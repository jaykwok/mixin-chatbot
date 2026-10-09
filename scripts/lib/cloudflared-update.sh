#!/usr/bin/env bash
# Update only this checkout's connector; downloads never control services.
cloudflared_version() {
    local output
    output="$(timeout 15 "$1" --version 2>/dev/null)" || return 1
    [[ "$output" =~ ^cloudflared\ version\ ([0-9]{4}\.[0-9]{1,2}\.[0-9]{1,3})([[:space:]]|$) ]] || return 1
    printf '%s' "${BASH_REMATCH[1]}"
}

download_cloudflared_update() {
    bun "$PROJECT_DIR/scripts/ops/cloudflared-download.ts" --version "$1" --os linux --arch "$2" --output "$3"
}

update_cloudflared() (
    acquire_deploy_lock || { echo '另一个部署或隧道操作正在进行' >&2; return 1; }
    local pointer
    for pointer in deploy-transaction update-transaction upgrade-transaction; do
        if [ -e "$PROJECT_DIR/data/state/$pointer" ]; then
            echo '有未完成的部署或升级，请先继续或回滚，再更新 cloudflared。' >&2; return 1
        fi
    done
    local executable="$PROJECT_DIR/cloudflared" version arch original_hash
    [ -f "$executable" ] && [ -x "$executable" ] && [ ! -L "$executable" ] || {
        echo '缺少有效的项目 cloudflared；请先部署隧道。' >&2; return 1;
    }
    version="$(cloudflared_version "$executable")" || { echo '项目 cloudflared 版本无效' >&2; return 1; }
    command -v bun >/dev/null 2>&1 || { echo '更新 cloudflared 需要宿主机 Bun；请先按项目环境指引安装。' >&2; return 1; }
    case "$(uname -m)" in
        x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; armv*) arch=arm ;; i?86) arch=386 ;;
        *) echo 'cloudflared 更新不支持此系统架构' >&2; return 1 ;;
    esac
    local previous_pid="" was_running=0
    local CLOUDFLARED_PREVIOUS_COMMAND=() CLOUDFLARED_COMMAND=() CLOUDFLARED_LOG_ARGS=()
    if previous_pid="$(managed_cloudflared_pid)"; then
        was_running=1
        read_cloudflared_command "$previous_pid" || return 1
        local known=0 mode protocol index matches
        for mode in off on; do
            for protocol in auto http2 quic; do
                cloudflared_command "$mode" "$protocol" || return 1
                matches=1
                [ "${#CLOUDFLARED_PREVIOUS_COMMAND[@]}" = "${#CLOUDFLARED_COMMAND[@]}" ] || continue
                for index in "${!CLOUDFLARED_COMMAND[@]}"; do
                    [ "${CLOUDFLARED_PREVIOUS_COMMAND[$index]}" = "${CLOUDFLARED_COMMAND[$index]}" ] || matches=0
                done
                [ "$matches" != 1 ] || known=1
            done
        done
        [ "$known" = 1 ] && [ -f "$PROJECT_DIR/data/config/cloudflared-token" ] || {
            echo '连接器归属或启动参数不符合本项目配置，请先重新部署隧道。' >&2; return 1;
        }
    elif pgrep -x cloudflared >/dev/null 2>&1; then
        echo '发现没有本项目归属记录的 Cloudflared，拒绝自动更新。' >&2; return 1
    fi
    original_hash="$(sha256sum "$executable")" || return 1
    local stage candidate backup new_version result=0 switched=0 stop_attempted=0 committed=0
    stage="$(umask 077; mktemp -d "$PROJECT_DIR/.cloudflared-update-XXXXXX")" || return 1
    candidate="$stage/candidate"; backup="$stage/previous"
    finish_cloudflared_update() {
        local failure=$? recovery=0
        trap - EXIT INT TERM HUP
        restore_cloudflared_update() {
            local current_pid=""
            if [ "$stop_attempted" = 1 ]; then
                if current_pid="$(managed_cloudflared_pid)" && { [ "$switched" = 1 ] || [ "$current_pid" != "$previous_pid" ]; }; then
                    stop_managed_cloudflared || return 1
                fi
                if [ "$switched" = 1 ]; then
                    cp -p -- "$backup" "$stage/restore" && mv -f -- "$stage/restore" "$executable" || return 1
                fi
                if [ "$was_running" = 1 ] && ! managed_cloudflared_pid >/dev/null 2>&1; then
                    start_managed_cloudflared_command "${CLOUDFLARED_PREVIOUS_COMMAND[@]}" || return 1
                fi
            elif [ "$switched" = 1 ]; then
                cp -p -- "$backup" "$stage/restore" && mv -f -- "$stage/restore" "$executable" || return 1
            fi
        }
        if [ "$committed" != 1 ] && { [ "$stop_attempted" = 1 ] || [ "$switched" = 1 ]; }; then
            run_shielded restore_cloudflared_update || recovery=1
            if [ "$recovery" = 0 ]; then echo '更新失败，已恢复原程序及运行状态。' >&2
            else echo "更新失败，恢复也失败；旧程序保留在 $backup，请人工恢复隧道。" >&2; fi
            [ "$failure" != 0 ] || failure=1
        fi
        if [ "$recovery" = 0 ]; then
            rm -f -- "$candidate" "$backup" "$stage/restore"
            rmdir -- "$stage" || echo "更新临时目录未清理：$stage" >&2
        fi
        exit "$failure"
    }
    trap finish_cloudflared_update EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    trap 'exit 129' HUP
    new_version="$(download_cloudflared_update "$version" "$arch" "$candidate")" || result=$?
    if [ "$result" = 3 ]; then echo "cloudflared $version 已是官方稳定版。"; return 0; fi
    [ "$result" = 0 ] || return "$result"
    chmod 755 "$candidate" || return 1
    [ "$(cloudflared_version "$candidate")" = "$new_version" ] || { echo '候选程序版本验证失败，尚未停止隧道。' >&2; return 1; }
    [ "$(sha256sum "$executable")" = "$original_hash" ] || { echo '下载期间原程序发生变化，拒绝覆盖。' >&2; return 1; }
    if [ "$was_running" = 1 ]; then
        [ "$(managed_cloudflared_pid)" = "$previous_pid" ] || { echo '下载期间连接器运行状态发生变化，请重试。' >&2; return 1; }
        local saved_command=("${CLOUDFLARED_PREVIOUS_COMMAND[@]}")
        read_cloudflared_command "$previous_pid" || return 1
        [ "${#saved_command[@]}" = "${#CLOUDFLARED_PREVIOUS_COMMAND[@]}" ] || return 1
        for index in "${!saved_command[@]}"; do
            [ "${saved_command[$index]}" = "${CLOUDFLARED_PREVIOUS_COMMAND[$index]}" ] || { echo '连接器启动参数发生变化，请重试。' >&2; return 1; }
        done
    elif managed_cloudflared_pid >/dev/null 2>&1 || pgrep -x cloudflared >/dev/null 2>&1; then
        echo '下载期间连接器开始运行，请重试。' >&2; return 1
    fi
    cp -p -- "$executable" "$backup" || return 1
    if [ "$was_running" = 1 ]; then stop_attempted=1; stop_managed_cloudflared || return 1; fi
    # Set before replacement: rollback also covers a failed/partial publication.
    switched=1
    mv -f -- "$candidate" "$executable" || return 1
    if [ "$was_running" = 1 ]; then start_managed_cloudflared_command "${CLOUDFLARED_PREVIOUS_COMMAND[@]}" || return 1; fi
    committed=1
    echo "cloudflared 已更新：$version → $new_version。"
    if [ "$was_running" = 1 ]; then echo '隧道已按原参数重新启动。'; else echo '隧道保持停止。'; fi
)
