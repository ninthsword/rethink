import HADevice from './base'
import AABBDevice from './aabb_device'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'

const MONITOR_STATUS: Record<number, string> = {
    0: 'MONITOR_FAIL',
    1: 'MONITOR_NOT_WORKING',
    2: 'MONITOR_NORMAL',
}

function temperature(name: string) {
    return {
        platform: 'sensor',
        unique_id: `$deviceid-${name}`,
        state_topic: `$this/${name}`,
        name,
        icon: 'mdi:thermometer',
        device_class: 'temperature',
        unit_of_measurement: '°C',
        state_class: 'measurement',
    }
}

function binary(name: string, icon: string) {
    return {
        platform: 'binary_sensor',
        unique_id: `$deviceid-${name}`,
        state_topic: `$this/${name}`,
        name,
        icon,
    }
}

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Kimchi Refrigerator' }),
                components: {
                    top_room_temperature: temperature('top_room_temperature'),
                    middle_room_temperature: temperature('middle_room_temperature'),
                    bottom_room_temperature: temperature('bottom_room_temperature'),
                    door: binary('door', 'mdi:fridge-outline'),
                    display_lock: binary('display_lock', 'mdi:lock'),
                    one_touch_filter: binary('one_touch_filter', 'mdi:air-filter'),
                    monitor_status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-monitor_status',
                        state_topic: '$this/monitor_status',
                        name: 'Monitor status',
                        icon: 'mdi:heart-pulse',
                        entity_category: 'diagnostic',
                    },
                },
            }),
        )
    }

    private processStatus(status: Buffer) {
        if (status.length !== 9) return

        if (status[1] !== 0xff) this.publishProperty('top_room_temperature', status[1])
        if (status[3] !== 0xff) this.publishProperty('middle_room_temperature', status[3])
        if (status[4] !== 0xff) this.publishProperty('bottom_room_temperature', status[4])
        if (status[6] !== 0xff) this.publishProperty('door', status[6] === 1 ? 'ON' : 'OFF')
        if (status[7] !== 0xff) this.publishProperty('display_lock', status[7] === 1 ? 'ON' : 'OFF')
        if (status[8] !== 0xff) this.publishProperty('one_touch_filter', status[8] === 1 ? 'ON' : 'OFF')
        if (status[0] !== 0xff) this.publishProperty('monitor_status', MONITOR_STATUS[status[0]] ?? `RAW_${status[0]}`)
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== 0x11) return
        if (buf[1] === 0xeb && buf.length === 11) this.processStatus(buf.subarray(2, 11))
        else if (buf[1] === 0xec && buf.length === 20) this.processStatus(buf.subarray(11, 20))
    }
}
