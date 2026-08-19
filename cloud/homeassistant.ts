import * as mqtt from 'mqtt'
import { TypedEmitter } from 'tiny-typed-emitter'
import { HAConfig } from '@/util/config'
import log from '@/util/logging'
import { delocalizeValue, localizeDiscovery, localizeValue } from '@/util/ha_locale'

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
        for (let pattern in replacements) {
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

    constructor(readonly config: HAConfig) {
        super()

        // mqtt module has builtin reconnection support
        this.client = mqtt.connect(this.config.mqtt_url, {
            will: {
                topic: config.rethink_prefix + '/availability',
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
        this.client.subscribe(this.config.discovery_prefix + '/status')
        // rethink/ID/PROPERTY/set
        this.client.subscribe(this.config.rethink_prefix + '/+/+/set')

        this.client.subscribe(this.config.rethink_prefix + '/+/availability')
        this.client.publish(this.config.rethink_prefix + '/availability', Buffer.from('online'), { retain: true })

        this.emit('discovery')
        this.emit('statusChanged', true)
    }

    disconnected() {
        this.isConnected = false
        log('status', 'HA mqtt connection lost')
        this.emit('statusChanged', false)
    }

    received(topic: string, message: Buffer, packet: mqtt.IPublishPacket) {
        try {
            if (topic === this.config.discovery_prefix + '/status' && message.toString('utf-8') === 'online') {
                log('status', 'HA online, starting discovery process')
                this.emit('discovery')
            }

            if (topic.startsWith(this.config.rethink_prefix + '/')) {
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
        this.registerLocalizedCommands(id, config, localizedConfig)
        const configPayload = JSON.stringify(recursiveReplace(localizedConfig, replacements))
        log('publish', configPayload)
        // Discovery must survive broker/rethink/HA restart ordering. Without retain, HA can keep an
        // older entity definition (for example, a generic RAC definition discovered before the
        // exact model handler was available) until it happens to announce `online` again.
        this.client.publish(discoveryTopic + '/config', configPayload, { retain: true })
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
        this.client.publish(deviceTopic + '/' + property, value, options)
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
