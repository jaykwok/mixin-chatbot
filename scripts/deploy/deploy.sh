#!/bin/bash

# 量子密信群聊协作机器人部署脚本 (Debian + Docker, Bun)
# AI 配置（provider/key/model）由 data/config/models.json 承载，容器内 TUI 生成；
# 无必需 .env/config.json。访问控制由应用 secret + 网络层（直连=UFW / Cloudflare=WAF）共同承担。
# 两种部署模式：直连（公网 IP + UFW 限平台 IP）/ Cloudflare（cloudflared 隧道 + WAF）。

set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_DIR"
DATA_DIR="${PROJECT_DIR}/data"
CONFIG_DIR="${DATA_DIR}/config"
STATE_DIR="${DATA_DIR}/state"
RUNTIME_DIR="${DATA_DIR}/runtime"
RUNTIME_HOME_DIR="${RUNTIME_DIR}/home"
DEFAULT_GROUP_DATA_ROOT="${DATA_DIR}/groups"
LOG_DIR="${PROJECT_DIR}/logs"
MODELS_FILE="${CONFIG_DIR}/models.json"
WEBHOOK_SECRET_FILE="${CONFIG_DIR}/webhook-secret"
DEFAULT_TUNNEL_TOKEN_FILE="${CONFIG_DIR}/tunnel-token"
BOT_PORT_FILE="${STATE_DIR}/bot-port"
DEPLOY_MODE_FILE="${STATE_DIR}/deploy-mode"
BOT_DOMAIN_FILE="${STATE_DIR}/bot-domain"
GROUP_DATA_ROOT_FILE="${STATE_DIR}/group-data-root"
TUNNEL_PID_FILE="${STATE_DIR}/cloudflared.pid"

# 量子密信平台出口 IP（webhook 来源；UFW/WAF 按此放行）。变更可在此改或用环境变量覆盖。
PLATFORM_IP="${PLATFORM_IP:-223.244.14.237}"
BOT_DEBUG_VALUE="${BOT_DEBUG:-0}"
if [ "$BOT_DEBUG_VALUE" != "0" ] && [ "$BOT_DEBUG_VALUE" != "1" ]; then
    echo "BOT_DEBUG 只能是 0 或 1" >&2
    exit 1
fi
BOT_MAX_ACTIVE_REQUESTS_VALUE="${BOT_MAX_ACTIVE_REQUESTS:-32}"
if ! [[ "$BOT_MAX_ACTIVE_REQUESTS_VALUE" =~ ^[0-9]+$ ]] ||
   [ "$BOT_MAX_ACTIVE_REQUESTS_VALUE" -lt 1 ] ||
   [ "$BOT_MAX_ACTIVE_REQUESTS_VALUE" -gt 1000 ]; then
    echo "BOT_MAX_ACTIVE_REQUESTS 必须是 1–1000 的整数" >&2
    exit 1
fi
if [ "$(id -u)" -eq 0 ]; then
    CONTAINER_UID=1001
    CONTAINER_GID=1001
else
    # bind mount 由当前部署用户拥有；用同一非 root 身份运行可同时保证主机与容器可维护。
    CONTAINER_UID="$(id -u)"
    CONTAINER_GID="$(id -g)"
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

print_status() { echo -e "${BLUE}[*] $1${NC}"; }
print_success() { echo -e "${GREEN}[+] $1${NC}"; }
print_warning() { echo -e "${YELLOW}[!] $1${NC}"; }
print_error() { echo -e "${RED}[-] $1${NC}"; }
print_prompt() { echo -e "${CYAN}?> $1${NC}"; }

trim_input() {
    printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

read_input() {
    local prompt="$1" output_name="$2" input_value=""
    print_prompt "$prompt"
    if ! IFS= read -r input_value; then
        echo ""
        print_warning "输入已结束，部署已取消"
        exit 130
    fi
    printf -v "$output_name" '%s' "$input_value"
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
ask_yes_no() {
    local prompt="$1" default_answer="${2:-n}" answer
    while true; do
        read_input "$prompt" answer
        answer="$(trim_input "$answer")"
        answer="${answer,,}"
        if [ -z "$answer" ]; then
            if [ "$default_answer" = "y" ]; then
                return 0
            fi
            return 1
        fi
        case "$answer" in
            y|yes|是) return 0 ;;
            n|no|否) return 1 ;;
            *) print_warning "请输入 y 或 n（也可直接回车采用默认值）" ;;
        esac
    done
}

can_manage_ufw() {
    [ "$(id -u)" -eq 0 ] || command -v sudo >/dev/null 2>&1
}

run_ufw() {
    if [ "$(id -u)" -eq 0 ]; then
        ufw "$@"
    else
        sudo ufw "$@"
    fi
}

remove_managed_ufw_rules() {
    local preserve_port="${1:-}" preserve_ip="${2:-}" kept=0
    local rule_numbers=()
    local line number
    while IFS= read -r line; do
        [[ "$line" == *"Mixin-Chatbot (平台IP)"* ]] || continue
        if [ -n "$preserve_port" ] && [ "$kept" -eq 0 ] &&
            [[ "$line" == *"${preserve_port}/tcp"* && "$line" == *"$preserve_ip"* ]]; then
            kept=1
            continue
        fi
        number="$(sed -n 's/^[[:space:]]*\[[[:space:]]*\([0-9][0-9]*\)\].*/\1/p' <<< "$line")"
        [ -n "$number" ] && rule_numbers+=("$number")
    done < <(run_ufw status numbered)
    local sorted_numbers=()
    mapfile -t sorted_numbers < <(printf '%s\n' "${rule_numbers[@]}" | sed '/^$/d' | sort -rn)
    for number in "${sorted_numbers[@]}"; do
        run_ufw --force delete "$number" >/dev/null
    done
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
    # 归属记录可能来自由 root/systemd 启动的 connector；无权限停止时必须失败关闭，
    # 不能把 kill -0 的 EPERM 误判为“进程已退出”并删除 PID 记录。
    kill "$pid" || return 1
    for attempt in $(seq 1 10); do
        if ! managed_cloudflared_pid >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    return 1
}

