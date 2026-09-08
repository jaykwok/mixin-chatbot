#!/usr/bin/env bash
# Shared filesystem and Linux process identity operations. Sourcing has no side effects.
archive_project_path() {
    local source archive parent
    source="$(realpath -ms -- "$1")" || return 1
    archive="$PROJECT_DIR/agents/rm"
    [ -e "$source" ] || [ -L "$source" ] || return 0
    case "$source" in "$PROJECT_DIR"/*) ;; *) echo "归档路径越界: $source" >&2; return 1 ;; esac
    case "$source" in "$archive"|"$archive"/*|"$PROJECT_DIR/agents") return 1 ;; esac
    parent="$(realpath -- "$(dirname "$source")")" || return 1
    case "$parent/" in "$PROJECT_DIR/"*) ;; *) echo '归档父目录越界' >&2; return 1 ;; esac
    mkdir -p "$archive"
    mv -- "$source" "$archive/$(date +%s)-${RANDOM}-${RANDOM}-$(basename "$source")"
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

stop_managed_cloudflared() {
    local pid attempt
    pid="$(managed_cloudflared_pid)" || return 1
    kill -TERM "$pid" || return 1
    for ((attempt=0; attempt<10; attempt++)); do
        if ! managed_cloudflared_pid >/dev/null; then archive_project_path "$TUNNEL_PID_FILE"; return $?; fi
        sleep 1
    done
    # Revalidate the birth time immediately before escalation; a PID alone is not ownership.
    [ "$(managed_cloudflared_pid)" = "$pid" ] || return 1
    kill -KILL "$pid" || return 1
    for ((attempt=0; attempt<5; attempt++)); do
        if ! managed_cloudflared_pid >/dev/null; then archive_project_path "$TUNNEL_PID_FILE"; return $?; fi
        sleep 1
    done
    return 1
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
