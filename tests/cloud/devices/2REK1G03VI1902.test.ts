import { test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/2REK1G03VI1902'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const META: Metadata = { modelId: '2REK1G03VI1902', modelName: '2REK1G03VI1902', swVersion: '1.0' }
const LIVE_STATUS = buf('AA0F11EB0200FF0300FF000100ECBB')

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('kimchi-id', META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

test('2REK1G03VI1902 decodes the live kimchi refrigerator snapshot', () => {
    const { ha, thinq } = makeDevice()
    thinq.emit('data', LIVE_STATUS)

    const p = ha.devices['kimchi-id'].properties
    // The bytes that look like a temperature are storage mode codes. This snapshot has the
    // top and bottom compartments keeping kimchi at the middle setting and the middle
    // compartment on produce, which is raw 3 for that compartment's own list.
    assert.equal(p.top_room_mode, 'kimchi_medium')
    assert.equal(p.middle_room_mode, 'produce_medium')
    assert.equal(p.bottom_room_mode, 'kimchi_medium')
    assert.equal(p.door, 'OFF')
    assert.equal(p.display_lock, 'ON')
    assert.equal(p.one_touch_filter, 'OFF')
    assert.equal(p.monitor_status, 'MONITOR_NORMAL')
})

test('2REK1G03VI1902 reads each compartment with its own mode list', () => {
    const { ha, thinq } = makeDevice()

    // Built from the live snapshot with only the mode bytes changed, checksum included.
    // Raw 6 is freezer on top, meat/fish in the middle and rice/grain at the bottom: the
    // same number means a different thing in each compartment.
    thinq.emit('data', buf('AA0F11EB0206FF0606FF00000092BB'))
    const p = ha.devices['kimchi-id'].properties
    assert.equal(p.top_room_mode, 'freezer')
    assert.equal(p.middle_room_mode, 'meat_fish')
    assert.equal(p.bottom_room_mode, 'rice_grain')

    // "Off" is 9 on top and at the bottom but 13 in the middle compartment.
    thinq.emit('data', buf('AA0F11EB0209FF0D09FF00000081BB'))
    assert.equal(p.top_room_mode, 'top_off')
    assert.equal(p.middle_room_mode, 'middle_off')
    assert.equal(p.bottom_room_mode, 'bottom_off')
})

test('2REK1G03VI1902 skips a compartment the appliance does not have', () => {
    const { ha, thinq } = makeDevice()
    thinq.emit('data', LIVE_STATUS)

    // Byte 2 is the right-hand top compartment of the wider models and always reads 0xff
    // here, so nothing must be published for it.
    const published = Object.keys(ha.devices['kimchi-id'].properties)
    assert.deepEqual(
        published.filter((name) => name.includes('room')).sort(),
        ['bottom_room_mode', 'middle_room_mode', 'top_room_mode'],
    )
})

test('2REK1G03VI1902 retires the temperature sensors it replaced', () => {
    const { ha } = makeDevice()

    // They published the raw mode byte as degrees Celsius, and Home Assistant keeps an
    // entity whose component vanishes from the discovery payload.
    const removal = ha.publishedConfigs.find(
        (config) => (config.components.top_room_temperature as Record<string, unknown>)?.platform === 'sensor',
    )
    assert.ok(removal, 'no temperature sensor removal was published')
    for (const name of ['top_room_temperature', 'middle_room_temperature', 'bottom_room_temperature'])
        assert.equal((removal.components[name] as Record<string, unknown>).platform, 'sensor')
})
