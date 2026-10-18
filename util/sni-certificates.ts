import { spawn } from 'node:child_process'
import { randomBytes, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSecureContext, type SecureContext } from 'node:tls'
import type { CA } from './config'
import { isDNSHostname } from './hostname'

const MAX_ACTIVE = 2
const MAX_QUEUED = 16
const MAX_CACHE = 64
const DEADLINE_MS = 10_000
const MAX_OUTPUT_BYTES = 64 * 1024

function runOpenSSL(args: string[], signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(new Error('인증서 발급이 취소되었습니다.'))
        const child = spawn('openssl', args, { stdio: ['ignore', 'pipe', 'pipe'] })
        let failure: Error | undefined
        let outputBytes = 0
        const cancel = () => {
            failure ??= new Error('인증서 발급이 취소되었거나 제한을 초과했습니다.')
            child.kill('SIGKILL')
        }
        signal.addEventListener('abort', cancel, { once: true })
        for (const stream of [child.stdout, child.stderr])
            stream.on('data', (chunk: Buffer) => {
                outputBytes += chunk.length
                if (outputBytes > MAX_OUTPUT_BYTES) cancel()
            })
        child.once('error', (error) => {
            failure = error
        })
        // close follows process exit and closed output pipes; only then may callers remove files.
        child.once('close', (code) => {
            signal.removeEventListener('abort', cancel)
            if (failure || code !== 0) reject(failure ?? new Error('인증서 발급에 실패했습니다.'))
            else resolve()
        })
    })
}

type PendingCertificate = {
    hostname: string
    controller: AbortController
    timer: NodeJS.Timeout
    promise: Promise<IssuedCertificate>
    resolve: (value: IssuedCertificate) => void
    reject: (error: Error) => void
    started: boolean
}

export type IssuedCertificate = {
    key: string
    /** The leaf followed by the certificate that signed it. */
    chain: string
    context: SecureContext
}

/** Creates and caches leaf certificates signed by rethink's device-trusted CA. */
export class SNICertificateProvider {
    readonly cache = new Map<string, IssuedCertificate>()

    private pending = new Map<string, PendingCertificate>()
    private queue: PendingCertificate[] = []
    private active = 0
    private closed = false

    constructor(readonly ca: CA) {}

    async forServerName(serverName: string): Promise<SecureContext> {
        return (await this.issue(serverName)).context
    }

    issue(serverName: string): Promise<IssuedCertificate> {
        if (typeof serverName !== 'string') throw new Error('Invalid TLS SNI hostname')
        const hostname = serverName.trim().toLowerCase().replace(/\.$/, '')
        if (!isDNSHostname(hostname)) throw new Error('Invalid TLS SNI hostname')
        if (this.closed) return Promise.reject(new Error('인증서 발급기가 종료되었습니다.'))
        const cached = this.cache.get(hostname)
        if (cached) {
            this.cache.delete(hostname)
            this.cache.set(hostname, cached)
            return Promise.resolve(cached)
        }
        const pending = this.pending.get(hostname)
        if (pending) return pending.promise
        if (this.active >= MAX_ACTIVE && this.queue.length >= MAX_QUEUED)
            return Promise.reject(new Error('인증서 발급 대기 한도를 초과했습니다.'))
        const controller = new AbortController()
        let resolve!: PendingCertificate['resolve']
        let reject!: PendingCertificate['reject']
        const promise = new Promise<IssuedCertificate>((yes, no) => {
            resolve = yes
            reject = no
        })
        const task: PendingCertificate = {
            hostname,
            controller,
            promise,
            resolve,
            reject,
            started: false,
            timer: setTimeout(() => {
                controller.abort()
                if (!task.started) this.finish(task, new Error('인증서 발급 대기 시간이 초과되었습니다.'))
            }, DEADLINE_MS),
        }
        this.pending.set(hostname, task)
        this.queue.push(task)
        this.drain()
        return promise
    }

