import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { test } from 'node:test'
import ts from 'typescript'

interface Edge {
    importer: string
    specifier: string
}

type Violation =
    | { rule: 'javascript'; file: string }
    | { rule: 'reach'; file: string; via: Edge[] }
    | { rule: 'call'; file: string; line: number; call: string }

function walk(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true })
        .flatMap((entry) => {
            const path = join(directory, entry.name)
            if (entry.isDirectory()) return walk(path)
            return entry.isFile() ? [path] : []
        })
        .sort()
}

/** The path relative to root, or undefined for files outside the repository or in node_modules. */
function repositoryPath(root: string, file: string): string | undefined {
    const path = relative(root, resolve(file))
    if (path === '' || path.startsWith('..') || resolve(path) === path) return undefined
    const segments = path.split(sep)
    return segments.includes('node_modules') ? undefined : segments.join('/')
}

/** Direct edges of one loaded file, derived with TypeScript's public resolver API. */
function directEdges(file: ts.SourceFile, root: string, options: ts.CompilerOptions): [string, Edge][] {
    const importer = repositoryPath(root, file.fileName)
    if (importer === undefined) return []
    const info = ts.preProcessFile(file.text, true, true)
    const targets: [string | undefined, string][] = [
        ...info.importedFiles.map(({ fileName }): [string | undefined, string] => [
            ts.resolveModuleName(fileName, file.fileName, options, ts.sys).resolvedModule?.resolvedFileName,
            fileName,
        ]),
        ...info.referencedFiles.map(({ fileName }): [string | undefined, string] => [
            resolve(dirname(file.fileName), fileName),
            fileName,
        ]),
        ...info.typeReferenceDirectives.map(({ fileName }): [string | undefined, string] => [
            ts.resolveTypeReferenceDirective(fileName, file.fileName, options, ts.sys).resolvedTypeReferenceDirective
                ?.resolvedFileName,
            fileName,
        ]),
    ]
    return targets.flatMap(([target, specifier]): [string, Edge][] => {
        const path = target === undefined ? undefined : repositoryPath(root, target)
        return path === undefined ? [] : [[path, { importer, specifier }]]
    })
}

function unresolvableCalls(file: ts.SourceFile, path: string): Violation[] {
    const found: Violation[] = []
    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
            const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
            const argument = node.arguments[0]
            const isNonLiteralImport =
                node.expression.kind === ts.SyntaxKind.ImportKeyword &&
                !(argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)))
            if (isRequire || isNonLiteralImport) {
                const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
                found.push({ rule: 'call', file: path, line, call: isRequire ? 'require()' : 'import()' })
            }
        }
        ts.forEachChild(node, visit)
    }
    visit(file)
    return found
}

/** Checks that cloud/ under root never reaches bridge/ or router/ and loads modules only statically. */
function checkBoundary(repositoryRoot: string): Violation[] {
    const root = realpathSync(repositoryRoot)
    const violations: Violation[] = []
    const cloudFiles = walk(join(root, 'cloud'))
    for (const file of cloudFiles) {
        if (/\.(js|jsx|mjs|cjs)$/.test(file)) violations.push({ rule: 'javascript', file: relative(root, file) })
    }

    const tsconfig = join(root, 'tsconfig.json')
    const config = ts.readConfigFile(tsconfig, ts.sys.readFile)
    if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
    const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, root, undefined, tsconfig)
    const rootNames = cloudFiles.filter((file) => /\.(ts|tsx|mts|cts)$/.test(file))
    const program = ts.createProgram({ rootNames, options })

    const loaded = program
        .getSourceFiles()
        .flatMap((file) => {
            const path = repositoryPath(root, file.fileName)
            return path === undefined ? [] : [{ file, path }]
        })
        .sort((a, b) => a.path.localeCompare(b.path))
    const edges = loaded.flatMap(({ file }) => directEdges(file, root, options))
    for (const { path } of loaded) {
        const first = path.split('/')[0]
        if (first !== 'bridge' && first !== 'router') continue
        const via = edges.filter(([target]) => target === path).map(([, edge]) => edge)
        violations.push({ rule: 'reach', file: path, via })
    }
    for (const { file, path } of loaded) violations.push(...unresolvableCalls(file, path))
    return violations
}

