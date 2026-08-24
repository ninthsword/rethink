import assert from 'node:assert/strict'
import { test } from 'node:test'
import Bridge from '@/cloud/ha_bridge'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'
import { setFilter } from '@/util/logging'

function captureLog(run: () => void) {
    const lines: string[] = []
    const original = console.log
    setFilter(() => true)
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '))
    try {
        run()
    } finally {
        console.log = original
        setFilter(() => false)
    }
    return lines
}

test('an appliance with no handler says so instead of vanishing quietly', () => {
    // The dryer hit this after being re-registered under a model id nothing here knew: it
    // connected and bridged normally but produced no entities, which reads as a
    // connection fault unless something says otherwise.
    const meta: Metadata = { modelId: 'NOT_A_REAL_MODEL', modelName: 'NOT_A_REAL_MODEL', swVersion: '1.0' }
    const lines = captureLog(() => {
        const ha = new MockHAConnection()
        const bridge = new Bridge(ha.asConnection(), 20)
        bridge.newDevice(new MockThinq2Device('mystery-id', meta))
    })

    const complaint = lines.find((line) => line.includes('NOT_A_REAL_MODEL'))
    assert.ok(complaint, 'the missing handler must be reported')
    assert.match(complaint, /no Home Assistant entities/, 'and it must say what the consequence is')
    assert.match(complaint, /mystery-id/, 'and which appliance it was')
})
