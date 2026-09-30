#!/usr/bin/env bash
# Scenarios for tests/ops/service-user.test.ts. Sources the libraries, stubs Docker, id, stat, chown and flock, and prints
# one "name=result" line per case; a case's standard error is kept in <fixture>/<name>.err for message checks.
# Usage: service-user-cases.sh <record|identity|container|deploy|files|guard> <fixture directory>
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/../../scripts/lib/common.sh"
. "$here/../../scripts/lib/service-user.sh"
group="$1"
fixture="$2"
PROJECT_DIR="$fixture/project"
STATE_DIR="$PROJECT_DIR/data/state"
mkdir -p "$fixture/containers" "$STATE_DIR" "$PROJECT_DIR/data/config"
: > "$fixture/calls"
: > "$fixture/chowns"

result() { printf '%s=%s\n' "$1" "$2"; }
# Runs in this shell, so a function's variables stay visible to the result lines that follow.
check() {
    local name="$1" code=0
    shift
    "$@" 2> "$fixture/$name.err" || code=$?
    result "$name" "$code"
}
# Standard output and status of a function that prints its answer.
capture() {
    local name="$1" out code=0
    shift
    out="$("$@" 2> "$fixture/$name.err")" || code=$?
    result "$name" "$code:$out"
}
# The function's own shell: exit, traps and file descriptors stay inside the case.
isolated() ( "$@" )

# ---- stubs: every answer comes from a file, so command substitutions share the state ----
rootless() { echo '[name=seccomp,profile=builtin name=rootless name=cgroupns]' > "$fixture/options"; }
rootful() { echo '[name=seccomp,profile=builtin name=cgroupns]' > "$fixture/options"; }
uid() { echo "$1" > "$fixture/uid"; }
owner() { if [ -n "$1" ]; then echo "$1" > "$fixture/owner"; else rm -f -- "$fixture/owner"; fi; }
# container <name> <id|user|image|data|groups>, or remove it with no fields.
container() {
    local name="$1"
    shift
    if [ "$#" -eq 0 ]; then rm -f -- "$fixture/containers/$name"; else printf '%s\n' "$*" > "$fixture/containers/$name"; fi
}
docker() {
    printf '%s\n' "$*" >> "$fixture/calls"
    if [ -e "$fixture/down" ]; then echo 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' >&2; return 1; fi
    case "$1 ${2:-}" in
        'info --format') cat "$fixture/options" ;;
        'container inspect')
            local name="${*: -1}"
            [ -f "$fixture/containers/$name" ] || { echo "Error response from daemon: No such container: $name" >&2; return 1; }
            if [ "${4:-}" = '{{.Config.User}}' ]; then cut -d'|' -f2 "$fixture/containers/$name"; else cat "$fixture/containers/$name"; fi ;;
        'run --rm') ;;
        *) return 99 ;;
    esac
}
id() { if [ "${1:-}" = -u ]; then cat "$fixture/uid"; else command id "$@"; fi; }
stat() {
    [ -f "$fixture/owner" ] || { echo "stat: cannot statx '${*: -1}': No such file or directory" >&2; return 1; }
    cat "$fixture/owner"
}
chown() { printf '%s\n' "$*" >> "$fixture/chowns"; [ ! -e "$fixture/chown-fails" ]; }
# The deployment lock is busy while <fixture>/held exists.
flock() { [ ! -e "$fixture/held" ]; }
print_error() { printf '%s\n' "$1" >&2; }
print_warning() { printf '%s\n' "$1" >&2; }
print_status() { :; }
ER() { printf '%s\n' "$1" >&2; }
WA() { printf '%s\n' "$1" >&2; }
ask_yes_no() { printf '%s\n' "$1" >> "$fixture/questions"; [ "$(cat "$fixture/answer")" = y ]; }
chowns() { tr '\n' ';' < "$fixture/chowns" | sed "s#$PROJECT_DIR#<p>#g"; : > "$fixture/chowns"; }
# A function taken from an entry script, so the test runs the shipped text rather than a copy.
load_function() { eval "$(sed -n "/^$2() [{(]\$/,/^[})]\$/p" "$1" | tr -d '\r')"; }

