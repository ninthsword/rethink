export type RawConfig = {
    hostname: string
    homeassistant: HAConfig
    ca_key_file: string
    ca_cert_file: string
    https_port: Port | number
    mqtts_port: Port | number
    mqtt_port: Port | number
    management_port?: Port | number
    thinq1_https_port?: Port | number
    thinq1_port?: Port | number
    mqtt?: boolean
    sni_certificates?: boolean
    /**
     * What to tell an appliance its servers are, when it asks. Left unset, rethink names
     * itself — which is what the original setup does, having first made that name resolve
     * and pointed the appliance at it deliberately. Where the appliances are redirected by a
     * firewall rule instead, that name was never published anywhere and an appliance told to
     * use it is left with an address that does not exist: it stops dialling and only a power
     * cycle brings it back. Naming its own factory servers keeps the appliance on addresses
     * that resolve, and the firewall rule goes on redirecting them.
     */
    route_servers?: { apiServer: string; mqttServer: string }
    /**
     * Hostnames the appliances address that rethink has no routes for, and so must not
     * answer: the firewall rule catches every host on port 443, and offering a certificate
     * for one rethink cannot serve leaves the appliance retrying a refusal forever.
     */
    passthrough_hostnames?: string[]
    bridge?: {
        storage_path: string
        preserve_existing_devices?: boolean
    }
    log?: string[]
}

export type Config = {
    hostname: string
    homeassistant: HAConfig
    ca_key_file: string
    ca_cert_file: string
    https_port: Port
    mqtts_port: Port
    mqtt_port: Port
    management_port?: Port
    thinq1_https_port: Port
    thinq1_port: Port
    mqtt: boolean
    sni_certificates: boolean
    route_servers?: { apiServer: string; mqttServer: string }
    passthrough_hostnames: string[]
    bridge?: {
        storage_path: string
        preserve_existing_devices: boolean
    }
    log: string[]
}

export type HAConfig = {
    mqtt_url: string
    discovery_prefix: string
    rethink_prefix: string
    mqtt_user: string
    mqtt_pass: string
    /** Language used for MQTT discovery labels and appliance enum states. */
    language?: 'english' | 'korean'
    /**
     * Seconds a disconnected appliance keeps its Home Assistant entities available.
     * LG appliances power their Wi-Fi module down while idle, so a short grace makes
     * every entity flip to "unavailable" on the appliance's own standby cycle.
     */
    offline_grace_seconds?: number
    /**
     * Air conditioners that share an outdoor unit. Each indoor unit reports the outdoor
     * unit's power rather than its own share, so their totals cannot simply be added. The
     * first appliance in each group carries the group's power and energy sensors, and the
     * members keep their own power reading but none of them carries a total.
     */
    outdoor_units?: Array<{ name?: string; devices: string[] }>
}

export type CA = {
    key: string
    cert: string
}

export type Port = {
    bind: number
    advertise: number
}

function parsePort(port: Port | number): Port
function parsePort(port: Port | number | undefined): Port | undefined
function parsePort(port: Port | number | undefined): Port | undefined {
    return typeof port === 'number' ? { bind: port, advertise: port } : port
}

export function normalize(config: RawConfig): Config {
    return {
        log: ['status', 'incoming', 'HTTPS'],
        mqtt: true,
        sni_certificates: false,
        /*
         * Empty on purpose. rethink can run with the appliances forwarded to it and no cloud
         * bridge at all, and quietly splicing a host through to LG would reopen from behind
         * exactly the connection that setup exists to cut. Anything listed here leaves the
         * house, so the list is the owner's to write.
         */
        passthrough_hostnames: [],
        ...config,
        homeassistant: {
            language: 'english',
            offline_grace_seconds: 1800,
            ...config.homeassistant,
        },
        bridge: config.bridge
            ? {
                  preserve_existing_devices: false,
                  ...config.bridge,
              }
            : undefined,
        https_port: parsePort(config.https_port),
        mqtts_port: parsePort(config.mqtts_port),
        mqtt_port: parsePort(config.mqtt_port),
        management_port: parsePort(config.management_port),
        thinq1_https_port: parsePort(config.thinq1_https_port ?? 46030),
        thinq1_port: parsePort(config.thinq1_port ?? 47878),
    }
}
