import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { matchesHostPattern, readServerName } from '@/cloud/sni_router'

/** A ClientHello carrying one server name, built the way a real one is laid out. */
function clientHello(serverName?: string) {
    const parts: Buffer[] = []
    parts.push(Buffer.alloc(32)) // random
    parts.push(Buffer.from([0])) // no session id
    parts.push(Buffer.from([0x00, 0x02, 0x13, 0x01])) // one cipher suite
    parts.push(Buffer.from([0x01, 0x00])) // one compression method
    let extensions = Buffer.alloc(0)
    if (serverName !== undefined) {
        const name = Buffer.from(serverName, 'ascii')
        const entry = Buffer.concat([Buffer.from([0x00]), Buffer.from([name.length >> 8, name.length & 0xff]), name])
        const list = Buffer.concat([Buffer.from([entry.length >> 8, entry.length & 0xff]), entry])
        extensions = Buffer.concat([Buffer.from([0x00, 0x00, list.length >> 8, list.length & 0xff]), list])
    }
    parts.push(Buffer.from([extensions.length >> 8, extensions.length & 0xff]), extensions)
    const body = Buffer.concat([Buffer.from([0x03, 0x03]), ...parts])
    const handshake = Buffer.concat([Buffer.from([0x01, 0, body.length >> 8, body.length & 0xff]), body])
    return Buffer.concat([Buffer.from([0x16, 0x03, 0x01, handshake.length >> 8, handshake.length & 0xff]), handshake])
}

describe('reading the host an appliance asked for', () => {
    test('the name comes out of a ClientHello', () => {
        assert.equal(readServerName(clientHello('kic-mclip.lgthinq.com')), 'kic-mclip.lgthinq.com')
        assert.equal(readServerName(clientHello('common.lgthinq.com')), 'common.lgthinq.com')
    })

    test('a hello without a name, or half a hello, yields nothing', () => {
        // Both mean "carry on as before" rather than "guess": the connection is handled
        // locally, exactly the way it was before any of this existed.
        assert.equal(readServerName(clientHello()), undefined)
        assert.equal(readServerName(clientHello('kic-mclip.lgthinq.com').subarray(0, 60)), undefined)
    })

    test('anything that is not a TLS handshake yields nothing', () => {
        assert.equal(readServerName(Buffer.from('GET / HTTP/1.1\r\n\r\n')), undefined)
        assert.equal(readServerName(Buffer.alloc(0)), undefined)
        assert.equal(readServerName(Buffer.from([0x16, 0x03, 0x01, 0xff, 0xff])), undefined)
    })
})

describe('which hosts are passed through', () => {
    test('the monitoring host is, and the ones rethink serves are not', () => {
        const passThrough = ['*mclip*']
        const passes = (host: string) => passThrough.some((p) => matchesHostPattern(host, p))

        assert.equal(passes('kic-mclip.lgthinq.com'), true)
        assert.equal(passes('eic-mclip.lgthinq.com'), true)
        assert.equal(passes('common.lgthinq.com'), false)
        assert.equal(passes('route.lgthinq.com'), false)
        assert.equal(passes('kic.lgthinq.com'), false)
    })

    test('matching ignores case and does not treat dots as wildcards', () => {
        assert.equal(matchesHostPattern('KIC-MCLIP.LGTHINQ.COM', '*mclip*'), true)
        assert.equal(matchesHostPattern('commonXlgthinq.com', 'common.lgthinq.com'), false)
    })
})

