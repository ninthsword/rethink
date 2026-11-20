import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { outdoorUnitFor, resetOutdoorUnits } from '@/cloud/devices/outdoor_unit'
import DUT from '@/cloud/devices/RAC_056905_WW'
import type { Metadata } from '@/cloud/thinq'
import { buf, hex, MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'
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
const WRITE_POWER_OFF_HEX = '01010400000065020101027DC00576'
const QUERY_REQUEST_HEX = '01010400000065020201027D425A6E'
const WINF_PUSH_HEX =
    '000004000000A8666501EA0A011465590001000002000100000000000000000000353400000000000000000007000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000000000010101000000000000000000000000869422000100000000000000003B0000011B4B000000000300000301050005000000000000010200D8000000044C03E800006B00DD003CBC0000F906A4000005C10000000000000000010000FF000000000000000000000000006400DD3C0145020000010E00000000000100000000000000000EF5290092000087000A98000038000DC3E1'

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    ha.on('setProperty', (_id: string, prop: string, value: string) => {
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
    test('prototype-like model id with a valid fallback uses advertised encoding', (t) => {
        enableMockTimers(t)
        const ha = new MockHAConnection()
        const meta: Metadata = { modelId: '__proto__', modelName: MODEL_ID, swVersion: '1.0' }
        const thinq = new MockThinq2Device(DEVICE_ID, meta)
        const dev = new DUT(ha.asConnection(), thinq, meta)

        thinq.emit('data', buf(CAPS_RESPONSE_HEX))
        thinq.emit('data', buf(QUERY_RESPONSE_HEX))
        tickMockTimers(t, 6000)

        const climate = ha.devices[DEVICE_ID].config?.components.climate as Record<string, unknown>
        assert.deepEqual(climate.fan_modes, ['level_1', 'level_2', 'level_3', 'level_4', 'level_5', 'natural'])
        dev.drop()
    })

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
        const components = device.config?.components as Record<string, Record<string, unknown>>
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
        // Three levels plus natural wind, on raw 2/4/6/8. The five levels on raw 3..7 that
        // the model data advertises are what the appliance was assumed to use until a
        // labelled capture of this unit showed otherwise.
        assert.deepEqual(components.climate.fan_modes, ['level_1', 'level_2', 'level_3', 'natural'])
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
        // This capture predates the labelled session that established this model's encoding.
        // Its raw 3 and raw 4 are not values the installed appliance uses for a fan level or
        // a mode, so nothing is published for them rather than a name they do not mean.
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), undefined) // 0x1FA=3
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), undefined) // 0x1F9=4
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
        // Pre-state observed in the capture at the moment of this write. The setpoint it
        // carried is fan_only's own, as a report of that mode leaves it.
        dev.processTLV([
            { t: 0x1f9, l: 0, v: 2 },
            { t: 0x1fe, l: 1, v: 0 },
        ])
        dev.raw_clip_state[0x1fa] = 3
        thinq.resetRecorder()

        ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'fan_only')

        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), WRITE_MODE_FAN_ONLY_HEX.toUpperCase())

        dev.drop()
    })

    test('a mode written while the appliance runs carries the fan and the setpoint with it', (t) => {
        const { thinq, dev, ha } = buildReadyDevice(t)
        dev.raw_clip_state[0x1f7] = 1
        dev.raw_clip_state[0x1fa] = 2
        dev.raw_clip_state[0x1fe] = 42 // 21C

        ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'fan_only')

        // No setpoint is held for fan_only, so it gets 26 C rather than the raw 21 C.
        assert.deepEqual(TLV.parse(thinq.outbox[0].subarray(11, thinq.outbox[0].length - 2)), [
            { t: 0x1f9, l: 0, v: 2 },
            { t: 0x1fa, l: 0, v: 2 },
            { t: 0x1fe, l: 1, v: 52 },
        ])

        dev.drop()
    })

    test('a mode chosen while the appliance is off turns it on in the same frame', (t) => {
        // Selecting a mode from the thermostat card sent 0x1f9 alone, which this appliance
        // takes and stays off for, so the card snapped back to off. The window unit showed it;
        // the frame is built the same way for both, so both are covered here.
        const { thinq, dev, ha } = buildReadyDevice(t)
        dev.raw_clip_state[0x1f7] = 0
        dev.raw_clip_state[0x1fa] = 2
        dev.raw_clip_state[0x1fe] = 42

        ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'cool')

        // No setpoint is held for cool, so it gets 26 C rather than the raw 21 C.
        const sent = TLV.parse(thinq.outbox[0].subarray(11, thinq.outbox[0].length - 2))
        assert.deepEqual(sent, [
            { t: 0x1f9, l: 0, v: 0 },
            { t: 0x1f7, l: 0, v: 1 },
            { t: 0x1fa, l: 0, v: 2 },
            { t: 0x1fe, l: 1, v: 52 },
        ])

        dev.drop()
    })

    test('RAC auto action becomes idle when the indoor unit stops', (t) => {
        enableMockTimers(t)
        const { ha, thinq, dev } = makeDevice()
        thinq.resetRecorder()

        thinq.emit('data', buf(CAPS_RESPONSE_HEX))
        // Register the IDU running field before configuration is built, as it appears in the
        // appliance's full state reports. The installed RAC reports auto as raw 3.
        dev.raw_clip_state[0x189] = 1
        thinq.emit('data', buf(QUERY_RESPONSE_HEX))
        tickMockTimers(t, 6000)
        assert.ok(ha.devices[DEVICE_ID]?.config, 'HA configuration published')

        // The previous full report left Home Assistant showing cooling. The next report
        // changes the indoor unit from running to idle while auto (raw 3) remains selected.
        dev.raw_clip_state[0x1f9] = 0
        dev.updateClimateAction()
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'action'), 'cooling')
        dev.raw_clip_state[0x1f9] = 3

        // This is the next state report's IDU transition. Before the regression fix, the
        // hard-coded auto raw 6 left the prior action in place instead of updating it to idle.
        dev.processKeyValue(0x189, 0)
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'action'), 'idle')

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

    test('RAC advertises no heating mode', (t) => {
        enableMockTimers(t)
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device(DEVICE_ID, META)
        const dev = new DUT(ha.asConnection(), thinq, META)
        thinq.emit('data', buf(CAPS_RESPONSE_HEX))
        thinq.emit('data', buf(QUERY_RESPONSE_HEX))
        tickMockTimers(t, 6000)

        // This model is cooling only; its panel has no heating mode, so offering one in
        // Home Assistant only produced a selection the appliance ignored.
        const climate = ha.devices[DEVICE_ID].config?.components.climate as Record<string, unknown>
        assert.deepEqual(climate.modes, ['off', 'cool', 'dry', 'fan_only', 'auto'])
        dev.drop()
    })

    test('the RAC has neither a sound button nor a temperature step button', (t) => {
        enableMockTimers(t)
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device(DEVICE_ID, META)
        const dev = new DUT(ha.asConnection(), thinq, META)
        thinq.emit('data', buf(CAPS_RESPONSE_HEX))
        thinq.emit('data', buf(QUERY_RESPONSE_HEX))
        tickMockTimers(t, 6000)

        // Only the WINF panel has them; offering them on this model gave Home Assistant
        // controls with nothing behind them.
        const components = ha.devices[DEVICE_ID].config?.components as Record<string, unknown>
        assert.equal(components.sound, undefined)
        assert.equal(components.temperature_step, undefined)
        assert.notEqual(components.display, undefined)
        dev.drop()
    })

    test('auto dry is read-only and the display is a writable switch', (t) => {
        enableMockTimers(t)
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device(DEVICE_ID, META)
        const dev = new DUT(ha.asConnection(), thinq, META)
        ha.on('setProperty', (_id: string, prop: string, value: string) => dev.setProperty(prop, value))
        thinq.emit('data', buf(CAPS_RESPONSE_HEX))
        thinq.emit('data', buf(QUERY_RESPONSE_HEX))
        tickMockTimers(t, 6000)

        const components = ha.devices[DEVICE_ID].config?.components as Record<string, Record<string, unknown>>
        // Auto dry is a reading: both rethink and the SmartThinQ path had their 0x20e writes
        // acknowledged on the wire and ignored by the appliance, which only moved for a
        // three-second press of the remote's own button.
        assert.equal(components.autodry.platform, 'binary_sensor')
        assert.equal(components.autodry.command_topic, undefined)
        assert.equal(components.display.platform, 'switch')

        // Nothing may go out for auto dry. The display remains a control and is inverted on
        // the wire, which a separate capture confirmed and this change does not touch.
        thinq.resetRecorder()
        ha.setProperty(DEVICE_ID, 'autodry', 'command', 'OFF')
        ha.setProperty(DEVICE_ID, 'autodry', 'command', 'ON')
        ha.setProperty(DEVICE_ID, 'display', 'command', 'OFF')
        ha.setProperty(DEVICE_ID, 'display', 'command', 'ON')
        assert.deepEqual(
            thinq.outbox
                .map((packet) => TLV.parse(packet.subarray(11, packet.length - 2)))
                .filter((tlv) => !tlv.some(({ t }) => t === 0x1f5)),
            [[{ t: 0x21f, l: 0, v: 1 }], [{ t: 0x21f, l: 0, v: 0 }]],
        )

        dev.processKeyValue(0x21f, 1)
        assert.equal(ha.getProperty(DEVICE_ID, 'display', 'state'), 'OFF')

        // The switch it was published as in between has to be retired, or Home Assistant
        // keeps both entities.
        assert.ok(
            ha.publishedConfigs.some(
                (config) => (config.components.autodry as Record<string, unknown>)?.platform === 'switch',
            ),
        )
        dev.drop()
    })

    test('the sound switch and the temperature step follow the appliance panel', (t) => {
        enableMockTimers(t)
        const ha = new MockHAConnection()
        const meta: Metadata = { ...META, modelId: 'WINF_056905_WW' }
        const thinq = new MockThinq2Device(DEVICE_ID, meta)
        const dev = new DUT(ha.asConnection(), thinq, meta)
        ha.on('setProperty', (_id: string, prop: string, value: string) => dev.setProperty(prop, value))
        thinq.emit('data', buf(CAPS_RESPONSE_HEX))
        thinq.emit('data', buf(QUERY_RESPONSE_HEX))
        tickMockTimers(t, 6000)

        // Captured from the panel: sound on then off reported 0x3a0 = 0 then 1, and the
        // step button reported 0x1fb = 1 for whole degrees and 0 for half.
        thinq.resetRecorder()
        ha.setProperty(DEVICE_ID, 'sound', 'command', 'ON')
        ha.setProperty(DEVICE_ID, 'sound', 'command', 'OFF')
        ha.setProperty(DEVICE_ID, 'temperature_step', 'command', 'one_degree')
        ha.setProperty(DEVICE_ID, 'temperature_step', 'command', 'half_degree')
        assert.deepEqual(
            thinq.outbox.map((packet) => TLV.parse(packet.subarray(11, packet.length - 2))),
            [
                [{ t: 0x3a0, l: 0, v: 0 }],
                [{ t: 0x3a0, l: 0, v: 1 }],
                [{ t: 0x1fb, l: 0, v: 1 }],
                [{ t: 0x1fb, l: 0, v: 0 }],
            ],
        )

        // The thermostat card rounds to the step it was told about, so the published step
        // has to follow the appliance.
        dev.processKeyValue(0x1fb, 1)
        const climate = ha.devices[DEVICE_ID].config?.components.climate as Record<string, unknown>
        assert.equal(climate.temp_step, 1)
        assert.equal(climate.precision, 1)
        dev.processKeyValue(0x1fb, 0)
        assert.equal(climate.temp_step, 0.5)
        dev.drop()
    })

    test('WINF variant advertises only its diagnostic-confirmed cooling modes', (t) => {
        enableMockTimers(t)
        const ha = new MockHAConnection()
        const meta: Metadata = { ...META, modelId: 'WINF_056905_WW' }
        const thinq = new MockThinq2Device(DEVICE_ID, meta)
        const dev = new DUT(ha.asConnection(), thinq, meta)
        ha.on('setProperty', (_id: string, prop: string, value: string) => {
            dev.setProperty(prop, value)
        })
        thinq.emit('data', buf(CAPS_RESPONSE_HEX))
        thinq.emit('data', buf(QUERY_RESPONSE_HEX))
        tickMockTimers(t, 6000)

        const climate = ha.devices[DEVICE_ID].config?.components.climate as Record<string, unknown>
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
        const sleepTimer = ha.devices[DEVICE_ID].config?.components.sleeptimer as Record<string, unknown>
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

    test('WINF decodes the evidence-backed fields in its 0xA8 push record', (t) => {
        enableMockTimers(t)
        const ha = new MockHAConnection()
        const meta: Metadata = { ...META, modelId: 'WINF_056905_WW' }
        const thinq = new MockThinq2Device(DEVICE_ID, meta)
        const dev = new DUT(ha.asConnection(), thinq, meta)
        thinq.emit('data', buf(CAPS_RESPONSE_HEX))
        thinq.emit('data', buf(QUERY_RESPONSE_HEX))
        tickMockTimers(t, 6000)

        thinq.emit('data', buf(WINF_PUSH_HEX))

        // Core state, from the labelled session that moved each control and watched both the
        // matching TLV and this record. Mode sits at 10, not the 8 an earlier note proposed.
        assert.equal(dev.raw_clip_state[0x1f7], 1)
        assert.equal(dev.raw_clip_state[0x1f9], 0)
        assert.equal(dev.raw_clip_state[0x1fa], 2)
        assert.equal(dev.raw_clip_state[0x322], 1)
        assert.equal(dev.raw_clip_state[0x1fe], 53)
        assert.equal(dev.raw_clip_state[0x1fd], 52)
        // Diagnostics, correlated earlier.
        assert.equal(dev.raw_clip_state[0x6c], 1)
        assert.equal(dev.raw_clip_state[0x32c], 148)
        assert.equal(dev.raw_clip_state[0x330], 216)
        assert.equal(dev.raw_clip_state[0x2b3], 56)

        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'cool')
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), 'level_1')
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'temperature_state'), 26.5)
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'current_temperature'), 26)
        assert.equal(ha.getProperty(DEVICE_ID, 'eev', 'state'), 216)
        assert.equal(ha.getProperty(DEVICE_ID, 'energy_current', 'state'), 56)
        dev.drop()
    })

    test('WINF partial push does not satisfy the initial values query', () => {
        const ha = new MockHAConnection()
        const meta: Metadata = { ...META, modelId: 'WINF_056905_WW' }
        const thinq = new MockThinq2Device(DEVICE_ID, meta)
        const dev = new DUT(ha.asConnection(), thinq, meta)

        thinq.emit('data', buf(CAPS_RESPONSE_HEX))
        thinq.emit('data', buf(WINF_PUSH_HEX))

        assert.equal(dev.initialValuesReceived, false)
        dev.drop()
    })

    test('WINF partial push keeps the post-write values query', (t) => {
        enableMockTimers(t)
        const ha = new MockHAConnection()
        const meta: Metadata = { ...META, modelId: 'WINF_056905_WW' }
        const thinq = new MockThinq2Device(DEVICE_ID, meta)
        const dev = new DUT(ha.asConnection(), thinq, meta)
        ha.on('setProperty', (_id: string, prop: string, value: string) => dev.setProperty(prop, value))
        thinq.emit('data', buf(CAPS_RESPONSE_HEX))
        thinq.emit('data', buf(QUERY_RESPONSE_HEX))
        tickMockTimers(t, 6000)
        thinq.resetRecorder()

        ha.setProperty(DEVICE_ID, 'climate', 'fan_mode_command', 'level_1')
        assert.equal(thinq.outbox.length, 1)

        // The push normally arrives about 1.2 seconds after a write, before the 1.5-second
        // fallback. It is partial, so the full values query still has to be sent.
        tickMockTimers(t, 1200)
        thinq.emit('data', buf(WINF_PUSH_HEX))
        tickMockTimers(t, 1000)

        assert.equal(thinq.outbox.length, 2)
        assert.equal(hex(thinq.outbox[1]), QUERY_REQUEST_HEX)
        dev.drop()
    })

    test('WINF does not treat an unavailable mode as auto', (t) => {
        enableMockTimers(t)
        const ha = new MockHAConnection()
        const meta: Metadata = { ...META, modelId: 'WINF_056905_WW' }
        const thinq = new MockThinq2Device(DEVICE_ID, meta)
        const dev = new DUT(ha.asConnection(), thinq, meta)
        thinq.emit('data', buf(CAPS_RESPONSE_HEX))
        thinq.emit('data', buf(QUERY_RESPONSE_HEX))
        tickMockTimers(t, 6000)

        delete dev.raw_clip_state[0x1f9]
        dev.updateClimateAction()
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'action'), undefined)
        dev.drop()
    })

    test('WINF runs its five fan levels one lower than the model data advertises', (t) => {
        // Physical indication, the command acknowledgement, and the full state that followed
        // all agreed: levels 1..5 are raw 2..6. On the advertised 3..7 the top level asked for
        // raw 7, which this appliance does not have and silently ignored.
        enableMockTimers(t)
        const ha = new MockHAConnection()
        const meta: Metadata = { ...META, modelId: 'WINF_056905_WW' }
        const thinq = new MockThinq2Device(DEVICE_ID, meta)
        const dev = new DUT(ha.asConnection(), thinq, meta)
        ha.on('setProperty', (_id: string, prop: string, value: string) => dev.setProperty(prop, value))
        thinq.emit('data', buf(CAPS_RESPONSE_HEX))
        thinq.emit('data', buf(QUERY_RESPONSE_HEX))
        tickMockTimers(t, 6000)

        const climate = ha.devices[DEVICE_ID].config?.components.climate as Record<string, unknown>
        assert.deepEqual(climate.fan_modes, ['level_1', 'level_2', 'level_3', 'level_4', 'level_5'])

        dev.raw_clip_state[0x1f7] = 1
        for (const [level, raw] of [
            ['level_1', 2],
            ['level_2', 3],
            ['level_3', 4],
            ['level_4', 5],
            ['level_5', 6],
        ] as const) {
            thinq.resetRecorder()
            ha.setProperty(DEVICE_ID, 'climate', 'fan_mode_command', level)
            const sent = TLV.parse(thinq.outbox[0].subarray(11, thinq.outbox[0].length - 2))
            assert.equal(sent.find(({ t: tag }) => tag === 0x1fa)?.v, raw, level)
            dev.processKeyValue(0x1fa, raw)
            assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), level)
        }

        dev.drop()
    })

    test('WINF exposes AI dry strength on 0x1f2 without a power guard', (t) => {
        // Each value was written and read back in a full state report while the appliance was
        // off, so this is stored configuration rather than an airflow command.
        enableMockTimers(t)
        const ha = new MockHAConnection()
        const meta: Metadata = { ...META, modelId: 'WINF_056905_WW' }
        const thinq = new MockThinq2Device(DEVICE_ID, meta)
        const dev = new DUT(ha.asConnection(), thinq, meta)
        ha.on('setProperty', (_id: string, prop: string, value: string) => dev.setProperty(prop, value))
        thinq.emit('data', buf(CAPS_RESPONSE_HEX))
        thinq.emit('data', buf(QUERY_RESPONSE_HEX))
        tickMockTimers(t, 6000)

        const component = ha.devices[DEVICE_ID].config?.components.ai_dry_strength as Record<string, unknown>
        assert.equal(component.platform, 'select')
        assert.deepEqual(component.options, ['weak_wind', 'medium_wind', 'strong_wind'])

        dev.raw_clip_state[0x1f7] = 0
        for (const [option, raw] of [
            ['weak_wind', 2],
            ['medium_wind', 4],
            ['strong_wind', 6],
        ] as const) {
            thinq.resetRecorder()
            ha.setProperty(DEVICE_ID, 'ai_dry_strength', 'command', option)
            assert.deepEqual(TLV.parse(thinq.outbox[0].subarray(11, thinq.outbox[0].length - 2)), [
                { t: 0x1f2, l: 0, v: raw },
            ])
            dev.processKeyValue(0x1f2, raw)
            assert.equal(ha.getProperty(DEVICE_ID, 'ai_dry_strength', 'state'), option)
        }

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
                index > removal && (config.components.sleeptimer as Record<string, unknown>)?.platform === 'number',
        )
        assert.notEqual(republish, -1, 'the number entity was not republished after the removal')
        dev.drop()
    })

    test('an appliance sharing an outdoor unit still gets a Home Assistant device', (t) => {
        enableMockTimers(t)
        resetOutdoorUnits()
        const ha = new MockHAConnection()
        ha.config = { outdoor_units: [{ name: '2 in 1', devices: ['other-id', DEVICE_ID] }] }
        const thinq = new MockThinq2Device(DEVICE_ID, META)
        const dev = new DUT(ha.asConnection(), thinq, META)
        thinq.emit('data', buf(CAPS_RESPONSE_HEX))
        thinq.emit('data', buf(QUERY_RESPONSE_HEX))
        tickMockTimers(t, 6000)

        // The compressor reading goes to the group rather than to a component of this
        // appliance's own, and a registration with no component behind it used to throw
        // while attaching its topics — taking the whole configure() call with it, so the
        // appliance published no discovery and no availability at all.
        assert.ok(ha.devices[DEVICE_ID]?.config, 'the appliance published no discovery')
        assert.equal(ha.devices[DEVICE_ID].availability, 'online')
        const components = ha.devices[DEVICE_ID].config?.components as Record<string, unknown>
        assert.equal(components.compressor, undefined, 'the group owns the compressor, not the head')
        resetOutdoorUnits()
        dev.drop()
    })

    test('leaving takes the head out of its shared outdoor unit', (t) => {
        enableMockTimers(t)
        resetOutdoorUnits()
        const ha = new MockHAConnection()
        ha.config = { outdoor_units: [{ name: '2 in 1', devices: [DEVICE_ID, 'other-id'] }] }
        const thinq = new MockThinq2Device(DEVICE_ID, META)
        const dev = new DUT(ha.asConnection(), thinq, META)
        thinq.emit('data', buf(CAPS_RESPONSE_HEX))
        thinq.emit('data', buf(QUERY_RESPONSE_HEX))
        tickMockTimers(t, 6000)

        const outdoor = outdoorUnitFor(ha.config as never, DEVICE_ID)
        assert.ok(outdoor)
        outdoor.report(DEVICE_ID, 470, true)
        assert.equal(ha.devices[DEVICE_ID].properties.outdoor_power, 470)

        // Losing the connection has to retire the reading, or the group keeps publishing it
        // and keeps adding energy for an appliance that is gone.
        dev.drop()
        outdoor.report('other-id', 50, true)
        assert.equal(ha.devices[DEVICE_ID].properties.outdoor_power, 50)
        resetOutdoorUnits()
    })

    test('an appliance with its own outdoor unit reports its own compressor', (t) => {
        enableMockTimers(t)
        const ha = new MockHAConnection()
        const meta: Metadata = { ...META, modelId: 'WINF_056905_WW' }
        const thinq = new MockThinq2Device(DEVICE_ID, meta)
        const dev = new DUT(ha.asConnection(), thinq, meta)
        thinq.emit('data', buf(CAPS_RESPONSE_HEX))
        thinq.emit('data', buf(QUERY_RESPONSE_HEX))
        tickMockTimers(t, 6000)

        const components = ha.devices[DEVICE_ID].config?.components as Record<string, Record<string, unknown>>
        assert.ok(components.compressor, 'no compressor sensor')
        assert.equal(components.compressor.platform, 'binary_sensor')
        assert.equal(components.compressor.device_class, 'running')

        // 15 Hz is the cap the tag reports whatever the real speed is; anything above zero
        // is the compressor turning, and it cannot turn while the appliance is off.
        dev.processKeyValue(0x1f7, 1)
        dev.processKeyValue(0x22a, 15)
        assert.equal(ha.getProperty(DEVICE_ID, 'compressor', 'state'), 'ON')

        dev.processKeyValue(0x22a, 0)
        assert.equal(ha.getProperty(DEVICE_ID, 'compressor', 'state'), 'OFF')

        dev.processKeyValue(0x1f7, 0)
        dev.processKeyValue(0x22a, 15)
        assert.equal(
            ha.getProperty(DEVICE_ID, 'compressor', 'state'),
            'OFF',
            'a switched-off unit has no compressor running',
        )
        dev.drop()
    })

    test('every reservation slider gets a countdown sensor beside it', (t) => {
        enableMockTimers(t)
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device(DEVICE_ID, META)
        const dev = new DUT(ha.asConnection(), thinq, META)
        thinq.emit('data', buf(CAPS_RESPONSE_HEX))
        thinq.emit('data', buf(QUERY_RESPONSE_HEX))
        tickMockTimers(t, 6000)

        // The slider rounds to the quarter hour it can display, so on its own it cannot say
        // that eleven minutes are left. The appliance sends the real figure every minute.
        const components = ha.devices[DEVICE_ID].config?.components as Record<string, Record<string, unknown>>
        for (const [slider, counter] of [
            ['sleeptimer', 'sleep_time'],
            ['starttimer', 'start_time'],
            ['stoptimer', 'stop_time'],
        ]) {
            assert.ok(components[slider], `${slider} is missing`)
            assert.ok(components[counter], `${slider} has no countdown sensor`)
            assert.equal(components[counter].platform, 'sensor')
            assert.equal(components[counter].unit_of_measurement, 'min')
            assert.equal(components[counter].device_class, 'duration')
        }
        dev.drop()
    })

    test('a zero filter reset date publishes the no-value payload', (t) => {
        enableMockTimers(t)
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device(DEVICE_ID, META)
        const dev = new DUT(ha.asConnection(), thinq, META)
        thinq.emit('data', buf(CAPS_RESPONSE_HEX))
        thinq.emit('data', buf(QUERY_RESPONSE_HEX))
        tickMockTimers(t, 6000)

        dev.filterChangedDate = 20260818
        dev.publishFilterData()
        assert.equal(ha.devices[DEVICE_ID].properties.filterchangeddate, '2026-08-18')

        // Zero formats to 0000-00-00 and an empty payload is no better: the date device class
        // rejects both. None is what Home Assistant reads as no value.
        dev.filterChangedDate = 0
        dev.publishFilterData()
        assert.equal(ha.devices[DEVICE_ID].properties.filterchangeddate, 'None')
        dev.drop()
    })

    test('the RAC retires the sound and temperature step it no longer offers', (t) => {
        enableMockTimers(t)
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device(DEVICE_ID, META)
        const dev = new DUT(ha.asConnection(), thinq, META)
        thinq.emit('data', buf(CAPS_RESPONSE_HEX))
        thinq.emit('data', buf(QUERY_RESPONSE_HEX))
        tickMockTimers(t, 6000)

        // Both were offered on every model this handler serves before being narrowed to the
        // WINF. Leaving them out of the payload does not take them off the bedroom unit's
        // page: Home Assistant keeps an entity until it is told the component is gone, and
        // these two sat there unavailable for days because nobody looked at that page.
        const removal = ha.publishedConfigs.findIndex(
            (config) => config.components.sound !== undefined && config.components.temperature_step !== undefined,
        )
        assert.notEqual(removal, -1, 'the RAC never retired the sound and temperature step')

        const last = ha.publishedConfigs[ha.publishedConfigs.length - 1]
        assert.equal(last.components.sound, undefined, 'the RAC must not offer a sound switch')
        assert.equal(last.components.temperature_step, undefined, 'the RAC must not offer a temperature step')
        dev.drop()
    })

    test('the WINF keeps the sound and temperature step it does have', (t) => {
        enableMockTimers(t)
        const ha = new MockHAConnection()
        const meta: Metadata = { ...META, modelId: 'WINF_056905_WW' }
        const thinq = new MockThinq2Device(DEVICE_ID, meta)
        const dev = new DUT(ha.asConnection(), thinq, meta)
        thinq.emit('data', buf(CAPS_RESPONSE_HEX))
        thinq.emit('data', buf(QUERY_RESPONSE_HEX))
        tickMockTimers(t, 6000)

        const last = ha.publishedConfigs[ha.publishedConfigs.length - 1]
        assert.ok(last.components.sound, 'the WINF panel has a sound button')
        assert.ok(last.components.temperature_step, 'the WINF panel has a temperature step button')
        dev.drop()
    })

    test('RAC variant also retires the duplicate sleep timer select', (t) => {
        enableMockTimers(t)
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device(DEVICE_ID, META)
        const dev = new DUT(ha.asConnection(), thinq, META)
        thinq.emit('data', buf(CAPS_RESPONSE_HEX))
        thinq.emit('data', buf(QUERY_RESPONSE_HEX))
        tickMockTimers(t, 6000)

        const removal = ha.publishedConfigs.findIndex(
            (config) => (config.components.sleeptimer as Record<string, unknown>)?.platform === 'select',
        )
        assert.notEqual(removal, -1, 'no RAC select removal was published')
        const republish = ha.publishedConfigs.findIndex(
            (config, index) =>
                index > removal && (config.components.sleeptimer as Record<string, unknown>)?.platform === 'number',
        )
        assert.notEqual(republish, -1, 'the RAC number entity was not republished after removal')
        dev.drop()
    })
})