function boundaryMessage(violations: Violation[]): string {
    const items = violations.map((violation) => {
        if (violation.rule === 'javascript') return `- ${violation.file}: JavaScript file in cloud/`
        if (violation.rule === 'call') return `- ${violation.file}:${violation.line}: ${violation.call} call`
        const via = violation.via.map(({ importer, specifier }) => `${importer} via '${specifier}'`).join(', ')
        return `- ${violation.file} is loaded from cloud/${via ? `, reached from ${via}` : ''}`
    })
    return [
        'cloud/ must not reach bridge/ or router/, directly or through another module, ' +
            'and the modules it loads use statically resolvable imports only ' +
            '(no require(), no import() with a non-literal argument); cloud/ holds TypeScript files only.',
        'Offending items:',
        ...items,
        'Pass what cloud/ needs through its Connection or a util/ helper that does not depend on bridge/ or router/.',
    ].join('\n')
}

test('cloud/ does not reach bridge/ or router/ and loads modules only statically', () => {
    const violations = checkBoundary('.')
    assert.deepEqual(violations, [], boundaryMessage(violations))
})

const fixtureBase: Record<string, string> = {
    'tsconfig.json': JSON.stringify({
        compilerOptions: {
            module: 'esnext',
            moduleResolution: 'bundler',
            allowJs: true,
            lib: ['es2021'],
            target: 'es2021',
            paths: { '@/*': ['./*'] },
            strict: true,
        },
        include: ['./**/*.ts'],
    }),
    'bridge/upstream.ts': 'export const a = 1\nexport default a\n',
    'bridge/state.ts': 'export const state = {}\n',
    'bridge/types.d.ts': 'declare const bridgeTypes: number\n',
    'router/dnat.ts': 'export interface DNATState {\n    port: number\n}\nexport type B = number\n',
    'router/table.ts': 'export const table = []\n',
    'util/casting.ts': 'export const d = 1\n',
    'cloud/ha_bridge.ts': 'export const c = 1\nexport default c\n',
    'cloud/sni_router.ts': 'export {}\n',
}

function checkFixture(files: Record<string, string> | ((root: string) => Record<string, string>)): Violation[] {
    const temporary = mkdtempSync(join(tmpdir(), 'rethink-boundary-'))
    try {
        const root = realpathSync(temporary)
        const all = { ...fixtureBase, ...(typeof files === 'function' ? files(root) : files) }
        for (const [path, content] of Object.entries(all)) {
            mkdirSync(dirname(join(root, path)), { recursive: true })
            writeFileSync(join(root, path), content)
        }
        return checkBoundary(root)
    } finally {
        rmSync(temporary, { recursive: true, force: true })
    }
}

function reaches(violations: Violation[], file: string): Edge[] {
    const found = violations.find((violation) => violation.rule === 'reach' && violation.file === file)
    assert.ok(found && found.rule === 'reach', `expected ${file} to be reported:\n${boundaryMessage(violations)}`)
    return found.via
}

const directCases: [string, string, string][] = [
    ["import { a } from '../../bridge/upstream'\n", 'bridge/upstream.ts', '../../bridge/upstream'],
    ["import type { B } from '@/router/dnat'\n", 'router/dnat.ts', '@/router/dnat'],
    ["export * from '../../router/dnat'\n", 'router/dnat.ts', '../../router/dnat'],
    ["import u = require('../../bridge/upstream')\n", 'bridge/upstream.ts', '../../bridge/upstream'],
    ["type S = import('@/router/dnat').DNATState\n", 'router/dnat.ts', '@/router/dnat'],
    ['/// <reference path="../../bridge/upstream.ts" />\n', 'bridge/upstream.ts', '../../bridge/upstream.ts'],
    ['/// <reference types="../../bridge/types" />\n', 'bridge/types.d.ts', '../../bridge/types'],
    ["await import('../../bridge/upstream')\nexport {}\n", 'bridge/upstream.ts', '../../bridge/upstream'],
    ['await import(`../../router/dnat`)\nexport {}\n', 'router/dnat.ts', '../../router/dnat'],
]

