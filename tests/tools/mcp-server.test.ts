import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, test } from 'node:test'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'

const stdinEvents = ['data', 'end', 'error', 'close', 'readable'] as const
const stdinListenersBeforeImport = stdinEvents.map((event) => process.stdin.listenerCount(event))
const mcpServer = await import('@/tools/mcp-server')
const stdinListenersAfterImport = stdinEvents.map((event) => process.stdin.listenerCount(event))
const { CloudFeedController, DeviceCaptureController } = mcpServer

const cloudState = { countryCode: 'ZZ', refreshToken: '' }

class FakeCloudClient {
    readonly endArgs: (boolean | undefined)[] = []

    end(force?: boolean): void {
        this.endArgs.push(force)
    }
}

type Deferred<T> = {
    promise: Promise<T>
    resolve(value: T): void
    reject(error: Error): void
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void
    let reject!: (error: Error) => void
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, resolve, reject }
}

class FakeSocket extends EventEmitter {
    closeCalls = 0

    close(): void {
        this.closeCalls++
    }
}

function captureHarness(timeoutMs = 50) {
    const sockets: FakeSocket[] = []
    const urls: string[] = []
    const socketFactory: ConstructorParameters<typeof DeviceCaptureController>[0] = (url) => {
        const socket = new FakeSocket()
        sockets.push(socket)
        urls.push(url)
        return socket
    }
    return { controller: new DeviceCaptureController(socketFactory, timeoutMs), sockets, urls }
}

function emitMessage(socket: FakeSocket, value: unknown): void {
    socket.emit('message', Buffer.from(JSON.stringify(value)))
}

test('import is inert and exposes only the two controller seams', () => {
    assert.deepEqual(stdinListenersAfterImport, stdinListenersBeforeImport)
    assert.deepEqual(Object.keys(mcpServer).sort(), ['CloudFeedController', 'DeviceCaptureController'])
})

