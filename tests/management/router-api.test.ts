import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { RouterAPI } from '@/management/router-api'
import type { RouterDeviceEntry } from '@/router/config-store'

/**
 * The wrapper the management routes are built from. It is reached through the class
 * because the failure it handles is the one the owner actually sees on screen.
 */
function wrapped(handler: () => Promise<void>) {
    const api = Object.create(RouterAPI.prototype) as RouterAPI
    Object.assign(api, { store: { exclusive: (action: () => Promise<unknown>) => action() } })
    const wrap = (api as unknown as { wrap(h: unknown): (req: unknown, res: unknown, next: unknown) => void }).wrap
    const sent = { status: 0, type: '', body: '' }
    const res = {
        headersSent: false,
        status(code: number) {
            sent.status = code
            return res
        },
        type(value: string) {
            sent.type = value
            return res
        },
        end(body: string) {
            sent.body = body
        },
    }
    const req = { method: 'POST', originalUrl: '/api/router/devices/x/bridge/resume' }
    let passedOn = false
    wrap.call(api, async () => handler())(req, res, () => {
        passedOn = true
    })
    return { sent, passedOn: () => passedOn }
}

describe('management errors reach the page as words', () => {
    test('a failure is answered in plain text, not an HTML error page', async () => {
        // Express's own handler renders HTML with a stack trace, and the page shows whatever
        // comes back — so a failed Bridge switch put a block of markup on screen instead of
        // the reason.
        const { sent, passedOn } = wrapped(async () => {
            throw new Error('The appliance has not connected to rethink')
        })
        await new Promise((resolve) => setImmediate(resolve))

        assert.equal(sent.status, 400)
        assert.equal(sent.type, 'text/plain')
        assert.equal(sent.body, 'The appliance has not connected to rethink')
        assert.equal(passedOn(), false, 'nothing is left for Express to render')
    })

    test('something thrown without a message still says something', async () => {
        const { sent } = wrapped(async () => {
            throw new Error('')
        })
        await new Promise((resolve) => setImmediate(resolve))

        assert.equal(sent.body, 'Unexpected error')
    })
})

// Exercise the actual registered handlers with a deterministic router actuator.
async function fixture() {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { EventEmitter } = await import('node:events')
    const { Bridge } = await import('@/bridge')
    const { JSONStorage } = await import('@/bridge/state')
    const { DeviceManager } = await import('@/cloud/devmgr')
    const { DNATManager } = await import('@/router/dnat-manager')
    const { mock } = await import('node:test')
    const dir = mkdtempSync(`${tmpdir()}/rethink-api-`)
    const manager = new DeviceManager()
    const bridge = new Bridge(new JSONStorage(dir), manager)
    const ha = { HA: new EventEmitter(), haDevices: new Map() } as unknown as import('@/cloud/ha_bridge').default
    const api = new RouterAPI(`${dir}/router.json`, ha, manager, bridge)
    api.reconciler.stop()
    let enabled = false
    const events: string[] = []
    const status = mock.method(DNATManager.prototype, 'status', async (entries: RouterDeviceEntry[]) =>
        Object.fromEntries(entries.map((entry: { entryId: string }) => [entry.entryId, enabled ? 'on' : 'off'])),
    )
    const enable = mock.method(DNATManager.prototype, 'enable', async () => {
        events.push('enable')
        enabled = true
        return 'on' as const
    })
    const disable = mock.method(DNATManager.prototype, 'disable', async () => {
        events.push('disable')
        enabled = false
        return 'off' as const
    })
    type Handler = (req: unknown, res: unknown, next: (error: unknown) => void) => void
    const handlers = new Map<string, Handler>()
    const host = Object.fromEntries(
        ['get', 'post', 'put', 'delete'].map((method) => [
            method,
            (url: string, handler: Handler) => handlers.set(`${method} ${url}`, handler),
        ]),
    )
    api.register(host as unknown as import('websocket-express').WebSocketExpress)
    const call = (method: string, url: string, entryId?: string, body: object = {}) =>
        new Promise<{ status: number; body: unknown }>((resolve, reject) => {
            let code = 200
            const res = {
                headersSent: false,
                status(value: number) {
                    code = value
                    return res
                },
                type() {
                    return res
                },
                json(value: unknown) {
                    resolve({ status: code, body: value })
                    return res
                },
                end(value?: unknown) {
                    resolve({ status: code, body: value })
                    return res
                },
            }
            const handler = handlers.get(`${method} ${url}`)
            assert(handler)
            handler({ params: { entryId }, body, method, originalUrl: url }, res, reject)
        })
    return {
        api,
        bridge,
        events,
        enable,
        disable,
        call,
        configured() {
            api.store.updateRouter({
                host: '192.0.2.1',
                rethinkIp: '192.0.2.2',
                username: 'synthetic',
                password: 'synthetic',
            })
        },
        cleanup() {
            status.mock.restore()
            enable.mock.restore()
            disable.mock.restore()
            rmSync(dir, { recursive: true, force: true })
        },
    }
}

