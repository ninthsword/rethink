import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import DUT from '@/cloud/devices/F21VDT_AKOR'
import type { Metadata } from '@/cloud/thinq'
import { buf, MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'

const META: Metadata = { modelId: 'F21VDT_AKOR', modelName: 'F21VDT_AKOR', swVersion: '1.0' }
const LIVE_POWER_OFF = buf('AA2220EB001A000000000000000000000000000000000000000534150400000016BB')

describe('F21VDT_AKOR', () => {
    test('decodes the live washer snapshot', () => {
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device('washer-id', META)
        new DUT(ha.asConnection(), thinq, META)
        thinq.emit('data', LIVE_POWER_OFF)

        const p = ha.devices['washer-id'].properties
        assert.equal(p.power, 'OFF')
        assert.equal(p.status, 'POWEROFF')
        assert.equal(p.run_completed, 'OFF')
        assert.equal(p.previous_status, 'INITIAL')
        assert.equal(p.remaining_time, 0)
        assert.equal(p.initial_time, 0)
        assert.equal(p.downloaded_course, 'SMALL_LOAD')
        assert.equal(p.operation_course, 'SPEEDWASH')
        assert.equal(p.tub_clean_count, 21)
    })

    test('exposes only observed read-only components', () => {
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device('washer-id', META)
        new DUT(ha.asConnection(), thinq, META)
        const components = ha.devices['washer-id'].config?.components
        assert.ok(components)
        assert.ok(components.status)
        assert.ok(components.run_completed)
        assert.ok(components.tub_clean_count)
        assert.equal(components.remote_start, undefined)
        assert.equal(components.power_off, undefined)
    })
})

test('F21VDT_AKOR reports the errors its model defines', () => {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('washer-id', META)
    new DUT(ha.asConnection(), thinq, META)

    const report = (code: number) => {
        const rec = Buffer.alloc(28)
        rec[1] = 0x1a
        rec[8] = code
        thinq.emit('data', Buffer.concat([Buffer.from([0xaa, 0x22, 0x20, 0xeb]), rec, Buffer.from([0, 0xbb])]))
        return ha.devices['washer-id'].properties
    }

    assert.equal(report(0).error, 'OFF')
    assert.equal(report(0).error_message, 'NO_ERROR')
    for (const [code, name] of [
        [1, 'ERROR_DE2'],
        [2, 'ERROR_IE'],
        [8, 'ERROR_LE'],
        [12, 'ERROR_FF'],
        [18, 'ERROR_LOE'],
        [19, 'ERROR_DE4'],
    ] as const) {
        const p = report(code)
        assert.equal(p.error_message, name)
        assert.equal(p.error, 'ON')
    }
})

test('F21VDT_AKOR names every download course the app offered', () => {
    // Each byte came from a `f0 25` download command captured on the wire while the owner
    // picked that course in the ThinQ app, fourteen in one sitting. index 17 was the only
    // position that differed across all fourteen, and SMALL_LOAD landing on the 0x34 this
    // handler already carried is the independent check that it is the right position.
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('washer-id', META)
    new DUT(ha.asConnection(), thinq, META)

    for (const [code, course] of [
        [0x33, 'COLD_WASH'],
        [0x34, 'SMALL_LOAD'],
        [0x35, 'SKIN_CARE'],
        [0x36, 'RAINY_DAY'],
        [0x37, 'SWEAT_STAIN'],
        [0x38, 'SINGLE_GARMENTS'],
        [0x39, 'KIDS_WEAR'],
        [0x3a, 'SHIRT'],
        [0x3b, 'SCHOOL_UNIFORM'],
        [0x3c, 'STATIC_REDUCE'],
        [0x3f, 'SPIN_ONLY'],
        [0x41, 'DEODORIZATION_WASHER'],
        [0x43, 'CLOTH_CARE'],
        [0x44, 'SMART_RINSE'],
    ] as const) {
        const rec = Buffer.alloc(28)
        rec[1] = 0x1a
        rec[22] = code
        thinq.emit('data', Buffer.concat([Buffer.from([0xaa, 0x22, 0x20, 0xeb]), rec, Buffer.from([0, 0xbb])]))
        assert.equal(ha.devices['washer-id'].properties.downloaded_course, course)
    }
})

test('F21VDT_AKOR names every course its dial reaches', () => {
    // Read off the appliance one dial position at a time, in the order the panel lists
    // them. The values run 7 down to 1 and wrap to 14, closing back on 표준세탁.
    const dial: Array<[number, string]> = [
        [7, 'NORMAL_WASH'],
        [6, 'STAIN_CARE'],
        [5, 'BABY_WEAR'],
        [4, 'ECO_BOIL'],
        [3, 'SPORTWEAR'],
        [2, 'ALLERGY_CARE'],
        [1, 'STEAM_STYLING'],
        [14, 'DOWNLOADED'],
        [13, 'RINSE_SPIN'],
        [12, 'LINGERIE_WOOL'],
        [11, 'BULKYITEM'],
        [10, 'COLOR_CARE'],
        [9, 'QUIET_WASH'],
        [8, 'SPEEDWASH'],
    ]

    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('washer-id', META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    for (const [raw, name] of dial) {
        const rec = Buffer.alloc(28)
        rec[1] = 0x1a
        rec[7] = raw
        const inner = Buffer.concat([Buffer.from([0x20, 0xeb]), rec])
        const frame = Buffer.concat([Buffer.from([0xaa, inner.length + 4]), inner, Buffer.from([0x00, 0xbb])])
        thinq.emit('data', frame)
        assert.equal(ha.devices['washer-id'].properties.course, name, `raw ${raw}`)
    }
    dev.drop()
})
