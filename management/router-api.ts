import type { Request, Response } from 'express'
import type { WebSocketExpress } from 'websocket-express'
import type { Bridge } from '@/bridge'
import { BridgePolicy, entryMode } from '@/bridge/policy'
import type { AnyDevice, DeviceManager } from '@/cloud/devmgr'
import type HA_bridge from '@/cloud/ha_bridge'
import { RouterConfigStore } from '@/router/config-store'
import { DNATManager, type DNATState } from '@/router/dnat-manager'
import { DNATReconciler } from '@/router/dnat-reconciler'
import log from '@/util/logging'

type Handler = (req: Request, res: Response) => Promise<unknown>

export class RouterAPI {
    readonly store: RouterConfigStore
    readonly reconciler: DNATReconciler

    constructor(
        filename: string,
        readonly ha: HA_bridge,
        readonly manager: DeviceManager,
        readonly bridge: Bridge | undefined,
    ) {
        this.store = bridge?.options?.policy?.store ?? new RouterConfigStore(filename)
        if (bridge && !bridge.options.policy) bridge.options.policy = new BridgePolicy(this.store)
        manager.on('newDevice', (device) => {
            void this.store
                .exclusive(async () => {
                    this.syncDevice(device)
                    await bridge?.reconcile(device.id)
                })
                .catch((err) => log('status', `Device linkage failed: ${err}`))
        })
        bridge?.on('deviceNamesChanged', () => {
            void this.store
                .exclusive(async () => this.syncAllDevices())
                .catch((err) => log('status', `Device names failed: ${err}`))
        })
        manager.allDevices.forEach((device) => {
            this.syncDevice(device)
        })
        this.reconciler = new DNATReconciler(
            this.store,
            () => new DNATManager(this.store.router()),
            undefined,
            undefined,
            async () => {
                await bridge?.reconcileAll()
            },
        )
        this.reconciler.start()
    }

