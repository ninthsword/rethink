import { createHash, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import type { IConnectPacket } from 'mqtt-packet'
import { isSafeDeviceId } from './device_id'
import type { Client, PublishPacket } from './mqtt-broker'

export type MQTTInventoryEntry = {
    entryId: string
    ip: string
    deviceId?: string
    autoLink?: boolean
    platform?: 'thinq1' | 'thinq2'
}
export type MQTTDiagnosticAccount = {
    username: string
    password: string
    device_ids: string[]
    allow_publish?: boolean
}
export type MQTTTransport = { tls: boolean }
export type MQTTSource = {
    remoteAddress?: string
    remotePort?: number
    localAddress?: string
    localPort?: number
}
export interface MQTTAccessPolicy {
    connect(
        packet: IConnectPacket,
        client: Client,
        transport: MQTTTransport,
        signal: AbortSignal,
    ): boolean | Promise<boolean>
    publish(packet: PublishPacket, client: Client): boolean
    subscribe(topic: string, client: Client): boolean
    deliver(topic: string, client: Client): boolean
    disconnect(client: Client): void
}

export const denyMQTTAccess: MQTTAccessPolicy = {
    connect: () => false,
    publish: () => false,
    subscribe: () => false,
    deliver: () => false,
    disconnect: () => {},
}

export function normalizeMQTTAddress(ip: string | undefined) {
    const value = ip?.replace(/^::ffff:/, '')
    return value && isIP(value) === 4 ? value : undefined
}

/** Keep the supported uplink prefix, but require one complete, exact device topic. */
export function parseDeviceTopic(topic: string) {
    if (!topic || Buffer.byteLength(topic) > 1024 || /[+#\0]/.test(topic)) return
    const lime = /^lime\/devices\/([^/]+)$/.exec(topic)
    if (lime && isSafeDeviceId(lime[1])) return { kind: 'lime' as const, deviceId: lime[1] }
    const normalized = topic.startsWith('clip/') ? topic : topic.slice(topic.lastIndexOf('/clip/') + 1)
    const clip = /^clip\/(message|provisioning)\/devices\/([^/]+)$/.exec(normalized)
    if (clip && isSafeDeviceId(clip[2])) return { kind: clip[1] as 'message' | 'provisioning', deviceId: clip[2] }
}

export function parseDevicePayload(payload: string | Buffer) {
    if (Buffer.byteLength(payload) > 64 * 1024) return
    try {
        let text = payload.toString()
        if (text.endsWith('\0')) text = text.slice(0, -1)
        const value: unknown = JSON.parse(text)
        if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
    } catch {
        // An invalid device envelope never reaches application consumers.
    }
}

export function validateMQTTDiagnostics(input: unknown): MQTTDiagnosticAccount[] {
    if (input === undefined) return []
    const invalid = () => new Error('MQTT 진단 계정 설정을 확인하세요.')
    if (!Array.isArray(input) || input.length > 32) throw invalid()
    const usernames = new Set<string>()
    return input.map((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
        const { username, password, device_ids, allow_publish } = value
        if (
            typeof username !== 'string' ||
            !/^[A-Za-z0-9_.-]{1,64}$/.test(username) ||
            usernames.has(username) ||
            typeof password !== 'string' ||
            Buffer.byteLength(password) < 16 ||
            Buffer.byteLength(password) > 256 ||
            !Array.isArray(device_ids) ||
            device_ids.length < 1 ||
            device_ids.length > 128 ||
            !device_ids.every(isSafeDeviceId) ||
            new Set(device_ids).size !== device_ids.length ||
            (allow_publish !== undefined && typeof allow_publish !== 'boolean')
        )
            throw invalid()
        usernames.add(username)
        return { username, password, device_ids: [...device_ids], allow_publish: allow_publish ?? false }
    })
}

type ApplianceSession = {
    kind: 'appliance'
    entryId: string
    ip: string
    id?: string
    linked: boolean
    revoked?: boolean
}
type Session = ApplianceSession | { kind: 'diagnostic'; ids: Set<string>; write: boolean }
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest()

export class DeviceMQTTAccess implements MQTTAccessPolicy {
    private sessions = new WeakMap<Client, Session>()
    private claims = new Map<string, { id: string; clients: Set<Client> }>()
    private accounts: Array<{ user: Buffer; pass: Buffer; ids: Set<string>; write: boolean }>

    constructor(
        private inventory: () => MQTTInventoryEntry[],
        accounts: MQTTDiagnosticAccount[] = [],
        private resolveSource?: (source: MQTTSource, signal: AbortSignal) => Promise<string | undefined>,
    ) {
        this.accounts = validateMQTTDiagnostics(accounts).map((account) => ({
            user: digest(account.username),
            pass: digest(account.password),
            ids: new Set(account.device_ids),
            write: account.allow_publish === true,
        }))
    }

    async connect(packet: IConnectPacket, client: Client, transport: MQTTTransport, signal: AbortSignal) {
        if (packet.username !== undefined || packet.password !== undefined) {
            if (!transport.tls || typeof packet.username !== 'string' || !packet.password || packet.will) return false
            const user = digest(packet.username),
                pass = digest(packet.password)
            let matched: (typeof this.accounts)[number] | undefined
            for (const account of this.accounts) {
                const userMatches = timingSafeEqual(user, account.user)
                const passMatches = timingSafeEqual(pass, account.pass)
                if (userMatches && passMatches) matched = account
            }
            if (!matched || signal.aborted) return false
            this.sessions.set(client, { kind: 'diagnostic', ids: matched.ids, write: matched.write })
            return true
        }
        const direct = normalizeMQTTAddress(client.remoteAddress)
        const ip = this.resolveSource
            ? await this.resolveSource(client.stream ?? { remoteAddress: direct }, signal)
            : direct
        if (!ip || signal.aborted) return false
        const entries = this.inventory()
        const matches = entries.filter((entry) => entry.ip === ip)
        const entry = matches.length === 1 ? matches[0] : undefined
        if (
            !entry?.entryId ||
            entry.platform === 'thinq1' ||
            entry.autoLink === false ||
            entries.filter((other) => other.entryId === entry.entryId).length !== 1 ||
            (entry.deviceId !== undefined && !isSafeDeviceId(entry.deviceId))
        )
            return false
        const session: ApplianceSession = {
            kind: 'appliance',
            entryId: entry.entryId,
            ip,
            id: entry.deviceId,
            linked: !!entry.deviceId,
        }
        this.sessions.set(client, session)
        client.sourceIp = ip
        if (session.id && !this.bind(session, client, session.id)) return false
        if (packet.will) {
            const topic = parseDeviceTopic(packet.will.topic)
            if (
                !topic ||
                topic.kind === 'lime' ||
                !this.bind(session, client, topic.deviceId) ||
                !this.publish(
                    {
                        topic: packet.will.topic,
                        payload: packet.will.payload,
                        qos: packet.will.qos ?? 0,
                        retain: packet.will.retain ?? false,
                        dup: false,
                    },
                    client,
                )
            )
                return false
        }
        return !signal.aborted
    }

    private current(session: ApplianceSession) {
        if (session.revoked) return
        const entries = this.inventory()
        const matches = entries.filter((entry) => entry.entryId === session.entryId)
        const entry = matches.length === 1 ? matches[0] : undefined
        if (
            !entry ||
            entry.ip !== session.ip ||
            entry.autoLink === false ||
            entry.platform === 'thinq1' ||
            entries.filter((other) => other.ip === session.ip).length !== 1 ||
            (entry.deviceId !== undefined && session.id !== undefined && entry.deviceId !== session.id) ||
            (session.linked && entry.deviceId !== session.id) ||
            (session.id && entries.some((other) => other.entryId !== session.entryId && other.deviceId === session.id))
        ) {
            session.revoked = true
            return
        }
        if (entry.deviceId && session.id) session.linked = true
        return entry
    }

    private bind(session: ApplianceSession, client: Client, id: string) {
        const entry = this.current(session)
        if (
            !entry ||
            (entry.deviceId !== undefined && entry.deviceId !== id) ||
            (session.id !== undefined && session.id !== id) ||
            this.inventory().some((other) => other.entryId !== session.entryId && other.deviceId === id)
        )
            return false
        for (const [entryId, claim] of this.claims) {
            for (const previous of claim.clients) {
                const prior = this.sessions.get(previous)
                if (prior?.kind !== 'appliance' || !this.current(prior)) claim.clients.delete(previous)
            }
            if (claim.clients.size === 0) this.claims.delete(entryId)
        }
        if ([...this.claims].some(([entryId, claim]) => entryId !== session.entryId && claim.id === id)) return false
        const claim = this.claims.get(session.entryId)
        if (claim && claim.id !== id) return false
        if (claim) claim.clients.add(client)
        else this.claims.set(session.entryId, { id, clients: new Set([client]) })
        session.id = id
        if (entry.deviceId) session.linked = true
        return true
    }

    publish(packet: PublishPacket, client: Client) {
        const session = this.sessions.get(client)
        const topic = parseDeviceTopic(packet.topic)
        if (!session || !topic) return false
        const payload = parseDevicePayload(packet.payload)
        if (!payload || payload.did !== topic.deviceId) return false
        if (session.kind === 'diagnostic')
            return session.write && !packet.retain && topic.kind === 'lime' && session.ids.has(topic.deviceId)
        if (!this.current(session) || topic.kind === 'lime') return false
        if (!session.id && topic.kind !== 'provisioning') return false
        return this.bind(session, client, topic.deviceId)
    }

    subscribe(topicName: string, client: Client) {
        const session = this.sessions.get(client),
            topic = parseDeviceTopic(topicName)
        if (!session || !topic) return false
        if (session.kind === 'diagnostic') return session.ids.has(topic.deviceId)
        return topic.kind === 'lime' && this.bind(session, client, topic.deviceId)
    }

    deliver(topicName: string, client: Client) {
        const session = this.sessions.get(client),
            topic = parseDeviceTopic(topicName)
        if (!session || !topic) return false
        if (session.kind === 'diagnostic') return session.ids.has(topic.deviceId)
        return !!this.current(session) && topic.kind === 'lime' && topic.deviceId === session.id
    }

    disconnect(client: Client) {
        const session = this.sessions.get(client)
        if (session?.kind === 'appliance') {
            const claim = this.claims.get(session.entryId)
            claim?.clients.delete(client)
            if (claim?.clients.size === 0) this.claims.delete(session.entryId)
        }
        this.sessions.delete(client)
    }
}
