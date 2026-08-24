import { randomUUID } from 'node:crypto'
import * as HTTPS from 'node:https'
import * as tls from 'node:tls'
import fetch, { type Response } from 'node-fetch'
import { TypedEmitter } from 'tiny-typed-emitter'
import { make as makeFrame, splitter } from '@/util/length_prefixed_frame'
import log from '@/util/logging'
import type { Thinq1Device } from './thinqApi'

type ConnectionEvents = {
    data: (payload: object) => void
    close: () => void
    error: (error: Error) => void
}

export type ConnectionOptions = {
    fetch?: typeof fetch
    tlsConnect?: typeof tls.connect
    connectTimeoutMs?: number
}

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000

export class Connection extends TypedEmitter<ConnectionEvents> {
    device: Thinq1Device
    socket?: tls.TLSSocket
    lastState?: Buffer
    isLive: boolean = false
    aliveTimer?: NodeJS.Timeout
    private destroyed = false
    private requestAbort?: AbortController
    private readonly fetchImpl: typeof fetch
    private readonly tlsConnect: typeof tls.connect
    private readonly connectTimeoutMs: number

    constructor(device: Thinq1Device, options: ConnectionOptions = {}) {
        super()
        this.device = device
        this.fetchImpl = options.fetch ?? fetch
        this.tlsConnect = options.tlsConnect ?? tls.connect
        this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
        // start() used to be an unobserved promise. A transient gateway/DNS failure then
        // became an unhandled rejection and no close event existed to drive the bridge's
        // reconnect loop.
        void this.start().catch((err) => this.fail(err))
    }

    async start() {
        const state = this.device.state
        const deviceType = this.device.meta.deviceType
        if (!deviceType) throw new Error('ThinQ1 device type is missing')

        const abort = new AbortController()
        this.requestAbort = abort
        const requestTimeout = setTimeout(() => abort.abort(), this.connectTimeoutMs)
        requestTimeout.unref?.()

        let resp: Response
        try {
            resp = await this.fetchImpl(`${state.httpServer}/lgehadm/api/Device/TotalDeviceInfoSvc`, {
                method: 'POST',
                headers: {
                    Accept: 'text/xml',
                    'content-type': 'text/xml;charset=utf-8',
                    'x-lgedm-userid': 'lgehadmUser',
                    'x-lgedm-password': 'bxLoLAZ+rp3oJDbEzRuIfAG4YumeqwWM9l6uUH6TupQ=',
                    'x-lgedm-deviceid': this.device.deviceId,
                    'x-lgedm-devicetype': deviceType,
                },
                body: `<lgedmRoot><countryCode>WW</countryCode><modelName>${this.device.meta.modelName}</modelName><itemList><item>THINQ_TIME_SYNC_URI</item><elementList><elementCode>pushDetailYn</elementCode><elementValue>Y</elementValue></elementList></itemList></lgedmRoot>`,
                agent: new HTTPS.Agent({ keepAlive: true, rejectUnauthorized: false }),
                signal: abort.signal,
            })
        } finally {
            clearTimeout(requestTimeout)
            if (this.requestAbort === abort) this.requestAbort = undefined
        }
        if (!resp.ok) throw new Error(`ThinQ1 gateway metadata request failed with HTTP ${resp.status}`)
        await resp.text()
        if (this.destroyed) return

        log('bridge', `${this.device.deviceId} connecting to ${state.rtiServer}`)
        const [host, port] = state.rtiServer.split(':')

        const sendAlive = () => {
            // DevInfo Alive
            // CmdWId: random
            this.writeJSON({
                Header: { 'x-lgedm-deviceId': this.device.deviceId },
                Body: {
                    CmdWId: randomUUID(),
                    Cmd: 'Alive',
                },
            })
        }
        const socket = this.tlsConnect(
            {
                host,
                port: Number(port),
                rejectUnauthorized: false /*FIXME*/,
            },
            () => {
                if (this.destroyed) {
                    socket.destroy()
                    return
                }
                socket.setTimeout(0)
                log('bridge', `${this.device.deviceId} connected`)
                // Cleared in destroy(); without that the heartbeat outlived the socket and
                // every reconnect left another one running.
                this.aliveTimer = setInterval(sendAlive, 60000)
                this.aliveTimer.unref?.()
                sendAlive()

                if (this.lastState) {
                    // DevInfo message
                    // CmdWId: random
                    this.writeJSON({
                        Header: { 'x-lgedm-deviceId': this.device.deviceId },
                        Body: {
                            CmdWId: randomUUID(),
                            Cmd: 'DevInfo',
                            Format: 'B64',
                            Data: this.lastState.toString('base64'),
                        },
                    })
                }
            },
        )
        this.socket = socket
        socket.setTimeout(this.connectTimeoutMs, () => {
            socket.destroy(new Error(`ThinQ1 RTI connection timed out after ${this.connectTimeoutMs} ms`))
        })

        socket.on(
            'data',
            splitter((payload: Buffer) => {
                try {
                    const str = payload.toString('utf-8')
                    const j = JSON.parse(str)
                    if (typeof j.Body === 'object') {
                        if (j.Body.CmdOpt === 'Start') {
                            this.isLive = true
                            if (this.lastState) this.send(this.lastState)

                            // don't forward upstream Start & Stop to the actual device
                            return
                        }

                        if (j.Body.CmdOpt === 'Stop') {
                            this.isLive = false
                            // don't forward upstream Start & Stop to the actual device
                            return
                        }

                        log('bridge', `${this.device.deviceId} <- ${JSON.stringify(j.Body)}`)
                        this.emit('data', j.Body)

                        if (j.Body.ReturnCode === undefined) {
                            // ACK
                            // CmdWId: echo
                            // ReturnCode: 0000
                            this.writeJSON({
                                Header: { 'x-lgedm-deviceId': this.device.deviceId },
                                Body: {
                                    CmdWId: j.Body.CmdWId,
                                    ReturnCode: '0000',
                                },
                            })
                        }
                    }
                } catch (err) {
                    console.log(err)
                }
            }),
        )

        socket.on('close', () => {
            if (this.destroyed) return
            log('bridge', `${this.device.deviceId} disconnected`)
            this.emit('close')
        })
        socket.on('error', (err) => this.emit('error', err))
    }

    private fail(error: unknown) {
        if (this.destroyed) return
        const err = error instanceof Error ? error : new Error(String(error))
        this.emit('error', err)
        // BridgedDevice owns the retry policy and listens for close. Fetch failures have
        // no socket that could emit it, so synthesize the same lifecycle event here.
        this.emit('close')
    }

    writeJSON(json: unknown) {
        this.socket?.write(makeFrame(JSON.stringify(json)))
    }

    send(data: Buffer) {
        // device status message
        // CmdWId: n-$DevideID
        // ReturnCode: 0000
        this.lastState = data
        log('bridge', `${this.device.deviceId} -> ${data.toString('hex')}`)

        if (this.isLive)
            this.writeJSON({
                Header: { 'x-lgedm-deviceId': this.device.deviceId },
                Body: {
                    CmdWId: `n-${this.device.deviceId}`,
                    ReturnCode: '0000',
                    Format: 'B64',
                    Data: data.toString('base64'),
                },
            })
    }

    destroy() {
        this.destroyed = true
        this.requestAbort?.abort()
        this.requestAbort = undefined
        if (this.aliveTimer) clearInterval(this.aliveTimer)
        this.aliveTimer = undefined
        this.socket?.destroy()
        this.socket = undefined
    }
}
