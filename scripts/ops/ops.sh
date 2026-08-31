#!/usr/bin/env bash
# mixin-chatbot 运维工具（Linux / Docker）。
# 一站式运维：doctor / update / restart / stop / start / logs / uninstall。
#
# 用法：./scripts/ops/ops.sh <命令>
#   命令：doctor、update、restart、stop、start、logs、uninstall（不带参数显示帮助）
set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONTAINER="mixin-chatbot"
ROLLBACK_CONTAINER="${CONTAINER}-rollback"
DATA_DIR="${PROJECT_DIR}/data"
CONFIG_DIR="${DATA_DIR}/config"
STATE_DIR="${DATA_DIR}/state"
DEFAULT_GROUP_DATA_ROOT="${DATA_DIR}/groups"
MODELS_FILE="${CONFIG_DIR}/models.json"
WEBHOOK_SECRET_FILE="${CONFIG_DIR}/webhook-secret"
BOT_PORT_FILE="${STATE_DIR}/bot-port"
DEPLOY_MODE_FILE="${STATE_DIR}/deploy-mode"
BOT_DOMAIN_FILE="${STATE_DIR}/bot-domain"
GROUP_DATA_ROOT_FILE="${STATE_DIR}/group-data-root"
TUNNEL_PID_FILE="${STATE_DIR}/cloudflared.pid"
if [ -n "${BOT_PORT:-}" ]; then
    PORT="$BOT_PORT"
elif [ -f "$BOT_PORT_FILE" ]; then
    PORT="$(tr -d '[:space:]' < "$BOT_PORT_FILE")"
else
    PORT="1011"
fi
if [ -f "$DEPLOY_MODE_FILE" ]; then
    DEPLOY_MODE="$(tr -d '[:space:]' < "$DEPLOY_MODE_FILE")"
else
    DEPLOY_MODE="direct"
fi
if [ -n "${BOT_DOMAIN:-}" ]; then
    DOMAIN="$BOT_DOMAIN"
elif [ -f "$BOT_DOMAIN_FILE" ]; then
    DOMAIN="$(tr -d '[:space:]' < "$BOT_DOMAIN_FILE")"
else
    DOMAIN=""
fi
if [ -s "$GROUP_DATA_ROOT_FILE" ]; then
    DEPLOYED_GROUP_DATA_ROOT="$(tr -d '\r\n' < "$GROUP_DATA_ROOT_FILE")"
else
    DEPLOYED_GROUP_DATA_ROOT="$DEFAULT_GROUP_DATA_ROOT"
