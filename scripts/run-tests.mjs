import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const BATCH_SIZE = 12

function testFiles(directory) {
    return readdirSync(directory, { withFileTypes: true })
        .flatMap((entry) => {
            const path = join(directory, entry.name)
            if (entry.isDirectory()) return testFiles(path)
            return entry.isFile() && entry.name.endsWith('.test.ts') ? [path] : []
        })
        .sort()
}

const files = testFiles('tests')
for (let offset = 0; offset < files.length; offset += BATCH_SIZE) {
    const batch = files.slice(offset, offset + BATCH_SIZE)
    const number = offset / BATCH_SIZE + 1
    const count = Math.ceil(files.length / BATCH_SIZE)
    console.log(`\nTest batch ${number}/${count} (${batch.length} files)`)
    const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', '--test', '--test-concurrency=3', '--test-reporter=spec', ...batch],
        { stdio: 'inherit' },
    )
    if (result.error) throw result.error
    if (result.status !== 0) process.exit(result.status ?? 1)
}
