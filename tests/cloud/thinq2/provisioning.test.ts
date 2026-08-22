import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { routes } from '@/cloud/thinq2/provisioning'
import type { CA, Config } from '@/util/config'

const CA_STUB = { key: '', cert: '' } as CA
const BASE = {
    hostname: 'rethink.lan',
    https_port: { advertise: 443 },
    mqtts_port: { advertise: 8883 },
} as unknown as Config

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
    }
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
