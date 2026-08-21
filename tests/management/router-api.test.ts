import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { RouterAPI } from '@/management/router-api'

/**
 * The wrapper the management routes are built from. It is reached through the class
 * because the failure it handles is the one the owner actually sees on screen.
 */
function wrapped(handler: () => Promise<void>) {
    const api = Object.create(RouterAPI.prototype) as RouterAPI
    const wrap = (api as unknown as { wrap(h: unknown): (req: unknown, res: unknown, next: unknown) => void }).wrap
    const sent = { status: 0, type: '', body: '' }
    const res = {
        headersSent: false,
        status(code: number) {
            sent.status = code
            return res
        },
        type(value: string) {
            sent.type = value
            return res
        },
        end(body: string) {
            sent.body = body
        },
    }
    const req = { method: 'POST', originalUrl: '/api/router/devices/x/bridge/resume' }
    let passedOn = false
    wrap.call(api, async () => handler())(req, res, () => {
        passedOn = true
    })
    return { sent, passedOn: () => passedOn }
}

describe('management errors reach the page as words', () => {
    test('a failure is answered in plain text, not an HTML error page', async () => {
        // Express's own handler renders HTML with a stack trace, and the page shows whatever
        // comes back — so a failed Bridge switch put a block of markup on screen instead of
        // the reason.
        const { sent, passedOn } = wrapped(async () => {
            throw new Error('The appliance has not connected to rethink')
        })
        await new Promise((resolve) => setImmediate(resolve))

        assert.equal(sent.status, 400)
        assert.equal(sent.type, 'text/plain')
        assert.equal(sent.body, 'The appliance has not connected to rethink')
        assert.equal(passedOn(), false, 'nothing is left for Express to render')
    })

    test('something thrown without a message still says something', async () => {
        const { sent } = wrapped(async () => {
            throw new Error('')
        })
        await new Promise((resolve) => setImmediate(resolve))

        assert.equal(sent.body, 'Unexpected error')
    })
})
