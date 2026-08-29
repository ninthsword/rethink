// (De)serialization of the lgcloud cloud State to disk. This is the persistence side that
// monitor.ts deliberately leaves to its callers: load a complete State or nothing, and
// save a State as a whole.

import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as pathModule from 'node:path'
import type { State } from './monitor'

export const DEFAULT_STATE_FILE = 'oauth.json'

// Returns a State only if the file exists and is complete; a missing, partial or corrupt
// file yields undefined ("not logged in").
export function loadState(path: string = DEFAULT_STATE_FILE): State | undefined {
    try {
        const s = JSON.parse(fs.readFileSync(path, 'utf-8')) as Partial<State> & {
            env?: { countryCode?: string }
        }
        const countryCode = s.countryCode ?? s.env?.countryCode
        if (countryCode && s.refreshToken) return { countryCode, refreshToken: s.refreshToken }
    } catch {}
    return undefined
}

export function saveState(state: State, path: string = DEFAULT_STATE_FILE): void {
    const directory = pathModule.dirname(path)
    let temporary: string | undefined
    let fd: number | undefined

    try {
        for (let attempt = 0; attempt < 10; attempt++) {
            const candidate = pathModule.join(
                directory,
                `.${pathModule.basename(path)}.${randomBytes(16).toString('hex')}.tmp`,
            )
            try {
                fd = fs.openSync(candidate, 'wx', 0o600)
                temporary = candidate
                break
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt === 9) throw error
            }
        }

        if (fd === undefined || temporary === undefined) throw new Error('Unable to create temporary state file')
        fs.writeFileSync(fd, JSON.stringify(state), { encoding: 'utf8' })
        fs.closeSync(fd)
        fd = undefined
        fs.renameSync(temporary, path)
        temporary = undefined
    } finally {
        if (fd !== undefined) fs.closeSync(fd)
        if (temporary !== undefined) {
            try {
                fs.unlinkSync(temporary)
            } catch {}
        }
    }
}
