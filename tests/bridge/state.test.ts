import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { JSONStorage } from '@/bridge/state'

const ID = 'dryer-id'
const REGISTRATION = { mqttServer: 'ssl://lg', certificate: 'first' } as never

function makeStore() {
    const dir = mkdtempSync(path.join(tmpdir(), 'rethink-bridge-'))
    return { store: new JSONStorage(dir), dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('bridge state durability', () => {
    test('what cannot be rebuilt is written atomically and kept to the owner', () => {
        const { store, dir, cleanup } = makeStore()
        store.setCredentials({ refreshToken: 'secret', env: { countryCode: 'KR' } })
        store.setDeviceState(ID, REGISTRATION)

        // These hold the account's refresh token and each appliance's certificate, neither
        // of which can be remade without the appliance. A half-written file costs a
        // registration rather than a retry, and they were world readable.
        for (const name of ['oauth2.json', `device_${ID}.json`]) {
            const file = path.join(dir, name)
            assert.equal(statSync(file).mode & 0o777, 0o600, name)
        }
        assert.equal(existsSync(path.join(dir, 'oauth2.json.tmp')), false, 'no temporary is left behind')
        cleanup()
    })
})

describe('bridge registration archive', () => {
    test('an archived registration comes back when the entry is re-added', () => {
        const { store, cleanup } = makeStore()
        store.setDeviceState(ID, REGISTRATION)

        // Deleting the router entry takes the registration with it, so nothing keeps
        // bridging with a certificate the setup no longer points at.
        assert.equal(store.archiveDeviceState(ID), true)
        assert.equal(store.getDeviceState(ID), undefined)

        assert.equal(store.restoreDeviceState(ID), true)
        assert.deepEqual(store.getDeviceState(ID), REGISTRATION)
        cleanup()
    })

    test('a registration made since the archive wins over it', () => {
        const { store, cleanup } = makeStore()
        store.setDeviceState(ID, REGISTRATION)
        store.archiveDeviceState(ID)

        // The appliance was deliberately registered afresh rather than restored by
        // accident, so the new certificate has to stand.
        const renewed = { mqttServer: 'ssl://lg', certificate: 'second' } as never
        store.setDeviceState(ID, renewed)
        assert.equal(store.restoreDeviceState(ID), false)
        assert.deepEqual(store.getDeviceState(ID), renewed)
        cleanup()
    })

    test('archiving a device with no registration does nothing', () => {
        const { store, dir, cleanup } = makeStore()
        assert.equal(store.archiveDeviceState(ID), false)
        assert.equal(store.restoreDeviceState(ID), false)
        assert.equal(existsSync(path.join(dir, `device_${ID}.archived.json`)), false)
        cleanup()
    })

    test('an archive is visible before it is restored', () => {
        const { store, cleanup } = makeStore()
        assert.equal(store.hasArchivedDeviceState(ID), false)
        store.setDeviceState(ID, REGISTRATION)
        store.archiveDeviceState(ID)

        // The management page shows the choice from this, rather than restoring on its own.
        assert.equal(store.hasArchivedDeviceState(ID), true)
        cleanup()
    })

    test('the newest archive replaces the previous one', () => {
        const { store, cleanup } = makeStore()
        store.setDeviceState(ID, REGISTRATION)
        store.archiveDeviceState(ID)

        const later = { mqttServer: 'ssl://lg', certificate: 'later' } as never
        store.setDeviceState(ID, later)
        store.archiveDeviceState(ID)
        store.restoreDeviceState(ID)
        assert.deepEqual(store.getDeviceState(ID), later)
        cleanup()
    })
})

describe('deleting a router entry keeps the registration recoverable', () => {
    test('archiving then clearing the state leaves the archive intact', () => {
        const { store, cleanup } = makeStore()
        store.setDeviceState(ID, REGISTRATION)

        // This is the order the delete handler runs in. It used to be the other way round:
        // the bridge cleared the state first, so the archive was made from a file that was
        // already gone and the registration went for good — the one outcome the archive
        // exists to prevent.
        assert.equal(store.archiveDeviceState(ID), true)
        store.setDeviceState(ID, undefined)

        assert.equal(store.hasArchivedDeviceState(ID), true)
        assert.equal(store.restoreDeviceState(ID), true)
        assert.deepEqual(store.getDeviceState(ID), REGISTRATION)
        cleanup()
    })

    test('clearing state that is already gone is not an error', () => {
        const { store, cleanup } = makeStore()
        // Archiving removes the live file, and the bridge then clears it again.
        store.setDeviceState(ID, REGISTRATION)
        store.archiveDeviceState(ID)
        store.setDeviceState(ID, undefined)
        store.setDeviceState(ID, undefined)
        store.setCredentials(undefined)
        cleanup()
    })
})
