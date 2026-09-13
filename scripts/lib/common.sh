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
        bun run "$PROJECT_DIR/scripts/config/validate-models.ts" "$PROJECT_DIR/data/config/models.json"
    else
        docker run --rm --network none --entrypoint bun -v "$PROJECT_DIR:/audit:ro" mixin-chatbot run /audit/scripts/config/validate-models.ts /audit/data/config/models.json
    fi
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
