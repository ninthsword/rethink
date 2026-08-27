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
    5: 'NORMAL',
    6: 'SOAK',
    7: 'STEAM_REFRESH',
    8: 'EXPRESS',
    9: 'STEAM_TUB_CLEAN',
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

function binarySensor(name: string, icon: string, extra: object = {}) {
    return {
        platform: 'binary_sensor',
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
                    door: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door',
                        state_topic: '$this/door',
                        name: 'Door',
                        device_class: 'door',
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
                    current_download_course: sensor('current_download_course', 'mdi:download-circle-outline', {
                        name: 'Stored download course',
                    }),
                    chime_enabled: binarySensor('chime_enabled', 'mdi:volume-high', { name: 'Product chime' }),
                    tub_sterilization_reminder: binarySensor('tub_sterilization_reminder', 'mdi:bell-ring-outline', {
                        name: 'Tub sterilization reminder',
                    }),
                    front_time_display: binarySensor('front_time_display', 'mdi:clock-digital', {
                        name: 'Front time display',
                    }),
                    rinse_aid_level: sensor('rinse_aid_level', 'mdi:cup-water', { name: 'Rinse aid level' }),
                    water_hardness_level: sensor('water_hardness_level', 'mdi:water-opacity', {
                        name: 'Water hardness level',
                    }),
                    dual_zone: binarySensor('dual_zone', 'mdi:table-split-cell', { name: 'Dual zone' }),
                    half_load_zone: sensor('half_load_zone', 'mdi:arrow-up-down-bold', { name: 'Half load zone' }),
                    extra_rinse: binarySensor('extra_rinse', 'mdi:water-plus', { name: 'Safe rinse' }),
                    steam: binarySensor('steam', 'mdi:kettle-steam', { name: 'Steam' }),
                    high_temp_sanitize: binarySensor('high_temp_sanitize', 'mdi:thermometer-high', {
                        name: 'High temperature sanitize',
                    }),
                    high_temp_dry: binarySensor('high_temp_dry', 'mdi:thermometer-high', {
                        name: 'High temperature dry',
                    }),
                    control_lock: binarySensor('control_lock', 'mdi:lock', { name: 'Control lock' }),
                    delay_active: binarySensor('delay_active', 'mdi:timer-sand', { name: 'Delay active' }),
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
        const isOff = state === 0 || state === 4
        this.publishProperty('power', isOff ? 'OFF' : 'ON')
        // Opening the door while state remained POWEROFF changed only bit 0x02 here;
        // the official ThinQ door entity changed from closed to open at the same instant.
        this.publishProperty('door', (rec[13] & 0x02) !== 0 ? 'ON' : 'OFF')
        // The appliance settles from POWEROFF into STANDBY without becoming operable.
        this.publishProperty('status', isOff ? 'POWEROFF' : mapped(STATUS, state))
        this.publishProperty('run_completed', state === 5 || rec[3] === 5 ? 'ON' : 'OFF')
        this.publishProperty('process', mapped(PROCESS, rec[3]))
        // A captured cycle held rec[5:6] constant while rec[9:10] counted to zero.
        this.publishProperty('remaining_time', isOff ? 0 : rec[9] * 60 + rec[10])
        this.publishProperty('initial_time', rec[5] * 60 + rec[6])
        this.publishProperty('reserve_time', rec[11] * 60 + rec[12])
        // A download cycle reuses the INTENSIVE raw course. It is distinguishable only by
        // its own marker and non-zero active-download byte; the stored download selection
        // alone (rec[25]) must not turn a normal intensive cycle into a download cycle.
        const isDownloadCycle = rec[7] === 2 && rec[8] === 1 && rec[22] !== 0
        this.publishProperty('course', isDownloadCycle ? 'DOWNLOAD_CYCLE' : mapped(COURSE, rec[7]))
        this.publishProperty('current_download_course', mapped(DOWNLOAD_COURSE, rec[25]))
        this.publishProperty('chime_enabled', (rec[13] & 0x10) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('tub_sterilization_reminder', (rec[13] & 0x20) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('front_time_display', (rec[17] & 0x08) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('rinse_aid_level', rec[15])
        this.publishProperty('water_hardness_level', rec[16])
        this.publishProperty('dual_zone', (rec[14] & 0x10) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('half_load_zone', mapped({ 0: 'disabled', 32: 'LOWER', 64: 'UPPER' }, rec[14] & 0x60))
        this.publishProperty('extra_rinse', (rec[17] & 0x04) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('steam', (rec[14] & 0x80) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('high_temp_sanitize', (rec[14] & 0x08) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('high_temp_dry', (rec[14] & 0x04) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('control_lock', (rec[13] & 0x01) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('delay_active', (rec[14] & 0x01) !== 0 ? 'ON' : 'OFF')
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
        else if (buf[1] === 0xbf && buf.length === 102) this.processLongRecord(buf, 43)
        else if (buf[1] === 0xcf && buf.length === 101) this.processLongRecord(buf, 42)
    }
}
