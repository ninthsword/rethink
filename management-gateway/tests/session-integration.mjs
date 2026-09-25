import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { tmpdir } from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import WebSocket, { WebSocketServer } from 'ws'
import { createService, safeReturn } from '../session-proxy/service.mjs'
import { createAuthority, SESSION_LIMIT, SESSION_MS, WARNING_MS } from '../session-proxy/session-store.mjs'

process.umask(0o077)
const here = path.dirname(fileURLToPath(import.meta.url))
const save = (authority, id) =>
    new Promise((done, reject) =>
        authority.store.set(id, { cookie: { maxAge: SESSION_MS }, authenticated: true }, (error) =>
            error ? reject(error) : done(),
        ),
    )
class HeldSocket extends EventEmitter {
    destroyed = false
    destroy() {
        this.destroyed = true
        this.emit('close')
    }
}

test('600s authority, 540s warning, no touch extension, generation race, expiry and stale saves', async () => {
    assert.equal(SESSION_MS, 600_000)
    assert.equal(WARNING_MS, 60_000)
    assert.equal(SESSION_LIMIT, 64)
    let now = 0
    const timers = []
    const authority = createAuthority({
        now: () => now,
        wall: () => 1000 + now,
        schedule: (callback) => {
            timers.push(callback)
            return 1
        },
        cancel() {},
    })
    try {
        authority.grant('a', 'host')
        await save(authority, 'a')
        const socket = new HeldSocket()
        authority.attach('a', socket)
        now = 539_999
        assert.equal(authority.view('a').remainingMs, 60_001)
        now = 540_000
        assert.equal(authority.view('a').remainingMs, WARNING_MS)
        await new Promise((done) => authority.store.touch('a', { cookie: { maxAge: 9999999 } }, done))
        assert.equal(authority.view('a').expiresAt, 601000)
        const generation = authority.view('a').generation
        const outcomes = await Promise.all(
            [1, 2].map(() => Promise.resolve().then(() => authority.extend('a', generation, 'host'))),
        )
        assert.equal(outcomes.filter(Boolean).length, 1)
        assert.equal(authority.view('a').remainingMs, 600000)
        timers[0]()
        assert(authority.active('a'), 'An old timer must re-read the current deadline')
        now += 600000
        assert.equal(authority.extend('a', generation + 1, 'host'), undefined)
        assert(socket.destroyed)
        await save(authority, 'a')
        assert.equal(await new Promise((done) => authority.store.get('a', (_error, value) => done(value))), undefined)
    } finally {
        authority.close()
    }
})

test('capacity disposal, host binding, logout and close revoke both socket directions without resurrection', async () => {
    const authority = createAuthority()
    try {
        authority.grant('first', 'one')
        await save(authority, 'first')
        const client = new HeldSocket(),
            upstream = new HeldSocket()
        authority.attach('first', client)
        authority.attach('first', upstream)
        assert.equal(authority.active('first', 'other'), undefined)
        for (let i = 0; i < 64; i++) {
            authority.grant(String(i), 'one')
            await save(authority, String(i))
        }
        assert(client.destroyed && upstream.destroyed)
        assert.equal(authority.active('first'), undefined)
        authority.revoke('63')
        await save(authority, '63')
        assert.equal(authority.active('63'), undefined)
        const remaining = new HeldSocket()
        authority.attach('62', remaining)
        authority.close()
        assert(remaining.destroyed)
    } finally {
        authority.close()
    }
    for (const value of [
        '//foreign.test',
        '/\\foreign.test',
        'https://foreign.test',
        '/__management/login',
        '/a\nheader',
    ]) {
        assert.equal(safeReturn(value), '/')
    }
    for (let code = 0; code <= 0x20; code++) {
        assert.equal(safeReturn(`/a${String.fromCharCode(code)}b`), '/')
    }
    assert.equal(safeReturn('/monitor?id=synthetic'), '/monitor?id=synthetic')
})

function request(options, body) {
    return new Promise((resolve, reject) => {
        const client = (options.port ? https : http).request(options, (response) => {
            const chunks = []
            response.on('data', (chunk) => chunks.push(chunk))
            response.on('end', () =>
                resolve({
                    status: response.statusCode,
                    headers: response.headers,
                    body: Buffer.concat(chunks).toString(),
                }),
            )
        })
        client.on('error', reject)
        if (body) client.write(body)
        client.end()
    })
}

