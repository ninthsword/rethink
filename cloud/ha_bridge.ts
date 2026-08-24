import log from '@/util/logging'
import Dev_2REB1GLVB1__2 from './devices/2REB1GLVB1__2'
import Dev_2REF11EBIVPC4 from './devices/2REF11EBIVPC4'
import Dev_2REF11EIDA__4 from './devices/2REF11EIDA__4'
import Dev_2REF12EJIS__2 from './devices/2REF12EJIS__2'
import Dev_2REK1G03VI1902 from './devices/2REK1G03VI1902'
import Dev_2RES1VE61NFA2 from './devices/2RES1VE61NFA2'
import Dev_2RES1VE600FWC from './devices/2RES1VE600FWC'
import Dev_2RES2VE300UA2 from './devices/2RES2VE300UA2'
import AIR_910604_WW from './devices/AIR_910604_WW'
import type HADevice from './devices/base'
import D121111 from './devices/D121111'
import DHUM_056905_WW from './devices/DHUM_056905_WW'
import DHUM_056905_WW_ThinQ1 from './devices/DHUM_056905_WW_ThinQ1'
import F_V__F___W_B_1QEUK from './devices/F_V__F___W.B_1QEUK'
import F_V8_Y___W_B_2QEUK from './devices/F_V8_Y___W.B_2QEUK'
import F_VB_F___W_B_2QEUK from './devices/F_VB_F___W.B_2QEUK'
import F3L2CYU__ from './devices/F3L2CYU__'
import F21VDT_AKOR from './devices/F21VDT_AKOR'
import Hd0C_F from './devices/Hd0C_F'
import PAC_910604_WW from './devices/PAC_910604_WW'
import Pd0F_F from './devices/Pd0F_F'
import POT_056905_WW from './devices/POT_056905_WW'
import RAC_056905_WW from './devices/RAC_056905_WW'
import RH16KR from './devices/RH16KR'
import RV13B6BSD_D_US_WIFI from './devices/RV13B6BSD_D_US_WIFI'
import RV13U6AM8W_D_US_WIFI from './devices/RV13U6AM8W_D_US_WIFI'
import T1789EFH_F from './devices/T1789EFH_F'
import VCDWL2QEUK from './devices/VCDWL2QEUK'
import WIN_056905_WW from './devices/WIN_056905_WW'
import WTDN3 from './devices/WTDN3'
import Y_V8_F___W_B_2QEUK from './devices/Y_V8_F___W.B_2QEUK'
import Y_V8_Y___W_B32QEUK from './devices/Y_V8_Y___W.B32QEUK'
import type { AnyDevice } from './devmgr'
import type { Connection } from './homeassistant'
import type { Metadata } from './thinq'
import type { Device as T1Device } from './thinq1/device'
import type { Device as T2Device } from './thinq2/device'

type T1Factory = new (HA: Connection, thinq: T1Device, metadata: Metadata) => HADevice
type T2Factory = new (HA: Connection, thinq: T2Device, metadata: Metadata) => HADevice

const t1deviceTypes: Record<string, T1Factory> = {
    WTDN3,
    AIR_910604_WW,
    DHUM_056905_WW: DHUM_056905_WW_ThinQ1,
}

const t2deviceTypes: Record<string, T2Factory> = {
    POT_056905_WW,
    RAC_056905_WW,
    PAC_910604_WW,
    RAC_0B0001_WW: RAC_056905_WW, // a different European variant (deviceType 401, RTK_RTL8720cm), same TLV handler
    WINF_056905_WW: RAC_056905_WW, // Korean wall-mounted cooling-only variant, same RAC TLV protocol
    WIN_056905_WW,
    DHUM_056905_WW,
    '2REF11EIDA__4': Dev_2REF11EIDA__4,
    '2REF11EBIVPC4': Dev_2REF11EBIVPC4,
    '2REF12EJIS__2': Dev_2REF12EJIS__2, // Korean four-door refrigerator
    '2RES1VE61NFA2': Dev_2RES1VE61NFA2,
    '2REB1GLVB1__2': Dev_2REB1GLVB1__2,
    '2RES1VE600FWC': Dev_2RES1VE600FWC,
    '2RES2VE300UA2': Dev_2RES2VE300UA2, // Korean refrigerator
    'Y_V8_Y___W.B32QEUK': Y_V8_Y___W_B32QEUK,
    'F_V7_Y___W.B_2QEUK': F_V8_Y___W_B_2QEUK, // NOTE: we reuse F_V8_Y___W_B_2QEUK as the models appear to be compatible
    'F_V8_Y___W.B_2QEUK': F_V8_Y___W_B_2QEUK,
    'Y_V8_F___W.B_2QEUK': Y_V8_F___W_B_2QEUK,
    'F_V__Y___W.B_2QEUK': F_V8_Y___W_B_2QEUK, // NOTE: we reuse F_V8_Y___W_B_2QEUK as the models appear to be compatible
    VCDWL2QEUK: VCDWL2QEUK, // LG F4X7511TWS front-load washer (matched on modelId VCDWL2QEUK)
    'F_V__F___W.B_1QEUK': F_V__F___W_B_1QEUK,
    'F_VB_F___W.B_2QEUK': F_VB_F___W_B_2QEUK, // LG CV74J7S2QA washer/dryer combo
    T1789EFH_F: T1789EFH_F, // LG WT7300CW top-loading washer
    Hd0C_F: Hd0C_F, // Korean top-loading washer
    RV13U6AM8W_D_US_WIFI: RV13U6AM8W_D_US_WIFI, // LG DLE7300WE dryer
    F3L2CYU__: F3L2CYU__, // LG front-load washer
    RV13B6BSD_D_US_WIFI: RV13B6BSD_D_US_WIFI, // LG electric dryer
    F21VDT_AKOR: F21VDT_AKOR, // Korean front-loading washer
    RH16KR: RH16KR, // Korean dryer
    // The same dryer reports this model id after being registered afresh in the ThinQ
    // app; its packets are byte-for-byte what the handler already reads.
    RH16_N_KR: RH16KR,
    '2REK1G03VI1902': Dev_2REK1G03VI1902, // Korean kimchi refrigerator
    Pd0F_F: Pd0F_F, // Korean mini washer
    D121111: D121111, // Korean dishwasher
}