describe('routing a live connection', () => {
    /**
     * A real TLS server behind the router. The point is the handshake completing: peeking at
     * the ClientHello and then handing the socket on is only correct if the bytes are still
     * there, and a listener that merely counts them cannot tell the difference.
     */
    async function withRouter(passThrough: string[], stall: string[] = [], stallMs?: number, upstreamPort = 1) {
        const [net, tls, { execFileSync }, { mkdtempSync, readFileSync, rmSync }, { tmpdir }, { join }] =
            await Promise.all([
                import('node:net'),
                import('node:tls'),
                import('node:child_process'),
                import('node:fs'),
                import('node:os'),
                import('node:path'),
            ])
        const { createSNIRouter } = await import('@/cloud/sni_router')

        const dir = mkdtempSync(join(tmpdir(), 'rethink-sni-router-'))
        const key = join(dir, 'k.pem')
        const cert = join(dir, 'c.pem')
        execFileSync('openssl', [
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-keyout',
            key,
            '-out',
            cert,
            '-days',
            '2',
            '-subj',
            '/CN=common.lgthinq.com',
            '-addext',
            'subjectAltName=DNS:common.lgthinq.com',
        ])
        const credentials = { key: readFileSync(key, 'utf-8'), cert: readFileSync(cert, 'utf-8') }
        rmSync(dir, { recursive: true, force: true })

        const served: string[] = []
        const tlsServer = tls.createServer(credentials, (socket) => {
            // servername is set by the SNI handshake but is not in @types/node's TLSSocket;
            // cloud/rethink-cloud.ts reaches it through the same cast.
            served.push((socket as unknown as { servername?: string }).servername || '')
            socket.end('ok')
        })
        const router = createSNIRouter({
            passThrough,
            stall,
            stallMs,
            upstreamPort,
            handleLocally: (socket) => tlsServer.emit('connection', socket),
        })
        await new Promise<void>((resolve) => router.listen(0, '127.0.0.1', resolve))
        const port = (router.address() as { port: number }).port
        return { port, served, credentials, close: () => router.close(), tls, net }
    }

    test('a host rethink serves completes a handshake with it', async () => {
        const { port, served, credentials, close, tls } = await withRouter(['*mclip*'])
        const finished = await new Promise<string>((resolve) => {
            const socket = tls.connect(
                { port, host: '127.0.0.1', servername: 'common.lgthinq.com', ca: credentials.cert },
                () => {
                    let body = ''
                    socket.on('data', (chunk) => (body += chunk))
                    socket.on('end', () => resolve(body))
                },
            )
            socket.on('error', (err) => resolve(`error: ${err.message}`))
        })

        assert.equal(finished, 'ok', 'the handshake completed and the server answered')
        assert.deepEqual(served, ['common.lgthinq.com'], 'and it saw the name it was asked for')
        close()
    })

    test('a host rethink cannot serve is spliced upstream instead', async () => {
        const net = await import('node:net')

        /*
         * The upstream is a listener on loopback and the name asked for is localhost, so the
         * splice is exercised end to end without leaving the machine. Dialling the real
         * kic-mclip.lgthinq.com — which this test used to do — made the suite depend on DNS
         * and on LG answering, and cost three and a half seconds a run.
         */
        const upstream = net.createServer()
        const received: Buffer[] = []
        upstream.on('connection', (socket) => {
            socket.on('data', (chunk) => received.push(chunk))
        })
        await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
        const upstreamPort = (upstream.address() as { port: number }).port

        const { port, served, close, tls } = await withRouter(['localhost'], [], undefined, upstreamPort)
        const client = tls.connect({ port, host: '127.0.0.1', servername: 'localhost', rejectUnauthorized: false })
        client.on('error', () => {})
        await new Promise((resolve) => setTimeout(resolve, 500))

        assert.ok(received.length > 0, 'the ClientHello should have been passed upstream')
        assert.equal(received[0][0], 0x16, 'and passed on unchanged, starting with the handshake record')
        assert.deepEqual(served, [], 'the local server is never involved')

        client.destroy()
        upstream.close()
        close()
    })

    test('a stalled host is held open instead of being refused', async () => {
        // A real hold is a minute; the test only needs long enough to show that nothing
        // was offered and nothing was refused in the meantime.
        const { port, served, close, tls } = await withRouter([], ['*mclip*'], 1500)

        // Refusing is instant, and an appliance that is refused asks again a second later.
        // Held open, it waits on its own timeout instead — the only part of this exchange
        // rethink can lengthen, since it cannot produce a certificate the appliance trusts.
        let client: import('node:tls').TLSSocket | undefined
        const result = await new Promise<string>((resolve) => {
            client = tls.connect(
                { port, host: '127.0.0.1', servername: 'kic-mclip.lgthinq.com', rejectUnauthorized: false },
                () => resolve('connected'),
            )
            client.on('error', (err) => resolve(`error: ${err.message}`))
            client.on('close', () => resolve('closed'))
            setTimeout(() => resolve('still waiting'), 700)
        })

        assert.equal(result, 'still waiting', 'the connection was answered with neither a certificate nor a refusal')
        assert.deepEqual(served, [], 'and the local server was never involved')
        // The server end holds this open for a minute by design, so the test has to let go
        // of it or the run waits that minute out.
        client?.destroy()
        close()
    })
})
