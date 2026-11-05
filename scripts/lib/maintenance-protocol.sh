#!/usr/bin/env bash
# 维护命令结构化结果的 Bash 读取端（revision-chain plan §8.5）：scripts/lib/maintenance-protocol.ts 的 --shell 输出，
# 每行一个 key=value，依次为 protocol、version、command、outcome，之后是该命令的字段，最后一行 end=1。Docker 主机
# 不保证有 jq 或主机 Bun，所以不解析 JSON。
#
# 只有退出码 0、结果完整（协议、版本、命令都对，最后一行 end=1）且 outcome=success 才算成功；被杀的进程、残缺或
# 无法识别的输出、未知版本都按失败处理。部署入口用它读停机前的修订整理预览（revision_cleanup_read_preview）。

MAINTENANCE_PROTOCOL=mixin-maintenance
MAINTENANCE_PROTOCOL_VERSION=1

# 从标准输入读入 MAINTENANCE_RESULT。用法：maintenance_result_read <命令> [成功时必须有的字段…]。结果不完整或无法识别时
# 返回 1；返回 0 只表示结果完整，成功与否看 MAINTENANCE_RESULT[outcome]。
maintenance_result_read() {
    local command="$1" line key value index=0 ended=0 field
    shift
    declare -gA MAINTENANCE_RESULT=()
    while IFS= read -r line || [ -n "$line" ]; do
        [ "$ended" = 0 ] || return 1
        key="${line%%=*}"
        value="${line#*=}"
        [ "$key" != "$line" ] && [[ "$key" =~ ^[a-z_]+$ ]] && [[ "$value" =~ ^[A-Za-z0-9_.:/-]*$ ]] || return 1
        [ -z "${MAINTENANCE_RESULT[$key]+set}" ] || return 1
        case "$index:$key" in
            0:protocol) [ "$value" = "$MAINTENANCE_PROTOCOL" ] || return 1 ;;
            1:version) [ "$value" = "$MAINTENANCE_PROTOCOL_VERSION" ] || return 1 ;;
            2:command) [ "$value" = "$command" ] || return 1 ;;
            3:outcome) [[ "$value" =~ ^(success|refused|stopped|not-enough-space|failed)$ ]] || return 1 ;;
            [0-3]:*) return 1 ;;
            *:end) [ "$value" = 1 ] || return 1; ended=1 ;;
        esac
        MAINTENANCE_RESULT[$key]="$value"
        index=$((index + 1))
    done
    [ "$ended" = 1 ] || return 1
    [ "${MAINTENANCE_RESULT[outcome]}" = success ] || return 0
    for field in "$@"; do [ -n "${MAINTENANCE_RESULT[$field]+set}" ] || return 1; done
}
