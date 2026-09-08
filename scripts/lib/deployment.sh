#!/usr/bin/env bash
# Deployment transaction. Call begin_deployment only after read-only preflight succeeds.
DEPLOY_FILES=(data/config data/state/bot-port data/state/deploy-mode data/state/bot-domain data/state/group-data-root)

# archive_project_path is shared with ops and tunnel scripts.

begin_deployment() {
    mkdir -p "$PROJECT_DIR/backup/tmp" "$PROJECT_DIR/backup/rm" "$PROJECT_DIR/data/state"
    # util-linux flock owns the deployment lock; children launched as daemons close descriptor 9.
    exec 9>"$PROJECT_DIR/data/state/deploy.lock"
    flock -n 9 || { print_error "另一个部署正在进行"; return 1; }
    ROLLBACK_CONTAINER="mixin-chatbot-rollback"
    if docker ps -a --format '{{.Names}}' | grep -qx "$ROLLBACK_CONTAINER"; then
        print_error "发现旧回滚容器，请先确认其状态"; return 1
    fi
    DEPLOY_SNAPSHOT="$(mktemp -d "$PROJECT_DIR/backup/tmp/deploy-XXXXXXXX")"
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

rollback_deployment() {
    local status=$? failed=0
    trap - EXIT INT TERM
    [ "$DEPLOYMENT_COMMITTED" = 0 ] || return "$status"
    set +e
    if [ "$DEPLOY_FILES_MUTATED" = 0 ]; then
        if [ "$PREVIOUS_STOP_ATTEMPTED" = 1 ] && [ "$PREVIOUS_RUNNING" = 1 ]; then docker start mixin-chatbot >/dev/null; fi
        exit 1
    fi
    stop_tunnel_launcher || failed=1
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
            nohup "${TUNNEL_COMMAND[@]}" >> "$LOG_DIR/cloudflared.log" 2>&1 9>&- &
            record_cloudflared_pid "$!" || failed=1
            local attempt
            for ((attempt=0; attempt<5; attempt++)); do
                managed_cloudflared_pid >/dev/null && break
                sleep 1
            done
            managed_cloudflared_pid >/dev/null || failed=1
        else failed=1; fi
    fi
    if [ "$failed" = 0 ]; then print_warning "已恢复配置、容器、网络入口和原运行状态；快照在 $DEPLOY_SNAPSHOT"
    else print_error "自动回滚未完成；请检查保留的快照 $DEPLOY_SNAPSHOT"; fi
    [ "$status" -ne 0 ] || status=1
    exit "$status"
}
