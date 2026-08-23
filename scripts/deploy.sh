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
# A rethink too old to know the route cannot release anything; say so and carry on rather
# than refusing to deploy the very version that adds it.
if ! curl -fsS -X POST "http://$MGMT/api/router/dnat/release"; then
    echo "  (the running rethink has no release route — deploying without it)"
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
# The management interface has no login, so it stays on loopback unless this says otherwise.
# `RETHINK_MGMT_HOST=0.0.0.0 scripts/deploy.sh` opens it to the LAN for as long as the
# container lives, without touching the configuration file in the data directory.
MGMT_HOST_ARG=()
if [ -n "${RETHINK_MGMT_HOST:-}" ]; then
    MGMT_HOST_ARG=(-e "RETHINK_MGMT_HOST=$RETHINK_MGMT_HOST")
fi

docker run -d --name rethink --network host --restart unless-stopped \
    --log-opt max-size=50m --log-opt max-file=5 \
    "${MGMT_HOST_ARG[@]}" \
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

curl -fsS "http://$MGMT/api/router/status" | python3 -c "
import json, sys
for d in sorted(json.load(sys.stdin)['devices'], key=lambda x: x['name']):
    print('  %-12s dnat=%-5s connected=%s' % (d['name'], d['dnat'], d['connected']))
"
