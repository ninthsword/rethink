import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { mock, type TestContext, test } from 'node:test'
import fetch from 'node-fetch'
import { Bridge } from '@/bridge'
import { BridgePolicy } from '@/bridge/policy'
import { JSONStorage } from '@/bridge/state'
import { Connection } from '@/bridge/thinq1connection'
import { Thinq1Device, Client as ThinqClient } from '@/bridge/thinqApi'
import { DeviceManager } from '@/cloud/devmgr'
import type { Connection as LocalConnection } from '@/cloud/thinq1/connection'
import { Device } from '@/cloud/thinq1/device'
import { RouterConfigStore } from '@/router/config-store'

const saved = { httpServer: 'https://cloud.example', rtiServer: 'rti.example:1234' }
function fixture() {
    const dir = mkdtempSync(path.join(tmpdir(), 'rethink-lifecycle-'))
    const state = new JSONStorage(dir)
    const manager = new DeviceManager()
    const store = new RouterConfigStore(path.join(dir, 'router.json'))
    const commands: unknown[] = []
    const con = Object.assign(new EventEmitter(), { json: (body: unknown) => commands.push(body) })
    const dev = new Device(con as unknown as LocalConnection, 'synthetic', {
        modelId: 'model',
        modelName: 'model',
        deviceType: '401',
    })
    const start = mock.method(Connection.prototype, 'start', async () => {})
    const bridge = new Bridge(state, manager, { policy: new BridgePolicy(store) })
    const registration = mock.method(bridge, 'register', async () => new Thinq1Device(dev.id, dev.meta, saved))
    return {
        dir,
        state,
        manager,
        store,
        dev,
        con,
        commands,
        bridge,
        registration,
        close() {
            bridge.disable(dev.id)
            start.mock.restore()
            rmSync(dir, { recursive: true, force: true })
        },
    }
}

test('disable preserves registration bytes and remains disabled across reconnect and restart; enable does not pair', async () => {
    const f = fixture()
    try {
        f.state.setDeviceState(f.dev.id, saved)
        const bytes = readFileSync(f.state.devicePath(f.dev.id))
        f.manager.accept(f.dev)
        assert.equal(f.bridge.status(f.dev.id), true)
        assert.equal(f.bridge.details(f.dev.id).cloudConnected, false)
        f.bridge.disable(f.dev.id)
        assert.deepEqual(readFileSync(f.state.devicePath(f.dev.id)), bytes)
        assert.equal(new JSONStorage(f.dir).getEnabled(f.dev.id), false)
        f.dev.emit('close')
        f.manager.accept(f.dev)
        assert.equal(f.bridge.status(f.dev.id), false)
        await f.bridge.enable(f.dev.id)
        assert.equal(f.bridge.status(f.dev.id), true)
        assert.equal(f.registration.mock.callCount(), 0)
        await f.bridge.enable(f.dev.id)
        assert.equal(f.dev.listenerCount('data'), 1)
    } finally {
        f.close()
    }
})

test('missing saved state never pairs at startup or enable, and explicit renewal retains previous bytes on failure', async () => {
    const f = fixture()
    try {
        f.manager.accept(f.dev)
        await assert.rejects(f.bridge.enable(f.dev.id), /Registration required/)
        assert.equal(f.registration.mock.callCount(), 0)
        assert.equal(f.bridge.details(f.dev.id).setupRequired, true)
        await f.bridge.renew(f.dev.id)
        assert.deepEqual(f.state.getDeviceState(f.dev.id), saved)
        const bytes = readFileSync(f.state.devicePath(f.dev.id))
        f.registration.mock.mockImplementation(async () => {
            throw new Error('pair failed')
        })
        await assert.rejects(f.bridge.renew(f.dev.id), /pair failed/)
        assert.deepEqual(readFileSync(f.state.devicePath(f.dev.id)), bytes)
        // A rejection must not poison the per-device queue.
        await f.bridge.enable(f.dev.id)
        assert.equal(f.bridge.status(f.dev.id), true)
    } finally {
        f.close()
    }
})

