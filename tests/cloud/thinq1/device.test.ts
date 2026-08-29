import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { DeviceAcceptor } from '@/cloud/thinq1/device'
import { routes } from '@/cloud/thinq1/http'
import type { Config } from '@/util/config'
import { make as makeFrame } from '@/util/length_prefixed_frame'

test('ThinQ1 DeviceAcceptor stores prototype-like identifiers in its connection Map', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'rethink-thinq1-device-'))
    writeFileSync(
        path.join(directory, 'thinq1-metadata.json'),
        '{"__proto__":{"deviceType":"403","modelId":"proto","modelName":"Prototype"},"toString":{"deviceType":"403","modelId":"string","modelName":"String"}}',
    )
    routes({ bridge: { storage_path: directory } } as Config)

    const acceptor = new DeviceAcceptor()
    const prototypeSocket = new PassThrough()
    const stringSocket = new PassThrough()
    acceptor.accept(prototypeSocket)
    acceptor.accept(stringSocket)

    try {
        const announce = (id: string) =>
            makeFrame(JSON.stringify({ Header: { 'x-lgedm-deviceId': id }, Body: { ReturnCode: '0000' } }))
        prototypeSocket.write(announce('__proto__'))
        stringSocket.write(announce('toString'))

        assert.equal(acceptor.connectionsById.has('__proto__'), true)
        assert.equal(acceptor.connectionsById.has('toString'), true)
        assert.equal(acceptor.connectionsById.size, 2)

        prototypeSocket.emit('close')
        assert.equal(acceptor.connectionsById.has('__proto__'), false)
        assert.equal(acceptor.connectionsById.has('toString'), true)
    } finally {
        prototypeSocket.destroy()
        stringSocket.destroy()
        rmSync(directory, { recursive: true, force: true })
    }
})

test('ThinQ1 DeviceAcceptor preserves valid legacy ids and rejects unsafe ids', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'rethink-thinq1-device-'))
    writeFileSync(
        path.join(directory, 'thinq1-metadata.json'),
        '{"legacy-id":{"deviceType":"403","modelId":"legacy","modelName":"Legacy"},"id/child":{"deviceType":"403","modelId":"unsafe","modelName":"Unsafe"}}',
    )
    routes({ bridge: { storage_path: directory } } as Config)

    const acceptor = new DeviceAcceptor()
    const validSocket = new PassThrough()
    const unsafeSocket = new PassThrough()
    acceptor.accept(validSocket)
    acceptor.accept(unsafeSocket)

    try {
        const announce = (id: string) =>
            makeFrame(JSON.stringify({ Header: { 'x-lgedm-deviceId': id }, Body: { ReturnCode: '0000' } }))
        validSocket.write(announce('legacy-id'))
        unsafeSocket.write(announce('id/child'))

        assert.equal(acceptor.connectionsById.has('legacy-id'), true)
        assert.equal(acceptor.connectionsById.has('id/child'), false)
        assert.equal(acceptor.connectionsById.size, 1)
    } finally {
        validSocket.destroy()
        unsafeSocket.destroy()
        rmSync(directory, { recursive: true, force: true })
    }
})
