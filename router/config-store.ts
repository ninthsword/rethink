import { randomUUID } from 'node:crypto'
import {
    closeSync,
    constants,
    fstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    readSync,
    renameSync,
    writeFileSync,
} from 'node:fs'
import { isIP } from 'node:net'
import path from 'node:path'

export type RouterSSHConfig = {
    host: string
    port: number
    username: string
    password: string
    rethinkIp: string
    hostKeyFingerprint?: string
}

export type RouterDeviceEntry = {
    entryId: string
    ip: string
    deviceId?: string
    autoLink?: boolean
    detectedName?: string
    customName?: string
    platform?: 'thinq1' | 'thinq2'
    /**
     * Whether this device is meant to have its DNAT rules in place. The router holds the
     * rules themselves and loses them on reboot, so this is the only record of what the
     * user asked for; the reconciler restores from it.
     */
    mode?: 'dnat' | 'local'
    dnatDesired?: boolean
}

export type RouterConfig = {
    router: RouterSSHConfig
    devices: RouterDeviceEntry[]
}

const emptyConfig = (): RouterConfig => ({
    router: { host: '', port: 22, username: '', password: '', rethinkIp: '' },
    devices: [],
})

function validIPv4(value: string) {
    return isIP(value) === 4
}

export function isHostKeyFingerprint(value: unknown): value is string {
    return (
        typeof value === 'string' &&
        /^SHA256:[A-Za-z0-9+/]{43}$/.test(value) &&
        Buffer.from(value.slice(7), 'base64').toString('base64').replace(/=+$/, '') === value.slice(7)
    )
}

function companionFingerprint(filename: string, router: RouterSSHConfig) {
    let descriptor: number | undefined
    try {
        descriptor = openSync(
            path.join(path.dirname(filename), 'router-ssh-trust.json'),
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        )
        const stat = fstatSync(descriptor)
        if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o600 || stat.size > 4096)
            return
        const buffer = Buffer.alloc(4097)
        const length = readSync(descriptor, buffer, 0, buffer.length, 0)
        if (length > 4096) return
        const trust = JSON.parse(buffer.subarray(0, length).toString('utf-8')) as Record<string, unknown>
        if (trust.host === router.host && trust.port === router.port && isHostKeyFingerprint(trust.hostKeyFingerprint))
            return trust.hostKeyFingerprint
    } catch {
        // Missing or unsafe trust never changes inventory or permits credential use.
    } finally {
        if (descriptor !== undefined) closeSync(descriptor)
    }
}

export class RouterConfigStore {
    private config: RouterConfig
    private persisted: RouterConfig
    private pending: Promise<unknown> = Promise.resolve()
    readonly released = new Set<string>()

    /** One queue covers API preconditions, intent changes and periodic reconciliation. */
    exclusive<T>(action: () => Promise<T>): Promise<T> {
        const result = this.pending.then(action)
        this.pending = result.catch(() => {})
        return result
    }

    constructor(readonly filename: string) {
        this.config = this.load()
        this.persisted = structuredClone(this.config)
    }

    private load() {
        try {
            const parsed = JSON.parse(readFileSync(this.filename, 'utf-8')) as Partial<RouterConfig>
            const router = { ...emptyConfig().router, ...parsed.router }
            if (!Object.prototype.hasOwnProperty.call(parsed.router ?? {}, 'hostKeyFingerprint')) {
                const fingerprint = companionFingerprint(this.filename, router)
                if (fingerprint) router.hostKeyFingerprint = fingerprint
            }
            return {
                router,
                /*
                 * These addresses are interpolated into an iptables command that runs on the
                 * router as root. Everything arriving through the API is checked; the file
                 * was trusted, which put the boundary in the wrong place — a hand-edited or
                 * truncated file would have carried whatever it said straight to that
                 * command line. Anything that is not an IPv4 address is dropped.
                 */
                devices: Array.isArray(parsed.devices)
                    ? parsed.devices.filter(
                          (entry): entry is RouterDeviceEntry =>
                              !!entry && typeof entry === 'object' && validIPv4(`${(entry as RouterDeviceEntry).ip}`),
                      )
                    : [],
            }
        } catch {
            return emptyConfig()
        }
    }

