import { performance } from 'node:perf_hooks'
import session from 'express-session'
import memorystore from 'memorystore'

export const SESSION_MS = 600_000
export const WARNING_MS = 60_000
export const SESSION_LIMIT = 64

// The LRU contains signed-session data; this authority alone controls authorization.
// All mutations are synchronous in one event loop, before any asynchronous callback.
export function createAuthority({
    now = () => performance.now(),
    wall = Date.now,
    duration = SESSION_MS,
    max = SESSION_LIMIT,
    schedule = setTimeout,
    cancel = clearTimeout,
} = {}) {
    const records = new Map()
    const MemoryStore = memorystore(session)
    let store
    function revoke(id, disposing = false) {
        const record = records.get(id)
        if (!record) return
        records.delete(id)
        cancel(record.timer)
        for (const socket of record.sockets) socket.destroy()
        record.sockets.clear()
        if (!disposing) store.destroy(id)
    }
    function active(id, host) {
        const record = records.get(id)
        if (record && now() >= record.deadline) revoke(id)
        return records.has(id) && (!host || record.host === host) ? record : undefined
    }
    function arm(id, record) {
        cancel(record.timer)
        record.timer = schedule(
            () => {
                if (active(id) !== record) return
                arm(id, record)
            },
            Math.max(1, record.deadline - now()),
        )
        record.timer?.unref?.()
    }
    store = new MemoryStore({
        max,
        noDisposeOnSet: true,
        checkPeriod: 30_000,
        ttl: (_options, _value, id) => Math.max(1, (records.get(id)?.deadline ?? now()) - now()),
        dispose: (id) => revoke(id, true),
    })
    const save = store.set.bind(store)
    store.set = (id, value, done) => {
        const record = active(id)
        if (!record) return queueMicrotask(() => done?.())
        // A late response cannot resurrect logout or overwrite a newer renewal.
        value.cookie.expires = new Date(record.expiresAt)
        value.cookie.originalMaxAge = Math.max(0, record.deadline - now())
        save(id, value, done)
    }
    store.touch = (_id, _value, done) => queueMicrotask(() => done?.())
    return {
        store,
        active,
        revoke,
        grant(id, host) {
            if (records.has(id)) revoke(id)
            const record = {
                host,
                generation: 1,
                deadline: now() + duration,
                expiresAt: wall() + duration,
                sockets: new Set(),
                timer: undefined,
            }
            records.set(id, record)
            arm(id, record)
            return record
        },
        extend(id, generation, host) {
            const record = active(id, host)
            if (!record || record.generation !== generation) return undefined
            record.generation += 1
            record.deadline = now() + duration
            record.expiresAt = wall() + duration
            arm(id, record)
            return record
        },
        attach(id, socket) {
            const record = active(id)
            if (!record) {
                socket.destroy()
                return false
            }
            record.sockets.add(socket)
            socket.once('close', () => record.sockets.delete(socket))
            return true
        },
        view(id, host) {
            const record = active(id, host)
            return (
                record && {
                    authenticated: true,
                    generation: record.generation,
                    expiresAt: record.expiresAt,
                    remainingMs: Math.max(0, record.deadline - now()),
                    warningMs: Math.min(WARNING_MS, duration / 10),
                }
            )
        },
        close() {
            for (const id of [...records.keys()]) revoke(id)
            store.stopInterval()
        },
    }
}