fi
resolve_group_data_root() {
    local value="$1"
    case "$value" in
        /*) realpath -m -- "$value" ;;
        *) realpath -m -- "${PROJECT_DIR}/${value}" ;;
    esac
}
is_valid_hostname() {
    local hostname="$1"
    [ -n "$hostname" ] && [ "${#hostname}" -le 253 ] || return 1
    [[ "$hostname" != .* && "$hostname" != *. && "$hostname" != *..* ]] || return 1
    local labels=()
    IFS='.' read -r -a labels <<< "$hostname"
    local label
    for label in "${labels[@]}"; do
        [ -n "$label" ] && [ "${#label}" -le 63 ] || return 1
        [[ "$label" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$ ]] || return 1
    done
}
normalize_hostname_input() {
    local value host
    value="$(printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    if is_valid_hostname "$value"; then
        printf '%s' "${value,,}"
        return 0
    fi
    if [[ "$value" =~ ^[Hh][Tt][Tt][Pp][Ss]?://([^/:?#]+)(/)?$ ]]; then
        host="${BASH_REMATCH[1]}"
        if is_valid_hostname "$host"; then
            printf '%s' "${host,,}"
            return 0
        fi
    fi
    return 1
}
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
    echo "BOT_PORT/data/state/bot-port 中的端口无效：$PORT" >&2
    exit 1
fi
if [ "$DEPLOY_MODE" != "direct" ] && [ "$DEPLOY_MODE" != "cloudflare" ]; then
    echo "data/state/deploy-mode 中的部署模式无效：$DEPLOY_MODE" >&2
    exit 1
fi
if [ -n "$DOMAIN" ]; then
    if NORMALIZED_DOMAIN="$(normalize_hostname_input "$DOMAIN")"; then
        DOMAIN="$NORMALIZED_DOMAIN"
    else
        echo "BOT_DOMAIN/data/state/bot-domain 中的域名无效：$DOMAIN" >&2
        exit 1
    fi
fi

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'
P()  { echo -e "${BLUE}[*]${NC} $1"; }
OK() { echo -e "${GREEN}[+]${NC} $1"; }
WA() { echo -e "${YELLOW}[!]${NC} $1"; }
ER() { echo -e "${RED}[x]${NC} $1"; }

ask_yes_no() {
    local prompt="$1" answer=""
    while true; do
        if ! IFS= read -r -p "$prompt" answer; then
            echo ""
            WA "输入已结束，按默认值“否”处理"
            return 1
        fi
        answer="$(printf '%s' "$answer" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
        answer="${answer,,}"
        case "$answer" in
            ""|n|no|否) return 1 ;;
            y|yes|是) return 0 ;;
            *) WA "请输入 y 或 n（也可直接回车采用默认值）" ;;
        esac
    done
}

PASS=0; FAIL=0
check() {
    local name="$1" ok="$2" detail="$3"
    if [ "$ok" = "1" ]; then OK "$(printf '%-30s %s' "$name" "$detail")"; PASS=$((PASS+1))
    else ER "$(printf '%-30s %s' "$name" "$detail")"; FAIL=$((FAIL+1)); fi
}

# 获取 URL 的 HTTP 状态码（curl 连接失败时输出 "000"）。
code_of() {
    curl -s -o /dev/null -w "%{http_code}" -m "${2:-10}" "$1" 2>/dev/null || true
}

wait_for_local() {
    local attempt code=""
    for attempt in $(seq 1 10); do
        code="$(code_of "http://localhost:${PORT}/favicon.svg" 2)"
        if [ "$code" = "200" ]; then
            printf '%s' "$code"
            return 0
        fi
        [ "$attempt" -eq 10 ] || sleep 1
    done
    printf '%s' "$code"
    return 1
}

managed_cloudflared_pid() {
    local pid="" process_name=""
    [ -f "$TUNNEL_PID_FILE" ] || return 1
    pid="$(tr -d '[:space:]' < "$TUNNEL_PID_FILE")"
    [[ "$pid" =~ ^[0-9]+$ ]] || { rm -f -- "$TUNNEL_PID_FILE"; return 1; }
    process_name="$(ps -p "$pid" -o comm= 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [ "${process_name##*/}" = "cloudflared" ] || { rm -f -- "$TUNNEL_PID_FILE"; return 1; }
    printf '%s' "$pid"
}

stop_managed_cloudflared() {
    local pid="" attempt
    pid="$(managed_cloudflared_pid)" || return 1
    kill "$pid" || return 1
    for attempt in $(seq 1 10); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 1
    done
    kill -0 "$pid" 2>/dev/null && return 1
    rm -f -- "$TUNNEL_PID_FILE"
}

has_container() {
    docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER}$"
}

has_rollback_container() {
    docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q "^${ROLLBACK_CONTAINER}$"
}

