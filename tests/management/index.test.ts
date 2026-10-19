import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import WebSocket from 'ws'
import { type AnyDevice, DeviceManager } from '@/cloud/devmgr'
import type HA_bridge from '@/cloud/ha_bridge'
import { app, isLoopbackAuthority, serializeDeviceEntries } from '@/management/index'

type SyntheticDevice = EventEmitter & {
    id: string
    meta: { modelId: string; modelName: string }
    platform: 'thinq2'
}

function fakeDevice(id: string): SyntheticDevice {
    return Object.assign(new EventEmitter(), {
        id,
        meta: { modelId: 'synthetic-model', modelName: 'Synthetic device' },
        platform: 'thinq2' as const,
    })
}

function acceptDevice(manager: DeviceManager, id: string) {
    const device = fakeDevice(id)
    manager.accept(device as unknown as AnyDevice)
    return device
}

function fakeHA() {
    const connection = Object.assign(new EventEmitter(), { isConnected: true })
    return { HA: connection, haDevices: new Map() } as unknown as HA_bridge
}

async function createMonitorFixture(bindHost = '127.0.0.1') {
    const directory = await mkdtemp(path.join(tmpdir(), 'rethink-management-monitor-'))
    const manager = new DeviceManager()
    const deviceId = 'synthetic-device'
    const device = acceptDevice(manager, deviceId)
    const server = app(fakeHA(), manager, undefined, path.join(directory, 'missing-router-config.json'))
    const sockets = new Set<Socket>()
    const clients = new Set<WebSocket>()
    const serverSockets = new Map<WebSocket, Socket>()

    server.on('connection', (socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
    })
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, bindHost, () => {
            server.removeListener('error', reject)
            resolve()
        })
    })
    const address = server.address()
    assert(address && typeof address === 'object')
    const port = address.port

    const managerBaseline = {
        newDevice: manager.listenerCount('newDevice'),
        dropDevice: manager.listenerCount('dropDevice'),
    }

    async function openMonitor(authority = `127.0.0.1:${port}`, origin?: string) {
        const connectionHost = bindHost.includes(':') ? `[${bindHost}]` : bindHost
        const client = new WebSocket(`ws://${connectionHost}:${port}/device?id=${deviceId}`, {
            headers: { Host: authority, ...(origin === undefined ? {} : { Origin: origin }) },
        })
        clients.add(client)
        client.on('close', () => clients.delete(client))
        client.on('error', () => {})
        const upgraded = new Promise<{ address?: string; port?: number }>((resolve) =>
            client.once('upgrade', (response) =>
                resolve({ address: response.socket.localAddress, port: response.socket.localPort }),
            ),
        )

        await new Promise<void>((resolve, reject) => {
            const onError = (error: Error) => {
                client.removeListener('message', onMessage)
                reject(error)
            }
            const onMessage = (data: WebSocket.RawData) => {
                client.removeListener('error', onError)
                try {
                    const message = JSON.parse(data.toString()) as { status?: string }
                    assert.equal(message.status, 'online')
                    resolve()
                } catch (error) {
                    reject(error)
                }
            }
            client.once('error', onError)
            client.once('message', onMessage)
        })
        // Server cleanup runs on the server side's close, which can come after the client's on some
        // loopback paths (WSL mirrored networking), so closeClient waits for both.
        const local = await upgraded
        const serverSocket = [...sockets].find(
            (socket) => socket.remotePort === local.port && socket.remoteAddress === local.address,
        )
        if (!serverSocket) throw new Error(`No server socket for client ${local.address}:${local.port}`)
        serverSockets.set(client, serverSocket)
        return client
    }

    async function closeClient(client: WebSocket) {
        const serverSocket = serverSockets.get(client)
        const serverClosed =
            serverSocket && sockets.has(serverSocket)
                ? new Promise<void>((resolve) => serverSocket.once('close', () => resolve()))
                : Promise.resolve()
        if (client.readyState !== WebSocket.CLOSED) {
            const closed = new Promise<void>((resolve) => client.once('close', () => resolve()))
            client.close()
            await closed
        }
        await serverClosed
    }

    async function cleanup() {
        for (const client of clients) client.terminate()
        for (const socket of sockets) socket.destroy()
        try {
            if (server.listening) {
                await new Promise<void>((resolve, reject) => {
                    server.close((error) => {
                        if (error) reject(error)
                        else resolve()
                    })
                })
            }
        } finally {
            await rm(directory, { recursive: true, force: true })
        }
    }

    return { cleanup, closeClient, device, deviceId, manager, managerBaseline, openMonitor, directory, port }
}

