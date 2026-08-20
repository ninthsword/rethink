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

test('publishConfig does not replace a valid retained config with an invalid one', () => {
    const published: Array<{ topic: string; payload: string }> = []
    const connection = Object.create(Connection.prototype) as Connection
    Object.assign(connection, {
        config: { discovery_prefix: 'homeassistant', rethink_prefix: 'rethink' },
        client: {
            publish(topic: string, payload: string) {
                published.push({ topic, payload })
            },
        } as unknown as MqttClient,
        localizedCommandValues: new Map(),
        localizedStateValues: new Map(),
    })

    connection.publishConfig('bad-id', {
        device: { identifiers: '$deviceid', name: 'Bad appliance' },
        origin: { name: 'rethink' },
        components: {
            mode: {
                platform: 'select',
                unique_id: '$deviceid-mode',
                options: ['normal'],
            },
        },
    } as unknown as DeviceDiscovery)

    assert.equal(published.length, 0)
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
                state_topic: '$this/status',
                device_class: 'enum',
                options: ['RUNNING', 'END'],
            },
            power: {
                platform: 'binary_sensor',
                unique_id: '$deviceid-power',
                name: 'Power',
                state_topic: '$this/power',
            },
            climate: {
                platform: 'climate',
                unique_id: '$deviceid-climate',
                name: null,
                modes: ['off', 'cool', 'fan_only'],
                mode_state_topic: '$this/climate-mode',
                mode_command_topic: '$this/climate-mode/set',
                fan_modes: ['auto', 'low'],
                fan_mode_state_topic: '$this/climate-fan_mode',
                fan_mode_command_topic: '$this/climate-fan_mode/set',
            },
            dehumidifier: {
                platform: 'humidifier',
                unique_id: '$deviceid-dehumidifier',
                name: null,
                modes: ['smart', 'fast'],
                target_humidity_command_topic: '$this/target_humidity/set',
                mode_state_topic: '$this/operation_mode',
                mode_command_topic: '$this/operation_mode/set',
            },
        },
    } as unknown as DeviceDiscovery

    connection.publishConfig('dryer-id', config)
    connection.publishProperty('dryer-id', 'status', 'RUNNING')
    connection.publishProperty('dryer-id', 'power', 'ON')
    connection.publishProperty('dryer-id', 'climate-fan_mode', 'auto')
    connection.publishProperty('dryer-id', 'operation_mode', 'smart')
    connection.publishProperty('dryer-id', 'climate-mode', 'off')

    const discovery = JSON.parse(published[0].payload)
    assert.equal(discovery.components.status.name, '상태')
    assert.deepEqual(discovery.components.status.options, ['운전 중', '완료'])
    assert.equal(discovery.components.power.name, '전원')
    assert.equal(discovery.device.name, '의류건조기')
    // A climate entity's modes are Home Assistant's own HVAC modes; translating them
    // makes Home Assistant drop the ones it does not recognise, which is how the air
    // conditioners lost their "off". A humidifier names its own modes, so those are
    // translated as before.
    assert.deepEqual(discovery.components.climate.modes, ['off', 'cool', 'fan_only'])
    assert.deepEqual(discovery.components.dehumidifier.modes, ['스마트', '쾌속'])
    assert.deepEqual(discovery.components.climate.fan_modes, ['자동', '약'])
    assert.equal(published[1].payload, '운전 중')
    assert.equal(published[2].payload, 'ON')
    assert.equal(published[3].payload, '자동')
    assert.equal(published[4].payload, '스마트')
    assert.equal(published[5].payload, 'off', 'the HVAC mode must reach Home Assistant untranslated')
    assert.equal(connection.localizedCommandValues.get('dryer-id/operation_mode')?.get('스마트'), 'smart')
    assert.equal(connection.localizedCommandValues.get('dryer-id/climate-mode')?.get('off'), 'off')
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
