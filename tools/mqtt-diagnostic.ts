import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { isIP } from 'node:net'
import { dirname, resolve } from 'node:path'
import { type ConnectionOptions, checkServerIdentity } from 'node:tls'
import { connect, type IClientOptions } from 'mqtt'
import { isSafeDeviceId } from '../cloud/device_id'
import { isDNSHostname } from '../util/hostname'

const settingsError = () => new Error('MQTT 진단 설정 파일과 접근 권한을 확인하세요.')

export function loadDiagnosticSettings(filename = process.env.RETHINK_MQTT_DIAGNOSTIC_CONFIG) {
    let descriptor: number | undefined
    try {
        if (!filename) throw settingsError()
        descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        const stat = fstatSync(descriptor)
        if (
            !stat.isFile() ||
            stat.uid !== process.getuid?.() ||
            (stat.mode & 0o7777) !== 0o600 ||
            stat.nlink !== 1 ||
            stat.size > 16 * 1024
        )
            throw settingsError()
        const buffer = Buffer.alloc(16 * 1024 + 1)
        const size = readSync(descriptor, buffer, 0, buffer.length, 0)
        if (size > 16 * 1024) throw settingsError()
        const settings = JSON.parse(buffer.subarray(0, size).toString('utf-8'))
        const url = new URL(settings.url)
        if (
            url.protocol !== 'mqtts:' ||
            url.username ||
            url.password ||
            url.pathname !== '' ||
            url.search ||
            url.hash ||
            (url.port && (!Number.isInteger(Number(url.port)) || Number(url.port) < 1)) ||
            typeof settings.username !== 'string' ||
            !/^[A-Za-z0-9_.-]{1,64}$/.test(settings.username) ||
            typeof settings.password !== 'string' ||
            Buffer.byteLength(settings.password) < 16 ||
            Buffer.byteLength(settings.password) > 256 ||
            typeof settings.ca_file !== 'string' ||
            !settings.ca_file ||
            !Array.isArray(settings.device_ids) ||
            settings.device_ids.length < 1 ||
            settings.device_ids.length > 128 ||
            !settings.device_ids.every(isSafeDeviceId) ||
            new Set(settings.device_ids).size !== settings.device_ids.length ||
            (settings.allow_publish !== undefined && typeof settings.allow_publish !== 'boolean')
        )
            throw settingsError()
        const hostname = url.hostname.replace(/^\[|\]$/g, '')
        const expected = settings.servername ?? hostname
        if (
            typeof expected !== 'string' ||
            !isDNSHostname(expected) ||
            (settings.servername !== undefined && !isIP(hostname) && expected !== hostname)
        )
            throw settingsError()
        const ca = readFileSync(resolve(dirname(filename), settings.ca_file))
        if (!ca.length || ca.length > 256 * 1024) throw settingsError()
        return {
            url,
            username: settings.username as string,
            password: settings.password as string,
            ca,
            servername: expected,
            deviceIds: settings.device_ids as string[],
            allowPublish: settings.allow_publish === true,
        }
    } catch {
        throw settingsError()
    } finally {
        if (descriptor !== undefined) closeSync(descriptor)
    }
}

export function connectDiagnostic(endpoint: string, deviceId: string, write = false) {
    const settings = loadDiagnosticSettings()
    let target: URL
    try {
        target = new URL(`mqtts://${endpoint}`)
    } catch {
        throw settingsError()
    }
    if (
        !isSafeDeviceId(deviceId) ||
        !settings.deviceIds.includes(deviceId) ||
        (write && !settings.allowPublish) ||
        target.hostname !== settings.url.hostname ||
        (target.port || '8883') !== (settings.url.port || '8883') ||
        target.username ||
        target.password ||
        target.pathname !== '' ||
        target.search ||
        target.hash
    )
        throw settingsError()
    const options: IClientOptions & ConnectionOptions = {
        username: settings.username,
        password: settings.password,
        ca: settings.ca,
        servername: settings.servername,
        rejectUnauthorized: true,
        checkServerIdentity: (_hostname, cert) => checkServerIdentity(settings.servername, cert),
        reconnectPeriod: 0,
        connectTimeout: 10_000,
    }
    const client = connect(settings.url.toString(), options)
    let failed = false
    const fail = () => {
        if (!failed) console.error('MQTT 진단 연결에 실패했습니다. 인증 정보와 TLS 인증서를 확인하세요.')
        failed = true
        process.exitCode = 1
        client.end(true)
    }
    client.on('error', fail)
    client.on('close', () => {
        if (!client.disconnecting) fail()
    })
    return client
}

export function diagnosticCLI(endpoint: string, deviceId: string, write = false) {
    try {
        return connectDiagnostic(endpoint, deviceId, write)
    } catch {
        console.error('MQTT 진단 설정 파일과 기기 권한을 확인하세요.')
        process.exit(1)
    }
}
