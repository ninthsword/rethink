import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import Bridge from '@/cloud/ha_bridge'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq1Device, MockThinq2Device } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'
import { normalize, type RawConfig } from '@/util/config'

const META: Metadata = { modelId: 'Hd0C_F', modelName: 'Hd0C_F', swVersion: '2.10.93' }

/** The same appliance after LG renamed its model, which is what this dryer actually did. */
const RENAMED: Metadata = { modelId: 'RH16_UNKNOWN_KR', modelName: 'RH16KR', swVersion: '2.9.66' }

class AvailabilityRecordingHA extends MockHAConnection {
    availabilityHistory: string[] = []

    override publishProperty(id: string, property: string, value: string | number) {
        super.publishProperty(id, property, value)
        if (property === 'availability') this.availabilityHistory.push(String(value))
    }
}

describe('HA bridge device replacement', () => {
    test('does not instantiate inherited handlers from external model metadata', () => {
        const ha = new MockHAConnection()
        const bridge = new Bridge(ha.asConnection())

        assert.doesNotThrow(() => {
            bridge.newDevice(
                new MockThinq1Device('bad-thinq1', {
                    modelId: '__proto__',
                    modelName: 'constructor',
                    swVersion: '1.0',
                }),
            )
            bridge.newDevice(
                new MockThinq2Device('bad-thinq2', {
                    modelId: 'toString',
                    modelName: '__proto__',
                    swVersion: '1.0',
                }),
            )
        })
        assert.equal(ha.devices['bad-thinq1'], undefined)
        assert.equal(ha.devices['bad-thinq2'], undefined)
    })

    test('still instantiates registered ThinQ1 and ThinQ2 handlers', (t) => {
        enableMockTimers(t)
        const ha = new MockHAConnection()
        const bridge = new Bridge(ha.asConnection())

        bridge.newDevice(
            new MockThinq1Device('ordinary-thinq1', {
                modelId: 'WTDN3',
                modelName: 'WTDN3',
                swVersion: '1.0',
            }),
        )
        bridge.newDevice(
            new MockThinq2Device('ordinary-thinq2', {
                modelId: 'RAC_056905_WW',
                modelName: 'RAC_056905_WW',
                swVersion: '1.0',
            }),
        )

        assert.ok(ha.devices['ordinary-thinq1'])
        assert.ok(bridge.haDevices.get('ordinary-thinq2'))
    })

    test('an appliance whose model id was renamed is still matched by its model name', (t) => {
        // This dryer went from RH16KR to RH16_N_KR with a firmware update and kept working
        // only because someone added the new id by hand. The two fields do not always move
        // together, so whichever one still names a handler is the one to use.
        enableMockTimers(t)
        const ha = new MockHAConnection()
        const bridge = new Bridge(ha.asConnection(), 20)
        const thinq = new MockThinq2Device('renamed-dryer', RENAMED)

        bridge.newDevice(thinq)

        assert.ok(ha.devices['renamed-dryer'], 'no handler was found for the renamed model')
    })

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
    // normalize() now insists on a configuration that would actually start, so these carry
    // the settings it checks rather than the two fields the assertion is about.
    const base = {
        hostname: 'rethink.lan',
        ca_key_file: 'ca.key',
        ca_cert_file: 'ca.cert',
        https_port: 4433,
        mqtts_port: 8883,
        mqtt_port: 1884,
        homeassistant: {
            mqtt_url: 'mqtt://127.0.0.1:1883',
            discovery_prefix: 'homeassistant',
            rethink_prefix: 'rethink',
            mqtt_user: 'user',
            mqtt_pass: 'pass',
        },
    } as unknown as RawConfig

    test('defaults to half an hour and is overridable', () => {
        assert.equal(normalize(base).homeassistant.offline_grace_seconds, 1800)

        const overridden = {
            ...base,
            homeassistant: { ...base.homeassistant, offline_grace_seconds: 60 },
        } as unknown as RawConfig
        assert.equal(normalize(overridden).homeassistant.offline_grace_seconds, 60)
    })
})

describe('a handler that has been superseded', () => {
    const TLV_META: Metadata = { modelId: 'RAC_056905_WW', modelName: 'TEST', swVersion: '1.0' }

    test('stops asking the appliance once its connection has been replaced', (t) => {
        enableMockTimers(t)
        const ha = new AvailabilityRecordingHA()
        const bridge = new Bridge(ha.asConnection(), 30 * 60 * 1000)
        const first = new MockThinq2Device('ac-id', TLV_META)

        bridge.newDevice(first)
        // The capabilities query is retried every fifteen seconds until the appliance
        // answers, so the superseded handler has a live interval to leak.
        tickMockTimers(t, 30_000)
        const asked = first.outbox.length
        assert.ok(asked > 0, 'the first handler should have been querying')

        const second = new MockThinq2Device('ac-id', TLV_META)
        bridge.newDevice(second)
        first.emit('close')
        tickMockTimers(t, 60_000)

        /*
         * send() publishes onto the broker topic the live appliance is subscribed to, so a
         * handler that keeps its timers keeps querying the real appliance — and, never
         * hearing an answer, eventually reports the live appliance as unavailable.
         */
        assert.equal(first.outbox.length, asked, 'the superseded handler must stop querying')
    })

    test('lets go of every timer it was holding', (t) => {
        enableMockTimers(t)
        const ha = new AvailabilityRecordingHA()
        const bridge = new Bridge(ha.asConnection(), 30 * 60 * 1000)

        bridge.newDevice(new MockThinq2Device('ac-id', TLV_META))
        const superseded = bridge.haDevices.get('ac-id') as unknown as Record<string, unknown>
        assert.notEqual(superseded.query_caps_timeout, undefined, 'the first handler should be retrying')

        bridge.newDevice(new MockThinq2Device('ac-id', TLV_META))

        /*
         * Left running, this interval would keep the handler alive and keep it querying an
         * appliance that answers a different object — and after three unanswered refreshes
         * it publishes offline under the id the replacement is using.
         */
        assert.equal(superseded.query_caps_timeout, undefined, 'the superseded handler kept a timer')
        assert.equal(superseded.query_values_timeout, undefined)
        assert.equal(superseded.query_timer, undefined)
        assert.notEqual(bridge.haDevices.get('ac-id'), superseded, 'the replacement should be in charge')
    })
})
