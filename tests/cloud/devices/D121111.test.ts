import assert from 'node:assert/strict'
import { test } from 'node:test'
import DUT from '@/cloud/devices/D121111'
import type { Metadata } from '@/cloud/thinq'
import { buf, MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'

const META: Metadata = { modelId: 'D121111', modelName: 'D121111', swVersion: '1.0' }
const LIVE_POWER_OFF = buf(
    'AA3A32EC0018040000012400000124000032000000090000000000000008001804000001240000012400003200000009000000000000000805BB',
)
const LIVE_DOOR_CLOSED = buf(
    'AA3A32EC081804000001240000012400003000000009000000000000000800180400000124000001240000300000000900000000000000080DBB',
)
const LIVE_DOOR_OPEN = buf(
    'AA3A32EC0018040000012400000124000030000000090000000000000008001804000001240000012400003200000009000000000000000807BB',
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
    assert.equal(p.remaining_time, 0)
    assert.equal(p.initial_time, 96)
    assert.equal(p.reserve_time, 0)
    assert.equal(p.course, 'NONE')
    assert.equal(p.current_download_course, 'FISH_DISH')
    assert.equal(device.config?.components.remote_start, undefined)
    assert.ok(device.config?.components.run_completed)
})

test('D121111 treats standby as powered off and keeps duration fields in their observed roles', () => {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('dishwasher-id', META)
    new DUT(ha.asConnection(), thinq, META)

    const report = (state: number, total: number, remaining: number) => {
        const rec = Buffer.alloc(26)
        rec[1] = 0x18
        rec[2] = state
        rec[6] = total
        rec[10] = remaining
        const inner = Buffer.concat([Buffer.from([0x32, 0xeb]), rec])
        thinq.emit('data', Buffer.concat([Buffer.from([0xaa, inner.length + 4]), inner, Buffer.from([0x00, 0xbb])]))
        return ha.devices['dishwasher-id'].properties
    }

    let p = report(2, 55, 12)
    assert.equal(p.power, 'ON')
    assert.equal(p.initial_time, 55)
    assert.equal(p.remaining_time, 12)

    p = report(0, 55, 1)
    assert.equal(p.power, 'OFF')
    assert.equal(p.status, 'POWEROFF')
    assert.equal(p.initial_time, 55)
    assert.equal(p.remaining_time, 0)
})

test('D121111 decodes the door bit while the appliance remains powered off', () => {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('dishwasher-id', META)
    new DUT(ha.asConnection(), thinq, META)

    thinq.emit('data', LIVE_DOOR_CLOSED)
    assert.equal(ha.devices['dishwasher-id'].properties.power, 'OFF')
    assert.equal(ha.devices['dishwasher-id'].properties.door, 'OFF')

    thinq.emit('data', LIVE_DOOR_OPEN)
    assert.equal(ha.devices['dishwasher-id'].properties.power, 'OFF')
    assert.equal(ha.devices['dishwasher-id'].properties.door, 'ON')
    const components = ha.devices['dishwasher-id'].config?.components as Record<string, Record<string, unknown>>
    assert.equal(components.door.device_class, 'door')
})

test('D121111 reports the runs since the last tub sterilisation', () => {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('dishwasher-id', META)
    const dev = new DUT(ha.asConnection(), thinq, META)

    // The counter is not in the status record at all, unlike the washer's. These are the
    // appliance's own long records, taken before and after a cycle: the ThinQ app showed
    // 20 and then 21, and this is the only byte that moved.
    const long = (kind: number, offset: number, value: number) => {
        const inner = Buffer.alloc(kind === 0xbf ? 102 : 101)
        inner[0] = 0x32
        inner[1] = kind
        inner[offset] = value
        return Buffer.concat([Buffer.from([0xaa, 0x00]), inner, Buffer.from([0x00, 0xbb])])
    }

    thinq.emit('data', long(0xcf, 42, 20))
    assert.equal(ha.devices['dishwasher-id'].properties.tub_clean_count, 20)

    // 0xBF carries one extra byte near the front, so the same field sits one place along.
    thinq.emit('data', long(0xbf, 43, 21))
    assert.equal(ha.devices['dishwasher-id'].properties.tub_clean_count, 21)
    dev.drop()
})
