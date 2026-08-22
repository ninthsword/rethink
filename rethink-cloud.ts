import express from 'express'
import stripJsonComments from 'strip-json-comments'
import { mkdirSync, readFileSync } from 'node:fs'
import * as https from 'node:https'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { Broker } from './cloud/mqtt-broker'
import * as tls from 'node:tls'
import type { TLSSocket } from 'node:tls'
import * as net from 'node:net'
import { X509Certificate } from 'node:crypto'
import { routes as thinq1Routes } from './cloud/thinq1/http'
import { routes as thinq2Routes } from './cloud/thinq2/provisioning'
import { DeviceAcceptor as T1Acceptor } from './cloud/thinq1/device'
import { DeviceAcceptor as T2Acceptor } from './cloud/thinq2/device'
import { Connection as HA_connection } from './cloud/homeassistant'
import HA_bridge from './cloud/ha_bridge'
import { normalize as normalizeConfig, RawConfig, CA } from './util/config'
import * as Management from './management'

import log, { setFilter as setLogFilter } from './util/logging'
import { createSNIRouter } from './cloud/sni_router'
import { DeviceManager } from './cloud/devmgr'
import { Bridge } from './bridge'
import { JSONStorage } from './bridge/state'
import { SNICertificateProvider } from './util/sni-certificates'
import { collapseRepeats, withoutErrorTag } from './util/repeated_log'

const configPath = resolve(process.argv[2] ?? './config.json')
const configDir = dirname(configPath)
const config = normalizeConfig(JSON.parse(stripJsonComments(readFileSync(configPath).toString('utf-8'))) as RawConfig)

config.ca_key_file = resolve(configDir, config.ca_key_file)
config.ca_cert_file = resolve(configDir, config.ca_cert_file)
if (config.bridge) config.bridge.storage_path = resolve(configDir, config.bridge.storage_path)

if (!config.log) config.log = ['status', 'incoming', 'HTTPS']

const enabled = Object.fromEntries(config.log.map((key) => [key, true]))
setLogFilter((topic) => {
    return enabled[topic] || enabled['all']
})

// if you add spaces here, you will have to fix quoting in the code below
// the CA is also the server
function loadOrCreateCert(): CA {
    let keypem: string, certpem: string
    try {
        keypem = readFileSync(config.ca_key_file).toString('utf-8')
        certpem = readFileSync(config.ca_cert_file).toString('utf-8')

        if (!new X509Certificate(certpem).checkHost(config.hostname))
            throw new Error('invalid subject, creating new certificate')
    } catch (err) {
        log('status', 'Creating a new key/certificate for the CA')
        spawnSync('openssl', [
            'req',
            '-x509',
            '-newkey',
            'rsa:4096',
            '-keyout',
            config.ca_key_file,
            '-out',
            config.ca_cert_file,
            '-sha256',
            '-days',
            '3650',
            '-nodes',
            '-subj',
            '/CN=' + config.hostname,
        ])
        keypem = readFileSync(config.ca_key_file).toString('utf-8')
        certpem = readFileSync(config.ca_cert_file).toString('utf-8')
    }

    return { key: keypem, cert: certpem }
}

const ca = loadOrCreateCert()
const sniCertificates = config.sni_certificates ? new SNICertificateProvider(ca) : undefined
const tlsServerOptions: tls.TlsOptions = {
    ...ca,
    SNICallback: sniCertificates
        ? (servername, callback) => {
              try {
                  callback(null, sniCertificates.forServerName(servername))
              } catch (err) {
                  callback(err as Error)
              }
          }
        : undefined,
}

// Thinq1
function t1setup(manager: DeviceManager) {
    // Thinq1 HTTPS server
    const app = express()
    app.use(function (req, res, next) {
        log('HTTPS', req.hostname, req.url)
        next()
    })

    app.use(thinq1Routes(config))

    // The same blind spot on the ThinQ1 side; see the ThinQ2 fallback above.
    app.use((req, res) => {
        const body = req.body && Object.keys(req.body).length ? JSON.stringify(req.body) : ''
        log(
            'unhandled-https',
            `${req.method} ${req.hostname}${req.url}`,
            body ? `body ${body.length}B: ${body.slice(0, 600)}` : '(no body)',
        )
        res.json({})
    })

    reportTlsErrors(https.createServer(tlsServerOptions, app), 'thinq1 https').listen(config.thinq1_https_port.bind)
    const acceptor = new T1Acceptor()
    reportTlsErrors(tls.createServer(tlsServerOptions, acceptor.accept.bind(acceptor)), 'thinq1').listen(
        config.thinq1_port.bind,
    )
    acceptor.on('newDevice', manager.accept.bind(manager))
}

/** How often a refusal that keeps repeating is worth restating. */
const REFUSAL_SUMMARY_MS = 60_000

/**
 * A refused TLS handshake was completely silent until now: neither server had a
 * tlsClientError listener, so an appliance that could not agree a connection simply never
 * appeared and left nothing to look at. Every listener gets one.
 */
function reportTlsErrors<
    T extends { on(event: 'tlsClientError', handler: (err: Error, socket: TLSSocket) => void): T },