function assertManagerMonitorCount(
    manager: DeviceManager,
    baseline: { newDevice: number; dropDevice: number },
    monitorCount: number,
) {
    assert.equal(manager.listenerCount('newDevice'), baseline.newDevice + monitorCount)
    assert.equal(manager.listenerCount('dropDevice'), baseline.dropDevice + monitorCount)
}

function assertDeviceMonitorCount(device: SyntheticDevice, monitorCount: number) {
    assert.equal(device.listenerCount('data'), monitorCount)
    assert.equal(device.listenerCount('sendData'), monitorCount)
}

test('management device serialization preserves arbitrary identifiers as own keys', () => {
    const prototypeNamed = { model: 'prototype' }
    const stringNamed = { model: 'string' }
    const ordinary = { model: 'ordinary' }
    const serialized = serializeDeviceEntries([
        ['__proto__', prototypeNamed],
        ['toString', stringNamed],
        ['ordinary-id', ordinary],
    ])

    assert.deepEqual(Object.keys(serialized), ['__proto__', 'toString', 'ordinary-id'])
    assert.equal(Object.getOwnPropertyDescriptor(serialized, '__proto__')?.value, prototypeNamed)
    assert.equal(serialized.toString, stringNamed)
    assert.equal(serialized['ordinary-id'], ordinary)
})

test('closing a device monitor disposes its device and manager listeners', { timeout: 5000 }, async () => {
    const fixture = await createMonitorFixture()
    try {
        const client = await fixture.openMonitor()
        assertDeviceMonitorCount(fixture.device, 1)
        assertManagerMonitorCount(fixture.manager, fixture.managerBaseline, 1)

        await fixture.closeClient(client)

        assertDeviceMonitorCount(fixture.device, 0)
        assertManagerMonitorCount(fixture.manager, fixture.managerBaseline, 0)
        assert.doesNotThrow(() => {
            fixture.device.emit('data', Buffer.from('after-close'))
            fixture.device.emit('sendData', { after: 'close' })
        })
    } finally {
        await fixture.cleanup()
    }
})

test('device replacement and drop do not accumulate monitor listeners', { timeout: 5000 }, async () => {
    const fixture = await createMonitorFixture()
    try {
        const client = await fixture.openMonitor()
        const replacement = acceptDevice(fixture.manager, fixture.deviceId)

        assertDeviceMonitorCount(fixture.device, 0)
        assertDeviceMonitorCount(replacement, 1)
        assertManagerMonitorCount(fixture.manager, fixture.managerBaseline, 1)

        replacement.emit('close')
        assertDeviceMonitorCount(replacement, 0)
        assert.equal(fixture.manager.allDevices.has(fixture.deviceId), false)
        assertManagerMonitorCount(fixture.manager, fixture.managerBaseline, 1)

        const reconnected = acceptDevice(fixture.manager, fixture.deviceId)
        assertDeviceMonitorCount(reconnected, 1)
        assertManagerMonitorCount(fixture.manager, fixture.managerBaseline, 1)

        await fixture.closeClient(client)
        assertDeviceMonitorCount(reconnected, 0)
        assertManagerMonitorCount(fixture.manager, fixture.managerBaseline, 0)
        assert.doesNotThrow(() => {
            fixture.device.emit('data', Buffer.from('superseded'))
            replacement.emit('sendData', { after: 'drop' })
            reconnected.emit('data', Buffer.from('after-close'))
        })
    } finally {
        await fixture.cleanup()
    }
})

