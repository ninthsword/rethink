#!/usr/bin/env bash
#
# Rebuild rethink and swap the container, without leaving the appliances pointed at a
# process that is going away.
#
# The firewall sends the appliances to rethink. Restarting it underneath them takes their
# endpoint away mid-connection, and while most dial straight back, the washers do not: they
# stop trying until their power is cycled. So the rules come off first — the appliances go
# back to talking to LG directly and stay connected to something — and the DNAT reconciler
# puts the rules back by itself once rethink is up, because releasing them leaves the record
# of what was wanted untouched.
#
# The bridges are deliberately not suspended. Suspending one deletes the appliance's
# registration, which cannot be rebuilt without the appliance; the bridges stop on their own
# when the process exits.
set -euo pipefail

MODE=default
IMAGE_ID=
case "${1:-}" in
    --build-only) [ "$#" -eq 2 ] || { echo "usage: deploy.sh --build-only TAG" >&2; exit 1; }; MODE=build; IMAGE_TAG=$2 ;;
    --create-only) [ "$#" -eq 3 ] || { echo "usage: deploy.sh --create-only TAG IMAGE_ID" >&2; exit 1; }; MODE=create; IMAGE_TAG=$2; IMAGE_ID=$3 ;;
    --replace-only) [ "$#" -eq 3 ] || { echo "usage: deploy.sh --replace-only TAG IMAGE_ID" >&2; exit 1; }; MODE=replace; IMAGE_TAG=$2; IMAGE_ID=$3 ;;
    *) [ "$#" -le 1 ] || { echo "usage: deploy.sh [TAG]" >&2; exit 1; }; IMAGE_TAG=${1:-deploy-$(date +%Y%m%d-%H%M%S)} ;;
