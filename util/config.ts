import { isIP } from 'node:net'

export type RawConfig = {
    hostname: string
    homeassistant: HAConfig
    ca_key_file: string
    ca_cert_file: string
    https_port: Port | number
    mqtts_port: Port | number
    mqtt_port: Port | number
    management_port?: Port | number
    management_host?: string
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
    stall_hostnames?: string[]
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
    management_host: string
    thinq1_https_port: Port
    thinq1_port: Port
    mqtt: boolean
    sni_certificates: boolean
    route_servers?: { apiServer: string; mqttServer: string }
    passthrough_hostnames: string[]
    stall_hostnames: string[]
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

/**
 * Every setting named here is dereferenced during startup, so leaving one out used to end
 * the process with "Cannot read properties of undefined (reading 'bind')" from a line that
 * says nothing about which setting was missing. Saying the name costs one check.
 */
function required<T>(value: T | undefined, name: string): T {
    if (value === undefined || value === null || value === '') throw new Error(`config.json: ${name} is required`)
    return value
}

function isLoopbackHost(value: string): boolean {
    const host = value.trim().toLowerCase()
    if (host === 'localhost') return true
    if (isIP(host) === 4) {
        const octets = host.split('.').map(Number)
        return octets[0] === 127
    }
    if (isIP(host) !== 6) return false
    if (host.includes('.')) return false

    const [head, tail] = host.split('::')
    if (host.split('::').length > 2) return false
    const left = head ? head.split(':').filter(Boolean) : []
    const right = tail ? tail.split(':').filter(Boolean) : []
    if (head && !host.includes('::') && left.length !== 8) return false
    const groups = host.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left
    return (
        groups.length === 8 &&
        groups.slice(0, 7).every((group) => Number.parseInt(group, 16) === 0) &&
        Number.parseInt(groups[7], 16) === 1
    )
}

function validatedManagementHost(value: unknown): string {
    if (typeof value !== 'string' || !isLoopbackHost(value)) {
        throw new Error('config.json: management_host must be localhost or a loopback address')
    }
    const normalized = value.trim().toLowerCase()
    return normalized === 'localhost' ? '127.0.0.1' : normalized
}

/** Return the validated loopback address for the unauthenticated management API. */
export function managementHost(config: Config): string {
    return validatedManagementHost(config.management_host)
}

export function normalize(config: RawConfig): Config {
    const homeassistant = {
        language: 'english' as const,
        offline_grace_seconds: 1800,
        ...config.homeassistant,
    }
    for (const key of ['mqtt_url', 'discovery_prefix', 'rethink_prefix'] as const)
        required(homeassistant[key], `homeassistant.${key}`)

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
        stall_hostnames: [],
        /*
         * The management API has no authentication: anything that can reach it can
         * release DNAT, edit the router credentials, or turn a bridge off. Loopback keeps
         * that behind SSH to this host; non-loopback bindings are rejected.
         */
        ...config,
        homeassistant,
        bridge: config.bridge
            ? {
                  preserve_existing_devices: false,
                  ...config.bridge,
              }
            : undefined,
        hostname: required(config.hostname, 'hostname'),
        ca_key_file: required(config.ca_key_file, 'ca_key_file'),
        ca_cert_file: required(config.ca_cert_file, 'ca_cert_file'),
        https_port: required(parsePort(config.https_port), 'https_port'),
        mqtts_port: required(parsePort(config.mqtts_port), 'mqtts_port'),
        mqtt_port: required(parsePort(config.mqtt_port), 'mqtt_port'),
        management_port: parsePort(config.management_port),
        management_host: validatedManagementHost(config.management_host ?? '127.0.0.1'),
        thinq1_https_port: required(parsePort(config.thinq1_https_port ?? 46030), 'thinq1_https_port'),
        thinq1_port: required(parsePort(config.thinq1_port ?? 47878), 'thinq1_port'),
    }
}
