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

test('RH16KR names every course its dial reaches', () => {
    // Read off the appliance by turning the dial one position at a time: fourteen
    // positions that close back on 표준. The order bears no relation to the model
    // schema's, which is why the table could not be derived from a single reading.
    const dial: Array<[number, string]> = [
        [5, 'COTTONNORMAL'],
        [11, 'ALLERGYCARE'],
        [8, 'QUICKDRY'],
        [17, 'TOWELS'],
        [14, 'EASYCARE'],
        [13, 'WOOL'],
        [20, 'SPORTWEAR'],
        [22, 'DOWNLOADED'],
        [15, 'WARMAIR'],
        [4, 'COOLAIR'],
        [7, 'PADDINGREFRESH'],
        [16, 'WATERREPELLENT'],
        [9, 'BEDDING_BRUSH'],
        [2, 'BULKYITEM'],
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
    dev.drop()
})
