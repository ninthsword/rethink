import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const dockerignore = readFileSync('.dockerignore', 'utf-8')
const dockerfile = readFileSync('Dockerfile', 'utf-8')
const deployScript = readFileSync('scripts/deploy.sh', 'utf-8')
const readme = readFileSync('README.md', 'utf-8')
const packageJson = JSON.parse(readFileSync('package.json', 'utf-8')) as {
    scripts: { build: string }
}

test('Docker context excludes private runtime material but keeps public config template', () => {
    const patterns = new Set(
        dockerignore
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith('#')),
    )
    for (const pattern of [
        '.git',
        '.claude/',
        '.agents/',
        '.codex/',
        'CLAUDE.md',
        'CLAUDE.local.md',
        'AGENTS.md',
        '.env',
        '.env.*',
        'oauth.json',
        'oauth2.json',
        'thinq1-metadata.json',
        'config.json',
        'router-dnat.json',
        'state/',
        'captures/',
        '*.key',
        '*.pem',
        '*.cert',
        '*.csr',
        '*.crt',
    ]) {
        assert.equal(patterns.has(pattern), true, pattern)
    }
    assert.equal(patterns.has('config.jsonc'), false)
})

test('build policy removes stale dist before compilation', () => {
    assert.match(packageJson.scripts.build, /^rm -rf dist && tsc /)
    assert.match(packageJson.scripts.build, /tsc-alias -p tsconfig\.build\.json/)
    assert.match(packageJson.scripts.build, /cp -r html dist\/$/)
})

test('the published image runs as app and owns its image-local data directory', () => {
    assert.match(dockerfile, /RUN mkdir -p \/app\/data[\s\S]*chown app:app \/app\/data/)
    assert.match(dockerfile, /\nUSER app\n/)
})

test('local deployment validates operator-owned data before releasing DNAT', () => {
    assert.match(deployScript, /OPERATOR_UID=\$\(id -u\)/)
    assert.match(deployScript, /OPERATOR_GID=\$\(id -g\)/)
    assert.match(deployScript, /\[ "\$OPERATOR_UID" -eq 0 \]/)
    assert.match(deployScript, /DNAT_ALREADY_RELEASED=\$\{RETHINK_DNAT_ALREADY_RELEASED:-0\}/)
    assert.match(deployScript, /RETHINK_DNAT_ALREADY_RELEASED must be 0 or 1/)
    assert.match(deployScript, /docker inspect --format '\{\{\.State\.Running\}\}' rethink/)
    assert.match(deployScript, /DNAT release failed/)
    assert.match(deployScript, /\[\[ "\$DATA" != \/\* \]\]/)
    assert.match(deployScript, /realpath -e -- "\$DATA"/)
    assert.match(deployScript, /DATA=\$canonical_data/)
    assert.match(
        deployScript,
        /find "\$DATA"[\s\S]*-type l[\s\S]*-type f[\s\S]*-type d[\s\S]*-uid "\$OPERATOR_UID"[\s\S]*-gid "\$OPERATOR_GID"/,
    )
    assert.match(deployScript, /-readable[\s\S]*-writable[\s\S]*-executable/)
    assert.match(deployScript, /--user "\$OPERATOR_UID:\$OPERATOR_GID"/)
    assert.ok(deployScript.indexOf('bad_data_entry=') < deployScript.indexOf('api/router/dnat/release'))
    assert.ok(deployScript.indexOf('canonical_data=') < deployScript.indexOf('api/router/dnat/release'))
    assert.doesNotMatch(deployScript, /chown/)
})

