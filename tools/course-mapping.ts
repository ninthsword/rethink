/**
 * Pair the course codes rethink reads off the wire with the names LG's cloud gives them.
 *
 *     npx tsx tools/course-mapping.ts
 *
 * The washer-family appliances send their selected and downloaded courses as a single byte
 * in the local AABB record. Nothing published says what those bytes mean: the model JSON
 * that LG serves for each appliance describes the *cloud* snapshot, where a course is a
 * string like POWER or SMALL_LOAD, and the byte appears nowhere in it. Decompiling the app
 * does not help for the same reason — the app reads the cloud's strings too.
 *
 * What does work is reading both at once. The cloud snapshot names the course; rethink's
 * retained MQTT topic carries the byte it decoded from the same appliance at the same time.
 * One reading pairs one byte with one name. So: download a course in the ThinQ app, wait for
 * the appliance to report it, run this, and record the line it prints. Repeat per course.
 *
 * It also resolves each course to the Korean the app displays, from LG's language pack, so a
 * new mapping can be added to util/ha_locale.ts in the same pass.
 *
 * Reading only. It refreshes the bridge's token and fetches the device list, model JSON and
 * language pack, exactly as the bridge does when it refreshes appliance names.
 */

import { readFileSync } from 'node:fs'
import mqtt from 'mqtt'
import { Client } from '@/bridge/thinqApi'

const CONFIG = process.env.RETHINK_CONFIG ?? `${process.env.HOME}/docker/rethink-data/config.json`
const STATE = process.env.RETHINK_STATE ?? `${process.env.HOME}/docker/rethink-data/state/oauth2.json`

const raw = readFileSync(CONFIG, 'utf-8')
const setting = (key: string) => new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`).exec(raw)?.[1]

/** The appliances whose courses arrive as a byte. The rest have no course concept at all. */
const COURSE_FIELDS = ['course', 'downloaded_course', 'operation_course', 'smart_course']

type CloudCourses = { deviceId: string; alias: string; modelName: string; courses: Record<string, string> }

/** Every course-shaped field in the cloud snapshot, with the language pack applied. */
async function fromCloud(): Promise<CloudCourses[]> {
    const creds = JSON.parse(readFileSync(STATE, 'utf-8'))
    const client = new Client(creds.env)
    // The pack is chosen by this header, and the point of the exercise is the Korean names.
    ;(client as unknown as { headers: Record<string, string> }).headers['x-language-code'] = 'ko-KR'
    await client.auth(creds.refreshToken)

    const devices = (await client.listDevices()) as unknown as Record<string, string & Record<string, unknown>>[]
    const out: CloudCourses[] = []

    for (const device of devices) {
        // The snapshot nests its readings under the product type — washerDryer, dishwasher —
        // rather than at the top level, so look one level down before giving up on a device.
        const top = (device.snapshot ?? {}) as Record<string, unknown>
        const snapshot = Object.values(top).find(
            (v) => v && typeof v === 'object' && Object.keys(v).some((k) => /course/i.test(k)),
        ) as Record<string, unknown> | undefined
        const fields = snapshot ? Object.keys(snapshot).filter((k) => /course/i.test(k)) : []
        if (!fields.length) continue

        const pack: Record<string, string> = {}
        for (const key of ['langPackProductTypeUri', 'langPackModelUri']) {
            const uri = device[key] as unknown as string | null
            if (!uri) continue
            try {
                const json = JSON.parse(await (await fetch(uri)).text())
                Object.assign(pack, json.pack ?? json)
            } catch {
                // A missing or malformed pack costs the Korean name, not the mapping.
            }
        }

        const model = JSON.parse(await (await fetch(device.modelJsonUri as unknown as string)).text())
        const named = (value: unknown) => {
            const key = String(value)
            for (const section of ['SmartCourse', 'Course'] as const) {
                const entry = model[section]?.[key]
                if (entry) return `${key}  ${pack[entry.name] ?? entry._comment ?? ''}`.trim()
            }
            return key
        }

        out.push({
            deviceId: device.deviceId as unknown as string,
            alias: device.alias as unknown as string,
            modelName: device.modelName as unknown as string,
            courses: Object.fromEntries(fields.map((f) => [f, named(snapshot?.[f])])),
        })
    }
    return out
}

/** The byte rethink decoded, per appliance, from its retained topics. */
async function fromRethink(): Promise<Map<string, Record<string, string>>> {
    const prefix = setting('rethink_prefix') ?? 'rethink'
    const mqttUrl = setting('mqtt_url')
    if (!mqttUrl) throw new Error('mqtt_url is missing from the rethink config')
    const client = mqtt.connect(mqttUrl, {
        clientId: 'rethink-course-mapping',
        username: setting('mqtt_user'),
        password: setting('mqtt_pass'),
    })

    const values = new Map<string, Record<string, string>>()
    // Subscribing acknowledges before the retained flood arrives, so listen first.
    await new Promise<void>((resolve) => {
        client.on('message', (topic, payload) => {
            const [, device, field] = topic.split('/')
            if (!device || !COURSE_FIELDS.includes(field)) return
            values.set(device, { ...values.get(device), [field]: payload.toString() })
        })
        client.on('connect', () => client.subscribe(`${prefix}/#`, () => resolve()))
    })
    await new Promise((r) => setTimeout(r, 2000))
    await client.endAsync()
    return values
}

const [cloud, local] = await Promise.all([fromCloud(), fromRethink()])

console.log('Pair each byte with the name beside it, then add it to the device handler and')
console.log('util/ha_locale.ts. A byte with no cloud name means the appliance has not reported')
console.log('the change yet — wait for it and run again.\n')

for (const { deviceId, alias, modelName, courses } of cloud) {
    // rethink keys its topics by the appliance's uuid, not by the name the app shows.
    const mine = local.get(deviceId)
    if (!mine) continue

    console.log(`${alias} (${modelName})`)
    for (const field of COURSE_FIELDS) {
        if (!(field in mine)) continue
        const cloudField = Object.keys(courses).find((k) => k.toLowerCase().includes(field.replace(/_/g, '')))
        console.log(
            `   ${field.padEnd(18)} rethink=${mine[field].padEnd(16)} cloud=${cloudField ? courses[cloudField] : '(no matching field)'}`,
        )
    }
    console.log()
}
