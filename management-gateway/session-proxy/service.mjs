import { randomBytes } from 'node:crypto'
import { chmodSync, lstatSync, readFileSync } from 'node:fs'
import http from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import session from 'express-session'
import { createProxyServer, proxyUpgrade } from 'httpxy'
import { createAuthority, SESSION_MS } from './session-store.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const COOKIE = '__Host-rethink-session'
const PREFIX = '/__management'
const cookieOptions = { secure: true, httpOnly: true, sameSite: 'strict', path: '/' }
export function safeReturn(value) {
    return typeof value === 'string' &&
        value.startsWith('/') &&
        !value.startsWith('//') &&
        ![...value].some((character) => character === '\\' || character.charCodeAt(0) <= 0x20) &&
        !value.startsWith(PREFIX)
        ? value
        : '/'
}
function verifyPassword(socketPath, password) {
    return new Promise((resolveResult) => {
        const request = http.request(
            {
                socketPath,
                path: '/verify',
                method: 'GET',
                headers: { Authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}` },
                timeout: 5000,
            },
            (response) => {
                response.resume()
                resolveResult(response.statusCode === 200)
            },
        )
        request.on('timeout', () => request.destroy())
        request.on('error', () => resolveResult(false))
        request.end()
    })
}
function stripHeaders(request) {
    for (const name of Object.keys(request.headers)) {
        if (
            name === 'authorization' ||
            name === 'proxy-authorization' ||
            name === 'forwarded' ||
            name === 'x-real-ip' ||
            name.startsWith('x-forwarded-') ||
            name.startsWith('x-management-')
        ) {
            delete request.headers[name]
        }
    }
    const cookies = (request.headers.cookie ?? '').split(';').filter((item) => item.trim().split('=')[0] !== COOKIE)
    if (cookies.some((item) => item.trim())) request.headers.cookie = cookies.join(';')
    else delete request.headers.cookie
}
// Only tests may supply a synthetic backend/clock through this in-process factory.
// The executable accepts a private settings file and always uses the fixed production backend.
export function createService({
    socketPath,
    verifierPath,
    hosts,
    backend = 'http://127.0.0.1:44401',
    authority = createAuthority(),
    assetRoot = here,
}) {
    if (!socketPath.startsWith('/') || !verifierPath.startsWith('/') || !hosts || !Object.keys(hosts).length) {
        throw new Error('Invalid private socket settings')
    }
    const app = express()
    app.disable('x-powered-by')
    app.set('trust proxy', false)
    const sessions = session({
        name: COOKIE,
        secret: randomBytes(48).toString('base64url'),
        store: authority.store,
        resave: false,
        saveUninitialized: false,
        rolling: false,
        proxy: true,
        cookie: { ...cookieOptions, maxAge: SESSION_MS },
    })
    function perimeter(request, response, next) {
        const host = request.headers.host
        const origin = Object.hasOwn(hosts, host) ? hosts[host] : undefined
        if (!origin) return response.status(421).end()
        if (
            (request.headers.origin && request.headers.origin !== origin) ||
            (!['GET', 'HEAD'].includes(request.method) && request.headers.origin !== origin) ||
            (request.headers.upgrade && request.headers.origin !== origin)
        )
            return response.status(403).end()
        // The only listener is the owner-only Unix socket. Never trust incoming proxy metadata.
        request.headers['x-forwarded-proto'] = 'https'
        response.setHeader('Cache-Control', 'no-store')
        next()
    }
    app.use(perimeter)
    app.use(sessions)
    app.use(`${PREFIX}/`, express.json({ limit: '4kb', strict: true, type: () => true }))
    const assets = new Map([
        ['login', ['login.html', 'html']],
        ['login.js', ['login.js', 'js']],
        ['login.css', ['login.css', 'css']],
        ['ui.js', ['ui.js', 'js']],
        ['ui.css', ['ui.css', 'css']],
    ])
    for (const [route, [file, type]] of assets) {
        app.get(`${PREFIX}/${route}`, (_request, response) => response.type(type).sendFile(resolve(assetRoot, file)))
    }
    let attempts = []
    app.post(`${PREFIX}/login`, async (request, response) => {
        const time = performance.now()
        attempts = attempts.filter((attempt) => time - attempt < 60_000)
        if (attempts.length >= 10) return response.status(429).json({ error: 'Login unavailable. Try again later.' })
        attempts.push(time)
        const password = request.body?.password
        if (
            request.body?.username !== 'admin' ||
            typeof password !== 'string' ||
            password.length > 1024 ||
            !password.length ||
            !(await verifyPassword(verifierPath, password))
        ) {
            return response.status(401).json({ error: 'Unable to sign in.' })
        }
        const oldId = request.sessionID
        authority.revoke(oldId)
        request.session.regenerate((error) => {
            if (error) return response.status(503).end()
            const record = authority.grant(request.sessionID, request.headers.host)
            request.session.authenticated = true
            request.session.cookie.expires = new Date(record.expiresAt)
            request.session.save((saveError) => {
                if (saveError || !authority.active(request.sessionID)) {
                    authority.revoke(request.sessionID)
                    return response.status(503).end()
                }
                response.json({ ...authority.view(request.sessionID), returnTo: safeReturn(request.body?.returnTo) })
            })
        })
    })
    app.get(`${PREFIX}/session`, (request, response) => {
        const view = authority.view(request.sessionID, request.headers.host)
        response.status(view ? 200 : 401).json(view ?? { authenticated: false })
    })
    app.post(`${PREFIX}/extend`, (request, response) => {
        const record = authority.extend(request.sessionID, request.body?.generation, request.headers.host)
        if (!record) return response.status(authority.active(request.sessionID) ? 409 : 401).end()
        // express-session excludes cookie fields from its modification hash when rolling is false.
        request.session.renewalGeneration = record.generation
        request.session.cookie.expires = new Date(record.expiresAt)
        request.session.save((error) => {
            if (error || !authority.active(request.sessionID)) return response.status(401).end()
            response.json(authority.view(request.sessionID, request.headers.host))
        })
    })
    app.post(`${PREFIX}/logout`, (request, response) => {
        authority.revoke(request.sessionID)
        request.session.destroy(() => {
            response.clearCookie(COOKIE, cookieOptions).status(204).end()
        })
    })
    app.use(PREFIX, (_request, response) => response.status(404).end())
    const proxy = createProxyServer({ target: backend, xfwd: false })
    app.use((request, response) => {
        if (!authority.active(request.sessionID, request.headers.host)) {
            if (request.method === 'GET' && request.headers.accept?.includes('text/html')) {
                return response.redirect(303, `${PREFIX}/login?returnTo=${encodeURIComponent(safeReturn(request.url))}`)
            }
            return response.status(401).end()
        }
        stripHeaders(request)
        proxy.web(request, response, { xfwd: false }).catch(() => {
            if (!response.headersSent) response.status(502).end()
            else response.destroy()
        })
    })
    app.use((_error, _request, response, _next) => response.status(400).json({ error: 'Invalid request.' }))
    const server = http.createServer(app)
    server.on('upgrade', (request, socket, head) => {
        const response = new http.ServerResponse(request)
        response.assignSocket(socket)
        perimeter(request, response, () =>
            sessions(request, response, async () => {
                if (request.url.startsWith(PREFIX) || !authority.active(request.sessionID, request.headers.host)) {
                    response.writeHead(401).end()
                    return
                }
                // Track the pending client before awaiting the upstream handshake. Revocation also
                // destroys an upstream which resolves after the client/session has disappeared.
                if (!authority.attach(request.sessionID, socket)) return
                response.detachSocket(socket)
                stripHeaders(request)
                try {
                    const upstream = await proxyUpgrade(backend, request, socket, head, { xfwd: false })
                    if (socket.destroyed || !authority.attach(request.sessionID, upstream)) upstream.destroy()
                } catch {
                    socket.destroy()
                }
            }),
        )
    })
    return {
        server,
        authority,
        async listen() {
            const parent = lstatSync(dirname(socketPath))
            if (!parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o777) !== 0o700) {
                throw new Error('Unsafe socket directory')
            }
            await new Promise((resolveListen, reject) => {
                server.once('error', reject)
                server.listen(socketPath, resolveListen)
            })
            chmodSync(socketPath, 0o600)
        },
        async close() {
            authority.close()
            server.closeAllConnections()
            await new Promise((done) => server.close(done))
        },
    }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const settings = JSON.parse(readFileSync('/settings/session.json', 'utf8'))
    if (Object.keys(settings).sort().join(',') !== 'hosts') throw new Error('Invalid session settings')
    const service = createService({
        socketPath: '/sockets/session.sock',
        verifierPath: '/sockets/verifier.sock',
        hosts: settings.hosts,
    })
    await service.listen()
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => service.close().then(() => process.exit(0)))
}
