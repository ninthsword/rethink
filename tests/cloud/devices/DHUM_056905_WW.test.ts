import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import DUT from '@/cloud/devices/DHUM_056905_WW'
import type { Metadata } from '@/cloud/thinq'
import { buf, hex, MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'
import * as TLV from '@/util/tlv'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'DHUM_056905_WW'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '1.0' }

// Real packets captured from an LG DQ203PECA through the ThinQ cloud bridge.
const CAPS_REQUEST_HEX = '01010400000065020201027D416A0D'
const QUERY_REQUEST_HEX = '01010400000065020201027D425A6E'
const CAPS_RESPONSE_HEX =
    '000004000000A70201AB6B644FB00DB0703E0000B0B0011044B300B340B4E00100B5A00402B541B6A00ABFB6E09244' +
    'B7200200B750A0BC40B3C0BD30010001BD60081FBD85B9501EB99046D401DD04FA01FB0BB5D011B600B646B5D012' +
    'B600B646B5D013B600B642B5D014B600B646B5D015B600B6467802'
const QUERY_RESPONSE_HEX =
    '000004000000A70204B15A7DC07E50117E8694D0377F503886C087008980C900D8008781CD90448840CE80AB00A881' +
    '87C1E801EE408C808CC0B5D011B600B646B5D012B600B646B5D013B600B642B5D014B600B646B5D015B600B646B5' +
    'D016B600B646FA8097F7'

const WRITE_POWER_ON_HEX = '01010400000065020100027DC163E3'
const WRITE_POWER_OFF_HEX = '01010400000065020100027DC073C2'
const WRITE_HUMIDITY_50_HEX = '010104000000650201000394D032D182'
const WRITE_HUMIDITY_55_HEX = '010104000000650201000394D0378127'
// Captured from the appliance; the LG cloud sends byte-identical packets for the same
// two commands, which is how the encoding was confirmed.
const WRITE_MODE_FAST_HEX = '01010400000065020100037E50128988'
const WRITE_FAN_LOW_HEX = '01010400000065020100027E824E17'
const WRITE_UVNANO_OFF_HEX = '0101040000006502010002A880D1D4'
const WRITE_UVNANO_ON_HEX = '0101040000006502010002A881C1F5'
const WRITE_TANK_LIGHT_OFF_HEX = '01010400000065020100028780C70C'
const WRITE_TANK_LIGHT_ON_HEX = '01010400000065020100028781D72D'
// The LG cloud sends this exact packet for airState.reservation.targetTimeToStop = 60.
const WRITE_OFF_TIMER_1H_HEX = '010104000000650201000386D03C1D4F'
const WRITE_OFF_TIMER_CANCEL_HEX = '010104000000650201000286C0BCF9'
const WRITE_SENSOR_OPERATING_HEX = '0101040000006502010002CDC06DCF'
const WRITE_BUTTON_SOUND_ON_HEX = '0101040000006502010002E8004D90'
const WRITE_STATUS_DISPLAY_ON_HEX = '010104000000650201000287C08FC8'

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    ha.on('setProperty', (_id: string, prop: string, value: string) => dev.setProperty(prop, value))
    return { ha, thinq, dev }
}

function buildReadyDevice() {
    const result = makeDevice()
    result.thinq.resetRecorder()
    result.thinq.emit('data', buf(CAPS_RESPONSE_HEX))
    assert.equal(hex(result.thinq.outbox[0]), QUERY_REQUEST_HEX)
    result.thinq.emit('data', buf(QUERY_RESPONSE_HEX))
    result.thinq.resetRecorder()
    return result
}

