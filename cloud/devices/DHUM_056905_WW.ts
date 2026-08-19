import TLVDevice from './tlv_device'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import * as TLV from '@/util/tlv'
import HADevice from './base'
import log from '@/util/logging'

const MODES: Record<number, string> = {
    17: 'smart',
    18: 'fast',
    19: 'silent',
    20: 'concentrated_drying',
    21: 'clothing_drying',
}

const FAN_SPEEDS: Record<number, string> = {
    0: 'lowest',
    1: 'very_low',
    2: 'low',
    3: 'medium_low',
    4: 'medium',
    5: 'medium_high',
    6: 'high',
    7: 'power',
    8: 'auto',
}

// Bitmaps in the capability response, one bit per supported raw value. This unit
// reports modes 17 through 21 and fan values 2 and 6, matching support.airState.opMode
// and support.airState.windStrength in its ThinQ model schema.
const SUPPORTED_MODES = 0x2c1
const SUPPORTED_FAN_SPEEDS = 0x2c2

const UVNANO = 0x2a2
const WATER_TANK_LIGHT = 0x21e
/** Minutes until the appliance turns itself off, counted down by the appliance. */
const OFF_TIMER = 0x21b

function supported(mask: number | undefined, values: Record<number, string>) {
    const names = Object.keys(values)
        .map(Number)
        .sort((a, b) => a - b)
        .filter((raw) => mask === undefined || ((mask >> raw) & 1) === 1)
        .map((raw) => values[raw])
    // An appliance that reports no bit at all is more likely to be using a capability
    // layout we have not seen than to support nothing, so fall back to every value.
    return names.length ? names : Object.values(values)
}

function reverse(values: Record<number, string>): Record<string, number> {
    return Object.fromEntries(Object.entries(values).map(([raw, name]) => [name, Number(raw)]))
}

const MODE_VALUES = reverse(MODES)
const FAN_VALUES = reverse(FAN_SPEEDS)

/**
 * LG dehumidifier DQ203PECA (ThinQ model DHUM_056905_WW).
 *
 * Power, target humidity, operation mode and fan speed are writable. The model
 * schema lists exactly these four under its basicCtrl control command
 * (airState.operation, airState.humidity.desired, airState.opMode and
 * airState.windStrength), and each write was captured on the appliance.
 *
 * The mode and fan options come from the capability bitmaps the appliance reports,
 * because it silently ignores any other value: a fan write of 0, 4, 7 or 8 is
 * acknowledged and then dropped without a state report, while 2 and 6 take effect.
 */
