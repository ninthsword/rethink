import { allowExtendedType } from '@/util/casting'
import type { Connection } from '../homeassistant'
import type { Metadata } from '../thinq'
import type { Device as Thinq2Device } from '../thinq2/device'
import AABBDevice from './aabb_device'
import HADevice from './base'

const STATUS: Record<number, string> = {
    0: 'STANDBY',
    1: 'INITIAL',
    2: 'RUNNING',
    3: 'PAUSE',
    4: 'POWEROFF',
    5: 'END',
    6: 'POWERFAIL',
}
const PROCESS: Record<number, string> = {
    0: 'NONE',
    1: 'RESERVED',
    2: 'RUNNING',
    3: 'RINSING',
    4: 'DRYING',
    5: 'END',
    6: 'NIGHTDRY',
    7: 'CANCEL',
}
const COURSE: Record<number, string> = {
    0: 'NONE',
    1: 'AUTO',
    2: 'INTENSIVE',
    3: 'DELICATE',
    4: 'TURBO',
    5: 'NORMAL_ECO',
    6: 'RINSE',
    7: 'REFRESH',
    8: 'EXPRESS',
    9: 'MACHINE_CLEAN',
    10: 'SHORT_MODE',
    11: 'DOWNLOAD_CYCLE',
}
const DOWNLOAD_COURSE: Record<number, string> = {
    0: 'NONE',
    1: 'POTS_AND_PANS',
    2: 'CASSEROLES',
    3: 'GLASSWARE',
    4: 'NIGHT_CARE',
    5: 'GRILLED_DISHES',
    6: 'GREASY_DISHES',
    7: 'PRESSED_DISHES',
    8: 'FISH_DISH',
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
                ...HADevice.config(meta, { name: 'LG Dishwasher' }),
                components: {
                    power: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        name: 'Power',
                        icon: 'mdi:dishwasher',
                    },
                    run_completed: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-run_completed',
                        state_topic: '$this/run_completed',
                        name: 'Run completed',
                        icon: 'mdi:check-circle-outline',
                    },
                    status: sensor('status', 'mdi:state-machine'),
                    process: sensor('process', 'mdi:progress-clock'),
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
                    course: sensor('course', 'mdi:dishwasher'),
                    current_download_course: sensor('current_download_course', 'mdi:download-circle-outline'),
                    tub_clean_count: sensor('tub_clean_count', 'mdi:dishwasher', {
                        state_class: 'total',
                        suggested_display_precision: 0,
                    }),
                },
            }),
        )
    }

    private processRecord(rec: Buffer) {
        if (rec.length !== 26 || rec[1] !== 0x18) return

        const state = rec[2]
        this.publishProperty('power', state === 0 || state === 4 ? 'OFF' : 'ON')
        this.publishProperty('status', mapped(STATUS, state))
        this.publishProperty('run_completed', state === 5 || rec[3] === 5 ? 'ON' : 'OFF')
        this.publishProperty('process', mapped(PROCESS, rec[3]))
        this.publishProperty('remaining_time', rec[5] * 60 + rec[6])
        this.publishProperty('initial_time', rec[9] * 60 + rec[10])
        this.publishProperty('reserve_time', rec[11] * 60 + rec[12])
        this.publishProperty('course', mapped(COURSE, rec[7]))
        this.publishProperty('current_download_course', mapped(DOWNLOAD_COURSE, rec[25]))
    }

    /*
     * The runs-since-sterilisation counter is not in the status record at all — unlike the
     * washer, which carries its own in one. It arrives in the appliance's long records,
     * which differ only in that 0xBF has one extra byte near the front, putting the same
     * field one place further along. Confirmed by running a cycle and watching it go from
     * 20 to 21, matching what the ThinQ app showed.
     */
    private processLongRecord(buf: Buffer, offset: number) {
        if (buf.length <= offset) return
        this.publishProperty('tub_clean_count', buf[offset])
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== 0x32) return
        if (buf[1] === 0xeb && buf.length === 28) this.processRecord(buf.subarray(2, 28))
        else if (buf[1] === 0xec && buf.length === 54) this.processRecord(buf.subarray(28, 54))
        else if (buf[1] === 0xbf) this.processLongRecord(buf, 43)
        else if (buf[1] === 0xcf) this.processLongRecord(buf, 42)
    }
}
