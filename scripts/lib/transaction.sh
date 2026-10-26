#!/usr/bin/env bash
# 部署/升级事务记录：快照目录中的 transaction 文件，每行一个 key=value。
# 记录停机前确认的全部选择；续做和回滚只使用记录值，不重新读取默认值。凭据永不写入。
# Windows 写入同一格式，运维界面按同一规则读取。format 2 起没有入口模式、域名和平台 IP（应用机器人不需要入站入口）。
TRANSACTION_KEYS=(format operation snapshot target_sha original_sha original_branch original_workspace_root target_workspace_root
    was_running bot_port reconfigure_ai)

transaction_value_valid() {
    local key="$1" value="$2"
    [[ ! "$value" =~ [[:cntrl:]] ]] || return 1
    case "$key" in
        format) [ "$value" = 2 ] ;;
        operation) [[ "$value" =~ ^(deploy|upgrade)$ ]] ;;
        snapshot) [[ "$value" =~ ^deploy-[A-Za-z0-9]+$ ]] ;;
        target_sha|original_sha) [[ "$value" =~ ^([0-9a-f]{40}|[0-9a-f]{64})?$ ]] ;;
        original_branch) [ -z "$value" ] || [ "$value" = HEAD ] || git check-ref-format --branch "$value" >/dev/null 2>&1 ;;
        original_workspace_root|target_workspace_root) [ -z "$value" ] || [[ "$value" == /* ]] ;;
        was_running|reconfigure_ai) [[ "$value" =~ ^[01]$ ]] ;;
        bot_port) [[ "$value" =~ ^[1-9][0-9]{0,4}$ ]] && [ "$value" -le 65535 ] ;;
        *) return 1 ;;
    esac
}

# 写入前逐项校验；先写临时文件再改名，读者不会看到半份记录。调用方先填好 TRANSACTION。
write_transaction_record() {
    local directory="$1" key value temporary="$1/transaction.tmp"
    : > "$temporary" || return 1
    for key in "${TRANSACTION_KEYS[@]}"; do
        value="${TRANSACTION[$key]-}"
        if ! transaction_value_valid "$key" "$value"; then
            rm -f -- "$temporary"
            echo "事务记录值无效：${key}=${value}" >&2
            return 1
        fi
        printf '%s=%s\n' "$key" "$value" >> "$temporary" || return 1
    done
    mv -- "$temporary" "$directory/transaction"
}

read_transaction_record() {
    local file="$1/transaction" line key value
    declare -gA TRANSACTION=()
    [ -f "$file" ] && [ ! -L "$file" ] || { echo "事务记录缺失：$file" >&2; return 1; }
    while IFS= read -r line || [ -n "$line" ]; do
        key="${line%%=*}"
        value="${line#*=}"
        if [ "$key" = "$line" ] || [ -n "${TRANSACTION[$key]+set}" ] || ! transaction_value_valid "$key" "$value"; then
            echo "事务记录无效：${key}" >&2
            return 1
        fi
        TRANSACTION[$key]="$value"
    done < "$file"
    for key in "${TRANSACTION_KEYS[@]}"; do
        [ -n "${TRANSACTION[$key]+set}" ] || { echo "事务记录缺少：${key}" >&2; return 1; }
    done
}

# 已提交部署保存的外置共享资料目录（宿主绝对路径）；为空表示默认的 data/workspace。
saved_workspace_root() {
    local file="$PROJECT_DIR/data/state/workspace-root"
    [ ! -s "$file" ] || tr -d '\r\n' < "$file"
}

# Current release transactions require their complete recorded choices; no historical snapshot reconstruction.
load_pending_transaction() {
    local pointer="$PROJECT_DIR/data/state/deploy-transaction" name snapshot
    name="$(cat "$pointer")" || return 1
    [[ "$name" =~ ^deploy-[a-zA-Z0-9]+$ ]] || { echo '部署事务快照名称无效' >&2; return 1; }
    snapshot="$PROJECT_DIR/backup/snapshots/$name"
    [ -d "$snapshot" ] && [ ! -L "$snapshot" ] || { echo "部署快照缺失：$snapshot" >&2; return 1; }
    TRANSACTION_SNAPSHOT="$snapshot"
    [ -f "$snapshot/transaction" ] || { echo '事务格式不匹配：缺少当前发布记录，请用对应版本完成原操作' >&2; return 1; }
    read_transaction_record "$snapshot" || return 1
    [ "${TRANSACTION[snapshot]}" = "$name" ] || { echo '事务记录与指针不一致' >&2; return 1; }
}

# 供菜单和日志显示的一行摘要。
describe_pending_transaction() {
    local kind='部署' state='停止'
    [ "${TRANSACTION[operation]}" = deploy ] || kind='升级'
    [ "${TRANSACTION[was_running]}" = 0 ] || state='运行'
    printf '未完成的%s：目标提交 %s；共享资料目录 %s（原 %s）；本机端口 %s；原运行状态：%s' "$kind" \
        "${TRANSACTION[target_sha]:0:7}" "${TRANSACTION[target_workspace_root]:-data/workspace}" "${TRANSACTION[original_workspace_root]:-data/workspace}" \
        "${TRANSACTION[bot_port]}" "$state"
    ! transaction_code_restore_pending || printf '；数据、配置和容器已经回滚，只剩代码待恢复到升级前的 %s（只能完成回滚）' "${TRANSACTION[original_sha]:0:7}"
}

# 升级的回滚分两段：部署脚本恢复数据、配置、容器和原运行状态后，代码若还不是升级前的提交，
# 在快照中留下 code-restore 标记并保留事务指针；升级器恢复代码后才清除指针。
# 代码恢复失败时回滚仍可重试，重试只恢复代码；标记存在时不能继续。
transaction_code_restore_pending() {
    local name
    name="$(cat "$PROJECT_DIR/data/state/deploy-transaction" 2>/dev/null)" || return 1
    [[ "$name" =~ ^deploy-[a-zA-Z0-9]+$ ]] && [ -f "$PROJECT_DIR/backup/snapshots/$name/code-restore" ]
}
