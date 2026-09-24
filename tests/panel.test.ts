import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browser, response, settle } from './helpers/browser'

const local = {
    name: '<img onerror=alert(1)>',
    model: '<script>bad</script>',
    mode: 'local',
    bridgeSaved: true,
    bridgeEnabled: false,
}
function snapshot(devices: object) {
    return { bridge: { loggedIn: true }, devices }
}

test('panel executes safe DOM rendering, separates modes, and encodes monitor identities', async () => {
    const page = await browser('panel')
    page.sockets[0].sendStatus(snapshot({ '__proto__/x?': local, dnat: { ...local, mode: 'dnat' } }))
    const rows = page.document.getElementById('devices_body').children
    assert.equal(rows.length, 2)
    assert.match(rows[0].textContent, /<img onerror=alert\(1\)>/)
    assert.equal(rows[0].querySelectorAll('script').length, 0)
    assert.equal(rows[0].querySelectorAll('input').length, 1)
    assert.equal(rows[1].querySelectorAll('input').length, 0)
    assert(rows[0].querySelectorAll('a').some((link) => link.href.includes('__proto__%2Fx%3F')))
})

test('failed HTTP mutation shows row error, preserves off state, and never returns false success', async () => {
    const calls: string[] = []
    const page = await browser('panel', async (path) => {
        calls.push(path)
        return response('Restore or set up first', 409)
    })
    page.sockets[0].sendStatus(snapshot({ local }))
    await page.document.getElementById('devices_body').querySelector('input').change(true)
    assert.equal(calls.length, 1)
    assert.equal(page.document.getElementById('devices_body').querySelector('input').checked, false)
    assert.match(page.document.getElementById('devices_body').textContent, /Restore or set up first/)
    assert(page.diagnostics.some((entry) => entry.context === 'bridge' && entry.value === 'Restore or set up first'))
    assert.equal(page.sockets.length, 1)
})

test('unknown WebSocket and Bridge diagnostics stay in status context without changing controls', async () => {
    const page = await browser('panel')
    page.sockets[0].sendStatus({
        ...snapshot({ local: { ...local, bridgeError: 'LG upstream unknown failure' } }),
        status: 'Remote service status unknown',
    })
    assert(
        page.diagnostics.some((entry) => entry.context === 'status' && entry.value === 'Remote service status unknown'),
    )
    assert(
        page.diagnostics.some((entry) => entry.context === 'bridge' && entry.value === 'LG upstream unknown failure'),
    )
    assert.equal(page.document.getElementById('devices_body').querySelector('input').checked, false)
})

test('busy and stale controls block duplicate requests; old socket cannot overwrite fresh snapshot', async () => {
    let finish!: (value: ReturnType<typeof response>) => void
    const page = await browser(
        'panel',
        async () =>
            new Promise((resolve) => {
                finish = resolve
            }),
    )
    const old = page.sockets[0]
    old.sendStatus(snapshot({ local }))
    const action = page.document.getElementById('devices_body').querySelector('input').change(true)
    assert.equal(page.document.getElementById('devices_body').querySelector('input').disabled, true)
    finish(response({}, 204))
    await action
    const current = page.sockets[1]
    current.sendStatus(snapshot({ local: { ...local, bridgeEnabled: true } }))
    assert.equal(page.document.activeElement.dataset.focus, 'local:toggle')
    old.sendStatus(snapshot({}))
    assert.equal(page.document.getElementById('devices_body').children.length, 1)
    current.close()
    assert.equal(page.document.getElementById('devices_body').querySelector('input').disabled, true)
    assert.match(page.document.getElementById('devices_body').textContent, /Stale/)
})

test('registration Cancel and Escape make no request and return keyboard focus', async () => {
    let calls = 0
    const page = await browser('panel', async () => {
        calls++
        return response()
    })
    page.sockets[0].sendStatus(snapshot({ local: { ...local, bridgeArchived: true } }))
    const trigger = page.document.getElementById('devices_body').querySelector('button')
    assert(trigger)
    await trigger.click()
    const dialog = page.document.querySelectorAll('dialog').find((dialog) => dialog.open)
    assert(dialog)
    assert(dialog.open)
    assert.match(
        dialog.textContent,
        /upstream LG registration, not the physical appliance’s Wi-Fi certificate enrollment/,
    )
    assert.equal(dialog.querySelectorAll('button').find((button) => button.textContent === 'Restore')?.disabled, true)
    assert(dialog.oncancel)
    dialog.oncancel({ preventDefault() {} })
    assert.equal(page.document.querySelectorAll('dialog').filter((dialog) => dialog.open).length, 0)
    assert.equal(page.document.activeElement.dataset.focus, trigger.dataset.focus)
    assert.equal(calls, 0)
})

test('network login failure keeps dialog open and retains form for retry', async () => {
    const page = await browser('panel', async () => {
        throw new Error('Network unavailable')
    })
    page.sockets[0].sendStatus(snapshot({}))
    page.document.getElementById('login_url').value = 'https://login.example/return'
    await page.document.getElementById('btn_thinq_login_complete').click()
    await settle()
    assert.deepEqual(page.modals, [])
    assert.match(page.document.getElementById('page_status').textContent, /Network unavailable/)
    assert(page.diagnostics.some((entry) => entry.context === 'account' && entry.value === 'Network unavailable'))
})
