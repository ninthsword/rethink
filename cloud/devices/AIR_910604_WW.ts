/* Implements confirmed ThinQ 1 controls, monitor state, and filter telemetry for AIR_910604_WW.
 * Related files: cloud/ha_bridge.ts, cloud/thinq1/connection.ts, cloud/thinq1/device.ts,
 * tests/cloud/devices/AIR_910604_WW.test.ts. */
import HADevice from './base'
import { Device as Thinq1Device } from '../thinq1/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'

const SLEEP_TIMER_VALUES: Record<string, string> = {
    Off: '0',
    '2 hours': '120',
    '4 hours': '240',
    '8 hours': '480',
    '12 hours': '720',
}

const WIND_STRENGTH_VALUES: Record<string, string> = {
    Low: '2',
    Medium: '4',
    High: '6',
    Auto: '8',
}

const SLEEP_TIMER_OPTIONS = Object.keys(SLEEP_TIMER_VALUES)
const WIND_STRENGTH_OPTIONS = Object.keys(WIND_STRENGTH_VALUES)
const MONITOR_ON_INTERVAL_MS = 60_000
const MONITOR_OFF_INTERVAL_MS = 5 * 60_000
const MONITOR_TIMEOUT_MS = 10_000
const CONTROL_REFRESH_DELAY_MS = 2_000
const FILTER_QUERY_DELAY_MS = 1_000
const INTERNAL_ACK_IGNORE_MS = 1_000

type FilterStatus = {
    RemainTime?: unknown
    ChangePeriod?: unknown
}

type MonitorStatus = {
    Operation?: unknown
    WindStrength?: unknown
    SleepTime?: unknown
    SensorPM1?: unknown
    SensorPM2?: unknown
    SensorPM10?: unknown
    AirFast?: unknown
    AirRemoval?: unknown
}

function optionForValue(values: Record<string, string>, raw: unknown): string | undefined {
    if (typeof raw !== 'string') return
    return Object.keys(values).find((option) => values[option] === raw)
}

function nonNegativeNumber(raw: unknown): number | undefined {
    if ((typeof raw !== 'string' && typeof raw !== 'number') || raw === '') return
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) return
    return value
}

export default class Device extends HADevice {
    private started = false
    private monitorInFlight = false
    private filterRequested = false
    private lastPowerState: 'ON' | 'OFF' | undefined
    private ignoreAckOnlyUntil = 0
    private periodicTimeout: NodeJS.Timeout | undefined
    private monitorTimeout: NodeJS.Timeout | undefined
    private refreshTimeout: NodeJS.Timeout | undefined
    private filterTimeout: NodeJS.Timeout | undefined

