#!/usr/bin/env bash
# mixin-chatbot ops tool (Linux / Docker).
# One-stop: doctor / restart / stop / start / logs / uninstall.
#
# Usage: ./scripts/ops.sh <command>
#   commands: doctor, restart, stop, start, logs, uninstall   (no arg -> menu)
set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER="mixin-chatbot"
PORT="${BOT_PORT:-1011}"
DOMAIN="${BOT_DOMAIN:-im-bot.jaykwok.net}"

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
    curl -s -o /dev/null -w "%{http_code}" -m 10 "$1" 2>/dev/null || true
}

has_container() {
    docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER}$"
}

doctor() {
    P "mixin-chatbot health check (domain=$DOMAIN, port=$PORT)"
    PASS=0; FAIL=0

    local cstate="missing"
    if has_container; then
        cstate="$(docker inspect --format '{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo "?")"
    fi
    check "container" "$([ "$cstate" = "running" ] && echo 1 || echo 0)" "$cstate"

    local lc; lc="$(code_of "http://localhost:${PORT}/favicon.svg")"
    check "local bot health" "$([ "$lc" = "200" ] && echo 1 || echo 0)" "HTTP $lc"

    local crunning="0" cdetail="no"
    if pgrep -x cloudflared >/dev/null 2>&1; then
        crunning="1"; cdetail="pid $(pgrep -x cloudflared | head -n1)"
    fi
    check "cloudflared running" "$crunning" "$cdetail"

    local pc; pc="$(code_of "https://${DOMAIN}/favicon.svg")"
    check "public CF->tunnel->bot" "$([ "$pc" = "200" ] && echo 1 || echo 0)" "HTTP $pc"

    check "data/models.json"    "$([ -f "${PROJECT_DIR}/data/models.json" ] && echo 1 || echo 0)" \
        "$([ -f "${PROJECT_DIR}/data/models.json" ] && echo present || echo MISSING)"
    check "data/webhook-secret" "$([ -f "${PROJECT_DIR}/data/webhook-secret" ] && echo 1 || echo 0)" \
        "$([ -f "${PROJECT_DIR}/data/webhook-secret" ] && echo present || echo 'MISSING (open /webhook)')"

    echo ""
    echo -e "result: ${GREEN}${PASS} pass${NC}, ${RED}${FAIL} fail${NC}"
    if [ "$FAIL" -gt 0 ]; then
        WA "hints: public 530/1033 -> tunnel down (start cloudflared / start-tunnel.sh);"
        WA "       public 502 -> tunnel up but bot down (ops.sh restart); local fail -> container down (ops.sh restart);"
        WA "       secret MISSING -> re-run deploy.sh"
    else
        OK "all checks passed"
    fi
}

restart_bot() {
    P "restarting container..."
    if ! has_container; then ER "container '$CONTAINER' not found; run deploy.sh first"; return; fi
    docker restart "$CONTAINER" >/dev/null 2>&1 || { ER "docker restart failed"; return; }
    sleep 2
    local lc; lc="$(code_of "http://localhost:${PORT}/favicon.svg")"
    if [ "$lc" = "200" ]; then OK "bot back up (HTTP 200 on :${PORT})"
    else WA "bot not responding yet (HTTP $lc); try 'ops.sh logs'"; fi
}

stop_bot() {
    P "stopping container..."
    if docker stop "$CONTAINER" >/dev/null 2>&1; then OK "container stopped"
    else WA "no running container to stop"; fi
}

start_bot() {
    P "starting container..."
    if docker start "$CONTAINER" >/dev/null 2>&1; then OK "container started"
    else ER "start failed; run deploy.sh first"; fi
}

show_logs() {
    if ! has_container; then ER "container '$CONTAINER' not found"; return; fi
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
    read -rp "Delete data/ (models.json, sessions, webhook-secret) and logs/? [y/N] " d || true
    if [[ "$d" =~ ^[Yy]$ ]]; then
        rm -rf "${PROJECT_DIR}/data" "${PROJECT_DIR}/logs"
        OK "data/ and logs/ removed"
    else
        OK "data/ and logs/ kept (models.json + sessions preserved)"
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
        echo "usage: ./scripts/ops.sh <command>"
        echo ""
        echo "  doctor     health check: container, :$PORT local+public reachability, cloudflared, config files"
        echo "  restart    docker restart"
        echo "  stop       docker stop"
        echo "  start      docker start"
        echo "  logs       docker logs -f --tail 50"
        echo "  uninstall  remove container (+optional image, cloudflared, data/, logs/)"
        ;;
esac
