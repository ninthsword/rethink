import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import TLVDevice from '@/cloud/devices/tlv_device'
import * as TLV from '@/util/tlv'
import type { DeviceDiscovery } from '@/cloud/homeassistant'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

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

test('writable: false rejects setProperty and emits no packet', (t) => {
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

    /** A TLV frame the device would send back; the contents do not matter here. */
    const reply = () => buf('000004000000A7020101027DC163E3')

    test('three unanswered refresh queries take its entities out of service', () => {
        // Being quiet is not being gone — most appliances say nothing for hours. A refresh
        // query is a question, though, and one that goes unanswered several times over is
        // the appliance no longer listening. The living-room dehumidifier sat like that with
        // its socket up while Home Assistant showed two-hour-old values as current.
        const { ha, dev } = makeDevice()

        dev.query()
        dev.query()
        assert.equal(availability(ha), undefined, 'two is not yet an answer nobody gave')

        dev.query()
        assert.equal(availability(ha), 'offline')
    })

    test('answering again puts them back', () => {
        const { ha, thinq, dev } = makeDevice()
        dev.query()
        dev.query()
        dev.query()
        assert.equal(availability(ha), 'offline')

        thinq.emit('data', reply())
        assert.equal(availability(ha), 'online')
    })

    test('an appliance that keeps answering is never taken out of service', () => {
        // However long it goes between having anything to report.
        const { ha, thinq, dev } = makeDevice()
        for (let round = 0; round < 20; round++) {
            dev.query()
            thinq.emit('data', reply())
        }
        assert.notEqual(availability(ha), 'offline')
    })
})
