import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { readBuildInfo } from '../management/build-info'
import { buildIdentity, writeBuildInfo } from '../scripts/write-build-info.mjs'

test('identity hashes emitted paths and bytes deterministically, excluding only its own metadata', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'rethink-build-test-'))
    try {
        await mkdir(path.join(root, 'html'))
        await writeFile(path.join(root, 'html/index.html'), 'synthetic HTML')
        await writeFile(path.join(root, 'index.js'), 'synthetic emitted JS')
        const first = await writeBuildInfo(root)
        assert.match(first, /^[a-f0-9]{64}$/)
        assert.equal(await buildIdentity(root), first)
        assert.equal(readBuildInfo(pathToFileURL(path.join(root, 'management-build.json'))), first.slice(0, 16))
        await writeFile(path.join(root, 'management-build.json'), 'arbitrary prior metadata')
        assert.equal(await buildIdentity(root), first)
        assert.equal(readBuildInfo(pathToFileURL(path.join(root, 'management-build.json'))), '')
        await writeFile(path.join(root, 'index.js'), 'changed emitted JS')
        assert.notEqual(await buildIdentity(root), first)
        assert.equal(readBuildInfo(pathToFileURL(path.join(root, 'missing.json'))), '')
        for (const value of [{ schema: 1, sha256: '20260814' }, { schema: 2, sha256: first }, 'x'.repeat(1024)]) {
            await writeFile(path.join(root, 'management-build.json'), JSON.stringify(value))
            assert.equal(readBuildInfo(pathToFileURL(path.join(root, 'management-build.json'))), '')
        }
    } finally {
        await rm(root, { recursive: true })
    }
})
