import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

test('LG API results remain usable without exposing credentials or remote responses', () => {
    const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', '--experimental-test-module-mocks', 'tests/fixtures/thinq-api-logging.mjs'],
        { encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr + result.stdout)
    assert.match(result.stdout, /PASS/)
    assert.doesNotMatch(result.stdout + result.stderr, /SENTINEL/)
})
