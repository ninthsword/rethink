import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import Bridge from '@/cloud/ha_bridge'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'
import { normalize, type RawConfig } from '@/util/config'

const META: Metadata = { modelId: 'Hd0C_F', modelName: 'Hd0C_F', swVersion: '2.10.93' }

class AvailabilityRecordingHA extends MockHAConnection {
    availabilityHistory: string[] = []

    override publishProperty(id: string, property: string, value: string | number) {
        super.publishProperty(id, property, value)
        if (property === 'availability') this.availabilityHistory.push(String(value))
    }
}

describe('HA bridge device replacement', () => {
    test('does not publish offline while atomically replacing a live connection', async () => {
        const ha = new AvailabilityRecordingHA()
        const bridge = new Bridge(ha.asConnection(), 20)
        const oldConnection = new MockThinq2Device('washer-id', META)
        const newConnection = new MockThinq2Device('washer-id', META)

        bridge.newDevice(oldConnection)
        ha.availabilityHistory = []

        bridge.newDevice(newConnection)
        assert.deepEqual(ha.availabilityHistory, ['online'])

        // Closing the superseded connection must not affect the replacement.
        oldConnection.emit('close')
        assert.deepEqual(ha.availabilityHistory, ['online'])

        // A genuine close of the active connection still publishes offline.
        newConnection.emit('close')
        await new Promise((resolve) => setTimeout(resolve, 30))
        assert.deepEqual(ha.availabilityHistory, ['online', 'offline'])
    })

    test('suppresses a brief offline blip when disconnect precedes re-registration', async () => {
        const ha = new AvailabilityRecordingHA()
        const bridge = new Bridge(ha.asConnection(), 20)
        const oldConnection = new MockThinq2Device('washer-id', META)
        const newConnection = new MockThinq2Device('washer-id', META)

        bridge.newDevice(oldConnection)
        ha.availabilityHistory = []

        oldConnection.emit('close')
        await new Promise((resolve) => setTimeout(resolve, 5))
        bridge.newDevice(newConnection)
        await new Promise((resolve) => setTimeout(resolve, 30))

        assert.deepEqual(ha.availabilityHistory, ['online'])
    })

    test('keeps entities available across a reconnect gap shorter than the grace', async () => {
        // LG appliances power their Wi-Fi module down while idle and reconnect on
        // their own standby cycle. With the former 2 second grace every entity went
        // "unavailable" on that cycle, so the grace is configurable and defaults to
        // half an hour.
        const ha = new AvailabilityRecordingHA()
        const bridge = new Bridge(ha.asConnection(), 200)
        const oldConnection = new MockThinq2Device('washer-id', META)
        const newConnection = new MockThinq2Device('washer-id', META)

        bridge.newDevice(oldConnection)
        ha.availabilityHistory = []

        oldConnection.emit('close')
        await new Promise((resolve) => setTimeout(resolve, 60))
        // Still available: the appliance has not exceeded its grace yet.
        assert.deepEqual(ha.availabilityHistory, [])

        bridge.newDevice(newConnection)
        await new Promise((resolve) => setTimeout(resolve, 200))
        assert.deepEqual(ha.availabilityHistory, ['online'])
        newConnection.emit('close')
    })
})

describe('offline grace configuration', () => {
    test('defaults to half an hour and is overridable', () => {
        const base = { hostname: 'rethink.lan', homeassistant: {} } as unknown as RawConfig
        assert.equal(normalize(base).homeassistant.offline_grace_seconds, 1800)

        const overridden = {
            hostname: 'rethink.lan',
            homeassistant: { offline_grace_seconds: 60 },
        } as unknown as RawConfig
        assert.equal(normalize(overridden).homeassistant.offline_grace_seconds, 60)
    })
})
