import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { createServer } from 'node:tls'
import { connect, type MqttClient } from 'mqtt'
import { DeviceMQTTAccess } from '@/cloud/mqtt-access'
import { Broker } from '@/cloud/mqtt-broker'
import { loadDiagnosticSettings } from '@/tools/mqtt-diagnostic'

const secret = 'test-password'.repeat(3)
const account = { username: 'diagnostic', password: secret, device_ids: ['one'], allow_publish: true }
const pause = (ms = 50) => new Promise<void>((resolve) => setTimeout(resolve, ms))
function run(tool: string, args: string[], filename?: string) {
    const child = spawn(process.execPath, ['--import', 'tsx', `tools/${tool}.ts`, ...args], {
        env: { ...process.env, RETHINK_MQTT_DIAGNOSTIC_CONFIG: filename ?? '' },
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (data) => {
        output += data.toString()
    })
    child.stderr.on('data', (data) => {
        output += data.toString()
    })
    const done = new Promise<{ code: number | null; output: string }>((resolve) =>
        child.on('close', (code) => resolve({ code, output })),
    )
    return { child, done, output: () => output }
}

test('diagnostic settings reject missing, symlink, broad-mode, oversized or malformed files without exposing values', () => {
    const dir = mkdtempSync(`${tmpdir()}/rethink-diagnostic-settings-`),
        filename = `${dir}/mqtt-diagnostic.json`
    try {
        assert.throws(() => loadDiagnosticSettings(`${dir}/missing`), /설정 파일/)
        writeFileSync(filename, JSON.stringify({ password: secret }), { mode: 0o600 })
        assert.throws(() => loadDiagnosticSettings(filename), /설정 파일/)
        chmodSync(filename, 0o644)
        assert.throws(() => loadDiagnosticSettings(filename), /설정 파일/)
        symlinkSync(filename, `${dir}/link`)
        assert.throws(() => loadDiagnosticSettings(`${dir}/link`), /설정 파일/)
        chmodSync(filename, 0o600)
        writeFileSync(filename, 'x'.repeat(16 * 1024 + 1))
        assert.throws(() => loadDiagnosticSettings(filename), /설정 파일/)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('actual three helper CLIs preserve TLS reads/writes and offline parsing; wrong trust/name/credentials never send application traffic', async () => {
    const dir = mkdtempSync(`${tmpdir()}/rethink-diagnostic-tls-`)
    const key = `${dir}/key.pem`,
        cert = `${dir}/ca.pem`,
        filename = `${dir}/mqtt-diagnostic.json`
    const created = spawnSync(
        'openssl',
        [
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-keyout',
            key,
            '-out',
            cert,
            '-days',
            '1',
            '-subj',
            '/CN=localhost',
            '-addext',
            'subjectAltName=DNS:localhost',
        ],
        { stdio: 'pipe' },
    )
    assert.equal(created.status, 0)
    const policy = new DeviceMQTTAccess(
        () => [],
        [account, { username: 'readonly', password: secret, device_ids: ['one'] }],
        async () => {
            throw new Error('diagnostics must bypass origin lookup')
        },
    )
    const broker = new Broker(policy),
        children: ReturnType<typeof run>[] = []
    const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (socket) =>
        broker.accept(socket, { tls: true }),
    )
    server.on('tlsClientError', () => {})
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert(address && typeof address === 'object')
    const endpoint = `127.0.0.1:${address.port}`
    const settings = {
        url: `mqtts://${endpoint}`,
        username: account.username,
        password: secret,
        ca_file: cert,
        servername: 'localhost',
        device_ids: ['one'],
        allow_publish: true,
    }
    const save = (overrides: object = {}) =>
        writeFileSync(filename, JSON.stringify({ ...settings, ...overrides }), { mode: 0o600 })
    let admitted = 0
    const publications: string[] = []
    broker.on('connect', () => admitted++)
    broker.on('publish', (packet, client) => {
        if (client) publications.push(packet.topic)
    })
    const launch = (tool: string, args: string[], file = filename) => {
        const child = run(tool, args, file)
        children.push(child)
        return child
    }
    try {
        save()
        const sender = launch('packet-sender', [endpoint, 'one', '1', '2', '3', '4', '5'])
        const sent = await sender.done
        assert.equal(sent.code, 0, sent.output)
        const device = launch('packet-sender-device', [endpoint, 'one', 'packet', '1', '"00"'])
        const deviceResult = await device.done
        assert.equal(
            deviceResult.code,
            0,
            `${deviceResult.output} admitted=${admitted} publications=${publications.length}`,
        )
        assert.deepEqual(publications, ['lime/devices/one', 'lime/devices/one'])
        const parser = launch('packet-parser', [endpoint, 'one'])
        for (
            let i = 0;
            i < 100 && ![...broker.clients].some((client) => client.subscriptions.has('clip/message/devices/one'));
            i++
        )
            await pause(10)
        broker.publish(
            {
                topic: 'clip/message/devices/one',
                payload: JSON.stringify({ did: 'one', cmd: 'device_packet', data: '0000000000000000000000' }),
                qos: 0,
                retain: false,
                dup: false,
            },
            null,
        )
        for (let i = 0; i < 100 && !parser.output().includes('0000000000000000000000'); i++) await pause(10)
        assert.match(parser.output(), /0000000000000000000000/)
        parser.child.kill('SIGTERM')
        await parser.done
        const offline = run('packet-parser', ['-message-raw', '0000000000000000000000'])
        children.push(offline)
        assert.equal((await offline.done).code, 0)
        const before = admitted,
            beforePublications = publications.length
        for (const overrides of [
            { password: 'wrong-password-sentinel' },
            { servername: 'wrong.example' },
            { ca_file: '/etc/ssl/certs/ca-certificates.crt' },
            { url: `mqtt://${endpoint}` },
            { url: `mqtts://user:${secret}@${endpoint}` },
            { device_ids: ['two'] },
            { allow_publish: false },
        ]) {
            save(overrides)
            const result = await launch('packet-sender-device', [endpoint, 'one', 'packet', '1', '"00"']).done
            assert.equal(result.code, 1, result.output)
            assert(!result.output.includes(secret))
            assert(!result.output.includes('wrong-password-sentinel'))
        }
        assert.equal(admitted, before)
        assert.equal(publications.length, beforePublications)
        // Wire clients also exercise server-side grants rather than relying on the settings loader.
        save()
        const clients: MqttClient[] = []
        async function diagnostic(username = account.username, password = secret, extra: object = {}) {
            const peer = connect(`mqtts://${endpoint}`, {
                username,
                password,
                ca: readFileSync(cert),
                servername: 'localhost',
                rejectUnauthorized: true,
                reconnectPeriod: 0,
                ...extra,
            })
            clients.push(peer)
            peer.on('error', () => {})
            await new Promise<void>((resolve, reject) => {
                peer.once('connect', () => resolve())
                peer.once('error', reject)
            })
            return peer
        }
        try {
            const reader = await diagnostic('readonly')
            const grants = await new Promise<number[]>((resolve) =>
                reader.subscribe(
                    [
                        'clip/message/devices/one',
                        'clip/provisioning/devices/one',
                        'lime/devices/one',
                        'lime/devices/two',
                        '#',
                    ],
                    (_error, _grants, packet) => resolve(packet?.granted.map(Number) ?? []),
                ),
            )
            assert.deepEqual(grants, [0, 0, 0, 128, 128])
            const seen: string[] = []
            reader.on('message', (topic) => seen.push(topic))
            broker.publish(
                { topic: 'lime/devices/two', payload: '{"did":"two"}', qos: 0, retain: true, dup: false },
                null,
            )
            broker.publish(
                { topic: 'lime/devices/one', payload: '{"did":"one"}', qos: 0, retain: true, dup: false },
                null,
            )
            await pause(100)
            assert.deepEqual(seen, ['lime/devices/one'])
            for (const [username, topic, retain] of [
                ['readonly', 'lime/devices/one', false],
                ['diagnostic', 'clip/message/devices/one', false],
                ['diagnostic', 'clip/provisioning/devices/one', false],
                ['diagnostic', 'lime/devices/two', false],
                ['diagnostic', 'lime/devices/one', true],
            ] as const) {
                const peer = await diagnostic(username)
                const closed = new Promise<void>((resolve) => peer.once('close', () => resolve()))
                peer.publish(topic, JSON.stringify({ did: topic.endsWith('two') ? 'two' : 'one' }), { retain, qos: 0 })
                await closed
            }
            assert.equal(publications.length, beforePublications)
            const rejected = connect(`mqtts://${endpoint}`, {
                username: account.username,
                password: secret,
                ca: readFileSync(cert),
                servername: 'localhost',
                rejectUnauthorized: true,
                reconnectPeriod: 0,
                will: { topic: 'lime/devices/one', payload: Buffer.from('{"did":"one"}'), qos: 0, retain: false },
            })
            clients.push(rejected)
            rejected.on('error', () => {})
            await new Promise<void>((resolve) => rejected.once('close', () => resolve()))
            assert.equal(publications.length, beforePublications)
        } finally {
            clients.forEach((client) => {
                client.end(true)
            })
        }
        for (const child of children)
            assert(!child.output().includes(secret), 'credentials must not appear on stdout or stderr')
    } finally {
        for (const child of children) if (child.child.exitCode === null) child.child.kill('SIGTERM')
        for (const peer of broker.clients) peer.destroy(true)
        await new Promise<void>((resolve) => server.close(() => resolve()))
        rmSync(dir, { recursive: true, force: true })
    }
})
