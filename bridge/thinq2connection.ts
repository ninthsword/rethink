import * as mqtt from 'mqtt'
import { TypedEmitter } from 'tiny-typed-emitter'
import type { ClipDeployMessage, ClipMessage } from '@/cloud/thinq2/clip'
import log from '@/util/logging'
import type { Thinq2Device, Thinq2DeviceState } from './thinqApi'

type ConnectionEvents = {
    data: (buffer: Buffer) => void
    message: (payload: ClipMessage) => void
    close: () => void
    error: (error: Error) => void
}

export class Connection extends TypedEmitter<ConnectionEvents> {
    mqtt: mqtt.MqttClient
    mid = 10000
    readonly state: Thinq2DeviceState

    constructor(
        readonly device: Thinq2Device,
        /**
         * What the appliance announced itself with. Sent on to the cloud in place of the
         * template below, so the cloud is told the model, firmware, modem and timezone the
         * appliance actually reports rather than a Korean air conditioner being described as
         * a European one with no device type.
         */
        readonly deployProfile?: ClipDeployMessage,
    ) {
        super()
        const state = this.device.state
        if (!state) throw new Error('ThinQ2 bridge state is missing')
        this.state = state
        log('bridge', `${this.device.deviceId} connecting to ${state.mqttServer}`)
        this.mqtt = mqtt.connect(state.mqttServer.replace('ssl', 'mqtts'), {
            ca: state.caCertificate,
            key: state.privateKey,
            cert: state.certificate,
            clientId: this.device.deviceId,
            reconnectPeriod: 0, // no auto-reconnect
        })

        this.mqtt.on('message', (topic, message, packet) => {
            try {
                if (topic === this.state.subTopic) {
                    this.traceMqtt('cloud->rethink', topic, message.toString('utf-8'), packet)
                    const payload = JSON.parse(message.toString('utf-8'))
                    if (payload.cmd === 'completeProvisioning') {
                        //msgtopic=payload.data.appInfo.publication.message
                        const message = JSON.stringify({
                            mid: ++this.mid,
                            did: this.device.deviceId,
                            kind: this.device.meta.modelName,
                            cmd: 'completeProvisioning_ack',
                            rssi: -48,
                            fs: 'idle',
                            data: null,
                            type: 1,
                        })
                        this.publishToCloud(this.state.pubTopic, message)
                    }

                    // completeProvisioning terminates at the bridge. Every other command belongs to
                    // the physical device and must keep its original JSON envelope. Some ThinQ2
                    // features (for example repeating reservations) use modem_cmd rather than packet.
                    if (payload.cmd !== 'completeProvisioning') {
                        log('bridge', `${this.device.deviceId} <- ${payload.data}`)
                        this.emit('message', payload)
                        if (payload.cmd === 'packet' && typeof payload.data === 'string') {
                            this.emit('data', Buffer.from(payload.data, 'hex'))
                        }
                    }
                }
            } catch (err) {
                console.log(err)
            }
        })

        this.mqtt.on('connect', () => {
            log('bridge', `${this.device.deviceId} connected`)
            void this.announceToCloud()
        })

        this.mqtt.on('close', () => this.emit('close'))
        this.mqtt.on('error', (err) => this.emit('error', err))
    }

    /**
     * Tell the LG cloud which appliance this connection speaks for. Split out from the
     * connect handler so it can be exercised without a broker.
     */
    async announceToCloud() {
        await this.mqtt.subscribe(this.state.subTopic)
        if (this.deployProfile) {
            // The appliance has described itself; nothing here can describe it better.
            await this.publishToCloud(
                this.state.provTopic,
                JSON.stringify({ ...this.deployProfile, mid: ++this.mid }),
                1,
            )
            return
        }
        // Nothing has been heard from the appliance yet — it can reach the cloud before
        // it reaches us — so announce it from what the registration knows.
        const message = JSON.stringify({
            mid: ++this.mid,
            did: this.device.deviceId,
            kind: this.device.meta.modelName,
            cmd: 'preDeploy',
            rssi: -48,
            fs: 'idle',
            data: {
                appInfo: {
                    modelName: this.device.meta.modelName,
                    modelLanguage: this.state.countryCode,
                    softVer: '690409',
                    ruleVer: '2.0.11',
                    countryCode: this.state.countryCode,
                    subCountryCode: this.state.countryCode,
                    appVersion: 'clip_hna_v1.9.183',
                    modemType: 'RTK_RTL8711am',
                    regionalCode: 'eic',
                    timezone: '+0100',
                    svcCode: 'SVC202',
                    HomeApSsid: 'whatever',
                    DeviceType: '',
                    ruleEngine: 'y',
                    protocolVer: '1',
                    oneshot: 'y',
                    size: 1572864,
                    fwUpgradeInfo: {
                        upgSched: {
                            cmd: 'none',
                            upgUtc: '0',
                        },
                    },
                },
                platformInfo: {
                    provisioningKey: this.device.meta.modelName,
                    version: 'clip_v2.00.15.05-RTK_RTL8711am-SDK-8-RELEASE',
                },
            },
            type: 0,
        })
        await this.publishToCloud(this.state.provTopic, message, 1)
    }

    send(data: string | Buffer) {
        if (Buffer.isBuffer(data)) data = data.toString('hex').toUpperCase()

        log('bridge', `${this.device.deviceId} -> ${data}`)
        const message = JSON.stringify({
            mid: ++this.mid,
            did: this.device.deviceId,
            kind: this.device.meta.modelName,
            cmd: 'device_packet',
            rssi: -48,
            fs: 'idle',
            data,
            type: 1,
        })
        this.publishToCloud(this.state.pubTopic, message)
    }

    sendMessage(payload: ClipMessage) {
        log('bridge', `${this.device.deviceId} -> ${payload.cmd}`)
        this.publishToCloud(this.state.pubTopic, JSON.stringify(payload))
    }

    private publishToCloud(topic: string, message: string, qos: 0 | 1 | 2 = 0) {
        this.traceMqtt('rethink->cloud', topic, message, { qos, dup: false, retain: false })
        return this.mqtt.publish(topic, message, { qos })
    }

    private traceMqtt(
        direction: string,
        topic: string,
        payload: string,
        packet: { qos: number; dup: boolean; retain: boolean; messageId?: number },
    ) {
        log(
            'mqtt-trace',
            JSON.stringify({
                direction,
                topic,
                qos: packet.qos,
                dup: packet.dup,
                retain: packet.retain,
                messageId: packet.messageId,
                payload,
            }),
        )
    }

    destroy() {
        this.mqtt.end()
    }
}