describe('RAC_056905_WW energy total', () => {
    const meter = (dev: unknown) =>
        (dev as { energy: { integratePower(w: number, now?: number, running?: boolean): void } }).energy

    // An appliance that says what it is drawing can also say what it has used.
    test('adds up the corrected power reading, not the raw one', (t) => {
        const { ha, dev } = buildReadyDevice(t)
        try {
            const total = ha.devices[DEVICE_ID].config?.components.energy_total as Record<string, unknown>
            assert.equal(total.state_class, 'total_increasing', 'a meter for the energy dashboard')
            assert.equal(total.unit_of_measurement, 'Wh')

            // Running values are passed through: measured against the whole-house meter,
            // the sixty this used to subtract was a standby artefact, not an offset.
            dev.raw_clip_state[0x1f7] = 1
            dev.processKeyValue(0x2b3, 720)
            assert.equal(ha.devices[DEVICE_ID].properties['energy_current-'], 720)

            meter(dev).integratePower(720, 0, true)
            meter(dev).integratePower(720, 60 * 1000, true)
            assert.equal(ha.devices[DEVICE_ID].properties.energy_total, 12, '720 W for a minute is 12 Wh')
        } finally {
            dev.drop()
        }
    })

    test('standby is zero and not counted', (t) => {
        const { ha, dev } = buildReadyDevice(t)
        try {
            // Switched off, these units keep reporting around fifty watts. That is a
            // placeholder, not a measurement, so it is displayed as zero and adds nothing:
            // counting it would put over a hundred made-up watt-hours a day on the total.
            dev.raw_clip_state[0x1f7] = 0
            dev.processKeyValue(0x2b3, 50)
            assert.equal(ha.devices[DEVICE_ID].properties['energy_current-'], 0)

            meter(dev).integratePower(0, 0, false)
            meter(dev).integratePower(0, 60 * 60 * 1000, false)
            assert.equal(ha.devices[DEVICE_ID].properties.energy_total, 0, 'an hour switched off is nothing')
        } finally {
            dev.drop()
        }
    })

    test('the clock restarts when it comes back on', (t) => {
        const { ha, dev } = buildReadyDevice(t)
        try {
            meter(dev).integratePower(720, 0, true)
            // Off for an hour, then running again: the hour is not credited to either state.
            meter(dev).integratePower(0, 30 * 60 * 1000, false)
            meter(dev).integratePower(720, 60 * 60 * 1000, true)
            assert.equal(ha.devices[DEVICE_ID].properties.energy_total ?? 0, 0)

            meter(dev).integratePower(720, 60 * 60 * 1000 + 60 * 1000, true)
            assert.equal(ha.devices[DEVICE_ID].properties.energy_total, 12, 'only the minute since it returned')
        } finally {
            dev.drop()
        }
    })
})

