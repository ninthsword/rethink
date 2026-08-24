import * as mqtt from 'mqtt'
import { TypedEmitter } from 'tiny-typed-emitter'
import type { HAConfig } from '@/util/config'
import { nameEntities } from '@/util/entity_naming'
import { delocalizeValue, localizeDiscovery, localizeValue } from '@/util/ha_locale'
import { validateDeviceDiscovery } from '@/util/ha_mqtt_validation'
import log from '@/util/logging'

// Notes on availability topic handling:
// 1. We want HA to be able to tell if a device is available.
// 2. When rethink stops, all devices should turn "offline"
// 3. But we can register only a single LWT topic at the MQTT broker
// 4. We define two availability topics. One per-device, the other - global
// 5. In a previous attempt, we had used availablility_mode: latest, and published all availability
// 	  messages with retain=off. This had one flaw: if HA was not already subscribed to the per-device
//    topic, it would miss the message and display the device as "offline" until it reconnected.
// 6. If we publish the per-device availability message with retain=true, then HA will received it
//    once it subscribes. It will also mean that these messages can survive from one `rethink` run
//	  to another. This would cause these "phatom" devices to appear "online" as soon as the new
//	  `rethink` instance starts.
// 7. To solve this, we subscribe to the availability topics and clean up all the retained "online"
// 	  messages on startup.
//
// The same reasoning applies to the state topics themselves. Every value is published with
// retain=true so Home Assistant sees it whatever order things start in, which also means a
// value outlives the entity that published it: rename a component, or replace one
// representation with a better one, and the old payload stays on the broker with nobody
// left to correct it. The living-room air conditioner still had filterused, filterlife and
// filterchangeddate sitting there long after it moved to a single remaining-life figure.
// So after publishing a device's discovery we look at what is actually retained under it
// and clear anything the config no longer refers to.

/** Long enough for the broker to deliver what it has stored, short enough to stay a sweep. */
const SWEEP_WINDOW_MS = 10 * 1000

function recursiveReplace(obj: unknown, replacements: Record<string, string>): unknown {
    if (Array.isArray(obj)) {
        return obj.map((v) => recursiveReplace(v, replacements))
    } else if (obj === null) {
        return null
    } else if (typeof obj === 'object') {
        return Object.fromEntries(
            Object.entries(obj as object).map(([key, value]) => [key, recursiveReplace(value, replacements)]),
        )
    } else if (typeof obj === 'string') {
        let str: string = obj
        for (const pattern in replacements) {
            str = str.replaceAll(pattern, replacements[pattern])
        }
        return str
    } else return obj
}

type ConnectionEvents = {
    discovery: () => void
    setProperty: (id: string, key: string, value: string) => void
    statusChanged: (status: boolean) => void
}

export class Connection extends TypedEmitter<ConnectionEvents> {
    client: mqtt.MqttClient
    isConnected: boolean = false

    // record for which devices we have published the availability topic during this connection
    readonly publishedAvailability = new Set<string>()
    /** Per command topic reverse map; avoids ambiguous Korean labels such as LOW/light -> "약". */
    readonly localizedCommandValues = new Map<string, Map<string, string>>()
    /** Per state topic forward map, paired with localized discovery enum options. */
    readonly localizedStateValues = new Map<string, Map<string, string>>()
    private deviceNameResolver?: (id: string) => string | undefined
    /** Property names the current discovery payload refers to, per device. */
    private readonly liveProperties = new Map<string, Set<string>>()
    private readonly sweepTimers = new Map<string, ReturnType<typeof setTimeout>>()

    constructor(readonly config: HAConfig) {
        super()

        // mqtt module has builtin reconnection support
        this.client = mqtt.connect(this.config.mqtt_url, {
            will: {
                topic: `${config.rethink_prefix}/availability`,
                payload: Buffer.from('offline'),
                retain: true,
            },
            username: this.config.mqtt_user,
            password: this.config.mqtt_pass,
        })
        this.client.on('connect', this.connected.bind(this))
        this.client.on('close', this.disconnected.bind(this))
        this.client.on('message', this.received.bind(this))
    }

    setDeviceNameResolver(resolver: (id: string) => string | undefined) {
        this.deviceNameResolver = resolver
    }

    connected() {
        this.publishedAvailability.clear()
        log('status', 'HA mqtt connection established')
        this.isConnected = true

        // homeassistant/status
        this.client.subscribe(`${this.config.discovery_prefix}/status`)
        // rethink/ID/PROPERTY/set
        this.client.subscribe(`${this.config.rethink_prefix}/+/+/set`)

        this.client.subscribe(`${this.config.rethink_prefix}/+/availability`)
        this.client.publish(`${this.config.rethink_prefix}/availability`, Buffer.from('online'), { retain: true })

        this.emit('discovery')
        this.emit('statusChanged', true)
    }

