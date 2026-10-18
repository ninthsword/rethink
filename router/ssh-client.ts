import { createHash, timingSafeEqual } from 'node:crypto'
import { Client, type ClientChannel } from 'ssh2'
import { isHostKeyFingerprint, type RouterSSHConfig } from './config-store'

export type SSHResult = { code: number; stdout: string; stderr: string }

export class RouterSSHClient {
    private client = new Client()
    private connected = false

    constructor(readonly config: RouterSSHConfig) {
        // Keep late transport errors handled after cancellation removes operation listeners.
        this.client.on('error', () => {})
        this.client.on('close', () => {
            this.connected = false
        })
    }

    connect(options: { signal?: AbortSignal } = {}) {
        if (options.signal?.aborted) return Promise.reject(new Error('공유기 SSH 연결이 취소되었습니다.'))
        if (this.connected) return Promise.resolve()
        if (!isHostKeyFingerprint(this.config.hostKeyFingerprint))
            return Promise.reject(new Error('공유기 SSH 호스트 키 지문을 확인하고 저장하세요.'))
        const expected = Buffer.from(this.config.hostKeyFingerprint.slice(7), 'base64')
        return new Promise<void>((resolve, reject) => {
            let settled = false
            const finish = (error?: Error) => {
                if (settled) return
                settled = true
                options.signal?.removeEventListener('abort', onAbort)
                this.client.removeListener('error', onError)
                this.client.removeListener('ready', onReady)
                this.client.removeListener('close', onClose)
                if (error) {
                    this.client.destroy()
                    reject(error)
                } else {
                    this.connected = true
                    resolve()
                }
            }
            const onAbort = () => finish(new Error('공유기 SSH 연결이 취소되었습니다.'))
            const onClose = () => finish(new Error('공유기 SSH 연결이 종료되었습니다.'))
            const onError = (err: Error) => finish(err)
            const onReady = () => finish()
            options.signal?.addEventListener('abort', onAbort, { once: true })
            this.client.once('error', onError)
            this.client.once('close', onClose)
            this.client.once('ready', onReady)
            try {
                this.client.connect({
                    host: this.config.host,
                    port: this.config.port,
                    username: this.config.username,
                    password: this.config.password,
                    readyTimeout: 5000,
                    hostVerifier: (key) => timingSafeEqual(createHash('sha256').update(key).digest(), expected),
                })
            } catch (error) {
                finish(error instanceof Error ? error : new Error('공유기 SSH 연결에 실패했습니다.'))
            }
        })
    }

    exec(command: string, options: { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number } = {}) {
        return new Promise<SSHResult>((resolve, reject) => {
            let channel: ClientChannel | undefined
            let settled = false,
                bytes = 0
            let stdout = '',
                stderr = ''
            const finish = (error?: Error, code?: number) => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                options.signal?.removeEventListener('abort', onAbort)
                this.client.removeListener('close', onClose)
                this.client.removeListener('error', onError)
                if (error) {
                    channel?.destroy()
                    this.client.destroy()
                    this.connected = false
                    reject(error)
                } else resolve({ code: code ?? 0, stdout, stderr })
            }
            const onAbort = () => finish(new Error('공유기 SSH 조회가 취소되었습니다.'))
            const onClose = () => finish(new Error('공유기 SSH 조회가 종료되었습니다.'))
            const onError = (error: Error) => finish(error)
            const timer =
                options.timeoutMs === undefined
                    ? undefined
                    : setTimeout(() => finish(new Error('공유기 SSH 조회 시간이 초과되었습니다.')), options.timeoutMs)
            if (options.signal?.aborted) {
                onAbort()
                return
            }
            options.signal?.addEventListener('abort', onAbort, { once: true })
            this.client.once('close', onClose)
            this.client.once('error', onError)
            const data = (value: Buffer, isError: boolean) => {
                if (settled) return
                bytes += value.length
                if (options.maxBytes !== undefined && bytes > options.maxBytes) {
                    finish(new Error('공유기 SSH 조회 결과가 너무 큽니다.'))
                    return
                }
                if (isError) stderr += value.toString('utf-8')
                else stdout += value.toString('utf-8')
            }
            try {
                this.client.exec(command, (err, stream) => {
                    if (settled) {
                        stream?.destroy()
                        return
                    }
                    if (err) {
                        finish(err)
                        return
                    }
                    channel = stream
                    stream.on('data', (value: Buffer) => data(value, false))
                    stream.stderr.on('data', (value: Buffer) => data(value, true))
                    stream.on('error', onError)
                    stream.on('close', (code: number | undefined) => {
                        if (code === undefined && options.maxBytes !== undefined)
                            finish(new Error('공유기 SSH 조회 결과가 불완전합니다.'))
                        else finish(undefined, code)
                    })
                })
            } catch (error) {
                finish(error instanceof Error ? error : new Error('공유기 SSH 조회에 실패했습니다.'))
            }
        })
    }

    close() {
        this.client.end()
        this.connected = false
    }
}
