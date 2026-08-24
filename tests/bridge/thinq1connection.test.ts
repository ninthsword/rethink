import assert from 'node:assert/strict'
import { test } from 'node:test'
import type * as tls from 'node:tls'
import type fetch from 'node-fetch'
import { Connection } from '@/bridge/thinq1connection'
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
