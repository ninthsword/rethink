import { test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/D121111'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const META: Metadata = { modelId: 'D121111', modelName: 'D121111', swVersion: '1.0' }
const LIVE_POWER_OFF = buf(
    'AA3A32EC0018040000012400000124000032000000090000000000000008001804000001240000012400003200000009000000000000000805BB',
)

test('D121111 decodes the newest live dishwasher record', () => {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('dishwasher-id', META)
    new DUT(ha.asConnection(), thinq, META)
    thinq.emit('data', LIVE_POWER_OFF)

    const device = ha.devices['dishwasher-id']
    const p = device.properties
    assert.equal(p.power, 'OFF')
    assert.equal(p.status, 'POWEROFF')
    assert.equal(p.run_completed, 'OFF')
    assert.equal(p.process, 'NONE')
    assert.equal(p.remaining_time, 96)
    assert.equal(p.initial_time, 96)
    assert.equal(p.reserve_time, 0)
    assert.equal(p.course, 'NONE')
    assert.equal(p.current_download_course, 'FISH_DISH')
    assert.equal(device.config!.components.remote_start, undefined)
    assert.ok(device.config!.components.run_completed)
})
