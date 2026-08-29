import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Broker } from '@/cloud/mqtt-broker'
import { DeviceAcceptor } from '@/cloud/thinq2/device'

const DEVICE_ID = 'dryer-id'

function deployMessage(deviceId = DEVICE_ID) {
    return {
        did: deviceId,
        kind: 'RH16_N_KR',
        cmd: 'deploy',
        data: { appInfo: { modelName: 'RH16_N_KR', softVer: '2.9.66', DeviceType: '202' } },
    }
}

function register(acceptor: DeviceAcceptor, client: Record<string, unknown>) {
    acceptor.mqtt(`clip/provisioning/devices/${DEVICE_ID}`, deployMessage() as never, client as never)
    acceptor.mqtt(
        `clip/message/devices/${DEVICE_ID}`,
        { did: DEVICE_ID, cmd: 'completeProvisioning_ack' } as never,
        client as never,
    )
}

test('an appliance that undeploys can register again on the same connection', () => {
    const acceptor = new DeviceAcceptor(new Broker())
    const client = {} as Record<string, unknown>
    const added: string[] = []
    const dropped: string[] = []
    let closes = 0
    acceptor.on('newDevice', (dev) => added.push(dev.id))
    acceptor.on('newDevice', (dev) => dev.on('close', () => closes++))
    acceptor.on('dropDevice', (id) => dropped.push(id))

    register(acceptor, client)
    assert.deepEqual(added, [DEVICE_ID])

    // The dryer sent this after being re-registered in the ThinQ app, and rethink ignored
    // it: the device object stayed, so the deploy that followed was refused as a duplicate
    // and the appliance never came back while quietly no longer sending state.
    acceptor.mqtt(
        `clip/provisioning/devices/${DEVICE_ID}`,
        { did: DEVICE_ID, cmd: 'undeploy' } as never,
        client as never,
    )
    assert.deepEqual(dropped, [DEVICE_ID])
    assert.equal(closes, 1)
    assert.equal(client.deviceObj, undefined)
    assert.equal(client.deployMsg, undefined)

    register(acceptor, client)
    assert.deepEqual(added, [DEVICE_ID, DEVICE_ID], 'the appliance must be able to come back')
})

test('invalid provisioning and acknowledgement messages do not mutate registration state', () => {
    const broker = new Broker()
    const acceptor = new DeviceAcceptor(broker)
    const client = {} as Record<string, unknown>
    let added = 0
    acceptor.on('newDevice', () => added++)
    const valid = deployMessage()
    const invalidDeployments: unknown[] = [
        null,
        [],
        { ...valid, did: {} },
        { ...valid, did: '' },
        { ...valid, did: 'x'.repeat(129) },
        { ...valid, kind: {} },
        { ...valid, kind: '' },
        { ...valid, data: null },
        { ...valid, data: { appInfo: [] } },
        { ...valid, data: { appInfo: { modelName: {} } } },
        { ...valid, data: { appInfo: { modelName: '' } } },
        { ...valid, data: { appInfo: { modelName: 'x'.repeat(129) } } },
        { ...valid, data: { appInfo: { modelName: 'MODEL', DeviceType: {} } } },
    ]

    for (const payload of invalidDeployments)
        acceptor.mqtt(`clip/provisioning/devices/${DEVICE_ID}`, payload as never, client as never)
    acceptor.mqtt(`clip/provisioning/devices/${DEVICE_ID}`, { ...valid, did: 'other-id' } as never, client as never)
    const invalidAcks: unknown[] = [
        null,
        [],
        { did: {} },
        { did: '' },
        { did: 'x'.repeat(129) },
        { did: DEVICE_ID, cmd: {} },
        { did: 'other-id', cmd: 'completeProvisioning_ack' },
    ]
    for (const payload of invalidAcks)
        acceptor.mqtt(`clip/message/devices/${DEVICE_ID}`, payload as never, client as never)

    assert.equal(client.deployMsg, undefined)
    assert.equal(acceptor.clientsById.size, 0)
    assert.equal(added, 0)
})

test('invalid deployment does not replace an existing valid registration', () => {
    const acceptor = new DeviceAcceptor(new Broker())
    const client = {} as Record<string, unknown>
    register(acceptor, client)
    const originalDeploy = client.deployMsg
    const originalDevice = client.deviceObj

    acceptor.mqtt(
        `clip/provisioning/devices/${DEVICE_ID}`,
        { ...deployMessage(), kind: 'x'.repeat(129) } as never,
        client as never,
    )

    assert.equal(client.deployMsg, originalDeploy)
    assert.equal(client.deviceObj, originalDevice)
    assert.equal(acceptor.clientsById.get(DEVICE_ID), client)
})

