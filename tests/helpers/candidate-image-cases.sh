#!/usr/bin/env bash
# Scenarios for tests/ops/candidate-image.test.ts. Sources the library, stubs Docker and the filesystem queries, and
# prints one "name=result" line per case; a case's standard error is kept in <fixture>/<name>.err for message checks.
# Usage: candidate-image-cases.sh <record|format|export|docker|prepare|storage|containerd|disk|snapshot> <fixture directory>
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/../../scripts/lib/candidate-image.sh"
group="$1"
fixture="$2"
DSTATE="$fixture/docker"
mkdir -p "$DSTATE/images" "$DSTATE/tags"
: > "$DSTATE/calls"
SHA="$(printf 'a%.0s' {1..40})"
IMAGE_B="sha256:$(printf 'b%.0s' {1..64})"
IMAGE_C="sha256:$(printf 'c%.0s' {1..64})"
DAEMON=5eec1de4-4518-46da-a461-80c0866ec11d
ROOTLESS='[name=seccomp,profile=builtin name=rootless name=cgroupns]'
ROOTFUL='[name=seccomp,profile=builtin name=cgroupns]'
TAG="$(candidate_tag mixin-chatbot 0123456789ab 0123456789abcdef)"

result() { printf '%s=%s\n' "$1" "$2"; }
# Runs in this shell, so a function's variables stay visible to later cases.
check() {
    local name="$1" code=0
    shift
    "$@" 2> "$fixture/$name.err" || code=$?
    result "$name" "$code"
}
exists() { if [ -e "$1" ]; then echo yes; else echo no; fi; }

valid_candidate() {
    declare -gA CANDIDATE=([format]=1 [source]=commit [target_sha]="$SHA" [image_id]="$IMAGE_B" [image_tag]="$TAG"
        [daemon_id]="$DAEMON" [project_id]=0123456789ab [operation_id]=0123456789abcdef)
}

# ---- Docker stub: images, tags and calls live in files so command substitutions share them ----
ref_file() { printf '%s/tags/%s' "$DSTATE" "$(printf '%s' "$1" | tr '/:' '__')"; }
resolve_ref() {
    local ref="$1" id
    if [[ "$ref" == sha256:* ]]; then id="$ref"; else [ -f "$(ref_file "$ref")" ] || return 1; id="$(cat "$(ref_file "$ref")")"; fi
    [ -f "$DSTATE/images/${id#sha256:}" ] || return 1
    printf '%s\n' "$id"
}
docker() {
    printf '%s\n' "$*" >> "$DSTATE/calls"
    if [ -n "${DOCKER_DOWN:-}" ]; then echo 'Cannot connect to the Docker daemon' >&2; return 1; fi
    case "$1" in
        info)
            case "$3" in
                '{{.ID}}') cat "$DSTATE/daemon" ;;
                '{{.Containerd.Address}}') cat "$DSTATE/address" ;;
                *) cat "$DSTATE/info" ;;
            esac ;;
        version) cat "$DSTATE/arch" ;;
        context) cat "$DSTATE/endpoint" ;;
        build)
            local iid='' tag='' revision='' project='' operation='' source='' id
            shift
            while [ "$#" -gt 1 ]; do
                case "$1" in
                    --iidfile) iid="$2"; shift 2 ;;
                    --tag) tag="$2"; shift 2 ;;
                    --label)
                        case "$2" in
                            org.opencontainers.image.revision=*) revision="${2#*=}" ;;
                            org.mixin-chatbot.project=*) project="${2#*=}" ;;
                            org.mixin-chatbot.operation=*) operation="${2#*=}" ;;
                            org.mixin-chatbot.source=*) source="${2#*=}" ;;
                        esac
                        shift 2 ;;
                    *) shift ;;
                esac
            done
            [ -z "${BUILD_FAIL:-}" ] || { echo 'build failed' >&2; return 1; }
            id="$(cat "$DSTATE/next-id")"
            printf '%s\n' "$id" > "$iid"
            if [[ "$id" == sha256:* ]]; then
                printf 'linux|amd64|%s|%s|%s|%s\n' "$revision" "$project" "$operation" "$source" > "$DSTATE/images/${id#sha256:}"
                printf '%s' "$id" > "$(ref_file "$tag")"
            fi ;;
        tag)
            local id
            id="$(resolve_ref "$2")" || { echo "Error response from daemon: No such image: $2" >&2; return 1; }
            [ -n "${TAG_NOOP:-}" ] || printf '%s' "$id" > "$(ref_file "$3")" ;;
        image)
            case "$2" in
                inspect)
                    local id
                    id="$(resolve_ref "$5")" || { echo "Error response from daemon: No such image: $5" >&2; return 1; }
                    case "$4" in
                        '{{.Id}}') printf '%s\n' "$id" ;;
                        '{{index .Config.Labels "org.mixin-chatbot.operation"}}') cut -d'|' -f5 "$DSTATE/images/${id#sha256:}" ;;
                        *) printf '%s|%s\n' "$id" "$(cat "$DSTATE/images/${id#sha256:}")" ;;
                    esac ;;
                rm) rm -f -- "$(ref_file "${*: -1}")" ;;
                ls) cat "$DSTATE/sizes" ;;
            esac ;;
    esac
}