test('device replacement or disable invalidates delayed renewal before persistence and attachment', async () => {
    const f = fixture()
    try {
        f.state.setDeviceState(f.dev.id, saved)
        f.manager.accept(f.dev)
        let finish!: (device: Thinq1Device) => void
        f.registration.mock.mockImplementation(
            async () =>
                new Promise<Thinq1Device>((resolve) => {
                    finish = resolve
                }),
        )
        const pending = f.bridge.renew(f.dev.id)
        await new Promise<void>((resolve) => setImmediate(resolve))
        f.bridge.disable(f.dev.id)
        finish(new Thinq1Device(f.dev.id, f.dev.meta, { ...saved, rtiServer: 'replacement.example:1' }))
        await assert.rejects(pending, /changed during registration/)
        assert.deepEqual(f.state.getDeviceState(f.dev.id), saved)
        assert.equal(f.bridge.status(f.dev.id), false)
    } finally {
        f.close()
    }
})

test('DNAT starts from shared policy, pauses on release, resumes saved material without independent switches', async () => {
    const f = fixture()
    try {
        f.state.setDeviceState(f.dev.id, saved)
        const entry = f.store.addDevice('192.0.2.20')
        f.store.linkDevice(entry.entryId, f.dev.id)
        f.manager.accept(f.dev)
        assert.equal(f.bridge.status(f.dev.id), false)
        f.store.setDnatDesired(entry.entryId, true)
        await f.bridge.reconcile(f.dev.id)
        assert.equal(f.bridge.status(f.dev.id), true)
        await assert.rejects(f.bridge.enable(f.dev.id), /DNAT control/)
        f.store.released.add(entry.entryId)
        await f.bridge.reconcile(f.dev.id)
        assert.equal(f.bridge.status(f.dev.id), false)
        assert.equal(f.bridge.mode(f.dev.id), 'dnat')
        f.store.released.delete(entry.entryId)
        await f.bridge.reconcile(f.dev.id)
        assert.equal(f.bridge.status(f.dev.id), true)
        assert.equal(f.registration.mock.callCount(), 0)
    } finally {
        f.close()
    }
})

test('synthetic cloud DNS/TLS failures and bridge reconnect preserve local telemetry and command delivery', async () => {
    const f = fixture()
    try {
        const reports: Buffer[] = []
        f.dev.on('data', (packet) => reports.push(packet))
        f.state.setDeviceState(f.dev.id, saved)
        f.manager.accept(f.dev)
        const active = f.bridge.bridgedDevices.get(f.dev.id)
        assert(active)
        const connection = active.connection as Connection
        connection.emit('connected')
        assert.equal(f.bridge.details(f.dev.id).cloudConnected, true)
        connection.emit('error', new Error('synthetic DNS/TLS failure'))
        connection.emit('close')
        assert.equal(f.bridge.details(f.dev.id).cloudConnected, false)
        f.con.emit('status', Buffer.from([1]))
        f.dev.send({ command: 'local-ha' })
        assert.equal(reports.length, 1)
        assert.equal(f.commands.length, 1)
        active.reconnectNow()
        const replacement = active.connection as Connection
        replacement.emit('connected')
        connection.emit('close')
        connection.emit('error', new Error('late old error'))
        connection.emit('data', { command: 'stale-cloud-command' })
        assert.equal(active.connection, replacement)
        assert.equal(active.connected, true)
        assert.equal(f.commands.length, 1)
        f.con.emit('status', Buffer.from([2]))
        assert.equal(reports.length, 2)
        assert.equal(f.dev.listenerCount('data'), 2, 'one local observer and one bridge observer')
        f.bridge.disable(f.dev.id)
        f.con.emit('status', Buffer.from([3]))
        f.dev.send({ command: 'local-ha' })
        assert.equal(reports.length, 3)
        assert.equal(f.commands.length, 2)
        assert.equal(active.reconnectTimeout, undefined)
    } finally {
        f.close()
    }
})

