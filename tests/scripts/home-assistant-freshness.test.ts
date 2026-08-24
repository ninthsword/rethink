import assert from 'node:assert/strict'
import { test } from 'node:test'
import { POLLED_PROTOCOL_STALE_MINUTES, stalePublicationReason } from '@/scripts/home-assistant-freshness'

test('a polled protocol is stale when three refresh periods produce no publication', () => {
    assert.equal(
        stalePublicationReason({
            periodicRefreshSeen: true,
            quietForMinutes: POLLED_PROTOCOL_STALE_MINUTES,
        }),
        `nothing published for ${POLLED_PROTOCOL_STALE_MINUTES} minutes despite periodic refresh queries`,
    )
})

test('a recently published polled protocol is current', () => {
    assert.equal(
        stalePublicationReason({
            periodicRefreshSeen: true,
            quietForMinutes: POLLED_PROTOCOL_STALE_MINUTES - 1,
        }),
        undefined,
    )
})

test('publication silence is not stale evidence for a push-only protocol', () => {
    assert.equal(stalePublicationReason({ periodicRefreshSeen: false, quietForMinutes: 24 * 60 }), undefined)
})
