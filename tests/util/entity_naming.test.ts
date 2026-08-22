import { test } from 'node:test'
import assert from 'node:assert/strict'
import { entityObjectId, nameEntities } from '@/util/entity_naming'
import type { DeviceDiscovery } from '@/cloud/homeassistant'

function discovery(components: Record<string, Record<string, unknown>>, name = '안방에어컨') {
    return { device: { name }, components } as unknown as DeviceDiscovery
}

test('an entity is named after its appliance and the component that publishes it', () => {
    assert.equal(entityObjectId('안방에어컨', 'energy_current', 'sensor'), 'rethink_안방에어컨_energy_current')
    assert.equal(entityObjectId('거실제습기', 'off_timer', 'number'), 'rethink_거실제습기_off_timer')
})

test('the component key is dropped when it only repeats what the appliance is', () => {
    // climate.rethink_anbangeeokeon_climate says the same thing twice.
    assert.equal(entityObjectId('안방에어컨', 'climate', 'climate'), 'rethink_안방에어컨')
    assert.equal(entityObjectId('거실제습기', 'dehumidifier', 'humidifier'), 'rethink_거실제습기')
    // Only for the platform it actually names: a sensor called climate is still a reading.
    assert.equal(entityObjectId('안방에어컨', 'climate', 'sensor'), 'rethink_안방에어컨_climate')
})

test('every component in a payload is named', () => {
    const config = discovery({
        climate: { platform: 'climate' },
        energy_current: { platform: 'sensor', device_class: 'power' },
        sleeptimer: { platform: 'number', min: 0 },
    })
    nameEntities(config)

    const components = config.components as unknown as Record<string, Record<string, unknown>>
    assert.equal(components.energy_current.object_id, 'rethink_안방에어컨_energy_current')
    assert.equal(components.sleeptimer.object_id, 'rethink_안방에어컨_sleeptimer')
})

test('a retirement notice is left alone', () => {
    /*
     * A component carrying nothing but its platform is how a device tells Home Assistant
     * that the component is gone. A second key would stop it being recognised as a removal,
     * and the entity would stay on the appliance's page for good.
     */
    const config = discovery({
        climate: { platform: 'climate' },
        sound: { platform: 'switch' },
    })
    nameEntities(config)

    const components = config.components as unknown as Record<string, Record<string, unknown>>
    assert.deepEqual(components.sound, { platform: 'switch' }, 'the removal payload must not grow a key')
    assert.deepEqual(components.climate, { platform: 'climate' }, 'nor may a one-key main entity')
})

test('a name a handler chose for itself is not overwritten', () => {
    const config = discovery({ power: { platform: 'sensor', object_id: 'something_deliberate' } })
    nameEntities(config)

    const components = config.components as unknown as Record<string, Record<string, unknown>>
    assert.equal(components.power.object_id, 'something_deliberate')
})

test('an appliance with no name yet is left unnamed rather than called rethink_undefined', () => {
    const config = {
        device: {},
        components: { power: { platform: 'sensor', name: 'Power' } },
    } as unknown as DeviceDiscovery
    nameEntities(config)

    const components = config.components as unknown as Record<string, Record<string, unknown>>
    assert.equal(components.power.object_id, undefined)
})