record_cases() {
    local base="$fixture/record" dir
    mkdir -p "$base/written" "$base/bad-id" "$base/missing-key" "$base/tag-mismatch"
    valid_candidate
    check write write_candidate_record "$base/written"
    result write-tmp-left "$(exists "$base/written/candidate-image.tmp")"
    check read-written read_candidate_record "$base/written"
    result read-written-tag "${CANDIDATE[image_tag]:-}"
    # Values that could not be read back are refused before anything is written.
    valid_candidate; CANDIDATE[image_id]=sha256:abc
    check write-bad-id write_candidate_record "$base/bad-id"
    valid_candidate; unset 'CANDIDATE[daemon_id]'
    check write-missing-key write_candidate_record "$base/missing-key"
    valid_candidate; CANDIDATE[project_id]=ffffffffffff
    check write-tag-mismatch write_candidate_record "$base/tag-mismatch"
    result refused-left "$(find "$base/bad-id" "$base/missing-key" "$base/tag-mismatch" -mindepth 1 | wc -l | tr -d ' ')"
    # Each prepared directory under read/ is read in turn; a refused read leaves nothing behind in CANDIDATE.
    for dir in "$base"/read/*/; do
        dir="${dir%/}"
        check "read-${dir##*/}" read_candidate_record "$dir"
        result "left-${dir##*/}" "${#CANDIDATE[@]}"
    done
}

format_cases() {
    . "$here/../../scripts/lib/common.sh"
    result keys "${TRANSACTION_KEYS[*]}"
    check format-1 transaction_value_valid format 1
    check format-2 transaction_value_valid format 2
    check candidate-key transaction_value_valid image_id "$IMAGE_B"
}

export_cases() {
    local repo="$fixture/repo" sha
    git init -q "$repo"
    printf 'FROM scratch\n' > "$repo/Dockerfile"
    printf 'ignored.txt\n' > "$repo/.dockerignore"
    mkdir -p "$repo/src"
    printf committed > "$repo/src/a.txt"
    git -C "$repo" add -A
    git -C "$repo" -c user.name=fixture -c user.email=fixture@example.invalid -c core.autocrlf=false commit -qm base
    sha="$(git -C "$repo" rev-parse HEAD)"
    # The working tree differs from the commit in every way a build could pick up.
    printf dirty > "$repo/src/a.txt"
    printf untracked > "$repo/secret.txt"
    printf staged > "$repo/staged.txt"
    git -C "$repo" add staged.txt
    check export candidate_export_context "$repo" "$sha" "$fixture/context"
    result exported-a "$(cat "$fixture/context/src/a.txt")"
    result exported-files "$(cd "$fixture/context" && find . -type f | LC_ALL=C sort | tr '\n' ' ')"
    check export-existing candidate_export_context "$repo" "$sha" "$fixture/context"
    check export-ref candidate_export_context "$repo" HEAD "$fixture/context-ref"
    check export-unknown candidate_export_context "$repo" "$(printf 'c%.0s' {1..40})" "$fixture/context-unknown"
    git -C "$repo" rm -q --cached staged.txt
    git -C "$repo" rm -q Dockerfile
    git -C "$repo" -c user.name=fixture -c user.email=fixture@example.invalid commit -qm 'no dockerfile'
    check export-no-dockerfile candidate_export_context "$repo" "$(git -C "$repo" rev-parse HEAD)" "$fixture/context-none"
}

docker_cases() {
    printf '%s' "$DAEMON" > "$DSTATE/daemon"
    printf amd64 > "$DSTATE/arch"
    printf '%s' "$IMAGE_B" > "$DSTATE/next-id"
    check build candidate_build "$fixture/context" "$TAG" "$SHA" 0123456789ab 0123456789abcdef commit
    result build-id "$CANDIDATE_IMAGE_ID"
    result build-call "$(grep '^build ' "$DSTATE/calls")"
    result tagged "$(cat "$(ref_file "$TAG")")"
    BUILD_FAIL=1 check build-failed candidate_build "$fixture/context" "$TAG" "$SHA" 0123456789ab 0123456789abcdef commit
    result build-failed-id "$CANDIDATE_IMAGE_ID"
    printf 'not-an-id' > "$DSTATE/next-id"
    check build-bad-iid candidate_build "$fixture/context" "$TAG" "$SHA" 0123456789ab 0123456789abcdef commit
    result build-bad-iid-id "$CANDIDATE_IMAGE_ID"

    valid_candidate
    check verify candidate_verify
    printf feb63570-4e9c-4408-bcc5-f4ddbfad1aa3 > "$DSTATE/daemon"
    check verify-daemon candidate_verify
    printf '%s' "$DAEMON" > "$DSTATE/daemon"
    printf arm64 > "$DSTATE/arch"
    check verify-arch candidate_verify
    printf amd64 > "$DSTATE/arch"
    CANDIDATE[operation_id]=fedcba9876543210; CANDIDATE[image_tag]="$(candidate_tag mixin-chatbot 0123456789ab fedcba9876543210)"
    check verify-owner candidate_verify
    valid_candidate
    # Another image takes the reserved tag: execution stays bound to the recorded ID.
    printf 'linux|amd64||||\n' > "$DSTATE/images/${IMAGE_C#sha256:}"
    printf '%s' "$IMAGE_C" > "$(ref_file "$TAG")"
    check verify-tag-moved candidate_verify
    rm -f "$(ref_file "$TAG")"
    check verify-tag-gone candidate_verify
    printf '%s' "$IMAGE_B" > "$(ref_file "$TAG")"
    mv "$DSTATE/images/${IMAGE_B#sha256:}" "$DSTATE/removed"
    check verify-missing candidate_verify
    mv "$DSTATE/removed" "$DSTATE/images/${IMAGE_B#sha256:}"
    DOCKER_DOWN=1 check verify-down candidate_verify

    check publish candidate_publish "$IMAGE_B" mixin-chatbot
    result published "$(cat "$(ref_file mixin-chatbot)")"
    TAG_NOOP=1 check publish-unverified candidate_publish "$IMAGE_C" mixin-chatbot

    printf '%s' "$IMAGE_C" > "$(ref_file "$TAG")"
    check release-moved candidate_release_tag "$TAG" "$IMAGE_B"
    result release-moved-tag "$(cat "$(ref_file "$TAG")")"
    printf '%s' "$IMAGE_B" > "$(ref_file "$TAG")"
    check release candidate_release_tag "$TAG" "$IMAGE_B"
    result release-tag-left "$(exists "$(ref_file "$TAG")")"
    result release-published "$(cat "$(ref_file mixin-chatbot)")"
    check release-absent candidate_release_tag "$TAG" "$IMAGE_B"
    DOCKER_DOWN=1 check release-down candidate_release_tag "$TAG" "$IMAGE_B"
    result rm-calls "$(grep -c '^image rm' "$DSTATE/calls")"
}

