#!/usr/bin/env node
// A minimalistic reimplementation of "simple-git-hooks" to work around the issue:
// https://github.com/toplenboren/simple-git-hooks/issues/132
//
// Note that the repository layout was at a later point changed to match simple-git-hooks.

import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.env.SKIP_GIT_HOOKS) {
    console.log('[install-git-hooks] SKIP_GIT_HOOKS set, skipping')
    process.exit(0)
}

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
const hooks = pkg['simple-git-hooks'] ?? {}

let gitDir
try {
    gitDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
        cwd: pkgDir,
        encoding: 'utf8',
    }).trim()
} catch {
    console.log('[install-git-hooks] not a git checkout, skipping')
    process.exit(0)
}
gitDir = resolve(pkgDir, gitDir)

const hooksDir = join(gitDir, 'hooks')
mkdirSync(hooksDir, { recursive: true })

for (const [name, command] of Object.entries(hooks)) {
    const path = join(hooksDir, name)
    // Hooks live in the common git directory, shared by every worktree: run them in the worktree
    // that triggered them, not in the directory the hook file sits under.
    const script = `#!/bin/sh
if [ -n "$SKIP_GIT_HOOKS" ]; then exit 0; fi
cd "$(git rev-parse --show-toplevel)" || exit 1
${command}\n`
    writeFileSync(path, script)
    chmodSync(path, 0o755)
    console.log(`[install-git-hooks] installed ${name} -> ${path}`)
}
