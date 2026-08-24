/**
 * How many refresh queries may go unanswered before the appliance is treated as no longer
 * listening. Three of them span three quarters of an hour at the default interval, which no
 * appliance that is merely idle will ever reach — it answers whether or not it has news.
 */
const UNANSWERED_QUERIES_BEFORE_SILENT = 3

/** Gap between initial-values attempts. */
const INITIAL_VALUES_RETRY_MS = 15 * 1000

import crc16 from '@/util/crc16'
import log from '@/util/logging'
import * as TLV from '@/util/tlv'
import type { Connection, DeviceDiscovery } from '../homeassistant'
import type { Device as Thinq2Device } from '../thinq2/device'
// base implementation for devices with a TLV-based payload format
import HADevice from './base'

export type FieldDefinition = {
    id?: number
    name: string
    comp: string
    state_topic?: string
    readable?: boolean
    writable?: boolean
    write_xform?: (val: string) => string | number | null | undefined
    write_attach?: number[] | ((val: unknown) => number[])
    read_xform?: (val: number) => string | number | undefined // undefined return values are discarded
    read_callback?: (val: string | number) => boolean
    write_callback?: (val: number) => boolean
}

/**
 * Tags that mark a reply as the answer to a capability query on this platform.
 *
 * 0x2da is the eeprom checksum older firmware sends. Newer modules answer with 0x2db or
 * 0x2c1 instead, and a handler that recognises only the old one waits out its capability
 * timeout and then concludes the appliance never answered — which is what anszom/rethink
 * issue #137 reports for a RAC on an RTL8720cm module. Every handler on this platform
 * carried its own copy of the old test, so the set lives here and they share it.
 */
export const CAPS_RESPONSE_TAGS: ReadonlySet<number> = new Set([0x2da, 0x2db, 0x2c1])

export function marksCapsResponse(tlvArray: TLV.TLV[]) {
    return tlvArray.some(({ t }) => CAPS_RESPONSE_TAGS.has(t))
}

export default class TLVDevice extends HADevice {
    query_timer: ReturnType<typeof setInterval> | undefined
    query_last_timestamp: number | undefined = undefined
    query_last_interval: number | undefined = undefined
    /*
     * A tag can carry more than one entity. The dehumidifier's target humidity is both a
     * humidifier slider and a number that steps the way the appliance does, and both are
     * tag 0x253. This used to be a single definition per tag, so the second registration
     * quietly replaced the first and the entity it belonged to simply stopped updating —
     * with nothing said about it. Keeping them all means every entity on a tag hears it.
     */
    fields_by_id: Record<number, FieldDefinition[]> = {}
    fields_by_ha: Record<string, FieldDefinition> = {}
    raw_clip_state: Record<number, number> = {}
    query_caps_timeout: ReturnType<typeof setInterval> | undefined = undefined
    query_values_timeout: ReturnType<typeof setInterval> | undefined = undefined
    /**
     * Refresh queries sent since the appliance last answered one.
     *
     * An appliance can be connected and say nothing for hours — most of them do, and being
     * quiet is not being gone. But a refresh query is a question, and one that goes
     * unanswered several times over is the appliance no longer listening. That happened to
     * the living-room dehumidifier: its socket stayed up, rethink asked two hundred and
     * sixty-four times, and Home Assistant went on showing the values from the last answer
     * as though they were current.
     */
    unansweredQueries = 0
    silent = false
    /**
     * What was last asked of the appliance and when, so a reply can be matched to it.
     *
     * These appliances answer the initial-values query with their capability table, over and
     * over, and rethink has no way to tell a fresh wrong answer from the same answer sent
     * twice: the frame carries a sequence byte the code has never looked at. Pairing the two
     * says which it is, and how long the appliance took.
     */
    lastAskedAt: number | undefined
    lastAskedFor: 'capabilities' | 'values' | undefined
    lastReplySequence: number | undefined

