import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CAPS_RESPONSE_TAGS, marksCapsResponse } from '@/cloud/devices/tlv_device'

const tlv = (t: number) => [{ t, v: 0 }]

test('a capability reply is recognised by any tag firmware marks it with', () => {
    // 0x2da is the eeprom checksum older modules answer with. Newer ones send 0x2db or
    // 0x2c1, and a handler that knows only the old tag waits out its capability timeout
    // and then reports that the appliance never answered — anszom/rethink issue #137.
    for (const tag of [0x2da, 0x2db, 0x2c1]) {
        assert.equal(marksCapsResponse(tlv(tag)), true, `tag 0x${tag.toString(16)}`)
    }
    assert.deepEqual(
        [...CAPS_RESPONSE_TAGS].sort((a, b) => a - b),
        [0x2c1, 0x2da, 0x2db],
    )
})

test('a reply carrying none of them is not a capability reply', () => {
    assert.equal(marksCapsResponse(tlv(0x1f7)), false)
    assert.equal(marksCapsResponse([]), false)
})
