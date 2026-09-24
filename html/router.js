/**
 * Fixed elements supplied by this page's HTML.
 * @typedef {{
 *   'device_ip': HTMLInputElement,
 *   'device_mode': HTMLSelectElement,
 *   'device_modal': HTMLDivElement,
 *   'device_rows': HTMLTableSectionElement,
 *   'empty_devices': HTMLParagraphElement,
 *   'refresh': HTMLButtonElement,
 *   'rethink_ip': HTMLInputElement,
 *   'router_error': HTMLSpanElement,
 *   'router_host': HTMLInputElement,
 *   'router_password': HTMLInputElement,
 *   'router_port': HTMLInputElement,
 *   'router_status': HTMLSpanElement,
 *   'router_username': HTMLInputElement,
 *   'save_device': HTMLButtonElement,
 *   'save_router': HTMLButtonElement,
 *   'test_router': HTMLButtonElement,
 *   'toggle_router_password': HTMLButtonElement,
 * }} PageElements
 */

const baseUrl = new URL(window.location.href)
baseUrl.pathname = baseUrl.pathname.replace(/[^/]*$/, '')
baseUrl.search = ''
baseUrl.hash = ''
/**
 * @typedef {{entryId: string, ip: string, name: string, customName?: string, deviceId?: string,
 * model?: string, connected: boolean, dnat: 'on' | 'off' | 'partial' | 'unknown',
 * mode?: 'dnat'|'local', forwardingPaused?: boolean, cloudConnected?: boolean, bridgeEnabled?: boolean,
 * bridgeBusy?: boolean, bridgeError?: string, bridgeActive: boolean, bridgeSaved: boolean, bridgeArchived: boolean}} RouterDevice
 * @typedef {{devices: RouterDevice[], unassigned: {deviceId: string, name?: string,
 * model?: string, sourceIp?: string}[], connected?: boolean, configured?: boolean, error?: string}} RouterSnapshot
 * @typedef {Omit<RequestInit, 'body' | 'headers'> & {body?: string | Record<string, unknown>,
 * headers?: Record<string, string>}} ApiOptions
 */
/** @type {RouterSnapshot} */
let snapshot = { devices: [], unassigned: [] }
/** @type {Set<string>} */
const busy = new Set()
/** @type {string | undefined} */
let pendingFocus
/** @type {Map<string, {message: string, context: string}>} */
const rowErrors = new Map()
/** @type {Map<string, string>} */
const modeNotices = new Map()
/** @type {(() => void) | undefined} */
let updateModeDialog
let fresh = false
let revision = 0
let globalBusy = false
/** @type {Map<string, string>} */
const pendingLinks = new Map()

document.addEventListener('DOMContentLoaded', async () => {
    M.Modal.init(document.querySelectorAll('.modal'))
    get('refresh').onclick = refresh
    get('save_router').onclick = () => globalAction(saveRouter)
    get('test_router').onclick = () => globalAction(testRouter)
    get('toggle_router_password').onclick = toggleRouterPassword
    get('save_device').onclick = () => globalAction(addDevice)
    await loadConfig()
    await refresh()
    setInterval(() => {
        if (!busy.size && !globalBusy) void refresh()
    }, 15000)
})

/** @template {keyof PageElements} K @param {K} id @returns {PageElements[K]} */
function get(id) {
    return /** @type {PageElements[K]} */ (document.getElementById(id))
}

function toggleRouterPassword() {
    const input = get('router_password')
    const button = get('toggle_router_password')
    const visible = input.type === 'text'
    input.type = visible ? 'password' : 'text'
    UI.bind(button, () => (visible ? UI.t('Show password') : UI.t('Hide password')), 'title')
    UI.bind(button, () => button.title, 'aria-label')
    button.setAttribute('aria-pressed', `${!visible}`)
    const icon = /** @type {HTMLElement} */ (button.querySelector('span'))
    UI.bind(icon, () => (visible ? UI.t('Show password') : UI.t('Hide password')))
    input.focus()
}

