import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { RouterConfigStore } from '@/router/config-store'

let dir: string
let file: string

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rethink-config-store-'))
    file = join(dir, 'router-dnat.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('what the router configuration will accept', () => {
    test('a device address has to be an IPv4 address', () => {
        const store = new RouterConfigStore(file)

        assert.throws(() => store.addDevice('not-an-address'), /Invalid device IPv4/)
        assert.throws(() => store.addDevice('192.168.1.256'), /Invalid device IPv4/)
        assert.throws(() => store.addDevice(''), /Invalid device IPv4/)
        // Every one of these would otherwise reach an iptables command line on the router.
        assert.throws(() => store.addDevice('192.168.1.5; reboot'), /Invalid device IPv4/)
        assert.throws(() => store.addDevice('$(id)'), /Invalid device IPv4/)
        assert.deepEqual(store.devices(), [])
    })

    test('the same address cannot be registered twice', () => {
        const store = new RouterConfigStore(file)
        store.addDevice('192.168.1.5')
        assert.throws(() => store.addDevice('192.168.1.5'), /already registered/)
    })

    /*
     * The addresses stored here are interpolated into a shell command that runs on the
     * router as root. Reaching them through the API is checked; reaching them through the
     * file was not, so a hand-edited or truncated file put the trust boundary in the wrong
     * place.
     */
    test('an address that is not an address is dropped when the file is read', () => {
        writeFileSync(
            file,
            JSON.stringify({
                router: { host: '192.168.1.1', port: 22, username: 'admin', password: 'x', rethinkIp: '192.168.1.2' },
                devices: [
                    { entryId: 'a', ip: '192.168.1.5' },
                    { entryId: 'b', ip: '192.168.1.6; reboot' },
                    { entryId: 'c', ip: 'nonsense' },
                    { entryId: 'd' },
                    'not an object',
                ],
            }),
        )

        const store = new RouterConfigStore(file)
        assert.deepEqual(
            store.devices().map((entry) => entry.ip),
            ['192.168.1.5'],
        )
    })

    test('a file that is not readable JSON leaves an empty configuration rather than throwing', () => {
        writeFileSync(file, '{ this is not json')
        const store = new RouterConfigStore(file)

        assert.deepEqual(store.devices(), [])
        assert.equal(store.configured(), false)
    })

    test('the router itself cannot be registered as one of its own devices', () => {
        const store = new RouterConfigStore(file)
        store.updateRouter({
            host: '192.168.1.1',
            port: 22,
            username: 'admin',
            password: 'x',
            rethinkIp: '192.168.1.2',
        })

        assert.throws(() => store.addDevice('192.168.1.1'), /cannot be registered/)
        assert.throws(() => store.addDevice('192.168.1.2'), /cannot be registered/)
    })
})

