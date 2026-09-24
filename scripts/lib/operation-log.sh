#!/usr/bin/env bash
# Native host diagnostics: usable on Docker hosts without Bun or project dependencies.
operation_event() {
    [ -n "${BOT_OPERATION_LOG_PATH:-}" ] || return 0
    local level="$1" message="${2:-}" text size
    size="$(wc -c < "$BOT_OPERATION_LOG_PATH" 2>/dev/null)" || return 0
    [ "$size" -lt 2097152 ] || return 0
    if [ "$level" = output ] && [ "$size" -ge 1048576 ]; then
        [ "${BOT_OPERATION_OUTPUT_LIMITED:-}" != "$BOT_OPERATION_LOG_PATH" ] || return 0
        BOT_OPERATION_OUTPUT_LIMITED="$BOT_OPERATION_LOG_PATH"
        level=warn
        message='Command output limit reached; subsequent stages and errors are still recorded.'
    fi
    text="$(printf '%s' "${message:0:16384}" | sed -E \
      -e 's/\x1b\[[0-?]*[ -/]*[@-~]//g' \
      -e 's/(Bearer[[:space:]]+)[^[:space:]";,]+/\1[redacted]/gI' \
      -e 's/((api[_-]?key|token|secret|password|authorization)["[:space:]]*[:=]["[:space:]]*)[^[:space:]",;&}]+/\1[redacted]/gI' \
      -e 's#(https?://)[^ /@:]+:[^ /@]+@#\1[redacted]@#gI' \
      -e 's/([?&](key|token|secret|password)=)[^[:space:]&#"]+/\1[redacted]/gI' \
      -e 's#/webhook/[a-f0-9]{64}#/webhook/[redacted]#gI' \
      -e 's/sk-[a-zA-Z0-9_-]{12,}/[redacted]/g')"
    text="${text//$'\r'/\\r}"; text="${text//$'\n'/\\n}"
    printf '%s [%s] %s %s: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$BASHPID" "$level" "${BOT_OPERATION_STAGE:-operation}" "$text" >> "$BOT_OPERATION_LOG_PATH" || echo '运维日志写入失败' >&2
    return 0
}

operation_stage() { export BOT_OPERATION_STAGE="$1"; operation_event info begin; }

operation_start() {
    local kind="$1" directory="$PROJECT_DIR/logs/operations" file name count=0
    local pattern='^(upgrade|deploy|migration|startup)-[0-9TZ]+-[a-zA-Z0-9_-]+\.log$'
    mkdir -p -- "$directory" || { echo '无法创建运维日志目录，继续使用终端输出' >&2; return 0; }
    [ ! -L "$directory" ] || { echo '日志目录不能是链接' >&2; return 0; }
    if [[ "${BOT_OPERATION_LOG:-}" =~ $pattern ]]; then
        file="$directory/$BOT_OPERATION_LOG"
        [ ! -L "$file" ] && { [ ! -e "$file" ] || [ -f "$file" ]; } || return 0
        (umask 077; touch -- "$file") || return 0
    else
        file="$(umask 077; mktemp "$directory/$kind-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXXXX.log")" || return 0
    fi
    export BOT_OPERATION_LOG="${file##*/}" BOT_OPERATION_LOG_PATH="$file"
    operation_stage "$kind"
    while IFS= read -r file; do
        name="${file##*/}"
        [[ "$name" =~ $pattern ]] && [ "$name" != "$BOT_OPERATION_LOG" ] && [ ! -L "$file" ] || continue
        count=$((count+1))
        if [ "$count" -ge 20 ]; then rm -f -- "$directory/$name" || true; fi
    done < <(ls -1t -- "$directory"/*.log 2>/dev/null)
    echo "运维日志：$BOT_OPERATION_LOG_PATH" >&2
}

operation_finish() {
    operation_event "$([ "$1" = 0 ] && echo info || echo error)" "operation finished; exit=$1"
    [ -z "${BOT_OPERATION_LOG_PATH:-}" ] || echo "运维日志：$BOT_OPERATION_LOG_PATH" >&2
    return 0
}

# Do not pipe interactive configuration commands: they must keep their terminal.
operation_capture() {
    local result
    if "$@" 2>&1 | while IFS= read -r line || [ -n "$line" ]; do
        printf '%s\n' "$line"
        operation_event output "$line"
    done; then result=0; else result=${PIPESTATUS[0]}; fi
    operation_event info "${1##*/}; exit=$result"
    return "$result"
}