# The whole preparation as the upgrader and the deploy script run it: identity first, the build in its own process
# group, the result checked by ID; and releasing the reserved tag afterwards.
prepare_cases() {
    local tag
    printf '%s' "$DAEMON" > "$DSTATE/daemon"
    printf amd64 > "$DSTATE/arch"
    printf '%s' "$IMAGE_B" > "$DSTATE/next-id"
    mkdir -p "$fixture/project"
    check prepare prepare_candidate_image "$fixture/context" "$SHA" commit "$fixture/project"
    result prepare-record "${CANDIDATE[source]}|${CANDIDATE[target_sha]}|${CANDIDATE[image_id]}|${CANDIDATE[daemon_id]}"
    tag="mixin-chatbot:candidate-$(candidate_project_id "$fixture/project")-${CANDIDATE[operation_id]}"
    result prepare-tag "$([ "${CANDIDATE[image_tag]}" = "$tag" ] && [[ "${CANDIDATE[operation_id]}" =~ ^[0-9a-f]{16}$ ]] && echo ours)"
    result prepare-tagged "$(cat "$(ref_file "$tag")")"
    check prepare-release release_candidate
    result prepare-release-left "$(exists "$(ref_file "$tag")")"
    # A standalone deployment from a directory that is not a git repository has no commit.
    printf '%s' "$IMAGE_C" > "$DSTATE/next-id"
    check workspace prepare_candidate_image "$fixture/context" '' workspace "$fixture/project"
    result workspace-record "${CANDIDATE[source]}|${CANDIDATE[target_sha]}|${CANDIDATE[image_id]}"
    check workspace-release release_candidate
    # A failed build leaves no tag and nothing to release.
    BUILD_FAIL=1 check failed prepare_candidate_image "$fixture/context" "$SHA" commit "$fixture/project"
    result failed-id "${CANDIDATE[image_id]}"
    check failed-release release_candidate
    # Interrupted after the build tagged the image but before its ID was read: the tag is claimed by the operation label.
    printf '%s' "$IMAGE_B" > "$DSTATE/next-id"
    prepare_candidate_image "$fixture/context" "$SHA" commit "$fixture/project" 2> /dev/null
    CANDIDATE[image_id]=''
    check claim release_candidate
    result claim-left "$(exists "$(ref_file "${CANDIDATE[image_tag]}")")"
    # A reserved tag whose image another operation built is not ours to remove.
    prepare_candidate_image "$fixture/context" "$SHA" commit "$fixture/project" 2> /dev/null
    CANDIDATE[image_id]='' CANDIDATE[operation_id]=ffffffffffffffff
    check claim-foreign release_candidate
    result claim-foreign-left "$(exists "$(ref_file "${CANDIDATE[image_tag]}")")"
    # Statuses pass through, and the caller's signal handlers are back afterwards.
    check interruptible run_interruptible true
    check interruptible-status run_interruptible sh -c 'exit 7'
    result interruptible-traps "$(trap -p INT TERM HUP)"
    trap 'exit 143' TERM
    check interruptible-kept run_interruptible true
    result interruptible-kept-traps "$(trap -p INT TERM HUP)"
    trap - TERM
    # A script started in the background ignores INT from the start (the upgrader under ops.sh): it stays ignored
    # afterwards instead of becoming the default action, which would end the script on Ctrl+C.
    result interruptible-ignored "$(bash -c ". '$here/../../scripts/lib/candidate-image.sh'; run_interruptible true; kill -INT \$\$; echo kept" & wait "$!")"
}

