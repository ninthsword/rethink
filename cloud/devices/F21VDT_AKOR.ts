import HADevice from './base'
import AABBDevice from './aabb_device'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'

// Korean front-loading washer. The offsets are based on packets captured from
// this exact model and cross-checked against its ThinQ washerDryer snapshot.
const STATUS: Record<number, string> = {
    0: 'POWEROFF',
    5: 'INITIAL',
    6: 'PAUSE',
    7: 'ERROR_AUTO_OFF',
    10: 'RESERVED',
    20: 'DETECTING',
    21: 'ADD_DRAIN',
    22: 'DETERGENT_AMOUNT',
    23: 'RUNNING',
    24: 'PREWASH',
    30: 'RINSING',
    31: 'RINSEHOLD',
    40: 'SPINNING',
    50: 'DRYING',
    60: 'END',
    61: 'REFRESHING',
    83: 'FROZEN_PREVENT_INITIAL',
    84: 'FROZEN_PREVENT_RUNNING',
    85: 'FROZEN_PREVENT_PAUSE',
    101: 'DIAGNOSIS',
}

const SOIL = ['NO', 'LIGHT', 'NORMAL', 'HEAVY', 'VERY_HEAVY', 'EXTRA_HEAVY']
const SPIN = ['NO', 'VERY_LOW', 'LOW', 'MEDIUM', 'HIGH', 'EXTRA_HIGH']
const TEMP = ['NO', 'COLD', '30_C', '40_C', '60_C', '95_C']
const RINSE = ['NO', '1', '2', '3', '4', '5']
const DRY_LEVEL: Record<number, string> = {
    0: 'NO',
    5: 'WIND',
    6: 'TURBO',
    7: '30_MIN',
    8: '60_MIN',
    9: '90_MIN',
    10: '120_MIN',
    11: '150_MIN',
}
const COURSE: Record<number, string> = { 0: 'NONE' }
const DOWNLOADED_COURSE: Record<number, string> = { 0: 'NONE', 0x34: 'SMALL_LOAD' }
const OPERATION_COURSE: Record<number, string> = { 0: 'NONE', 0x04: 'SPEEDWASH' }

function sensor(name: string, icon: string, extra: object = {}) {
    return {
        platform: 'sensor',
        unique_id: `$deviceid-${name}`,
        state_topic: `$this/${name}`,
        name,
        icon,
        ...extra,
    }
}

function value(map: Record<number, string>, raw: number) {
    return map[raw] ?? `RAW_${raw}`
}

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Washer' }),
                components: {
                    power: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        name: 'Power',
                        icon: 'mdi:washing-machine',
                    },
                    run_completed: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-run_completed',
                        state_topic: '$this/run_completed',
                        name: 'Run completed',
                        icon: 'mdi:check-circle-outline',
                    },
                    status: sensor('status', 'mdi:state-machine'),
                    previous_status: sensor('previous_status', 'mdi:history'),
                    remaining_time: sensor('remaining_time', 'mdi:timer-outline', {
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    }),
                    initial_time: sensor('initial_time', 'mdi:clock-start', {
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    }),
                    reserve_time: sensor('reserve_time', 'mdi:clock-outline', {
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    }),
                    course: sensor('course', 'mdi:washing-machine'),
                    downloaded_course: sensor('downloaded_course', 'mdi:download-circle-outline'),
                    operation_course: sensor('operation_course', 'mdi:washing-machine'),
                    soil: sensor('soil', 'mdi:water-opacity'),
                    spin: sensor('spin', 'mdi:rotate-3d'),
                    water_temp: sensor('water_temp', 'mdi:thermometer-lines'),
                    rinse: sensor('rinse', 'mdi:waves-arrow-right'),
                    dry_level: sensor('dry_level', 'mdi:tumble-dryer'),
                    tub_clean_count: sensor('tub_clean_count', 'mdi:washing-machine', {
                        state_class: 'total',
                        suggested_display_precision: 0,
                    }),
                },
            }),
        )
    }

    private processRecord(rec: Buffer) {
        if (rec.length !== 28 || rec[1] !== 0x1a) return

        const state = rec[2]
        this.publishProperty('power', state === 0 ? 'OFF' : 'ON')
        this.publishProperty('status', value(STATUS, state))
        this.publishProperty('run_completed', state === 60 ? 'ON' : 'OFF')
        this.publishProperty('previous_status', value(STATUS, rec[21]))
        this.publishProperty('remaining_time', rec[3] * 60 + rec[4])
        this.publishProperty('initial_time', rec[5] * 60 + rec[6])
        this.publishProperty('reserve_time', rec[14] * 60 + rec[15])
        this.publishProperty('course', value(COURSE, rec[7]))
        this.publishProperty('downloaded_course', value(DOWNLOADED_COURSE, rec[22]))
        this.publishProperty('operation_course', value(OPERATION_COURSE, rec[24]))
        this.publishProperty('soil', SOIL[rec[9]] ?? `RAW_${rec[9]}`)
        this.publishProperty('spin', SPIN[rec[10]] ?? `RAW_${rec[10]}`)
        this.publishProperty('water_temp', TEMP[rec[11]] ?? `RAW_${rec[11]}`)
        this.publishProperty('rinse', RINSE[rec[12]] ?? `RAW_${rec[12]}`)
        this.publishProperty('dry_level', value(DRY_LEVEL, rec[13]))
        this.publishProperty('tub_clean_count', rec[23])
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== 0x20) return
        if (buf[1] === 0xeb && buf.length === 30) this.processRecord(buf.subarray(2, 30))
        else if (buf[1] === 0xec && buf.length === 58) this.processRecord(buf.subarray(30, 58))
    }
}
