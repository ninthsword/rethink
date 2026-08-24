import { allowExtendedType } from '@/util/casting'
import type { Connection } from '../homeassistant'
import type { Metadata } from '../thinq'
import type { Device as Thinq2Device } from '../thinq2/device'
import AABBDevice from './aabb_device'
import HADevice from './base'

const STATUS: Record<number, string> = {
    0: 'POWEROFF',
    1: 'INITIAL',
    2: 'PAUSE',
    3: 'DETECTING',
    4: 'SOAKING',
    5: 'RUNNING',
    6: 'RINSING',
    7: 'SPINNING',
    8: 'END',
    9: 'RESERVED',
    10: 'FIRMWARE',
    11: 'DIAGNOSIS',
}
const PREVIOUS_STATUS: Record<number, string> = STATUS
/*
 * From the error table in LG's model JSON for this appliance. Its keys are the numbers the
 * appliance puts on the wire, unlike the course tables, so nothing had to be captured to
 * pair them. The gaps are real: the model skips 6, 7, 13-15 and everything between 17 and 26.
 * 0 keeps the NO_ERROR it has always published rather than the model's ERROR_NO, because that
 * value is already on screen and already translated.
 */
const ERROR: Record<number, string> = {
    0: 'NO_ERROR',
    1: 'ERROR_IE',
    2: 'ERROR_OE',
    3: 'ERROR_UE',
    4: 'ERROR_DE1',
    5: 'ERROR_PE',
    8: 'ERROR_DO',
    9: 'ERROR_LE',
    10: 'ERROR_AE',
    11: 'ERROR_TE',
    12: 'ERROR_FE',
    16: 'ERROR_DE2',
    27: 'ERROR_FF',
    36: 'ERROR_E7',
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

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Mini Washer' }),
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
                    error: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-error',
                        state_topic: '$this/error',
                        name: 'Error',
                        device_class: 'problem',
                    },
                    error_message: sensor('error_message', 'mdi:alert-circle-outline'),
                    door_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door_lock',
                        state_topic: '$this/door_lock',
                        name: 'Door lock',
                        icon: 'mdi:lock',
                    },
                },
            }),
        )
    }

    private processRecord(rec: Buffer) {
        if (rec.length !== 27 || rec[1] !== 0x19) return

        const state = rec[2]
        const isOff = state === 0
        const error = rec[22]
        this.publishProperty('power', isOff ? 'OFF' : 'ON')
        this.publishProperty('status', STATUS[state] ?? `RAW_${state}`)
        this.publishProperty('run_completed', state === 8 ? 'ON' : 'OFF')
        this.publishProperty('previous_status', PREVIOUS_STATUS[rec[21]] ?? `RAW_${rec[21]}`)
        // Its power-off record uses one minute in both fields as an idle sentinel.
        this.publishProperty('remaining_time', isOff ? 0 : rec[3] * 60 + rec[4])
        this.publishProperty('initial_time', isOff ? 0 : rec[5] * 60 + rec[6])
        this.publishProperty('reserve_time', rec[13] * 60 + rec[14])
        this.publishProperty('error', error === 0 ? 'OFF' : 'ON')
        this.publishProperty('error_message', ERROR[error] ?? `ERROR_${error}`)
        this.publishProperty('door_lock', (rec[16] & 0x08) !== 0 ? 'ON' : 'OFF')
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== 0x20) return
        if (buf[1] === 0xeb && buf.length === 29) this.processRecord(buf.subarray(2, 29))
        else if (buf[1] === 0xec && buf.length === 56) this.processRecord(buf.subarray(29, 56))
    }
}
