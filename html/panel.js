/**
 * Fixed elements supplied by this page's HTML.
 * @typedef {{
 *   'btn_devicetype_continue': HTMLButtonElement,
 *   'btn_thinq_login': HTMLButtonElement,
 *   'btn_thinq_login_complete': HTMLButtonElement,
 *   'btn_thinq_login_continue': HTMLButtonElement,
 *   'btn_thinq_logout': HTMLButtonElement,
 *   'btn_thinq_logout_continue': HTMLButtonElement,
 *   'country_code': HTMLInputElement,
 *   'devices_body': HTMLTableSectionElement,
 *   'devicetype_query': HTMLDivElement,
 *   'devtype-input': HTMLInputElement,
 *   'login_url': HTMLInputElement,
 *   'management_started': HTMLSpanElement,
 *   'management_version': HTMLSpanElement,
 *   'status_bridge': HTMLSpanElement,
 *   'status_bridge_text': HTMLSpanElement,
 *   'status_mqtt': HTMLSpanElement,
 *   'status_rethink': HTMLSpanElement,
 *   'thinq_login': HTMLDivElement,
 *   'thinq_logout': HTMLDivElement,
 * }} PageElements
 */

document.addEventListener('DOMContentLoaded', () => {
    M.Tooltip.init(document.querySelectorAll('.tooltipped'))
    M.Modal.init(document.querySelectorAll('.modal'))
    M.FormSelect.init(document.querySelectorAll('select'))
    M.Autocomplete.init(document.querySelectorAll('.autocomplete'), {
        data: {
            '101 (Refrigerator)': null,
            '201 (Washer)': null,
            '202 (Dryer)': null,
            '204 (Dishwasher)': null,
            '301 (Gas Range)': null,
            '302 (Microwave)': null,
            '401 (Air Conditioner)': null,
        },
    })
})

let _ws
/** @type {ReturnType<typeof setTimeout> | undefined} */
let reconnectTimer
const STATUS_OK = `<i class="tiny material-icons green-text">check</i>`
const STATUS_ERROR = `<i class="tiny material-icons red-text">error</i>`
const STATUS_UNKNOWN = `<i class="tiny material-icons red-text">question_mark</i>`
let bridge_status = false

get('status_rethink').innerHTML = STATUS_UNKNOWN
get('status_mqtt').innerHTML = STATUS_UNKNOWN
get('status_bridge').innerHTML = STATUS_UNKNOWN
get('status_bridge_text').innerText = 'Unknown'

/**
 * @typedef {{name?: string, model?: string, mapped: boolean, platform: string,
 * deviceType?: string, bridged: boolean}} DeviceState
 */
/** @type {Map<string, DeviceEntry>} */
const devices = new Map()

