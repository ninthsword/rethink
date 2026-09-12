import { TypedEmitter } from 'tiny-typed-emitter'
import { Device as T1Downstream } from '@/cloud/thinq1/device'
import type { ClipMessage } from '@/cloud/thinq2/clip'
import { Device as T2Downstream } from '@/cloud/thinq2/device'
import log from '@/util/logging'
import type { AnyDevice, DeviceManager } from '../cloud/devmgr'
import * as OAuth2 from './oauth2'
import type { BridgePolicy } from './policy'
import type { BridgeState } from './state'
import { Connection as Thinq1Connection } from './thinq1connection'
import { Connection as Thinq2Connection } from './thinq2connection'
import {
    type Device as ClientDevice,
    type Environment,
    type HomeDevice,
    signInUrl,
    Thinq1Device,
    Thinq2Device,
    Client as ThinqClient,
} from './thinqApi'

type StatusCallback = (status: string) => void
type BridgeOptions = {
    preserveExistingDevices?: boolean
    policy?: BridgePolicy
}

const RECONNECT_PERIOD = 5000

class BridgedDevice {
    // upstream - our connection to the ThinQ cloud
    // downstream - the physical device
    constructor(
        readonly upstream: ClientDevice,
        readonly downstream: AnyDevice,
        readonly changed: () => void,
    ) {
        // we create the functions at runtime so that they have unique identities that can be removed with removeListener
        this.onDownstreamData = (packet: Buffer) => this.forward(() => this.connection?.send(packet))
        this.onDownstreamMessage = (payload: ClipMessage) => {
            this.forward(() => {
                if (this.connection instanceof Thinq2Connection) this.connection.sendMessage(payload)
            })
        }
        this.onDownstreamClose = () => this.destroy()

        if (this.upstream.platformType !== this.downstream.platform) {
            console.warn("Bridge device types don't match")
            return
        }

        if (downstream instanceof T1Downstream) downstream.on('data', this.onDownstreamData)
        if (downstream instanceof T2Downstream) downstream.onBridgeMessage(this.onDownstreamMessage)
        downstream.on('close', this.onDownstreamClose)

        this.reconnectNow()
    }

    onDownstreamData: (packet: Buffer) => void
    onDownstreamMessage: (payload: ClipMessage) => void
    onDownstreamClose: () => void

    private destroyed = false
    connected = false
    error: string | undefined

    connection: Thinq1Connection | Thinq2Connection | undefined

    private forward(action: () => unknown) {
        try {
            action()
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error)
            this.disconnect()
        }
    }

    reconnectNow() {
        try {
            this.connect()
        } catch (error) {
            if (this.destroyed) return
            this.error = error instanceof Error ? error.message : String(error)
            if (this.connection) this.disconnect()
            else {
                clearTimeout(this.reconnectTimeout)
                this.reconnectTimeout = setTimeout(() => this.reconnectNow(), RECONNECT_PERIOD)
                this.reconnectTimeout.unref?.()
                this.changed()
            }
        }
    }

    private connect() {
        if (this.destroyed || this.connection) return
        this.connected = false
        const U = this.upstream
        const D = this.downstream
        if (U instanceof Thinq1Device && D instanceof T1Downstream) {
            const connection = new Thinq1Connection(U)
            this.connection = connection
            // feed the initial state to the connection
            if (D.lastReport) connection.send(D.lastReport)

            connection.on('data', (payload) => {
                if (this.connection === connection) D.send(payload)
            })
            connection.on('close', () => {
                if (this.connection === connection) this.disconnect()
            })
        } else if (U instanceof Thinq2Device && D instanceof T2Downstream) {
            const connection = new Thinq2Connection(U, D.deployProfile)
            this.connection = connection
            connection.on('message', (payload) => {
                if (this.connection === connection) D.forward_message(payload)
            })
            connection.on('close', () => {
                if (this.connection === connection) this.disconnect()
            })
        } else {
            console.warn("Can't connect bridge")
            return
        }
        const events = this.connection as Thinq1Connection
        events.on('connected', () => {
            if (this.destroyed || this.connection !== events) return
            this.connected = true
            this.error = undefined
            this.changed()
        })
        events.on('error', (err) => {
            if (this.destroyed || this.connection !== events) return
            this.connected = false
            this.error = err.message
            log('status', `Bridge ${U.deviceId} error: ${err.message}`)
            this.changed()
        })
    }

    reconnectTimeout: NodeJS.Timeout | undefined

    disconnect() {
        if (this.connection) {
            const connection = this.connection
            this.connection = undefined
            this.connected = false
            connection.destroy()
            this.changed()
            if (this.destroyed) return
            clearTimeout(this.reconnectTimeout)
            this.reconnectTimeout = setTimeout(() => this.reconnectNow(), RECONNECT_PERIOD)
            this.reconnectTimeout.unref?.()
        }
    }

    destroy() {
        this.destroyed = true
        this.connected = false
        if (this.connection) {
            const connection = this.connection
            this.connection = undefined
            connection.destroy()
        }
        if (this.downstream instanceof T1Downstream) {
            this.downstream.removeListener('data', this.onDownstreamData)
        }
        if (this.downstream instanceof T2Downstream) {
            this.downstream.removeBridgeMessageListener(this.onDownstreamMessage)
        }
        this.downstream.removeListener('close', this.onDownstreamClose)
        clearTimeout(this.reconnectTimeout)
        this.reconnectTimeout = undefined
    }
}