    disconnected() {
        for (const timer of this.sweepTimers.values()) clearTimeout(timer)
        this.sweepTimers.clear()
        this.liveProperties.clear()
        this.isConnected = false
        log('status', 'HA mqtt connection lost')
        this.emit('statusChanged', false)
    }

    received(topic: string, message: Buffer, packet: mqtt.IPublishPacket) {
        try {
            if (topic === `${this.config.discovery_prefix}/status` && message.toString('utf-8') === 'online') {
                log('status', 'HA online, starting discovery process')
                this.emit('discovery')
            }

            if (topic.startsWith(`${this.config.rethink_prefix}/`)) {
                const pathelements = topic.substring(this.config.rethink_prefix.length + 1).split('/')
                // rethink/+/+/set
                if (pathelements.length === 3 && pathelements[2] === 'set') {
                    const [id, prop] = pathelements
                    const mqttValue = message.toString('utf-8')
                    const originalValue =
                        this.localizedCommandValues.get(`${id}/${prop}`)?.get(mqttValue) ??
                        delocalizeValue(mqttValue, this.config.language)
                    this.emit('setProperty', id, prop, originalValue)
                }

                // rethink/+/PROPERTY, during a sweep window: a retained value with no entity
                // left to own it. Live deliveries carry retain=false, so they never match.
                if (pathelements.length === 2 && pathelements[1] !== 'availability' && packet.retain) {
                    this.clearIfOrphaned(pathelements[0], pathelements[1], topic, message)
                }

                // rethink/+/availability
                // only for retained deliveries. Packets delivered in real-time will not be caught by this
                if (
                    pathelements.length === 2 &&
                    pathelements[1] === 'availability' &&
                    message.toString('utf-8') === 'online' &&
                    packet.retain
                ) {
                    // clear any retained availability topic, but only if we hadn't published a message on that topic yet
                    if (!this.publishedAvailability.has(pathelements[0]))
                        this.client.publish(topic, 'offline', { retain: true })
                }
            }
        } catch (err) {
            console.warn(`Error processing MQTT packet: ${err}`)
        }
    }

    publishConfig(id: string, config: DeviceDiscovery) {
        const discoveryTopic = `${this.config.discovery_prefix}/device/rethink/${id}`
        const deviceTopic = `${this.config.rethink_prefix}/${id}`
        const replacements = {
            $this: deviceTopic,
            $rethink: this.config.rethink_prefix,
            $deviceid: id,
        }
        const localizedConfig = localizeDiscovery(config, this.config.language)
        // The cloud alias is the user's authoritative appliance name. Keep it
        // verbatim: it may already contain Korean, room names, or other text
        // that must not be passed through the generic device-type translator.
        const registeredName = this.deviceNameResolver?.(id)
        if (registeredName) localizedConfig.device.name = registeredName
        nameEntities(localizedConfig)
        const validationIssues = validateDeviceDiscovery(localizedConfig)
        if (validationIssues.length > 0) {
            // Nothing is published, so the appliance loses every entity it had. This is the
            // loudest failure there is here and it used to be the quietest.
            log('status', `discovery for ${id} rejected, publishing nothing: ${validationIssues.join('; ')}`)
            return
        }
        this.registerLocalizedCommands(id, config, localizedConfig)
        const configPayload = JSON.stringify(recursiveReplace(localizedConfig, replacements))
        log('publish', configPayload)
        // Discovery must survive broker/rethink/HA restart ordering. Without retain, HA can keep an
        // older entity definition (for example, a generic RAC definition discovered before the
        // exact model handler was available) until it happens to announce `online` again.
        this.client.publish(`${discoveryTopic}/config`, configPayload, { retain: true })
        this.sweepRetainedState(id, localizedConfig)
    }

    /**
     * Collect the device's own state topics from a discovery payload. Command topics and
     * the availability topic are left out: the first are never retained, and the second has
     * its own cleanup on connect.
     */
    private static stateProperties(config: DeviceDiscovery) {
        const found = new Set<string>()
        const walk = (value: unknown) => {
            if (Array.isArray(value)) value.forEach(walk)
            else if (value && typeof value === 'object') Object.values(value).forEach(walk)
            else if (typeof value === 'string' && value.startsWith('$this/')) {
                const property = value.substring('$this/'.length)
                if (!property.includes('/') && property !== 'availability') found.add(property)
            }
        }
        walk(config)
        return found
    }

    /**
     * Ask the broker what it is still holding for this device. Retained values arrive as
     * soon as the subscription is acknowledged, so the window only has to outlast that;
     * afterwards the subscription goes away rather than duplicating every live publish.
     */
    private sweepRetainedState(id: string, config: DeviceDiscovery) {
        const properties = Connection.stateProperties(config)
        const previous = this.liveProperties.get(id)
        this.liveProperties.set(id, properties)
        // Only worth asking when the set of entities has actually changed; that is exactly
        // when something can have been left behind.
        if (previous && previous.size === properties.size && [...properties].every((p) => previous.has(p))) return

        const filter = `${this.config.rethink_prefix}/${id}/+`
        const running = this.sweepTimers.get(id)
        if (running) clearTimeout(running)
        else this.client.subscribe(filter)

        this.sweepTimers.set(
            id,
            setTimeout(() => {
                this.sweepTimers.delete(id)
                this.client.unsubscribe(filter)
            }, SWEEP_WINDOW_MS),
        )
    }

