import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { MqttClient } from 'mqtt'
import { Connection, type DeviceDiscovery } from '@/cloud/homeassistant'

type Published = { topic: string; payload: string; options: unknown }

function fakeConnection(config: Record<string, unknown>) {
    const published: Published[] = []
    const subscribed: string[] = []
    const unsubscribed: string[] = []
    const connection = Object.create(Connection.prototype) as Connection
    Object.assign(connection, {
        config: { discovery_prefix: 'homeassistant', rethink_prefix: 'rethink', ...config },
        client: {
            publish(topic: string, payload: string | Buffer, options: unknown) {
                published.push({ topic, payload: String(payload), options })
            },
            subscribe: (filter: string) => subscribed.push(filter),
            unsubscribe: (filter: string) => unsubscribed.push(filter),
        } as unknown as MqttClient,
        publishedAvailability: new Set<string>(),
        localizedCommandValues: new Map(),
        localizedStateValues: new Map(),
        liveProperties: new Map(),
        sweepTimers: new Map(),
    })
    return { connection, published, subscribed, unsubscribed }
}

test('publishConfig retains the current model-specific MQTT discovery config', () => {
    const { connection, published } = fakeConnection({})

    const config = {
        device: { identifiers: '$deviceid', model: 'PAC_910604_WW' },
        origin: { name: 'rethink' },
        components: {
            climate: {
                platform: 'climate',
                unique_id: '$deviceid-climate',
                mode_command_topic: '$this/climate-mode/set',
            },
        },
    } as unknown as DeviceDiscovery

    connection.publishConfig('pac-id', config)

    assert.equal(published.length, 1)
    assert.equal(published[0].topic, 'homeassistant/device/rethink/pac-id/config')
    assert.deepEqual(published[0].options, { retain: true })
    assert.deepEqual(JSON.parse(published[0].payload), {
        device: { identifiers: 'pac-id', model: 'PAC_910604_WW' },
        origin: { name: 'rethink' },
        components: {
            climate: {
                platform: 'climate',
                unique_id: 'pac-id-climate',
                mode_command_topic: 'rethink/pac-id/climate-mode/set',
            },
        },
    })
})

test('publishConfig does not replace a valid retained config with an invalid one', () => {
    const { connection, published } = fakeConnection({})

    connection.publishConfig('bad-id', {
        device: { identifiers: '$deviceid', name: 'Bad appliance' },
        origin: { name: 'rethink' },
        components: {
            mode: {
                platform: 'select',
                unique_id: '$deviceid-mode',
                options: ['normal'],
            },
        },
    } as unknown as DeviceDiscovery)

    assert.equal(published.length, 0)
})

test('korean language localizes discovery and state while preserving HA protocol values', () => {
    const { connection, published } = fakeConnection({ language: 'korean' })
    connection.setDeviceNameResolver((id) => (id === 'dryer-id' ? '의류건조기' : undefined))

    const config = {
        device: { identifiers: '$deviceid', model: 'RH16KR', name: 'LG Dryer' },
        origin: { name: 'rethink' },
        components: {
            status: {
                platform: 'sensor',
                unique_id: '$deviceid-status',
                name: 'Status',
                state_topic: '$this/status',
                device_class: 'enum',
                options: ['RUNNING', 'END'],
            },
            power: {
                platform: 'binary_sensor',
                unique_id: '$deviceid-power',
                name: 'Power',
                state_topic: '$this/power',
            },
            climate: {
                platform: 'climate',
                unique_id: '$deviceid-climate',
                name: null,
                modes: ['off', 'cool', 'fan_only'],
                mode_state_topic: '$this/climate-mode',
                mode_command_topic: '$this/climate-mode/set',
                fan_modes: ['auto', 'low'],
                fan_mode_state_topic: '$this/climate-fan_mode',
                fan_mode_command_topic: '$this/climate-fan_mode/set',
            },
            dehumidifier: {
                platform: 'humidifier',
                unique_id: '$deviceid-dehumidifier',
                name: null,
                modes: ['smart', 'fast'],
                target_humidity_command_topic: '$this/target_humidity/set',
                mode_state_topic: '$this/operation_mode',
                mode_command_topic: '$this/operation_mode/set',
            },
        },
    } as unknown as DeviceDiscovery

    connection.publishConfig('dryer-id', config)
    connection.publishProperty('dryer-id', 'status', 'RUNNING')
    connection.publishProperty('dryer-id', 'power', 'ON')
    connection.publishProperty('dryer-id', 'climate-fan_mode', 'auto')
    connection.publishProperty('dryer-id', 'operation_mode', 'smart')
    connection.publishProperty('dryer-id', 'climate-mode', 'off')

    const discovery = JSON.parse(published[0].payload)
    assert.equal(discovery.components.status.name, '상태')
    assert.deepEqual(discovery.components.status.options, ['운전 중', '완료'])
    assert.equal(discovery.components.power.name, '전원')
    assert.equal(discovery.device.name, '의류건조기')
    // A climate entity's modes are Home Assistant's own HVAC modes; translating them
    // makes Home Assistant drop the ones it does not recognise, which is how the air
    // conditioners lost their "off". A humidifier names its own modes, so those are
    // translated as before.
    assert.deepEqual(discovery.components.climate.modes, ['off', 'cool', 'fan_only'])
    assert.deepEqual(discovery.components.dehumidifier.modes, ['스마트', '쾌속'])
    assert.deepEqual(discovery.components.climate.fan_modes, ['자동', '약'])
    assert.equal(published[1].payload, '운전 중')
    assert.equal(published[2].payload, 'ON')
    assert.equal(published[3].payload, '자동')
    assert.equal(published[4].payload, '스마트')
    assert.equal(published[5].payload, 'off', 'the HVAC mode must reach Home Assistant untranslated')
    assert.equal(connection.localizedCommandValues.get('dryer-id/operation_mode')?.get('스마트'), 'smart')
    assert.equal(connection.localizedCommandValues.get('dryer-id/climate-mode')?.get('off'), 'off')
})