>(server: T, name: string) {
    /*
     * A refused host keeps being refused: the appliance retries about once a second and will
     * do so for as long as it is powered. Saying so once a minute, with the count, describes
     * that exactly as well as thirty identical lines do.
     */
    const report = collapseRepeats(REFUSAL_SUMMARY_MS, (line) => log('status', line))

    server.on('tlsClientError', (err, socket) => {
        const s = socket as unknown as { remoteAddress?: string; remotePort?: number; servername?: string }
        const from = s.remoteAddress ?? 'unknown'
        /*
         * The name matters more than the error. Everything arrives from the router's address
         * because it masquerades the whole house, so the hostname the appliance asked for is
         * the only thing that says which service it wanted — and an "unknown ca" refusal
         * means the appliance would not accept the certificate offered for that name.
         */
        const wanted = s.servername ? ` for ${s.servername}` : ' with no server name'
        const reason = withoutErrorTag(err.message)

        /*
         * The port is deliberately not part of the key. It changes on every attempt, and
         * keying on it would mean every refusal is a first one and nothing ever collapses.
         */
        report(
            `${name}|${s.servername ?? ''}|${reason}`,
            (held) =>
                `TLS handshake refused on ${name} from ${from}:${s.remotePort ?? '?'}${wanted}: ${reason}` +
                (held ? ` (and ${held} more like it since the last report)` : ''),
        )
    })
    return server
}

// Thinq2
function t2setup(manager: DeviceManager) {
    // Thinq2 HTTPS server
    const app = express()
    app.use(express.json())

    app.use(function (req, res, next) {
        log('HTTPS', req.hostname, req.url)
        next()
    })

    app.use(thinq2Routes(config, ca))

    /*
     * Anything the appliance asks for that is not one of the three provisioning routes above
     * is answered with an empty body and nothing else happens to it — rethink neither
     * handles it nor passes it on, and the appliance takes the 200 for success and never
     * retries. That is fine for chatter, but it is also where an appliance's usage upload
     * would go, and the LG cloud's daily energy figures stopped for every appliance on the
     * day it was bridged while its live readings kept working. So say what is being
     * swallowed, in enough detail to tell which it is.
     */
    app.use((req, res) => {
        const body = req.body && Object.keys(req.body).length ? JSON.stringify(req.body) : ''
        log(
            'unhandled-https',
            `${req.method} ${req.hostname}${req.url}`,
            body ? `body ${body.length}B: ${body.slice(0, 600)}` : '(no body)',
        )
        res.header('content-type', 'text/xml;charset=utf-8')
        res.end('')
    })

    /*
     * The firewall sends every port-443 connection here, including hosts rethink has no
     * routes for. Those are read far enough to learn the name asked for and then spliced
     * through to the real server, so the appliance meets the certificate it expects instead
     * of one it refuses.
     */
    const thinq2Https = reportTlsErrors(https.createServer(tlsServerOptions, app), 'thinq2 https')
    createSNIRouter({
        passThrough: config.passthrough_hostnames,
        stall: config.stall_hostnames,
        upstreamPort: 443,
        handleLocally: (socket: net.Socket) => thinq2Https.emit('connection', socket),
    }).listen(config.https_port.bind)

    // internal MQTT broker
    const broker = new Broker()

    if (config.mqtt) {
        reportTlsErrors(tls.createServer(tlsServerOptions, broker.accept.bind(broker)), 'mqtts').listen(
            config.mqtts_port.bind,
        )
        net.createServer({}, broker.accept.bind(broker)).listen(config.mqtt_port.bind)
    }

    const acceptor = new T2Acceptor(broker)
    acceptor.on('newDevice', manager.accept.bind(manager))

    // Appliances with a long keepalive do not notice the process going away until their
    // own timer fires, which left the washer absent for up to twenty minutes after every
    // restart. Cutting the connections on the way out brings them straight back.
    for (const signal of ['SIGTERM', 'SIGINT'] as const)
        process.once(signal, () => {
            broker.shutdown()
            // process.exit() drops whatever is still queued on stdout, which in a container
            // is a pipe and therefore written asynchronously. A tick is enough for the
            // shutdown line to survive; the resets themselves already left the kernel.
            setTimeout(() => process.exit(0), 100)
        })
}

/*
 * A rejection nobody handled ends the process in Node, and here that is expensive: every
 * appliance loses the peer it was attached to, all eleven go through undeploy and deploy
 * again, and the washer-class ones are gone for up to twenty-five minutes while their
 * keepalive runs out. Almost none of that is worth paying for a stray promise.
 *
 * So the process stays up and says what happened. An uncaught exception is different — the
 * state after one is not known to be sound — so that one is reported and then allowed to
 * end the process, which is at least a restart with a reason attached to it.
 */
process.on('unhandledRejection', (reason) => {
    log('status', `unhandled rejection, continuing: ${reason instanceof Error ? reason.stack : reason}`)
})
process.on('uncaughtException', (err) => {
    log('status', `uncaught exception, exiting: ${err.stack ?? err}`)
    process.exit(1)
})

// HA connector
const haConnection = new HA_connection(config.homeassistant)
// An appliance that drops its connection is usually only entering standby, not going
// away. Keep its entities available for the configured grace period; a real rethink
// outage is still signalled immediately through the global availability topic.
const offlineGraceMs = Math.max(2000, (config.homeassistant.offline_grace_seconds ?? 1800) * 1000)
const ha = new HA_bridge(haConnection, offlineGraceMs)
const manager = new DeviceManager()
manager.on('newDevice', (dev) => ha.newDevice(dev))

t1setup(manager)
t2setup(manager)

let bridge: Bridge | undefined
if (config.bridge) {
    mkdirSync(config.bridge.storage_path, { recursive: true })
    const storage = new JSONStorage(config.bridge.storage_path)
    bridge = new Bridge(storage, manager, {
        preserveExistingDevices: config.bridge.preserve_existing_devices,
    })
    haConnection.setDeviceNameResolver((id) => bridge?.name(id))
    bridge.on('deviceNamesChanged', () => ha.refreshDiscovery())
}

if (config.management_port)
    Management.app(ha, manager, bridge, resolve(configDir, 'router-dnat.json')).listen(config.management_port.bind)

console.log('Rethink cloud ready')