test('unsafe device ids are rejected before mutating an existing registration', () => {
    const broker = new Broker()
    const acceptor = new DeviceAcceptor(broker)
    const client = {} as Record<string, unknown>
    let responses = 0
    broker.on('publish', () => responses++)

    register(acceptor, client)
    const originalDeploy = client.deployMsg
    const originalDevice = client.deviceObj
    const responseCount = responses
    const invalidIds = [
        'id/child',
        'id+wildcard',
        'id#wildcard',
        'id,other',
        'id with space',
        'id\u0000control',
        'x'.repeat(129),
    ]

    for (const deviceId of invalidIds) {
        acceptor.mqtt(
            `clip/provisioning/devices/${deviceId}`,
            { ...deployMessage(deviceId), did: deviceId } as never,
            client as never,
        )
        acceptor.mqtt(
            `clip/message/devices/${deviceId}`,
            { did: deviceId, cmd: 'completeProvisioning_ack' } as never,
            client as never,
        )
        acceptor.mqtt(
            `clip/provisioning/devices/${deviceId}`,
            { did: deviceId, cmd: 'undeploy' } as never,
            client as never,
        )
    }

    assert.equal(client.deployMsg, originalDeploy)
    assert.equal(client.deviceObj, originalDevice)
    assert.equal(acceptor.clientsById.get(DEVICE_ID), client)
    assert.equal(acceptor.clientsById.size, 1)
    assert.equal(responses, responseCount)
})

test('undeploy for another device cannot clear a pending deployment', () => {
    const broker = new Broker()
    const acceptor = new DeviceAcceptor(broker)
    const client = {} as Record<string, unknown>
    const dropped: string[] = []
    let responses = 0
    acceptor.on('dropDevice', (id) => dropped.push(id))
    broker.on('publish', () => responses++)

    acceptor.mqtt(`clip/provisioning/devices/${DEVICE_ID}`, deployMessage() as never, client as never)
    const originalDeploy = client.deployMsg
    const responseCount = responses

    acceptor.mqtt(
        'clip/provisioning/devices/other-id',
        { ...deployMessage('other-id'), cmd: 'undeploy' } as never,
        client as never,
    )

    assert.equal(client.deployMsg, originalDeploy)
    assert.equal(client.deviceObj, undefined)
    assert.equal(acceptor.clientsById.size, 0)
    assert.deepEqual(dropped, [])
    assert.equal(responses, responseCount)
})

test('undeploy for another device cannot clear a registered device', () => {
    const acceptor = new DeviceAcceptor(new Broker())
    const client = {} as Record<string, unknown>
    const dropped: string[] = []
    let closes = 0
    let responses = 0
    acceptor.on('dropDevice', (id) => dropped.push(id))
    acceptor.on('newDevice', (dev) => dev.on('close', () => closes++))
    acceptor.broker.on('publish', () => responses++)

    register(acceptor, client)
    const originalDeploy = client.deployMsg
    const originalDevice = client.deviceObj
    const responseCount = responses

    acceptor.mqtt(
        'clip/provisioning/devices/other-id',
        { ...deployMessage('other-id'), cmd: 'undeploy' } as never,
        client as never,
    )

    assert.equal(client.deployMsg, originalDeploy)
    assert.equal(client.deviceObj, originalDevice)
    assert.equal(acceptor.clientsById.get(DEVICE_ID), client)
    assert.deepEqual(dropped, [])
    assert.equal(closes, 0)
    assert.equal(responses, responseCount)
})

test('acknowledgement and later deployment must stay bound to the client identity', () => {
    const broker = new Broker()
    const acceptor = new DeviceAcceptor(broker)
    const client = {} as Record<string, unknown>
    let published = 0
    let added = 0
    broker.on('publish', () => published++)
    acceptor.on('newDevice', () => added++)

    acceptor.mqtt(`clip/provisioning/devices/${DEVICE_ID}`, deployMessage() as never, client as never)
    const originalDeploy = client.deployMsg
    const invalidAck = { did: 'other-id', cmd: 'completeProvisioning_ack' }
    acceptor.mqtt(`clip/message/devices/other-id`, invalidAck as never, client as never)
    assert.equal(client.deviceObj, undefined)
    assert.equal(acceptor.clientsById.size, 0)
    assert.equal(added, 0)

    acceptor.mqtt(
        `clip/message/devices/${DEVICE_ID}`,
        { did: DEVICE_ID, cmd: 'completeProvisioning_ack' } as never,
        client as never,
    )
    const originalDevice = client.deviceObj
    const publishCount = published
    assert.equal(added, 1)

    acceptor.mqtt(
        'clip/provisioning/devices/other-id',
        { ...deployMessage(), did: 'other-id' } as never,
        client as never,
    )
    assert.equal(client.deployMsg, originalDeploy)
    assert.equal(client.deviceObj, originalDevice)
    assert.equal(acceptor.clientsById.get(DEVICE_ID), client)
    assert.equal(published, publishCount)
})

test('closing a replaced client does not erase the current client index', () => {
    const acceptor = new DeviceAcceptor(new Broker())
    const oldClient = { destroy() {} } as Record<string, unknown>
    const newClient = { destroy() {} } as Record<string, unknown>

    register(acceptor, oldClient)
    register(acceptor, newClient)
    assert.equal(acceptor.clientsById.get(DEVICE_ID), newClient)

    // The real socket close is asynchronous and can arrive after completeProvisioning
    // has installed the replacement. The old event must not make a third connection look
    // as if no client were present.
    acceptor.disconnected(oldClient as never)
    assert.equal(acceptor.clientsById.get(DEVICE_ID), newClient)
})
