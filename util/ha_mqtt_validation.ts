import type { DeviceDiscovery } from '@/cloud/homeassistant'

type Component = Record<string, unknown>

// Home Assistant Core `dev`, homeassistant/components/mqtt/const.py.
// Keep this list explicit so a typo cannot silently turn into an ignored discovery component.
const SUPPORTED_COMPONENTS = new Set([
    'alarm_control_panel',
    'binary_sensor',
    'button',
    'camera',
    'climate',
    'cover',
    'date',
    'datetime',
    'device_automation',
    'device_tracker',
    'event',
    'fan',
    'humidifier',
    'image',
    'infrared',
    'lawn_mower',
    'light',
    'lock',
    'notify',
    'number',
    'scene',
    'select',
    'sensor',
    'siren',
    'switch',
    'tag',
    'text',
    'time',
    'update',
    'vacuum',
    'valve',
    'water_heater',
])

const READ_ONLY_COMPONENTS = new Set(['binary_sensor', 'sensor'])
const READ_WRITE_COMPONENTS = new Set(['fan', 'number', 'select', 'switch'])
const ENTITY_CATEGORIES = new Set(['config', 'diagnostic'])
const AVAILABILITY_MODES = new Set(['all', 'any', 'latest'])
const CLIMATE_MODES = new Set(['off', 'heat', 'cool', 'heat_cool', 'auto', 'dry', 'fan_only'])
const CLIMATE_PRECISIONS = new Set([0.1, 0.5, 1])
const SENSOR_STATE_CLASSES = new Set(['measurement', 'total', 'total_increasing'])
const SENSOR_DEVICE_CLASS_UNITS: Record<string, Set<string>> = {
    duration: new Set(['ms', 's', 'min', 'h', 'd']),
    energy: new Set(['Wh', 'kWh']),
    humidity: new Set(['%']),
    pm1: new Set(['µg/m³']),
    pm10: new Set(['µg/m³']),
    pm25: new Set(['µg/m³']),
    power: new Set(['mW', 'W', 'kW']),
    temperature: new Set(['°C', '°F', 'K']),
    volume: new Set(['mL', 'L']),
}

function nonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0
}

function validTopic(topic: unknown): boolean {
    // Discovery state and command topics must be concrete topics, not subscription filters.
    return nonEmptyString(topic) && !topic.includes('\0') && !topic.includes('+') && !topic.includes('#')
}

function validateEnum(component: Component, key: string, path: string, issues: string[]) {
    const values = component[key]
    if (values === undefined) return
    if (!Array.isArray(values) || values.length === 0 || values.some((value) => !nonEmptyString(value))) {
        issues.push(`${path}.${key} must be a non-empty list of non-empty strings`)
        return
    }
    if (new Set(values).size !== values.length) issues.push(`${path}.${key} contains duplicate values`)
}

