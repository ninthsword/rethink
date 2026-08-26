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

function packet(first: Buffer, second: Buffer, kind = 0xec) {
    const inner = Buffer.concat([Buffer.from([0x32, kind]), first, second])
    return Buffer.concat([Buffer.from([0xaa, inner.length + 4]), inner, Buffer.from([0x00, 0xbb])])
}

function record(fields: Record<number, number> = {}) {
    const rec = Buffer.alloc(26)
    rec[1] = 0x18
    for (const [offset, value] of Object.entries(fields)) rec[Number(offset)] = value
    return rec
}

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

test('D121111 decodes every confirmed status field from the current half of a dual record', () => {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('dishwasher-id', META)
    new DUT(ha.asConnection(), thinq, META)

    // The first record is the previous state. Deliberately give it conflicting values so
    // this verifies the 0xEC handler reads only the newest, second record.
    const previous = record({
        2: 4,
        3: 0,
        5: 0,
        6: 12,
        7: 1,
        8: 0,
        9: 0,
        10: 2,
        11: 0,
        12: 6,
        13: 0,
        14: 0,
        15: 1,
        16: 1,
        17: 0,
        22: 0,
        25: 1,
    })
    const current = record({
        2: 2,
        3: 3,
        5: 1,
        6: 23,
        7: 2,
        8: 1,
        9: 0,
        10: 45,
        11: 0,
        12: 9,
        13: 0x33,
        14: 0xdd,
        15: 4,
        16: 3,
        17: 0x0c,
        22: 8,
        25: 8,
    })
    thinq.emit('data', packet(previous, current))

    const { properties: p, config } = ha.devices['dishwasher-id']
    assert.deepEqual(p, {
        power: 'ON',
        door: 'ON',
        status: 'RUNNING',
        run_completed: 'OFF',
        process: 'RINSING',
        remaining_time: 45,
        initial_time: 83,
        reserve_time: 9,
        course: 'DOWNLOAD_CYCLE',
        current_download_course: 'FISH_DISH',
        chime_enabled: 'ON',
        tub_sterilization_reminder: 'ON',
        front_time_display: 'ON',
        rinse_aid_level: 4,
        water_hardness_level: 3,
        dual_zone: 'ON',
        half_load_zone: 'UPPER',
        extra_rinse: 'ON',
        steam: 'ON',
        high_temp_sanitize: 'ON',
        high_temp_dry: 'ON',
        control_lock: 'ON',
        delay_active: 'ON',
    })

    const components = config?.components as Record<string, Record<string, unknown>>
    for (const [property, platform] of Object.entries({
        chime_enabled: 'binary_sensor',
        tub_sterilization_reminder: 'binary_sensor',
        front_time_display: 'binary_sensor',
        rinse_aid_level: 'sensor',
        water_hardness_level: 'sensor',
        dual_zone: 'binary_sensor',
        half_load_zone: 'sensor',
        extra_rinse: 'binary_sensor',
        steam: 'binary_sensor',
        high_temp_sanitize: 'binary_sensor',
        high_temp_dry: 'binary_sensor',
        control_lock: 'binary_sensor',
        delay_active: 'binary_sensor',
    })) {
        assert.equal(components[property].platform, platform)
        assert.equal(components[property].command_topic, undefined)
    }
})

test('D121111 maps observed dishwasher courses and only identifies the compound download cycle', () => {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('dishwasher-id', META)
    new DUT(ha.asConnection(), thinq, META)

    const report = (fields: Record<number, number>) => {
        const rec = record({ 2: 2, ...fields })
        thinq.emit('data', packet(rec, Buffer.alloc(0), 0xeb))
        return ha.devices['dishwasher-id'].properties.course
    }

    for (const [raw, course] of Object.entries({
        1: 'AUTO',
        8: 'EXPRESS',
        2: 'INTENSIVE',
        3: 'DELICATE',
        6: 'SOAK',
        5: 'NORMAL',
        9: 'STEAM_TUB_CLEAN',
        7: 'STEAM_REFRESH',
    }))
        assert.equal(report({ 7: Number(raw) }), course)
    assert.equal(report({ 7: 4 }), 'RAW_4')
    assert.equal(report({ 7: 10 }), 'RAW_10')
    assert.equal(report({ 7: 11 }), 'RAW_11')
    assert.equal(report({ 7: 250 }), 'RAW_250')

    // A stored download course and every observed option bit are insufficient on their own.
    assert.equal(report({ 7: 2, 14: 0xdd, 22: 8, 25: 8 }), 'INTENSIVE')
    assert.equal(report({ 7: 2, 8: 1, 14: 0xdd, 25: 8 }), 'INTENSIVE')
    assert.equal(report({ 7: 2, 8: 1, 22: 8, 25: 8 }), 'DOWNLOAD_CYCLE')
})

test('D121111 reports lower and unexpected half-load bitmap values without guessing', () => {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('dishwasher-id', META)
    new DUT(ha.asConnection(), thinq, META)

    const report = (halfLoadBits: number) => {
        const rec = record({ 2: 2, 14: halfLoadBits })
        thinq.emit('data', packet(rec, Buffer.alloc(0), 0xeb))
        return ha.devices['dishwasher-id'].properties.half_load_zone
    }

    assert.equal(report(0), 'disabled')
    assert.equal(report(0x20), 'LOWER')
    assert.equal(report(0x60), 'RAW_96')
})

test('D121111 ignores wrong-length status records without replacing the last valid course', () => {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('dishwasher-id', META)
    new DUT(ha.asConnection(), thinq, META)

    thinq.emit('data', packet(record({ 2: 2, 7: 1 }), Buffer.alloc(0), 0xeb))
    assert.equal(ha.devices['dishwasher-id'].properties.course, 'AUTO')

    thinq.emit('data', packet(record({ 2: 2, 7: 3 }).subarray(0, 25), Buffer.alloc(0), 0xeb))
    assert.equal(ha.devices['dishwasher-id'].properties.course, 'AUTO')

    thinq.emit('data', packet(record({ 2: 2, 7: 3 }), record({ 2: 2, 7: 8 }).subarray(0, 25)))
    assert.equal(ha.devices['dishwasher-id'].properties.course, 'AUTO')
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
    const long = (kind: number, innerLength: number, offset: number, value: number) => {
        const inner = Buffer.alloc(innerLength)
        inner[0] = 0x32
        inner[1] = kind
        inner[offset] = value
        return Buffer.concat([Buffer.from([0xaa, inner.length + 4]), inner, Buffer.from([0x00, 0xbb])])
    }

    thinq.emit('data', long(0xcf, 101, 42, 20))
    assert.equal(ha.devices['dishwasher-id'].properties.tub_clean_count, 20)

    for (const [kind, innerLength, offset] of [
        [0xcf, 100, 42],
        [0xcf, 102, 42],
        [0xbf, 101, 43],
        [0xbf, 103, 43],
    ]) {
        thinq.emit('data', long(kind, innerLength, offset, 99))
        assert.equal(ha.devices['dishwasher-id'].properties.tub_clean_count, 20)
    }

    // 0xBF carries one extra byte near the front, so the same field sits one place along.
    thinq.emit('data', long(0xbf, 102, 43, 21))
    assert.equal(ha.devices['dishwasher-id'].properties.tub_clean_count, 21)
    dev.drop()
})
