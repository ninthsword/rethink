import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { subprocess } from '@/bridge/util'

const shell = '/bin/sh'

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

        const [shellPid, backgroundPid] = readFileSync(marker, 'utf-8').split(' ').map(Number)
        assert(shellPid > 0)
        assert(backgroundPid > 0)
        assert.throws(() => process.kill(shellPid, 0), { code: 'ESRCH' })
        assert.throws(() => process.kill(backgroundPid, 0), { code: 'ESRCH' })
    } finally {
        rmSync(directory, { recursive: true, force: true })
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
