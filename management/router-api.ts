import type { Request, Response } from 'express'
import type { WebSocketExpress } from 'websocket-express'
import type HA_bridge from '@/cloud/ha_bridge'
import type { AnyDevice, DeviceManager } from '@/cloud/devmgr'
import type { Bridge } from '@/bridge'
import { RouterConfigStore } from '@/router/config-store'
import { DNATManager, type DNATState } from '@/router/dnat-manager'
import { DNATReconciler } from '@/router/dnat-reconciler'
import log from '@/util/logging'

type Handler = (req: Request, res: Response) => Promise<any>

export class RouterAPI {
    readonly store: RouterConfigStore
    readonly reconciler: DNATReconciler

    constructor(
        filename: string,
        readonly ha: HA_bridge,
        readonly manager: DeviceManager,
        readonly bridge: Bridge | undefined,
    ) {
        this.store = new RouterConfigStore(filename)
        manager.on('newDevice', (device) => this.syncDevice(device))
        bridge?.on('deviceNamesChanged', () => this.syncAllDevices())
        Object.values(manager.allDevices).forEach((device) => this.syncDevice(device))
        this.reconciler = new DNATReconciler(this.store, () => new DNATManager(this.store.router()))
        this.reconciler.start()
    }

    register(app: WebSocketExpress) {
        app.get(
            '/api/router/config',
            this.wrap(async (_req, res) => res.json(this.store.publicRouter())),
        )

        app.put(
            '/api/router/config',
            this.wrap(async (req, res) => res.json(this.store.updateRouter(req.body || {}))),
        )

        app.post(
            '/api/router/test',
            this.wrap(async (_req, res) => {
                this.requireConfigured()
                res.json(await new DNATManager(this.store.router()).test())
            }),
        )

        app.get(
            '/api/router/status',
            this.wrap(async (_req, res) => res.json(await this.snapshot())),
        )

        app.post(
            '/api/router/devices',
            this.wrap(async (req, res) => {
                const entry = this.store.addDevice(req.body?.ip)
                res.status(201).json(entry)
            }),
        )

        app.put(
            '/api/router/devices/:entryId',
            this.wrap(async (req, res) => {
                const entry = this.store.requireDevice(this.param(req, 'entryId'))
                if (req.body?.ip !== undefined && `${req.body.ip}`.trim() !== entry.ip) {
                    const state = await this.stateFor(entry.entryId)
                    if (state !== 'off') throw new ConflictError('Turn DNAT off before changing the IP')
                }
                res.json(this.store.updateDevice(entry.entryId, req.body || {}))
            }),
        )

        app.delete(
            '/api/router/devices/:entryId',
            this.wrap(async (req, res) => {
                const entryId = this.param(req, 'entryId')
                const state = await this.stateFor(entryId)
                if (state !== 'off') throw new ConflictError('Turn DNAT off before deleting the device')

                // The appliance's registration goes with the entry, or rethink keeps
                // bridging with a certificate nothing points at any more — which is how one
                // appliance ended up with two identities and stopped reporting. It is put
                // aside rather than destroyed, so re-adding an entry deleted by mistake
                // brings it back; a deliberate re-registration overwrites it instead.
                const entry = this.store.requireDevice(entryId)
                if (entry.deviceId) {
                    // Put it aside first. disable() deletes the very file the archive is
                    // copied from, so archiving afterwards always found nothing and the
                    // registration went for good — which is the one outcome this exists to
                    // prevent.
                    if (this.bridge?.state.archiveDeviceState(entry.deviceId))
                        log('status', 'archived the bridge registration of', entry.deviceId)
                    this.bridge?.disable(entry.deviceId)
                }
                this.store.deleteDevice(entryId)
                res.status(204).end()
            }),
        )

        app.post(
            '/api/router/devices/:entryId/link',
            this.wrap(async (req, res) => {
                const deviceId = `${req.body?.deviceId || ''}`
                const device = this.manager.allDevices[deviceId]
                if (!device) throw new Error('Rethink device is not connected')
                res.json(
                    this.store.linkDevice(
                        this.param(req, 'entryId'),
                        deviceId,
                        this.deviceName(device),
                        device.platform,
                    ),
                )
            }),
        )

        app.delete(
            '/api/router/devices/:entryId/link',
            this.wrap(async (req, res) => res.json(this.store.unlinkDevice(this.param(req, 'entryId')))),
        )

        app.post(
            '/api/router/dnat/release',
            this.wrap(async (_req, res) => {
                /*
                 * For restarting rethink without pointing the appliances at a process that
                 * is going away. With the rules gone they go back to talking to LG directly
                 * and stay connected to something; without this they lose the endpoint
                 * underneath them, and the two washers do not dial back once that happens.
                 *
                 * dnatDesired is deliberately left alone, so the reconciler treats the rules
                 * as missing and puts them back on its own once rethink is up again.
                 */
                this.requireConfigured()
                const manager = new DNATManager(this.store.router())
                const entries = this.store.devices().filter((entry) => entry.dnatDesired)
                for (const entry of entries) await manager.disable(entry)
                log('status', `released the DNAT rules for ${entries.length} appliances; they will be restored`)
                res.json({ released: entries.map((entry) => entry.entryId) })
            }),
        )

        app.post(
            '/api/router/devices/:entryId/dnat/enable',
            this.wrap(async (req, res) => {
                this.requireConfigured()
                const entry = this.store.requireDevice(this.param(req, 'entryId'))
                await new DNATManager(this.store.router()).enable(entry)
                // Recorded only once the router accepted the rules, so a failed attempt
                // does not leave the reconciler chasing a device the user never got on.
                this.store.setDnatDesired(entry.entryId, true)
                res.json(await this.snapshot())
            }),
        )

        app.post(
            '/api/router/devices/:entryId/dnat/disable',
            this.wrap(async (req, res) => {
                this.requireConfigured()
                const entry = this.store.requireDevice(this.param(req, 'entryId'))
                if (entry.deviceId && this.bridge?.status(entry.deviceId))
                    throw new ConflictError('Suspend Bridge before turning DNAT off')
                await new DNATManager(this.store.router()).disable(entry)
                this.store.setDnatDesired(entry.entryId, false)
                res.json(await this.snapshot())
            }),
        )

        app.post(
            '/api/router/devices/:entryId/bridge/registration/restore',
            this.wrap(async (req, res) => {
                const entry = this.store.requireDevice(this.param(req, 'entryId'))
                if (!entry.deviceId) throw new Error('No Rethink device is linked to this IP')
                if (!this.bridge) throw new Error('Bridge is not configured')
                if (this.bridge.status(entry.deviceId))
                    throw new ConflictError('Suspend Bridge before changing its registration')
                if (!this.bridge.state.restoreDeviceState(entry.deviceId))
                    throw new ConflictError('There is no archived registration to restore')
                log('status', 'restored the archived bridge registration of', entry.deviceId)
                res.status(204).end()
            }),
        )

        app.post(
            '/api/router/devices/:entryId/bridge/registration/renew',
            this.wrap(async (req, res) => {
                const entry = this.store.requireDevice(this.param(req, 'entryId'))
                if (!entry.deviceId) throw new Error('No Rethink device is linked to this IP')
                if (!this.bridge) throw new Error('Bridge is not configured')
                if (this.bridge.status(entry.deviceId))
                    throw new ConflictError('Suspend Bridge before changing its registration')
                // Nothing is deleted here: turning the bridge on pairs a fresh certificate
                // and that becomes the current one. Discarding the archive as well would
                // throw away the only copy of the previous registration for no gain.
                this.bridge.disable(entry.deviceId)
                log('status', 'discarded the current bridge registration of', entry.deviceId, 'for a fresh one')
                res.status(204).end()
            }),
        )

        app.post(
            '/api/router/devices/:entryId/bridge/resume',
            this.wrap(async (req, res) => {
                const entry = this.store.requireDevice(this.param(req, 'entryId'))
                if (!entry.deviceId) throw new Error('No Rethink device is linked to this IP')
                if ((await this.stateFor(entry.entryId)) !== 'on')
                    throw new ConflictError('Turn DNAT on before starting Bridge')
                if (!this.bridge) throw new Error('Bridge is not configured')
                // enable() answers with a bare false for three different situations, and
                // "Unable to start Bridge" told the owner none of them. The usual one is an
                // appliance that has not reached rethink: the washers stop talking when they
                // are idle and their Wi-Fi indicator goes out, which looks like a fault.
                const started = await this.bridge.enable(entry.deviceId)
                if (!started) {
                    if (!this.bridge.isLoggedIn())
                        throw new ConflictError('Sign in to the LG account before starting Bridge')
                    if (!this.manager.allDevices[entry.deviceId])
                        throw new ConflictError(
                            'The appliance has not connected to rethink, so there is nothing to bridge yet. ' +
                                'It reaches rethink when it next has something to report — run it, or switch it off and on again.',
                        )
                    throw new Error('The LG cloud refused the registration')
                }
                res.json(await this.snapshot())
            }),
        )

        app.post(
            '/api/router/devices/:entryId/bridge/suspend',
            this.wrap(async (req, res) => {
                const entry = this.store.requireDevice(this.param(req, 'entryId'))
                if (!entry.deviceId || !this.bridge) throw new Error('Bridge is not configured for this device')
                this.bridge.disable(entry.deviceId)
                res.json(await this.snapshot())
            }),
        )

        app.delete(
            '/api/router/devices/:entryId/bridge/credentials',
            this.wrap(async (req, res) => {
                const entry = this.store.requireDevice(this.param(req, 'entryId'))
                if (!entry.deviceId || !this.bridge) throw new Error('Bridge is not configured for this device')
                this.bridge.disable(entry.deviceId)
                res.json(await this.snapshot())
            }),
        )
    }

