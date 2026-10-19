import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { test } from 'node:test'
import ssh2 from 'ssh2'
import { RouterSSHClient } from '@/router/ssh-client'

const { Client, Server, utils } = ssh2

test('SSH authenticates only after matching the independently trusted raw host key', async (t) => {
    const { privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    const key = Buffer.from(privateKey)
    const fingerprint = `SHA256:${createHash('sha256').update(utils.parseKey(key).getPublicSSH()).digest('base64').replace(/=+$/, '')}`
    let authenticationAttempts = 0,
        connections = 0
    const peers = new Set<{ end(): void }>()
    const server = new Server({ hostKeys: [key] }, (client) => {
        connections++
        peers.add(client)
        client.on('error', () => {})
        client.on('close', () => peers.delete(client))
        client.on(
            'authentication',
            (context: { method: string; username: string; password: string; accept(): void; reject(): void }) => {
                authenticationAttempts++
                if (
                    context.method === 'password' &&
                    context.username === 'synthetic' &&
                    context.password === 'synthetic'
                )
                    context.accept()
                else context.reject()
            },
        )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert(address && typeof address === 'object')
    const config = {
        host: '127.0.0.1',
        port: address.port,
        username: 'synthetic',
        password: 'synthetic',
        rethinkIp: '192.0.2.2',
    }
    const calls = t.mock.method(Client.prototype, 'connect')
    const clients: RouterSSHClient[] = []
    try {
        const missing = new RouterSSHClient(config)
        clients.push(missing)
        await assert.rejects(missing.connect(), /호스트 키 지문/)
        assert.equal(calls.mock.callCount(), 0)
        assert.equal(connections, 0)
        const mismatch = new RouterSSHClient({
            ...config,
            hostKeyFingerprint: `SHA256:${Buffer.alloc(32, 1).toString('base64').replace(/=+$/, '')}`,
        })
        clients.push(mismatch)
        await assert.rejects(mismatch.connect())
        assert.equal(authenticationAttempts, 0, 'a changed server identity must receive no credentials')
        const matching = new RouterSSHClient({ ...config, hostKeyFingerprint: fingerprint })
        clients.push(matching)
        await matching.connect()
        assert(authenticationAttempts > 0)
    } finally {
        clients.forEach((client) => {
            client.close()
        })
        peers.forEach((client) => {
            client.end()
        })
        await new Promise<void>((resolve) => server.close(() => resolve()))
    }
})