    private clearIfOrphaned(id: string, property: string, topic: string, message: Buffer) {
        // Outside a sweep window we have no business judging what belongs here, and an
        // already-empty topic is not holding anything.
        if (!this.sweepTimers.has(id) || message.length === 0) return
        if (this.liveProperties.get(id)?.has(property)) return

        log('status', `clearing retained ${topic}, which no entity publishes any more`)
        this.client.publish(topic, Buffer.alloc(0), { retain: true })
    }

    private registerLocalizedCommands(id: string, original: DeviceDiscovery, localized: DeviceDiscovery) {
        if (this.config.language !== 'korean') return

        const valueKeys: Array<[string, string, string]> = [
            ['options', 'command_topic', 'state_topic'],
            ['fan_modes', 'fan_mode_command_topic', 'fan_mode_state_topic'],
            ['swing_modes', 'swing_mode_command_topic', 'swing_mode_state_topic'],
            ['swing_horizontal_modes', 'swing_horizontal_mode_command_topic', 'swing_horizontal_mode_state_topic'],
            ['preset_modes', 'preset_mode_command_topic', 'preset_mode_state_topic'],
            ['modes', 'mode_command_topic', 'mode_state_topic'],
        ]
        for (const [componentId, originalComponent] of Object.entries(original.components)) {
            const localizedComponent = localized.components[componentId]
            if (!localizedComponent) continue
            const source = originalComponent as Record<string, unknown>
            const translated = localizedComponent as Record<string, unknown>
            for (const [valuesKey, commandKey, stateKey] of valueKeys) {
                const values = source[valuesKey]
                const localizedValues = translated[valuesKey]
                const commandTopic = source[commandKey]
                const stateTopic = source[stateKey]
                if (!Array.isArray(values) || !Array.isArray(localizedValues)) continue
                const reverse = new Map<string, string>()
                const forward = new Map<string, string>()
                values.forEach((value, index) => {
                    const localizedValue = localizedValues[index]
                    if (typeof value === 'string' && typeof localizedValue === 'string') {
                        reverse.set(localizedValue, value)
                        forward.set(value, localizedValue)
                    }
                })
                if (typeof commandTopic === 'string') {
                    const match = /^\$this\/(.+)\/set$/.exec(commandTopic)
                    if (match) this.localizedCommandValues.set(`${id}/${match[1]}`, reverse)
                }
                if (typeof stateTopic === 'string') {
                    const match = /^\$this\/(.+)$/.exec(stateTopic)
                    if (match) this.localizedStateValues.set(`${id}/${match[1]}`, forward)
                }
            }
        }
    }

    /** Remove a retained state value that is no longer valid for an entity. */
    clearRetainedProperty(id: string, property: string) {
        const topic = `${this.config.rethink_prefix}/${id}/${property}`
        log('status', `clearing retained ${topic}`)
        this.client.publish(topic, Buffer.alloc(0), { retain: true })
    }

    publishProperty(id: string, property: string, value: string | number, options?: mqtt.IClientPublishOptions) {
        if (!options) options = { retain: true } // FIXME?

        if (typeof value === 'number') value = value.toString()

        const deviceTopic = `${this.config.rethink_prefix}/${id}`
        if (property === 'availability') this.publishedAvailability.add(id)

        if (typeof value === 'string')
            value =
                this.localizedStateValues.get(`${id}/${property}`)?.get(value) ??
                localizeValue(value, this.config.language)
        log('publish', id, property, value)
        this.client.publish(`${deviceTopic}/${property}`, value, options)
    }
}

export type DeviceInfo = {
    identifiers: string | string[]
    manufacturer?: string
    model?: string
    sw_version?: string
    name?: string
}

export type OriginInfo = {
    name: string
    support_url?: string
    sw_version?: string
}

export type AvailabilityInfo = {
    topic: string
}

export type ComponentInfo = {
    name?: string | null
    platform: string
    unique_id: string
}

export type DeviceDiscovery = {
    device: DeviceInfo
    origin: OriginInfo
    availability?: AvailabilityInfo[]
    availability_mode?: 'all' | 'any' | 'latest'
    components: Record<string, ComponentInfo>
}

export type ClimateComponent = ComponentInfo & {
    platform: 'climate'
    action_topic?: string
    current_humidity_topic?: string
    temperature_unit?: 'C' | 'F'
    temp_step?: number
    precision?: number
    min_temp?: number
    max_temp?: number
    modes?: string[]
    fan_modes?: string[]
    swing_modes?: string[]
    swing_horizontal_modes?: string[]
}