function validateComponent(id: string, component: Component, issues: string[]) {
    const path = `components.${id}`
    const platform = component.platform
    if (!nonEmptyString(platform) || !SUPPORTED_COMPONENTS.has(platform)) {
        issues.push(`${path}.platform is not a supported MQTT component`)
        return
    }

    // A platform-only component is Home Assistant device-discovery's component removal form.
    if (Object.keys(component).length === 1) return

    if (!nonEmptyString(component.unique_id)) issues.push(`${path}.unique_id is required`)
    if (component.name === '')
        issues.push(`${path}.name should be null for a device's main entity, not an empty string`)
    if (component.entity_category !== undefined && !ENTITY_CATEGORIES.has(String(component.entity_category))) {
        issues.push(`${path}.entity_category must be config or diagnostic`)
    }
    for (const [key, value] of Object.entries(component)) {
        if (key.endsWith('_topic') && !validTopic(value))
            issues.push(`${path}.${key} is not a valid concrete MQTT topic`)
    }

    if (READ_ONLY_COMPONENTS.has(platform) && !validTopic(component.state_topic)) {
        issues.push(`${path}.state_topic is required for ${platform}`)
    }
    if (READ_WRITE_COMPONENTS.has(platform) && !validTopic(component.command_topic)) {
        issues.push(`${path}.command_topic is required for ${platform}`)
    }
    if (platform === 'button' && !validTopic(component.command_topic)) {
        issues.push(`${path}.command_topic is required for button`)
    }

    if (platform === 'select') validateEnum(component, 'options', path, issues)
    if (platform === 'sensor' && component.options !== undefined) {
        validateEnum(component, 'options', path, issues)
        if (component.device_class !== 'enum') issues.push(`${path}.options requires device_class enum`)
        if (component.state_class !== undefined || component.unit_of_measurement !== undefined) {
            issues.push(`${path}.options cannot be combined with state_class or unit_of_measurement`)
        }
    }
    if (platform === 'sensor') {
        if (component.state_class !== undefined && !SENSOR_STATE_CLASSES.has(String(component.state_class))) {
            issues.push(`${path}.state_class is not supported by Home Assistant`)
        }
        const units = SENSOR_DEVICE_CLASS_UNITS[String(component.device_class)]
        if (units && component.unit_of_measurement !== undefined && !units.has(String(component.unit_of_measurement))) {
            issues.push(`${path}.unit_of_measurement is invalid for device_class ${String(component.device_class)}`)
        }
    }
    if (platform === 'number') {
        const min = Number(component.min ?? 0)
        const max = Number(component.max ?? 100)
        const step = Number(component.step ?? 1)
        if (!Number.isFinite(min) || !Number.isFinite(max) || min > max)
            issues.push(`${path} has an invalid min/max range`)
        if (!Number.isFinite(step) || step < 0.001) issues.push(`${path}.step must be at least 0.001`)
    }
    if (platform === 'climate') {
        validateEnum(component, 'modes', path, issues)
        validateEnum(component, 'fan_modes', path, issues)
        validateEnum(component, 'swing_modes', path, issues)
        validateEnum(component, 'swing_horizontal_modes', path, issues)
        validateEnum(component, 'preset_modes', path, issues)
        if (
            Array.isArray(component.modes) &&
            component.modes.some((mode) => !nonEmptyString(mode) || !CLIMATE_MODES.has(mode))
        ) {
            issues.push(`${path}.modes contains a non-standard Home Assistant HVAC mode`)
        }
        if (component.precision !== undefined && !CLIMATE_PRECISIONS.has(Number(component.precision))) {
            issues.push(`${path}.precision must be 0.1, 0.5, or 1`)
        }
        if (component.min_temp !== undefined && component.max_temp !== undefined) {
            if (Number(component.min_temp) > Number(component.max_temp))
                issues.push(`${path} has an invalid temperature range`)
        }
        if (component.target_humidity_state_topic && !component.target_humidity_command_topic) {
            issues.push(`${path}.target_humidity_state_topic requires target_humidity_command_topic`)
        }
    }
    if (platform === 'humidifier') {
        if (!validTopic(component.target_humidity_command_topic)) {
            issues.push(`${path}.target_humidity_command_topic is required for humidifier`)
        }
        validateEnum(component, 'modes', path, issues)
        if ((component.modes === undefined) !== (component.mode_command_topic === undefined)) {
            issues.push(`${path}.modes and mode_command_topic must be used together`)
        }
        const min = Number(component.min_humidity ?? 0)
        const max = Number(component.max_humidity ?? 100)
        if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max || max > 100) {
            issues.push(`${path} has an invalid humidity range`)
        }
    }
    if (platform === 'fan') {
        validateEnum(component, 'preset_modes', path, issues)
        if ((component.preset_modes === undefined) !== (component.preset_mode_command_topic === undefined)) {
            issues.push(`${path}.preset_modes and preset_mode_command_topic must be used together`)
        }
    }
}

/**
 * Validate the subset of Home Assistant's current MQTT device-discovery schema used by rethink.
 * Unknown platform-specific keys are deliberately left to Home Assistant for forward compatibility.
 */
export function validateDeviceDiscovery(config: DeviceDiscovery): string[] {
    const issues: string[] = []
    const root = config as unknown as Record<string, unknown>
    const device = root.device as Record<string, unknown> | undefined
    const origin = root.origin as Record<string, unknown> | undefined
    const components = root.components as Record<string, Component> | undefined

    if (!device || (!device.identifiers && !device.connections)) {
        issues.push('device must have identifiers or connections')
    }
    if (!origin || !nonEmptyString(origin.name)) issues.push('origin.name is required')
    if (!components || typeof components !== 'object' || Array.isArray(components)) {
        issues.push('components must be an object')
        return issues
    }
    if (root.availability_mode !== undefined && !AVAILABILITY_MODES.has(String(root.availability_mode))) {
        issues.push('availability_mode must be all, any, or latest')
    }
    if (root.availability !== undefined) {
        if (!Array.isArray(root.availability) || root.availability.length === 0) {
            issues.push('availability must be a non-empty list')
        } else {
            root.availability.forEach((entry, index) => {
                const topic = (entry as Record<string, unknown>)?.topic
                if (!validTopic(topic)) issues.push(`availability.${index}.topic is invalid`)
            })
        }
    }

    for (const [id, component] of Object.entries(components)) validateComponent(id, component, issues)
    return issues
}