    constructor(
        HA: Connection,
        readonly thinq: Thinq2Device,
    ) {
        super(HA, thinq.id)
        thinq.on('data', (data) => this.processData(data))

        // initial capabilities query
        this.queryCaps()

        // retry every 15 s until caps are received
        this.query_caps_timeout = setInterval(() => {
            log('status', this.id, 're-trying capabilities query due to timeout')
            this.queryCaps()
        }, 15 * 1000)
    }

    // we waste memory by storing the field set per-device, not per-class. Whatever.
    addField(config: DeviceDiscovery, options: FieldDefinition, autoreg?: boolean) {
        if (options.id) {
            this.fields_by_id[options.id] ??= []
            this.fields_by_id[options.id].push(options)
        }

        const fullName = `${options.comp}-${options.name}`
        // Two entities on one topic is never intentional: the second shadows the first for
        // writes, and no amount of reading the device file makes that visible.
        if (this.fields_by_ha[fullName])
            log('status', this.id, `${fullName} is registered twice; the later one takes its commands`)
        this.fields_by_ha[fullName] = options

        if (autoreg !== false) {
            let topicPrefix: string = ''
            if (options.name !== '') {
                topicPrefix = `${options.name}_`
            }

            const target = config.components[options.comp] as unknown as Record<string, string>

            if (options.readable !== false) {
                const stateTopic = options.state_topic == null ? 'state_topic' : options.state_topic
                target[topicPrefix + stateTopic] = `$this/${fullName}`
            }

            if (options.writable !== false) target[`${topicPrefix}command_topic`] = `$this/${fullName}/set`
        }
    }

    // clip-side
    queryCaps() {
        this.send([1, 1, 2, 2, 1], [{ t: 0x1f5, v: 1 }])
        this.lastAskedAt = Date.now()
        this.lastAskedFor = 'capabilities'
        log('exchange', this.id, 'asked for capabilities')
    }

    query() {
        this.send([1, 1, 2, 2, 1], [{ t: 0x1f5, v: 2 }])
        this.query_last_timestamp = performance.now()
        this.lastAskedAt = Date.now()
        this.lastAskedFor = 'values'
        log('exchange', this.id, 'asked for values')
    }

    /**
     * Count a periodic refresh, and only that. The startup paths retry every fifteen
     * seconds until the appliance answers, so counting every query at all would call an
     * appliance silent three quarters of a minute in rather than three quarters of an hour.
     */
    private askedForRefresh() {
        this.unansweredQueries += 1
        if (this.unansweredQueries < UNANSWERED_QUERIES_BEFORE_SILENT || this.silent) return
        // Saying nothing is not the same as being unreachable, so this is not a disconnect:
        // the entities go unavailable rather than showing an answer nobody gave.
        this.silent = true
        log(
            'status',
            this.id,
            `has not answered ${this.unansweredQueries} refresh queries; its entities are unavailable until it does`,
        )
        this.HA.publishProperty(this.id, 'availability', 'offline')
    }

    /** The appliance answered, so whatever it says now is current again. */
    private heard() {
        this.unansweredQueries = 0
        if (!this.silent) return
        this.silent = false
        log('status', this.id, 'answered again; its entities are available')
        this.HA.publishProperty(this.id, 'availability', 'online')
    }

    setQueryInterval(interval: number = 15 * 60 * 1000) {
        if (this.query_timer !== undefined) {
            if (this.query_last_interval === interval) return

            if (this.query_last_timestamp != null && performance.now() - this.query_last_timestamp >= interval) {
                log('status', this.id, 'sending immediate refresh query due to changed interval to', interval / 1000)
                this.query()
            } else {
                log('status', this.id, 'changing refresh query interval to', interval / 1000)
            }

            clearInterval(this.query_timer)
        }
        this.query_timer = setInterval(() => {
            log('status', this.id, 'sending periodic refresh query')
            this.askedForRefresh()
            this.query()
        }, interval)
        this.query_last_interval = interval
    }

    start() {
        /*
         * Set initial query interval timer if something hasn't already set it.
         * Refresh every 15 minutes by default since not every tag change
         * generates async notify.
         */
        if (this.query_timer == null) this.setQueryInterval()
    }