type BridgeEvents = {
    loggedIn: () => void
    loggedOut: () => void
    deviceNamesChanged: () => void
    started: (id: string) => void
    stopped: (id: string) => void
    statusChanged: (id: string) => void
}

export class Bridge extends TypedEmitter<BridgeEvents> {
    bridgedDevices = new Map<string, BridgedDevice>()
    deviceNames = new Map<string, string>()
    private generations = new Map<string, number>()
    private pending = new Map<string, Promise<unknown>>()
    private intent = new Map<string, boolean>()

    private serialize<T>(id: string, action: () => Promise<T>): Promise<T> {
        const result = (this.pending.get(id) ?? Promise.resolve()).catch(() => {}).then(action)
        this.pending.set(id, result)
        void result
            .finally(() => {
                if (this.pending.get(id) === result) {
                    this.pending.delete(id)
                    this.emit('statusChanged', id)
                }
            })
            .catch(() => {})
        return result
    }

    mode(id: string) {
        return this.options.policy?.mode(id, this.manager.allDevices.get(id)) ?? 'local'
    }

    wanted(id: string) {
        if (this.mode(id) === 'dnat')
            return this.options.policy?.forwarding(id, this.manager.allDevices.get(id)) ?? false
        return this.state.getEnabled?.(id) ?? this.intent.get(id) ?? this.hasSavedState(id)
    }

    private setIntent(id: string, enabled: boolean) {
        this.state.setEnabled?.(id, enabled)
        this.intent.set(id, enabled)
    }

    details(id: string) {
        const active = this.bridgedDevices.get(id)
        return {
            mode: this.mode(id),
            bridgeEnabled: this.wanted(id),
            bridgeActive: !!active,
            cloudConnected: active?.connected ?? false,
            bridgeSaved: this.hasSavedState(id),
            bridgeArchived: this.hasArchivedState(id),
            bridgeBusy: this.pending.has(id),
            bridgeError: active?.error,
            setupRequired: !this.hasSavedState(id),
        }
    }

    async reconcile(id: string) {
        return this.serialize(id, async () => {
            if (!this.wanted(id)) this.#stop(id)
            else {
                const dev = this.manager.allDevices.get(id)
                if (dev) this.#start(dev)
            }
            this.emit('statusChanged', id)
        })
    }

    async reconcileAll() {
        await Promise.all([...this.manager.allDevices.keys()].map((id) => this.reconcile(id)))
    }

