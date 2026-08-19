import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/RAC_056905_WW'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'
import * as TLV from '@/util/tlv'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'RAC_056905_WW'
const META: Metadata = { modelId: MODEL_ID, modelName: 'TEST', swVersion: '1.0' }

// Real packet captures from a RAC_056905_WW air conditioner.

// Capability request
const CAPS_REQUEST_HEX = '01010400000065020201027D416A0D'

// Capability response (response to query 0x1F5/1). Contains TLV t=0x2DA (eeprom checksum),
// which triggers `isCapsResponse`
const CAPS_RESPONSE_HEX =
    '0000040000008702010249' +
    'B001B05057B0A0017CB0C1B103B306B34FB4C7B582B541B543B6A04D81B6F0690409B701BC40BD47' +
    'B5C0B61024B643B5C1B600B643B5C2B600B643B5C4B61026B643B5C6B6102CB643' +
    '44E1'

// Comprehensive state response (response to query 0x1F5/2).
// Contains TLV t=0x1f7 (power), which triggers `isValuesResponse`
//      t=0x1f9 l=0 v=0x4 (4)   mode=heat
//      t=0x1f7 l=0 v=0x1 (1)   power=ON
//      t=0x1fa l=0 v=0x3 (3)   fan=level_1
//      t=0x1fd l=1 v=0x29 (41) current_temp=20.5
//      t=0x1fe l=1 v=0x26 (38) set_temp=19
//      ...
const QUERY_RESPONSE_HEX =
    '00000400000087020415' +
    '777E447DC17E837F50297F9026C840C880C8C08340838083C0868086C0870087C0894088408A1011' +
    '8A505A8A8F8CA0C0BA8CD010ACE00164D540D580C900CAD0A0CB1040CB40CB8CCBCFCC1032CC504F' +
    'CC90438B40BF600155BFE00271BFA00155C0200271BE509FBE90A01B01BED050C300C340C0C0C380' +
    '3E6B'

// Bytes that the device sends in response to specific HA setProperty calls.
const WRITE_MODE_FAN_ONLY_HEX = '01010400000065020101067E427E837F80B452'
const WRITE_MODE_HEAT_HEX = '01010400000065020101077E447E837F902AF936'
const WRITE_POWER_OFF_HEX = '01010400000065020101027DC00576'

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    ha.on('setProperty', (id: string, prop: string, value: string) => {
        dev.setProperty(prop, value)
    })
    return { ha, thinq, dev }
}

/** Bring the device through the full caps->values->initMakeSetConfig flow using mock timers.
 *  Returns the device with config installed and thinq recorder cleared. */
