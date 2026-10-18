import assert from 'node:assert/strict'
import type { Socket } from 'node:net'
import { test } from 'node:test'
import type { MQTTAccessPolicy } from '@/cloud/mqtt-access'
import { Broker, idleTimeoutFor, mqttTopicMatches } from '@/cloud/mqtt-broker'

const budgetTestPolicy: MQTTAccessPolicy = {
    connect: () => true,
    publish: () => true,
    subscribe: () => true,
    deliver: () => true,
    disconnect: () => {},
}

test('MQTT filters match complete levels without treating regex syntax specially', () => {
    assert.equal(mqttTopicMatches('home/kitchen/state', 'home/+/state'), true)
    assert.equal(mqttTopicMatches('home/kitchen/state/extra', 'home/+/state'), false)
    assert.equal(mqttTopicMatches('home', 'home/#'), true)
    assert.equal(mqttTopicMatches('home/kitchen/state', 'home/#'), true)
    assert.equal(mqttTopicMatches('home/kitchen/state', 'other/#'), false)
    assert.equal(mqttTopicMatches('device[1].state', 'device[1].state'), true)
    assert.equal(mqttTopicMatches('device[1].state', 'device[1].*'), false)
})

test('MQTT filters reject invalid wildcard placement and remain bounded', () => {
    assert.equal(mqttTopicMatches('home/kitchen', 'home/kit+hen'), false)
    assert.equal(mqttTopicMatches('home/kitchen', 'home/#/state'), false)
    assert.equal(mqttTopicMatches(`home/${'x'.repeat(10000)}`, 'home/+'), true)
})

function fakeSocket(record: string[]): Socket {
    const handlers: Record<string, (packet: unknown) => void> = {}
    return {
        remoteAddress: '192.168.1.71',
        timeout: 0,
        setTimeout(ms: number) {
            record.push(`timeout ${ms}`)
        },
        setKeepAlive(enable: boolean, delay: number) {
            record.push(`keepalive ${enable} ${delay}`)
        },
        handlers,
        on(event: string, handler: (packet: unknown) => void) {
            handlers[event] = handler
        },
        once() {},
        removeListener() {},
        write() {
            return true
        },
        end() {},
        pipe() {},
        resetAndDestroy() {
            record.push('reset')
        },
        destroy() {
            record.push('destroy')
        },
    } as unknown as Socket
}

test('shutdown resets every appliance connection rather than closing it', () => {
    const record: string[] = []
    const broker = new Broker()
    broker.accept(fakeSocket(record))
    broker.accept(fakeSocket(record))

    // An appliance that asks for a twenty minute keepalive is not reading its socket in
    // between, so a plain close leaves it waiting for its own timer before it reconnects.
    // A reset raises an error on the connection straight away.
    // Setting a connection up records probe and timeout calls that are not the subject here.
    record.length = 0
    broker.shutdown()
    assert.deepEqual(record, ['reset', 'reset'])
})

test('shutdown falls back to a plain close where reset is unavailable', () => {
    const record: string[] = []
    const broker = new Broker()
    const socket = fakeSocket(record) as unknown as Record<string, unknown>
    delete socket.resetAndDestroy
    broker.accept(socket as unknown as Socket)

    // Setting a connection up records probe and timeout calls that are not the subject here.
    record.length = 0
    broker.shutdown()
    assert.deepEqual(record, ['destroy'])
})

test('shutdown resets the socket underneath a TLS connection', () => {
    const record: string[] = []
    const broker = new Broker()
    const tls = fakeSocket(record) as unknown as Record<string, unknown>
    const raw = fakeSocket(record)
    // Appliances arrive over TLS, where resetAndDestroy throws ERR_INVALID_HANDLE_TYPE.
    tls.resetAndDestroy = () => {
        throw new Error('ERR_INVALID_HANDLE_TYPE')
    }
    tls._parent = raw
    broker.accept(tls as unknown as Socket)

    // Setting a connection up records probe and timeout calls that are not the subject here.
    record.length = 0
    broker.shutdown()
    assert.deepEqual(record, ['reset'], 'the reset must land on the socket that accepts one')
})

test('shutdown survives a connection that can be neither reset nor found underneath', () => {
    const record: string[] = []
    const broker = new Broker()
    const stubborn = fakeSocket(record) as unknown as Record<string, unknown>
    stubborn.resetAndDestroy = () => {
        throw new Error('ERR_INVALID_HANDLE_TYPE')
    }
    const ordinary = fakeSocket(record)
    broker.accept(stubborn as unknown as Socket)
    broker.accept(ordinary)

    // A throw used to abort the shutdown before any connection was dealt with, and took
    // the process down with it on every restart.
    // Setting a connection up records probe and timeout calls that are not the subject here.
    record.length = 0
    broker.shutdown()
    assert.deepEqual(record, ['destroy', 'reset'])
})

