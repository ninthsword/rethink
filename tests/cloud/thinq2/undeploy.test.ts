import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Broker } from '@/cloud/mqtt-broker'
import { DeviceAcceptor } from '@/cloud/thinq2/device'

const DEVICE_ID = 'dryer-id'

function deployMessage() {
    return {
        did: DEVICE_ID,
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
    acceptor.on('newDevice', (dev) => added.push(dev.id))
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
    assert.equal(client.deviceObj, undefined)
    assert.equal(client.deployMsg, undefined)

    register(acceptor, client)
    assert.deepEqual(added, [DEVICE_ID, DEVICE_ID], 'the appliance must be able to come back')
})

test('closing a replaced client does not erase the current client index', () => {
    const acceptor = new DeviceAcceptor(new Broker())
    const oldClient = { destroy() {} } as Record<string, unknown>
    const newClient = { destroy() {} } as Record<string, unknown>

    register(acceptor, oldClient)
    register(acceptor, newClient)
    assert.equal(acceptor.clientsById[DEVICE_ID], newClient)

    // The real socket close is asynchronous and can arrive after completeProvisioning
    // has installed the replacement. The old event must not make a third connection look
    // as if no client were present.
    acceptor.disconnected(oldClient as never)
    assert.equal(acceptor.clientsById[DEVICE_ID], newClient)
})
