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
