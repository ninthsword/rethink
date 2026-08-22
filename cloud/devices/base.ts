import { type Metadata } from '../thinq'
import type { Connection, DeviceDiscovery } from '../homeassistant'

export default class HADevice {
    config: DeviceDiscovery | undefined

    static config(meta: Metadata, deviceInfo?: object): DeviceDiscovery {
        return {
            availability: [{ topic: '$this/availability' }, { topic: '$rethink/availability' }],
            availability_mode: 'all',
            device: {
                identifiers: '$deviceid',
                manufacturer: 'LG',
                model: meta.modelName,
                sw_version: meta.swVersion,
                ...(deviceInfo || {}),
            },
            origin: {
                name: 'rethink',
                support_url: 'https://github.com/anszom/rethink',
            },
            components: {},
        }
    }

    constructor(
        readonly HA: Connection,
        readonly id: string,
    ) {}

    setConfig(config: DeviceDiscovery, removedComponents?: Record<string, { platform: string }>) {
        this.config = config
        if (removedComponents) {
            this.HA.publishConfig(this.id, {
                ...config,
                components: { ...config.components, ...removedComponents } as DeviceDiscovery['components'],
            })
        }
        this.publishConfig()
    }

    /**
     * Let go of everything that keeps running on its own — timers, subscriptions — without
     * saying anything to Home Assistant.
     *
     * A handler is superseded whenever an appliance reconnects before the old socket has
     * finished closing, and the replacement speaks for the same appliance under the same id.
     * The old one must go quiet at that moment: its queries are published onto the broker
     * topic the live appliance is subscribed to, so they still reach the appliance, and
     * never hearing an answer it eventually reports a perfectly healthy appliance as
     * unavailable. Handlers with nothing running need not override this.
     */
    stopTimers() {}

    drop() {
        this.stopTimers()
        this.HA.publishProperty(this.id, 'availability', 'offline')
    }

    start() {}

    // HA-side
    publishConfig() {
        if (this.config) {
            this.HA.publishProperty(this.id, 'availability', 'online')
            this.HA.publishConfig(this.id, this.config)
        }
    }

    setProperty(prop: string, mqttValue: string) {
        throw new Error('To be overriden')
    }
}
