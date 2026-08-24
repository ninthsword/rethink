import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { managementHost, normalize, type RawConfig } from '@/util/config'

/** The least a configuration can say and still describe a working rethink. */
function minimal(): RawConfig {
    return {
        hostname: 'rethink.lan',
        ca_key_file: 'ca.key',
        ca_cert_file: 'ca.cert',
        https_port: 4433,
        mqtts_port: 8883,
        mqtt_port: 1884,
        homeassistant: {
            mqtt_url: 'mqtt://127.0.0.1:1883',
            discovery_prefix: 'homeassistant',
            rethink_prefix: 'rethink',
            mqtt_user: 'user',
            mqtt_pass: 'pass',
        },
    } as RawConfig
}

describe('reading config.json', () => {
    test('a complete configuration comes through with its defaults filled in', () => {
        const config = normalize(minimal())

        assert.equal(config.hostname, 'rethink.lan')
        assert.deepEqual(config.https_port, { bind: 4433, advertise: 4433 })
        assert.deepEqual(config.thinq1_https_port, { bind: 46030, advertise: 46030 })
        assert.equal(config.homeassistant.language, 'english')
        assert.equal(config.homeassistant.offline_grace_seconds, 1800)
        assert.deepEqual(config.passthrough_hostnames, [])
        assert.deepEqual(config.stall_hostnames, [])
    })

    test('a port given as bind and advertise separately is kept as written', () => {
        const config = normalize({ ...minimal(), https_port: { bind: 4433, advertise: 443 } } as RawConfig)
        assert.deepEqual(config.https_port, { bind: 4433, advertise: 443 })
    })

    /*
     * Every one of these is dereferenced during startup. Missing, they used to surface as
     * "Cannot read properties of undefined (reading 'bind')" from a line that says nothing
     * about which setting was left out.
     */
    for (const missing of ['hostname', 'ca_key_file', 'ca_cert_file', 'https_port', 'mqtts_port', 'mqtt_port']) {
        test(`says which setting is missing when ${missing} is left out`, () => {
            const raw = minimal() as unknown as Record<string, unknown>
            delete raw[missing]

            assert.throws(
                () => normalize(raw as RawConfig),
                (err: Error) => err.message.includes(missing),
                `the error should name ${missing}`,
            )
        })
    }

    test('says which Home Assistant setting is missing', () => {
        const raw = minimal()
        delete (raw.homeassistant as unknown as Record<string, unknown>).mqtt_url

        assert.throws(
            () => normalize(raw),
            (err: Error) => err.message.includes('homeassistant.mqtt_url'),
        )
    })

    test('the management API binds to loopback unless the owner opens it', () => {
        // It has no authentication, so reaching it must take either being on this host or a
        // deliberate edit. Defaulting to every interface would publish it to the whole LAN.
        assert.equal(normalize(minimal()).management_host, '127.0.0.1')
    })

    test('a management host written in the configuration is kept as given', () => {
        const config = normalize({ ...minimal(), management_host: '0.0.0.0' } as RawConfig)
        assert.equal(config.management_host, '0.0.0.0')
    })

    test('RETHINK_MGMT_HOST opens the management interface without editing the file', () => {
        // The deployed configuration lives in the data directory, not in this repository, so
        // opening the interface used to mean editing a file the operator does not otherwise
        // touch. The variable makes it an argument to scripts/deploy.sh instead.
        const config = normalize(minimal())
        assert.equal(managementHost(config, { RETHINK_MGMT_HOST: '0.0.0.0' }), '0.0.0.0')
    })

    test('without the variable the configured host wins', () => {
        const config = normalize({ ...minimal(), management_host: '10.0.0.5' } as RawConfig)
        assert.equal(managementHost(config, {}), '10.0.0.5')
        assert.equal(managementHost(normalize(minimal()), {}), '127.0.0.1')
    })

    test('an empty variable is treated as unset rather than as every interface', () => {
        // Docker passes `-e RETHINK_MGMT_HOST` through as an empty string when the variable is
        // unset on the host, and Node would hand that straight to listen(), which reads it as
        // 0.0.0.0 -- the one value this setting exists to avoid choosing by accident.
        assert.equal(managementHost(normalize(minimal()), { RETHINK_MGMT_HOST: '' }), '127.0.0.1')
    })

    test('the optional settings stay optional', () => {
        const config = normalize(minimal())
        assert.equal(config.management_port, undefined)
        assert.equal(config.bridge, undefined)
        assert.equal(config.route_servers, undefined)
    })
})
