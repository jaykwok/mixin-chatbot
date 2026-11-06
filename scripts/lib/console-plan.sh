#!/usr/bin/env bash
# Host-only check. The enclosing wrapper owns the lock until its operation finishes.
assert_console_lifecycle() {
    [ "${MIXIN_OPS_CONSOLE:-}" = 1 ] || return 0
    local operation="$1" branch="${2:-main}"
    if [ "${MIXIN_OPS_LIFECYCLE:-}" != "$operation" ] || [ -z "${MIXIN_OPS_TASK_ID:-}" ]; then
        echo '控制台部署缺少明确选择或任务记录；服务尚未停止' >&2; return 1
    fi
    case "${MIXIN_OPS_SWITCH_MAIN:-}" in 0|1) ;; *) echo '必须明确选择是否允许切换分支；服务尚未停止' >&2; return 1 ;; esac
    if [ "$operation" = update ] && [ "$branch" != main ] && [ "$MIXIN_OPS_SWITCH_MAIN" != 1 ]; then
        echo '未允许切换到 main；服务尚未停止' >&2; return 1
    fi
    case "${MIXIN_OPS_DIRECTORY:-}" in
        saved) [ -f "$PROJECT_DIR/data/config/directory.json" ] && [ -z "${BOT_DIRECTORY_SCOPE:-}" ] || {
            echo '已保存的通讯录范围与确认不符；服务尚未停止' >&2; return 1; } ;;
        all) [ ! -e "$PROJECT_DIR/data/config/directory.json" ] && [ "${BOT_DIRECTORY_SCOPE:-}" = all ] || {
            echo '首次通讯录范围与确认不符；服务尚未停止' >&2; return 1; } ;;
        selected) [ ! -e "$PROJECT_DIR/data/config/directory.json" ] && [ -z "${BOT_DIRECTORY_SCOPE:-}" ] &&
            [ -n "${MIXIN_OPS_DIRECTORY_INPUT:-}" ] && [ -n "${MIXIN_OPS_DIRECTORY_APP:-}" ] || {
            echo '部门选择与确认不符；服务尚未停止' >&2; return 1; } ;;
        *) echo '必须明确选择通讯录范围；服务尚未停止' >&2; return 1 ;;
    esac
    local required
    for required in data/config/models.json data/config/app-bot.json data/runtime/pi/settings.json; do
        [ -f "$PROJECT_DIR/$required" ] || { echo '缺少已有配置，请先完成首次部署；服务尚未停止' >&2; return 1; }
    done
}

check_console_plan() {
    [ -n "${MIXIN_OPS_TASK_ID:-}" ] || return 0
    if [ -z "${MIXIN_OPS_BUN:-}" ] || [ -z "${MIXIN_OPS_GUARD:-}" ] || [ -z "${MIXIN_OPS_EXPECT_CODE:-}" ]; then
        echo '控制台任务缺少执行版本，未执行操作' >&2
        return 1
    fi
    "$MIXIN_OPS_BUN" --no-env-file "$MIXIN_OPS_GUARD" --project "$PROJECT_DIR" --task "$MIXIN_OPS_TASK_ID" --digest "$MIXIN_OPS_EXPECT_CODE"
}
