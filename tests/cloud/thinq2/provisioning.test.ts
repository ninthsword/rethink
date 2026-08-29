import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, test } from 'node:test'
import express from 'express'
import { routes } from '@/cloud/thinq2/provisioning'
import type { CA, Config } from '@/util/config'

const CA_STUB = { key: '', cert: '' } as CA
const BASE = {
    hostname: 'rethink.lan',
    https_port: { advertise: 443 },
    mqtts_port: { advertise: 8883 },
} as unknown as Config

class FakeCertificateProcess extends EventEmitter {
    readonly stdout = new PassThrough()
    readonly stderr = new PassThrough()
    readonly stdin = new PassThrough()
    killed = false

    kill() {
        this.killed = true
        this.emit('close', null)
        return true
    }
}

/** Call GET /route against the real router and return what it answered. */
async function route(config: Config) {
    const app = express()
    app.use(routes(config, CA_STUB))
    const server = app.listen(0)
    try {
        const { port } = server.address() as { port: number }
        const response = await fetch(`http://127.0.0.1:${port}/route`)
        return (await response.json()) as { result: { apiServer: string; mqttServer: string } }
    } finally {
        server.close()
        server.closeAllConnections()
    }
}

function certificate(spawnCertificate: unknown, deviceId = 'device-id', csr?: unknown) {
    const router = routes(BASE, CA_STUB, spawnCertificate as never)
    const stack = (
        router as unknown as {
            stack: Array<{
                route?: { path: string; stack: Array<{ handle: (req: unknown, res: unknown) => unknown }> }
            }>
        }
    ).stack
    const layer = stack.find((item) => item.route?.path === '/device/:deviceId/certificate')
    assert.ok(layer?.route)
    const handle = layer.route.stack[0].handle

    return new Promise<{ status: number; body: string }>((resolve) => {
        let status = 200
        const response = {
            status(code: number) {
                status = code
                return response
            },
            end() {
                resolve({ status, body: '' })
            },
            json(body: unknown) {
                resolve({ status, body: JSON.stringify(body) })
            },
        }
        handle({ params: { deviceId }, body: { csr } }, response)
    })
}

describe('what /route tells an appliance its servers are', () => {
    test('by default rethink names itself', async () => {
        // Which is right when the appliance was pointed at rethink deliberately and that
        // name was made to resolve — the setup the original documents.
        const answered = await route(BASE)
        assert.equal(answered.result.apiServer, 'https://rethink.lan:443')
        assert.equal(answered.result.mqttServer, 'ssl://rethink.lan:8883')
    })

    test('configured servers are handed back verbatim', async () => {
        // Where a firewall rule does the redirecting, rethink's own name was never published
        // and an appliance told to use it is left with an address that does not exist: it
        // stops dialling and only a power cycle brings it back. Its factory addresses
        // resolve, and the firewall rule goes on redirecting them.
        const answered = await route({
            ...BASE,
            route_servers: {
                apiServer: 'https://kic-common.lgthinq.com:443',
                mqttServer: 'ssl://common.iot.kic.lgthinq.com:8883',
            },
        } as Config)

        assert.equal(answered.result.apiServer, 'https://kic-common.lgthinq.com:443')
        assert.equal(answered.result.mqttServer, 'ssl://common.iot.kic.lgthinq.com:8883')
        assert.ok(!JSON.stringify(answered).includes('rethink.lan'), 'nothing of rethink leaks in')
    })
})

describe('certificate generation input and process boundaries', () => {
    test('rejects invalid device ids and CSRs before spawning openssl', async () => {
        let calls = 0
        const spawnCertificate = () => {
            calls++
            return new FakeCertificateProcess() as never
        }

        for (const deviceId of ['id/child', 'id+wildcard', 'id#wildcard', 'id with space', 'x'.repeat(129)]) {
            const result = await certificate(spawnCertificate, deviceId)
            assert.equal(result.status, 400)
        }
        for (const csr of [undefined, null, {}, '', 'x'.repeat(64 * 1024 + 1)]) {
            const result = await certificate(spawnCertificate, 'device-id', csr)
            assert.equal(result.status, 400)
        }
        assert.equal(calls, 0)
    })

    test('returns one generic error for spawn, stdin, and nonzero-exit failures', async () => {
        for (const fail of ['spawn', 'stdin', 'close']) {
            let child: FakeCertificateProcess | undefined
            const spawnCertificate = () => {
                if (fail === 'spawn') throw new Error('private spawn detail')
                child = new FakeCertificateProcess()
                setImmediate(() => {
                    if (fail === 'stdin') child?.stdin.emit('error', new Error('private stdin detail'))
                    else child?.emit('close', 1)
                })
                return child as never
            }

            const result = await certificate(spawnCertificate, 'device-id', 'csr')
            assert.equal(result.status, 500)
            assert.deepEqual(JSON.parse(result.body), {
                resultCode: '1000',
                resultMsg: 'Certificate generation failed',
            })
            if (child) assert.equal(child.killed, true)
        }
    })

    test('returns the generated certificate once for a successful process', async () => {
        const child = new FakeCertificateProcess()
        const spawnCertificate = () => {
            setImmediate(() => {
                child.stdout.emit('data', Buffer.from('CERT\r\n'))
                child.emit('close', 0)
            })
            return child as never
        }

        const result = await certificate(spawnCertificate, 'device-id', 'csr')
        assert.equal(result.status, 200)
        assert.deepEqual(JSON.parse(result.body), {
            resultCode: '0000',
            result: { certificatePem: 'CERT\n' },
        })
        assert.equal(child.killed, false)
    })
})
