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

/*
 * The bytes that look like a compartment temperature are really a storage mode: the
 * model schema maps each raw value to a mode label through roomNTemp_C, and every
 * compartment has its own list. The names below follow those labels; the Korean
 * wording comes from LG's own language pack for this product type.
 *
 * "Strong" and "weak" are the appliance's own words for the two steps around the
 * middle setting of a mode, which is why they read as high and low here.
 */
const KIMCHI_MODES: Record<number, string> = {
    0: 'kimchi_medium',
    1: 'kimchi_high',
    2: 'kimchi_low',
}

const TOP_ROOM_MODES: Record<number, string> = {
    ...KIMCHI_MODES,
    3: 'fridge_medium',
    4: 'fridge_high',
    5: 'fridge_low',
    6: 'freezer',
    7: 'fermenting',
    8: 'fermentation_done',
    9: 'top_off',
}

const MIDDLE_ROOM_MODES: Record<number, string> = {
    ...KIMCHI_MODES,
    3: 'produce_medium',
    4: 'produce_high',
    5: 'produce_low',
    6: 'meat_fish',
    7: 'lacto_kimchi',
    8: 'lacto_kimchi_step_1',
    9: 'lacto_kimchi_step_2',
    10: 'lacto_kimchi_step_3',
    11: 'fermenting',
    12: 'fermentation_done',
    13: 'middle_off',
}

const BOTTOM_ROOM_MODES: Record<number, string> = {
    ...KIMCHI_MODES,
    3: 'produce_medium',
    4: 'produce_high',
    5: 'produce_low',
    6: 'rice_grain',
    7: 'bought_kimchi',
    8: 'long_storage',
    9: 'bottom_off',
}

/** The appliance sends this for a compartment it does not have, or a value it will not report. */
const IGNORE = 0xff

function mode(name: string, label: string, modes: Record<number, string>) {
    return {
        platform: 'sensor',
        unique_id: `$deviceid-${name}`,
        state_topic: `$this/${name}`,
        name: label,
        icon: 'mdi:fridge-outline',
        device_class: 'enum',
        options: Object.values(modes),
    }
}

/**
 * The raw byte, kept under the id it has always had. It is a mode code rather than a
 * reading in degrees, but it is the number this appliance has always shown in Home
 * Assistant, so it stays next to the decoded mode instead of being taken away.
 */
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
                    top_room_mode: mode('top_room_mode', 'Top room', TOP_ROOM_MODES),
                    middle_room_mode: mode('middle_room_mode', 'Middle room', MIDDLE_ROOM_MODES),
                    bottom_room_mode: mode('bottom_room_mode', 'Bottom room', BOTTOM_ROOM_MODES),
                    top_room_temperature: temperature('top_room_temperature'),
                    middle_room_temperature: temperature('middle_room_temperature'),
                    bottom_room_temperature: temperature('bottom_room_temperature'),
                    door: binary('door', 'mdi:fridge-outline'),
                    display_lock: binary('display_lock', 'mdi:lock'),
                    // LG's own name for this is 원터치 탈취; it is a deodorizing cycle, not a filter state.
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

    private publishRoom(comp: string, raw: number, modes: Record<number, string>) {
        if (raw === IGNORE) return
        this.publishProperty(`${comp}_mode`, modes[raw] ?? `RAW_${raw}`)
        this.publishProperty(`${comp}_temperature`, raw)
    }

    private processStatus(status: Buffer) {
        if (status.length !== 9) return

        // status[2] is room2, the right-hand top compartment of the wider models. This one
        // does not have it and always reports the ignore value.
        this.publishRoom('top_room', status[1], TOP_ROOM_MODES)
        this.publishRoom('middle_room', status[3], MIDDLE_ROOM_MODES)
        this.publishRoom('bottom_room', status[4], BOTTOM_ROOM_MODES)
        if (status[6] !== IGNORE) this.publishProperty('door', status[6] === 1 ? 'ON' : 'OFF')
        if (status[7] !== IGNORE) this.publishProperty('display_lock', status[7] === 1 ? 'ON' : 'OFF')
        if (status[8] !== IGNORE) this.publishProperty('one_touch_filter', status[8] === 1 ? 'ON' : 'OFF')
        if (status[0] !== IGNORE) this.publishProperty('monitor_status', MONITOR_STATUS[status[0]] ?? `RAW_${status[0]}`)
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== 0x11) return
        if (buf[1] === 0xeb && buf.length === 11) this.processStatus(buf.subarray(2, 11))
        else if (buf[1] === 0xec && buf.length === 20) this.processStatus(buf.subarray(11, 20))
    }
}