# ---- Process, lock and mount fixtures for the containerd lookup ----
# A process under $PROC_ROOT owned by $PROC_UID (default: this user): proc <pid> <comm> <argv...>
proc() {
    local pid="$1" comm="$2" uid="${PROC_UID:-$(id -u)}"
    shift 2
    mkdir -p "$PROC_ROOT/$pid"
    printf '%s\n' "$comm" > "$PROC_ROOT/$pid/comm"
    printf '%s\0' "$@" > "$PROC_ROOT/$pid/cmdline"
    printf 'Name:\t%s\nUid:\t%s\t%s\t%s\t%s\n' "$comm" "$uid" "$uid" "$uid" "$uid" > "$PROC_ROOT/$pid/status"
}
# A configuration in the shape `containerd config dump` prints: dump <file> <root> <address> [root_path] [snapshotter]
dump() {
    printf "version = 3\nroot = '%s'\nstate = '/run/containerd'\nimports = ['/etc/containerd/conf.d/*.toml']\n\n[grpc]\n  address = '%s'\n\n[plugins]\n  [plugins.'io.containerd.snapshotter.v1.%s']\n    root_path = '%s'\n" \
        "$2" "$3" "${5:-overlayfs}" "${4:-}" > "$1"
}
# The shape containerd 2.3 and later print (configuration version 4): the address is in the gRPC server plugin's
# section, and a top-level [grpc] table left in the file is printed last. dump4 <file> <root> <address> <leftover address>
dump4() {
    printf "version = 4\nroot = '%s'\nstate = '/run/containerd'\nimports = ['/etc/containerd/conf.d/*.toml']\n\n[plugins]\n  [plugins.'io.containerd.server.v1.grpc']\n    address = '%s'\n\n  [plugins.'io.containerd.snapshotter.v1.overlayfs']\n    root_path = ''\n\n[grpc]\n  address = '%s'\n" \
        "$2" "$3" "$4" > "$1"
}
# A stand-in containerd program: records that it ran, then prints the file given with --config (default.toml without).
fake_containerd() {
    mkdir -p "${1%/*}"
    printf '#!/bin/sh\nprintf "%%s\\n" "$0" >> "%s/executions"\nconfig="%s/default.toml"\n[ "$1" = --config ] && config="$2"\n[ -f "$config" ] || { echo "open $config: permission denied" >&2; exit 1; }\ncat "$config"\n' \
        "$fixture" "$fixture" > "$1"
    chmod 755 "$1"
}
# The lock table: locks <pid> <hex major:minor> <inode or file> ...
locks() {
    local pid inode number=1
    : > "$PROC_ROOT/locks"
    while [ "$#" -ge 3 ]; do
        pid="$1"
        inode="$3"
        [[ "$inode" =~ ^[0-9]+$ ]] || inode="$(stat -c %i -- "$inode")"
        printf '%s: FLOCK  ADVISORY  WRITE %s %s:%s 0 EOF\n' "$number" "$pid" "$2" "$inode" >> "$PROC_ROOT/locks"
        number=$((number + 1))
        shift 3
    done
}

