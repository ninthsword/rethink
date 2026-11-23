import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { setEnergyDataDirectory } from '@/cloud/devices/energy_meter'
import DUT from '@/cloud/devices/RH16KR'
import type { Metadata } from '@/cloud/thinq'
import { buf, MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'
import { localizeDiscovery } from '@/util/ha_locale'

const META: Metadata = { modelId: 'RH16KR', modelName: 'RH16KR', swVersion: '1.0' }
const LIVE_POWER_OFF = buf('AA2130EB001900000000000000000000000000000000000000010000008300D6BB')

test('RH16KR decodes the live dryer snapshot', () => {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('dryer-id', META)
    new DUT(ha.asConnection(), thinq, META)
    thinq.emit('data', LIVE_POWER_OFF)

    const p = ha.devices['dryer-id'].properties
    assert.equal(p.power, 'OFF')
    assert.equal(p.status, 'POWEROFF')
    assert.equal(p.process_status, 'NONE')
    assert.equal(p.run_completed, 'OFF')
    assert.equal(p.remaining_time, 0)
    assert.equal(p.dry_level, 'NO')
    assert.equal(p.eco_hybrid, 'NONE')
    assert.equal(p.anti_crease, 'OFF')
    assert.equal(p.control_lock, 'OFF')
    assert.equal(p.downloaded_course, 'SELFCLEANING')

    const config = ha.devices['dryer-id'].config
    assert.ok(config)
    assert.equal(localizeDiscovery(config, 'korean').components.eco_hybrid.name, '절약건조')
    assert.equal(localizeDiscovery(config, 'korean').components.control_lock.name, '버튼잠금')
})

test('RH16KR reads the newer of the two records a 0xEC packet carries', () => {
    // Captured from the appliance one second after the ThinQ app downloaded 구김 완화 건조:
    // the download command carried 0x72, and only the second record had taken it. Reading
    // the first showed the previous course, so a downloaded course appeared to flip back and
    // forth on its own for as long as it took the next report to catch up. The washer,
    // dishwasher and Hd0C_F siblings all read the second record; this one did not.
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('dryer-id', META)
    new DUT(ha.asConnection(), thinq, META)

    thinq.emit(
        'data',
        buf(
            'AA3C30EC00190000000000000000000000000000000800000004000000770000190000000000000000000000000000080800000004000000720068BB',
        ),
    )

    assert.equal(ha.devices['dryer-id'].properties.downloaded_course, 'MINIMIZEWRINKLES')
})

test('RH16KR names the courses whose codes the download command revealed', () => {
    // Each byte here came from a `f0 25` download command captured on the wire while the
    // owner picked that course in the app, so the pairing is the appliance's own, not a guess.
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('dryer-id', META)
    new DUT(ha.asConnection(), thinq, META)

    for (const [code, course] of [
        [0x66, 'GYMCLOTHES'],
        [0x69, 'RAINYSEASON'],
        [0x6b, 'DEODORIZATION'],
        [0x6c, 'SMALLLOAD'],
        [0x6e, 'EASYIRON'],
        [0x70, 'ECONOMICDRY'],
        [0x71, 'BIGSIZEITEM'],
        [0x72, 'MINIMIZEWRINKLES'],
        [0x74, 'FULLSIZELOAD'],
        [0x77, 'POWER'],
    ] as const) {
        const rec = Buffer.alloc(27)
        rec[1] = 0x19
        rec[25] = code
        thinq.emit('data', Buffer.concat([Buffer.from([0xaa, 0x21, 0x30, 0xeb]), rec, Buffer.from([0, 0xbb])]))
        assert.equal(ha.devices['dryer-id'].properties.downloaded_course, course)
    }
})

test('RH16KR reports the errors its model defines', () => {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('dryer-id', META)
    new DUT(ha.asConnection(), thinq, META)

    const report = (code: number) => {
        const rec = Buffer.alloc(27)
        rec[1] = 0x19
        rec[8] = code
        thinq.emit('data', Buffer.concat([Buffer.from([0xaa, 0x21, 0x30, 0xeb]), rec, Buffer.from([0, 0xbb])]))
        return ha.devices['dryer-id'].properties
    }

    assert.equal(report(0).error, 'OFF')
    assert.equal(report(0).error_message, 'NO_ERROR')
    for (const [code, name] of [
        [1, 'ERROR_TE1'],
        [7, 'ERROR_CE1'],
        [15, 'ERROR_DOOR'],
        [17, 'ERROR_NOFILTER'],
        [21, 'ERROR_AE_DRYER'],
        [30, 'ERROR_LE1'],
        [42, 'ERROR_DE2'],
    ] as const) {
        const p = report(code)
        assert.equal(p.error_message, name)
        assert.equal(p.error, 'ON')
    }
})

test('RH16KR ignores a non-zero rec[22] when rec[8] reports no error', () => {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('dryer-id', META)
    new DUT(ha.asConnection(), thinq, META)

    const rec = Buffer.alloc(27)
    rec[1] = 0x19
    rec[2] = 2
    rec[22] = 15
    thinq.emit('data', Buffer.concat([Buffer.from([0xaa, 0x21, 0x30, 0xeb]), rec, Buffer.from([0, 0xbb])]))

    const p = ha.devices['dryer-id'].properties
    assert.equal(p.error, 'OFF')
    assert.equal(p.error_message, 'NO_ERROR')
})

test('RH16KR exposes the complete model process table', () => {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('dryer-id', META)
    new DUT(ha.asConnection(), thinq, META)

    const report = (state: number, phase: number, legacy = 0) => {
        const rec = Buffer.alloc(27)
        rec[1] = 0x19
        rec[2] = state
        rec[11] = phase
        rec[21] = legacy
        thinq.emit('data', Buffer.concat([Buffer.from([0xaa, 0x21, 0x30, 0xeb]), rec, Buffer.from([0, 0xbb])]))
        return ha.devices['dryer-id'].properties
    }

    // rec[11] carries the zero-based processState of the model diagnostic.
    for (const [phase, name] of [
        [0, 'DETECTING'],
        [1, 'STEAM'],
        [2, 'DRY_LV1'],
        [3, 'DRY_LV2'],
        [4, 'DRY_LV3'],
        [5, 'COOL'],
        [6, 'ANTI_CREASE'],
        [7, 'END'],
        [8, 'RAW_8'],
    ] as const)
        assert.equal(report(2, phase).process_status, name, `phase ${phase}`)

    // A contradicting rec[21] no longer decides the phase.
    assert.equal(report(2, 3, 6).process_status, 'DRY_LV2')
    assert.equal(report(2, 5, 1).process_status, 'COOL')

    // PAUSE and END show whatever phase rec[11] carries.
    assert.equal(report(3, 4).process_status, 'DRY_LV3')
    assert.equal(report(4, 7).process_status, 'END')
    assert.equal(report(4, 5).process_status, 'COOL')

    // POWEROFF and INITIAL show no phase, whatever rec[11] retains.
    assert.equal(report(0, 3).process_status, 'NONE')
    assert.equal(report(1, 5).process_status, 'NONE')
})

test('RH16KR reports run completed only in the END state', () => {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('dryer-id', META)
    new DUT(ha.asConnection(), thinq, META)

    const report = (state: number, phase: number, legacy: number) => {
        const rec = Buffer.alloc(27)
        rec[1] = 0x19
        rec[2] = state
        rec[11] = phase
        rec[21] = legacy
        thinq.emit('data', Buffer.concat([Buffer.from([0xaa, 0x21, 0x30, 0xeb]), rec, Buffer.from([0, 0xbb])]))
        return ha.devices['dryer-id'].properties
    }

    // END with a non-END phase is complete; RUNNING with the END phase and the old
    // rec[21] completion value is not, so rec[2] alone decides.
    assert.equal(report(4, 5, 0).run_completed, 'ON')
    assert.equal(report(2, 7, 8).run_completed, 'OFF')
    assert.equal(report(4, 7, 0).run_completed, 'ON')
    assert.equal(report(3, 7, 8).run_completed, 'OFF')
})

test('RH16KR publishes the cycle energy of every decoded record', () => {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('dryer-id', META)
    new DUT(ha.asConnection(), thinq, META)

    const component = ha.devices['dryer-id'].config?.components.cycle_energy as Record<string, unknown>
    assert.deepEqual(component, {
        platform: 'sensor',
        unique_id: '$deviceid-cycle_energy',
        state_topic: '$this/cycle_energy',
        name: 'Cycle energy',
        icon: 'mdi:lightning-bolt',
        device_class: 'energy',
        unit_of_measurement: 'Wh',
        state_class: 'total_increasing',
    })

    const report = (state: number, high: number, low: number) => {
        const rec = Buffer.alloc(27)
        rec[1] = 0x19
        rec[2] = state
        rec[19] = high
        rec[20] = low
        thinq.emit('data', Buffer.concat([Buffer.from([0xaa, 0x21, 0x30, 0xeb]), rec, Buffer.from([0, 0xbb])]))
        return ha.devices['dryer-id'].properties
    }

    // The first decoded record is a power-off record that still holds the last cycle's value.
    assert.equal(report(0, 0x05, 0xb1).cycle_energy, 1457)
    assert.equal(report(1, 0, 0).cycle_energy, 0)
    assert.equal(report(2, 0x05, 0xa8).cycle_energy, 1448)
})

test('RH16KR handles the model id the dryer reports after a fresh registration', () => {
    // Re-registering the appliance in the ThinQ app changed its model id from RH16KR to
    // RH16_N_KR, and rethink then had no handler for it. This packet is the one the
    // appliance sent afterwards: same 0x30/0xEC framing, same 27 byte record.
    const meta: Metadata = { modelId: 'RH16_N_KR', modelName: 'RH16_N_KR', swVersion: '2.9.66' }
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('dryer-id', meta)
    new DUT(ha.asConnection(), thinq, meta)
    thinq.emit(
        'data',
        buf(
            'AA3C30EC001901012800000200000200000000000088000000000000008300' +
                '001901012800000200000200000000000080000000000000008300CBBB',
        ),
    )

    assert.equal(ha.devices['dryer-id'].properties.power, 'ON')
})

test('RH16KR maps each labelled panel course and preserves unknown values', () => {
    const dial: Array<[number, string]> = [
        [2, 'TOWELS'],
        [4, 'BULKYITEM'],
        [5, 'EASYCARE'],
        [7, 'COTTONNORMAL'],
        [8, 'SPORTWEAR'],
        [9, 'QUICKDRY'],
        [11, 'WOOL'],
        [12, 'RACKDRY'],
        [13, 'COOLAIR'],
        [14, 'WARMAIR'],
        [15, 'BEDDING_BRUSH'],
        [16, 'ALLERGYCARE'],
        [18, 'CONDENSERCARE'],
        [19, 'SELFCLEANING'],
        [20, 'PADDINGREFRESH'],
        [21, 'TIMEDRY'],
        [22, 'WATERREPELLENT'],
    ]

    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('dryer-id', META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    for (const [raw, name] of dial) {
        const rec = Buffer.alloc(27)
        rec[1] = 0x19
        rec[7] = raw
        const inner = Buffer.concat([Buffer.from([0x30, 0xeb]), rec])
        const frame = Buffer.concat([Buffer.from([0xaa, inner.length + 4]), inner, Buffer.from([0x00, 0xbb])])
        thinq.emit('data', frame)
        assert.equal(ha.devices['dryer-id'].properties.course, name, `raw ${raw}`)
    }
    const unknown = Buffer.alloc(27)
    unknown[1] = 0x19
    unknown[7] = 17
    thinq.emit('data', Buffer.concat([Buffer.from([0xaa, 0x21, 0x30, 0xeb]), unknown, Buffer.from([0, 0xbb])]))
    assert.equal(ha.devices['dryer-id'].properties.course, 'RAW_17')
    dev.drop()
})

test('RH16KR decodes labelled dryer options and keeps unknown raw values visible', () => {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('dryer-id', META)
    new DUT(ha.asConnection(), thinq, META)

    const report = (dryLevel: number, ecoHybrid: number) => {
        const rec = Buffer.alloc(27)
        rec[1] = 0x19
        rec[9] = dryLevel
        rec[10] = ecoHybrid
        thinq.emit('data', Buffer.concat([Buffer.from([0xaa, 0x21, 0x30, 0xeb]), rec, Buffer.from([0, 0xbb])]))
        return ha.devices['dryer-id'].properties
    }

    for (const [raw, value] of [
        [0, 'NO'],
        [1, 'DAMP'],
        [2, 'LESS'],
        [3, 'IRON'],
        [4, 'CUPBOARD'],
        [5, 'VERY_DRY'],
    ] as const)
        assert.equal(report(raw, 0).dry_level, value, `dry level ${raw}`)

    for (const [raw, value] of [
        [0, 'NONE'],
        [1, 'ENERGY'],
        [2, 'NORMAL'],
        [3, 'SPEED'],
    ] as const)
        assert.equal(report(0, raw).eco_hybrid, value, `Eco Hybrid ${raw}`)

    const unknown = report(6, 4)
    assert.equal(unknown.dry_level, 'RAW_6')
    assert.equal(unknown.eco_hybrid, 'RAW_4')
})

test('RH16KR publishes raw time fields independently for labelled panel selections', () => {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('dryer-id', META)
    new DUT(ha.asConnection(), thinq, META)

    const report = (
        course: number,
        remainingHours: number,
        remainingMinutes: number,
        initialHours: number,
        initialMinutes: number,
    ) => {
        const rec = Buffer.alloc(27)
        rec[1] = 0x19
        rec[7] = course
        rec[3] = remainingHours
        rec[4] = remainingMinutes
        rec[5] = initialHours
        rec[6] = initialMinutes
        thinq.emit('data', Buffer.concat([Buffer.from([0xaa, 0x21, 0x30, 0xeb]), rec, Buffer.from([0, 0xbb])]))
        return ha.devices['dryer-id'].properties
    }

    // Synthetic selection-stage regressions lock the labelled raw fields; they do not
    // assert how total time behaves during live dryer operation.
    let p = report(7, 1, 20, 2, 0)
    assert.equal(p.remaining_time, 80)
    assert.equal(p.initial_time, 120)

    p = report(21, 0, 40, 0, 40)
    assert.equal(p.course, 'TIMEDRY')
    assert.equal(p.remaining_time, 40)
    assert.equal(p.initial_time, 40)

    p = report(13, 0, 50, 1, 0)
    assert.equal(p.course, 'COOLAIR')
    assert.equal(p.remaining_time, 50)
    assert.equal(p.initial_time, 60)

    p = report(14, 0, 30, 0, 20)
    assert.equal(p.course, 'WARMAIR')
    assert.equal(p.remaining_time, 30)
    assert.equal(p.initial_time, 20)
})

test('RH16KR preserves live COOLAIR and WARMAIR time transitions', () => {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('dryer-id', META)
    new DUT(ha.asConnection(), thinq, META)

    const report = (course: number, state: number, remaining: number, initial: number) => {
        const rec = Buffer.alloc(27)
        rec[1] = 0x19
        rec[2] = state
        rec[3] = Math.floor(remaining / 60)
        rec[4] = remaining % 60
        rec[5] = Math.floor(initial / 60)
        rec[6] = initial % 60
        rec[7] = course
        thinq.emit('data', Buffer.concat([Buffer.from([0xaa, 0x21, 0x30, 0xeb]), rec, Buffer.from([0, 0xbb])]))
        return ha.devices['dryer-id'].properties
    }

    // Owner-labelled live sequence: selection, start, countdown, then stop/pause.
    let p = report(13, 1, 60, 0)
    assert.equal(p.course, 'COOLAIR')
    assert.equal(p.status, 'INITIAL')
    assert.equal(p.remaining_time, 60)
    assert.equal(p.initial_time, 0)

    p = report(13, 2, 60, 60)
    assert.equal(p.status, 'RUNNING')
    assert.equal(p.remaining_time, 60)
    assert.equal(p.initial_time, 60)

    p = report(13, 2, 59, 60)
    assert.equal(p.remaining_time, 59)
    assert.equal(p.initial_time, 60)

    p = report(13, 3, 59, 60)
    assert.equal(p.status, 'PAUSE')
    assert.equal(p.remaining_time, 59)
    assert.equal(p.initial_time, 60)

    // WARMAIR inherited the displayed initial time at selection and counted down
    // through successive status samples without changing initial_time.
    p = report(14, 1, 60, 60)
    assert.equal(p.course, 'WARMAIR')
    assert.equal(p.status, 'INITIAL')
    assert.equal(p.remaining_time, 60)
    assert.equal(p.initial_time, 60)
    for (const remaining of [60, 59, 58, 57]) {
        p = report(14, 2, remaining, 60)
        assert.equal(p.status, 'RUNNING')
        assert.equal(p.remaining_time, remaining)
        assert.equal(p.initial_time, 60)
    }
})

test('RH16KR treats only the confirmed compound as a downloaded course and reports errors beside it', () => {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('dryer-id', META)
    new DUT(ha.asConnection(), thinq, META)

    const report = (course: number, current: number, stored: number, error = 0) => {
        const rec = Buffer.alloc(27)
        rec[1] = 0x19
        rec[7] = course
        rec[8] = error
        rec[22] = current
        rec[25] = stored
        thinq.emit('data', Buffer.concat([Buffer.from([0xaa, 0x21, 0x30, 0xeb]), rec, Buffer.from([0, 0xbb])]))
        return ha.devices['dryer-id'].properties
    }

    const downloaded = report(4, 113, 113)
    assert.equal(downloaded.course, 'DOWNLOADED')
    assert.equal(downloaded.downloaded_course, 'BIGSIZEITEM')
    assert.equal(downloaded.error, 'OFF')
    assert.equal(downloaded.error_message, 'NO_ERROR')

    const bedding = report(4, 0, 113)
    assert.equal(bedding.course, 'BULKYITEM')
    assert.equal(bedding.downloaded_course, 'BIGSIZEITEM')
    assert.equal(bedding.error, 'OFF')

    // Distinct non-zero slots are not the compound, with or without a fault.
    const unequal = report(4, 15, 113)
    assert.equal(unequal.course, 'BULKYITEM')
    assert.equal(unequal.error, 'OFF')

    const fault = report(4, 15, 113, 15)
    assert.equal(fault.course, 'BULKYITEM')
    assert.equal(fault.error, 'ON')
    assert.equal(fault.error_message, 'ERROR_DOOR')

    const downloadedFault = report(4, 113, 113, 15)
    assert.equal(downloadedFault.course, 'DOWNLOADED')
    assert.equal(downloadedFault.downloaded_course, 'BIGSIZEITEM')
    assert.equal(downloadedFault.error, 'ON')
    assert.equal(downloadedFault.error_message, 'ERROR_DOOR')
})

test('RH16KR decodes labelled option bits and validates active reservation time', () => {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('dryer-id', META)
    new DUT(ha.asConnection(), thinq, META)
    const components = ha.devices['dryer-id'].config?.components as Record<string, Record<string, unknown>>
    for (const component of Object.values(components)) assert.equal(component.command_topic, undefined)
    assert.equal(components.remote_control, undefined)
    assert.deepEqual(components.remote_start, {
        platform: 'binary_sensor',
        unique_id: '$deviceid-remote_start',
        state_topic: '$this/remote_start',
        name: 'Remote start',
        icon: 'mdi:remote',
    })
    const config = ha.devices['dryer-id'].config
    assert.ok(config)
    assert.equal(localizeDiscovery(config, 'korean').components.remote_start.name, '원격 시작')

    for (const name of ['smart_care', 'reservation_active', 'control_lock'] as const) {
        assert.equal(components[name].platform, 'binary_sensor')
    }

    const report = (flags16: number, flags17: number, hours: number, minutes: number) => {
        const rec = Buffer.alloc(27)
        rec[1] = 0x19
        rec[12] = hours
        rec[13] = minutes
        rec[16] = flags16
        rec[17] = flags17
        thinq.emit('data', Buffer.concat([Buffer.from([0xaa, 0x21, 0x30, 0xeb]), rec, Buffer.from([0, 0xbb])]))
        return ha.devices['dryer-id'].properties
    }

    let p = report(0x03, 0x20, 3, 0)
    assert.equal(p.anti_crease, 'ON')
    assert.equal(p.smart_care, 'ON')
    assert.equal(p.reservation_active, 'ON')
    assert.equal(p.reserve_time, 180)

    p = report(0, 0, 3, 0)
    assert.equal(p.anti_crease, 'OFF')
    assert.equal(p.smart_care, 'OFF')
    assert.equal(p.control_lock, 'OFF')
    assert.equal(p.reservation_active, 'OFF')
    assert.equal(p.reserve_time, 0)

    p = report(0, 0x10, 3, 0)
    assert.equal(p.smart_care, 'OFF')
    assert.equal(p.control_lock, 'OFF')

    p = report(0x08, 0, 3, 0)
    assert.equal(p.control_lock, 'OFF')

    p = report(0x18, 0, 3, 0)
    assert.equal(p.control_lock, 'ON')

    p = report(0x08, 0, 3, 0)
    assert.equal(p.control_lock, 'OFF')

    p = report(0, 0x01, 3, 0)
    assert.equal(p.remote_start, 'ON')
    assert.equal(p.smart_care, 'OFF')
    p = report(0, 0x20, 3, 0)
    assert.equal(p.remote_start, 'OFF')
    assert.equal(p.smart_care, 'ON')
    p = report(0, 0x21, 3, 0)
    assert.equal(p.remote_start, 'ON')
    p = report(0, 0, 3, 0)
    assert.equal(p.remote_start, 'OFF')

    assert.equal(report(0x01, 0, 2, 0).reserve_time, 0)
    assert.equal(report(0x01, 0, 20, 0).reserve_time, 0)
    assert.equal(report(0x01, 0, 3, 60).reserve_time, 0)
})

/** A status record carrying only the state rec[2] and the cycle energy rec[19..20]. */
function energyRecord(state: number, wh: number) {
    const rec = Buffer.alloc(27)
    rec[1] = 0x19
    rec[2] = state
    rec[19] = wh >> 8
    rec[20] = wh & 0xff
    return Buffer.concat([Buffer.from([0xaa, 0x21, 0x30, 0xeb]), rec, Buffer.from([0, 0xbb])])
}

const RUNNING = 2
const END = 4
const POWEROFF = 0

describe('RH16KR cumulative energy and cycles', () => {
    let dir: string
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'rethink-dryer-energy-'))
    })
    afterEach(() => {
        setEnergyDataDirectory(undefined as unknown as string)
        rmSync(dir, { recursive: true, force: true })
    })

    function dryer(ha = new MockHAConnection()) {
        const thinq = new MockThinq2Device('dryer-id', META)
        new DUT(ha.asConnection(), thinq, META)
        return { ha, thinq, p: () => ha.devices['dryer-id'].properties }
    }
    const filePath = () => join(dir, 'dryer-energy-dryer-id.json')
    const saved = () => JSON.parse(readFileSync(filePath(), 'utf-8'))
    /** The recorded 2026-11-22 shape: rising energy while running, END at 591, then off. */
    function recordedCycle(thinq: MockThinq2Device, endWh: number) {
        for (const wh of [0, 120, 300, endWh - 1]) thinq.emit('data', energyRecord(RUNNING, Math.max(wh, 0)))
        thinq.emit('data', energyRecord(END, endWh))
        thinq.emit('data', energyRecord(END, endWh))
        thinq.emit('data', energyRecord(POWEROFF, endWh))
    }

    test('exposes the total and the count with exact fields', () => {
        const { ha, p } = dryer()
        const components = ha.devices['dryer-id'].config?.components as Record<string, Record<string, unknown>>
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
        assert.deepEqual(components.total_cycles, {
            platform: 'sensor',
            unique_id: '$deviceid-total_cycles',
            state_topic: '$this/total_cycles',
            name: 'Total cycles',
            icon: 'mdi:counter',
            state_class: 'total_increasing',
            suggested_display_precision: 0,
        })
        assert.equal(p().energy_total, 0, 'the total is published with its discovery')
        assert.equal(p().total_cycles, 0, 'the count is published with its discovery')
        const config = ha.devices['dryer-id'].config
        assert.ok(config)
        assert.equal(localizeDiscovery(config, 'korean').components.total_cycles.name, '누적 사용 횟수')
    })

    test('adds each cycle once, where the state moves into END', () => {
        const { thinq, p } = dryer()
        recordedCycle(thinq, 591)
        assert.equal(p().energy_total, 591)
        assert.equal(p().total_cycles, 1)
        assert.equal(p().cycle_energy, 591, 'cycle_energy is still published on every record')

        recordedCycle(thinq, 400)
        assert.equal(p().energy_total, 991)
        assert.equal(p().total_cycles, 2)
    })

    test('a handler whose first record is END or POWEROFF adds nothing', () => {
        for (const state of [END, POWEROFF]) {
            const { thinq, p } = dryer()
            thinq.emit('data', energyRecord(state, 1457))
            thinq.emit('data', energyRecord(state, 1457))
            assert.equal(p().energy_total, 0, `state ${state}`)
            assert.equal(p().total_cycles, 0, `state ${state}`)
        }
    })

    test('a cycle switched off before END is not counted', () => {
        const { thinq, p } = dryer()
        for (const wh of [0, 120, 300]) thinq.emit('data', energyRecord(RUNNING, wh))
        thinq.emit('data', energyRecord(POWEROFF, 300))
        assert.equal(p().energy_total, 0)
        assert.equal(p().total_cycles, 0)
    })

    test('a cycle ending at 0 counts as a cycle and adds no energy', () => {
        const { thinq, p } = dryer()
        recordedCycle(thinq, 591)
        thinq.emit('data', energyRecord(RUNNING, 0))
        thinq.emit('data', energyRecord(END, 0))
        assert.equal(p().energy_total, 591)
        assert.equal(p().total_cycles, 2)
    })

    test('keeps both values across a restart, owner-readable only', () => {
        setEnergyDataDirectory(dir)
        const first = dryer()
        recordedCycle(first.thinq, 591)
        assert.deepEqual(saved(), { totalWh: 591, cycles: 1 })
        assert.equal(statSync(filePath()).mode & 0o777, 0o600)

        const second = dryer()
        assert.equal(second.p().energy_total, 591, 'the saved total is published at discovery')
        assert.equal(second.p().total_cycles, 1, 'the saved count is published at discovery')
        recordedCycle(second.thinq, 400)
        assert.equal(second.p().energy_total, 991)
        assert.equal(second.p().total_cycles, 2)
        assert.deepEqual(saved(), { totalWh: 991, cycles: 2 })
    })

    test('two handlers alive over one directory keep both cycles', () => {
        setEnergyDataDirectory(dir)
        const first = dryer()
        const second = dryer(new MockHAConnection())
        first.thinq.emit('data', energyRecord(RUNNING, 300))
        second.thinq.emit('data', energyRecord(RUNNING, 100))
        first.thinq.emit('data', energyRecord(END, 591))
        second.thinq.emit('data', energyRecord(END, 400))
        assert.deepEqual(saved(), { totalWh: 991, cycles: 2 })
        assert.equal(second.p().energy_total, 991)
        assert.equal(second.p().total_cycles, 2)
    })

    test('lives in memory when no directory has been named', () => {
        const { thinq, p } = dryer()
        recordedCycle(thinq, 591)
        assert.equal(p().energy_total, 591)
        assert.equal(p().total_cycles, 1)

        setEnergyDataDirectory(dir)
        const next = dryer()
        assert.equal(next.p().energy_total, 0, 'nothing was written')
        assert.equal(next.p().total_cycles, 0, 'nothing was written')
    })

    test('a damaged file or an impossible saved value reads as 0', () => {
        setEnergyDataDirectory(dir)
        for (const [content, totalWh, cycles] of [
            ['{ truncated', 0, 0],
            ['{"totalWh":-5,"cycles":-1}', 0, 0],
            ['{"totalWh":"many","cycles":"many"}', 0, 0],
            ['{"totalWh":"42","cycles":"3"}', 0, 0],
            ['{"totalWh":true,"cycles":true}', 0, 0],
            ['{"totalWh":[7],"cycles":[2]}', 0, 0],
            ['{"totalWh":591,"cycles":2.5}', 591, 0],
            ['{"totalWh":591,"cycles":-3}', 591, 0],
        ] as const) {
            writeFileSync(filePath(), content)
            const { p } = dryer()
            assert.equal(p().energy_total, totalWh, content)
            assert.equal(p().total_cycles, cycles, content)
        }
    })

    test('a failed save never makes a published value drop', () => {
        setEnergyDataDirectory(dir)
        // A directory where the file belongs makes both the reread and the save fail.
        mkdirSync(filePath())
        const ha = new MockHAConnection()
        const seen: Record<string, number[]> = {
            energy_total: [],
            total_cycles: [],
        }
        const publish = ha.publishProperty.bind(ha)
        ha.publishProperty = (id: string, prop: string, value: string | number) => {
            if (prop in seen) seen[prop].push(Number(value))
            publish(id, prop, value)
        }
        const { thinq, p } = dryer(ha)
        recordedCycle(thinq, 591)
        assert.equal(p().energy_total, 591)
        assert.equal(p().total_cycles, 1)

        rmdirSync(filePath())
        recordedCycle(thinq, 400)
        assert.equal(p().energy_total, 991)
        assert.equal(p().total_cycles, 2)
        assert.deepEqual(saved(), { totalWh: 991, cycles: 2 })
        for (const values of Object.values(seen))
            for (let i = 1; i < values.length; i++) assert.ok(values[i] >= values[i - 1], String(values))
    })
})