test('a device monitor error followed by close disposes listeners idempotently', { timeout: 5000 }, async () => {
    const fixture = await createMonitorFixture()
    try {
        const client = await fixture.openMonitor()
        assertDeviceMonitorCount(fixture.device, 1)
        assertManagerMonitorCount(fixture.manager, fixture.managerBaseline, 1)

        const closed = new Promise<void>((resolve) => client.once('close', () => resolve()))
        client.send('unmasked client frame', { mask: false })
        await closed

        assertDeviceMonitorCount(fixture.device, 0)
        assertManagerMonitorCount(fixture.manager, fixture.managerBaseline, 0)
        assert.doesNotThrow(() => {
            fixture.device.emit('data', Buffer.from('after-error'))
            fixture.device.emit('sendData', { after: 'error' })
        })
    } finally {
        await fixture.cleanup()
    }
})

test('direct bridge API rejects DNAT switches with 409 and resumes Local saved state without router SSH', async () => {
    const { Bridge } = await import('@/bridge')
    const { BridgePolicy } = await import('@/bridge/policy')
    const { JSONStorage } = await import('@/bridge/state')
    const { RouterConfigStore } = await import('@/router/config-store')
    const dir = await mkdtemp(path.join(tmpdir(), 'rethink-direct-policy-'))
    const manager = new DeviceManager()
    const state = new JSONStorage(dir)
    const store = new RouterConfigStore(path.join(dir, 'router.json'))
    const entry = store.addDevice('192.0.2.20')
    store.linkDevice(entry.entryId, 'synthetic')
    state.setDeviceState('synthetic', { httpServer: 'https://cloud.example', rtiServer: 'rti.example:1' })
    const bridge = new Bridge(state, manager, { policy: new BridgePolicy(store) })
    const server = app(fakeHA(), manager, bridge, store.filename)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
        const address = server.address()
        assert(address && typeof address === 'object')
        const base = `http://127.0.0.1:${address.port}`
        for (const action of ['enable', 'disable']) {
            const result = await fetch(`${base}/bridge/synthetic/${action}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
            })
            assert.equal(result.status, 409)
            assert.match(await result.text(), /DNAT control/)
            assert.match(result.headers.get('content-type') || '', /text\/plain/)
        }
        store.updateDevice(entry.entryId, { mode: 'local' })
        const result = await fetch(`${base}/bridge/synthetic/enable`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        })
        assert.equal(result.status, 204)
        assert.equal(state.getEnabled('synthetic'), true)
        const missing = await fetch(`${base}/bridge/missing/enable`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        })
        assert.equal(missing.status, 400)
        assert.match(await missing.text(), /Registration required/)
    } finally {
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
        await rm(dir, { recursive: true, force: true })
    }
})

test('raw management authority and Origin reject browser and WebSocket effects before routes', async () => {
    const http = await import('node:http')
    const { existsSync } = await import('node:fs')
    const fixture = await createMonitorFixture()
    const host = `127.0.0.1:${fixture.port}`
    const call = (headers: Record<string, string | string[]>) =>
        new Promise<number>((resolve, reject) => {
            const request = http.request(
                {
                    host: '127.0.0.1',
                    port: fixture.port,
                    method: 'POST',
                    path: '/api/router/devices',
                    headers: { 'Content-Type': 'application/json', ...headers },
                },
                (response) => {
                    response.resume()
                    response.on('end', () => resolve(response.statusCode!))
                },
            )
            request.on('error', reject)
            request.end(JSON.stringify({ ip: '192.0.2.77', mode: 'local' }))
        })
    try {
        for (const headers of [
            { Host: 'foreign.invalid', Origin: 'http://foreign.invalid' },
            { Host: host, Origin: 'null' },
            { Host: host, Origin: 'https://' + host },
            { Host: host, Origin: 'http://' + host + '/' },
            { Host: host, Origin: '' },
            { Host: host, Origin: ['http://' + host, 'http://' + host] },
        ])
            assert([403, 421].includes(await call(headers)))
        assert.equal(existsSync(path.join(fixture.directory, 'missing-router-config.json')), false)
        for (const headers of [{ Host: 'foreign.invalid' }, { Origin: 'http://foreign.invalid' }]) {
            const client = new WebSocket(`ws://${host}/device?id=${fixture.deviceId}`, { headers })
            const status = await new Promise<number>((resolve, reject) => {
                client.once('unexpected-response', (_request, response) => {
                    response.resume()
                    resolve(response.statusCode!)
                })
                client.once('open', () => {
                    client.terminate()
                    reject(new Error('foreign WebSocket accepted'))
                })
                client.on('error', () => {})
            })
            assert([403, 421].includes(status))
        }
        assertDeviceMonitorCount(fixture.device, 0)
        assert.equal(await call({ Host: host, Origin: `http://${host}` }), 201)
        const native = await fetch(`http://${host}/api/router/config`)
        assert.equal(native.status, 200)
        const ws = await fixture.openMonitor()
        await fixture.closeClient(ws)
    } finally {
        await fixture.cleanup()
    }
})