esac
if [[ ! "$IMAGE_TAG" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
    echo "refusing deployment: invalid operation tag" >&2; exit 1
fi
if { [ "$MODE" = replace ] || [ "$MODE" = create ]; } && [[ ! "$IMAGE_ID" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    echo "refusing deployment: invalid immutable image ID" >&2; exit 1
fi
MGMT=${RETHINK_MGMT:-127.0.0.1:44401}
DATA=${RETHINK_DATA:-$HOME/docker/rethink-data}
OPERATOR_UID=$(id -u)
OPERATOR_GID=$(id -g)
DNAT_ALREADY_RELEASED=${RETHINK_DNAT_ALREADY_RELEASED:-0}
cd "$(dirname "$0")/.."

say() { printf '\n== %s\n' "$*" >&2; }

if [ "$OPERATOR_UID" -eq 0 ]; then
    echo "refusing deployment from root; run it as the data owner" >&2
    exit 1
fi
if [ "$DNAT_ALREADY_RELEASED" != 0 ] && [ "$DNAT_ALREADY_RELEASED" != 1 ]; then
    echo "refusing deployment: RETHINK_DNAT_ALREADY_RELEASED must be 0 or 1" >&2
    exit 1
fi

# The bind source must be an absolute, existing canonical path. This also rejects symlinked
# components without exposing the requested path in an error message.
if [[ "$DATA" != /* ]]; then
    echo "refusing deployment: RETHINK_DATA must be an absolute canonical directory" >&2
    exit 1
fi
if ! canonical_data=$(realpath -e -- "$DATA" 2>/dev/null); then
    echo "refusing deployment: RETHINK_DATA is absent or cannot be canonicalized" >&2
    exit 1
fi
if [ "$DATA" != "$canonical_data" ]; then
    echo "refusing deployment: RETHINK_DATA must not contain links or dot segments" >&2
    exit 1
fi
DATA=$canonical_data

# Do not release DNAT until the bind mount is a directory the invoking operator can own.
# Keep the first offending path private: it may contain credentials or appliance state.
if [ ! -d "$DATA" ] || [ -L "$DATA" ]; then
    echo "refusing deployment: the data directory is absent or unsafe" >&2
    exit 1
fi
if ! bad_data_entry=$(find "$DATA" \
    \( -type l -o ! \( -type f -o -type d \) -o \
    ! -uid "$OPERATOR_UID" -o ! -gid "$OPERATOR_GID" -o \
    \( -type d -a \( ! -readable -o ! -writable -o ! -executable \) \) -o \
    \( -type f -a \( ! -readable -o ! -writable \) \) \) \
    -print -quit 2>/dev/null); then
    echo "refusing deployment: the data directory could not be checked safely" >&2
    exit 1
fi
if [ -n "$bad_data_entry" ]; then
    echo "refusing deployment: the data directory has unsafe ownership, type, or permissions" >&2
    exit 1
fi

umask 077
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

require_stopped() {
    if ! container_running=$(docker inspect --format '{{.State.Running}}' rethink 2>/dev/null) || [ "$container_running" != false ]; then
        echo "refusing deployment: the existing container must be stopped" >&2
        exit 1
    fi
}

# A failed inspect is not proof of absence: require a successful exact-name listing.
# Docker's unique --name reservation also rejects a concurrent create at the final boundary.
require_absent() {
    if ! docker container ls --all --filter 'name=^/rethink$' --format '{{.Names}}' > "$scratch/container-names" 2>/dev/null || [ -s "$scratch/container-names" ]; then
        echo "refusing deployment: container absence was not proven" >&2
        exit 1
    fi
}
if [ "$MODE" = create ]; then require_absent; fi

# The legacy recovery flag still requires a stopped container before doing any build.
if [ "$MODE" = replace ] || { [ "$MODE" = default ] && [ "$DNAT_ALREADY_RELEASED" -eq 1 ]; }; then
    require_stopped
fi

if [ "$MODE" = default ] || [ "$MODE" = build ]; then
    say "building the operation image"
    docker build -q --iidfile "$scratch/image-id" -t "rethink-lg-bridge:$IMAGE_TAG" . > "$scratch/build-output"
    if [ ! -f "$scratch/image-id" ] || [ "$(wc -c < "$scratch/image-id")" -gt 72 ]; then
        echo "deployment failed: build did not record a bounded image ID" >&2; exit 1
    fi
    IMAGE_ID=$(cat "$scratch/image-id")
    if [[ ! "$IMAGE_ID" =~ ^sha256:[a-f0-9]{64}$ ]]; then
        echo "deployment failed: invalid built image ID" >&2; exit 1
    fi
fi
if ! tagged_id=$(docker image inspect --format '{{.Id}}' "rethink-lg-bridge:$IMAGE_TAG" 2>/dev/null) || [ "$tagged_id" != "$IMAGE_ID" ]; then
    echo "refusing deployment: operation tag does not match the exact image" >&2; exit 1
fi
if [ "$MODE" = build ]; then
    printf '{"schema":"rethink-built-image-v1","tag":"%s","image_id":"%s"}\n' "$IMAGE_TAG" "$IMAGE_ID"
    exit 0
fi

status_request() {
    curl -fsS --connect-timeout 2 --max-time 5 --max-filesize 1048576 \
        -o "$scratch/status" "http://$MGMT/api/router/status" 2> "$scratch/http-error"
}

observed_baseline=0
if [ "$MODE" = default ] && [ "$DNAT_ALREADY_RELEASED" -eq 0 ]; then
    if ! status_request || ! python3 scripts/deploy-status.py snapshot < "$scratch/status" > /dev/null; then
        echo "refusing deployment: baseline registration status unavailable" >&2; exit 1
    fi
    cp -- "$scratch/status" "$scratch/baseline"
    observed_baseline=1
    if python3 scripts/deploy-status.py has-desired < "$scratch/baseline" > /dev/null; then
        say "requesting DNAT release once"
        release_result=0
        curl -fsS --connect-timeout 2 --max-time 5 --max-filesize 1048576 \
            -o "$scratch/release" -X POST "http://$MGMT/api/router/dnat/release" 2> "$scratch/http-error" || release_result=$?
        printf 'DNAT release request exit status: %s; observing completion.\n' "$release_result" >&2
        release_ready=0
        for ((attempt = 0; attempt < 30; attempt++)); do
            if status_request && python3 scripts/deploy-status.py released "$scratch/baseline" < "$scratch/status" > /dev/null; then
                release_ready=1
                break
            fi
            sleep 5
        done
        if [ "$release_ready" -ne 1 ]; then
            echo "refusing deployment: DNAT release completion was not proven" >&2; exit 1
        fi
    fi
fi

say "swapping the container by immutable image ID"
if [ "$MODE" = create ]; then
    require_absent
else
    if [ "$MODE" != replace ]; then docker stop rethink > /dev/null; fi
    # Recheck at the removal boundary; replacement never stops a running container implicitly.
    require_stopped
    docker rm rethink > /dev/null
fi
# Docker's json-file driver does no rotation unless it is told to, and this container
# writes about seventy megabytes a day, so an unbounded log is a slow disk leak. Five files
# of fifty megabytes caps it at 250 MB, which is several days of history: long enough for
# scripts/check-home-assistant.mts to tell an appliance that never finished starting up
# from one that is merely quiet, and for a fault to still be readable the next morning.
docker run -d --name rethink --network host --restart unless-stopped \
    --log-opt max-size=50m --log-opt max-file=5 \
    --user "$OPERATOR_UID:$OPERATOR_GID" \
    -v "$DATA:/app/data" "$IMAGE_ID" \
    sh -c '[ -f /app/data/config.json ] || cp /app/config.json /app/data/config.json; exec node dist/rethink-cloud.js /app/data/config.json' \
    > /dev/null

say "waiting for registration and DNAT restoration"
for ((attempt = 0; attempt < 30; attempt++)); do
    if status_request; then
        status_args=()
        if [ "$observed_baseline" -eq 1 ]; then status_args=(restored "$scratch/baseline"); fi
        if python3 scripts/deploy-status.py "${status_args[@]}" < "$scratch/status" > /dev/null; then
            if actual_image=$(docker inspect --format '{{.Image}}' rethink 2>/dev/null) && [ "$actual_image" = "$IMAGE_ID" ]; then
                printf '{"schema":"rethink-deployed-image-v1","tag":"%s","image_id":"%s"}\n' "$IMAGE_TAG" "$IMAGE_ID"
                exit 0
            fi
            echo "deployment failed: container image identity mismatch" >&2; exit 1
        fi
    fi
    sleep 5
done

echo "deployment failed: desired DNAT and registration restoration timed out" >&2
exit 1
