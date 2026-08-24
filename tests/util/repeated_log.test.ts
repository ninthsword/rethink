import assert from 'node:assert/strict'
import { test } from 'node:test'
import { collapseRepeats, withoutErrorTag } from '@/util/repeated_log'

test('the first occurrence is reported at once and the repeats are held', () => {
    const lines: string[] = []
    const report = collapseRepeats(60_000, (l) => lines.push(l))

    report('mclip', (held) => `refused${held ? ` (+${held})` : ''}`, 0)
    for (let at = 1000; at < 60_000; at += 1000) report('mclip', (held) => `refused (+${held})`, at)

    assert.deepEqual(lines, ['refused'], 'a refusal that keeps repeating must not keep printing')
})

test('once the interval is up, the next occurrence carries the count of the held ones', () => {
    const lines: string[] = []
    const report = collapseRepeats(60_000, (l) => lines.push(l))

    report('mclip', () => 'refused', 0)
    for (let at = 1000; at <= 30_000; at += 1000) report('mclip', (held) => `refused (+${held})`, at)
    report('mclip', (held) => `refused (+${held})`, 61_000)

    // Thirty were held back before the interval elapsed, and the thirty-first reports them.
    assert.deepEqual(lines, ['refused', 'refused (+31)'])
})

test('a different failure is its own first occurrence', () => {
    const lines: string[] = []
    const report = collapseRepeats(60_000, (l) => lines.push(l))

    report('mclip', () => 'mclip refused', 0)
    report('mclip', () => 'mclip refused again', 1000)
    report('common', () => 'common refused', 2000)

    assert.deepEqual(lines, ['mclip refused', 'common refused'])
})

test("OpenSSL's per-connection tag is dropped so identical failures compare equal", () => {
    const first =
        '287736234E7B0000:error:0A000418:SSL routines:ssl3_read_bytes:tlsv1 alert unknown ca:rec_layer_s3.c:914:'
    const second =
        'A81B0F4422770000:error:0A000418:SSL routines:ssl3_read_bytes:tlsv1 alert unknown ca:rec_layer_s3.c:914:'

    assert.equal(withoutErrorTag(first), withoutErrorTag(second))
    assert.match(withoutErrorTag(first), /^error:0A000418:/)
})

test('a message without a tag is left alone', () => {
    assert.equal(withoutErrorTag('socket hang up'), 'socket hang up')
})
