# Project Profile

Status: VERIFIED
Last verified: 2026-08-23 (KST)

> Only what is hard to rediscover. The code is the source of truth for everything else.

## Purpose

Replaces LG's ThinQ cloud for eleven appliances in one home: the appliances are redirected to
this server by router DNAT, it speaks their protocols locally, publishes them to Home
Assistant over MQTT discovery, and optionally bridges upstream to the real LG cloud so the
ThinQ app keeps working.

A fork of `anszom/rethink` via `af950833/rethink` (`upstream` remote). Fork point `3e9e63b`.

## Stack

TypeScript on Node 20, ESM (`"type": "module"`), no framework. `tsx` runs sources directly;
`tsc` + `tsc-alias` build to `dist/`. Path alias `@/*` → repository root.

## Entry points

- `rethink-cloud.ts` — the server. Assembles the CA, five listeners, the Home Assistant
  connection, the device manager, the cloud bridge and the management app.
- `rethink-setup.ts` — one-off Wi-Fi provisioning tool. **Unverified by any test.**
- `scripts/deploy.sh` — the only supported way to restart the container.
- `scripts/check-home-assistant.mts` — the end-user-side health check.

## Commands (all verified 2026-08-23)

| | |
|---|---|
| Build | `npm run build` |
| Type check | `npm run typecheck` (`tsconfig.json`, includes tests) |
| Test | `npm test` — type checks first, then 532 tests in 5 batches, ~2 min |
| Focused test | `npx tsx --test tests/path/to/file.test.ts` |
| Format | `npx prettier . --write` |
| Deploy | `bash scripts/deploy.sh` |
| End-user check | `npx tsx scripts/check-home-assistant.mts` |

There is **no lint**: no ESLint config and no `lint` script. Prettier is formatting only, run
on staged files by a `pretty-quick` pre-commit hook. Sixteen files fail `prettier --check`;
eight are long-standing and are not worth a formatting-only commit.

`npm run build` compiles `tsconfig.build.json`, which **excludes `tests`**. Only
`npm run typecheck` covers the test files.

## Architecture boundaries

```
appliance ──DNAT──> cloud/          (protocol, model handlers, HA discovery)
                      ├── thinq2/   MQTT+TLS 8883, JSON over clip/* topics
                      ├── thinq1/   JSON over TLS 47878, HTTPS 46030
                      ├── devices/  ~40 model handlers, one file per model
                      ├── ha_bridge.ts   device lifecycle, offline grace
                      └── homeassistant.ts  MQTT discovery, retained-topic sweep
                    bridge/         upstream LG cloud relay
                    router/         router SSH, DNAT apply/release, reconciler
                    management/     web API on 44401
```

`cloud/devices/*` must not reach into `bridge/` or `router/`. Handlers talk to Home Assistant
only through the `Connection` passed to them.

## Environment

- Runs as a container named `rethink`, `--network host`, image `rethink-lg-bridge:*`.
- Data directory `~/docker/rethink-data` — `config.json`, CA key/cert, `state/` (device
  certificates), `router-dnat.json` (0600), per-appliance energy totals.
- Home Assistant, the MQTT broker, the router, and this server all sit on the operator's
  private LAN. This repository is public, so their addresses are not committed — read them
  from `CLAUDE.local.md`, which `.gitignore` excludes.

## Risks and gotchas

- **Never stop the container directly.** See CLAUDE.md rule 1. A `PreToolUse` hook blocks
  `docker restart|stop|rm|kill rethink`.
- **`~/docker/rethink-data/state/` holds device certificates that cannot be rebuilt without
  the appliance.** Turning a device's bridge off deletes them. Not a routine operation.
- **rethink's own signals are not evidence of health.** See CLAUDE.md rule 2.
- The management API on 44401 has **no authentication** and binds `0.0.0.0`. It can write
  router SSH credentials, run iptables as root on the router, and delete registrations.
  Known and unresolved; do not widen its exposure.
- `smartthinq_sensors_custom` in Home Assistant is **disabled on purpose** — enabling it gets
  the LG cloud account blocked for about 24 hours. Never propose reviving it.
- Appliance entity ids follow `<domain>.rethink_<appliance>_<component key>`; `object_id` in
  the discovery payload decides it. `docs/entity-id-rename-20260823.md` is the mapping.
- `passthrough_hostnames` hides what the appliance sends over that host from rethink and has
  caused four appliances to stop reporting over MQTT. Prefer `stall_hostnames`.
- Tests must not dial external hosts; the SNI router tests use loopback stubs.

## Unverified areas

ThinQ1 end-to-end, the cloud bridge's token refresh, `rethink-setup.ts`, `tools/*`, and
management API behaviour under concurrent requests.
