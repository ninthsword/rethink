import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { RouterConfigStore } from '@/router/config-store'

let dir: string
let file: string

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rethink-config-store-'))
    file = join(dir, 'router-dnat.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('what the router configuration will accept', () => {
    test('a device address has to be an IPv4 address', () => {
        const store = new RouterConfigStore(file)

        assert.throws(() => store.addDevice('not-an-address'), /Invalid device IPv4/)
        assert.throws(() => store.addDevice('192.168.1.256'), /Invalid device IPv4/)
        assert.throws(() => store.addDevice(''), /Invalid device IPv4/)
        // Every one of these would otherwise reach an iptables command line on the router.
        assert.throws(() => store.addDevice('192.168.1.5; reboot'), /Invalid device IPv4/)
        assert.throws(() => store.addDevice('$(id)'), /Invalid device IPv4/)
        assert.deepEqual(store.devices(), [])
    })

    test('the same address cannot be registered twice', () => {
        const store = new RouterConfigStore(file)
        store.addDevice('192.168.1.5')
        assert.throws(() => store.addDevice('192.168.1.5'), /already registered/)
    })

    /*
     * The addresses stored here are interpolated into a shell command that runs on the
     * router as root. Reaching them through the API is checked; reaching them through the
     * file was not, so a hand-edited or truncated file put the trust boundary in the wrong
     * place.
     */
    test('an address that is not an address is dropped when the file is read', () => {
        writeFileSync(
            file,
            JSON.stringify({
                router: { host: '192.168.1.1', port: 22, username: 'admin', password: 'x', rethinkIp: '192.168.1.2' },
                devices: [
                    { entryId: 'a', ip: '192.168.1.5' },
                    { entryId: 'b', ip: '192.168.1.6; reboot' },
                    { entryId: 'c', ip: 'nonsense' },
                    { entryId: 'd' },
                    'not an object',
                ],
            }),
        )

        const store = new RouterConfigStore(file)
        assert.deepEqual(
            store.devices().map((entry) => entry.ip),
            ['192.168.1.5'],
        )
    })

    test('a file that is not readable JSON leaves an empty configuration rather than throwing', () => {
        writeFileSync(file, '{ this is not json')
        const store = new RouterConfigStore(file)

        assert.deepEqual(store.devices(), [])
        assert.equal(store.configured(), false)
    })

    test('the router itself cannot be registered as one of its own devices', () => {
        const store = new RouterConfigStore(file)
        store.updateRouter({
            host: '192.168.1.1',
            port: 22,
            username: 'admin',
            password: 'x',
            rethinkIp: '192.168.1.2',
        })

        assert.throws(() => store.addDevice('192.168.1.1'), /cannot be registered/)
        assert.throws(() => store.addDevice('192.168.1.2'), /cannot be registered/)
    })
})
