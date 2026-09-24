import { readFileSync } from 'node:fs'

export function readBuildInfo(file: URL = new URL('../management-build.json', import.meta.url)): string {
    try {
        const bytes = readFileSync(file)
        if (bytes.length > 256) return ''
        const value: unknown = JSON.parse(bytes.toString('utf8'))
        if (!value || typeof value !== 'object') return ''
        const metadata = value as Record<string, unknown>
        return metadata.schema === 1 && typeof metadata.sha256 === 'string' && /^[a-f0-9]{64}$/.test(metadata.sha256)
            ? metadata.sha256.slice(0, 16)
            : ''
    } catch {
        return ''
    }
}
