import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createConnection, createServer, type Socket } from 'node:net'
import { test } from 'node:test'
import { MqttClient } from 'mqtt'
import mqttPacket, { type Packet } from 'mqtt-packet'
import {
    DeviceMQTTAccess,
    type MQTTInventoryEntry,
    parseDeviceTopic,
    validateMQTTDiagnostics,
} from '@/cloud/mqtt-access'
import { Broker } from '@/cloud/mqtt-broker'
import { DeviceAcceptor } from '@/cloud/thinq2/device'

const pause = (ms = 30) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const envelope = (id: string, cmd = 'device_packet', data: unknown = '00') => JSON.stringify({ did: id, cmd, data })
const account = { username: 'reader', password: 'synthetic-secret-unique', device_ids: ['one', 'two'] }

async function fixture(resolveSource?: ConstructorParameters<typeof DeviceMQTTAccess>[2]) {
    const entries: MQTTInventoryEntry[] = [
        { entryId: 'first', ip: '127.0.0.2', deviceId: 'one', platform: 'thinq2' },
        { entryId: 'second', ip: '127.0.0.3', deviceId: 'two', platform: 'thinq2' },
    ]
    const policy = new DeviceMQTTAccess(() => entries.map((entry) => ({ ...entry })), [account], resolveSource)
    const broker = new Broker(policy)
    const acceptor = new DeviceAcceptor(broker)
    const server = createServer((socket) => broker.accept(socket))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert(address && typeof address === 'object')
    const port = address.port
    const clients: MqttClient[] = [],
        sockets: Socket[] = []
    async function client(ip = '127.0.0.2', extra: object = {}) {
        const peer = new MqttClient(() => createConnection({ host: '127.0.0.1', port, localAddress: ip }), {
            clientId: 'arbitrary-firmware-id',
            reconnectPeriod: 0,
            keepalive: 1200,
            ...extra,
        })
        peer.on('error', () => {})
        clients.push(peer)
        await new Promise<void>((resolve, reject) => {
            peer.once('connect', () => resolve())
            peer.once('error', reject)
            peer.once('close', () => reject(new Error('connection closed before admission')))
        })
        return peer
    }
    async function wire(packets: Packet[], ip = '127.0.0.2') {
        const socket = createConnection({ host: '127.0.0.1', port, localAddress: ip })
        sockets.push(socket)
        const parsed: Packet[] = [],
            parser = mqttPacket.parser()
        parser.on('packet', (packet) => parsed.push(packet))
        socket.on('data', (data) => parser.parse(data))
        socket.on('error', () => {})
        await once(socket, 'connect')
        socket.write(Buffer.concat(packets.map((packet) => mqttPacket.generate(packet))))
        return { socket, parsed }
    }
    return {
        entries,
        broker,
        policy,
        acceptor,
        server,
        port,
        client,
        wire,
        async cleanup() {
            for (const peer of clients) peer.end(true)
            for (const socket of sockets) socket.destroy()
            for (const peer of broker.clients) peer.destroy(true)
            await new Promise<void>((resolve) => server.close(() => resolve()))
        },
    }
}
const connectPacket: Packet = {
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: true,
    clientId: 'firmware',
    keepalive: 1200,
}
const subPacket: Packet = { cmd: 'subscribe', messageId: 1, subscriptions: [{ topic: 'lime/devices/one', qos: 0 }] }
const pubPacket = (id = 'one'): Packet => ({
    cmd: 'publish',
    topic: `clip/message/devices/${id}`,
    payload: envelope(id),
    qos: 1,
    messageId: 7,
    retain: false,
    dup: false,
})

async function subscribe(client: MqttClient, topics: string | string[]) {
    return new Promise<number[]>((resolve) =>
        client.subscribe(topics, (_error, _grants, packet) => resolve(packet?.granted.map(Number) ?? [])),
    )
}
async function publish(client: MqttClient, topic: string, payload: string) {
    await new Promise<void>((resolve, reject) =>
        client.publish(topic, payload, { qos: 1 }, (error) => (error ? reject(error) : resolve())),
    )
}

