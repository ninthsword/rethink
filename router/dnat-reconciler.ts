import log from '@/util/logging'
import type { RouterConfigStore, RouterDeviceEntry } from './config-store'
import type { DNATState } from './dnat-manager'

/**
 * ASUS stock firmware drops user-added NAT chains on a reboot or a firewall restart, and
 * the router is the only place the rules live. Rethink keeps the entry list and now also
 * remembers which entries the user switched on, so it can put the rules back without
 * anyone opening the management page.
 *
 * The reconciler never turns DNAT on for an entry the user has not enabled, and never
 * turns one off: an entry switched off in the UI is recorded as such and skipped.
 */
export type DNATActuator = {
    status(devices: RouterDeviceEntry[]): Promise<Record<string, DNATState>>
    enable(device: RouterDeviceEntry): Promise<DNATState>
}

export const DEFAULT_RECONCILE_INTERVAL_MS = 5 * 60 * 1000
export const INITIAL_RECONCILE_DELAY_MS = 30 * 1000

export type ReconcileResult = { adopted: string[]; restored: string[] }

export class DNATReconciler {
    private timer: ReturnType<typeof setInterval> | undefined
    private initialTimer: ReturnType<typeof setTimeout> | undefined
    private running = false

    constructor(
        readonly store: RouterConfigStore,
        readonly actuator: () => DNATActuator,
        readonly intervalMs = DEFAULT_RECONCILE_INTERVAL_MS,
        readonly initialDelayMs = INITIAL_RECONCILE_DELAY_MS,
    ) {}

    start() {
        if (this.timer) return
        // The first cycle waits for the appliances and the router to settle after a
        // restart; it is also what adopts the rules that are already in place.
        this.initialTimer = setTimeout(() => void this.reconcile(), this.initialDelayMs)
        this.initialTimer.unref?.()
        this.timer = setInterval(() => void this.reconcile(), this.intervalMs)
        // A reconcile cycle must never hold the process open on its own.
        this.timer.unref?.()
    }

    stop() {
        if (this.initialTimer) clearTimeout(this.initialTimer)
        this.initialTimer = undefined
        if (this.timer) clearInterval(this.timer)
        this.timer = undefined
    }

    /**
     * Adopts rules that are already in place as the desired state, then restores the ones
     * that are meant to be on and are not.
     */
    async reconcile(): Promise<ReconcileResult> {
        const empty: ReconcileResult = { adopted: [], restored: [] }
        // Cycles are skipped rather than queued: the router is slow to answer over SSH and
        // a backlog would only pile up more connections to it.
        if (this.running || !this.store.configured()) return empty

        const entries = this.store.devices()
        if (!entries.length) return empty

        this.running = true
        const adopted: string[] = []
        const restored: string[] = []
        try {
            const actuator = this.actuator()
            const states = await actuator.status(entries)

            for (const entry of entries) {
                if (entry.dnatDesired !== undefined) continue
                // Entries that predate this record, or were forwarded by hand. A rule that
                // is in place was put there deliberately, so adopt it. Nothing is adopted
                // from an 'off' reading — the router may simply be rebooting right now.
                if (states[entry.entryId] !== 'on') continue
                this.store.setDnatDesired(entry.entryId, true)
                adopted.push(entry.entryId)
                log('status', 'adopting the DNAT already in place for', entry.ip)
            }

            for (const entry of this.store.devices()) {
                if (!entry.dnatDesired) continue
                // 'partial' counts as missing: half the ports forwarded is not a working
                // appliance, and enable() adds only what is absent.
                if (states[entry.entryId] === 'on') continue

                log('status', 'restoring DNAT for', entry.ip, `(was ${states[entry.entryId] ?? 'unknown'})`)
                try {
                    await actuator.enable(entry)
                    restored.push(entry.entryId)
                } catch (err) {
                    log('status', 'could not restore DNAT for', entry.ip, `${err}`)
                }
            }
        } catch (err) {
            // The router being unreachable is expected while it reboots.
            log('status', 'DNAT reconcile skipped:', `${err}`)
        } finally {
            this.running = false
        }
        return { adopted, restored }
    }
}