storage_cases() {
    local fx droot="$fixture/disk1/docker" system="$fixture/disk2/containerd" override="$fixture/disk3/override"
    local snapshots="$fixture/disk3/snapshots" bin="$fixture/bin/containerd" sock=/run/containerd/containerd.sock
    local meta=io.containerd.metadata.v1.bolt/meta.db content=io.containerd.content.v1.content linux=''
    [ "$(command uname -s)" = Linux ] && linux=1
    fx="$(realpath -m -- "$fixture")"
    uname() { if [ "$1" = -n ]; then echo testhost; else command uname "$@"; fi; }
    paths() { result "$1-paths" "${DOCKER_STORAGE_PATHS[*]}"; }
    # disk1..3 under the fixture are three disks; /run is a tmpfs. Extra lines are mounts inside them.
    mounts() {
        printf '%s\n' "22 1 8:1 / $fx/disk1 rw - ext4 /dev/sda1 rw" "23 1 8:2 / $fx/disk2 rw - ext4 /dev/sdb1 rw" \
            "24 1 8:3 / $fx/disk3 rw - xfs /dev/sdc1 rw" '25 1 0:61 / /run rw - tmpfs tmpfs rw' "$@" > "$MOUNTINFO_FILE"
    }
    # df names the mount a path is on: the longest mount point containing it.
    df() {
        local path="${*: -1}" target='' point
        while read -r _ _ _ _ point _; do
            if [ "$path" = "$point" ] || [[ "$path" == "$point/"* ]]; then [ "${#point}" -le "${#target}" ] || target="$point"; fi
        done < "$MOUNTINFO_FILE"
        [ -n "$target" ] && [[ "$*" == *--output=target* ]] || return 1
        printf 'Mounted on\n%s\n' "$target"
    }
    PROC_ROOT="$fixture/proc"
    MOUNTINFO_FILE="$fixture/mountinfo"
    mounts
    mkdir -p "$droot" "$system/${meta%/*}" "$system/$content" "$override/${meta%/*}" "$snapshots" "$fixture/disk3/content"
    : > "$system/$meta"
    : > "$override/$meta"
    : > "$snapshots/metadata.db"
    fake_containerd "$bin"

    # Unless a case says otherwise the daemon is rootless and its files and processes belong to this user.
    printf 'tcp://10.0.0.2:2376' > "$DSTATE/endpoint"
    printf 'testhost|%s|overlay2|[]|%s\n' "$droot" "$ROOTLESS" > "$DSTATE/info"
    check storage-tcp docker_storage_paths
    printf 'unix:///var/run/docker.sock' > "$DSTATE/endpoint"
    DOCKER_HOST=ssh://ops@example.invalid check storage-ssh docker_storage_paths
    printf 'otherhost|%s|overlay2|[]|%s\n' "$droot" "$ROOTLESS" > "$DSTATE/info"
    check storage-other-host docker_storage_paths
    printf 'testhost|%s|overlay2|[[Backing Filesystem extfs] [Supports d_type true]]|%s\n' "$droot" "$ROOTLESS" > "$DSTATE/info"
    check storage-classic docker_storage_paths
    paths storage-classic
    # A rootful daemon's data directory is root's: another user (in the docker group) cannot see what is linked from
    # inside it, so only root looks.
    printf 'testhost|%s|overlay2|[[Backing Filesystem extfs] [Supports d_type true]]|%s\n' "$droot" "$ROOTFUL" > "$DSTATE/info"
    EFFECTIVE_UID=1000 check storage-rootful-user docker_storage_paths
    EFFECTIVE_UID=0 check storage-rootful-root docker_storage_paths
    paths storage-rootful-root
    printf 'testhost|%s|overlayfs|[[driver-type io.containerd.snapshotter.v1]]|%s\n' "$droot" "$ROOTFUL" > "$DSTATE/info"
    EFFECTIVE_UID=1000 check storage-rootful-containerd docker_storage_paths
    printf 'testhost|%s|overlay2|[[Backing Filesystem extfs] [Supports d_type true]]|%s\n' "$droot" "$ROOTLESS" > "$DSTATE/info"
    # A directory moved out of the Docker root by a symbolic link is measured where it is; volumes, links inside the
    # root and links to nowhere add nothing (Linux: Git Bash copies instead of linking). A Docker root this user
    # cannot enter hides its links.
    if [ -n "$linux" ]; then
        mkdir -p "$fixture/disk3/overlay2" "$fixture/disk3/volumes" "$droot/image"
        ln -s "$fixture/disk3/overlay2" "$droot/overlay2"
        ln -s "$fixture/disk3/volumes" "$droot/volumes"
        ln -s "$droot/image" "$droot/inside"
        ln -s "$fixture/nowhere" "$droot/dangling"
        check storage-docker-relocated docker_storage_paths
        paths storage-docker-relocated
        rm -f "$droot/overlay2" "$droot/volumes" "$droot/inside" "$droot/dangling"
    else
        result storage-docker-relocated skipped
    fi
    # Finding those links needs both entering and listing the Docker root: no access (000), searchable but not
    # listable (0300: entries can still be written by name, yet the links cannot be found), listable but not
    # searchable (0600).
    if [ -n "$linux" ] && [ "$(id -u)" != 0 ]; then
        ln -s "$fixture/disk3/overlay2" "$droot/buildkit-moved"
        for mode in 000 300 600; do
            chmod "$mode" "$droot"
            check "storage-docker-mode-$mode" docker_storage_paths
            chmod 755 "$droot"
        done
        rm -f "$droot/buildkit-moved"
    else
        for mode in 000 300 600; do result "storage-docker-mode-$mode" skipped; done
    fi
    # Listing the Docker root can still fail after the permission check (removed, I/O error): that is refused too.
    find() { command find "$@"; return 1; }
    check storage-docker-unlisted docker_storage_paths
    unset -f find

    printf 'testhost|%s|overlayfs|[[driver-type io.containerd.snapshotter.v1]]|%s\n' "$droot" "$ROOTLESS" > "$DSTATE/info"
    : > "$DSTATE/address"
    check storage-no-address docker_storage_paths
    printf '%s' "$sock" > "$DSTATE/address"
    printf 'testhost|%s|devmapper|[[driver-type io.containerd.snapshotter.v1]]|%s\n' "$droot" "$ROOTLESS" > "$DSTATE/info"
    check storage-devmapper docker_storage_paths
    printf 'testhost|%s|overlayfs|[[driver-type io.containerd.snapshotter.v1]]|%s\n' "$droot" "$ROOTLESS" > "$DSTATE/info"

    # The system containerd (default configuration) serves Docker; a rootless one and a shim are other processes. A
    # directory under <DockerRootDir>/containerd/daemon is not evidence that Docker uses it: the rootless one holds the
    # lock on its own database there, and only its address sets it apart.
    mkdir -p "$droot/containerd/daemon/${meta%/*}"
    : > "$droot/containerd/daemon/$meta"
    dump "$fixture/default.toml" "$system" "$sock"
    dump "$fixture/rootless.toml" "$droot/containerd/daemon" /run/user/1000/docker/containerd/containerd.sock
    proc 100 containerd "$bin"
    proc 200 containerd "$bin" --config "$fixture/rootless.toml"
    proc 300 containerd-shim "$bin" -namespace moby
    locks 100 08:02 "$system/$meta" 100 00:3d 12 200 08:01 "$droot/containerd/daemon/$meta"
    check storage-system docker_storage_paths
    paths storage-system
    # Locks confirm the process: another file on the same disk, a database that cannot be read (a lock on its disk is
    # not enough), a disk outside the locations found and a filesystem not mounted here are all refused; the tmpfs
    # state lock above was accepted.
    locks 100 08:02 "$fixture/default.toml"
    check storage-other-inode docker_storage_paths
    mv "$system/$meta" "$fixture/meta.saved"
    locks 100 08:02 77
    check storage-no-database docker_storage_paths
    mv "$fixture/meta.saved" "$system/$meta"
    locks 100 08:02 "$system/$meta" 100 08:03 9
    check storage-extra-disk docker_storage_paths
    locks 100 08:02 "$system/$meta" 100 00:63 9
    check storage-unknown-device docker_storage_paths
    # Another process claims the same address from its own configuration but holds no locks (a containerd in a
    # container, or a `containerd config dump` in progress): it is not the one serving Docker.
    proc 400 containerd "$bin"
    locks 100 08:02 "$system/$meta"
    check storage-claimant docker_storage_paths
    paths storage-claimant
    rm -rf "${PROC_ROOT:?}/400"
    # The dump's configuration version decides which address containerd serves: from version 4 the gRPC server plugin's
    # (a leftover top-level [grpc] table is ignored), before it the top-level [grpc] (a plugin section is ignored).
    dump4 "$fixture/default.toml" "$system" "$sock" /run/other.sock
    check storage-version4 docker_storage_paths
    paths storage-version4
    dump4 "$fixture/default.toml" "$system" /run/other.sock "$sock"
    check storage-version4-leftover docker_storage_paths
    dump "$fixture/default.toml" "$system" /run/other.sock
    printf "  [plugins.'io.containerd.server.v1.grpc']\n    address = '%s'\n" "$sock" >> "$fixture/default.toml"
    check storage-version3-plugin docker_storage_paths
    dump "$fixture/default.toml" "$system" "$sock"

    # Locations come from the mount table, not from locks: a disk mounted on the content store holds no lock and still
    # counts, as does one inside the Docker root; container runtime mounts and Docker volumes do not.
    mkdir -p "$droot/buildkit" "$droot/containers/c1/mounts/shm" "$droot/volumes/v1/_data" "$system/tmpmounts/m1"
    mounts "26 23 8:5 / $fx/disk2/containerd/$content rw - xfs /dev/sde1 rw" \
        "27 23 0:90 / $fx/disk2/containerd/tmpmounts/m1 rw - overlay overlay rw,lowerdir=/x" \
        "28 22 0:91 / $fx/disk1/docker/containers/c1/mounts/shm rw - tmpfs shm rw" \
        "29 22 0:92 / $fx/disk1/docker/volumes/v1/_data rw - nfs host:/v rw" \
        "30 22 8:6 / $fx/disk1/docker/buildkit rw - ext4 /dev/sdf1 rw"
    check storage-nested docker_storage_paths
    paths storage-nested
    mounts
    # A content store moved elsewhere by a symbolic link is followed where this user can see it (Linux: Git Bash copies
    # instead of linking).
    if [ -n "$linux" ]; then
        rm -rf "${system:?}/$content"
        ln -s "$fixture/disk3/content" "$system/$content"
        check storage-relocated docker_storage_paths
        paths storage-relocated
        rm -f "$system/$content"
        mkdir -p "$system/$content"
    else
        result storage-relocated skipped
    fi
    # A mount inside a directory this user cannot enter cannot be measured.
    if [ -n "$linux" ] && [ "$(id -u)" != 0 ]; then
        mkdir -p "$system/private/blobs"
        chmod 000 "$system/private"
        mounts "31 23 8:8 / $fx/disk2/containerd/private/blobs rw - ext4 /dev/sdg1 rw"
        check storage-nested-hidden docker_storage_paths
        chmod 755 "$system/private"
        mounts
    else
        result storage-nested-hidden skipped
    fi

    # Startup flags override the configuration file.
    dump "$fixture/main.toml" "$system" /run/other.sock
    proc 100 containerd "$bin" -c "$fixture/main.toml" --root "$override" --address="$sock"
    locks 100 08:03 "$override/$meta"
    check storage-flags docker_storage_paths
    paths storage-flags
    # A snapshot directory set by root_path is measured too, and must be in use as well.
    dump "$fixture/default.toml" "$system" "$sock" "$snapshots"
    proc 100 containerd "$bin"
    locks 100 08:02 "$system/$meta" 100 08:03 "$snapshots/metadata.db"
    check storage-snapshots docker_storage_paths
    paths storage-snapshots
    locks 100 08:02 "$system/$meta"
    check storage-snapshots-unused docker_storage_paths
    dump "$fixture/default.toml" "$system" "$sock"
    dump "$fixture/native.toml" "$system" "$sock" '' native
    proc 100 containerd "$bin" --config "$fixture/native.toml"
    check storage-no-snapshotter docker_storage_paths

    # Programs of other users' processes, and programs other users could replace, are never run, not even to be
    # refused later. The one serving Docker is still found.
    proc 100 containerd "$bin"
    fake_containerd "$fixture/foreign/containerd"
    PROC_UID=4242 proc 500 containerd "$fixture/foreign/containerd"
    check storage-foreign docker_storage_paths
    paths storage-foreign
    if [ -n "$linux" ]; then
        fake_containerd "$fixture/open/containerd"
        chmod 777 "$fixture/open"
        fake_containerd "$fixture/group-writable/containerd"
        chmod 775 "$fixture/group-writable/containerd"
        fake_containerd "$fixture/sticky/containerd"
        chmod 1777 "$fixture/sticky"
        proc 501 containerd "$fixture/open/containerd"
        proc 502 containerd "$fixture/group-writable/containerd"
        proc 503 containerd "$fixture/sticky/containerd" --address /run/sticky.sock
        check storage-writable docker_storage_paths
        chmod 755 "$fixture/open" "$fixture/sticky"
        rm -rf "${PROC_ROOT:?}"/50[123]
    else
        result storage-writable skipped
    fi
    rm -rf "${PROC_ROOT:?}"/[0-9]*
    PROC_UID=4242 proc 500 containerd "$fixture/foreign/containerd"
    check storage-only-foreign docker_storage_paths
    result executions "$(LC_ALL=C sort -u "$fixture/executions" | tr '\n' ' ')"

    # Configurations that cannot be read, and executables that cannot be found, leave nothing to choose from.
    proc 100 containerd "$bin" --config "$fixture/unreadable.toml"
    check storage-unreadable docker_storage_paths
    proc 100 containerd containerd
    check storage-no-executable docker_storage_paths
    rm -rf "${PROC_ROOT:?}"/[0-9]*
    check storage-no-process docker_storage_paths
    rm -rf "$droot"
    check storage-root-missing docker_storage_paths
}

