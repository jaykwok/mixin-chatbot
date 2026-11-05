#!/usr/bin/env bash
# Native host diagnostics: usable on Docker hosts without Bun or project dependencies.
#
# rootful 部署把 logs/ 交给服务身份，以 root 运行的入口不能按路径反复写入其中的文件（可能已被换成链接或 FIFO）。
# 本次日志只打开一次，之后都经描述符追加。每个进程只写自己在 operation_start 中核对过的描述符（OPERATION_LOG_FD，不导出）；
# 导出的 BOT_OPERATION_LOG_FD 只是给子进程的提示，子进程同样先核对它指向的文件。
operation_event() {
    [ -n "${BOT_OPERATION_LOG_PATH:-}" ] && [ -n "${OPERATION_LOG_FD:-}" ] || return 0
    local level="$1" message="${2:-}" text size
    size="$(stat -L -c %s "/proc/self/fd/$OPERATION_LOG_FD" 2>/dev/null)" || return 0
    [ "$size" -lt 2097152 ] || return 0
    if [ "$level" = output ] && [ "$size" -ge 1048576 ]; then
        [ "${BOT_OPERATION_OUTPUT_LIMITED:-}" != "$BOT_OPERATION_LOG_PATH" ] || return 0
        BOT_OPERATION_OUTPUT_LIMITED="$BOT_OPERATION_LOG_PATH"
        level=warn
        message='Command output limit reached; subsequent stages and errors are still recorded.'
    fi
    text="$(operation_redact "$message")"
    text="${text//$'\r'/\\r}"; text="${text//$'\n'/\\n}"
    printf '%s [%s] %s %s: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$BASHPID" "$level" "${BOT_OPERATION_STAGE:-operation}" "$text" >&"$OPERATION_LOG_FD" || echo '运维日志写入失败' >&2
    return 0
}

# 与 scripts/lib/redact.ts 和 operation-log.ps1 的规则、顺序相同，都替换为 ***；tests/ops/redaction-parity.test.ts 让三者
# 跑同一组样例。字节序区间：en_US.UTF-8 等按排序规则解释 [ -/] 会编译失败，set -e 的调用方随之退出，所以用 LC_ALL=C。
OPERATION_REDACT_SED=(
    -e 's/\x1b\[[0-?]*[ -/]*[@-~]//g'
    -e 's/\b((sk|pk|ghp|xoxb|hf)[-_]|github_pat_)[A-Za-z0-9_-]{6,}/\1***/gI'
    -e "s/(Bearer[[:space:]]+)[^[:space:]\"',;]+/\\1***/gI"
    -e "s/([\"']?(api[_-]?key|access[_-]?token|token|secret|password|passwd|authorization)[\"']?[[:space:]]*[:=][[:space:]]*[\"']?((Bearer|Basic)[[:space:]]+)?)[^\"'[:space:],;}&]+/\\1***/gI"
    -e "s/([?&](key|token|secret|sig|sign|signature|password)=)[^&[:space:]\"']+/\\1***/gI"
    -e 's#(https?://)[^[:space:]/@]+:[^[:space:]/@]+@#\1***@#gI'
)

# 一条日志消息（最多 16384 个字符）脱敏后写到标准输出。
operation_redact() {
    printf '%s' "${1:0:16384}" | LC_ALL=C sed -E "${OPERATION_REDACT_SED[@]}"
}

operation_stage() { export BOT_OPERATION_STAGE="$1"; operation_event info begin; }

