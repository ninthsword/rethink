/**
 * Fixed elements supplied by this page's HTML.
 * @typedef {{
 *   'autoscroll': HTMLInputElement,
 *   'btn_send1': HTMLButtonElement,
 *   'btn_send2': HTMLButtonElement,
 *   'device_id': HTMLSpanElement,
 *   'device_model': HTMLSpanElement,
 *   'device_status': HTMLSpanElement,
 *   'messages': HTMLDivElement,
 *   'send1': HTMLInputElement,
 *   'send2': HTMLInputElement,
 * }} PageElements
 */

document.addEventListener('DOMContentLoaded', () => {})

/** @type {WebSocket} */
let ws
/** @type {ReturnType<typeof setTimeout> | undefined} */
let reconnectTimer

get('device_id').innerText = new URLSearchParams(window.location.search).get('id') ?? ''
get('device_status').innerText = 'Waiting for rethink connection...'

function connect() {
    clearTimeout(reconnectTimer)
    const socketUrl = new URL('/device', window.location.href)
    socketUrl.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    socketUrl.search = window.location.search
    ws = new WebSocket(socketUrl)

    ws.onclose = () => {
        reconnectTimer = setTimeout(connect, 5000)
        get('device_status').innerText = 'Waiting for rethink connection...'
    }

    ws.onopen = () => {
        get('device_status').innerText = 'offline'
    }

    ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
            /** @type {{rx?: string, tx?: string, injected?: boolean, status?: string, meta?: {modelId: string}}} */
            const json = JSON.parse(ev.data)
            if (json.rx) {
                const payload = json.rx
                const div = pushMessage('rx', payload, json.injected)
                div.onclick = () => {
                    get('send2').value = payload
                    M.updateTextFields()
                }
            }

            if (json.tx) {
                const payload = json.tx
                const div = pushMessage('tx', payload, json.injected)
                div.onclick = () => {
                    get('send1').value = payload
                    M.updateTextFields()
                }
            }

            if (json.status) {
                get('device_status').innerText = json.status
                if (json.status === 'online') {
                    get('btn_send1').disabled = false
                    get('btn_send1').onclick = () => {
                        /** @type {string | Record<string, unknown>} */
                        let cmd = get('send1').value
                        if (cmd[0] === '{') cmd = JSON.parse(cmd)

                        ws.send(JSON.stringify({ sendToDevice: cmd }))
                    }

                    get('btn_send2').disabled = false
                    get('btn_send2').onclick = () => {
                        ws.send(JSON.stringify({ sendFromDevice: get('send2').value }))
                    }
                } else {
                    get('btn_send1').disabled = true
                    get('btn_send2').disabled = true
                }
            }

            if (json.meta) {
                get('device_model').innerText = json.meta.modelId
            }
        }
    }
}

/** @param {string} direction @param {string} payload @param {boolean | undefined} injected */
function pushMessage(direction, payload, injected) {
    const timestamp = document.createElement('span')
    const messages = get('messages')

    timestamp.innerText = new Date().toLocaleTimeString()
    timestamp.classList.add('timestamp')
    const div = document.createElement('div')
    div.classList.add(direction, 'message')
    if (injected) div.classList.add('injected')
    div.innerText = payload
    div.appendChild(timestamp)

    messages.appendChild(div)

    if (get('autoscroll').checked) messages.scrollTop = messages.scrollHeight

    return div
}

/** @template {keyof PageElements} K @param {K} id @returns {PageElements[K]} */
function get(id) {
    return /** @type {PageElements[K]} */ (document.getElementById(id))
}

connect()