describe('RAC_056905_WW writes nothing just because rethink restarted', () => {
    /** A write carries the 0x02 0x01 header; a query carries the 0x02 0x02. */
    const writeTLVs = (packets: Buffer[]) =>
        packets
            .filter((packet) => packet[7] === 2 && packet[8] === 1)
            .map((packet) => TLV.parse(packet.subarray(11, packet.length - 2)))
    const combined = [
        { t: 0x1f9, l: 0, v: 0 },
        { t: 0x1f7, l: 0, v: 1 },
        { t: 0x1fa, l: 0, v: 2 },
        { t: 0x1fe, l: 1, v: 42 },
    ]
    const frame = (powerFirst: boolean) => {
        const power = { t: 0x1f7, l: 0, v: 1 }
        const mode = { t: 0x1f9, l: 0, v: 0 }
        const state = [
            { t: 0x1fa, l: 0, v: 2 },
            { t: 0x1fe, l: 1, v: 42 },
            { t: 0x323, l: 0, v: 0 },
            { t: 0x20d, l: 0, v: 0 },
        ]
        return powerFirst ? [power, mode, ...state] : [mode, power, ...state]
    }
    const trackHooks = (dev: DUT) => {
        const modeCounts = dev.modeChangeHooks.map(() => 0)
        const powerCounts = dev.powerChangeHooks.map(() => 0)
        dev.modeChangeHooks = dev.modeChangeHooks.map((hook, i) => () => {
            modeCounts[i]++
            hook()
        })
        dev.powerChangeHooks = dev.powerChangeHooks.map((hook, i) => () => {
            powerCounts[i]++
            hook()
        })
        return { modeCounts, powerCounts }
    }
    const resetCounts = (...counts: number[][]) => {
        counts.forEach((count) => {
            count.fill(0)
        })
    }
    const assertHooks = (counts: number[], expected: number, message: string) => {
        assert.ok(counts.length, `${message}: no hooks registered`)
        assert.deepEqual(
            counts,
            counts.map(() => expected),
            message,
        )
    }
    const establishOff = (dev: DUT, remembered = false, oldDry = false) => {
        // A report of cool with its setpoint, so cool's own setpoint is 21 C.
        dev.processTLV([
            { t: 0x1f9, l: 0, v: 0 },
            { t: 0x1fe, l: 1, v: 42 },
        ])
        if (remembered) {
            dev.processKeyValue(0x323, 1)
            dev.processKeyValue(0x20d, 1)
        }
        if (oldDry) dev.processKeyValue(0x1f9, 1)
        dev.processKeyValue(0x1f7, 0)
        dev.raw_clip_state[0x1fa] = 2
    }

    test('coming up against a running appliance sends it nothing', (t) => {
        // The first reading records the appliance's state; it is not an appliance power-up.
        enableMockTimers(t)
        const { thinq, dev } = makeDevice()
        try {
            thinq.emit('data', buf(CAPS_RESPONSE_HEX))
            thinq.emit('data', buf(QUERY_RESPONSE_HEX))
            tickMockTimers(t, 6000)
            assert.deepEqual(writeTLVs(thinq.outbox), [], 'only queries, never a setting')
        } finally {
            dev.drop()
        }
    })

    test('an appliance-initiated power-up restores remembered settings once', (t) => {
        const { thinq, dev } = buildReadyDevice(t)
        try {
            establishOff(dev, true, true)
            thinq.resetRecorder()
            const { modeCounts, powerCounts } = trackHooks(dev)
            // No HA write preceded this full power-before-mode response.
            dev.processTLV(frame(true))
            assertHooks(modeCounts, 0, 'mode hooks stay suppressed')
            assertHooks(powerCounts, 1, 'each power hook runs once')
            assert.deepEqual(writeTLVs(thinq.outbox), [[{ t: 0x323, l: 0, v: 1 }], [{ t: 0x20d, l: 0, v: 1 }]])
        } finally {
            dev.drop()
        }
    })

    for (const remembered of [false, true]) {
        test(
            remembered
                ? 'an off-to-cool command restores remembered settings in either tag order'
                : 'an off-to-cool command does not reapply default-off settings',
            (t) => {
                const { thinq, dev, ha } = buildReadyDevice(t)
                try {
                    establishOff(dev, remembered)
                    const { modeCounts, powerCounts } = trackHooks(dev)
                    for (const [n, powerFirst] of [false, true].entries()) {
                        if (n) {
                            if (remembered) {
                                dev.processKeyValue(0x323, 1)
                                dev.processKeyValue(0x20d, 1)
                            }
                            dev.processKeyValue(0x1f7, 0)
                            resetCounts(modeCounts, powerCounts)
                            thinq.resetRecorder()
                        } else {
                            thinq.resetRecorder()
                        }
                        ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'cool')
                        const before = writeTLVs(thinq.outbox)
                        assert.deepEqual(before, [combined], 'the original combined command is one frame')
                        dev.processTLV(frame(powerFirst))
                        assertHooks(modeCounts, 0, 'mode hooks stay suppressed')
                        assertHooks(powerCounts, 1, 'each power hook runs once')
                        const expected = remembered
                            ? [combined, [{ t: 0x323, l: 0, v: 1 }], [{ t: 0x20d, l: 0, v: 1 }]]
                            : [combined]
                        assert.deepEqual(writeTLVs(thinq.outbox), expected)
                    }
                } finally {
                    dev.drop()
                }
            },
        )
    }

    test('a delayed off-mode report does not replay mode settings', (t) => {
        const offFrame = (powerFirst: boolean) => {
            const power = { t: 0x1f7, l: 0, v: 0 }
            const mode = { t: 0x1f9, l: 0, v: 0 }
            return powerFirst ? [power, mode] : [mode, power]
        }

        const { thinq, dev } = buildReadyDevice(t)
        try {
            dev.processKeyValue(0x1f7, 1)
            dev.processKeyValue(0x1f9, 0)
            const { modeCounts, powerCounts } = trackHooks(dev)
            for (const [n, powerFirst] of [false, true].entries()) {
                if (n) {
                    // Return to the running state before checking the other tag order.
                    dev.processTLV(frame(powerFirst))
                    resetCounts(modeCounts, powerCounts)
                    thinq.resetRecorder()
                }

                dev.processTLV(offFrame(powerFirst))
                assertHooks(modeCounts, 0, 'combined shutdown mode hooks stay suppressed')
                assertHooks(powerCounts, 1, 'combined shutdown power hooks own the transition')
                assert.deepEqual(writeTLVs(thinq.outbox), [], 'combined shutdown stays write-free')
            }

            // Keep the mode history running, then model the appliance acknowledging power off
            // before its separate mode=off report arrives.
            dev.processTLV(frame(true))
            resetCounts(modeCounts, powerCounts)
            thinq.resetRecorder()
            dev.processTLV([{ t: 0x1f7, v: 0 }])
            assertHooks(modeCounts, 0, 'delayed shutdown power step has no mode hook')
            assertHooks(powerCounts, 1, 'delayed shutdown power hook owns the transition')
            resetCounts(modeCounts, powerCounts)
            thinq.resetRecorder()

            dev.processTLV([{ t: 0x1f9, v: 0 }])
            assertHooks(modeCounts, 0, 'delayed shutdown mode report has no mode hook')
            assertHooks(powerCounts, 0, 'delayed shutdown mode report has no power hook')
            assert.deepEqual(writeTLVs(thinq.outbox), [], 'delayed shutdown mode report stays write-free')
        } finally {
            dev.drop()
        }
    })

    test('stable-power mode frames invoke mode hooks only', (t) => {
        const { thinq, dev } = buildReadyDevice(t)
        try {
            dev.processKeyValue(0x1f9, 1)
            dev.processKeyValue(0x1f7, 1)
            const { modeCounts, powerCounts } = trackHooks(dev)
            for (const [n, powerFirst] of [true, false].entries()) {
                if (n) {
                    dev.processKeyValue(0x1f9, 1)
                    resetCounts(modeCounts, powerCounts)
                    thinq.resetRecorder()
                }
                dev.processTLV(frame(powerFirst))
                assertHooks(modeCounts, 1, 'each mode hook runs once')
                assertHooks(powerCounts, 0, 'each power hook stays unused')
                // Jet and energy saving are off, so a mode change re-sends neither.
                assert.deepEqual(writeTLVs(thinq.outbox), [])
            }
        } finally {
            dev.drop()
        }
    })
})

