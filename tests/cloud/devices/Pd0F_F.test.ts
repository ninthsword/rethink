import { test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/Pd0F_F'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const META: Metadata = { modelId: 'Pd0F_F', modelName: 'Pd0F_F', swVersion: '1.0' }
const LIVE_POWER_OFF = buf('AA2120EB00190000010001000000010000000000020002000001000000690035BB')

test('Pd0F_F decodes the live mini-washer snapshot without unsafe controls', () => {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('mini-id', META)
    new DUT(ha.asConnection(), thinq, META)
    thinq.emit('data', LIVE_POWER_OFF)

    const device = ha.devices['mini-id']
    const p = device.properties
    assert.equal(p.power, 'OFF')
    assert.equal(p.status, 'POWEROFF')
    assert.equal(p.run_completed, 'OFF')
    assert.equal(p.previous_status, 'INITIAL')
    assert.equal(p.remaining_time, 1)
    assert.equal(p.initial_time, 1)
    assert.equal(p.error, 'OFF')
    assert.equal(p.error_message, 'NO_ERROR')
    assert.equal(device.config!.components.remote_start, undefined)
})
