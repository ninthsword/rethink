import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/PAC_910604_WW'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'
import * as TLV from '@/util/tlv'

const DEVICE_ID = 'test-id'
const META: Metadata = { modelId: 'PAC_910604_WW', modelName: 'PAC_910604_WW', swVersion: '640903' }

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    ha.on('setProperty', (id: string, prop: string, value: string) => dev.setProperty(prop, value))
    return { ha, thinq, dev }
}

function configureDevice() {
    const result = makeDevice()
    result.dev.raw_clip_state[0x1f7] = 1
    result.dev.raw_clip_state[0x1f9] = 0
    result.dev.raw_clip_state[0x1fa] = 0x0606
    result.dev.raw_clip_state[0x1fe] = 53
    result.dev.raw_clip_state[0x2cc] = 0
    result.dev.raw_clip_state[0x2d3] = 5
    result.dev.raw_clip_state[0x2b3] = 1
    result.dev.raw_clip_state[0x333] = 8
    result.dev.raw_clip_state[0x334] = 8
    result.dev.raw_clip_state[0x335] = 10
    result.dev.raw_clip_state[0x336] = 68
    result.dev.raw_clip_state[0x355] = 508
    result.dev.raw_clip_state[0x356] = 720
    ;(result.dev as unknown as { initMakeSetConfig(): void }).initMakeSetConfig()
    return result
}

