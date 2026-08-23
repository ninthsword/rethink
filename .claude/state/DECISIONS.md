# Durable Decisions

Record only decisions that future development genuinely needs to know.

| Date | Decision | Reason | Impact / constraint | Reversible? |
|---|---|---|---|---|
| 2026-08-19 | Point `/route` at LG's factory addresses instead of rethink's own hostname | `rethink.lan` resolves nowhere for an appliance reached by DNAT, and one handed an address that does not exist stops dialling until it is power-cycled | `route_servers` must stay set in any DNAT deployment | Yes |
| 2026-08-22 | Quiet an unservable host with `stall_hostnames`, not `passthrough_hostnames` | Passing kic-mclip through gave the appliances a working route to LG, and four of them began reporting there instead of over MQTT — the cloud stayed current while Home Assistant went stale | Passing a host through hides its traffic from rethink; check every appliance still reaches "received initial values" afterwards | Yes |
| 2026-08-22 | Entity ids are `<domain>.rethink_<appliance>_<component key>`, set by `object_id` | Home Assistant builds an entity id once and never rebuilds it, and the same appliances exist under two other integrations that hold the unprefixed ids even while disabled | Renaming an existing entity needs a registry rename plus a dashboard sweep; `docs/entity-id-rename-20260823.md` records the mapping | Costly |
| 2026-08-23 | Keep `smartthinq_sensors_custom` devices disabled | Enabling them gets the LG cloud account blocked for about 24 hours, which also takes out the ThinQ app and the bridge | Anything depending on those entities must be repointed at a live source, never fixed by re-enabling | No |
| 2026-08-23 | `docker restart/stop rethink` is blocked by a `PreToolUse` hook | The rule had lived only in prose and was broken twice in one session; the washer was stranded for 25 minutes | Use `scripts/deploy.sh`; the hook names the manual DNAT release if it is ever needed | Yes |