# ---- 前置检查 ----

print_status "检查运行环境..."

if ! docker info > /dev/null 2>&1; then
    print_error "无法连接 Docker，请确保 Docker 已安装且当前用户有权限"
    echo "  提示: sudo usermod -aG docker \$USER && newgrp docker"
    exit 1
fi

required_files=("package.json" "src/server/index.ts" "scripts/config/configure.ts")
for file in "${required_files[@]}"; do
    if [ ! -f "$file" ]; then
        print_error "缺少必要文件: $file"
        exit 1
    fi
done

print_success "环境检查通过"

# ---- 目录 + 监听端口 ----

mkdir -p "$CONFIG_DIR" "$STATE_DIR" "$RUNTIME_HOME_DIR" "$DEFAULT_GROUP_DATA_ROOT" "$LOG_DIR"
if [ -n "${BOT_PORT:-}" ]; then
    PORT_DEFAULT_SOURCE="BOT_PORT"
    PORT_DEFAULT="$(trim_input "$BOT_PORT")"
elif [ -f "$BOT_PORT_FILE" ]; then
    PORT_DEFAULT_SOURCE="data/state/bot-port"
    PORT_DEFAULT="$(tr -d '[:space:]' < "$BOT_PORT_FILE")"
else
    PORT_DEFAULT_SOURCE=""
    PORT_DEFAULT="1011"
fi
if ! [[ "$PORT_DEFAULT" =~ ^[0-9]+$ ]] || [ "$PORT_DEFAULT" -lt 1 ] || [ "$PORT_DEFAULT" -gt 65535 ]; then
    print_warning "${PORT_DEFAULT_SOURCE} 中的端口无效，已改用安全默认值 1011：${PORT_DEFAULT}"
    PORT_DEFAULT="1011"
fi
while true; do
    read_input "机器人监听端口 [默认 ${PORT_DEFAULT}]：" port_in
    port_in="$(trim_input "$port_in")"
    BOT_PORT="${port_in:-$PORT_DEFAULT}"
    if [[ "$BOT_PORT" =~ ^[0-9]+$ ]] && [ "$BOT_PORT" -ge 1 ] && [ "$BOT_PORT" -le 65535 ]; then
        break
    fi
    print_warning "端口必须是 1–65535 的整数，请重新输入"
done
print_success "监听端口：$BOT_PORT"

# ---- 部署模式 ----

if [ -n "${DEPLOY_MODE:-}" ]; then
    DEPLOY_MODE_DEFAULT_SOURCE="DEPLOY_MODE"
    DEPLOY_MODE_DEFAULT="$(trim_input "${DEPLOY_MODE,,}")"
elif [ -f "$DEPLOY_MODE_FILE" ]; then
    DEPLOY_MODE_DEFAULT_SOURCE="data/state/deploy-mode"
    DEPLOY_MODE_DEFAULT="$(tr '[:upper:]' '[:lower:]' < "$DEPLOY_MODE_FILE" | tr -d '[:space:]')"
else
    DEPLOY_MODE_DEFAULT_SOURCE=""
    DEPLOY_MODE_DEFAULT="direct"
fi
if [ "$DEPLOY_MODE_DEFAULT" != "direct" ] && [ "$DEPLOY_MODE_DEFAULT" != "cloudflare" ]; then
    print_warning "${DEPLOY_MODE_DEFAULT_SOURCE} 中的部署模式无效，已改用安全默认值 direct：${DEPLOY_MODE_DEFAULT}"
    DEPLOY_MODE_DEFAULT="direct"
fi
if [ "$DEPLOY_MODE_DEFAULT" = "cloudflare" ]; then
    DEPLOY_MODE_DEFAULT_CHOICE="2"
    DEPLOY_MODE_DEFAULT_LABEL="Cloudflare"
else
    DEPLOY_MODE_DEFAULT_CHOICE="1"
    DEPLOY_MODE_DEFAULT_LABEL="直连"
fi

echo ""
print_prompt "选择部署模式："
echo "  1) 直连模式 — 服务器有公网 IP，直接暴露 :${BOT_PORT}（UFW 只放行平台 IP）"
echo "  2) Cloudflare 模式 — 经 cloudflared 隧道 + WAF（无公网 IP / 想要边缘防护）"
while true; do
    read_input "输入 1 或 2 [默认 ${DEPLOY_MODE_DEFAULT_CHOICE} / ${DEPLOY_MODE_DEFAULT_LABEL}]：" mode_choice
    mode_choice="$(trim_input "$mode_choice")"
    mode_choice="${mode_choice:-$DEPLOY_MODE_DEFAULT_CHOICE}"
    case "$mode_choice" in
        1) DEPLOY_MODE="direct"; break ;;
        2) DEPLOY_MODE="cloudflare"; break ;;
        *) print_warning "请输入 1 或 2" ;;
    esac
done
if [ "$DEPLOY_MODE" = "cloudflare" ]; then
    BOT_HOST="127.0.0.1"
    DEPLOY_MODE_LABEL="Cloudflare"
else
    BOT_HOST="0.0.0.0"
    DEPLOY_MODE_LABEL="直连"
fi
print_status "部署模式：$DEPLOY_MODE_LABEL"
if [ "$DEPLOY_MODE" = "cloudflare" ]; then
    print_warning "请把 Cloudflare Tunnel 的 Published application 服务地址设为 http://localhost:${BOT_PORT}"
fi

