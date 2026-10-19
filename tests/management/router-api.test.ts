import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { RouterAPI } from '@/management/router-api'
import type { RouterConfigStore, RouterDeviceEntry } from '@/router/config-store'

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
        status,
        call,
        configured() {
            api.store.updateRouter({
                host: '192.0.2.1',
                rethinkIp: '192.0.2.2',
                username: 'synthetic',
                password: 'synthetic',
                hostKeyFingerprint: `SHA256:${Buffer.alloc(32, 2).toString('base64').replace(/=+$/, '')}`,
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

// Use the actual JSON/HTTP consumer and synthetic SSH server; never execute router commands.
async function recoveryFixture(existingPin?: string, legacyOnly = false) {
    const { createHash, generateKeyPairSync } = await import('node:crypto')
    const { EventEmitter } = await import('node:events')
    const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { WebSocketExpress } = await import('websocket-express')
    const { default: ssh2 } = await import('ssh2')
    const { DeviceManager } = await import('@/cloud/devmgr')
    const { RouterConfigStore } = await import('@/router/config-store')
    const directory = mkdtempSync(`${tmpdir()}/rethink-pin-recovery-`)
    const filename = `${directory}/router.json`
    const { privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    const key = Buffer.from(privateKey)
    const fingerprint = `SHA256:${createHash('sha256').update(ssh2.utils.parseKey(key).getPublicSSH()).digest('base64').replace(/=+$/, '')}`
    const observed = { connections: 0, authenticationAttempts: 0, commands: [] as string[], ruleExitCode: 0 }
    const peers = new Set<{ end(): void }>()
    const ssh = new ssh2.Server({ hostKeys: [key] }, (client) => {
        observed.connections++
        peers.add(client)
        client.on('error', () => {})
        client.on('close', () => peers.delete(client))
        client.on(
            'authentication',
            (context: { method: string; username: string; password: string; accept(): void; reject(): void }) => {
                observed.authenticationAttempts++
                if (
                    context.method === 'password' &&
                    context.username === 'synthetic' &&
                    context.password === 'retained-password'
                )
                    context.accept()
                else context.reject()
            },
        )
        client.on('ready', () => {
            client.on('session', (accept: () => InstanceType<typeof EventEmitter>) => {
                const session = accept()
                session.on(
                    'exec',
                    (
                        accept: () => { write(text: string): void; exit(code: number): void; end(): void },
                        _reject: () => void,
                        info: { command: string },
                    ) => {
                        observed.commands.push(info.command)
                        const channel = accept()
                        channel.write('synthetic tool version\n')
                        channel.exit(
                            info.command.startsWith('/usr/sbin/iptables -t nat -C ') ? observed.ruleExitCode : 0,
                        )
                        channel.end()
                    },
                )
            })
        })
    })
    await new Promise<void>((resolve) => ssh.listen(0, '127.0.0.1', resolve))
    const sshAddress = ssh.address()
    assert(sshAddress && typeof sshAddress === 'object')
    const legacy = {
        router: {
            host: '127.0.0.1',
            port: sshAddress.port,
            username: 'synthetic',
            password: 'retained-password',
            rethinkIp: '192.0.2.2',
            ...(existingPin === undefined ? {} : { hostKeyFingerprint: existingPin }),
        },
        devices: [
            {
                entryId: 'active',
                ip: '192.0.2.20',
                deviceId: 'saved-device',
                customName: 'Saved name',
                platform: 'thinq2',
                dnatDesired: true,
            },
            { entryId: 'local', ip: '192.0.2.21', mode: 'local', autoLink: false, dnatDesired: false },
            { entryId: 'legacy', ip: '192.0.2.22' },
        ],
    }
    if (legacyOnly) legacy.devices = legacy.devices.filter((entry) => entry.entryId === 'legacy')
    writeFileSync(filename, JSON.stringify(legacy), { mode: 0o600 })
    const manager = new DeviceManager()
    const ha = { HA: new EventEmitter(), haDevices: new Map() } as unknown as import('@/cloud/ha_bridge').default
    const api = new RouterAPI(filename, ha, manager, undefined)
    api.reconciler.stop()
    const app = new WebSocketExpress()
    app.use(WebSocketExpress.json())
    api.register(app)
    const server = app.createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert(address && typeof address === 'object')
    const call = async (body: unknown, route = '/api/router/config', method = 'PUT') => {
        const response = await fetch(`http://127.0.0.1:${address.port}${route}`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        })
        return { status: response.status, text: await response.text() }
    }
    const form = { ...legacy.router, password: '', hostKeyFingerprint: fingerprint }
    return {
        api,
        call,
        fingerprint,
        form,
        legacy,
        observed,
        bytes: () => readFileSync(filename),
        reload: () => new RouterConfigStore(filename),
        blockSave: () => mkdirSync(`${filename}.tmp`),
        unblockSave: () => rmSync(`${filename}.tmp`, { recursive: true }),
        async cleanup() {
            server.closeAllConnections()
            await new Promise<void>((resolve) => server.close(() => resolve()))
            peers.forEach((peer) => {
                peer.end()
            })
            await new Promise<void>((resolve) => ssh.close(() => resolve()))
            rmSync(directory, { recursive: true, force: true })
        },
    }
}

test('actual full settings form repairs only missing trust with active DNAT and retains saved state', async () => {
    const f = await recoveryFixture()
    try {
        assert.equal(f.api.store.configured(), false)
        const original = f.bytes()
        const otherPin = `SHA256:${Buffer.alloc(32, 3).toString('base64').replace(/=+$/, '')}`
        for (const changes of [
            { host: '127.0.0.2' },
            { port: f.form.port + 1 },
            { username: 'changed' },
            { rethinkIp: '192.0.2.3' },
            { password: 'retained-password' },
            { password: 'changed' },
            { password: null },
            { port: String(f.form.port) },
            { extra: true },
            { devices: [] },
            { hostKeyFingerprint: '' },
            { hostKeyFingerprint: 'SHA256:bad' },
            { hostKeyFingerprint: null },
            { host: null },
        ]) {
            const rejected = await f.call({ ...f.form, ...changes })
            assert.equal(rejected.status, 409, JSON.stringify(changes))
            assert.deepEqual(f.bytes(), original)
            assert.equal(f.api.store.configured(), false)
        }
        assert.equal(f.observed.connections, 0, 'rejected recovery never contacts SSH')
        const saved = await f.call(f.form)
        assert.equal(saved.status, 200, saved.text)
        assert.equal(JSON.parse(saved.text).password, undefined)
        assert.equal(JSON.parse(saved.text).passwordSaved, true)
        assert.equal(f.observed.connections, 0, 'saving trust must not query or change DNAT')
        assert.deepEqual(f.observed.commands, [])
        assert.deepEqual(JSON.parse(f.bytes().toString()), {
            ...f.legacy,
            router: { ...f.legacy.router, hostKeyFingerprint: f.fingerprint },
        })
        const reloaded = f.reload()
        assert.equal(reloaded.configured(), true)
        assert.deepEqual(reloaded.devices(), f.legacy.devices)
        assert.equal(reloaded.router().password, f.legacy.router.password)
        const stable = f.bytes()
        for (const hostKeyFingerprint of [f.fingerprint, otherPin, '']) {
            assert.equal((await f.call({ ...f.form, hostKeyFingerprint })).status, 409)
            assert.deepEqual(f.bytes(), stable)
        }
        assert.equal(f.observed.connections, 0, 'existing-pin updates still obey the active DNAT guard')
        const checked = await f.call({}, '/api/router/test', 'POST')
        assert.equal(checked.status, 200, checked.text)
        assert(f.observed.authenticationAttempts > 0)
        assert.deepEqual(f.observed.commands, ['/usr/sbin/iptables --version', '/usr/sbin/conntrack -V'])
    } finally {
        await f.cleanup()
    }
})

test('missing trust recovery with an incorrect pin saves no credentials to the synthetic SSH server', async () => {
    const f = await recoveryFixture('')
    try {
        const wrongPin = `SHA256:${Buffer.alloc(32, 4).toString('base64').replace(/=+$/, '')}`
        // Omitted unchanged fields and password are also supported.
        const result = await f.call({ hostKeyFingerprint: wrongPin })
        assert.equal(result.status, 200, result.text)
        assert.equal(f.observed.connections, 0)
        assert.equal((await f.call({}, '/api/router/test', 'POST')).status, 400)
        assert.equal(f.observed.authenticationAttempts, 0)
        assert.deepEqual(f.observed.commands, [])
        assert.deepEqual(f.reload().devices(), f.legacy.devices)
        assert.equal(f.reload().router().password, f.legacy.router.password)
    } finally {
        await f.cleanup()
    }
})

test('failed recovery persistence rolls back memory and disk, then the same queued HTTP consumer can retry', async () => {
    const f = await recoveryFixture()
    try {
        const original = f.bytes()
        const router = f.api.store.router()
        f.blockSave()
        assert.equal((await f.call(f.form)).status, 400)
        assert.deepEqual(f.api.store.router(), router)
        assert.deepEqual(f.api.store.devices(), f.legacy.devices)
        assert.deepEqual(f.bytes(), original)
        assert.equal(f.reload().configured(), false)
        assert.equal(f.observed.connections, 0)
        f.unblockSave()
        assert.equal((await f.call(f.form)).status, 200)
        assert.equal(f.reload().configured(), true)
        assert.deepEqual(f.reload().devices(), f.legacy.devices)
        assert.equal(f.observed.connections, 0)
    } finally {
        await f.cleanup()
    }
})

test('concurrent full-form recovery validates the current pin only after the existing exclusive queue', async (t) => {
    const f = await recoveryFixture()
    let release!: () => void
    try {
        const earlier = f.api.store.exclusive(
            async () =>
                new Promise<void>((resolve) => {
                    release = resolve
                }),
        )
        await new Promise<void>((resolve) => setImmediate(resolve))
        const exclusive = f.api.store.exclusive
        let queued = 0
        let firstQueued!: () => void, secondQueued!: () => void
        const firstReady = new Promise<void>((resolve) => {
            firstQueued = resolve
        })
        const secondReady = new Promise<void>((resolve) => {
            secondQueued = resolve
        })
        t.mock.method(f.api.store, 'exclusive', function <T>(this: RouterConfigStore, action: () => Promise<T>) {
            const result = exclusive.call(this, action)
            if (++queued === 1) firstQueued()
            else secondQueued()
            return result
        })
        const first = f.call(f.form)
        await firstReady
        const second = f.call({
            ...f.form,
            hostKeyFingerprint: `SHA256:${Buffer.alloc(32, 5).toString('base64').replace(/=+$/, '')}`,
        })
        await secondReady
        assert.equal(f.api.store.configured(), false)
        assert.equal(f.observed.connections, 0)
        release()
        await earlier
        assert.equal((await first).status, 200)
        assert.equal((await second).status, 409)
        assert.equal(f.reload().router().hostKeyFingerprint, f.fingerprint)
        assert.deepEqual(f.reload().devices(), f.legacy.devices)
        assert.equal(f.observed.connections, 0)
    } finally {
        release?.()
        await f.cleanup()
    }
})

for (const existingPin of ['malformed', `SHA256:${Buffer.alloc(32, 6).toString('base64').replace(/=+$/, '')}`]) {
    test(`active DNAT cannot replace an existing ${existingPin === 'malformed' ? 'malformed' : 'valid'} pin`, async () => {
        const f = await recoveryFixture(existingPin)
        try {
            const original = f.bytes()
            assert.equal((await f.call(f.form)).status, 409)
            assert.deepEqual(f.bytes(), original)
            assert.equal(f.api.store.router().hostKeyFingerprint, existingPin)
            assert.equal(f.observed.connections, 0)
        } finally {
            await f.cleanup()
        }
    })
}

test('a legacy-only DNAT inventory preserves untrusted saved settings until pin recovery and verified rule release', async () => {
    const f = await recoveryFixture(undefined, true)
    try {
        assert.deepEqual(f.legacy.devices, [{ entryId: 'legacy', ip: '192.0.2.22' }])
        const original = f.bytes(),
            router = f.api.store.router()
        for (const changes of [
            { host: '127.0.0.2' },
            { rethinkIp: '192.0.2.3' },
            { port: f.form.port + 1 },
            { username: 'changed' },
            { password: 'changed' },
        ]) {
            const rejected = await f.call({ ...f.form, ...changes })
            assert.equal(rejected.status, 409)
            assert.match(rejected.text, /SSH 호스트 키 지문/)
            assert.deepEqual(f.bytes(), original)
            assert.deepEqual(f.api.store.router(), router)
            assert.deepEqual(f.api.store.devices(), f.legacy.devices)
        }
        assert.equal(f.observed.connections, 0)
        assert.equal(f.observed.commands.length, 0)
        const recovered = await f.call(f.form)
        assert.equal(recovered.status, 200, recovered.text)
        assert.equal(f.observed.connections, 0, 'pin-only recovery must not query or change DNAT')
        assert.deepEqual(f.reload().devices(), f.legacy.devices)
        const trusted = f.bytes(),
            trustedRouter = f.api.store.router()
        const targetChange = { ...f.form, rethinkIp: '192.0.2.3' }
        const active = await f.call(targetChange)
        assert.equal(active.status, 409, active.text)
        assert.match(active.text, /Release all existing DNAT rules/)
        assert(f.observed.authenticationAttempts > 0)
        assert.deepEqual(f.bytes(), trusted)
        assert.deepEqual(f.api.store.router(), trustedRouter)
        assert.deepEqual(f.api.store.devices(), f.legacy.devices)
        assert(f.observed.commands.length > 0)
        assert(f.observed.commands.every((command) => command.startsWith('/usr/sbin/iptables -t nat -C ')))
        f.observed.ruleExitCode = 1
        const off = await f.call(targetChange)
        assert.equal(off.status, 200, off.text)
        assert.equal(f.reload().router().rethinkIp, '192.0.2.3')
        assert.equal(f.reload().router().password, f.legacy.router.password)
        assert.deepEqual(f.reload().devices(), f.legacy.devices)
        assert(f.observed.commands.every((command) => command.startsWith('/usr/sbin/iptables -t nat -C ')))
    } finally {
        await f.cleanup()
    }
})

test('initial setup and untrusted Local-only settings remain editable without SSH', async () => {
    const f = await fixture()
    try {
        const entry = f.api.store.addDevice('192.0.2.20')
        const initial = { host: '192.0.2.1', rethinkIp: '192.0.2.2', username: 'synthetic', password: 'synthetic' }
        assert.equal(f.api.store.hasConnectionSettings(), false)
        assert.equal((await f.call('put', '/api/router/config', undefined, initial)).status, 200)
        assert.equal(f.api.store.hasConnectionSettings(), true)
        assert.equal(f.api.store.configured(), false)
        f.api.store.updateDevice(entry.entryId, { mode: 'local' })
        const updated = await f.call('put', '/api/router/config', undefined, { ...initial, rethinkIp: '192.0.2.3' })
        assert.equal(updated.status, 200)
        assert.equal(f.api.store.router().rethinkIp, '192.0.2.3')
        assert.equal(f.status.mock.callCount(), 0)
        assert.deepEqual(f.events, [])
    } finally {
        f.cleanup()
    }
})
