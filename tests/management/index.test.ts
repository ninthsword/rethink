import assert from 'node:assert/strict'
import { test } from 'node:test'
import { serializeDeviceEntries } from '@/management/index'

test('management device serialization preserves arbitrary identifiers as own keys', () => {
    const prototypeNamed = { model: 'prototype' }
    const stringNamed = { model: 'string' }
    const ordinary = { model: 'ordinary' }
    const serialized = serializeDeviceEntries([
        ['__proto__', prototypeNamed],
        ['toString', stringNamed],
        ['ordinary-id', ordinary],
    ])

    assert.deepEqual(Object.keys(serialized), ['__proto__', 'toString', 'ordinary-id'])
    assert.equal(Object.getOwnPropertyDescriptor(serialized, '__proto__')?.value, prototypeNamed)
    assert.equal(serialized.toString, stringNamed)
    assert.equal(serialized['ordinary-id'], ordinary)
})