    private drain() {
        while (!this.closed && this.active < MAX_ACTIVE && this.queue.length) {
            const task = this.queue.shift()!
            task.started = true
            this.active++
            void this.generate(task.hostname, task.controller.signal).then(
                (issued) => {
                    if (task.controller.signal.aborted) this.finish(task, new Error('인증서 발급이 취소되었습니다.'))
                    else {
                        this.cache.set(task.hostname, issued)
                        if (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value!)
                        this.finish(task, undefined, issued)
                    }
                },
                () => this.finish(task, new Error('인증서 발급에 실패했거나 제한을 초과했습니다.')),
            )
        }
    }

    private finish(task: PendingCertificate, error?: Error, issued?: IssuedCertificate) {
        clearTimeout(task.timer)
        this.pending.delete(task.hostname)
        this.queue = this.queue.filter((item) => item !== task)
        if (task.started) this.active--
        if (error) task.reject(error)
        else task.resolve(issued!)
        this.drain()
    }

    async close() {
        this.closed = true
        const tasks = [...this.pending.values()]
        for (const task of tasks) {
            task.controller.abort()
            if (!task.started) this.finish(task, new Error('인증서 발급기가 종료되었습니다.'))
        }
        await Promise.allSettled(tasks.map((task) => task.promise))
        this.cache.clear()
    }

    private async generate(hostname: string, signal: AbortSignal): Promise<IssuedCertificate> {
        const dir = mkdtempSync(join(tmpdir(), 'rethink-sni-'))
        try {
            const caKey = join(dir, 'ca-key.pem')
            const caCert = join(dir, 'ca-cert.pem')
            const leafKey = join(dir, 'leaf-key.pem')
            const leafCsr = join(dir, 'leaf.csr')
            const leafCert = join(dir, 'leaf-cert.pem')
            const extensions = join(dir, 'extensions.cnf')

            writeFileSync(caKey, this.ca.key, { mode: 0o600 })
            writeFileSync(caCert, this.ca.cert, { mode: 0o600 })
            writeFileSync(
                extensions,
                [
                    'basicConstraints=critical,CA:FALSE',
                    'keyUsage=critical,digitalSignature,keyEncipherment',
                    'extendedKeyUsage=serverAuth',
                    `subjectAltName=DNS:${hostname}`,
                    '',
                ].join('\n'),
                { mode: 0o600 },
            )

            await runOpenSSL(['genrsa', '-out', leafKey, '2048'], signal)
            await runOpenSSL(['req', '-new', '-key', leafKey, '-out', leafCsr, '-subj', `/CN=${hostname}`], signal)
            await runOpenSSL(
                [
                    'x509',
                    '-req',
                    '-in',
                    leafCsr,
                    '-CA',
                    caCert,
                    '-CAkey',
                    caKey,
                    '-set_serial',
                    `0x${randomBytes(16).toString('hex')}`,
                    '-out',
                    leafCert,
                    '-days',
                    '825',
                    '-sha256',
                    '-extfile',
                    extensions,
                ],
                signal,
            )

            const key = readFileSync(leafKey, 'utf-8')
            const cert = readFileSync(leafCert, 'utf-8')
            if (!new X509Certificate(cert).checkHost(hostname)) {
                throw new Error(`Generated certificate does not cover ${hostname}`)
            }
            /*
             * The issuer goes out with the leaf. Sent on its own, an appliance that cannot
             * find the certificate that signed it answers "unknown ca" and gives up —
             * measured at about a refusal a second, indefinitely, from an appliance that
             * then never got far enough to re-establish anything else. The MQTT listener
             * never had the problem because it presents the CA certificate itself, which is
             * the very one the appliance was given.
             */
            const chain = [cert.trimEnd(), this.ca.cert.trimEnd(), ''].join('\n')
            return { key, chain, context: createSecureContext({ key, cert: chain }) }
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    }
}
