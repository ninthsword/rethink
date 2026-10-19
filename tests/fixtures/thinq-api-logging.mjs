import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { inspect } from 'node:util'

let response = { resultCode: '0000', result: { ok: true } }
let networkFailure = false
let profileStatus = 1
const output = []
mock.module('node-fetch', {
    defaultExport: async () => {
        if (networkFailure) throw new Error('SENTINEL_URL and SENTINEL_RESPONSE')
        return { json: async () => response }
    },
})
mock.module('../../bridge/util.ts', {
    namedExports: {
        subprocess: async () => {
            throw new Error('synthetic stop')
        },
    },
})
mock.module('../../bridge/oauth2.ts', {
    namedExports: {
        refresh: async () => ({ accessToken: 'SENTINEL_TOKEN' }),
        signedRequest: async () => ({
            status: profileStatus,
            account: { userID: 'SENTINEL_ACCOUNT', userNo: 'SENTINEL_USER' },
        }),
    },
})
const original = console.log
console.log = (...args) => output.push(inspect(args))
try {
    const { apiFetch, Client, RemoteError, Thinq2Device } = await import('../../bridge/thinqApi.ts')
    assert.deepEqual(
        await apiFetch('https://fixture.invalid/SENTINEL_URL', {
            body: 'SENTINEL_BODY',
            headers: { Authorization: 'SENTINEL_TOKEN' },
        }),
        { ok: true },
    )
    response = { resultCode: '0100', result: { secret: 'SENTINEL_RESPONSE' } }
    await assert.rejects(apiFetch('https://fixture.invalid/SENTINEL_URL', { body: 'SENTINEL_BODY' }), (error) => {
        assert(error instanceof RemoteError)
        assert.equal(error.resultCode, '0100')
        assert.doesNotMatch(inspect(error, { showHidden: true }), /SENTINEL/)
        return true
    })
    response = { resultCode: '0000', result: { item: [] } }
    Client.gatewayCache.KR = Promise.resolve({
        thinq2Uri: 'https://fixture.invalid',
        uris: { empOauthBaseUri: 'https://fixture.invalid' },
    })
    await new Client({ countryCode: 'KR' }).auth('SENTINEL_REFRESH')
    profileStatus = 0
    await assert.rejects(new Client({ countryCode: 'KR' }).auth('SENTINEL_REFRESH'))
    // Stop before key generation; the OTP log occurs after the route/certificate calls.
    const device = new Thinq2Device('synthetic', { modelId: 'synthetic', modelName: 'synthetic' })
    // A mocked subprocess stops the flow before key generation; all API calls are mocked.
    await assert.rejects(
        device.pair({ countryCode: 'KR' }, { otp: 'SENTINEL_OTP', publicKey: 'synthetic' }),
        /synthetic stop/,
    )
    networkFailure = true
    await assert.rejects(apiFetch('https://fixture.invalid/SENTINEL_URL', {}), (error) => {
        assert.doesNotMatch(inspect(error, { showHidden: true }), /SENTINEL/)
        return true
    })
    assert.doesNotMatch(output.join('\n'), /SENTINEL/)
} finally {
    console.log = original
}
console.log('PASS sanitized API results and diagnostics')
