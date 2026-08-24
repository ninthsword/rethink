import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import TLVDevice, { CAPS_RESPONSE_TAGS, marksCapsResponse } from '@/cloud/devices/tlv_device'
import type { DeviceDiscovery } from '@/cloud/homeassistant'
import { buf, MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'
import * as TLV from '@/util/tlv'

const DEVICE_ID = 'test-id'
function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, { modelId: 'X', modelName: 'X' })
    const dev = new TLVDevice(ha.asConnection(), thinq)
    // Stop the cap-retry interval set up in the constructor so the test process can exit cleanly.
    if (dev.query_caps_timeout) {
        clearInterval(dev.query_caps_timeout)
        dev.query_caps_timeout = undefined
    }
    // addField writes into config.components[comp], so seed the comp entries we use.
    const config = {
        components: { sensor: {}, c: {} },
    } as unknown as DeviceDiscovery
    // Constructor calls queryCaps which puts a packet in the outbox; clear so each test starts fresh.
    thinq.resetRecorder()
    return { ha, thinq, dev, config }
}

test('a write is followed by one refresh query, however fast the slider moves', (t) => {
    // The appliance answers a write with a frame this parser does not recognise, so the value
    // it accepted only reaches Home Assistant on the next periodic query. The dehumidifier
    // polls every fifteen minutes by default, which is how a turn-off reservation could be set
    // correctly on the wire and still read as unchanged on screen for a quarter of an hour.
    // One query after the writes settle closes that without asking the appliance fourteen
    // times because someone dragged a slider.
    enableMockTimers(t)
    const { thinq, dev, config } = makeDevice()
    dev.addField(config, { id: 0x21b, name: '', comp: 'c', write_xform: (v) => Number(v) * 60 })

    dev.setProperty('c-', '1')
    dev.setProperty('c-', '2')
    dev.setProperty('c-', '4')
    const writes = thinq.outbox.length
    assert.equal(writes, 3, 'each write still goes out immediately')

    tickMockTimers(t, 2000)
    const after = thinq.outbox
    assert.equal(after.length, writes + 1, 'exactly one refresh query follows the burst')
    // A values query uses the 0x02 sub-header; a write uses 0x01 there.
    assert.match(after[after.length - 1].toString('hex'), /^010104000000650202/)

    tickMockTimers(t, 60_000)
    assert.equal(thinq.outbox.length, writes + 1, 'the refresh does not repeat on its own')
})

test('processData ignores frames that do not match magic prefix', () => {
    const { ha, thinq } = makeDevice()
    thinq.emit('data', buf('00112233445566778899AABBCC'))

    assert.equal(Object.entries(ha.devices[DEVICE_ID]?.properties ?? {}).length, 0) // nothing published
})

test('unknown TLV id is stored in raw_clip_state but not published', () => {
    const { ha, dev } = makeDevice()
    dev.processKeyValue(0x999, 42)
    assert.equal(dev.raw_clip_state[0x999], 42)

    assert.equal(Object.entries(ha.devices[DEVICE_ID]?.properties ?? {}).length, 0) // nothing published
})

test('read_xform returning undefined discards', () => {
    const { ha, dev, config } = makeDevice()
    dev.addField(config, {
        id: 0x100,
        name: 'foo',
        comp: 'sensor',
        read_xform: () => undefined,
    })
    dev.processKeyValue(0x100, 7)
    assert.equal(dev.raw_clip_state[0x100], 7)

    assert.equal(Object.entries(ha.devices[DEVICE_ID]?.properties ?? {}).length, 0) // nothing published
})

test('read_callback returning false suppresses publish', () => {
    const { ha, dev, config } = makeDevice()
    let callbackArg: unknown
    dev.addField(config, {
        id: 0x101,
        name: 'foo',
        comp: 'sensor',
        read_xform: (v) => v + 1,
        read_callback: (v) => {
            callbackArg = v
            return false
        },
    })
    dev.processKeyValue(0x101, 5)
    assert.equal(callbackArg, 6)
    assert.equal(Object.entries(ha.devices[DEVICE_ID]?.properties ?? {}).length, 0) // nothing published
})