/** Writes (header 0x02 0x01) as [tag, value] pairs, queries left out. */
const sentWrites = (packets: Buffer[]) =>
    packets
        .filter((packet) => packet[7] === 2 && packet[8] === 1)
        .map((packet) => TLV.parse(packet.subarray(11, packet.length - 2)).map(({ t, v }) => [t, v]))
/** One appliance report, its tags applied in the order given. */
const report = (dev: DUT, ...tags: [number, number][]) => dev.processTLV(tags.map(([t, v]) => ({ t, v })))
const shownTemperature = (ha: MockHAConnection) => ha.devices[DEVICE_ID].properties['climate-temperature']
const shownComfort = (ha: MockHAConnection) => ha.devices[DEVICE_ID].properties.auto_comfort
/** The values response with some tags left out, so they come from nothing the appliance reported. */
const queryResponseWithout = (...tags: number[]) =>
    TLV.parse(buf(QUERY_RESPONSE_HEX).subarray(11, buf(QUERY_RESPONSE_HEX).length - 2)).filter(
        ({ t }) => !tags.includes(t),
    )
const steadyAuto = (dev: DUT) => report(dev, [0x1f7, 1], [0x1f9, 3], [0x1fa, 2], [0x1fe, 34])
const steadyCool = (dev: DUT) => report(dev, [0x1f7, 1], [0x1f9, 0], [0x1fa, 2], [0x1fe, 52])