test('DNAT guards both router Bridge switches and credential deletion, while Local resume needs no SSH', async () => {
    const f = await fixture()
    try {
        const entry = f.api.store.addDevice('192.0.2.20')
        f.api.store.linkDevice(entry.entryId, 'synthetic')
        f.bridge.state.setDeviceState('synthetic', { httpServer: 'https://cloud.example', rtiServer: 'rti.example:1' })
        for (const action of ['resume', 'suspend']) {
            const result = await f.call('post', `/api/router/devices/:entryId/bridge/${action}`, entry.entryId)
            assert.equal(result.status, 409)
            assert.match(String(result.body), /DNAT control/)
        }
        assert.equal(
            (await f.call('delete', '/api/router/devices/:entryId/bridge/credentials', entry.entryId)).status,
            409,
        )
        f.api.store.updateDevice(entry.entryId, { mode: 'local' })
        const result = await f.call('post', '/api/router/devices/:entryId/bridge/resume', entry.entryId)
        assert.equal(result.status, 200)
        assert.equal(f.bridge.wanted('synthetic'), true)
        assert.deepEqual(f.events, [])
    } finally {
        f.cleanup()
    }
})

test('router enable and disable serialize router action before intent; release latch blocks periodic reapplication', async () => {
    const f = await fixture()
    try {
        f.configured()
        const entry = f.api.store.addDevice('192.0.2.20')
        let finish!: () => void
        f.enable.mock.mockImplementation(async () => {
            await new Promise<void>((resolve) => {
                finish = resolve
            })
            f.events.push('enable')
            return 'on' as const
        })
        const on = f.call('post', '/api/router/devices/:entryId/dnat/enable', entry.entryId)
        await new Promise<void>((resolve) => setImmediate(resolve))
        assert.equal(f.api.store.requireDevice(entry.entryId).dnatDesired, undefined)
        const off = f.call('post', '/api/router/devices/:entryId/dnat/disable', entry.entryId)
        finish()
        assert.equal((await on).status, 200)
        assert.equal((await off).status, 200)
        assert.deepEqual(f.events, ['enable', 'disable'])
        assert.equal(f.api.store.requireDevice(entry.entryId).dnatDesired, false)
        f.api.store.setDnatDesired(entry.entryId, true)
        assert.equal((await f.call('post', '/api/router/dnat/release')).status, 200)
        assert.equal(f.api.store.requireDevice(entry.entryId).dnatDesired, true)
        const before = f.events.length
        await f.api.reconciler.reconcile()
        assert.equal(f.events.length, before)
        assert(f.api.store.released.has(entry.entryId))
    } finally {
        f.cleanup()
    }
})

test('failed router enable does not commit intent and mode change never pairs', async () => {
    const f = await fixture()
    try {
        f.configured()
        const entry = f.api.store.addDevice('192.0.2.20')
        f.enable.mock.mockImplementation(async () => {
            throw new Error('SSH failed')
        })
        const result = await f.call('post', '/api/router/devices/:entryId/dnat/enable', entry.entryId)
        assert.equal(result.status, 400)
        assert.equal(f.api.store.requireDevice(entry.entryId).dnatDesired, undefined)
        const changed = await f.call('put', '/api/router/devices/:entryId', entry.entryId, {
            mode: 'local',
            modeTransition: { from: 'dnat', to: 'local', acknowledged: true },
        })
        assert.equal(changed.status, 200)
        assert.equal(f.api.store.requireDevice(entry.entryId).mode, 'local')
        assert.deepEqual(f.events, [])
    } finally {
        f.cleanup()
    }
})