record_cases() {
    local base="$fixture/record" dir
    mkdir -p "$base/written" "$base/bad-user" "$base/bad-source"
    SERVICE_USER=1000:1000 SERVICE_USER_SOURCE=container
    check write write_service_user_record "$base/written"
    result write-tmp-left "$([ -e "$base/written/service-user.tmp" ] && echo yes || echo no)"
    SERVICE_USER='' SERVICE_USER_SOURCE=''
    check read-written read_service_user_record "$base/written"
    result read-written-value "$SERVICE_USER|$SERVICE_USER_SOURCE"
    # Values that could not be read back are refused before anything is written.
    SERVICE_USER=appuser SERVICE_USER_SOURCE=container
    check write-bad-user write_service_user_record "$base/bad-user"
    SERVICE_USER=1000:1000 SERVICE_USER_SOURCE=guessed
    check write-bad-source write_service_user_record "$base/bad-source"
    result refused-left "$(find "$base/bad-user" "$base/bad-source" -mindepth 1 | wc -l | tr -d ' ')"
    # Each prepared directory under read/ is read in turn; a refused read leaves nothing behind.
    for dir in "$base"/read/*/; do
        dir="${dir%/}"
        SERVICE_USER=stale SERVICE_USER_SOURCE=stale
        check "read-${dir##*/}" read_service_user_record "$dir"
        result "left-${dir##*/}" "$SERVICE_USER|$SERVICE_USER_SOURCE"
    done
}

identity_cases() {
    local value
    # Printed as "key:value=status"; the values are one-line and hold no "=".
    valid() { local code=0; service_user_value_valid "$1" "$2" 2> /dev/null || code=$?; result "$1:$2" "$code"; }
    for value in 1000:1000 0:0 1001:0 4294967294:4294967294 4294967295:0 0:4294967295 01000:1000 1000 appuser 1000:1000:1 -1:0 ' 1000:1000' ''; do
        valid user "$value"
    done
    check user-newline service_user_value_valid user $'1000:1000\n'
    for value in container default confirmed guessed ''; do valid source "$value"; done
    valid format 1
    valid format 2
    valid image 1000:1000
    # rootless: only 0:0, which maps to the deploying user; rootful: never the host's root.
    check fits-rootless-root service_user_fits_daemon 0:0 1
    check fits-rootless-user service_user_fits_daemon 1000:1000 1
    check fits-rootful-user service_user_fits_daemon 1000:1000 0
    check fits-rootful-root-group service_user_fits_daemon 1000:0 0
    check fits-rootful-root service_user_fits_daemon 0:0 0
    check fits-rootful-root-user service_user_fits_daemon 0:1000 0
    capture default-rootless default_service_user 1
    capture default-rootful default_service_user 0
    # The operator gate: rootful needs root, rootless must not be root.
    rootful; uid 0
    DOCKER_ROOTLESS=''; check operator-rootful-root require_deploy_operator update; result operator-rootful-root-mode "$DOCKER_ROOTLESS"
    uid 1000
    DOCKER_ROOTLESS=''; check operator-rootful-user require_deploy_operator update
    rootless
    DOCKER_ROOTLESS=''; check operator-rootless-user require_deploy_operator resume; result operator-rootless-user-mode "$DOCKER_ROOTLESS"
    uid 0
    DOCKER_ROOTLESS=''; check operator-rootless-root require_deploy_operator rollback
    # Whether a deployment was ever committed: any of its settings.
    check recorded-none deployment_recorded
    : > "$STATE_DIR/deploy-mode"
    check recorded-mode deployment_recorded
    rm -f -- "$STATE_DIR/deploy-mode"
    # The owner of data/state, offered for confirmation when the container is gone.
    rootful; uid 0
    owner 1000:1000; capture data-rootful data_owner_user 0
    owner 0:0; capture data-rootful-root data_owner_user 0
    owner ''; capture data-missing data_owner_user 0
    uid 1000; owner 1000:1000; capture data-rootless data_owner_user 1
    owner 1001:1001; capture data-rootless-other data_owner_user 1
}
data_owner_user() { service_user_from_data "$1"; }

