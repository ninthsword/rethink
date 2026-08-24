import assert from 'node:assert/strict'
import * as fs from 'node:fs'
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
    const path = '/tmp/rethink-test-roundtrip-state.json'
    try {
        saveState(COMPLETE, path)
        assert.deepEqual(loadState(path), COMPLETE)
    } finally {
        fs.unlinkSync(path)
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