describe('CloudFeedController', () => {
    test('missing state reports unavailable and a later start retries', async (t) => {
        t.mock.method(console, 'error', () => undefined)
        let stateCalls = 0
        let connectCalls = 0
        const client = new FakeCloudClient()
        const controller = new CloudFeedController(
            () => {
                stateCalls++
                return stateCalls === 1 ? undefined : cloudState
            },
            async () => {
                connectCalls++
                return client
            },
        )

        assert.equal(await controller.status(), 'disabled')
        assert.equal(await controller.ensure(), 'unavailable')
        assert.equal(await controller.status(), 'unavailable')
        assert.equal(connectCalls, 0)

        assert.equal(await controller.ensure(), 'connected')
        assert.equal(connectCalls, 1)
        assert.equal(await controller.status(), 'connected')

        controller.stop()
        assert.deepEqual(client.endArgs, [true])
        assert.equal(await controller.status(), 'disabled')
    })

    test('a rejected connector reports unavailable and releases the retry slot', async (t) => {
        t.mock.method(console, 'error', () => undefined)
        let connectCalls = 0
        const client = new FakeCloudClient()
        const controller = new CloudFeedController(
            () => cloudState,
            async () => {
                connectCalls++
                if (connectCalls === 1) throw new Error('synthetic connect failure')
                return client
            },
        )

        assert.equal(await controller.ensure(), 'unavailable')
        assert.equal(await controller.status(), 'unavailable')
        assert.equal(await controller.ensure(), 'connected')
        assert.equal(connectCalls, 2)

        controller.stop()
        assert.deepEqual(client.endArgs, [true])
    })

    test('concurrent starts share the exact connection promise', async () => {
        const pending = deferred<FakeCloudClient>()
        const client = new FakeCloudClient()
        let connectCalls = 0
        const controller = new CloudFeedController(
            () => cloudState,
            () => {
                connectCalls++
                return pending.promise
            },
        )

        const first = controller.ensure()
        const concurrent = controller.ensure()
        assert.strictEqual(concurrent, first)
        assert.equal(connectCalls, 1)

        pending.resolve(client)
        assert.equal(await first, 'connected')
        assert.strictEqual(controller.ensure(), first)

        controller.stop()
        assert.deepEqual(client.endArgs, [true])
    })

    test('a newer connection can resolve before the stopped attempt without being replaced', async () => {
        const oldConnect = deferred<FakeCloudClient>()
        const newConnect = deferred<FakeCloudClient>()
        const connects = [oldConnect, newConnect]
        let connectIndex = 0
        const oldClient = new FakeCloudClient()
        const newClient = new FakeCloudClient()
        const controller = new CloudFeedController(
            () => cloudState,
            () => connects[connectIndex++].promise,
        )

        const first = controller.ensure()
        controller.stop()
        const replacement = controller.ensure()

        newConnect.resolve(newClient)
        assert.equal(await replacement, 'connected')
        oldConnect.resolve(oldClient)
        assert.equal(await first, 'unavailable')

        assert.deepEqual(oldClient.endArgs, [true])
        assert.deepEqual(newClient.endArgs, [])
        assert.equal(await controller.status(), 'connected')
        assert.strictEqual(controller.ensure(), replacement)

        controller.stop()
        assert.deepEqual(newClient.endArgs, [true])
    })

    test('a stale rejection cannot clear a successful replacement', async (t) => {
        t.mock.method(console, 'error', () => undefined)
        const oldConnect = deferred<FakeCloudClient>()
        const newConnect = deferred<FakeCloudClient>()
        const connects = [oldConnect, newConnect]
        let connectIndex = 0
        const newClient = new FakeCloudClient()
        const controller = new CloudFeedController(
            () => cloudState,
            () => connects[connectIndex++].promise,
        )

        const first = controller.ensure()
        controller.stop()
        const replacement = controller.ensure()
        newConnect.resolve(newClient)
        assert.equal(await replacement, 'connected')

        oldConnect.reject(new Error('synthetic stale failure'))
        assert.equal(await first, 'unavailable')
        assert.equal(await controller.status(), 'connected')
        assert.strictEqual(controller.ensure(), replacement)

        controller.stop()
        assert.deepEqual(newClient.endArgs, [true])
    })
})

