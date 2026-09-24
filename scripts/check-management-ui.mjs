import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = process.cwd()
const baseline = process.env.BASELINE_SOURCE_ROOT
if (
    !baseline ||
    !path.isAbsolute(baseline) ||
    !statSync(baseline).isDirectory() ||
    realpathSync(baseline) === realpathSync(root)
) {
    throw new Error('BASELINE_SOURCE_ROOT must name the separate authenticated baseline source root')
}
for (const name of ['PLAYWRIGHT_MODULE', 'CHROMIUM_EXECUTABLE']) {
    if (!process.env[name]) throw new Error(`${name} is required; browser acceptance cannot be skipped`)
}
const withGateway = process.argv.includes('--with-session-gateway')
if (process.argv.slice(2).some((argument) => argument !== '--with-session-gateway'))
    throw new Error('Unknown acceptance argument')
const evidence = mkdtempSync(path.join(tmpdir(), 'rethink-management-check-'))
const environment = { ...process.env, TSX_DISABLE_CACHE: '1', PYTHONDONTWRITEBYTECODE: '1' }
const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
if (digest(path.join(root, 'package-lock.json')) !== digest(path.join(baseline, 'package-lock.json'))) {
    throw new Error('Root dependency lock differs from the authenticated baseline')
}
function inventory(directory, prefix = '') {
    const output = {}
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (['node_modules', 'dist', '.git'].includes(entry.name)) continue
        const relative = prefix + entry.name
        if (entry.isDirectory()) Object.assign(output, inventory(path.join(directory, entry.name), `${relative}/`))
        else output[relative] = digest(path.join(directory, entry.name))
    }
    return output
}
const before = inventory(root)
const changed = Object.keys(before).filter((file) => {
    try {
        return digest(path.join(baseline, file)) !== before[file]
    } catch {
        return true
    }
})
let index = 0
function execute(label, command, args, cwd = root, required = true) {
    const result = spawnSync(command, args, { cwd, env: environment, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    const output = `${result.stdout || ''}${result.stderr || ''}`
    writeFileSync(path.join(evidence, `${String(++index).padStart(2, '0')}-${label}.log`), output, { mode: 0o600 })
    console.log(`${label}: exit=${result.status} signal=${result.signal || 'none'}`)
    if (result.error || result.signal || (required && result.status !== 0)) {
        process.stderr.write(output)
        throw result.error || new Error(`${label} failed; native output retained in ${evidence}`)
    }
    return { status: result.status, output }
}
try {
    const tsc = path.join(root, 'node_modules/typescript/bin/tsc')
    const comparisons = []
    for (const config of [
        'tsconfig.json',
        'tsconfig.node-tools.json',
        'tsconfig.browser-panel.json',
        'tsconfig.browser-router.json',
        'tsconfig.browser-monitor.json',
    ]) {
        const original = execute(
            `baseline-${config}`,
            process.execPath,
            [tsc, '--noEmit', '-p', config],
            baseline,
            false,
        )
        const candidate = execute(`candidate-${config}`, process.execPath, [tsc, '--noEmit', '-p', config], root, false)
        const normalize = (output) =>
            output
                .replaceAll(root, '<root>')
                .replaceAll(baseline, '<root>')
                .split('\n')
                .filter(Boolean)
                .map((line) => line.replace(/\(\d+,\d+\)/g, '(location)'))
                .sort()
        if (
            candidate.status !== 0 &&
            (original.status === 0 ||
                JSON.stringify(normalize(candidate.output)) !== JSON.stringify(normalize(original.output)))
        ) {
            process.stderr.write(candidate.output)
            throw new Error(`New or changed typecheck diagnostics: ${config}`)
        }
        comparisons.push({
            config,
            baseline: original.status,
            candidate: candidate.status,
            classification: candidate.status === 0 ? 'PASS' : 'UNVERIFIED: identical legacy diagnostics',
        })
    }
    writeFileSync(path.join(evidence, 'paired-typecheck.json'), JSON.stringify(comparisons, null, 2), { mode: 0o600 })
    for (const comparison of comparisons) console.log(`${comparison.config}: ${comparison.classification}`)
    const formatted = changed.filter((file) => /\.(?:js|mjs|ts|json|css|html)$/.test(file))
    execute('focused-format', path.join(root, 'node_modules/.bin/biome'), [
        'format',
        '--vcs-enabled=false',
        ...formatted,
    ])
    execute('focused-behavior', process.execPath, [
        '--import',
        'tsx',
        '--test',
        'tests/build-info.test.ts',
        'tests/management-ui.test.ts',
        'tests/panel.test.ts',
        'tests/router-ui.test.ts',
        'tests/management/index.test.ts',
    ])
    execute('production-build', 'npm', ['run', 'build'])
    const { buildIdentity } = await import('./write-build-info.mjs')
    const metadata = JSON.parse(readFileSync(path.join(root, 'dist/management-build.json'), 'utf8'))
    if (metadata.sha256 !== (await buildIdentity(path.join(root, 'dist'))))
        throw new Error('Emitted build identity mismatch')
    execute('ui-browser', process.execPath, ['tests/management-ui.browser.mjs'])
    if (withGateway) {
        if (!environment.CERTUTIL_BIN) throw new Error('CERTUTIL_BIN is required for isolated CA trust')
        execute('gateway-dependency-audit', 'npm', [
            'audit',
            '--omit=dev',
            '--audit-level=low',
            '--prefix',
            'management-gateway/session-proxy',
            '--cache',
            path.join(evidence, 'npm-cache'),
        ])
        execute('legacy-gateway-acceptance', environment.PYTHON_BIN || 'python3', [
            '-B',
            'management-gateway/tests/integration.py',
            '--acceptance',
        ])
        execute('session-native', process.execPath, ['--test', 'management-gateway/tests/session-integration.mjs'])
        execute('session-browser', process.execPath, ['management-gateway/tests/session-browser.mjs'])
    }
    if (JSON.stringify(inventory(root)) !== JSON.stringify(before)) throw new Error('Acceptance modified source')
    console.log(
        `PASS combined ${withGateway ? 'LANG CONTENT RESPONSIVE ACCESSIBLE MONITOR PRESERVE SOURCE SESSION AUTH LIFECYCLE' : 'UI'} checks. Evidence: ${evidence}`,
    )
    console.log(
        'Any identical legacy typecheck failures remain UNVERIFIED. Chromium and shortened-clock fixtures do not establish physical Safari or actual ten-minute observation.',
    )
} catch (error) {
    console.error(error.message)
    console.error(`Native evidence retained: ${evidence}`)
    process.exitCode = 1
}