# 打开 logs/operations/<名称> 供追加，描述符号放进 OPERATION_LOG_FD。create=1 时在新的随机名上用 noclobber 创建
# （O_EXCL：路径上已有任何条目都失败，不经链接创建），再经 /proc/self/fd 以追加方式重新打开同一个文件；沿用上级日志时
# 优先用继承的描述符，没有才按路径打开已有的普通文件。打开的必须正是项目 logs/operations 下这个名称的普通文件。
operation_log_open() {
    local name="$1" create="$2" expected file fd='' created='' noclobber=0 mask actual
    OPERATION_LOG_FD=''
    expected="$(realpath -- "$PROJECT_DIR/logs" 2>/dev/null)" || return 1
    expected="$expected/operations/$name"
    file="$PROJECT_DIR/logs/operations/$name"
    if [ "$create" = 1 ]; then
        [[ $- == *C* ]] && noclobber=1
        mask="$(umask)"; umask 077; set -C
        { exec {created}>"$file"; } 2>/dev/null || created=''
        umask "$mask"; [ "$noclobber" = 1 ] || set +C
        [ -n "$created" ] || return 1
        { exec {fd}>>"/proc/self/fd/$created"; } 2>/dev/null || fd=''
        exec {created}>&-
    elif [[ "${BOT_OPERATION_LOG_FD:-}" =~ ^[0-9]+$ ]] && [ "$(readlink "/proc/self/fd/$BOT_OPERATION_LOG_FD" 2>/dev/null)" = "$expected" ]; then
        fd="$BOT_OPERATION_LOG_FD"
    elif [ -f "$file" ] && [ ! -L "$file" ]; then
        { exec {fd}>>"$file"; } 2>/dev/null || fd=''
    fi
    [ -n "$fd" ] || return 1
    actual="$(readlink "/proc/self/fd/$fd" 2>/dev/null)" || actual=''
    if [ "$actual" != "$expected" ] || [ ! -f "/proc/self/fd/$fd" ]; then
        # Created through a replaced logs/operations: the new, still empty file is ours; remove it where it really is.
        [ "$create" != 1 ] || [ -z "$actual" ] || rm -f -- "$actual"
        [ "$fd" = "${BOT_OPERATION_LOG_FD:-}" ] || exec {fd}>&-
        return 1
    fi
    OPERATION_LOG_FD="$fd"
}

operation_start() {
    local kind="$1" directory="$PROJECT_DIR/logs/operations" file name family count=0 attempt
    local pattern='^(upgrade|deploy|startup)-[0-9TZ]+-[a-zA-Z0-9_-]+\.log$'
    # Only the process creating the log announces it; children inherit its name.
    OPERATION_LOG_OWNER=0
    mkdir -p -- "$directory" || { echo '无法创建运维日志目录，继续使用终端输出' >&2; return 0; }
    [ ! -L "$directory" ] || { echo '日志目录不能是链接' >&2; return 0; }
    if [[ "${BOT_OPERATION_LOG:-}" =~ $pattern ]]; then
        name="$BOT_OPERATION_LOG"
        operation_log_open "$name" 0 || { [ ! -e "$directory/$name" ] && [ ! -L "$directory/$name" ] && operation_log_open "$name" 1; } ||
            return 0
    else
        for attempt in 1 2 3; do
            name="$(mktemp -u "$kind-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXXXX.log")" || return 0
            ! operation_log_open "$name" 1 || break
            name=''
        done
        [ -n "$name" ] || { echo '无法创建运维日志，继续使用终端输出' >&2; return 0; }
        OPERATION_LOG_OWNER=1
    fi
    file="$directory/$name"
    export BOT_OPERATION_LOG="$name" BOT_OPERATION_LOG_PATH="$file" BOT_OPERATION_LOG_FD="$OPERATION_LOG_FD"
    family="${BOT_OPERATION_LOG%%-*}"
    operation_stage "$kind"
    while IFS= read -r file; do
        name="${file##*/}"
        [[ "$name" =~ $pattern ]] && [[ "$name" == "$family-"* ]] && [ "$name" != "$BOT_OPERATION_LOG" ] && [ -f "$file" ] && [ ! -L "$file" ] || continue
        count=$((count+1))
        if [ "$count" -ge 20 ]; then rm -f -- "$directory/$name" || true; fi
    done < <(ls -1t -- "$directory"/*.log 2>/dev/null)
    if [ "$OPERATION_LOG_OWNER" = 1 ]; then echo "本次操作日志：$BOT_OPERATION_LOG_PATH" >&2; fi
}

operation_finish() {
    operation_event "$([ "$1" = 0 ] && echo info || echo error)" "operation finished; exit=$1"
    if [ "$1" != 0 ] && [ "${OPERATION_LOG_OWNER:-0}" = 1 ] && [ -n "${BOT_OPERATION_LOG_PATH:-}" ]; then
        echo "本次操作日志：$BOT_OPERATION_LOG_PATH" >&2
    fi
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