# ---- Pi 群数据总根（<group>/workspace + <group>/users/<phone>/{tmp,session.jsonl}）----
GROUP_DATA_ROOT_ENV="$(trim_input "${GROUP_DATA_ROOT:-}")"
if [ -n "$GROUP_DATA_ROOT_ENV" ]; then
    GROUP_DATA_ROOT_DEFAULT="$GROUP_DATA_ROOT_ENV"
elif [ -s "$GROUP_DATA_ROOT_FILE" ]; then
    GROUP_DATA_ROOT_DEFAULT="$(trim_input "$(tr -d '\r\n' < "$GROUP_DATA_ROOT_FILE")")"
else
    GROUP_DATA_ROOT_DEFAULT="$DEFAULT_GROUP_DATA_ROOT"
fi
GROUP_DATA_ROOT="$GROUP_DATA_ROOT_DEFAULT"
while true; do
    read_input "Pi 群数据总根 [默认 ${GROUP_DATA_ROOT_DEFAULT}；首次为 ${DEFAULT_GROUP_DATA_ROOT}]：" cwd_in
    cwd_in="$(trim_input "$cwd_in")"
    GROUP_DATA_ROOT="${cwd_in:-$GROUP_DATA_ROOT_DEFAULT}"
    if ! HOST_GROUP_DATA_ROOT="$(realpath -m -- "$GROUP_DATA_ROOT")"; then
        print_warning "群数据总根路径无效：$GROUP_DATA_ROOT"
        continue
    fi
    if [ "$HOST_GROUP_DATA_ROOT" = "/" ] || [ "$HOST_GROUP_DATA_ROOT" = "$PROJECT_DIR" ]; then
        print_warning "群数据总根不能是文件系统根目录或项目根目录：$HOST_GROUP_DATA_ROOT"
        continue
    fi
    case "$HOST_GROUP_DATA_ROOT" in
        "$PROJECT_DIR"/*)
            if [ "$HOST_GROUP_DATA_ROOT" != "$DEFAULT_GROUP_DATA_ROOT" ]; then
                print_warning "项目内群数据目录固定为 data/groups；如需自定义，请选择项目外的路径：$HOST_GROUP_DATA_ROOT"
                continue
            fi
            ;;
    esac
    if [ -e "$HOST_GROUP_DATA_ROOT" ] && [ ! -d "$HOST_GROUP_DATA_ROOT" ]; then
        print_warning "群数据总根不是目录：$HOST_GROUP_DATA_ROOT"
        continue
    fi
    if ! mkdir -p -- "$HOST_GROUP_DATA_ROOT"; then
        print_warning "无法创建群数据总根：$HOST_GROUP_DATA_ROOT"
        continue
    fi
    HOST_GROUP_DATA_ROOT="$(realpath -- "$HOST_GROUP_DATA_ROOT")"
    if ! chmod 755 "$HOST_GROUP_DATA_ROOT"; then
        print_warning "无法设置群数据总根权限：$HOST_GROUP_DATA_ROOT"
        continue
    fi
    write_probe="${HOST_GROUP_DATA_ROOT}/.mixin-chatbot-write-test-$$"
    if ! (umask 077 && : > "$write_probe") 2>/dev/null; then
        print_warning "群数据总根不可写：$HOST_GROUP_DATA_ROOT"
        continue
    fi
    if ! rm -f -- "$write_probe"; then
        print_warning "无法清理群数据总根写入测试文件：$write_probe"
        continue
    fi
    break
done
GROUP_ROOT_ARGS=()
if [ "$HOST_GROUP_DATA_ROOT" = "$DEFAULT_GROUP_DATA_ROOT" ]; then
    GROUP_ROOT_ENV_VAL="/app/data/groups"
else
    if [ "$(id -u)" -eq 0 ]; then
        chown "$CONTAINER_UID:$CONTAINER_GID" "$HOST_GROUP_DATA_ROOT"
    fi
    GROUP_ROOT_ARGS+=(-v "$HOST_GROUP_DATA_ROOT:/app/group-data")
    GROUP_ROOT_ENV_VAL="/app/group-data"
    print_warning "主机群数据目录挂到容器 /app/group-data"
fi
print_status "Pi 群数据总根：$HOST_GROUP_DATA_ROOT（容器内：$GROUP_ROOT_ENV_VAL）"
echo ""

# ---- 目录 ----

print_status "设置目录权限..."
# root 部署固定降权到 appuser(1001)；普通 Docker 用户则由容器沿用当前 UID/GID。
if [ "$(id -u)" -eq 0 ]; then
    chown -R "$CONTAINER_UID:$CONTAINER_GID" "$DATA_DIR" "$LOG_DIR" "$HOST_GROUP_DATA_ROOT"
fi
chmod 755 "$DATA_DIR" "$CONFIG_DIR" "$STATE_DIR" "$RUNTIME_DIR" "$RUNTIME_HOME_DIR" "$DEFAULT_GROUP_DATA_ROOT" "$LOG_DIR"
print_success "目录就绪"

# ---- 构建镜像 ----

print_status "构建 Docker 镜像..."
if docker build -t mixin-chatbot .; then
    print_success "镜像构建成功"
else
    print_error "镜像构建失败"
    exit 1
fi

verify_container_storage() {
    docker run --rm \
      --user "$CONTAINER_UID:$CONTAINER_GID" \
      -e HOME=/app/data/runtime/home \
      -e GROUP_DATA_ROOT="$GROUP_ROOT_ENV_VAL" \
      "${GROUP_ROOT_ARGS[@]}" \
      -v "$(pwd)/logs:/app/logs" \
      -v "$(pwd)/data:/app/data" \
      --entrypoint sh \
      mixin-chatbot \
      -c 'for directory in /app/data/config /app/data/state /app/data/runtime /app/data/runtime/home /app/logs "$GROUP_DATA_ROOT"; do
              [ -d "$directory" ] && [ -w "$directory" ] || { echo "容器用户不可写: $directory" >&2; exit 1; }
          done
          for file in /app/data/config/models.json /app/data/config/webhook-secret; do
              [ ! -e "$file" ] || { [ -r "$file" ] && [ -w "$file" ]; } || { echo "容器用户不可读写: $file" >&2; exit 1; }
          done'
}

print_status "验证容器用户对持久化目录的权限..."
if ! verify_container_storage; then
    print_error "容器运行用户（UID ${CONTAINER_UID}）无法读写持久化目录"
    echo "  请修复 data/、logs/ 与群数据根的属主/权限后重试；也可用 sudo 运行部署，让容器固定降权到 UID 1001。"
    exit 1
fi
print_success "持久化目录权限正常"

# ---- AI 配置（容器内 TUI 写 data/config/models.json）----
# 首次必须配置；已存在则询问是否重配。

if [ ! -f "$MODELS_FILE" ]; then
    print_status "首次配置 AI（provider/key/model）..."
    if ! docker run --rm -it --user "$CONTAINER_UID:$CONTAINER_GID" -e HOME=/app/data/runtime/home -v "$(pwd)/data:/app/data" mixin-chatbot bun run configure; then
        print_error "AI 配置命令执行失败"
        exit 1
    fi
    if [ ! -f "$MODELS_FILE" ]; then
        print_error "未生成 data/config/models.json，已中止"
        exit 1
    fi
else
    print_status "检测到已有 data/config/models.json"
    if ask_yes_no "是否重新配置 AI（provider/key/model）？[y/N]：" "n"; then
        if ! docker run --rm -it --user "$CONTAINER_UID:$CONTAINER_GID" -e HOME=/app/data/runtime/home -v "$(pwd)/data:/app/data" mixin-chatbot bun run configure; then
            print_error "AI 配置命令执行失败"
            exit 1
        fi
    fi
fi
if [ "$(id -u)" -eq 0 ]; then
    chown "$CONTAINER_UID:$CONTAINER_GID" "$MODELS_FILE"
fi
chmod 600 "$MODELS_FILE"

# ---- Webhook 随机密钥路径（两模式共用，应用层鉴权）----
# data/config/webhook-secret 存 64hex（256bit）；应用启动读它，存在则启用 /webhook/<secret>。
if [ ! -f "$WEBHOOK_SECRET_FILE" ]; then
    print_status "生成 webhook 随机密钥路径..."
    if SECRET=$(openssl rand -hex 32 2>/dev/null) && [ -n "$SECRET" ]; then
        : # openssl 可用
    else
        SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n') # 回退
    fi
    printf '%s' "$SECRET" > "$WEBHOOK_SECRET_FILE"
    if [ "$(id -u)" -eq 0 ]; then
        chown "$CONTAINER_UID:$CONTAINER_GID" "$WEBHOOK_SECRET_FILE"
    fi
    chmod 600 "$WEBHOOK_SECRET_FILE"
    print_success "已生成 webhook 密钥"
    SHOW_SECRET=1
else
    SECRET="$(tr -d '[:space:]' < "$WEBHOOK_SECRET_FILE")"
    if ! [[ "$SECRET" =~ ^[0-9a-fA-F]{64}$ ]]; then
        print_error "data/config/webhook-secret 格式无效（应为 64 位十六进制）；请删除该文件后重新部署以生成新密钥"
        exit 1
    fi
    SHOW_SECRET=0
    print_status "检测到已有 data/config/webhook-secret（沿用）"
fi
if ! verify_container_storage; then
    print_error "models.json 或 webhook-secret 对容器用户（UID ${CONTAINER_UID}）不可读写；请修复目录/文件权限后重试"
    exit 1
fi

# 域名接受 hostname 或仅含 hostname 的 http(s) 根 URL，并统一规范化为 hostname。
# 显式环境变量会在部署成功后持久化，方便 ops 脚本在后续 shell 中继续做公网健康检查。
PERSIST_BOT_DOMAIN=0
CLEAR_PERSISTED_BOT_DOMAIN=0
INVALID_CONFIGURED_DOMAIN=""
DOMAIN_SOURCE=""
if [ -n "${BOT_DOMAIN:-}" ]; then
    RAW_PUBLIC_DOMAIN="$BOT_DOMAIN"
    DOMAIN_SOURCE="BOT_DOMAIN"
elif [ -f "$BOT_DOMAIN_FILE" ]; then
    RAW_PUBLIC_DOMAIN="$(sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$BOT_DOMAIN_FILE")"
    DOMAIN_SOURCE="data/state/bot-domain"
else
    RAW_PUBLIC_DOMAIN=""
fi
PUBLIC_DOMAIN=""
if [ -n "$RAW_PUBLIC_DOMAIN" ]; then
    if PUBLIC_DOMAIN="$(normalize_hostname_input "$RAW_PUBLIC_DOMAIN")"; then
        if [ "$DOMAIN_SOURCE" = "BOT_DOMAIN" ] || [ "$PUBLIC_DOMAIN" != "$RAW_PUBLIC_DOMAIN" ]; then
            PERSIST_BOT_DOMAIN=1
        fi
    else
        INVALID_CONFIGURED_DOMAIN="$RAW_PUBLIC_DOMAIN"
        PUBLIC_DOMAIN=""
        if [ "$DOMAIN_SOURCE" = "data/state/bot-domain" ]; then
            CLEAR_PERSISTED_BOT_DOMAIN=1
        fi
    fi
fi
if [ -n "$INVALID_CONFIGURED_DOMAIN" ]; then
    print_warning "$DOMAIN_SOURCE 中的域名无效，已忽略：$INVALID_CONFIGURED_DOMAIN"
fi
if [ "$DEPLOY_MODE" = "cloudflare" ]; then
    DOMAIN_DEFAULT="$PUBLIC_DOMAIN"
    while true; do
        if [ -n "$DOMAIN_DEFAULT" ]; then
            read_input "Cloudflare 公网域名 [默认 ${DOMAIN_DEFAULT}；支持完整根 URL]：" domain_in
        else
            read_input "Cloudflare 公网域名（可留空；支持 im-bot.example.com 或 https://im-bot.example.com）：" domain_in
        fi
        if [ -z "$domain_in" ]; then
            PUBLIC_DOMAIN="$DOMAIN_DEFAULT"
            break
        fi
        if PUBLIC_DOMAIN="$(normalize_hostname_input "$domain_in")"; then
            PERSIST_BOT_DOMAIN=1
            if [ "$PUBLIC_DOMAIN" != "$domain_in" ]; then
                print_success "已规范化公网域名：$PUBLIC_DOMAIN"
            fi
            break
        fi
        print_warning "域名格式无效；请输入纯 hostname，或只含 hostname 的 http(s) URL（不能带端口、路径、查询参数）"
    done
fi

SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
SERVER_IP="${SERVER_IP:-<服务器IP>}"

echo ""
print_prompt "把回调地址填到 IM 平台（webhook URL）："
if [ "$DEPLOY_MODE" = "direct" ]; then
    if [ "$SHOW_SECRET" = "1" ]; then
        echo "    http://${SERVER_IP}:${BOT_PORT}/webhook/$SECRET"
    else
        echo "    http://${SERVER_IP}:${BOT_PORT}/webhook/<secret>（密钥未变；忘记可 cat data/config/webhook-secret）"
    fi
    echo ""
    print_warning "直连走 HTTP：secret 在 URL 里明文经「平台→服务器」传输，网络层必须只允许配置的回调来源访问"
    if [ "${ALLOW_UNMANAGED_FIREWALL:-0}" = "1" ]; then
        print_warning "已显式跳过 UFW 安全基线；请确认云防火墙/其他系统防火墙已限制 TCP ${BOT_PORT}"
    else
        print_warning "确认 UFW：sudo ufw status（应仅允许配置的回调来源访问 TCP ${BOT_PORT}）"
    fi
    print_warning "有域名想加密可自行套 nginx/caddy + 证书反代到 :${BOT_PORT}（URL 改 https://<域名>/webhook/<secret>）"
else
    PUBLIC_DOMAIN_DISPLAY="${PUBLIC_DOMAIN:-<你的域名>}"
    if [ "$SHOW_SECRET" = "1" ]; then
        echo "    https://${PUBLIC_DOMAIN_DISPLAY}/webhook/$SECRET"
    else
        echo "    https://${PUBLIC_DOMAIN_DISPLAY}/webhook/<secret>（密钥未变；忘记可 cat data/config/webhook-secret）"
    fi
    echo ""
    print_warning "Cloudflare 模式仅监听 127.0.0.1:${BOT_PORT}，不会直接暴露公网端口"
    print_warning "部署末尾会启动 cloudflared connector；远程管理隧道的源站端口需在 Cloudflare 控制台配置为 http://localhost:${BOT_PORT}"
    print_warning "WAF 应只限制 /webhook/ 前缀：平台 IP + POST 放行，其他 webhook 请求 Block；可保留 /favicon.svg 供健康检查"
fi
if [ "$SHOW_SECRET" = "1" ]; then
    print_warning "密钥仅本次显示、不进容器日志；泄露时删 data/config/webhook-secret 重新部署即重新生成"
fi
echo ""

# ---- 停止旧容器 ----
# 镜像、配置和密钥全部准备成功后才产生服务停机窗口。
if [ "$DEPLOY_MODE" = "direct" ]; then
    if command -v ufw >/dev/null 2>&1 && can_manage_ufw; then
        print_status "同步 UFW 规则到端口 ${BOT_PORT}..."
        # 先写入新入口；旧规则到新部署提交时才删除，失败回滚仍保留原入口。
        UFW_RULE_WRITTEN=0
        if run_ufw allow from "$PLATFORM_IP" to any port "$BOT_PORT" proto tcp comment 'Mixin-Chatbot (平台IP)'; then
            UFW_RULE_WRITTEN=1
        else
            if [ "${ALLOW_UNMANAGED_FIREWALL:-0}" != "1" ]; then
                print_error "无法写入 UFW 规则；直连模式拒绝在 0.0.0.0 上启动"
                echo "  修复 UFW/sudo，或确认已有等效云防火墙后显式设置 ALLOW_UNMANAGED_FIREWALL=1。"
                exit 1
            fi
            print_warning "ALLOW_UNMANAGED_FIREWALL=1：UFW 规则写入失败，依赖你已配置的外部防火墙"
        fi
        if [ "$UFW_RULE_WRITTEN" = "1" ]; then
            # 旧入口保留到新容器健康且模式切换完成，便于失败时恢复旧容器。
            CLEANUP_UFW_AFTER_HEALTH=1
        fi
        if [ "$UFW_RULE_WRITTEN" = "1" ] && run_ufw status | grep -q "Status: active"; then
            print_success "UFW 已确认允许配置的回调来源访问 TCP ${BOT_PORT}"
        elif [ "${ALLOW_UNMANAGED_FIREWALL:-0}" = "1" ]; then
            print_warning "ALLOW_UNMANAGED_FIREWALL=1：UFW 未启用，依赖你已配置的外部防火墙"
        else
            print_error "UFW 未启用；直连模式拒绝在 0.0.0.0 上启动"
            echo "  运行 scripts/deploy/setup-server.sh / sudo ufw enable，或确认已有等效云防火墙后设置 ALLOW_UNMANAGED_FIREWALL=1。"
            exit 1
        fi
    elif [ "${ALLOW_UNMANAGED_FIREWALL:-0}" = "1" ]; then
        print_warning "ALLOW_UNMANAGED_FIREWALL=1：UFW 不可管理，依赖你已配置的外部防火墙"
    else
        print_error "UFW 不可用或当前用户没有 root/sudo 权限；直连模式拒绝在 0.0.0.0 上启动"
        echo "  修复 UFW/sudo，或确认已有等效云防火墙后显式设置 ALLOW_UNMANAGED_FIREWALL=1。"
        exit 1
    fi
else
    if command -v ufw >/dev/null 2>&1 && can_manage_ufw; then
        CLEANUP_UFW_AFTER_HEALTH=1
        print_status "Cloudflare 模式将在新部署成功后清理本项目旧直连规则"
    else
        print_warning "UFW 不可用或当前用户没有 root/sudo 权限；无法自动清理以前的直连规则"
    fi
fi

# 在产生机器人停机窗口前确认未托管 connector 的归属；用户拒绝时旧服务保持不变。
UNMANAGED_TUNNEL_CONFIRMED=0
if ! managed_cloudflared_pid >/dev/null 2>&1 && pgrep -x cloudflared >/dev/null 2>&1; then
    unmanaged_pid="$(pgrep -x cloudflared | head -n1)"
    if [ "$DEPLOY_MODE" = "cloudflare" ]; then
        print_warning "检测到未由本项目记录的 cloudflared（pid ${unmanaged_pid}），无法自动确认它连接的是当前隧道"
        unmanaged_prompt="确认该 connector 正在服务本项目，继续沿用？[y/N]："
    else
        print_warning "系统有未由本项目记录的 cloudflared（pid ${unmanaged_pid}）；不会自动停止，以免影响其他隧道"
        unmanaged_prompt="确认该 connector 与本项目无关或其入口仍受保护，继续直连部署？[y/N]："
    fi
    if ! ask_yes_no "$unmanaged_prompt" "n"; then
        print_error "未确认未托管 cloudflared 的安全边界；尚未停止现有机器人"
        exit 1
    fi
    UNMANAGED_TUNNEL_CONFIRMED=1
fi

ROLLBACK_CONTAINER="mixin-chatbot-rollback"
PREVIOUS_CONTAINER_SAVED=0
NEW_CONTAINER_ATTEMPTED=0
TUNNEL_STARTED_BY_DEPLOY=0
DEPLOYMENT_COMMITTED=0

rollback_deployment() {
    local exit_status=$?
    trap - EXIT
    if [ "$DEPLOYMENT_COMMITTED" = "1" ]; then
        exit "$exit_status"
    fi
    set +e
    if [ "$TUNNEL_STARTED_BY_DEPLOY" = "1" ]; then
        stop_managed_cloudflared >/dev/null 2>&1
    fi
    if [ "$NEW_CONTAINER_ATTEMPTED" = "1" ] &&
       docker ps -a --format '{{.Names}}' | grep -q '^mixin-chatbot$'; then
        docker rm -f mixin-chatbot >/dev/null 2>&1
    fi
    if [ "$PREVIOUS_CONTAINER_SAVED" = "1" ] &&
       docker ps -a --format '{{.Names}}' | grep -q "^${ROLLBACK_CONTAINER}$"; then
        if docker rename "$ROLLBACK_CONTAINER" mixin-chatbot >/dev/null 2>&1 &&
           docker start mixin-chatbot >/dev/null 2>&1; then
            print_warning "新部署未完成，已恢复并启动旧容器"
        else
            print_error "新部署未完成，旧容器自动恢复失败；请检查 docker ps -a"
        fi
    fi
    exit "$exit_status"
}

if docker ps -a --format '{{.Names}}' | grep -q "^${ROLLBACK_CONTAINER}$"; then
    print_error "发现上次遗留的 ${ROLLBACK_CONTAINER}；请先确认容器状态，避免覆盖可恢复版本"
    exit 1
fi
trap rollback_deployment EXIT

print_status "停止现有容器..."
if docker ps -a --format '{{.Names}}' | grep -q '^mixin-chatbot$'; then
    if ! docker stop mixin-chatbot >/dev/null 2>&1; then
        print_error "旧容器停止失败；未继续覆盖部署"
        docker start mixin-chatbot >/dev/null 2>&1 || true
        exit 1
    fi
    if ! docker rename mixin-chatbot "$ROLLBACK_CONTAINER" >/dev/null 2>&1; then
        print_error "旧容器保存为回滚版本失败；未继续覆盖部署"
        docker start mixin-chatbot >/dev/null 2>&1 || true
        exit 1
    fi
    PREVIOUS_CONTAINER_SAVED=1
    print_success "旧容器已保存为临时回滚版本"
else
    print_success "没有发现旧容器"
fi

# ---- 启动容器 ----

print_status "启动容器..."
NEW_CONTAINER_ATTEMPTED=1
if docker run -d \
  --init \
  --user "$CONTAINER_UID:$CONTAINER_GID" \
  --network host \
  -e HOME=/app/data/runtime/home \
  -e GROUP_DATA_ROOT="$GROUP_ROOT_ENV_VAL" \
  -e BOT_PORT="$BOT_PORT" \
  -e BOT_HOST="$BOT_HOST" \
  -e BOT_DEBUG="$BOT_DEBUG_VALUE" \
  -e BOT_MAX_ACTIVE_REQUESTS="$BOT_MAX_ACTIVE_REQUESTS_VALUE" \
  "${GROUP_ROOT_ARGS[@]}" \
  -v "$(pwd)/logs:/app/logs" \
  -v "$(pwd)/data:/app/data" \
  --restart unless-stopped \
  --stop-timeout 30 \
  --name mixin-chatbot \
  --memory="512m" \
  --memory-swap="768m" \
  --cpus="1.0" \
  --pids-limit=256 \
  --read-only \
  --tmpfs /tmp:size=64m \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --log-driver json-file \
  --log-opt max-size=5m \
  --log-opt max-file=2 \
  mixin-chatbot; then
    print_success "容器启动成功"
else
    print_error "容器启动失败"
    docker logs mixin-chatbot 2>/dev/null
    exit 1
fi

# ---- 等待健康检查 ----

print_status "等待服务就绪..."
for i in $(seq 1 18); do
    status=$(docker inspect --format='{{.State.Health.Status}}' mixin-chatbot 2>/dev/null || echo "unknown")
    if [ "$status" = "healthy" ]; then
        print_success "健康检查通过"
        break
    fi
    if [ "$status" = "unhealthy" ]; then
        print_error "健康检查失败，请检查日志: docker logs mixin-chatbot"
        docker logs --tail 50 mixin-chatbot 2>&1 || true
        exit 1
    fi
    if [ $i -eq 18 ]; then
        print_error "健康检查超时（90s），请检查日志: docker logs mixin-chatbot"
        docker logs --tail 50 mixin-chatbot 2>&1 || true
        exit 1
    fi
    sleep 5
done

# ---- Cloudflare 模式：确保 cloudflared 在线 ----
if [ "$DEPLOY_MODE" = "cloudflare" ]; then
    print_status "Cloudflare 模式：确保 cloudflared 隧道在线..."
    if managed_pid="$(managed_cloudflared_pid)"; then
        print_success "本项目 cloudflared 已在运行（pid ${managed_pid}）"
    elif pgrep -x cloudflared >/dev/null 2>&1; then
        unmanaged_pid="$(pgrep -x cloudflared | head -n1)"
        if [ "$UNMANAGED_TUNNEL_CONFIRMED" != "1" ]; then
            print_warning "检测到部署期间出现的未托管 cloudflared（pid ${unmanaged_pid}），无法自动确认归属"
        fi
        if [ "$UNMANAGED_TUNNEL_CONFIRMED" != "1" ] &&
           ! ask_yes_no "确认该 connector 正在服务本项目，继续沿用？[y/N]：" "n"; then
            print_error "未确认未托管的 cloudflared 归属；Cloudflare 模式部署已停止"
            exit 1
        fi
    elif [ -f scripts/tunnel/start-tunnel.sh ]; then
        mkdir -p "$LOG_DIR"
        tunnel_token_args=()
        need_tunnel_token_prompt=0
        if [ -n "${TUNNEL_TOKEN:-}" ]; then
            : # 裸 token 由子脚本读取。
        elif [ -n "${TUNNEL_TOKEN_FILE:-}" ]; then
            if [ ! -f "$TUNNEL_TOKEN_FILE" ]; then
                print_warning "TUNNEL_TOKEN_FILE 指向的文件不存在：$TUNNEL_TOKEN_FILE"
                need_tunnel_token_prompt=1
            fi
        elif [ ! -f "$DEFAULT_TUNNEL_TOKEN_FILE" ]; then
            need_tunnel_token_prompt=1
        fi
        while ! managed_cloudflared_pid >/dev/null 2>&1; do
            if [ "$need_tunnel_token_prompt" = "1" ]; then
                read_input "隧道 token 文件 [直接回车按 TUNNEL_TOKEN_FILE / TUNNEL_TOKEN / data/config/tunnel-token 的顺序查找]：" tunnel_token_file_in
                tunnel_token_file_in="$(trim_input "$tunnel_token_file_in")"
                tunnel_token_args=()
                if [ -n "$tunnel_token_file_in" ]; then
                    if [ ! -f "$tunnel_token_file_in" ]; then
                        print_warning "找不到 token 文件：$tunnel_token_file_in"
                        continue
                    fi
                    tunnel_token_args=("$tunnel_token_file_in")
                elif [ -n "${TUNNEL_TOKEN_FILE:-}" ] && [ ! -f "$TUNNEL_TOKEN_FILE" ] && [ -f "$DEFAULT_TUNNEL_TOKEN_FILE" ]; then
                    tunnel_token_args=("$DEFAULT_TUNNEL_TOKEN_FILE")
                elif [ -z "${TUNNEL_TOKEN:-}" ] &&
                     { [ -z "${TUNNEL_TOKEN_FILE:-}" ] || [ ! -f "$TUNNEL_TOKEN_FILE" ]; } &&
                     [ ! -f "$DEFAULT_TUNNEL_TOKEN_FILE" ]; then
                    print_warning "没有可用的 token 来源，请输入 token 文件路径"
                    continue
                fi
            fi

            print_warning "cloudflared 未运行，后台启动 scripts/tunnel/start-tunnel.sh..."
            BOT_PORT="$BOT_PORT" nohup bash ./scripts/tunnel/start-tunnel.sh "${tunnel_token_args[@]}" >>"$LOG_DIR/cloudflared.log" 2>&1 &
            tunnel_launcher_pid=$!
            for attempt in $(seq 1 30); do
                managed_cloudflared_pid >/dev/null 2>&1 && break
                kill -0 "$tunnel_launcher_pid" 2>/dev/null || break
                sleep 1
            done
            if managed_pid="$(managed_cloudflared_pid)"; then
                TUNNEL_STARTED_BY_DEPLOY=1
                print_success "cloudflared 已后台启动（pid ${managed_pid}，日志 logs/cloudflared.log）"
                print_warning "持久化建议：配 systemd 服务（开机自启 + 崩溃重启）；当前 nohup 仅本次运行"
                break
            fi
            print_warning "cloudflared 未能启动，最近日志："
            tail -n 10 "$LOG_DIR/cloudflared.log" 2>/dev/null || true
            print_warning "请修正 token 来源后重试；按 Ctrl+C 可取消部署。"
            need_tunnel_token_prompt=1
        done
    else
        print_error "未找到 scripts/tunnel/start-tunnel.sh，无法启动 Cloudflare 隧道"
        exit 1
    fi
else
    if managed_pid="$(managed_cloudflared_pid)"; then
        print_status "直连模式：停止本项目记录的 cloudflared（pid ${managed_pid}）..."
        if stop_managed_cloudflared; then
            print_success "本项目 cloudflared 已停止，旧隧道入口不再由本机 connector 提供"
        else
            print_error "无法停止本项目 cloudflared（pid ${managed_pid}）；为避免保留旧隧道入口，部署未完成"
            exit 1
        fi
    elif pgrep -x cloudflared >/dev/null 2>&1; then
        unmanaged_pid="$(pgrep -x cloudflared | head -n1)"
        if [ "$UNMANAGED_TUNNEL_CONFIRMED" != "1" ]; then
            print_warning "部署期间出现未由本项目记录的 cloudflared（pid ${unmanaged_pid}）；不会自动停止"
        fi
        if [ "$UNMANAGED_TUNNEL_CONFIRMED" != "1" ] &&
           ! ask_yes_no "确认该 connector 与本项目无关或其入口仍受保护，继续直连部署？[y/N]：" "n"; then
            print_error "未确认遗留隧道的安全边界；直连模式部署已停止"
            exit 1
        fi
    fi
fi

if [ "${CLEANUP_UFW_AFTER_HEALTH:-0}" = "1" ]; then
    if [ "$DEPLOY_MODE" = "direct" ]; then
        print_status "新入口已就绪，清理本项目旧 UFW 规则..."
        remove_managed_ufw_rules "$BOT_PORT" "$PLATFORM_IP"
        print_success "UFW 仅保留当前机器人入口"
    else
        print_status "新隧道部署已就绪，清理本项目旧 UFW 规则..."
        remove_managed_ufw_rules
        print_success "Cloudflare 模式已移除本项目的直连 UFW 规则"
    fi
fi

# 只有机器人健康且部署模式切换完成后才提交状态，避免运维脚本读取到半完成配置。
printf '%s' "$BOT_PORT" > "$BOT_PORT_FILE"
printf '%s' "$DEPLOY_MODE" > "$DEPLOY_MODE_FILE"
printf '%s' "$HOST_GROUP_DATA_ROOT" > "$GROUP_DATA_ROOT_FILE"
if [ "$PERSIST_BOT_DOMAIN" = "1" ]; then
    printf '%s' "$PUBLIC_DOMAIN" > "$BOT_DOMAIN_FILE"
elif [ "$CLEAR_PERSISTED_BOT_DOMAIN" = "1" ]; then
    rm -f -- "$BOT_DOMAIN_FILE"
fi

DEPLOYMENT_COMMITTED=1
trap - EXIT
if [ "$PREVIOUS_CONTAINER_SAVED" = "1" ]; then
    if docker rm "$ROLLBACK_CONTAINER" >/dev/null 2>&1; then
        print_success "部署已提交，旧容器回滚版本已清理"
    else
        print_warning "部署已成功，但旧回滚容器 ${ROLLBACK_CONTAINER} 清理失败；可确认后手动 docker rm"
    fi
fi

# ---- 输出信息 ----

if docker ps --format '{{.Names}}' | grep -q '^mixin-chatbot$'; then
    print_success "服务启动成功"

    echo ""
    echo "=========================================="
    echo "  量子密信群聊协作机器人部署完成"
    echo "=========================================="
    echo ""
    if [ "$DEPLOY_MODE" = "direct" ]; then
        echo "  模式:      直连（来源 IP 闸门）"
        echo "  回调地址:   http://${SERVER_IP}:${BOT_PORT}/webhook/<secret>"
    else
        echo "  模式:      Cloudflare（隧道 + WAF）"
        echo "  回调地址:   https://${PUBLIC_DOMAIN_DISPLAY}/webhook/<secret>"
    fi
    echo "  AI 配置:   $(pwd)/data/config/models.json"
    echo "  日志:      $(pwd)/logs/"
    echo "  数据:      $(pwd)/data/"
    echo "  群数据根:  $HOST_GROUP_DATA_ROOT"
    echo "  监听:      $BOT_HOST:$BOT_PORT"
    echo ""
    echo "  内存限制: 512MB | CPU: 1核"
    echo ""
    echo "  常用命令（推荐走 ops.sh：带健康检查、隧道判断和失败回滚）:"
    echo "    ./scripts/ops/ops.sh doctor                          # 体检"
    echo "    ./scripts/ops/ops.sh logs                            # 实时日志"
    echo "    ./scripts/ops/ops.sh restart                         # 重启"
    echo "    ./scripts/ops/ops.sh update                          # 升级到 origin/main（提示回车即沿用现有配置）"
    echo ""
    echo "  底层命令（ops.sh 不适用时排障用）:"
    echo "    docker logs -f mixin-chatbot                         # 容器层日志"
    echo "    docker restart mixin-chatbot                         # 直接重启容器"
    echo "    docker run --rm -it --user \"\$(stat -c '%u:%g' data)\" -e HOME=/app/data/runtime/home -v \"\$(pwd)/data:/app/data\" mixin-chatbot bun run configure && docker restart mixin-chatbot   # 重配 AI"
    echo ""

    print_status "最近日志:"
    docker logs --tail 10 mixin-chatbot 2>&1
else
    print_error "服务启动失败"
    docker logs mixin-chatbot 2>&1
    exit 1
fi
