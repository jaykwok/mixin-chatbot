#!/usr/bin/env bash
# Optional diagnostics, read without Bun/jq so a Docker host needs no extra runtime.
cloudflared_logging() {
    local path="$PROJECT_DIR/data/config/cloudflared-logging" level
    if [ ! -e "$path" ]; then printf off; return; fi
    level="$(sed 's/^[[:space:]]*//;s/[[:space:]]*$//' "$path")" || return 1
    case "$level" in off|on) printf '%s' "$level" ;; *) echo 'cloudflared-logging 只接受 off 或 on' >&2; return 1 ;; esac
}

cloudflared_protocol() {
    local path="$PROJECT_DIR/data/config/cloudflared-protocol" protocol
    if [ ! -e "$path" ]; then printf auto; return; fi
    protocol="$(sed 's/^[[:space:]]*//;s/[[:space:]]*$//' "$path")" || return 1
    case "$protocol" in auto|http2|quic) printf '%s' "$protocol" ;; *) echo 'cloudflared-protocol 只接受 auto、http2 或 quic' >&2; return 1 ;; esac
}

save_cloudflared_logging() { save_cloudflared_preference logging "$1"; }
save_cloudflared_protocol() { save_cloudflared_preference protocol "$1"; }

save_cloudflared_preference() (
    case "$1" in logging|protocol) ;; *) return 1 ;; esac
    local path="$PROJECT_DIR/data/config/cloudflared-$1" temporary
    mkdir -p "$(dirname "$path")" || return 1
    temporary="$(mktemp "$path.XXXXXX")" || return 1
    trap 'rm -f -- "$temporary"' EXIT
    printf '%s' "$2" > "$temporary" && mv -f -- "$temporary" "$path"
)

cloudflared_log_args() {
    # Fixed Debug level when enabled: Info omits normal HTTP request/response records.
    # --log-directory rotates automatically; --logfile would grow without bounds.
    CLOUDFLARED_LOG_ARGS=()
    case "$1" in
        off) ;;
        on) CLOUDFLARED_LOG_ARGS=(--loglevel debug --log-directory "$PROJECT_DIR/logs") ;;
        *) echo 'cloudflared-logging 只接受 off 或 on' >&2; return 1 ;;
    esac
}

cloudflared_command() {
    local protocol="${2:-}"
    if [ -z "$protocol" ]; then protocol="$(cloudflared_protocol)" || return 1; fi
    case "$protocol" in auto|http2|quic) ;; *) echo 'cloudflared-protocol 只接受 auto、http2 或 quic' >&2; return 1 ;; esac
    cloudflared_log_args "$1" || return 1
    CLOUDFLARED_COMMAND=("$PROJECT_DIR/cloudflared" tunnel --no-autoupdate --protocol "$protocol" "${CLOUDFLARED_LOG_ARGS[@]}" run --token-file "$PROJECT_DIR/data/config/cloudflared-token")
}

read_cloudflared_command() {
    mapfile -d '' -t CLOUDFLARED_PREVIOUS_COMMAND < "/proc/$1/cmdline"
}

# Used when restarting an already managed connector. Keep its token and other state intact.
start_managed_cloudflared_command() {
    (umask 077; unset MIXIN_TUNNEL_TOKEN_INPUT TUNNEL_TOKEN; exec nohup "$@" </dev/null >/dev/null 2>&1 9>&-) &
    tunnel_launcher_pid=$!
    tunnel_launcher_start="$(process_start_identity "$tunnel_launcher_pid")" || return 1
    if ! record_cloudflared_pid "$tunnel_launcher_pid"; then stop_tunnel_launcher; return 1; fi
    local attempt
    for ((attempt=0; attempt<5; attempt++)); do
        sleep 1
        if managed_cloudflared_pid >/dev/null 2>&1; then
            tunnel_launcher_pid=""
            return 0
        fi
        kill -0 "$tunnel_launcher_pid" 2>/dev/null || break
    done
    stop_tunnel_launcher || return 1
    tunnel_launcher_pid=""
    echo 'Cloudflared 未能保持运行，请检查隧道日志或前台启动输出。' >&2
    return 1
}

configure_tunnel_logging() { configure_tunnel_setting logging "${1:-}"; }
configure_tunnel_protocol() { configure_tunnel_setting protocol "${1:-}"; }

