# WINF_056905_WW `0xA8` push record

Analysed from the small-room window air conditioner on 2026-08-24 KST. The retained
rethink log contained repeated `0xA8` records and nearby ordinary `0xA7` TLV state
responses from the same device.

## Envelope

- Total frame length: 247 bytes.
- Fixed-record payload: 237 bytes (`frame[8..-2]`).
- CRC16 covers the frame beginning at byte 2 and gives a zero remainder.
- Observed variants: `0x66` and `0x67` at frame byte 7.
- Payload signature: `01 EA 0A 01 14` at offsets 1 through 5.
- Payload offset 0 is repeated at offset 6. `0x66` frames used marker `0x65` and
  `0x67` frames normally used marker `0x0D`; the meaning is not yet known.
- Payload offset 7 is a monotonically advancing sequence byte.

This is not the 76-byte dehumidifier layout. The common part is only the `0xA8`
envelope; record offsets are model-specific.

## Evidence-backed mappings

The following values changed across the capture and tracked the corresponding TLV in
the nearest full `0xA7` response. Small disagreements occurred only on fast-changing
telemetry when the paired query was several seconds later.

| Payload offset | Width | TLV     | Meaning                              |
| -------------: | ----: | ------: | ------------------------------------ |
|              9 |     1 | `0x1F7` | Power                                |
|             10 |     1 | `0x1F9` | Operation mode                       |
|             12 |     1 | `0x1FA` | Fan strength                         |
|             14 |     1 | `0x322` | Horizontal vane position             |
|             25 |     1 | `0x1FE` | Target temperature, half-degrees C   |
|             26 |     1 | `0x1FD` | Current temperature, half-degrees C  |
|            107 |     1 | `0x32C` | Outdoor heat-exchanger raw value     |
|            143 |     1 | `0x06C` | Indoor-unit active state             |
|            146 |     1 | `0x330` | Electronic expansion valve opening   |
|        233–234 |     2 | `0x2B3` | Current power in watts, big-endian    |

These mappings are decoded by the WINF handler. The record is intentionally treated as
a partial state report, so receiving it does not cancel the post-write full values query.

## Core fields, promoted 2026-08-25

A labelled session changed power, mode, fan level, horizontal vane and target temperature
one at a time with a full `0xA7` query after each. Every offset above from 9 to 26 comes
from that session.

The earlier note proposed payload 8 as the mode candidate. It is 10: offset 8 did not move
when the mode did.

Additional correlations were found at payload 106 (`0x32B`), 202 (`0x228`), 228
(`0x232`) and 233–234 (`0x2B3`). The first three tags have no established user-facing
meaning in this handler, so they remain raw research candidates rather than Home
Assistant state.

## Other appliances in the retained log

No other connected model emitted the UART `0xA8` envelope. PAC and RAC air conditioners
used ordinary `0x87`/`0xA7` TLV reports. Washer, dryer, dishwasher and refrigerator
families used their existing `AA ... BB` record types instead.

The refrigerator's `AA 08 10 A8 ... BB` packet must not be confused with this envelope:
there, `10 A8` is a four-byte AABB inner command for a door-zone event. It is already
decoded as zone 1/2 (fridge/freezer) and state 0/1 (closed/open) by its refrigerator
handler.
