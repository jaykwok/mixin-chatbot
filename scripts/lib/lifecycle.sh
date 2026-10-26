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
# Shared archive and backup operations on the project tree. Sourcing has no side effects.
archive_project_path() {
    local source archive parent
    source="$(realpath -ms -- "$1")" || return 1
    archive="$PROJECT_DIR/backup/rm"
    if [[ "${BOT_DEPLOY_BACKUP_ID:-}" =~ ^deploy-[a-zA-Z0-9]+$ ]]; then archive="$archive/$BOT_DEPLOY_BACKUP_ID"; fi
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
    [[ "$name" =~ ^deploy-[a-zA-Z0-9]+$ ]] || return 1
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