container_cases() {
    local data="$PROJECT_DIR/data" name
    rootful
    container mixin-chatbot "c0ffee|1000:1000|sha256:old|$data|/srv/groups"
    check read original_service_container
    result read-fields "$ORIGINAL_CONTAINER_ID|$ORIGINAL_CONTAINER_USER|$ORIGINAL_CONTAINER_IMAGE|$ORIGINAL_CONTAINER_GROUPS"
    container mixin-chatbot
    check read-missing original_service_container
    : > "$fixture/down"
    check read-down original_service_container
    rm -f -- "$fixture/down"
    # Each container is read and then checked; SERVICE_USER is set only when the identity is certain.
    identity() {
        local name="$1" rootless="$2"
        shift 2
        container mixin-chatbot "$*"
        SERVICE_USER='' SERVICE_USER_SOURCE=''
        original_service_container 2> /dev/null
        check "from-$name" service_user_from_container "$rootless"
        result "from-$name-value" "$SERVICE_USER|$SERVICE_USER_SOURCE"
    }
    identity rootful 0 "c0ffee|1000:1000|sha256:old|$data|"
    identity rootful-dotted 0 "c0ffee|1000:1000|sha256:old|$PROJECT_DIR/./data/|"
    identity rootless 1 "c0ffee|0:0|sha256:old|$data|"
    identity foreign-data 0 "c0ffee|1000:1000|sha256:old|$fixture/other/data|"
    identity no-data 0 "c0ffee|1000:1000|sha256:old||"
    identity image-user 0 "c0ffee||sha256:old|$data|"
    identity named-user 0 "c0ffee|appuser|sha256:old|$data|"
    identity rootful-root 0 "c0ffee|0:0|sha256:old|$data|"
    identity rootless-user 1 "c0ffee|1000:1000|sha256:old|$data|"
    # One-off containers of the operations entry use the service container's identity, then the owner of data/config.
    capture one-off-container service_container_user
    container mixin-chatbot "c0ffee|appuser|sha256:old|$data|"
    owner 1234:1234; capture one-off-named service_container_user
    container mixin-chatbot
    capture one-off-owner service_container_user
    rootless; capture one-off-rootless service_container_user
    rootful; owner ''; capture one-off-unreadable service_container_user
    # Without dependencies in the checkout the configuration is checked in the image, offline, as that identity.
    owner 1234:1234
    : > "$fixture/calls"
    check validate-default validate_model_configuration
    check validate-pinned validate_model_configuration "sha256:$(printf 'c%.0s' {1..64})" 1000:1000
    owner ''
    check validate-unreadable validate_model_configuration
    result validate-runs "$(grep '^run ' "$fixture/calls" | sed "s#$PROJECT_DIR#<p>#g" | tr '\n' ';')"
}

deploy_cases() {
    local data="$PROJECT_DIR/data"
    load_function "$here/../../scripts/deploy/deploy.sh" determine_service_user
    deploy_identity() {
        local name="$1"
        SERVICE_USER='' SERVICE_USER_SOURCE='' DOCKER_ROOTLESS="$2"
        : > "$fixture/questions"
        check "deploy-$name" determine_service_user
        result "deploy-$name-user" "$SERVICE_USER|$SERVICE_USER_SOURCE"
        result "deploy-$name-questions" "$(wc -l < "$fixture/questions" | tr -d ' ')"
    }
    rootful; uid 0; echo n > "$fixture/answer"
    container mixin-chatbot "c0ffee|1000:1000|sha256:old|$data|"
    deploy_identity container 0
    container mixin-chatbot "c0ffee|appuser|sha256:old|$data|"
    deploy_identity unclear 0
    : > "$fixture/down"
    deploy_identity down 0
    rm -f -- "$fixture/down"
    # No service container: a leftover rollback container is looked at first.
    container mixin-chatbot
    container mixin-chatbot-rollback "d00d|1000:1000|sha256:old|$data|"
    deploy_identity rollback-left 0
    container mixin-chatbot-rollback
    # Never deployed: the image default.
    deploy_identity first 0
    deploy_identity first-rootless 1
    # Deployed before but the container is gone: the operator confirms the owner of data/state, or nothing changes.
    echo 1000 > "$STATE_DIR/bot-port"
    owner 1000:1000
    deploy_identity declined 0
    result deploy-declined-question "$(cat "$fixture/questions")"
    echo y > "$fixture/answer"
    deploy_identity confirmed 0
    owner 0:0
    deploy_identity root-owned 0
    uid 1000; owner 1000:1000; rootless
    deploy_identity confirmed-rootless 1
    rm -f -- "$STATE_DIR/bot-port"
}

