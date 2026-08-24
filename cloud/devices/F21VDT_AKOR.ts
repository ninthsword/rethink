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
/*
 * Read off the appliance by turning the course dial one position at a time: fourteen
 * consecutive values that close back on 표준세탁, matching the panel one for one. The
 * dial counts down, so turning it the way the panel reads walks 7 down to 1 and then
 * wraps to 14.
 */
const COURSE: Record<number, string> = {
    0: 'NONE',
    1: 'STEAM_STYLING',
    2: 'ALLERGY_CARE',
    3: 'SPORTWEAR',
    4: 'ECO_BOIL',
    5: 'BABY_WEAR',
    6: 'STAIN_CARE',
    7: 'NORMAL_WASH',
    8: 'SPEEDWASH',
    9: 'QUIET_WASH',
    10: 'COLOR_CARE',
    11: 'BULKYITEM',
    12: 'LINGERIE_WOOL',
    13: 'RINSE_SPIN',
    14: 'DOWNLOADED',
}
/*
 * Each byte was read from the `f0 25` download command captured while that course was
 * picked in the ThinQ app, so the pairing is the appliance's own. The names are the cloud's
 * keys for this model, matching the SmartCourse table in LG's model JSON.
 *
 * DEODORIZATION_WASHER is the one exception. The dryer has a course under the same cloud
 * key that the app calls 리프레쉬, while this one is 냄새 제거, and util/ha_locale.ts is a
 * flat table with room for only one Korean name per value.
 *
 * ECO_WASH (알뜰 세탁) is the fifteenth course the model lists and is not here: it was not
 * among the ones downloaded. The codes run consecutively for the first ten and then skip,
 * so guessing where it landed is exactly the mistake this table was built to avoid.
 */
/*
 * From the error table in LG's model JSON for this appliance, whose keys are the numbers it
 * puts on the wire, and titled from LG's Korean language pack.
 *
 * The byte is rec[8]. anszom/rethink contributor martijndhondt placed the same field at
 * buf[10] on F_C__Y___W.A__QEUK by capturing an actual dE2 fault, and seven of that
 * handler's fields — status, both times, spin and temperature — sit exactly two positions
 * ahead of ours, so buf[10] lands on rec[8] here. This handler does not otherwise read it
 * and it was zero in every record captured while the washer was healthy. Confirm against
 * the ThinQ app the first time this washer actually faults.
 */
const ERROR: Record<number, string> = {
    0: 'NO_ERROR',
    1: 'ERROR_DE2',
    2: 'ERROR_IE',
    3: 'ERROR_OE',
    4: 'ERROR_UE',
    5: 'ERROR_FE',
    6: 'ERROR_PE',
    7: 'ERROR_TE',
    8: 'ERROR_LE',
    9: 'ERROR_CE',
    10: 'ERROR_DHE',
    11: 'ERROR_PF',
    12: 'ERROR_FF',
    13: 'ERROR_DCE',
    15: 'ERROR_EE',
    16: 'ERROR_PS',
    17: 'ERROR_DE1',
    18: 'ERROR_LOE',
    19: 'ERROR_DE4',
}

const DOWNLOADED_COURSE: Record<number, string> = {
    0: 'NONE',
    0x33: 'COLD_WASH',
    0x34: 'SMALL_LOAD',
    0x35: 'SKIN_CARE',
    0x36: 'RAINY_DAY',
    0x37: 'SWEAT_STAIN',
    0x38: 'SINGLE_GARMENTS',
    0x39: 'KIDS_WEAR',
    0x3a: 'SHIRT',
    0x3b: 'SCHOOL_UNIFORM',
    0x3c: 'STATIC_REDUCE',
    0x3f: 'SPIN_ONLY',
    0x41: 'DEODORIZATION_WASHER',
    0x43: 'CLOTH_CARE',
    0x44: 'SMART_RINSE',
}
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
                    error: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-error',
                        state_topic: '$this/error',
                        name: 'error',
                        icon: 'mdi:alert-circle-outline',
                        device_class: 'problem',
                    },
                    error_message: sensor('error_message', 'mdi:alert-circle-outline'),
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
        this.publishProperty('error', rec[8] === 0 ? 'OFF' : 'ON')
        this.publishProperty('error_message', ERROR[rec[8]] ?? `RAW_${rec[8]}`)
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