    private wrap(handler: Handler) {
        return (req: Request, res: Response, next: (err: any) => void) => {
            handler(req, res).catch((err) => {
                if (res.headersSent) return next(err)
                /*
                 * The management page shows whatever comes back. Anything not handled here
                 * reached Express's own error page, so a failed Bridge switch put a block of
                 * HTML and a stack trace on screen where the reason should have been.
                 */
                const message = err instanceof Error && err.message ? err.message : 'Unexpected error'
                res.status(err instanceof ConflictError ? 409 : 400)
                    .type('text/plain')
                    .end(message)
                log('status', `${req.method} ${req.originalUrl} failed: ${message}`)
            })
        }
    }

    private param(req: Request, name: string) {
        const value = req.params[name]
        if (typeof value !== 'string') throw new Error(`Invalid ${name}`)
        return value
    }

    private requireConfigured() {
        if (!this.store.configured()) throw new Error('Router SSH settings are not configured')
    }

    private async stateFor(entryId: string) {
        this.requireConfigured()
        const states = await new DNATManager(this.store.router()).status([this.store.requireDevice(entryId)])
        return states[entryId]
    }

    private async snapshot() {
        this.syncAllDevices()
        const entries = this.store.devices()
        let connected = false
        let error: string | undefined
        let states: Record<string, DNATState> = Object.fromEntries(entries.map((entry) => [entry.entryId, 'unknown']))
        if (this.store.configured()) {
            try {
                states = await new DNATManager(this.store.router()).status(entries)
                connected = true
            } catch (err) {
                error = `${err}`
            }
        }

        const linkedIds = new Set(entries.map((entry) => entry.deviceId).filter(Boolean))
        return {
            configured: this.store.configured(),
            connected,
            error,
            router: this.store.publicRouter(),
            devices: entries.map((entry) => {
                const device = entry.deviceId ? this.manager.allDevices[entry.deviceId] : undefined
                return {
                    ...entry,
                    name: entry.customName || entry.detectedName || '-',
                    model: device?.meta.modelId,
                    connected: !!device,
                    dnat: states[entry.entryId],
                    bridgeActive: !!(entry.deviceId && this.bridge?.status(entry.deviceId)),
                    bridgeSaved: !!(entry.deviceId && this.bridge?.hasSavedState(entry.deviceId)),
                    // Offered as a choice rather than applied automatically: only the owner
                    // knows whether the entry was removed by mistake or on purpose.
                    bridgeArchived: !!(entry.deviceId && this.bridge?.hasArchivedState(entry.deviceId)),
                }
            }),
            unassigned: Object.values(this.manager.allDevices)
                .filter((device) => !linkedIds.has(device.id))
                .map((device) => ({
                    deviceId: device.id,
                    name: this.deviceName(device),
                    model: device.meta.modelId,
                    sourceIp: 'sourceIp' in device ? device.sourceIp : undefined,
                })),
        }
    }

    private syncAllDevices() {
        Object.values(this.manager.allDevices).forEach((device) => this.syncDevice(device))
    }

    private syncDevice(device: AnyDevice) {
        const name = this.deviceName(device)
        const sourceIp = 'sourceIp' in device ? device.sourceIp : undefined
        this.store.linkByIp(sourceIp, device.id, name, device.platform)
        this.store.refreshDetectedName(device.id, name)
    }

    private deviceName(device: AnyDevice) {
        return (
            this.bridge?.name(device.id) ||
            this.ha.haDevices.get(device.id)?.config?.device?.name ||
            device.meta.modelName
        )
    }
}

class ConflictError extends Error {}
