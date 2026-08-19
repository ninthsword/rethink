import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'

const STATUS_LENGTH = 18
const COMMAND_LENGTH = 41

// Bytes 18..40 are constant in every captured F017 command. The first 18 bytes
// are the latest full status with the requested field changed.
const COMMAND_SUFFIX = Buffer.from('ffffff000000ffff00ffffffff00ffffffffffffffffff', 'hex')

export default class Device extends AABBDevice {
    readonly deviceConfig: DeviceDiscovery
    private currentStatus: Buffer | undefined

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.deviceConfig = HADevice.config(meta, { name: 'LG Fridge' })
        this.setConfig(
            allowExtendedType({
                ...this.deviceConfig,
                components: {
                    fridge_setpoint: {
                        platform: 'number',
                        device_class: 'temperature',
                        unique_id: '$deviceid-fridge_setpoint',
                        state_topic: '$this/fridge_setpoint',
                        command_topic: '$this/fridge_setpoint/set',
                        name: 'Fridge temperature',
                        unit_of_measurement: '°C',
                        min: 1,
                        max: 7,
                    },
                    freezer_setpoint: {
                        platform: 'number',
                        device_class: 'temperature',
                        unique_id: '$deviceid-freezer_setpoint',
                        state_topic: '$this/freezer_setpoint',
                        command_topic: '$this/freezer_setpoint/set',
                        name: 'Freezer temperature',
                        unit_of_measurement: '°C',
                        min: -23,
                        max: -15,
                    },
                    express_freeze: {
                        platform: 'switch',
                        unique_id: '$deviceid-express_freeze',
                        state_topic: '$this/express_freeze',
                        command_topic: '$this/express_freeze/set',
                        icon: 'mdi:snowflake',
                        name: 'Express Freeze',
                    },
                    door: {
                        platform: 'binary_sensor',
                        device_class: 'door',
                        unique_id: '$deviceid-door',
                        state_topic: '$this/door',
                        name: 'Door',
                    },
                    fridge_door: {
                        platform: 'binary_sensor',
                        device_class: 'door',
                        unique_id: '$deviceid-fridge-door',
                        state_topic: '$this/fridge_door',
                        name: 'Fridge door',
                    },
                    freezer_door: {
                        platform: 'binary_sensor',
                        device_class: 'door',
                        unique_id: '$deviceid-freezer-door',
                        state_topic: '$this/freezer_door',
                        name: 'Freezer door',
                    },
                    control_panel_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-control-panel-lock',
                        state_topic: '$this/control_panel_lock',
                        icon: 'mdi:lock',
                        name: 'Control panel lock',
                    },
                },
            }),
        )
    }

    start() {
        this.send(Buffer.from('F0ED1211010000010400', 'hex'))
    }

    processAABB(buf: Buffer) {
        if (buf.length === 2 + STATUS_LENGTH && buf[0] === 0x10 && buf[1] === 0xeb) {
            this.processStatus(buf.subarray(2))
            return
        }

        if (buf.length === 2 + STATUS_LENGTH * 2 && buf[0] === 0x10 && buf[1] === 0xec) {
            this.processStatus(buf.subarray(2 + STATUS_LENGTH))
            return
        }

        // Door event: zone 1=fridge, zone 2=freezer; state 1=open, 0=closed.
        // The appliance does not distinguish the left and right door within a zone.
        if (buf.length === 4 && buf[0] === 0x10 && buf[1] === 0xa8) {
            const property = buf[2] === 1 ? 'fridge_door' : buf[2] === 2 ? 'freezer_door' : undefined
            if (property && (buf[3] === 0 || buf[3] === 1)) this.publishProperty(property, buf[3] ? 'ON' : 'OFF')
        }
    }

    private processStatus(status: Buffer) {
        this.currentStatus = Buffer.from(status)
        this.publishProperty('fridge_setpoint', 8 - status[1])
        this.publishProperty('freezer_setpoint', -14 - status[2])
        this.publishProperty('express_freeze', status[3] === 2 ? 'ON' : 'OFF')
        this.publishProperty('door', status[7] === 1 ? 'ON' : 'OFF')
        this.publishProperty('control_panel_lock', status[10] === 2 ? 'ON' : 'OFF')
    }

    private sendSetting(offset: number, value: number) {
        if (!this.currentStatus) return
        const command = Buffer.alloc(COMMAND_LENGTH, 0xff)
        this.currentStatus.copy(command, 0)
        COMMAND_SUFFIX.copy(command, STATUS_LENGTH)
        command[offset] = value
        this.send(Buffer.concat([Buffer.from('F017', 'hex'), command]))
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'fridge_setpoint') {
            const value = Number(mqttValue)
            if (Number.isInteger(value) && value >= 1 && value <= 7) this.sendSetting(1, 8 - value)
        } else if (prop === 'freezer_setpoint') {
            const value = Number(mqttValue)
            if (Number.isInteger(value) && value >= -23 && value <= -15) this.sendSetting(2, -14 - value)
        } else if (prop === 'express_freeze' && (mqttValue === 'ON' || mqttValue === 'OFF')) {
            this.sendSetting(3, mqttValue === 'ON' ? 2 : 1)
        }
    }
}