describe('RAC_056905_WW shows a setpoint only in the mode that owns it', () => {
    for (const setpointFirst of [false, true]) {
        test(`a report carrying auto and its setpoint shows the comfort level (${setpointFirst ? 'setpoint' : 'mode'} first)`, (t) => {
            const { ha, dev } = buildReadyDevice(t)
            try {
                report(dev, [0x1f7, 1])
                if (setpointFirst) report(dev, [0x1fe, 34], [0x1f9, 3])
                else report(dev, [0x1f9, 3], [0x1fe, 34])
                assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'auto')
                assert.equal(shownTemperature(ha), 'None')
                assert.equal(shownComfort(ha), 0)

                // The remote's up and down in auto report the setpoint alone.
                report(dev, [0x1fe, 36])
                assert.equal(shownComfort(ha), 1)
                assert.equal(shownTemperature(ha), 'None')

                report(dev, [0x1f9, 0], [0x1fe, 52])
                assert.equal(shownTemperature(ha), 26)
                assert.equal(shownComfort(ha), 'None')
            } finally {
                dev.drop()
            }
        })
    }

    test('a mode-only report shows no value until that mode reports its setpoint', (t) => {
        const { ha, dev } = buildReadyDevice(t)
        try {
            steadyCool(dev)
            report(dev, [0x1f9, 3])
            assert.equal(shownTemperature(ha), 'None')
            assert.equal(shownComfort(ha), 'None')
            report(dev, [0x1fe, 34])
            assert.equal(shownComfort(ha), 0)

            report(dev, [0x1f9, 1])
            assert.equal(shownTemperature(ha), 'None')
            assert.equal(shownComfort(ha), 'None')
            report(dev, [0x1fe, 46])
            assert.equal(shownTemperature(ha), 23)
        } finally {
            dev.drop()
        }
    })

    test('while off only a setpoint reported outside auto is shown', (t) => {
        const { ha, dev } = buildReadyDevice(t)
        try {
            steadyAuto(dev)
            assert.equal(shownComfort(ha), 0)
            // A power-only shutdown from auto clears the comfort level.
            report(dev, [0x1f7, 0])
            assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'off')
            assert.equal(shownComfort(ha), 'None')
            assert.equal(shownTemperature(ha), 'None')

            report(dev, [0x1f9, 0], [0x1fe, 52])
            assert.equal(shownTemperature(ha), 26)
            assert.equal(shownComfort(ha), 'None')

            report(dev, [0x1f9, 3], [0x1fe, 34])
            assert.equal(shownTemperature(ha), 'None')
            assert.equal(shownComfort(ha), 'None')
        } finally {
            dev.drop()
        }
    })

    for (const powerFirst of [true, false]) {
        test(`a power-on report into auto sets both values (${powerFirst ? 'power' : 'mode'} first)`, (t) => {
            const { ha, dev } = buildReadyDevice(t)
            try {
                report(dev, [0x1f7, 0], [0x1f9, 0], [0x1fe, 52])
                if (powerFirst) report(dev, [0x1f7, 1], [0x1f9, 3], [0x1fe, 34])
                else report(dev, [0x1f9, 3], [0x1f7, 1], [0x1fe, 34])
                assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'auto')
                assert.equal(shownTemperature(ha), 'None')
                assert.equal(shownComfort(ha), 0)
            } finally {
                dev.drop()
            }
        })
    }

    test('a raw mode outside the table is shown in the not-auto branch', (t) => {
        const { ha, dev } = buildReadyDevice(t)
        try {
            steadyAuto(dev)
            assert.equal(shownComfort(ha), 0)
            // The base publisher drops raw 4, so the climate mode still reads auto.
            report(dev, [0x1f9, 4], [0x1fe, 38])
            assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'auto')
            assert.equal(shownTemperature(ha), 19)
            assert.equal(shownComfort(ha), 'None')
        } finally {
            dev.drop()
        }
    })

    test('a report carrying none of power, mode or setpoint publishes neither value', (t) => {
        const { ha, dev } = buildReadyDevice(t)
        try {
            steadyCool(dev)
            delete ha.devices[DEVICE_ID].properties['climate-temperature']
            delete ha.devices[DEVICE_ID].properties.auto_comfort
            report(dev, [0x1fd, 50])
            assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'current_temperature'), 25)
            assert.equal(shownTemperature(ha), undefined)
            assert.equal(shownComfort(ha), undefined)
        } finally {
            dev.drop()
        }
    })

    test('the climate entity keeps its temperature topics and gains a comfort level sensor', (t) => {
        const { ha, dev } = buildReadyDevice(t)
        try {
            const components = ha.devices[DEVICE_ID].config?.components as Record<string, Record<string, unknown>>
            assert.equal(components.climate.temperature_state_topic, '$this/climate-temperature')
            assert.equal(components.climate.temperature_command_topic, '$this/climate-temperature/set')
            assert.deepEqual(components.auto_comfort, {
                platform: 'sensor',
                unique_id: '$deviceid-auto_comfort',
                state_topic: '$this/auto_comfort',
                name: 'Auto comfort level',
                icon: 'mdi:thermometer-auto',
            })
        } finally {
            dev.drop()
        }
    })
})

