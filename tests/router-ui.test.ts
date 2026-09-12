import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browser, response } from './helpers/browser'

const local = {
    entryId: 'entry',
    ip: '192.0.2.20',
    name: '<img onerror=bad()>',
    deviceId: 'appliance',
    mode: 'local',
    connected: true,
    dnat: 'off',
    bridgeSaved: true,
    bridgeEnabled: false,
}
const state = { configured: false, connected: false, devices: [local], unassigned: [] }

test('Local switch remains usable without router SSH; DNAT has no independent switch', async () => {
    const page = await browser('router', async (path) =>
        response(
            path.endsWith('status') ? { ...state, devices: [local, { ...local, entryId: 'dnat', mode: 'dnat' }] } : {},
        ),
    )
    const rows = page.document.getElementById('device_rows').children
    assert.equal(rows[0].querySelector('input').disabled, false)
    assert.equal(rows[1].querySelectorAll('input').length, 0)
    assert.match(rows[0].textContent, /<img onerror=bad\(\)>/)
    assert.equal(rows[0].querySelectorAll('img').length, 0)
})

test('router failed fetch marks stale and disables every row mutation', async () => {
    let fail = false
    const page = await browser('router', async (path) => {
        if (fail) throw new Error('Network lost')
        return response(path.endsWith('status') ? state : {})
    })
    fail = true
    await page.document.getElementById('refresh').click()
    assert.match(page.document.getElementById('router_status').textContent, /stale/)
    assert(
        page.document
            .getElementById('device_rows')
            .querySelectorAll('button, input, select')
            .every((control) => control.disabled),
    )
})

test('failed mutation exposes actionable row error and does not toggle saved state', async () => {
    const calls: string[] = []
    const page = await browser('router', async (path) => {
        calls.push(path)
        return path.endsWith('resume')
            ? response('Registration required', 409)
            : response(path.endsWith('status') ? state : {})
    })
    await page.document.getElementById('device_rows').querySelector('input').change(true)
    assert.match(page.document.getElementById('device_rows').textContent, /Registration required/)
    assert.equal(page.document.getElementById('device_rows').querySelector('input').checked, false)
    assert.equal(calls.filter((path) => path.endsWith('resume')).length, 1)
})

test('newer refresh wins over slow stale poll and dialog cancel restores focus', async () => {
    const page = await browser('router', async (path) => response(path.endsWith('status') ? state : {}))
    page.evaluate('fetch = () => new Promise(resolve => { globalThis.finishPoll = resolve })')
    const pending = page.evaluate('refresh()')
    const slow = page.evaluate('finishPoll')
    page.evaluate(
        `fetch = async () => ({ok:true,status:200,json:async()=>(${JSON.stringify({ ...state, devices: [{ ...local, name: 'Latest' }] })})})`,
    )
    await page.evaluate('refresh()')
    slow(response(state))
    await pending
    assert.match(page.document.getElementById('device_rows').textContent, /Latest/)
    const trigger = page.document
        .getElementById('device_rows')
        .querySelectorAll('button')
        .find((button) => button.textContent === 'Registration…')
    assert(trigger)
    await trigger.click()
    const dialog = page.document.querySelectorAll('dialog')[0]
    const cancel = dialog.querySelectorAll('button').find((button) => button.textContent === 'Cancel')
    assert(cancel)
    await cancel.click()
    assert.equal(page.document.activeElement.dataset.focus, trigger.dataset.focus)
    assert.equal(page.document.querySelectorAll('dialog').length, 0)
})

test('password saves with blank-preserves semantics and clears only after successful save', async () => {
    let sent: Record<string, unknown> = {}
    let fail = true
    const page = await browser('router', async (path, options) => {
        if (options.method === 'PUT') {
            sent = JSON.parse(String(options.body))
            return response(fail ? 'Save failed' : {}, fail ? 400 : 200)
        }
        return response(path.endsWith('status') ? state : { passwordSaved: true })
    })
    page.document.getElementById('router_password').value = 'synthetic password'
    await page.document.getElementById('save_router').click()
    assert.equal(page.document.getElementById('router_password').value, 'synthetic password')
    fail = false
    await page.document.getElementById('save_router').click()
    assert.equal(sent.password, 'synthetic password')
    assert.equal(page.document.getElementById('router_password').value, '')
    await page.document.getElementById('save_router').click()
    assert.equal(sent.password, '')
})

async function transitionFixture(from: 'dnat' | 'local', outcome: 'ok' | 'failure' | 'pending' = 'ok') {
    let mode: string = from
    let offline = false
    let bridgeBusy = false
    let finish!: (value: ReturnType<typeof response>) => void
    const puts: Record<string, unknown>[] = []
    const page = await browser('router', async (path, options) => {
        if (options.method === 'PUT') {
            const body = JSON.parse(String(options.body)) as Record<string, unknown>
            puts.push(body)
            if (outcome === 'failure') return response('Mode approval is stale. Refresh and approve again.', 409)
            mode = String(body.mode)
            if (outcome === 'pending')
                return new Promise((resolve) => {
                    finish = resolve
                })
            return response({ ...local, mode })
        }
        if (offline) throw new Error('Management unavailable')
        return response(path.endsWith('status') ? { ...state, devices: [{ ...local, mode, bridgeBusy }] } : {})
    })
    const open = async () => {
        const selector = page.document
            .getElementById('device_rows')
            .querySelectorAll('select')
            .find((element) => element.dataset.focus === 'entry:mode')
        assert(selector)
        await selector.change(from === 'dnat' ? 'local' : 'dnat')
        const dialog = page.document.querySelectorAll('dialog')[0]
        assert(dialog)
        const approve = dialog.querySelectorAll('button').find((button) => button.textContent === 'Approve mode change')
        const cancel = dialog.querySelectorAll('button').find((button) => button.textContent === 'Cancel')
        assert(approve && cancel)
        return { selector, dialog, approve, cancel, acknowledgment: dialog.querySelector('input') }
    }
    return {
        page,
        puts,
        open,
        offline() {
            offline = true
        },
        changeMode() {
            mode = from === 'dnat' ? 'local' : 'dnat'
        },
        setBusy() {
            bridgeBusy = true
        },
        finish() {
            finish(response({}, 204))
        },
    }
}