describe('DeviceCaptureController', () => {
    test('concurrent starts create one socket and stop settles the pending start', async (t) => {
        enableMockTimers(t)
        const { controller, sockets, urls } = captureHarness()

        const first = controller.start('example.test', 'device / one')
        const concurrent = controller.start('example.test', 'device / one')

        assert.equal(await concurrent, 'already-capturing')
        assert.equal(sockets.length, 1)
        assert.deepEqual(urls, ['ws://example.test:44401/device?id=device%20%2F%20one'])

        controller.stop('device / one')
        assert.equal(await first, 'stopped')
        assert.equal(controller.has('device / one'), false)
        assert.equal(sockets[0].closeCalls, 1)
    })

    test('status cancels the startup timeout while retaining the active capture', async (t) => {
        enableMockTimers(t)
        const { controller, sockets } = captureHarness()
        const started = controller.start('example.test:44401', 'device-1')

        emitMessage(sockets[0], { status: 'online' })
        assert.equal(await started, 'online')
        tickMockTimers(t, 100)

        assert.equal(controller.has('device-1'), true)
        assert.deepEqual(controller.ids(), ['device-1'])
        assert.equal(sockets[0].closeCalls, 0)
        assert.equal(await controller.start('example.test', 'device-1'), 'already-capturing')
        assert.equal(sockets.length, 1)

        controller.stop('device-1')
        assert.equal(sockets[0].closeCalls, 1)
    })

    test('timeout resolves unknown, closes once, and permits retry', async (t) => {
        enableMockTimers(t)
        const { controller, sockets } = captureHarness()
        const started = controller.start('example.test', 'device-1')

        tickMockTimers(t, 50)
        assert.equal(await started, 'unknown')
        assert.equal(controller.has('device-1'), false)
        assert.equal(sockets[0].closeCalls, 1)

        sockets[0].emit('close')
        tickMockTimers(t, 100)
        assert.equal(sockets[0].closeCalls, 1)

        const retry = controller.start('example.test', 'device-1')
        assert.equal(sockets.length, 2)
        controller.stop('device-1')
        assert.equal(await retry, 'stopped')
        assert.equal(sockets[1].closeCalls, 1)
    })

    test('an early close settles closed and releases the slot', async (t) => {
        enableMockTimers(t)
        const { controller, sockets } = captureHarness()
        const started = controller.start('example.test', 'device-1')

        sockets[0].emit('close')
        assert.equal(await started, 'closed')
        assert.equal(controller.has('device-1'), false)
        tickMockTimers(t, 100)
        assert.equal(sockets[0].closeCalls, 0)

        const retry = controller.start('example.test', 'device-1')
        controller.stop('device-1')
        assert.equal(await retry, 'stopped')
    })

    test('an early error rejects promptly, closes once, and releases the slot', async (t) => {
        enableMockTimers(t)
        const { controller, sockets } = captureHarness()
        const started = controller.start('example.test', 'device-1')

        sockets[0].emit('error', new Error('synthetic socket failure'))
        await assert.rejects(started, /synthetic socket failure/)
        assert.equal(controller.has('device-1'), false)
        assert.equal(sockets[0].closeCalls, 1)
        tickMockTimers(t, 100)
        assert.equal(sockets[0].closeCalls, 1)

        const retry = controller.start('example.test', 'device-1')
        controller.stop('device-1')
        assert.equal(await retry, 'stopped')
    })

    test('stop one and stop all settle every pending capture once', async (t) => {
        enableMockTimers(t)
        const { controller, sockets } = captureHarness()
        const first = controller.start('example.test', 'device-1')
        const second = controller.start('example.test', 'device-2')
        const third = controller.start('example.test', 'device-3')

        controller.stop('device-2')
        assert.equal(await second, 'stopped')
        assert.deepEqual(controller.ids(), ['device-1', 'device-3'])

        controller.stop()
        assert.deepEqual(await Promise.all([first, third]), ['stopped', 'stopped'])
        assert.deepEqual(controller.ids(), [])
        assert.deepEqual(
            sockets.map((socket) => socket.closeCalls),
            [1, 1, 1],
        )
    })

    test('late old events cannot settle, erase, or write through a replacement', async (t) => {
        enableMockTimers(t)
        let nowCalls = 0
        t.mock.method(Date, 'now', () => {
            nowCalls++
            return 1
        })
        const { controller, sockets } = captureHarness()

        const first = controller.start('example.test', 'device-1')
        controller.stop('device-1')
        assert.equal(await first, 'stopped')

        const replacement = controller.start('example.test', 'device-1')
        let replacementSettled = false
        void replacement.then(
            () => {
                replacementSettled = true
            },
            () => {
                replacementSettled = true
            },
        )

        emitMessage(sockets[0], { rx: 'late-old-frame' })
        emitMessage(sockets[0], { status: 'offline' })
        sockets[0].emit('close')
        sockets[0].emit('error', new Error('late old error'))
        await Promise.resolve()

        assert.equal(nowCalls, 0)
        assert.equal(replacementSettled, false)
        assert.equal(controller.has('device-1'), true)
        assert.equal(sockets[0].closeCalls, 1)

        emitMessage(sockets[1], { status: 'online' })
        assert.equal(await replacement, 'online')
        sockets[0].emit('close')
        sockets[0].emit('error', new Error('later old error'))
        assert.equal(controller.has('device-1'), true)

        controller.stop('device-1')
        assert.equal(sockets[0].closeCalls, 1)
        assert.equal(sockets[1].closeCalls, 1)
    })
})