test('real Unix service rejects fixation and spoofing; pending and established upgrades revoke on expiry', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'rethink-session-unit-'))
    const sockets = path.join(directory, 'sockets')
    await mkdir(sockets, { mode: 0o700 })
    const verifier = http.createServer((req, res) =>
        res
            .writeHead(
                req.headers.authorization === `Basic ${Buffer.from('admin:synthetic-password').toString('base64')}`
                    ? 200
                    : 401,
            )
            .end(),
    )
    const verifierPath = path.join(sockets, 'verifier.sock')
    await new Promise((done) => verifier.listen(verifierPath, done))
    const seen = [],
        upstreams = new Set()
    const backend = http.createServer((req, res) => {
        seen.push(req.headers)
        res.end('synthetic')
    })
    const ws = new WebSocketServer({ noServer: true })
    let release
    backend.on('upgrade', (req, socket, head) => {
        upstreams.add(socket)
        socket.on('close', () => upstreams.delete(socket))
        const accept = () =>
            ws.handleUpgrade(req, socket, head, (connection) =>
                connection.on('message', (data) => connection.send(data)),
            )
        if (req.url === '/pending') release = accept
        else accept()
    })
    await new Promise((done) => backend.listen(0, '127.0.0.1', done))
    let now = 0
    const authority = createAuthority({ now: () => now, max: 2 })
    const socketPath = path.join(sockets, 'session.sock')
    const service = createService({
        socketPath,
        verifierPath,
        hosts: { 'fixture.test': 'https://fixture.test' },
        backend: `http://127.0.0.1:${backend.address().port}`,
        authority,
    })
    await service.listen()
    const call = (route, body, cookie, headers = {}) =>
        request(
            {
                socketPath,
                path: route,
                method: body ? 'POST' : 'GET',
                headers: {
                    Host: 'fixture.test',
                    Origin: 'https://fixture.test',
                    'Content-Type': 'application/json',
                    ...(cookie ? { Cookie: cookie } : {}),
                    ...headers,
                },
            },
            body ? JSON.stringify(body) : undefined,
        )
    try {
        assert.equal((await call('/api/private')).status, 401)
        assert.equal(seen.length, 0)
        assert.equal((await call('/__management/session', undefined, undefined, { Host: 'evil.test' })).status, 421)
        assert.equal(
            (await call('/__management/login', { username: 'wrong', password: 'synthetic-password' })).status,
            401,
        )
        assert.equal((await call('/__management/login', { username: 'admin', password: 'wrong' })).status, 401)
        const result = await call(
            '/__management/login',
            { username: 'admin', password: 'synthetic-password' },
            '__Host-rethink-session=attacker',
        )
        assert.equal(result.status, 200)
        const setCookie = result.headers['set-cookie'][0]
        for (const flag of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/']) assert(setCookie.includes(flag))
        assert(!setCookie.includes('Domain=') && !setCookie.includes('attacker'))
        const cookie = setCookie.split(';')[0]
        const initial = JSON.parse((await call('/__management/session', undefined, cookie)).body)
        now = 540000
        const read = await call('/api/private', undefined, `${cookie}; application=preserved`, {
            Authorization: 'Basic attacker',
            Forwarded: 'for=evil',
            'X-Forwarded-For': 'evil',
            'X-Forwarded-Proto': 'http',
        })
        assert.equal(read.status, 200)
        assert.equal(read.headers['set-cookie'], undefined)
        assert.equal(seen.at(-1).authorization, undefined)
        assert.equal(seen.at(-1)['x-forwarded-for'], undefined)
        assert.equal(seen.at(-1).cookie, 'application=preserved')
        assert.equal(
            JSON.parse((await call('/__management/session', undefined, cookie)).body).expiresAt,
            initial.expiresAt,
        )
        // Cookie serialization uses the real wall clock and whole-second Expires values.
        await new Promise((done) => setTimeout(done, 1100))
        const renewed = await call('/__management/extend', { generation: initial.generation }, cookie)
        assert.equal(renewed.status, 200)
        const renewedHeader = renewed.headers['set-cookie']?.[0]
        assert(renewedHeader, 'Successful explicit renewal must emit Set-Cookie')
        assert(renewedHeader.split(';')[0] === cookie, 'Renewal retains the legitimate signed session')
        for (const flag of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/']) assert(renewedHeader.includes(flag))
        assert(!renewedHeader.includes('Domain='))
        const renewedView = JSON.parse(renewed.body)
        const renewedExpiry = Date.parse(/Expires=([^;]+)/.exec(renewedHeader)[1])
        assert(renewedExpiry > initial.expiresAt)
        assert(Math.abs(renewedExpiry - renewedView.expiresAt) < 1000)
        for (const [body, headers, status] of [
            [{ generation: initial.generation }, {}, 409],
            [{ generation: 'invalid' }, {}, 409],
            [{ generation: renewedView.generation }, { Origin: 'https://foreign.test' }, 403],
        ]) {
            const denied = await call('/__management/extend', body, cookie, headers)
            assert.equal(denied.status, status)
            assert.equal(denied.headers['set-cookie'], undefined)
        }
        now = 600001
        for (const route of ['/api/private', '/__management/session']) {
            const passive = await call(route, undefined, cookie)
            assert.equal(passive.status, 200, 'Renewed session survives its original deadline')
            assert.equal(passive.headers['set-cookie'], undefined)
            if (route.endsWith('/session')) assert.equal(JSON.parse(passive.body).expiresAt, renewedView.expiresAt)
        }
        const connect = (route, signedCookie = cookie) =>
            new WebSocket(`ws+unix://${socketPath}:${route}`, {
                headers: { Host: 'fixture.test', Origin: 'https://fixture.test', Cookie: signedCookie },
            })
        const established = connect('/ws')
        await new Promise((done, reject) => {
            established.once('open', done)
            established.once('error', reject)
        })
        const pending = connect('/pending')
        pending.on('error', () => {})
        for (let i = 0; i < 100 && !release; i++) await new Promise((done) => setTimeout(done, 10))
        assert(release)
        const closed = new Promise((done) => established.once('close', done))
        now = 1140000
        assert.equal((await call('/__management/session', undefined, cookie)).status, 401)
        release()
        await closed
        for (let i = 0; i < 100 && upstreams.size; i++) await new Promise((done) => setTimeout(done, 10))
        assert.equal(upstreams.size, 0, 'Pending and established upstream sockets must close')
        assert.equal((await call('/__management/extend', { generation: 1 }, cookie)).status, 401)
        const signIn = async () =>
            (await call('/__management/login', { username: 'admin', password: 'synthetic-password' })).headers[
                'set-cookie'
            ][0].split(';')[0]
        const pair = async (signedCookie) => {
            const sockets = ['/ws', '/device?id=synthetic'].map((route) => connect(route, signedCookie))
            await Promise.all(
                sockets.map(
                    (socket) =>
                        new Promise((done, reject) => {
                            socket.once('open', done)
                            socket.once('error', reject)
                        }),
                ),
            )
            return {
                sockets,
                closed: Promise.all(sockets.map((socket) => new Promise((done) => socket.once('close', done)))),
            }
        }
        const logoutCookie = await signIn()
        const logoutPair = await pair(logoutCookie)
        await call('/__management/logout', {}, logoutCookie)
        await logoutPair.closed
        const evictedCookie = await signIn()
        const evictedPair = await pair(evictedCookie)
        await signIn()
        await signIn()
        await evictedPair.closed
        assert.equal((await call('/api/private', undefined, evictedCookie)).status, 401)
        const exitCookie = await signIn()
        const exitPair = await pair(exitCookie)
        await service.close()
        await exitPair.closed
    } finally {
        await service.close()
        ws.close()
        for (const socket of upstreams) socket.destroy()
        await Promise.all([new Promise((done) => verifier.close(done)), new Promise((done) => backend.close(done))])
        await rm(directory, { recursive: true })
    }
})

