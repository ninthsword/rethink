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