# The real `containerd config dump` merges imports; the storage found must follow it rather than the main file or a
# leftover directory. Needs a containerd binary (Linux; skipped elsewhere).
containerd_cases() {
    local binary
    if [ "$(command uname -s)" != Linux ] || ! binary="$(command -v containerd)"; then result containerd-real skipped; return; fi
    local droot="$fixture/docker-root" actual="$fixture/actual-root" meta=io.containerd.metadata.v1.bolt/meta.db major minor
    uname() { if [ "$1" = -n ]; then echo testhost; else command uname "$@"; fi; }
    PROC_ROOT="$fixture/proc"
    mkdir -p "$droot/containerd/daemon" "$fixture/default-root" "$actual/${meta%/*}"
    : > "$actual/$meta"
    printf 'version = 2\nroot = "%s/default-root"\nimports = ["%s/conf.d/*.toml"]\n' "$fixture" "$fixture" > "$fixture/config.toml"
    mkdir -p "$fixture/conf.d"
    printf 'version = 2\nroot = "%s"\n[grpc]\n  address = "%s/containerd.sock"\n' "$actual" "$fixture" > "$fixture/conf.d/storage.toml"
    proc 100 containerd "$binary" --config "$fixture/config.toml"
    mount_facts "$actual"
    IFS=: read -r major minor <<< "$MOUNT_DEVICE"
    locks 100 "$(printf '%02x:%02x' "$major" "$minor")" "$actual/$meta"
    printf 'unix:///var/run/docker.sock' > "$DSTATE/endpoint"
    printf 'testhost|%s|overlayfs|[[driver-type io.containerd.snapshotter.v1]]|%s\n' "$droot" "$ROOTLESS" > "$DSTATE/info"
    printf '%s/containerd.sock' "$fixture" > "$DSTATE/address"
    check containerd-real docker_storage_paths
    result containerd-real-paths "${DOCKER_STORAGE_PATHS[*]}"
}

