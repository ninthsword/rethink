import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { MqttClient } from 'mqtt'
import { Connection, type DeviceDiscovery } from '@/cloud/homeassistant'

test('publishConfig retains the current model-specific MQTT discovery config', () => {
    const published: Array<{ topic: string; payload: string; options: unknown }> = []
    const connection = Object.create(Connection.prototype) as Connection

    Object.assign(connection, {
        config: {
            discovery_prefix: 'homeassistant',
            rethink_prefix: 'rethink',
        },
        client: {
            publish(topic: string, payload: string, options: unknown) {
                published.push({ topic, payload, options })
            },
        } as unknown as MqttClient,
        localizedCommandValues: new Map(),
        localizedStateValues: new Map(),
    })

    const config = {
        device: { identifiers: '$deviceid', model: 'PAC_910604_WW' },
        origin: { name: 'rethink' },
        components: {
            climate: {
                platform: 'climate',
                unique_id: '$deviceid-climate',
                mode_command_topic: '$this/climate-mode/set',
            },
        },
    } as unknown as DeviceDiscovery

    connection.publishConfig('pac-id', config)

    assert.equal(published.length, 1)
    assert.equal(published[0].topic, 'homeassistant/device/rethink/pac-id/config')
    assert.deepEqual(published[0].options, { retain: true })
    assert.deepEqual(JSON.parse(published[0].payload), {
        device: { identifiers: 'pac-id', model: 'PAC_910604_WW' },
        origin: { name: 'rethink' },
        components: {
            climate: {
                platform: 'climate',
                unique_id: 'pac-id-climate',
                mode_command_topic: 'rethink/pac-id/climate-mode/set',
            },
        },
    })
})

test('korean language localizes discovery and state while preserving HA protocol values', () => {
    const published: Array<{ topic: string; payload: string; options: unknown }> = []
    const connection = Object.create(Connection.prototype) as Connection
    Object.assign(connection, {
        config: {
            discovery_prefix: 'homeassistant',
            rethink_prefix: 'rethink',
            language: 'korean',
        },
        publishedAvailability: new Set<string>(),
        localizedCommandValues: new Map(),
        localizedStateValues: new Map(),
        client: {
            publish(topic: string, payload: string, options: unknown) {
                published.push({ topic, payload: String(payload), options })
            },
        } as unknown as MqttClient,
    })
    connection.setDeviceNameResolver((id) => (id === 'dryer-id' ? '의류건조기' : undefined))

    const config = {
        device: { identifiers: '$deviceid', model: 'RH16KR', name: 'LG Dryer' },
        origin: { name: 'rethink' },
        components: {
            status: {
                platform: 'sensor',
                unique_id: '$deviceid-status',
                name: 'Status',
                options: ['RUNNING', 'END'],
            },
            power: { platform: 'binary_sensor', unique_id: '$deviceid-power', name: 'Power' },
            climate: {
                platform: 'climate',
                unique_id: '$deviceid-climate',
                name: null,
                modes: ['smart', 'fan_only'],
                mode_state_topic: '$this/operation_mode',
                mode_command_topic: '$this/operation_mode/set',
                fan_modes: ['auto', 'low'],
                fan_mode_state_topic: '$this/climate-fan_mode',
                fan_mode_command_topic: '$this/climate-fan_mode/set',
            },
        },
    } as unknown as DeviceDiscovery

    connection.publishConfig('dryer-id', config)
    connection.publishProperty('dryer-id', 'status', 'RUNNING')
    connection.publishProperty('dryer-id', 'power', 'ON')
    connection.publishProperty('dryer-id', 'climate-fan_mode', 'auto')
    connection.publishProperty('dryer-id', 'operation_mode', 'smart')

    const discovery = JSON.parse(published[0].payload)
    assert.equal(discovery.components.status.name, '상태')
    assert.deepEqual(discovery.components.status.options, ['운전 중', '완료'])
    assert.equal(discovery.components.power.name, '전원')
    assert.equal(discovery.device.name, '의류건조기')
    assert.deepEqual(discovery.components.climate.modes, ['스마트', 'fan_only'])
    assert.deepEqual(discovery.components.climate.fan_modes, ['자동', '약'])
    assert.equal(published[1].payload, '운전 중')
    assert.equal(published[2].payload, 'ON')
    assert.equal(published[3].payload, '자동')
    assert.equal(published[4].payload, '스마트')
    assert.equal(connection.localizedCommandValues.get('dryer-id/operation_mode')?.get('스마트'), 'smart')
})

test('korean language localizes Korean appliance course values', () => {
    const published: Array<{ topic: string; payload: string }> = []
    const connection = Object.create(Connection.prototype) as Connection
    Object.assign(connection, {
        config: { discovery_prefix: 'homeassistant', rethink_prefix: 'rethink', language: 'korean' },
        publishedAvailability: new Set<string>(),
        localizedCommandValues: new Map(),
        localizedStateValues: new Map(),
        client: {
            publish(topic: string, payload: string) {
                published.push({ topic, payload: String(payload) })
            },
        } as unknown as MqttClient,
    })

    connection.publishProperty('dishwasher-id', 'current_download_course', 'FISH_DISH')
    connection.publishProperty('dryer-id', 'downloaded_course', 'SELFCLEANING')

    assert.equal(published[0].payload, '생선 요리')
    assert.equal(published[1].payload, '자가 세척')
})
