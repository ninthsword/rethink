import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Broker, idleTimeoutFor } from '@/cloud/mqtt-broker'
import type { Socket } from 'node:net'

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