configure_tunnel_setting() (
    local setting="$1" level="${2:-}" previous_level preference="$PROJECT_DIR/data/config/cloudflared-$1" label
    case "$setting:$level" in
        logging:off|logging:on) label=日志 ;;
        protocol:auto|protocol:http2|protocol:quic) label=连接模式 ;;
        *) echo '请使用 tunnel-logging off|on 或 tunnel-protocol auto|http2|quic' >&2; return 1 ;;
    esac
    acquire_deploy_lock || { echo '另一个部署或隧道设置操作正在进行' >&2; return 1; }
    local logging protocol
    logging="$(cloudflared_logging)" || return 1
    protocol="$(cloudflared_protocol)" || return 1
    if [ "$setting" = logging ]; then previous_level="$logging"; logging="$level"
    else previous_level="$protocol"; protocol="$level"; fi
    if [ "$level" = "$previous_level" ]; then echo "Cloudflared $label 设置未变化。"; return; fi
    local previous_pid="" was_running=0
    local CLOUDFLARED_PREVIOUS_COMMAND=() CLOUDFLARED_COMMAND=() CLOUDFLARED_LOG_ARGS=()
    if previous_pid="$(managed_cloudflared_pid)"; then
        was_running=1
        read_cloudflared_command "$previous_pid" || return 1
        local known=0 candidate transport index matches
        for candidate in off on; do
            for transport in auto http2 quic; do
                cloudflared_command "$candidate" "$transport" || return 1
                matches=1
                if [ "${#CLOUDFLARED_PREVIOUS_COMMAND[@]}" != "${#CLOUDFLARED_COMMAND[@]}" ]; then continue; fi
                for index in "${!CLOUDFLARED_COMMAND[@]}"; do
                    [ "${CLOUDFLARED_COMMAND[$index]}" = "${CLOUDFLARED_PREVIOUS_COMMAND[$index]}" ] || matches=0
                done
                [ "$matches" = 1 ] && known=1
            done
        done
        if [ "$known" != 1 ]; then
            echo '现有连接器使用自定义启动参数；请先按当前项目脚本重新部署隧道，再修改隧道设置。' >&2
            return 1
        fi
        [ -x "$PROJECT_DIR/cloudflared" ] && [ -f "$PROJECT_DIR/data/config/cloudflared-token" ] || {
            echo '缺少项目 cloudflared 或 data/config/cloudflared-token，尚未修改连接器。' >&2; return 1;
        }
    elif pgrep -x cloudflared >/dev/null 2>&1; then
        echo '发现没有本项目归属记录的 Cloudflared，无法自动应用隧道设置。' >&2
        return 1
    fi
    [ "$logging" != on ] || mkdir -p "$PROJECT_DIR/logs" || return 1
    mkdir -p "$(dirname "$preference")" || return 1
    local backup had_preference=0 committed=0 stop_attempted=0
    backup="$(mktemp "$preference.backup-XXXXXX")" || return 1
    if [ -f "$preference" ]; then
        had_preference=1
        cp -p -- "$preference" "$backup" || { rm -f -- "$backup"; return 1; }
    fi
    restore_tunnel_setting() {
        local result=$? failed=0 current_pid=""
        trap - EXIT INT TERM
        if [ "$committed" != 1 ]; then
            if [ "$stop_attempted" = 1 ] && current_pid="$(managed_cloudflared_pid)" && [ "$current_pid" != "$previous_pid" ]; then
                stop_managed_cloudflared || failed=1
            fi
            if [ "$had_preference" = 1 ]; then mv -f -- "$backup" "$preference" || failed=1
            else rm -f -- "$preference" || failed=1; fi
            if [ "$failed" = 0 ] && [ "$was_running" = 1 ] && ! managed_cloudflared_pid >/dev/null 2>&1; then
                start_managed_cloudflared_command "${CLOUDFLARED_PREVIOUS_COMMAND[@]}" || failed=1
            fi
            if [ "$failed" = 0 ]; then echo '应用失败，已恢复原设置及运行状态。' >&2
            else echo '应用失败，恢复原设置或连接器也失败，请检查隧道状态。' >&2; fi
            [ "$result" != 0 ] || result=1
        fi
        rm -f -- "$backup"
        exit "$result"
    }
    trap restore_tunnel_setting EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    if [ "$was_running" = 1 ]; then
        stop_attempted=1
        stop_managed_cloudflared || return 1
    fi
    "save_cloudflared_$setting" "$level" || return 1
    if [ "$was_running" = 1 ]; then
        cloudflared_command "$logging" "$protocol" || return 1
        start_managed_cloudflared_command "${CLOUDFLARED_COMMAND[@]}" || return 1
    fi
    committed=1
    if [ "$setting" = protocol ]; then echo "Cloudflared 连接模式已设为 $level。"
    elif [ "$level" = on ]; then echo 'Cloudflared 已开启，日志：logs/cloudflared.log（自动轮转）。'
    else echo 'Cloudflared 已关闭文件日志，已有日志保留。'; fi
    if [ "$was_running" = 1 ]; then echo '隧道连接器已重新启动。'
    else echo '隧道保持停止，下次启动或部署时生效。'; fi
)
