import { test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/2REK1G03VI1902'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const META: Metadata = { modelId: '2REK1G03VI1902', modelName: '2REK1G03VI1902', swVersion: '1.0' }
const LIVE_STATUS = buf('AA0F11EB0200FF0300FF000100ECBB')

test('2REK1G03VI1902 decodes the live kimchi refrigerator snapshot', () => {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('kimchi-id', META)
    new DUT(ha.asConnection(), thinq, META)
    thinq.emit('data', LIVE_STATUS)

    const p = ha.devices['kimchi-id'].properties
    assert.equal(p.top_room_temperature, 0)
    assert.equal(p.middle_room_temperature, 3)
    assert.equal(p.bottom_room_temperature, 0)
    assert.equal(p.door, 'OFF')
    assert.equal(p.display_lock, 'ON')
    assert.equal(p.one_touch_filter, 'OFF')
    assert.equal(p.monitor_status, 'MONITOR_NORMAL')
})
