/* ThinQ 1 JSON-protocol handler for the older Korean DHUM_056905_WW dehumidifier. */

import { allowExtendedType } from '@/util/casting'
import type { Connection } from '../homeassistant'
import type { Metadata } from '../thinq'
import type { Device as Thinq1Device } from '../thinq1/device'
import HADevice from './base'

const MODES: Record<string, string> = {
    smart: '17',
    fast: '18',
    silent: '19',
    concentrated_drying: '20',
    clothing_drying: '21',
}

const FAN_SPEEDS: Record<string, string> = {
    low: '2',
    medium: '4',
    high: '6',
    power: '7',
}

const SENSOR_MODES: Record<string, string> = {
    operating_only: '0',
    always: '1',
}

/** SupportReserve advertises @AP_SIMPLE_TIMER_DHUM_8, the eight hour simple timer. */
const MAX_OFF_TIMER_HOURS = 8

const MONITOR_ON_INTERVAL_MS = 60_000
const MONITOR_OFF_INTERVAL_MS = 5 * 60_000
const MONITOR_TIMEOUT_MS = 10_000
const CONTROL_REFRESH_DELAY_MS = 2_000
const INTERNAL_ACK_IGNORE_MS = 1_000

type MonitorStatus = {
    Operation?: unknown
    OpMode?: unknown
    HumidityCfg?: unknown
    WindStrength?: unknown
    SensorHumidity?: unknown
    WatertankLight?: unknown
    CleanDry?: unknown
    OffTime?: unknown
    SensorMon?: unknown
    DiagCode?: unknown
}

function optionForValue(values: Record<string, string>, raw: unknown): string | undefined {
    if (typeof raw !== 'string' && typeof raw !== 'number') return
    const value = String(raw)
    return Object.keys(values).find((option) => values[option] === value)
}

function numberInRange(raw: unknown, min: number, max: number): number | undefined {
    if ((typeof raw !== 'string' && typeof raw !== 'number') || raw === '') return
    const value = Number(raw)
    if (!Number.isFinite(value) || value < min || value > max) return
    return value
}

export default class Device extends HADevice {
    private started = false
    private monitorInFlight = false
    private lastPowerState: 'ON' | 'OFF' | undefined
    private ignoreAckOnlyUntil = 0
    private periodicTimeout: NodeJS.Timeout | undefined
    private monitorTimeout: NodeJS.Timeout | undefined
    private refreshTimeout: NodeJS.Timeout | undefined
    private readonly publishCache: Record<string, string | number> = {}

