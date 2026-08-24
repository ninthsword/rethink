import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { Connection } from '@/bridge/thinq2connection'
import { Thinq2Device } from '@/bridge/thinqApi'
import type { ClipDeployMessage } from '@/cloud/thinq2/clip'

const DEVICE_ID = 'pac-id'
const STATE = {
    mqttServer: 'ssl://cloud.example:8883',
    provTopic: 'prov/topic',
    pubTopic: 'pub/topic',
    subTopic: 'sub/topic',
    countryCode: 'KR',
    caCertificate: '',
    privateKey: '',
    certificate: '',
} as never

/** What the living-room air conditioner actually announces itself with. */
const REAL_DEPLOY = {
    mid: 1006229,
    did: DEVICE_ID,
    kind: 'PAC_910604_WW',
    cmd: 'deploy',
    data: {
        appInfo: {
            modelName: 'PAC_910604_WW',
            countryCode: 'KR',
            appVersion: 'clip_hna_v1.9.230',
            modemType: 'QCOM_QCA4010',
            regionalCode: '+0900',
            timezone: '+0900',
            DeviceType: '401',
            protocolVer: '7',
        },
        platformInfo: { provisioningKey: 'PAC_910604_WW' },
    },
} as unknown as ClipDeployMessage

function announce(profile?: ClipDeployMessage) {
    const published: Array<{ topic: string; message: string }> = []
    const connection = Object.create(Connection.prototype) as Connection
    Object.assign(connection, {
        device: Object.assign(new Thinq2Device(DEVICE_ID, { modelId: 'PAC_910604_WW', modelName: 'PAC_910604_WW' }), {
            state: STATE,
        }),
        deployProfile: profile,
        state: STATE,
        mid: 10000,
        mqtt: {
            subscribe: async () => {},
            publish: (topic: string, message: string) => published.push({ topic, message }),
        },
    })
    return { connection, published }
}

describe('what the bridge tells the LG cloud about the appliance', () => {
    test('the appliance describes itself and the bridge passes that on', async () => {
        // The template this replaced claimed a European timezone and region, an empty device
        // type and a modem the appliance does not have, for a Korean air conditioner.
        const { connection, published } = announce(REAL_DEPLOY)
        await connection.announceToCloud()

        assert.equal(published.length, 1)
        assert.equal(published[0].topic, 'prov/topic')
        const sent = JSON.parse(published[0].message)
        assert.equal(sent.cmd, 'deploy')
        assert.equal(sent.data.appInfo.timezone, '+0900')
        assert.equal(sent.data.appInfo.DeviceType, '401')
        assert.equal(sent.data.appInfo.modemType, 'QCOM_QCA4010')
        assert.equal(sent.data.appInfo.protocolVer, '7')
        assert.notEqual(sent.mid, REAL_DEPLOY.mid, 'a fresh message id for a fresh publish')
    })

    test('an appliance that has said nothing yet is still announced', async () => {
        // It can reach the cloud before it reaches rethink, and the bridge cannot wait.
        const { connection, published } = announce(undefined)
        await connection.announceToCloud()

        assert.equal(published.length, 1)
        const sent = JSON.parse(published[0].message)
        assert.equal(sent.cmd, 'preDeploy')
        assert.equal(sent.data.appInfo.modelName, 'PAC_910604_WW')
    })
})
