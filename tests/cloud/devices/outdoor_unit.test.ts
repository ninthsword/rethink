import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { OutdoorUnit, outdoorUnitFor, resetOutdoorUnits } from '@/cloud/devices/outdoor_unit'
import type { HAConfig } from '@/util/config'

const LIVING = 'living-id'
const BEDROOM = 'bedroom-id'
const CONFIG = {
    outdoor_units: [{ name: '2 in 1', devices: [LIVING, BEDROOM] }],
} as unknown as HAConfig

function makeUnit() {
    const published: Array<[string, number]> = []
    const unit = new OutdoorUnit(LIVING, [LIVING, BEDROOM], '2 in 1')
    unit.attachPrimary((property, value) => published.push([property, value]))
    const latest = (property: string) => [...published].reverse().find(([p]) => p === property)?.[1]
    return { unit, published, latest }
}

beforeEach(() => resetOutdoorUnits())

describe('shared outdoor unit', () => {
    test('two heads reporting the same compressor are counted once', () => {
        // With both running they read within a few watts of each other, because both are
        // reporting the outdoor unit rather than their own share.
        const { unit, latest } = makeUnit()
        unit.report(LIVING, 725, true)
        unit.report(BEDROOM, 750, true)

        assert.equal(latest('outdoor_power'), 750, 'the highest reading, not the sum')
    })

    test('a head that is off does not drag the outdoor unit down', () => {
        // Measured: with only the bedroom on, the living room reported three watts while the
        // outdoor unit drew eight hundred. Taking either head alone loses the other's work.
        const { unit, latest } = makeUnit()
        unit.report(LIVING, 3, false)
        unit.report(BEDROOM, 881, true)

        assert.equal(latest('outdoor_power'), 881)
    })

    test('every head off means the outdoor unit is off', () => {
        const { unit, latest } = makeUnit()
        unit.report(LIVING, 725, true)
        unit.report(BEDROOM, 750, true)
        unit.report(LIVING, 3, false)
        unit.report(BEDROOM, 5, false)

        assert.equal(latest('outdoor_power'), 0)
    })

    test('both heads find the same group, and only the first carries its sensors', () => {
        const living = outdoorUnitFor(CONFIG, LIVING)
        const bedroom = outdoorUnitFor(CONFIG, BEDROOM)

        assert.ok(living)
        assert.equal(living, bedroom, 'one group, not one per appliance')
        assert.equal(living!.isPrimary(LIVING), true)
        assert.equal(living!.isPrimary(BEDROOM), false)
    })

    test('an appliance with an outdoor unit to itself is left alone', () => {
        // The window unit in the small room has its own, so it keeps its own total.
        assert.equal(outdoorUnitFor(CONFIG, 'window-unit-id'), undefined)
        assert.equal(outdoorUnitFor({} as HAConfig, LIVING), undefined)
    })

    test('the group works before its primary appliance has connected', () => {
        // The bedroom can reach rethink first; nothing may be lost while it does.
        const unit = new OutdoorUnit(LIVING, [LIVING, BEDROOM], '2 in 1')
        unit.report(BEDROOM, 881, true)

        const published: Array<[string, number]> = []
        unit.attachPrimary((property, value) => published.push([property, value]))
        unit.report(BEDROOM, 881, true)

        assert.equal(published.find(([p]) => p === 'outdoor_power')?.[1], 881)
    })
})
