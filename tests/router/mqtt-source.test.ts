import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import ssh2 from 'ssh2'
import { RouterConfigStore } from '@/router/config-store'
import { conntrackMQTTSource, MQTT_CONNTRACK_COMMAND, RouterMQTTSourceResolver } from '@/router/mqtt-source'
import { RouterSSHClient } from '@/router/ssh-client'

const pin = `SHA256:${Buffer.alloc(32, 1).toString('base64').replace(/=+$/, '')}`
const config = {
    host: '127.0.0.1',
    port: 22,
    rethinkIp: '192.0.2.2',
    username: 'synthetic',
    password: 'synthetic',
    hostKeyFingerprint: pin,
}
const source = {
    remoteAddress: '::ffff:127.0.0.1',
    remotePort: 45000,
    localAddress: '::ffff:192.0.2.2',
    localPort: 8883,
}
const entries = [
    { entryId: 'one', ip: '192.0.2.10', deviceId: 'one' },
    { entryId: 'two', ip: '192.0.2.11', deviceId: 'two' },
]
const row = (ip = '192.0.2.10', translatedPort = 45000) =>
    `tcp 6 431999 ESTABLISHED src=${ip} dst=198.51.100.2 sport=32123 dport=8883 src=192.0.2.2 dst=127.0.0.1 sport=8883 dport=${translatedPort} [ASSURED] mark=0 use=1\n`
