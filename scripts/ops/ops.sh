#!/usr/bin/env bash
# mixin-chatbot 运维工具（Linux / Docker）。
# 一站式运维：doctor / restart / stop / start / logs / uninstall。
#
# 用法：./scripts/ops/ops.sh <命令>
#   命令：doctor、restart、stop、start、logs、uninstall（不带参数显示帮助）
set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONTAINER="mixin-chatbot"
if [ -n "${BOT_PORT:-}" ]; then
    PORT="$BOT_PORT"
elif [ -f "${PROJECT_DIR}/data/bot-port" ]; then
    PORT="$(tr -d '[:space:]' < "${PROJECT_DIR}/data/bot-port")"
else
    PORT="1011"
fi
if [ -f "${PROJECT_DIR}/data/deploy-mode" ]; then
    DEPLOY_MODE="$(tr -d '[:space:]' < "${PROJECT_DIR}/data/deploy-mode")"
else
    DEPLOY_MODE="direct"
fi
if [ -n "${BOT_DOMAIN:-}" ]; then
    DOMAIN="$BOT_DOMAIN"
elif [ -f "${PROJECT_DIR}/data/bot-domain" ]; then
    DOMAIN="$(tr -d '[:space:]' < "${PROJECT_DIR}/data/bot-domain")"
else
    DOMAIN=""
fi
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
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
    echo "BOT_PORT/data/bot-port 中的端口无效：$PORT" >&2
    exit 1
fi
if [ "$DEPLOY_MODE" != "direct" ] && [ "$DEPLOY_MODE" != "cloudflare" ]; then
    echo "data/deploy-mode 中的部署模式无效：$DEPLOY_MODE" >&2
    exit 1
fi
if [ -n "$DOMAIN" ] && ! is_valid_hostname "$DOMAIN"; then
    echo "BOT_DOMAIN/data/bot-domain 中的 hostname 无效：$DOMAIN" >&2
    exit 1
fi

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'
P()  { echo -e "${BLUE}[*]${NC} $1"; }
OK() { echo -e "${GREEN}[+]${NC} $1"; }
WA() { echo -e "${YELLOW}[!]${NC} $1"; }
ER() { echo -e "${RED}[x]${NC} $1"; }

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

has_container() {
    docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER}$"
}

doctor() {
    local mode_label="直连"
    [ "$DEPLOY_MODE" = "cloudflare" ] && mode_label="Cloudflare"
    P "mixin-chatbot 健康检查（模式=$mode_label，端口=$PORT）"
    PASS=0; FAIL=0

    local cstate="缺少"
    if has_container; then
        cstate="$(docker inspect --format '{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo "?")"
    fi
    local cstate_label="$cstate"
    [ "$cstate" = "running" ] && cstate_label="运行中"
    [ "$cstate" = "exited" ] && cstate_label="已退出"
    check "容器" "$([ "$cstate" = "running" ] && echo 1 || echo 0)" "$cstate_label"

    local lc; lc="$(code_of "http://localhost:${PORT}/favicon.svg")"
    check "本地机器人健康" "$([ "$lc" = "200" ] && echo 1 || echo 0)" "HTTP $lc"

    if [ "$DEPLOY_MODE" = "cloudflare" ]; then
        local crunning="0" cdetail="未运行"
        if pgrep -x cloudflared >/dev/null 2>&1; then
            crunning="1"; cdetail="pid $(pgrep -x cloudflared | head -n1)"
        fi
        check "cloudflared 运行状态" "$crunning" "$cdetail"

        if [ -n "$DOMAIN" ]; then
            local pc; pc="$(code_of "https://${DOMAIN}/favicon.svg")"
            check "公网 CF→隧道→机器人" "$([ "$pc" = "200" ] && echo 1 || echo 0)" "HTTP $pc"
        else
            WA "BOT_DOMAIN/data/bot-domain 未设置，跳过公网健康检查"
        fi
    fi

    local models_ok="0"
    if [ -s "${PROJECT_DIR}/data/models.json" ]; then
        if command -v jq >/dev/null 2>&1; then
            jq -e '.providers | type == "object" and length > 0' "${PROJECT_DIR}/data/models.json" >/dev/null 2>&1 && models_ok="1"
        else
            grep -q '"providers"' "${PROJECT_DIR}/data/models.json" && models_ok="1"
        fi
    fi
    check "data/models.json" "$models_ok" "$([ "$models_ok" = "1" ] && echo 有效 || echo '缺少或无效')"

    local secret_ok="0"
    [ -f "${PROJECT_DIR}/data/webhook-secret" ] &&
        grep -Eq '^[0-9a-fA-F]{32,64}$' "${PROJECT_DIR}/data/webhook-secret" &&
        secret_ok="1"
    check "data/webhook-secret" "$secret_ok" "$([ "$secret_ok" = "1" ] && echo 有效 || echo '缺少或无效（生产服务拒绝启动）')"

    echo ""
    echo -e "结果：${GREEN}${PASS} 项通过${NC}，${RED}${FAIL} 项失败${NC}"
    if [ "$FAIL" -gt 0 ]; then
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

show_logs() {
    if ! has_container; then ER "找不到容器 '$CONTAINER'"; return 1; fi
    P "持续查看 Docker 日志（Ctrl+C 退出）"
    docker logs -f --tail 50 "$CONTAINER"
}

uninstall() {
    P "卸载 mixin-chatbot"
    docker stop "$CONTAINER" >/dev/null 2>&1 || true
    if docker rm "$CONTAINER" >/dev/null 2>&1; then OK "容器已删除"; else WA "没有可删除的容器"; fi

    local a=""
    read -rp "是否删除 Docker 镜像 mixin-chatbot？[y/N] " a || true
    if [[ "$a" =~ ^[Yy]$ ]]; then
        if docker rmi mixin-chatbot >/dev/null 2>&1; then OK "镜像已删除"; else WA "镜像删除失败"; fi
    fi

    if pgrep -x cloudflared >/dev/null 2>&1; then
        local b=""
        read -rp "是否停止 cloudflared（结束进程）？[y/N] " b || true
        if [[ "$b" =~ ^[Yy]$ ]]; then
            if pkill -x cloudflared; then OK "cloudflared 已停止"; else WA "结束进程失败"; fi
        fi
    fi

    local d=""
    read -rp "是否删除 data/（models.json、webhook-secret、默认群数据）和 logs/？[y/N] " d || true
    if [[ "$d" =~ ^[Yy]$ ]]; then
        rm -rf "${PROJECT_DIR}/data" "${PROJECT_DIR}/logs"
        OK "data/ 和 logs/ 已删除"
    else
        OK "已保留 data/ 和 logs/（配置与默认群数据保留）"
    fi
    OK "卸载流程完成。"
}

case "${1:-}" in
    doctor|status) doctor ;;
    restart)   restart_bot ;;
    stop)      stop_bot ;;
    start)     start_bot ;;
    logs)      show_logs ;;
    uninstall) uninstall ;;
    *)
        echo -e "${CYAN}mixin-chatbot 运维工具（Linux/Docker）${NC}"
        echo "用法：./scripts/ops/ops.sh <命令>"
        echo ""
        echo "  doctor     健康检查：容器、:$PORT、配置；隧道模式额外检查 Cloudflare"
        echo "  restart    重启 Docker 容器"
        echo "  stop       停止 Docker 容器"
        echo "  start      启动 Docker 容器"
        echo "  logs       持续查看最近 50 行 Docker 日志"
        echo "  uninstall  删除容器（可选镜像、cloudflared、data/、logs/）"
        ;;
esac