test('korean language localizes Korean appliance course values', () => {
    const { connection, published } = fakeConnection({ language: 'korean' })

    connection.publishProperty('dishwasher-id', 'current_download_course', 'FISH_DISH')
    connection.publishProperty('dryer-id', 'downloaded_course', 'SELFCLEANING')

    assert.equal(published[0].payload, '생선 요리')
    assert.equal(published[1].payload, '자가 세척')
})

test('clearRetainedProperty removes the broker value with an empty retained payload', () => {
    const { connection, published } = fakeConnection({})

    connection.clearRetainedProperty('rac-id', 'filterchangeddate')

    assert.deepEqual(published, [{ topic: 'rethink/rac-id/filterchangeddate', payload: '', options: { retain: true } }])
})

function config(components: Record<string, unknown>) {
    return {
        device: { identifiers: '$deviceid', name: 'Living room air conditioner' },
        origin: { name: 'rethink' },
        components,
    } as unknown as DeviceDiscovery
}

const FILTER_REMAINING = {
    filterremaining: {
        platform: 'sensor',
        unique_id: '$deviceid-filterremaining',
        state_topic: '$this/filterremaining',
    },
}
const FILTER_HOURS = {
    filterused: { platform: 'sensor', unique_id: '$deviceid-filterused', state_topic: '$this/filterused' },
    filterreset: { platform: 'button', unique_id: '$deviceid-filterreset', command_topic: '$this/filterreset/set' },
}

function retained(connection: Connection, topic: string, payload: string) {
    const [, id, property] = topic.split('/')
    connection.received(topic, Buffer.from(payload), { retain: true, topic, payload } as never)
    return { id, property }
}

test('a value left behind by a replaced entity is cleared from the broker', (t) => {
    // The living-room air conditioner moved from a used/lifetime pair to a single
    // remaining-life figure, and the old values sat retained on the broker afterwards with
    // no entity left to correct them.
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { connection, published, subscribed } = fakeConnection({})

    connection.publishConfig('pac-id', config(FILTER_REMAINING))
    assert.deepEqual(subscribed, ['rethink/pac-id/+'], 'the broker has to be asked what it still holds')

    published.length = 0
    retained(connection, 'rethink/pac-id/filterused', '0')
    retained(connection, 'rethink/pac-id/filterlife', '720')
    retained(connection, 'rethink/pac-id/filterremaining', '68')

    assert.deepEqual(
        published.map((p) => p.topic),
        ['rethink/pac-id/filterused', 'rethink/pac-id/filterlife'],
        'only the values no entity publishes any more',
    )
    assert.deepEqual(published[0].payload, '', 'and clearing means an empty retained payload')
    assert.deepEqual(published[0].options, { retain: true })
})

test('the sweep window closes and the subscription goes with it', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { connection, published, unsubscribed } = fakeConnection({})
    connection.publishConfig('pac-id', config(FILTER_REMAINING))

    t.mock.timers.tick(10 * 1000)
    assert.deepEqual(unsubscribed, ['rethink/pac-id/+'])

    // Past the window rethink has no business judging what belongs on these topics.
    published.length = 0
    retained(connection, 'rethink/pac-id/filterused', '0')
    assert.deepEqual(published, [])
})

test('republishing an unchanged config does not re-sweep', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { connection, subscribed } = fakeConnection({})

    // Home Assistant announcing `online` makes every device publish its config again.
    connection.publishConfig('pac-id', config(FILTER_REMAINING))
    t.mock.timers.tick(10 * 1000)
    connection.publishConfig('pac-id', config(FILTER_REMAINING))

    assert.deepEqual(subscribed, ['rethink/pac-id/+'], 'nothing can have been left behind')
})

test('a config that gains an entity sweeps again', (t) => {
    // The air conditioners only learn whether they have a filter after the appliance
    // answers, so their entity set grows mid-run.
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { connection, published, subscribed } = fakeConnection({})

    connection.publishConfig('pac-id', config(FILTER_REMAINING))
    t.mock.timers.tick(10 * 1000)
    connection.publishConfig('pac-id', config({ ...FILTER_REMAINING, ...FILTER_HOURS }))
    assert.equal(subscribed.length, 2)

    published.length = 0
    retained(connection, 'rethink/pac-id/filterused', '0')
    retained(connection, 'rethink/pac-id/filterlife', '720')
    assert.deepEqual(
        published.map((p) => p.topic),
        ['rethink/pac-id/filterlife'],
        'the entity that came back keeps its value',
    )
})

test('availability, commands and empty topics are left alone', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { connection, published } = fakeConnection({})
    connection.publishConfig('pac-id', config(FILTER_HOURS))

    published.length = 0
    // A command topic is three elements deep and never retained.
    connection.received('rethink/pac-id/filterreset/set', Buffer.from('PRESS'), { retain: true } as never)
    // An already-cleared topic is not holding anything.
    retained(connection, 'rethink/pac-id/filterlife', '')
    // A live delivery is the appliance reporting, not the broker's memory.
    connection.received('rethink/pac-id/filterlife', Buffer.from('720'), { retain: false } as never)
    assert.deepEqual(published, [])

    // Availability is swept too, but by the mechanism that already existed for it: a
    // stale "online" becomes "offline", not an empty payload.
    retained(connection, 'rethink/pac-id/availability', 'online')
    assert.deepEqual(published, [
        { topic: 'rethink/pac-id/availability', payload: 'offline', options: { retain: true } },
    ])
})