test('canonical topics preserve prefixes and reject wildcard or extra device levels; account validation is bounded', () => {
    assert.deepEqual(parseDeviceTopic('region/home/clip/message/devices/one'), { kind: 'message', deviceId: 'one' })
    for (const topic of [
        'lime/devices/+',
        'clip/message/devices/one/more',
        'clip/provisioning/devices/#',
        'lime/devices/one\0',
    ])
        assert.equal(parseDeviceTopic(topic), undefined)
    assert.deepEqual(validateMQTTDiagnostics(undefined), [])
    for (const value of [
        null,
        [account, account],
        [{ ...account, password: 'short' }],
        [{ ...account, device_ids: ['one', 'one'] }],
        [{ ...account, allow_publish: 'true' }],
        Array(33).fill(account),
    ])
        assert.throws(() => validateMQTTDiagnostics(value), /진단 계정/)
})

test('real broker denies unknown, preCONNECT and duplicate CONNECT with zero application/retained effects', async () => {
    const f = await fixture()
    let published = 0
    f.broker.on('publish', () => published++)
    try {
        for (const [packets, ip] of [
            [[pubPacket()], '127.0.0.2'],
            [[connectPacket, pubPacket()], '127.0.0.4'],
            [[connectPacket, connectPacket, pubPacket()], '127.0.0.2'],
        ] as Array<[Packet[], string]>) {
            const wire = await f.wire(packets, ip)
            await pause()
            assert.equal(
                wire.parsed.some((packet) => packet.cmd === 'puback'),
                false,
            )
            assert.equal(wire.socket.destroyed, true)
        }
        assert.equal(published, 0)
        assert.equal(f.broker.retainMap.size, 0)
        const credential = await f.wire([
            { ...connectPacket, username: account.username, password: Buffer.from(account.password) } as Packet,
        ])
        await pause()
        assert.equal(
            credential.parsed.some((packet) => packet.cmd === 'connack' && packet.returnCode === 0),
            false,
        )
    } finally {
        await f.cleanup()
    }
})

test('saved source IDs allow arbitrary clientId, exact grants and one QoS ACK; cross-device effects and LWT are denied', {
    timeout: 8000,
}, async () => {
    const f = await fixture()
    const published: string[] = []
    f.broker.on('publish', (packet) => published.push(packet.topic))
    try {
        const first = await f.client()
        const second = await f.client('127.0.0.3')
        assert.deepEqual(
            await subscribe(first, ['lime/devices/one', 'lime/devices/two', 'lime/devices/#']),
            [0, 128, 128],
        )
        await subscribe(second, 'lime/devices/two')
        let delivered = 0
        second.on('message', () => delivered++)
        const own = await f.wire([connectPacket, pubPacket()])
        await pause()
        assert.equal(own.parsed.filter((packet) => packet.cmd === 'puback').length, 1)
        for (const packet of [
            pubPacket('two'),
            { ...pubPacket('two'), retain: true, payload: '' } as Packet,
            { ...pubPacket(), payload: envelope('two') } as Packet,
        ]) {
            const before = published.length
            const denied = await f.wire([connectPacket, packet])
            await pause()
            assert.equal(
                denied.parsed.some((packet) => packet.cmd === 'puback'),
                false,
            )
            assert.equal(published.length, before)
        }
        const badWill = await f.wire([
            {
                ...connectPacket,
                will: {
                    topic: 'clip/message/devices/two',
                    payload: Buffer.from(envelope('two')),
                    qos: 0,
                    retain: false,
                },
            } as Packet,
        ])
        await pause()
        assert.equal(
            badWill.parsed.some((packet) => packet.cmd === 'connack' && packet.returnCode === 0),
            false,
        )
        assert.equal(delivered, 0)
        const peer = [...f.broker.clients].find((peer) => peer.sourceIp === '127.0.0.2')
        assert(peer)
        const before = published.length
        assert.equal(
            f.broker.publish(
                { topic: 'clip/message/devices/two', payload: envelope('two'), retain: true, qos: 0, dup: false },
                peer,
            ),
            false,
        )
        assert.equal(published.length, before)
    } finally {
        await f.cleanup()
    }
})

