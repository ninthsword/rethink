import { allowExtendedType } from '@/util/casting'
import type { Connection } from '../homeassistant'
import type { Metadata } from '../thinq'
import type { Device as Thinq2Device } from '../thinq2/device'
import AABBDevice from './aabb_device'
import HADevice from './base'

const STATUS: Record<number, string> = {
    0: 'Off',
    1: 'Starting',
    3: 'Paused',
    50: 'Drying',
    51: 'Cooldown',
    4: 'Finishing',
}

const CYCLES: Record<number, string> = {
    1: 'Heavy Duty',
    3: 'Normal',
    4: 'Perm. Press',
    5: 'Delicates',
    7: 'Bedding',
    16: 'Speed Dry',
    17: 'Air Dry',
    18: 'Manual',
}

const TEMPS: Record<number, string> = {
    0: 'Off',
    1: 'Ultra Low',
    2: 'Low',
    3: 'Medium',
    4: 'Med High',
    5: 'High',
}

const DRY_LEVELS: Record<number, string> = {
    0: 'None',
    1: 'Damp',
    2: 'Less',
    3: 'Normal',
    4: 'More',
    5: 'Very',
}

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Dryer' }),
                components: {
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                        device_class: 'enum',
                        options: [...new Set(Object.values(STATUS))],
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining_time',
                        state_topic: '$this/remaining_time',
                        name: 'Remaining time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    power: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        name: 'Power',
                        icon: 'mdi:tumble-dryer',
                        device_class: 'running',
                    },
                    drum_running: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-drum_running',
                        state_topic: '$this/drum_running',
                        name: 'Drum running',
                        icon: 'mdi:rotate-3d-variant',
                    },
                    cycle: {
                        platform: 'sensor',
                        unique_id: '$deviceid-cycle',
                        state_topic: '$this/cycle',
                        name: 'Cycle',
                        icon: 'mdi:tumble-dryer',
                        device_class: 'enum',
                        options: Object.values(CYCLES),
                    },
                    temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        name: 'Temperature',
                        icon: 'mdi:thermometer',
                        device_class: 'enum',
                        options: Object.values(TEMPS),
                    },
                    dry_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-dry_level',
                        state_topic: '$this/dry_level',
                        name: 'Dry level',
                        icon: 'mdi:water-percent',
                        device_class: 'enum',
                        options: Object.values(DRY_LEVELS),
                    },
                },
            }),
        )
    }

    private processRecord(rec: Buffer) {
        const phase = rec[2]
        const mins = rec[4]

        this.publishProperty('status', STATUS[phase] ?? 'unknown')
        this.publishProperty('remaining_time', mins)
        this.publishProperty('power', phase !== 0 ? 'ON' : 'OFF')
        this.publishProperty('drum_running', rec[17] === 0xa9 ? 'ON' : 'OFF')
        this.publishProperty('cycle', CYCLES[rec[7]] ?? 'unknown')
        this.publishProperty('temp', TEMPS[rec[10]] ?? 'unknown')
        this.publishProperty('dry_level', DRY_LEVELS[rec[9]] ?? 'unknown')
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== 0x30) return

        if (buf[1] === 0xec && buf.length === 60) {
            // 0xEC: two back-to-back 29-byte records (current + previous); use current
            this.processRecord(buf.subarray(2, 31))
        } else if (buf[1] === 0xeb && buf.length === 31) {
            // 0xEB: single record sent after reconnect
            this.processRecord(buf.subarray(2, 31))
        }
    }
}
