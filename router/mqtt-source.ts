import { type MQTTInventoryEntry, type MQTTSource, normalizeMQTTAddress } from '@/cloud/mqtt-access'
import { isHostKeyFingerprint, type RouterConfigStore, type RouterSSHConfig } from './config-store'
import { RouterSSHClient } from './ssh-client'

export const MQTT_CONNTRACK_COMMAND = '/usr/sbin/conntrack -L -p tcp --dport 8883'
const MAX_OUTPUT = 256 * 1024
const validPort = (port: number | undefined): port is number =>
    typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535
function registered(entries: MQTTInventoryEntry[], ip: string) {
    const matches = entries.filter((entry) => entry.ip === ip)
    return matches.length === 1 && matches[0].platform !== 'thinq1' && matches[0].autoLink !== false
        ? matches[0]
        : undefined
}

/** Match the complete reply socket tuple; NAT may translate the source port too. */
export function conntrackMQTTSource(
    output: string,
    source: MQTTSource,
    config: RouterSSHConfig,
    entries: MQTTInventoryEntry[],
) {
    const remote = normalizeMQTTAddress(source.remoteAddress),
        local = normalizeMQTTAddress(source.localAddress)
    if (
        remote !== config.host ||
        local !== config.rethinkIp ||
        !validPort(source.remotePort) ||
        !validPort(source.localPort) ||
        !output.endsWith('\n') ||
        Buffer.byteLength(output) > MAX_OUTPUT
    )
        return
    const matches: string[] = []
    for (const line of output.trimEnd().split('\n')) {
        const row =
            /^tcp\s+6\s+\d+\s+([A-Z_]+)\s+src=(\S+)\s+dst=(\S+)\s+sport=(\d+)\s+dport=(\d+)\s+src=(\S+)\s+dst=(\S+)\s+sport=(\d+)\s+dport=(\d+)((?:\s+(?:\[[A-Z_]+\]|[a-z_]+=[A-Za-z0-9:.-]+))*)$/.exec(
                line,
            )
        if (
            !row ||
            ![row[2], row[3], row[6], row[7]].every((ip) => normalizeMQTTAddress(ip)) ||
            ![row[4], row[5], row[8], row[9]].every((port) => validPort(Number(port)))
        )
            return
        if (
            row[1] === 'ESTABLISHED' &&
            Number(row[5]) === 8883 &&
            normalizeMQTTAddress(row[6]) === local &&
            normalizeMQTTAddress(row[7]) === remote &&
            Number(row[8]) === source.localPort &&
            Number(row[9]) === source.remotePort
        ) {
            const origin = normalizeMQTTAddress(row[2])
            if (origin) matches.push(origin)
        }
    }
    return matches.length === 1 &&
        matches[0] !== config.host &&
        matches[0] !== config.rethinkIp &&
        registered(entries, matches[0])
        ? matches[0]
        : undefined
}

type QueryClient = Pick<RouterSSHClient, 'connect' | 'exec' | 'close'>
type Job = { run: () => Promise<void> }

export class RouterMQTTSourceResolver {
    private active = 0
    private queue: Job[] = []
    constructor(
        private store: RouterConfigStore,
        private ssh: (config: RouterSSHConfig) => QueryClient = (config) => new RouterSSHClient(config),
    ) {}

    resolve = (source: MQTTSource, signal: AbortSignal): Promise<string | undefined> => {
        const remote = normalizeMQTTAddress(source.remoteAddress)
        if (signal.aborted || !remote) return Promise.resolve(undefined)
        const config = this.store.router()
        if (remote !== config.host && remote !== config.rethinkIp && registered(this.store.devices(), remote))
            return Promise.resolve(remote)
        if (
            remote !== config.host ||
            !this.store.configured() ||
            !isHostKeyFingerprint(config.hostKeyFingerprint) ||
            normalizeMQTTAddress(source.localAddress) !== config.rethinkIp ||
            !validPort(source.remotePort) ||
            !validPort(source.localPort) ||
            (this.active >= 2 && this.queue.length >= 16)
        )
            return Promise.resolve(undefined)
        const tuple: MQTTSource = {
            remoteAddress: source.remoteAddress,
            remotePort: source.remotePort,
            localAddress: source.localAddress,
            localPort: source.localPort,
        }
        return new Promise((resolve) => {
            const abort = new AbortController()
            let settled = false
            const finish = (ip?: string) => {
                if (settled) return
                settled = true
                clearTimeout(deadline)
                signal.removeEventListener('abort', cancel)
                const index = this.queue.indexOf(job)
                if (index >= 0) this.queue.splice(index, 1)
                resolve(ip)
            }
            const cancel = () => {
                abort.abort()
                finish()
            }
            const deadline = setTimeout(cancel, 10_000)
            const job: Job = {
                run: async () => {
                    if (settled) return
                    this.active++
                    const client = this.ssh(config)
                    try {
                        await client.connect({ signal: abort.signal })
                        if (abort.signal.aborted) return
                        const result = await client.exec(MQTT_CONNTRACK_COMMAND, {
                            signal: abort.signal,
                            timeoutMs: 2000,
                            maxBytes: MAX_OUTPUT,
                        })
                        const outputBytes = Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)
                        const summary = /^conntrack v[^\n]{1,128}: (\d+) flow entries have been shown\.\n$/.exec(
                            result.stderr,
                        )
                        const stderrValid =
                            !result.stderr ||
                            (summary && Number(summary[1]) === result.stdout.trimEnd().split('\n').length)
                        if (
                            settled ||
                            abort.signal.aborted ||
                            result.code !== 0 ||
                            outputBytes > MAX_OUTPUT ||
                            !stderrValid ||
                            JSON.stringify(this.store.router()) !== JSON.stringify(config) ||
                            !this.store.configured()
                        )
                            return
                        const ip = conntrackMQTTSource(result.stdout, tuple, config, this.store.devices())
                        finish(ip)
                    } catch {
                        /* Lookup failure always denies admission. */
                    } finally {
                        client.close()
                        finish()
                        this.active--
                        this.queue.shift()?.run()
                    }
                },
            }
            signal.addEventListener('abort', cancel, { once: true })
            if (this.active < 2) void job.run()
            else this.queue.push(job)
        })
    }
}
