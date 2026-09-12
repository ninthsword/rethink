import type { AnyDevice } from '@/cloud/devmgr'
import type { RouterConfigStore, RouterDeviceEntry } from '@/router/config-store'

export type ApplianceMode = 'dnat' | 'local'

export function entryMode(entry: RouterDeviceEntry): ApplianceMode {
    return entry.mode === 'local' ? 'local' : 'dnat'
}

/** Policy is installed before Bridge subscribes to the device manager. */
export class BridgePolicy {
    constructor(readonly store: RouterConfigStore) {}

    entry(id: string, device?: AnyDevice) {
        const entries = this.store.devices()
        return (
            entries.find((entry) => entry.deviceId === id) ??
            entries.find(
                (entry) =>
                    entry.autoLink !== false &&
                    !entry.deviceId &&
                    device &&
                    'sourceIp' in device &&
                    entry.ip === device.sourceIp,
            )
        )
    }

    mode(id: string, device?: AnyDevice): ApplianceMode {
        const entry = this.entry(id, device)
        return entry ? entryMode(entry) : 'local'
    }

    forwarding(id: string, device?: AnyDevice) {
        const entry = this.entry(id, device)
        return (
            !!entry &&
            entryMode(entry) === 'dnat' &&
            entry.dnatDesired === true &&
            !this.store.released.has(entry.entryId)
        )
    }
}
