import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { RouterConfigStore, type RouterDeviceEntry } from '@/router/config-store'
import { DNATReconciler, type DNATActuator } from '@/router/dnat-reconciler'
import type { DNATState } from '@/router/dnat-manager'

function makeStore() {
    const dir = mkdtempSync(path.join(tmpdir(), 'rethink-router-'))
    const store = new RouterConfigStore(path.join(dir, 'router-dnat.json'))
    store.updateRouter({ host: '192.168.1.1', port: 22, username: 'admin', password: 'x', rethinkIp: '192.168.1.2' })
    return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

class RecordingActuator implements DNATActuator {
    enabled: string[] = []
    failFor = new Set<string>()

    constructor(readonly states: Record<string, DNATState>) {}

    async status(devices: RouterDeviceEntry[]) {
        return Object.fromEntries(devices.map((device) => [device.entryId, this.states[device.entryId] ?? 'off']))
    }

    async enable(device: RouterDeviceEntry) {
        if (this.failFor.has(device.entryId)) throw new Error('router refused')
        this.enabled.push(device.entryId)
        this.states[device.entryId] = 'on'
        return 'on' as const
    }
}

describe('DNAT reconciler', () => {
    test('restores an entry the user turned on but the router has lost', async () => {
        const { store, cleanup } = makeStore()
        const lost = store.addDevice('192.168.1.10')
        const untouched = store.addDevice('192.168.1.11')
        store.setDnatDesired(lost.entryId, true)
        store.setDnatDesired(untouched.entryId, false)

        // The router rebooted, so neither rule is in place any more.
        const actuator = new RecordingActuator({ [lost.entryId]: 'off', [untouched.entryId]: 'off' })
        const result = await new DNATReconciler(store, () => actuator).reconcile()

        assert.deepEqual(result.restored, [lost.entryId])
        assert.deepEqual(actuator.enabled, [lost.entryId], 'an entry switched off must never be turned back on')
        cleanup()
    })

    test('treats a half-applied rule set as missing', async () => {
        const { store, cleanup } = makeStore()
        const entry = store.addDevice('192.168.1.10')
        store.setDnatDesired(entry.entryId, true)

        // One port forwarded is not a working appliance.
        const actuator = new RecordingActuator({ [entry.entryId]: 'partial' })
        await new DNATReconciler(store, () => actuator).reconcile()
        assert.deepEqual(actuator.enabled, [entry.entryId])
        cleanup()
    })

    test('leaves an entry alone while its rules are in place', async () => {
        const { store, cleanup } = makeStore()
        const entry = store.addDevice('192.168.1.10')
        store.setDnatDesired(entry.entryId, true)

        const actuator = new RecordingActuator({ [entry.entryId]: 'on' })
        const result = await new DNATReconciler(store, () => actuator).reconcile()
        assert.deepEqual(result.restored, [])
        assert.deepEqual(actuator.enabled, [])
        cleanup()
    })

    test('adopts rules that are already in place and then keeps them', async () => {
        const { store, cleanup } = makeStore()
        const entry = store.addDevice('192.168.1.10')

        // Entries created before the desired state was recorded carry no preference, and
        // a rule that is in place was put there deliberately.
        const actuator = new RecordingActuator({ [entry.entryId]: 'on' })
        const reconciler = new DNATReconciler(store, () => actuator)
        const first = await reconciler.reconcile()
        assert.deepEqual(first.adopted, [entry.entryId])
        assert.equal(store.requireDevice(entry.entryId).dnatDesired, true)

        actuator.states[entry.entryId] = 'off'
        const second = await reconciler.reconcile()
        assert.deepEqual(second.restored, [entry.entryId])
        cleanup()
    })

    test('adopts nothing from an off reading, which is what a rebooting router looks like', async () => {
        const { store, cleanup } = makeStore()
        const entry = store.addDevice('192.168.1.10')

        const actuator = new RecordingActuator({ [entry.entryId]: 'off' })
        const result = await new DNATReconciler(store, () => actuator).reconcile()
        assert.deepEqual(result.adopted, [])
        assert.equal(store.requireDevice(entry.entryId).dnatDesired, undefined)
        assert.deepEqual(actuator.enabled, [])
        cleanup()
    })

    test('carries on after one entry fails and survives an unreachable router', async () => {
        const { store, cleanup } = makeStore()
        const broken = store.addDevice('192.168.1.10')
        const fine = store.addDevice('192.168.1.11')
        store.setDnatDesired(broken.entryId, true)
        store.setDnatDesired(fine.entryId, true)

        const actuator = new RecordingActuator({ [broken.entryId]: 'off', [fine.entryId]: 'off' })
        actuator.failFor.add(broken.entryId)
        const result = await new DNATReconciler(store, () => actuator).reconcile()
        assert.deepEqual(result.restored, [fine.entryId])

        const unreachable: DNATActuator = {
            status: async () => {
                throw new Error('connect ETIMEDOUT')
            },
            enable: async () => {
                throw new Error('unreachable')
            },
        }
        assert.deepEqual(await new DNATReconciler(store, () => unreachable).reconcile(), {
            adopted: [],
            restored: [],
        })
        cleanup()
    })

    test('does nothing until the router is configured', async () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'rethink-router-'))
        const store = new RouterConfigStore(path.join(dir, 'router-dnat.json'))
        const entry = store.addDevice('192.168.1.10')
        store.setDnatDesired(entry.entryId, true)

        const actuator = new RecordingActuator({ [entry.entryId]: 'off' })
        await new DNATReconciler(store, () => actuator).reconcile()
        assert.deepEqual(actuator.enabled, [])
        rmSync(dir, { recursive: true, force: true })
    })
})