/** @param {string} path @param {ApiOptions} options @returns {Promise<unknown>} */
async function api(path, options = {}) {
    if (options.body && typeof options.body !== 'string') {
        options.headers = { ...(options.headers || {}), 'Content-Type': 'application/json' }
        options.body = JSON.stringify(options.body)
    }
    const response = await fetch(new URL(path, baseUrl), /** @type {RequestInit} */ (options))
    if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`)
    if (response.status === 204) return undefined
    return response.json()
}

async function loadConfig() {
    try {
        const config =
            /** @type {{host?: string, port?: number, username?: string, passwordSaved: boolean, rethinkIp?: string}} */ (
                await api('api/router/config')
            )
        get('router_host').value = config.host || ''
        get('router_port').value = String(config.port || 22)
        get('router_username').value = config.username || ''
        UI.bind(
            get('router_password'),
            () => (config.passwordSaved ? UI.t('Saved; leave blank to keep') : ''),
            'placeholder',
        )
        get('rethink_ip').value = config.rethinkIp || ''
        M.updateTextFields()
    } catch (err) {
        toast(err)
    }
}

async function saveRouter() {
    try {
        await api('api/router/config', {
            method: 'PUT',
            body: {
                host: get('router_host').value,
                port: Number(get('router_port').value),
                username: get('router_username').value,
                password: get('router_password').value,
                rethinkIp: get('rethink_ip').value,
            },
        })
        get('router_password').value = ''
        await loadConfig()
        if (await refresh()) UI.bind(get('router_error'), () => UI.t('Router settings saved'))
    } catch (err) {
        toast(err)
    }
}

async function testRouter() {
    try {
        const result = /** @type {{iptables: string, conntrack: string}} */ (
            await api('api/router/test', { method: 'POST' })
        )
        UI.bind(get('router_error'), () =>
            UI.locale === 'ko'
                ? UI.t('Router connection test succeeded')
                : UI.t('Connected: {0}; {1}', [result.iptables, result.conntrack]),
        )
    } catch (err) {
        toast(err)
    }
}

async function addDevice() {
    try {
        await api('api/router/devices', {
            method: 'POST',
            body: { ip: get('device_ip').value, mode: get('device_mode').value || 'dnat' },
        })
        get('device_ip').value = ''
        M.Modal.getInstance(get('device_modal')).close()
        await refresh()
    } catch (err) {
        toast(err)
    }
}

/** @param {() => Promise<void>} action */
async function globalAction(action) {
    if (!UI.allowed() || globalBusy || busy.size || !fresh) return
    globalBusy = true
    revision++
    updateGlobalControls()
    renderDevices()
    try {
        await action()
    } finally {
        globalBusy = false
        updateGlobalControls()
        renderDevices()
    }
}
function updateGlobalControls() {
    get('refresh').disabled = globalBusy || busy.size > 0
    for (const id of ['save_router', 'test_router', 'save_device']) {
        const control = /** @type {HTMLButtonElement} */ (document.getElementById(id))
        control.disabled = globalBusy || !fresh || busy.size > 0
    }
}
async function refresh() {
    const request = ++revision
    try {
        const incoming = /** @type {RouterSnapshot} */ (await api('api/router/status'))
        if (request !== revision) return
        snapshot = incoming
        fresh = true
        UI.bind(get('router_status'), () =>
            snapshot.connected
                ? UI.t('Connected')
                : snapshot.configured
                  ? UI.t('SSH unavailable · Local controls remain available')
                  : UI.t('SSH not configured · Local controls remain available'),
        )
        get('router_status').className = snapshot.connected ? 'green-text' : 'state-unknown'
        UI.bind(get('router_error'), () => UI.diagnostic(snapshot.error, 'ssh'))
        return true
    } catch (error) {
        if (request !== revision) return
        fresh = false
        UI.bind(get('router_status'), () => UI.t('Disconnected · displayed status is stale'))
        toast(error)
        return false
    } finally {
        if (request === revision) {
            renderDevices()
            updateGlobalControls()
        }
    }
}

function renderDevices() {
    updateModeDialog?.()
    const active = document.activeElement
    const focusKey = (active instanceof HTMLElement ? active.dataset.focus : undefined) || pendingFocus
    get('device_rows').replaceChildren()
    get('empty_devices').style.display = snapshot.devices.length ? 'none' : 'block'
    for (const device of snapshot.devices) get('device_rows').append(renderDevice(device))
    if (focusKey)
        document.querySelectorAll('[data-focus]').forEach((element) => {
            if (/** @type {HTMLElement} */ (element).dataset.focus === focusKey) {
                const target = /** @type {HTMLButtonElement} */ (element)
                if (target.disabled) pendingFocus = focusKey
                else {
                    target.focus()
                    pendingFocus = undefined
                }
            }
        })
}

/** @param {RouterDevice} device */
function renderDevice(device) {
    const row = document.createElement('tr')
    row.setAttribute('role', 'row')
    const disabled = !fresh || busy.size > 0 || globalBusy || !!device.bridgeBusy
    row.setAttribute('aria-busy', String(busy.has(device.entryId)))
    const name = cell(device.name || '-')
    const ip = cell(device.ip)
    const identity = cell(
        device.deviceId ? `${device.model || 'ThinQ'} · ${device.deviceId.slice(0, 8)}` : UI.t('No appliance linked'),
    )
    const connection = document.createElement('small')
    UI.bind(connection, () =>
        !fresh
            ? UI.t('Stale · connection unknown')
            : device.connected
              ? UI.t('Connected to Rethink')
              : UI.t('Waiting for appliance connection'),
    )
    identity.append(connection)
    if (!device.deviceId && snapshot.unassigned.length) {
        const select = document.createElement('select')
        select.className = 'browser-default'
        select.dataset.focus = `${device.entryId}:link`
        select.onchange = () => pendingLinks.set(device.entryId, select.value)
        UI.bind(select, () => UI.t('Appliance for {0}', [device.ip]), 'aria-label')
        for (const detected of snapshot.unassigned) {
            const option = document.createElement('option')
            option.value = detected.deviceId
            UI.bind(option, () => detected.name || detected.model || detected.deviceId)
            select.append(option)
        }
        if (snapshot.unassigned.some((entry) => entry.deviceId === pendingLinks.get(device.entryId)))
            select.value = pendingLinks.get(device.entryId) || ''
        const link = button(UI.t('Link'))
        link.onclick = () =>
            run(device.entryId, () =>
                api(`api/router/devices/${device.entryId}/link`, { method: 'POST', body: { deviceId: select.value } }),
            )
        identity.append(select, link)
    }
    const mode = document.createElement('td')
    const selectMode = document.createElement('select')
    selectMode.className = 'browser-default'
    UI.bind(selectMode, () => UI.t('Mode for {0}', [device.name || device.ip]), 'aria-label')
    for (const value of ['dnat', 'local']) {
        const option = document.createElement('option')
        option.value = value
        UI.bind(option, () => (value === 'dnat' ? 'DNAT' : 'Local'))
        selectMode.append(option)
    }
    selectMode.value = device.mode || 'dnat'
    selectMode.dataset.focus = `${device.entryId}:mode`
    selectMode.onchange = () => {
        const next = selectMode.value
        selectMode.value = device.mode || 'dnat'
        modeTransitionChoice(device, next)
    }
    const notice = document.createElement('p')
    notice.className = 'subtle'
    notice.setAttribute('role', 'status')
    notice.setAttribute('aria-live', 'polite')
    UI.bind(notice, () =>
        modeNotices.has(device.entryId)
            ? UI.t(
                  '{0} policy saved. Physical Wi-Fi-module reset and target-mode appliance certificate enrollment are not performed or verified by this page.',
                  [modeName(modeNotices.get(device.entryId) || '')],
              )
            : '',
    )
    mode.append(selectMode, notice)
    const dnat = document.createElement('td')
    if (device.mode === 'local') UI.bind(dnat, () => UI.t('Not used in Local mode'))
    else {
        const state = document.createElement('small')
        UI.bind(state, () =>
            device.forwardingPaused
                ? UI.t('Released · paused until Enable or restart')
                : UI.t('Rules: {0}', [UI.t(fresh ? device.dnat : 'stale')]),
        )
        const action = button(
            device.dnat === 'on' && !device.forwardingPaused
                ? UI.t('Turn off')
                : device.dnat === 'partial'
                  ? UI.t('Repair / Enable')
                  : UI.t('Enable'),
        )
        action.dataset.focus = `${device.entryId}:dnat`
        action.disabled = !snapshot.connected
        action.onclick = () =>
            run(device.entryId, () =>
                api(
                    `api/router/devices/${device.entryId}/dnat/${device.dnat === 'on' && !device.forwardingPaused ? 'disable' : 'enable'}`,
                    { method: 'POST' },
                ),
            )
        dnat.append(state, action)
    }
    const forwarding = cell(
        !fresh
            ? UI.t('Stale · LG status unknown')
            : device.cloudConnected
              ? UI.t('LG connected')
              : device.bridgeActive
                ? UI.t('LG connecting / retrying')
                : device.bridgeEnabled
                  ? UI.t('Forwarding requested')
                  : UI.t('LG forwarding off'),
    )
    const saved = document.createElement('small')
    UI.bind(saved, () =>
        device.bridgeSaved
            ? UI.t('Registration saved')
            : device.bridgeArchived
              ? UI.t('Archived registration available')
              : UI.t('Setup required'),
    )
    forwarding.append(saved)
    if (device.mode === 'local' && device.deviceId) {
        const label = document.createElement('label')
        const toggle = document.createElement('input')
        toggle.type = 'checkbox'
        toggle.checked = !!device.bridgeEnabled
        UI.bind(toggle, () => UI.t('Optional LG Bridge for {0}', [device.name || device.ip]), 'aria-label')
        toggle.dataset.focus = `${device.entryId}:bridge`
        toggle.disabled = !device.bridgeSaved
        toggle.onchange = () =>
            run(
                device.entryId,
                () =>
                    api(`api/router/devices/${device.entryId}/bridge/${toggle.checked ? 'resume' : 'suspend'}`, {
                        method: 'POST',
                    }),
                'bridge',
            )
        label.append(
            toggle,
            UI.textNode(() => UI.t(' Optional LG Bridge')),
        )
        forwarding.append(label)
    } else if (device.mode !== 'local') {
        const hint = document.createElement('small')
        UI.bind(hint, () => UI.t('Automatic with DNAT · no separate Bridge switch'))
        forwarding.append(hint)
    }
    if (device.deviceId) {
        const registration = button(
            device.bridgeSaved || device.bridgeArchived ? UI.t('Registration…') : UI.t('Set up registration…'),
        )
        registration.dataset.focus = `${device.entryId}:registration`
        registration.onclick = () => registrationChoice(device)
        forwarding.append(registration)
    }
    const status = document.createElement('p')
    status.className = 'row-status'
    status.setAttribute('role', 'status')
    status.setAttribute('aria-live', 'polite')
    UI.bind(status, () => {
        const error = rowErrors.get(device.entryId)
        return error
            ? UI.diagnostic(error.message, error.context)
            : busy.has(device.entryId)
              ? UI.t('Working…')
              : UI.diagnostic(device.bridgeError, 'bridge')
    })
    forwarding.append(status)
    const actions = document.createElement('td')
    actions.className = 'actions'
    const rename = button(UI.t('Rename'))
    rename.onclick = () => {
        const customName = prompt(UI.t('Custom name (blank = detected name)'), device.customName || '')
        if (customName === null) return
        return run(device.entryId, () =>
            api(`api/router/devices/${device.entryId}`, { method: 'PUT', body: { customName } }),
        )
    }
    const remove = button(UI.t('Remove'))
    remove.onclick = () => {
        if (
            !confirm(
                UI.t(
                    'Remove {0}? Turn DNAT off first. Registration will be archived; the LG appliance is not deleted.',
                    [device.ip],
                ),
            )
        )
            return
        return run(device.entryId, () => api(`api/router/devices/${device.entryId}`, { method: 'DELETE' }))
    }
    actions.append(rename, remove)
    row.append(name, ip, identity, mode, dnat, forwarding, actions)
    row.querySelectorAll('button, input, select').forEach((element) => {
        const control = /** @type {HTMLButtonElement | HTMLInputElement | HTMLSelectElement} */ (element)
        control.disabled = control.disabled || disabled
    })
    Array.from(row.children).forEach((child, index) => {
        const cellElement = /** @type {HTMLElement} */ (child)
        cellElement.setAttribute('role', 'cell')
        UI.bind(
            cellElement,
            () => UI.t(['Device', 'IP', 'Local connection', 'Mode', 'DNAT', 'LG forwarding', 'Actions'][index]),
            'data-label',
        )
    })
    return row
}

/** @param {string} mode */
function modeName(mode) {
    return mode === 'dnat' ? 'DNAT' : 'Local'
}

/** @param {RouterDevice} device @param {string} to */
function modeTransitionChoice(device, to) {
    const from = device.mode || 'dnat'
    if (
        !UI.allowed() ||
        !fresh ||
        busy.size ||
        globalBusy ||
        device.bridgeBusy ||
        updateModeDialog ||
        (to !== 'dnat' && to !== 'local') ||
        from === to
    )
        return
    const dialog = document.createElement('dialog')
    dialog.setAttribute('aria-labelledby', 'mode-transition-title')
    dialog.setAttribute('aria-describedby', 'mode-transition-guidance')
    const title = document.createElement('h2')
    title.id = 'mode-transition-title'
    UI.bind(title, () => UI.t('Approve mode change · {0} → {1}', [modeName(from), modeName(to)]))
    const guidance = document.createElement('p')
    guidance.id = 'mode-transition-guidance'
    UI.bind(guidance, () =>
        UI.t(
            'For this supported switching workflow, DNAT and Local use different appliance certificates. Switching in either direction requires removing appliance power to reset its Wi-Fi module, then restoring power and repeating Wi-Fi setup and appliance certificate enrollment for the target mode. Follow the appliance-specific instructions; no universal reset duration is assumed.',
        ),
    )
    const target = document.createElement('p')
    UI.bind(target, () =>
        to === 'local'
            ? UI.t(
                  'Target: Local. Keep managed DNAT off and establish an independent appliance connection to Rethink. Use the Local-mode Wi-Fi setup and Rethink appliance-certificate enrollment procedure after the power-removal reset.',
              )
            : UI.t(
                  'Target: DNAT. Use the DNAT network setup and target-mode Wi-Fi / appliance-certificate enrollment procedure after the power-removal reset. Release existing managed DNAT rules before changing policy; configure DNAT for the target enrollment procedure.',
              ),
    )
    const boundary = document.createElement('p')
    UI.bind(boundary, () =>
        UI.t(
            'Approval saves forwarding policy only. This page neither performs nor verifies physical reset, Wi-Fi enrollment or certificate conversion. Bridge Restore / Set up / Renew manages upstream LG registration; it does not enroll the physical appliance’s Wi-Fi certificate.',
        ),
    )
    const label = document.createElement('label')
    const acknowledge = document.createElement('input')
    acknowledge.type = 'checkbox'
    acknowledge.checked = false
    UI.bind(
        acknowledge,
        () => UI.t('Acknowledge reset and target-mode appliance enrollment requirements'),
        'aria-label',
    )
    label.append(
        acknowledge,
        UI.textNode(() =>
            UI.t(
                ' I understand the reset and target-mode appliance enrollment requirements and approve this policy change.',
            ),
        ),
    )
    const status = document.createElement('p')
    status.setAttribute('role', 'status')
    status.setAttribute('aria-live', 'polite')
    const approve = button(UI.t('Approve mode change'))
    approve.disabled = true
    const cancel = button(UI.t('Cancel'))
    let invalidated = false
    const update = () => {
        const current = snapshot.devices.find((entry) => entry.entryId === device.entryId)
        if (
            !fresh ||
            busy.size ||
            globalBusy ||
            !current ||
            current.bridgeBusy ||
            (current.mode || 'dnat') !== from ||
            current.ip !== device.ip ||
            current.deviceId !== device.deviceId
        )
            invalidated = true
        acknowledge.disabled = invalidated
        if (invalidated) {
            acknowledge.checked = false
            UI.bind(status, () =>
                UI.t(
                    'Device state changed or management is unavailable. Cancel and refresh before approving a new transition.',
                ),
            )
        }
        approve.disabled = invalidated || !acknowledge.checked
    }
    const close = () => {
        updateModeDialog = undefined
        dialog.close()
        dialog.remove()
        pendingFocus = `${device.entryId}:mode`
        renderDevices()
    }
    acknowledge.onchange = update
    cancel.onclick = close
    dialog.oncancel = (event) => {
        event.preventDefault()
        close()
    }
    approve.onclick = () => {
        update()
        if (approve.disabled) return
        close()
        return run(device.entryId, async () => {
            await api(`api/router/devices/${device.entryId}`, {
                method: 'PUT',
                body: { mode: to, modeTransition: { from, to, acknowledged: true } },
            })
            modeNotices.set(device.entryId, to)
        })
    }
    dialog.append(title, guidance, target, boundary, label, status, approve, cancel)
    document.body.append(dialog)
    updateModeDialog = update
    update()
    dialog.showModal()
    cancel.focus()
}

/** @param {RouterDevice} device */
function registrationChoice(device) {
    if (!UI.allowed() || !fresh || busy.size || globalBusy) return
    const dialog = document.createElement('dialog')
    dialog.setAttribute('aria-labelledby', 'registration-title')
    const title = document.createElement('h2')
    title.id = 'registration-title'
    UI.bind(title, () => UI.t('Registration · {0}', [device.name || device.ip]))
    const explanation = document.createElement('p')
    UI.bind(explanation, () =>
        UI.t(
            'These actions manage upstream LG registration, not the physical appliance’s Wi-Fi certificate enrollment. Restore reuses the archive only when no current registration exists. Renew / Set up contacts LG and may pair a new certificate. Previous local material stays until replacement succeeds; remote pairing cannot be rolled back. Preserving LG Home membership does not prove that the appliance keeps its credentials.',
        ),
    )
    const type = document.createElement('input')
    UI.bind(type, () => UI.t('Device type if unknown (for example 401)'), 'placeholder')
    UI.bind(type, () => UI.t('LG device type'), 'aria-label')
    const close = () => {
        dialog.close()
        dialog.remove()
        document.querySelectorAll('[data-focus]').forEach((element) => {
            if (/** @type {HTMLElement} */ (element).dataset.focus === `${device.entryId}:registration`)
                /** @type {HTMLElement} */ (element).focus()
        })
    }
    const restore = button(UI.t('Restore'))
    restore.disabled = !device.bridgeArchived || !!device.bridgeSaved
    restore.onclick = () => {
        close()
        return run(
            device.entryId,
            () => api(`api/router/devices/${device.entryId}/bridge/registration/restore`, { method: 'POST' }),
            'bridge',
        )
    }
    const renew = button(device.bridgeSaved ? UI.t('Renew') : UI.t('Set up'))
    renew.disabled = !device.connected
    renew.onclick = () => {
        const deviceType = type.value.trim()
        close()
        return run(
            device.entryId,
            () =>
                api(`api/router/devices/${device.entryId}/bridge/registration/renew`, {
                    method: 'POST',
                    body: deviceType ? { deviceType } : {},
                }),
            'bridge',
        )
    }
    const cancel = button(UI.t('Cancel'))
    cancel.onclick = close
    dialog.oncancel = (event) => {
        event.preventDefault()
        close()
    }
    dialog.append(title, explanation, type, restore, renew, cancel)
    document.body.append(dialog)
    dialog.showModal()
    cancel.focus()
}

/** @param {string} entryId @param {() => Promise<unknown>} action @param {string} context */
async function run(entryId, action, context = 'router') {
    if (!UI.allowed() || !fresh || busy.size || globalBusy) return
    busy.add(entryId)
    updateGlobalControls()
    revision++
    rowErrors.delete(entryId)
    renderDevices()
    try {
        await action()
        await refresh()
    } catch (error) {
        rowErrors.set(entryId, { message: error instanceof Error ? error.message : String(error), context })
    } finally {
        busy.delete(entryId)
        updateGlobalControls()
        renderDevices()
    }
}
/** @param {string} text */
function cell(text) {
    const element = document.createElement('td')
    element.setAttribute('role', 'cell')
    UI.bind(element, () => text)
    return element
}
/** @param {string} label */
function button(label) {
    const element = document.createElement('button')
    element.type = 'button'
    element.className = 'btn-small'
    UI.bind(element, () => UI.t(label))
    return element
}
/** @param {unknown} error */
function toast(error) {
    UI.bind(get('router_error'), () => UI.diagnostic(error, 'router'))
}

UI.onChange(() => renderDevices())