for (const [source, file, specifier] of directCases) {
    test(`boundary check reports ${JSON.stringify(source.trim())}`, () => {
        const violations = checkFixture({ 'cloud/devices/case.ts': source })
        assert.deepEqual(
            reaches(violations, file).filter(({ importer }) => importer === 'cloud/devices/case.ts'),
            [{ importer: 'cloud/devices/case.ts', specifier }],
        )
    })
}

test('boundary check reports an import of the absolute path to bridge/upstream', () => {
    let specifier = ''
    const violations = checkFixture((root) => {
        specifier = join(root, 'bridge', 'upstream')
        return { 'cloud/devices/case.ts': `import { a } from '${specifier}'\n` }
    })
    assert.deepEqual(reaches(violations, 'bridge/upstream.ts'), [{ importer: 'cloud/devices/case.ts', specifier }])
})

test('boundary check reports bridge/ reached through a util/ module', () => {
    const violations = checkFixture({
        'cloud/devices/case.ts': "import { r } from '@/util/relay'\n",
        'util/relay.ts': "import { a } from '../bridge/upstream'\nexport const r = a\n",
    })
    assert.deepEqual(reaches(violations, 'bridge/upstream.ts'), [
        { importer: 'util/relay.ts', specifier: '../bridge/upstream' },
    ])
})

test('boundary check reports require() in cloud/', () => {
    const violations = checkFixture({ 'cloud/devices/case.ts': "const r = require('@/util/casting')\n" })
    assert.deepEqual(violations, [{ rule: 'call', file: 'cloud/devices/case.ts', line: 1, call: 'require()' }])
})

test('boundary check reports require() and non-literal import() in a util/ module cloud/ imports', () => {
    const violations = checkFixture({
        'cloud/devices/case.ts': "import { load } from '@/util/loader'\n",
        'util/loader.ts': [
            'export async function load(name: string) {',
            '    const r = require(name)',
            '    return [r, await import(name)]',
            '}',
            '',
        ].join('\n'),
    })
    assert.deepEqual(violations, [
        { rule: 'call', file: 'util/loader.ts', line: 2, call: 'require()' },
        { rule: 'call', file: 'util/loader.ts', line: 3, call: 'import()' },
    ])
})

test('boundary check reports non-literal import() in cloud/', () => {
    const violations = checkFixture({ 'cloud/case.ts': "const name = 'x'\nawait import(name)\nexport {}\n" })
    assert.deepEqual(violations, [{ rule: 'call', file: 'cloud/case.ts', line: 2, call: 'import()' }])
})

test('boundary check reports a JavaScript file in cloud/', () => {
    const violations = checkFixture({ 'cloud/devices/x.js': 'export const x = 1\n' })
    assert.deepEqual(violations, [{ rule: 'javascript', file: 'cloud/devices/x.js' }])
})

test("boundary check accepts cloud's own modules, util/ helpers and packages", () => {
    const sources = [
        "import { c } from '../ha_bridge'",
        "import '../sni_router'",
        "type H = import('@/cloud/ha_bridge').default",
        'await import(`../ha_bridge`)',
        "import { d } from '@/util/casting'",
        "import e from 'node:path'",
        "import f from 'mqtt-packet'",
    ]
    for (const source of sources) {
        const violations = checkFixture({ 'cloud/devices/case.ts': `${source}\nexport {}\n` })
        assert.deepEqual(violations, [], `${source}\n${boundaryMessage(violations)}`)
    }
})

test('boundary failure message names the item, the rule and the remedy', () => {
    const message = boundaryMessage([
        {
            rule: 'reach',
            file: 'bridge/upstream.ts',
            via: [{ importer: 'cloud/x.ts', specifier: '@/bridge/upstream' }],
        },
    ])
    assert.match(
        message,
        /bridge\/upstream\.ts is loaded from cloud\/, reached from cloud\/x\.ts via '@\/bridge\/upstream'/,
    )
    assert.match(message, /must not reach bridge\/ or router\/, directly or through another module/)
    assert.match(message, /the modules it loads use statically resolvable imports only/)
    assert.match(message, /through its Connection or a util\/ helper/)
})