    private save() {
        try {
            mkdirSync(path.dirname(this.filename), { recursive: true })
            const temporary = `${this.filename}.tmp`
            writeFileSync(temporary, JSON.stringify(this.config, null, 2), { mode: 0o600 })
            renameSync(temporary, this.filename)
            this.persisted = structuredClone(this.config)
        } catch (error) {
            this.config = structuredClone(this.persisted)
            throw error
        }
    }

    hasConnectionSettings() {
        const r = this.config.router
        return validIPv4(r.host) && validIPv4(r.rethinkIp) && !!r.username && !!r.password && r.port > 0
    }

    configured() {
        return this.hasConnectionSettings() && isHostKeyFingerprint(this.config.router.hostKeyFingerprint)
    }

    router() {
        return { ...this.config.router }
    }

    publicRouter() {
        const { password, ...router } = this.config.router
        return { ...router, passwordSaved: !!password }
    }

    recoverHostKeyFingerprint(input: unknown) {
        const current = this.config.router
        if (
            (current.hostKeyFingerprint !== undefined && current.hostKeyFingerprint !== '') ||
            !input ||
            typeof input !== 'object' ||
            Array.isArray(input)
        )
            return false
        const fields = input as Record<string, unknown>
        const keys = Object.keys(fields)
        if (
            !isHostKeyFingerprint(fields.hostKeyFingerprint) ||
            keys.some(
                (key) => !['host', 'port', 'username', 'password', 'rethinkIp', 'hostKeyFingerprint'].includes(key),
            ) ||
            ['host', 'port', 'username', 'rethinkIp'].some(
                (key) => keys.includes(key) && fields[key] !== current[key as keyof RouterSSHConfig],
            ) ||
            (fields.password !== undefined && fields.password !== '') ||
            !validIPv4(current.host) ||
            !validIPv4(current.rethinkIp) ||
            !Number.isInteger(current.port) ||
            current.port < 1 ||
            current.port > 65535 ||
            !current.username ||
            !current.password
        )
            return false
        // Restore only absent trust; preserve the exact saved credentials, inventory and intent.
        this.config.router = { ...current, hostKeyFingerprint: fields.hostKeyFingerprint }
        this.save()
        return true
    }

    updateRouter(input: Partial<RouterSSHConfig>) {
        const current = this.config.router
        const next = {
            host: `${input.host ?? current.host}`.trim(),
            port: Number(input.port ?? current.port),
            username: `${input.username ?? current.username}`.trim(),
            password: input.password ? `${input.password}` : current.password,
            rethinkIp: `${input.rethinkIp ?? current.rethinkIp}`.trim(),
            hostKeyFingerprint:
                input.hostKeyFingerprint !== undefined
                    ? `${input.hostKeyFingerprint}`.trim()
                    : `${input.host ?? current.host}`.trim() === current.host &&
                        Number(input.port ?? current.port) === current.port
                      ? current.hostKeyFingerprint
                      : undefined,
        }
        if (!validIPv4(next.host)) throw new Error('Invalid router IPv4 address')
        if (!validIPv4(next.rethinkIp)) throw new Error('Invalid rethink IPv4 address')
        if (!Number.isInteger(next.port) || next.port < 1 || next.port > 65535) throw new Error('Invalid SSH port')
        if (!next.username) throw new Error('SSH username is required')
        if (!next.password) throw new Error('SSH password is required')
        if (next.hostKeyFingerprint && !isHostKeyFingerprint(next.hostKeyFingerprint))
            throw new Error('SSH 호스트 키 지문은 SHA256 형식이어야 합니다.')
        if (this.config.devices.some((entry) => entry.ip === next.host || entry.ip === next.rethinkIp))
            throw new Error('Router or rethink server IP is already registered as a device')
        this.config.router = next
        this.save()
        return this.publicRouter()
    }

    devices() {
        return this.config.devices.map((entry) => ({ ...entry }))
    }