/** @param {string} value */
function formatStartedAt(value) {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return '-'

    const pad = (/** @type {number} */ part) => String(part).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const baseUrl = new URL(window.location.href)
baseUrl.search = ''
baseUrl.hash = ''

class DeviceEntry {
    /** @param {string} id @param {DeviceState} remoteState @param {HTMLElement} parent */
    constructor(id, remoteState, parent) {
        this.id = id
        this.remoteState = remoteState
        this.row = document.createElement('tr')
        this.updateDom()
        parent.appendChild(this.row)
    }

    destroy() {
        this.row.remove()
    }

    /** @param {DeviceState} remoteState */
    update(remoteState) {
        this.remoteState = remoteState
        this.updateDom()
    }

    updateDom() {
        const children = []

        let td
        td = document.createElement('td')
        td.innerText = this.id
        children.push(td)

        td = document.createElement('td')
        td.innerText = this.remoteState.name || '-'
        children.push(td)

        td = document.createElement('td')
        const modelText = document.createElement('span')
        modelText.textContent = this.remoteState.model || '-'
        td.appendChild(modelText)
        if (!this.remoteState.mapped) {
            td.appendChild(document.createTextNode(' '))
            const warning = document.createElement('i')
            warning.className = 'material-icons tooltipped tiny'
            warning.dataset.position = 'bottom'
            warning.dataset.tooltip = 'This device is not supported by rethink. It will not be mapped to HomeAssistant'
            warning.textContent = 'warning'
            td.appendChild(warning)
        }
        children.push(td)

        td = document.createElement('td')
        td.innerText = this.remoteState.platform
        children.push(td)

        td = document.createElement('td')
        td.style.cssText = 'width: 10em'

        td.innerHTML = `
            <div class="switch">
                <label>Off <input type="checkbox"> <span class="lever"></span>On</label>
            </div>
            <div class="hide preloader-wrapper verysmall active">
                <div class="spinner-layer spinner-green-only">
                <div class="circle-clipper left">
                    <div class="circle"></div>
                </div><div class="gap-patch">
                    <div class="circle"></div>
                </div><div class="circle-clipper right">
                    <div class="circle"></div>
                </div>
                </div>
            </div>`
        children.push(td)

        this.bridgeSwitch = td.getElementsByTagName('input')[0]
        this.bridgeDiv = td.getElementsByClassName('switch')[0]
        this.spinner = td.getElementsByClassName('preloader-wrapper')[0]

        const startBridge = async (/** @type {string} */ deviceType) => {
            this.bridgeBusy = true
            this.refreshUI()

            try {
                await fetchWrapper(`bridge/${this.id}/enable`, { deviceType }, { method: 'POST' })
                this.remoteState.bridged = true
            } finally {
                this.bridgeBusy = false
                this.refreshUI()
            }
        }

        const stopBridge = async () => {
            this.bridgeBusy = true
            this.refreshUI()

            try {
                await fetchWrapper(`bridge/${this.id}/disable`, {}, { method: 'POST' })
                this.remoteState.bridged = false
            } finally {
                this.bridgeBusy = false
                this.refreshUI()
            }
        }

        this.bridgeSwitch.onchange = () => {
            const bridgeSwitch = /** @type {HTMLInputElement} */ (this.bridgeSwitch)
            if (bridgeSwitch.checked) {
                if (this.remoteState.deviceType) {
                    startBridge(this.remoteState.deviceType)
                } else {
                    get('btn_devicetype_continue').onclick = () => {
                        let devType = get('devtype-input').value
                        devType = devType.split(' ')[0]
                        startBridge(devType)
                        M.Modal.getInstance(get('devicetype_query')).close()
                    }
                    M.Modal.getInstance(get('devicetype_query')).open()
                }
            } else {
                stopBridge()
            }
        }

        td = document.createElement('td')
        const monitor = document.createElement('a')
        monitor.className = 'btn waves-effect waves-light'
        monitor.href = `monitor?id=${encodeURIComponent(this.id)}`
        const monitorIcon = document.createElement('i')
        monitorIcon.className = 'material-icons'
        monitorIcon.textContent = 'troubleshoot'
        monitor.appendChild(monitorIcon)
        td.appendChild(monitor)
        children.push(td)

        this.row.replaceChildren(...children)
        Array.from(this.row.getElementsByClassName('tooltipped')).forEach((e) => {
            M.Tooltip.init(e)
        })
    }

    refreshUI() {
        // updateDom creates all three controls synchronously before this method can run.
        const bridgeSwitch = /** @type {HTMLInputElement} */ (this.bridgeSwitch)
        const bridgeDiv = /** @type {Element} */ (this.bridgeDiv)
        const spinner = /** @type {Element} */ (this.spinner)
        if (this.bridgeBusy) {
            bridgeDiv.classList.add('hide')
            spinner.classList.remove('hide')
        } else {
            spinner.classList.add('hide')
            bridgeDiv.classList.remove('hide')
            bridgeSwitch.checked = !!this.remoteState.bridged
        }

        if (bridge_status) {
            bridgeSwitch.classList.remove('disabled')
        } else {
            bridgeSwitch.classList.add('disabled')
        }
    }
}

function connect() {
    clearTimeout(reconnectTimer)
    const ws = new WebSocket(`${baseUrl}ws`)

    ws.onclose = () => {
        get('status_rethink').innerHTML = STATUS_ERROR
        get('status_mqtt').innerHTML = STATUS_UNKNOWN
        document.getElementsByTagName('body')[0].classList.add('offline')
        reconnectTimer = setTimeout(connect, 5000)
    }

    ws.onopen = () => {
        get('status_rethink').innerHTML = STATUS_OK
        document.getElementsByTagName('body')[0].classList.remove('offline')
    }

    ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
            /** @type {{ha?: boolean, system?: {version?: string, startedAt: string},
             * devices?: Record<string, DeviceState>, bridge?: {loggedIn: boolean}, status?: string}} */
            const json = JSON.parse(ev.data)
            if (typeof json.ha === 'boolean') {
                get('status_mqtt').innerHTML = json.ha ? STATUS_OK : STATUS_ERROR
            }

            if (typeof json.system === 'object') {
                get('management_version').innerText = json.system.version || '-'
                get('management_started').innerText = formatStartedAt(json.system.startedAt)
            }

            if (json.devices && typeof json.devices === 'object' && !Array.isArray(json.devices)) {
                const incomingDevices = new Map(Object.entries(json.devices))
                for (const [id, device] of devices) {
                    if (!incomingDevices.has(id)) {
                        device.destroy()
                        devices.delete(id)
                    }
                }

                for (const [id, j] of incomingDevices) {
                    const device = devices.get(id)
                    if (!device) devices.set(id, new DeviceEntry(id, j, get('devices_body')))
                    else device.update(j)
                }
            }

            if (typeof json.bridge === 'object') {
                bridge_status = json.bridge.loggedIn
                if (json.bridge.loggedIn === true) {
                    get('btn_thinq_login').classList.add('hide')
                    get('btn_thinq_logout').classList.remove('hide')

                    get('status_bridge').innerHTML = STATUS_OK
                    get('status_bridge_text').innerText = 'Ok'
                } else {
                    get('btn_thinq_login').classList.remove('hide')
                    get('btn_thinq_logout').classList.add('hide')

                    get('status_bridge').innerHTML = STATUS_ERROR
                    get('status_bridge_text').innerText = 'Not configured'
                }

                for (const device of devices.values()) device.refreshUI()
            }

            if (typeof json.status === 'string') {
                toastText(json.status)
            }
        }
    }
}

