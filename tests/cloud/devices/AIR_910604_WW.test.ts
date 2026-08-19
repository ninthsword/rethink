/* Verifies confirmed AIR_910604_WW controls, monitor state, and MFilter response parsing.
 * Related files: cloud/devices/AIR_910604_WW.ts, cloud/ha_bridge.ts. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/AIR_910604_WW'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq1Device } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-air-purifier'
const MODEL_ID = 'AIR_910604_WW'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '2.6.7_RTOS_3K' }

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq1Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('config exposes only confirmed controls and sensors', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.deepEqual(Object.keys(components), [
            'fan',
            'air_fast',
            'air_removal',
            'sleep_timer',
            'pm1',
            'pm25',
            'pm10',
            'filter_remaining_time',
            'filter_remaining',
        ])
        assert.deepEqual(components.sleep_timer.options, ['Off', '2 hours', '4 hours', '8 hours', '12 hours'])
        assert.equal(components.fan.platform, 'fan')
        assert.equal(components.fan.state_topic, '$this/power')
        assert.equal(components.fan.command_topic, '$this/power/set')
        assert.deepEqual(components.fan.preset_modes, ['Low', 'Medium', 'High', 'Auto'])
        assert.equal(components.fan.preset_mode_state_topic, '$this/wind_strength')
        assert.equal(components.fan.preset_mode_command_topic, '$this/wind_strength/set')
        assert.equal(components.pm25.unit_of_measurement, 'µg/m³')
    })

    test('start requests only a monitor snapshot initially', () => {
        const { thinq, dev } = makeDevice()
        dev.start()
        assert.deepEqual(thinq.sent, [{ Cmd: 'Mon', CmdOpt: 'Start' }])
        dev.drop()
    })

    test('first monitor state stops the stream and then requests MFilter sequentially', async () => {
        const { thinq, dev } = makeDevice()
        dev.start()
        thinq.emit('data', Buffer.from('{"Operation":"1"}'))
        assert.deepEqual(thinq.sent, [
            { Cmd: 'Mon', CmdOpt: 'Start' },
            { Cmd: 'Mon', CmdOpt: 'Stop' },
        ])
        await new Promise((resolve) => setTimeout(resolve, 1_050))
        assert.deepEqual(thinq.sent, [
            { Cmd: 'Mon', CmdOpt: 'Start' },
            { Cmd: 'Mon', CmdOpt: 'Stop' },
            { Cmd: 'Config', CmdOpt: 'Get', Value: 'MFilter', Data: 'bnVsbA==' },
        ])
        dev.drop()
    })

    test('power commands use confirmed Operation values', () => {
        const { ha, thinq, dev } = makeDevice()
        dev.setProperty('power', 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'OFF')
        dev.setProperty('power', 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'ON')
        assert.deepEqual(thinq.sent, [
            { Cmd: 'Control', CmdOpt: 'Operation', Value: '0' },
            { Cmd: 'Control', CmdOpt: 'Operation', Value: '1' },
        ])
    })

    test('fast and sterilization switches use confirmed Set values', () => {
        const { ha, thinq, dev } = makeDevice()
        dev.setProperty('air_fast', 'ON')
        dev.setProperty('air_fast', 'OFF')
        dev.setProperty('air_removal', 'ON')
        dev.setProperty('air_removal', 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.air_fast, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.air_removal, 'OFF')
        assert.deepEqual(thinq.sent, [
            { Cmd: 'Control', CmdOpt: 'Set', Value: { AirFast: '1' } },
            { Cmd: 'Control', CmdOpt: 'Set', Value: { AirFast: '0' } },
            { Cmd: 'Control', CmdOpt: 'Set', Value: { AirRemoval: '1' } },
            { Cmd: 'Control', CmdOpt: 'Set', Value: { AirRemoval: '0' } },
        ])
    })

    test('sleep timer accepts only confirmed choices', () => {
        const { thinq, dev } = makeDevice()
        for (const option of ['Off', '2 hours', '4 hours', '8 hours', '12 hours', 'invalid']) {
            dev.setProperty('sleep_timer', option)
        }
        assert.deepEqual(
            thinq.sent.map((packet) => (packet as { Value: { SleepTime: string } }).Value.SleepTime),
            ['0', '120', '240', '480', '720'],
        )
    })

    test('fan speed accepts only the four captured values', () => {
        const { thinq, dev } = makeDevice()
        for (const option of ['Low', 'Medium', 'High', 'Auto', 'invalid']) dev.setProperty('wind_strength', option)
        assert.deepEqual(thinq.sent, [
            { Cmd: 'Control', CmdOpt: 'Set', Value: { WindStrength: '2' } },
            { Cmd: 'Control', CmdOpt: 'Set', Value: { WindStrength: '4' } },
            { Cmd: 'Control', CmdOpt: 'Set', Value: { WindStrength: '6' } },
            { Cmd: 'Control', CmdOpt: 'Set', Value: { WindStrength: '8' } },
        ])
    })

    test('monitor response publishes real control state, fan speed, and particulate matter', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit(
            'data',
            Buffer.from(
                '{"Operation":"1","WindStrength":"4","SleepTime":"120","SensorPM1":"8","SensorPM2":"9","SensorPM10":"10","AirFast":"1","AirRemoval":"0"}',
            ),
        )
        assert.deepEqual(ha.devices[DEVICE_ID].properties, {
            power: 'ON',
            air_fast: 'ON',
            air_removal: 'OFF',
            sleep_timer: '2 hours',
            wind_strength: 'Medium',
            pm1: 8,
            pm25: 9,
            pm10: 10,
        })
    })

    test('an ACK-only response after control starts immediate one-shot state reconciliation', async () => {
        const { thinq, dev } = makeDevice()
        dev.start()
        thinq.emit('data', Buffer.from('{"Operation":"1"}'))
        await new Promise((resolve) => setTimeout(resolve, 1_050))
        thinq.resetRecorder()

        dev.setProperty('air_fast', 'ON')
        assert.deepEqual(thinq.sent, [{ Cmd: 'Control', CmdOpt: 'Set', Value: { AirFast: '1' } }])
        thinq.emit('response', { ReturnCode: '0000' })
        await new Promise((resolve) => setTimeout(resolve, 10))
        assert.deepEqual(thinq.sent, [
            { Cmd: 'Control', CmdOpt: 'Set', Value: { AirFast: '1' } },
            { Cmd: 'Mon', CmdOpt: 'Start' },
        ])
        thinq.emit('data', Buffer.from('{"Operation":"1","AirFast":"1"}'))
        assert.deepEqual(thinq.sent[thinq.sent.length - 1], { Cmd: 'Mon', CmdOpt: 'Stop' })
        dev.drop()
    })

    test('MFilter response publishes remaining hours and percentage', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', Buffer.from('{"RemainTime":"2843","ChangePeriod":"4000"}'))
        assert.equal(ha.devices[DEVICE_ID].properties.filter_remaining_time, 2843)
        assert.equal(ha.devices[DEVICE_ID].properties.filter_remaining, 71.1)
    })

    test('invalid and unrelated data are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', Buffer.from('TimeZone=+0900,GroupType=12'))
        thinq.emit('data', Buffer.from('{"RemainTime":"x","ChangePeriod":"4000"}'))
        thinq.emit('data', Buffer.from('{"RemainTime":"100","ChangePeriod":"0"}'))
        assert.deepEqual(ha.devices[DEVICE_ID].properties, {})
    })
})
