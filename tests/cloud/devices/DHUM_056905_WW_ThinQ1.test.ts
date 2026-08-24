import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import DUT from '@/cloud/devices/DHUM_056905_WW_ThinQ1'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq1Device } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-thinq1-dehumidifier'
const META: Metadata = { modelId: 'DHUM_056905_WW', modelName: 'DHUM_056905_WW', swVersion: '2.6.7_RTOS_3K' }

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq1Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe('ThinQ1 DHUM_056905_WW', () => {
    test('discovery exposes the model-confirmed entities and ranges', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config?.components as Record<string, Record<string, unknown>>
        assert.deepEqual(Object.keys(components), [
            'dehumidifier',
            'target_humidity',
            'fan_speed',
            'water_tank_light',
            'clean_dry',
            'sensor_mode',
            'off_timer',
            'off_time',
            'error',
        ])
        // The appliance only takes multiples of five and Home Assistant's humidifier
        // slider always moves one per cent at a time, so the value gets its own control
        // sharing the same topics.
        assert.equal(components.target_humidity.step, 5)
        assert.equal(components.target_humidity.min, 30)
        assert.equal(components.target_humidity.max, 70)
        // SupportReserve advertises @AP_SIMPLE_TIMER_DHUM_8, so the slider stops at eight
        // hours and moves an hour at a time.
        assert.equal(components.off_timer.min, 0)
        assert.equal(components.off_timer.max, 8)
        assert.equal(components.off_timer.step, 1)
        assert.deepEqual(components.dehumidifier.modes, [
            'smart',
            'fast',
            'silent',
            'concentrated_drying',
            'clothing_drying',
        ])
        assert.equal(components.dehumidifier.min_humidity, 30)
        assert.equal(components.dehumidifier.max_humidity, 70)
        assert.deepEqual(components.fan_speed.options, ['low', 'medium', 'high', 'power'])
    })

    test('start requests a one-shot monitor snapshot', () => {
        const { thinq, dev } = makeDevice()
        dev.start()
        assert.deepEqual(thinq.sent, [{ Cmd: 'Mon', CmdOpt: 'Start' }])
        dev.drop()
    })

    test('diagnostic monitor snapshot decodes exact installed-model values', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit(
            'data',
            Buffer.from(
                JSON.stringify({
                    Operation: '0',
                    OpMode: '17',
                    HumidityCfg: '50',
                    WindStrength: '6',
                    SensorHumidity: '65',
                    WatertankLight: '1',
                    CleanDry: '0',
                    SensorMon: '1',
                    DiagCode: '00',
                }),
            ),
        )
        assert.deepEqual(ha.devices[DEVICE_ID].properties, {
            power: 'OFF',
            target_humidity: 50,
            current_humidity: 65,
            operation_mode: 'smart',
            fan_speed: 'high',
            sensor_mode: 'always',
            water_tank_light: 'ON',
            clean_dry: 'OFF',
            error: 'normal',
        })
    })

    test('control packets follow the ThinQ1 model ControlWifi schema', () => {
        const { thinq, dev } = makeDevice()
        // The reservation is only accepted while the appliance runs, and setProperty here
        // starts from an unknown power state, so announce it first.
        thinq.emit('data', Buffer.from(JSON.stringify({ Operation: '1' })))
        thinq.resetRecorder()
        dev.setProperty('power', 'ON')
        dev.setProperty('power', 'OFF')
        dev.setProperty('target_humidity', '53')
        dev.setProperty('operation_mode', 'silent')
        dev.setProperty('fan_speed', 'power')
        dev.setProperty('water_tank_light', 'OFF')
        dev.setProperty('clean_dry', 'ON')
        dev.setProperty('sensor_mode', 'operating_only')
        dev.setProperty('off_timer', '2')
        assert.deepEqual(thinq.sent, [
            { Cmd: 'Control', CmdOpt: 'Operation', Value: 'Start' },
            { Cmd: 'Control', CmdOpt: 'Operation', Value: 'Stop' },
            { Cmd: 'Control', CmdOpt: 'Set', Value: { HumidityCfg: '55' } },
            { Cmd: 'Control', CmdOpt: 'Set', Value: { OpMode: '19' } },
            { Cmd: 'Control', CmdOpt: 'Set', Value: { WindStrength: '7' } },
            { Cmd: 'Control', CmdOpt: 'Set', Value: { WatertankLight: '0' } },
            { Cmd: 'Control', CmdOpt: 'Set', Value: { CleanDry: '1' } },
            { Cmd: 'Config', CmdOpt: 'Set', Value: { SensorMon: '0' } },
            // The schema documents OffTime in minutes: "1시간일 경우 60으로 데이터 받음".
            { Cmd: 'Control', CmdOpt: 'Set', Value: { OffTime: '120' } },
        ])
    })

    test('the turn-off reservation reads back as the hour it has left', () => {
        const { ha, thinq, dev } = makeDevice()

        // The appliance counts the reservation down every minute, so 119 minutes left is
        // still the two hours the slider can show.
        thinq.emit('data', Buffer.from(JSON.stringify({ Operation: '1', OffTime: '119' })))
        assert.equal(ha.devices[DEVICE_ID].properties.off_timer, 2)
        // The slider cannot say 119, so the companion sensor carries the minutes it drops.
        assert.equal(ha.devices[DEVICE_ID].properties.off_time, 119)
        thinq.resetRecorder()

        // The appliance offers eight hours, so a larger request is clamped rather than
        // dropped, which would have left Home Assistant showing a value it never took.
        dev.setProperty('off_timer', '12')
        assert.deepEqual(thinq.sent[thinq.sent.length - 1], {
            Cmd: 'Control',
            CmdOpt: 'Set',
            Value: { OffTime: '480' },
        })
    })

    test('invalid values are ignored', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('target_humidity', '100')
        dev.setProperty('operation_mode', 'invalid')
        dev.setProperty('fan_speed', 'auto')
        dev.setProperty('sensor_mode', 'invalid')
        dev.setProperty('off_timer', 'nonsense')
        assert.deepEqual(thinq.sent, [])

        // A reservation while the appliance is off is dropped rather than sent.
        thinq.emit('data', Buffer.from(JSON.stringify({ Operation: '0' })))
        thinq.resetRecorder()
        dev.setProperty('off_timer', '2')
        assert.deepEqual(thinq.sent, [])
    })
})
