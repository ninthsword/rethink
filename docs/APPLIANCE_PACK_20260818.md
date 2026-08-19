# Korean appliance packet notes (2026-08-18)

These handlers were derived from packets captured while each appliance remained
registered in the owner's ThinQ home. The ThinQ model snapshot was used only to
confirm field meanings; Home Assistant state comes from the local appliance packet.

## Implemented models

| Appliance           | modelId          | Local state exposed to Home Assistant                                                                                                                       |
| ------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Front-load washer   | `F21VDT_AKOR`    | power, current/previous state, completion, remaining/initial/reserved time, course fields, soil, spin, water temperature, rinse, dry level, tub-clean count |
| Dryer               | `RH16KR`         | power, state/full process table/completion, remaining/initial/reserved time, course/downloaded course, dry level, Eco Hybrid, anti-crease                   |
| Kimchi refrigerator | `2REK1G03VI1902` | top/middle/bottom room temperatures, door, display lock, one-touch filter, monitor status                                                                   |
| Mini washer         | `Pd0F_F`         | power, current/previous state, completion, remaining/initial/reserved time, error and door lock                                                             |
| Dishwasher          | `D121111`        | power, state/process/completion, remaining/initial/reserved time, course and downloaded course                                                              |

Every field above was checked against at least one packet from the exact installed
model. Unknown enum values are retained as `RAW_<number>` instead of being guessed.

## Deferred controls and fields

No writable entity is exposed for these five models yet. Starting a washer, dryer,
mini washer, or dishwasher can move machinery, heat, or use water, so a ThinQ schema
entry alone is not sufficient evidence for a safe local command.

Before enabling a control, capture the real ThinQ cloud command and the resulting
local packet, then restore the original state and add a regression test. In
particular, defer:

- remote start, pause, power-off, cycle selection and downloaded-cycle execution;
- washer/dryer option switches whose packet offsets have not been observed while
  changing;
- dishwasher door, option bitmaps, error and tub-clean count until each byte is
  isolated by a physical state change;
- kimchi-refrigerator writes: its model schema reports `supportControl=false`.

The ThinQ model diagnostic confirms that `D121111` has door, rinse-refill,
salt-refill, auto-door, rinse-level and softening-level properties. It does not
identify their byte offsets in the local AABB record. Do not expose those cloud
snapshot values as local entities until a labelled physical state-change capture
isolates each byte.

`WINF_056905_WW` is registered through the RAC TLV handler. Its diagnostic
capability table confirms cooling, drying and fan-only modes, so heat and auto are
not advertised for this model. The installed Korean RAC/WINF units were additionally
validated as follows on 2026-08-19:

- fan tag `0x1fa`: raw `3..7` = levels 1..5; RAC alone advertises raw `9` = natural wind;
- horizontal vane tag `0x322`: `0` off, `100` swing, `13/24/35` left/centre/right
  focus and `1..5` fixed positions. The installed RAC does not advertise centre
  focus, so raw `24` is offered only for WINF;
- vertical vane tag `0x321` on RAC: `0` off, `100` swing and `1..6` fixed positions;
- WINF sleep countdown tag `0x21a`: 0..12 hours is exposed as the same Home Assistant
  number entity used by the other AC handlers. A same-state write was acknowledged
  by the installed unit.

On the installed RAC, writing fan or vane settings while the unit is off implicitly
starts cooling even though the write frame does not contain the power tag. The handler
therefore rejects fan and vane commands while power is off; change the climate mode
first, then set fan or vane values. This guard applies to both RAC and WINF.

The WINF ThinQ model snapshot also confirms cloud fields for AI auto-dry fan strength,
scheduled drying (`powerDry`), child lock, deep/good-sleep adjustment and quiet mode
(`silentAWHP`). They are intentionally not writable yet: the local status frame has
`0x20e=255`, so the legacy RAC auto-dry tag is not the AI-dry control, and no local
TLV tag/write value has been isolated for the other fields. For each feature, capture
one transition on and off (and every AI-dry strength) while recording the complete
before/after TLV state. Good-sleep needs separate captures for on/off, automatic start
temperature and custom temperature adjustment. Only then add state-backed entities
and regression tests; do not infer these controls from cloud property names.

ThinQ1 `DHUM_056905_WW` now has a separate JSON-protocol handler based on its exact
model schema and captured monitor snapshot. `S5BB_DN4` remains unregistered because
no local protocol frames are available for safe decoding.

The bridge must remain in preserve-existing-device mode. During container
replacement, stop the bridge/container before replacing it and keep DNAT pointed at
the same host. If a device retains a stale TCP session, reapply its existing DNAT-on
rule to clear only that device's 443/8883 conntrack entries.