get('btn_thinq_login_continue').onclick = () => {
    if (!get('country_code').validity.valid) return

    const countryCode = get('country_code').value.toUpperCase()

    window.open(`${baseUrl}thinq_login?countryCode=${countryCode}`, '_blank')
}

get('btn_thinq_login_complete').onclick = async () => {
    if (!get('country_code').validity.valid) return

    if (!get('login_url').validity.valid) return

    const countryCode = get('country_code').value.toUpperCase()
    const url = get('login_url').value
    await fetchWrapper(`thinq_login_accept`, { url, countryCode }, { method: 'POST' })
    M.Modal.getInstance(get('thinq_login')).close()
}

get('btn_thinq_logout_continue').onclick = async () => {
    await fetchWrapper(`thinq_logout`, {}, { method: 'POST' })
    M.Modal.getInstance(get('thinq_logout')).close()
}

/** @template {keyof PageElements} K @param {K} id @returns {PageElements[K]} */
function get(id) {
    return /** @type {PageElements[K]} */ (document.getElementById(id))
}

/** @param {unknown} value */
function toastText(value) {
    const escaped = document.createElement('span')
    escaped.textContent = String(value)
    M.toast({ html: escaped.innerHTML })
}

/**
 * @param {string} path
 * @param {Record<string, unknown>} body
 * @param {Omit<RequestInit, 'headers'> & {headers?: Record<string, string>}} options
 */
async function fetchWrapper(path, body, options) {
    if (options.method !== 'GET') {
        if (!options.headers) options.headers = {}
        options.headers['Content-type'] = 'application/json'
    }
    options.body = JSON.stringify(body)
    try {
        const response = await fetch(`${baseUrl}${path}`, options)
        if (response.status >= 300) toastText(`HTTP error ${response.status}: ${await response.text()}`)

        return response
    } catch (err) {
        toastText(`FETCH error: ${err}`)
    }
}
connect()