    constructor(
        readonly state: BridgeState,
        readonly manager: DeviceManager,
        readonly options: BridgeOptions = {},
    ) {
        super()
        this.manager.on('newDevice', this.#start.bind(this))
        this.manager.on('dropDevice', this.#stop.bind(this))
        this.manager.allDevices.forEach(this.#start.bind(this))
        void this.refreshDeviceNames()
    }

    #start(dev: AnyDevice) {
        if (!this.wanted(dev.id)) return
        if (this.bridgedDevices.get(dev.id)?.downstream === dev) return
        this.#stop(dev.id)
        const clientDevice = this.loadSavedDevice(dev)
        if (!clientDevice) return

        const bridged = new BridgedDevice(clientDevice, dev, () => this.emit('statusChanged', dev.id))
        this.bridgedDevices.set(dev.id, bridged)
        this.emit('started', dev.id)
    }

    #stop(id: string) {
        this.generations.set(id, (this.generations.get(id) ?? 0) + 1)
        const bridged = this.bridgedDevices.get(id)
        if (bridged) {
            this.bridgedDevices.delete(id)
            this.emit('stopped', id)
            bridged.destroy()
        }
    }

    status(id: string) {
        const dev = this.manager.allDevices.get(id)
        if (!dev) return undefined

        if (this.bridgedDevices.has(id)) return true

        return false
    }

    /** Whether a registration is waiting to be restored after its entry was removed. */
    hasArchivedState(id: string) {
        return this.state.hasArchivedDeviceState(id)
    }

    hasSavedState(id: string) {
        return !!this.state.getDeviceState(id)
    }

    name(id: string) {
        return this.deviceNames.get(id)
    }

    async refreshDeviceNames() {
        const creds = this.state.getCredentials()
        if (!creds) {
            if (this.deviceNames.size) {
                this.deviceNames.clear()
                this.emit('deviceNamesChanged')
            }
            return
        }

        try {
            const client = new ThinqClient(creds.env)
            await client.auth(creds.refreshToken)
            const names = new Map(
                (await client.listDevices())
                    .filter((device) => device.alias)
                    .map((device) => [device.deviceId, device.alias]),
            )
            this.deviceNames = names
            this.emit('deviceNamesChanged')
        } catch (err) {
            console.warn('Unable to load LG ThinQ device names', err)
        }
    }

    /** Ordinary enable only resumes saved registration; pairing is always explicit. */
    async enable(id: string, _devType?: string, _statusCallback?: StatusCallback) {
        if (this.mode(id) === 'dnat') throw new Error('DNAT forwarding follows DNAT. Use the DNAT control.')
        return this.serialize(id, async () => {
            if (!this.hasSavedState(id))
                throw new Error('Registration required. Choose Restore or Set up registration.')
            this.setIntent(id, true)
            const dev = this.manager.allDevices.get(id)
            if (dev) this.#start(dev)
            this.emit('statusChanged', id)
            return true
        })
    }

    disable(id: string) {
        this.setIntent(id, false)
        this.#stop(id)
        this.emit('statusChanged', id)
    }

    async restore(id: string) {
        return this.serialize(id, async () => {
            if (this.hasSavedState(id)) throw new Error('Current registration takes precedence; renewal is explicit.')
            if (!this.state.restoreDeviceState(id)) throw new Error('No archived registration is available to restore.')
            const dev = this.manager.allDevices.get(id)
            if (dev && this.wanted(id)) this.#start(dev)
            this.emit('statusChanged', id)
        })
    }

    async renew(id: string, deviceType?: string, statusCallback?: StatusCallback) {
        return this.serialize(id, async () => {
            const dev = this.manager.allDevices.get(id)
            if (!dev) throw new Error('Appliance is not connected to Rethink. Wait for its next connection.')
            const generation = this.generations.get(id) ?? 0
            const replacement = await this.register(dev, deviceType, statusCallback)
            if (this.manager.allDevices.get(id) !== dev || (this.generations.get(id) ?? 0) !== generation)
                throw new Error(
                    'Appliance or forwarding changed during registration. Previous local registration retained; refresh before retrying.',
                )
            // Persist before replacing the live connection. A failed write retains the old one.
            this.state.setDeviceState(id, replacement.state)
            this.#stop(id)
            if (this.wanted(id)) this.#start(dev)
            this.emit('statusChanged', id)
            return true
        })
    }

    isLoggedIn() {
        return !!this.state.getCredentials()
    }

    async beginLogin(env: Environment): Promise<URL> {
        const client = new ThinqClient(env)
        const base = await client.getUrls()
        return signInUrl(base.webUrl, env.countryCode)
    }

    async completeLogin(env: Environment, url: URL) {
        const client = new ThinqClient(env)
        const base = await client.getUrls()
        const code = url.searchParams.get('code')
        if (!code) return false

        try {
            const token = await OAuth2.fromCode(base.authUrl, code)
            this.state.setCredentials({
                env,
                refreshToken: token.refreshToken,
            })
            await this.refreshDeviceNames()
            this.emit('loggedIn')
            return true
        } catch (_err) {
            return false
        }
    }

    logout() {
        this.state.setCredentials(undefined)
        this.deviceNames.clear()
        this.emit('deviceNamesChanged')
        // Account logout does not erase per-appliance registrations or forwarding intent.
        this.emit('loggedOut')
    }

    async register(device: AnyDevice, deviceType?: string, statusCallback?: StatusCallback) {
        if (!statusCallback) statusCallback = () => {}

        const creds = this.state.getCredentials()
        if (!creds) throw new Error('Not logged in')

        if (!deviceType) deviceType = device.meta.deviceType

        if (!deviceType) throw new Error('Device type must be specified')

        const client = new ThinqClient(creds.env)
        await client.auth(creds.refreshToken)

        let existingDevice: HomeDevice | undefined
        const preserve = this.mode(device.id) === 'dnat' || this.options.preserveExistingDevices
        if (preserve) {
            statusCallback('Checking existing device registration')
            existingDevice = (await client.listDevices()).find((item) => item.deviceId === device.id)
            if (device.platform === 'thinq1' && !existingDevice) {
                // Adding it here would register it as a new "Rethink ..." device, which is
                // the very thing preserve mode exists to avoid. A ThinQ1 appliance carries
                // no pairing material, so there is nothing to rebuild from either.
                throw new Error('Register the appliance in LG ThinQ before bridging it, or turn off preserve mode')
            }
        } else {
            statusCallback('Removing device from home')
            await client.removeDevice(device.id)
        }

        let clientDevice: Thinq1Device | Thinq2Device

        if (device.platform === 'thinq1') {
            const gateway = await client.gateway
            const state = {
                httpServer: gateway.thinq1Uri.replace(/\/api$/, ''),
                rtiServer: gateway.rtiUri,
            }

            clientDevice = new Thinq1Device(device.id, device.meta, state)

            // A ThinQ1 device holds no certificate or pairing secret: the upstream
            // connection identifies it by its id alone, and everything it needs comes from
            // the gateway. So an appliance that is already in the home needs no
            // registration call at all — which is what makes preserve mode possible here.
            if (existingDevice) {
                statusCallback(`Preserving existing device registration (${existingDevice.alias})`)
            } else {
                statusCallback('Adding device to home')
                await client.addDevice(clientDevice, `Rethink ${device.id.substring(0, 8)}`, deviceType)
            }
        } else if (device.platform === 'thinq2') {
            statusCallback('Fetching otp key')
            const otp = await client.prepareNewT2Device()

            const t2 = new Thinq2Device(device.id, device.meta)
            clientDevice = t2

            statusCallback('Registering new device')
            let ciphertext: Buffer
            try {
                ciphertext = await t2.pair(client.env, otp)
            } catch (err) {
                statusCallback('Pairing failed. Make sure that common.lgthinq.com is not redirected')
                throw err
            }

            if (existingDevice) {
                statusCallback(`Preserving existing device registration (${existingDevice.alias})`)
            } else {
                statusCallback('Adding device to home')
                await client.addDevice(
                    clientDevice,
                    `Rethink ${device.id.substring(0, 8)}`,
                    deviceType,
                    ciphertext,
                    preserve,
                )
            }
        } else {
            throw new Error('Unknown device platform')
        }

        statusCallback('LG registration received; saving locally')

        return clientDevice
    }

    loadSavedDevice(device: AnyDevice) {
        const state = this.state.getDeviceState(device.id)
        if (state) {
            if ('rtiServer' in state) {
                // thinq1
                return new Thinq1Device(device.id, device.meta, state)
            } else if ('mqttServer' in state) {
                // thinq2
                return new Thinq2Device(device.id, device.meta, state)
            }
        }

        return undefined
    }
}