    register(app: WebSocketExpress) {
        app.get(
            '/api/router/config',
            this.wrap(async (_req, res) => res.json(this.store.publicRouter())),
        )

        app.put(
            '/api/router/config',
            this.wrap(async (req, res) => {
                if (this.store.devices().some((entry) => entry.dnatDesired))
                    throw new ConflictError('Turn all DNAT entries off before changing router settings.')
                if (this.store.configured()) {
                    const states = await new DNATManager(this.store.router()).status(this.store.devices())
                    if (Object.values(states).some((state) => state !== 'off'))
                        throw new ConflictError('Release all existing DNAT rules before changing router settings.')
                }
                res.json(this.store.updateRouter(req.body || {}))
            }),
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
                const entry = this.store.addDevice(req.body?.ip, req.body?.mode)
                res.status(201).json(entry)
            }),
        )

        app.put(
            '/api/router/devices/:entryId',
            this.wrap(async (req, res) => {
                const entry = this.store.requireDevice(this.param(req, 'entryId'))
                const changesIdentity = req.body?.ip !== undefined && `${req.body.ip}`.trim() !== entry.ip
                const requestedMode = req.body?.mode
                if (requestedMode !== undefined && requestedMode !== 'dnat' && requestedMode !== 'local')
                    throw new Error('Mode must be dnat or local')
                const changesMode = requestedMode !== undefined && requestedMode !== entryMode(entry)
                if (changesMode) {
                    // The wrapper holds the shared queue: validate against the current entry,
                    // not a mode observed before a concurrent mutation completed.
                    const approval = req.body?.modeTransition
                    if (
                        !approval ||
                        typeof approval !== 'object' ||
                        Array.isArray(approval) ||
                        approval.from !== entryMode(entry) ||
                        approval.to !== requestedMode ||
                        approval.acknowledged !== true
                    )
                        throw new ConflictError(
                            `Review and explicitly approve ${entryMode(entry)} → ${requestedMode} before changing mode. ` +
                                'Acknowledge power-removal Wi-Fi-module reset and target-mode appliance certificate enrollment, ' +
                                'then send modeTransition {from, to, acknowledged: true} matching the current and requested modes. ' +
                                'Approval does not verify physical preparation. Refresh if the mode has changed.',
                        )
                }
                if (changesIdentity || changesMode) await this.requireOff(entry.entryId)
                const previousId = entry.deviceId
                const updated = this.store.updateDevice(entry.entryId, req.body || {})
                if (previousId && changesIdentity) this.bridge?.disable(previousId)
                if (previousId) await this.bridge?.reconcile(previousId)
                res.json(updated)
            }),
        )

        app.delete(
            '/api/router/devices/:entryId',
            this.wrap(async (req, res) => {
                const entryId = this.param(req, 'entryId')
                await this.requireOff(entryId)

                const entry = this.store.requireDevice(entryId)
                if (entry.deviceId) {
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
                const entry = this.store.requireDevice(this.param(req, 'entryId'))
                if (entry.deviceId && entry.deviceId !== req.body?.deviceId) await this.requireOff(entry.entryId)
                const previousId = entry.deviceId
                const deviceId = `${req.body?.deviceId || ''}`
                const device = this.manager.allDevices.get(deviceId)
                if (!device) throw new Error('Rethink device is not connected')
                const linked = this.store.linkDevice(
                    this.param(req, 'entryId'),
                    deviceId,
                    this.deviceName(device),
                    device.platform,
                )
                if (previousId && previousId !== deviceId) this.bridge?.disable(previousId)
                await this.bridge?.reconcile(deviceId)
                res.json(linked)
            }),
        )

        app.delete(
            '/api/router/devices/:entryId/link',
            this.wrap(async (req, res) => {
                const entry = this.store.requireDevice(this.param(req, 'entryId'))
                await this.requireOff(entry.entryId)
                if (entry.deviceId) this.bridge?.disable(entry.deviceId)
                res.json(this.store.unlinkDevice(entry.entryId))
            }),
        )

        app.post(
            '/api/router/dnat/release',
            this.wrap(async (_req, res) => {
                this.requireConfigured()
                const manager = new DNATManager(this.store.router())
                const entries = this.store.devices().filter((entry) => entryMode(entry) === 'dnat')
                // Latch before touching the router; partial failures cannot be undone by a timer.
                for (const entry of entries) this.store.released.add(entry.entryId)
                for (const entry of entries) {
                    await manager.disable(entry)
                    if (entry.deviceId) await this.bridge?.reconcile(entry.deviceId)
                }
                log('status', `Released DNAT for ${entries.length} appliances until explicit enable or restart`)
                res.json({ released: entries.map((entry) => entry.entryId) })
            }),
        )

        app.post(
            '/api/router/devices/:entryId/dnat/enable',
            this.wrap(async (req, res) => {
                this.requireConfigured()
                const entry = this.store.requireDevice(this.param(req, 'entryId'))
                if (entryMode(entry) !== 'dnat')
                    throw new ConflictError('Choose DNAT mode before enabling router forwarding.')
                await new DNATManager(this.store.router()).enable(entry)
                // Recorded only once the router accepted the rules, so a failed attempt
                // does not leave the reconciler chasing a device the user never got on.
                this.store.setDnatDesired(entry.entryId, true)
                this.store.released.delete(entry.entryId)
                if (entry.deviceId) await this.bridge?.reconcile(entry.deviceId)
                res.json(await this.snapshot())
            }),
        )

        app.post(
            '/api/router/devices/:entryId/dnat/disable',
            this.wrap(async (req, res) => {
                this.requireConfigured()
                const entry = this.store.requireDevice(this.param(req, 'entryId'))
                await new DNATManager(this.store.router()).disable(entry)
                // Rules have been released even if saving intent fails; keep forwarding paused.
                this.store.released.add(entry.entryId)
                if (entry.deviceId) await this.bridge?.reconcile(entry.deviceId)
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
                await this.bridge.restore(entry.deviceId)
                res.status(204).end()
            }),
        )

        app.post(
            '/api/router/devices/:entryId/bridge/registration/renew',
            this.wrap(async (req, res) => {
                const entry = this.store.requireDevice(this.param(req, 'entryId'))
                if (!entry.deviceId) throw new Error('No Rethink device is linked to this IP')
                if (!this.bridge) throw new Error('Bridge is not configured')
                await this.bridge.renew(
                    entry.deviceId,
                    typeof req.body?.deviceType === 'string' ? req.body.deviceType : undefined,
                )
                res.status(204).end()
            }),
        )

        app.post(
            '/api/router/devices/:entryId/bridge/resume',
            this.wrap(async (req, res) => {
                const entry = this.store.requireDevice(this.param(req, 'entryId'))
                if (!entry.deviceId) throw new Error('No Rethink device is linked to this IP')
                this.requireLocal(entry.entryId)
                if (!this.bridge) throw new Error('Bridge is not configured')
                await this.bridge.enable(entry.deviceId)
                res.json(await this.snapshot())
            }),
        )

        app.post(
            '/api/router/devices/:entryId/bridge/suspend',
            this.wrap(async (req, res) => {
                const entry = this.store.requireDevice(this.param(req, 'entryId'))
                if (!entry.deviceId || !this.bridge) throw new Error('Bridge is not configured for this device')
                this.requireLocal(entry.entryId)
                this.bridge.disable(entry.deviceId)
                res.json(await this.snapshot())
            }),
        )

        app.delete(
            '/api/router/devices/:entryId/bridge/credentials',
            this.wrap(async (req, _res) => {
                const entry = this.store.requireDevice(this.param(req, 'entryId'))
                if (!entry.deviceId || !this.bridge) throw new Error('Bridge is not configured for this device')
                throw new ConflictError(
                    'Registration is preserved. Use Suspend in Local mode or explicit registration renewal.',
                )
            }),
        )
    }

    private wrap(handler: Handler) {
        return (req: Request, res: Response, next: (err: unknown) => void) => {
            this.store
                .exclusive(async () => handler(req, res))
                .catch((err) => {
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

    private requireLocal(entryId: string) {
        if (entryMode(this.store.requireDevice(entryId)) === 'dnat')
            throw new ConflictError(
                'DNAT forwarding follows DNAT. Use the DNAT control, or turn DNAT off and choose Local mode.',
            )
    }

    private async requireOff(entryId: string) {
        const entry = this.store.requireDevice(entryId)
        if (entry.dnatDesired) throw new ConflictError('Turn DNAT off before changing this entry.')
        if (!this.store.configured() && entryMode(entry) === 'local') return
        if ((await this.stateFor(entryId)) !== 'off')
            throw new ConflictError('Turn DNAT off before changing this entry.')
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
                const device = entry.deviceId ? this.manager.allDevices.get(entry.deviceId) : undefined
                return {
                    ...entry,
                    mode: entryMode(entry),
                    forwardingPaused: this.store.released.has(entry.entryId),
                    ...(entry.deviceId ? this.bridge?.details(entry.deviceId) : {}),
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
            unassigned: Array.from(this.manager.allDevices.values())
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
        this.manager.allDevices.forEach((device) => {
            this.syncDevice(device)
        })
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
