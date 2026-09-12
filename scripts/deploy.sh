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

IMAGE_TAG=${1:-deploy-$(date +%Y%m%d-%H%M%S)}
MGMT=${RETHINK_MGMT:-127.0.0.1:44401}
DATA=${RETHINK_DATA:-$HOME/docker/rethink-data}
OPERATOR_UID=$(id -u)
OPERATOR_GID=$(id -g)
DNAT_ALREADY_RELEASED=${RETHINK_DNAT_ALREADY_RELEASED:-0}
cd "$(dirname "$0")/.."

say() { printf '\n== %s\n' "$*"; }

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

say "releasing the DNAT rules ($MGMT)"
if [ "$DNAT_ALREADY_RELEASED" -eq 1 ]; then
    if ! container_running=$(docker inspect --format '{{.State.Running}}' rethink 2>/dev/null); then
        echo "refusing deployment: the existing container could not be checked safely" >&2
        exit 1
    fi
    if [ "$container_running" != false ]; then
        echo "refusing deployment: the existing container is still running" >&2
        exit 1
    fi
else
    if ! curl -fsS --connect-timeout 2 --max-time 5 -X POST "http://$MGMT/api/router/dnat/release"; then
        echo "refusing deployment: DNAT release failed" >&2
        exit 1
    fi
fi
echo

say "building $IMAGE_TAG"
docker build -q -t "rethink-lg-bridge:$IMAGE_TAG" . > /dev/null

say "swapping the container"
docker stop rethink > /dev/null
docker rm rethink > /dev/null
# Docker's json-file driver does no rotation unless it is told to, and this container
# writes about seventy megabytes a day, so an unbounded log is a slow disk leak. Five files
# of fifty megabytes caps it at 250 MB, which is several days of history: long enough for
# scripts/check-home-assistant.mts to tell an appliance that never finished starting up
# from one that is merely quiet, and for a fault to still be readable the next morning.
docker run -d --name rethink --network host --restart unless-stopped \
    --log-opt max-size=50m --log-opt max-file=5 \
    --user "$OPERATOR_UID:$OPERATOR_GID" \
    -v "$DATA:/app/data" "rethink-lg-bridge:$IMAGE_TAG" \
    sh -c '[ -f /app/data/config.json ] || cp /app/config.json /app/data/config.json; exec node dist/rethink-cloud.js /app/data/config.json' \
    > /dev/null

say "waiting for the management interface"
management_ready=0
for ((attempt = 0; attempt < 30; attempt++)); do
    if curl -fsS --connect-timeout 2 --max-time 5 -o /dev/null "http://$MGMT/api/router/status"; then
        management_ready=1
        break
    fi
    sleep 2
done
if [ "$management_ready" -ne 1 ]; then
    echo "deployment failed: management interface timed out" >&2
    exit 1
fi

# The reconciler's first pass is thirty seconds in; wait for it rather than racing it.
# Capture only successful HTTP responses before parsing: a failed request may still emit JSON.
say "waiting for the DNAT rules to come back"
for ((attempt = 0; attempt < 30; attempt++)); do
    if status=$(curl -fsS --connect-timeout 2 --max-time 5 --max-filesize 1048576 "http://$MGMT/api/router/status") &&
        python3 scripts/deploy-status.py <<< "$status"; then
        exit 0
    fi
    sleep 5
done

echo "deployment failed: desired DNAT forwarding did not become ready" >&2
exit 1