    stopTimers() {
        if (this.query_timer !== undefined) {
            clearInterval(this.query_timer)
            this.query_timer = undefined
        }

        if (this.query_caps_timeout !== undefined) {
            clearInterval(this.query_caps_timeout)
            this.query_caps_timeout = undefined
        }

        if (this.query_values_timeout !== undefined) {
            clearInterval(this.query_values_timeout)
            this.query_values_timeout = undefined
        }

        super.stopTimers()
    }

    drop() {
        super.drop()
    }

    processData(buf: Buffer) {
        if (
            buf[2] === 0x04 &&
            buf[3] === 0x00 &&
            buf[4] === 0x00 &&
            buf[5] === 0x00 &&
            (buf[6] === 0x87 || buf[6] === 0xa7) &&
            buf[7] === 0x02 &&
            (buf[8] === 0x01 || buf[8] === 0x04) &&
            /* && buf[9] is a "sequence" number */ buf[10] === buf.length - 13
        ) {
            // ignore the CRC, we assume that the modem verifies it :/
            log('status', this.id, 'received TLV packet')
            const sequence = buf[9]
            const tlv = TLV.parse(buf.subarray(11, buf.length - 2))
            log(
                'exchange',
                this.id,
                `replied seq=${sequence}${sequence === this.lastReplySequence ? ' (same as last)' : ''}`,
                `${tlv.length} tags`,
                this.isCapsResponse(tlv) ? 'capabilities' : this.isValuesResponse(tlv) ? 'values' : 'neither',
                `to the ${this.lastAskedFor ?? 'nothing'} asked`,
                this.lastAskedAt ? `${Date.now() - this.lastAskedAt} ms earlier` : '',
            )
            this.lastReplySequence = sequence
            this.heard()
            this.processTLV(TLV.parse(buf.subarray(11, buf.length - 2)))
        }
        if (
            buf[1] === 0xff &&
            buf[2] === 0x04 &&
            buf[3] === 0x00 &&
            buf[4] === 0x00 &&
            buf[5] === 0x00 &&
            (buf[6] === 0x87 || buf[6] === 0xa7) &&
            buf[7] === 0xfd &&
            buf[8] === 0x03 &&
            buf[10] === buf.length - 13
        ) {
            this.processPrivData(buf[0], buf[9], buf.subarray(11, buf.length - 2))
        }
        if (
            (buf[0] === 0x02 || buf[0] === 0x03) &&
            buf[2] === 0x04 &&
            buf[3] === 0x00 &&
            buf[4] === 0x00 &&
            buf[5] === 0x00 &&
            (buf[6] === 0x87 || buf[6] === 0xa7) &&
            buf[7] === 0xfd &&
            buf[8] === 0x10 &&
            buf[9] === 0x00 &&
            buf[10] === 0x05 &&
            buf[11] === 0xfe &&
            buf[12] != null
        ) {
            this.processPrivDataCmdResp(buf[0] === 0x02, buf[1], buf[12], buf.subarray(13, buf.length - 2))
        }
    }

    send(header: number[], tlv: TLV.TLV[]) {
        const [b0, b1, b2, b3, b4] = header
        const tlvArray = TLV.build(tlv)
        let buf = [0x04, 0x00, 0x00, 0x00, 0x65, b2, b3, b4, tlvArray.length].concat(tlvArray)
        const result = crc16(buf)
        buf = [b0, b1].concat(buf, [result >> 8, result & 0xff])
        this.thinq.send_packet(Buffer.from(buf))
    }

    isCapsResponse(_tlvArray: TLV.TLV[]) {
        /* To be overridden */
        return false
    }

    isValuesResponse(_tlvArray: TLV.TLV[]) {
        /* To be overridden */
        return false
    }

