#!/usr/bin/env bash
# 云电脑本地对接脚本：起 cloudflared，把 Cloudflare Tunnel 接到本机 BOT_PORT（默认 1011）。
#
# 前置：
#   1) 机器人已在本机 BOT_PORT 跑起来（./scripts/deploy/deploy.sh 选 Cloudflare 模式）
#   2) 隧道 token。来源（按优先级）：
#        位置参数：./scripts/tunnel/start-tunnel.sh <token文件>   # 路径，相对或绝对
#        环境变量：TUNNEL_TOKEN_FILE=<路径>                   # 指定文件
#        环境变量：TUNNEL_TOKEN=<裸 token>                    # 直接给值
#        默认：    data/config/tunnel-token                   # 裸值或 .env 形式均可
#      token 文件可以是裸 token，也可以是直接拷来的 .env
#      （也可直接使用内含 TUNNEL_TOKEN=<值> 的 .env 文件）。
#
# 用法： ./scripts/tunnel/start-tunnel.sh [token文件]
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_DIR"
BOT_PORT_FILE="${PROJECT_DIR}/data/state/bot-port"
DEFAULT_TUNNEL_TOKEN_FILE="${PROJECT_DIR}/data/config/tunnel-token"
TUNNEL_PID_FILE="${PROJECT_DIR}/data/state/cloudflared.pid"

managed_tunnel_pid() {
    local pid="" process_name=""
    [ -f "$TUNNEL_PID_FILE" ] || return 1
    pid="$(tr -d '[:space:]' < "$TUNNEL_PID_FILE")"
    [[ "$pid" =~ ^[0-9]+$ ]] || { rm -f -- "$TUNNEL_PID_FILE"; return 1; }
    process_name="$(ps -p "$pid" -o comm= 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [ "${process_name##*/}" = "cloudflared" ] || { rm -f -- "$TUNNEL_PID_FILE"; return 1; }
    printf '%s' "$pid"
}

if existing_pid="$(managed_tunnel_pid)"; then
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

# 从 token 文件取值。三种结局，靠退出码区分：
#   0 → 文件是 .env 且 TUNNEL_TOKEN 有值，值已打印到 stdout
#   7 → 文件里没有任何 KEY=VALUE 行，按裸 token 文件处理
#   8 → 文件确实是 .env，但 TUNNEL_TOKEN 缺失或为空
# 第三种必须和第二种分开：把整个 .env 当裸 token 读进来，清洗掉非 base64 字符之后
# 剩下的仍然是个非空字符串（`FOO=bar` 全是合法字符），于是一个由别的变量拼出来的
# 伪 token 会被原样喂给 cloudflared，报错还指向隧道本身。
extract_env_token() {
    awk '
        /^[[:space:]]*TUNNEL_TOKEN[[:space:]]*=/ {
            envlike = 1
            sub(/^[^=]*=/, "")
            gsub(/^[[:space:]]+|[[:space:]\r]+$/, "")
            gsub(/^["'\'']+|["'\'']+$/, "")
            if (length($0) > 0) { print; found = 1; exit }
            next
        }
        /^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/ { envlike = 1 }
        END {
            if (found) exit 0
            exit (envlike ? 8 : 7)
        }
    ' "$1"
}

# ---- 1. 取 token（位置参数 > TUNNEL_TOKEN_FILE > TUNNEL_TOKEN > 默认文件）----
if [ "$#" -ge 1 ] && [ -n "$1" ]; then
    TOKEN_FILE="$1"
elif [ -n "${TUNNEL_TOKEN_FILE:-}" ]; then
    TOKEN_FILE="$TUNNEL_TOKEN_FILE"
elif [ -n "${TUNNEL_TOKEN:-}" ]; then
    TOKEN_FILE=""
    echo "ℹ 使用环境变量 TUNNEL_TOKEN"
else
    TOKEN_FILE="$DEFAULT_TUNNEL_TOKEN_FILE"
fi

if [ -n "$TOKEN_FILE" ]; then
    if [ ! -f "$TOKEN_FILE" ]; then
        echo "✗ 未找到隧道 token 文件：$TOKEN_FILE" >&2
        echo "  优先级：位置参数 > TUNNEL_TOKEN_FILE > TUNNEL_TOKEN > data/config/tunnel-token" >&2
        exit 1
    fi
    extract_rc=0
    val="$(extract_env_token "$TOKEN_FILE")" || extract_rc=$?
    case "$extract_rc" in
        0) TUNNEL_TOKEN="$val" ;;
        7) TUNNEL_TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")" ;;
        *)
            echo "✗ ${TOKEN_FILE} 看起来是 .env 文件，但其中的 TUNNEL_TOKEN 缺失或为空" >&2
            echo "  请补上 TUNNEL_TOKEN=<值>，或改用只含裸 token 的文件" >&2
            exit 1
            ;;
    esac
    echo "ℹ token 来自文件：$(cd "$(dirname "$TOKEN_FILE")" && pwd)/$(basename "$TOKEN_FILE")"
fi

# 统一清洗：只保留 base64 字符（去空白/引号/BOM/CR）
TUNNEL_TOKEN="$(printf '%s' "$TUNNEL_TOKEN" | tr -cd 'A-Za-z0-9+/=_-')"
# 与 start-tunnel.ps1 的 Test-TunnelTokenValue 对齐：只判非空拦不住明显不是 token 的
# 输入（一个字符也算非空），真实的 connector token 是几百字符的 base64。
if [ "${#TUNNEL_TOKEN}" -lt 20 ]; then
    echo "✗ token 为空或格式明显无效（清洗后长度不足 20）" >&2
    exit 1
