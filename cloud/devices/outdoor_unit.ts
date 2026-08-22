import type { HAConfig } from '@/util/config'
import { EnergyMeter } from './energy_meter'
import log from '@/util/logging'

/**
 * Air conditioners that share an outdoor unit.
 *
 * Each indoor unit reports the outdoor unit's power rather than its own share, but only
 * while it is itself running — measured by running a 2-in-1's two heads against the
 * whole-house meter. With both on, the two read within a few watts of each other, so adding
 * them counts the same compressor twice; with only the bedroom on, the living room reported
 * three watts while the outdoor unit drew eight hundred, so taking either one alone loses
 * whatever the other was doing.
 *
 * What is actually true of the outdoor unit is the highest reading among the heads that are
 * running. That is what this publishes, and what the group's energy is accumulated from.
 * The individual power readings stay as they are — they are the appliance's own view — but
 * only the group carries a total.
 */
export type OutdoorUnitConfig = {
    /** For the log and for the owner's benefit; not used in any identifier. */
    name?: string
    /** Appliance ids sharing one outdoor unit. The first carries the group's sensors. */
    devices: string[]
}

const groups = new Map<string, OutdoorUnit>()

export class OutdoorUnit {
    private readonly readings = new Map<string, number>()
    private readonly energy: EnergyMeter
    private publisher: ((property: string, value: string | number) => void) | undefined

    constructor(
        readonly primaryId: string,
        readonly memberIds: readonly string[],
        readonly name: string,
    ) {
        this.energy = new EnergyMeter(`${primaryId}-outdoor`, (wh) => this.publisher?.('outdoor_energy_total', wh))
    }

    isPrimary(deviceId: string) {
        return deviceId === this.primaryId
    }

    /** The primary's device is where the group's two sensors appear. */
    attachPrimary(publish: (property: string, value: string | number) => void) {
        this.publisher = publish
        this.publish()
    }

    /**
     * A head that is off is reporting a standby placeholder, not a measurement, so it takes
     * no part in the maximum. When every head is off the outdoor unit is off.
     */
    report(deviceId: string, watts: number, running: boolean) {
        if (running) this.readings.set(deviceId, watts)
        else this.readings.delete(deviceId)
        this.recompute()
    }

    /**
     * A head has gone away without saying it stopped.
     *
     * Only a report of its own can take a head out of the maximum, so a head that loses its
     * connection while running leaves its last reading behind — and the group goes on
     * publishing that figure, and going on accumulating energy from it, for as long as any
     * other head keeps reporting. A 2-in-1 with one head unplugged at 470 W would have gone
     * on adding 470 W to a total the energy dashboard treats as a meter reading.
     */
    forget(deviceId: string) {
        if (!this.readings.delete(deviceId)) return
        this.recompute()
    }

    private recompute() {
        const running = this.readings.size > 0
        const power = running ? Math.max(...this.readings.values()) : 0
        this.publisher?.('outdoor_power', power)
        this.energy.integratePower(power, Date.now(), running)
    }

    /**
     * The compressor lives in the outdoor unit, so whether it is turning is a fact about
     * the group and not about any one head. Only some heads report it: the bedroom unit
     * sends the Hz tag and the living room one never does, and the bedroom sends it while
     * switched off — 15 Hz with its own power at standby, at the same minute the living
     * room head was drawing 473 W. It is describing the compressor it shares, so it is
     * reported here as it arrives, without reference to the sender's own power.
     */
    reportCompressor(running: boolean) {
        this.publisher?.('outdoor_compressor', running ? 'ON' : 'OFF')
    }

    publish() {
        this.energy.publish()
    }
}

/** The group this appliance belongs to, if the owner has declared one. */
export function outdoorUnitFor(config: HAConfig | undefined, deviceId: string) {
    // A connection without configuration is a test harness, and a configuration without
    // groups is the ordinary case: an appliance with an outdoor unit to itself.
    for (const group of config?.outdoor_units ?? []) {
        const devices = group.devices ?? []
        if (!devices.includes(deviceId)) continue
        const primaryId = devices[0]
        let unit = groups.get(primaryId)
        if (!unit) {
            unit = new OutdoorUnit(primaryId, devices, group.name ?? primaryId)
            groups.set(primaryId, unit)
            log('status', `outdoor unit "${unit.name}" shared by ${devices.length} appliances`)
        }
        return unit
    }
    return undefined
}

/** The sensors a shared outdoor unit puts on its primary appliance. */
export function outdoorUnitComponents() {
    return {
        outdoor_power: {
            platform: 'sensor',
            unique_id: '$deviceid-outdoor_power',
            state_topic: '$this/outdoor_power',
            name: '실외기 소비 전력',
            device_class: 'power',
            unit_of_measurement: 'W',
            state_class: 'measurement',
            suggested_display_precision: 0,
        },
        outdoor_compressor: {
            platform: 'binary_sensor',
            unique_id: '$deviceid-outdoor_compressor',
            state_topic: '$this/outdoor_compressor',
            name: '실외기 압축기',
            device_class: 'running',
            icon: 'mdi:air-conditioner',
        },
        outdoor_energy_total: {
            platform: 'sensor',
            unique_id: '$deviceid-outdoor_energy_total',
            state_topic: '$this/outdoor_energy_total',
            name: '실외기 누적 전력 사용량',
            device_class: 'energy',
            unit_of_measurement: 'Wh',
            state_class: 'total_increasing',
            icon: 'mdi:lightning-bolt',
        },
    }
}

/** Only for tests: groups are process-wide and would otherwise leak between them. */
export function resetOutdoorUnits() {
    groups.clear()
}
