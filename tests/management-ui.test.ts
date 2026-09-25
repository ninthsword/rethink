import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

test('static declared locale keys have Korean translations without touching user data', () => {
    const source = ts.createSourceFile(
        'ui.js',
        readFileSync('html/ui.js', 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
    )
    const keys = new Set<string>()
    function visit(node: ts.Node) {
        if (
            ts.isVariableDeclaration(node) &&
            node.name.getText(source) === 'korean' &&
            node.initializer &&
            ts.isObjectLiteralExpression(node.initializer)
        ) {
            for (const property of node.initializer.properties) {
                if (property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)))
                    keys.add(property.name.text)
            }
        }
        ts.forEachChild(node, visit)
    }
    visit(source)
    assert(keys.size > 100)
    for (const file of [
        'html/index.html',
        'html/router.html',
        'html/monitor.html',
        'management-gateway/session-proxy/login.html',
    ]) {
        const html = readFileSync(file, 'utf8')
        assert(!html.includes('cdnjs.cloudflare.com') && !html.includes('fonts.googleapis.com'))
        assert(/<main(?:\s|>)/.test(html) && html.includes('<h1') && html.includes('<title'))
        for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bdata-i18n(?:\s|>)[^>]*>([^<>]+)<\/\1\s*>/g)) {
            const key = match[2].trim().replace(/\s+/g, ' ')
            assert(keys.has(key) || ['IP', 'DNAT', 'Local', 'URL'].includes(key), `${file}: missing Korean key ${key}`)
        }
    }
})

test('diagnostics localize exact errors and hide unknown raw text only in Korean', () => {
    const context = vm.createContext({
        navigator: { languages: ['ko-KR'] },
        localStorage: { getItem: () => null, setItem() {} },
        document: { addEventListener() {}, documentElement: { lang: '' }, querySelectorAll: () => [] },
        window: { addEventListener() {} },
    })
    vm.runInContext(readFileSync('html/ui.js', 'utf8'), context)
    const diagnostic = (value: string, kind: string) => {
        context.value = value
        context.kind = kind
        return vm.runInContext('UI.diagnostic(value, kind)', context) as string
    }
    assert.equal(
        diagnostic('Turn DNAT off before changing this entry.', 'router'),
        '이 기기의 DNAT를 끈 뒤 다시 시도하세요.',
    )
    assert.equal(
        diagnostic('Registration required. Choose Restore or Set up registration.', 'bridge'),
        'LG 등록이 필요합니다. 등록 복원 또는 설정을 선택하세요.',
    )
    const approval =
        'Review and explicitly approve dnat → local before changing mode. Acknowledge power-removal Wi-Fi-module reset and target-mode appliance certificate enrollment, then send modeTransition {from, to, acknowledged: true} matching the current and requested modes. Approval does not verify physical preparation. Refresh if the mode has changed.'
    assert.match(diagnostic(approval, 'router'), /모드 변경 내용을 다시 확인하고/)
    const unknown = 'SSH handshake failed: <img src=x onerror=bad()>'
    assert.equal(diagnostic(unknown, 'ssh'), '공유기 SSH 상태를 확인하지 못했습니다. 연결과 설정을 확인하세요.')
    assert.equal(
        diagnostic(`${approval} injected`, 'router'),
        '공유기 작업을 완료하지 못했습니다. 연결과 설정을 확인한 뒤 다시 시도하세요.',
    )
    vm.runInContext("UI.setLocale('en')", context)
    assert.equal(diagnostic(unknown, 'ssh'), unknown)
    vm.runInContext("UI.setLocale('ko')", context)
    assert.equal(diagnostic(unknown, 'ssh'), '공유기 SSH 상태를 확인하지 못했습니다. 연결과 설정을 확인하세요.')
})