fi

# ---- 2. 确保 cloudflared ----
if ! command -v cloudflared >/dev/null 2>&1; then
    echo "cloudflared 未安装，尝试安装（Linux）..."
    if [ "$(uname -s)" = "Linux" ] && command -v curl >/dev/null 2>&1; then
        ARCH=$(uname -m)
        case "$ARCH" in
            x86_64)       BIN=cloudflared-linux-amd64;;
            aarch64|arm64) BIN=cloudflared-linux-arm64;;
            *) echo "✗ 不支持的架构 $ARCH，请手动安装 cloudflared" >&2; exit 1;;
        esac
        CF_TMP="$(mktemp)"
        trap 'rm -f "$CF_TMP"' EXIT
        if ! curl -fsSL -o "$CF_TMP" \
            "https://github.com/cloudflare/cloudflared/releases/latest/download/$BIN"; then
            echo "✗ 下载 cloudflared 失败，请检查网络后重试" >&2
            exit 1
        fi
        chmod +x "$CF_TMP"
        if ! "$CF_TMP" --version >/dev/null 2>&1; then
            echo "✗ 下载的 cloudflared 无法运行" >&2
            exit 1
        fi
        if [ "$(id -u)" -eq 0 ]; then
            install -m 0755 "$CF_TMP" /usr/local/bin/cloudflared || {
                echo "✗ 安装 cloudflared 失败" >&2
                exit 1
            }
        elif command -v sudo >/dev/null 2>&1; then
            sudo install -m 0755 "$CF_TMP" /usr/local/bin/cloudflared || {
                echo "✗ 通过 sudo 安装 cloudflared 失败" >&2
                exit 1
            }
        else
            echo "✗ 安装到 /usr/local/bin 需要 root 或 sudo" >&2
            exit 1
        fi
        rm -f "$CF_TMP"
        trap - EXIT
    else
        echo "✗ 请先安装 cloudflared：" >&2
        echo "  Linux:   https://pkg.cloudflare.com/cloudflared 或下载二进制到 /usr/local/bin" >&2
        echo "  macOS:   brew install cloudflared" >&2
        echo "  Windows: https://github.com/cloudflare/cloudflared/releases (cloudflared-windows-amd64.exe)" >&2
        exit 1
    fi
fi

# ---- 3. 连接前的确认：连到哪条隧道、本机有没有东西可转发 ----
#
# token 是 base64 过的 JSON：{"a":"<账号>","t":"<隧道 id>","s":"<密钥>"}。打印前两个字段
# 让人看清将要接入哪条隧道，secret 一个字符都不输出。解不开就跳过，这只是给人看的信息。
if command -v base64 >/dev/null 2>&1; then
    tunnel_identity="$(
        printf '%s' "$TUNNEL_TOKEN" | tr '_-' '/+' \
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

# 机器人不在线时拒绝连接。这不是保守，是这个脚本唯一真正危险的失败模式：
#
# 连接器一连上，Cloudflare 就会开始把生产流量分给这台机器，而它没有可转发的目标，分到它
# 手上的请求只能是 502。隧道通常还有别的连接器在正常服务，于是现象是「一半请求好、一半
# 502」——极难定位。本项目就这么被坑过一次：一次脚本冒烟测试在开发机上跑到这里，读到了
# data/config/tunnel-token 里的真实 token，把一台什么都没跑的开发机接进了生产隧道。
#
# 原来这里只打一行警告然后照连不误。警告不是门槛。
if curl -fsS "http://localhost:${BOT_PORT}/favicon.svg" >/dev/null 2>&1; then
    echo "✓ 本机 :${BOT_PORT} 机器人在线"
elif [ "${TUNNEL_ALLOW_NO_BOT:-}" = "1" ]; then
    echo "⚠ 本机 :${BOT_PORT} 无响应，但 TUNNEL_ALLOW_NO_BOT=1，继续连接" >&2
else
    {
        echo "✗ 已中止：本机 :${BOT_PORT} 上没有机器人在监听，不能把这台机器接进隧道"
        echo "  连上之后 Cloudflare 会把流量分给它，而它无处可转发，只会返回 502；"
        echo "  如果隧道里还有正常的连接器，表现就是时好时坏，非常难查。"
        echo
        echo "  · 要在这台机器上部署：先 ./scripts/deploy/deploy.sh（Cloudflare 模式）再回来"
        echo "  · 只是想测试本脚本：别用生产 token，用 TUNNEL_TOKEN 指向一条测试隧道"
        echo "  · 确认就是要这么连：TUNNEL_ALLOW_NO_BOT=1 后重跑"
    } >&2
    exit 1
fi

# ---- 4. 起隧道（前台）----
echo "▶ 启动 cloudflared connector（控制台 Published application 应配置为 http://localhost:${BOT_PORT}）"
echo "  （前台运行，Ctrl+C 停止。常驻开机自启可用 systemd/tmux 包一层）"
mkdir -p "$(dirname "$TUNNEL_PID_FILE")"
(umask 077 && printf '%s' "$$" > "$TUNNEL_PID_FILE")
exec cloudflared tunnel --no-autoupdate run --token "$TUNNEL_TOKEN"
