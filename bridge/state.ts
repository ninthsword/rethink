import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import type { Environment, Thinq1DeviceState, Thinq2DeviceState } from './thinqApi'

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
    /** Whether an archived registration is waiting to be restored. */
    hasArchivedDeviceState(id: string): boolean
}

export class JSONStorage implements BridgeState {
    constructor(readonly basePath: string) {}

    /**
     * Writes through a temporary file so a crash cannot leave a half-written one behind.
     * What is kept here — the account's refresh token and each appliance's bridge
     * certificate — cannot be rebuilt without the appliance itself, so a truncated file
     * costs a registration rather than a retry. The router's own settings have always been
     * written this way; these are the files that deserve it more.
     *
     * The mode keeps them to the owner: they are credentials, and they were world readable.
     */
    /** Removing what is already gone is the desired end state, not an error. */
    private removeIfPresent(path: string) {
        if (existsSync(path)) unlinkSync(path)
    }

    private writeAtomically(path: string, contents: string | Buffer) {
        const temporary = `${path}.tmp`
        writeFileSync(temporary, contents, { mode: 0o600 })
        renameSync(temporary, path)
    }

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
        } catch (_err) {
            return undefined
        }
    }

    setCredentials(credentials: Credentials | undefined) {
        if (credentials) this.writeAtomically(this.oauth2Path(), JSON.stringify(credentials))
        else this.removeIfPresent(this.oauth2Path())
    }

    getDeviceState(id: string) {
        try {
            return JSON.parse(readFileSync(this.devicePath(id)).toString('utf-8')) as
                | Thinq1DeviceState
                | Thinq2DeviceState
        } catch (_err) {
            return undefined
        }
    }

    setDeviceState(id: string, state: Thinq1DeviceState | Thinq2DeviceState | undefined) {
        if (state) this.writeAtomically(this.devicePath(id), JSON.stringify(state))
        else this.removeIfPresent(this.devicePath(id))
    }

    archiveDeviceState(id: string) {
        const state = this.getDeviceState(id)
        if (!state) return false
        this.writeAtomically(this.archivePath(id), JSON.stringify(state))
        this.removeIfPresent(this.devicePath(id))
        return true
    }

    hasArchivedDeviceState(id: string) {
        try {
            readFileSync(this.archivePath(id))
            return true
        } catch {
            return false
        }
    }

    restoreDeviceState(id: string) {
        // A registration made since the archive was taken is the current one and wins: the
        // appliance was deliberately registered afresh rather than restored by accident.
        if (this.getDeviceState(id)) return false
        try {
            this.writeAtomically(this.devicePath(id), readFileSync(this.archivePath(id)))
            return true
        } catch {
            return false
        }
    }
}