test('read_callback returning true allows publish', () => {
    const { ha, dev, config } = makeDevice()
    dev.addField(config, {
        id: 0x102,
        name: 'foo',
        comp: 'sensor',
        read_callback: () => true,
    })
    dev.processKeyValue(0x102, 9)
    assert.equal(ha.devices[DEVICE_ID]?.properties['sensor-foo'], 9)
})

test('readable: false suppresses publish but still updates raw_clip_state', () => {
    const { ha, dev, config } = makeDevice()
    dev.addField(config, {
        id: 0x103,
        name: 'foo',
        comp: 'sensor',
        readable: false,
    })
    dev.processKeyValue(0x103, 11)
    assert.equal(dev.raw_clip_state[0x103], 11)
    assert.equal(Object.entries(ha.devices[DEVICE_ID]?.properties ?? {}).length, 0) // nothing published
})

test('writable: false rejects setProperty and emits no packet', (_t) => {
    const { thinq, dev, config } = makeDevice()
    dev.addField(config, {
        id: 0x104,
        name: 'foo',
        comp: 'sensor',
        writable: false,
    })
    dev.setProperty('sensor-foo', '1')
    assert.equal(thinq.outbox.length, 0)
})

test('setProperty with write_callback returning false suppresses send', () => {
    const { thinq, dev, config } = makeDevice()
    dev.addField(config, {
        id: 0x105,
        name: 'foo',
        comp: 'sensor',
        write_xform: (v) => Number(v),
        write_callback: () => false,
    })
    dev.setProperty('sensor-foo', '7')
    // Even though write_callback returned false, raw_clip_state should still be updated
    // - but no packet should be sent.
    assert.equal(thinq.outbox.length, 0)
})

test('setProperty with write_attach as array sends additional TLVs', () => {
    const { thinq, dev, config } = makeDevice()
    dev.addField(config, {
        id: 0x200,
        name: 'a',
        comp: 'c',
        write_xform: (v) => Number(v),
        write_attach: [0x201],
    })
    // Pre-seed the attached field so its current value is included
    dev.raw_clip_state[0x201] = 9
    dev.setProperty('c-a', '3')
    assert.equal(thinq.outbox.length, 1)
    // The packet should encode TLV t=0x200 v=3 followed by t=0x201 v=9.
    // Frame body byte 10 = TLV length. With both TLVs at l=0, length = 4.
    const out = thinq.outbox[0]
    const tlv = TLV.parse(out.subarray(11, out.length - 2))
    assert.equal(tlv[0].t, 0x200)
    assert.equal(tlv[0].v, 3)
    assert.equal(tlv[1].t, 0x201)
    assert.equal(tlv[1].v, 9)
})

test('every entity registered on a tag is published, not just the last one', () => {
    const { ha, dev, config } = makeDevice()
    // The dehumidifier's target humidity is a humidifier slider and a number that steps
    // the way the appliance does, both on one tag. Registering the second used to replace
    // the first, and the entity that lost simply stopped updating without a word.
    dev.addField(config, { id: 0x253, name: 'target_humidity', comp: 'sensor' })
    dev.addField(config, { id: 0x253, name: '', comp: 'c' })

    dev.processKeyValue(0x253, 55)

    assert.equal(ha.devices[DEVICE_ID]?.properties['sensor-target_humidity'], 55)
    assert.equal(ha.devices[DEVICE_ID]?.properties['c-'], 55)
})

test('each entity on a shared tag keeps its own transform', () => {
    const { ha, dev, config } = makeDevice()
    dev.addField(config, { id: 0x300, name: 'raw', comp: 'sensor' })
    dev.addField(config, { id: 0x300, name: '', comp: 'c', read_xform: (raw) => (raw ? 'ON' : 'OFF') })

    dev.processKeyValue(0x300, 1)

    assert.equal(ha.devices[DEVICE_ID]?.properties['sensor-raw'], 1)
    assert.equal(ha.devices[DEVICE_ID]?.properties['c-'], 'ON')
})

