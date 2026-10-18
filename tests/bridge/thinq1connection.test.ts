import assert from 'node:assert/strict'
import { test } from 'node:test'
import type * as tls from 'node:tls'
import type fetch from 'node-fetch'
import { Connection, escapeXmlText } from '@/bridge/thinq1connection'
import { Thinq1Device } from '@/bridge/thinqApi'

function appliance() {
    return new Thinq1Device(
        'thin-q1-id',
        { modelId: 'DHUM_056905_WW', modelName: 'DHUM_056905_WW', deviceType: '403' },
        { httpServer: 'https://thin-q1.invalid', rtiServer: 'rti.invalid:47878' },
    )
}

function nextTurn() {
    return new Promise<void>((resolve) => setImmediate(resolve))
}

test('ThinQ1 bridge turns a gateway failure into an error and a reconnectable close', async () => {
    let tlsCalls = 0
    const connection = new Connection(appliance(), {
        fetch: (async () => {
            throw new Error('gateway unavailable')
        }) as typeof fetch,
        tlsConnect: (() => {
            tlsCalls++
            throw new Error('must not connect')
        }) as unknown as typeof tls.connect,
    })
    const errors: Error[] = []
    let closes = 0
    connection.on('error', (err) => errors.push(err))
    connection.on('close', () => closes++)

    await nextTurn()
    assert.equal(errors[0]?.message, 'gateway unavailable')
    assert.equal(closes, 1, 'BridgedDevice needs close in order to schedule a retry')
    assert.equal(tlsCalls, 0)
    connection.destroy()
})

test('ThinQ1 bridge rejects an unsuccessful gateway response before RTI', async () => {
    const connection = new Connection(appliance(), {
        fetch: (async () =>
            ({ ok: false, status: 503, text: async () => '' }) as Awaited<ReturnType<typeof fetch>>) as typeof fetch,
        tlsConnect: (() => {
            throw new Error('must not connect')
        }) as unknown as typeof tls.connect,
    })
    const errors: Error[] = []
    connection.on('error', (err) => errors.push(err))

    await nextTurn()
    assert.equal(errors[0]?.message, 'ThinQ1 gateway metadata request failed with HTTP 503')
    connection.destroy()
})

test('ThinQ1 bridge escapes metadata XML text', async () => {
    let body = ''
    const connection = new Connection(
        new Thinq1Device(
            'thin-q1-id',
            { modelId: 'MODEL', modelName: `A&B<"' >`, deviceType: '403' },
            { httpServer: 'https://thin-q1.invalid', rtiServer: 'rti.invalid:47878' },
        ),
        {
            fetch: (async (_url, init) => {
                body = String(init?.body)
                return { ok: false, status: 503, text: async () => '' } as Awaited<ReturnType<typeof fetch>>
            }) as typeof fetch,
            tlsConnect: (() => {
                throw new Error('must not connect')
            }) as unknown as typeof tls.connect,
        },
    )
    connection.on('error', () => {})

    await nextTurn()
    assert.match(body, /<modelName>A&amp;B&lt;&quot;&apos; &gt;<\/modelName>/)
    assert.equal(escapeXmlText(`A&B<"' >`), 'A&amp;B&lt;&quot;&apos; &gt;')
    connection.destroy()
})

test('destroying ThinQ1 bridge during its HTTP request cannot resurrect an RTI socket', async () => {
    let resolveFetch!: (response: Awaited<ReturnType<typeof fetch>>) => void
    const pending = new Promise<Awaited<ReturnType<typeof fetch>>>((resolve) => {
        resolveFetch = resolve
    })
    let tlsCalls = 0
    const connection = new Connection(appliance(), {
        fetch: (() => pending) as typeof fetch,
        tlsConnect: (() => {
            tlsCalls++
            throw new Error('must not connect after destroy')
        }) as unknown as typeof tls.connect,
    })

    connection.destroy()
    resolveFetch({ ok: true, status: 200, text: async () => '<ok />' } as Awaited<ReturnType<typeof fetch>>)
    await nextTurn()
    assert.equal(tlsCalls, 0)
})

test('ThinQ1 framing failures close only that connection once and preserve valid siblings', async () => {
    const { EventEmitter } = await import('node:events')
    const { make } = await import('@/util/length_prefixed_frame')
    function fixture() {
        const socket = Object.assign(new EventEmitter(), {
            setTimeout() {},
            write() {},
            destroy() {
                socket.emit('close')
            },
        })
        const connection = new Connection(appliance(), {
            fetch: (async () => ({ ok: true, text: async () => '' })) as unknown as typeof fetch,
            tlsConnect: (() => socket) as unknown as typeof tls.connect,
        })
        const errors: Error[] = []
        let closes = 0
        connection.on('error', (error) => errors.push(error))
        connection.on('close', () => closes++)
        return { socket, connection, errors, closes: () => closes }
    }
    const sibling = fixture()
    const received: object[] = []
    sibling.connection.on('data', (value) => received.push(value))
    await nextTurn()
    for (const invalid of [
        Buffer.from('ffffffff', 'hex'),
        Buffer.from('00010001', 'hex'),
        Buffer.from('0000000461', 'hex'),
    ]) {
        const failed = fixture()
        await nextTurn()
        assert.doesNotThrow(() => failed.socket.emit('data', invalid))
        assert.doesNotThrow(() => failed.socket.emit('end'))
        failed.socket.emit('close')
        assert.equal(failed.closes(), 1)
        assert.equal(failed.errors.length, 1)
        failed.connection.destroy()
    }
    const first = make(JSON.stringify({ Body: { Cmd: 'one', ReturnCode: '0000' } }))
    sibling.socket.emit('data', first.subarray(0, 2))
    sibling.socket.emit(
        'data',
        Buffer.concat([first.subarray(2), make(JSON.stringify({ Body: { Cmd: 'two', ReturnCode: '0000' } }))]),
    )
    assert.equal(received.length, 2)
    assert.equal(sibling.closes(), 0)
    sibling.connection.destroy()
})

