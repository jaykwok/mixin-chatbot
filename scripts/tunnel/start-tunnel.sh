#!/usr/bin/env bash
# 云电脑本地对接脚本：起 cloudflared，把 Cloudflare Tunnel 接到本机 BOT_PORT（默认 1011）。
#
# 前置：
#   1) 机器人已在本机 BOT_PORT 跑起来（./scripts/deploy/deploy.sh 选 Cloudflare 模式）
#   2) 隧道 token。来源（按优先级）：
#        位置参数：./scripts/tunnel/start-tunnel.sh <token或文件> # 完整 token 或文件路径
#        环境变量：TUNNEL_TOKEN_FILE=<路径>                   # 指定文件
#        环境变量：TUNNEL_TOKEN=<裸 token>                    # 直接给值
#        默认：    data/config/cloudflared-token              # 输入与运行共用
#      token 文件可以是裸 token，也可以是直接拷来的 .env
#      （也可直接使用内含 TUNNEL_TOKEN=<值> 的 .env 文件）。
#
# 用法： ./scripts/tunnel/start-tunnel.sh [token或文件]
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_DIR"
BOT_PORT_FILE="${PROJECT_DIR}/data/state/bot-port"
TUNNEL_PID_FILE="${PROJECT_DIR}/data/state/cloudflared.pid"

. "$PROJECT_DIR/scripts/lib/common.sh"

logging_mode="$(cloudflared_logging)"
protocol="$(cloudflared_protocol)"
cloudflared_log_args "$logging_mode"
if [ "$logging_mode" = on ]; then
    mkdir -p "$PROJECT_DIR/logs"
fi

if existing_pid="$(managed_cloudflared_pid)"; then
    echo "✓ 本项目 cloudflared 已在运行（pid ${existing_pid}）"
    exit 0
fi

if [ -n "${BOT_PORT:-}" ]; then
    BOT_PORT="$BOT_PORT"
elif [ -f "$BOT_PORT_FILE" ]; then
    BOT_PORT="$(tr -d '[:space:]' < "$BOT_PORT_FILE")"
else
    BOT_PORT="1011"
fi
if ! [[ "$BOT_PORT" =~ ^[0-9]+$ ]] || [ "$BOT_PORT" -lt 1 ] || [ "$BOT_PORT" -gt 65535 ]; then
    echo "✗ BOT_PORT 必须是 1–65535 的整数" >&2
    exit 1
fi

# ---- 1. 取 token（位置参数 > TUNNEL_TOKEN_FILE > TUNNEL_TOKEN > 默认文件）----
if ! load_tunnel_token "${1:-${MIXIN_TUNNEL_TOKEN_INPUT:-}}"; then
    show_tunnel_token_help >&2
    exit 1
fi
unset MIXIN_TUNNEL_TOKEN_INPUT TUNNEL_TOKEN
echo "ℹ token 来源：$TUNNEL_TOKEN_SOURCE"

# ---- 2. 只使用项目根目录的 cloudflared；缺失或不可用时下载并校验。 ----
cloudflared_path="$(ensure_cloudflared "$PROJECT_DIR")"

# ---- 3. 连接前的确认：连到哪条隧道、本机有没有东西可转发 ----
#
# token 是 base64 过的 JSON：{"a":"<账号>","t":"<隧道 id>","s":"<密钥>"}。打印前两个字段
# 让人看清将要接入哪条隧道，secret 一个字符都不输出。解不开就跳过，这只是给人看的信息。
if command -v base64 >/dev/null 2>&1; then
    tunnel_identity="$(
        printf '%s' "$TUNNEL_TOKEN_VALUE" | tr '_-' '/+' \
            | { padded="$(cat)"; case $(( ${#padded} % 4 )) in
                    2) printf '%s==' "$padded" ;;
                    3) printf '%s=' "$padded" ;;
                    *) printf '%s' "$padded" ;;
                esac; } \
            | base64 -d 2>/dev/null \
            | sed -n 's/.*"t"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
    )" || tunnel_identity=""
    [ -n "$tunnel_identity" ] && echo "▸ 目标隧道：${tunnel_identity}"
fi

# 连接器注册后会参与分流；默认要求本地服务健康，避免向无服务实例导入生产流量。
if bot_local_ready "$BOT_PORT" >/dev/null 2>&1; then
    echo "✓ 本机 :${BOT_PORT} 机器人在线"
elif [ "${TUNNEL_ALLOW_NO_BOT:-}" = "1" ]; then
    echo "⚠ 本机 :${BOT_PORT} 无响应，但 TUNNEL_ALLOW_NO_BOT=1，继续连接" >&2
else
    {
        echo "✗ 已中止：本机 :${BOT_PORT} 上没有机器人在监听，不能把这台机器接进隧道"
        echo "  连上之后 Cloudflare 会把流量分给它，而它无处可转发，只会返回 502；"
        echo "  如果隧道里还有正常的连接器，表现就是时好时坏，非常难查。"
        echo
        echo "  · 要在这台机器上部署：先使用 $(ops_command_hint deploy)（Cloudflare 模式）再回来"
        echo "  · 只是想测试本脚本：别用生产 token，用 TUNNEL_TOKEN 指向一条测试隧道"
        echo "  · 确认就是要这么连：TUNNEL_ALLOW_NO_BOT=1 后重跑"
    } >&2
    exit 1
fi

# ---- 4. 起隧道（前台）----
echo "▶ 启动 cloudflared connector（控制台 Published application 应配置为 http://localhost:${BOT_PORT}）"
echo "  （前台运行，Ctrl+C 停止。常驻开机自启可用 systemd/tmux 包一层）"
token_path="$(save_project_tunnel_token "$TUNNEL_TOKEN_VALUE")"
unset TUNNEL_TOKEN_VALUE
record_cloudflared_pid "$$"
# Background console output must not also append to the rolling file, or to an unlinked
# startup capture forever. Foreground use still prints native diagnostics to the terminal.
if [ "${CLOUDFLARED_BACKGROUND:-}" = 1 ]; then exec >/dev/null 2>&1; fi
umask 077
exec "$cloudflared_path" tunnel --no-autoupdate --protocol "$protocol" "${CLOUDFLARED_LOG_ARGS[@]}" run --token-file "$token_path"
