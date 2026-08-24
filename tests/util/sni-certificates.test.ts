import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { SNICertificateProvider } from '@/util/sni-certificates'

/** A throwaway CA, made the way rethink's own is. */
function makeCA() {
    const dir = mkdtempSync(join(tmpdir(), 'rethink-ca-test-'))
    try {
        const key = join(dir, 'ca.key')
        const cert = join(dir, 'ca.cert')
        execFileSync('openssl', ['genrsa', '-out', key, '2048'])
        execFileSync('openssl', [
            'req',
            '-new',
            '-x509',
            '-key',
            key,
            '-out',
            cert,
            '-days',
            '30',
            '-subj',
            '/CN=rethink.test',
        ])
        return { key: readFileSync(key, 'utf-8'), cert: readFileSync(cert, 'utf-8') }
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
}

const certificatesIn = (pem: string) => pem.match(/-----BEGIN CERTIFICATE-----/g)?.length ?? 0

describe('the certificate offered for a hostname', () => {
    test('goes out with the certificate that signed it', () => {
        // On its own, an appliance that cannot find the issuer answers "unknown ca" and
        // retries about once a second indefinitely, never getting far enough to
        // re-establish anything else. The MQTT listener never had the problem: it presents
        // the CA certificate itself, which is the one the appliance was given.
        const ca = makeCA()
        const issued = new SNICertificateProvider(ca).issue('kic-mclip.lgthinq.com')

        assert.equal(certificatesIn(issued.chain), 2, 'leaf and issuer')
        assert.ok(issued.chain.includes(ca.cert.trimEnd()), 'and the issuer is the CA')

        const leaf = new X509Certificate(issued.chain)
        assert.equal(leaf.subject, 'CN=kic-mclip.lgthinq.com')
        assert.equal(leaf.checkHost('kic-mclip.lgthinq.com'), 'kic-mclip.lgthinq.com')
        assert.ok(leaf.verify(new X509Certificate(ca.cert).publicKey), 'signed by the CA')
    })

    test('the same hostname is only ever issued once', () => {
        const provider = new SNICertificateProvider(makeCA())
        assert.equal(provider.forServerName('common.lgthinq.com'), provider.forServerName('COMMON.lgthinq.com.'))
        assert.equal(provider.cache.size, 1, 'case and a trailing dot name the same host')
    })

    test('a name that is not a hostname is refused rather than signed', () => {
        const provider = new SNICertificateProvider(makeCA())
        assert.throws(() => provider.forServerName('not a hostname'))
        assert.throws(() => provider.forServerName('../../etc/passwd'))
    })
})
