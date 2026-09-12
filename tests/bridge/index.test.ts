import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { mock, test } from 'node:test'
import { Bridge } from '@/bridge'
import { BridgePolicy } from '@/bridge/policy'
import { JSONStorage } from '@/bridge/state'
import { Connection } from '@/bridge/thinq1connection'
import { Thinq1Device } from '@/bridge/thinqApi'
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
