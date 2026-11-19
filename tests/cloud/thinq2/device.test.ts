import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Broker, type PublishPacket } from '@/cloud/mqtt-broker'
import type { ClipMessage } from '@/cloud/thinq2/clip'
import { Device, DeviceAcceptor } from '@/cloud/thinq2/device'

describe('ThinQ2 device message forwarding', () => {
    it('forwards a cloud ack JSON without changing its mid, cmd or data', () => {
        const broker = new Broker()
        const device = new Device(broker, 'lime/devices/fridge', 'fridge', {
            modelId: '2RES2VE300UA2',
            modelName: '2RES2VE300UA2',
        })
        const published: PublishPacket[] = []
        broker.on('publish', (packet) => published.push(packet))

        const ack = {
            did: 'fridge',
            mid: 1785283454163,
            cmd: 'ack',
            type: 1,
            data: 'AA08F000C5043EBB',
        } as ClipMessage

        device.forward_message(ack)

        assert.equal(published.length, 1)
        assert.equal(published[0].topic, 'lime/devices/fridge')
        assert.deepEqual(JSON.parse(published[0].payload.toString()), ack)
    })

    it('forwards a cloud modem command JSON without changing its mid, cmd or data', () => {
        const broker = new Broker()
        const device = new Device(broker, 'lime/devices/aircon', 'aircon', {
            modelId: 'PAC_910604_WW',
            modelName: 'PAC_910604_WW',
        })
        const published: PublishPacket[] = []
        broker.on('publish', (packet) => published.push(packet))

        const command = {
            did: 'aircon',
            mid: 1786291393406,
            cmd: 'modem_cmd',
            type: 1,
            data: 'reserv-get-3',
        } as ClipMessage

        device.forward_message(command)

        assert.equal(published.length, 1)
        assert.deepEqual(JSON.parse(published[0].payload.toString()), command)
    })

    it('emits the original device modem response for transparent cloud forwarding', () => {
        const broker = new Broker()
        const acceptor = new DeviceAcceptor(broker)
        const device = new Device(broker, 'lime/devices/aircon', 'aircon', {
            modelId: 'PAC_910604_WW',
            modelName: 'PAC_910604_WW',
        })
        const client = { deviceObj: device, deployMsg: undefined }
        const received: ClipMessage[] = []
        device.onBridgeMessage((payload) => received.push(payload))

        const response = {
            did: 'aircon',
            mid: 112139777,
            cmd: 'modem_cmd',
            type: 1,
            data: 'reserv-result-3',
        } as ClipMessage

        acceptor.mqtt('clip/message/devices/aircon', response, client as never)

        assert.deepEqual(received, [response])
    })

    it('retains prototype-like identifiers through provisioning', () => {
        const acceptor = new DeviceAcceptor(new Broker())
        const clients = new Map<string, Record<string, unknown>>()

        for (const id of ['__proto__', 'toString']) {
            const client: Record<string, unknown> = { deviceObj: undefined, deployMsg: undefined }
            clients.set(id, client)
            acceptor.mqtt(
                `clip/provisioning/devices/${id}`,
                {
                    did: id,
                    kind: 'TEST_DEVICE',
                    cmd: id === '__proto__' ? 'preDeploy' : 'deploy',
                    data: { appInfo: { modelName: 'TEST_DEVICE' } },
                } as never,
                client as never,
            )
            acceptor.mqtt(
                `clip/message/devices/${id}`,
                { did: id, cmd: 'completeProvisioning_ack' } as never,
                client as never,
            )
        }

        assert.equal(acceptor.clientsById.get('__proto__'), clients.get('__proto__'))
        assert.equal(acceptor.clientsById.get('toString'), clients.get('toString'))
        assert.equal(acceptor.clientsById.size, 2)

        acceptor.disconnected(clients.get('__proto__') as never)
        assert.equal(acceptor.clientsById.has('__proto__'), false)
        assert.equal(acceptor.clientsById.has('toString'), true)
    })
})

describe('ThinQ2 rssi event', () => {
    const DEPLOY = {
        did: 'washer',
        kind: 'Hd0C_F',
        cmd: 'deploy',
        rssi: -61,
        data: { appInfo: { modelName: 'Hd0C_F' } },
    }

    function registeredAppliance() {
        const acceptor = new DeviceAcceptor(new Broker())
        const client: Record<string, unknown> = { deviceObj: undefined, deployMsg: undefined }
        const devices: Device[] = []
        acceptor.on('newDevice', (dev) => devices.push(dev))
        acceptor.mqtt('clip/provisioning/devices/washer', DEPLOY, client as never)
        acceptor.mqtt(
            'clip/message/devices/washer',
            { did: 'washer', cmd: 'completeProvisioning_ack', rssi: -62 },
            client as never,
        )
        assert.equal(devices.length, 1)
        const readings: unknown[] = []
        devices[0].onRssi((rssi) => readings.push(rssi))
        return { acceptor, client, device: devices[0], readings }
    }

    it('is emitted for every envelope a registered appliance sends about itself', () => {
        const { acceptor, client, readings } = registeredAppliance()

        acceptor.mqtt(
            'clip/message/devices/washer',
            { did: 'washer', cmd: 'device_packet', data: '00', rssi: -50 },
            client as never,
        )
        acceptor.mqtt('clip/message/devices/washer', { did: 'washer', cmd: 'req_timesync', rssi: -51 }, client as never)
        // A repeat acknowledgement on an already registered connection.
        acceptor.mqtt(
            'clip/message/devices/washer',
            { did: 'washer', cmd: 'completeProvisioning_ack', rssi: -52 },
            client as never,
        )
        acceptor.mqtt('clip/provisioning/devices/washer', { ...DEPLOY, rssi: -53 }, client as never)

        assert.deepEqual(readings, [-50, -51, -52, -53])
    })

    it('is not emitted for another did, an envelope without rssi or an unregistered connection', () => {
        const { acceptor, client, readings } = registeredAppliance()

        acceptor.mqtt('clip/message/devices/other', { did: 'other', cmd: 'device_packet', rssi: -50 }, client as never)
        acceptor.mqtt('clip/message/devices/washer', { did: 'other', cmd: 'device_packet', rssi: -50 }, client as never)
        acceptor.mqtt(
            'clip/message/devices/washer',
            { did: 'washer', cmd: 'device_packet', data: '00' },
            client as never,
        )
        assert.deepEqual(readings, [])

        const stranger: Record<string, unknown> = { deviceObj: undefined, deployMsg: undefined }
        assert.doesNotThrow(() =>
            acceptor.mqtt(
                'clip/message/devices/washer',
                { did: 'washer', cmd: 'device_packet', rssi: -50 },
                stranger as never,
            ),
        )
        assert.deepEqual(readings, [])
    })

    it('is emitted before the envelope reaches its data and bridge-message listeners', () => {
        const { acceptor, client, device } = registeredAppliance()
        const order: string[] = []
        device.on('data', () => order.push('data'))
        device.onBridgeMessage(() => order.push('bridge'))
        device.onRssi(() => order.push('rssi'))

        acceptor.mqtt(
            'clip/message/devices/washer',
            { did: 'washer', cmd: 'device_packet', data: '00', rssi: -50 },
            client as never,
        )

        assert.deepEqual(order, ['rssi', 'data', 'bridge'])
    })
})
