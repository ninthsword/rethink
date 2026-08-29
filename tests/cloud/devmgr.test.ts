import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import type { AnyDevice } from '@/cloud/devmgr'
import { DeviceManager } from '@/cloud/devmgr'

function fakeDevice(id: string) {
    const device = new EventEmitter() as EventEmitter & {
        id: string
        meta: { modelId: string; modelName: string }
        platform: string
    }
    device.id = id
    device.meta = { modelId: 'test', modelName: 'test' }
    device.platform = 'test'
    return device as unknown as AnyDevice
}

test('DeviceManager retains arbitrary identifiers and removes the matching device', () => {
    const manager = new DeviceManager()
    const prototypeNamed = fakeDevice('__proto__')
    const stringNamed = fakeDevice('toString')

    manager.accept(prototypeNamed)
    manager.accept(stringNamed)

    assert.equal(manager.allDevices.get('__proto__'), prototypeNamed)
    assert.equal(manager.allDevices.get('toString'), stringNamed)
    assert.deepEqual([...manager.allDevices.keys()], ['__proto__', 'toString'])

    prototypeNamed.emit('close')
    assert.equal(manager.allDevices.has('__proto__'), false)
    assert.equal(manager.allDevices.get('toString'), stringNamed)
})
