import net from 'node:net'
import log from '@/util/logging'

/**
 * Not every hostname an appliance asks for is one rethink can answer.
 *
 * The appliances are pointed at rethink by a firewall rule on port 443, which catches every
 * host they talk to, not only the ones rethink implements. For a host it cannot serve it
 * still offers its own certificate, the appliance refuses it — "unknown ca" — and retries,
 * about once a second, indefinitely. The washers were doing exactly that: reaching for
 * kic-mclip.lgthinq.com, being turned away, and never getting far enough to re-establish
 * anything else.
 *
 * So the connection is read far enough to learn which host was asked for, before any
 * certificate is offered. A host rethink serves is handled as before; anything else is
 * spliced through to the real one, where the appliance meets the certificate it expects.
 */

/** The largest ClientHello worth waiting for before giving up and handling it locally. */
const MAX_HELLO_BYTES = 8 * 1024

/**
 * The server name from a TLS ClientHello, or undefined if this is not one, does not carry a
 * name, or has not arrived in full yet. Deliberately total: anything unparseable is somebody
 * else's problem and gets handled the way it always was.
 */
export function readServerName(hello: Buffer): string | undefined {
    try {
        if (hello.length < 47 || hello[0] !== 0x16 || hello[5] !== 0x01) return undefined

        let at = 43 // record header, handshake header, client version, random
        const sessionId = hello[at]
        at += 1 + sessionId
        const cipherSuites = hello.readUInt16BE(at)
        at += 2 + cipherSuites
        const compression = hello[at]
        at += 1 + compression
        if (at + 2 > hello.length) return undefined

        const extensionsEnd = Math.min(hello.readUInt16BE(at) + at + 2, hello.length)
        at += 2
        while (at + 4 <= extensionsEnd) {
            const type = hello.readUInt16BE(at)
            const length = hello.readUInt16BE(at + 2)
            const body = at + 4
            if (type === 0x0000 && body + 5 <= extensionsEnd) {
                // server_name_list: 2 bytes of list length, then entries of type + length.
                const nameLength = hello.readUInt16BE(body + 3)
                const start = body + 5
                if (hello[body + 2] !== 0x00 || start + nameLength > extensionsEnd) return undefined
                return hello.subarray(start, start + nameLength).toString('ascii')
            }
            at = body + length
        }
        return undefined
    } catch {
        return undefined
    }
}

/** Case-insensitive match with `*` standing for any run of characters. */
export function matchesHostPattern(hostname: string, pattern: string) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    return new RegExp(`^${escaped}$`, 'i').test(hostname)
}

/**
 * How long a stalled connection is held before it is closed. Long enough that the appliance
 * is waiting on its own timeout rather than ours, short enough that the sockets do not pile
 * up: at one attempt a second, a minute's hold is sixty open sockets at a time.
 */
export const STALL_MS = 60_000

export type SNIRouterOptions = {
    /** Hostnames to splice through to the real server instead of terminating here. */
    passThrough: string[]
    /**
     * Hostnames to accept and then answer with nothing at all.
     *
     * Refusing a handshake is instant, so an appliance that will not accept rethink's
     * certificate for a host simply asks again about once a second, for as long as it is
     * powered. Saying nothing makes it wait out its own timeout instead, which is the only
     * part of the exchange rethink can lengthen — it cannot produce a certificate the
     * appliance trusts, and passing the host through hands the appliance a working route to
     * LG, which is what stopped four appliances reporting over MQTT at all.
     */
    stall?: string[]
    /** How long a stalled connection is held before being closed. Defaults to STALL_MS. */
    stallMs?: number
    /** The port the appliance originally addressed, before the firewall redirected it. */
    upstreamPort: number
    /** Hand the connection to the local TLS server, with its first bytes put back. */
    handleLocally: (socket: net.Socket) => void
}

export function createSNIRouter({
    passThrough,
    stall = [],
    stallMs = STALL_MS,
    upstreamPort,
    handleLocally,
}: SNIRouterOptions) {
    return net.createServer((socket) => {
        let buffered = Buffer.alloc(0)
        let settled = false

        /*
         * Paused, and read explicitly. A socket in flowing mode cannot have bytes put back
         * on it, so peeking with a 'data' handler and then unshifting hands the local server
         * a connection with its ClientHello missing — which it waits out and drops.
         */
        socket.pause()

        const stopPeeking = () => {
            settled = true
            socket.removeListener('readable', onReadable)
            socket.removeListener('end', onEnd)
            socket.removeListener('error', onEarlyError)
        }

        const takeLocally = () => {
            stopPeeking()
            if (buffered.length) socket.unshift(buffered)
            handleLocally(socket)
        }

        const splice = (hostname: string) => {
            stopPeeking()
            const upstream = net.connect(upstreamPort, hostname)
            upstream.on('error', (err) => {
                log('status', `cannot reach ${hostname}:${upstreamPort} for a passed-through appliance: ${err.message}`)
                socket.destroy()
            })
            socket.on('error', () => upstream.destroy())
            upstream.on('connect', () => {
                upstream.write(buffered)
                socket.pipe(upstream)
                upstream.pipe(socket)
            })
        }

        const stallConnection = (hostname: string) => {
            stopPeeking()
            log('status', `holding a connection for ${hostname} open rather than refusing it`)
            /*
             * Both the socket and its timer are unreferenced. A held connection is one
             * rethink has decided to ignore, so it should never be the reason the process
             * stays alive; the listening server keeps it running for as long as it should.
             */
            const timer = setTimeout(() => socket.destroy(), stallMs)
            timer.unref()
            socket.unref()
            // An appliance that gives up first must not leave the timer behind it.
            socket.on('close', () => clearTimeout(timer))
            socket.on('error', () => socket.destroy())
            socket.resume()
        }

        const onReadable = () => {
            for (;;) {
                if (settled) return
                const chunk = socket.read() as Buffer | null
                if (!chunk) return
                buffered = Buffer.concat([buffered, chunk])

                const hostname = readServerName(buffered)
                if (hostname) {
                    if (passThrough.some((pattern) => matchesHostPattern(hostname, pattern))) splice(hostname)
                    else if (stall.some((pattern) => matchesHostPattern(hostname, pattern))) stallConnection(hostname)
                    else takeLocally()
                    return
                }
                // Either still arriving or not a ClientHello at all; do not wait forever.
                if (buffered.length >= MAX_HELLO_BYTES) return takeLocally()
            }
        }

        // Whatever it was, it is the local server's to answer or refuse, not ours to drop.
        const onEnd = () => takeLocally()
        const onEarlyError = () => socket.destroy()

        socket.on('readable', onReadable)
        socket.on('end', onEnd)
        socket.on('error', onEarlyError)
    })
}
