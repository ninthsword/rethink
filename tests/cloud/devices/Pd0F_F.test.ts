import assert from 'node:assert/strict'
import { test } from 'node:test'
import DUT from '@/cloud/devices/Pd0F_F'
import type { Metadata } from '@/cloud/thinq'
import { buf, MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'

const META: Metadata = { modelId: 'Pd0F_F', modelName: 'Pd0F_F', swVersion: '1.0' }
const LIVE_POWER_OFF = buf('AA2120EB00190000010001000000010000000000020002000001000000690035BB')

test('Pd0F_F names the states and errors its model defines', () => {
    // Taken from the MonitoringValue tables in LG's model JSON for Pd0F_F, whose keys are the
    // numbers the appliance puts on the wire, so no capture was needed to pair them. The
    // handler had ten of the twelve states and only the absence of an error.
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('mini-id', META)
    new DUT(ha.asConnection(), thinq, META)

    const report = (state: number, error: number) => {
        const rec = Buffer.alloc(27)
        rec[1] = 0x19
        rec[2] = state
        rec[22] = error
        thinq.emit('data', Buffer.concat([Buffer.from([0xaa, 0x21, 0x20, 0xeb]), rec, Buffer.from([0, 0xbb])]))
        return ha.devices['mini-id'].properties
    }

    assert.equal(report(10, 0).status, 'FIRMWARE')
    assert.equal(report(11, 0).status, 'DIAGNOSIS')

    for (const [code, name] of [
        [1, 'ERROR_IE'],
        [2, 'ERROR_OE'],
        [3, 'ERROR_UE'],
        [4, 'ERROR_DE1'],
        [5, 'ERROR_PE'],
        [8, 'ERROR_DO'],
        [9, 'ERROR_LE'],
        [10, 'ERROR_AE'],
        [11, 'ERROR_TE'],
        [12, 'ERROR_FE'],
        [16, 'ERROR_DE2'],
        [27, 'ERROR_FF'],
        [36, 'ERROR_E7'],
    ] as const) {
        const p = report(1, code)
        assert.equal(p.error_message, name)
        assert.equal(p.error, 'ON')
    }
})

test('Pd0F_F decodes the live mini-washer snapshot without unsafe controls', () => {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('mini-id', META)
    new DUT(ha.asConnection(), thinq, META)
    thinq.emit('data', LIVE_POWER_OFF)

    const device = ha.devices['mini-id']
    const p = device.properties
    assert.equal(p.power, 'OFF')
    assert.equal(p.status, 'POWEROFF')
    assert.equal(p.run_completed, 'OFF')
    assert.equal(p.previous_status, 'INITIAL')
    assert.equal(p.remaining_time, 0)
    assert.equal(p.initial_time, 0)
    assert.equal(p.error, 'OFF')
    assert.equal(p.error_message, 'NO_ERROR')
    assert.equal(device.config?.components.remote_start, undefined)
})
