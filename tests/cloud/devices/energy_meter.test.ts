import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { EnergyMeter, setEnergyDataDirectory } from '@/cloud/devices/energy_meter'

let dir: string

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rethink-energy-'))
})
afterEach(() => {
    setEnergyDataDirectory(undefined as unknown as string)
    rmSync(dir, { recursive: true, force: true })
})

function meter(id = 'ac') {
    const published: number[] = []
    return { published, meter: new EnergyMeter(id, (wh) => published.push(wh)) }
}

describe('adding up what an appliance drew', () => {
    test('the first sample only starts the clock', () => {
        const { meter: m } = meter()
        m.integratePower(900, 0)
        assert.equal(m.state.totalWh, 0, 'nothing is known about the time before the first sample')
    })

    test('an hour at nine hundred watts is nine hundred watt-hours', () => {
        const { meter: m } = meter()
        m.integratePower(900, 0)
        // Half an hour at a time, because a single sample can only carry five minutes.
        for (let at = 60_000; at <= 3_600_000; at += 60_000) m.integratePower(900, at)
        assert.equal(Math.round(m.state.totalWh), 900)
    })

    /*
     * The appliance stops reporting altogether when it is switched off. Assuming it drew
     * the last figure for all that time would put a made-up hundred-odd watt-hours a day on
     * a total the energy dashboard reads as a meter.
     */
    test('a gap longer than five minutes counts as five minutes', () => {
        const { meter: m } = meter()
        m.integratePower(3600, 0)
        m.integratePower(3600, 60 * 60 * 1000)
        assert.equal(Math.round(m.state.totalWh), 300, 'five minutes at 3600 W, not an hour')
    })

    test('an appliance that is off contributes nothing and does not hand over its idle time', () => {
        const { meter: m } = meter()
        m.integratePower(900, 0)
        m.integratePower(50, 60_000, false)
        m.integratePower(900, 4 * 60 * 60 * 1000)
        assert.equal(m.state.totalWh, 0, 'the first sample after coming back only restarts the clock')
    })

    test('a negative or unreadable reading is ignored rather than subtracted', () => {
        const { meter: m } = meter()
        m.integratePower(900, 0)
        m.integratePower(-5, 60_000)
        m.integratePower(Number.NaN, 120_000)
        assert.equal(m.state.totalWh, 0)
    })
})

describe('an interval the appliance measured itself', () => {
    test('is believed, and takes over from the estimate permanently', () => {
        const { meter: m } = meter()
        m.addMeasuredInterval(120, 900, 0)
        assert.equal(m.state.totalWh, 120)

        // Estimation stops once a real report has arrived, so the two can never be summed.
        m.integratePower(900, 1000)
        m.integratePower(900, 61_000)
        assert.equal(m.state.totalWh, 120)
    })

    test('the same interval reported twice in two minutes is a retransmission', () => {
        const { meter: m } = meter()
        m.addMeasuredInterval(120, 900, 0)
        m.addMeasuredInterval(120, 900, 30_000)
        assert.equal(m.state.totalWh, 120)

        // The same figure long afterwards is a genuine second interval.
        m.addMeasuredInterval(120, 900, 5 * 60 * 1000)
        assert.equal(m.state.totalWh, 240)
    })
})

describe('the total across a restart', () => {
    test('is kept when a data directory has been named, and reloaded as a meter reading', () => {
        setEnergyDataDirectory(dir)
        const { meter: m } = meter()
        m.addMeasuredInterval(500, 900, 0)

        const reloaded = new EnergyMeter('ac', () => {})
        assert.equal(reloaded.state.totalWh, 500)
        assert.equal(reloaded.state.fromReports, true, 'which source is in use has to survive too')
    })

    test('lives only for the process when no directory has been named', () => {
        const { meter: m } = meter()
        m.addMeasuredInterval(500, 900, 0)

        setEnergyDataDirectory(dir)
        assert.equal(new EnergyMeter('ac', () => {}).state.totalWh, 0, 'nothing was written')
    })

    test('a damaged file starts from zero rather than throwing', () => {
        setEnergyDataDirectory(dir)
        writeFileSync(join(dir, 'air-conditioner-energy-ac.json'), '{ truncated')
        assert.equal(new EnergyMeter('ac', () => {}).state.totalWh, 0)
    })

    test('is written where only the owner can read it', () => {
        setEnergyDataDirectory(dir)
        const { meter: m } = meter()
        m.addMeasuredInterval(500, 900, 0)

        const saved = JSON.parse(readFileSync(join(dir, 'air-conditioner-energy-ac.json'), 'utf-8'))
        assert.equal(saved.totalWh, 500)
    })
})
