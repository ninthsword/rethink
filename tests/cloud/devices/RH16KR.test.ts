import assert from 'node:assert/strict'
import { test } from 'node:test'
import DUT from '@/cloud/devices/RH16KR'
import type { Metadata } from '@/cloud/thinq'
import { buf, MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'

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
    assert.equal(p.downloaded_course, 'SELFCLEANING')
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
        rec[22] = code
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

test('RH16KR exposes the complete model process table', () => {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('dryer-id', META)
    new DUT(ha.asConnection(), thinq, META)

    // Build a 27-byte record with one-based AABB processState=COOL (6).
    const rec = Buffer.alloc(27)
    rec[1] = 0x19
    rec[2] = 2
    rec[21] = 6
    const packet = Buffer.concat([Buffer.from([0xaa, 0x21, 0x30, 0xeb]), rec, Buffer.from([0, 0xbb])])
    thinq.emit('data', packet)

    assert.equal(ha.devices['dryer-id'].properties.process_status, 'COOL')
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
        [19, 'SELFCLEANING'],
        [20, 'PADDINGREFRESH'],
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

test('RH16KR treats only the confirmed compound as a downloaded course and false error', () => {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('dryer-id', META)
    new DUT(ha.asConnection(), thinq, META)

    const report = (course: number, current: number, stored: number) => {
        const rec = Buffer.alloc(27)
        rec[1] = 0x19
        rec[7] = course
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

    const fault = report(4, 15, 113)
    assert.equal(fault.course, 'BULKYITEM')
    assert.equal(fault.error, 'ON')
    assert.equal(fault.error_message, 'ERROR_DOOR')
})

test('RH16KR decodes labelled option bits and validates active reservation time', () => {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('dryer-id', META)
    new DUT(ha.asConnection(), thinq, META)
    const components = ha.devices['dryer-id'].config?.components as Record<string, Record<string, unknown>>
    for (const name of ['smart_care', 'reservation_active'] as const) {
        assert.equal(components[name].platform, 'binary_sensor')
        assert.equal(components[name].command_topic, undefined)
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
    assert.equal(p.reservation_active, 'OFF')
    assert.equal(p.reserve_time, 0)

    assert.equal(report(0x01, 0, 2, 0).reserve_time, 0)
    assert.equal(report(0x01, 0, 20, 0).reserve_time, 0)
    assert.equal(report(0x01, 0, 3, 60).reserve_time, 0)
})