for (const [bindHost, hosts] of [
    ['127.0.0.1', ['127.0.0.1', 'localhost', 'LOCALHOST', '127.0.0.2']],
    ['127.0.0.2', ['127.0.0.2', 'localhost']],
    ['::1', ['[::1]', '[0:0:0:0:0:0:0:1]', '[0000:0000:0000:0000:0000:0000:0000:0001]']],
] as const) {
    test(`supported management authorities reach HTTP and WebSocket routes on ${bindHost}`, async () => {
        const http = await import('node:http')
        const fixture = await createMonitorFixture(bindHost)
        try {
            for (const hostname of hosts) {
                const authority = `${hostname}:${fixture.port}`
                for (const origin of [undefined, `http://${authority}`]) {
                    const status = await new Promise<number>((resolve, reject) => {
                        const request = http.get(
                            {
                                host: bindHost,
                                port: fixture.port,
                                path: '/api/router/config',
                                headers: { Host: authority, ...(origin === undefined ? {} : { Origin: origin }) },
                            },
                            (response) => {
                                response.resume()
                                response.on('end', () => resolve(response.statusCode ?? 0))
                            },
                        )
                        request.on('error', reject)
                    })
                    assert.equal(status, 200, `${authority} with Origin ${origin}`)
                    const client = await fixture.openMonitor(authority, origin)
                    assertDeviceMonitorCount(fixture.device, 1)
                    await fixture.closeClient(client)
                    assertDeviceMonitorCount(fixture.device, 0)
                }
            }
        } finally {
            await fixture.cleanup()
        }
    })
}