export default class Device extends TLVDevice {
    private deviceConfig: DeviceDiscovery | undefined

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)

        const config: DeviceDiscovery = allowExtendedType({
            ...HADevice.config(meta, { name: 'LG Dehumidifier' }),
            components: {
                dehumidifier: {
                    platform: 'humidifier',
                    unique_id: '$deviceid-dehumidifier',
                    name: null,
                    device_class: 'dehumidifier',
                    min_humidity: 30,
                    max_humidity: 70,
                    modes: Object.values(MODES),
                },
                temperature: {
                    platform: 'sensor',
                    unique_id: '$deviceid-temperature',
                    name: 'Temperature',
                    device_class: 'temperature',
                    unit_of_measurement: '°C',
                    suggested_display_precision: 1,
                },
                fan_speed: {
                    platform: 'select',
                    unique_id: '$deviceid-fan-speed',
                    name: 'Fan speed',
                    options: Object.values(FAN_SPEEDS),
                    icon: 'mdi:fan',
                },
                uvnano: {
                    platform: 'switch',
                    unique_id: '$deviceid-uvnano',
                    name: 'UVnano',
                    icon: 'mdi:auto-fix',
                    entity_category: 'config',
                },
                water_tank_light: {
                    platform: 'switch',
                    unique_id: '$deviceid-water-tank-light',
                    name: 'Water tank light',
                    icon: 'mdi:lightbulb-outline',
                    entity_category: 'config',
                },
                off_timer: {
                    platform: 'number',
                    unique_id: '$deviceid-off-timer',
                    name: 'Turn-off reservation',
                    icon: 'mdi:timer-stop',
                    device_class: 'duration',
                    unit_of_measurement: 'h',
                    min: 0,
                    max: 8,
                    step: 1,
                    mode: 'slider',
                },
                error: {
                    platform: 'sensor',
                    unique_id: '$deviceid-error',
                    name: 'Error',
                    entity_category: 'diagnostic',
                    icon: 'mdi:alert-circle-outline',
                },
            },
        })

        this.addField(config, {
            id: 0x1f7,
            name: '',
            comp: 'dehumidifier',
            read_xform: (raw) => (raw ? 'ON' : 'OFF'),
            write_xform: (value) => (value === 'ON' ? 1 : 0),
        })

        this.addField(config, {
            id: 0x253,
            name: 'target_humidity',
            comp: 'dehumidifier',
            read_xform: (raw) => raw,
            write_xform: (value) => {
                const humidity = Number(value)
                if (!Number.isFinite(humidity)) return null
                return Math.min(70, Math.max(30, Math.round(humidity / 5) * 5))
            },
        })

        this.addField(config, {
            id: 0x336,
            name: 'current_humidity',
            comp: 'dehumidifier',
            state_topic: 'topic',
            writable: false,
        })

        this.addField(config, {
            id: 0x1fd,
            name: '',
            comp: 'temperature',
            writable: false,
            read_xform: (raw) => raw / 2,
        })

        this.addField(config, {
            id: 0x1f9,
            name: 'mode',
            comp: 'dehumidifier',
            read_xform: (raw) => MODES[raw],
            write_xform: (value) => MODE_VALUES[value] ?? null,
            write_callback: () => this.allowWriteWhilePowered('operation mode'),
        })

        this.addField(config, {
            id: 0x1fa,
            name: '',
            comp: 'fan_speed',
            read_xform: (raw) => FAN_SPEEDS[raw],
            write_xform: (value) => FAN_VALUES[value] ?? null,
            write_callback: (value) => this.allowFanWrite(value),
        })

        this.addField(config, {
            id: UVNANO,
            name: '',
            comp: 'uvnano',
            read_xform: (raw) => (raw ? 'ON' : 'OFF'),
            write_xform: (value) => (value === 'ON' ? 1 : 0),
        })

        this.addField(config, {
            id: WATER_TANK_LIGHT,
            name: '',
            comp: 'water_tank_light',
            read_xform: (raw) => (raw ? 'ON' : 'OFF'),
            write_xform: (value) => (value === 'ON' ? 1 : 0),
        })

        this.addField(config, {
            id: OFF_TIMER,
            name: '',
            comp: 'off_timer',
            // The appliance counts the reservation down every minute, so round the
            // remaining time up to the hour the slider can actually show.
            read_xform: (raw) => Math.ceil(raw / 60),
            write_xform: (value) => {
                const hours = Number(value)
                if (!Number.isFinite(hours)) return null
                return Math.min(8, Math.max(0, Math.round(hours))) * 60
            },
            write_callback: () => this.allowWriteWhilePowered('turn-off reservation'),
        })

        this.addField(config, {
            id: 0x221,
            name: '',
            comp: 'error',
            writable: false,
            read_xform: (raw) => (raw === 0 ? 'normal' : `E${raw.toString().padStart(2, '0')}`),
        })

        // Both entities used to be read-only sensors on these very component ids. Home
        // Assistant keeps the old entity when a component changes platform, and the mode
        // sensor is gone entirely now that the humidifier carries the mode itself.
        this.deviceConfig = config
        this.setConfig(config, {
            operation_mode: { platform: 'sensor' },
            fan_speed: { platform: 'sensor' },
        })
    }

    /**
     * The appliance answers a mode or fan write while powered off with an ack and then
     * ignores it, which would leave Home Assistant showing a value the appliance never
     * took. Power is the only write that is meaningful in that state.
     */
    allowWriteWhilePowered(what: string) {
        if (this.raw_clip_state[0x1f7]) return true
        log('status', this.id, `ignoring ${what} command while powered off`)
        return false
    }

    allowFanWrite(value: number) {
        if (!this.allowWriteWhilePowered('fan speed')) return false

        if (!this.supportedFanSpeeds().includes(FAN_SPEEDS[value])) {
            log('status', this.id, 'ignoring unsupported fan speed', value)
            return false
        }
        return true
    }

    supportedFanSpeeds() {
        return supported(this.raw_clip_state[SUPPORTED_FAN_SPEEDS], FAN_SPEEDS)
    }

    /** The capability response carries the bitmaps, so the option lists are known only here. */
    override capabilityReceived() {
        if (!this.deviceConfig) return

        const dehumidifier = this.deviceConfig.components.dehumidifier as { modes?: string[] }
        const fanSpeed = this.deviceConfig.components.fan_speed as { options?: string[] }
        dehumidifier.modes = supported(this.raw_clip_state[SUPPORTED_MODES], MODES)
        fanSpeed.options = this.supportedFanSpeeds()
        this.publishConfig()
    }

    protected override writeHeader() {
        // Live ThinQ captures for this model use transaction byte 0x00.
        return [1, 1, 2, 1, 0]
    }

    isCapsResponse(tlvArray: TLV.TLV[]) {
        return tlvArray.some(({ t }) => t === 0x2da)
    }

    isValuesResponse(tlvArray: TLV.TLV[]) {
        return tlvArray.some(({ t }) => t === 0x1f7) && tlvArray.some(({ t }) => t === 0x253)
    }
}