test('IP-only bootstrap claims one device transiently, preserves same-ID reconnect, and real ThinQ2 provisioning links resolved IP', async () => {
    const f = await fixture(async (_source, signal) => (signal.aborted ? undefined : '127.0.0.2'))
    f.entries[0].deviceId = undefined
    f.entries[0].platform = undefined
    try {
        const first = await f.client('127.0.0.1')
        assert.deepEqual(await subscribe(first, 'lime/devices/one'), [0])
        const raced = await f.client('127.0.0.1')
        assert.deepEqual(await subscribe(raced, 'lime/devices/other'), [128])
        const same = await f.client('127.0.0.1')
        assert.deepEqual(await subscribe(same, 'lime/devices/one'), [0])
        const provisioned = new Promise<import('@/cloud/thinq2/device').Device>((resolve) =>
            f.acceptor.once('newDevice', resolve),
        )
        await publish(
            first,
            'prefix/clip/provisioning/devices/one',
            `${envelope('one', 'preDeploy', { appInfo: { modelName: 'TEST_DEVICE', softVer: '1', DeviceType: 'TEST' } }).replace('"cmd":', '"kind":"TEST_DEVICE","cmd":')}\0`,
        )
        await publish(first, 'clip/message/devices/one', envelope('one', 'completeProvisioning_ack'))
        const device = await provisioned
        assert.equal(device.sourceIp, '127.0.0.2')
        assert.equal(device.id, 'one')
        f.entries[0].deviceId = 'one'
        f.entries[0].platform = 'thinq2'
        assert.deepEqual(
            await subscribe(raced, 'lime/devices/one'),
            [0],
            'an admitted unbound peer can bind the same ID after linkage',
        )
        const received: string[] = []
        device.onBridgeMessage((message) => received.push(message.cmd))
        await publish(first, 'prefix/clip/message/devices/one', envelope('one', 'modem_cmd', 'result'))
        assert.deepEqual(received, ['modem_cmd'])
        const state: Buffer[] = []
        device.on('data', (packet) => state.push(packet))
        await publish(first, 'clip/message/devices/one', envelope('one', 'device_packet', '01ff'))
        assert.deepEqual(state, [Buffer.from('01ff', 'hex')])
        const response = (cmd: string) =>
            new Promise<Record<string, unknown>>((resolve) => {
                const handler = (_topic: string, payload: Buffer) => {
                    const value = JSON.parse(payload.toString())
                    if (value.cmd === cmd) {
                        first.removeListener('message', handler)
                        resolve(value)
                    }
                }
                first.on('message', handler)
            })
        const timesync = response('resp_timesync')
        await publish(first, 'clip/message/devices/one', envelope('one', 'req_timesync'))
        assert.equal((await timesync).did, 'one')
        const ack = response('ack')
        device.forward_message({ did: 'one', kind: 'TEST_DEVICE', mid: 1, cmd: 'ack', type: 1, data: '01ff' })
        assert.equal((await ack).data, '01ff')
        await publish(first, 'clip/provisioning/devices/one', envelope('one', 'undeploy'))
        assert.equal(f.acceptor.clientsById.size, 0)
        const reprovisioned = new Promise<import('@/cloud/thinq2/device').Device>((resolve) =>
            f.acceptor.once('newDevice', resolve),
        )
        await publish(
            same,
            'clip/provisioning/devices/one',
            JSON.stringify({ did: 'one', cmd: 'deploy', kind: 'TEST', data: { appInfo: { modelName: 'TEST' } } }),
        )
        await publish(same, 'clip/message/devices/one', envelope('one', 'completeProvisioning_ack'))
        assert.equal((await reprovisioned).id, 'one')
        assert.equal(
            [...f.broker.clients].find((peer) => peer.sourceIp === '127.0.0.2')?.stream?.timeout,
            0,
            '1200-second keepalive remains untimed',
        )
    } finally {
        await f.cleanup()
    }
})