doctor() {
    local mode_label="直连"
    [ "$DEPLOY_MODE" = "cloudflare" ] && mode_label="Cloudflare"
    P "mixin-chatbot 健康检查（模式=$mode_label，端口=$PORT）"
    PASS=0; FAIL=0

    local resolved_group_root=""
    resolved_group_root="$(resolve_group_data_root "$DEPLOYED_GROUP_DATA_ROOT" 2>/dev/null || true)"
    local group_root_ok="0" group_root_detail="目录不存在或路径无效：$DEPLOYED_GROUP_DATA_ROOT"
    if [ -n "$resolved_group_root" ] && [ -d "$resolved_group_root" ]; then
        group_root_ok="1"
        group_root_detail="$resolved_group_root"
    fi
    check "群数据总根" "$group_root_ok" "$group_root_detail"

    local cstate="缺少"
    if has_container; then
        cstate="$(docker inspect --format '{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo "?")"
    fi
    local cstate_label="$cstate"
    [ "$cstate" = "running" ] && cstate_label="运行中"
    [ "$cstate" = "exited" ] && cstate_label="已退出"
    check "容器" "$([ "$cstate" = "running" ] && echo 1 || echo 0)" "$cstate_label"
    check "部署回滚容器" "$(! has_rollback_container && echo 1 || echo 0)" \
        "$(! has_rollback_container && echo 无 || echo "发现 ${ROLLBACK_CONTAINER}，请确认后恢复或删除")"

    local lc; lc="$(code_of "http://localhost:${PORT}/favicon.svg")"
    check "本地机器人健康" "$([ "$lc" = "200" ] && echo 1 || echo 0)" "HTTP $lc"

    if [ "$DEPLOY_MODE" = "cloudflare" ]; then
        local crunning="0" cdetail="未运行"
        local managed_pid=""
        if managed_pid="$(managed_cloudflared_pid)"; then
            crunning="1"; cdetail="本项目 pid $managed_pid"
        elif pgrep -x cloudflared >/dev/null 2>&1; then
            crunning="1"; cdetail="未记录归属的 pid $(pgrep -x cloudflared | head -n1)"
            WA "检测到 cloudflared，但它没有本项目 PID 记录；请确认该进程连接的是当前隧道"
        fi
        check "cloudflared 运行状态" "$crunning" "$cdetail"

        if [ -n "$DOMAIN" ]; then
            local pc; pc="$(code_of "https://${DOMAIN}/favicon.svg")"
            check "公网 CF→隧道→机器人" "$([ "$pc" = "200" ] && echo 1 || echo 0)" "HTTP $pc"
        else
            WA "BOT_DOMAIN/data/state/bot-domain 未设置，跳过公网健康检查"
        fi
    fi

    local models_ok="0"
    if [ -s "$MODELS_FILE" ]; then
        if command -v jq >/dev/null 2>&1; then
            jq -e '.providers | type == "object" and length > 0' "$MODELS_FILE" >/dev/null 2>&1 && models_ok="1"
        else
            grep -q '"providers"' "$MODELS_FILE" && models_ok="1"
        fi
    fi
    check "data/config/models.json" "$models_ok" "$([ "$models_ok" = "1" ] && echo 有效 || echo '缺少或无效')"

    local secret_ok="0"
    [ -f "$WEBHOOK_SECRET_FILE" ] &&
        grep -Eq '^[0-9a-fA-F]{64}$' "$WEBHOOK_SECRET_FILE" &&
        secret_ok="1"
    check "data/config/webhook-secret" "$secret_ok" "$([ "$secret_ok" = "1" ] && echo 有效 || echo '缺少或无效（生产服务拒绝启动）')"

    echo ""
    echo -e "结果：${GREEN}${PASS} 项通过${NC}，${RED}${FAIL} 项失败${NC}"
    if [ "$FAIL" -gt 0 ]; then
        [ "$group_root_ok" = "1" ] || WA "       群数据根失败 -> 重新运行 scripts/deploy/deploy.sh 并确认目录；"
        if [ "$DEPLOY_MODE" = "cloudflare" ]; then
            WA "提示：公网 530/1033 通常表示隧道断开；公网 502 表示隧道到达但机器人源站不可用。"
        fi
        WA "       本地失败 -> 容器未运行（scripts/ops/ops.sh restart）；"
        WA "       secret 缺少 -> 重新运行 scripts/deploy/deploy.sh"
        return 1
    else
        OK "全部检查通过"
        return 0
    fi
}

restart_bot() {
    P "重新启动容器..."
    if ! has_container; then ER "找不到容器 '$CONTAINER'；请先运行 scripts/deploy/deploy.sh"; return 1; fi
    docker restart "$CONTAINER" >/dev/null 2>&1 || { ER "docker restart 失败"; return 1; }
    local lc
    if lc="$(wait_for_local)"; then OK "机器人已恢复（:${PORT} 返回 HTTP 200）"
    else WA "机器人仍未响应（HTTP $lc）；请尝试 scripts/ops/ops.sh logs"; return 1; fi
}

stop_bot() {
    P "停止容器..."
    if docker stop "$CONTAINER" >/dev/null 2>&1; then OK "容器已停止"
    else WA "没有正在运行的容器"; fi
}

start_bot() {
    P "启动容器..."
    docker start "$CONTAINER" >/dev/null 2>&1 || { ER "启动失败；请先运行 scripts/deploy/deploy.sh"; return 1; }
    local lc
    if lc="$(wait_for_local)"; then OK "机器人已启动（:${PORT} 返回 HTTP 200）"
    else WA "机器人未通过健康检查（HTTP $lc）；请尝试 scripts/ops/ops.sh logs"; return 1; fi
}

# git 只在这里用；GIT_TERMINAL_PROMPT=0 让缺凭证时立刻失败，而不是挂在无人应答的提示上。
git_here() {
    GIT_TERMINAL_PROMPT=0 git -C "$PROJECT_DIR" "$@"
}

restore_checkout() {
    local branch="$1" sha="$2"
    if [ -n "$branch" ] && [ "$branch" != "HEAD" ]; then
        git_here checkout "$branch" >/dev/null 2>&1 || { ER "切回分支 ${branch} 失败"; return 1; }
    fi
    git_here reset --hard "$sha" >/dev/null 2>&1 || { ER "回滚到 ${sha} 失败"; return 1; }
}