test('real ThinQ1 HTTPS and RTI require a trusted certificate for the requested hostname', async () => {
    const { execFileSync } = await import('node:child_process')
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const https = await import('node:https')
    const tls = await import('node:tls')
    const { default: realFetch } = await import('node-fetch')
    const directory = mkdtempSync(join(tmpdir(), 'rethink-thinq1-tls-'))
    const keyPath = join(directory, 'key.pem'),
        certPath = join(directory, 'cert.pem')
    execFileSync(
        'openssl',
        [
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-keyout',
            keyPath,
            '-out',
            certPath,
            '-days',
            '1',
            '-subj',
            '/CN=localhost',
            '-addext',
            'subjectAltName=DNS:localhost',
        ],
        { stdio: 'ignore' },
    )
    const key = readFileSync(keyPath),
        cert = readFileSync(certPath)
    let httpData = 0,
        rtiData = 0
    const sockets = new Set<import('node:net').Socket>()
    const httpServer = https.createServer({ key, cert }, (_req, res) => {
        httpData++
        res.end('<ok />')
    })
    let firstData!: () => void
    const receivedFirstData = new Promise<void>((resolve) => {
        firstData = resolve
    })
    const rtiServer = tls.createServer({ key, cert }, (socket) =>
        socket.on('data', () => {
            rtiData++
            firstData()
        }),
    )
    for (const server of [httpServer, rtiServer]) {
        server.on('connection', (socket) => {
            sockets.add(socket)
            socket.on('close', () => sockets.delete(socket))
        })
        server.on('tlsClientError', () => {})
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    }
    const port = (server: typeof httpServer | typeof rtiServer) => {
        const address = server.address()
        assert(address && typeof address === 'object')
        return address.port
    }
    const connections: Connection[] = []
    async function attempt(httpHost: string, rtiHost: string, trusted: boolean, rtiTrusted = trusted) {
        const device = appliance()
        device.state.httpServer = `https://${httpHost}:${port(httpServer)}`
        device.state.rtiServer = `${rtiHost}:${port(rtiServer)}`
        const connection = new Connection(device, {
            fetch: (async (url, init) => {
                const original = init?.agent as import('node:https').Agent
                assert.equal(original.options.rejectUnauthorized, true)
                return realFetch(url, {
                    ...init,
                    agent: new https.Agent({
                        ...original.options,
                        ...(trusted ? { ca: cert } : {}),
                        lookup: (_name, options, done) =>
                            options.all
                                ? done(null, [{ address: '127.0.0.1', family: 4 }])
                                : done(null, '127.0.0.1', 4),
                    }),
                })
            }) as typeof fetch,
            tlsConnect: ((options: import('node:tls').ConnectionOptions, callback: () => void) => {
                assert.equal(options.rejectUnauthorized, true)
                assert.equal(options.servername, rtiHost)
                return tls.connect(
                    {
                        ...options,
                        ...(rtiTrusted ? { ca: cert } : {}),
                        lookup: (_name, options, done) =>
                            options.all
                                ? done(null, [{ address: '127.0.0.1', family: 4 }])
                                : done(null, '127.0.0.1', 4),
                    },
                    callback,
                )
            }) as typeof tls.connect,
        })
        connections.push(connection)
        return new Promise<boolean>((resolve) => {
            connection.once('connected', () => resolve(true))
            connection.on('error', () => resolve(false))
        })
    }
    try {
        assert.equal(await attempt('localhost', 'localhost', true), true)
        await receivedFirstData
        const beforeHttp = httpData,
            beforeRTI = rtiData
        assert.equal(await attempt('wrong.invalid', 'localhost', true), false)
        assert.equal(await attempt('localhost', 'localhost', false), false)
        assert.equal(httpData, beforeHttp, 'untrusted or wrong-host HTTPS must not send application data')
        assert.equal(await attempt('localhost', 'wrong.invalid', true), false)
        assert.equal(rtiData, beforeRTI, 'wrong-host RTI must not send application data')
        assert.equal(await attempt('localhost', 'localhost', true, false), false)
        assert.equal(rtiData, beforeRTI, 'untrusted RTI must not send application data')
    } finally {
        connections.forEach((connection) => {
            connection.destroy()
        })
        sockets.forEach((socket) => {
            socket.destroy()
        })
        await Promise.all(
            [httpServer, rtiServer].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
        )
        rmSync(directory, { recursive: true, force: true })
    }
})
