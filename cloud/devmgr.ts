import { TypedEmitter } from 'tiny-typed-emitter'
import type { Device as T1Device } from './thinq1/device'
import type { Device as T2Device } from './thinq2/device'

export type AnyDevice = T1Device | T2Device

type DeviceManagerEvents = {
    newDevice: (dev: AnyDevice) => void
    dropDevice: (id: string) => void
}

export class DeviceManager extends TypedEmitter<DeviceManagerEvents> {
    allDevices = new Map<string, AnyDevice>()

    accept(device: AnyDevice) {
        this.allDevices.set(device.id, device)
        device.on('close', () => {
            if (this.allDevices.get(device.id) === device) {
                this.allDevices.delete(device.id)
                this.emit('dropDevice', device.id)
            }
        })
        this.emit('newDevice', device)
    }
}
