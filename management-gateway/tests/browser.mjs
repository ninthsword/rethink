// Isolated Chromium certificate trust and synthetic servers; no production endpoint.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'

process.umask(0o077)
const here = path.dirname(fileURLToPath(import.meta.url))
let modulePath = process.env.PLAYWRIGHT_MODULE
if (modulePath && (await stat(modulePath)).isDirectory()) modulePath = path.join(modulePath, 'index.mjs')
const { chromium } = await import(modulePath ? pathToFileURL(modulePath).href : 'playwright')
const certutil = process.env.CERTUTIL_BIN || 'certutil'
async function exercise(mode) {
    const home = await mkdtemp(path.join(tmpdir(), 'rethink-browser-test-'))
    let fixture
    let browser
    let fixtureExit
    let scenarioError
    try {
        fixture = spawn(process.env.PYTHON_BIN || 'python3', ['-B', path.join(here, 'integration.py'), mode], {
            stdio: ['pipe', 'pipe', 'inherit'],
        })
        fixtureExit = new Promise((resolve, reject) => {
            fixture.once('error', reject)
            fixture.once('exit', (code, signal) => resolve({ code, signal }))
        })
        const lines = readline.createInterface({ input: fixture.stdout })
        const metadata = await Promise.race([
            new Promise((resolve) => lines.once('line', (line) => resolve(JSON.parse(line)))),
            fixtureExit.then(() => {
                throw new Error('Synthetic fixture exited before readiness')
            }),
        ])
        const db = path.join(home, '.pki', 'nssdb')
        await mkdir(db, { recursive: true, mode: 0o700 })
        execFileSync(certutil, ['-N', '-d', `sql:${db}`, '--empty-password'], { stdio: 'pipe' })
        execFileSync(
            certutil,
            ['-A', '-d', `sql:${db}`, '-n', 'Isolated Rethink Fixture CA', '-t', 'C,,', '-i', metadata.ca],
            { stdio: 'pipe' },
        )
        browser = await chromium.launch({
            headless: true,
            executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
            env: { ...process.env, HOME: home },
            args: [
                '--no-proxy-server',
                ...(metadata.hostname ? [`--host-resolver-rules=MAP ${metadata.hostname} 127.0.0.1`] : []),
            ],
        })
        const anonymous = await browser.newContext()
        const unauthPage = await anonymous.newPage()
        // An HTTP 401 is accepted here only after Chromium has verified the fixture certificate.
        const denied = await unauthPage.goto(metadata.origin)
        assert.equal(denied.status(), 401)
        assert.ok(await denied.securityDetails())
        await anonymous.close()

        const context = await browser.newContext({
            httpCredentials: { username: 'admin', password: metadata.password, origin: metadata.origin },
        })
        const page = await context.newPage()
        const response = await page.goto(metadata.origin)
        assert.equal(response.status(), 200)
        assert.ok(await response.securityDetails())
        assert.equal(await page.title(), 'Fixture management')
        const fetchResults = await page.evaluate(async () => {
            const read = await fetch('/api/read')
            const write = await fetch('/api/write', { method: 'POST', body: '{}' })
            return [read.status, write.status]
        })
        assert.deepEqual(fetchResults, [200, 200])
        for (const route of ['/ws', '/device?id=synthetic']) {
            const echoed = await page.evaluate(
                ({ origin, route }) =>
                    new Promise((resolve, reject) => {
                        const ws = new WebSocket(origin.replace('https:', 'wss:') + route)
                        const timeout = setTimeout(() => {
                            ws.close()
                            reject(new Error('WebSocket timed out'))
                        }, 10000)
                        ws.onopen = () => ws.send('browser-echo')
                        ws.onmessage = (event) => {
                            clearTimeout(timeout)
                            ws.close()
                            resolve(event.data)
                        }
                        ws.onerror = () => {
                            clearTimeout(timeout)
                            reject(new Error('WebSocket failed'))
                        }
                    }),
                { origin: metadata.origin, route },
            )
            assert.equal(echoed, 'browser-echo')
        }
        const popupPromise = page.waitForEvent('popup')
        await page.locator('#login').click()
        const popup = await popupPromise
        await popup.waitForLoadState()
        assert.ok((await popup.textContent('body')).includes('"ok": true'))
        await popup.close()

        const stats = async () => {
            const result = await fetch(metadata.backend + '/fixture-stats')
            return result.json()
        }
        const direct = await context.newPage()
        assert.equal((await direct.goto(metadata.origin + '/THINQ_LOGIN/')).status(), 403)
        await direct.close()
        const foreign = await context.newPage()
        await foreign.goto(metadata.foreign)
        const before = (await stats()).length
        await foreign.evaluate(async (origin) => {
            for (const [route, options] of [
                ['/api/read', {}],
                ['/api/write', { method: 'POST', body: 'attack' }],
                ['/thinq_login', {}],
            ]) {
                try {
                    await fetch(origin + route, { ...options, credentials: 'include' })
                } catch {}
            }
            for (const route of ['/ws', '/device?id=synthetic']) {
                await new Promise((resolve) => {
                    const ws = new WebSocket(origin.replace('https:', 'wss:') + route)
                    ws.onerror = () => resolve()
                    ws.onopen = () => {
                        ws.close()
                        resolve()
                    }
                    setTimeout(() => {
                        ws.close()
                        resolve()
                    }, 3000)
                })
            }
        }, metadata.origin)
        const crossPopupPromise = foreign.waitForEvent('popup')
        await foreign.evaluate((origin) => window.open(origin + '/thinq_login'), metadata.origin)
        const crossPopup = await crossPopupPromise
        await crossPopup.waitForLoadState()
        assert.ok((await crossPopup.textContent('body')).includes('403'))
        await crossPopup.close()
        await foreign.evaluate((origin) => {
            const frame = document.createElement('iframe')
            frame.name = 'form-target'
            document.body.append(frame)
            const form = document.createElement('form')
            form.method = 'POST'
            form.action = origin + '/api/write'
            form.target = frame.name
            document.body.append(form)
            form.submit()
        }, metadata.origin)
        await foreign.waitForTimeout(500)
        assert.equal((await stats()).length, before, 'Cross-site browser requests reached synthetic backend')
        if (metadata.hostname) {
            await page.evaluate(
                (origin) =>
                    new Promise((resolve, reject) => {
                        window.rotationSocket = new WebSocket(origin.replace('https:', 'wss:') + '/ws')
                        window.rotationSocket.onopen = resolve
                        window.rotationSocket.onerror = () => reject(new Error('Rotation WebSocket failed'))
                    }),
                metadata.origin,
            )
            const rotated = new Promise((resolve, reject) =>
                lines.once('line', (line) => {
                    try {
                        resolve(JSON.parse(line))
                    } catch (error) {
                        reject(error)
                    }
                }),
            )
            fixture.stdin.write('rotate\n')
            const update = await Promise.race([
                rotated,
                fixtureExit.then(() => {
                    throw new Error('Ingress fixture exited during rotation')
                }),
            ])
            await page.waitForFunction(() => window.rotationSocket.readyState === WebSocket.CLOSED)
            const renewed = await browser.newContext({
                httpCredentials: { username: 'admin', password: update.password, origin: metadata.origin },
            })
            const renewedPage = await renewed.newPage()
            assert.equal((await renewedPage.goto(metadata.origin)).status(), 200)
            await renewed.close()
        }
        await context.close()
        console.log(
            `PASS ${mode}: trusted Chromium TLS, Basic challenge, fetch, /ws and /device WebSockets, popup and cross-site isolation${metadata.hostname ? ', ingress rotation' : ''}`,
        )
    } catch (error) {
        scenarioError = error
    }
    const cleanupErrors = []
    if (browser) {
        try {
            await browser.close()
        } catch (error) {
            cleanupErrors.push(error)
        }
    }
    if (fixture) {
        try {
            fixture.stdin.end('\n')
        } catch (error) {
            cleanupErrors.push(error)
        }
        try {
            const result = await fixtureExit
            if (result.code !== 0) cleanupErrors.push(new Error('Synthetic fixture cleanup failed'))
        } catch (error) {
            cleanupErrors.push(error)
        }
    }
    try {
        await rm(home, { recursive: true, force: true })
    } catch (error) {
        cleanupErrors.push(error)
    }
    if (scenarioError && cleanupErrors.length)
        throw new AggregateError([scenarioError, ...cleanupErrors], 'Scenario and fixture cleanup failures retained')
    if (scenarioError) throw scenarioError
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Fixture cleanup failed')
}

await exercise('--fixture')
await exercise('--fixture-ingress')
