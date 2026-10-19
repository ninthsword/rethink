import type { Socket } from 'node:net'
import newMqttConnection, { type MqttConnection } from 'mqtt-connection'
import type { IConnectPacket, IPublishPacket, ISubscribePacket, IUnsubscribePacket } from 'mqtt-packet'
import { TypedEmitter } from 'tiny-typed-emitter'
import log from '@/util/logging'
import { denyMQTTAccess, type MQTTAccessPolicy, type MQTTTransport } from './mqtt-access'

export type PublishPacket = Omit<IPublishPacket, 'cmd'>

const MAX_RETAINED_TOPICS = 1024
const MAX_RETAINED_BYTES = 8 * 1024 * 1024
const MAX_CLIENT_SUBSCRIPTIONS = 128
const MAX_SUBSCRIPTIONS = 4096
const MAX_FILTER_BYTES = 1024 * 1024
const MAX_FILTER_LENGTH = 1024
type SubscriptionBudget = { count: number; bytes: number }

function validFilter(filter: string) {
    return (
        !!filter &&
        Buffer.byteLength(filter) <= MAX_FILTER_LENGTH &&
        !filter.includes('\0') &&
        filter
            .split('/')
            .every(
                (level, index, levels) =>
                    level === '+' || (level === '#' ? index === levels.length - 1 : !/[+#]/.test(level)),
            )
    )
}

function retainedSize(packet: PublishPacket) {
    return (
        Buffer.byteLength(packet.topic) +
        Buffer.byteLength(packet.payload) +
        (packet.properties ? Buffer.byteLength(JSON.stringify(packet.properties)) : 0)
    )
}

/** Match an MQTT topic name against a level-based topic filter. */
export function mqttTopicMatches(topic: string, filter: string): boolean {
    if (typeof topic !== 'string' || typeof filter !== 'string' || !topic || !filter) return false

    const topicLevels = topic.split('/')
    const filterLevels = filter.split('/')
    for (let index = 0; index < filterLevels.length; index++) {
        const level = filterLevels[index]
        if (level === '#') return index === filterLevels.length - 1
        if (level !== '+' && (level.includes('#') || level.includes('+'))) return false
        if (level !== '+' && level !== topicLevels[index]) return false
    }
    return topicLevels.length === filterLevels.length
}

class Subscription {
    constructor(readonly topicPattern: string) {}

    match(topic: string) {
        return mqttTopicMatches(topic, this.topicPattern)
    }
}

/** Also the floor for a client that asks for a shorter keepalive than this. */
const MIN_IDLE_TIMEOUT_MS = 5 * 60 * 1000

/** How long a connection may be quiet before the kernel starts checking it is still there. */
const KEEPALIVE_PROBE_AFTER_MS = 60 * 1000

/**
 * How long a client may stay silent before it is dropped, or 0 to leave it alone.
 *
 * The washer asks for twenty minutes and then sends nothing at all for longer than that,
 * so even half again its keepalive cut it off — after a cycle finished and it went quiet,
 * which is exactly when it should have been left alone. An appliance that asks for more
 * silence than the timeout allows is one whose silence tells us nothing, so it is not
 * timed out at all; the kernel's keepalive probes are what notice if it has really gone.
 * Every other appliance here keeps to a sixty second keepalive and is timed out as before.
 */
export function idleTimeoutFor(keepaliveSeconds: number) {
    if (keepaliveSeconds * 1000 > MIN_IDLE_TIMEOUT_MS) return 0
    if (keepaliveSeconds > 0) return Math.max(MIN_IDLE_TIMEOUT_MS, keepaliveSeconds * 1500)
    return MIN_IDLE_TIMEOUT_MS
}

type LWT = IConnectPacket['will']
type ClientEvents = { destroy: (will: LWT) => void }
type Deferred = { bytes: number; run: () => void }
const ADMISSION_MS = 10_000
const MAX_PENDING = 64
const MAX_DEFERRED_PACKETS = 8
const MAX_DEFERRED_BYTES = 64 * 1024

export class Client extends TypedEmitter<ClientEvents> {
    subscriptions = new Map<string, Subscription>()
    mqtt: MqttConnection | null
    will: LWT
    sourceIp?: string
    state: 'new' | 'pending' | 'active' | 'closed' = 'new'
    readonly admission = new AbortController()
    deferred: Deferred[] = []
    deferredBytes = 0

    constructor(
        mqtt: MqttConnection,
        readonly remoteAddress?: string,
        readonly stream?: Socket,
        private readonly budget: SubscriptionBudget = { count: 0, bytes: 0 },
        private readonly canDeliver: (topic: string) => boolean = () => false,
    ) {
        super()
        this.mqtt = mqtt
    }

    subscribe(packet: ISubscribePacket, retainMap: Map<string, PublishPacket>, allowed: (topic: string) => boolean) {
        const previous = [...this.subscriptions.values()]
        const added: Subscription[] = []
        const granted = packet.subscriptions.map(({ topic }) => {
            if (!validFilter(topic) || !allowed(topic)) return 128
            if (this.subscriptions.has(topic)) return 0
            const bytes = Buffer.byteLength(topic)
            if (
                this.subscriptions.size >= MAX_CLIENT_SUBSCRIPTIONS ||
                this.budget.count >= MAX_SUBSCRIPTIONS ||
                this.budget.bytes + bytes > MAX_FILTER_BYTES
            )
                return 128
            const subscription = new Subscription(topic)
            this.subscriptions.set(topic, subscription)
            added.push(subscription)
            this.budget.count++
            this.budget.bytes += bytes
            return 0
        })
        this.mqtt?.suback({ granted, messageId: packet.messageId })
        for (const [topic, retained] of retainMap) {
            if (
                !previous.some((sub) => sub.match(topic)) &&
                added.some((sub) => sub.match(topic)) &&
                this.canDeliver(topic)
            )
                this.mqtt?.publish(retained)
        }
    }

    unsubscribe(packet: IUnsubscribePacket) {
        for (const topic of packet.unsubscriptions) this.removeSubscription(topic)
        this.mqtt?.unsuback({ messageId: packet.messageId })
    }

    private removeSubscription(topic: string) {
        if (!this.subscriptions.delete(topic)) return
        this.budget.count--
        this.budget.bytes -= Buffer.byteLength(topic)
    }

    destroy(graceful = false) {
        if (!this.mqtt) return
        const mqtt = this.mqtt
        this.mqtt = null
        const wasActive = this.state === 'active'
        this.state = 'closed'
        this.admission.abort()
        this.deferred = []
        this.deferredBytes = 0
        for (const topic of this.subscriptions.keys()) this.removeSubscription(topic)
        if (graceful && this.stream) {
            const stream = this.stream
            const closing = setTimeout(() => stream.destroy(), ADMISSION_MS)
            closing.unref()
            stream.once('close', () => clearTimeout(closing))
            stream.end()
        } else {
            mqtt.destroy()
            this.stream?.destroy()
        }
        this.emit('destroy', wasActive && !graceful ? this.will : undefined)
    }

    try_publish(packet: PublishPacket) {
        if (this.state !== 'active' || !this.mqtt || !this.canDeliver(packet.topic)) return
        if ([...this.subscriptions.values()].some((sub) => sub.match(packet.topic))) this.mqtt.publish(packet)
    }
}

type BrokerEvents = {
    connect: (packet: IConnectPacket, client: Client) => void
    disconnect: (client: Client) => void
    publish: (packet: PublishPacket, client: Client | null) => void
}

export class Broker extends TypedEmitter<BrokerEvents> {
    clients = new Set<Client>()
    retainMap = new Map<string, PublishPacket>()
    private retainedBytes = 0
    private subscriptionBudget: SubscriptionBudget = { count: 0, bytes: 0 }
    private pending = new Set<Client>()

    constructor(private readonly policy: MQTTAccessPolicy = denyMQTTAccess) {
        super()
    }

    accept(stream: Socket, transport: MQTTTransport = { tls: false }) {
        if (this.pending.size >= MAX_PENDING) {
            stream.destroy()
            return
        }
        let pendingBytes = 0
        // Count the entire initial chunk too: the parser can emit more packets after pause().
        const onData = (data: Buffer) => {
            if (client.state !== 'new' && client.state !== 'pending') return
            pendingBytes += data.length
            if (pendingBytes > MAX_DEFERRED_BYTES) client.destroy()
        }
        const mqtt = newMqttConnection(stream) as MqttConnection & {
            pubrec(packet: { messageId?: number }): void
            pubcomp(packet: { messageId?: number }): void
            on(event: 'pubrel', handler: (packet: { messageId?: number }) => void): MqttConnection
        }
        const client: Client = new Client(
            mqtt,
            stream.remoteAddress?.replace(/^::ffff:/, ''),
            stream,
            this.subscriptionBudget,
            (topic) => this.policy.deliver(topic, client),
        )
        this.clients.add(client)
        this.pending.add(client)
        stream.prependListener?.('data', onData)
        const deadline = setTimeout(() => client.destroy(), ADMISSION_MS)
        deadline.unref()

        const operation = (bytes: number, run: () => void) => {
            if (client.state === 'active') {
                run()
                return
            }
            if (
                client.state !== 'pending' ||
                client.deferred.length >= MAX_DEFERRED_PACKETS ||
                client.deferredBytes + bytes > MAX_DEFERRED_BYTES
            ) {
                client.destroy()
                return
            }
            client.deferred.push({ bytes, run })
            client.deferredBytes += bytes
        }
        mqtt.on('connect', (packet) => {
            if (client.state !== 'new') {
                client.destroy()
                return
            }
            client.state = 'pending'
            stream.pause?.()
            void Promise.resolve()
                .then(() => this.policy.connect(packet, client, transport, client.admission.signal))
                .then((allowed) => {
                    if (client.state !== 'pending' || client.admission.signal.aborted || stream.destroyed) return
                    if (!allowed) {
                        mqtt.connack({ returnCode: 5, sessionPresent: false })
                        client.destroy(true)
                        return
                    }
                    clearTimeout(deadline)
                    this.pending.delete(client)
                    stream.removeListener('data', onData)
                    client.will = packet.will
                    mqtt.connack({ returnCode: 0, sessionPresent: false })
                    client.state = 'active'
                    stream.setTimeout(idleTimeoutFor(packet.keepalive ?? 0))
                    this.emit('connect', packet, client)
                    const deferred = client.deferred
                    client.deferred = []
                    client.deferredBytes = 0
                    for (const packet of deferred) {
                        if (client.state !== 'active') break
                        packet.run()
                    }
                    if (client.state === 'active') stream.resume?.()
                })
                .catch(() => client.destroy())
        })
        mqtt.on('publish', (packet) =>
            operation(Buffer.byteLength(packet.topic) + Buffer.byteLength(packet.payload), () => {
                if (!this.publish(packet, client)) {
                    client.destroy()
                    return
                }
                if (packet.qos === 1) mqtt.puback({ messageId: packet.messageId })
                else if (packet.qos === 2) mqtt.pubrec({ messageId: packet.messageId })
            }),
        )
        mqtt.on('pubrel', (packet) => operation(4, () => mqtt.pubcomp({ messageId: packet.messageId })))
        mqtt.on('subscribe', (packet) =>
            operation(
                packet.subscriptions.reduce((n, sub) => n + Buffer.byteLength(sub.topic) + 3, 4),
                () => client.subscribe(packet, this.retainMap, (topic) => this.policy.subscribe(topic, client)),
            ),
        )
        mqtt.on('unsubscribe', (packet) =>
            operation(
                packet.unsubscriptions.reduce((n, topic) => n + Buffer.byteLength(topic) + 2, 4),
                () => client.unsubscribe(packet),
            ),
        )
        mqtt.on('pingreq', () => operation(2, () => mqtt.pingresp({})))
        mqtt.on('disconnect', () => client.destroy(true))
        mqtt.on('close', () => client.destroy())
        mqtt.on('error', () => client.destroy())
        stream.on('close', () => client.destroy())
        try {
            stream.setKeepAlive(true, KEEPALIVE_PROBE_AFTER_MS)
        } catch {
            /* Non-TCP test streams. */
        }
        stream.setTimeout(ADMISSION_MS)
        stream.on('timeout', () => client.destroy())
        client.on('destroy', (will) => {
            clearTimeout(deadline)
            this.pending.delete(client)
            stream.removeListener('data', onData)
            if (will) {
                const packet: PublishPacket = {
                    topic: will.topic,
                    payload: will.payload,
                    qos: will.qos ?? 0,
                    dup: false,
                    retain: false,
                }
                if (this.policy.publish(packet, client)) this.publishAllowed(packet, client)
            }
            this.policy.disconnect(client)
            this.emit('disconnect', client)
            this.clients.delete(client)
        })
    }

    /**
     * Cuts every appliance connection with a reset before the process goes away.
     *
     * An appliance that keeps a long keepalive — the washer here asks for twenty minutes —
     * does not look at its socket in between, so after a restart it stays away until its
     * own timer fires. A reset raises an error on the connection immediately, which is
     * what makes the appliance reconnect straight away rather than a quarter of an hour
     * later. A plain close is not enough: the appliance is not reading, so it never sees
     * the end of the stream.
     */
    shutdown() {
        let reset = 0
        for (const client of this.clients) {
            // resetAndDestroy only works on a raw TCP socket. Appliances arrive over TLS,
            // where it throws ERR_INVALID_HANDLE_TYPE, so try the socket underneath the
            // TLS one as well and fall back to a plain close. A throw here would abort the
            // shutdown before any connection was dealt with.
            const parent = (client.stream as unknown as { _parent?: Socket } | undefined)?._parent
            let done = false
            for (const socket of [client.stream, parent]) {
                if (!socket?.resetAndDestroy) continue
                try {
                    socket.resetAndDestroy()
                    reset++
                    done = true
                    break
                } catch {
                    // Not a socket that can be reset; try the next one.
                }
            }
            if (!done) client.stream?.destroy()
        }
        log('status', 'closed', this.clients.size, 'appliance connections for shutdown,', reset, 'with a reset')
    }

    publish(packet: PublishPacket, client: Client | null) {
        if (client && (client.state !== 'active' || !this.policy.publish(packet, client))) return false
        return this.publishAllowed(packet, client)
    }

    private publishAllowed(packet: PublishPacket, client: Client | null) {
        this.emit('publish', packet, client)

        for (const ci of this.clients) ci.try_publish(packet)

        if (packet.retain) {
            const previous = this.retainMap.get(packet.topic)
            const previousBytes = previous ? retainedSize(previous) : 0
            if (packet.payload.length === 0) {
                this.retainMap.delete(packet.topic)
                this.retainedBytes -= previousBytes
                return true
            }
            const bytes = retainedSize(packet)
            if (
                (!previous && this.retainMap.size >= MAX_RETAINED_TOPICS) ||
                this.retainedBytes - previousBytes + bytes > MAX_RETAINED_BYTES
            )
                return true
            const owned = {
                ...packet,
                payload: Buffer.from(packet.payload),
                ...(packet.properties ? { properties: structuredClone(packet.properties) } : {}),
            }
            if (owned.properties && packet.properties?.correlationData)
                owned.properties.correlationData = Buffer.from(packet.properties.correlationData)
            this.retainMap.set(packet.topic, owned)
            this.retainedBytes += bytes - previousBytes
        }
        return true
    }
}
