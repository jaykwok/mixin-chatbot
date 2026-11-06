#!/usr/bin/env bash
# Appended to the copied scripts/lib/core-handoff.sh of a deploy-entry fixture (tests/ops/deploy-entry.test.ts): the last
# library deploy.sh sources, so these replace the library's Docker, build, task-daemon and disk-space boundaries while
# deploy.sh's own functions run unchanged. Every call is appended to $FIXTURE_EVENTS; a Docker call that could change the
# running service is recorded as FORBIDDEN and fails. The fixture's rootless daemon maps the service to 0:0.

fixture_event() { printf '%s\n' "$*" >> "$FIXTURE_EVENTS"; }

require_deploy_operator() { DOCKER_ROOTLESS=1; fixture_event operator; }
ops_bun() { printf '%s\n' "$FIXTURE_BUN"; }
check_build_disk_space() { fixture_event build-space; }
check_stop_disk_space() { fixture_event stop-space; }
task_runtime_prepare() { TASK_DOCKER_ENDPOINT=unix:///run/user/1002/docker.sock TASK_DOCKER_ID=task-daemon-01; fixture_event task-runtime; }
release_candidate() { fixture_event "release ${CANDIDATE[image_tag]}"; }

prepare_candidate_image() {
    local project_id
    project_id="$(candidate_project_id "$4")" || return 1
    fixture_event "build source=$3 head=$2"
    [ "${FIXTURE_BUILD:-0}" = 0 ] || return "$FIXTURE_BUILD"
    declare -gA CANDIDATE=([format]=1 [source]="$3" [target_sha]="$2" [image_id]="$FIXTURE_IMAGE"
        [image_tag]="mixin-bot:candidate-${project_id}-0123456789abcdef" [daemon_id]=main-daemon-01 [project_id]="$project_id"
        [operation_id]=0123456789abcdef)
}

docker() {
    fixture_event "docker $*"
    case "$1" in
        info|logs) return 0 ;;
        container)
            if [ "$2" = inspect ] && [ "${*: -1}" = mixin-bot ] && [ -n "${FIXTURE_ORIGINAL:-}" ]; then
                case "$*" in
                    *'{{.Id}}|'*) printf '%s|0:0|%s|%s\n' "$FIXTURE_ORIGINAL" "$FIXTURE_ORIGINAL_IMAGE" "$PROJECT_DIR/data" ;;
                    *) printf '%s\n' "$FIXTURE_ORIGINAL_IMAGE" ;;
                esac
                return 0
            fi
            [ "$2" = inspect ] || { fixture_event FORBIDDEN; return 1; }
            echo "Error response from daemon: No such container: ${*: -1}" >&2
            return 1 ;;
        run) fixture_docker_run "${@:2}" ;;
        *) fixture_event FORBIDDEN; return 1 ;;
    esac
}

# One-off containers of the entry: every one runs the candidate by ID and is removed after it exits. The previews write what
# the target release would into the stage directory mounted at /preview.
fixture_docker_run() {
    local arg previous='' preview='' port='' host=''
    for arg in "$@"; do
        if [ "$previous" = -v ] && [[ "$arg" == *:/preview ]]; then preview="${arg%:/preview}"; fi
        if [ "$previous" = -e ] && [[ "$arg" == BOT_PORT=* ]]; then port="${arg#BOT_PORT=}"; fi
        if [ "$previous" = -e ] && [[ "$arg" == BOT_HOST=* ]]; then host="${arg#BOT_HOST=}"; fi
        previous="$arg"
    done
    [ "$1" = --rm ] && [[ " $* " == *" $FIXTURE_IMAGE "* ]] || { fixture_event FORBIDDEN; return 1; }
    case " $* " in
        *" ops/tools/data-current.ts "*)
            [ "${FIXTURE_DATA:-0}" = 0 ] || return "$FIXTURE_DATA"
            [[ " $* " != *" --plan /preview/data-plan.json "* ]] || printf '{}\n' > "$preview/data-plan.json" ;;
        *" ops/config/directory-scope.ts choose "*)
            [ "${BOT_DIRECTORY_SCOPE:-}" = all ] || { echo '没有终端，不能运行通讯录同步范围的选择向导' >&2; return 1; }
            printf '{"format":1,"all":true}\n' > "$preview/directory-scope-plan.json" ;;
        *" ops/config/runtime-settings.ts --prepare-values "*)
            printf '{"format":1,"base":null,"values":{"BOT_PORT":"%s","BOT_HOST":"%s"}}\n' "$port" "$host" > "$preview/runtime-values.json" ;;
        *" ops/tools/layout-check.ts "*|*" --entrypoint sh "*) ;;
        *) fixture_event FORBIDDEN; return 1 ;;
    esac
}
