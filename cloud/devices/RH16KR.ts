import HADevice from './base'
import AABBDevice from './aabb_device'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'

const STATUS: Record<number, string> = {
    0: 'POWEROFF',
    1: 'INITIAL',
    2: 'RUNNING',
    3: 'PAUSE',
    4: 'END',
    5: 'ERROR',
    8: 'DIAGNOSIS',
    100: 'RESERVED',
}
const DRY_LEVEL = ['NO', 'DAMP', 'LESS', 'IRON', 'CUPBOARD', 'VERY_DRY']
const ECO_HYBRID = ['NONE', 'ECO', 'NORMAL', 'TURBO']
/*
 * Only the entry confirmed against the appliance is here. The model schema lists
 * seventeen courses but gives them no numbers, and their order in the file does not line
 * up with the wire: the appliance reported 5 while its panel showed 표준, which is fourth
 * in that list. Guessing an offset from one point would mislabel every other course, so
 * the rest wait for the dial to be stepped through with a capture running.
 */
const COURSE: Record<number, string> = { 0: 'NONE', 5: 'COTTON_NORMAL' }
const DOWNLOADED_COURSE: Record<number, string> = { 0: 'NONE', 0x83: 'SELFCLEANING' }
// Exact RH16KR processState table from the installed model diagnostic.
const PROCESS: Record<number, string> = {
    // The AABB wire record is one-based. The ThinQ model diagnostic uses
    // zero-based indices for the same ordered processState values.
    0: 'NONE',
    1: 'DETECTING',
    2: 'STEAM',
    3: 'DRY_LV1',
    4: 'DRY_LV2',
    5: 'DRY_LV3',
    6: 'COOL',
    7: 'ANTI_CREASE',
    8: 'END',
}

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

function mapped(map: Record<number, string>, raw: number) {
    return map[raw] ?? `RAW_${raw}`
}

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Dryer' }),
                components: {
                    power: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        name: 'Power',
                        icon: 'mdi:tumble-dryer',
                    },
                    run_completed: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-run_completed',
                        state_topic: '$this/run_completed',
                        name: 'Run completed',
                        icon: 'mdi:check-circle-outline',
                    },
                    status: sensor('status', 'mdi:state-machine'),
                    process_status: sensor('process_status', 'mdi:progress-clock'),
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
                    course: sensor('course', 'mdi:tumble-dryer'),
                    downloaded_course: sensor('downloaded_course', 'mdi:download-circle-outline'),
                    dry_level: sensor('dry_level', 'mdi:water-percent'),
                    eco_hybrid: sensor('eco_hybrid', 'mdi:leaf'),
                    anti_crease: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-anti_crease',
                        state_topic: '$this/anti_crease',
                        name: 'Anti crease',
                        icon: 'mdi:iron-outline',
                    },
                },
            }),
        )
    }

    private processRecord(rec: Buffer) {
        if (rec.length !== 27 || rec[1] !== 0x19) return

        const state = rec[2]
        this.publishProperty('power', state === 0 ? 'OFF' : 'ON')
        this.publishProperty('status', mapped(STATUS, state))
        this.publishProperty('run_completed', state === 4 || rec[21] === 8 ? 'ON' : 'OFF')
        this.publishProperty('process_status', mapped(PROCESS, rec[21]))
        this.publishProperty('remaining_time', rec[3] * 60 + rec[4])
        this.publishProperty('initial_time', rec[5] * 60 + rec[6])
        this.publishProperty('reserve_time', rec[13] * 60 + rec[14])
        this.publishProperty('course', mapped(COURSE, rec[7]))
        this.publishProperty('downloaded_course', mapped(DOWNLOADED_COURSE, rec[25]))
        this.publishProperty('dry_level', DRY_LEVEL[rec[9]] ?? `RAW_${rec[9]}`)
        this.publishProperty('eco_hybrid', ECO_HYBRID[rec[10]] ?? `RAW_${rec[10]}`)
        this.publishProperty('anti_crease', rec[11] === 1 ? 'ON' : 'OFF')
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== 0x30) return
        if (buf[1] === 0xeb && buf.length === 29) this.processRecord(buf.subarray(2, 29))
        // This dryer family sends current then previous in 0xEC, unlike the
        // washer/dishwasher variants whose newest record is second.
        else if (buf[1] === 0xec && buf.length === 56) this.processRecord(buf.subarray(2, 29))
    }
}
