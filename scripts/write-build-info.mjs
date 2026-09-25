import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const METADATA = 'management-build.json'
export async function buildIdentity(root) {
    const hash = createHash('sha256')
    async function walk(directory, prefix = '') {
        for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
            a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
        )) {
            const relative = `${prefix}${entry.name}`
            if (relative === METADATA) continue
            if (entry.isDirectory()) await walk(path.join(directory, entry.name), `${relative}/`)
            else if (entry.isFile()) {
                const bytes = await readFile(path.join(directory, entry.name))
                hash.update(`${Buffer.byteLength(relative)}:${relative}:${bytes.length}:`)
                hash.update(bytes)
            } else throw new Error('Build contains an unsupported file type')
        }
    }
    await walk(root)
    return hash.digest('hex')
}
export async function writeBuildInfo(root) {
    const sha256 = await buildIdentity(root)
    await writeFile(path.join(root, METADATA), `${JSON.stringify({ schema: 1, sha256 })}\n`)
    return sha256
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    console.log(`Build ${await writeBuildInfo(path.resolve('dist'))}`)
}