describe(MODEL_ID, () => {
    test('publishes humidifier configuration and captured state', () => {
        const { ha, dev } = buildReadyDevice()
        const components = ha.devices[DEVICE_ID].config?.components as Record<string, Record<string, unknown>>

        assert.equal(components.dehumidifier.platform, 'humidifier')
        assert.equal(components.dehumidifier.device_class, 'dehumidifier')
        assert.equal(components.dehumidifier.min_humidity, 30)
        assert.equal(components.dehumidifier.max_humidity, 70)
        assert.equal(ha.getProperty(DEVICE_ID, 'dehumidifier', 'state'), 'OFF')
        assert.equal(ha.getProperty(DEVICE_ID, 'dehumidifier', 'target_humidity_state'), 55)
        assert.equal(ha.getProperty(DEVICE_ID, 'dehumidifier', 'current_humidity'), 68)
        assert.equal(ha.getProperty(DEVICE_ID, 'temperature', 'state'), 28)
        assert.equal(ha.getProperty(DEVICE_ID, 'dehumidifier', 'mode_state'), 'smart')
        assert.equal(ha.getProperty(DEVICE_ID, 'fan_speed', 'state'), 'high')
        assert.equal(ha.getProperty(DEVICE_ID, 'error', 'state'), 'normal')

        assert.deepEqual(components.dehumidifier.modes, [
            'smart',
            'fast',
            'silent',
            'concentrated_drying',
            'clothing_drying',
        ])
        assert.equal(components.fan_speed.platform, 'select')

        dev.drop()
    })

    test('retires the read-only sensors that the writable entities replaced', () => {
        const { ha, dev } = buildReadyDevice()

        // Mode and fan used to be sensors on these same component ids. Home Assistant does
        // not retire an entity when a component changes platform, and the mode sensor is
        // gone entirely now that the humidifier carries the mode itself.
        const removal = ha.publishedConfigs.find(
            (config) =>
                (config.components.operation_mode as Record<string, unknown>)?.platform === 'sensor' &&
                (config.components.fan_speed as Record<string, unknown>)?.platform === 'sensor',
        )
        assert.ok(removal, 'no sensor removal was published')
        assert.equal(
            (ha.devices[DEVICE_ID].config?.components.operation_mode as Record<string, unknown>) ?? undefined,
            undefined,
            'the mode sensor must not survive in the published config',
        )
        dev.drop()
    })

    test('offers only the modes and fan speeds the capability bitmaps report', () => {
        const { ha, dev } = buildReadyDevice()
        const components = ha.devices[DEVICE_ID].config?.components as Record<string, Record<string, unknown>>

        // The captured capability response reports 0x2c1 = 0x3e0000 (modes 17..21) and
        // 0x2c2 = 0x11044 (fan values 2 and 6). Every other fan value is acknowledged by
        // the appliance and then dropped without a state report.
        assert.deepEqual(components.dehumidifier.modes, [
            'smart',
            'fast',
            'silent',
            'concentrated_drying',
            'clothing_drying',
        ])
        assert.deepEqual(components.fan_speed.options, ['low', 'high'])
        dev.drop()
    })

    test('writes captured power packets', () => {
        const { ha, thinq, dev } = buildReadyDevice()

        ha.setProperty(DEVICE_ID, 'dehumidifier', 'command', 'ON')
        ha.setProperty(DEVICE_ID, 'dehumidifier', 'command', 'OFF')

        assert.deepEqual(thinq.outbox.map(hex), [WRITE_POWER_ON_HEX, WRITE_POWER_OFF_HEX])
        dev.drop()
    })

    test('writes captured target humidity packets and clamps to 30..70 in steps of five', () => {
        const { ha, thinq, dev } = buildReadyDevice()

        ha.setProperty(DEVICE_ID, 'dehumidifier', 'target_humidity_command', '50')
        ha.setProperty(DEVICE_ID, 'dehumidifier', 'target_humidity_command', '54')

        assert.deepEqual(thinq.outbox.map(hex), [WRITE_HUMIDITY_50_HEX, WRITE_HUMIDITY_55_HEX])
        dev.drop()
    })

    test('writes mode and fan only while the appliance is running', () => {
        const { ha, thinq, dev } = buildReadyDevice()

        // The captured state has the appliance powered off, where it acks a mode or fan
        // write and then ignores it.
        ha.setProperty(DEVICE_ID, 'dehumidifier', 'mode_command', 'fast')
        ha.setProperty(DEVICE_ID, 'fan_speed', 'command', 'low')
        assert.deepEqual(thinq.outbox.map(hex), [])

        dev.raw_clip_state[0x1f7] = 1
        ha.setProperty(DEVICE_ID, 'dehumidifier', 'mode_command', 'fast')
        ha.setProperty(DEVICE_ID, 'fan_speed', 'command', 'low')
        assert.deepEqual(thinq.outbox.map(hex), [WRITE_MODE_FAST_HEX, WRITE_FAN_LOW_HEX])

        dev.drop()
    })

    test('rejects a fan speed the appliance does not support', () => {
        const { ha, thinq, dev } = buildReadyDevice()
        dev.raw_clip_state[0x1f7] = 1

        // "power" (7) is acknowledged by the appliance and then ignored, so it must never
        // be offered nor sent.
        ha.setProperty(DEVICE_ID, 'fan_speed', 'command', 'power')
        assert.deepEqual(thinq.outbox.map(hex), [])

        ha.setProperty(DEVICE_ID, 'fan_speed', 'command', 'low')
        assert.equal(thinq.outbox.length, 1)
        dev.drop()
    })

    test('writes the verified UVnano and water tank light packets', () => {
        const { ha, thinq, dev } = buildReadyDevice()

        // Both were injected on the appliance and reported back, which is how the ids and
        // the encoding were confirmed.
        ha.setProperty(DEVICE_ID, 'uvnano', 'command', 'OFF')
        ha.setProperty(DEVICE_ID, 'uvnano', 'command', 'ON')
        ha.setProperty(DEVICE_ID, 'water_tank_light', 'command', 'OFF')
        ha.setProperty(DEVICE_ID, 'water_tank_light', 'command', 'ON')

        assert.deepEqual(thinq.outbox.map(hex), [
            WRITE_UVNANO_OFF_HEX,
            WRITE_UVNANO_ON_HEX,
            WRITE_TANK_LIGHT_OFF_HEX,
            WRITE_TANK_LIGHT_ON_HEX,
        ])
        dev.drop()
    })

    test('writes the turn-off reservation in minutes while running', () => {
        const { ha, thinq, dev } = buildReadyDevice()

        // Powered off the appliance acks the reservation and drops it.
        ha.setProperty(DEVICE_ID, 'off_timer', 'command', '1')
        assert.deepEqual(thinq.outbox.map(hex), [])

        dev.raw_clip_state[0x1f7] = 1
        ha.setProperty(DEVICE_ID, 'off_timer', 'command', '1')
        ha.setProperty(DEVICE_ID, 'off_timer', 'command', '0')
        assert.deepEqual(thinq.outbox.map(hex), [WRITE_OFF_TIMER_1H_HEX, WRITE_OFF_TIMER_CANCEL_HEX])

        // The appliance counts the reservation down every minute; 59 left is still the
        // one hour the slider shows.
        dev.processKeyValue(0x21b, 59)
        assert.equal(ha.getProperty(DEVICE_ID, 'off_timer', 'state'), 1)
        dev.drop()
    })

    test('clamps the turn-off reservation to the eight hours the appliance offers', () => {
        const { ha, thinq, dev } = buildReadyDevice()
        dev.raw_clip_state[0x1f7] = 1

        ha.setProperty(DEVICE_ID, 'off_timer', 'command', '12')
        assert.deepEqual(TLV.parse(thinq.outbox[0].subarray(11, thinq.outbox[0].length - 2)), [
            { t: 0x21b, l: 2, v: 480 },
        ])
        dev.drop()
    })

    test('writes the verified sensor, sound and display packets', () => {
        const { ha, thinq, dev } = buildReadyDevice()

        // All three were injected on the appliance and reported back. The sound and the
        // display are inverted on the wire: the appliance stores "silenced" / "off".
        ha.setProperty(DEVICE_ID, 'humidity_sensor', 'command', 'operating_only')
        ha.setProperty(DEVICE_ID, 'button_sound', 'command', 'ON')
        ha.setProperty(DEVICE_ID, 'status_display', 'command', 'ON')

        assert.deepEqual(thinq.outbox.map(hex), [
            WRITE_SENSOR_OPERATING_HEX,
            WRITE_BUTTON_SOUND_ON_HEX,
            WRITE_STATUS_DISPLAY_ON_HEX,
        ])

        dev.processKeyValue(0x3a0, 1)
        dev.processKeyValue(0x21f, 0)
        assert.equal(ha.getProperty(DEVICE_ID, 'button_sound', 'state'), 'OFF')
        assert.equal(ha.getProperty(DEVICE_ID, 'status_display', 'state'), 'ON')
        dev.drop()
    })

    test('raises the water tank warning only for the notification that means it', () => {
        const { ha, dev } = buildReadyDevice()

        // Captured by filling the tank until the appliance complained and then emptying
        // it: the id says which notification, the state says whether it is raised.
        dev.processKeyValue(0x2b1, 256)
        dev.processKeyValue(0x2b2, 1)
        assert.equal(ha.getProperty(DEVICE_ID, 'water_tank_full', 'state'), 'ON')

        dev.processKeyValue(0x2b2, 0)
        assert.equal(ha.getProperty(DEVICE_ID, 'water_tank_full', 'state'), 'OFF')

        // Some other notification must not be reported as a full tank.
        dev.processKeyValue(0x2b1, 4096)
        dev.processKeyValue(0x2b2, 1)
        assert.equal(ha.getProperty(DEVICE_ID, 'water_tank_full', 'state'), 'OFF')
        dev.drop()
    })

    test('offers target humidity in the steps the appliance accepts', () => {
        const { ha, thinq, dev } = buildReadyDevice()
        const number = ha.devices[DEVICE_ID].config?.components.target_humidity as Record<string, unknown>

        // The appliance only takes multiples of five and Home Assistant's humidifier
        // slider always moves one per cent at a time, so the value gets its own control.
        assert.equal(number.platform, 'number')
        assert.equal(number.step, 5)
        assert.equal(number.min, 30)
        assert.equal(number.max, 70)

        ha.setProperty(DEVICE_ID, 'target_humidity', 'command', '52')
        assert.deepEqual(thinq.outbox.map(hex), [WRITE_HUMIDITY_50_HEX])

        // Both entities sit on tag 0x253 and both have to hear it, or whichever one lost
        // the registration race goes stale while looking perfectly healthy.
        dev.processKeyValue(0x253, 65)
        assert.equal(ha.getProperty(DEVICE_ID, 'target_humidity', 'state'), 65)
        assert.equal(ha.getProperty(DEVICE_ID, 'dehumidifier', 'target_humidity_state'), 65)
        dev.drop()
    })

    test('constructor sends the standard capability query', () => {
        const { thinq, dev } = makeDevice()
        assert.equal(hex(thinq.outbox[0]), CAPS_REQUEST_HEX)
        dev.drop()
    })
})