test('failed persistence leaves previous in-memory configuration and desired intent intact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rethink-persistence-'))
    try {
        const store = new RouterConfigStore(join(dir, 'router.json'))
        const entry = store.addDevice('192.0.2.20')
        // A directory at the temporary-file path makes the next atomic write fail.
        mkdirSync(`${store.filename}.tmp`)
        assert.throws(() => store.setDnatDesired(entry.entryId, true))
        assert.equal(store.requireDevice(entry.entryId).dnatDesired, undefined)
        assert.throws(() => store.updateDevice(entry.entryId, { mode: 'local' }))
        assert.equal(store.requireDevice(entry.entryId).mode, undefined)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('explicit unlink survives automatic IP discovery until an explicit link', () => {
    const store = new RouterConfigStore(join(dir, 'router.json'))
    const entry = store.addDevice('192.0.2.20', 'local')
    store.linkDevice(entry.entryId, 'device')
    store.unlinkDevice(entry.entryId)
    assert.equal(store.linkByIp(entry.ip, 'device', 'Detected'), false)
    assert.equal(store.requireDevice(entry.entryId).deviceId, undefined)
    store.linkDevice(entry.entryId, 'device')
    assert.equal(store.requireDevice(entry.entryId).deviceId, 'device')
})

test('legacy SSH trust loads only from an exact private regular companion, without changing inventory', async () => {
    const { chmodSync, readFileSync, symlinkSync, unlinkSync } = await import('node:fs')
    const fingerprint = `SHA256:${Buffer.alloc(32, 2).toString('base64').replace(/=+$/, '')}`
    const router = { host: '192.0.2.1', port: 22, username: 'synthetic', password: 'synthetic', rethinkIp: '192.0.2.2' }
    const devices = [{ entryId: 'legacy', ip: '192.0.2.15', mode: 'local', dnatDesired: true }]
    const original = JSON.stringify({ router, devices })
    writeFileSync(file, original)
    const companion = join(dir, 'router-ssh-trust.json')
    const trust = { host: router.host, port: router.port, hostKeyFingerprint: fingerprint }
    const writeTrust = (value: object) => writeFileSync(companion, JSON.stringify(value), { mode: 0o600 })
    assert.equal(new RouterConfigStore(file).router().hostKeyFingerprint, undefined)
    writeTrust(trust)
    const store = new RouterConfigStore(file)
    assert.equal(store.router().hostKeyFingerprint, fingerprint)
    assert.deepEqual(store.devices(), devices)
    assert.equal(readFileSync(file, 'utf8'), original)
    store.updateRouter({ username: 'updated', password: '' })
    assert.equal(store.router().password, 'synthetic')
    assert.equal(store.router().hostKeyFingerprint, fingerprint)
    assert.deepEqual(store.devices(), devices)
    store.updateRouter({ host: '192.0.2.3' })
    assert.equal(store.router().hostKeyFingerprint, undefined, 'new endpoints cannot inherit trust')
    writeFileSync(file, original)
    chmodSync(companion, 0o644)
    assert.equal(new RouterConfigStore(file).router().hostKeyFingerprint, undefined)
    chmodSync(companion, 0o600)
    for (const value of [
        { ...trust, host: '192.0.2.9' },
        { ...trust, port: 23 },
        { ...trust, hostKeyFingerprint: 'bad' },
    ]) {
        writeTrust(value)
        assert.equal(new RouterConfigStore(file).router().hostKeyFingerprint, undefined)
        assert.equal(readFileSync(file, 'utf8'), original)
    }
    writeTrust(trust)
    chmodSync(companion, 0o4600)
    assert.equal(new RouterConfigStore(file).router().hostKeyFingerprint, undefined)
    chmodSync(companion, 0o600)
    writeFileSync(companion, 'x'.repeat(4097))
    assert.equal(new RouterConfigStore(file).router().hostKeyFingerprint, undefined)
    writeTrust(trust)
    writeFileSync(file, JSON.stringify({ router: { ...router, hostKeyFingerprint: 'explicit-bad' }, devices }))
    assert.equal(
        new RouterConfigStore(file).router().hostKeyFingerprint,
        'explicit-bad',
        'explicit invalid pins never fall back',
    )
    writeFileSync(file, original)
    unlinkSync(companion)
    const target = join(dir, 'trust-target.json')
    writeFileSync(target, JSON.stringify(trust), { mode: 0o600 })
    symlinkSync(target, companion)
    assert.equal(new RouterConfigStore(file).router().hostKeyFingerprint, undefined)
    assert.deepEqual(new RouterConfigStore(file).devices(), devices)
})

test('fingerprint validation rejects malformed input without altering password, intent or inventory', () => {
    const store = new RouterConfigStore(file)
    const entry = store.addDevice('192.0.2.15', 'local')
    store.setDnatDesired(entry.entryId, true)
    store.updateRouter({ host: '192.0.2.1', rethinkIp: '192.0.2.2', username: 'synthetic', password: 'synthetic' })
    const previous = store.router()
    for (const fingerprint of ['bad', 'SHA256:AAAA', `SHA256:${'A'.repeat(42)}B`]) {
        assert.throws(() => store.updateRouter({ hostKeyFingerprint: fingerprint, password: '' }), /SHA256/)
        assert.deepEqual(store.router(), previous)
        assert.equal(store.devices()[0].dnatDesired, true)
    }
})

test('saved connection settings remain distinguishable from trusted SSH readiness', () => {
    const store = new RouterConfigStore(file)
    const entry = store.addDevice('192.0.2.20')
    assert.equal(store.hasConnectionSettings(), false)
    assert.equal(store.configured(), false)
    store.updateRouter({ host: '192.0.2.1', rethinkIp: '192.0.2.2', username: 'synthetic', password: 'synthetic' })
    assert.equal(store.hasConnectionSettings(), true)
    assert.equal(store.configured(), false)
    const inventory = store.devices()
    store.recoverHostKeyFingerprint({
        hostKeyFingerprint: `SHA256:${Buffer.alloc(32, 7).toString('base64').replace(/=+$/, '')}`,
    })
    assert.equal(store.hasConnectionSettings(), true)
    assert.equal(store.configured(), true)
    assert.deepEqual(store.devices(), inventory)
    assert.equal(store.requireDevice(entry.entryId).dnatDesired, undefined)
})