test('one entity discarding a reading does not silence the others on the tag', () => {
    const { ha, dev, config } = makeDevice()
    dev.addField(config, { id: 0x301, name: 'skips', comp: 'sensor', read_xform: () => undefined })
    dev.addField(config, { id: 0x301, name: '', comp: 'c' })

    dev.processKeyValue(0x301, 7)

    assert.equal(ha.devices[DEVICE_ID]?.properties['sensor-skips'], undefined)
    assert.equal(ha.devices[DEVICE_ID]?.properties['c-'], 7)
})

describe('an appliance that stops answering', () => {
    const availability = (ha: MockHAConnection) => ha.devices[DEVICE_ID]?.availability
    const reply = () => buf('000004000000A7020101027DC163E3')
    /** Fire the periodic refresh the way its timer does. */
    const refresh = (_dev: TLVDevice, t: import('node:test').TestContext) => tickMockTimers(t, 15 * 60 * 1000)

    test('three unanswered refreshes take its entities out of service', (t) => {
        // Being quiet is not being gone — most appliances say nothing for hours. A refresh
        // query is a question, though, and one unanswered several times over is the
        // appliance no longer listening. The living-room dehumidifier sat like that with
        // its socket up while Home Assistant showed two-hour-old values as current.
        enableMockTimers(t)
        const { ha, dev } = makeDevice()
        dev.setQueryInterval()

        refresh(dev, t)
        refresh(dev, t)
        assert.notEqual(availability(ha), 'offline', 'twice is not yet an answer nobody gave')

        refresh(dev, t)
        assert.equal(availability(ha), 'offline')
        dev.drop()
    })

    test('the startup retries do not count', (t) => {
        // They fire every fifteen seconds until the appliance answers, which would call it
        // silent three quarters of a minute in rather than three quarters of an hour.
        enableMockTimers(t)
        const { ha, dev } = makeDevice()

        for (let i = 0; i < 20; i++) dev.query()
        assert.notEqual(availability(ha), 'offline')
        dev.drop()
    })

    test('answering again puts them back', (t) => {
        enableMockTimers(t)
        const { ha, thinq, dev } = makeDevice()
        dev.setQueryInterval()
        refresh(dev, t)
        refresh(dev, t)
        refresh(dev, t)
        assert.equal(availability(ha), 'offline')

        thinq.emit('data', reply())
        assert.equal(availability(ha), 'online')
        dev.drop()
    })

    test('an appliance that keeps answering is never taken out of service', (t) => {
        enableMockTimers(t)
        const { ha, thinq, dev } = makeDevice()
        dev.setQueryInterval()
        for (let round = 0; round < 10; round++) {
            refresh(dev, t)
            thinq.emit('data', reply())
        }
        assert.notEqual(availability(ha), 'offline')
        dev.drop()
    })
})

const capabilityTlv = (t: number) => [{ t, v: 0 }]

test('a capability reply is recognised by any tag firmware marks it with', () => {
    // 0x2da is the eeprom checksum older modules answer with. Newer ones send 0x2db or
    // 0x2c1, and a handler that knows only the old tag waits out its capability timeout
    // and then reports that the appliance never answered — anszom/rethink issue #137.
    for (const tag of [0x2da, 0x2db, 0x2c1]) {
        assert.equal(marksCapsResponse(capabilityTlv(tag)), true, `tag 0x${tag.toString(16)}`)
    }
    assert.deepEqual(
        [...CAPS_RESPONSE_TAGS].sort((a, b) => a - b),
        [0x2c1, 0x2da, 0x2db],
    )
})

test('a reply carrying none of them is not a capability reply', () => {
    assert.equal(marksCapsResponse(capabilityTlv(0x1f7)), false)
    assert.equal(marksCapsResponse([]), false)
})
