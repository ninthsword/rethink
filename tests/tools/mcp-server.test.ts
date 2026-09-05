import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, test } from 'node:test'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'

const stdinEvents = ['data', 'end', 'error', 'close', 'readable'] as const
const stdinListenersBeforeImport = stdinEvents.map((event) => process.stdin.listenerCount(event))
const mcpServer = await import('@/tools/mcp-server')
const stdinListenersAfterImport = stdinEvents.map((event) => process.stdin.listenerCount(event))
const { CloudFeedController, DeviceCaptureController, canonicalizeManagementAuthority } = mcpServer

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
    readonly sendArgs: string[] = []

    close(): void {
        this.closeCalls++
    }

    send(data: string): void {
        this.sendArgs.push(data)
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

const acceptedAuthorities = [
    ['localhost', '127.0.0.1:44401'],
    ['localhost:1', '127.0.0.1:1'],
    ['localhost:65535', '127.0.0.1:65535'],
    ['127.0.0.1', '127.0.0.1:44401'],
    ['127.0.0.1:80', '127.0.0.1:80'],
    ['[::1]', '[::1]:44401'],
    ['[::1]:44401', '[::1]:44401'],
    ['[::1]:65535', '[::1]:65535'],
] as const

const rejectedAuthorities = [
    '',
    ' localhost',
    'localhost ',
    'localhost\t',
    'localhost\n',
    'LOCALHOST',
    'localhost.',
    'example.test',
    '127.0.0.2',
    '127.1',
    '2130706433',
    '0x7f000001',
    '0177.0.0.1',
    '::1',
    '[0:0:0:0:0:0:0:1]',
    '[::ffff:127.0.0.1]',
    '[::1%lo]',
    '[::1',
    '::1]',
    '[[::1]]',
    'http://localhost',
    'localhost@127.0.0.1',
    'localhost/path',
    'localhost?port=1',
    'localhost#fragment',
    'localhost:',
    'localhost:0',
    'localhost:01',
    'localhost:00001',
    'localhost:+1',
    'localhost:-1',
    'localhost:1e2',
    'localhost:65536',
    'localhost:99999',
    'localhost:１２３',
    'localhost:1:2',
    '[::1]:',
    '[::1]:00',
    '[::1]:65536',
    '[::1]:1/path',
] as const

test('import is inert and exposes only the controllers and pure authority parser', () => {
    assert.deepEqual(stdinListenersAfterImport, stdinListenersBeforeImport)
    assert.deepEqual(Object.keys(mcpServer).sort(), [
        'CloudFeedController',
        'DeviceCaptureController',
        'canonicalizeManagementAuthority',
    ])
})

describe('canonicalizeManagementAuthority', () => {
    for (const [authority, expected] of acceptedAuthorities) {
        test(`canonicalizes ${authority}`, () => {
            assert.equal(canonicalizeManagementAuthority(authority), expected)
        })
    }

    for (const authority of rejectedAuthorities) {
        test(`rejects ${JSON.stringify(authority)}`, () => {
            assert.throws(() => canonicalizeManagementAuthority(authority), /management authority/)
        })
    }
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
    for (const authority of rejectedAuthorities) {
        test(`rejects ${JSON.stringify(authority)} before every socket factory`, async () => {
            const { controller, urls } = captureHarness()

            await assert.rejects(async () => controller.start(authority, 'device-1'), /management authority/)
            await assert.rejects(controller.snapshot(authority), /management authority/)
            await assert.rejects(controller.inject(authority, 'device-1', 'fromDevice', 'aabb'), /management authority/)
            assert.equal(urls.length, 0)
        })
    }

    test('snapshot uses the canonical IPv6 URL and closes after the first object', async () => {
        const { controller, sockets, urls } = captureHarness()
        const pending = controller.snapshot('[::1]:44402')

        assert.equal(sockets.length, 1)
        const url = new URL(urls[0])
        assert.equal(url.protocol, 'ws:')
        assert.equal(url.hostname, '[::1]')
        assert.equal(url.port, '44402')
        assert.equal(url.pathname, '/ws')
        assert.equal(url.search, '')

        const expected = { ha: 'connected', bridge: { status: 'ready' }, devices: { one: { online: true } } }
        emitMessage(sockets[0], expected)
        assert.deepEqual(await pending, expected)
        assert.equal(sockets[0].closeCalls, 1)
    })

    test('snapshot timeout closes the socket and rejects once', async (t) => {
        enableMockTimers(t)
        const { controller, sockets } = captureHarness()
        const pending = controller.snapshot('localhost')

        tickMockTimers(t, 50)
        await assert.rejects(pending, /timed out connecting to the management \/ws/)
        assert.equal(sockets[0].closeCalls, 1)
    })

    for (const direction of ['fromDevice', 'toDevice'] as const) {
        test(`inject ${direction} uses the canonical URL and matching acknowledgement`, async () => {
            const { controller, sockets, urls } = captureHarness()
            const pending = controller.inject('localhost:44402', 'device / one', direction, 'AaBb')

            assert.equal(sockets.length, 1)
            const url = new URL(urls[0])
            assert.equal(url.protocol, 'ws:')
            assert.equal(url.hostname, '127.0.0.1')
            assert.equal(url.port, '44402')
            assert.equal(url.pathname, '/device')
            assert.equal(url.searchParams.get('id'), 'device / one')
            assert.deepEqual([...url.searchParams.keys()], ['id'])

            sockets[0].emit('open')
            const sendKey = direction === 'fromDevice' ? 'sendFromDevice' : 'sendToDevice'
            const echoKey = direction === 'fromDevice' ? 'rx' : 'tx'
            assert.deepEqual(JSON.parse(sockets[0].sendArgs[0]), { [sendKey]: 'AaBb' })

            let settled = false
            void pending.then(
                () => {
                    settled = true
                },
                () => {
                    settled = true
                },
            )
            emitMessage(sockets[0], { injected: false, [echoKey]: 'aabb' })
            emitMessage(sockets[0], { injected: true, [echoKey]: 'different' })
            await Promise.resolve()
            assert.equal(settled, false)

            emitMessage(sockets[0], { injected: true, [echoKey]: 'aabb' })
            await pending
            assert.equal(sockets[0].closeCalls, 1)

            emitMessage(sockets[0], { injected: true, [echoKey]: 'aabb' })
            sockets[0].emit('error', new Error('late duplicate error'))
            assert.equal(sockets[0].closeCalls, 1)
        })
    }

    test('inject timeout rejects and closes the socket once', async (t) => {
        enableMockTimers(t)
        const { controller, sockets } = captureHarness()
        const pending = controller.inject('[::1]', 'device-1', 'fromDevice', 'aabb')

        tickMockTimers(t, 50)
        await assert.rejects(pending, /inject not acknowledged/)
        assert.equal(sockets[0].closeCalls, 1)
    })

    test('concurrent starts create one socket and stop settles the pending start', async (t) => {
        enableMockTimers(t)
        const { controller, sockets, urls } = captureHarness()

        const first = controller.start('localhost', 'device / one')
        const concurrent = controller.start('127.0.0.1:44401', 'device / one')

        assert.equal(await concurrent, 'already-capturing')
        assert.equal(sockets.length, 1)
        const url = new URL(urls[0])
        assert.equal(url.protocol, 'ws:')
        assert.equal(url.hostname, '127.0.0.1')
        assert.equal(url.port, '44401')
        assert.equal(url.pathname, '/device')
        assert.equal(url.searchParams.get('id'), 'device / one')
        assert.deepEqual([...url.searchParams.keys()], ['id'])

        controller.stop('device / one')
        assert.equal(await first, 'stopped')
        assert.equal(controller.has('device / one'), false)
        assert.equal(sockets[0].closeCalls, 1)
    })

    test('invalid authority is rejected before the duplicate capture shortcut', async () => {
        const { controller, sockets } = captureHarness()
        const started = controller.start('localhost', 'device-1')
        emitMessage(sockets[0], { status: 'online' })
        assert.equal(await started, 'online')

        await assert.rejects(async () => controller.start('example.test', 'device-1'), /management authority/)
        assert.equal(sockets.length, 1)
        assert.equal(controller.has('device-1'), true)

        controller.stop('device-1')
        assert.equal(sockets[0].closeCalls, 1)
    })

    test('status cancels the startup timeout while retaining the active capture', async (t) => {
        enableMockTimers(t)
        const { controller, sockets } = captureHarness()
        const started = controller.start('[::1]:44401', 'device-1')

        emitMessage(sockets[0], { status: 'online' })
        assert.equal(await started, 'online')
        tickMockTimers(t, 100)

        assert.equal(controller.has('device-1'), true)
        assert.deepEqual(controller.ids(), ['device-1'])
        assert.equal(sockets[0].closeCalls, 0)
        assert.equal(await controller.start('localhost', 'device-1'), 'already-capturing')
        assert.equal(sockets.length, 1)

        controller.stop('device-1')
        assert.equal(sockets[0].closeCalls, 1)
    })

    test('timeout resolves unknown, closes once, and permits retry', async (t) => {
        enableMockTimers(t)
        const { controller, sockets } = captureHarness()
        const started = controller.start('127.0.0.1', 'device-1')

        tickMockTimers(t, 50)
        assert.equal(await started, 'unknown')
        assert.equal(controller.has('device-1'), false)
        assert.equal(sockets[0].closeCalls, 1)

        sockets[0].emit('close')
        tickMockTimers(t, 100)
        assert.equal(sockets[0].closeCalls, 1)

        const retry = controller.start('localhost', 'device-1')
        assert.equal(sockets.length, 2)
        controller.stop('device-1')
        assert.equal(await retry, 'stopped')
        assert.equal(sockets[1].closeCalls, 1)
    })

    test('an early close settles closed and releases the slot', async (t) => {
        enableMockTimers(t)
        const { controller, sockets } = captureHarness()
        const started = controller.start('[::1]', 'device-1')

        sockets[0].emit('close')
        assert.equal(await started, 'closed')
        assert.equal(controller.has('device-1'), false)
        tickMockTimers(t, 100)
        assert.equal(sockets[0].closeCalls, 0)

        const retry = controller.start('localhost', 'device-1')
        controller.stop('device-1')
        assert.equal(await retry, 'stopped')
    })

    test('an early error rejects promptly, closes once, and releases the slot', async (t) => {
        enableMockTimers(t)
        const { controller, sockets } = captureHarness()
        const started = controller.start('127.0.0.1', 'device-1')

        sockets[0].emit('error', new Error('synthetic socket failure'))
        await assert.rejects(started, /synthetic socket failure/)
        assert.equal(controller.has('device-1'), false)
        assert.equal(sockets[0].closeCalls, 1)
        tickMockTimers(t, 100)
        assert.equal(sockets[0].closeCalls, 1)

        const retry = controller.start('localhost', 'device-1')
        controller.stop('device-1')
        assert.equal(await retry, 'stopped')
    })

    test('stop one and stop all settle every pending capture once', async (t) => {
        enableMockTimers(t)
        const { controller, sockets } = captureHarness()
        const first = controller.start('localhost', 'device-1')
        const second = controller.start('127.0.0.1', 'device-2')
        const third = controller.start('[::1]', 'device-3')

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

        const first = controller.start('localhost', 'device-1')
        controller.stop('device-1')
        assert.equal(await first, 'stopped')

        const replacement = controller.start('127.0.0.1', 'device-1')
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
