import { IPublishPacket, IConnectPacket, ISubscribePacket, IUnsubscribePacket } from 'mqtt-packet'
import newMqttConnection, { MqttConnection } from 'mqtt-connection'
import { TypedEmitter } from 'tiny-typed-emitter'
import { Socket } from 'node:net'
import log from '@/util/logging'

export type PublishPacket = Omit<IPublishPacket, 'cmd'>

class Subscription {
    re: RegExp

    constructor(topicPattern: string) {
        const re = '^' + topicPattern.replace(/#$/, '.*').replace(/\+/g, '[^/]*') + '$'
        this.re = new RegExp(re)
    }

    match(topic: string) {
        return !!topic.match(this.re)
    }
}

/** Also the floor for a client that asks for a shorter keepalive than this. */
const MIN_IDLE_TIMEOUT_MS = 5 * 60 * 1000

type LWT = IConnectPacket['will']
type ClientEvents = {
    destroy: (will: LWT) => void
}

export class Client extends TypedEmitter<ClientEvents> {
    subscriptions = new Map<string, Subscription>()
    mqtt: any = undefined
    will: LWT

    constructor(
        mqtt: MqttConnection,
        retainMap: Map<string, PublishPacket>,
        readonly remoteAddress?: string,
        readonly stream?: Socket,
    ) {
        super()

        this.mqtt = mqtt
        mqtt.on('connect', (packet) => {
            if (packet.will) {
                this.will = packet.will
            }
            mqtt.connack({ returnCode: 0, sessionPresent: false })
        })

        mqtt.on('publish', (packet) => {
            if (packet.qos > 0) mqtt.puback({ messageId: packet.messageId })
        })

        mqtt.on('pingreq', () => {
            mqtt.pingresp({})
        })

        mqtt.on('subscribe', (packet) => {
            // we grant all subscriptions with QoS = 0
            const granted = packet.subscriptions.map(() => 0)
            mqtt.suback({ granted: granted, messageId: packet.messageId })

            // collect all retained topics that aren't yet covered by this client's subscriptions
            const unseenRetainedTopics: string[] = []
            for (const t of retainMap.keys()) {
                let seen = false
                for (const s of this.subscriptions.values()) {
                    if (s.match(t)) {
                        seen = true
                        break
                    }
                }

                if (!seen) unseenRetainedTopics.push(t)
            }

            // register new subscriptions
            const newSubscriptions: Subscription[] = []
            packet.subscriptions.forEach((el) => {
                const newSub = new Subscription(el.topic)
                newSubscriptions.push(newSub)
                this.subscriptions.set(el.topic, newSub)
            })

            // deliver retained messages that match any of the new subscriptions
            for (const t of unseenRetainedTopics) {
                for (const s of newSubscriptions) {
                    if (s.match(t)) {
                        // `t` comes from `unseenRetainedTopics` which is filled with values
                        // coming from `retainMap.keys()`. It will always be a valid key.
                        mqtt.publish(retainMap.get(t)!)
                        break
                    }
                }
            }
        })

        mqtt.on('unsubscribe', (packet) => {
            mqtt.unsuback({ messageId: packet.messageId })
            packet.unsubscriptions.forEach((topic) => {
                this.subscriptions.delete(topic)
            })
        })

        mqtt.on('close', () => {
            this.destroy()
        })
        mqtt.on('error', (err) => {
            console.warn(err)
            this.destroy()
        })
        mqtt.on('disconnect', () => {
            this.destroy()
        })
    }

    destroy() {
        if (!this.mqtt) return

        this.mqtt.destroy()
        this.mqtt = null
        this.emit('destroy', this.will)
    }

    try_publish(packet: PublishPacket) {
        if (!this.mqtt) return

        for (const [k, v] of this.subscriptions) {
            if (v.match(packet.topic)) {
                this.mqtt.publish(packet)
                return
            }
        }
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

    constructor() {
        super()
    }

    accept(stream: Socket) {
        const mqtt = newMqttConnection(stream)
        const client = new Client(mqtt, this.retainMap, stream.remoteAddress?.replace(/^::ffff:/, ''), stream)

        mqtt.on('publish', (packet) => {
            this.publish(packet, client)

            if (packet.qos > 0) mqtt.puback({ messageId: packet.messageId })
        })

        mqtt.on('connect', (packet) => {
            // MQTT lets the client choose how long it may stay silent, and an idle LG
            // appliance uses a much longer keepalive than the five minutes assumed here.
            // Cutting it off early makes the appliance reconnect, which is what showed up
            // in Home Assistant as an appliance going offline and back on by itself.
            const keepalive = packet.keepalive ?? 0
            log('status', 'mqtt client', packet.clientId, 'connected, keepalive', keepalive, 's')
            if (keepalive > 0) stream.setTimeout(Math.max(MIN_IDLE_TIMEOUT_MS, keepalive * 1500))
            this.emit('connect', packet, client)
        })

        this.clients.add(client)

        // Until the CONNECT packet says otherwise. The grace of half again the keepalive is
        // what the MQTT specification asks a server to allow.
        stream.setTimeout(MIN_IDLE_TIMEOUT_MS)
        stream.on('timeout', function () {
            log('status', 'dropping idle mqtt client', client.remoteAddress ?? '', 'after', stream.timeout, 'ms')
            client.destroy()
        })

        client.on('destroy', (lwt: LWT) => {
            if (lwt)
                this.publish(
                    {
                        qos: 0,
                        dup: false,
                        retain: false,
                        topic: lwt.topic,
                        payload: lwt.payload,
                    },
                    client,
                )

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
        for (const client of this.clients) {
            const stream = client.stream
            // resetAndDestroy sends RST; older runtimes only have destroy, which at least
            // closes the connection.
            if (stream?.resetAndDestroy) stream.resetAndDestroy()
            else stream?.destroy()
        }
        log('status', 'reset', this.clients.size, 'appliance connections for shutdown')
    }

    publish(packet: PublishPacket, client: Client | null) {
        this.emit('publish', packet, client)

        for (const ci of this.clients) ci.try_publish(packet)

        if (packet.retain) {
            if (packet.payload.length > 0) {
                // new retained topic
                this.retainMap.set(packet.topic, packet)
            } else {
                // delete retained topic
                this.retainMap.delete(packet.topic)
            }
        }
    }
}
