#!/usr/bin/env bash
# Deployment transaction. Call begin_deployment only after read-only preflight succeeds.
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
# 服务商、选型和动态目录缓存一起恢复，保证回滚后的实例仍能离线解析出原模型。
DEPLOY_FILES=(data/config data/runtime/pi/settings.json data/runtime/models-store.json data/state/bot-port data/state/deploy-mode data/state/bot-domain data/state/group-data-root)

# archive_project_path is shared with ops and tunnel scripts.

# Check before mkdir or Docker bind mounts can recreate an empty, missing data root.
verify_deployed_group_root() {
    local recorded="$PROJECT_DIR/data/state/group-data-root" root
    [ -s "$recorded" ] || return 0
    root="$(tr -d '\r\n' < "$recorded")"
    case "$root" in /*) ;; *) root="$PROJECT_DIR/$root" ;; esac
    if [ ! -d "$root" ]; then
        print_error "已部署的群数据根不存在：$root；请恢复原挂载后重试"
        return 1
    fi
}

begin_deployment() {
    mkdir -p "$PROJECT_DIR/backup/snapshots" "$PROJECT_DIR/backup/rm" "$PROJECT_DIR/data/state"
    # util-linux flock owns the deployment lock; children launched as daemons close descriptor 9.
    acquire_deploy_lock || { print_error "另一个部署正在进行"; return 1; }
    ROLLBACK_CONTAINER="mixin-chatbot-rollback"
    if [ -f "$PROJECT_DIR/data/state/deploy-transaction" ]; then
        local saved_name
        saved_name="$(cat "$PROJECT_DIR/data/state/deploy-transaction")"
        [[ "$saved_name" =~ ^deploy-[a-zA-Z0-9]+$ ]] || { print_error "部署事务快照名称无效"; return 1; }
        DEPLOY_SNAPSHOT="$PROJECT_DIR/backup/snapshots/$saved_name"
        [ -d "$DEPLOY_SNAPSHOT" ] && [ ! -L "$DEPLOY_SNAPSHOT" ] || { print_error "部署快照缺失"; return 1; }
        if [ -s "$DEPLOY_SNAPSHOT/group-root" ] && [ "$(cat "$DEPLOY_SNAPSHOT/group-root")" != "${HOST_GROUP_DATA_ROOT:-}" ]; then
            print_error "中断部署必须使用原群目录继续"; return 1
        fi
        if [ -s "$DEPLOY_SNAPSHOT/target-sha" ] && [ "$(git -C "$PROJECT_DIR" rev-parse HEAD)" != "$(cat "$DEPLOY_SNAPSHOT/target-sha")" ]; then
            print_error "中断部署必须使用原目标提交继续"; return 1
        fi
        PREVIOUS_RUNNING="$(cat "$DEPLOY_SNAPSHOT/was-running")"
        [[ "$PREVIOUS_RUNNING" =~ ^[01]$ ]] || return 1
        # Complete an already committed activation before beginning another transaction.
        if declare -F migration_docker >/dev/null && migration_docker committed --deployment "$saved_name"; then
            docker stop --time 30 mixin-chatbot >/dev/null || return 1
            rm -f -- "$PROJECT_DIR/data/state/verify-only"
            if [ "$PREVIOUS_RUNNING" = 1 ]; then docker start mixin-chatbot >/dev/null || return 1; fi
            if docker inspect "$ROLLBACK_CONTAINER" >/dev/null 2>&1; then docker rm "$ROLLBACK_CONTAINER" >/dev/null || return 1; fi
            rm -f -- "$PROJECT_DIR/data/state/deploy-transaction"
            begin_deployment
            return $?
        fi
        export BOT_DEPLOY_BACKUP_ID="$saved_name"
        PREVIOUS_IMAGE="$(cat "$DEPLOY_SNAPSHOT/previous-image")"
        PREVIOUS_TUNNEL_RUNNING="$(cat "$DEPLOY_SNAPSHOT/tunnel-running")"
        TUNNEL_COMMAND=()
        if [ -s "$DEPLOY_SNAPSHOT/tunnel-command" ]; then mapfile -d '' -t TUNNEL_COMMAND < "$DEPLOY_SNAPSHOT/tunnel-command"; fi
        UFW_SNAPSHOTTED=0
        if [ -f "$DEPLOY_SNAPSHOT/ufw-rules.txt" ]; then UFW_SNAPSHOTTED=1; fi
        PREVIOUS_CONTAINER_SAVED=0; PREVIOUS_STOP_ATTEMPTED=0
        if docker inspect "$ROLLBACK_CONTAINER" >/dev/null 2>&1; then
            PREVIOUS_CONTAINER_SAVED=1; PREVIOUS_STOP_ATTEMPTED=1
            if docker inspect mixin-chatbot >/dev/null 2>&1; then
                docker stop --time 30 mixin-chatbot >/dev/null || return 1
                docker rename mixin-chatbot "mixin-chatbot-failed-$(date +%s)" || return 1
            fi
        elif [ -n "$PREVIOUS_IMAGE" ]; then
            docker stop --time 30 mixin-chatbot >/dev/null || return 1
            docker rename mixin-chatbot "$ROLLBACK_CONTAINER" || return 1
            PREVIOUS_CONTAINER_SAVED=1; PREVIOUS_STOP_ATTEMPTED=1
        elif docker inspect mixin-chatbot >/dev/null 2>&1; then
            docker stop --time 30 mixin-chatbot >/dev/null || return 1
            docker rename mixin-chatbot "mixin-chatbot-failed-$(date +%s)" || return 1
        fi
        NEW_CONTAINER_ATTEMPTED=0; DEPLOY_FILES_MUTATED=1; TUNNEL_STARTED_BY_DEPLOY=0; DEPLOYMENT_COMMITTED=0
        MIGRATION_APPLY_ATTEMPTED=1
        trap rollback_deployment EXIT; trap 'exit 130' INT; trap 'exit 143' TERM
        print_warning "继续中断的部署，沿用原快照和原运行状态：$saved_name"
        return 0
    fi
    if docker ps -a --format '{{.Names}}' | grep -qx "$ROLLBACK_CONTAINER"; then
        print_error "发现旧回滚容器，请先确认其状态"; return 1
    fi
    DEPLOY_SNAPSHOT="$(mktemp -d "$PROJECT_DIR/backup/snapshots/deploy-XXXXXXXX")"
    export BOT_DEPLOY_BACKUP_ID="$(basename -- "$DEPLOY_SNAPSHOT")"
    chmod 700 "$DEPLOY_SNAPSHOT"
    local relative
    for relative in "${DEPLOY_FILES[@]}"; do
        if [ -e "$PROJECT_DIR/$relative" ]; then
            mkdir -p "$(dirname "$DEPLOY_SNAPSHOT/$relative")"
            cp -a -- "$PROJECT_DIR/$relative" "$DEPLOY_SNAPSHOT/$relative"
        fi
    done
    PREVIOUS_RUNNING=0
    PREVIOUS_CONTAINER_SAVED=0
    PREVIOUS_STOP_ATTEMPTED=0
    PREVIOUS_IMAGE="$(docker inspect --format '{{.Image}}' mixin-chatbot 2>/dev/null || true)"
    if [ "$(docker inspect --format '{{.State.Running}}' mixin-chatbot 2>/dev/null || true)" = true ]; then PREVIOUS_RUNNING=1; fi
    PREVIOUS_TUNNEL_RUNNING=0
    TUNNEL_COMMAND=()
    local tunnel_pid
    if tunnel_pid="$(managed_cloudflared_pid)"; then
        PREVIOUS_TUNNEL_RUNNING=1
        mapfile -d '' -t TUNNEL_COMMAND < "/proc/$tunnel_pid/cmdline"
    fi
    UFW_SNAPSHOTTED=0
    if command -v ufw >/dev/null 2>&1 && can_manage_ufw; then
        run_ufw show added > "$DEPLOY_SNAPSHOT/ufw-before.txt"
        : > "$DEPLOY_SNAPSHOT/ufw-rules.txt"
        local line
        while IFS= read -r line; do
            [[ "$line" == *'Mixin-Chatbot (平台IP)'* ]] || continue
            if [[ "$line" =~ ^ufw\ allow\ (proto\ tcp\ )?from\ ([0-9a-fA-F:./]+)\ to\ any\ port\ ([0-9]+)\ (proto\ tcp\ )?comment\  ]]; then
                printf '%s %s\n' "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}" >> "$DEPLOY_SNAPSHOT/ufw-rules.txt"
            else
                print_error "无法安全记录项目 UFW 规则，尚未修改部署"; return 1
            fi
        done < "$DEPLOY_SNAPSHOT/ufw-before.txt"
        UFW_SNAPSHOTTED=1
    fi
    printf '%s' "$PREVIOUS_RUNNING" > "$DEPLOY_SNAPSHOT/was-running"
    printf '%s' "$PREVIOUS_IMAGE" > "$DEPLOY_SNAPSHOT/previous-image"
    printf '%s' "$PREVIOUS_TUNNEL_RUNNING" > "$DEPLOY_SNAPSHOT/tunnel-running"
    printf '%s' "${HOST_GROUP_DATA_ROOT:-}" > "$DEPLOY_SNAPSHOT/group-root"
    git -C "$PROJECT_DIR" rev-parse HEAD > "$DEPLOY_SNAPSHOT/target-sha" 2>/dev/null || : > "$DEPLOY_SNAPSHOT/target-sha"
    if [ "${#TUNNEL_COMMAND[@]}" -gt 0 ]; then printf '%s\0' "${TUNNEL_COMMAND[@]}" > "$DEPLOY_SNAPSHOT/tunnel-command"; fi
    printf '%s' "$(basename -- "$DEPLOY_SNAPSHOT")" > "$PROJECT_DIR/data/state/deploy-transaction.tmp"
    mv -- "$PROJECT_DIR/data/state/deploy-transaction.tmp" "$PROJECT_DIR/data/state/deploy-transaction"
    NEW_CONTAINER_ATTEMPTED=0
    DEPLOY_FILES_MUTATED=0
    TUNNEL_STARTED_BY_DEPLOY=0
    DEPLOYMENT_COMMITTED=0
    trap rollback_deployment EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    if [ -n "$PREVIOUS_IMAGE" ]; then
        PREVIOUS_STOP_ATTEMPTED=1
        docker stop --time 30 mixin-chatbot >/dev/null
        docker rename mixin-chatbot "$ROLLBACK_CONTAINER"
        PREVIOUS_CONTAINER_SAVED=1
    fi
    DEPLOY_FILES_MUTATED=1
}

commit_deployment() {
    # The update parent must distinguish a committed deployment from a later diagnostic failure or signal.
    if [ -n "${BOT_UPDATE_COMMIT_FILE:-}" ]; then
        printf 'committed\n' > "$BOT_UPDATE_COMMIT_FILE" || return 1
    fi
    DEPLOYMENT_COMMITTED=1
    trap - EXIT INT TERM
}

rollback_deployment() {
    local status=$? failed=0
    trap - EXIT INT TERM
    [ "$DEPLOYMENT_COMMITTED" = 0 ] || return "$status"
    # A signal can arrive after the receipt write and before the local flag is assigned.
    if [ "${MIGRATION_APPLY_ATTEMPTED:-0}" = 0 ] && [ -n "${BOT_UPDATE_COMMIT_FILE:-}" ] && [ "$(cat "$BOT_UPDATE_COMMIT_FILE" 2>/dev/null)" = committed ]; then return "$status"; fi
    set +e
    if [ "$DEPLOY_FILES_MUTATED" = 0 ]; then
        if [ "$PREVIOUS_STOP_ATTEMPTED" = 1 ] && [ "$PREVIOUS_RUNNING" = 1 ]; then docker start mixin-chatbot >/dev/null; fi
        exit 1
    fi
    stop_tunnel_launcher || failed=1
    if [ -n "${tunnel_startup_log:-}" ]; then rm -f -- "$tunnel_startup_log" || failed=1; fi
    if [ "$TUNNEL_STARTED_BY_DEPLOY" = 1 ] || [ "$PREVIOUS_TUNNEL_RUNNING" = 0 ]; then
        if managed_cloudflared_pid >/dev/null 2>&1; then stop_managed_cloudflared || failed=1; fi
    fi
    if [ "$NEW_CONTAINER_ATTEMPTED" = 1 ] && docker inspect mixin-chatbot >/dev/null 2>&1; then
        if docker stop --time 30 mixin-chatbot >/dev/null; then
            docker rename mixin-chatbot "mixin-chatbot-failed-$(date +%s)" || failed=1
        else
            print_error "新容器未停止，拒绝覆盖其配置；快照保留在 $DEPLOY_SNAPSHOT"
            exit 1
        fi
    fi
    # Data must be restored before the old container can start. A committed data marker
    # is authoritative even if the shell died before writing its deployment receipt.
    if declare -F rollback_data_migration >/dev/null; then
        local migration_status=0
        rollback_data_migration || migration_status=$?
        if [ "$migration_status" != 0 ]; then
            # The legacy update parent only understands this receipt. Preserve the target
            # code (and its recovery tools) even when data restoration itself failed.
            if [ -n "${BOT_UPDATE_COMMIT_FILE:-}" ]; then printf 'committed\n' > "$BOT_UPDATE_COMMIT_FILE"; fi
            print_error "数据回滚未完成或已经提交；保持停止，不恢复旧容器。"
            exit 1
        fi
    fi
    rm -f -- "$PROJECT_DIR/data/state/verify-only"
    local relative
    for relative in "${DEPLOY_FILES[@]}"; do
        archive_project_path "$PROJECT_DIR/$relative" || failed=1
        if [ -e "$DEPLOY_SNAPSHOT/$relative" ]; then
            mkdir -p "$(dirname "$PROJECT_DIR/$relative")"
            cp -a -- "$DEPLOY_SNAPSHOT/$relative" "$PROJECT_DIR/$relative" || failed=1
        fi
    done
    if [ "$UFW_SNAPSHOTTED" = 1 ]; then
        remove_managed_ufw_rules || failed=1
        local address port
        while read -r address port; do
            run_ufw allow from "$address" to any port "$port" proto tcp comment 'Mixin-Chatbot (平台IP)' || failed=1
        done < "$DEPLOY_SNAPSHOT/ufw-rules.txt"
    fi
    if [ -n "$PREVIOUS_IMAGE" ]; then docker tag "$PREVIOUS_IMAGE" mixin-chatbot || failed=1; fi
    if [ "$PREVIOUS_CONTAINER_SAVED" = 1 ]; then docker rename "$ROLLBACK_CONTAINER" mixin-chatbot || failed=1; fi
    if [ "$failed" = 0 ] && [ "$PREVIOUS_STOP_ATTEMPTED" = 1 ] && [ "$PREVIOUS_RUNNING" = 1 ]; then
        docker start mixin-chatbot >/dev/null || failed=1
    fi
    if [ "$PREVIOUS_TUNNEL_RUNNING" = 1 ] && ! managed_cloudflared_pid >/dev/null 2>&1; then
        if [ "${#TUNNEL_COMMAND[@]}" -gt 0 ]; then
            start_managed_cloudflared_command "${TUNNEL_COMMAND[@]}" || failed=1
        else failed=1; fi
    fi
    if [ "$failed" = 0 ]; then
        if [ "${MIGRATION_APPLY_ATTEMPTED:-0}" = 1 ] && [ -n "${BOT_UPDATE_COMMIT_FILE:-}" ]; then : > "$BOT_UPDATE_COMMIT_FILE"; fi
        rm -f -- "$PROJECT_DIR/data/state/deploy-transaction"
        print_warning "已恢复配置、容器、网络入口和原运行状态；快照在 $DEPLOY_SNAPSHOT"
    else print_error "自动回滚未完成；请检查保留的快照 $DEPLOY_SNAPSHOT"; fi
    [ "$status" -ne 0 ] || status=1
    exit "$status"
}
