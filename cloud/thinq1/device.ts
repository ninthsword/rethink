import { randomUUID } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { TypedEmitter } from 'tiny-typed-emitter'
import { isSafeDeviceId } from '../device_id'
import type { Metadata } from '../thinq'
import { Connection } from './connection'
import { getDeviceMetadata } from './http'

type ConWithExtra = Connection & {
    deviceObj?: Device
}

type DeviceEvents = {
    data: (packet: Buffer) => void
    response: (body: Record<string, unknown>) => void
    sendData: (body: object) => void
    close: () => void
}

export class Device extends TypedEmitter<DeviceEvents> {
    readonly platform = 'thinq1'

    lastReport: Buffer | undefined

    constructor(
        readonly con: ConWithExtra,
        readonly id: string,
        readonly meta: Metadata,
    ) {
        super()
        con.deviceObj = this
        con.on('status', (packet) => {
            this.lastReport = packet
            this.emit('data', packet)
        })
        con.on('response', (body) => this.emit('response', body))
        con.on('error', console.log)
        con.on('close', () => {
            if (con.deviceObj === this) {
                this.emit('close')
                con.deviceObj = undefined
            }
        })
    }

    send(body: object) {
        this.emit('sendData', body)
        this.con.json({
            Header: { 'x-lgedm-deviceId': this.id },
            Body: {
                ...body,
                CmdWId: `n-${randomUUID()}`,
            },
        })
    }
}

type DeviceAcceptorEvents = {
    newDevice: (dev: Device) => void
    dropDevice: (id: string) => void
}

export class DeviceAcceptor extends TypedEmitter<DeviceAcceptorEvents> {
    connectionsById = new Map<string, Connection>()

    accept(socket: Duplex) {
        const con = new Connection(socket) as ConWithExtra
        con.on('error', () => {}) // ignore errors at this stage
        con.on('init', (deviceId) => {
            console.log('here', deviceId)
            if (!isSafeDeviceId(deviceId)) {
                console.warn(`device ${deviceId} id is invalid`)
                con.destroy()
                return
            }
            const meta = getDeviceMetadata(deviceId)
            if (!meta) {
                console.warn(`device ${deviceId} metadata not known, send HTTP POST first!`)
                con.destroy()
                return
            }

            const existing = this.connectionsById.get(deviceId)
            if (existing) {
                console.warn(`device ${deviceId} already connected, dropping the old one`)
                existing.destroy()
            }

            this.connectionsById.set(deviceId, con)

            con.on('close', () => {
                if (this.connectionsById.get(deviceId) === con) {
                    this.connectionsById.delete(deviceId)
                    this.emit('dropDevice', deviceId)
                }
            })
            con.removeAllListeners('error')

            const dev = new Device(con, deviceId, meta)
            this.emit('newDevice', dev)
        })
    }
}
