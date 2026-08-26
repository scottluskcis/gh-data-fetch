#!/bin/sh

set -eu

volume_name="vscode"
workspace_dir=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
confirm=false
target_commit=""

usage() {
    printf '%s\n' "Usage: $0 [--yes] [--commit HASH] [--volume NAME]"
    printf '%s\n' ""
    printf '%s\n' "Cleans up stuck devcontainers and pre-stages the VS Code Server binary"
    printf '%s\n' "into the shared Docker volume to prevent double-hop SSH streaming hangs."
    printf '%s\n' "Without --yes, it runs in dry-run mode."
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --yes)
            confirm=true
            ;;
        --commit)
            shift
            [ "$#" -gt 0 ] || {
                printf '%s\n' "Missing value for --commit." >&2
                exit 2
            }
            target_commit=$1
            ;;
        --volume)
            shift
            [ "$#" -gt 0 ] || {
                printf '%s\n' "Missing value for --volume." >&2
                exit 2
            }
            volume_name=$1
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            printf '%s\n' "Unknown option: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
    shift
done

command -v docker >/dev/null 2>&1 || {
    printf '%s\n' "Docker is required." >&2
    exit 1
}

docker info >/dev/null 2>&1 || {
    printf '%s\n' "Docker daemon is not running or not reachable." >&2
    exit 1
}

container_ids=$(docker ps -aq --filter "label=devcontainer.local_folder=$workspace_dir")
if docker volume inspect "$volume_name" >/dev/null 2>&1; then
    volume_exists=true
else
    volume_exists=false
fi

printf '%s\n' "Workspace: $workspace_dir"
printf '%s\n' "Containers to remove: ${container_ids:-none}"
if [ "$volume_exists" = true ]; then
    printf '%s\n' "Volume to remove: $volume_name"
else
    printf '%s\n' "Volume to remove: none"
fi

if [ "$confirm" != true ]; then
    printf '%s\n' ""
    printf '%s\n' "Dry run only. Re-run with --yes to remove containers and pre-stage VS Code Server."
    exit 0
fi

if [ -n "$container_ids" ]; then
    printf '%s\n' "Removing existing workspace containers..."
    docker rm -f $container_ids
fi

if [ "$volume_exists" = true ]; then
    docker volume rm "$volume_name"
else
    printf '%s\n' "Volume does not exist; nothing to remove."
fi

printf '%s\n' "Pre-staging VS Code Server binaries into Docker volume..."

# 1. Pre-stage any VS Code Server installs found on the host SSH VM
if [ -d "$HOME/.vscode-server/cli/servers" ]; then
    for dir in "$HOME/.vscode-server/cli/servers"/Stable-*; do
        if [ -d "$dir/server" ]; then
            commit=$(basename "$dir" | sed "s/Stable-//")
            printf '%s\n' "Staging host server commit $commit..."
            docker run --rm \
                -v "$volume_name:/vscode" \
                -v "$dir/server:/host_server:ro" \
                alpine sh -c "mkdir -p /vscode/vscode-server/bin/linux-x64/$commit && cp -a /host_server/. /vscode/vscode-server/bin/linux-x64/$commit/"
        fi
    done
fi

# 2. If a specific commit was requested and is not yet in the volume, download it directly on the VM
if [ -n "$target_commit" ]; then
    already_staged=$(docker run --rm -v "$volume_name:/vscode" alpine sh -c "[ -d /vscode/vscode-server/bin/linux-x64/$target_commit ] && echo yes || true")
    if [ "$already_staged" != "yes" ]; then
        printf '%s\n' "Downloading VS Code Server for commit $target_commit directly on VM..."
        docker run --rm \
            -v "$volume_name:/vscode" \
            alpine sh -c "apk add --no-cache curl tar && mkdir -p /vscode/vscode-server/bin/linux-x64/$target_commit && curl -sSL https://update.code.visualstudio.com/commit:$target_commit/server-linux-x64/stable | tar -xz -C /vscode/vscode-server/bin/linux-x64/$target_commit"
    fi
fi

printf '%s\n' ""
printf '%s\n' "Recovery & pre-staging complete. You can now run Reopen in Container!"