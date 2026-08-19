import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/F21VDT_AKOR'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

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
        const components = ha.devices['washer-id'].config!.components
        assert.ok(components.status)
        assert.ok(components.run_completed)
        assert.ok(components.tub_clean_count)
        assert.equal(components.remote_start, undefined)
        assert.equal(components.power_off, undefined)
    })
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
