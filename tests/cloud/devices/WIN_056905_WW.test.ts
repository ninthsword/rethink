import assert from 'node:assert/strict'
import { describe, type TestContext, test } from 'node:test'
import DUT from '@/cloud/devices/WIN_056905_WW'
import { hex, MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'
import * as TLV from '@/util/tlv'

// Synthetic fixtures derived from the existing handler's field definitions, not hardware captures.
const ID = 'synthetic-window-ac'
const META = { modelId: 'WIN_056905_WW', modelName: 'LW1823HRSM' }
const VALUES: TLV.TLV[] = [
    { t: 0x1f7, v: 1 },
    { t: 0x1f9, v: 0 },
    { t: 0x1fa, v: 2 },
    { t: 0x1fd, v: 43 },
    { t: 0x1fe, v: 45 },
    { t: 0x322, v: 100 },
    { t: 0x300, v: 0 },
    { t: 0x301, v: 0 },
    { t: 0x302, v: 0 },
    { t: 0x303, v: 0 },
]

function frame(values: TLV.TLV[], sequence: number, kind = 4) {
    const payload = TLV.build(values)
    // This inbound TLV path delegates CRC verification to the modem.
    return Buffer.from([0, 0, 4, 0, 0, 0, 0x87, 2, kind, sequence, payload.length, ...payload, 0, 0])
}

function makeDevice(t: TestContext) {
    enableMockTimers(t)
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    t.after(() => dev.drop())
    ha.on('setProperty', (_id: string, property: string, value: string) => dev.setProperty(property, value))
    return { ha, thinq, dev }
}

function readyDevice(t: TestContext) {
    const fixture = makeDevice(t)
    fixture.thinq.emit('data', frame([{ t: 0x2da, v: 1 }], 1, 1))
    fixture.thinq.emit('data', frame(VALUES, 2))
    tickMockTimers(t, 1000)
    fixture.thinq.resetRecorder()
    return fixture
}

function fields(packet: Buffer) {
    assert.equal(hex(packet.subarray(0, 10)), '01010400000065020101')
    assert.equal(packet[10], packet.length - 13)
    return TLV.parse(packet.subarray(11, -2)).map(({ t, v }) => ({ t, v }))
}

describe('WIN_056905_WW synthetic protocol coverage', () => {
    test('queries capabilities, accepts all supported markers, and requires a full values response', (t) => {
        const { dev, thinq } = makeDevice(t)
        assert.equal(hex(thinq.outbox[0]), '01010400000065020201027D416A0D')
        for (const tag of [0x2da, 0x2db, 0x2c1]) assert.equal(dev.isCapsResponse([{ t: tag, v: 1 }]), true)
        assert.equal(dev.isCapsResponse([{ t: 0x300, v: 1 }]), false)
        assert.equal(dev.isValuesResponse(VALUES), true)
        assert.equal(dev.isValuesResponse(VALUES.slice(0, 9)), false)
        assert.equal(
            dev.isValuesResponse(VALUES.map((entry) => (entry.t === 0x1f7 ? { t: 0x304, v: 1 } : entry))),
            false,
        )
        thinq.resetRecorder()
        thinq.emit('data', frame([{ t: 0x2db, v: 1 }], 1, 1))
        assert.equal(hex(thinq.outbox[0]), '01010400000065020201027D425A6E')
        assert.equal(dev.query_caps_timeout, undefined)
        thinq.emit('data', frame(VALUES, 2))
        assert.equal(dev.query_values_timeout, undefined)
    })

    test('publishes climate discovery and half-degree temperatures from synthetic TLV values', (t) => {
        const { ha } = readyDevice(t)
        const climate = ha.devices[ID].config?.components.climate as Record<string, unknown>
        assert.equal(climate.platform, 'climate')
        assert.deepEqual(climate.modes, ['off', 'cool', 'fan_only', 'heat'])
        assert.deepEqual(climate.fan_modes, ['low', 'high'])
        assert.deepEqual(climate.swing_modes, ['on', 'off'])
        assert.equal(climate.temp_step, 0.5)
        assert.equal(climate.precision, 0.5)
        assert.equal(ha.getProperty(ID, 'climate', 'current_temperature'), 21.5)
        assert.equal(ha.getProperty(ID, 'climate', 'temperature_state'), 22.5)
        assert.equal(ha.getProperty(ID, 'climate', 'mode_state'), 'cool')
        assert.equal(ha.getProperty(ID, 'climate', 'fan_mode_state'), 'low')
        assert.equal(ha.getProperty(ID, 'climate', 'swing_mode_state'), 'on')
    })

    test('power controls the reported mode while unsupported mode values are omitted', (t) => {
        const { dev, ha } = readyDevice(t)
        for (const [raw, expected] of [
            [0, 'cool'],
            [2, 'fan_only'],
            [4, 'heat'],
        ] as const) {
            dev.processKeyValue(0x1f9, raw)
            assert.equal(ha.getProperty(ID, 'climate', 'mode_state'), expected)
        }
        dev.processKeyValue(0x1f9, 1)
        assert.equal(ha.getProperty(ID, 'climate', 'mode_state'), 'heat')
        dev.processKeyValue(0x1f7, 0)
        assert.equal(ha.getProperty(ID, 'climate', 'mode_state'), 'off')
        dev.processKeyValue(0x1f9, 2)
        dev.processKeyValue(0x1f7, 1)
        assert.equal(ha.getProperty(ID, 'climate', 'mode_state'), 'fan_only')
    })

    test('power and mode writes retain their existing TLV fields and attachments', (t) => {
        const { dev, ha, thinq } = readyDevice(t)
        const warn = t.mock.method(console, 'warn', () => {})
        dev.setProperty('climate-power', 'OFF')
        assert.deepEqual(fields(thinq.outbox[0]), [{ t: 0x1f7, v: 0 }])
        dev.setProperty('climate-power', 'ON')
        assert.deepEqual(fields(thinq.outbox[1]), [
            { t: 0x1f7, v: 1 },
            { t: 0x1f9, v: 0 },
        ])
        for (const [mode, raw] of [
            ['cool', 0],
            ['fan_only', 2],
            ['heat', 4],
        ] as const) {
            thinq.resetRecorder()
            const previousMode = dev.raw_clip_state[0x1f9]
            ha.setProperty(ID, 'climate', 'mode_command', mode)
            assert.equal(thinq.outbox.length, 2)
            assert.deepEqual(fields(thinq.outbox[0]), [
                { t: 0x1f7, v: 1 },
                { t: 0x1f9, v: previousMode },
            ])
            assert.deepEqual(fields(thinq.outbox[1]), [
                { t: 0x1f9, v: raw },
                { t: 0x1f7, v: 1 },
                { t: 0x1fa, v: 2 },
                { t: 0x1fe, v: 45 },
                { t: 0x322, v: 100 },
            ])
        }
        assert.equal(warn.mock.callCount(), 0)
    })

    test('HA off sends only power off without changing the remembered mode', (t) => {
        const { dev, ha, thinq } = readyDevice(t)
        const warn = t.mock.method(console, 'warn', () => {})
        dev.processKeyValue(0x1f9, 4)
        ha.setProperty(ID, 'climate', 'mode_command', 'off')
        assert.equal(thinq.outbox.length, 1)
        assert.deepEqual(fields(thinq.outbox[0]), [{ t: 0x1f7, v: 0 }])
        assert.equal(dev.raw_clip_state[0x1f7], 0)
        assert.equal(dev.raw_clip_state[0x1f9], 4)
        assert.equal(warn.mock.callCount(), 0)
    })

    for (const [mode, raw] of [
        ['cool', 0],
        ['fan_only', 2],
        ['heat', 4],
        ['dry', 8],
    ] as const) {
        test(`HA ${mode} from observed power off sends power on before the mapped mode`, (t) => {
            const { dev, ha, thinq } = readyDevice(t)
            const warn = t.mock.method(console, 'warn', () => {})
            dev.processKeyValue(0x1f9, 2)
            dev.processKeyValue(0x1f7, 0)
            assert.equal(ha.getProperty(ID, 'climate', 'mode_state'), 'off')
            ha.setProperty(ID, 'climate', 'mode_command', mode)
            assert.equal(thinq.outbox.length, 2)
            assert.deepEqual(fields(thinq.outbox[0]), [
                { t: 0x1f7, v: 1 },
                { t: 0x1f9, v: 2 },
            ])
            assert.deepEqual(fields(thinq.outbox[1]), [
                { t: 0x1f9, v: raw },
                { t: 0x1f7, v: 1 },
                { t: 0x1fa, v: 2 },
                { t: 0x1fe, v: 45 },
                { t: 0x322, v: 100 },
            ])
            assert.equal(dev.raw_clip_state[0x1f7], 1)
            assert.equal(dev.raw_clip_state[0x1f9], raw)
            assert.equal(warn.mock.callCount(), 0)
        })
    }

    test('invalid HA modes have no packets, state changes, warnings or deferred refresh', (t) => {
        const { dev, ha, thinq } = readyDevice(t)
        const warn = t.mock.method(console, 'warn', () => {})
        for (const power of [0, 1]) {
            dev.processKeyValue(0x1f7, power)
            for (const mode of [
                'constructor',
                'toString',
                '__proto__',
                'hasOwnProperty',
                '',
                'unknown',
                'COOL',
                ' cool',
            ]) {
                const before = { ...dev.raw_clip_state }
                const properties = { ...ha.devices[ID].properties }
                ha.setProperty(ID, 'climate', 'mode_command', mode)
                assert.deepEqual(dev.raw_clip_state, before, mode)
                assert.deepEqual(ha.devices[ID].properties, properties, mode)
                tickMockTimers(t, 2000)
                assert.equal(thinq.outbox.length, 0, mode)
            }
        }
        assert.equal(warn.mock.callCount(), 0)
    })

    test('temperature clamps and rounds while fan and swing writes preserve mode attachments', (t) => {
        const { ha, thinq, dev } = readyDevice(t)
        for (const [temperature, raw] of [
            ['10', 32],
            ['35', 60],
            ['22.3', 45],
        ] as const) {
            thinq.resetRecorder()
            ha.setProperty(ID, 'climate', 'temperature_command', temperature)
            assert.deepEqual(fields(thinq.outbox[0]), [
                { t: 0x1fe, v: raw },
                { t: 0x1f9, v: 0 },
                { t: 0x1fa, v: 2 },
            ])
        }
        for (const [mode, raw] of [
            ['low', 2],
            ['high', 6],
        ] as const) {
            thinq.resetRecorder()
            ha.setProperty(ID, 'climate', 'fan_mode_command', mode)
            assert.deepEqual(fields(thinq.outbox[0]), [
                { t: 0x1fa, v: raw },
                { t: 0x1f9, v: 0 },
                { t: 0x1fe, v: 45 },
            ])
            dev.processKeyValue(0x1fa, raw)
            assert.equal(ha.getProperty(ID, 'climate', 'fan_mode_state'), mode)
        }
        for (const [mode, raw] of [
            ['off', 0],
            ['on', 100],
        ] as const) {
            thinq.resetRecorder()
            ha.setProperty(ID, 'climate', 'swing_mode_command', mode)
            assert.deepEqual(fields(thinq.outbox[0]), [
                { t: 0x322, v: raw },
                { t: 0x1f9, v: 0 },
                { t: 0x1fa, v: 6 },
            ])
            dev.processKeyValue(0x322, raw)
            assert.equal(ha.getProperty(ID, 'climate', 'swing_mode_state'), mode)
        }
    })
})
