#!/bin/sh

set -eu

volume_name="vscode"
workspace_dir=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
confirm=false

usage() {
    printf '%s\n' "Usage: $0 [--yes] [--volume NAME]"
    printf '%s\n' ""
    printf '%s\n' "Removes this workspace's devcontainer and the shared VS Code server cache."
    printf '%s\n' "Without --yes, it only reports what would be removed."
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --yes)
            confirm=true
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
    printf '%s\n' "Dry run only. Re-run with --yes to remove this workspace's container(s) and the cache volume."
    exit 0
fi

if [ -n "$container_ids" ]; then
    docker rm -f $container_ids
fi

if [ "$volume_exists" = true ]; then
    docker volume rm "$volume_name"
else
    printf '%s\n' "Volume does not exist; nothing to remove."
fi

printf '%s\n' "Recovery cleanup complete. Reconnect over SSH, then run Reopen in Container."