test('publish-first bootstrap and revocation recheck retained replay, fanout, ingress and LWT without inventory mutation', async () => {
    const f = await fixture()
    f.entries[0].deviceId = undefined
    try {
        const first = await f.client()
        await publish(
            first,
            'clip/provisioning/devices/one',
            JSON.stringify({ did: 'one', cmd: 'preDeploy', kind: 'TEST', data: { appInfo: { modelName: 'TEST' } } }),
        )
        assert.deepEqual(await subscribe(first, 'lime/devices/one'), [0])
        f.entries[0].deviceId = 'one'
        const initial = new Promise<void>((resolve) => first.once('message', () => resolve()))
        f.broker.publish(
            { topic: 'lime/devices/one', payload: envelope('one'), qos: 0, retain: true, dup: false },
            null,
        )
        await initial
        let delivered = 0
        first.on('message', () => delivered++)
        const peer = [...f.broker.clients][0]
        f.entries[0].autoLink = false
        f.entries[0].deviceId = undefined
        const snapshot = structuredClone(f.entries)
        f.broker.publish(
            { topic: 'lime/devices/one', payload: envelope('one'), qos: 0, retain: false, dup: false },
            null,
        )
        assert.equal(f.policy.deliver('lime/devices/one', peer), false)
        assert.equal(f.policy.subscribe('lime/devices/one', peer), false)
        assert.deepEqual(
            await subscribe(first, 'lime/devices/one'),
            [128],
            'revocation denies retained replay through the wire path',
        )
        assert.equal(
            f.broker.publish(
                { topic: 'clip/message/devices/one', payload: envelope('one'), qos: 0, retain: true, dup: false },
                peer,
            ),
            false,
        )
        await pause()
        assert.equal(delivered, 0)
        assert.deepEqual(f.entries, snapshot)
        for (const change of [
            (entry: MQTTInventoryEntry) => {
                entry.ip = '127.0.0.9'
            },
            (entry: MQTTInventoryEntry) => {
                entry.deviceId = 'other'
            },
        ]) {
            f.entries[0] = { entryId: 'first', ip: '127.0.0.2', deviceId: 'one' }
            const connected = await f.client()
            const current = [...f.broker.clients].find(
                (client) => client.mqtt && client !== peer && client.sourceIp === '127.0.0.2',
            )
            assert(current)
            change(f.entries[0])
            assert.equal(f.policy.deliver('lime/devices/one', current), false)
            connected.end(true)
        }
        f.entries.splice(0, 1)
        assert.equal(f.policy.deliver('lime/devices/one', peer), false)
    } finally {
        await f.cleanup()
    }
})

test('pending admission pauses and bounds pipelines, cancels closure, drains only after CONNACK and never accepts late', async () => {
    let release: (ip?: string) => void = () => {},
        aborted = 0,
        lookups = 0
    const f = await fixture(
        (_source, signal) =>
            new Promise((resolve) => {
                lookups++
                release = resolve
                signal.addEventListener('abort', () => aborted++, { once: true })
            }),
    )
    try {
        let published = 0
        f.broker.on('publish', () => published++)
        const wire = await f.wire([connectPacket, subPacket, pubPacket()])
        await pause()
        assert.equal(wire.parsed.length, 0)
        assert.equal(published, 0)
        release('127.0.0.2')
        await pause()
        assert.deepEqual(
            wire.parsed.map((packet) => packet.cmd),
            ['connack', 'suback', 'puback'],
        )
        const closed = await f.wire([connectPacket])
        await pause()
        closed.socket.destroy()
        await pause()
        const count = f.broker.clients.size
        release('127.0.0.2')
        await pause()
        assert.equal(f.broker.clients.size, count)
        assert(aborted > 0)
        const overflow = await f.wire([connectPacket, ...Array(9).fill(subPacket)])
        await pause()
        assert.equal(overflow.socket.destroyed, true)
        release('127.0.0.2')
        await pause()
        assert.equal(overflow.parsed.length, 0)
        assert.equal(lookups, 3)
        const changed = await f.wire([connectPacket])
        await pause()
        f.entries.splice(0)
        release('127.0.0.2')
        await pause()
        assert.equal(
            changed.parsed.some((packet) => packet.cmd === 'connack' && packet.returnCode === 0),
            false,
        )
    } finally {
        await f.cleanup()
    }
})