    constructor(
        HA: Connection,
        readonly thinq: Thinq1Device,
        meta: Metadata,
    ) {
        super(HA, thinq.id)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Air Purifier' }),
                components: {
                    fan: {
                        platform: 'fan',
                        unique_id: '$deviceid-fan',
                        state_topic: '$this/power',
                        command_topic: '$this/power/set',
                        name: '',
                        icon: 'mdi:air-purifier',
                        preset_mode_state_topic: '$this/wind_strength',
                        preset_mode_command_topic: '$this/wind_strength/set',
                        preset_modes: WIND_STRENGTH_OPTIONS,
                    },
                    air_fast: {
                        platform: 'switch',
                        unique_id: '$deviceid-air-fast',
                        state_topic: '$this/air_fast',
                        command_topic: '$this/air_fast/set',
                        name: 'Fast mode',
                        icon: 'mdi:fan-plus',
                    },
                    air_removal: {
                        platform: 'switch',
                        unique_id: '$deviceid-air-removal',
                        state_topic: '$this/air_removal',
                        command_topic: '$this/air_removal/set',
                        name: 'Air sterilization',
                        icon: 'mdi:air-filter',
                    },
                    sleep_timer: {
                        platform: 'select',
                        unique_id: '$deviceid-sleep-timer',
                        state_topic: '$this/sleep_timer',
                        command_topic: '$this/sleep_timer/set',
                        options: SLEEP_TIMER_OPTIONS,
                        name: 'Sleep timer',
                        icon: 'mdi:timer-sand',
                        entity_category: 'config',
                    },
                    pm1: {
                        platform: 'sensor',
                        unique_id: '$deviceid-pm1',
                        state_topic: '$this/pm1',
                        name: 'PM1.0',
                        icon: 'mdi:blur',
                        unit_of_measurement: 'µg/m³',
                        state_class: 'measurement',
                    },
                    pm25: {
                        platform: 'sensor',
                        unique_id: '$deviceid-pm25',
                        state_topic: '$this/pm25',
                        name: 'PM2.5',
                        icon: 'mdi:blur',
                        unit_of_measurement: 'µg/m³',
                        state_class: 'measurement',
                    },
                    pm10: {
                        platform: 'sensor',
                        unique_id: '$deviceid-pm10',
                        state_topic: '$this/pm10',
                        name: 'PM10',
                        icon: 'mdi:blur',
                        unit_of_measurement: 'µg/m³',
                        state_class: 'measurement',
                    },
                    filter_remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-filter-remaining-time',
                        state_topic: '$this/filter_remaining_time',
                        name: 'Filter remaining time',
                        icon: 'mdi:air-filter',
                        unit_of_measurement: 'h',
                        device_class: 'duration',
                        state_class: 'measurement',
                    },
                    filter_remaining: {
                        platform: 'sensor',
                        unique_id: '$deviceid-filter-remaining',
                        state_topic: '$this/filter_remaining',
                        name: 'Filter remaining',
                        icon: 'mdi:air-filter',
                        unit_of_measurement: '%',
                        state_class: 'measurement',
                    },
                },
            }),
        )

        thinq.on('data', (buf) => this.processData(buf))
        thinq.on('response', (body) => this.processResponse(body))
    }

    start() {
        this.started = true
        this.requestMonitorSnapshot()
    }

    drop() {
        this.started = false
        if (this.periodicTimeout) clearTimeout(this.periodicTimeout)
        if (this.monitorTimeout) clearTimeout(this.monitorTimeout)
        if (this.refreshTimeout) clearTimeout(this.refreshTimeout)
        if (this.filterTimeout) clearTimeout(this.filterTimeout)
        super.drop()
    }

    private requestMonitorSnapshot() {
        if (!this.started || this.monitorInFlight) return
        if (this.periodicTimeout) clearTimeout(this.periodicTimeout)
        this.periodicTimeout = undefined
        this.monitorInFlight = true
        this.ignoreAckOnlyUntil = Date.now() + INTERNAL_ACK_IGNORE_MS
        this.thinq.send({ Cmd: 'Mon', CmdOpt: 'Start' })
        this.monitorTimeout = setTimeout(() => this.finishMonitorSnapshot(), MONITOR_TIMEOUT_MS)
        this.monitorTimeout.unref()
    }

    private finishMonitorSnapshot() {
        if (!this.monitorInFlight) return
        this.monitorInFlight = false
        if (this.monitorTimeout) clearTimeout(this.monitorTimeout)
        this.monitorTimeout = undefined
        this.ignoreAckOnlyUntil = Date.now() + INTERNAL_ACK_IGNORE_MS
        this.thinq.send({ Cmd: 'Mon', CmdOpt: 'Stop' })
        this.schedulePeriodicSnapshot()
    }

    private schedulePeriodicSnapshot() {
        if (!this.started) return
        if (this.periodicTimeout) clearTimeout(this.periodicTimeout)
        const delay = this.lastPowerState === 'OFF' ? MONITOR_OFF_INTERVAL_MS : MONITOR_ON_INTERVAL_MS
        this.periodicTimeout = setTimeout(() => {
            this.periodicTimeout = undefined
            this.requestMonitorSnapshot()
        }, delay)
        this.periodicTimeout.unref()
    }

    private scheduleMonitorSnapshot(delay = CONTROL_REFRESH_DELAY_MS) {
        if (!this.started) return
        if (this.refreshTimeout) clearTimeout(this.refreshTimeout)
        this.refreshTimeout = setTimeout(() => {
            this.refreshTimeout = undefined
            if (this.monitorInFlight) this.scheduleMonitorSnapshot()
            else this.requestMonitorSnapshot()
        }, delay)
        this.refreshTimeout.unref()
    }

    private scheduleFilterQuery() {
        if (this.filterRequested || !this.started) return
        this.filterRequested = true
        this.filterTimeout = setTimeout(() => {
            this.filterTimeout = undefined
            this.thinq.send({ Cmd: 'Config', CmdOpt: 'Get', Value: 'MFilter', Data: 'bnVsbA==' })
        }, FILTER_QUERY_DELAY_MS)
        this.filterTimeout.unref()
    }

    private readonly publishCache: Record<string, string | number> = {}

    private publishProperty(prop: string, value: string | number) {
        if (prop === 'power' && (value === 'ON' || value === 'OFF')) this.lastPowerState = value
        if (this.publishCache[prop] === value) return
        this.publishCache[prop] = value
        this.HA.publishProperty(this.id, prop, value)
    }

    private processResponse(body: Record<string, unknown>) {
        if (body.ReturnCode !== '0000' || body.Data !== undefined) return
        if (!this.started || this.monitorInFlight || Date.now() < this.ignoreAckOnlyUntil) return
        this.scheduleMonitorSnapshot(0)
    }

    private processData(buf: Buffer) {
        let status: FilterStatus & MonitorStatus
        try {
            status = JSON.parse(buf.toString('utf-8')) as FilterStatus
        } catch {
            return
        }

        const remainTime = nonNegativeNumber(status.RemainTime)
        const changePeriod = nonNegativeNumber(status.ChangePeriod)
        if (remainTime !== undefined && changePeriod !== undefined && changePeriod > 0) {
            this.publishProperty('filter_remaining_time', remainTime)
            const remainingPercent = Math.min(100, Math.round((remainTime / changePeriod) * 1000) / 10)
            this.publishProperty('filter_remaining', remainingPercent)
        }

        if (status.Operation === '0' || status.Operation === '1')
            this.publishProperty('power', status.Operation === '1' ? 'ON' : 'OFF')
        if (status.AirFast === '0' || status.AirFast === '1')
            this.publishProperty('air_fast', status.AirFast === '1' ? 'ON' : 'OFF')
        if (status.AirRemoval === '0' || status.AirRemoval === '1')
            this.publishProperty('air_removal', status.AirRemoval === '1' ? 'ON' : 'OFF')

        const sleepTimer = optionForValue(SLEEP_TIMER_VALUES, status.SleepTime)
        if (sleepTimer) this.publishProperty('sleep_timer', sleepTimer)
        const windStrength = optionForValue(WIND_STRENGTH_VALUES, status.WindStrength)
        if (windStrength) this.publishProperty('wind_strength', windStrength)

        for (const [field, property] of [
            ['SensorPM1', 'pm1'],
            ['SensorPM2', 'pm25'],
            ['SensorPM10', 'pm10'],
        ] as const) {
            const value = nonNegativeNumber(status[field])
            if (value !== undefined) this.publishProperty(property, value)
        }

        if (status.Operation === '0' || status.Operation === '1') {
            this.finishMonitorSnapshot()
            this.scheduleFilterQuery()
        }
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'power' && (mqttValue === 'ON' || mqttValue === 'OFF')) {
            this.thinq.send({ Cmd: 'Control', CmdOpt: 'Operation', Value: mqttValue === 'ON' ? '1' : '0' })
            this.publishProperty('power', mqttValue)
            this.scheduleMonitorSnapshot()
        } else if (prop === 'air_fast' && (mqttValue === 'ON' || mqttValue === 'OFF')) {
            this.thinq.send({
                Cmd: 'Control',
                CmdOpt: 'Set',
                Value: { AirFast: mqttValue === 'ON' ? '1' : '0' },
            })
            this.publishProperty('air_fast', mqttValue)
            this.scheduleMonitorSnapshot()
        } else if (prop === 'air_removal' && (mqttValue === 'ON' || mqttValue === 'OFF')) {
            this.thinq.send({
                Cmd: 'Control',
                CmdOpt: 'Set',
                Value: { AirRemoval: mqttValue === 'ON' ? '1' : '0' },
            })
            this.publishProperty('air_removal', mqttValue)
            this.scheduleMonitorSnapshot()
        } else if (prop === 'sleep_timer' && SLEEP_TIMER_VALUES[mqttValue] !== undefined) {
            this.thinq.send({
                Cmd: 'Control',
                CmdOpt: 'Set',
                Value: { SleepTime: SLEEP_TIMER_VALUES[mqttValue] },
                Data: 'bnVsbA==',
            })
            this.publishProperty('sleep_timer', mqttValue)
            this.scheduleMonitorSnapshot()
        } else if (prop === 'wind_strength' && WIND_STRENGTH_VALUES[mqttValue] !== undefined) {
            this.thinq.send({
                Cmd: 'Control',
                CmdOpt: 'Set',
                Value: { WindStrength: WIND_STRENGTH_VALUES[mqttValue] },
            })
            this.publishProperty('wind_strength', mqttValue)
            this.scheduleMonitorSnapshot()
        }
    }
}
