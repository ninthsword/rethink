import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
process.env.PLAYWRIGHT_MODULE ||= path.dirname(require.resolve('playwright/package.json'))
if (!process.env.CHROMIUM_EXECUTABLE) {
    const { chromium } = await import('playwright')
    process.env.CHROMIUM_EXECUTABLE = chromium.executablePath()
}
process.env.UI_ACCESSIBILITY_MODULE ||= path.join(root, 'tests/management-ui-axe.mjs')
const { exerciseManagementUI } = await import('../tests/management-ui.browser.mjs')
await exerciseManagementUI()