disk_cases() {
    # df maps each path to a mount point and reports the free space written for that mount point. The mount table has
    # two ext4 disks, two subvolumes of one btrfs filesystem, two datasets of one ZFS pool and a tmpfs stacked on a
    # mount point whose name has a space.
    set_free() { printf '%s' "$2" > "$DSTATE/free-$(printf '%s' "$1" | tr '/ ' '_-')"; }
    df() {
        local path="${*: -1}" target
        case "$path" in
            /fs-a*) target=/mnt/1 ;;
            /fs-b*) target=/mnt/2 ;;
            /pool/docker*) target=/var/lib/docker ;;
            /pool/home*) target=/home ;;
            /tank/docker*) target=/tank/docker ;;
            /tank/data*) target=/tank/data ;;
            /tank/containerd*) target=/tank/containerd ;;
            '/srv/with space'*) target='/srv/with space' ;;
            *) return 1 ;;
        esac
        case "$*" in
            *--output=target*) printf 'Mounted on\n%s\n' "$target" ;;
            *--output=avail*) printf 'Avail\n%s\n' "$(cat "$DSTATE/free-$(printf '%s' "$target" | tr '/ ' '_-')")" ;;
            *) return 1 ;;
        esac
    }
    MOUNTINFO_FILE="$fixture/mountinfo"
    printf '%s\n' '22 1 8:1 / /mnt/1 rw - ext4 /dev/sda1 rw' '23 1 8:2 / /mnt/2 rw - ext4 /dev/sdb1 rw' \
        '30 1 0:31 /@docker /var/lib/docker rw - btrfs /dev/nvme0n1p2 rw,subvolid=257,subvol=/@docker' \
        '31 1 0:31 /@home /home rw - btrfs /dev/nvme0n1p2 rw,subvolid=256,subvol=/@home' \
        '40 1 0:45 / /tank/docker rw - zfs tank/docker rw,xattr' '41 1 0:46 / /tank/data rw - zfs tank/data rw,xattr' \
        '42 1 0:47 / /tank/containerd rw - zfs tank/containerd rw,xattr' \
        '50 1 8:4 / /srv/with\040space rw - ext4 /dev/sdd1 rw' '51 50 0:52 / /srv/with\040space rw - tmpfs tmpfs rw' > "$MOUNTINFO_FILE"
    local path
    for path in /pool/docker/x /pool/home/x /tank/docker/x /tank/data/x '/srv/with space/x' /elsewhere; do
        mount_facts "$path"
        result "facts-$path" "$MOUNT_TARGET|$MOUNT_DEVICE|$MOUNT_TYPE|$MOUNT_POOL"
    done
    set_free /mnt/1 3000000000
    set_free /mnt/2 3000000000
    check disk-separate check_free_space /fs-a/docker 2000000000 /fs-b/data 1000000000
    check disk-short check_free_space /fs-a/docker 3500000000 /fs-b/data 1000000000
    check disk-summed check_free_space /fs-a/x 1600000000 /fs-a/y 1600000000
    check disk-unknown check_free_space /elsewhere 1
    # The build estimate: the Docker root and containerd root share /fs-a and count once; a data path there adds the reserve.
    docker_storage_paths() { DOCKER_STORAGE_PATHS=(/fs-a/docker /fs-a/containerd); }
    printf 'linux|amd64||||\n' > "$DSTATE/images/${IMAGE_B#sha256:}"
    printf '%s' "$IMAGE_B" > "$(ref_file mixin-chatbot)"
    printf '%s 322MB\n%s 9GB\n' "$IMAGE_B" "$IMAGE_C" > "$DSTATE/sizes"
    set_free /mnt/1 5147483648
    check build-exact check_build_disk_space mixin-chatbot /fs-a/data
    set_free /mnt/1 5147483647
    check build-short check_build_disk_space mixin-chatbot /fs-a/data
    printf '%s 2.5GB\n' "$IMAGE_B" > "$DSTATE/sizes"
    set_free /mnt/1 4823741824
    check build-large check_build_disk_space mixin-chatbot
    set_free /mnt/1 4823741823
    check build-large-short check_build_disk_space mixin-chatbot
    set_free /mnt/1 4073741824
    check build-no-previous check_build_disk_space ''
    # Docker on one btrfs subvolume and the data on another: both report the pool's 4.5 GB, which has to hold the build
    # estimate (4,073,741,824) and the data reserve (1,073,741,824) together.
    docker_storage_paths() { DOCKER_STORAGE_PATHS=(/pool/docker/root); }
    set_free /var/lib/docker 4500000000
    set_free /home 4500000000
    check btrfs-shared check_build_disk_space '' /pool/home/data
    set_free /var/lib/docker 5147483648
    set_free /home 5147483648
    check btrfs-enough check_build_disk_space '' /pool/home/data
    # Two datasets of one ZFS pool: needs add up against the smaller free space reported.
    set_free /tank/docker 6000000000
    set_free /tank/data 3000000000
    check zfs-pool check_free_space /tank/docker/x 2000000000 /tank/data/x 1500000000
    # Through the build check: Docker and containerd on datasets of one pool, containerd's under a 1 GB quota. The
    # estimate is needed once, but each dataset's own free space counts.
    docker_storage_paths() { DOCKER_STORAGE_PATHS=(/tank/docker/root /tank/containerd/root); }
    set_free /tank/docker 10000000000
    set_free /tank/containerd 1000000000
    check zfs-quota check_build_disk_space ''
    set_free /tank/containerd 4073741824
    check zfs-quota-enough check_build_disk_space ''
    docker_storage_paths() { echo 'storage unknown' >&2; return 1; }
    check build-unknown-storage check_build_disk_space mixin-chatbot /fs-b/data
    local size
    for size in 322MB 1.23GB 976.6kB 0B 12XB ''; do result "bytes-$size" "$(human_to_bytes "$size" 2>/dev/null || echo fail)"; done
}