update() {
    local deploy_script="${PROJECT_DIR}/scripts/deploy/deploy.sh"
    P "同步到 origin/main 并重新部署"

    if ! command -v git >/dev/null 2>&1; then
        ER "找不到 git；无法自动更新"
        return 1
    fi
    if ! git_here rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        ER "${PROJECT_DIR} 不是 git 仓库，无法自动更新"
        WA "这份部署可能是解压得到的；请改用 git clone 重新部署后再使用 update"
        return 1
    fi
    if [ ! -f "$deploy_script" ]; then
        ER "找不到部署脚本：$deploy_script"
        return 1
    fi

    # 已跟踪文件的改动会被后面的 checkout/reset 冲掉，必须先拦下来。只看已跟踪文件：
    # 未跟踪文件不会被这些操作动到，拿它们挡住升级只会让这条命令永远跑不起来。
    # data/ 和 logs/ 都在 .gitignore 里，配置与群数据本来就不算改动。
    local dirty
    dirty="$(git_here status --porcelain --untracked-files=no 2>&1)"
    if [ -n "$dirty" ]; then
        ER "已跟踪文件有未提交的改动，已停止升级："
        printf '%s\n' "$dirty" | sed 's/^/      /'
        WA "请先提交、撤销（git restore <文件>）或备份这些改动，然后重试"
        return 1
    fi

    local original_branch original_sha
    original_branch="$(git_here rev-parse --abbrev-ref HEAD 2>/dev/null)"
    original_sha="$(git_here rev-parse HEAD 2>/dev/null)"
    if [ -z "$original_sha" ]; then ER "无法读取当前提交"; return 1; fi

    P "拉取 origin/main..."
    if ! git_here fetch --prune origin main; then
        ER "git fetch 失败"
        return 1
    fi

    if [ "$original_branch" != "main" ]; then
        WA "当前在分支 ${original_branch}，不是 main"
        if ! ask_yes_no "切换到 main 并继续升级？[y/N] "; then
            WA "已取消升级"
            return 1
        fi
        if ! git_here checkout main; then
            ER "切换到 main 失败"
            return 1
        fi
    fi

    local current_sha target_sha
    current_sha="$(git_here rev-parse HEAD)"
    target_sha="$(git_here rev-parse origin/main 2>/dev/null)"
    if [ -z "$target_sha" ]; then
        ER "无法解析 origin/main；请确认远端存在 main 分支"
        return 1
    fi

    if [ "$current_sha" = "$target_sha" ]; then
        OK "已经是 origin/main 最新版本（${target_sha:0:7}）"
        if ask_yes_no "代码没有变化；仍然重启容器？[y/N] "; then
            restart_bot || return 1
        fi
        echo ""
        doctor
        return $?
    fi

    # 只接受快进。本地有未推送的提交时停下来，而不是替用户决定怎么合并。
    if ! git_here merge-base --is-ancestor HEAD origin/main; then
        ER "本地 main 与 origin/main 已分叉，无法快进升级"
        WA "本地独有的提交："
        git_here log --oneline origin/main..HEAD | sed 's/^/      /'
        WA "请先推送或丢弃这些提交后重试"
        return 1
    fi

    echo ""
    echo -e "${CYAN}将要应用的提交：${NC}"
    git_here log --oneline HEAD..origin/main | sed 's/^/      /'
    echo ""

    if ! git_here merge --ff-only origin/main; then
        ER "git merge --ff-only 失败；代码未改变"
        return 1
    fi
    OK "代码已更新到 ${target_sha:0:7}"

    # Docker 部署升级必须重建镜像，而「重建 + 换容器 + 失败自动换回旧容器」这套逻辑已经
    # 完整存在于 deploy.sh 里。在这里再写一遍等于把最关键的安全逻辑维护成两份，所以直接
    # 交给它；端口、模式、域名、群数据根这些提示都默认沿用当前值，回车即可。
    # 隧道也由 deploy.sh 一并处理，不需要在这里单独重启 cloudflared。
    P "交给 deploy.sh 重建镜像并切换容器（各项提示直接回车即沿用当前配置）..."
    echo ""
    if bash "$deploy_script"; then
        echo ""
        OK "升级完成：${original_sha:0:7} -> ${target_sha:0:7}"
        echo ""
        doctor
        return $?
    fi

    echo ""
    ER "部署失败，正在把代码回滚到 ${original_sha:0:7}..."
    if restore_checkout "$original_branch" "$original_sha"; then
        OK "代码已回滚到升级前的版本"
        WA "deploy.sh 失败时会恢复升级前的容器，机器人多半仍在运行；请执行 ops.sh doctor 确认"
    else
        ER "自动回滚失败；请手动执行：git checkout ${original_branch} && git reset --hard ${original_sha}"
    fi
    return 1
}

