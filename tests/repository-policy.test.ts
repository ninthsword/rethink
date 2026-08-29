import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const dockerignore = readFileSync('.dockerignore', 'utf-8')
const packageJson = JSON.parse(readFileSync('package.json', 'utf-8')) as {
    scripts: { build: string }
}

test('Docker context excludes private runtime material but keeps public config template', () => {
    const patterns = new Set(
        dockerignore
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith('#')),
    )
    for (const pattern of [
        '.git',
        '.claude/',
        '.agents/',
        '.codex/',
        'CLAUDE.md',
        'CLAUDE.local.md',
        'AGENTS.md',
        '.env',
        '.env.*',
        'oauth.json',
        'oauth2.json',
        'thinq1-metadata.json',
        'config.json',
        'router-dnat.json',
        'state/',
        'captures/',
        '*.key',
        '*.pem',
        '*.cert',
        '*.csr',
        '*.crt',
    ]) {
        assert.equal(patterns.has(pattern), true, pattern)
    }
    assert.equal(patterns.has('config.jsonc'), false)
})

test('build policy removes stale dist before compilation', () => {
    assert.match(packageJson.scripts.build, /^rm -rf dist && tsc /)
    assert.match(packageJson.scripts.build, /tsc-alias -p tsconfig\.build\.json/)
    assert.match(packageJson.scripts.build, /cp -r html dist\/$/)
})
