/**
 * Some failures repeat because nothing about them changes.
 *
 * An appliance turned away from a host rethink cannot serve retries about once a second and
 * keeps doing it for as long as the appliance is powered — kic-mclip.lgthinq.com produced
 * around thirty refusals a minute, every minute, and the container's log driver keeps all of
 * it. The first refusal is worth seeing; the forty thousandth is the same sentence again and
 * it buries everything else.
 *
 * So identical lines are collapsed: the first one goes out immediately, and after that at
 * most one line per interval, carrying the count of the ones held back. Nothing is decided
 * or hidden — the fact that it is still happening, and how often, stays in the log.
 */
export function collapseRepeats(everyMs: number, emit: (line: string) => void) {
    const seen = new Map<string, { reportedAt: number; held: number }>()

    /**
     * `line` is only called when something will actually be printed, so building the message
     * costs nothing on the suppressed calls, which are the overwhelming majority. It receives
     * the number of repeats held back since the last report.
     */
    return function report(key: string, line: (held: number) => string, now = Date.now()) {
        const state = seen.get(key)
        if (!state) {
            seen.set(key, { reportedAt: now, held: 0 })
            emit(line(0))
            return
        }

        state.held++
        if (now - state.reportedAt < everyMs) return

        const held = state.held
        state.held = 0
        state.reportedAt = now
        emit(line(held))
    }
}

/**
 * OpenSSL prefixes its error strings with a per-connection hex tag, so two refusals that are
 * the same failure never compare equal. Dropping the tag is what makes them collapsible.
 */
export function withoutErrorTag(message: string) {
    return message.replace(/^[0-9A-F]{8,}:/, '')
}
