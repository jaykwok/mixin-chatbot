#!/usr/bin/env bash
# mixin-chatbot ops tool (Linux / Docker).
# One-stop: doctor / restart / stop / start / logs / uninstall.
#
# Usage: ./scripts/ops/ops.sh <command>
#   commands: doctor, restart, stop, start, logs, uninstall   (no arg -> menu)
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
    echo "invalid bot port in BOT_PORT/data/bot-port: $PORT" >&2
    exit 1
fi
if [ "$DEPLOY_MODE" != "direct" ] && [ "$DEPLOY_MODE" != "cloudflare" ]; then
    echo "invalid deployment mode in data/deploy-mode: $DEPLOY_MODE" >&2
    exit 1
fi
if [ -n "$DOMAIN" ] && ! is_valid_hostname "$DOMAIN"; then
    echo "invalid hostname in BOT_DOMAIN/data/bot-domain: $DOMAIN" >&2
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

# HTTP status code of a URL (curl prints "000" on connection failure).
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
    P "mixin-chatbot health check (mode=$DEPLOY_MODE, port=$PORT)"
    PASS=0; FAIL=0

    local cstate="missing"
    if has_container; then
        cstate="$(docker inspect --format '{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo "?")"
    fi
    check "container" "$([ "$cstate" = "running" ] && echo 1 || echo 0)" "$cstate"

    local lc; lc="$(code_of "http://localhost:${PORT}/favicon.svg")"
    check "local bot health" "$([ "$lc" = "200" ] && echo 1 || echo 0)" "HTTP $lc"

    if [ "$DEPLOY_MODE" = "cloudflare" ]; then
        local crunning="0" cdetail="no"
        if pgrep -x cloudflared >/dev/null 2>&1; then
            crunning="1"; cdetail="pid $(pgrep -x cloudflared | head -n1)"
        fi
        check "cloudflared running" "$crunning" "$cdetail"

        if [ -n "$DOMAIN" ]; then
            local pc; pc="$(code_of "https://${DOMAIN}/favicon.svg")"
            check "public CF->tunnel->bot" "$([ "$pc" = "200" ] && echo 1 || echo 0)" "HTTP $pc"
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
    check "data/models.json" "$models_ok" "$([ "$models_ok" = "1" ] && echo valid || echo 'MISSING/INVALID')"

    local secret_ok="0"
    [ -f "${PROJECT_DIR}/data/webhook-secret" ] &&
        grep -Eq '^[0-9a-fA-F]{32,64}$' "${PROJECT_DIR}/data/webhook-secret" &&
        secret_ok="1"
    check "data/webhook-secret" "$secret_ok" "$([ "$secret_ok" = "1" ] && echo valid || echo 'MISSING/INVALID (service refuses to start)')"

    echo ""
    echo -e "result: ${GREEN}${PASS} pass${NC}, ${RED}${FAIL} fail${NC}"
    if [ "$FAIL" -gt 0 ]; then
        if [ "$DEPLOY_MODE" = "cloudflare" ]; then
            WA "hints: public 530/1033 -> tunnel down; public 502 -> tunnel up but bot down;"
        fi
        WA "       local fail -> container down (scripts/ops/ops.sh restart);"
        WA "       secret MISSING -> re-run scripts/deploy/deploy.sh"
        return 1
    else
        OK "all checks passed"
        return 0
    fi
}

restart_bot() {
    P "restarting container..."
    if ! has_container; then ER "container '$CONTAINER' not found; run scripts/deploy/deploy.sh first"; return 1; fi
    docker restart "$CONTAINER" >/dev/null 2>&1 || { ER "docker restart failed"; return 1; }
    local lc
    if lc="$(wait_for_local)"; then OK "bot back up (HTTP 200 on :${PORT})"
    else WA "bot not responding yet (HTTP $lc); try 'scripts/ops/ops.sh logs'"; return 1; fi
}

stop_bot() {
    P "stopping container..."
    if docker stop "$CONTAINER" >/dev/null 2>&1; then OK "container stopped"
    else WA "no running container to stop"; fi
}

start_bot() {
    P "starting container..."
    docker start "$CONTAINER" >/dev/null 2>&1 || { ER "start failed; run scripts/deploy/deploy.sh first"; return 1; }
    local lc
    if lc="$(wait_for_local)"; then OK "bot started (HTTP 200 on :${PORT})"
    else WA "bot did not become healthy (HTTP $lc); try 'scripts/ops/ops.sh logs'"; return 1; fi
}

show_logs() {
    if ! has_container; then ER "container '$CONTAINER' not found"; return 1; fi
    P "tailing docker logs (Ctrl+C to exit)"
    docker logs -f --tail 50 "$CONTAINER"
}

uninstall() {
    P "uninstall mixin-chatbot"
    docker stop "$CONTAINER" >/dev/null 2>&1 || true
    if docker rm "$CONTAINER" >/dev/null 2>&1; then OK "container removed"; else WA "no container to remove"; fi

    local a=""
    read -rp "Remove the docker image 'mixin-chatbot'? [y/N] " a || true
    if [[ "$a" =~ ^[Yy]$ ]]; then
        if docker rmi mixin-chatbot >/dev/null 2>&1; then OK "image removed"; else WA "image remove failed"; fi
    fi

    if pgrep -x cloudflared >/dev/null 2>&1; then
        local b=""
        read -rp "Stop cloudflared (kill process)? [y/N] " b || true
        if [[ "$b" =~ ^[Yy]$ ]]; then
            if pkill -x cloudflared; then OK "cloudflared stopped"; else WA "pkill failed"; fi
        fi
    fi

    local d=""
    read -rp "Delete data/ (models.json, webhook-secret, default group data) and logs/? [y/N] " d || true
    if [[ "$d" =~ ^[Yy]$ ]]; then
        rm -rf "${PROJECT_DIR}/data" "${PROJECT_DIR}/logs"
        OK "data/ and logs/ removed"
    else
        OK "data/ and logs/ kept (config + default group data preserved)"
    fi
    OK "uninstall complete."
}

case "${1:-}" in
    doctor|status) doctor ;;
    restart)   restart_bot ;;
    stop)      stop_bot ;;
    start)     start_bot ;;
    logs)      show_logs ;;
    uninstall) uninstall ;;
    *)
        echo -e "${CYAN}mixin-chatbot ops tool (Linux/Docker)${NC}"
        echo "usage: ./scripts/ops/ops.sh <command>"
        echo ""
        echo "  doctor     health check: container, :$PORT, config; Cloudflare checks only in tunnel mode"
        echo "  restart    docker restart"
        echo "  stop       docker stop"
        echo "  start      docker start"
        echo "  logs       docker logs -f --tail 50"
        echo "  uninstall  remove container (+optional image, cloudflared, data/, logs/)"
        ;;
esac