function buildReadyDevice(t: import('node:test').TestContext) {
    enableMockTimers(t)
    const { ha, thinq, dev } = makeDevice()

    // Constructor sent the queryCaps packet, discard it.
    thinq.resetRecorder()

    // Respond & give other timeouts a chance to fire.
    thinq.emit('data', buf(CAPS_RESPONSE_HEX))
    thinq.emit('data', buf(QUERY_RESPONSE_HEX))
    tickMockTimers(t, 6000)

    thinq.resetRecorder()
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('caps and values responses triggers config publish', (t) => {
        enableMockTimers(t)
        const { ha, thinq, dev } = makeDevice()
        thinq.resetRecorder() // discard the queryCaps from the constructor

        thinq.emit('data', buf(CAPS_RESPONSE_HEX))
        thinq.emit('data', buf(QUERY_RESPONSE_HEX))

        // allow timed events to process
        tickMockTimers(t, 6000)
        const device = ha.devices[DEVICE_ID]
        assert.ok(device, 'HA configuration published')

        // Config exposes the climate component with all five base fields registered.
        const components = device.config!.components as Record<string, Record<string, unknown>>
        assert.ok(components.climate, 'climate component')
        assert.equal(components.climate.platform, 'climate')

        // Capability bits from the captured caps response unlocked these optional components.
        assert.ok(components.jet, 'jet (because 0x2CD bits 0x1|0x2)')
        assert.ok(components.energysave, 'energysave (because 0x2CC bit 0x2)')
        assert.equal(components.jet.optimistic, undefined, 'state-backed jet switch is not optimistic')
        assert.equal(components.energysave.optimistic, undefined, 'state-backed energy switch is not optimistic')
        assert.ok(components.autodry, 'autodry (because 0x2CC bit 0x4)')
        assert.ok(components.sleeptimer, 'sleeptimer (because 0x2D3 bit 0x1)')
        assert.ok(components.starttimer, 'starttimer (because 0x2D3 bit 0x4)')
        assert.ok(components.stoptimer, 'stoptimer (because 0x2D3 bit 0x4)')
        // Conversely, airclean (0x2CC bit 0x1) is not unlocked.
        assert.ok(!components.airclean, 'airclean off (0x2CC bit 0x1 unset)')

        // Swing modes registered because 0x2CD has both 0x4 and 0x8.
        assert.deepEqual(components.climate.fan_modes, [
            'level_1',
            'level_2',
            'level_3',
            'level_4',
            'level_5',
            'natural',
        ])
        assert.deepEqual(components.climate.swing_modes, [
            'off',
            'swing',
            'position_1',
            'position_2',
            'position_3',
            'position_4',
            'position_5',
            'position_6',
        ])
        assert.deepEqual(components.climate.swing_horizontal_modes, [
            'off',
            'swing',
            'focus_left',
            'focus_right',
            'position_1',
            'position_2',
            'position_3',
            'position_4',
            'position_5',
        ])

        dev.drop()
    })

    test('initial state response publishes all expected HA properties', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        thinq.emit('data', buf(QUERY_RESPONSE_HEX))

        // allow timed events to process
        tickMockTimers(t, 1000)

        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'current_temperature'), 20.5) // 0x29 / 2
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'temperature_state'), 19) // 0x26 / 2
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), 'level_1') // 0x1FA=3
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'heat') // 0x1F9=4 with power=ON
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'swing_mode_state'), 'off') // 0x321=0
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'swing_horizontal_mode_state'), 'off') // 0x322=0
        assert.equal(ha.getProperty(DEVICE_ID, 'autodry', 'state'), 'OFF') // 0x20E=0
        assert.equal(ha.getProperty(DEVICE_ID, 'sleeptimer', 'state'), 0) // 0x21A=0
        assert.equal(ha.getProperty(DEVICE_ID, 'starttimer', 'state'), 0) // 0x21C=0
        assert.equal(ha.getProperty(DEVICE_ID, 'stoptimer', 'state'), 0) // 0x21B=0
        assert.equal(ha.getProperty(DEVICE_ID, 'jet', 'state'), 'OFF')

        // energysave is mode-dependent (cool only). With mode=heat its read_callback returns false,
        // so it must NOT have been published.
        assert.ok(!ha.getProperty(DEVICE_ID, 'energysave', 'state'), 'energysave suppressed in heat mode')

        dev.drop()
    })

    test('HA write climate-mode=fan_only emits expected bytes', (t) => {
        const { thinq, dev, ha } = buildReadyDevice(t)
        // Pre-state observed in the capture at the moment of this write.
        dev.raw_clip_state[0x1fa] = 3
        dev.raw_clip_state[0x1fe] = 0

        ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'fan_only')

        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), WRITE_MODE_FAN_ONLY_HEX.toUpperCase())

        dev.drop()
    })

    test('HA write climate-mode=heat emits expected bytes', (t) => {
        const { thinq, dev, ha } = buildReadyDevice(t)
        // Pre-state observed in the capture at the moment of this write.
        dev.raw_clip_state[0x1fa] = 3
        dev.raw_clip_state[0x1fe] = 42 // 21C

        ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'heat')

        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), WRITE_MODE_HEAT_HEX.toUpperCase())

        dev.drop()
    })

    test('HA write climate-mode=off triggers power=OFF instead of mode write', (t) => {
        const { thinq, dev, ha } = buildReadyDevice(t)
        dev.raw_clip_state[0x1f7] = 1
        dev.raw_clip_state[0x1f9] = 0
        dev.raw_clip_state[0x1fa] = 3
        dev.raw_clip_state[0x1fe] = 42

        ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'off')

        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), WRITE_POWER_OFF_HEX.toUpperCase())

        dev.drop()
    })

    test('fan and vane commands are ignored while powered off', (t) => {
        const { thinq, dev, ha } = buildReadyDevice(t)
        dev.raw_clip_state[0x1f7] = 0

        ha.setProperty(DEVICE_ID, 'climate', 'fan_mode_command', 'level_4')
        ha.setProperty(DEVICE_ID, 'climate', 'swing_mode_command', 'swing')
        ha.setProperty(DEVICE_ID, 'climate', 'swing_horizontal_mode_command', 'off')

        assert.equal(thinq.outbox.length, 0)
        dev.drop()
    })

    test('constructor sends a queryCaps packet on the wire', () => {
        const { thinq, dev } = makeDevice()
        if (dev.query_caps_timeout) {
            clearInterval(dev.query_caps_timeout)
            dev.query_caps_timeout = undefined
        }
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), CAPS_REQUEST_HEX.toUpperCase())
        dev.drop()
    })

    test('publishes filter remaining percentage from used and lifetime hours', () => {
        const { ha, dev } = makeDevice()
        dev.filterUsedTime = 250
        dev.filterLifeTime = 1000
        dev.filterChangedDate = 20260818

        dev.publishFilterData()

        assert.equal(ha.devices[DEVICE_ID].properties.filterremaining, 75)
        dev.drop()
    })

    test('WINF variant advertises only its diagnostic-confirmed cooling modes', (t) => {
        enableMockTimers(t)
        const ha = new MockHAConnection()
        const meta: Metadata = { ...META, modelId: 'WINF_056905_WW' }
        const thinq = new MockThinq2Device(DEVICE_ID, meta)
        const dev = new DUT(ha.asConnection(), thinq, meta)
        ha.on('setProperty', (id: string, prop: string, value: string) => {
            dev.setProperty(prop, value)
        })
        thinq.emit('data', buf(CAPS_RESPONSE_HEX))
        thinq.emit('data', buf(QUERY_RESPONSE_HEX))
        tickMockTimers(t, 6000)

        const climate = ha.devices[DEVICE_ID].config!.components.climate as Record<string, unknown>
        assert.deepEqual(climate.modes, ['off', 'cool', 'dry', 'fan_only'])
        assert.deepEqual(climate.fan_modes, ['level_1', 'level_2', 'level_3', 'level_4', 'level_5'])
        assert.deepEqual(climate.swing_horizontal_modes, [
            'off',
            'swing',
            'focus_left',
            'focus_center',
            'focus_right',
            'position_1',
            'position_2',
            'position_3',
            'position_4',
            'position_5',
        ])
        const sleepTimer = ha.devices[DEVICE_ID].config!.components.sleeptimer as Record<string, unknown>
        assert.equal(sleepTimer.platform, 'number')
        assert.equal(sleepTimer.min, 0)
        assert.equal(sleepTimer.max, 12)
        assert.equal(sleepTimer.step, 0.25)

        // Confirm the number entity uses the same hours-to-minutes wire conversion as
        // the RAC/PAC handlers. These match real WINF captures from the appliance.
        for (const [hours, minutes, length] of [
            ['0.25', 15, 0],
            ['0.5', 30, 1],
            ['1.5', 90, 1],
        ] as const) {
            thinq.resetRecorder()
            ha.setProperty(DEVICE_ID, 'sleeptimer', 'command', hours)
            assert.equal(thinq.outbox.length, 1)
            assert.deepEqual(TLV.parse(thinq.outbox[0].subarray(11, thinq.outbox[0].length - 2)), [
                { t: 0x21a, l: length, v: minutes },
            ])
        }

        dev.raw_clip_state[0x1f7] = 0
        thinq.resetRecorder()
        ha.setProperty(DEVICE_ID, 'sleeptimer', 'command', '1.5')
        assert.equal(thinq.outbox.length, 0, 'sleep timer command is ignored while powered off')
        dev.drop()
    })

    test('WINF variant retires the sleep timer select that preceded the number entity', (t) => {
        enableMockTimers(t)
        const ha = new MockHAConnection()
        const meta: Metadata = { ...META, modelId: 'WINF_056905_WW' }
        const thinq = new MockThinq2Device(DEVICE_ID, meta)
        const dev = new DUT(ha.asConnection(), thinq, meta)
        thinq.emit('data', buf(CAPS_RESPONSE_HEX))
        thinq.emit('data', buf(QUERY_RESPONSE_HEX))
        tickMockTimers(t, 6000)

        // An earlier build published this component as a select, and Home Assistant keeps
        // the old entity when a component changes platform. The removal payload has to be
        // published before the real config so the number entity survives it.
        const removal = ha.publishedConfigs.findIndex(
            (config) => (config.components.sleeptimer as Record<string, unknown>)?.platform === 'select',
        )
        assert.notEqual(removal, -1, 'no select removal was published')
        const republish = ha.publishedConfigs.findIndex(
            (config, index) =>
                index > removal &&
                (config.components.sleeptimer as Record<string, unknown>)?.platform === 'number',
        )
        assert.notEqual(republish, -1, 'the number entity was not republished after the removal')
        dev.drop()
    })

    test('RAC variant leaves the sleep timer select alone', (t) => {
        enableMockTimers(t)
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device(DEVICE_ID, META)
        const dev = new DUT(ha.asConnection(), thinq, META)
        thinq.emit('data', buf(CAPS_RESPONSE_HEX))
        thinq.emit('data', buf(QUERY_RESPONSE_HEX))
        tickMockTimers(t, 6000)

        // Only the WINF build ever published the select, so no other model should emit a
        // removal that Home Assistant would have to reconcile.
        assert.ok(
            ha.publishedConfigs.every(
                (config) => (config.components.sleeptimer as Record<string, unknown>)?.platform !== 'select',
            ),
        )
        dev.drop()
    })
})