test('an appliance asking for more silence than the timeout is left alone', () => {
    // The washer asks for twenty minutes and then sends nothing for longer than that, so
    // half again its keepalive still cut it off just as a cycle finished and it went quiet.
    assert.equal(idleTimeoutFor(1200), 0)
})

test('an appliance that keeps to a short keepalive is still timed out', () => {
    // Every other appliance here asks for sixty seconds and honours it.
    assert.equal(idleTimeoutFor(60), 300000)
    assert.equal(idleTimeoutFor(240), 360000, 'half again, once that is past the floor')
    assert.equal(idleTimeoutFor(0), 300000, 'nothing negotiated yet')
})

test('the kernel is asked to probe every appliance connection', () => {
    const record: string[] = []
    const broker = new Broker()
    broker.accept(fakeSocket(record))

    // This is what makes it safe to leave a long-keepalive appliance alone above: an idle
    // one answers a probe and stays, one whose power was pulled does not and is torn down.
    assert.ok(
        record.some((entry) => entry.startsWith('keepalive true ')),
        'connections must be probed',
    )
})

test('retained topic and byte quotas own payloads, preserve rejected replacements and release deletion budget', () => {
    const broker = new Broker()
    const packet = (topic: string, payload: Buffer) => ({ topic, payload, retain: true, qos: 0 as const, dup: false })
    const source = Buffer.from('original')
    broker.publish(packet('owned', source), null)
    source.fill(0)
    assert.equal(broker.retainMap.get('owned')?.payload.toString(), 'original')
    for (let index = 1; index < 1024; index++) broker.publish(packet(`t${index}`, Buffer.from('a')), null)
    broker.publish(packet('overflow', Buffer.from('x')), null)
    assert.equal(broker.retainMap.size, 1024)
    broker.publish(packet('owned', Buffer.from('replaced')), null)
    assert.equal(broker.retainMap.get('owned')?.payload.toString(), 'replaced')
    broker.publish(packet('owned', Buffer.alloc(8 * 1024 * 1024)), null)
    assert.equal(broker.retainMap.get('owned')?.payload.toString(), 'replaced')
    broker.publish(packet('owned', Buffer.alloc(0)), null)
    broker.publish(packet('overflow', Buffer.from('x')), null)
    assert.equal(broker.retainMap.size, 1024)
    assert.equal(broker.retainMap.has('overflow'), true)
    const bytes = new Broker()
    bytes.publish(packet('a', Buffer.alloc(8 * 1024 * 1024 - 1)), null)
    bytes.publish(packet('b', Buffer.from('x')), null)
    assert.equal(bytes.retainMap.has('b'), false)
    bytes.publish(packet('a', Buffer.from('small')), null)
    bytes.publish(packet('b', Buffer.from('x')), null)
    assert.equal(bytes.retainMap.has('b'), true)
    const correlationData = Buffer.from('synthetic-correlation')
    const userProperties = { label: ['original'] }
    bytes.publish({ ...packet('properties', Buffer.from('x')), properties: { correlationData, userProperties } }, null)
    correlationData.fill(0)
    userProperties.label.push('mutated')
    const properties = bytes.retainMap.get('properties')?.properties
    assert(Buffer.isBuffer(properties?.correlationData))
    assert.equal(properties?.correlationData?.toString(), 'synthetic-correlation')
    assert.deepEqual(properties?.userProperties, { label: ['original'] })
    bytes.publish(
        {
            ...packet('properties', Buffer.from('x')),
            properties: { userProperties: { huge: 'x'.repeat(8 * 1024 * 1024) } },
        },
        null,
    )
    assert.deepEqual(bytes.retainMap.get('properties')?.properties?.userProperties, { label: ['original'] })
})