export async function gatewayFixture(mode = '--fixture-session') {
    const child = spawn(process.env.PYTHON_BIN || 'python3', ['-B', path.join(here, 'integration.py'), mode], {
        stdio: ['pipe', 'pipe', 'inherit'],
    })
    const exit = new Promise((done, reject) => {
        child.once('error', reject)
        child.once('exit', (code) => done(code))
    })
    const lines = readline.createInterface({ input: child.stdout })
    const next = () =>
        Promise.race([
            new Promise((done) => lines.once('line', (line) => done(JSON.parse(line)))),
            exit.then(() => {
                throw new Error('Fixture exited before reply')
            }),
        ])
    const metadata = await next()
    return {
        metadata,
        async command(command) {
            const reply = next()
            child.stdin.write(command + '\n')
            return reply
        },
        async close() {
            child.stdin.end()
            const code = await exit
            assert.equal(code, 0)
            lines.close()
        },
    }
}

test('actual nginx hash verifier and migrated cookie perimeter isolate the synthetic backend', async () => {
    const fixture = await gatewayFixture()
    const f = fixture.metadata
    const ca = await readFile(f.ca)
    const call = (route, body, cookie, extra = {}) =>
        request(
            {
                hostname: '127.0.0.1',
                port: Number(new URL(f.origin).port),
                ca,
                path: route,
                method: body ? 'POST' : 'GET',
                headers: {
                    Origin: f.origin,
                    'Content-Type': 'application/json',
                    ...(cookie ? { Cookie: cookie } : {}),
                    ...extra,
                },
            },
            body ? JSON.stringify(body) : undefined,
        )
    try {
        const unauth = await call('/api/private')
        assert.equal(unauth.status, 401)
        assert.equal(unauth.headers['www-authenticate'], undefined)
        assert.equal((await call('/verify')).status, 401)
        assert.equal((await call('/__management/unknown')).status, 404)
        assert.equal((await call('/__management/login', { username: 'not-admin', password: f.password })).status, 401)
        assert.equal((await call('/__management/login', { username: 'admin', password: 'wrong' })).status, 401)
        assert.equal((await call('/__management/login', { username: 'admin', password: 'x'.repeat(5000) })).status, 400)
        const signed = await call('/__management/login', {
            username: 'admin',
            password: f.password,
            returnTo: '//foreign.test',
        })
        assert.equal(signed.status, 200)
        assert.equal(JSON.parse(signed.body).returnTo, '/')
        const cookie = signed.headers['set-cookie'][0].split(';')[0]
        const proxied = await call('/api/private', undefined, cookie)
        assert.equal(proxied.status, 200)
        assert.equal(JSON.parse(proxied.body).headers.host, new URL(f.origin).host)
        assert.equal((await call('/api/write', {}, cookie, { Origin: 'https://foreign.test' })).status, 403)
        assert.equal((await call('/api/private', undefined, undefined, { Authorization: f.basic })).status, 401)
        const renewed = await call('/__management/extend', { generation: 1 }, cookie)
        assert.equal(renewed.status, 200)
        assert.equal((await call('/__management/extend', { generation: 1 }, cookie)).status, 409)
        await call('/__management/logout', {}, cookie)
        assert.equal((await call('/api/private', undefined, cookie)).status, 401)
        const afterLogout = await call('/__management/login', { username: 'admin', password: f.password })
        const old = afterLogout.headers['set-cookie'][0].split(';')[0]
        const held = ['/ws', '/device?id=synthetic'].map(
            (route) =>
                new WebSocket(f.origin.replace('https:', 'wss:') + route, {
                    ca,
                    headers: { Cookie: old, Origin: f.origin },
                }),
        )
        await Promise.all(
            held.map(
                (socket) =>
                    new Promise((done, reject) => {
                        socket.once('open', done)
                        socket.once('error', reject)
                    }),
            ),
        )
        const closed = Promise.all(held.map((socket) => new Promise((done) => socket.once('close', done))))
        await fixture.command('rotate')
        await closed
        assert.equal((await call('/api/private', undefined, old)).status, 401)
        const summary = await fixture.command('summary')
        assert(summary.accountPreservedUntilRotation && summary.mountBoundary && summary.backendAlive)
    } finally {
        await fixture.close()
    }
})
