import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { BridgePolicy } from '@/bridge/policy'
import type { AnyDevice } from '@/cloud/devmgr'
import { RouterConfigStore } from '@/router/config-store'

test('legacy entries default to DNAT, unlinked appliances to Local, without rewriting the file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rethink-policy-'))
    try {
        const store = new RouterConfigStore(path.join(dir, 'router.json'))
        const entry = store.addDevice('192.0.2.20')
        store.linkDevice(entry.entryId, 'linked')
        const before = readFileSync(store.filename)
        const policy = new BridgePolicy(new RouterConfigStore(store.filename))
        assert.equal(policy.mode('linked'), 'dnat')
        assert.equal(policy.mode('unlinked'), 'local')
        assert.equal(policy.forwarding('linked'), false)
        assert.deepEqual(readFileSync(store.filename), before)
        store.setDnatDesired(entry.entryId, true)
        const active = new BridgePolicy(store)
        assert.equal(active.forwarding('linked'), true)
        store.released.add(entry.entryId)
        assert.equal(active.mode('linked'), 'dnat')
        assert.equal(active.forwarding('linked'), false)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('startup source-IP match applies policy before asynchronous router linkage', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rethink-policy-'))
    try {
        const store = new RouterConfigStore(path.join(dir, 'router.json'))
        store.addDevice('192.0.2.20')
        const policy = new BridgePolicy(store)
        const device = { id: 'new', sourceIp: '192.0.2.20' } as AnyDevice
        assert.equal(policy.mode(device.id, device), 'dnat')
        assert.equal(policy.forwarding(device.id, device), false)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})
