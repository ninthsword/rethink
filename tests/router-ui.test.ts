import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const router = readFileSync('html/router.js', 'utf-8')

test('router test results use the escaped toast path', () => {
    assert.match(router, /toast\(`Connected: \$\{result\.iptables\}; \$\{result\.conntrack\}`\)/)
    assert.match(router, /function toast\(err\)/)
    assert.match(router, /M\.toast\(\{ html: escapeHtml\(/)
    assert.doesNotMatch(router, /M\.toast\(\{ html: `Connected:/)

    for (const value of ['<img onerror="alert(1)">', '&', '"quoted"']) {
        assert.equal(router.includes(`M.toast({ html: ${value} })`), false)
    }
})
