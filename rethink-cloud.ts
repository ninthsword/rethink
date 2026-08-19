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
import { DeviceManager } from './cloud/devmgr'
import { Bridge } from './bridge'
import { JSONStorage } from './bridge/state'
import { SNICertificateProvider } from './util/sni-certificates'

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

    // fallback
    app.use((req, res) => {
        res.json({})
    })

    reportTlsErrors(https.createServer(tlsServerOptions, app), 'thinq1 https').listen(config.thinq1_https_port.bind)
    const acceptor = new T1Acceptor()
    reportTlsErrors(tls.createServer(tlsServerOptions, acceptor.accept.bind(acceptor)), 'thinq1').listen(
        config.thinq1_port.bind,
    )
    acceptor.on('newDevice', manager.accept.bind(manager))
}

/**
 * A refused TLS handshake was completely silent until now: neither server had a
 * tlsClientError listener, so an appliance that could not agree a connection simply never
 * appeared and left nothing to look at. Every listener gets one.
 */
function reportTlsErrors<T extends { on(event: 'tlsClientError', handler: (err: Error, socket: TLSSocket) => void): T }>(
    server: T,
    name: string,
) {
    server.on('tlsClientError', (err, socket) => {
        const from = (socket as unknown as { remoteAddress?: string }).remoteAddress ?? 'unknown'
        log('status', `TLS handshake refused on ${name} from ${from}: ${err.message}`)
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

    // fallback
    app.use((req, res) => {
        res.header('content-type', 'text/xml;charset=utf-8')
        res.end('')
    })

    reportTlsErrors(https.createServer(tlsServerOptions, app), 'thinq2 https').listen(config.https_port.bind)

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
