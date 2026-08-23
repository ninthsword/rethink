import { test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/RH16KR'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

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
    assert.equal(p.process_status, 'DETECTING')
    assert.equal(p.run_completed, 'OFF')
    assert.equal(p.remaining_time, 0)
    assert.equal(p.dry_level, 'NO')
    assert.equal(p.eco_hybrid, 'NONE')
    assert.equal(p.anti_crease, 'OFF')
    assert.equal(p.downloaded_course, 'SELFCLEANING')
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
