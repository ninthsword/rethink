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
cd "$(dirname "$0")/.."

say() { printf '\n== %s\n' "$*"; }

say "releasing the DNAT rules ($MGMT)"
curl -fsS -X POST "http://$MGMT/api/router/dnat/release" | head -c 400
echo

say "building $IMAGE_TAG"
docker build -q -t "rethink-lg-bridge:$IMAGE_TAG" . > /dev/null

say "swapping the container"
docker stop rethink > /dev/null
docker rm rethink > /dev/null
docker run -d --name rethink --network host --restart unless-stopped \
    -v "$DATA:/app/data" "rethink-lg-bridge:$IMAGE_TAG" \
    sh -c '[ -f /app/data/config.json ] || cp /app/config.json /app/data/config.json; exec node dist/rethink-cloud.js /app/data/config.json' \
    > /dev/null

say "waiting for the management interface"
until curl -fsS -o /dev/null "http://$MGMT/api/router/status"; do sleep 2; done

# The reconciler's first pass is thirty seconds in; wait for it rather than racing it.
say "waiting for the DNAT rules to come back"
for _ in $(seq 1 30); do
    sleep 5
    if ! curl -fsS "http://$MGMT/api/router/status" \
        | grep -q '"dnat": *"off"'; then
        break
    fi
done

curl -fsS "http://$MGMT/api/router/status" | python3 -c '
import json, sys
for device in sorted(json.load(sys.stdin)["devices"], key=lambda d: d["name"]):
    print(f"  {device[\"name\"]:12} dnat={device[\"dnat\"]:5} connected={device[\"connected\"]}")
'
