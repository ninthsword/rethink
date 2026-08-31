import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'

export type SubprocessOptions = {
    timeoutMs?: number
    maxOutputBytes?: number
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024
const MAX_TIMEOUT_MS = 2_147_483_647

const ERRORS = {
    outputLimit: 'Subprocess stdout limit exceeded',
    start: 'Subprocess failed to start',
    timeout: 'Subprocess timed out',
    signal: 'Subprocess terminated by signal',
    status: 'Subprocess exited unsuccessfully',
} as const

function optionNumber(value: number | undefined, fallback: number, allowZero: boolean): number {
    if (value === undefined) return fallback
    if (
        !Number.isSafeInteger(value) ||
        (allowZero ? value < 0 : value <= 0) ||
        (!allowZero && value > MAX_TIMEOUT_MS)
    ) {
        throw new RangeError('Invalid subprocess option')
    }
    return value
}

/**
 * Run a child process with bounded output and a deadline.
 *
 * The child is placed in its own process group on POSIX systems so a timeout or
 * output-limit failure also terminates descendants (for example, a shell pipe).
 * Failure messages intentionally contain no command, arguments, or child output.
 */
export function subprocess(
    command: string,
    args: string[],
    stdin: string = '',
    options: SubprocessOptions = {},
): Promise<string> {
    const timeoutMs = optionNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS, false)
    const maxOutputBytes = optionNumber(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, true)

    return new Promise((resolve, reject) => {
        let child: ChildProcessWithoutNullStreams
        try {
            child = spawn(command, args, { detached: process.platform !== 'win32' })
        } catch {
            reject(new Error(ERRORS.start))
            return
        }
        const output: Buffer[] = []
        let outputBytes = 0
        let failure: Error | undefined
        let settled = false
        let terminationRequested = false

        const terminate = () => {
            if (terminationRequested) return
            terminationRequested = true
            child.stdin.destroy()
            try {
                if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
                else child.kill('SIGKILL')
            } catch {
                // The child may have exited between the failure and kill request.
            }
        }

        const fail = (message: string) => {
            if (settled) return
            if (!failure) failure = new Error(message)
            terminate()
        }

        const timer = setTimeout(() => fail(ERRORS.timeout), timeoutMs)
        timer.unref()

        child.stdout.on('data', (data: Buffer) => {
            const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data)
            if (chunk.length > maxOutputBytes - outputBytes) {
                fail(ERRORS.outputLimit)
                return
            }
            output.push(chunk)
            outputBytes += chunk.length
        })
        // Drain stderr to avoid backpressure, but never retain or expose it.
        child.stderr.on('data', () => {})
        // A child that exits without reading stdin can legitimately close the pipe early.
        child.stdin.on('error', () => {})
        child.once('error', () => fail(ERRORS.start))
        child.once('close', (code, signal) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            if (failure) reject(failure)
            else if (signal) reject(new Error(ERRORS.signal))
            else if (code !== 0) reject(new Error(ERRORS.status))
            else resolve(Buffer.concat(output, outputBytes).toString('utf-8'))
        })

        child.stdin.end(stdin)
    })
}
