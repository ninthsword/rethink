import { racAirTemp, racPipeTemp } from '@/util/ac_tables'
import { allowExtendedType } from '@/util/casting'
import log from '@/util/logging'
import type * as TLV from '@/util/tlv'
import type { ClimateComponent, Connection, DeviceDiscovery } from '../homeassistant'
import type { Metadata } from '../thinq'
import type { Device as Thinq2Device } from '../thinq2/device'
import HADevice from './base'
import { EnergyMeter, energyTotalComponent as energyTotal } from './energy_meter'
import { type OutdoorUnit, outdoorUnitComponents, outdoorUnitFor } from './outdoor_unit'
import TLVDevice, { type FieldDefinition, marksCapsResponse } from './tlv_device'

type PowerModeChangeHook = () => void
type CheckMode = (arg: number) => boolean

/**
 * Fan and mode encodings, per model.
 *
 * These appliances share a handler but not their raw values. The model data advertises five
 * fan levels on raw 3..7, which is what this file assumed for every model; live captures of
 * the two installed units show otherwise. The window unit runs its five levels one lower, on
 * raw 2..6, which is why a request for raw 7 was silently ignored. The wall unit has three
 * levels plus natural wind on raw 2/4/6/8 and names its fourth mode AI rather than heat.
 *
 * Anything not named here keeps the advertised table: the European RAC_0B0001_WW variant maps
 * to this handler and has not been captured, so it is not moved on the strength of a
 * different appliance's evidence.
 */
type ModelEncoding = {
    fanLevels: readonly string[]
    fanToRaw: Readonly<Record<string, number>>
    modeToRaw: Readonly<Record<string, number>>
    /** Raw value of the mode Home Assistant shows as `auto`, when the model has one. */
    autoRaw?: number
}

function invert(table: Readonly<Record<string, number>>): Record<number, string> {
    return Object.fromEntries(Object.entries(table).map(([name, raw]) => [raw, name]))
}

const ADVERTISED: ModelEncoding = {
    fanLevels: ['level_1', 'level_2', 'level_3', 'level_4', 'level_5', 'natural'],
    fanToRaw: { level_1: 3, level_2: 4, level_3: 5, level_4: 6, level_5: 7, natural: 9 },
    modeToRaw: { cool: 0, dry: 1, fan_only: 2, heat: 4, auto: 6 },
    autoRaw: 6,
}

const MODEL_ENCODINGS: Readonly<Record<string, ModelEncoding>> = {
    WINF_056905_WW: {
        fanLevels: ['level_1', 'level_2', 'level_3', 'level_4', 'level_5'],
        fanToRaw: { level_1: 2, level_2: 3, level_3: 4, level_4: 5, level_5: 6 },
        // This unit advertises no auto mode and none was captured, so only the three it
        // already offered are listed; the fan values are the only part the capture moved.
        modeToRaw: { cool: 0, dry: 1, fan_only: 2 },
    },
    RAC_056905_WW: {
        fanLevels: ['level_1', 'level_2', 'level_3', 'natural'],
        fanToRaw: { level_1: 2, level_2: 4, level_3: 6, natural: 8 },
        modeToRaw: { cool: 0, dry: 1, fan_only: 2, auto: 3 },
        autoRaw: 3,
    },
}

function encodingFor(modelId: string): ModelEncoding {
    return Object.getOwnPropertyDescriptor(MODEL_ENCODINGS, modelId) ? MODEL_ENCODINGS[modelId] : ADVERTISED
}

const VERTICAL_SWING_MODES = [
    'off',
    'swing',
    'position_1',
    'position_2',
    'position_3',
    'position_4',
    'position_5',
    'position_6',
]
const HORIZONTAL_SWING_MODES = [
    'off',
    'swing',
    'focus_left',
    'focus_center',
    'focus_right',
    'position_1',
    'position_2',
    'position_3',
    'position_4',
    'position_5',
]
const HORIZONTAL_SWING_TO_RAW: Record<string, number> = {
    off: 0,
    swing: 100,
    focus_left: 13,
    focus_center: 24,
    focus_right: 35,
    position_1: 1,
    position_2: 2,
    position_3: 3,
    position_4: 4,
    position_5: 5,
}
const HORIZONTAL_RAW_TO_SWING: Record<number, string> = Object.fromEntries(
    Object.entries(HORIZONTAL_SWING_TO_RAW).map(([name, raw]) => [raw, name]),
)

/**
 * The window unit's AI dry strength, on ordinary TLV 0x1f2.
 *
 * Each value was written and then read back in a full state report, and the appliance was off
 * throughout, so this is stored configuration rather than an airflow command: it does not take
 * the power guard the fan and vane controls need.
 */
const AI_DRY_STRENGTH: Record<string, number> = {
    weak_wind: 2,
    medium_wind: 4,
    strong_wind: 6,
}

const TEMPERATURE_STEPS: Record<number, string> = {
    0: 'half_degree',
    1: 'one_degree',
}

const WINF_PUSH_PAYLOAD_LENGTH = 237
const WINF_PUSH_SIGNATURE = Buffer.from([0x01, 0xea, 0x0a, 0x01, 0x14])

