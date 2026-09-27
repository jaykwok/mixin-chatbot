#!/usr/bin/env bash
# 部署/升级事务记录：快照目录中的 transaction 文件，每行一个 key=value。
# 记录停机前确认的全部选择；续做和回滚只使用记录值，不重新读取默认值。隧道 token 永不写入。
# Windows 写入同一格式，运维界面按同一规则读取。
TRANSACTION_KEYS=(format operation snapshot target_sha original_sha original_branch original_group_root target_group_root
    was_running bot_port deploy_mode bot_domain domain_action unmanaged_tunnel platform_ip reconfigure_ai)

transaction_value_valid() {
    local key="$1" value="$2"
    [[ ! "$value" =~ [[:cntrl:]] ]] || return 1
    case "$key" in
        format) [ "$value" = 1 ] ;;
        operation) [[ "$value" =~ ^(deploy|upgrade)$ ]] ;;
        snapshot) [[ "$value" =~ ^deploy-[A-Za-z0-9]+$ ]] ;;
        target_sha|original_sha) [[ "$value" =~ ^([0-9a-f]{40}|[0-9a-f]{64})?$ ]] ;;
        original_branch) [ -z "$value" ] || [ "$value" = HEAD ] || git check-ref-format --branch "$value" >/dev/null 2>&1 ;;
        original_group_root|target_group_root) [[ "$value" == /* ]] ;;
        was_running|reconfigure_ai) [[ "$value" =~ ^[01]$ ]] ;;
        bot_port) [[ "$value" =~ ^[1-9][0-9]{0,4}$ ]] && [ "$value" -le 65535 ] ;;
        deploy_mode) [[ "$value" =~ ^(direct|cloudflare)$ ]] ;;
        bot_domain) [ -z "$value" ] || [ "$(normalize_hostname_input "$value" 2>/dev/null)" = "$value" ] ;;
        domain_action) [[ "$value" =~ ^(keep|persist|clear)$ ]] ;;
        unmanaged_tunnel) [[ "$value" =~ ^(direct|cloudflare)?$ ]] ;;
        # 直连防火墙放行的来源：IPv4 或 IPv6，可带前缀长度。
        platform_ip) [ "${#value}" -le 64 ] && [[ "$value" =~ ^(([0-9]{1,3}\.){3}[0-9]{1,3}|[0-9A-Fa-f]*:[0-9A-Fa-f:.]*)(/[0-9]{1,3})?$ ]] ;;
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

# 已提交部署保存的群根；相对路径按项目目录解析，未保存时为默认 data/groups。
saved_group_data_root() {
    local root="$PROJECT_DIR/data/groups" file="$PROJECT_DIR/data/state/group-data-root"
    if [ -s "$file" ]; then
        root="$(tr -d '\r\n' < "$file")"
        case "$root" in /*) ;; *) root="$PROJECT_DIR/$root" ;; esac
    fi
    realpath -m -- "$root"
}

# 读取未完成事务的指针和记录，结果在 TRANSACTION 中；调用方须持有部署锁。
# 旧版快照没有记录：按快照中的目标群根、目标提交和原运行状态合成，端口、模式、域名取已保存设置，
# 平台 IP 取当前 PLATFORM_IP 或默认值（与旧版续做相同）。
load_pending_transaction() {
    local pointer="$PROJECT_DIR/data/state/deploy-transaction" name snapshot key value
    name="$(cat "$pointer")" || return 1
    [[ "$name" =~ ^deploy-[a-zA-Z0-9]+$ ]] || { echo '部署事务快照名称无效' >&2; return 1; }
    snapshot="$PROJECT_DIR/backup/snapshots/$name"
    [ -d "$snapshot" ] && [ ! -L "$snapshot" ] || { echo "部署快照缺失：$snapshot" >&2; return 1; }
    TRANSACTION_SNAPSHOT="$snapshot"
    if [ -e "$snapshot/transaction" ]; then
        read_transaction_record "$snapshot" || return 1
        [ "${TRANSACTION[snapshot]}" = "$name" ] || { echo '事务记录与指针不一致' >&2; return 1; }
        TRANSACTION_LEGACY=0
        return 0
    fi
    local state="$PROJECT_DIR/data/state" saved=()
    declare -gA TRANSACTION=([format]=1 [operation]=deploy [snapshot]="$name" [original_sha]='' [original_branch]=''
        [reconfigure_ai]=0 [unmanaged_tunnel]='' [domain_action]=keep [bot_port]=1011 [deploy_mode]=direct [bot_domain]=''
        [platform_ip]="${PLATFORM_IP:-$DEFAULT_PLATFORM_IP}")
    if [ -f "$state/update-transaction" ]; then
        mapfile -t saved < "$state/update-transaction"
        TRANSACTION[operation]=upgrade
        TRANSACTION[original_sha]="${saved[1]:-}"
        TRANSACTION[original_branch]="${saved[2]:-}"
    fi
    for key in target_sha:target-sha was_running:was-running target_group_root:group-root; do
        value=''
        if [ -f "$snapshot/${key#*:}" ]; then value="$(cat "$snapshot/${key#*:}")"; fi
        TRANSACTION[${key%%:*}]="$value"
    done
    TRANSACTION[original_group_root]="$(saved_group_data_root)"
    if [ -f "$state/bot-port" ]; then TRANSACTION[bot_port]="$(tr -d '[:space:]' < "$state/bot-port")"; fi
    if [ -f "$state/deploy-mode" ]; then TRANSACTION[deploy_mode]="$(tr -d '[:space:]' < "$state/deploy-mode")"; fi
    if [ -f "$state/bot-domain" ]; then
        value="$(tr -d '[:space:]' < "$state/bot-domain")"
        # 与部署脚本一致：无效域名清除，需要规范化的写回规范值。
        if TRANSACTION[bot_domain]="$(normalize_hostname_input "$value" 2>/dev/null)"; then
            [ "${TRANSACTION[bot_domain]}" = "$value" ] || TRANSACTION[domain_action]=persist
        else
            TRANSACTION[bot_domain]=''; TRANSACTION[domain_action]=clear
        fi
    fi
    for key in "${TRANSACTION_KEYS[@]}"; do
        transaction_value_valid "$key" "${TRANSACTION[$key]-}" || { echo "旧版部署事务的 ${key} 无法识别" >&2; return 1; }
    done
    TRANSACTION_LEGACY=1
}

# 供菜单和日志显示的一行摘要。
describe_pending_transaction() {
    local kind='部署' state='停止' entry="${TRANSACTION[deploy_mode]}"
    [ "${TRANSACTION[operation]}" = deploy ] || kind='升级'
    [ "${TRANSACTION[was_running]}" = 0 ] || state='运行'
    [ "$entry" != direct ] || entry="direct（来源 ${TRANSACTION[platform_ip]}）"
    printf '未完成的%s：目标提交 %s；群数据总根 %s（原 %s）；端口 %s；入口 %s；原运行状态：%s' "$kind" \
        "${TRANSACTION[target_sha]:0:7}" "${TRANSACTION[target_group_root]}" "${TRANSACTION[original_group_root]}" \
        "${TRANSACTION[bot_port]}" "$entry" "$state"
    [ "${TRANSACTION_LEGACY:-0}" = 0 ] || printf '（旧版事务，端口、入口和域名按已保存设置，平台 IP 按当前设置）'
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
