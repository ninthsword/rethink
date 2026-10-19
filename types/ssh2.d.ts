declare module 'ssh2' {
    import { EventEmitter } from 'node:events'
    import { Server as NetServer } from 'node:net'

    export type ClientChannel = EventEmitter & { stderr: EventEmitter; destroy(): void }

    export type ConnectConfig = {
        host: string
        port?: number
        username: string
        password?: string
        readyTimeout?: number
        hostVerifier?: (key: Buffer) => boolean
    }

    export class Client extends EventEmitter {
        connect(config: ConnectConfig): this
        exec(command: string, callback: (err: Error | undefined, stream: ClientChannel) => void): void
        end(): void
        destroy(): void
    }

    export class Server extends NetServer {
        constructor(options: { hostKeys: Buffer[] }, listener: (client: EventEmitter & { end(): void }) => void)
    }
    export const utils: { parseKey(key: Buffer): { getPublicSSH(): Buffer } }
}