for (const desired of [true, false]) {
    test(`fresh DNAT startup with desired=${desired} uses DNAT intent despite persisted Local off`, () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'rethink-fresh-mode-'))
        const start = mock.method(Connection.prototype, 'start', async () => {})
        const register = mock.method(Bridge.prototype, 'register', async () => {
            throw new Error('Automatic pairing forbidden')
        })
        const manager = new DeviceManager()
        try {
            const state = new JSONStorage(dir)
            state.setDeviceState('synthetic', saved)
            state.setEnabled('synthetic', false)
            const store = new RouterConfigStore(path.join(dir, 'router.json'))
            const entry = store.addDevice('192.0.2.20', 'dnat')
            store.linkDevice(entry.entryId, 'synthetic')
            store.setDnatDesired(entry.entryId, desired)
            const bytes = readFileSync(state.devicePath('synthetic'))
            const con = Object.assign(new EventEmitter(), { json() {} })
            const device = new Device(con as unknown as LocalConnection, 'synthetic', {
                modelId: 'model',
                modelName: 'model',
                deviceType: '401',
            })
            manager.accept(device)
            // Both stores are freshly reloaded, and the device exists before subscription.
            const bridge = new Bridge(new JSONStorage(dir), manager, {
                policy: new BridgePolicy(new RouterConfigStore(store.filename)),
            })
            assert.equal(bridge.mode(device.id), 'dnat')
            assert.equal(bridge.status(device.id), desired)
            assert.equal(bridge.wanted(device.id), desired)
            assert.equal(state.getEnabled(device.id), false)
            assert.deepEqual(readFileSync(state.devicePath(device.id)), bytes)
            assert.equal(register.mock.callCount(), 0)
            assert.equal(start.mock.callCount(), desired ? 1 : 0)
            device.emit('close')
        } finally {
            start.mock.restore()
            register.mock.restore()
            rmSync(dir, { recursive: true, force: true })
        }
    })
}

const NAME_ID = 'synthetic-ac'
const COUNTRY = 'ZZ'
const settle = () => new Promise((resolve) => setImmediate(resolve))

/** A bridge's names with LG stubbed out: any real request fails the test. */
function namesFixture(t: TestContext, stored: string | undefined = '안방', credentials = true) {
    const requests: unknown[] = []
    const refuse = (url: unknown) => {
        requests.push(url)
        throw new Error('network is not available to this test')
    }
    t.mock.method(https, 'request', refuse as never)
    t.mock.method(http, 'request', refuse as never)

    // The Client constructor fetches LG's gateway unless this is already cached.
    const previousGateway = ThinqClient.gatewayCache[COUNTRY]
    ThinqClient.gatewayCache[COUNTRY] = Promise.resolve({}) as never

    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)

    const dir = mkdtempSync(path.join(tmpdir(), 'rethink-names-'))
    const state = new JSONStorage(dir)
    if (credentials) state.setCredentials({ refreshToken: 'synthetic-token', env: { countryCode: COUNTRY } })
    if (stored) state.setDeviceNames(new Map([[NAME_ID, stored]]))

    t.mock.method(ThinqClient.prototype, 'auth', async () => undefined as never)
    const listDevices = t.mock.method(
        ThinqClient.prototype,
        'listDevices',
        async () => [{ deviceId: NAME_ID, alias: '거실' }] as never,
    )
    const warn = t.mock.method(console, 'warn', () => {})

    t.after(async () => {
        await settle()
        process.off('unhandledRejection', onUnhandled)
        if (previousGateway === undefined) delete ThinqClient.gatewayCache[COUNTRY]
        else ThinqClient.gatewayCache[COUNTRY] = previousGateway
        rmSync(dir, { recursive: true, force: true })
        assert.deepEqual(requests, [], 'a test reached for the network')
        assert.deepEqual(unhandled, [])
    })

    return { state, manager: new DeviceManager(), listDevices, warn, requests }
}

function deferredDevices() {
    let resolve: (devices: never) => void = () => {}
    const devices = new Promise<never>((done) => {
        resolve = done
    })
    return { devices, finish: () => resolve([{ deviceId: NAME_ID, alias: '거실' }] as never) }
}

const storedNames = (state: JSONStorage) => [...state.getDeviceNames()]

test('the network guard catches the fetch LG requests are made with', async (t) => {
    const f = namesFixture(t)
    await assert.rejects(fetch('https://lg.invalid/'))
    assert.equal(f.requests.length, 1)
    f.requests.length = 0
})

