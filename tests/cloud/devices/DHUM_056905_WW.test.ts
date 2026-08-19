import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/DHUM_056905_WW'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

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

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    ha.on('setProperty', (id: string, prop: string, value: string) => dev.setProperty(prop, value))
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
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>

        assert.equal(components.dehumidifier.platform, 'humidifier')
        assert.equal(components.dehumidifier.device_class, 'dehumidifier')
        assert.equal(components.dehumidifier.min_humidity, 30)
        assert.equal(components.dehumidifier.max_humidity, 70)
        assert.equal(ha.getProperty(DEVICE_ID, 'dehumidifier', 'state'), 'OFF')
        assert.equal(ha.getProperty(DEVICE_ID, 'dehumidifier', 'target_humidity_state'), 55)
        assert.equal(ha.getProperty(DEVICE_ID, 'dehumidifier', 'current_humidity'), 68)
        assert.equal(ha.getProperty(DEVICE_ID, 'temperature', 'state'), 28)
        assert.equal(ha.getProperty(DEVICE_ID, 'operation_mode', 'state'), 'smart')
        assert.equal(ha.getProperty(DEVICE_ID, 'fan_speed', 'state'), 'high')
        assert.equal(ha.getProperty(DEVICE_ID, 'error', 'state'), 'normal')

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

    test('constructor sends the standard capability query', () => {
        const { thinq, dev } = makeDevice()
        assert.equal(hex(thinq.outbox[0]), CAPS_REQUEST_HEX)
        dev.drop()
    })
})
