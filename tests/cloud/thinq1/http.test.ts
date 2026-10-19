import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Metadata } from '@/cloud/thinq'
import { getDeviceMetadata, routes } from '@/cloud/thinq1/http'
import type { Config } from '@/util/config'

function metadataRoute(directory: string) {
    const router = routes({ bridge: { storage_path: directory } } as Config)
    const stack = (
        router as unknown as {
            stack: Array<{
                route?: { path: string; stack: Array<{ handle: (req: unknown, res: unknown) => unknown }> }
            }>
        }
    ).stack
    const layer = stack.find((item) => item.route?.path === '/lgehadm/api/Device/TotalDeviceInfoSvc')
    assert.ok(layer?.route)
    return layer.route.stack[0].handle
}

test('ThinQ1 metadata lookup does not expose object prototype properties', () => {
    assert.equal(getDeviceMetadata('__proto__'), undefined)
    assert.equal(getDeviceMetadata('toString'), undefined)
})

test('ThinQ1 metadata persistence uses a Map and plain-object serialization', () => {
    const source = readFileSync('cloud/thinq1/http.ts', 'utf-8')
    assert.match(source, /new Map<string, Metadata>\(\)/)
    assert.match(source, /Object\.fromEntries\(deviceMeta\)/)
})

test('ThinQ1 metadata loads and stores __proto__ as an ordinary device id', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rethink-thinq1-metadata-'))
    const metadataPath = join(directory, 'thinq1-metadata.json')
    writeFileSync(metadataPath, '{"__proto__":{"deviceType":"403","modelId":"initial","modelName":"Initial"}}')

    try {
        const router = routes({ bridge: { storage_path: directory } } as Config)
        assert.deepEqual(getDeviceMetadata('__proto__'), {
            deviceType: '403',
            modelId: 'initial',
            modelName: 'Initial',
        })
        assert.equal(getDeviceMetadata('toString'), undefined)

        const stack = (
            router as unknown as {
                stack: Array<{
                    route?: { path: string; stack: Array<{ handle: (req: unknown, res: unknown) => unknown }> }
                }>
            }
        ).stack
        const layer = stack.find((item) => item.route?.path === '/lgehadm/api/Device/TotalDeviceInfoSvc')
        assert.ok(layer?.route)
        const response = {
            header: () => response,
            end: () => undefined,
            status: () => response,
        }
        layer.route.stack[0].handle(
            {
                headers: { 'x-lgedm-deviceid': '__proto__', 'x-lgedm-devicetype': '403' },
                body: { lgedmRoot: { modelName: 'updated' } },
            },
            response,
        )

        assert.equal(getDeviceMetadata('__proto__')?.modelName, 'updated')
        const saved = JSON.parse(readFileSync(metadataPath, 'utf-8')) as Record<string, Metadata>
        const savedProtoDescriptor = Object.getOwnPropertyDescriptor(saved, '__proto__')
        assert.ok(savedProtoDescriptor)
        const savedProto = savedProtoDescriptor.value as Metadata
        assert.equal(savedProto?.modelName, 'updated')
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

test('ThinQ1 metadata ignores unsafe persisted device ids', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rethink-thinq1-metadata-'))
    const metadataPath = join(directory, 'thinq1-metadata.json')
    writeFileSync(
        metadataPath,
        '{"id/child":{"deviceType":"403","modelId":"unsafe","modelName":"Unsafe"},"legacy-id":{"deviceType":"403","modelId":"legacy","modelName":"Legacy"},"__proto__":{"deviceType":"403","modelId":"proto","modelName":"Prototype"},"toString":{"deviceType":"403","modelId":"string","modelName":"String"}}',
    )

    try {
        routes({ bridge: { storage_path: directory } } as Config)
        assert.equal(getDeviceMetadata('id/child'), undefined)
        assert.deepEqual(getDeviceMetadata('legacy-id'), {
            deviceType: '403',
            modelId: 'legacy',
            modelName: 'Legacy',
        })
        assert.deepEqual(getDeviceMetadata('__proto__'), {
            deviceType: '403',
            modelId: 'proto',
            modelName: 'Prototype',
        })
        assert.deepEqual(getDeviceMetadata('toString'), {
            deviceType: '403',
            modelId: 'string',
            modelName: 'String',
        })
        assert.equal(readFileSync(metadataPath, 'utf-8').includes('id/child'), true)
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

test('ThinQ1 metadata ignores non-string, empty, and oversized fields', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rethink-thinq1-metadata-'))
    const handle = metadataRoute(directory)
    const response = {
        header: () => response,
        end: () => undefined,
        status: () => response,
    }
    const cases: unknown[] = [{ modelName: { nested: 'MODEL' } }, { modelName: '' }, { modelName: 'x'.repeat(129) }]

    try {
        for (const body of cases) {
            handle(
                {
                    headers: {
                        'x-lgedm-deviceid': `invalid-${cases.indexOf(body)}`,
                        'x-lgedm-devicetype': '403',
                    },
                    body: { lgedmRoot: body },
                },
                response,
            )
        }

        for (const index of cases.keys()) assert.equal(getDeviceMetadata(`invalid-${index}`), undefined)
        handle(
            {
                headers: { 'x-lgedm-deviceid': 'invalid-device-type', 'x-lgedm-devicetype': ['403', '404'] },
                body: { lgedmRoot: { modelName: 'MODEL' } },
            },
            response,
        )
        assert.equal(getDeviceMetadata('invalid-device-type'), undefined)
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

test('ThinQ1 metadata rejects unsafe, coalesced, and oversized device IDs', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rethink-thinq1-metadata-'))
    const handle = metadataRoute(directory)
    const response = {
        header: () => response,
        end: () => undefined,
        status: () => response,
    }
    const invalidIds: unknown[] = ['', 'x'.repeat(129), 'id/child', 'id+wildcard', 'id#wildcard', 'id,other']

    try {
        for (const deviceId of invalidIds) {
            handle(
                {
                    headers: { 'x-lgedm-deviceid': deviceId, 'x-lgedm-devicetype': '403' },
                    body: { lgedmRoot: { modelName: 'MODEL' } },
                },
                response,
            )
        }
        handle(
            {
                headers: { 'x-lgedm-deviceid': ['scalar-id', 'coalesced-id'], 'x-lgedm-devicetype': '403' },
                body: { lgedmRoot: { modelName: 'MODEL' } },
            },
            response,
        )

        for (const deviceId of invalidIds) assert.equal(getDeviceMetadata(String(deviceId)), undefined)
        assert.equal(getDeviceMetadata('scalar-id'), undefined)
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

test('metadata admission preserves an oversized legacy inventory and avoids unchanged writes', async () => {
    const { statSync } = await import('node:fs')
    const directory = mkdtempSync(join(tmpdir(), 'rethink-thinq1-quota-'))
    const filename = join(directory, 'thinq1-metadata.json')
    const inventory = Object.fromEntries(
        Array.from({ length: 1025 }, (_, index) => [
            `device-${index}`,
            { modelId: 'MODEL', modelName: 'MODEL', deviceType: '403' },
        ]),
    )
    writeFileSync(filename, JSON.stringify(inventory))
    const original = readFileSync(filename, 'utf8')
    try {
        const handle = metadataRoute(directory)
        assert.equal(readFileSync(filename, 'utf8'), original, 'startup must not rewrite existing metadata')
        let status = 200
        const response = {
            header: () => response,
            end() {},
            status(value: number) {
                status = value
                return response
            },
        }
        const request = (id: string, modelName: string) =>
            handle(
                {
                    headers: { 'x-lgedm-deviceid': id, 'x-lgedm-devicetype': '403' },
                    body: { lgedmRoot: { modelName } },
                },
                response,
            )
        request('new-device', 'MODEL')
        assert.equal(status, 429)
        assert.equal(readFileSync(filename, 'utf8'), original)
        const before = statSync(filename, { bigint: true }).mtimeNs
        request('device-0', 'MODEL')
        assert.equal(statSync(filename, { bigint: true }).mtimeNs, before)
        request('device-0', 'UPDATED')
        const saved = JSON.parse(readFileSync(filename, 'utf8'))
        assert.equal(Object.keys(saved).length, 1025)
        assert.equal(saved['device-0'].modelName, 'UPDATED')
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

test('the real ThinQ1 HTTP parser rejects malformed and oversized XML and accepts valid XML', async () => {
    const { default: express } = await import('express')
    const directory = mkdtempSync(join(tmpdir(), 'rethink-thinq1-parser-'))
    const application = express()
    application.use(routes({ bridge: { storage_path: directory } } as Config))
    const server = application.listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address()
    assert(address && typeof address === 'object')
    const url = `http://127.0.0.1:${address.port}/lgehadm/api/Device/TotalDeviceInfoSvc`
    const headers = { 'x-lgedm-deviceid': 'synthetic', 'x-lgedm-devicetype': '403' }
    try {
        for (const body of ['<', '<lgedmRoot><modelName>broken</lgedmRoot>', 'x'.repeat(1_000_001)]) {
            assert.equal((await fetch(url, { method: 'POST', headers, body })).status, 400)
            assert.equal(getDeviceMetadata('synthetic'), undefined)
        }
        assert.equal(
            (await fetch(url, { method: 'POST', headers, body: '<lgedmRoot><modelName>MODEL</modelName></lgedmRoot>' }))
                .status,
            200,
        )
        assert.equal(getDeviceMetadata('synthetic')?.modelName, 'MODEL')
    } finally {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        rmSync(directory, { recursive: true, force: true })
    }
})

test('new ThinQ1 metadata admits exactly 1024 identities and writes nothing for rejected identities', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rethink-thinq1-new-quota-'))
    const filename = join(directory, 'thinq1-metadata.json')
    const handle = metadataRoute(directory)
    let status = 200
    const response = {
        header: () => response,
        end() {},
        status(value: number) {
            status = value
            return response
        },
    }
    const request = (id: string) =>
        handle(
            {
                headers: { 'x-lgedm-deviceid': id, 'x-lgedm-devicetype': '403' },
                body: { lgedmRoot: { modelName: 'MODEL' } },
            },
            response,
        )
    try {
        for (let index = 0; index < 1024; index++) request(`device-${index}`)
        assert.equal(Object.keys(JSON.parse(readFileSync(filename, 'utf8'))).length, 1024)
        const saved = readFileSync(filename, 'utf8')
        request('one-too-many')
        assert.equal(status, 429)
        assert.equal(readFileSync(filename, 'utf8'), saved)
        assert.equal(getDeviceMetadata('one-too-many'), undefined)
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})