describe('RAC_056905_WW display at discovery', () => {
    test('discovery publishes neither value; the first values report publishes both with the mode', (t) => {
        enableMockTimers(t)
        const { ha, thinq, dev } = makeDevice()
        try {
            thinq.emit('data', buf(CAPS_RESPONSE_HEX))
            thinq.emit('data', buf(QUERY_RESPONSE_HEX))
            tickMockTimers(t, 6000)
            assert.ok(ha.devices[DEVICE_ID]?.config)
            assert.equal(shownTemperature(ha), undefined)
            assert.equal(shownComfort(ha), undefined)

            report(dev, [0x1f9, 3], [0x1f7, 1], [0x1fe, 36])
            assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'auto')
            assert.equal(shownTemperature(ha), 'None')
            assert.equal(shownComfort(ha), 1)
        } finally {
            dev.drop()
        }
    })

    test('ownership filled from the cached state decides the first partial report', (t) => {
        enableMockTimers(t)
        const { ha, thinq, dev } = makeDevice()
        try {
            thinq.emit('data', buf(CAPS_RESPONSE_HEX))
            dev.processTLV(queryResponseWithout(0x1f9, 0x1fe))
            dev.raw_clip_state[0x1f9] = 3
            dev.raw_clip_state[0x1fe] = 34
            tickMockTimers(t, 6000)
            assert.ok(ha.devices[DEVICE_ID]?.config)
            assert.equal(shownTemperature(ha), undefined)
            assert.equal(shownComfort(ha), undefined)

            // The cached setpoint belongs to auto, so cool shows no value yet.
            report(dev, [0x1f7, 1], [0x1f9, 0])
            assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'cool')
            assert.equal(shownTemperature(ha), 'None')
            assert.equal(shownComfort(ha), 'None')
        } finally {
            dev.drop()
        }
    })

    test('reports received before discovery is built are kept', (t) => {
        enableMockTimers(t)
        const { ha, thinq, dev } = makeDevice()
        try {
            thinq.emit('data', buf(CAPS_RESPONSE_HEX))
            thinq.emit('data', buf(QUERY_RESPONSE_HEX))
            report(dev, [0x1f9, 0], [0x1fe, 52])
            // The cache moves on without a report: it must not replace what was reported.
            dev.raw_clip_state[0x1f9] = 3
            dev.raw_clip_state[0x1fe] = 34
            tickMockTimers(t, 6000)
            assert.ok(ha.devices[DEVICE_ID]?.config)

            report(dev, [0x1f7, 1])
            assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'auto')
            assert.equal(shownComfort(ha), 'None')
            report(dev, [0x1f9, 0])
            assert.equal(shownTemperature(ha), 26)
        } finally {
            dev.drop()
        }
    })

    test('a setpoint reported before any mode leaves its owner unknown', (t) => {
        enableMockTimers(t)
        const { ha, thinq, dev } = makeDevice()
        try {
            thinq.emit('data', buf(CAPS_RESPONSE_HEX))
            report(dev, [0x1fe, 34])
            report(dev, [0x1f9, 0])
            dev.processTLV(queryResponseWithout(0x1f9, 0x1fe))
            tickMockTimers(t, 6000)
            assert.ok(ha.devices[DEVICE_ID]?.config)

            report(dev, [0x1f7, 1], [0x1f9, 0])
            assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'cool')
            assert.equal(shownTemperature(ha), 'None')
            assert.equal(shownComfort(ha), 'None')

            thinq.resetRecorder()
            ha.setProperty(DEVICE_ID, 'climate', 'fan_mode_command', 'level_2')
            // The 34 has no known owner, so cool gets 26 C rather than it.
            assert.deepEqual(sentWrites(thinq.outbox), [
                [
                    [0x1fa, 4],
                    [0x1f9, 0],
                    [0x1fe, 52],
                ],
            ])
        } finally {
            dev.drop()
        }
    })
})

describe('RAC_056905_WW display while a Home Assistant command is unconfirmed', () => {
    test('after cool to auto, a power-only report shows auto with no values until confirmed', (t) => {
        const { ha, dev } = buildReadyDevice(t)
        try {
            steadyCool(dev)
            ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'auto')
            report(dev, [0x1f7, 1])
            assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'auto')
            assert.equal(shownTemperature(ha), 'None')
            assert.equal(shownComfort(ha), 'None')
            report(dev, [0x1f9, 3], [0x1fe, 34])
            assert.equal(shownComfort(ha), 0)
        } finally {
            dev.drop()
        }
    })

    test('after auto to cool, a power-only report shows no temperature', (t) => {
        const { ha, dev } = buildReadyDevice(t)
        try {
            steadyAuto(dev)
            ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'cool')
            report(dev, [0x1f7, 1])
            assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'cool')
            assert.equal(shownTemperature(ha), 'None')
            assert.equal(shownComfort(ha), 'None')
        } finally {
            dev.drop()
        }
    })

    test('after auto to dry, a setpoint-only report still belongs to auto', (t) => {
        const { ha, dev } = buildReadyDevice(t)
        try {
            steadyAuto(dev)
            ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'dry')
            report(dev, [0x1fe, 36])
            assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'auto')
            assert.equal(shownComfort(ha), 1)
            assert.equal(shownTemperature(ha), 'None')
        } finally {
            dev.drop()
        }
    })

    test('a temperature written from Home Assistant is shown only once reported', (t) => {
        const { ha, dev } = buildReadyDevice(t)
        try {
            steadyCool(dev)
            ha.setProperty(DEVICE_ID, 'climate', 'temperature_command', '24')
            report(dev, [0x1f7, 1])
            assert.equal(shownTemperature(ha), 26)
            report(dev, [0x1fe, 48])
            assert.equal(shownTemperature(ha), 24)
        } finally {
            dev.drop()
        }
    })

    test('after a power off command, a setpoint-only report keeps the shown branch', (t) => {
        const { ha, dev } = buildReadyDevice(t)
        try {
            steadyCool(dev)
            ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'off')
            report(dev, [0x1fe, 50])
            assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'cool')
            assert.equal(shownTemperature(ha), 25)
            assert.equal(shownComfort(ha), 'None')
        } finally {
            dev.drop()
        }
    })
})