test('deployment rejects noncanonical data paths before invoking curl or Docker', {
    skip: process.getuid?.() === 0 ? 'behavioral harness requires a non-root process' : false,
}, () => {
    const temporary = mkdtempSync(join(tmpdir(), 'rethink-deploy-policy-'))
    try {
        const bin = join(temporary, 'bin')
        mkdirSync(bin)
        const operatorUid = process.getuid?.()
        const operatorGid = process.getgid?.()
        if (operatorUid === undefined || operatorGid === undefined) {
            throw new Error('the policy harness requires process UID/GID support')
        }
        writeFileSync(join(bin, 'id'), `#!/bin/sh\n[ "$1" = -u ] && echo ${operatorUid} || echo ${operatorGid}\n`)
        const events = join(temporary, 'events')
        writeFileSync(join(bin, 'curl'), `#!/bin/sh\necho curl >> ${events}\nexit "\${RETHINK_TEST_CURL_STATUS:-0}"\n`)
        writeFileSync(
            join(bin, 'docker'),
            `#!/bin/sh\nif [ "$1" = inspect ]; then echo inspect >> ${events}; echo "\${RETHINK_TEST_CONTAINER_RUNNING:-false}"; exit 0; fi\necho docker >> ${events}\nexit 1\n`,
        )
        for (const command of ['id', 'curl', 'docker']) chmodSync(join(bin, command), 0o755)

        const data = join(temporary, 'data')
        mkdirSync(data)
        symlinkSync(data, join(temporary, 'link'))
        const readonlyFileData = join(temporary, 'readonly-file-data')
        mkdirSync(readonlyFileData)
        const readonlyFile = join(readonlyFileData, 'state')
        writeFileSync(readonlyFile, 'state')
        chmodSync(readonlyFile, 0o400)
        const readonlyDirectoryData = join(temporary, 'readonly-directory-data')
        mkdirSync(readonlyDirectoryData)
        const readonlyDirectory = join(readonlyDirectoryData, 'state')
        mkdirSync(readonlyDirectory)
        chmodSync(readonlyDirectory, 0o500)
        const specialData = join(temporary, 'special-data')
        mkdirSync(specialData)
        const special = join(specialData, 'state')
        assert.equal(spawnSync('mkfifo', [special]).status, 0)
        const cases = [
            'named-volume',
            `${data}/../data`,
            join(temporary, 'link'),
            readonlyFileData,
            readonlyDirectoryData,
            specialData,
        ]
        for (const path of cases) {
            const result = spawnSync('bash', ['scripts/deploy.sh'], {
                cwd: process.cwd(),
                encoding: 'utf-8',
                env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RETHINK_DATA: path },
            })
            assert.equal(result.status, 1, path)
            assert.equal(existsSync(events), false, path)
            assert.doesNotMatch(
                `${result.stdout}${result.stderr}`,
                new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
            )
        }

        const validData = join(temporary, 'valid-data')
        mkdirSync(validData)
        chmodSync(validData, 0o700)
        const ordinaryFile = join(validData, 'state')
        writeFileSync(ordinaryFile, 'state')
        chmodSync(ordinaryFile, 0o600)
        const validResult = spawnSync('bash', ['scripts/deploy.sh'], {
            cwd: process.cwd(),
            encoding: 'utf-8',
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RETHINK_DATA: validData },
        })
        assert.equal(validResult.status, 1)
        assert.equal(readFileSync(events, 'utf-8'), 'curl\ndocker\n')

        rmSync(events)
        const curlFailureResult = spawnSync('bash', ['scripts/deploy.sh'], {
            cwd: process.cwd(),
            encoding: 'utf-8',
            env: {
                ...process.env,
                PATH: `${bin}:${process.env.PATH}`,
                RETHINK_DATA: validData,
                RETHINK_TEST_CURL_STATUS: '7',
            },
        })
        assert.equal(curlFailureResult.status, 1)
        assert.equal(readFileSync(events, 'utf-8'), 'curl\n')

        rmSync(events)
        const runningFlagResult = spawnSync('bash', ['scripts/deploy.sh'], {
            cwd: process.cwd(),
            encoding: 'utf-8',
            env: {
                ...process.env,
                PATH: `${bin}:${process.env.PATH}`,
                RETHINK_DATA: validData,
                RETHINK_DNAT_ALREADY_RELEASED: '1',
                RETHINK_TEST_CONTAINER_RUNNING: 'true',
            },
        })
        assert.equal(runningFlagResult.status, 1)
        assert.equal(readFileSync(events, 'utf-8'), 'inspect\n')

        rmSync(events)
        const stoppedFlagResult = spawnSync('bash', ['scripts/deploy.sh'], {
            cwd: process.cwd(),
            encoding: 'utf-8',
            env: {
                ...process.env,
                PATH: `${bin}:${process.env.PATH}`,
                RETHINK_DATA: validData,
                RETHINK_DNAT_ALREADY_RELEASED: '1',
                RETHINK_TEST_CONTAINER_RUNNING: 'false',
            },
        })
        assert.equal(stoppedFlagResult.status, 1)
        assert.equal(readFileSync(events, 'utf-8'), 'inspect\ndocker\n')
    } finally {
        rmSync(temporary, { force: true, recursive: true })
    }
})

test('runtime documentation covers fresh and migrated data ownership', () => {
    assert.match(readme, /mkdir -p ~\/docker\/rethink-data/)
    assert.match(readme, /backup/i)
    assert.match(readme, /chown -R .*id -u.*id -g/i)
    assert.match(readme, /--user .*id -u.*id -g/i)
    assert.match(readme, /above 1024/i)
    assert.match(readme, /root-only backup .*rollback/i)
    const migration = readme.indexOf('first release DNAT successfully')
    const migrationGuard = readme.indexOf('(\nset -eu\n', migration)
    const release = readme.indexOf('curl -fsS -X POST http://127.0.0.1:44401/api/router/dnat/release', migration)
    const stop = readme.indexOf('docker stop rethink', release)
    const backupDir = readme.indexOf('BACKUP_DIR=$(sudo mktemp -d /var/tmp/rethink-data-backup.XXXXXX)', stop)
    const backupArchive = readme.indexOf('BACKUP="$BACKUP_DIR/rethink-data.tar.gz"', backupDir)
    const privilegedBackup = readme.indexOf('sudo sh -c \'umask 077; tar -C "$1" -czf "$2" "$3"\'', backupArchive)
    const backupVerify = readme.indexOf('sudo tar -tzf "$BACKUP" >/dev/null', privilegedBackup)
    const ownership = readme.indexOf('sudo chown -R', backupVerify)
    const deploy = readme.indexOf('scripts/deploy.sh', ownership)
    const migrationEnd = readme.indexOf('\n)', deploy)
    assert.ok(migrationGuard >= migration && migrationGuard < release)
    assert.ok(release >= 0 && release < stop)
    assert.ok(stop < backupDir && backupDir < backupArchive && backupArchive < privilegedBackup)
    assert.ok(privilegedBackup < backupVerify)
    assert.ok(backupVerify < ownership && ownership < deploy)
    assert.doesNotMatch(readme.slice(backupDir, ownership), /sudo chown/)
    assert.ok(deploy < migrationEnd)
})
