import TLVDevice from './tlv_device'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import * as TLV from '@/util/tlv'
import HADevice from './base'

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

/**
 * LG dehumidifier DQ203PECA (ThinQ model DHUM_056905_WW).
 *
 * Only power and target humidity are writable. Both were captured end-to-end
 * through ThinQ cloud and restored to their original values. Mode and fan
 * controls remain read-only until their mode-dependent behavior is captured.
 */
export default class Device extends TLVDevice {
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
                },
                temperature: {
                    platform: 'sensor',
                    unique_id: '$deviceid-temperature',
                    name: 'Temperature',
                    device_class: 'temperature',
                    unit_of_measurement: '°C',
                    suggested_display_precision: 1,
                },
                operation_mode: {
                    platform: 'sensor',
                    unique_id: '$deviceid-operation-mode',
                    name: 'Operation mode',
                    device_class: 'enum',
                    options: Object.values(MODES),
                    icon: 'mdi:air-humidifier-off',
                },
                fan_speed: {
                    platform: 'sensor',
                    unique_id: '$deviceid-fan-speed',
                    name: 'Fan speed',
                    device_class: 'enum',
                    options: Object.values(FAN_SPEEDS),
                    icon: 'mdi:fan',
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
            name: '',
            comp: 'operation_mode',
            writable: false,
            read_xform: (raw) => MODES[raw],
        })

        this.addField(config, {
            id: 0x1fa,
            name: '',
            comp: 'fan_speed',
            writable: false,
            read_xform: (raw) => FAN_SPEEDS[raw],
        })

        this.addField(config, {
            id: 0x221,
            name: '',
            comp: 'error',
            writable: false,
            read_xform: (raw) => (raw === 0 ? 'normal' : `E${raw.toString().padStart(2, '0')}`),
        })

        this.setConfig(config)
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