describe('RAC_056905_WW sends every mode its own setpoint', () => {
    /** A write carries the target's setpoint in 0x1fe after the fan. */
    const modeWrite = (mode: number, setpoint: number, fan = 2) => [
        [0x1f9, mode],
        [0x1fa, fan],
        [0x1fe, setpoint],
    ]

    test('a mode write into auto carries the current setpoint, out of auto with none held 26 C', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)
        try {
            steadyAuto(dev)
            thinq.resetRecorder()
            ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'cool')
            assert.deepEqual(sentWrites(thinq.outbox), [modeWrite(0, 52)])

            steadyCool(dev)
            report(dev, [0x1fe, 50])
            thinq.resetRecorder()
            ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'auto')
            assert.deepEqual(sentWrites(thinq.outbox), [modeWrite(3, 50)])
        } finally {
            dev.drop()
        }
    })

    test('leaving auto carries the setpoint cool last reported, and so does the next fan speed', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)
        try {
            steadyCool(dev)
            report(dev, [0x1fe, 50])
            // The auto comfort value does not replace cool's own.
            report(dev, [0x1f9, 3], [0x1fe, 36])
            thinq.resetRecorder()
            ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'cool')
            ha.setProperty(DEVICE_ID, 'climate', 'fan_mode_command', 'level_2')
            assert.deepEqual(sentWrites(thinq.outbox), [
                modeWrite(0, 50),
                [
                    [0x1fa, 4],
                    [0x1f9, 0],
                    [0x1fe, 50],
                ],
            ])
        } finally {
            dev.drop()
        }
    })

    test('each mode written after a mode-only auto report gets its own last setpoint', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)
        try {
            report(dev, [0x1f7, 1], [0x1f9, 0], [0x1fa, 2], [0x1fe, 50])
            report(dev, [0x1f9, 1], [0x1fe, 46])
            report(dev, [0x1f9, 3])
            thinq.resetRecorder()
            ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'dry')
            ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'cool')
            assert.deepEqual(sentWrites(thinq.outbox), [modeWrite(1, 46), modeWrite(0, 50)])
        } finally {
            dev.drop()
        }
    })

    test('the later of two cool reports is the one leaving auto carries', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)
        try {
            report(dev, [0x1f7, 1], [0x1f9, 0], [0x1fa, 2], [0x1fe, 50])
            report(dev, [0x1fe, 48])
            report(dev, [0x1f9, 3], [0x1fe, 34])
            thinq.resetRecorder()
            ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'cool')
            assert.deepEqual(sentWrites(thinq.outbox), [modeWrite(0, 48)])
        } finally {
            dev.drop()
        }
    })

    for (const dryHeld of [false, true]) {
        test(`cool to dry carries ${dryHeld ? 'the setpoint held for dry' : '26 C when none is held for dry'}`, (t) => {
            const { ha, thinq, dev } = buildReadyDevice(t)
            try {
                if (dryHeld) report(dev, [0x1f7, 1], [0x1f9, 1], [0x1fa, 2], [0x1fe, 46])
                report(dev, [0x1f7, 1], [0x1f9, 0], [0x1fa, 2], [0x1fe, 50])
                thinq.resetRecorder()
                ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'dry')
                assert.deepEqual(sentWrites(thinq.outbox), [modeWrite(1, dryHeld ? 46 : 52)])
            } finally {
                dev.drop()
            }
        })
    }

    test('after auto to dry, a fan speed carries dry its own setpoint, not the auto value reported since', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)
        try {
            report(dev, [0x1f7, 1], [0x1f9, 1], [0x1fa, 2], [0x1fe, 46])
            steadyAuto(dev)
            ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'dry')
            report(dev, [0x1fe, 36])
            thinq.resetRecorder()
            ha.setProperty(DEVICE_ID, 'climate', 'fan_mode_command', 'level_2')
            assert.deepEqual(sentWrites(thinq.outbox), [
                [
                    [0x1fa, 4],
                    [0x1f9, 1],
                    [0x1fe, 46],
                ],
            ])
        } finally {
            dev.drop()
        }
    })

    test('auto to cool, a temperature and back to auto before any report keep the temperature for cool', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)
        try {
            steadyAuto(dev)
            thinq.resetRecorder()
            ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'cool')
            ha.setProperty(DEVICE_ID, 'climate', 'temperature_command', '24')
            ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'auto')
            assert.deepEqual(sentWrites(thinq.outbox), [
                modeWrite(0, 52),
                [
                    [0x1fe, 48],
                    [0x1f9, 0],
                    [0x1fa, 2],
                ],
                modeWrite(3, 48),
            ])

            report(dev, [0x1f9, 3], [0x1fe, 34])
            thinq.resetRecorder()
            ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'cool')
            assert.deepEqual(sentWrites(thinq.outbox), [modeWrite(0, 48)])
        } finally {
            dev.drop()
        }
    })

    for (const coolSelected of [false, true]) {
        test(`a direct power-on ${coolSelected ? "with cool selected after auto carries cool's own" : 'in auto carries the current'} setpoint`, (t) => {
            const { ha, thinq, dev } = buildReadyDevice(t)
            try {
                report(dev, [0x1f7, 0], [0x1f9, 0], [0x1fa, 2], [0x1fe, 50])
                report(dev, [0x1f9, 3], [0x1fe, 34])
                if (coolSelected) report(dev, [0x1f9, 0])
                thinq.resetRecorder()
                ha.setProperty(DEVICE_ID, 'climate', 'power_command', 'ON')
                assert.deepEqual(sentWrites(thinq.outbox), [
                    [
                        [0x1f7, 1],
                        [0x1f9, coolSelected ? 0 : 3],
                        [0x1fa, 2],
                        [0x1fe, coolSelected ? 50 : 34],
                    ],
                ])
            } finally {
                dev.drop()
            }
        })
    }

    test('a setpoint reported before its mode in one report belongs to that mode', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)
        try {
            steadyCool(dev)
            report(dev, [0x1fe, 34], [0x1f9, 3])
            thinq.resetRecorder()
            ha.setProperty(DEVICE_ID, 'climate', 'fan_mode_command', 'level_2')
            assert.deepEqual(sentWrites(thinq.outbox), [
                [
                    [0x1fa, 4],
                    [0x1f9, 3],
                    [0x1fe, 34],
                ],
            ])
        } finally {
            dev.drop()
        }
    })

    for (const [to, toRaw] of [
        ['auto', 3],
        ['cool', 0],
    ] as const) {
        test(`a mode chosen while off into ${to} carries ${to === 'auto' ? 'the current' : "cool's own"} setpoint`, (t) => {
            const { ha, thinq, dev } = buildReadyDevice(t)
            try {
                report(dev, [0x1f7, 0], [0x1f9, 0], [0x1fa, 2], [0x1fe, 50])
                if (to === 'cool') report(dev, [0x1f9, 3], [0x1fe, 34])
                thinq.resetRecorder()
                ha.setProperty(DEVICE_ID, 'climate', 'mode_command', to)
                assert.deepEqual(sentWrites(thinq.outbox), [
                    [
                        [0x1f9, toRaw],
                        [0x1f7, 1],
                        [0x1fa, 2],
                        [0x1fe, 50],
                    ],
                ])
            } finally {
                dev.drop()
            }
        })
    }

    test("a fan speed carries the setpoint of raw state's mode", (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)
        try {
            steadyAuto(dev)
            thinq.resetRecorder()
            ha.setProperty(DEVICE_ID, 'climate', 'fan_mode_command', 'level_3')
            assert.deepEqual(sentWrites(thinq.outbox), [
                [
                    [0x1fa, 6],
                    [0x1f9, 3],
                    [0x1fe, 34],
                ],
            ])

            // Right after auto to cool, with no setpoint held for cool.
            thinq.resetRecorder()
            ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'cool')
            ha.setProperty(DEVICE_ID, 'climate', 'fan_mode_command', 'level_2')
            assert.deepEqual(sentWrites(thinq.outbox)[1], [
                [0x1fa, 4],
                [0x1f9, 0],
                [0x1fe, 52],
            ])
        } finally {
            dev.drop()
        }
    })

    test('a written temperature is carried by the next fan speed', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)
        try {
            steadyCool(dev)
            thinq.resetRecorder()
            ha.setProperty(DEVICE_ID, 'climate', 'temperature_command', '24')
            ha.setProperty(DEVICE_ID, 'climate', 'fan_mode_command', 'level_3')
            assert.deepEqual(sentWrites(thinq.outbox), [
                [
                    [0x1fe, 48],
                    [0x1f9, 0],
                    [0x1fa, 2],
                ],
                [
                    [0x1fa, 6],
                    [0x1f9, 0],
                    [0x1fe, 48],
                ],
            ])
        } finally {
            dev.drop()
        }
    })

    test('a temperature in auto is not written, on or off', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)
        try {
            steadyAuto(dev)
            thinq.resetRecorder()
            ha.setProperty(DEVICE_ID, 'climate', 'temperature_command', '24')
            assert.deepEqual(sentWrites(thinq.outbox), [])
            assert.equal(dev.raw_clip_state[0x1fe], 34)

            report(dev, [0x1f7, 0])
            ha.setProperty(DEVICE_ID, 'climate', 'temperature_command', '24')
            assert.deepEqual(sentWrites(thinq.outbox), [])
            assert.equal(dev.raw_clip_state[0x1fe], 34)

            steadyCool(dev)
            thinq.resetRecorder()
            ha.setProperty(DEVICE_ID, 'climate', 'temperature_command', '24')
            assert.deepEqual(sentWrites(thinq.outbox), [
                [
                    [0x1fe, 48],
                    [0x1f9, 0],
                    [0x1fa, 2],
                ],
            ])
        } finally {
            dev.drop()
        }
    })

    for (const [to, toRaw, setpoint] of [
        ['cool', 0, 52],
        ['auto', 3, 34],
    ] as const) {
        test(`a mode write into ${to} with no cached setpoint carries ${setpoint}`, (t) => {
            enableMockTimers(t)
            const { ha, thinq, dev } = makeDevice()
            try {
                thinq.emit('data', buf(CAPS_RESPONSE_HEX))
                dev.processTLV(queryResponseWithout(0x1fe))
                tickMockTimers(t, 6000)
                assert.ok(ha.devices[DEVICE_ID]?.config)
                thinq.resetRecorder()
                ha.setProperty(DEVICE_ID, 'climate', 'mode_command', to)
                assert.deepEqual(sentWrites(thinq.outbox), [modeWrite(toRaw, setpoint, 3)])
            } finally {
                dev.drop()
            }
        })
    }

    /** Complete discovery with a values response that carries neither mode nor setpoint. */
    const discoverWithoutModeOrSetpoint = (t: import('node:test').TestContext, ha: MockHAConnection, dev: DUT) => {
        dev.processTLV(queryResponseWithout(0x1f9, 0x1fe))
        tickMockTimers(t, 6000)
        assert.ok(ha.devices[DEVICE_ID]?.config)
    }

    test('a cool report received before discovery is kept through a later auto report', (t) => {
        enableMockTimers(t)
        const { ha, thinq, dev } = makeDevice()
        try {
            thinq.emit('data', buf(CAPS_RESPONSE_HEX))
            report(dev, [0x1f9, 0], [0x1fe, 50])
            report(dev, [0x1f9, 3], [0x1fe, 34])
            discoverWithoutModeOrSetpoint(t, ha, dev)
            thinq.resetRecorder()
            ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'cool')
            assert.deepEqual(sentWrites(thinq.outbox), [modeWrite(0, 50, 3)])
        } finally {
            dev.drop()
        }
    })

    test('an auto setpoint reported before discovery is never carried into cool', (t) => {
        enableMockTimers(t)
        const { ha, thinq, dev } = makeDevice()
        try {
            thinq.emit('data', buf(CAPS_RESPONSE_HEX))
            report(dev, [0x1f9, 3], [0x1fe, 34])
            report(dev, [0x1f9, 0])
            discoverWithoutModeOrSetpoint(t, ha, dev)
            thinq.resetRecorder()
            ha.setProperty(DEVICE_ID, 'climate', 'fan_mode_command', 'level_2')
            assert.deepEqual(sentWrites(thinq.outbox), [
                [
                    [0x1fa, 4],
                    [0x1f9, 0],
                    [0x1fe, 52],
                ],
            ])
        } finally {
            dev.drop()
        }
    })

    test('discovery from a cached cool state holds its setpoint for cool', (t) => {
        enableMockTimers(t)
        const { ha, thinq, dev } = makeDevice()
        try {
            thinq.emit('data', buf(CAPS_RESPONSE_HEX))
            dev.processTLV(queryResponseWithout(0x1f9, 0x1fe))
            // Set directly: in production reports fill the cache and already hold the
            // setpoint, so the seed at discovery covers a cache filled any other way.
            dev.raw_clip_state[0x1f9] = 0
            dev.raw_clip_state[0x1fe] = 48
            tickMockTimers(t, 6000)
            assert.ok(ha.devices[DEVICE_ID]?.config)

            report(dev, [0x1f9, 3], [0x1fe, 34])
            thinq.resetRecorder()
            ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'cool')
            assert.deepEqual(sentWrites(thinq.outbox), [modeWrite(0, 48, 3)])
        } finally {
            dev.drop()
        }
    })

    test('a temperature written while no mode is known holds no setpoint for a mode', (t) => {
        enableMockTimers(t)
        const { ha, thinq, dev } = makeDevice()
        try {
            thinq.emit('data', buf(CAPS_RESPONSE_HEX))
            dev.processTLV(queryResponseWithout(0x1f9))
            tickMockTimers(t, 6000)
            assert.ok(ha.devices[DEVICE_ID]?.config)
            thinq.resetRecorder()
            ha.setProperty(DEVICE_ID, 'climate', 'temperature_command', '24')
            assert.equal(sentWrites(thinq.outbox).length, 1, 'the write is still sent')

            report(dev, [0x1f9, 0])
            thinq.resetRecorder()
            ha.setProperty(DEVICE_ID, 'climate', 'fan_mode_command', 'level_2')
            assert.deepEqual(sentWrites(thinq.outbox), [
                [
                    [0x1fa, 4],
                    [0x1f9, 0],
                    [0x1fe, 52],
                ],
            ])
        } finally {
            dev.drop()
        }
    })
})