    sendPrivCommand(cmd: number, cmd_sub: number, data: Buffer = Buffer.alloc(0)) {
        const cmdDataLen = data.length + 1
        const header = Buffer.from([
            0x00,
            0xff,
            0x04,
            0x00,
            0x00,
            0x00,
            0x65,
            0xfd,
            cmd_sub,
            cmdDataLen >> 8,
            cmdDataLen & 0xff,
            cmd,
        ])
        let buf = Buffer.concat([header, data])

        const crc = crc16(buf.subarray(2))
        buf = Buffer.concat([buf, Buffer.from([crc >> 8, crc & 0xff])])

        this.thinq.send_packet(buf)
    }

    capabilityReceived() {
        /* To be overridden if necessary */
    }

    valuesReceived() {
        /* To be overridden if necessary */
    }

    processPrivData(_cmd: number, _buf9: number, _data: Buffer) {
        /* To be overridden */
    }

    processPrivDataCmdResp(_success: boolean, _buf1: number, _cmd: number, _data: Buffer) {
        /* To be overridden */
    }

    processTLV(tlvArray: TLV.TLV[]) {
        tlvArray.forEach(({ t, v }) => {
            this.processKeyValue(t, v)
        })

        // capabilities are expected to be received only at the init time
        if (this.query_caps_timeout !== undefined && this.isCapsResponse(tlvArray)) {
            log('status', this.id, 'received capability key')
            clearInterval(this.query_caps_timeout)
            this.query_caps_timeout = undefined
            this.capabilityReceived()

            // perform initial values query
            this.query()

            /*
             * Retry at a fixed interval. Backing off was tried and was the wrong reading of
             * the evidence: an appliance that will not answer sends the same capability
             * table however often it is asked, and asking less often only takes longer to
             * find out. The one that recovered did so from a single query it answered four
             * times over, so what matters is being there when it does.
             */
            this.query_values_timeout = setInterval(() => {
                log('status', this.id, 're-trying initial values query due to timeout')
                this.query()
            }, INITIAL_VALUES_RETRY_MS)
        }

        // values are expected to be received also post-init time
        // but don't process them until capabilities are received
        if (this.query_caps_timeout === undefined && this.isValuesResponse(tlvArray)) {
            if (this.query_values_timeout !== undefined) {
                log('status', this.id, 'received initial values key')
                clearInterval(this.query_values_timeout)
                this.query_values_timeout = undefined
            }
            this.valuesReceived()
        }
    }

    processKeyValue(k: number, v: number) {
        this.raw_clip_state[k] = v

        for (const def of this.fields_by_id[k] ?? []) this.publishKeyValue(def, v)
    }

    private publishKeyValue(def: FieldDefinition, v: number) {
        let processed: string | number = v

        if (def.read_xform) {
            const tmp = def.read_xform(processed)
            if (tmp === undefined) return
            processed = tmp
        }

        var doRead = true
        if (def.read_callback) doRead = def.read_callback(processed)
        if (doRead) {
            if (def.readable === false) return

            const fullName = `${def.comp}-${def.name}`
            this.HA.publishProperty(this.id, fullName, processed)
        }
    }

    // HA-side
    setProperty(prop: string, mqttValue: string) {
        //console.log("HA write", prop, mqttValue)
        const def = this.fields_by_ha[prop]
        if (!def || def.writable === false) {
            console.warn(`Attempting to set property ${prop} which is not writable`)
            return
        }

        let value: string | number | null | undefined
        if (def.write_xform) value = def.write_xform(mqttValue)

        if (value === null || value === undefined) return

        if (typeof value === 'string') value = Number(value)

        var doWrite = true
        if (def.write_callback) doWrite = def.write_callback(value)
        if (doWrite && def.id !== undefined) {
            this.raw_clip_state[def.id] = value

            let attach: number[] = []
            if (Array.isArray(def.write_attach)) attach = def.write_attach
            if (typeof def.write_attach === 'function') attach = def.write_attach(value)

            const write_fields = [def.id].concat(attach)
            const tlvArray = write_fields.map((id) => ({ t: id, v: this.raw_clip_state[id] }))
            //console.log("Sending ", tlvArray)
            this.send(this.writeHeader(), tlvArray)
        }
    }

    protected writeHeader() {
        return [1, 1, 2, 1, 1]
    }
}
