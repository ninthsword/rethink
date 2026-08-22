import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readServerName, matchesHostPattern } from '@/cloud/sni_router'

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
        extensions = Buffer.concat([
            Buffer.from([0x00, 0x00, list.length >> 8, list.length & 0xff]),
            list,
        ])
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
    test('a host rethink serves is handed to the local server, bytes intact', async () => {
        const { createSNIRouter } = await import('@/cloud/sni_router')
        const net = await import('node:net')
        const hello = clientHello('common.lgthinq.com')

        const handled: Buffer[] = []
        const router = createSNIRouter({
            passThrough: ['*mclip*'],
            upstreamPort: 443,
            handleLocally: (socket) => {
                socket.on('data', (chunk) => handled.push(chunk))
            },
        })
        await new Promise<void>((resolve) => router.listen(0, '127.0.0.1', resolve))
        const port = (router.address() as { port: number }).port

        const client = net.connect(port, '127.0.0.1')
        await new Promise<void>((resolve) => client.on('connect', () => resolve()))
        client.write(hello)
        await new Promise((resolve) => setTimeout(resolve, 150))

        // The local server must see the ClientHello it would have seen without any of this.
        assert.deepEqual(Buffer.concat(handled), hello, 'the peeked bytes are put back')
        client.destroy()
        router.close()
    })

    test('a host it cannot serve is never handed to the local server', async () => {
        const { createSNIRouter } = await import('@/cloud/sni_router')
        const net = await import('node:net')

        let handledLocally = false
        const router = createSNIRouter({
            passThrough: ['*mclip*'],
            // Nothing listens here; the point is only that the local server is not used.
            upstreamPort: 1,
            handleLocally: () => {
                handledLocally = true
            },
        })
        await new Promise<void>((resolve) => router.listen(0, '127.0.0.1', resolve))
        const port = (router.address() as { port: number }).port

        const client = net.connect(port, '127.0.0.1')
        await new Promise<void>((resolve) => client.on('connect', () => resolve()))
        client.on('error', () => {})
        client.write(clientHello('kic-mclip.lgthinq.com'))
        await new Promise((resolve) => setTimeout(resolve, 250))

        assert.equal(handledLocally, false, 'no certificate of ours is ever offered for it')
        client.destroy()
        router.close()
    })
})
