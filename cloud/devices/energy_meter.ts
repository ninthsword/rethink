import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import log from '@/util/logging'

/**
 * Where the running totals are kept.
 *
 * Only rethink-cloud has a data directory; under the test runner or the tools there is
 * nowhere to write and the total simply lives for the process. This used to be worked out
 * by looking for "rethink-cloud" in process.argv[1], which was one rename or one wrapper
 * script away from silently keeping nothing — and a total that silently restarts at zero is
 * read by Home Assistant as a meter being replaced.
 */
let dataDir: string | undefined

/** Called once at startup. Anything constructed before this keeps its total in memory. */
export function setEnergyDataDirectory(directory: string) {
    dataDir = directory
}

/**
 * A running total of the energy an appliance has used, kept as a meter reading so Home
 * Assistant's energy dashboard can take the differences and produce the hours, days and
 * months itself.
 *
 * Most appliances that measure their own consumption only report it as power: watts, now.
 * The total is estimated from that by adding what was drawn over the time since the last
 * reading — the same thing LG's cloud does, which is why the ThinQ app says its figures may
 * differ from actual. An appliance that reports measured intervals of its own is believed
 * instead, permanently and across restarts, so the two can never be added to one total.
 */

/** Beyond this, the gap is time the appliance did not report and nothing is assumed about it. */
const MAX_POWER_SAMPLE_GAP_S = 5 * 60
/**
 * Power samples arrive several times a second. Publishing and saving on each one would put
 * thousands of retained messages and file writes an hour behind a figure that moves by
 * fractions of a watt-hour.
 */
const PUBLISH_INTERVAL_MS = 60 * 1000
/** A repeat of the same interval report within this window is a retransmission, not more energy. */
const REPEAT_REPORT_WINDOW_MS = 2 * 60 * 1000

export type EnergyMeterState = {
    /** It only ever goes up. Periods are Home Assistant's job. */
    totalWh: number
    lastReportSignature?: string
    lastReportAt?: number
    /** Set once the appliance has reported a measured interval of its own. */
    fromReports?: boolean
}

/** The Home Assistant sensor this meter feeds. Paired with the appliance's power sensor. */
export function energyTotalComponent(name = '누적 전력 사용량') {
    return {
        platform: 'sensor',
        device_class: 'energy',
        unique_id: '$deviceid-energy_total',
        state_topic: '$this/energy_total',
        name,
        unit_of_measurement: 'Wh',
        // A meter reading, not a bucket: Home Assistant takes the differences.
        state_class: 'total_increasing',
        icon: 'mdi:lightning-bolt',
    }
}

export class EnergyMeter {
    state: EnergyMeterState
    private lastSampleAt: number | undefined
    private lastPublishAt = 0

    constructor(
        readonly deviceId: string,
        private readonly publishTotal: (wh: number) => void,
    ) {
        this.state = this.load()
    }

    private path() {
        return dataDir ? join(dataDir, `air-conditioner-energy-${this.deviceId}.json`) : undefined
    }

    private load(): EnergyMeterState {
        const empty: EnergyMeterState = { totalWh: 0 }
        const path = this.path()
        if (!path) return empty
        try {
            const saved = JSON.parse(readFileSync(path, 'utf-8')) as EnergyMeterState
            return {
                totalWh: Number(saved.totalWh) || 0,
                ...(saved.lastReportSignature ? { lastReportSignature: saved.lastReportSignature } : {}),
                ...(Number.isFinite(saved.lastReportAt) ? { lastReportAt: Number(saved.lastReportAt) } : {}),
                // Which source is in use has to survive a restart, or an appliance that does
                // report intervals would be estimated against until its next report and then
                // have the measured figure added on top of the estimate.
                ...(saved.fromReports ? { fromReports: true } : {}),
            }
        } catch {
            return empty
        }
    }

    private save() {
        const path = this.path()
        if (!path) return
        const temporary = `${path}.tmp`
        try {
            writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 })
            renameSync(temporary, path)
        } catch (err) {
            log('status', this.deviceId, `unable to save the energy total: ${err}`)
        }
    }

    publish() {
        this.publishTotal(Math.round(this.state.totalWh))
    }

    /**
     * Add what the appliance drew since the last reading. The appliance stops reporting
     * power altogether when it is switched off, so a long gap is time nothing is known
     * about and guessing at it is worse than leaving it out.
     */
    integratePower(watts: number, now = Date.now(), running = true) {
        /*
         * A switched-off appliance is not measured, it is substituted: these units report a
         * fixed figure in standby that stands in for a reading nobody took. Adding it up
         * would put a made-up hundred-odd watt-hours a day on the total, so an appliance
         * that is off contributes nothing — and it forgets when it was last seen, so that
         * the time it spent off is not handed to the first reading after it comes back.
         */
        if (!running) {
            this.lastSampleAt = undefined
            return
        }

        const previous = this.lastSampleAt
        this.lastSampleAt = now
        // A measured report arrived once, so that is what this appliance is counted by.
        if (this.state.fromReports || previous === undefined) return

        const seconds = Math.min((now - previous) / 1000, MAX_POWER_SAMPLE_GAP_S)
        if (!(seconds > 0) || !Number.isFinite(watts) || watts < 0) return

        this.state.totalWh += (watts * seconds) / 3600

        if (now - this.lastPublishAt < PUBLISH_INTERVAL_MS) return
        this.lastPublishAt = now
        this.publish()
        this.save()
    }

    /** An interval the appliance measured itself, which beats anything estimated. */
    addMeasuredInterval(intervalWh: number, intervalSeconds: number, now = Date.now()) {
        this.state.fromReports = true
        const signature = `${intervalWh}:${intervalSeconds}`
        if (
            this.state.lastReportSignature === signature &&
            this.state.lastReportAt != null &&
            now - this.state.lastReportAt < REPEAT_REPORT_WINDOW_MS
        )
            return

        this.state.lastReportSignature = signature
        this.state.lastReportAt = now
        this.state.totalWh += intervalWh
        this.publish()
        this.save()
    }
}
