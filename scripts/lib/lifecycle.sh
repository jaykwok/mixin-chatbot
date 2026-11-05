#!/usr/bin/env bash

# Recovery runs in its own process group and finishes even after Ctrl+C or disconnect.
run_shielded() {
    local pid status=0
    set -m
    "$@" </dev/null &
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
    [ -e "$source" ] || [ -L "$source" ] || return 0
    case "$source" in "$PROJECT_DIR"/*) ;; *) echo "归档路径越界: $source" >&2; return 1 ;; esac
    case "$source" in "$archive"|"$archive"/*|"$PROJECT_DIR/backup") return 1 ;; esac
    parent="$(realpath -- "$(dirname "$source")")" || return 1
    case "$parent/" in "$PROJECT_DIR/"*) ;; *) echo '归档父目录越界' >&2; return 1 ;; esac
    mkdir -p "$archive"
    mv -- "$source" "$archive/$(date +%s)-${RANDOM}-${RANDOM}-$(basename "$source")"
}