files_cases() {
    local p="$PROJECT_DIR"
    SERVICE_USER=1000:1000
    mkdir -p "$p/backup" "$p/logs"
    uid 0
    # Only the directories made now change hands, from the highest one created; existing ones keep their owner.
    check make make_service_directories "$p/backup/snapshots" "$p/backup/rm" "$p/new/a/b" "$p/data/config"
    result make-dirs "$([ -d "$p/backup/snapshots" ] && [ -d "$p/backup/rm" ] && [ -d "$p/new/a/b" ] && echo yes)"
    result make-chowns "$(chowns)"
    check make-existing make_service_directories "$p/backup/snapshots" "$p/new/a/b"
    result make-existing-chowns "$(chowns)"
    : > "$fixture/chown-fails"
    check make-chown-fails make_service_directories "$p/other"
    rm -f -- "$fixture/chown-fails"
    : > "$fixture/chowns"
    uid 1000
    check make-user make_service_directories "$p/user/a"
    result make-user-dirs "$([ -d "$p/user/a" ] && echo yes)"
    result make-user-chowns "$(chowns)"
    # Single paths, never recursive; nothing to do for a user who cannot give files away.
    uid 0; check grant grant_service_access "$p/a" "$p/b"; result grant-chowns "$(chowns)"
    uid 1000; check grant-user grant_service_access "$p/a"; result grant-user-chowns "$(chowns)"
    # The operation log: the two directory levels that exist and this operation's file, never a link.
    uid 0
    : > "$p/logs/operation.log"
    BOT_OPERATION_LOG_PATH="$p/logs/operation.log" check log grant_operation_log_access
    result log-chowns "$(chowns)"
    mkdir -p "$p/logs/operations"
    ln -s "$p/logs/operation.log" "$p/logs/operations/link.log" 2> /dev/null
    [ -L "$p/logs/operations/link.log" ] || rm -f -- "$p/logs/operations/link.log"
    BOT_OPERATION_LOG_PATH="$p/logs/operations/link.log" check log-link grant_operation_log_access
    result log-link-chowns "$(chowns)"
    rm -rf -- "$p/logs"
    BOT_OPERATION_LOG_PATH='' check log-none grant_operation_log_access
    result log-none-chowns "$(chowns)"
}

guard_cases() {
    load_function "$here/../../scripts/ops/ops.sh" guard_one_off_container
    load_function "$here/../../scripts/ops/ops.sh" deployment_in_progress
    check guard-clear isolated guard_one_off_container
    : > "$fixture/held"
    check guard-busy isolated guard_one_off_container
    rm -f -- "$fixture/held"
    : > "$STATE_DIR/deploy-transaction"
    check guard-deploy isolated guard_one_off_container
    rm -f -- "$STATE_DIR/deploy-transaction"
    : > "$STATE_DIR/update-transaction"
    check guard-update isolated guard_one_off_container
    rm -f -- "$STATE_DIR/update-transaction"
    # The read-only check does not take the lock: it only asks whether someone else holds it.
    rm -f -- "$STATE_DIR/deploy.lock"
    check busy-none deployment_in_progress
    : > "$STATE_DIR/deploy.lock"
    check busy-free deployment_in_progress
    : > "$fixture/held"
    check busy-held deployment_in_progress
    BOT_DEPLOY_LOCK_HELD="$(realpath -m -- "$STATE_DIR")/deploy.lock" check busy-own deployment_in_progress
    rm -f -- "$fixture/held"
    : > "$STATE_DIR/deploy-transaction"
    check busy-pointer deployment_in_progress
    rm -f -- "$STATE_DIR/deploy-transaction"
    # root upgrading a checkout that a docker group user owns: git's refusal is explained, never overridden.
    load_function "$here/../../scripts/ops/ops.sh" require_git_checkout
    owner jay
    git() { printf "fatal: detected dubious ownership in repository at '%s'\n" "$PROJECT_DIR" >&2; return 128; }
    check git-foreign require_git_checkout
    git() { echo 'fatal: not a git repository (or any of the parent directories): .git' >&2; return 128; }
    check git-none require_git_checkout
    git() { echo true; }
    check git-ok require_git_checkout
    unset -f git
}

"${group}_cases"
