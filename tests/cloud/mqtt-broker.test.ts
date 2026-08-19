import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Broker } from '@/cloud/mqtt-broker'
import type { Socket } from 'node:net'

function fakeSocket(record: string[]): Socket {
    return {
        remoteAddress: '192.168.1.71',
        setTimeout() {},
        on() {},
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
    broker.shutdown()
    assert.deepEqual(record, ['reset', 'reset'])
})

test('shutdown falls back to a plain close where reset is unavailable', () => {
    const record: string[] = []
    const broker = new Broker()
    const socket = fakeSocket(record) as unknown as Record<string, unknown>
    delete socket.resetAndDestroy
    broker.accept(socket as unknown as Socket)

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
    broker.shutdown()
    assert.deepEqual(record, ['destroy', 'reset'])
})
