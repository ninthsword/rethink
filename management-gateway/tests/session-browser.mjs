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
if (!modulePath || !process.env.CHROMIUM_EXECUTABLE || !process.env.CERTUTIL_BIN) {
    throw new Error('PLAYWRIGHT_MODULE, CHROMIUM_EXECUTABLE and CERTUTIL_BIN are required')
}
if ((await stat(modulePath)).isDirectory()) modulePath = path.join(modulePath, 'index.mjs')
const { chromium } = await import(pathToFileURL(modulePath).href)
async function exercise(mode) {
    const home = await mkdtemp(path.join(tmpdir(), 'rethink-session-browser-'))
    const fixture = spawn(process.env.PYTHON_BIN || 'python3', ['-B', path.join(here, 'integration.py'), mode], {
        stdio: ['pipe', 'pipe', 'inherit'],
    })
    const exit = new Promise((done, reject) => {
        fixture.once('error', reject)
        fixture.once('exit', (code) => done(code))
    })
    const lines = readline.createInterface({ input: fixture.stdout })
    const next = () =>
        Promise.race([
            new Promise((done) => lines.once('line', (line) => done(JSON.parse(line)))),
            exit.then(() => {
                throw new Error('Synthetic session fixture exited before readiness')
            }),
        ])
    let browser, primaryError
    const errors = [],
        requestFailures = [],
        assets = []
    try {
        const metadata = await next()
        const database = path.join(home, '.pki', 'nssdb')
        await mkdir(database, { recursive: true, mode: 0o700 })
        execFileSync(process.env.CERTUTIL_BIN, ['-N', '-d', `sql:${database}`, '--empty-password'], { stdio: 'pipe' })
        execFileSync(
            process.env.CERTUTIL_BIN,
            ['-A', '-d', `sql:${database}`, '-n', 'Synthetic session CA', '-t', 'C,,', '-i', metadata.ca],
            { stdio: 'pipe' },
        )
        browser = await chromium.launch({
            headless: true,
            executablePath: process.env.CHROMIUM_EXECUTABLE,
            env: { ...process.env, HOME: home },
            args: [
                '--no-proxy-server',
                ...(metadata.hostname ? [`--host-resolver-rules=MAP ${metadata.hostname} 127.0.0.1`] : []),
            ],
        })
        const context = await browser.newContext({ locale: 'ko-KR' })
        let pageNumber = 0
        context.on('page', (observed) => {
            const pageId = ++pageNumber
            observed.on('pageerror', (error) => errors.push({ pageId, message: error.message }))
            observed.on('requestfailed', (request) =>
                requestFailures.push({
                    pageId,
                    path: new URL(request.url()).pathname,
                    failure: request.failure()?.errorText,
                }),
            )
            observed.on('response', (response) => {
                const pathname = new URL(response.url()).pathname
                if (pathname.endsWith('.js')) assets.push({ pageId, path: pathname, status: response.status() })
            })
        })
        const page = await context.newPage()
        const response = await page.goto(metadata.origin)
        assert.equal(new URL(page.url()).pathname, '/__management/login')
        assert.ok(await response.securityDetails(), 'Browser must verify HTTPS without ignore flags')
        assert.equal(await page.title(), '관리 로그인')
        if (metadata.duration === 600000) {
            for (const returnTo of [
                'https://external.invalid/escape',
                '//external.invalid/escape',
                'javascript:alert(1)',
                '/\\external.invalid/escape',
            ]) {
                const error = page.locator('#login-error')
                await error.evaluate(
                    (element) => {
                        element.textContent = ''
                    },
                    undefined,
                    { timeout: 15_000 },
                )
                assert.equal((await error.textContent({ timeout: 15_000 })).trim(), '')
                let interceptedPosts = 0
                const dialogs = []
                const dialogDismissalErrors = []
                const routeHandler = (route) => {
                    if (route.request().method() !== 'POST') return route.continue()
                    interceptedPosts += 1
                    return route.fulfill({
                        status: 200,
                        contentType: 'application/json',
                        body: JSON.stringify({ returnTo }),
                    })
                }
                const dialogHandler = (dialog) => {
                    dialogs.push(dialog.type())
                    dialog.dismiss().catch((dismissError) => dialogDismissalErrors.push(dismissError.message))
                }
                await page.route('**/__management/login', routeHandler)
                page.on('dialog', dialogHandler)
                try {
                    await page.locator('#password').fill(metadata.password, { timeout: 15_000 })
                    const response = page.waitForResponse(
                        (candidate) =>
                            candidate.url() === `${metadata.origin}/__management/login` &&
                            candidate.request().method() === 'POST',
                        { timeout: 15_000 },
                    )
                    const [forged] = await Promise.all([response, page.locator('#sign-in').click({ timeout: 15_000 })])
                    assert.equal(forged.status(), 200)
                    assert.deepEqual(await forged.json(), { returnTo })
                    await page.waitForFunction(
                        () =>
                            !document.getElementById('sign-in').disabled &&
                            document.getElementById('login-error').textContent.trim(),
                        null,
                        { timeout: 15_000 },
                    )
                    assert.equal(interceptedPosts, 1)
                    assert.equal(new URL(page.url()).pathname, '/__management/login')
                    assert.equal(new URL(page.url()).origin, metadata.origin)
                } finally {
                    page.off('dialog', dialogHandler)
                    await page.unroute('**/__management/login', routeHandler)
                    assert.deepEqual(dialogs, [], `Forged returnTo executed a dialog: ${returnTo}`)
                    assert.deepEqual(dialogDismissalErrors, [])
                }
            }
        }
        await page.locator('#password').fill(metadata.password)
        await page.locator('#sign-in').click()
        await page.waitForURL(metadata.origin + '/')
        await page.waitForFunction(
            () =>
                document.querySelector('.session-bar') &&
                typeof UI !== 'undefined' &&
                UI.allowed() &&
                !document.querySelector('main').inert,
        )
        const session = () => page.evaluate(async () => (await fetch('/__management/session')).json())
        const initial = await session()
        assert(initial.remainingMs <= metadata.duration && initial.remainingMs > metadata.duration - 5000)
        const cookies = await context.cookies()
        assert.equal(cookies.length, 1)
        assert.equal(cookies[0].name, '__Host-rethink-session')
        assert(cookies[0].secure && cookies[0].httpOnly && cookies[0].sameSite === 'Strict')
        assert.equal(cookies[0].path, '/')
        for (let i = 0; i < 2; i++) {
            await page.reload()
            await page.waitForFunction(
                () =>
                    document.querySelector('.session-bar') &&
                    typeof UI !== 'undefined' &&
                    UI.allowed() &&
                    !document.querySelector('main').inert,
            )
            assert.equal((await session()).expiresAt, initial.expiresAt)
        }
        for (const route of ['/ws', '/device?id=synthetic']) {
            assert.equal(
                await page.evaluate(
                    (route) =>
                        new Promise((done, reject) => {
                            const socket = new WebSocket(location.origin.replace('https:', 'wss:') + route)
                            socket.onopen = () => socket.send('synthetic-echo')
                            socket.onmessage = (event) => {
                                socket.close()
                                done(event.data)
                            }
                            socket.onerror = () => reject(new Error('Synthetic WebSocket failed'))
                        }),
                    route,
                ),
                'synthetic-echo',
            )
        }
        const forwarded = await page.evaluate(async () => (await (await fetch('/api/read')).json()).headers)
        assert.equal(forwarded.host, new URL(metadata.origin).host)
        assert.equal(forwarded.authorization, undefined)
        assert.equal(forwarded.cookie, undefined)
        if (metadata.duration === 600000) {
            // A response whose headers arrived first must not commit its late body over a newer check.
            await page.evaluate(() => {
                const original = window.fetch.bind(window)
                let held = false
                window.fetch = async (...arguments_) => {
                    const response = await original(...arguments_)
                    if (arguments_[0] === '/__management/session' && !held) {
                        held = true
                        const value = await response.json()
                        return {
                            ok: true,
                            status: 200,
                            json: () =>
                                new Promise((done) => {
                                    window.releaseStaleBody = () => done({ ...value, remainingMs: 0 })
                                }),
                        }
                    }
                    return response
                }
                window.dispatchEvent(new Event('pageshow'))
            })
            await page.waitForFunction(() => typeof window.releaseStaleBody === 'function')
            await page.evaluate(() => window.dispatchEvent(new Event('pageshow')))
            await page.waitForFunction(
                () =>
                    document.querySelector('.session-bar') &&
                    typeof UI !== 'undefined' &&
                    UI.allowed() &&
                    !document.querySelector('main').inert,
            )
            await page.evaluate(() => window.releaseStaleBody())
            await page.waitForTimeout(100)
            assert.equal(new URL(page.url()).pathname, '/')
            assert.equal(await page.locator('main').evaluate((main) => main.inert), false)
            const uncertain = await context.newPage()
            await uncertain.route('**/__management/session', (route) => route.fulfill({ status: 503, body: '' }))
            await uncertain.goto(metadata.origin)
            await uncertain.waitForFunction(
                () =>
                    document.querySelector('main').inert &&
                    document.querySelector('.session-bar').textContent.includes('제어'),
            )
            await uncertain.waitForTimeout(1100)
            assert.equal(await uncertain.locator('#synthetic-dialog').evaluate((dialog) => dialog.inert), true)
            assert((await uncertain.locator('.session-bar').textContent()).includes('제어'))
            await uncertain.unroute('**/__management/session')
            await uncertain.evaluate(() => window.dispatchEvent(new Event('pageshow')))
            await uncertain.waitForFunction(
                () =>
                    document.querySelector('.session-bar') &&
                    typeof UI !== 'undefined' &&
                    UI.allowed() &&
                    !document.querySelector('main').inert,
            )
            await uncertain.route('**/__management/session', (route) => route.fulfill({ status: 503, body: '' }))
            await uncertain.evaluate(() => window.dispatchEvent(new Event('pageshow')))
            await uncertain.waitForFunction(() => document.querySelector('.session-bar').textContent.includes('제어'))
            await uncertain.waitForTimeout(1100)
            assert(
                (await uncertain.locator('.session-bar').textContent()).includes('제어'),
                'Countdown must not conceal the locked error',
            )
            await uncertain.close()
            await page.clock.install()
            await page.locator('#unsaved').fill('preserved input')
            await page.locator('#unsaved').evaluate((input) => input.setSelectionRange(3, 7))
            await page.clock.fastForward(30000)
            await page.waitForTimeout(100)
            assert.equal(await page.locator('#unsaved').inputValue(), 'preserved input')
            assert.deepEqual(
                await page.evaluate(() => [
                    document.activeElement.id,
                    document.getElementById('unsaved').selectionStart,
                    document.getElementById('unsaved').selectionEnd,
                ]),
                ['unsaved', 3, 7],
            )
            assert.equal((await session()).expiresAt, initial.expiresAt)
            await page.clock.resume()
        } else {
            assert.equal(metadata.duration, 12000, 'Explicit shortened real-clock fixture')
            const second = await context.newPage()
            await second.goto(metadata.origin)
            await Promise.all([
                page.locator('#session-warning[open]').waitFor(),
                second.locator('#session-warning[open]').waitFor(),
            ])
            assert((await page.locator('#session-warning').textContent()).includes('세션'))
            const renewalResponse = page.waitForResponse(
                (response) => new URL(response.url()).pathname === '/__management/extend' && response.status() === 200,
            )
            await page.getByRole('button', { name: '세션 연장', exact: true }).click()
            assert(await (await renewalResponse).headerValue('set-cookie'), 'Renewal response must update the cookie')
            await second.locator('#session-warning[open]').waitFor({ state: 'hidden' })
            const extended = await session()
            assert.equal(extended.generation, initial.generation + 1)
            assert(extended.expiresAt > initial.expiresAt)
            const renewedCookies = await context.cookies()
            assert.equal(renewedCookies.length, 1)
            const renewedCookie = renewedCookies[0]
            assert(renewedCookie.value === cookies[0].value, 'Explicit renewal retains the signed session')
            assert(renewedCookie.expires > cookies[0].expires)
            assert(Math.abs(renewedCookie.expires * 1000 - extended.expiresAt) < 1000)
            assert(renewedCookie.secure && renewedCookie.httpOnly && renewedCookie.sameSite === 'Strict')
            assert.equal(renewedCookie.path, '/')
            assert.equal(
                await page.evaluate(
                    async (generation) =>
                        (
                            await fetch('/__management/extend', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ generation }),
                            })
                        ).status,
                    initial.generation,
                ),
                409,
            )
            assert.equal((await session()).generation, extended.generation)
            assert.equal((await context.cookies())[0].expires, renewedCookie.expires, 'Stale renewal is not consent')
            const closedRoutes = new Set()
            second.on('websocket', (socket) =>
                socket.on('close', () => closedRoutes.add(new URL(socket.url()).pathname)),
            )
            await second.evaluate(() => {
                window.held = ['/ws', '/device?id=synthetic'].map(
                    (route) => new WebSocket(location.origin.replace('https:', 'wss:') + route),
                )
            })
            await second.waitForFunction(() => window.held.every((socket) => socket.readyState === WebSocket.OPEN))
            // Cross the original browser and server deadlines using the fixture's real clock.
            await page.waitForTimeout(Math.max(0, initial.expiresAt - Date.now() + 300))
            assert(Date.now() > cookies[0].expires * 1000)
            assert(Date.now() < renewedCookie.expires * 1000, 'Check must run before the renewed deadline')
            assert.equal(await page.evaluate(async () => (await fetch('/api/read')).status), 200)
            await page.reload()
            await page.waitForFunction(
                () => document.querySelector('.session-bar') && typeof UI !== 'undefined' && UI.allowed(),
            )
            assert.equal(new URL(page.url()).pathname, '/')
            assert.equal((await session()).expiresAt, extended.expiresAt, 'Reload must not extend the server session')
            assert.equal(
                (await context.cookies())[0].expires,
                renewedCookie.expires,
                'Passive activity must not extend the cookie',
            )
            assert.equal(
                await second.evaluate(() => window.held.every((socket) => socket.readyState === WebSocket.OPEN)),
                true,
            )
            await page.locator('#session-warning[open]').waitFor()
            await page.getByRole('button', { name: '나중에', exact: true }).click()
            await page.waitForURL('**/__management/login?**')
            await second.waitForURL('**/__management/login?**')
            assert(Date.now() >= extended.expiresAt - 1000, 'Session ends at the renewed deadline')
            assert.deepEqual([...closedRoutes].sort(), ['/device', '/ws'])
            assert.equal(await page.evaluate(async () => (await fetch('/api/read')).status), 401)
            await second.close()
        }
        if (new URL(page.url()).pathname === '/__management/login') {
            await page.locator('#password').fill(metadata.password)
            await page.locator('#sign-in').click()
            await page.waitForURL(metadata.origin + '/')
        }
        await page.waitForFunction(
            () =>
                document.querySelector('.session-bar') &&
                typeof UI !== 'undefined' &&
                UI.allowed() &&
                !document.querySelector('main').inert,
        )
        const beforeForeign = await fetch(metadata.backend + '/fixture-stats').then((r) => r.json())
        const foreign = await context.newPage()
        await foreign.goto(metadata.foreign)
        await foreign.evaluate(async (origin) => {
            for (const route of ['/api/read', '/__management/extend', '/__management/logout']) {
                try {
                    await fetch(origin + route, {
                        method: route === '/api/read' ? 'GET' : 'POST',
                        credentials: 'include',
                    })
                } catch {}
            }
        }, metadata.origin)
        const afterForeign = await fetch(metadata.backend + '/fixture-stats').then((r) => r.json())
        assert.equal(afterForeign.length, beforeForeign.length)
        await foreign.close()
        await page.getByRole('button', { name: '로그아웃', exact: true }).first().click()
        await page.waitForURL('**/__management/login?**')
        assert.equal(await page.evaluate(async () => (await fetch('/api/read')).status), 401)
        assert.deepEqual(errors, [])
        await context.close()
        console.log(
            `PASS session browser ${mode}: trusted TLS, signed cookie reload, explicit extension, tabs, logout${metadata.duration === 12000 ? ', shortened 12s real-clock expiry (not an actual 10-minute or Safari observation)' : ', 600s settings and focus-preserving polling'}`,
        )
    } catch (error) {
        primaryError = error
        console.error('Synthetic browser errors/assets:', { errors, requestFailures, assets })
        if (browser)
            for (const context of browser.contexts())
                for (const diagnosticPage of context.pages()) {
                    console.error(
                        'Synthetic UI failure state:',
                        await diagnosticPage
                            .evaluate(() => ({
                                path: location.pathname,
                                title: document.title,
                                language: document.documentElement.lang,
                                inert: document.querySelector('main')?.inert,
                                status: document.querySelector('.session-bar')?.textContent,
                            }))
                            .catch(() => ({ unavailable: true })),
                    )
                }
        console.error(error)
    }
    const cleanupErrors = []
    if (browser) {
        try {
            await browser.close()
        } catch (error) {
            cleanupErrors.push(error)
        }
    }
    try {
        fixture.stdin.end()
    } catch (error) {
        cleanupErrors.push(error)
    }
    try {
        const code = await exit
        if (code !== 0) cleanupErrors.push(new Error(`Synthetic fixture exited with code ${code}`))
    } catch (error) {
        cleanupErrors.push(error)
    }
    lines.close()
    try {
        await rm(home, { recursive: true })
    } catch (error) {
        cleanupErrors.push(error)
    }
    if (primaryError && cleanupErrors.length)
        throw new AggregateError([primaryError, ...cleanupErrors], 'Scenario and fixture failures retained')
    if (primaryError) throw primaryError
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Fixture cleanup failed')
}
await exercise('--fixture-session')
await exercise('--fixture-session-ingress')