show_logs() {
    if ! has_container; then ER "找不到容器 '$CONTAINER'"; return 1; fi
    P "持续查看 Docker 日志（Ctrl+C 退出）"
    docker logs -f --tail 50 "$CONTAINER"
}

uninstall() {
    P "卸载 mixin-chatbot"
    local resolved_group_root=""
    resolved_group_root="$(resolve_group_data_root "$DEPLOYED_GROUP_DATA_ROOT" 2>/dev/null || true)"
    if has_container; then
        if ! docker stop "$CONTAINER" >/dev/null 2>&1; then
            ER "容器停止失败；为避免删除仍在使用的数据，卸载已停止"
            return 1
        fi
        if ! docker rm "$CONTAINER" >/dev/null 2>&1; then
            ER "容器删除失败；卸载已停止"
            return 1
        fi
        OK "容器已删除"
    else
        WA "没有可删除的容器"
    fi
    if has_rollback_container; then
        if ! docker stop "$ROLLBACK_CONTAINER" >/dev/null 2>&1; then
            ER "回滚容器停止失败；卸载已停止"
            return 1
        fi
        if ! docker rm "$ROLLBACK_CONTAINER" >/dev/null 2>&1; then
            ER "回滚容器删除失败；卸载已停止"
            return 1
        fi
        OK "部署遗留回滚容器已删除"
    fi

    if ask_yes_no "是否删除 Docker 镜像 mixin-chatbot？[y/N] "; then
        if docker rmi mixin-chatbot >/dev/null 2>&1; then OK "镜像已删除"; else WA "镜像删除失败"; fi
    fi

    local managed_pid=""
    if managed_pid="$(managed_cloudflared_pid)"; then
        if ask_yes_no "是否停止本项目 cloudflared（pid ${managed_pid}）？[y/N] "; then
            if stop_managed_cloudflared; then OK "本项目 cloudflared 已停止"; else WA "结束 pid ${managed_pid} 失败"; fi
        fi
    elif pgrep -x cloudflared >/dev/null 2>&1; then
        WA "检测到未记录归属的 cloudflared；不会用 pkill 批量停止，请先确认进程归属"
    fi

    if ask_yes_no "是否删除 data/（配置、部署状态、runtime、默认群数据）和 logs/？[y/N] "; then
        if managed_pid="$(managed_cloudflared_pid)"; then
            ER "本项目 cloudflared（pid ${managed_pid}）仍在运行；为避免删除其归属/token 状态，已保留 data/ 和 logs/"
            return 1
        fi
        if rm -rf -- "${PROJECT_DIR}/data" "${PROJECT_DIR}/logs" &&
            [ ! -e "${PROJECT_DIR}/data" ] && [ ! -e "${PROJECT_DIR}/logs" ]; then
            OK "data/ 和 logs/ 已删除"
        else
            ER "data/ 或 logs/ 删除不完整；请检查权限后重试"
            return 1
        fi
    else
        OK "已保留 data/ 和 logs/（配置、状态与默认群数据保留）"
    fi
    if [ -n "$resolved_group_root" ] && [ "$resolved_group_root" != "$DEFAULT_GROUP_DATA_ROOT" ]; then
        WA "自定义群数据根未删除：$resolved_group_root"
    fi
    OK "卸载流程完成。"
}

case "${1:-}" in
    doctor|status) doctor ;;
    update|upgrade) update ;;
    restart)   restart_bot ;;
    stop)      stop_bot ;;
    start)     start_bot ;;
    logs)      show_logs ;;
    uninstall) uninstall ;;
    *)
        echo -e "${CYAN}mixin-chatbot 运维工具（Linux/Docker）${NC}"
        echo "用法：./scripts/ops/ops.sh <命令>"
        echo ""
        echo "  doctor     健康检查：群数据根、容器、:$PORT、配置；隧道模式额外检查 Cloudflare"
        echo "  update     同步 origin/main，再交给 deploy.sh 重建并切换容器；失败自动回滚代码"
        echo "  restart    重启 Docker 容器"
        echo "  stop       停止 Docker 容器"
        echo "  start      启动 Docker 容器"
        echo "  logs       持续查看最近 50 行 Docker 日志"
        echo "  uninstall  删除容器（可选镜像、cloudflared、data/、logs/）"
        ;;
esac
