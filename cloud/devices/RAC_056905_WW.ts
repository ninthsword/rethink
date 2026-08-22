import TLVDevice, { FieldDefinition } from './tlv_device'
import { Device as Thinq2Device } from '../thinq2/device'
import { ClimateComponent, DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import { EnergyMeter, energyTotalComponent as energyTotal } from './energy_meter'
import { outdoorUnitComponents, outdoorUnitFor, type OutdoorUnit } from './outdoor_unit'
import * as TLV from '@/util/tlv'
import { racAirTemp, racPipeTemp } from '@/util/ac_tables'
import log from '@/util/logging'
import HADevice from './base'

type PowerModeChangeHook = () => void
type CheckMode = (arg: number) => boolean

const FAN_LEVELS = ['level_1', 'level_2', 'level_3', 'level_4', 'level_5']
const FAN_LEVEL_TO_RAW: Record<string, number> = {
    level_1: 3,
    level_2: 4,
    level_3: 5,
    level_4: 6,
    level_5: 7,
    natural: 9,
}
const FAN_RAW_TO_LEVEL: Record<number, string> = Object.fromEntries(
    Object.entries(FAN_LEVEL_TO_RAW).map(([name, raw]) => [raw, name]),
)

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

const TEMPERATURE_STEPS: Record<number, string> = {
    0: 'half_degree',
    1: 'one_degree',
}

export default class Device extends TLVDevice {
    meta: Metadata
    initialValuesReceived: boolean = false
    powerChangeHooks: PowerModeChangeHook[] = []
    powerStatePrev?: boolean
    modeChangeHooks: PowerModeChangeHook[] = []
    modePrev?: string
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

    drop() {
        if (this.tlvBlacklistDisableTimer != undefined) {
            clearTimeout(this.tlvBlacklistDisableTimer)
            this.tlvBlacklistDisableTimer = undefined
        }

        if (this.increasedQueryIntervalTimeout != undefined) {
            clearTimeout(this.increasedQueryIntervalTimeout)
            this.increasedQueryIntervalTimeout = undefined
        }

        if (this.filterInitialQueryTimeout != undefined) {
            clearTimeout(this.filterInitialQueryTimeout)
            this.filterInitialQueryTimeout = undefined
        }

        if (this.filterQueryTimer != undefined) {
            clearInterval(this.filterQueryTimer)
            this.filterQueryTimer = undefined
        }

        super.drop()
    }

    processPrivData(cmd: number, buf9: number, data: Buffer) {
        if (cmd == 0x02) this.processFilterData(buf9, data)
    }

    processPrivDataCmdResp(success: boolean, buf1: number, cmd: number, data: Buffer) {
        if (cmd == 0x2) this.processFilterCmdResp(success, data)
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
        /* eeprom checksum */
        return tlvArray.some(({ t, v }) => t === 0x2da)
    }

    isValuesResponse(tlvArray: TLV.TLV[]) {
        /* power */
        return tlvArray.length >= 10 && tlvArray.some(({ t, v }) => t === 0x1f7)
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

    processFilterData(buf9: number, data: Buffer) {
        if (data.length < 1 + 3 * 4) {
            log('status', this.id, 'filter data too short:', data.length)
            return
        }

        this.filterUsedTime = data.readUInt32LE(1 + 0 * 4)
        this.filterLifeTime = data.readUInt32LE(1 + 1 * 4)
        this.filterChangedDate = data.readUInt32LE(1 + 2 * 4)

        // if this was the initial filter query the device config is ready now
        if (this.filterInitialQueryTimeout != undefined) {
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
         * sensor sat at unknown regardless. Saying nothing leaves it at unknown honestly.
         */
        if (this.filterLifeTime > 0) {
            const remaining = Math.max(
                0,
                Math.min(100, Math.floor((1 - this.filterUsedTime / this.filterLifeTime) * 100)),
            )
            this.HA.publishProperty(this.id, 'filterremaining', remaining)
        }
        if (this.filterChangedDate > 0) this.HA.publishProperty(this.id, 'filterchangeddate', changedDate)
    }

    processFilterCmdResp(success: boolean, data: Buffer) {
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
        let action: string | undefined = undefined
        let increaseQueryInterval = false
        if (this.getPowerTLV() === 0) {
            action = 'off'
        } else if ((modeTLV === 0 || modeTLV === 1 || modeTLV === 4 || modeTLV === 6) && !iduRunning) {
            action = 'idle'
        } else if (modeTLV === 6) {
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
            if (this.increasedQueryIntervalTimeout != undefined) {
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
                    fan_modes: isWinf ? FAN_LEVELS : [...FAN_LEVELS, 'natural'],
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
                const modes2ha = ['cool', 'dry', 'fan_only', undefined, 'heat', undefined, 'auto']
                if (this.getPowerTLV() === 0) return 'off'
                return modes2ha[raw]
            },
            read_callback: (val) => {
                if (typeof val !== 'string') return true
                // As with power: the first reading tells us where the appliance is, not that
                // it moved. See the power branch above.
                if (this.modePrev !== undefined && this.modePrev !== val)
                    for (const hook of this.modeChangeHooks) hook()
                this.modePrev = val
                return true
            },
            write_xform: (val) => {
                const modes2clip: Record<string, number> = { cool: 0, dry: 1, fan_only: 2, heat: 4, auto: 6 }
                if (val === 'off') {
                    // Call function power (0x1f7) with value OFF
                    this.setProperty('climate-power', 'OFF')
                    return null
                }
                return modes2clip[val]
            },
            write_attach: [0x1fa, 0x1fe],
        })

        this.addField(config, {
            id: 0x1fa,
            name: 'fan_mode',
            comp: 'climate',
            read_xform: (raw) => FAN_RAW_TO_LEVEL[raw],
            write_xform: (val) => FAN_LEVEL_TO_RAW[val],
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
            config['components']['climate']['swing_modes'] = VERTICAL_SWING_MODES
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
            config['components']['climate']['swing_horizontal_modes'] = isWinf
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
         * [ 0x22a, 0x32f ] - ODU compressor Hz
         * Standard2 IDUs even notify about the former
         * tag changes.
         *
         * But the value seems to be capped at 15 Hz
         * regardless of the actual compressor speed,
         * which makes it of limited usability.
         */

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
            config['components']['sound'] = allowExtendedType({
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
            config['components']['temperature_step'] = allowExtendedType({
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
        config['components']['display'] = allowExtendedType({
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
            // WINF reports and accepts the sleep countdown on 0x21a even though its extended
            // capability bitmap does not use the legacy bit. Match the other ACs' number entity.
            this.addTimerField(config, 0x21a, 'sleeptimer', 'Sleep timer', 'mdi:bed-clock', 12, true)
        } else if (this.raw_clip_state[0x2d3] & 1) {
            // 15h - displayed in hex as "FH"
            this.addTimerField(config, 0x21a, 'sleeptimer', 'Sleep timer', 'mdi:bed-clock', 15)
        }

        if (this.raw_clip_state[0x2d3] & 4) {
            this.addTimerField(config, 0x21c, 'starttimer', 'Turn-on timer', 'mdi:timer-play', 24)
            this.addTimerField(config, 0x21b, 'stoptimer', 'Turn-off timer', 'mdi:timer-stop', 24)
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
            const compADry = {
                platform: 'switch',
                unique_id: '$deviceid-autodry',
                name: 'Auto dry',
                icon: 'mdi:hair-dryer',
                entity_category: 'config',
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
            config['components']['autodry'] = compADry
            config['components']['autodryremain'] = compADryRem

            this.addField(config, {
                id: 0x20e,
                name: '',
                comp: 'autodry',
                read_xform: (raw) => (raw ? 'ON' : 'OFF'),
                write_xform: (value) => (value === 'ON' ? 1 : 0),
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
                    read_callback: (val) => {
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
            config['components']['filterremaining'] = filterRemaining
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
            config['components']['filterused'] = filterUsed
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
            config['components']['filterlife'] = filterLife
            const filterChanged = {
                platform: 'sensor',
                unique_id: '$deviceid-filterchangeddate',
                state_topic: '$this/filterchangeddate',
                name: 'Filter usage last reset',
                icon: 'mdi:calendar-refresh-outline',
                device_class: 'date',
                entity_category: 'diagnostic',
            }
            config['components']['changeddate'] = filterChanged

            const filterReset = {
                platform: 'button',
                unique_id: '$deviceid-filterreset',
                command_topic: '$this/filterreset/set',
                name: 'Reset filter usage',
                icon: 'mdi:calendar-refresh-outline',
                entity_category: 'diagnostic',
            }
            config['components']['filterreset'] = filterReset
            this.fields_by_ha['filterreset'] = {
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

            config['components']['energy_current'] = energyCurrent
            /*
             * An appliance that says what it is drawing can also say what it has used. Where
             * an outdoor unit is shared, though, this reading is the outdoor unit's and not
             * this head's, so the total belongs to the group and lives on its primary
             * appliance — one total for one compressor.
             */
            if (this.outdoor) {
                if (this.outdoor.isPrimary(this.id)) Object.assign(config['components'], outdoorUnitComponents())
            } else config['components']['energy_total'] = energyTotal()

            /*
             * The reading is in watts and needs nothing taken off it. This file used to
             * subtract sixty from every value for a "bias of +50"; measured against the
             * whole-house meter, that bias is a standby artefact and not an offset on
             * running values — switched off, these units keep reporting around fifty, which
             * is a placeholder rather than a measurement. So standby is shown as five watts
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
                read_xform: (raw) => (this.getPowerTLV() === 0 ? 5 : Math.max(5, raw)),
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
            // Auto dry used to be a read-only sensor on this id, and Home Assistant keeps
            // the old entity when a component changes platform.
            autodry: { platform: 'binary_sensor' },
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

    addTimerField(
        config: DeviceDiscovery,
        id: number,
        name: string,
        desc: string,
        icon: string,
        max: number,
        requiresPower = false,
    ) {
        const comp = {
            platform: 'number',
            unique_id: '$deviceid-' + name,
            name: desc,
            icon: icon,
            device_class: 'duration',
            unit_of_measurement: 'h',
            min: 0,
            max: max,
            step: 0.25,
            mode: 'slider',
        } as const
        config['components'][name] = comp

        /*
         * Upon setting this field the device starts counting down and
         * every minute sends the remaining time.
         */
        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            read_xform: (raw) => Math.ceil(raw / 60 / 0.25) * 0.25,
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
        const descFull =
            desc + ' ' + (jetCool ? 'cool' : '') + (jetCool && jetHeat ? '/' : '') + (jetHeat ? 'heat' : '')

        const comp = {
            platform: 'switch',
            unique_id: '$deviceid-' + name,
            name: descFull,
            icon: icon,
            entity_category: 'config',
        }
        config['components'][name] = comp

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
                if (jetCool && this.getModeTLV() === 0 && raw == 1) return 'ON'
                if (jetHeat && this.getModeTLV() === 4 && raw == 2) return 'ON'
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
            write_callback: (val) => {
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
            if (this.getPowerTLV() === 0) return
            this.setProperty(name + '-', this.jetMode ? 'ON' : 'OFF')
        })
        this.modeChangeHooks.push(() => {
            this.setProperty(name + '-', this.jetMode ? 'ON' : 'OFF')
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

        let id = ids.find(
            (val) =>
                this.raw_clip_state[val] != null &&
                (read_xform == null || read_xform(this.raw_clip_state[val]) != null),
        )
        if (id == null) return

        const comp = {
            icon: icon ?? undefined,
            platform: 'sensor',
            unique_id: '$deviceid-' + name,
            name: desc,
            entity_category: 'diagnostic',
            ...extra,
        }

        config['components'][name] = comp

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
            unique_id: '$deviceid-' + name,
            name: desc,
            icon: icon,
            entity_category: 'config',
        }
        config['components'][name] = comp

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
            unique_id: '$deviceid-' + name,
            name: desc,
            icon: icon,
            entity_category: 'config',
        }
        config['components'][name] = comp

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
                if (!!check_mode && !check_mode(this.getModeTLV())) return false

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
            if (this.getPowerTLV() === 0) return
            /*
             * This value needs to be written at each power up,
             * but in a separate message.
             */
            this.setProperty(name + '-', this[field_name] ? 'ON' : 'OFF')
        })

        if (!!check_mode) {
            this.modeChangeHooks.push(() => {
                this.setProperty(name + '-', this[field_name] ? 'ON' : 'OFF')
            })
        }
    }
}
