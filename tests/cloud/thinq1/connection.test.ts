import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { Connection } from '@/cloud/thinq1/connection'
import { make as makeFrame } from '@/util/length_prefixed_frame'

function request(id: unknown, body: object = { ReturnCode: '0000' }) {
    return makeFrame(
        JSON.stringify({
            Header: { 'x-lgedm-deviceId': id },
            Body: body,
        }),
    )
}

function connectionWithErrors(socket: PassThrough) {
    const connection = new Connection(socket)
    const errors: Error[] = []
    connection.on('error', (error) => errors.push(error))
    return { connection, errors }
}

function nextTurn() {
    return new Promise<void>((resolve) => setImmediate(resolve))
}

test('malformed JSON destroys only its socket and a later valid socket works', () => {
    const brokenSocket = new PassThrough()
    const { errors } = connectionWithErrors(brokenSocket)
    brokenSocket.write(makeFrame('{'))

    assert.equal(errors.length, 1)
    assert.match(errors[0].message, /JSON/)
    assert.equal(brokenSocket.destroyed, true)

    const validSocket = new PassThrough()
    const valid = new Connection(validSocket)
    const responses: Record<string, unknown>[] = []
    valid.on('response', (body) => responses.push(body))
    validSocket.write(request('device-1'))

    assert.deepEqual(responses, [{ ReturnCode: '0000' }])
    valid.destroy()
})

test('invalid device ids and framing errors emit one normalized error and destroy', () => {
    const cases: [Buffer, RegExp][] = [
        [request(42), /Invalid ThinQ1 device id/],
        [Buffer.from([0xff, 0xff, 0xff, 0xff]), /cannot be negative/],
        [Buffer.from([0x00, 0x01, 0x00, 0x01]), /Payload length exceeded/],
    ]

    for (const [payload, message] of cases) {
        const socket = new PassThrough()
        const { connection, errors } = connectionWithErrors(socket)
        socket.write(payload)

        assert.equal(errors.length, 1)
        assert.match(errors[0].message, message)
        assert.equal(socket.destroyed, true)
        connection.destroy()
    }
})

test('socket end reports a truncated pending frame once', async () => {
    const socket = new PassThrough()
    const { connection, errors } = connectionWithErrors(socket)
    socket.write(Buffer.from([0x00, 0x00, 0x00, 0x05, 0x01]))
    socket.end()
    await nextTurn()

    assert.equal(errors.length, 1)
    assert.match(errors[0].message, /Truncated length-prefixed frame/)
    connection.destroy()
})
