# Korean appliance packet notes (2026-08-18)

These handlers were derived from packets captured while each appliance remained
registered in the owner's ThinQ home. The ThinQ model snapshot was used only to
confirm field meanings; Home Assistant state comes from the local appliance packet.

## Implemented models

| Appliance           | modelId          | Local state exposed to Home Assistant                                                                                                                       |
| ------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Front-load washer   | `F21VDT_AKOR`    | power, current/previous state, completion, remaining/initial/reserved time, course fields, soil, spin, water temperature, rinse, dry level, tub-clean count |
| Dryer               | `RH16KR`         | power, state/full process table/completion, remaining/initial/reserved time, course/downloaded course, dry level, Eco Hybrid, anti-crease, Smart Care, reservation active |
| Kimchi refrigerator | `2REK1G03VI1902` | top/middle/bottom room temperatures, door, display lock, one-touch filter, monitor status                                                                   |
| Mini washer         | `Pd0F_F`         | power, current/previous state, completion, remaining/initial/reserved time, error and door lock                                                             |
| Dishwasher          | `D121111`        | power, state/process/completion, remaining/initial/reserved time, course/stored download course, tub-clean count, confirmed read-only settings               |

Every field above was checked against at least one packet from the exact installed
model. Unknown enum values are retained as `RAW_<number>` instead of being guessed.

For the installed `RH16_N_KR` dryer, a labelled panel capture confirms
`TOWELS=2`, `BULKYITEM=4`, `EASYCARE=5`, `COTTONNORMAL=7`, `SPORTWEAR=8`,
`QUICKDRY=9`, `WOOL=11`, `RACKDRY=12`, `COOLAIR=13`, `WARMAIR=14`,
`BEDDING_BRUSH=15`, `ALLERGYCARE=16`, `SELFCLEANING=19`,
`PADDINGREFRESH=20`, and `WATERREPELLENT=22`. Raw `4` is a downloaded course
only when `rec[22]` is nonzero and equals stored-download `rec[25]`; otherwise it
remains Bedding. The stored download is always decoded from `rec[25]`. That
compound state suppresses only its false error indication. Anti-crease is
`rec[16] & 0x02`, Smart Care is `rec[17] & 0x20`, and reservation active is
`rec[16] & 0x01`. While active, a valid `rec[12]` hour (3--19) and `rec[13]`
minute (0--59) publish the reservation duration; all inactive or invalid values
publish zero. `rec[14]`, the transient `rec[18]`, and the unlabelled `rec[10]`
were not assigned by this capture.

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
- dishwasher controls and error until each write packet is captured and proven safe;
- kimchi-refrigerator writes: its model schema reports `supportControl=false`.

The following `D121111` status fields were confirmed by a labelled physical panel
sequence. They are read-only Home Assistant entities; no local control packet is
implemented. The `0xEC` frame has a prior record followed by the current record,
so only the second 26-byte record is decoded.

| Local record field | Read-only entity | Confirmed value |
| ------------------ | ---------------- | --------------- |
| `rec[13] & 0x10` | product chime | enabled |
| `rec[13] & 0x20` | tub sterilization reminder | enabled |
| `rec[17] & 0x08` | front time display | enabled |
| `rec[15]` | rinse aid level | 0 through 4 |
| `rec[16]` | water hardness level | 0 through 4 |
| `rec[14] & 0x10` | dual zone | enabled |
| `rec[14] & 0x60` | half-load zone | `disabled`, `UPPER`, `LOWER`; other values remain `RAW_<number>` |
| `rec[17] & 0x04` | extra rinse | enabled |
| `rec[14] & 0x80` | steam | enabled |
| `rec[14] & 0x08` | high-temperature sanitize | enabled |
| `rec[14] & 0x04` | high-temperature dry | enabled |
| `rec[13] & 0x01` | control lock | enabled |
| `rec[14] & 0x01` | delay active | enabled |

The observed courses are `AUTO=1`, `EXPRESS=8`, `INTENSIVE=2`, `DELICATE=3`,
`SOAK=6`, `NORMAL=5`, `STEAM_TUB_CLEAN=9`, and `STEAM_REFRESH=7`.
`DOWNLOAD_CYCLE` is a compound state: its labelled installed-model transition used
raw course `2` together with `rec[8]=1` and `rec[22]=8`; the decoder requires that
active-download byte to be nonzero. A stored download value in
`rec[25]` alone never changes an intensive cycle to a download cycle.

The panel's delay setting exposed only its active bit during the labelled sequence;
the individual 1--12 hour values were not present in the decoded status record.
`reserve_time` remains the independent `rec[11:12]` duration and is not presented
as a delay-hour setting. Exact delay hours remain deferred.

The dishwasher door is the exception: a labelled close/open capture on 2026-08-24
kept the appliance state at `POWEROFF` and changed only bit `0x02` of status record
byte 13. The official ThinQ door entity changed at the same instant, confirming
`rec[13] & 0x02` as open.

The tub-clean count is carried outside the status record. Exact inner record
`0x32/0xCF` length 101 stores it at offset 42, while exact inner record `0x32/0xBF`
length 102 stores it at offset 43. A labelled cycle changed only this counter from
20 to 21 and matched the ThinQ app; shorter and longer records are rejected.

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
