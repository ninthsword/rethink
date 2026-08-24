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
 * Captured by turning the course dial one position at a time with the appliance
 * reporting: fourteen positions that close back on 표준, matching the panel one for one.
 * The order is nothing like the model schema's, which is why a single reading could not
 * be extrapolated. The schema names four more courses — 선반건조, 시간건조, 콘덴서케어 and
 * 통살균 — which this appliance selects with its own buttons rather than the dial. They
 * report their own raw values, so they stay unmapped until one is read off the appliance.
 */
const COURSE: Record<number, string> = {
    0: 'NONE',
    2: 'BULKYITEM',
    4: 'COOLAIR',
    5: 'COTTONNORMAL',
    7: 'PADDINGREFRESH',
    8: 'QUICKDRY',
    9: 'BEDDING_BRUSH',
    11: 'ALLERGYCARE',
    13: 'WOOL',
    14: 'EASYCARE',
    15: 'WARMAIR',
    16: 'WATERREPELLENT',
    17: 'TOWELS',
    20: 'SPORTWEAR',
    22: 'DOWNLOADED',
}
/*
 * Codes read straight off `f0 25` download commands captured while the owner picked each
 * course in the ThinQ app. The names are the cloud's own keys for this model, so they line
 * up with the SmartCourse table in LG's model JSON; util/ha_locale.ts carries the Korean.
 * All ten the model offers are here, so an unmapped code now means the model gained one.
 */
const DOWNLOADED_COURSE: Record<number, string> = {
    0: 'NONE',
    0x66: 'GYMCLOTHES',
    0x69: 'RAINYSEASON',
    0x6b: 'DEODORIZATION',
    0x6c: 'SMALLLOAD',
    0x6e: 'EASYIRON',
    0x70: 'ECONOMICDRY',
    0x71: 'BIGSIZEITEM',
    0x72: 'MINIMIZEWRINKLES',
    0x74: 'FULLSIZELOAD',
    0x77: 'POWER',
    0x83: 'SELFCLEANING',
}
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
        // The newest record is the second one, as it is for the washer, the dishwasher and
        // Hd0C_F. Reading the first meant a downloaded course only arrived a report late,
        // and appeared to flip back to the previous one in between.
        else if (buf[1] === 0xec && buf.length === 56) this.processRecord(buf.subarray(29, 56))
    }
}