const pause = (ms = 20) => new Promise<void>((resolve) => setTimeout(resolve, ms))
function storeFixture() {
    const dir = mkdtempSync(`${tmpdir()}/rethink-mqtt-source-`)
    const store = new RouterConfigStore(`${dir}/router.json`)
    store.updateRouter(config)
    for (const entry of entries) store.addDevice(entry.ip, 'local')
    return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('conntrack matches full reply tuple and translated source ports uniquely, including two NATed origins', () => {
    const output = row() + row('192.0.2.11', 45001)
    assert.equal(conntrackMQTTSource(output, source, config, entries), '192.0.2.10')
    assert.equal(conntrackMQTTSource(output, { ...source, remotePort: 45001 }, config, entries), '192.0.2.11')
    const invalid = [
        row().replace('ESTABLISHED', 'TIME_WAIT'),
        row().replace('tcp 6', 'udp 17'),
        row().replace('sport=8883', 'sport=8884'),
        row().replace('dst=127.0.0.1', 'dst=127.0.0.2'),
        row().replace('src=192.0.2.2', 'src=192.0.2.3'),
        row().replace('dport=45000', 'dport=45001'),
        row().replace('dport=8883', 'dport=8884'),
        row('192.0.2.99'),
        row() + row(),
        row().trimEnd(),
        row().replace('sport=32123', 'sport=0'),
        'malformed\n',
    ]
    for (const output of invalid) assert.equal(conntrackMQTTSource(output, source, config, entries), undefined, output)
    for (const changed of [
        { ...source, localPort: 8884 },
        { ...source, remotePort: 0 },
        { ...source, localAddress: '::1' },
    ])
        assert.equal(conntrackMQTTSource(row(), changed, config, entries), undefined)
    assert.equal(conntrackMQTTSource(row(), source, config, [...entries, entries[0]]), undefined)
})

test('resolver bypasses direct IP, uses fixed bounded query per socket, and revalidates config and inventory', async () => {
    const f = storeFixture()
    let calls = 0,
        close = 0
    let result = { code: 0, stdout: row(), stderr: '' }
    let during = () => {}
    const resolver = new RouterMQTTSourceResolver(f.store, () => ({
        connect: async () => {},
        exec: async (command, options) => {
            calls++
            assert.equal(command, MQTT_CONNTRACK_COMMAND)
            assert.equal(options?.timeoutMs, 2000)
            assert.equal(options?.maxBytes, 256 * 1024)
            during()
            return result
        },
        close: () => {
            close++
        },
    }))
    const signal = new AbortController().signal
    try {
        assert.equal(await resolver.resolve({ remoteAddress: '192.0.2.10' }, signal), '192.0.2.10')
        assert.equal(calls, 0)
        assert.equal(await resolver.resolve(source, signal), '192.0.2.10')
        assert.equal(await resolver.resolve(source, signal), '192.0.2.10')
        assert.equal(calls, 2, 'fresh sockets never reuse a positive origin cache')
        for (const failed of [
            { code: 1, stdout: row(), stderr: '' },
            { code: 0, stdout: row(), stderr: 'failed\n' },
            { code: 0, stdout: 'x'.repeat(256 * 1024 + 1), stderr: '' },
        ]) {
            result = failed
            assert.equal(await resolver.resolve(source, signal), undefined)
        }
        result = { code: 0, stdout: row(), stderr: '' }
        during = () => f.store.updateRouter({ username: 'changed' })
        assert.equal(await resolver.resolve(source, signal), undefined)
        during = () => f.store.deleteDevice(f.store.devices()[0].entryId)
        assert.equal(await resolver.resolve(source, signal), undefined)
        assert.equal(close, calls)
        assert.equal(await resolver.resolve({ ...source, remoteAddress: '192.0.2.99' }, signal), undefined)
    } finally {
        f.cleanup()
    }
})

test('resolver limits active/queued lookups, removes queued aborts and aborts the running transport', async () => {
    const f = storeFixture()
    let active = 0,
        maximum = 0,
        closed = 0,
        aborted = 0
    const resolver = new RouterMQTTSourceResolver(f.store, () => ({
        connect: async ({ signal } = {}) => {
            active++
            maximum = Math.max(maximum, active)
            await new Promise<void>((_resolve, reject) =>
                signal?.addEventListener(
                    'abort',
                    () => {
                        aborted++
                        reject(new Error('synthetic cancellation'))
                    },
                    { once: true },
                ),
            )
        },
        exec: async () => ({ code: 0, stdout: row(), stderr: '' }),
        close: () => {
            active--
            closed++
        },
    }))
    const controllers = Array.from({ length: 19 }, () => new AbortController())
    try {
        const jobs = controllers.map((controller) => resolver.resolve(source, controller.signal))
        await pause()
        assert.equal(maximum, 2)
        assert.equal(await jobs[18], undefined, 'only 2 active plus 16 queued')
        controllers[5].abort()
        assert.equal(await jobs[5], undefined)
        controllers.forEach((controller) => {
            controller.abort()
        })
        await Promise.all(jobs)
        await pause()
        assert.equal(aborted, 2)
        assert.equal(closed, 2)
        assert.equal(active, 0)
    } finally {
        f.cleanup()
    }
})

test('real pinned SSH consumer resolves conntrack; mismatched pin sends no credentials; output/timeout/abort close owned transport', async () => {
    const { privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    const key = Buffer.from(privateKey)
    const fingerprint = `SHA256:${createHash('sha256').update(ssh2.utils.parseKey(key).getPublicSSH()).digest('base64').replace(/=+$/, '')}`
    const f = storeFixture()
    let auth = 0,
        commands = 0,
        connections = 0,
        mode = 'normal'
    const peers = new Set<{ end(): void }>()
    const server = new ssh2.Server({ hostKeys: [key] }, (peer) => {
        connections++
        peers.add(peer)
        peer.on('error', () => {})
        peer.on('close', () => peers.delete(peer))
        peer.on('authentication', (context: { accept(): void }) => {
            auth++
            context.accept()
        })
        peer.on('ready', () =>
            peer.on(
                'session',
                (
                    accept: () => {
                        on(
                            event: 'exec',
                            cb: (
                                accept: () => { write(value: string): void; exit(code: number): void; end(): void },
                                reject: unknown,
                                info: { command: string },
                            ) => void,
                        ): void
                    },
                ) => {
                    const session = accept()
                    session.on(
                        'exec',
                        (
                            accept: () => { write(value: string): void; exit(code: number): void; end(): void },
                            _reject: unknown,
                            info: { command: string },
                        ) => {
                            commands++
                            assert.equal(info.command, MQTT_CONNTRACK_COMMAND)
                            const stream = accept()
                            if (mode === 'normal') {
                                stream.write(row())
                                stream.exit(0)
                                stream.end()
                            } else if (mode === 'overflow') stream.write('x'.repeat(300 * 1024))
                        },
                    )
                },
            ),
        )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert(address && typeof address === 'object')
    f.store.updateRouter({ port: address.port, hostKeyFingerprint: fingerprint })
    try {
        const resolver = new RouterMQTTSourceResolver(f.store)
        assert.equal(await resolver.resolve(source, new AbortController().signal), '192.0.2.10')
        assert.equal(commands, 1)
        const before = auth
        f.store.updateRouter({ hostKeyFingerprint: pin })
        assert.equal(await resolver.resolve(source, new AbortController().signal), undefined)
        assert.equal(auth, before)
        f.store.updateRouter({ hostKeyFingerprint: fingerprint })
        mode = 'overflow'
        assert.equal(await resolver.resolve(source, new AbortController().signal), undefined)
        mode = 'stall'
        assert.equal(await resolver.resolve(source, new AbortController().signal), undefined)
        const controller = new AbortController()
        const job = resolver.resolve(source, controller.signal)
        await pause(100)
        controller.abort()
        assert.equal(await job, undefined)
        await pause(100)
        assert.equal(peers.size, 0)
        assert(connections >= 4)
        // Cancellation before ready must close the actual SSH socket too.
        const native = new RouterSSHClient(f.store.router())
        const abort = new AbortController()
        const connecting = native.connect({ signal: abort.signal })
        abort.abort()
        await assert.rejects(connecting)
        native.close()
    } finally {
        peers.forEach((peer) => {
            peer.end()
        })
        await new Promise<void>((resolve) => server.close(() => resolve()))
        f.cleanup()
    }
})