    addDevice(ip: string, mode?: string) {
        if (mode !== undefined && mode !== 'dnat' && mode !== 'local') throw new Error('Mode must be dnat or local')
        ip = `${ip}`.trim()
        if (!validIPv4(ip)) throw new Error('Invalid device IPv4 address')
        if (ip === this.config.router.host || ip === this.config.router.rethinkIp)
            throw new Error('Router or rethink server IP cannot be registered as a device')
        if (this.config.devices.some((entry) => entry.ip === ip)) throw new Error('Device IP is already registered')
        const entry: RouterDeviceEntry = {
            entryId: randomUUID(),
            ip,
            ...(mode ? { mode: mode as 'dnat' | 'local' } : {}),
        }
        this.config.devices.push(entry)
        this.save()
        return { ...entry }
    }

    updateDevice(entryId: string, input: { ip?: string; customName?: string; mode?: string }) {
        const entry = this.requireDevice(entryId)
        if (input.mode !== undefined) {
            if (input.mode !== 'dnat' && input.mode !== 'local') throw new Error('Mode must be dnat or local')
        }
        if (input.ip !== undefined && `${input.ip}`.trim() !== entry.ip) {
            const ip = `${input.ip}`.trim()
            if (!validIPv4(ip)) throw new Error('Invalid device IPv4 address')
            if (ip === this.config.router.host || ip === this.config.router.rethinkIp)
                throw new Error('Router or rethink server IP cannot be registered as a device')
            if (this.config.devices.some((other) => other !== entry && other.ip === ip))
                throw new Error('Device IP is already registered')
            entry.ip = ip
            entry.autoLink = undefined
            entry.deviceId = undefined
            entry.detectedName = undefined
            entry.platform = undefined
        }
        if (input.mode === 'dnat' || input.mode === 'local') entry.mode = input.mode
        if (input.customName !== undefined) entry.customName = `${input.customName}`.trim() || undefined
        this.save()
        return { ...entry }
    }

    deleteDevice(entryId: string) {
        const index = this.config.devices.findIndex((entry) => entry.entryId === entryId)
        if (index < 0) throw new Error('Unknown router device')
        this.config.devices.splice(index, 1)
        this.save()
    }

    linkDevice(entryId: string, deviceId: string, detectedName?: string, platform?: 'thinq1' | 'thinq2') {
        const entry = this.requireDevice(entryId)
        const duplicate = this.config.devices.find((item) => item !== entry && item.deviceId === deviceId)
        if (duplicate) throw new Error('Rethink device is already linked to another IP')
        entry.deviceId = `${deviceId}`
        entry.autoLink = undefined
        if (detectedName) entry.detectedName = detectedName
        if (platform) entry.platform = platform
        this.save()
        return { ...entry }
    }

    unlinkDevice(entryId: string) {
        const entry = this.requireDevice(entryId)
        entry.autoLink = false
        entry.deviceId = undefined
        entry.detectedName = undefined
        entry.platform = undefined
        this.save()
        return { ...entry }
    }

    requireDevice(entryId: string) {
        const entry = this.config.devices.find((item) => item.entryId === entryId)
        if (!entry) throw new Error('Unknown router device')
        return entry
    }

    linkByIp(
        ip: string | undefined,
        deviceId: string,
        detectedName: string | undefined,
        platform?: 'thinq1' | 'thinq2',
    ) {
        if (!ip) return false
        const entry = this.config.devices.find((item) => item.ip === ip)
        if (!entry || entry.autoLink === false) return false
        if (entry.deviceId && entry.deviceId !== deviceId) return false
        if (this.config.devices.some((other) => other !== entry && other.deviceId === deviceId)) return false
        const changed = entry.deviceId !== deviceId || (!!detectedName && entry.detectedName !== detectedName)
        entry.deviceId = deviceId
        if (detectedName) entry.detectedName = detectedName
        if (platform && entry.platform !== platform) {
            entry.platform = platform
            this.save()
            return true
        }
        if (changed) this.save()
        return changed
    }

    setDnatDesired(entryId: string, desired: boolean) {
        const entry = this.requireDevice(entryId)
        if (entry.dnatDesired === desired) return entry
        entry.dnatDesired = desired
        this.save()
        return entry
    }

    refreshDetectedName(deviceId: string, detectedName: string | undefined) {
        if (!detectedName) return false
        const entry = this.config.devices.find((item) => item.deviceId === deviceId)
        if (!entry || entry.detectedName === detectedName) return false
        entry.detectedName = detectedName
        this.save()
        return true
    }
}