test('wire subscription quotas reject excess filters, release budgets and preserve wildcard retained replay', async () => {
    const { createServer } = await import('node:net')
    const { connect } = await import('mqtt')
    const broker = new Broker(budgetTestPolicy)
    const server = createServer((socket) => broker.accept(socket))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert(address && typeof address === 'object')
    const port = address.port
    const clients: ReturnType<typeof connect>[] = []
    async function client() {
        const connection = connect(`mqtt://127.0.0.1:${port}`, { reconnectPeriod: 0, keepalive: 1200 })
        clients.push(connection)
        await new Promise<void>((resolve, reject) => {
            connection.once('connect', () => resolve())
            connection.once('error', reject)
        })
        return connection
    }
    function subscribe(connection: ReturnType<typeof connect>, topics: string | string[]) {
        return new Promise<{ error: Error | null; granted: number[] }>((resolve) =>
            connection.subscribe(topics, (error, _grants, packet) =>
                resolve({
                    error,
                    granted:
                        packet?.granted.map((grant) => {
                            assert(typeof grant === 'number')
                            return grant
                        }) ?? [],
                }),
            ),
        )
    }
    async function disconnect(connection: ReturnType<typeof connect>) {
        await new Promise<void>((resolve, reject) =>
            connection.end(true, {}, (error) => (error ? reject(error) : resolve())),
        )
        await new Promise<void>((resolve) => setTimeout(resolve, 20))
    }
    try {
        const first = await client()
        const filters = Array.from({ length: 128 }, (_, index) => `local/${index}`)
        assert((await subscribe(first, filters)).granted.every((grant) => grant === 0))
        assert.equal((await subscribe(first, 'excess')).granted[0], 128)
        assert.equal((await subscribe(first, filters[0])).granted[0], 0, 'duplicates use no extra budget')
        await new Promise<void>((resolve, reject) =>
            first.unsubscribe(filters[0], (error) => (error ? reject(error) : resolve())),
        )
        assert.equal((await subscribe(first, 'replacement')).granted[0], 0)
        await disconnect(first)
        // Count quota across independent clients.
        for (let index = 0; index < 32; index++)
            assert((await subscribe(await client(), filters)).granted.every((grant) => grant === 0))
        const extra = await client()
        assert.equal((await subscribe(extra, 'count-overflow')).granted[0], 128)
        await disconnect(clients[1])
        assert.equal((await subscribe(extra, 'count-overflow')).granted[0], 0)
        for (const connection of clients.slice(2)) await disconnect(connection)
        // UTF-8 bytes, not character count, determine filter admission.
        const wide = '가'.repeat(340)
        assert.equal((await subscribe(await client(), `${wide}aaaaa`)).granted[0], 128)
        for (let index = 0; index < 8; index++) {
            const filters = Array.from({ length: 128 }, (_, item) => `${wide}${String(item).padStart(4, '0')}`)
            assert((await subscribe(await client(), filters)).granted.every((grant) => grant === 0))
        }
        const byteOverflow = await client()
        assert.equal((await subscribe(byteOverflow, 'x')).granted[0], 128)
        for (const connection of clients) if (connection.connected) await disconnect(connection)
        broker.publish(
            { topic: 'remote/helper/state', payload: Buffer.from('retained'), retain: true, qos: 0, dup: false },
            null,
        )
        const replay = await client()
        const message = new Promise<string>((resolve) =>
            replay.once('message', (_topic, payload) => resolve(payload.toString())),
        )
        assert.equal((await subscribe(replay, 'remote/+/state')).granted[0], 0)
        assert.equal(await message, 'retained')
    } finally {
        await Promise.all(clients.filter((connection) => connection.connected).map(disconnect))
        for (const client of broker.clients) client.destroy()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    }
})

test('wire retained publishes enforce count and byte ceilings while replacements and deletions stay available', async () => {
    const { createServer } = await import('node:net')
    const { connect } = await import('mqtt')
    const broker = new Broker(budgetTestPolicy)
    const server = createServer((socket) => broker.accept(socket))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert(address && typeof address === 'object')
    const client = connect(`mqtt://127.0.0.1:${address.port}`, { reconnectPeriod: 0 })
    await new Promise<void>((resolve, reject) => {
        client.once('connect', () => resolve())
        client.once('error', reject)
    })
    const publish = (topic: string, payload: string | Buffer) =>
        new Promise<void>((resolve, reject) =>
            client.publish(topic, payload, { retain: true, qos: 0 }, (error) => (error ? reject(error) : resolve())),
        )
    const barrier = () =>
        new Promise<void>((resolve, reject) =>
            client.subscribe('barrier', (error) => (error ? reject(error) : resolve())),
        )
    try {
        for (let index = 0; index < 1025; index++) await publish(`topic-${index}`, 'x')
        await barrier()
        assert.equal(broker.retainMap.size, 1024)
        assert.equal(broker.retainMap.has('topic-1024'), false)
        await publish('topic-0', 'replaced')
        await barrier()
        assert.equal(broker.retainMap.get('topic-0')?.payload.toString(), 'replaced')
        await publish('topic-0', '')
        await publish('topic-1024', 'admitted')
        await barrier()
        assert.equal(broker.retainMap.get('topic-1024')?.payload.toString(), 'admitted')
        for (const topic of broker.retainMap.keys()) await publish(topic, '')
        await barrier()
        assert.equal(broker.retainMap.size, 0)
        await publish('a', Buffer.alloc(8 * 1024 * 1024 - 1))
        await barrier()
        assert.equal(broker.retainMap.size, 1)
        await publish('b', 'rejected')
        await barrier()
        assert.equal(broker.retainMap.has('b'), false)
        await publish('a', 'small')
        await publish('b', 'admitted')
        await barrier()
        assert.equal(broker.retainMap.get('b')?.payload.toString(), 'admitted')
    } finally {
        await new Promise<void>((resolve) => client.end(true, {}, () => resolve()))
        for (const peer of broker.clients) peer.destroy()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    }
})
