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
import { app, serializeDeviceEntries } from '@/management/index'

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

async function createMonitorFixture() {
    const directory = await mkdtemp(path.join(tmpdir(), 'rethink-management-monitor-'))
    const manager = new DeviceManager()
    const deviceId = 'synthetic-device'
    const device = acceptDevice(manager, deviceId)
    const server = app(fakeHA(), manager, undefined, path.join(directory, 'missing-router-config.json'))
    const sockets = new Set<Socket>()
    const clients = new Set<WebSocket>()

    server.on('connection', (socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert(address && typeof address === 'object')
    const port = address.port

    const managerBaseline = {
        newDevice: manager.listenerCount('newDevice'),
        dropDevice: manager.listenerCount('dropDevice'),
    }

    async function openMonitor() {
        const client = new WebSocket(`ws://127.0.0.1:${port}/device?id=${deviceId}`)
        clients.add(client)
        client.on('close', () => clients.delete(client))
        client.on('error', () => {})

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
        return client
    }

    async function closeClient(client: WebSocket) {
        if (client.readyState === WebSocket.CLOSED) return
        const closed = new Promise<void>((resolve) => client.once('close', () => resolve()))
        client.close()
        await closed
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

    return { cleanup, closeClient, device, deviceId, manager, managerBaseline, openMonitor }
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
