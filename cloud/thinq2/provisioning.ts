import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { Router } from 'express'
import type { CA, Config } from '@/util/config'
import { isSafeDeviceId } from '../device_id'
import type { ClipDeployMessage } from './clip'

const MAX_CSR_LENGTH = 64 * 1024
const CERTIFICATE_ERROR = 'Certificate generation failed'

type CertificateSpawner = (command: string, args: string[]) => ChildProcessWithoutNullStreams

export function routes(config: Config, ca: CA, spawnCertificate: CertificateSpawner = spawn) {
    const router = Router()
    router.get('/route', (_req, res) => {
        // Naming rethink here only works if that name resolves for the appliance, which is
        // true when the appliance was pointed at rethink deliberately and not when a
        // firewall rule redirects it. An appliance handed an address that does not exist
        // stops dialling altogether.
        const servers = config.route_servers ?? {
            apiServer: `https://${config.hostname}:${config.https_port.advertise}`,
            mqttServer: `ssl://${config.hostname}:${config.mqtts_port.advertise}`,
        }
        res.json({ resultCode: '0000', result: servers })
    })

    router.get('/route/certificate', (req, res) => {
        if (req.query.name) {
            res.json({ resultCode: '0000', result: { certificatePem: ca.cert } })
        } else {
            res.json({ resultCode: '0000', result: ['common-server', 'aws-iot'] })
        }
    })

    router.post('/device/:deviceId/certificate', (req, res) => {
        const csr = req.body?.csr
        if (
            !isSafeDeviceId(req.params.deviceId) ||
            typeof csr !== 'string' ||
            csr.length === 0 ||
            csr.length > MAX_CSR_LENGTH
        )
            return res.status(400).end()

        let responded = false
        let x509: ChildProcessWithoutNullStreams | undefined
        const respondError = () => {
            if (responded) return
            responded = true
            x509?.kill()
            res.status(500).json({ resultCode: '1000', resultMsg: CERTIFICATE_ERROR })
        }

        try {
            x509 = spawnCertificate('openssl', [
                'x509',
                '-req',
                '-in',
                '-',
                '-days',
                '3650',
                '-CA',
                config.ca_cert_file,
                '-CAkey',
                config.ca_key_file,
                '-set_serial',
                '0100',
                '-out',
                '-',
            ])
        } catch {
            respondError()
            return
        }

        const out: Buffer[] = []
        x509.stdout.on('data', (data: Buffer) => {
            out.push(data)
        })
        x509.stderr.on('data', () => {})
        x509.on('error', respondError)
        x509.stdin.on('error', respondError)
        x509.on('close', (code) => {
            if (code !== 0) {
                respondError()
                return
            }
            if (responded) return
            responded = true
            // Warning: we don't supply MQTT topics at this point. Maybe we should?
            // OTOH, the firmware seems to ignore it outright...
            res.json({
                resultCode: '0000',
                result: { certificatePem: Buffer.concat(out).toString('utf-8').replace(/\r/g, '') },
            })
        })
        try {
            x509.stdin.end(csr)
        } catch {
            respondError()
        }
    })
    return router
}

export function generateDeployResponse(payload: ClipDeployMessage) {
    return {
        did: payload.did,
        mid: Date.now(),
        cmd: 'completeProvisioning',
        type: 0,
        data: {
            result: 0,
            host: 'message',
            appInfo: {
                host: 'message',
                publication: {
                    // this path is arbitrary
                    message: `clip/message/devices/${payload.did}`,

                    // This path is not-so-arbitrary, because the device will cache it
                    // and try to reuse it on a next provisioning attempt. We pick the
                    // default path that is used by the firmware, so that we can be sure
                    // that it will keep working if you revert to the official cloud.

                    // The paths ARE sent by the API server during certificate generation
                    // but the firmware I've worked with seems to ignore them.
                    provisioning: `clip/provisioning/devices/${payload.did}`,
                },
            },
            provisioningType: payload.cmd,
            deployInterval: 600,
        },
    }
}
