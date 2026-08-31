#!/usr/bin/env bash
# Linux 脚本共用的纯辅助函数。deploy.sh / ops.sh 都 source 它。
#
# 这里只放「不依赖调用方任何变量、也不碰部署状态」的东西。Docker、UFW、隧道这些核心流程
# 各脚本继续各自维护——它们的差异是本质的，硬抽出来只会做出一个到处是 if 的四不像。
#
# 用法：. "${PROJECT_DIR}/scripts/lib/common.sh"

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