describe('PAC_910604_WW', () => {
    test('exposes its live-confirmed controls and raw power value', () => {
        const { ha, thinq, dev } = configureDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>

        for (const component of [
            'airclean',
            'coolpower',
            'longpower',
            'energysave',
            'autodry',
            'autodryprogress',
            'displaylight',
            'smartcare',
            'humidity_sensor_mode',
            'energy_current_hour',
            'energy_today',
            'energy_month',
        ]) {
            assert.equal(
                components[component].platform,
                component.startsWith('energy_') || component === 'autodryprogress'
                    ? 'sensor'
                    : component === 'humidity_sensor_mode'
                      ? 'select'
                      : 'switch',
            )
        }

        assert.equal(components.autodryprogress.unit_of_measurement, '%')
        assert.equal(components.autodryprogress.suggested_display_precision, 0)
        assert.deepEqual(components.climate.fan_modes, [
            '약풍_약풍',
            '약풍_중풍',
            '약풍_강풍',
            '약풍_정지',
            '중풍_약풍',
            '중풍_중풍',
            '중풍_강풍',
            '중풍_정지',
            '강풍_약풍',
            '강풍_중풍',
            '강풍_강풍',
            '강풍_정지',
            '자동_자동',
            '정지_약풍',
            '정지_중풍',
            '정지_강풍',
        ])
        assert.deepEqual(components.climate.swing_horizontal_modes, ['정지', '우측회전', '좌측회전', '회전'])

        for (const component of ['humidity', 'pm1', 'pm25', 'pm10', 'filterremaining', 'sleep_time', 'stop_time'])
            assert.equal(components[component].platform, 'sensor')

        dev.processKeyValue(0x225, 37)
        assert.equal(ha.devices[DEVICE_ID].properties['autodryprogress-'], 37)

        for (const [component, expectedTag] of [
            ['energysave', 0x20d],
            ['autodry', 0x20e],
            ['airclean', 0x20f],
            ['displaylight', 0x21f],
            ['coolpower', 0x236],
            ['smartcare', 0x23e],
        ] as const) {
            thinq.resetRecorder()
            ha.setProperty(DEVICE_ID, component, 'command', 'ON')
            assert.equal(thinq.outbox.length, 1)
            assert.deepEqual(TLV.parse(thinq.outbox[0].subarray(11, thinq.outbox[0].length - 2)), [
                { t: expectedTag, l: 0, v: 1 },
            ])
        }

        dev.processKeyValue(0x2b3, 550)
        assert.equal(ha.devices[DEVICE_ID].properties['energy_current-'], 550)

        dev.processKeyValue(0x336, 68)
        dev.processKeyValue(0x333, 8)
        dev.processKeyValue(0x334, 9)
        dev.processKeyValue(0x335, 10)
        dev.processKeyValue(0x355, 508)
        dev.processKeyValue(0x21a, 45)
        dev.processKeyValue(0x21b, 90)
        assert.equal(ha.devices[DEVICE_ID].properties['climate-current_humidity'], 68)
        assert.equal(ha.devices[DEVICE_ID].properties.humidity, 68)
        assert.equal(ha.devices[DEVICE_ID].properties['pm1-'], 8)
        assert.equal(ha.devices[DEVICE_ID].properties['pm25-'], 9)
        assert.equal(ha.devices[DEVICE_ID].properties['pm10-'], 10)
        assert.equal(ha.devices[DEVICE_ID].properties['filterremaining-'], 70)
        assert.equal(ha.devices[DEVICE_ID].properties.sleep_time, 45)
        assert.equal(ha.devices[DEVICE_ID].properties.stop_time, 90)

        dev.processKeyValue(0x21f, 3)
        assert.equal(ha.devices[DEVICE_ID].properties['displaylight-'], 'OFF')
        dev.processKeyValue(0x21f, 1)
        assert.equal(ha.devices[DEVICE_ID].properties['displaylight-'], 'ON')

        dev.processKeyValue(0x337, 0)
        assert.equal(ha.devices[DEVICE_ID].properties['humidity_sensor_mode-'], '운전 중에만')
        thinq.resetRecorder()
        ha.setProperty(DEVICE_ID, 'humidity_sensor_mode', 'command', '항상')
        assert.deepEqual(thinq.outbox, [Buffer.from('01020400000065fd0100050c00000001a140', 'hex')])

        dev.processKeyValue(0x337, 1)
        assert.equal(ha.devices[DEVICE_ID].properties['humidity_sensor_mode-'], '항상')
        thinq.resetRecorder()
        ha.setProperty(DEVICE_ID, 'humidity_sensor_mode', 'command', '운전 중에만')
        assert.deepEqual(thinq.outbox, [Buffer.from('01020400000065fd0100050c00000000b161', 'hex')])
        dev.drop()
    })

    test('accumulates B115 interval energy and ignores immediate retransmissions', () => {
        const { ha, dev } = makeDevice()
        const report = (wh: number, seconds: number) => {
            const packet = Buffer.alloc(20)
            packet[6] = 0x87
            packet[7] = 0xfd
            packet[8] = 0x03
            packet[10] = 0xb1
            packet[11] = 0x15
            packet.writeUInt32LE(wh, 12)
            packet.writeUInt32LE(seconds, 16)
            dev.processData(packet)
        }

        report(123, 910)
        report(123, 910)
        report(142, 900)

        const properties = ha.devices[DEVICE_ID].properties
        assert.equal(properties.energy_current_hour, 265)
        assert.equal(properties.energy_today, 265)
        assert.equal(properties.energy_month, 0.265)
        dev.drop()
    })

    test('publishes standby power immediately when the appliance turns off', () => {
        const { ha, dev } = configureDevice()

        dev.processKeyValue(0x2b3, 38)
        assert.equal(ha.devices[DEVICE_ID].properties['energy_current-'], 38)

        dev.processKeyValue(0x1f7, 0)
        assert.equal(ha.devices[DEVICE_ID].properties['energy_current-'], 3)

        // Full state packets contain a stale 0x2B3 value after the OFF tag.
        dev.processKeyValue(0x2b3, 38)
        assert.equal(ha.devices[DEVICE_ID].properties['energy_current-'], 3)
        dev.drop()
    })

    test('polls fan-only at the active 28-second interval', () => {
        const { dev } = configureDevice()
        dev.raw_clip_state[0x1f9] = 5

        dev.updateClimateAction()

        assert.equal(dev.query_last_interval, 28_000)
        dev.drop()
    })

    test('turns the powered-off PAC on when an MQTT climate mode is selected', () => {
        const { ha, thinq, dev } = configureDevice()
        dev.raw_clip_state[0x1f7] = 0
        dev.raw_clip_state[0x1f9] = 1
        dev.raw_clip_state[0x1fa] = 0x0606
        dev.raw_clip_state[0x1fe] = 53
        thinq.resetRecorder()

        ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'cool')

        assert.equal(thinq.outbox.length, 1)
        assert.deepEqual(TLV.parse(thinq.outbox[0].subarray(11, thinq.outbox[0].length - 2)), [
            { t: 0x1f7, l: 0, v: 1 },
            { t: 0x1f9, l: 0, v: 0 },
            { t: 0x1fa, l: 2, v: 0x0606 },
            { t: 0x1fe, l: 1, v: 53 },
        ])
        assert.equal(dev.raw_clip_state[0x1f7], 1)
        assert.equal(dev.raw_clip_state[0x1f9], 0)
        dev.drop()
    })

    test('uses separate switches for Cool Power and Long Power when leaving fan-only', async () => {
        const coolPower = configureDevice()
        coolPower.dev.raw_clip_state[0x1f9] = 5
        coolPower.dev.raw_clip_state[0x1fa] = 0x0404
        coolPower.dev.raw_clip_state[0x1fe] = 56
        coolPower.thinq.resetRecorder()

        const longPower = configureDevice()
        longPower.dev.raw_clip_state[0x1f9] = 5
        longPower.dev.raw_clip_state[0x1fa] = 0x0404
        longPower.dev.raw_clip_state[0x1fe] = 56
        longPower.thinq.resetRecorder()

        let coolPackets: TLV.TLV[][] = []
        let longPackets: TLV.TLV[][] = []
        try {
            coolPower.ha.setProperty(DEVICE_ID, 'coolpower', 'command', 'ON')
            longPower.ha.setProperty(DEVICE_ID, 'longpower', 'command', 'ON')

            await new Promise((resolve) => setTimeout(resolve, 1800))

            coolPackets = coolPower.thinq.outbox.map((packet) => TLV.parse(packet.subarray(11, packet.length - 2)))
            longPackets = longPower.thinq.outbox.map((packet) => TLV.parse(packet.subarray(11, packet.length - 2)))
        } finally {
            coolPower.dev.drop()
            longPower.dev.drop()
        }

        assert.deepEqual(coolPackets, [[{ t: 0x236, l: 0, v: 1 }], [{ t: 0x20f, l: 0, v: 0 }]])
        assert.deepEqual(longPackets, [
            [
                { t: 0x1f9, l: 0, v: 0 },
                { t: 0x1fa, l: 2, v: 0x0404 },
                { t: 0x1fe, l: 1, v: 56 },
            ],
            [{ t: 0x20f, l: 0, v: 0 }],
            [
                { t: 0x1fa, l: 2, v: 0x0909 },
                { t: 0x1f9, l: 0, v: 0 },
                { t: 0x1fe, l: 1, v: 56 },
            ],
        ])
    })

    test('maps the dual outlets to the diagnostic fan-mode combinations', (t) => {
        const { ha, thinq, dev } = configureDevice()
        t.after(() => dev.drop())

        dev.processKeyValue(0x1fa, 0x0206)
        assert.equal(ha.devices[DEVICE_ID].properties['climate-fan_mode'], '약풍_강풍')
        assert.equal(ha.devices[DEVICE_ID].properties['longpower-'], 'OFF')

        thinq.resetRecorder()
        ha.setProperty(DEVICE_ID, 'climate', 'fan_mode_command', '정지_중풍')
        assert.deepEqual(TLV.parse(thinq.outbox[0].subarray(11, thinq.outbox[0].length - 2)), [
            { t: 0x1fa, l: 0, v: 0x0004 },
            { t: 0x1f9, l: 0, v: 0 },
            { t: 0x1fe, l: 1, v: 53 },
        ])

        dev.processKeyValue(0x1fa, 0x0909)
        assert.equal(ha.devices[DEVICE_ID].properties['longpower-'], 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties['climate-fan_mode'], '약풍_강풍')
    })
})
