#!/usr/bin/env bash

# Recovery runs in its own process group and finishes even after Ctrl+C or disconnect.
run_shielded() {
    local pid status=0
    set -m
    (SHIELDED_RUN=1; "$@") </dev/null &
    pid=$!
    set +m
    trap '' INT TERM HUP
    wait "$pid" || status=$?
    return "$status"
}
# Shared filesystem and Linux process identity operations. Sourcing has no side effects.
archive_project_path() {
    local source archive parent
    source="$(realpath -ms -- "$1")" || return 1
    archive="$PROJECT_DIR/backup/rm"
    if [[ "${BOT_DEPLOY_BACKUP_ID:-}" =~ ^(deploy|tunnel)-[a-zA-Z0-9-]+$ ]]; then archive="$archive/$BOT_DEPLOY_BACKUP_ID"; fi
    [ -e "$source" ] || [ -L "$source" ] || return 0
    case "$source" in "$PROJECT_DIR"/*) ;; *) echo "归档路径越界: $source" >&2; return 1 ;; esac
    case "$source" in "$archive"|"$archive"/*|"$PROJECT_DIR/backup") return 1 ;; esac
    parent="$(realpath -- "$(dirname "$source")")" || return 1
    case "$parent/" in "$PROJECT_DIR/"*) ;; *) echo '归档父目录越界' >&2; return 1 ;; esac
    mkdir -p "$archive"
    mv -- "$source" "$archive/$(date +%s)-${RANDOM}-${RANDOM}-$(basename "$source")"
}

# A successful operation discards only what it owns: its snapshot and the archive made under the snapshot's name
# (backup/rm/<name>). Other snapshots, loose or manual archives and earlier transactions stay for the explicit cleanup.
cleanup_completed_backup() {
    local backup snapshot name target
    backup="$PROJECT_DIR/backup"
    snapshot="$(realpath -ms -- "$1")" || return 1
    name="$(basename -- "$snapshot")"
    [[ "$name" =~ ^(deploy|tunnel)-[a-zA-Z0-9-]+$ ]] || return 1
    [ "$(dirname -- "$snapshot")" = "$backup/snapshots" ] || return 1
    # Refuse a redirected path or a link in either place before removing anything; rm unlinks links inside without following them.
    for target in "$snapshot" "$backup/rm/$name"; do
        [ "$(realpath -m -- "$target")" = "$target" ] || return 1
    done
    for target in "$snapshot" "$backup/rm/$name"; do
        rm -rf -- "$target" || return 1
    done
    # Remove empty parents only, retaining other snapshots still present under snapshots/.
    rmdir -- "$backup/snapshots" "$backup/rm" 2>/dev/null || true
    # A running container still holds this bind mount. Removing its host inode
    # would prevent subsequent archives from reaching the recreated host path.
    if [ "${2:-}" != keep-root ]; then rmdir -- "$backup" 2>/dev/null || true; fi
}

process_start_identity() {
    local line fields
    [[ "$1" =~ ^[1-9][0-9]*$ ]] || return 1
    IFS= read -r line < "/proc/$1/stat" 2>/dev/null || return 1
    # comm can contain spaces and parentheses; starttime is field 22, after the last ')'.
    line="${line##*) }"
    read -r -a fields <<< "$line"
    [ "${fields[0]:-}" != Z ] && [[ "${fields[19]:-}" =~ ^[0-9]+$ ]] || return 1
    printf '%s' "${fields[19]}"
}

record_cloudflared_pid() {
    local start boot
    start="$(process_start_identity "$1")" || return 1
    boot="$(cat /proc/sys/kernel/random/boot_id)" || return 1
    mkdir -p "$(dirname "$TUNNEL_PID_FILE")"
    (umask 077 && printf '%s %s %s\n' "$1" "$start" "$boot" > "$TUNNEL_PID_FILE")
}

managed_cloudflared_pid() {
    local pid start boot current extra
    [ -f "$TUNNEL_PID_FILE" ] || return 1
    read -r pid start boot extra < "$TUNNEL_PID_FILE" || return 1
    [ -z "$extra" ] && [ -n "$boot" ] || return 1
    [ "$boot" = "$(cat /proc/sys/kernel/random/boot_id)" ] || return 1
    current="$(process_start_identity "$pid")" || return 1
    [ "$current" = "$start" ] || return 1
    [ "$(cat "/proc/$pid/comm" 2>/dev/null)" = cloudflared ] || return 1
    printf '%s' "$pid"
}

# Waits up to $1 seconds for the recorded process to go away. The check after the last sleep
# counts: an exit during the final second is a completed stop, not a timeout.
wait_managed_cloudflared_exit() {
    local attempt
    for ((attempt=0; ; attempt++)); do
        managed_cloudflared_pid >/dev/null || return 0
        [ "$attempt" -lt "$1" ] || return 1
        sleep 1
    done
}

# A process that exited after it was looked up no longer needs the signal.
signal_managed_cloudflared() {
    local error
    error="$(kill "-$2" "$1" 2>&1)" && return 0
    managed_cloudflared_pid >/dev/null || return 0
    printf '%s\n' "$error" >&2
    return 1
}

stop_managed_cloudflared() {
    local pid current
    # Gone before or during the stop is a successful stop; callers look the process up first, so it
    # may exit in between. The PID file then only describes a finished process and is archived.
    if pid="$(managed_cloudflared_pid)"; then
        signal_managed_cloudflared "$pid" TERM || return 1
        if ! wait_managed_cloudflared_exit 10 && current="$(managed_cloudflared_pid)"; then
            # Revalidate the birth time immediately before escalation; a PID alone is not ownership.
            [ "$current" = "$pid" ] || return 1
            signal_managed_cloudflared "$pid" KILL || return 1
            wait_managed_cloudflared_exit 5 || return 1
        fi
    fi
    archive_project_path "$TUNNEL_PID_FILE"
}

stop_tunnel_launcher() {
    local current
    [ -n "${tunnel_launcher_pid:-}" ] || return 0
    current="$(process_start_identity "$tunnel_launcher_pid")" || return 0
    [ "$current" = "${tunnel_launcher_start:-}" ] || return 1
    # start-tunnel performs only bounded preflight commands, then execs the official binary.
    kill -TERM "$tunnel_launcher_pid" || return 1
    local attempt
    for ((attempt=0; attempt<5; attempt++)); do
        process_start_identity "$tunnel_launcher_pid" >/dev/null || { wait "$tunnel_launcher_pid" 2>/dev/null || true; return 0; }
        sleep 1
    done
    [ "$(process_start_identity "$tunnel_launcher_pid")" = "$tunnel_launcher_start" ] || return 0
    kill -KILL "$tunnel_launcher_pid" || return 1
    wait "$tunnel_launcher_pid" 2>/dev/null || true
}