for (const from of ['dnat', 'local'] as const) {
    const to = from === 'dnat' ? 'local' : 'dnat'
    test(`${from} → ${to} requires unchecked acknowledgment and explicit approval; only policy is reported saved`, async () => {
        const f = await transitionFixture(from)
        const { dialog, approve, acknowledgment } = await f.open()
        assert.match(
            dialog.textContent,
            new RegExp(`${from === 'dnat' ? 'DNAT' : 'Local'} → ${to === 'dnat' ? 'DNAT' : 'Local'}`),
        )
        assert.match(dialog.textContent, /different appliance certificates/)
        assert.match(dialog.textContent, /removing appliance power to reset its Wi-Fi module/)
        assert.match(dialog.textContent, /Wi-Fi setup and appliance certificate enrollment/)
        assert.match(dialog.textContent, /does not enroll the physical appliance/)
        assert.equal(acknowledgment.checked, false)
        assert.equal(approve.disabled, true)
        await approve.click()
        assert.equal(f.puts.length, 0)
        await acknowledgment.change(true)
        assert.equal(approve.disabled, false)
        await approve.click()
        assert.deepEqual(f.puts, [{ mode: to, modeTransition: { from, to, acknowledged: true } }])
        assert.equal(f.page.document.querySelectorAll('dialog').length, 0)
        assert.equal(f.page.document.activeElement.dataset.focus, 'entry:mode')
        const row = f.page.document.getElementById('device_rows')
        assert.match(row.textContent, /policy saved/)
        assert.match(row.textContent, /not performed or verified/)
        await f.page.document.getElementById('refresh').click()
        assert.match(row.textContent, /policy saved/)
        assert.doesNotMatch(row.textContent, /conversion complete|enrollment complete|reset complete/i)
    })

    test(`${from} → ${to} Cancel and Escape issue no PUT and restore focus`, async () => {
        const f = await transitionFixture(from)
        for (const useEscape of [false, true]) {
            const { dialog, cancel, acknowledgment } = await f.open()
            assert.equal(acknowledgment.checked, false)
            await acknowledgment.change(true)
            if (useEscape) {
                assert(dialog.oncancel)
                dialog.oncancel({ preventDefault() {} })
            } else await cancel.click()
            assert.equal(f.puts.length, 0)
            assert.equal(f.page.document.querySelectorAll('dialog').length, 0)
            assert.equal(f.page.document.activeElement.dataset.focus, 'entry:mode')
        }
    })

    test(`${from} → ${to} rejected approval leaves the mode unchanged without a success notice`, async () => {
        const f = await transitionFixture(from, 'failure')
        const { approve, acknowledgment } = await f.open()
        await acknowledgment.change(true)
        await approve.click()
        const row = f.page.document.getElementById('device_rows')
        assert.match(row.textContent, /Mode approval is stale/)
        assert.doesNotMatch(row.textContent, /policy saved/)
        assert.equal(
            row.querySelectorAll('select').find((element) => element.dataset.focus === 'entry:mode')?.value,
            from,
        )
        assert.equal(f.page.document.activeElement.dataset.focus, 'entry:mode')
    })
}

for (const invalidation of ['offline', 'mode', 'busy'] as const) {
    test(`open transition approval fails closed after ${invalidation} status`, async () => {
        const f = await transitionFixture('local')
        const { approve, acknowledgment, dialog } = await f.open()
        await acknowledgment.change(true)
        if (invalidation === 'offline') f.offline()
        if (invalidation === 'mode') f.changeMode()
        if (invalidation === 'busy') f.setBusy()
        await f.page.document.getElementById('refresh').click()
        assert.equal(approve.disabled, true)
        assert.equal(acknowledgment.checked, false)
        assert.equal(acknowledgment.disabled, true)
        assert.match(dialog.textContent, /Cancel and refresh/)
        await approve.click()
        assert.equal(f.puts.length, 0)
    })
}

test('approved transition disables busy controls and rejects duplicate submission', async () => {
    const f = await transitionFixture('local', 'pending')
    const { approve, acknowledgment } = await f.open()
    await acknowledgment.change(true)
    const pending = approve.click()
    await approve.click()
    assert.equal(f.puts.length, 1)
    assert(
        f.page.document
            .getElementById('device_rows')
            .querySelectorAll('button, input, select')
            .every((control) => control.disabled),
    )
    f.finish()
    await pending
    assert.equal(f.page.document.activeElement.dataset.focus, 'entry:mode')
})
