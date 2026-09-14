#!/usr/bin/env bash
# Linux 脚本共用的主机名、实例健康、模型校验、部署互斥和生命周期操作。
#
# lifecycle 函数在调用时读取 PROJECT_DIR 与 TUNNEL_PID_FILE；导入不操作外部状态。
#
# 用法：. "${PROJECT_DIR}/scripts/lib/common.sh"
. "$(dirname "${BASH_SOURCE[0]}")/lifecycle.sh"

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

# 把用户输入规范化成裸 hostname。允许直接填 https://bot.example.com 这种整段 URL——
# 从浏览器地址栏复制粘贴是最自然的动作——但只接受不带端口、路径、查询的根地址，其余
# 一律判为无效，免得把一段面目不清的输入写进部署状态。
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

# Host-port response must identify this project's current instance. Docker provides Bun when the host does not.
bot_local_ready() {
    local port="$1" body
    body="$(curl --noproxy '*' --max-time 3 -fsS "http://127.0.0.1:$port/health")" || return 1
    if command -v bun >/dev/null 2>&1; then
        (cd "$PROJECT_DIR" && printf '%s' "$body" | BOT_PORT="$port" bun run scripts/ops/health-check.ts --stdin)
    else
        printf '%s' "$body" | docker exec -i -e BOT_PORT="$port" mixin-chatbot bun run scripts/ops/health-check.ts --stdin
    fi
}

validate_model_configuration() {
    if command -v bun >/dev/null 2>&1; then
        bun run "$PROJECT_DIR/scripts/config/validate-models.ts" "$PROJECT_DIR"
    else
        docker run --rm --network none --entrypoint bun -v "$PROJECT_DIR:/audit:ro" mixin-chatbot run /audit/scripts/config/validate-models.ts /audit
    fi
}

# A pinned official release keeps Windows and Linux downloads reproducible without a JSON parser.
# Run in a subshell so temporary-file cleanup does not replace a deployment's traps.
ensure_cloudflared() (
    local PROJECT_DIR="$1" executable="$1/cloudflared" version asset checksum actual download output
    if [ -x "$executable" ] && output="$("$executable" --version 2>/dev/null)" && [[ "$output" =~ ^cloudflared[[:space:]]+version ]]; then
        printf '%s\n' "$executable"
        return 0
    fi
    if [ -e "$executable" ] && [ ! -f "$executable" ]; then
        echo "cloudflared 路径不是文件：$executable" >&2
        return 1
    fi
    case "$(uname -m)" in
        x86_64|amd64) asset=cloudflared-linux-amd64 ;;
        aarch64|arm64) asset=cloudflared-linux-arm64 ;;
        armv6*|armv7*) asset=cloudflared-linux-arm ;;
        i?86) asset=cloudflared-linux-386 ;;
        *) echo '当前 Linux 架构没有自动下载项，请将可用的 cloudflared 放在项目根目录。' >&2; return 1 ;;
    esac
    read -r version _ checksum < <(awk -v asset="$asset" '$2 == asset { print; exit }' "$PROJECT_DIR/scripts/tunnel/cloudflared-release.txt") || return 1
    checksum="${checksum%$'\r'}"
    if ! [[ "$version" =~ ^[0-9]{4}\.[0-9]+\.[0-9]+$ && "$checksum" =~ ^[a-fA-F0-9]{64}$ ]]; then
        echo "cloudflared 下载清单无效：$asset" >&2
        return 1
    fi
    download="$(mktemp "$executable.download-XXXXXX")" || return 1
    trap 'rm -f -- "$download"' EXIT
    echo "[*] 正在从 Cloudflare 官方发布下载 cloudflared $version 到项目根目录..." >&2
    curl --proto '=https' --tlsv1.2 --fail --location --show-error --silent --connect-timeout 15 --max-time 180 \
        --output "$download" "https://github.com/cloudflare/cloudflared/releases/download/$version/$asset" || return 1
    actual="$(sha256sum < "$download")" || return 1
    if [ "${actual%% *}" != "${checksum,,}" ]; then
        echo 'cloudflared 下载文件 SHA-256 校验失败' >&2
        return 1
    fi
    chmod 755 "$download" || return 1
    if ! output="$("$download" --version 2>/dev/null)" || ! [[ "$output" =~ ^cloudflared[[:space:]]+version ]]; then
        echo '下载的 cloudflared 无法运行或版本检查失败' >&2
        return 1
    fi
    archive_project_path "$executable" || return 1
    mv -- "$download" "$executable" || return 1
    printf '%s\n' "$executable"
)

show_tunnel_token_help() {
    echo 'token 获取：Cloudflare 控制台 → Networking → Tunnels → 创建 Cloudflared 隧道，或选择已有隧道 → Add a replica（添加副本）。'
    echo '控制台入口：https://dash.cloudflare.com/?to=/:account/tunnels'
    echo '复制安装命令中 eyJ 开头的完整 token，单独保存到 data/config/tunnel-token。'
    echo '部署提示中输入的是 token 文件路径；保存在默认位置后直接回车。连接器安装由本脚本完成。'
}

acquire_deploy_lock() {
    mkdir -p "$PROJECT_DIR/data/state"
    local lock_path
    lock_path="$(realpath "$PROJECT_DIR/data/state")/deploy.lock"
    if [ "${BOT_DEPLOY_LOCK_HELD:-}" = "$lock_path" ] && [ "$(readlink /proc/self/fd/9 2>/dev/null)" = "$lock_path" ]; then
        flock -n 9
        return $?
    fi
    exec 9>"$lock_path"
    flock -n 9 || return 1
    export BOT_DEPLOY_LOCK_HELD="$lock_path"
}
