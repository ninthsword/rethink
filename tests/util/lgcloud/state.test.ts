import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { loadState, saveState } from '@/util/lgcloud/state'

const COMPLETE = { countryCode: 'US', refreshToken: 'tok' }

test('loadState returns undefined when the file is missing', () => {
    assert.equal(loadState('/tmp/rethink-test-no-such-state.json'), undefined)
})

test('loadState rejects an incomplete state (refresh token without country code)', () => {
    const path = '/tmp/rethink-test-partial-state.json'
    fs.writeFileSync(path, JSON.stringify({ refreshToken: 'tok' }))
    try {
        assert.equal(loadState(path), undefined)
    } finally {
        fs.unlinkSync(path)
    }
})

test('saveState then loadState round-trips a complete state', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rethink-lgcloud-state-'))
    const statePath = path.join(dir, 'oauth.json')
    try {
        saveState(COMPLETE, statePath)
        assert.deepEqual(loadState(statePath), COMPLETE)
        fs.chmodSync(statePath, 0o644)
        const replacement = { countryCode: 'KR', refreshToken: 'replacement' }
        saveState(replacement, statePath)
        assert.deepEqual(loadState(statePath), replacement)
        assert.equal(statSync(statePath).mode & 0o777, 0o600)
        assert.equal(fs.existsSync(`${statePath}.tmp`), false, 'no temporary is left behind')
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('saveState ignores a predictable stale temporary symlink', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rethink-lgcloud-state-'))
    const statePath = path.join(dir, 'oauth.json')
    const protectedPath = path.join(dir, 'protected')
    const stalePath = `${statePath}.tmp`
    fs.writeFileSync(protectedPath, 'do not replace')
    symlinkSync(protectedPath, stalePath)

    try {
        saveState(COMPLETE, statePath)
        assert.deepEqual(loadState(statePath), COMPLETE)
        assert.equal(readFileSync(protectedPath, 'utf-8'), 'do not replace')
        assert.equal(readlinkSync(stalePath), protectedPath)
        assert.equal(lstatSync(statePath).isSymbolicLink(), false)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('saveState cleans its unpredictable temporary file after a failed rename', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rethink-lgcloud-state-'))
    const targetDirectory = path.join(dir, 'target')
    fs.mkdirSync(targetDirectory)

    try {
        assert.throws(() => saveState(COMPLETE, targetDirectory))
        assert.deepEqual(fs.readdirSync(dir), ['target'])
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('loadState accepts the bridge credential layout', () => {
    const path = '/tmp/rethink-test-bridge-state.json'
    try {
        fs.writeFileSync(path, JSON.stringify({ env: { countryCode: 'KR' }, refreshToken: 'bridge-token' }))
        assert.deepEqual(loadState(path), { countryCode: 'KR', refreshToken: 'bridge-token' })
    } finally {
        fs.unlinkSync(path)
    }
})
