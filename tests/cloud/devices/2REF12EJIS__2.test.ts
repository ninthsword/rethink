import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import DUT from '@/cloud/devices/2REF12EJIS__2'
import type { Metadata } from '@/cloud/thinq'
import { buf, hex, MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const META: Metadata = { modelId: '2REF12EJIS__2', modelName: '2REF12EJIS__2', swVersion: '1.0' }

// Live captures: old status followed by current status (18 bytes each).
const BASE = '020705010702FF0001000100FFFFFFFFFF01'
const OPEN = '020705010702FF0101000100FFFFFFFFFF01'
const LOCKED = '020705010702FF0001000200FFFFFFFFFF01'
const STATUS_CLOSED = buf(`AA2A10EC${OPEN}${BASE}AEBB`)
const STATUS_OPEN = buf(`AA2A10EC${BASE}${OPEN}AEBB`)
const INITIAL = buf(`AA1810EB${BASE}87BB`)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe('2REF12EJIS__2', () => {
    test('publishes supported components and decodes captured status', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATUS_CLOSED)
        const device = ha.devices[DEVICE_ID]
        const components = device.config?.components as Record<string, Record<string, unknown>>
        assert.deepEqual(Object.keys(components), [
            'fridge_setpoint',
            'freezer_setpoint',
            'express_freeze',
            'door',
            'fridge_door',
            'freezer_door',
            'control_panel_lock',
        ])
        assert.equal(device.properties.fridge_setpoint, 1)
        assert.equal(device.properties.freezer_setpoint, -19)
        assert.equal(device.properties.express_freeze, 'OFF')
        assert.equal(device.properties.door, 'OFF')
        assert.equal(device.properties.control_panel_lock, 'OFF')
    })

    test('decodes the physical control-panel touch lock as read-only state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf(`AA2A10EC${BASE}${LOCKED}AEBB`))
        assert.equal(ha.devices[DEVICE_ID].properties.control_panel_lock, 'ON')
        thinq.emit('data', buf(`AA2A10EC${LOCKED}${BASE}AEBB`))
        assert.equal(ha.devices[DEVICE_ID].properties.control_panel_lock, 'OFF')
    })

    test('decodes the 10EB initial status sent after reconnect', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', INITIAL)
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_setpoint, 1)
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_setpoint, -19)
        assert.equal(ha.devices[DEVICE_ID].properties.express_freeze, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'OFF')
    })

    test('decodes persistent overall-door state and zone door events', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATUS_OPEN)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'ON')
        thinq.emit('data', buf('AA0810A8010139BB'))
        thinq.emit('data', buf('AA0810A8020138BB'))
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_door, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_door, 'ON')
        thinq.emit('data', buf('AA0810A801003EBB'))
        thinq.emit('data', buf('AA0810A8020039BB'))
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_door, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_door, 'OFF')
    })

    test('writes captured F017 layouts for temperature and express freeze', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', STATUS_CLOSED)
        thinq.resetRecorder()

        dev.setProperty('fridge_setpoint', '2')
        const packet = thinq.outbox.pop()
        assert.ok(packet)
        assert.equal(
            hex(packet),
            'AA2FF017020605010702FF0001000100FFFFFFFFFF01FFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFFB7BB',
        )
        dev.setProperty('freezer_setpoint', '-20')
        assert.equal(thinq.outbox.pop()?.[4 + 2], 6)
        dev.setProperty('express_freeze', 'ON')
        assert.equal(thinq.outbox.pop()?.[4 + 3], 2)
    })

    test('does not write before status or accept out-of-range values', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('fridge_setpoint', '2')
        assert.equal(thinq.outbox.length, 0)
        thinq.emit('data', STATUS_CLOSED)
        dev.setProperty('fridge_setpoint', '8')
        dev.setProperty('freezer_setpoint', '-24')
        dev.setProperty('express_freeze', 'invalid')
        assert.equal(thinq.outbox.length, 0)
    })
})
