import { Environment, Thinq1DeviceState, Thinq2DeviceState } from './thinqApi'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'

export type Credentials = {
    refreshToken: string
    env: Environment
}

export type BridgeState = {
    getCredentials(): Credentials | undefined
    setCredentials(credentials: Credentials | undefined): void
    getDeviceState(id: string): Thinq1DeviceState | Thinq2DeviceState | undefined
    setDeviceState(id: string, state: Thinq1DeviceState | Thinq2DeviceState | undefined): void
    /**
     * Puts a device's registration aside instead of destroying it, for when its entry is
     * removed from the router list. Deleting an entry by mistake used to leave the
     * registration behind and re-adding it produced two identities for one appliance;
     * deleting it outright would instead cost a registration that cannot be rebuilt
     * without the appliance. Keeping a copy is what makes the removal reversible.
     */
    archiveDeviceState(id: string): boolean
    /** Brings an archived registration back, unless a live one has taken its place. */
    restoreDeviceState(id: string): boolean
}

export class JSONStorage implements BridgeState {
    constructor(readonly basePath: string) {}

    oauth2Path() {
        return `${this.basePath}/oauth2.json`
    }

    devicePath(id: string) {
        return `${this.basePath}/device_${id}.json`
    }

    archivePath(id: string) {
        return `${this.basePath}/device_${id}.archived.json`
    }

    getCredentials() {
        try {
            return JSON.parse(readFileSync(this.oauth2Path()).toString('utf-8')) as Credentials
        } catch (err) {
            return undefined
        }
    }

    setCredentials(credentials: Credentials | undefined) {
        if (credentials) writeFileSync(this.oauth2Path(), JSON.stringify(credentials))
        else unlinkSync(this.oauth2Path())
    }

    getDeviceState(id: string) {
        try {
            return JSON.parse(readFileSync(this.devicePath(id)).toString('utf-8')) as
                | Thinq1DeviceState
                | Thinq2DeviceState
        } catch (err) {
            return undefined
        }
    }

    setDeviceState(id: string, state: Thinq1DeviceState | Thinq2DeviceState | undefined) {
        if (state) writeFileSync(this.devicePath(id), JSON.stringify(state))
        else unlinkSync(this.devicePath(id))
    }

    archiveDeviceState(id: string) {
        const state = this.getDeviceState(id)
        if (!state) return false
        writeFileSync(this.archivePath(id), JSON.stringify(state))
        unlinkSync(this.devicePath(id))
        return true
    }

    restoreDeviceState(id: string) {
        // A registration made since the archive was taken is the current one and wins: the
        // appliance was deliberately registered afresh rather than restored by accident.
        if (this.getDeviceState(id)) return false
        try {
            writeFileSync(this.devicePath(id), readFileSync(this.archivePath(id)))
            return true
        } catch {
            return false
        }
    }
}