    constructor(
        HA: Connection,
        readonly thinq: Thinq1Device,
        meta: Metadata,
    ) {
        super(HA, thinq.id)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Dehumidifier' }),
                components: {
                    dehumidifier: {
                        platform: 'humidifier',
                        unique_id: '$deviceid-dehumidifier',
                        name: null,
                        device_class: 'dehumidifier',
                        state_topic: '$this/power',
                        command_topic: '$this/power/set',
                        target_humidity_state_topic: '$this/target_humidity',
                        target_humidity_command_topic: '$this/target_humidity/set',
                        current_humidity_topic: '$this/current_humidity',
                        mode_state_topic: '$this/operation_mode',
                        mode_command_topic: '$this/operation_mode/set',
                        modes: Object.keys(MODES),
                        min_humidity: 30,
                        max_humidity: 70,
                    },
                    /*
                     * The appliance only accepts multiples of five. Home Assistant's
                     * humidifier entity has no step setting — its slider always moves one
                     * per cent at a time — so the value gets its own control that moves the
                     * way the appliance does.
                     */
                    target_humidity: {
                        platform: 'number',
                        unique_id: '$deviceid-target-humidity',
                        name: 'Target humidity',
                        icon: 'mdi:water-percent',
                        device_class: 'humidity',
                        unit_of_measurement: '%',
                        state_topic: '$this/target_humidity',
                        command_topic: '$this/target_humidity/set',
                        min: 30,
                        max: 70,
                        step: 5,
                        mode: 'slider',
                    },
                    fan_speed: {
                        platform: 'select',
                        unique_id: '$deviceid-fan-speed',
                        name: 'Fan speed',
                        icon: 'mdi:fan',
                        state_topic: '$this/fan_speed',
                        command_topic: '$this/fan_speed/set',
                        options: Object.keys(FAN_SPEEDS),
                    },
                    water_tank_light: {
                        platform: 'switch',
                        unique_id: '$deviceid-water-tank-light',
                        name: 'Water tank light',
                        icon: 'mdi:lightbulb-outline',
                        state_topic: '$this/water_tank_light',
                        command_topic: '$this/water_tank_light/set',
                    },
                    clean_dry: {
                        platform: 'switch',
                        unique_id: '$deviceid-clean-dry',
                        name: 'Clean dry',
                        icon: 'mdi:weather-windy',
                        state_topic: '$this/clean_dry',
                        command_topic: '$this/clean_dry/set',
                    },
                    sensor_mode: {
                        platform: 'select',
                        unique_id: '$deviceid-sensor-mode',
                        name: 'Humidity sensor mode',
                        icon: 'mdi:water-percent',
                        state_topic: '$this/sensor_mode',
                        command_topic: '$this/sensor_mode/set',
                        options: Object.keys(SENSOR_MODES),
                        entity_category: 'config',
                    },
                    off_timer: {
                        platform: 'number',
                        unique_id: '$deviceid-off-timer',
                        name: 'Turn-off reservation',
                        icon: 'mdi:timer-stop',
                        state_topic: '$this/off_timer',
                        command_topic: '$this/off_timer/set',
                        device_class: 'duration',
                        unit_of_measurement: 'h',
                        min: 0,
                        max: 8,
                        step: 1,
                        mode: 'slider',
                    },
                    /*
                     * The slider only moves in whole hours, so it reads 1 h whether seven
                     * minutes are left or fifty-nine. The appliance reports the minutes it
                     * has left; this shows them.
                     */
                    off_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-off-time',
                        name: 'Stop time',
                        icon: 'mdi:timer-stop-outline',
                        state_topic: '$this/off_time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        entity_category: 'diagnostic',
                    },
                    error: {
                        platform: 'sensor',
                        unique_id: '$deviceid-error',
                        name: 'Error',
                        icon: 'mdi:alert-circle-outline',
                        state_topic: '$this/error',
                        entity_category: 'diagnostic',
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

    stopTimers() {
        this.started = false
        if (this.periodicTimeout) clearTimeout(this.periodicTimeout)
        if (this.monitorTimeout) clearTimeout(this.monitorTimeout)
        if (this.refreshTimeout) clearTimeout(this.refreshTimeout)
        super.stopTimers()
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
        let status: MonitorStatus
        try {
            status = JSON.parse(buf.toString('utf-8')) as MonitorStatus
        } catch {
            return
        }

        if (status.Operation === '0' || status.Operation === '1')
            this.publishProperty('power', status.Operation === '1' ? 'ON' : 'OFF')

        const targetHumidity = numberInRange(status.HumidityCfg, 30, 70)
        if (targetHumidity !== undefined) this.publishProperty('target_humidity', targetHumidity)
        const currentHumidity = numberInRange(status.SensorHumidity, 0, 100)
        if (currentHumidity !== undefined) this.publishProperty('current_humidity', currentHumidity)

        const mode = optionForValue(MODES, status.OpMode)
        if (mode) this.publishProperty('operation_mode', mode)
        const fanSpeed = optionForValue(FAN_SPEEDS, status.WindStrength)
        if (fanSpeed) this.publishProperty('fan_speed', fanSpeed)
        const sensorMode = optionForValue(SENSOR_MODES, status.SensorMon)
        if (sensorMode) this.publishProperty('sensor_mode', sensorMode)

        if (status.WatertankLight === '0' || status.WatertankLight === '1')
            this.publishProperty('water_tank_light', status.WatertankLight === '1' ? 'ON' : 'OFF')
        if (status.CleanDry === '0' || status.CleanDry === '1')
            this.publishProperty('clean_dry', status.CleanDry === '1' ? 'ON' : 'OFF')
        // The appliance reports the reservation as the minutes it has left and counts it
        // down, so round up to the hour the slider can show. Its own schema documents the
        // field this way: "1시간일 경우 60으로 데이터 받음".
        const offTime = numberInRange(status.OffTime, 0, MAX_OFF_TIMER_HOURS * 60)
        if (offTime !== undefined) {
            this.publishProperty('off_timer', Math.ceil(offTime / 60))
            this.publishProperty('off_time', offTime)
        }
        if (typeof status.DiagCode === 'string')
            this.publishProperty('error', status.DiagCode === '00' ? 'normal' : status.DiagCode)

        if (status.Operation === '0' || status.Operation === '1') this.finishMonitorSnapshot()
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'power' && (mqttValue === 'ON' || mqttValue === 'OFF')) {
            this.thinq.send({
                Cmd: 'Control',
                CmdOpt: 'Operation',
                Value: mqttValue === 'ON' ? 'Start' : 'Stop',
            })
            this.scheduleMonitorSnapshot()
        } else if (prop === 'target_humidity') {
            const value = numberInRange(mqttValue, 30, 70)
            if (value === undefined) return
            const humidity = Math.round(value / 5) * 5
            this.thinq.send({ Cmd: 'Control', CmdOpt: 'Set', Value: { HumidityCfg: String(humidity) } })
            this.scheduleMonitorSnapshot()
        } else if (prop === 'operation_mode' && MODES[mqttValue] !== undefined) {
            this.thinq.send({ Cmd: 'Control', CmdOpt: 'Set', Value: { OpMode: MODES[mqttValue] } })
            this.scheduleMonitorSnapshot()
        } else if (prop === 'fan_speed' && FAN_SPEEDS[mqttValue] !== undefined) {
            this.thinq.send({ Cmd: 'Control', CmdOpt: 'Set', Value: { WindStrength: FAN_SPEEDS[mqttValue] } })
            this.scheduleMonitorSnapshot()
        } else if (prop === 'water_tank_light' && (mqttValue === 'ON' || mqttValue === 'OFF')) {
            this.thinq.send({
                Cmd: 'Control',
                CmdOpt: 'Set',
                Value: { WatertankLight: mqttValue === 'ON' ? '1' : '0' },
            })
            this.scheduleMonitorSnapshot()
        } else if (prop === 'clean_dry' && (mqttValue === 'ON' || mqttValue === 'OFF')) {
            this.thinq.send({
                Cmd: 'Control',
                CmdOpt: 'Set',
                Value: { CleanDry: mqttValue === 'ON' ? '1' : '0' },
            })
            this.scheduleMonitorSnapshot()
        } else if (prop === 'off_timer') {
            const requested = Number(mqttValue)
            if (mqttValue === '' || !Number.isFinite(requested)) return
            // Observed on the appliance: a reservation set while it is powered off is
            // acknowledged and then reported back as 0.
            if (this.lastPowerState === 'OFF') return
            const hours = Math.min(MAX_OFF_TIMER_HOURS, Math.max(0, Math.round(requested)))
            this.thinq.send({ Cmd: 'Control', CmdOpt: 'Set', Value: { OffTime: String(hours * 60) } })
            this.scheduleMonitorSnapshot()
        } else if (prop === 'sensor_mode' && SENSOR_MODES[mqttValue] !== undefined) {
            this.thinq.send({ Cmd: 'Config', CmdOpt: 'Set', Value: { SensorMon: SENSOR_MODES[mqttValue] } })
            this.scheduleMonitorSnapshot()
        }
    }
}
