/** @typedef {{name?: string, model?: string, mapped?: boolean, platform?: string, deviceType?: string,
 * mode?: 'dnat'|'local', bridgeEnabled?: boolean, bridgeActive?: boolean, cloudConnected?: boolean,
 * bridgeSaved?: boolean, bridgeArchived?: boolean, bridgeBusy?: boolean, bridgeError?: string}} DeviceState */
/** @type {Map<string, DeviceState>} */
const devices = new Map()
/** @type {Set<string>} */
const busy = new Set()
/** @type {string | undefined} */
let pendingFocus
/** @type {Map<string, string>} */
const errors = new Map()
/** @type {WebSocket | undefined} */
let currentSocket
let online = false
let accountBusy = false
let loggedIn = false
let bridgeConfigured = false
const baseUrl = new URL('.', window.location.href)
/** @param {string} id */
function get(id) {
    return /** @type {HTMLElement} */ (document.getElementById(id))
}
/** @param {string} id */
function input(id) {
    return /** @type {HTMLInputElement} */ (get(id))
}
/** @param {string} value */
function formatStartedAt(value) {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString()
}
/** @param {string} label @param {() => unknown} action */
function button(label, action) {
    const element = document.createElement('button')
    element.type = 'button'
    element.className = 'btn-small'
    element.textContent = label
    element.onclick = action
    return element
}
/** @param {string} text */
function cell(text) {
    const element = document.createElement('td')
    element.textContent = text
    return element
}
function render() {
    for (const id of [
        'btn_thinq_login',
        'btn_thinq_logout',
        'btn_thinq_login_continue',
        'btn_thinq_login_complete',
        'btn_thinq_logout_continue',
    ]) {
        const control = /** @type {HTMLButtonElement} */ (get(id))
        control.disabled = !online || accountBusy
    }
    const active = document.activeElement
    const focusId = (active instanceof HTMLElement ? active.dataset.focus : undefined) || pendingFocus
    get('devices_body').replaceChildren()
    for (const [id, state] of devices) {
        const row = document.createElement('tr')
        row.dataset.device = id
        row.setAttribute('aria-busy', String(busy.has(id) || !!state.bridgeBusy))
        const name = cell(state.name || '-')
        const identity = document.createElement('small')
        identity.textContent = id
        name.append(identity)
        const model = cell(state.model || '-')
        if (!state.mapped) model.append(document.createTextNode(' · HA mapping unavailable'))
        const mode = cell(state.mode === 'dnat' ? 'DNAT' : 'Local')
        const local = cell(online ? 'Connected to Rethink' : 'Stale · connection unknown')
        const forwarding = cell(
            !online
                ? 'Stale · LG status unknown'
                : state.cloudConnected
                  ? 'LG connected'
                  : state.bridgeActive
                    ? 'LG connecting / retrying'
                    : state.bridgeEnabled
                      ? 'Forwarding requested'
                      : 'LG forwarding off',
        )
        const registration = document.createElement('small')
        registration.textContent = state.bridgeSaved
            ? 'Registration saved'
            : state.bridgeArchived
              ? 'Archived registration available'
              : 'Setup required'
        forwarding.append(registration)
        if (state.mode === 'dnat') {
            const link = document.createElement('a')
            link.href = 'router.html'
            link.textContent = 'Manage DNAT and automatic forwarding'
            forwarding.append(link)
        } else {
            const label = document.createElement('label')
            const toggle = document.createElement('input')
            toggle.type = 'checkbox'
            toggle.checked = !!state.bridgeEnabled
            toggle.dataset.focus = `${id}:toggle`
            toggle.setAttribute('aria-label', `Optional LG Bridge for ${state.name || id}`)
            toggle.disabled = !online || !bridgeConfigured || busy.has(id) || !!state.bridgeBusy || !state.bridgeSaved
            toggle.onchange = () =>
                run(id, () => api(`bridge/${encodeURIComponent(id)}/${toggle.checked ? 'enable' : 'disable'}`))
            label.append(toggle, document.createTextNode(' Optional LG Bridge'))
            forwarding.append(label)
        }
        const setup = button(state.bridgeSaved || state.bridgeArchived ? 'Registration…' : 'Set up registration…', () =>
            registrationChoice(id),
        )
        setup.dataset.focus = `${id}:registration`
        setup.disabled = !online || !bridgeConfigured || busy.has(id) || !!state.bridgeBusy
        forwarding.append(setup)
        const status = document.createElement('p')
        status.className = 'row-status'
        status.setAttribute('role', 'status')
        status.setAttribute('aria-live', 'polite')
        status.textContent = errors.get(id) || (busy.has(id) ? 'Working…' : state.bridgeError || '')
        forwarding.append(status)
        const monitorCell = document.createElement('td')
        const monitor = document.createElement('a')
        monitor.href = `monitor?id=${encodeURIComponent(id)}`
        monitor.textContent = 'Monitor'
        monitorCell.append(monitor)
        row.append(name, model, mode, local, forwarding, monitorCell)
        Array.from(row.children).forEach((child, index) => {
            const cellElement = /** @type {HTMLElement} */ (child)
            cellElement.dataset.label = ['Device', 'Model', 'Mode', 'Local connection', 'LG forwarding', 'Tools'][index]
        })
        get('devices_body').append(row)
    }
    if (focusId)
        document.querySelectorAll('[data-focus]').forEach((element) => {
            if (/** @type {HTMLElement} */ (element).dataset.focus === focusId) {
                const target = /** @type {HTMLButtonElement} */ (element)
                if (target.disabled) pendingFocus = focusId
                else {
                    target.focus()
                    pendingFocus = undefined
                }
            }
        })
    get('empty_devices').hidden = devices.size > 0
}
/** @param {string} path @param {Record<string, unknown>} body */
async function api(path, body = {}) {
    const response = await fetch(new URL(path, baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`)
    return response
}
/** @param {string} id @param {() => Promise<unknown>} action */
async function run(id, action) {
    if (!online || busy.has(id)) return
    busy.add(id)
    errors.delete(id)
    render()
    try {
        await action()
        // A fresh socket snapshot follows the mutation; an old socket cannot overwrite it.
        connect()
    } catch (error) {
        errors.set(id, error instanceof Error ? error.message : String(error))
    } finally {
        busy.delete(id)
        render()
    }
}
/** @param {string} id */
function registrationChoice(id) {
    const state = devices.get(id)
    if (!state || !online || busy.has(id)) return
    const dialog = document.createElement('dialog')
    dialog.setAttribute('aria-labelledby', 'registration-title')
    const title = document.createElement('h5')
    title.id = 'registration-title'
    title.textContent = `Registration · ${state.name || id}`
    const text = document.createElement('p')
    text.textContent =
        'These actions manage upstream LG registration, not the physical appliance’s Wi-Fi certificate enrollment. Restore reuses an archived registration only when no current one exists. Renew / Set up explicitly contacts LG and may pair a new certificate. Previous local material is kept if this fails; remote pairing cannot be rolled back. DNAT preserves Home membership, which does not guarantee appliance credential continuity.'
    const deviceType = document.createElement('input')
    deviceType.value = state.deviceType || ''
    deviceType.placeholder = 'Device type (for example 401)'
    deviceType.setAttribute('aria-label', 'LG device type')
    const focusKey = `${id}:registration`
    const close = () => {
        dialog.close()
        dialog.remove()
        document.querySelectorAll('[data-focus]').forEach((element) => {
            if (/** @type {HTMLElement} */ (element).dataset.focus === focusKey)
                /** @type {HTMLElement} */ (element).focus()
        })
    }
    const restore = button('Restore', () => {
        close()
        return run(id, () => api(`bridge/${encodeURIComponent(id)}/registration/restore`))
    })
    restore.disabled = !state.bridgeArchived || !!state.bridgeSaved
    const renew = button(state.bridgeSaved ? 'Renew' : 'Set up', () => {
        const value = deviceType.value.trim()
        close()
        return run(id, () => api(`bridge/${encodeURIComponent(id)}/registration/renew`, { deviceType: value }))
    })
    renew.disabled = !loggedIn
    const cancel = button('Cancel', close)
    dialog.oncancel = (event) => {
        event.preventDefault()
        close()
    }
    dialog.append(title, text, deviceType, restore, renew, cancel)
    document.body.append(dialog)
    dialog.showModal()
    cancel.focus()
}
function connect() {
    const old = currentSocket
    const url = new URL('ws', baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(url)
    currentSocket = ws
    online = false
    old?.close()
    render()
    ws.onclose = () => {
        if (currentSocket !== ws) return
        online = false
        get('status_rethink').textContent = 'Disconnected · displayed device status is stale'
        get('status_mqtt').textContent = 'Unknown'
        render()
        setTimeout(() => {
            if (currentSocket === ws) connect()
        }, 5000)
    }
    ws.onmessage = (event) => {
        if (currentSocket !== ws || typeof event.data !== 'string') return
        try {
            /** @type {{ha?: boolean, system?: {version?: string, startedAt: string}, bridge?: {loggedIn: boolean}, devices?: Record<string, DeviceState>, status?: string}} */
            const json = JSON.parse(event.data)
            if (json.devices && typeof json.devices === 'object' && !Array.isArray(json.devices)) {
                devices.clear()
                for (const [id, state] of Object.entries(json.devices)) devices.set(id, state)
                online = true
                get('status_rethink').textContent = 'Connected'
            }
            if (typeof json.ha === 'boolean')
                get('status_mqtt').textContent = json.ha
                    ? 'MQTT connected (entity health is separate)'
                    : 'MQTT disconnected'
            if (json.system) {
                get('management_version').textContent = json.system.version || '-'
                get('management_started').textContent = formatStartedAt(json.system.startedAt)
            }
            if (json.bridge) {
                bridgeConfigured = true
                loggedIn = json.bridge.loggedIn
                get('status_bridge_text').textContent = loggedIn
                    ? 'Signed in · separate from appliance forwarding'
                    : 'Sign in for explicit setup / renewal'
                get('btn_thinq_login').classList.toggle('hide', loggedIn)
                get('btn_thinq_logout').classList.toggle('hide', !loggedIn)
            }
            if (json.status) get('page_status').textContent = json.status
            render()
        } catch {
            get('page_status').textContent = 'Invalid status response. Reconnect to refresh.'
        }
    }
}
/** @param {string} id @param {() => Promise<unknown>} action */
async function accountAction(id, action) {
    const control = /** @type {HTMLButtonElement} */ (get(id))
    if (!online || control.disabled || accountBusy) return
    accountBusy = true
    render()
    try {
        await action()
    } catch (error) {
        get('page_status').textContent = String(error)
    } finally {
        accountBusy = false
        render()
    }
}
document.addEventListener('DOMContentLoaded', () => {
    M.Modal.init(document.querySelectorAll('.modal'))
    get('btn_thinq_login_continue').onclick = () => {
        if (input('country_code').validity.valid)
            window.open(
                new URL(
                    `thinq_login?countryCode=${encodeURIComponent(input('country_code').value.toUpperCase())}`,
                    baseUrl,
                ).href,
                '_blank',
            )
    }
    get('btn_thinq_login_complete').onclick = () =>
        accountAction('btn_thinq_login_complete', async () => {
            if (!input('country_code').validity.valid || !input('login_url').validity.valid) return
            await api('thinq_login_accept', {
                countryCode: input('country_code').value.toUpperCase(),
                url: input('login_url').value,
            })
            input('login_url').value = ''
            M.Modal.getInstance(get('thinq_login')).close()
        })
    get('btn_thinq_logout_continue').onclick = () =>
        accountAction('btn_thinq_logout_continue', async () => {
            await api('thinq_logout')
            M.Modal.getInstance(get('thinq_logout')).close()
        })
    connect()
})
