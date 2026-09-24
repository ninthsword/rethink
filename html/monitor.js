/** @type {WebSocket | undefined} */
let currentSocket
/** @type {ReturnType<typeof setTimeout> | undefined} */
let reconnectTimer
let online = false
let discarded = 0
/** @param {string} id */
function get(id) {
    return /** @type {HTMLElement} */ (document.getElementById(id))
}
/** @param {string} id */
function input(id) {
    return /** @type {HTMLInputElement} */ (get(id))
}
function controls() {
    for (const id of ['btn_send1', 'btn_send2']) {
        const control = /** @type {HTMLButtonElement} */ (get(id))
        control.disabled = !online || !UI.allowed()
    }
}
/** @param {string} key */
function monitorStatus(key) {
    UI.bind(get('device_status'), () => UI.t(key))
}
/** @param {string} key */
function error(key) {
    UI.bind(get('monitor_error'), () => UI.t(key))
}
function connect() {
    clearTimeout(reconnectTimer)
    const previous = currentSocket
    const url = new URL('/device', window.location.href)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.search = window.location.search
    const socket = new WebSocket(url)
    currentSocket = socket
    previous?.close()
    online = false
    controls()
    monitorStatus('Waiting for Rethink connection…')
    const disconnected = () => {
        if (currentSocket !== socket) return
        online = false
        controls()
        monitorStatus('Waiting for Rethink connection…')
    }
    socket.onerror = disconnected
    socket.onclose = () => {
        if (currentSocket !== socket) return
        disconnected()
        reconnectTimer = setTimeout(() => {
            if (currentSocket === socket) connect()
        }, 5000)
    }
    socket.onopen = () => {
        if (currentSocket === socket) monitorStatus('Appliance offline')
    }
    socket.onmessage = (event) => {
        if (currentSocket !== socket || typeof event.data !== 'string') return
        try {
            const message = JSON.parse(event.data)
            if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid message')
            for (const direction of ['rx', 'tx']) {
                if (message[direction] !== undefined && typeof message[direction] !== 'string')
                    throw new Error('Invalid payload')
                if (typeof message[direction] === 'string')
                    pushMessage(direction, message[direction], message.injected === true)
            }
            if (message.status !== undefined) {
                if (typeof message.status !== 'string') throw new Error('Invalid status')
                online = message.status === 'online'
                monitorStatus(online ? 'Appliance online' : 'Appliance offline')
                controls()
            }
            if (message.meta && typeof message.meta.modelId === 'string')
                get('device_model').textContent = message.meta.modelId
        } catch {
            error('Invalid message received. Waiting for the next update.')
        }
    }
}
/** @param {'sendToDevice' | 'sendFromDevice'} direction */
function send(direction) {
    const socket = currentSocket
    if (!UI.allowed() || !online || !socket || socket.readyState !== WebSocket.OPEN) {
        online = false
        controls()
        error('Connection unavailable. Command was not sent.')
        return
    }
    /** @type {unknown} */
    let payload = input(direction === 'sendToDevice' ? 'send1' : 'send2').value
    try {
        if (direction === 'sendToDevice' && typeof payload === 'string' && payload.trimStart().startsWith('{')) {
            payload = JSON.parse(payload)
        }
    } catch {
        error('Invalid JSON. Correct the input and try again.')
        return
    }
    try {
        socket.send(JSON.stringify({ [direction]: payload }))
        error('')
    } catch {
        online = false
        controls()
        error('Connection unavailable. Command was not sent.')
    }
}
/** @param {string} direction @param {string} payload @param {boolean} injected */
function pushMessage(direction, payload, injected) {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = `message ${direction}${injected ? ' injected' : ''}`
    UI.bind(item, () => UI.t('Copy payload to input'), 'aria-label')
    const content = document.createElement('code')
    content.textContent = payload
    const timestamp = document.createElement('time')
    const time = Date.now()
    timestamp.dateTime = new Date(time).toISOString()
    timestamp.className = 'timestamp'
    UI.bind(timestamp, () => UI.time(time))
    item.append(content, timestamp)
    item.onclick = () => {
        const field = input(direction === 'rx' ? 'send2' : 'send1')
        field.value = payload
        field.focus()
    }
    const messages = get('messages')
    messages.append(item)
    while (messages.children.length > 1000) {
        messages.firstElementChild?.remove()
        discarded++
    }
    UI.bind(get('discarded'), () => (discarded ? UI.t('{0} older messages discarded', [discarded]) : ''))
    if (input('autoscroll').checked) messages.scrollTop = messages.scrollHeight
}
get('device_id').textContent = new URLSearchParams(window.location.search).get('id') ?? ''
get('btn_send1').onclick = () => send('sendToDevice')
get('btn_send2').onclick = () => send('sendFromDevice')
window.addEventListener('management-session', controls)
connect()
