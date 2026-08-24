import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DeviceDiscovery } from '@/cloud/homeassistant'
import { validateDeviceDiscovery } from '@/util/ha_mqtt_validation'

function discovery(components: Record<string, Record<string, unknown>>): DeviceDiscovery {
    return {
        availability: [{ topic: '$this/availability' }, { topic: '$rethink/availability' }],
        availability_mode: 'all',
        device: { identifiers: '$deviceid', name: 'Appliance' },
        origin: { name: 'rethink', support_url: 'https://github.com/anszom/rethink' },
        components,
    } as unknown as DeviceDiscovery
}

test('accepts current device discovery and the platform-only component removal form', () => {
    const config = discovery({
        temperature: {
            platform: 'sensor',
            unique_id: '$deviceid-temperature',
            state_topic: '$this/temperature',
            device_class: 'temperature',
            unit_of_measurement: '°C',
        },
        old_switch: { platform: 'switch' },
    })

    assert.deepEqual(validateDeviceDiscovery(config), [])
})

test('rejects sensor enum options without the enum device class', () => {
    const issues = validateDeviceDiscovery(
        discovery({
            status: {
                platform: 'sensor',
                unique_id: '$deviceid-status',
                state_topic: '$this/status',
                options: ['RUNNING', 'END'],
            },
        }),
    )

    assert.ok(issues.includes('components.status.options requires device_class enum'))
})

test('rejects missing writable topics and wildcard state topics', () => {
    const issues = validateDeviceDiscovery(
        discovery({
            mode: {
                platform: 'select',
                unique_id: '$deviceid-mode',
                state_topic: '$this/+/mode',
                options: ['normal'],
            },
        }),
    )

    assert.ok(issues.includes('components.mode.state_topic is not a valid concrete MQTT topic'))
    assert.ok(issues.includes('components.mode.command_topic is required for select'))
})

test('enforces Home Assistant climate and humidifier combinations', () => {
    const issues = validateDeviceDiscovery(
        discovery({
            climate: {
                platform: 'climate',
                unique_id: '$deviceid-climate',
                modes: ['off', 'unsupported'],
                precision: 0.25,
            },
            humidifier: {
                platform: 'humidifier',
                unique_id: '$deviceid-humidifier',
                modes: ['smart'],
                min_humidity: 70,
                max_humidity: 70,
            },
        }),
    )

    assert.ok(issues.includes('components.climate.modes contains a non-standard Home Assistant HVAC mode'))
    assert.ok(issues.includes('components.climate.precision must be 0.1, 0.5, or 1'))
    assert.ok(issues.includes('components.humidifier.target_humidity_command_topic is required for humidifier'))
    assert.ok(issues.includes('components.humidifier.modes and mode_command_topic must be used together'))
    assert.ok(issues.includes('components.humidifier has an invalid humidity range'))
})

test('rejects legacy blank main names and incompatible sensor units', () => {
    const issues = validateDeviceDiscovery(
        discovery({
            power: {
                platform: 'sensor',
                unique_id: '$deviceid-power',
                name: '',
                state_topic: '$this/power',
                device_class: 'power',
                unit_of_measurement: 'kWh',
                state_class: 'invalid',
            },
        }),
    )

    assert.ok(issues.includes("components.power.name should be null for a device's main entity, not an empty string"))
    assert.ok(issues.includes('components.power.state_class is not supported by Home Assistant'))
    assert.ok(issues.includes('components.power.unit_of_measurement is invalid for device_class power'))
})