test('raw authority rejects ambiguous aliases, duplicates and mismatched origins before parsing or effects', async () => {
    const { connect } = await import('node:net')
    const { existsSync } = await import('node:fs')
    const fixture = await createMonitorFixture()
    const host = `127.0.0.1:${fixture.port}`
    const headers = [
        [],
        [`Host: ${host}`, `Host: ${host}`],
        ...[
            'foreign.invalid',
            'localhost.foreign.invalid',
            'localhost.',
            '127.1',
            '2130706433',
            '0177.0.0.1',
            '127.000.0.1',
            '0x7f000001',
            '192.0.2.1',
            '[::ffff:127.0.0.1]',
            '[::2]',
            '::1',
            'user@localhost',
            'localhost/path',
            'localhost#fragment',
        ].map((hostname) => [`Host: ${hostname}:${fixture.port}`]),
        [`Host: ${host}/`],
        [`Host: localhost:0${fixture.port}`],
        [`Host: localhost:${fixture.port === 65535 ? 65534 : fixture.port + 1}`],
        [`Host: localhost`],
        ...[
            'null',
            `https://${host}`,
            `http://${host}/`,
            'http://foreign.invalid',
            `http://localhost:${fixture.port}`,
            `http://127.0.0.1:${fixture.port + 1}`,
        ].map((origin) => [`Host: ${host}`, `Origin: ${origin}`]),
        [`Host: ${host}`, `Origin: http://${host}`, `Origin: http://${host}`],
    ]
    try {
        for (const fields of headers) {
            for (const upgrade of [false, true]) {
                const code = await new Promise<number>((resolve, reject) => {
                    const socket = connect(fixture.port, '127.0.0.1')
                    let response = ''
                    socket.on('error', reject)
                    socket.on('data', (chunk) => {
                        response += chunk.toString()
                        if (!response.includes('\r\n')) return
                        socket.destroy()
                        resolve(Number(response.split(' ')[1]))
                    })
                    socket.on('connect', () => {
                        // Invalid JSON proves authority validation runs before the body parser.
                        const body = '{invalid-json'
                        socket.write(
                            [
                                `${upgrade ? 'GET' : 'POST'} ${upgrade ? `/device?id=${fixture.deviceId}` : '/api/router/devices'} HTTP/1.1`,
                                ...fields,
                                ...(upgrade
                                    ? [
                                          'Connection: Upgrade',
                                          'Upgrade: websocket',
                                          'Sec-WebSocket-Version: 13',
                                          'Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==',
                                      ]
                                    : [
                                          'Content-Type: application/json',
                                          `Content-Length: ${body.length}`,
                                          'Connection: close',
                                      ]),
                                '',
                                upgrade ? '' : body,
                            ].join('\r\n'),
                        )
                    })
                })
                assert(
                    (fields.length === 0 ? [upgrade ? 421 : 400] : [403, 421]).includes(code),
                    `${fields.join('; ')} upgrade=${upgrade}: ${code}`,
                )
            }
        }
        assert.equal(existsSync(path.join(fixture.directory, 'missing-router-config.json')), false)
        assertDeviceMonitorCount(fixture.device, 0)
        assertManagerMonitorCount(fixture.manager, fixture.managerBaseline, 0)
    } finally {
        await fixture.cleanup()
    }
})

test('the middleware authority predicate compares implicit HTTP port 80 with the actual socket port', () => {
    for (const authority of ['localhost', 'LOCALHOST', '127.0.0.1', '127.0.0.2', '[::1]', '[0:0:0:0:0:0:0:1]']) {
        assert.equal(isLoopbackAuthority(authority, 80), true, authority)
        assert.equal(isLoopbackAuthority(`${authority}:80`, 80), true, authority)
        assert.equal(isLoopbackAuthority(authority, 8080), false, authority)
        assert.equal(isLoopbackAuthority(`${authority}:80`, 8080), false, authority)
        assert.equal(isLoopbackAuthority(`${authority}:8080`, 80), false, authority)
    }
    for (const authority of ['foreign.invalid', '127.1', 'localhost:080', 'localhost:', '[::2]'])
        assert.equal(isLoopbackAuthority(authority, 80), false, authority)
})