test('LWT binds an IP-only row, graceful close suppresses it, and revocation rejects later LWT delivery', async () => {
    const f = await fixture()
    f.entries[0].deviceId = undefined
    const will = {
        topic: 'clip/message/devices/one',
        payload: Buffer.from(envelope('one', 'offline')),
        qos: 0 as const,
        retain: false,
    }
    let wills = 0
    f.broker.on('publish', (packet) => {
        if (packet.topic === will.topic) wills++
    })
    try {
        const graceful = await f.wire([{ ...connectPacket, will } as Packet])
        await pause()
        assert.equal(
            graceful.parsed.some((packet) => packet.cmd === 'connack' && packet.returnCode === 0),
            true,
        )
        graceful.socket.write(mqttPacket.generate({ cmd: 'disconnect' }))
        await pause()
        assert.equal(wills, 0)
        const disconnected = await f.wire([{ ...connectPacket, will } as Packet])
        await pause()
        disconnected.socket.destroy()
        await pause()
        assert.equal(wills, 1)
        const revoked = await f.wire([{ ...connectPacket, will } as Packet])
        await pause()
        f.entries[0].autoLink = false
        revoked.socket.destroy()
        await pause()
        assert.equal(wills, 1)
    } finally {
        await f.cleanup()
    }
})

test('pending connection and byte limits reject excess work and the absolute admission deadline prevents late success', async (t) => {
    const releases: Array<(ip: string) => void> = []
    const f = await fixture((_source, _signal) => new Promise((resolve) => releases.push(resolve)))
    try {
        const sockets = []
        for (let index = 0; index < 65; index++) sockets.push(await f.wire([connectPacket]))
        await pause()
        assert.equal(f.broker.clients.size, 64)
        assert.equal(sockets[64].socket.destroyed, true)
        for (const socket of sockets) socket.socket.destroy()
        await pause()
        const oversized = await f.wire([
            {
                ...connectPacket,
                username: 'u'.repeat(40 * 1024),
                password: Buffer.alloc(30 * 1024),
            } as Packet,
        ])
        for (let index = 0; index < 40 && !oversized.socket.destroyed; index++) await pause(10)
        assert.equal(oversized.socket.destroyed, true)
        assert.equal(oversized.parsed.length, 0)
        t.mock.timers.enable({ apis: ['setTimeout'] })
        // This connection is created after timer mocking, so its actual broker deadline is controlled.
        const before = releases.length
        const expired = await f.wire([connectPacket])
        for (let index = 0; index < 100 && releases.length === before; index++)
            await new Promise<void>((resolve) => setImmediate(resolve))
        assert.equal(releases.length, before + 1)
        t.mock.timers.tick(10_001)
        await new Promise<void>((resolve) => setImmediate(resolve))
        t.mock.timers.reset()
        for (const release of releases) release('127.0.0.2')
        await pause()
        assert.equal(
            expired.parsed.some((packet) => packet.cmd === 'connack' && packet.returnCode === 0),
            false,
        )
        assert.equal(expired.socket.destroyed, true)
    } finally {
        t.mock.timers.reset()
        await f.cleanup()
    }
})

test('ambiguous, disabled or incompatible live inventory denies admission without changing registration', async () => {
    const f = await fixture()
    const original = structuredClone(f.entries)
    const cases: MQTTInventoryEntry[][] = [
        [...original, { entryId: 'duplicate-ip', ip: '127.0.0.2' }],
        [...original, { entryId: 'first', ip: '127.0.0.9' }],
        [original[0], { ...original[1], deviceId: 'one' }],
        [{ ...original[0], autoLink: false }],
        [{ ...original[0], platform: 'thinq1' }],
        [{ ...original[0], deviceId: 'invalid/id' }],
    ]
    try {
        for (const entries of cases) {
            f.entries.splice(0, f.entries.length, ...structuredClone(entries))
            const snapshot = structuredClone(f.entries)
            const peer = await f.wire([connectPacket, pubPacket()])
            await pause()
            assert.equal(
                peer.parsed.some((packet) => packet.cmd === 'connack' && packet.returnCode === 0),
                false,
            )
            assert.equal(
                peer.parsed.some((packet) => packet.cmd === 'puback'),
                false,
            )
            assert.deepEqual(f.entries, snapshot)
        }
    } finally {
        await f.cleanup()
    }
})