test('stored names answer from construction, before any device starts', async (t) => {
    const f = namesFixture(t)
    const order: string[] = []
    const getDeviceNames = f.state.getDeviceNames.bind(f.state)
    t.mock.method(f.state, 'getDeviceNames', () => {
        order.push('names')
        return getDeviceNames()
    })
    t.mock.method(f.state, 'getEnabled', () => {
        order.push('start')
        return false
    })
    f.manager.allDevices.set('existing', { id: 'existing' } as never)

    const bridge = new Bridge(f.state, f.manager)

    assert.equal(bridge.name(NAME_ID), '안방')
    assert.deepEqual(order, ['names', 'start'])
    await settle()
})

test('a successful refresh replaces the stored names', async (t) => {
    const f = namesFixture(t)
    f.state.setDeviceNames(
        new Map([
            [NAME_ID, '안방'],
            ['gone-id', '사라짐'],
        ]),
    )
    const bridge = new Bridge(f.state, f.manager)
    await settle()

    assert.equal(bridge.name(NAME_ID), '거실')
    assert.deepEqual(storedNames(f.state), [[NAME_ID, '거실']])
})

test('a failed refresh leaves memory and storage as they were', async (t) => {
    const f = namesFixture(t)
    f.listDevices.mock.mockImplementation(async () => {
        throw new Error('synthetic LG failure')
    })
    const bridge = new Bridge(f.state, f.manager)
    await settle()

    assert.equal(bridge.name(NAME_ID), '안방')
    assert.deepEqual(storedNames(f.state), [[NAME_ID, '안방']])
})

test('logging out clears memory and storage', async (t) => {
    const f = namesFixture(t)
    const bridge = new Bridge(f.state, f.manager)
    await settle()

    bridge.logout()

    assert.equal(bridge.name(NAME_ID), undefined)
    assert.deepEqual(storedNames(f.state), [])
})

test('starting with no credentials clears memory and storage', async (t) => {
    const f = namesFixture(t, '안방', false)
    const bridge = new Bridge(f.state, f.manager)
    await settle()

    assert.equal(bridge.name(NAME_ID), undefined)
    assert.deepEqual(storedNames(f.state), [])
    assert.equal(f.listDevices.mock.callCount(), 0)
})

test('a refresh finishing after a logout stores nothing', async (t) => {
    const f = namesFixture(t)
    const { devices, finish } = deferredDevices()
    f.listDevices.mock.mockImplementation(async () => devices)
    const bridge = new Bridge(f.state, f.manager)
    await settle()

    bridge.logout()
    finish()
    await settle()

    assert.equal(bridge.name(NAME_ID), undefined)
    assert.deepEqual(storedNames(f.state), [])
})

test('a refresh finishing after the token changed stores nothing', async (t) => {
    const f = namesFixture(t)
    const { devices, finish } = deferredDevices()
    f.listDevices.mock.mockImplementation(async () => devices)
    const bridge = new Bridge(f.state, f.manager)
    await settle()

    f.state.setCredentials({ refreshToken: 'another-token', env: { countryCode: COUNTRY } })
    finish()
    await settle()

    assert.equal(bridge.name(NAME_ID), '안방')
    assert.deepEqual(storedNames(f.state), [[NAME_ID, '안방']])
})

test('a failed store on refresh keeps the fresh names and does not log them', async (t) => {
    const f = namesFixture(t)
    t.mock.method(f.state, 'setDeviceNames', () => {
        throw new Error('synthetic ENOSPC')
    })
    const bridge = new Bridge(f.state, f.manager)
    let changed = 0
    bridge.on('deviceNamesChanged', () => changed++)
    await settle()

    assert.equal(bridge.name(NAME_ID), '거실')
    assert.equal(changed, 1)
    assert.equal(f.warn.mock.callCount(), 1)
    assert.equal(JSON.stringify(f.warn.mock.calls[0].arguments.map(String)).includes('거실'), false)
})

test('a failed store on logout still clears memory and finishes the logout', async (t) => {
    const f = namesFixture(t)
    const bridge = new Bridge(f.state, f.manager)
    await settle()
    t.mock.method(f.state, 'setDeviceNames', () => {
        throw new Error('synthetic ENOSPC')
    })
    const events: string[] = []
    bridge.on('deviceNamesChanged', () => events.push('names'))
    bridge.on('loggedOut', () => events.push('loggedOut'))

    bridge.logout()

    assert.equal(bridge.name(NAME_ID), undefined)
    assert.deepEqual(events, ['names', 'loggedOut'])
})
