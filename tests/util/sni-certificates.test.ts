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
    test('goes out with the certificate that signed it', async () => {
        // On its own, an appliance that cannot find the issuer answers "unknown ca" and
        // retries about once a second indefinitely, never getting far enough to
        // re-establish anything else. The MQTT listener never had the problem: it presents
        // the CA certificate itself, which is the one the appliance was given.
        const ca = makeCA()
        const issued = await new SNICertificateProvider(ca).issue('kic-mclip.lgthinq.com')

        assert.equal(certificatesIn(issued.chain), 2, 'leaf and issuer')
        assert.ok(issued.chain.includes(ca.cert.trimEnd()), 'and the issuer is the CA')

        const leaf = new X509Certificate(issued.chain)
        assert.equal(leaf.subject, 'CN=kic-mclip.lgthinq.com')
        assert.equal(leaf.checkHost('kic-mclip.lgthinq.com'), 'kic-mclip.lgthinq.com')
        assert.ok(leaf.verify(new X509Certificate(ca.cert).publicKey), 'signed by the CA')
    })

    test('the same hostname is only ever issued once', async () => {
        const provider = new SNICertificateProvider(makeCA())
        const first = provider.issue('common.lgthinq.com')
        assert.equal(first, provider.issue('COMMON.lgthinq.com.'))
        assert.equal(await provider.forServerName('common.lgthinq.com'), (await first).context)
        assert.equal(provider.cache.size, 1, 'case and a trailing dot name the same host')
    })

    test('a name that is not a hostname is refused rather than signed', () => {
        const provider = new SNICertificateProvider(makeCA())
        assert.throws(() => provider.issue('not a hostname'))
        assert.throws(() => provider.issue('../../etc/passwd'))
    })
})

test('unsafe SNI names fail before certificate generation or CA material access', () => {
    const ca = {
        get key(): string {
            throw new Error('CA key must not be read')
        },
        get cert(): string {
            throw new Error('CA certificate must not be read')
        },
    }
    const provider = new SNICertificateProvider(ca)
    for (const name of [
        'a/CN=other',
        'a\\b',
        'a+OU=other',
        'a\u0000b',
        'a\nb',
        'a..b',
        '-a',
        'a-',
        'a'.repeat(64),
        `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`,
        null,
        42,
        {},
    ]) {
        assert.throws(() => provider.issue(name as string), /Invalid TLS SNI hostname/)
    }
    assert.equal(provider.cache.size, 0)
})

test('issuance bounds concurrent work and queue, coalesces names, and cancels without leftover files', async () => {
    const { chmodSync, readdirSync, writeFileSync } = await import('node:fs')
    const dir = mkdtempSync(join(tmpdir(), 'rethink-openssl-bounds-'))
    const executable = join(dir, 'openssl')
    writeFileSync(executable, `#!${process.execPath}\nsetInterval(() => {}, 1000)\n`)
    chmodSync(executable, 0o700)
    const oldPath = process.env.PATH,
        oldTmp = process.env.TMPDIR
    process.env.PATH = `${dir}:${oldPath}`
    process.env.TMPDIR = dir
    const provider = new SNICertificateProvider(makeCAForQueue())
    function makeCAForQueue() {
        return { key: 'synthetic', cert: 'synthetic' }
    }
    const results: Promise<unknown>[] = []
    try {
        const first = provider.issue('host0.test')
        assert.equal(provider.issue('HOST0.test.'), first)
        results.push(first.catch((error) => error))
        for (let index = 1; index < 18; index++)
            results.push(provider.issue(`host${index}.test`).catch((error) => error))
        await assert.rejects(provider.issue('overflow.test'), /대기 한도/)
        assert.equal(readdirSync(dir).filter((name) => name.startsWith('rethink-sni-')).length, 2)
        let responsive = false
        await new Promise<void>((resolve) =>
            setImmediate(() => {
                responsive = true
                resolve()
            }),
        )
        assert(responsive)
        await provider.close()
        assert((await Promise.all(results)).every((result) => result instanceof Error))
        assert.deepEqual(readdirSync(dir), ['openssl'])
        await assert.rejects(provider.issue('after.test'), /종료/)
    } finally {
        await provider.close()
        process.env.PATH = oldPath
        if (oldTmp === undefined) delete process.env.TMPDIR
        else process.env.TMPDIR = oldTmp
        rmSync(dir, { recursive: true, force: true })
    }
})

