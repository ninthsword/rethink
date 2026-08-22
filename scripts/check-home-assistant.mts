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
 * It reads the discovery configs rethink published, then asks Home Assistant what became of
 * them. Anything it cannot account for is printed and the exit status is non-zero.
 */
import mqtt from 'mqtt'
import { readFileSync } from 'node:fs'

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

const problems: string[] = []
const { appliances, retained } = await whatRethinkPublished()

console.log(`rethink published discovery for ${appliances.size} appliances\n`)
for (const [id, { name, entities }] of [...appliances].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
    const availability = retained.get(`rethink/${id}/availability`) ?? '(none)'
    const fresh = availability === 'online'
    console.log(`  ${name.padEnd(14)} ${String(entities).padStart(3)} entities   availability=${availability}`)
    if (!fresh) problems.push(`${name} is ${availability} to Home Assistant`)
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
