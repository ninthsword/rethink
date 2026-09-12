import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// Synthetic full-script harness: Docker, HTTP and sleeps are replaced with recorders.
const ready = {
    configured: true,
    connected: true,
    devices: [{ mode: 'dnat', dnatDesired: true, forwardingPaused: false, dnat: 'on' }],
}
const pending = { ...ready, devices: [{ ...ready.devices[0], dnat: 'off' }] }
type Response = { status?: number; body?: unknown }
type Scenario = {
    release?: number
    running?: boolean
    alreadyReleased?: boolean
    management?: number[]
    responses?: Response[]
}
type Event = { command: string; args: string[] }

function deploy(scenario: Scenario = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'rethink-deploy-test-'))
    try {
        const bin = join(dir, 'bin')
        const data = join(dir, 'data')
        mkdirSync(bin)
        mkdirSync(data)
        const events = join(dir, 'events')
        writeFileSync(events, '')
        const stub = `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const command = path.basename(process.argv[1])
const args = process.argv.slice(2)
const dir = process.env.RETHINK_TEST_DIR
const scenario = JSON.parse(process.env.RETHINK_TEST_SCENARIO)
fs.appendFileSync(path.join(dir, 'events'), JSON.stringify({command, args}) + '\\n')
if (command === 'docker' && args[0] === 'inspect') console.log(String(scenario.running ?? false))
if (command === 'curl') {
    if (args.at(-1).endsWith('/release')) process.exit(scenario.release ?? 0)
    const kind = args.includes('-o') ? 'management' : 'responses'
    const file = path.join(dir, kind)
    const index = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0
    fs.writeFileSync(file, String(index + 1))
    const entries = scenario[kind] ?? (kind === 'management' ? [0] : [{body: ${JSON.stringify(ready)}}])
    const response = entries[Math.min(index, entries.length - 1)]
    if (kind === 'management') process.exit(response)
    if (response.body !== undefined) console.log(typeof response.body === 'string' ? response.body : JSON.stringify(response.body))
    process.exit(response.status ?? 0)
}
`
        for (const command of ['docker', 'curl', 'sleep']) {
            writeFileSync(join(bin, command), stub)
            chmodSync(join(bin, command), 0o755)
        }
        const result = spawnSync('bash', ['scripts/deploy.sh', 'synthetic'], {
            encoding: 'utf-8',
            timeout: 20_000,
            env: {
                ...process.env,
                PATH: `${bin}:${process.env.PATH}`,
                RETHINK_DATA: data,
                RETHINK_MGMT: 'fixture.invalid:44401',
                RETHINK_DNAT_ALREADY_RELEASED: scenario.alreadyReleased ? '1' : '0',
                RETHINK_TEST_DIR: dir,
                RETHINK_TEST_SCENARIO: JSON.stringify(scenario),
            },
        })
        assert.ifError(result.error)
        return {
            result,
            events: readFileSync(events, 'utf-8')
                .trim()
                .split('\n')
                .filter(Boolean)
                .map((line) => JSON.parse(line) as Event),
        }
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
}

const options = { skip: process.getuid?.() === 0 ? 'requires non-root data owner' : false }

test('deployment releases before stop and retries until every desired entry is ready', options, () => {
    const { result, events } = deploy({ management: [7, 0], responses: [{ body: pending }, { body: ready }] })
    assert.equal(result.status, 0, result.stderr)
    const commands = events.filter((event) => event.command !== 'sleep')
    assert.deepEqual(
        commands.slice(0, 5).map((event) => (event.command === 'curl' ? 'release' : event.args[0])),
        ['release', 'build', 'stop', 'rm', 'run'],
    )
    assert.equal(events.filter((event) => event.command === 'curl' && !event.args.includes('-o')).length, 3)
    for (const event of events.filter((event) => event.command === 'curl')) {
        assert.ok(event.args.includes('--connect-timeout'))
        assert.ok(event.args.includes('--max-time'))
    }
    assert.ok(!events.some((event) => event.args.some((arg) => /suspend|undeploy|archive/.test(arg))))
})

test('HTTP failure with a ready body, malformed JSON, partial and paused DNAT must retry', options, () => {
    const responses = [
        { status: 22, body: ready },
        { body: '{invalid' },
        { body: {} },
        { body: { ...ready, devices: [{ ...ready.devices[0], dnat: 'partial' }] } },
        { body: { ...ready, devices: [{ ...ready.devices[0], forwardingPaused: true }] } },
        { body: { ...ready, connected: false } },
        { body: ready },
    ]
    const { result, events } = deploy({ responses })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(
        events.filter((event) => event.command === 'curl' && !event.args.includes('-o')).length,
        responses.length + 1,
    )
})

test('management and DNAT timeouts exit nonzero after bounded attempts', options, () => {
    for (const scenario of [
        { management: [28] },
        { responses: [{ body: pending }] },
        { responses: [{ status: 7, body: ready }] },
    ]) {
        const { result, events } = deploy(scenario)
        assert.equal(result.status, 1, result.stderr)
        assert.match(result.stderr, /deployment failed/)
        assert.doesNotMatch(result.stdout, /forwarding is ready/)
        const requests = events.filter((event) => event.command === 'curl')
        assert.ok(requests.length <= 32)
    }
})

test('release failure cannot stop the container and stopped recovery checks inspect first', options, () => {
    const failed = deploy({ release: 28 })
    assert.equal(failed.result.status, 1)
    assert.ok(failed.events.every((event) => event.command === 'curl'))
    const running = deploy({ alreadyReleased: true, running: true })
    assert.equal(running.result.status, 1)
    assert.deepEqual(
        running.events.map((event) => event.args[0]),
        ['inspect'],
    )
    const stopped = deploy({ alreadyReleased: true })
    assert.equal(stopped.result.status, 0, stopped.result.stderr)
    assert.deepEqual(
        stopped.events.slice(0, 5).map((event) => event.args[0]),
        ['inspect', 'build', 'stop', 'rm', 'run'],
    )
    assert.ok(!stopped.events.some((event) => event.args[event.args.length - 1]?.endsWith('/release')))
})

test('local, disabled and empty desired sets finish without a router connection', options, () => {
    for (const devices of [
        [],
        [{ ...ready.devices[0], mode: 'local', dnat: 'unknown' }],
        [{ ...ready.devices[0], dnatDesired: false, dnat: 'off' }],
    ]) {
        const { result } = deploy({ responses: [{ body: { configured: false, connected: false, devices } }] })
        assert.equal(result.status, 0, result.stderr)
    }
})

test('omitted DNAT intent is a no-op and does not hide a desired pending entry', options, () => {
    const omitted = { forwardingPaused: false, dnat: 'unknown' }
    for (const entry of [omitted, { ...omitted, mode: 'local' }, { ...omitted, mode: 'dnat' }]) {
        const { result } = deploy({ responses: [{ body: { configured: false, connected: false, devices: [entry] } }] })
        assert.equal(result.status, 0, result.stderr)
    }
    const { result, events } = deploy({
        responses: [
            { body: { ...ready, devices: [omitted, pending.devices[0]] } },
            { body: { ...ready, devices: [omitted, ready.devices[0]] } },
        ],
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(events.filter((event) => event.command === 'curl' && !event.args.includes('-o')).length, 3)
})

test('present malformed intent never reports readiness even for a local entry', options, () => {
    const { result } = deploy({
        responses: [{ body: { ...ready, devices: [{ ...ready.devices[0], mode: 'local', dnatDesired: null }] } }],
    })
    assert.equal(result.status, 1, result.stderr)
    assert.doesNotMatch(result.stdout, /forwarding is ready/)
})