test('a partial maintenance release fails visibly and latches entries against reconciliation', async () => {
    const f = await fixture()
    try {
        f.configured()
        const entry = f.api.store.addDevice('192.0.2.20')
        f.api.store.setDnatDesired(entry.entryId, true)
        f.disable.mock.mockImplementation(async () => {
            throw new Error('Partial router release failure')
        })
        const result = await f.call('post', '/api/router/dnat/release')
        assert.equal(result.status, 400)
        assert.match(String(result.body), /Partial router release failure/)
        assert(f.api.store.released.has(entry.entryId))
        await f.api.reconciler.reconcile()
        assert.equal(f.enable.mock.callCount(), 0)
        assert.equal(f.api.store.requireDevice(entry.entryId).dnatDesired, true)
    } finally {
        f.cleanup()
    }
})

for (const [from, to] of [
    ['dnat', 'local'],
    ['local', 'dnat'],
] as const) {
    test(`${from} → ${to} requires exact explicit acknowledgment; ordinary edits remain compatible`, async () => {
        const f = await fixture()
        try {
            f.configured()
            const entry = f.api.store.addDevice('192.0.2.20', from)
            for (const modeTransition of [
                undefined,
                null,
                [],
                {},
                { from, to, acknowledged: false },
                { from, to, acknowledged: 'true' },
                { from: to, to, acknowledged: true },
                { from, to: from, acknowledged: true },
            ]) {
                const result = await f.call('put', '/api/router/devices/:entryId', entry.entryId, {
                    mode: to,
                    modeTransition,
                })
                assert.equal(result.status, 409)
                assert.match(String(result.body), /explicitly approve/)
                assert.equal(f.api.store.requireDevice(entry.entryId).mode, from)
            }
            for (const body of [
                { customName: 'Display name' },
                { mode: from },
                { mode: from, modeTransition: { from: to, to: from, acknowledged: false } },
            ]) {
                assert.equal((await f.call('put', '/api/router/devices/:entryId', entry.entryId, body)).status, 200)
            }
            assert.equal(f.api.store.requireDevice(entry.entryId).customName, 'Display name')
            const approval = { mode: to, modeTransition: { from, to, acknowledged: true } }
            f.api.store.setDnatDesired(entry.entryId, true)
            const blocked = await f.call('put', '/api/router/devices/:entryId', entry.entryId, approval)
            assert.equal(blocked.status, 409)
            assert.match(String(blocked.body), /Turn DNAT off/)
            assert.equal(f.api.store.requireDevice(entry.entryId).mode, from)
            f.api.store.setDnatDesired(entry.entryId, false)
            const result = await f.call('put', '/api/router/devices/:entryId', entry.entryId, approval)
            assert.equal(result.status, 200)
            assert.equal(f.api.store.requireDevice(entry.entryId).mode, to)
            assert.equal(
                'modeTransition' in f.api.store.requireDevice(entry.entryId),
                false,
                'acknowledgment is not physical completion metadata',
            )
            assert.deepEqual(f.events, [], 'saving policy does not actuate DNAT or enroll an appliance')
        } finally {
            f.cleanup()
        }
    })
}

test('mode acknowledgment is validated after earlier queued mutations, against the current entry', async () => {
    const f = await fixture()
    try {
        f.configured()
        const entry = f.api.store.addDevice('192.0.2.20', 'dnat')
        let finish!: () => void
        const earlier = f.api.store.exclusive(async () => {
            await new Promise<void>((resolve) => {
                finish = resolve
            })
            f.api.store.updateDevice(entry.entryId, { mode: 'local' })
        })
        await new Promise<void>((resolve) => setImmediate(resolve))
        const pending = f.call('put', '/api/router/devices/:entryId', entry.entryId, {
            mode: 'dnat',
            modeTransition: { from: 'dnat', to: 'dnat', acknowledged: true },
        })
        finish()
        await earlier
        const result = await pending
        assert.equal(result.status, 409)
        assert.equal(f.api.store.requireDevice(entry.entryId).mode, 'local')
    } finally {
        f.cleanup()
    }
})
