import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { type Request, type Response, Router } from 'express'
import { XMLBuilder, XMLParser } from 'fast-xml-parser'
import type { Config } from '@/util/config'
import type { Metadata } from '../thinq'

const XML_HEADER = '<?xml version="1.0" encoding="utf-8" standalone="yes"?>'

const deviceMeta: Record<string, Metadata> = {}
let metadataFile: string | undefined

function configureMetadataStorage(config: Config) {
    const filename = config.bridge?.storage_path
        ? resolve(config.bridge.storage_path, 'thinq1-metadata.json')
        : undefined
    if (!filename || metadataFile === filename) return
    metadataFile = filename
    try {
        const saved = JSON.parse(readFileSync(filename, 'utf-8')) as Record<string, Metadata>
        for (const [id, meta] of Object.entries(saved)) {
            if (meta && typeof meta.modelId === 'string' && typeof meta.modelName === 'string') deviceMeta[id] = meta
        }
    } catch {
        // The file is optional and is created after the first metadata request.
    }
}

function persistMetadata() {
    if (!metadataFile) return
    mkdirSync(dirname(metadataFile), { recursive: true })
    const temporary = `${metadataFile}.tmp`
    writeFileSync(temporary, JSON.stringify(deviceMeta, null, 2), { mode: 0o600 })
    renameSync(temporary, metadataFile)
}

export function getDeviceMetadata(id: string) {
    return deviceMeta[id]
}

function xmlParser(req: Request, res: Response, next: () => void) {
    const buffers: Buffer[] = []
    let length = 0
    let error = false

    req.on('data', (data) => {
        if (!error) {
            buffers.push(data)
            length += data.length
            if (length > 1000000) {
                res.status(400).end()
                error = true
            }
        }
    })

    req.on('end', () => {
        if (!error) {
            req.body = new XMLParser().parse(Buffer.concat(buffers))
            next()
        }
    })
}

export function routes(config: Config) {
    configureMetadataStorage(config)
    const router = Router()
    router.use(xmlParser)

    router.post('/lgehadm/api/Device/TotalDeviceInfoSvc', (req, res) => {
        const response: { returnCd: string; returnMsg: string; itemList?: object } = {
            returnCd: '0000',
            returnMsg: 'OK',
        }

        const deviceId = req.header('x-lgedm-deviceid')
        const deviceType = req.header('x-lgedm-devicetype')
        const modelName = req.body?.lgedmRoot?.modelName
        if (!deviceId) return res.status(400).end()

        if (modelName && deviceType) {
            deviceMeta[deviceId] = {
                deviceType,
                modelId: modelName,
                modelName,
            }
            persistMetadata()
        }

        if (req.body?.lgedmRoot?.itemList?.item === 'DM_SETTING_INFO_GET_URI') {
            response.itemList = {
                elementList: {
                    elementCode: 'settingInfoList',
                    elementValueList: {
                        code: 'BlackBox',
                        value: 'N',
                    },
                },
                item: 'DM_SETTING_INFO_GET_URI',
                returnCode: '0000',
            }
        } else if (req.body?.lgedmRoot?.itemList?.item === 'THINQ_TIME_SYNC_URI') {
            response.itemList = {
                elementList: [
                    {
                        elementCode: 'utcTime',
                        elementValue: new Date()
                            .toISOString()
                            .replace(/T|\....Z/g, ' ')
                            .trim(),
                    },
                    {
                        elementCode: 'timezone',
                        elementValue: 0,
                    },
                ],
                item: 'THINQ_TIME_SYNC_URI',
                returnCode: '0000',
            }
        }

        res.header('Content-type: text/xml;charset=utf-8')
        res.end(XML_HEADER + new XMLBuilder().build({ lgedmRoot: response }))
    })

    router.post('/lgehadm/api/Grid/PowerSavingInfoSvc', (_req, res) => {
        res.header('Content-type: text/xml;charset=utf-8')
        res.end(XML_HEADER + new XMLBuilder().build({ lgedmRoot: { returnCd: '0108', returnMsg: 'No Saving Data.' } }))
    })

    router.post('/lgehadm/api/Rtos/FWInfoSettingSvc', (_req, res) => {
        res.header('Content-type: text/xml;charset=utf-8')
        res.end(XML_HEADER + new XMLBuilder().build({ lgedmRoot: { returnCd: '0000', returnMsg: 'OK' } }))
    })

    router.post('/lgehadm/report/diagmon', (_req, res) => {
        res.end()
    })

    return router
}