describe('RAC_056905_WW mode changes re-send only features that are on', () => {
    const countModeHooks = (dev: DUT) => {
        const counts = dev.modeChangeHooks.map(() => 0)
        dev.modeChangeHooks = dev.modeChangeHooks.map((hook, i) => () => {
            counts[i]++
            hook()
        })
        return counts
    }
    const rememberFeaturesInCool = (dev: DUT) => {
        steadyCool(dev)
        report(dev, [0x323, 1], [0x20d, 1])
        assert.equal(dev.jetMode, true)
        assert.equal(dev.energySave, true)
    }

    test('a change to cool with both features off writes nothing through the refresh delay', (t) => {
        const { thinq, dev } = buildReadyDevice(t)
        try {
            report(dev, [0x1f7, 1], [0x1f9, 1])
            thinq.resetRecorder()
            report(dev, [0x1f9, 0])
            tickMockTimers(t, 2000)
            assert.deepEqual(sentWrites(thinq.outbox), [])
        } finally {
            dev.drop()
        }
    })

    test('features on and absent from the report are re-sent as ON', (t) => {
        const { thinq, dev } = buildReadyDevice(t)
        try {
            rememberFeaturesInCool(dev)
            report(dev, [0x1f9, 1])
            thinq.resetRecorder()
            report(dev, [0x1f9, 0])
            assert.deepEqual(sentWrites(thinq.outbox), [[[0x323, 1]], [[0x20d, 1]]])
        } finally {
            dev.drop()
        }
    })

    for (const featureFirst of [true, false]) {
        test(`a feature the same report turns off is not re-sent (${featureFirst ? 'feature' : 'mode'} first)`, (t) => {
            const { thinq, dev } = buildReadyDevice(t)
            try {
                rememberFeaturesInCool(dev)
                report(dev, [0x1f9, 1])
                thinq.resetRecorder()
                if (featureFirst) report(dev, [0x323, 0], [0x20d, 0], [0x1f9, 0])
                else report(dev, [0x1f9, 0], [0x323, 0], [0x20d, 0])
                assert.deepEqual(sentWrites(thinq.outbox), [])
                assert.equal(dev.jetMode, false)
                assert.equal(dev.energySave, false)

                report(dev, [0x1f9, 1])
                report(dev, [0x1f9, 0])
                assert.deepEqual(sentWrites(thinq.outbox), [])
            } finally {
                dev.drop()
            }
        })
    }

    test('jet reported on before the mode that supports it is recorded', (t) => {
        const { dev } = buildReadyDevice(t)
        try {
            report(dev, [0x1f7, 1], [0x1f9, 1])
            report(dev, [0x323, 1], [0x1f9, 0])
            assert.equal(dev.jetMode, true)
        } finally {
            dev.drop()
        }
    })

    test('an OFF read in a mode without jet keeps jet remembered for the next cool', (t) => {
        const { thinq, dev } = buildReadyDevice(t)
        try {
            steadyCool(dev)
            report(dev, [0x323, 1])
            thinq.resetRecorder()
            report(dev, [0x1f9, 3], [0x323, 0])
            assert.equal(dev.jetMode, true)
            assert.deepEqual(sentWrites(thinq.outbox), [])

            report(dev, [0x1f9, 0])
            assert.deepEqual(sentWrites(thinq.outbox), [[[0x323, 1]]])
        } finally {
            dev.drop()
        }
    })

    test('after an auto to cool command the mode hooks run once and write nothing', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)
        try {
            steadyAuto(dev)
            const counts = countModeHooks(dev)
            ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'cool')
            thinq.resetRecorder()

            report(dev, [0x1f7, 1])
            assert.ok(counts.length)
            assert.deepEqual(
                counts,
                counts.map(() => 1),
                'each mode hook runs on the power-only report that shows cool',
            )
            report(dev, [0x1f9, 0], [0x1fe, 52])
            assert.deepEqual(
                counts,
                counts.map(() => 1),
                'the confirming report runs none again',
            )
            tickMockTimers(t, 2000)
            assert.deepEqual(sentWrites(thinq.outbox), [])
        } finally {
            dev.drop()
        }
    })

    test('after a power off command, a feature tag is judged by its own report', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)
        try {
            steadyCool(dev)
            report(dev, [0x323, 1])

            // A report carrying jet alone is judged under the raw power the command set.
            ha.setProperty(DEVICE_ID, 'climate', 'power_command', 'OFF')
            report(dev, [0x323, 0])
            assert.equal(dev.jetMode, true)

            // One carrying its own power and mode records jet off.
            report(dev, [0x323, 0], [0x1f7, 1], [0x1f9, 0])
            assert.equal(dev.jetMode, false)

            thinq.resetRecorder()
            report(dev, [0x1f9, 1])
            report(dev, [0x1f9, 0])
            assert.deepEqual(sentWrites(thinq.outbox), [])
        } finally {
            dev.drop()
        }
    })
})

describe('RAC_056905_WW setpoint ownership is the bedroom encoding only', () => {
    test('the advertised encoding keeps its setpoint on an auto mode write and has no comfort sensor', (t) => {
        enableMockTimers(t)
        const ha = new MockHAConnection()
        const meta: Metadata = { ...META, modelId: 'RAC_0B0001_WW' }
        const thinq = new MockThinq2Device(DEVICE_ID, meta)
        const dev = new DUT(ha.asConnection(), thinq, meta)
        ha.on('setProperty', (_id: string, prop: string, value: string) => dev.setProperty(prop, value))
        try {
            thinq.emit('data', buf(CAPS_RESPONSE_HEX))
            thinq.emit('data', buf(QUERY_RESPONSE_HEX))
            tickMockTimers(t, 6000)
            const components = ha.devices[DEVICE_ID].config?.components as Record<string, unknown>
            assert.equal(components.auto_comfort, undefined)

            thinq.resetRecorder()
            ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'auto')
            assert.deepEqual(sentWrites(thinq.outbox), [
                [
                    [0x1f9, 6],
                    [0x1fa, 3],
                    [0x1fe, 38],
                ],
            ])
        } finally {
            dev.drop()
        }
    })
})