test('failed and overflowing OpenSSL output cleans up and permits reissuance', async () => {
    const { chmodSync, readdirSync, writeFileSync } = await import('node:fs')
    const dir = mkdtempSync(join(tmpdir(), 'rethink-openssl-output-'))
    const executable = join(dir, 'openssl')
    writeFileSync(
        executable,
        `#!${process.execPath}\nprocess.stdout.write('x'.repeat(131072)); setInterval(() => {}, 1000)\n`,
    )
    chmodSync(executable, 0o700)
    const oldPath = process.env.PATH,
        oldTmp = process.env.TMPDIR
    process.env.PATH = `${dir}:${oldPath}`
    process.env.TMPDIR = dir
    const provider = new SNICertificateProvider({ key: 'synthetic', cert: 'synthetic' })
    try {
        await assert.rejects(provider.issue('output.test'))
        assert.deepEqual(readdirSync(dir), ['openssl'])
        writeFileSync(executable, `#!${process.execPath}\nprocess.exit(1)\n`)
        await assert.rejects(provider.issue('output.test'))
        assert.deepEqual(readdirSync(dir), ['openssl'])
    } finally {
        await provider.close()
        process.env.PATH = oldPath
        if (oldTmp === undefined) delete process.env.TMPDIR
        else process.env.TMPDIR = oldTmp
        rmSync(dir, { recursive: true, force: true })
    }
})

test('the total issuance deadline expires queued and active jobs and restores admission', async (t) => {
    const { chmodSync, readdirSync, writeFileSync } = await import('node:fs')
    const dir = mkdtempSync(join(tmpdir(), 'rethink-openssl-deadline-'))
    const executable = join(dir, 'openssl')
    writeFileSync(executable, `#!${process.execPath}\nsetInterval(() => {}, 1000)\n`)
    chmodSync(executable, 0o700)
    const oldPath = process.env.PATH,
        oldTmp = process.env.TMPDIR
    process.env.PATH = `${dir}:${oldPath}`
    process.env.TMPDIR = dir
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const provider = new SNICertificateProvider({ key: 'synthetic', cert: 'synthetic' })
    try {
        const pending = Array.from({ length: 18 }, (_, index) =>
            provider.issue(`deadline${index}.test`).catch((error) => error),
        )
        t.mock.timers.tick(9999)
        assert.equal(readdirSync(dir).filter((name) => name.startsWith('rethink-sni-')).length, 2)
        t.mock.timers.tick(1)
        assert((await Promise.all(pending)).every((error) => error instanceof Error))
        assert.deepEqual(readdirSync(dir), ['openssl'])
        writeFileSync(executable, `#!${process.execPath}\nprocess.exit(1)\n`)
        await assert.rejects(provider.issue('deadline0.test'))
        assert.deepEqual(readdirSync(dir), ['openssl'])
    } finally {
        await provider.close()
        t.mock.timers.reset()
        process.env.PATH = oldPath
        if (oldTmp === undefined) delete process.env.TMPDIR
        else process.env.TMPDIR = oldTmp
        rmSync(dir, { recursive: true, force: true })
    }
})

test('the certificate cache evicts old entries at 64 and can issue an evicted host again', async () => {
    const { chmodSync, writeFileSync } = await import('node:fs')
    const dir = mkdtempSync(join(tmpdir(), 'rethink-openssl-cache-'))
    const keyPath = join(dir, 'template-key.pem'),
        certPath = join(dir, 'template-cert.pem')
    execFileSync(
        'openssl',
        [
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-keyout',
            keyPath,
            '-out',
            certPath,
            '-days',
            '1',
            '-subj',
            '/CN=*.cache.test',
            '-addext',
            'subjectAltName=DNS:*.cache.test',
        ],
        { stdio: 'ignore' },
    )
    const ca = { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8') }
    const executable = join(dir, 'openssl')
    writeFileSync(
        executable,
        `#!${process.execPath}\nconst fs=require('node:fs'); const args=process.argv.slice(2); const out=args[args.indexOf('-out')+1]; fs.copyFileSync(args[0]==='genrsa'?${JSON.stringify(keyPath)}:${JSON.stringify(certPath)},out);\n`,
    )
    chmodSync(executable, 0o700)
    const oldPath = process.env.PATH
    process.env.PATH = `${dir}:${oldPath}`
    const provider = new SNICertificateProvider(ca)
    try {
        const first = await provider.issue('host0.cache.test')
        for (let index = 1; index <= 64; index++) await provider.issue(`host${index}.cache.test`)
        assert.equal(provider.cache.size, 64)
        assert.equal(provider.cache.has('host0.cache.test'), false)
        assert.notEqual(await provider.issue('host0.cache.test'), first)
        assert.equal(provider.cache.size, 64)
    } finally {
        await provider.close()
        process.env.PATH = oldPath
        rmSync(dir, { recursive: true, force: true })
    }
})