export default class Device extends TLVDevice {
    meta: Metadata
    initialValuesReceived: boolean = false
    powerChangeHooks: PowerModeChangeHook[] = []
    powerStatePrev?: boolean
    modeChangeHooks: PowerModeChangeHook[] = []
    modePrev?: string
    private powerTransitionInFrame = false
    airClean: boolean = false
    jetMode: boolean = false
    energySave: boolean = false
    tlvBlacklistDisableTimer: ReturnType<typeof setTimeout> | undefined
    increasedQueryIntervalTimeout: ReturnType<typeof setTimeout> | undefined
    filterUsedTime: number = 0
    filterLifeTime: number = 0
    filterChangedDate: number = 0
    filterInitialQueryTimeout: ReturnType<typeof setTimeout> | undefined
    filterQueryTimer: ReturnType<typeof setInterval> | undefined
    energy: EnergyMeter
    outdoor: OutdoorUnit | undefined

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.meta = meta
        this.energy = new EnergyMeter(thinq.id, (wh) => this.HA.publishProperty(this.id, 'energy_total', wh))
        this.outdoor = outdoorUnitFor(HA.config, thinq.id)
        if (this.outdoor?.isPrimary(thinq.id))
            this.outdoor.attachPrimary((property, value) => this.HA.publishProperty(this.id, property, value))
    }

    override processTLV(tlvArray: TLV.TLV[], canSatisfyValuesResponse: boolean = true) {
        const powerTransitionInFrame =
            this.powerStatePrev !== undefined &&
            tlvArray.some(({ t, v }) => t === 0x1f7 && (v !== 0) !== this.powerStatePrev)
        if (powerTransitionInFrame) {
            const modeTLV = tlvArray.find(({ t }) => t === 0x1f9)?.v
            if (modeTLV !== undefined) this.raw_clip_state[0x1f9] = modeTLV
        }

        const previousFrameState = this.powerTransitionInFrame
        this.powerTransitionInFrame = powerTransitionInFrame
        try {
            super.processTLV(tlvArray, canSatisfyValuesResponse)
        } finally {
            this.powerTransitionInFrame = previousFrameState
        }
    }

    stopTimers() {
        if (this.tlvBlacklistDisableTimer !== undefined) {
            clearTimeout(this.tlvBlacklistDisableTimer)
            this.tlvBlacklistDisableTimer = undefined
        }

        if (this.increasedQueryIntervalTimeout !== undefined) {
            clearTimeout(this.increasedQueryIntervalTimeout)
            this.increasedQueryIntervalTimeout = undefined
        }

        if (this.filterInitialQueryTimeout !== undefined) {
            clearTimeout(this.filterInitialQueryTimeout)
            this.filterInitialQueryTimeout = undefined
        }

        if (this.filterQueryTimer !== undefined) {
            clearInterval(this.filterQueryTimer)
            this.filterQueryTimer = undefined
        }

        // Its last reading must not go on standing for the shared outdoor unit.
        this.outdoor?.forget(this.id)

        super.stopTimers()
    }

    processPrivData(cmd: number, buf9: number, data: Buffer) {
        if (cmd === 0x02) this.processFilterData(buf9, data)
    }

    processPrivDataCmdResp(success: boolean, _buf1: number, cmd: number, data: Buffer) {
        if (cmd === 0x2) this.processFilterCmdResp(success, data)
    }

    /**
     * Decode the WINF fixed-record fields that moved with the corresponding TLV in repeated
     * paired captures. A later labelled session exercised the core controls, so power, mode,
     * fan, the horizontal vane and both temperatures are correlated too; mode turned out to
     * sit at 10 rather than the 8 the earlier documentation had proposed. Offsets no capture
     * has moved stay in the documentation rather than becoming executable guesses.
     */
    protected override decodePushData(payload: Buffer): TLV.TLV[] | undefined {
        if (
            this.meta.modelId !== 'WINF_056905_WW' ||
            payload.length !== WINF_PUSH_PAYLOAD_LENGTH ||
            !payload.subarray(1, 6).equals(WINF_PUSH_SIGNATURE)
        )
            return undefined

        return [
            // Core state, each offset correlated with the matching TLV in a labelled capture.
            // Mode is at 10, not the 8 the earlier documentation proposed as a candidate.
            { t: 0x1f7, v: payload[9] },
            { t: 0x1f9, v: payload[10] },
            { t: 0x1fa, v: payload[12] },
            { t: 0x322, v: payload[14] },
            { t: 0x1fe, v: payload[25] },
            { t: 0x1fd, v: payload[26] },
            // Diagnostics, correlated earlier.
            { t: 0x6c, v: payload[143] },
            { t: 0x32c, v: payload[107] },
            { t: 0x330, v: payload[146] },
            { t: 0x2b3, v: payload.readUInt16BE(233) },
        ]
    }

    /** WINF pushes contain only the fields with evidence-backed offsets, not a full state. */
    protected override isCompletePushSnapshot(_tlvArray: TLV.TLV[]): boolean {
        return false
    }

    sendFilterQuery() {
        this.sendPrivCommand(0x02, 0x02)
    }

    sendFilterReset() {
        if (!this.filterLifeTime) throw new Error('Filter lifetime not known')

        const now = new Date()
        const date = now.getUTCFullYear() * 10000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate()

        const buf = Buffer.alloc(4 * 3)
        // yes, it's opposite endianness vs read cmd
        buf.writeUInt32BE(this.filterLifeTime, 1 * 4)
        buf.writeUInt32BE(date, 2 * 4)

        log('status', this.id, 'sending filter reset')
        this.sendPrivCommand(0x02, 0x01, buf)
    }

    isCapsResponse(tlvArray: TLV.TLV[]) {
        return marksCapsResponse(tlvArray)
    }

    isValuesResponse(tlvArray: TLV.TLV[]) {
        /* power */
        return tlvArray.length >= 10 && tlvArray.some(({ t }) => t === 0x1f7)
    }

    valuesReceived() {
        if (this.initialValuesReceived) return
        this.initialValuesReceived = true

        // we want to be informed about all TLV changes - set an empty blacklist
        this.thinq.send('setMaskingInfo', 0, { blacklist_tlv: '1200' })

        // give modem some time to process the command before continuing
        this.tlvBlacklistDisableTimer = setTimeout(() => {
            this.tlvBlacklistDisableTimer = undefined

            if (!(this.raw_clip_state[0x2f1] & 1 || this.raw_clip_state[0x2f1] & 0x200)) {
                // no mFilter, check basic filter management support
                this.initProbeForFilter()
            } else {
                // unsupported mFilter management support
                this.initMakeSetConfig()
            }
        }, 500)
    }

    initProbeForFilter() {
        log('status', this.id, 'sending initial filter data query')
        this.sendFilterQuery()

        this.filterInitialQueryTimeout = setTimeout(() => {
            this.filterInitialQueryTimeout = undefined

            log('status', this.id, 'filter data query timeout, assuming no filter')
            this.initMakeSetConfig()
        }, 5 * 1000)
    }

    processFilterData(_buf9: number, data: Buffer) {
        if (data.length < 1 + 3 * 4) {
            log('status', this.id, 'filter data too short:', data.length)
            return
        }

        this.filterUsedTime = data.readUInt32LE(1 + 0 * 4)
        this.filterLifeTime = data.readUInt32LE(1 + 1 * 4)
        this.filterChangedDate = data.readUInt32LE(1 + 2 * 4)

        // if this was the initial filter query the device config is ready now
        if (this.filterInitialQueryTimeout !== undefined) {
            log('status', this.id, 'received initial filter data')

            clearTimeout(this.filterInitialQueryTimeout)
            this.filterInitialQueryTimeout = undefined

            this.initMakeSetConfig()
        } else {
            // if this was not the initial query just update the HA values
            this.publishFilterData()
        }
    }

    publishFilterData() {
        const changedDate =
            Math.floor(this.filterChangedDate / 10000)
                .toString()
                .padStart(4, '0') +
            '-' +
            (Math.floor(this.filterChangedDate / 100) % 100).toString().padStart(2, '0') +
            '-' +
            (this.filterChangedDate % 100).toString().padStart(2, '0')

        this.HA.publishProperty(this.id, 'filterused', this.filterUsedTime)
        this.HA.publishProperty(this.id, 'filterlife', this.filterLifeTime)
        /*
         * An appliance whose filter has never been reset reports the date as zero, which
         * formats to 0000-00-00. That is not a date, and the sensor carries device_class
         * date, so Home Assistant rejects the message and logs a warning every time the
         * appliance reconnects — forty-four of them on the bedroom unit alone, while the
         * sensor sat at unknown regardless. Clear the old retained value as well as declining
         * to replace it, otherwise a value published by an older rethink survives forever.
         */
        if (this.filterLifeTime > 0) {
            const remaining = Math.max(
                0,
                Math.min(100, Math.floor((1 - this.filterUsedTime / this.filterLifeTime) * 100)),
            )
            this.HA.publishProperty(this.id, 'filterremaining', remaining)
        }
        if (this.filterChangedDate > 0) this.HA.publishProperty(this.id, 'filterchangeddate', changedDate)
        else this.HA.clearRetainedProperty(this.id, 'filterchangeddate')
    }

    processFilterCmdResp(success: boolean, _data: Buffer) {
        if (!success) {
            log('status', this.id, 'filter reset failed')
            return
        }

        log('status', this.id, 'filter reset okay, re-querying')
        this.sendFilterQuery()
    }

    updateClimateAction() {
        // also updates query interval
        const modeTLV = this.getModeTLV()

        let iduRunning = true
        const iduRunningTLVNum = this.getIDUActionRunningTLVNum()
        if (iduRunningTLVNum != null) {
            iduRunning = this.raw_clip_state[iduRunningTLVNum] !== 0
        }

        const modes2ha = ['cooling', 'drying', 'fan', undefined, 'heating']
        const { autoRaw } = encodingFor(this.meta.modelId)
        const autoMode = autoRaw !== undefined && modeTLV === autoRaw
        let action: string | undefined
        let increaseQueryInterval = false
        if (this.getPowerTLV() === 0) {
            action = 'off'
        } else if ((modeTLV === 0 || modeTLV === 1 || modeTLV === 4 || autoMode) && !iduRunning) {
            action = 'idle'
        } else if (autoMode) {
            // TODO: figure out how to detect the actual running mode in Auto
            // For now, clear the reported action.
            action = 'None'
            increaseQueryInterval = true // assume it is running
        } else {
            action = modes2ha[modeTLV]
            increaseQueryInterval = action != null && action !== 'fan'
        }

        if (action != null) this.HA.publishProperty(this.id, 'climate-action', action)
        this.updateQueryInterval(increaseQueryInterval)
    }

    updateQueryInterval(increaseQueryInterval: boolean) {
        if (increaseQueryInterval) {
            if (this.increasedQueryIntervalTimeout !== undefined) {
                clearTimeout(this.increasedQueryIntervalTimeout)
                this.increasedQueryIntervalTimeout = undefined
            }

            /*
             * When in one of active modes update more frequently
             * since parameters can change rapidly:
             * every a bit less than half a minute.
             *
             * This matches the observed ODU parameter recalculation intervals:
             * compressor Hz - every 30 seconds,
             * EEV openings - every 30 seconds during transient periods.
             */
            this.setQueryInterval((30 - 2) * 1000)
        } else if (this.increasedQueryIntervalTimeout == null) {
            /*
             * Reset to the default interval after 15 minutes,
             * hopefully things returned to steady idle state by this time.
             */
            this.increasedQueryIntervalTimeout = setTimeout(
                () => {
                    this.increasedQueryIntervalTimeout = undefined
                    this.setQueryInterval()
                },
                15 * 60 * 1000,
            )
        }
    }

    getPowerTLV() {
        return this.raw_clip_state[0x1f7]
    }

    getModeTLV() {
        return this.raw_clip_state[0x1f9]
    }

    getIDUActionRunningTLVNum() {
        if (this.raw_clip_state[0x189] != null) {
            return 0x189 // IDUThermoOnOff
        }
        if (this.raw_clip_state[0x6c] != null) {
            return 0x6c
        }

        return undefined
    }

    initMakeSetConfig() {
        const isWinf = this.meta.modelId === 'WINF_056905_WW'
        const encoding = encodingFor(this.meta.modelId)
        const config: DeviceDiscovery & { components: { climate: ClimateComponent } } = allowExtendedType({
            ...HADevice.config(this.meta, { name: 'LG Air Conditioner' }),
            components: {
                climate: {
                    platform: 'climate',
                    unique_id: '$deviceid-climate',
                    name: null,
                    action_topic: '$this/climate-action',
                    temperature_unit: 'C',
                    /* TODO: detect 0.5 C vs 1 C step */
                    temp_step: 0.5,
                    precision: 0.5,
                    /* TODO: some devices report these temp ranges via tags 0x2e1 - 0x2ec */
                    min_temp: 18,
                    max_temp: 30,
                    // The Korean RAC here is cooling only: its panel has no heating mode and
                    // selecting one in Home Assistant did nothing. WINF has no auto either.
                    modes: isWinf ? ['off', 'cool', 'dry', 'fan_only'] : ['off', 'cool', 'dry', 'fan_only', 'auto'],
                    // The Korean RAC/WINF model data advertises raw 3..7 as five fan levels.
                    // RAC additionally advertises raw 9 (natural wind); WINF does not.
                    fan_modes: [...encoding.fanLevels],
                    /* TODO: get allowed op modes from 0x2c1 */
                } satisfies ClimateComponent,
            },
        })

        this.addField(config, {
            id: 0x1fd,
            name: 'current_temperature',
            comp: 'climate',
            state_topic: 'topic',
            writable: false,
            read_xform: (raw) => raw / 2,
        })
        this.addField(config, {
            id: 0x1f7,
            name: 'power',
            comp: 'climate',
            readable: false,
            write_xform: (val) => (val === 'ON' ? 1 : 0),
            /*  0x1f7 is not necessary for ON but does not seem to hurt either */
            write_attach: (raw) => (raw ? [0x1f9, 0x1fa, 0x1fe] : []),
            read_xform: (raw) => (raw ? 'ON' : 'OFF'),
            read_callback: (val) => {
                // update 'mode' instead
                this.processKeyValue(0x1f9, this.raw_clip_state[0x1f9])

                const powerState = val === 'ON'
                /*
                 * Only a change the appliance actually made. The first reading after rethink
                 * starts is not one: the appliance has been sitting there with its own
                 * settings, and treating it as a power-up made every restart re-apply three
                 * of them — five writes, five beeps from a bedroom air conditioner, and
                 * every one of them OFF because the values they re-apply had not been read
                 * back yet. The re-apply is for the appliance's own power-up, which rethink
                 * sees as a change from a state it had already recorded.
                 */
                if (this.powerStatePrev !== undefined && this.powerStatePrev !== powerState)
                    for (const hook of this.powerChangeHooks) hook()
                this.powerStatePrev = powerState

                return false
            },
        })

        this.addField(config, {
            id: 0x1f9,
            name: 'mode',
            comp: 'climate',
            read_xform: (raw) => {
                if (this.getPowerTLV() === 0) return 'off'
                return invert(encoding.modeToRaw)[raw]
            },
            read_callback: (val) => {
                if (typeof val !== 'string') return true
                // As with power: the first reading tells us where the appliance is, not that
                // it moved. See the power branch above. A complete state frame can contain both
                // a mode and power transition in either order. The raw power may already have
                // been updated optimistically while building an HA command, so the current raw
                // value alone cannot establish ownership; processTLV marks the frame before
                // callbacks run and lets the power callback reapply settings once.
                const powerTLV = this.getPowerTLV()
                const powerStable =
                    powerTLV !== undefined &&
                    this.powerStatePrev !== undefined &&
                    (powerTLV !== 0) === this.powerStatePrev
                if (this.modePrev !== undefined && this.modePrev !== val && !this.powerTransitionInFrame && powerStable)
                    for (const hook of this.modeChangeHooks) hook()
                this.modePrev = val
                return true
            },
            write_xform: (val) => {
                if (val === 'off') {
                    // Call function power (0x1f7) with value OFF
                    this.setProperty('climate-power', 'OFF')
                    return null
                }
                return encoding.modeToRaw[val]
            },
            /*
             * The appliance ignores a mode written while it is off: the frame carries no 0x1f7
             * and it stays off, so the card snaps back to off. Powering on in the same frame
             * is what makes choosing a mode from off do what the card implies.
             *
             * The power value has to be put into raw_clip_state here rather than in a
             * write_callback, because the callback runs first and would make this test of the
             * old state look like the appliance was already on.
             */
            write_attach: () => {
                if (this.getPowerTLV() !== 0) return [0x1fa, 0x1fe]
                this.raw_clip_state[0x1f7] = 1
                return [0x1f7, 0x1fa, 0x1fe]
            },
        })

        this.addField(config, {
            id: 0x1fa,
            name: 'fan_mode',
            comp: 'climate',
            read_xform: (raw) => invert(encoding.fanToRaw)[raw],
            write_xform: (val) => encoding.fanToRaw[val],
            write_attach: [0x1f9, 0x1fe],
            write_callback: () => this.allowAirflowWriteWhilePowered(),
        })

        this.addField(config, {
            id: 0x1fe,
            name: 'temperature',
            comp: 'climate',
            read_xform: (raw) => raw / 2,
            write_xform: (val) => Math.round(Number(val) * 2),
            write_attach: [0x1f9, 0x1fa],
        })

        if (this.raw_clip_state[0x2cd] & 4) {
            config.components.climate.swing_modes = VERTICAL_SWING_MODES
            this.addField(config, {
                id: 0x321,
                name: 'swing_mode',
                comp: 'climate',
                read_xform: (raw) =>
                    raw === 0 ? 'off' : raw === 100 ? 'swing' : raw >= 1 && raw <= 6 ? `position_${raw}` : undefined,
                write_xform: (val) => {
                    const modes2clip: Record<string, number> = {
                        off: 0,
                        swing: 100,
                        position_1: 1,
                        position_2: 2,
                        position_3: 3,
                        position_4: 4,
                        position_5: 5,
                        position_6: 6,
                    }
                    return modes2clip[val]
                },
                write_callback: () => this.allowAirflowWriteWhilePowered(),
            })
        }

        if (this.raw_clip_state[0x2cd] & 8) {
            // The master-bedroom RAC model data has no raw 24 (centre focus), while the
            // small-room WINF model does. Do not advertise a command unsupported by RAC.
            config.components.climate.swing_horizontal_modes = isWinf
                ? HORIZONTAL_SWING_MODES
                : HORIZONTAL_SWING_MODES.filter((mode) => mode !== 'focus_center')
            this.addField(config, {
                id: 0x322,
                name: 'swing_horizontal_mode',
                comp: 'climate',
                read_xform: (raw) => HORIZONTAL_RAW_TO_SWING[raw],
                write_xform: (val) => HORIZONTAL_SWING_TO_RAW[val],
                write_callback: () => this.allowAirflowWriteWhilePowered(),
            })
        }

        this.addOptionalSensorField(config, 0x221, 'error', 'Error code', 'mdi:alert')
        this.addOptionalSensorField(config, 0x333, 'pm1', 'PM1.0', undefined, {
            device_class: 'pm1',
            unit_of_measurement: 'µg/m³',
            state_class: 'measurement',
        })
        this.addOptionalSensorField(config, 0x334, 'pm25', 'PM2.5', undefined, {
            device_class: 'pm25',
            unit_of_measurement: 'µg/m³',
            state_class: 'measurement',
        })
        this.addOptionalSensorField(config, 0x335, 'pm10', 'PM10', undefined, {
            device_class: 'pm10',
            unit_of_measurement: 'µg/m³',
            state_class: 'measurement',
        })
        this.addOptionalSensorField(
            config,
            0x32e,
            'capacity',
            'Capacity nominal',
            undefined,
            {
                device_class: 'power',
                unit_of_measurement: 'kW',
                suggested_display_precision: 1,
            },
            (raw) => (raw !== 0 ? Math.round(raw * 0.293 * 10) / 10 : undefined),
        ) // raw is in kBTU / hour

        /*
         * Whether the IDU will report its EEV opening correctly during its
         * active operation is highly inconsistent between IDUs.
         * For example, from two Standard2 IDUs with 0x690409 software version
         * connected to common ODU one IDU works as expected while the other
         * one reports the EEV opening value of the other Standard2 IDU (?).
         * This may be an ODU firmware bug. On the other hand, another Deluxe
         * IDU connected to the same ODU always reports correct EEV values.
         * None of tested IDUs seem to usually notify by itself when this value changes.
         */
        this.addOptionalSensorField(config, 0x330, 'eev', 'EEV opening', 'mdi:valve', {
            state_class: 'measurement',
            suggested_display_precision: 0,
        })

        /*
         * IDUs send notifications about the updates of the temperatures below
         * at their own pace, sometimes in clusters with other attributes.
         * Deluxe IDUs send notifications noticeably more often than Standard2 IDUs.
         *
         * Pipe temps are sometimes reported as 0 (-100 C) for a moment after a shutdown.
         * Make sure to filter out such updates.
         */
        this.addOptionalSensorTempField(
            config,
            0x2f9,
            'pipeintemp',
            'Pipe liquid temperature',
            'mdi:pipe',
            (raw) => racPipeTemp[255 - raw],
        )
        this.addOptionalSensorTempField(
            config,
            0x2fa,
            'pipeouttemp',
            'Pipe gas temperature',
            'mdi:pipe',
            (raw) => racPipeTemp[255 - raw],
        )

        this.addOptionalSensorTempField(
            config,
            [0x7a, 0x32c],
            'oduhextemp',
            'ODU HEX temperature', // "HEX" = "heat exchanger"
            'mdi:heating-coil',
            (raw) => racPipeTemp[255 - raw],
        )
        this.addOptionalSensorTempField(
            config,
            0x332,
            'oduairtemp',
            'ODU air temperature',
            'mdi:thermometer-lines',
            (raw) => racAirTemp[255 - raw],
        )

        /*
         * [ 0x22a, 0x32f ] - ODU compressor Hz. Standard2 IDUs even notify about the former
         * tag changes. The value is capped at 15 Hz regardless of the actual compressor
         * speed, which is why it is not published as a speed — but the cap does not touch
         * the one thing it says plainly, which is whether the compressor is turning at all.
         *
         * Measured over 287 samples from the two units that send it: 15 Hz went with 242 to
         * 263 W on the small room unit and 0 Hz with 57 to 66 W, the difference between a
         * compressor and a fan. The intermediate 1 and 9 appeared while it was ramping.
         *
         * It describes the outdoor unit, not the head that sends it. The bedroom unit
         * reported 15 Hz while switched off and drawing standby, in the same minute its
         * 2-in-1 partner was drawing 473 W. So on a shared unit the reading goes to the
         * group, untouched by the sender's own power; on an appliance with an outdoor unit
         * to itself, a compressor cannot be turning while the appliance is off.
         */
        if (this.outdoor) {
            /*
             * No component of its own: the group publishes this on the primary appliance,
             * so this registration exists only to be handed the value. autoreg false and a
             * callback returning false keep it from reaching for a component that is not
             * there — attaching topics to config.components[''] throws, and the exception
             * takes the whole configure() call with it, leaving the appliance with no Home
             * Assistant device at all.
             */
            this.addField(
                config,
                {
                    id: 0x22a,
                    name: 'outdoor_compressor',
                    comp: '',
                    readable: false,
                    writable: false,
                    read_callback: (value) => {
                        if (typeof value === 'number') this.outdoor?.reportCompressor(value > 0)
                        return false
                    },
                },
                false,
            )
        } else {
            config.components.compressor = allowExtendedType({
                platform: 'binary_sensor',
                unique_id: '$deviceid-compressor',
                state_topic: '$this/compressor',
                name: 'Compressor',
                device_class: 'running',
                icon: 'mdi:air-conditioner',
            })
            this.addField(config, {
                id: 0x22a,
                name: '',
                comp: 'compressor',
                writable: false,
                read_xform: (raw) => (this.getPowerTLV() !== 0 && raw > 0 ? 'ON' : 'OFF'),
            })
        }

        // 0x2fb is the target fan RPM, while this is the current RPM
        this.addOptionalSensorField(
            config,
            0x331,
            'fanrpm',
            'Fan RPM',
            'mdi:fan',
            {
                state_class: 'measurement',
                unit_of_measurement: 'rpm',
                suggested_display_precision: 0,
            },
            (raw) => raw * 10,
        )

        if (this.raw_clip_state[0x2cc] & 1) {
            this.addModeDependentConfigSwitchField(
                config,
                0x20f,
                'airclean',
                /* Same desc as in lg_thinq */
                'Air purify',
                'mdi:air-purifier',
                'airClean',
            )
        }

        // Confirmed on the WINF panel: the sound button reports 0x3a0, inverted the same
        // way as the display, and the dehumidifiers store their button sound on the same
        // tag with the same meaning. The RAC in this home has neither this nor the
        // temperature step button, so both stay with the model that has them.
        if (isWinf) {
            config.components.sound = allowExtendedType({
                platform: 'switch',
                unique_id: '$deviceid-sound',
                name: 'Sound',
                icon: 'mdi:volume-high',
                entity_category: 'config',
            })
            this.addField(config, {
                id: 0x3a0,
                name: '',
                comp: 'sound',
                read_xform: (raw) => (raw ? 'OFF' : 'ON'),
                write_xform: (value) => (value === 'ON' ? 0 : 1),
            })

            // The temperature step the appliance's own panel switches between. Confirmed by
            // pressing the button: 0x1fb reads 1 for whole degrees and 0 for half degrees.
            config.components.temperature_step = allowExtendedType({
                platform: 'select',
                unique_id: '$deviceid-temperature_step',
                name: 'Temperature step',
                icon: 'mdi:thermometer-lines',
                entity_category: 'config',
                options: Object.values(TEMPERATURE_STEPS),
            })
            this.addField(config, {
                id: 0x1fb,
                name: '',
                comp: 'temperature_step',
                read_xform: (raw) => TEMPERATURE_STEPS[raw],
                write_xform: (value) => (value === TEMPERATURE_STEPS[1] ? 1 : 0),
                read_callback: (value) => {
                    this.applyTemperatureStep(value === TEMPERATURE_STEPS[1] ? 1 : 0.5)
                    return true
                },
            })
        }

        // Confirmed on the appliance panel: pressing the display button reports 0x21f,
        // and the value is inverted — 1 is the display switched off.
        config.components.display = allowExtendedType({
            platform: 'switch',
            unique_id: '$deviceid-display',
            name: 'Display',
            icon: 'mdi:television-ambient-light',
            entity_category: 'config',
        })
        this.addField(config, {
            id: 0x21f,
            name: '',
            comp: 'display',
            read_xform: (raw) => (raw ? 'OFF' : 'ON'),
            write_xform: (value) => (value === 'ON' ? 0 : 1),
        })

        const jetCool: boolean = !!(this.raw_clip_state[0x2cd] & 1)
        const jetHeat: boolean = !!(this.raw_clip_state[0x2cd] & 2)
        if (jetCool || jetHeat) {
            this.addJetField(config, 0x323, 'jet', 'Jet', 'mdi:wind-power', jetCool, jetHeat)
        }

        if (isWinf) {
            config.components.ai_dry_strength = allowExtendedType({
                platform: 'select',
                unique_id: '$deviceid-ai-dry-strength',
                name: 'AI dry strength',
                icon: 'mdi:weather-windy',
                options: Object.keys(AI_DRY_STRENGTH),
                entity_category: 'config',
            })

            this.addField(config, {
                id: 0x1f2,
                name: '',
                comp: 'ai_dry_strength',
                read_xform: (raw) => invert(AI_DRY_STRENGTH)[raw],
                write_xform: (val) => AI_DRY_STRENGTH[val],
            })
        }

        const sleepCountdown = { component: 'sleep_time', name: 'Sleep time', icon: 'mdi:weather-night' }
        if (isWinf) {
            // WINF reports and accepts the sleep countdown on 0x21a even though its extended
            // capability bitmap does not use the legacy bit. Match the other ACs' number entity.
            this.addTimerField(config, 0x21a, 'sleeptimer', 'Sleep timer', 'mdi:bed-clock', 12, true, sleepCountdown)
        } else if (this.raw_clip_state[0x2d3] & 1) {
            // 15h - displayed in hex as "FH"
            this.addTimerField(config, 0x21a, 'sleeptimer', 'Sleep timer', 'mdi:bed-clock', 15, false, sleepCountdown)
        }

        if (this.raw_clip_state[0x2d3] & 4) {
            this.addTimerField(config, 0x21c, 'starttimer', 'Turn-on timer', 'mdi:timer-play', 24, false, {
                component: 'start_time',
                name: 'Start time',
                icon: 'mdi:timer-play-outline',
            })
            this.addTimerField(config, 0x21b, 'stoptimer', 'Turn-off timer', 'mdi:timer-stop', 24, false, {
                component: 'stop_time',
                name: 'Stop time',
                icon: 'mdi:timer-stop-outline',
            })
        }

        if (this.raw_clip_state[0x2cc] & 2) {
            // Can be enabled only when running in the cooling mode
            this.addModeDependentConfigSwitchField(
                config,
                0x20d,
                'energysave',
                'Energy saving',
                'mdi:flower',
                'energySave',
                (mode) => mode === 0,
            )
        }

        if (this.raw_clip_state[0x2cc] & 4) {
            /*
             * Read-only on purpose. Both rethink and the SmartThinQ cloud path wrote 0x20e and
             * both writes were acknowledged on the wire, yet the appliance's state did not
             * move; only holding the remote's automatic-dry button for three seconds changed
             * it. A switch that reports back whatever it was set to is worse than a sensor
             * that tells the truth, so this stays a reading until a distinct network command
             * for it is actually captured.
             */
            const compADry = {
                platform: 'binary_sensor',
                unique_id: '$deviceid-autodry',
                name: 'Auto dry',
                icon: 'mdi:hair-dryer',
                entity_category: 'diagnostic',
            }
            const compADryRem = {
                platform: 'sensor',
                unique_id: '$deviceid-autodryremain',
                name: 'Auto dry remaining',
                icon: 'mdi:hair-dryer-outline',
                unit_of_measurement: '%',
                suggested_display_precision: 0,
                entity_category: 'diagnostic',
            }
            config.components.autodry = compADry
            config.components.autodryremain = compADryRem

            this.addField(config, {
                id: 0x20e,
                name: '',
                comp: 'autodry',
                writable: false,
                read_xform: (raw) => (raw ? 'ON' : 'OFF'),
            })

            this.addField(config, {
                id: 0x225,
                name: '',
                comp: 'autodryremain',
                writable: false,
            })
        }

        if (this.getIDUActionRunningTLVNum() != null) {
            this.addField(
                config,
                {
                    id: this.getIDUActionRunningTLVNum(),
                    name: 'action',
                    comp: 'climate',
                    read_callback: (_val) => {
                        this.updateClimateAction()
                        return false
                    },
                },
                false,
            )
        }

        this.powerChangeHooks.push(() => {
            this.updateClimateAction()
        })
        this.modeChangeHooks.push(() => {
            this.updateClimateAction()
        })

        // 0x21f - "display light" value is inverted in some devices,
        // but in some devices it is not - not shown in ThinQ app either

        if (this.filterLifeTime) {
            const filterRemaining = {
                platform: 'sensor',
                unique_id: '$deviceid-filterremaining',
                state_topic: '$this/filterremaining',
                name: 'Filter Remaining Life',
                icon: 'mdi:air-filter',
                unit_of_measurement: '%',
                state_class: 'measurement',
            }
            config.components.filterremaining = filterRemaining
            const filterUsed = {
                platform: 'sensor',
                unique_id: '$deviceid-filterused',
                state_topic: '$this/filterused',
                name: 'Filter used time',
                icon: 'mdi:air-filter',
                device_class: 'duration',
                unit_of_measurement: 'h',
                state_class: 'total_increasing',
                entity_category: 'diagnostic',
            }
            config.components.filterused = filterUsed
            const filterLife = {
                platform: 'sensor',
                unique_id: '$deviceid-filterlife',
                state_topic: '$this/filterlife',
                name: 'Filter life time',
                icon: 'mdi:air-filter',
                device_class: 'duration',
                unit_of_measurement: 'h',
                entity_category: 'diagnostic',
            }
            config.components.filterlife = filterLife
            const filterChanged = {
                platform: 'sensor',
                unique_id: '$deviceid-filterchangeddate',
                state_topic: '$this/filterchangeddate',
                name: 'Filter usage last reset',
                icon: 'mdi:calendar-refresh-outline',
                device_class: 'date',
                entity_category: 'diagnostic',
            }
            config.components.changeddate = filterChanged

            const filterReset = {
                platform: 'button',
                unique_id: '$deviceid-filterreset',
                command_topic: '$this/filterreset/set',
                name: 'Reset filter usage',
                icon: 'mdi:calendar-refresh-outline',
                entity_category: 'diagnostic',
            }
            config.components.filterreset = filterReset
            this.fields_by_ha.filterreset = {
                name: '',
                comp: '',
                write_xform: (val) => (val === 'PRESS' ? 1 : 0),
                write_callback: (val) => {
                    if (val === 1) this.sendFilterReset()
                    return false
                },
            }
        }

        // this value is reported as zero by multi-split units
        if (this.raw_clip_state[0x2b3]) {
            const energyCurrent = {
                platform: 'sensor',
                unique_id: '$deviceid-energy_current',
                state_topic: '$this/energy_current',
                name: 'Power',
                device_class: 'power',
                unit_of_measurement: 'W',
                state_class: 'measurement',
                suggested_display_precision: 0,
            }

            config.components.energy_current = energyCurrent
            /*
             * An appliance that says what it is drawing can also say what it has used. Where
             * an outdoor unit is shared, though, this reading is the outdoor unit's and not
             * this head's, so the total belongs to the group and lives on its primary
             * appliance — one total for one compressor.
             */
            if (this.outdoor) {
                if (this.outdoor.isPrimary(this.id)) Object.assign(config.components, outdoorUnitComponents())
            } else config.components.energy_total = energyTotal()

            /*
             * The reading is in watts and needs nothing taken off it. This file used to
             * subtract sixty from every value for a "bias of +50"; measured against the
             * whole-house meter, that bias is a standby artefact and not an offset on
             * running values — switched off, these units keep reporting around fifty, which
             * is a placeholder rather than a measurement. So standby is shown as zero watts
             * and everything else is passed through, which is what ha-smartthinq-sensors
             * does with the same field.
             *
             * Confirmed by running the bedroom unit alongside the living-room one on the
             * same outdoor unit: its raw value tracked the living room's within twenty-five
             * watts across seven samples — its own indoor fan — while the subtraction was
             * making it read thirty-five watts lower than a unit measuring the same thing.
             */
            this.addField(config, {
                id: 0x2b3,
                name: '',
                comp: 'energy_current',
                writable: false,
                read_xform: (raw) => (this.getPowerTLV() === 0 ? 0 : Math.max(5, raw)),
                // Whatever correction the reading needs, the total is added up from the
                // corrected figure — the same one the sensor shows.
                read_callback: (value) => {
                    if (typeof value !== 'number') return true
                    const running = this.getPowerTLV() !== 0
                    if (this.outdoor) this.outdoor.report(this.id, value, running)
                    else this.energy.integratePower(value, Date.now(), running)
                    return true
                },
            })
            if (this.outdoor) this.outdoor.publish()
            else this.energy.publish()
        }

        // Earlier builds published the sleep countdown as a select on this component id.
        // The duplicate was observed on both the WINF and the installed RAC, so retire the
        // old select for every variant before publishing the number entity. Home Assistant
        // does not remove an entity merely because the component platform changed.
        this.setConfig(config, {
            // Auto dry is a reading again, because the appliance ignores writes to it. Home
            // Assistant keeps the old entity when a component changes platform, so the switch
            // it was published as in between has to be retired by name.
            autodry: { platform: 'switch' },
            sleeptimer: { platform: 'select' },
            // A head on a shared outdoor unit had a total of its own before the group took
            // it over; left alone it would sit there counting the same compressor again.
            ...(this.outdoor ? { energy_total: { platform: 'sensor' } } : {}),
            // The sound switch and the temperature step select were offered on every model
            // this handler serves before they were narrowed to the WINF, which is the only
            // one whose panel has the buttons. Dropping them from the payload is not enough:
            // Home Assistant keeps an entity it was told about until it is told otherwise,
            // so the bedroom unit carried two unavailable controls for days.
            ...(isWinf ? {} : { sound: { platform: 'switch' }, temperature_step: { platform: 'select' } }),
        })

        if (this.filterLifeTime) {
            this.publishFilterData()

            /*
             * Refresh only once a day since a query might do an EEPROM
             * write.
             */
            this.filterQueryTimer = setInterval(
                () => {
                    log('status', this.id, 'sending periodic filter data refresh query')
                    this.sendFilterQuery()
                },
                24 * 60 * 60 * 1000,
            )
        }

        this.query()
    }

    /**
     * `countdown` adds a read-only companion to the slider. The number entity rounds the
     * remaining time to the quarter hour it can display, so it cannot say that eleven
     * minutes are left; the appliance sends the real figure every minute and the sensor
     * shows it. The living room air conditioner has had this pair since it was split off,
     * and the timers behave the same way on every model here.
     */
    addTimerField(
        config: DeviceDiscovery,
        id: number,
        name: string,
        desc: string,
        icon: string,
        max: number,
        requiresPower = false,
        countdown?: { component: string; name: string; icon: string },
    ) {
        const comp = {
            platform: 'number',
            unique_id: `$deviceid-${name}`,
            name: desc,
            icon: icon,
            device_class: 'duration',
            unit_of_measurement: 'h',
            min: 0,
            max: max,
            step: 0.25,
            mode: 'slider',
        } as const
        config.components[name] = comp

        if (countdown) {
            config.components[countdown.component] = allowExtendedType({
                platform: 'sensor',
                unique_id: `$deviceid-${countdown.component}`,
                name: countdown.name,
                icon: countdown.icon,
                device_class: 'duration',
                unit_of_measurement: 'min',
                state_topic: `$this/${countdown.component}`,
                entity_category: 'diagnostic',
            })
        }

        /*
         * Upon setting this field the device starts counting down and
         * every minute sends the remaining time.
         */
        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            read_xform: (raw) => {
                if (countdown) this.HA.publishProperty(this.id, countdown.component, raw)
                return Math.ceil(raw / 60 / 0.25) * 0.25
            },
            write_xform: (val) => Math.round(Number(val) * 60),
            write_callback: requiresPower ? () => this.allowSleepTimerWriteWhilePowered() : undefined,
        })
    }

    /**
     * The thermostat card rounds what the user picks to the step it was told about, so the
     * published step has to follow the one the appliance is actually set to.
     */
    applyTemperatureStep(step: 0.5 | 1) {
        const climate = this.config?.components.climate as { temp_step?: number; precision?: number } | undefined
        if (!climate || climate.temp_step === step) return
        climate.temp_step = step
        climate.precision = step
        this.publishConfig()
    }

    allowSleepTimerWriteWhilePowered() {
        if (this.getPowerTLV() !== 0) return true
        log('status', this.id, 'ignoring sleep timer command while powered off')
        return false
    }

    allowAirflowWriteWhilePowered() {
        if (this.getPowerTLV() !== 0) return true
        log('status', this.id, 'ignoring fan/vane command while powered off; this model would turn on')
        return false
    }

    addJetField(
        config: DeviceDiscovery,
        id: number,
        name: string,
        desc: string,
        icon: string,
        jetCool: boolean,
        jetHeat: boolean,
    ) {
        const descFull = `${desc} ${jetCool ? 'cool' : ''}${jetCool && jetHeat ? '/' : ''}${jetHeat ? 'heat' : ''}`

        const comp = {
            platform: 'switch',
            unique_id: `$deviceid-${name}`,
            name: descFull,
            icon: icon,
            entity_category: 'config',
        }
        config.components[name] = comp

        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            write_xform: (val) => {
                this.jetMode = val === 'ON'
                if (!this.jetMode) return 0

                /* ON */
                if (jetCool && this.getModeTLV() === 0) return 1
                if (jetHeat && this.getModeTLV() === 4) return 2
                return 0
            },
            read_xform: (raw) => {
                if (jetCool && this.getModeTLV() === 0 && raw === 1) return 'ON'
                if (jetHeat && this.getModeTLV() === 4 && raw === 2) return 'ON'
                return 'OFF'
            },
            read_callback: (val) => {
                // Ignore read value if not running
                const powerTLV = this.getPowerTLV()
                if (powerTLV === 0 || powerTLV == null) return false

                // Ignore read value if not in the right mode
                if (!((jetCool && this.getModeTLV() === 0) || (jetHeat && this.getModeTLV() === 4))) return false

                this.jetMode = val === 'ON'
                return true
            },
            write_callback: (_val) => {
                /*
                 * Writing '1' in OFF state seem to immediately
                 * power on into the cooling mode, while writing
                 * '2' in the OFF state is ignored.
                 * Be consistent and only allow enabling Jet mode
                 * when running in the right mode.
                 */
                return (
                    this.getPowerTLV() !== 0 &&
                    ((jetCool && this.getModeTLV() === 0) || (jetHeat && this.getModeTLV() === 4))
                )
            },
        })

        /*
         * This value needs to be written at each power up in heat/cool mode,
         * but in a separate message.
         */
        this.powerChangeHooks.push(() => {
            if (this.getPowerTLV() === 0 || !this.jetMode) return
            this.setProperty(`${name}-`, 'ON')
        })
        this.modeChangeHooks.push(() => {
            this.setProperty(`${name}-`, this.jetMode ? 'ON' : 'OFF')
        })
    }

    addOptionalSensorField(
        config: DeviceDiscovery,
        ids: number | number[],
        name: string,
        desc: string,
        icon?: string,
        extra?: Record<string, unknown>,
        read_xform?: FieldDefinition['read_xform'],
    ) {
        if (typeof ids === 'number') {
            ids = [ids]
        }

        const id = ids.find(
            (val) =>
                this.raw_clip_state[val] != null &&
                (read_xform == null || read_xform(this.raw_clip_state[val]) != null),
        )
        if (id == null) return

        const comp = {
            icon: icon ?? undefined,
            platform: 'sensor',
            unique_id: `$deviceid-${name}`,
            name: desc,
            entity_category: 'diagnostic',
            ...extra,
        }

        config.components[name] = comp

        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            writable: false,
            read_xform: read_xform,
        })
    }

    addOptionalSensorTempField(
        config: DeviceDiscovery,
        ids: number | number[],
        name: string,
        desc: string,
        icon?: string,
        read_xform?: FieldDefinition['read_xform'],
    ) {
        this.addOptionalSensorField(
            config,
            ids,
            name,
            desc,
            icon,
            {
                device_class: 'temperature',
                unit_of_measurement: '°C',
                state_class: 'measurement',
                suggested_display_precision: 2,
            },
            read_xform,
        )
    }

    addConfigSwitchField(config: DeviceDiscovery, id: number, name: string, desc: string, icon: string) {
        const comp = {
            platform: 'switch',
            unique_id: `$deviceid-${name}`,
            name: desc,
            icon: icon,
            entity_category: 'config',
        }
        config.components[name] = comp

        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            write_xform: (val) => (val === 'ON' ? 1 : 0),
            read_xform: (raw) => (raw ? 'ON' : 'OFF'),
        })
    }

    addModeDependentConfigSwitchField(
        config: DeviceDiscovery,
        id: number,
        name: string,
        desc: string,
        icon: string,
        field_name: 'airClean' | 'jetMode' | 'energySave',
        check_mode?: CheckMode,
    ) {
        const comp = {
            platform: 'switch',
            unique_id: `$deviceid-${name}`,
            name: desc,
            icon: icon,
            entity_category: 'config',
        }
        config.components[name] = comp

        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            write_xform: (val) => (val === 'ON' ? 1 : 0),
            read_xform: (raw) => (raw ? 'ON' : 'OFF'),
            read_callback: (val) => {
                // Ignore read value if not running
                const powerTLV = this.getPowerTLV()
                if (powerTLV === 0 || powerTLV == null) return false

                // Ignore read value if not in the right mode
                if (check_mode && !check_mode(this.getModeTLV())) return false

                this[field_name] = val === 'ON'
                return true
            },
            write_callback: (val) => {
                this[field_name] = val === 1

                // No need to write the value if not running in the right mode
                return this.getPowerTLV() !== 0 && (!check_mode || check_mode(this.getModeTLV()))
            },
        })

        this.powerChangeHooks.push(() => {
            if (this.getPowerTLV() === 0 || !this[field_name]) return
            /*
             * This value needs to be written at each power up,
             * but in a separate message.
             */
            this.setProperty(`${name}-`, 'ON')
        })

        if (check_mode) {
            this.modeChangeHooks.push(() => {
                this.setProperty(`${name}-`, this[field_name] ? 'ON' : 'OFF')
            })
        }
    }
}