class Bridge {
    haDevices = new Map<string, HADevice>()
    pendingDrops = new Map<string, { device: HADevice; timer: ReturnType<typeof setTimeout> }>()

    constructor(
        readonly HA: Connection,
        readonly disconnectGraceMs = 2000,
    ) {
        HA.on('discovery', () => {
            this.haDevices.forEach((ha) => {
                ha.publishConfig()
            })
        })
        HA.on('setProperty', (id: string, prop: string, value: string) => {
            const ha = this.haDevices.get(id)
            if (ha) ha.setProperty(prop, value)
        })
    }

    refreshDiscovery() {
        this.haDevices.forEach((device) => {
            device.publishConfig()
        })
    }

    newDevice(thinqdev: AnyDevice) {
        const meta = thinqdev.meta

        let hadevice: HADevice | undefined

        /*
         * modelName is tried when modelId misses because LG renames a model without the
         * appliance changing: this dryer went from RH16KR to RH16_N_KR with a firmware
         * update, and only a hand-added alias kept its entities alive. The two fields do not
         * always move together, so the one that still matches a handler wins.
         */
        const handlerFor = (table: Record<string, T1Factory | T2Factory>) =>
            table[meta.modelId] ?? (meta.modelName ? table[meta.modelName] : undefined)

        if (thinqdev.platform === 'thinq1') {
            const devclass = handlerFor(t1deviceTypes) as T1Factory | undefined
            if (devclass) hadevice = new devclass(this.HA, thinqdev, meta)
        } else if (thinqdev.platform === 'thinq2') {
            const devclass = handlerFor(t2deviceTypes) as T2Factory | undefined
            if (devclass) hadevice = new devclass(this.HA, thinqdev, meta)
        }

        if (!hadevice) {
            // The appliance is connected and bridging; it simply has no handler, so it
            // produces no Home Assistant entities. That is easy to mistake for a
            // connection problem — the dryer was, after being re-registered under a model
            // id nothing here knew — so say what it is and what to do about it.
            log(
                'status',
                `no handler for ${thinqdev.platform} model ${meta.modelId}` +
                    (meta.modelName && meta.modelName !== meta.modelId ? ` (name ${meta.modelName})` : '') +
                    `; ${thinqdev.id} will have no Home Assistant entities`,
            )
            return
        }

        const pendingDrop = this.pendingDrops.get(thinqdev.id)
        if (pendingDrop) {
            clearTimeout(pendingDrop.timer)
            this.pendingDrops.delete(thinqdev.id)
        }

        /*
         * Clearing that timer took away the only thing that would ever have called drop()
         * on the handler being replaced, and nothing else holds a reference to it — nothing
         * except its own intervals, which keep it alive and keep it working. Its queries go
         * onto the broker topic the live appliance is subscribed to, so the appliance really
         * does receive them; the answers go to the connection that closed. After three
         * unanswered refreshes it publishes offline under the same id the replacement is
         * using, and a healthy appliance goes unavailable in Home Assistant.
         *
         * So the superseded handler is silenced here. Not dropped: drop() would publish
         * offline, which is the flicker the replacement path exists to avoid.
         */
        const superseded = this.haDevices.get(thinqdev.id)
        if (superseded && superseded !== hadevice) superseded.stopTimers()

        // A ThinQ appliance may establish its replacement MQTT connection
        // before the old socket closes (notably shortly after a washer powers
        // itself off). The new handler publishes online during construction,
        // so publishing offline for the old handler here only creates a brief
        // unavailable -> available flicker for every entity. The old close
        // listener is identity-guarded by dropDevice() and cannot take the
        // replacement offline after this map entry is updated.
        this.haDevices.set(thinqdev.id, hadevice)
        thinqdev.on('close', () => this.dropDevice(hadevice))

        // hadevice.publishConfig() not needed anymore, will usually happen in the devclass constructor - or later
        hadevice.start()
    }

    dropDevice(ha: HADevice) {
        if (this.haDevices.get(ha.id) === ha) {
            const previous = this.pendingDrops.get(ha.id)
            if (previous) clearTimeout(previous.timer)

            const pending: { device: HADevice; timer: ReturnType<typeof setTimeout> } = {
                device: ha,
                timer: setTimeout(() => {
                    if (this.haDevices.get(ha.id) === ha) {
                        this.haDevices.delete(ha.id)
                        ha.drop()
                    }
                    if (this.pendingDrops.get(ha.id) === pending) this.pendingDrops.delete(ha.id)
                }, this.disconnectGraceMs),
            }
            this.pendingDrops.set(ha.id, pending)
        }
    }
}

export default Bridge
