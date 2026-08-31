import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { fromCode, refresh } from '@/bridge/oauth2'

async function withResponse<T>(body: unknown, run: (url: string) => Promise<T>): Promise<T> {
    const server = createServer((_request, response) => {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(body))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert(address && typeof address === 'object')

    try {
        return await run(`http://127.0.0.1:${address.port}`)
    } finally {
        await new Promise<void>((resolve, reject) =>
            server.close((error) => {
                if (error) reject(error)
                else resolve()
            }),
        )
    }
}

test('OAuth code exchange accepts positive numeric string and number expiries', async () => {
    for (const expires_in of ['3600', 3600]) {
        const before = Date.now()
        const token = await withResponse({ access_token: 'access', refresh_token: 'refresh', expires_in }, (url) =>
            fromCode(url, 'code'),
        )
        assert.equal(token.accessToken, 'access')
        assert.equal(token.refreshToken, 'refresh')
        assert(token.validUntil >= before + 3_600_000)
        assert(token.validUntil <= Date.now() + 3_600_000)
    }
})

test('OAuth code exchange rejects malformed responses without exposing tokens', async () => {
    const invalid: unknown[] = [
        null,
        [],
        {},
        { access_token: '', refresh_token: 'refresh-secret', expires_in: 3600 },
        { access_token: 'access-secret', refresh_token: '', expires_in: 3600 },
        { access_token: 123, refresh_token: 'refresh-secret', expires_in: 3600 },
        { access_token: 'access-secret', refresh_token: 456, expires_in: 3600 },
        { access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: '' },
        { access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 'not-a-number' },
        { access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 0 },
        { access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: -1 },
        { access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 'Infinity' },
        { access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: Number.MAX_VALUE },
    ]

    for (const response of invalid) {
        await assert.rejects(
            withResponse(response, (url) => fromCode(url, 'code')),
            (error: Error) => {
                assert.equal(error.message, 'OAuth2 sign-in failed: invalid response')
                assert.doesNotMatch(error.message, /access-secret|refresh-secret/)
                return true
            },
        )
    }
})

test('OAuth refresh accepts only a nonempty access token', async () => {
    const token = await withResponse({ access_token: 'access-response', refresh_token: 'ignored-response' }, (url) =>
        refresh(url, 'request-refresh'),
    )
    assert.deepEqual(token, { accessToken: 'access-response' })

    for (const response of [null, [], {}, { access_token: '' }, { access_token: 123 }]) {
        await assert.rejects(
            withResponse(response, (url) => refresh(url, 'request-refresh-secret')),
            (error: Error) => {
                assert.equal(error.message, 'OAuth2 refresh failed: invalid response')
                assert.doesNotMatch(error.message, /request-refresh-secret/)
                return true
            },
        )
    }
})
