import assert from 'node:assert/strict'
import { mkdir, readFile, stat } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { WebSocketServer } from 'ws'

export async function browserPrerequisites() {
    let modulePath = process.env.PLAYWRIGHT_MODULE
    if (!modulePath || !process.env.CHROMIUM_EXECUTABLE)
        throw new Error('PLAYWRIGHT_MODULE and CHROMIUM_EXECUTABLE are required')
    if ((await stat(modulePath)).isDirectory()) modulePath = path.join(modulePath, 'index.mjs')
    return import(pathToFileURL(modulePath).href)
}
export async function exerciseManagementUI() {
    const { chromium } = await browserPrerequisites()
    const long = '합성 기기 이름과 모델 식별자 '.repeat(12)
    const id = '__proto__/synthetic?one=1'
    const device = {
        entryId: 'fixture-entry',
        ip: '192.0.2.15',
        name: long,
        deviceId: id,
        model: long,
        connected: true,
        dnat: 'off',
        mode: 'local',
        bridgeEnabled: false,
        bridgeSaved: true,
        bridgeArchived: true,
        bridgeActive: false,
        cloudConnected: false,
    }
    const snapshot = { devices: [device], unassigned: [], configured: true, connected: true }
    const calls = []
    const ws = new WebSocketServer({ noServer: true })
    const monitors = new Set()
    const server = http.createServer(async (req, res) => {
        try {
            if (req.url.startsWith('/__management/')) {
                res.writeHead(404).end()
                return
            }
            if (req.url.startsWith('/api/')) {
                const chunks = []
                for await (const chunk of req) chunks.push(chunk)
                calls.push({ path: req.url, method: req.method, body: Buffer.concat(chunks).toString() })
                res.setHeader('Content-Type', 'application/json')
                if (req.url === '/api/router/config')
                    res.end(
                        JSON.stringify({
                            host: '192.0.2.1',
                            port: 22,
                            username: 'synthetic',
                            passwordSaved: true,
                            rethinkIp: '192.0.2.2',
                        }),
                    )
                else if (req.url === '/api/router/status') res.end(JSON.stringify(snapshot))
                else if (req.url === '/api/router/test')
                    res.end(JSON.stringify({ iptables: 'synthetic', conntrack: 'synthetic' }))
                else if (req.url === '/api/router/devices/fixture-entry' && req.method === 'PUT')
                    res.writeHead(409).end('Turn DNAT off before changing this entry.')
                else res.end('{}')
                return
            }
            const file = new URL(req.url, 'http://fixture').pathname
            const mapping = {
                '/': 'index.html',
                '/router.html': 'router.html',
                '/monitor': 'monitor.html',
                '/panel.js': 'panel.js',
                '/router.js': 'router.js',
                '/monitor.js': 'monitor.js',
                '/ui.js': 'ui.js',
                '/ui.css': 'ui.css',
            }
            if (!mapping[file]) {
                res.writeHead(404).end()
                return
            }
            res.setHeader(
                'Content-Type',
                file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html',
            )
            res.end(await readFile(path.resolve('html', mapping[file])))
        } catch {
            res.writeHead(500).end()
        }
    })
    server.on('upgrade', (req, socket, head) =>
        ws.handleUpgrade(req, socket, head, (client) => {
            if (req.url.startsWith('/device')) {
                monitors.add(client)
                client.on('close', () => monitors.delete(client))
                client.send(JSON.stringify({ status: 'online', meta: { modelId: long } }))
                client.on('message', (data) => calls.push({ method: 'WS', body: data.toString() }))
            } else
                client.send(
                    JSON.stringify({
                        ha: true,
                        system: { version: '0123456789abcdef', startedAt: '2026-01-02T03:04:05Z' },
                        bridge: { loggedIn: true },
                        devices: { [id]: { ...device, mapped: false } },
                    }),
                )
        }),
    )
    await new Promise((done) => server.listen(0, '127.0.0.1', done))
    const origin = `http://127.0.0.1:${server.address().port}`
    const browser = await chromium.launch({
        headless: true,
        executablePath: process.env.CHROMIUM_EXECUTABLE,
        args: ['--no-proxy-server'],
    })
    const errors = [],
        outside = []
    const context = await browser.newContext({ locale: 'ko-KR' })
    await context.route('**/*', (route) => {
        if (!route.request().url().startsWith(origin)) {
            outside.push(route.request().url())
            return route.abort()
        }
        return route.continue()
    })
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    try {
        await page.goto(origin)
        await page.waitForFunction(() => document.querySelector('#devices_body tr'))
        assert.equal(await page.locator('html').getAttribute('lang'), 'ko')
        assert.equal(await page.title(), 'Rethink 관리')
        assert.equal(await page.locator('#management_version').textContent(), '0123456789abcdef')
        assert((await page.locator('#devices_body').textContent()).includes(long))
        const rawStatus = 'SSH handshake failed: <img src=x onerror=alert(1)>'
        const rawBridge = 'LG upstream diagnostic: retry token expired'
        for (const client of ws.clients)
            client.send(
                JSON.stringify({
                    status: rawStatus,
                    bridge: { loggedIn: true },
                    devices: { [id]: { ...device, bridgeError: rawBridge } },
                }),
            )
        await page.waitForFunction(() => document.getElementById('page_status').textContent.includes('상태 알림'))
        assert.equal(await page.locator('#page_status img').count(), 0)
        assert.doesNotMatch(await page.locator('#devices_body').textContent(), /LG upstream diagnostic/)
        await page.evaluate(async () =>
            accountAction('btn_thinq_login_complete', async () => {
                throw new Error('Network unavailable')
            }),
        )
        assert.match(await page.locator('#page_status').textContent(), /LG 계정 작업을 완료하지 못했습니다/)
        await page.evaluate(() => UI.setLocale('en'))
        assert.equal(await page.locator('#page_status').textContent(), 'Network unavailable')
        assert.match(await page.locator('#devices_body').textContent(), /LG upstream diagnostic/)
        await page.evaluate(() => UI.setLocale('ko'))
        assert.equal(
            await page.evaluate(() => UI.diagnostic('Turn DNAT off before changing this entry.', 'router')),
            '이 기기의 DNAT를 끈 뒤 다시 시도하세요.',
        )
        assert.match(
            await page.evaluate(() =>
                UI.diagnostic(
                    'Review and explicitly approve dnat → local before changing mode. Acknowledge power-removal Wi-Fi-module reset and target-mode appliance certificate enrollment, then send modeTransition {from, to, acknowledged: true} matching the current and requested modes. Approval does not verify physical preparation. Refresh if the mode has changed.',
                    'router',
                ),
            ),
            /모드 변경 내용을 다시 확인하고/,
        )
        const mutations = () => calls.filter((call) => !['GET', 'HEAD'].includes(call.method)).length
        const before = mutations()
        await page.getByRole('button', { name: '등록…', exact: true }).click()
        await page.locator('dialog[open] input').fill('401-unsaved')
        await page.evaluate(() => UI.setLocale('en'))
        assert.equal(await page.locator('dialog[open] input').inputValue(), '401-unsaved')
        assert.equal(await page.locator('dialog[open] button').last().textContent(), 'Cancel')
        await page.keyboard.press('Escape')
        assert.equal(mutations(), before)
        await page.goto(origin + '/router.html')
        await page.waitForFunction(() => document.querySelector('#device_rows tr'))
        assert.equal(await page.locator('html').getAttribute('lang'), 'en')
        snapshot.error = rawStatus
        await page.evaluate(() => refresh())
        await page.evaluate(() => UI.setLocale('ko'))
        assert.match(await page.locator('#router_error').textContent(), /공유기 SSH 상태를 확인하지 못했습니다/)
        assert.doesNotMatch(await page.locator('#router_error').textContent(), /SSH handshake failed/)
        await page.evaluate(() => UI.setLocale('en'))
        assert.equal(await page.locator('#router_error').textContent(), rawStatus)
        assert.equal(await page.locator('#test_router').textContent(), 'Test saved settings')
        await page.locator('#router_host').fill('192.0.2.99')
        await page.locator('#router_password').fill('unsaved-synthetic-password')
        await page.locator('#router_password').focus()
        await page.evaluate(() => refresh())
        assert.equal(await page.locator('#router_password').inputValue(), 'unsaved-synthetic-password')
        assert.equal(await page.evaluate(() => document.activeElement.id), 'router_password')
        await page.locator('[data-focus="fixture-entry:mode"]').selectOption('dnat')
        const acknowledgment = page.locator('dialog[open] input[type=checkbox]')
        assert.equal(await acknowledgment.isChecked(), false)
        await page.evaluate(() => UI.setLocale('ko'))
        assert.equal(await acknowledgment.isChecked(), false)
        assert.equal(await page.getByRole('button', { name: '모드 변경 승인', exact: true }).isDisabled(), true)
        assert.equal(await page.locator('#router_password').inputValue(), 'unsaved-synthetic-password')
        await page.keyboard.press('Escape')
        assert.equal(mutations(), before)
        const routerTestsBefore = calls.filter(
            (call) => call.method === 'POST' && call.path === '/api/router/test',
        ).length
        await page.locator('#test_router').click()
        await page.waitForFunction(
            () => document.getElementById('router_error')?.textContent === '공유기 연결 테스트에 성공했습니다',
            undefined,
            { timeout: 15_000 },
        )
        assert.equal(
            calls.filter((call) => call.method === 'POST' && call.path === '/api/router/test').length,
            routerTestsBefore + 1,
        )
        assert(!calls.some((call) => call.path === '/api/router/config' && call.method !== 'GET'))
        await page.evaluate(() =>
            run('fixture-entry', () =>
                api('api/router/devices/fixture-entry', { method: 'PUT', body: { customName: 'synthetic' } }),
            ),
        )
        assert.match(await page.locator('#device_rows .row-status').textContent(), /이 기기의 DNAT를 끈 뒤/)
        assert.doesNotMatch(await page.locator('#device_rows').textContent(), /정책을 저장했습니다/)
        await page.evaluate(() => UI.setLocale('en'))
        assert.equal(
            await page.locator('#device_rows .row-status').textContent(),
            'Turn DNAT off before changing this entry.',
        )
        await page.evaluate(() => UI.setLocale('ko'))
        for (const route of ['/', '/router.html', `/monitor?id=${encodeURIComponent(id)}`]) {
            await page.goto(origin + route)
            await page.waitForFunction(() => !document.querySelector('main').inert)
            if (route.startsWith('/monitor'))
                await page.waitForFunction(() => !document.getElementById('btn_send1').disabled)
            else await page.waitForFunction(() => document.querySelector('tbody tr'))
            for (const width of [320, 390, 768, 1024, 1440]) {
                await page.setViewportSize({ width, height: width === 768 ? 390 : 900 })
                assert(
                    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
                    `${route} overflows at ${width}`,
                )
                const targets = await page
                    .locator('button:visible, nav a:visible, td a:visible, select:visible')
                    .evaluateAll((elements) =>
                        elements.map((element) => ({
                            text: element.textContent,
                            height: element.getBoundingClientRect().height,
                        })),
                    )
                assert(
                    targets.every((target) => target.height >= 43.5),
                    JSON.stringify(targets),
                )
                if (process.env.MANAGEMENT_SCREENSHOT_DIR && [390, 1440].includes(width)) {
                    await mkdir(process.env.MANAGEMENT_SCREENSHOT_DIR, { recursive: true, mode: 0o700 })
                    await page.screenshot({
                        path: path.join(
                            process.env.MANAGEMENT_SCREENSHOT_DIR,
                            `${route === '/' ? 'panel' : route.startsWith('/router') ? 'router' : 'monitor'}-${width}-ko.png`,
                        ),
                        fullPage: true,
                    })
                }
            }
            // 200% text/reflow proxy in Chromium, not an OS zoom or Safari claim.
            await page.setViewportSize({ width: 640, height: 800 })
            await page.addStyleTag({ content: ':root {font-size:32px}' })
            assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
        }
        await page.goto(origin + '/monitor?id=synthetic')
        await page.waitForFunction(
            () => !document.getElementById('btn_send1').disabled && !document.querySelector('main').inert,
        )
        assert.equal(
            await page.evaluate(() => {
                const old = currentSocket
                connect()
                old.onmessage({ data: JSON.stringify({ status: 'online', meta: { modelId: 'stale-socket' } }) })
                return (
                    document.getElementById('btn_send1').disabled &&
                    document.getElementById('device_model').textContent !== 'stale-socket'
                )
            }),
            true,
        )
        await page.waitForFunction(() => !document.getElementById('btn_send1').disabled)
        const client = [...monitors].at(-1)
        client.send('malformed-json')
        await page.waitForFunction(() => document.getElementById('monitor_error').textContent.length > 0)
        await page.locator('#send1').fill('{broken')
        const wsBefore = calls.filter((call) => call.method === 'WS').length
        await page.locator('#btn_send1').click()
        assert.equal(calls.filter((call) => call.method === 'WS').length, wsBefore)
        const payload = '<script>raw & unchanged</script>'
        client.send(JSON.stringify({ rx: payload }))
        await page.locator('.message').first().focus()
        await page.keyboard.press('Enter')
        assert.equal(await page.locator('#send2').inputValue(), payload)
        for (let i = 0; i < 1002; i++) client.send(JSON.stringify({ tx: `synthetic-${i}` }))
        await page.waitForFunction(() => document.getElementById('discarded').textContent.includes('3'))
        assert.equal(await page.locator('.message').count(), 1000)
        client.close()
        await page.waitForFunction(() => document.getElementById('btn_send1').disabled)
        await page.evaluate(() => send('sendToDevice'))
        assert.equal(calls.filter((call) => call.method === 'WS').length, wsBefore)
        await page.reload()
        assert.equal(await page.locator('html').getAttribute('lang'), 'ko')
        const fallback = await browser.newContext({ locale: 'ko-KR' })
        await fallback.addInitScript(() =>
            Object.defineProperty(window, 'localStorage', {
                get() {
                    throw new Error('Storage unavailable')
                },
            }),
        )
        const fallbackPage = await fallback.newPage()
        await fallbackPage.goto(origin)
        assert.equal(await fallbackPage.locator('html').getAttribute('lang'), 'ko')
        await fallbackPage.locator('#language').selectOption('en')
        assert.equal(await fallbackPage.title(), 'Rethink management')
        await fallback.close()
        assert.deepEqual(outside, [])
        assert.deepEqual(errors, [])
        console.log(
            'PASS UI browser: LANG CONTENT RESPONSIVE ACCESSIBLE MONITOR PRESERVE; Chromium reflow proxy, synthetic data only',
        )
    } finally {
        await browser.close()
        for (const client of ws.clients) client.terminate()
        ws.close()
        await new Promise((done) => server.close(done))
    }
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('tests/management-ui.browser.mjs'))
    await exerciseManagementUI()
