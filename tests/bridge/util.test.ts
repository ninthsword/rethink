import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { test } from 'node:test'
import { subprocess } from '@/bridge/util'

const shell = '/bin/sh'
const processObservationTimeoutMs = 5_000
const processObservationYieldMs = 10

type ProcessObservation =
    | { status: 'absent' }
    | { status: 'visible'; state: string | null; processGroup: number | null }

function hasErrorCode(error: unknown, code: string): boolean {
    return error instanceof Error && 'code' in error && error.code === code
}

function observeProcess(pid: number, expectedProcessGroup?: number): ProcessObservation {
    try {
        process.kill(pid, 0)
    } catch (error) {
        if (hasErrorCode(error, 'ESRCH')) return { status: 'absent' }
        throw error
    }

    if (process.platform !== 'linux') return { status: 'visible', state: null, processGroup: null }

    let stat: string
    try {
        stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return { status: 'absent' }
        throw error
    }

    const closingParenthesis = stat.lastIndexOf(')')
    const [state, , processGroupText] =
        closingParenthesis > 0 && stat[closingParenthesis + 1] === ' '
            ? stat
                  .slice(closingParenthesis + 1)
                  .trim()
                  .split(/\s+/)
            : []
    if (state?.length !== 1 || processGroupText === undefined || !/^[1-9]\d*$/.test(processGroupText)) {
        throw new Error(`Malformed process stat for PID ${pid}`)
    }

    const processGroup = Number(processGroupText)
    if (!Number.isSafeInteger(processGroup)) throw new Error(`Malformed process stat for PID ${pid}`)
    if (expectedProcessGroup !== undefined && processGroup !== expectedProcessGroup) {
        throw new Error(`Process group mismatch for PID ${pid}: expected ${expectedProcessGroup}, got ${processGroup}`)
    }

    return { status: 'visible', state, processGroup }
}

function isProcessNotRunning(observation: ProcessObservation): boolean {
    return (
        observation.status === 'absent' ||
        observation.state === 'Z' ||
        observation.state === 'X' ||
        observation.state === 'x'
    )
}

function describeProcessObservation(observation: ProcessObservation): string {
    if (observation.status === 'absent') return 'state=absent, pgrp=none'
    return `state=${observation.state ?? 'visible'}, pgrp=${observation.processGroup ?? 'unavailable'}`
}

async function waitForProcessNotRunning(pid: number, expectedProcessGroup: number): Promise<void> {
    const deadline = performance.now() + processObservationTimeoutMs
    while (true) {
        const observation = observeProcess(pid, expectedProcessGroup)
        if (isProcessNotRunning(observation)) return
        if (performance.now() >= deadline) {
            assert.fail(
                `Process ${pid} remained running after ${processObservationTimeoutMs}ms (${describeProcessObservation(observation)})`,
            )
        }
        await new Promise<void>((resolve) => setTimeout(resolve, processObservationYieldMs))
    }
}

test('subprocess returns bounded stdout and accepts stdin', async () => {
    const output = await subprocess(shell, ['-c', 'cat'], 'hello', {
        timeoutMs: 1_000,
        maxOutputBytes: 5,
    })
    assert.equal(output, 'hello')
})

test('subprocess rejects nonzero exits without exposing stderr', async () => {
    await assert.rejects(subprocess(shell, ['-c', 'printf private-stderr-secret >&2; exit 7']), (error: Error) => {
        assert.equal(error.message, 'Subprocess exited unsuccessfully')
        assert.doesNotMatch(error.message, /private-stderr-secret/)
        return true
    })
})

test('subprocess rejects signal termination with a generic error', async () => {
    await assert.rejects(subprocess(shell, ['-c', 'kill -TERM $$']), (error: Error) => {
        assert.equal(error.message, 'Subprocess terminated by signal')
        return true
    })
})

test('subprocess rejects spawn errors without exposing command details', async () => {
    await assert.rejects(subprocess('/definitely/missing/rethink-subprocess-command', []), (error: Error) => {
        assert.equal(error.message, 'Subprocess failed to start')
        assert.doesNotMatch(error.message, /definitely|rethink-subprocess-command/)
        return true
    })
})

test('subprocess terminates the timed-out child and its process group', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rethink-subprocess-'))
    const marker = join(directory, 'pid')
    let shellPid: number | undefined
    let backgroundPid: number | undefined
    let completed = false
    try {
        await assert.rejects(
            subprocess(
                shell,
                [
                    '-c',
                    'sleep 10 & background=$!; printf \'%s %s\' "$$" "$background" > "$1"; wait',
                    'rethink-subprocess-timeout',
                    marker,
                ],
                '',
                { timeoutMs: 100 },
            ),
            (error: Error) => {
                assert.equal(error.message, 'Subprocess timed out')
                return true
            },
        )

        const recordedPids = readFileSync(marker, 'utf-8').split(' ').map(Number)
        shellPid = recordedPids[0]
        backgroundPid = recordedPids[1]
        assert(shellPid > 0)
        assert(backgroundPid > 0)
        const currentProcessObservation = observeProcess(process.pid)
        assert.equal(
            isProcessNotRunning(currentProcessObservation),
            false,
            `Observer classified the current process as not running (${describeProcessObservation(currentProcessObservation)})`,
        )
        const directChildPid = shellPid
        assert.throws(() => process.kill(directChildPid, 0), { code: 'ESRCH' })
        await waitForProcessNotRunning(backgroundPid, shellPid)
        completed = true
    } finally {
        try {
            if (
                !completed &&
                process.platform === 'linux' &&
                shellPid !== undefined &&
                shellPid > 0 &&
                backgroundPid !== undefined &&
                backgroundPid > 0
            ) {
                const observation = observeProcess(backgroundPid, shellPid)
                if (
                    observation.status === 'visible' &&
                    observation.processGroup === shellPid &&
                    !isProcessNotRunning(observation)
                ) {
                    process.kill(-shellPid, 'SIGKILL')
                }
            }
        } finally {
            rmSync(directory, { recursive: true, force: true })
        }
    }
})

test('subprocess rejects stdout beyond the configured cap without exposing it', async () => {
    await assert.rejects(
        subprocess(shell, ['-c', 'printf stdout-private-secret'], '', { maxOutputBytes: 4 }),
        (error: Error) => {
            assert.equal(error.message, 'Subprocess stdout limit exceeded')
            assert.doesNotMatch(error.message, /stdout-private-secret/)
            return true
        },
    )
})
