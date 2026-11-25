import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { setEnergyDataDirectory } from '@/cloud/devices/energy_meter'
import DUT from '@/cloud/devices/F21VDT_AKOR'
import type { Metadata } from '@/cloud/thinq'
import { buf, MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'

const META: Metadata = { modelId: 'F21VDT_AKOR', modelName: 'F21VDT_AKOR', swVersion: '1.0' }
const LIVE_POWER_OFF = buf('AA2220EB001A000000000000000000000000000000000000000534150400000016BB')

describe('F21VDT_AKOR', () => {
    test('decodes the live washer snapshot', () => {
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device('washer-id', META)
        new DUT(ha.asConnection(), thinq, META)
        thinq.emit('data', LIVE_POWER_OFF)

        const p = ha.devices['washer-id'].properties
        assert.equal(p.power, 'OFF')
        assert.equal(p.status, 'POWEROFF')
        assert.equal(p.run_completed, 'OFF')
        assert.equal(p.previous_status, 'INITIAL')
        assert.equal(p.remaining_time, 0)
        assert.equal(p.initial_time, 0)
        assert.equal(p.downloaded_course, 'SMALL_LOAD')
        assert.equal(p.operation_course, 'SPEEDWASH')
        assert.equal(p.tub_clean_count, 21)
    })

    test('exposes only observed read-only components', () => {
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device('washer-id', META)
        new DUT(ha.asConnection(), thinq, META)
        const components = ha.devices['washer-id'].config?.components
        assert.ok(components)
        assert.ok(components.status)
        assert.ok(components.run_completed)
        assert.ok(components.tub_clean_count)
        assert.equal(components.remote_start, undefined)
        assert.equal(components.power_off, undefined)
    })
})

test('F21VDT_AKOR reports the errors its model defines', () => {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('washer-id', META)
    new DUT(ha.asConnection(), thinq, META)

    const report = (code: number) => {
        const rec = Buffer.alloc(28)
        rec[1] = 0x1a
        rec[8] = code
        thinq.emit('data', Buffer.concat([Buffer.from([0xaa, 0x22, 0x20, 0xeb]), rec, Buffer.from([0, 0xbb])]))
        return ha.devices['washer-id'].properties
    }

    assert.equal(report(0).error, 'OFF')
    assert.equal(report(0).error_message, 'NO_ERROR')
    for (const [code, name] of [
        [1, 'ERROR_DE2'],
        [2, 'ERROR_IE'],
        [8, 'ERROR_LE'],
        [12, 'ERROR_FF'],
        [18, 'ERROR_LOE'],
        [19, 'ERROR_DE4'],
    ] as const) {
        const p = report(code)
        assert.equal(p.error_message, name)
        assert.equal(p.error, 'ON')
    }
})

test('F21VDT_AKOR names every download course the app offered', () => {
    // Each byte came from a `f0 25` download command captured on the wire while the owner
    // picked that course in the ThinQ app, fourteen in one sitting. index 17 was the only
    // position that differed across all fourteen, and SMALL_LOAD landing on the 0x34 this
    // handler already carried is the independent check that it is the right position.
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('washer-id', META)
    new DUT(ha.asConnection(), thinq, META)

    for (const [code, course] of [
        [0x33, 'COLD_WASH'],
        [0x34, 'SMALL_LOAD'],
        [0x35, 'SKIN_CARE'],
        [0x36, 'RAINY_DAY'],
        [0x37, 'SWEAT_STAIN'],
        [0x38, 'SINGLE_GARMENTS'],
        [0x39, 'KIDS_WEAR'],
        [0x3a, 'SHIRT'],
        [0x3b, 'SCHOOL_UNIFORM'],
        [0x3c, 'STATIC_REDUCE'],
        [0x3f, 'SPIN_ONLY'],
        [0x41, 'DEODORIZATION_WASHER'],
        [0x43, 'CLOTH_CARE'],
        [0x44, 'SMART_RINSE'],
    ] as const) {
        const rec = Buffer.alloc(28)
        rec[1] = 0x1a
        rec[22] = code
        thinq.emit('data', Buffer.concat([Buffer.from([0xaa, 0x22, 0x20, 0xeb]), rec, Buffer.from([0, 0xbb])]))
        assert.equal(ha.devices['washer-id'].properties.downloaded_course, course)
    }
})

test('F21VDT_AKOR names the tub-clean course off the dial', () => {
    // 통살균 is not one of the dial's fourteen positions; its run reported course 15.
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('washer-id', META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    const rec = Buffer.alloc(28)
    rec[1] = 0x1a
    rec[7] = 15
    const inner = Buffer.concat([Buffer.from([0x20, 0xeb]), rec])
    thinq.emit('data', Buffer.concat([Buffer.from([0xaa, inner.length + 4]), inner, Buffer.from([0x00, 0xbb])]))
    assert.equal(ha.devices['washer-id'].properties.course, 'TUB_CLEAN')
    dev.drop()
})

test('F21VDT_AKOR names every course its dial reaches', () => {
    // Read off the appliance one dial position at a time, in the order the panel lists
    // them. The values run 7 down to 1 and wrap to 14, closing back on 표준세탁.
    const dial: Array<[number, string]> = [
        [7, 'NORMAL_WASH'],
        [6, 'STAIN_CARE'],
        [5, 'BABY_WEAR'],
        [4, 'ECO_BOIL'],
        [3, 'SPORTWEAR'],
        [2, 'ALLERGY_CARE'],
        [1, 'STEAM_STYLING'],
        [14, 'DOWNLOADED'],
        [13, 'RINSE_SPIN'],
        [12, 'LINGERIE_WOOL'],
        [11, 'BULKYITEM'],
        [10, 'COLOR_CARE'],
        [9, 'QUIET_WASH'],
        [8, 'SPEEDWASH'],
    ]

    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('washer-id', META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    for (const [raw, name] of dial) {
        const rec = Buffer.alloc(28)
        rec[1] = 0x1a
        rec[7] = raw
        const inner = Buffer.concat([Buffer.from([0x20, 0xeb]), rec])
        const frame = Buffer.concat([Buffer.from([0xaa, inner.length + 4]), inner, Buffer.from([0x00, 0xbb])])
        thinq.emit('data', frame)
        assert.equal(ha.devices['washer-id'].properties.course, name, `raw ${raw}`)
    }
    dev.drop()
})

/**
 * A status record carrying only the energy estimate rec[19..20]: running (state 23, RUNNING)
 * when `running` is nonzero, else END (state 60). rec[25] takes `running` as the appliance's
 * own flag does, which the cycle end no longer depends on.
 */
function energyRecord(wh: number, running: number, state = running ? 23 : 60) {
    const rec = Buffer.alloc(28)
    rec[1] = 0x1a
    rec[2] = state
    rec[19] = wh >> 8
    rec[20] = wh & 0xff
    rec[25] = running
    return Buffer.concat([Buffer.from([0xaa, 0x22, 0x20, 0xeb]), rec, Buffer.from([0, 0xbb])])
}

describe('F21VDT_AKOR energy', () => {
    let dir: string
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'rethink-washer-energy-'))
    })
    afterEach(() => {
        setEnergyDataDirectory(undefined as unknown as string)
        rmSync(dir, { recursive: true, force: true })
    })

    function washer(ha = new MockHAConnection()) {
        const thinq = new MockThinq2Device('washer-id', META)
        new DUT(ha.asConnection(), thinq, META)
        return { ha, thinq, p: () => ha.devices['washer-id'].properties }
    }
    const savedTotal = () => JSON.parse(readFileSync(join(dir, 'washer-energy-washer-id.json'), 'utf-8')).totalWh

    test('publishes the estimate and exposes both energy sensors', () => {
        const { ha, thinq, p } = washer()
        const components = ha.devices['washer-id'].config?.components as Record<string, Record<string, unknown>>
        assert.deepEqual(components.estimated_energy, {
            platform: 'sensor',
            unique_id: '$deviceid-estimated_energy',
            state_topic: '$this/estimated_energy',
            name: 'Estimated energy',
            icon: 'mdi:lightning-bolt-outline',
            device_class: 'energy',
            unit_of_measurement: 'Wh',
        })
        assert.deepEqual(components.energy_total, {
            platform: 'sensor',
            device_class: 'energy',
            unique_id: '$deviceid-energy_total',
            state_topic: '$this/energy_total',
            name: '누적 전력 사용량',
            unit_of_measurement: 'Wh',
            state_class: 'total_increasing',
            icon: 'mdi:lightning-bolt',
        })
        assert.equal(p().energy_total, 0, 'the total is published with its discovery')

        const rec = Buffer.alloc(28)
        rec[1] = 0x1a
        rec[19] = 5
        rec[20] = 111
        thinq.emit('data', Buffer.concat([Buffer.from([0xaa, 0x22, 0x20, 0xeb]), rec, Buffer.from([0, 0xbb])]))
        assert.equal(p().estimated_energy, 1391)
    })

    test('adds each finished cycle once, at the record whose state becomes END', () => {
        const { thinq, p } = washer()
        for (const wh of [0, 120, 800, 1468, 345, 900]) thinq.emit('data', energyRecord(wh, 1))
        assert.equal(p().energy_total, 0, 'a fall in mid-cycle changes nothing')
        thinq.emit('data', energyRecord(1391, 0))
        assert.equal(p().energy_total, 1391)
        thinq.emit('data', energyRecord(1392, 0))
        assert.equal(p().energy_total, 1391, 'a repeated end record counts once')

        for (const wh of [10, 300]) thinq.emit('data', energyRecord(wh, 1))
        thinq.emit('data', energyRecord(631, 0))
        assert.equal(p().energy_total, 2022)
    })

    test('counts the 2026-11-23 cycle, whose rec[25] stayed 2, at its END record', () => {
        const { thinq, p } = washer()
        for (const wh of [0, 231]) thinq.emit('data', energyRecord(wh, 2))
        for (const wh of [739, 108, 1162]) thinq.emit('data', energyRecord(wh, 2, 30))
        for (const wh of [92, 1212]) thinq.emit('data', energyRecord(wh, 2, 40))
        thinq.emit('data', energyRecord(126, 0))
        assert.equal(p().energy_total, 126)
        thinq.emit('data', energyRecord(126, 0, 0))
        assert.equal(p().energy_total, 126, 'the power-off after END adds nothing')
    })

    test('an END record still carrying a nonzero rec[25] ends the cycle', () => {
        const { thinq, p } = washer()
        thinq.emit('data', energyRecord(500, 1, 40))
        thinq.emit('data', energyRecord(631, 1, 60))
        assert.equal(p().energy_total, 631)
    })

    test('a cycle switched off before END is not counted', () => {
        const { thinq, p } = washer()
        for (const wh of [0, 300, 600]) thinq.emit('data', energyRecord(wh, 1))
        thinq.emit('data', energyRecord(600, 0, 0))
        assert.equal(p().energy_total, 0)
    })

    test('a handler whose first record is END adds nothing', () => {
        const { thinq, p } = washer()
        thinq.emit('data', energyRecord(1391, 0))
        thinq.emit('data', energyRecord(1391, 0))
        assert.equal(p().energy_total, 0)
    })

    test('a cycle whose energy is 0 adds nothing', () => {
        setEnergyDataDirectory(dir)
        const { thinq, p } = washer()
        thinq.emit('data', energyRecord(0, 1))
        thinq.emit('data', energyRecord(0, 0))
        assert.equal(p().energy_total, 0)
        assert.throws(() => statSync(join(dir, 'washer-energy-washer-id.json')), 'nothing was written')
    })

    test('keeps the total across a restart, owner-readable only', () => {
        setEnergyDataDirectory(dir)
        const first = washer()
        first.thinq.emit('data', energyRecord(900, 1))
        first.thinq.emit('data', energyRecord(1391, 0))
        assert.equal(savedTotal(), 1391)
        assert.equal(statSync(join(dir, 'washer-energy-washer-id.json')).mode & 0o777, 0o600)

        const second = washer()
        assert.equal(second.p().energy_total, 1391, 'the saved total is published at discovery')
        second.thinq.emit('data', energyRecord(400, 1))
        second.thinq.emit('data', energyRecord(631, 0))
        assert.equal(second.p().energy_total, 2022)
        assert.equal(savedTotal(), 2022)
    })

    test('two handlers alive over one directory keep both cycles', () => {
        setEnergyDataDirectory(dir)
        const first = washer()
        const second = washer(new MockHAConnection())
        first.thinq.emit('data', energyRecord(900, 1))
        second.thinq.emit('data', energyRecord(300, 1))
        first.thinq.emit('data', energyRecord(1391, 0))
        second.thinq.emit('data', energyRecord(631, 0))
        assert.equal(savedTotal(), 2022)
        assert.equal(second.p().energy_total, 2022)
    })

    test('lives in memory when no directory has been named', () => {
        const { thinq, p } = washer()
        thinq.emit('data', energyRecord(900, 1))
        thinq.emit('data', energyRecord(1391, 0))
        assert.equal(p().energy_total, 1391)

        setEnergyDataDirectory(dir)
        assert.equal(washer().p().energy_total, 0, 'nothing was written')
    })

    test('a damaged file or an impossible saved value reads as 0', () => {
        setEnergyDataDirectory(dir)
        const path = join(dir, 'washer-energy-washer-id.json')
        for (const content of [
            '{ truncated',
            '{"totalWh":-5}',
            '{"totalWh":"many"}',
            '{"totalWh":"42"}',
            '{"totalWh":true}',
            '{"totalWh":[7]}',
        ]) {
            writeFileSync(path, content)
            assert.equal(washer().p().energy_total, 0, content)
        }
    })

    test('a failed save never makes the published total drop', () => {
        setEnergyDataDirectory(dir)
        // A directory where the file belongs makes both the reread and the save fail.
        const path = join(dir, 'washer-energy-washer-id.json')
        mkdirSync(path)
        const { thinq, p } = washer()
        thinq.emit('data', energyRecord(900, 1))
        thinq.emit('data', energyRecord(1391, 0))
        assert.equal(p().energy_total, 1391)

        rmdirSync(path)
        thinq.emit('data', energyRecord(300, 1))
        thinq.emit('data', energyRecord(631, 0))
        assert.equal(p().energy_total, 2022)
        assert.equal(savedTotal(), 2022)
    })
})
