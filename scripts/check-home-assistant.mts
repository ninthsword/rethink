/**
 * Check rethink's appliances from Home Assistant — the screen the owner actually reads.
 *
 * rethink's own signals are not evidence that the system works. The management API's
 * "connected" means a TCP session exists and nothing more: an appliance can hold a socket
 * open, never finish initialising, and have no Home Assistant device at all, while every
 * internal reading says it is fine. That is exactly how two air conditioners sat as
 * unavailable for a quarter of an hour while rethink reported eleven of eleven healthy.
 *
 *     npx tsx scripts/check-home-assistant.mts
 *
 * It reads the discovery configs rethink published, then checks what became of them.
 * Anything it cannot account for is printed and the exit status is non-zero.
 *
 * "available" is not the same as "current", which is the trap this exists to close. A
 * retained availability of online only says something published it once — possibly a
 * container ago — and an appliance can sit behind it showing hours-old values, or never have
 * finished starting up at all. Both happened here, twice in one evening, and both were read
 * as healthy. So freshness and start-up are checked too.
 *
 * Where the ha-mcp server is available, Home Assistant's own last_changed per entity is the
 * final word on staleness; this is what can be had without it.
 */
import mqtt from 'mqtt'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** Longer than this without rethink publishing anything for an appliance is worth saying. */
const STALE_MINUTES = 45

const CONFIG = process.env.RETHINK_CONFIG ?? `${process.env.HOME}/docker/rethink-data/config.json`
const raw = readFileSync(CONFIG, 'utf-8')
const setting = (key: string) => new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`).exec(raw)?.[1]

/** Everything rethink told Home Assistant to create, and the last value it gave each topic. */
async function whatRethinkPublished() {
    const client = mqtt.connect(setting('mqtt_url')!, {
        clientId: 'rethink-ha-check',
        username: setting('mqtt_user'),
        password: setting('mqtt_pass'),
    })
    const retained = new Map<string, string>()
    // Listening before subscribing, because retained messages start arriving the moment the
    // subscription is acknowledged: attaching afterwards loses most of them, and the report
    // then blames the appliances for the reader's own race.
    client.on('message', (topic, payload, packet) => {
        if (packet.retain) retained.set(topic, payload.toString('utf-8'))
    })
    await new Promise<void>((resolve, reject) => {
        client.on('error', reject)
        client.on('connect', () => client.subscribe(['rethink/#', 'homeassistant/device/rethink/#'], () => resolve()))
    })
    await new Promise((resolve) => setTimeout(resolve, 10_000))
    client.end()

    const appliances = new Map<string, { name: string; entities: number }>()
    for (const [topic, body] of retained) {
        const match = /^homeassistant\/device\/rethink\/([^/]+)\/config$/.exec(topic)
        if (!match) continue
        const config = JSON.parse(body)
        appliances.set(match[1], {
            name: config.device?.name ?? match[1],
            entities: Object.keys(config.components ?? {}).length,
        })
    }
    return { appliances, retained }
}

/**
 * What rethink's own log says about each appliance: whether it ever finished starting up,
 * and when it last had anything to publish. An appliance still asking for its initial values
 * has no usable entities however available it claims to be.
 */
function fromTheLog() {
    let log = ''
    try {
        log = execFileSync('docker', ['logs', process.env.RETHINK_CONTAINER ?? 'rethink'], {
            encoding: 'utf-8',
            maxBuffer: 256 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'pipe'],
        })
    } catch {
        return undefined
    }
    const state = new Map<string, { stillStarting: boolean; lastPublish?: Date }>()
    for (const line of log.split('\n')) {
        const id = /([0-9a-f]{8}-[0-9a-f-]{27,})/.exec(line)?.[1]
        if (!id) continue
        const entry = state.get(id) ?? { stillStarting: false }
        if (line.includes('re-trying initial values')) entry.stillStarting = true
        if (line.includes('received initial values key')) entry.stillStarting = false
        if (/ publish [0-9a-f-]+ /.test(line)) {
            const at = new Date(line.slice(0, 24))
            if (!Number.isNaN(at.valueOf())) entry.lastPublish = at
        }
        state.set(id, entry)
    }
    return state
}

const log = fromTheLog()

const problems: string[] = []
const { appliances, retained } = await whatRethinkPublished()

console.log(`rethink published discovery for ${appliances.size} appliances\n`)
for (const [id, { name, entities }] of [...appliances].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
    const availability = retained.get(`rethink/${id}/availability`) ?? '(none)'
    const state = log?.get(id)
    const quietFor = state?.lastPublish ? Math.round((Date.now() - state.lastPublish.valueOf()) / 60_000) : undefined
    const note = state?.stillStarting
        ? 'still asking for its initial values'
        : quietFor !== undefined && quietFor >= STALE_MINUTES
          ? `nothing published for ${quietFor} minutes`
          : ''
    console.log(
        `  ${name.padEnd(14)} ${String(entities).padStart(3)} entities   availability=${availability.padEnd(7)} ${note}`,
    )
    if (availability !== 'online') problems.push(`${name} is ${availability} to Home Assistant`)
    // The one that reads as healthy from every angle except the screen.
    if (state?.stillStarting) problems.push(`${name} never finished starting up; its entities are not current`)
    else if (quietFor !== undefined && quietFor >= STALE_MINUTES)
        problems.push(`${name} has published nothing for ${quietFor} minutes`)
}

// An appliance rethink is talking to but never published discovery for has no entities at
// all — the failure that looks like health from the inside.
const management = setting('management_port') ?? '44401'
try {
    const status = (await (await fetch(`http://127.0.0.1:${management}/api/router/status`)).json()) as {
        devices: Array<{ name: string; deviceId?: string; connected: boolean }>
    }
    for (const device of status.devices) {
        if (!device.connected || !device.deviceId) continue
        if (!appliances.has(device.deviceId)) {
            problems.push(`${device.name} is connected to rethink but has no Home Assistant device`)
        }
    }
} catch (err) {
    problems.push(`could not read the management interface: ${err}`)
}

console.log()
if (!problems.length) {
    console.log('Nothing unaccounted for.')
    process.exit(0)
}
console.log('Unaccounted for:')
for (const problem of problems) console.log(`  - ${problem}`)
process.exit(1)