test('bridge-absent management HTTP and MQTT share live inventory, provisioning linkage and the exclusive queue', async () => {
    const { RouterConfigStore } = await import('@/router/config-store')
    const { DeviceMQTTAccess } = await import('@/cloud/mqtt-access')
    const { Broker } = await import('@/cloud/mqtt-broker')
    const { DeviceAcceptor } = await import('@/cloud/thinq2/device')
    const { createServer, createConnection } = await import('node:net')
    const { MqttClient } = await import('mqtt')
    const directory = await mkdtemp(path.join(tmpdir(), 'rethink-shared-mqtt-'))
    const store = new RouterConfigStore(path.join(directory, 'router.json'))
    const manager = new DeviceManager(),
        broker = new Broker(new DeviceMQTTAccess(() => store.devices()))
    const acceptor = new DeviceAcceptor(broker)
    acceptor.on('newDevice', (device) => manager.accept(device))
    const management = app(fakeHA(), manager, undefined, store.filename, store)
    const mqttServer = createServer((socket) => broker.accept(socket))
    await Promise.all([
        new Promise<void>((resolve) => management.listen(0, '127.0.0.1', resolve)),
        new Promise<void>((resolve) => mqttServer.listen(0, '127.0.0.1', resolve)),
    ])
    const address = management.address(),
        mqttAddress = mqttServer.address()
    assert(address && typeof address === 'object' && mqttAddress && typeof mqttAddress === 'object')
    const url = `http://127.0.0.1:${address.port}`
    const call = (method: string, route: string, body?: object) =>
        fetch(`${url}${route}`, {
            method,
            headers: { 'content-type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
        })
    const client = new MqttClient(
        () => createConnection({ host: '127.0.0.1', port: mqttAddress.port, localAddress: '127.0.0.2' }),
        { reconnectPeriod: 0, manualConnect: true },
    )
    client.on('error', () => {})
    try {
        let unlock = () => {}
        const held = store.exclusive(
            () =>
                new Promise<void>((resolve) => {
                    unlock = resolve
                }),
        )
        await new Promise<void>((resolve) => setImmediate(resolve))
        let added = false
        const adding = call('POST', '/api/router/devices', { ip: '127.0.0.2', mode: 'local' }).then((response) => {
            added = true
            return response
        })
        await new Promise<void>((resolve) => setTimeout(resolve, 25))
        assert.equal(added, false, 'HTTP uses the same exclusive queue')
        unlock()
        await held
        const response = await adding
        assert.equal(response.status, 201)
        const entry = (await response.json()) as { entryId: string }
        assert.equal(store.devices().length, 1)
        const connected = new Promise<void>((resolve, reject) => {
            client.once('connect', () => resolve())
            client.once('error', reject)
        })
        client.connect()
        await connected
        await new Promise<void>((resolve, reject) =>
            client.subscribe('lime/devices/shared', (error) => (error ? reject(error) : resolve())),
        )
        const publish = (topic: string, value: object) =>
            new Promise<void>((resolve, reject) =>
                client.publish(topic, JSON.stringify(value), { qos: 1 }, (error) =>
                    error ? reject(error) : resolve(),
                ),
            )
        await publish('clip/provisioning/devices/shared', {
            did: 'shared',
            cmd: 'deploy',
            kind: 'TEST',
            data: { appInfo: { modelName: 'TEST' } },
        })
        await publish('clip/message/devices/shared', { did: 'shared', cmd: 'completeProvisioning_ack' })
        await store.exclusive(async () => {})
        assert.equal(store.devices()[0].deviceId, 'shared')
        const linked = manager.allDevices.get('shared')
        assert(linked && 'sourceIp' in linked)
        assert.equal(linked.sourceIp, '127.0.0.2')
        const peer = [...broker.clients][0]
        assert.equal((await call('DELETE', `/api/router/devices/${entry.entryId}/link`)).status, 200)
        assert.equal(
            broker.publish(
                {
                    topic: 'clip/message/devices/shared',
                    payload: '{"did":"shared"}',
                    qos: 0,
                    retain: false,
                    dup: false,
                },
                peer,
            ),
            false,
        )
        assert.equal((await call('DELETE', `/api/router/devices/${entry.entryId}`)).status, 204)
        assert.equal(store.devices().length, 0)
    } finally {
        client.end(true)
        for (const peer of broker.clients) peer.destroy(true)
        await Promise.all([
            new Promise<void>((resolve) => management.close(() => resolve())),
            new Promise<void>((resolve) => mqttServer.close(() => resolve())),
        ])
        await rm(directory, { recursive: true, force: true })
    }
})