# The recheck before stopping: the snapshot written after the stop needs its own size in backup/, and every data path
# keeps the reserve. The files are real; check_free_space only records what it is asked.
snapshot_cases() {
    . "$here/../../scripts/lib/deployment.sh"
    PROJECT_DIR="$fixture/project"
    local groups="$fixture/groups" size
    mkdir -p "$PROJECT_DIR/data/config" "$PROJECT_DIR/data/state" "$PROJECT_DIR/data/runtime/pi" "$groups/g1"
    sized() { head -c "$2" /dev/zero > "$1"; }
    # Counted: configuration, markers, the state databases and the group statistics.
    sized "$PROJECT_DIR/data/config/models.json" 100000
    sized "$PROJECT_DIR/data/runtime/pi/settings.json" 20000
    sized "$PROJECT_DIR/data/state/data-version.json" 3000
    sized "$PROJECT_DIR/data/state/bot.sqlite" 400000
    sized "$PROJECT_DIR/data/state/bot.sqlite-wal" 50000
    sized "$groups/stats.sqlite" 600000
    sized "$groups/data-version.json" 7000
    # Not in the snapshot: group workspaces and other state.
    sized "$groups/g1/big" 5000000
    sized "$PROJECT_DIR/data/state/other.log" 5000000
    size="$(snapshot_size_estimate "$groups")"
    result estimate-at-least "$([ "$size" -ge 1180000 ] && echo yes || echo "no:$size")"
    result estimate-at-most "$([ "$size" -lt 1400000 ] && echo yes || echo "no:$size")"
    result estimate-empty "$(PROJECT_DIR="$fixture/none"; snapshot_size_estimate "$fixture/empty-groups")"
    check_free_space() { printf '%s\n' "$*" | sed "s#$fixture#<f>#g" > "$fixture/free-args"; }
    snapshot_size_estimate() { echo 5000; }
    check stop-no-backup check_stop_disk_space "$groups" "$fixture/upgrader"
    result stop-no-backup-args "$(cat "$fixture/free-args")"
    mkdir -p "$PROJECT_DIR/backup"
    check stop check_stop_disk_space "$groups"
    result stop-args "$(cat "$fixture/free-args")"
    snapshot_size_estimate() { echo 'du: cannot access' >&2; return 1; }
    rm -f -- "$fixture/free-args"
    check stop-unknown check_stop_disk_space "$groups"
    result stop-unknown-checked "$([ -e "$fixture/free-args" ] && echo yes || echo no)"
}

"${group}_cases"
