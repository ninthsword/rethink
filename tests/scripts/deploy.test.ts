import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const image = `sha256:${'a'.repeat(64)}`
const ready = {
    configured: true,
    connected: true,
    devices: [
        {
            entryId: 'entry-1',
            ip: '192.0.2.1',
            deviceId: 'device-1',
            mode: 'dnat',
            dnatDesired: true,
            bridgeSaved: true,
            bridgeArchived: false,
            forwardingPaused: false,
            dnat: 'on',
        },
    ],
}
const released = { ...ready, devices: [{ ...ready.devices[0], dnat: 'off', forwardingPaused: true }] }
type Response = { status?: number; body?: unknown }
type Scenario = {
    args?: string[]
    release?: number
    running?: boolean
    alreadyReleased?: boolean
    baseline?: unknown
    releaseResponses?: Response[]
    responses?: Response[]
    tagId?: string
    actualImage?: string
    buildFailure?: boolean
    containers?: string[]
    listFailure?: boolean
    runFailure?: boolean
    runLostAcknowledgement?: boolean
    unsafeData?: boolean
}
type Event = { command: string; args: string[] }

function deploy(scenario: Scenario = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'rethink-deploy-test-'))
    try {
        const bin = join(dir, 'bin')
        const data = join(dir, 'data')
        mkdirSync(bin)
        mkdirSync(data)
        if (scenario.unsafeData) symlinkSync(bin, join(data, 'unsafe-link'))
        writeFileSync(join(dir, 'events'), '')
        const stub = `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const command = path.basename(process.argv[1])
const args = process.argv.slice(2)
const dir = process.env.RETHINK_TEST_DIR
const scenario = JSON.parse(process.env.RETHINK_TEST_SCENARIO)
fs.appendFileSync(path.join(dir, 'events'), JSON.stringify({command, args}) + '\\n')
const image = ${JSON.stringify(image)}
if (command === 'docker') {
 if (args[0] === 'container') {
  if (scenario.listFailure) process.exit(1)
  const file = path.join(dir, 'list-count')
  const index = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0
  fs.writeFileSync(file, String(index + 1))
  const entries = scenario.containers ?? ['rethink\\n']
  process.stdout.write(entries[Math.min(index, entries.length - 1)])
 }
 if (args[0] === 'run' && scenario.runFailure) process.exit(1)
 if (args[0] === 'build') {
  if (scenario.buildFailure) process.exit(1)
  fs.writeFileSync(args[args.indexOf('--iidfile') + 1], image + '\\n')
 }
 if (args[0] === 'image') console.log(scenario.tagId ?? image)
 if (args[0] === 'stop') fs.writeFileSync(path.join(dir, 'stopped'), '')
 if (args[0] === 'run') {
  fs.writeFileSync(path.join(dir, 'started'), '')
  if (scenario.runLostAcknowledgement) process.exit(1)
 }
 if (args[0] === 'inspect') console.log(args.includes('{{.Image}}') ? (scenario.actualImage ?? image) : String(fs.existsSync(path.join(dir, 'stopped')) ? false : (scenario.running ?? true)))
}
if (command === 'curl') {
 let response
 if (args.at(-1).endsWith('/release')) response = {status: scenario.release ?? 0}
 else {
  const started = fs.existsSync(path.join(dir, 'started'))
  const key = started ? 'responses' : 'before'
  const file = path.join(dir, key)
  const index = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0
  fs.writeFileSync(file, String(index + 1))
  if (!started && index === 0) response = {body: scenario.baseline ?? ${JSON.stringify(ready)}}
  else {
   const entries = started ? (scenario.responses ?? [{body: ${JSON.stringify(ready)}}]) : (scenario.releaseResponses ?? [{body: ${JSON.stringify(released)}}])
   response = entries[Math.min(started ? index : index - 1, entries.length - 1)]
  }
 }
 const body = response.body === undefined ? '' : (typeof response.body === 'string' ? response.body : JSON.stringify(response.body))
 fs.writeFileSync(args[args.indexOf('-o') + 1], body)
 process.exit(response.status ?? 0)
}
`
        for (const command of ['docker', 'curl', 'sleep']) {
            writeFileSync(join(bin, command), stub)
            chmodSync(join(bin, command), 0o755)
        }
        const result = spawnSync('bash', ['scripts/deploy.sh', ...(scenario.args ?? ['synthetic'])], {
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
            events: readFileSync(join(dir, 'events'), 'utf-8')
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
const isRelease = (event: Event) => event.command === 'curl' && event.args[event.args.length - 1]?.endsWith('/release')

test('default builds once then proves timed-out release before stop and restores exact image', options, () => {
    const { result, events } = deploy({ release: 28, releaseResponses: [{ body: ready }, { body: released }] })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(events.filter((event) => event.args[0] === 'build').length, 1)
    assert.equal(events.filter(isRelease).length, 1)
    const stop = events.findIndex((event) => event.args[0] === 'stop')
    assert.ok(stop > events.findIndex(isRelease))
    assert.equal(events.slice(0, stop).filter((event) => event.command === 'curl' && !isRelease(event)).length, 3)
    assert.ok(events.find((event) => event.args[0] === 'run')?.args.includes(image))
    assert.equal(JSON.parse(result.stdout).image_id, image)
    assert.doesNotMatch(result.stdout + result.stderr, /192\.0\.2\.1|device-1/)
    assert.ok(!events.some((event) => event.args.some((arg) => /suspend|undeploy|archive/.test(arg))))
})

test('partial unknown drift and failed HTTP release observations never stop or replay', options, () => {
    for (const response of [
        { body: { ...released, devices: [{ ...released.devices[0], dnat: 'partial' }] } },
        { body: { ...released, devices: [{ ...released.devices[0], dnat: 'unknown' }] } },
        { body: { ...released, devices: [{ ...released.devices[0], bridgeSaved: false }] } },
        { body: { ...released, devices: [] } },
        { status: 22, body: released },
        { body: '{invalid' },
    ]) {
        const { result, events } = deploy({ releaseResponses: [response] })
        assert.equal(result.status, 1, result.stderr)
        assert.equal(events.filter(isRelease).length, 1)
        assert.ok(!events.some((event) => ['stop', 'rm', 'run'].includes(event.args[0])))
        assert.ok(events.filter((event) => event.command === 'curl').length <= 32)
    }
})

test('build-only leaves runtime untouched and replacement requires stopped exact-tag image', options, () => {
    const built = deploy({ args: ['--build-only', 'operation'] })
    assert.equal(built.result.status, 0, built.result.stderr)
    assert.deepEqual(
        built.events.map((event) => event.args[0]),
        ['build', 'image'],
    )
    assert.equal(JSON.parse(built.result.stdout).image_id, image)
    const replaced = deploy({ args: ['--replace-only', 'operation', image], running: false })
    assert.equal(replaced.result.status, 0, replaced.result.stderr)
    assert.ok(!replaced.events.some((event) => ['build', 'stop'].includes(event.args[0]) || isRelease(event)))
    for (const scenario of [{ running: true }, { running: false, tagId: `sha256:${'b'.repeat(64)}` }]) {
        const failed = deploy({ args: ['--replace-only', 'operation', image], ...scenario })
        assert.equal(failed.result.status, 1)
        assert.ok(
            !failed.events.some((event) => ['build', 'stop', 'rm', 'run'].includes(event.args[0]) || isRelease(event)),
        )
    }
    for (const args of [['--replace-only', 'operation', 'latest'], ['--build-only', '../bad'], ['--unknown']]) {
        const failed = deploy({ args })
        assert.equal(failed.result.status, 1)
        assert.deepEqual(failed.events, [])
    }
})

test('legacy stopped recovery builds once and never releases again', options, () => {
    const running = deploy({ alreadyReleased: true })
    assert.equal(running.result.status, 1)
    assert.deepEqual(
        running.events.map((event) => event.args[0]),
        ['inspect'],
    )
    const stopped = deploy({ alreadyReleased: true, running: false })
    assert.equal(stopped.result.status, 0, stopped.result.stderr)
    assert.equal(stopped.events.filter((event) => event.args[0] === 'build').length, 1)
    assert.ok(!stopped.events.some(isRelease))
})

test('zero desired DNAT permits unconfigured local or empty state without a release POST', options, () => {
    for (const devices of [
        [],
        [{ ...ready.devices[0], mode: 'local' }],
        [{ ...ready.devices[0], dnatDesired: false }],
    ]) {
        const baseline = { configured: false, connected: false, devices }
        const { result, events } = deploy({ baseline, responses: [{ body: baseline }] })
        assert.equal(result.status, 0, result.stderr)
        assert.ok(!events.some(isRelease))
    }
})

test('baseline and build failures preserve runtime and restore rejects registration drift', options, () => {
    for (const scenario of [{ buildFailure: true }, { baseline: {} }]) {
        const { result, events } = deploy(scenario)
        assert.equal(result.status, 1)
        assert.ok(!events.some((event) => ['stop', 'rm', 'run'].includes(event.args[0]) || isRelease(event)))
    }
    for (const responses of [[{ status: 22, body: ready }], [{ body: { ...ready, devices: [] } }]]) {
        const { result } = deploy({ responses })
        assert.equal(result.status, 1)
    }
    assert.equal(deploy({ actualImage: `sha256:${'b'.repeat(64)}` }).result.status, 1)
})

test('create-only proves absence twice and creates once with the exact replacement options', options, () => {
    const created = deploy({ args: ['--create-only', 'operation', image], containers: [''] })
    assert.equal(created.result.status, 0, created.result.stderr)
    assert.deepEqual(
        created.events.filter((event) => event.command === 'docker').map((event) => event.args[0]),
        ['container', 'image', 'container', 'run', 'inspect'],
    )
    for (const event of created.events.filter((event) => event.args[0] === 'container')) {
        assert.deepEqual(event.args, [
            'container',
            'ls',
            '--all',
            '--filter',
            'name=^/rethink$',
            '--format',
            '{{.Names}}',
        ])
    }
    assert.ok(!created.events.some((event) => ['build', 'stop', 'rm'].includes(event.args[0]) || isRelease(event)))
    const replaced = deploy({ args: ['--replace-only', 'operation', image], running: false })
    const run = created.events.find((event) => event.args[0] === 'run')?.args
    const replacementRun = replaced.events.find((event) => event.args[0] === 'run')?.args
    assert.ok(run && replacementRun)
    // Synthetic data roots differ; every other argument must remain exactly the same.
    assert.deepEqual(
        run.map((arg) => (arg.endsWith(':/app/data') ? 'DATA:/app/data' : arg)),
        replacementRun.map((arg) => (arg.endsWith(':/app/data') ? 'DATA:/app/data' : arg)),
    )
    assert.equal(JSON.parse(created.result.stdout).image_id, image)
})

test('create-only rejects existing containers and uncertain or changed absence without effects', options, () => {
    for (const scenario of [
        { containers: ['rethink\n'], running: true },
        { containers: ['rethink\n'], running: false },
        { containers: [''], listFailure: true },
        { containers: [''], unsafeData: true },
        { containers: ['\n'] },
        { containers: ['unexpected'] },
        { containers: ['', 'rethink\n'] },
        { containers: [''], tagId: `sha256:${'b'.repeat(64)}` },
    ]) {
        const { result, events } = deploy({ args: ['--create-only', 'operation', image], ...scenario })
        assert.equal(result.status, 1, result.stderr)
        assert.ok(
            !events.some((event) => ['build', 'stop', 'rm', 'run'].includes(event.args[0]) || event.command === 'curl'),
        )
    }
    for (const args of [
        ['--create-only', 'operation'],
        ['--create-only', '../bad', image],
        ['--create-only', 'operation', 'latest'],
    ]) {
        const { result, events } = deploy({ args, containers: [''] })
        assert.equal(result.status, 1)
        assert.deepEqual(events, [])
    }
})

test('create-only never replays a failed create or readiness/image observation', options, () => {
    for (const scenario of [
        { runFailure: true },
        { runLostAcknowledgement: true },
        { responses: [{ status: 22 }] },
        { actualImage: `sha256:${'b'.repeat(64)}` },
    ]) {
        const { result, events } = deploy({
            args: ['--create-only', 'operation', image],
            containers: [''],
            ...scenario,
        })
        assert.equal(result.status, 1)
        assert.equal(events.filter((event) => event.args[0] === 'run').length, 1)
        if ('runLostAcknowledgement' in scenario) assert.equal(events[events.length - 1]?.args[0], 'run')
        assert.ok(!events.some((event) => ['build', 'stop', 'rm'].includes(event.args[0]) || isRelease(event)))
        assert.ok(events.filter((event) => event.command === 'curl').length <= 30)
    }
})
