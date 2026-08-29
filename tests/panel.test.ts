import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const panel = readFileSync('html/panel.js', 'utf-8')

test('panel renders external model text without an HTML sink', () => {
    assert.match(panel, /modelText\.textContent = this\.remoteState\.model \|\| '-'/)
    assert.match(panel, /warning\.className = 'material-icons tooltipped tiny'/)
    assert.match(panel, /warning\.textContent = 'warning'/)
    assert.doesNotMatch(panel, /td\.innerHTML = model/)
})

test('panel builds an encoded monitor link through the DOM', () => {
    assert.match(panel, /monitor\.href = `monitor\?id=\$\{encodeURIComponent\(this\.id\)\}`/)
    assert.match(panel, /monitorIcon\.textContent = 'troubleshoot'/)
    assert.doesNotMatch(panel, /td\.innerHTML = `<a class=/)
})

test('panel escapes dynamic toast content before passing it to Materialize', () => {
    assert.match(panel, /function toastText\(value\)/)
    assert.match(panel, /escaped\.textContent = String\(value\)/)
    assert.match(panel, /M\.toast\(\{ html: escaped\.innerHTML \}\)/)
    assert.match(panel, /toastText\(json\.status\)/)
    assert.match(panel, /toastText\(`HTTP error \$\{response\.status\}: \$\{await response\.text\(\)\}`\)/)
    assert.match(panel, /toastText\(`FETCH error: \$\{err\}`\)/)
    for (const value of ['<img onerror="alert(1)">', '&', '"quoted"']) {
        assert.equal(panel.includes(`M.toast({ html: ${value} })`), false)
    }
    assert.doesNotMatch(panel, /M\.toast\(\{ html: json\.status \}\)/)
    assert.doesNotMatch(panel, /M\.toast\(\{ html: `HTTP error/)
    assert.doesNotMatch(panel, /M\.toast\(\{ html: `FETCH error/)
})

test('panel tracks device ids in a Map with own incoming entries', () => {
    assert.match(panel, /const devices = new Map\(\)/)
    assert.match(panel, /const incomingDevices = new Map\(Object\.entries\(json\.devices\)\)/)
    assert.match(panel, /for \(const \[id, device\] of devices\)/)
    assert.match(panel, /const device = devices\.get\(id\)/)
    assert.match(panel, /devices\.set\(id, new DeviceEntry\(id, j, get\('devices_body'\)\)\)/)
    assert.match(panel, /for \(const device of devices\.values\(\)\) device\.refreshUI\(\)/)
    assert.doesNotMatch(panel, /devices\[/)

    const incoming = JSON.parse('{"__proto__":{"model":"prototype"},"constructor":{"model":"constructor"}}') as Record<
        string,
        { model: string }
    >
    const registry = new Map(Object.entries(incoming))
    assert.equal(registry.get('__proto__')?.model, 'prototype')
    assert.equal(registry.get('constructor')?.model, 'constructor')
})
