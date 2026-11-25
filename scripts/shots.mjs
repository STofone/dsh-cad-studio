#!/usr/bin/env node
/**
 * Re-shoot the README screenshots against a *test* instance.
 *
 * Only the panel element is captured (`[data-cad-panel-root]`), so the
 * screenshots never show a real workspace, session title or file path — the
 * left rail and the chat area are cropped out. The models used here are the
 * synthetic `体验_*` documents produced by `scripts/dev-playground.mjs`.
 *
 * Usage (inside a container that can reach the dev instance):
 *   node scripts/shots.mjs --url http://127.0.0.1:3201 --token-file /tmp/dev-token.txt
 *
 * --url may point straight at the dev instance when its auth cookie matches
 * the browser origin; otherwise front it with a Host-rewriting proxy (see the
 * note in README).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('/tmp/node_modules/playwright-core')

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at > 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback
}
const URL_BASE = arg('url', 'http://127.0.0.1:3201').replace(/\/+$/, '')
const TOKEN = readFileSync(arg('token-file', '/tmp/dev-token.txt'), 'utf8').trim()
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs')
const CHROME = arg('chrome', '/root/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome')
const SESSION = arg('session', '调用 cad_studio_run 建模方块')

const panel = '[data-cad-panel-root]'
const wait = (page, ms) => page.waitForTimeout(ms)

async function openPanel(page) {
  await page.goto(`${URL_BASE}/?token=${TOKEN}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(6000)
  // The panel exposes `open()` on its debug hook, so a script does not have to
  // negotiate the host's own tab launcher (which moves between versions).
  const opened = await page.waitForFunction(() => Boolean(window.__cadStudioAutoOpen), null, { timeout: 30000 }).then(() => true).catch(() => false)
  if (!opened) throw new Error('the CAD Studio plugin did not load (no window.__cadStudioAutoOpen)')
  for (let i = 0; i < 4; i += 1) {
    await page.evaluate(() => { try { window.__cadStudioAutoOpen.open() } catch (err) { /* retry */ } })
    await page.waitForTimeout(1200)
    if (await page.locator('[data-cad-rail="parts"]').count()) break
  }
  await page.waitForSelector('[data-cad-rail="parts"]', { timeout: 20000 })
  await page.waitForTimeout(2500)
}

/** Open a model as its own tab, through the "+" menu. */
async function openAsTab(page, title) {
  await page.click('[data-cad-tab-add]')
  await wait(page, 600)
  await page.locator('[data-cad-add-scene]', { hasText: title }).first().click()
  await wait(page, 2000)
}

/** Pick a model from the rail's model list (folder icon). */
async function pickModel(page, title) {
  await page.click('[data-cad-rail="models"]')
  await wait(page, 700)
  await page.locator('[data-cad-scene]', { hasText: title }).first().click()
  await wait(page, 1800)
  await page.click('[data-cad-rail="models"]')
  await wait(page, 400)
}

async function shot(page, name) {
  const el = await page.$(panel)
  if (!el) throw new Error(`no ${panel} on page`)
  await el.screenshot({ path: join(OUT, `${name}.png`) })
  console.log(`shot docs/${name}.png`)
}

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--in-process-gpu'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
await openPanel(page)

// 1. the default view: an assembly open in its own tab
await openAsTab(page, '体验_装配')
await shot(page, 'preview')

// 2. joints: numeric entry, zero button, slider, explode
await page.click('[data-cad-rail="motion"]')
await wait(page, 900)
await shot(page, 'motion')

// 3. a selected part: colour, visibility, opacity, wireframe, isolate
await page.click('[data-cad-rail="parts"]')
await wait(page, 600)
const row = page.locator('[data-cad-row]').nth(1)
if (await row.count()) await row.click()
await page.click('[data-cad-rail="props"]')
await wait(page, 800)
await shot(page, 'props')

// 4. a feature list, one row editable at a time
await pickModel(page, '体验_特征')
await page.click('[data-cad-rail="features"]')
await wait(page, 900)
await shot(page, 'features')

// 5. a script model: params on top, rebuild in place
await pickModel(page, '体验_参数化')
await page.click('[data-cad-rail="features"]')
await wait(page, 900)
await shot(page, 'params')

// 6. two model tabs side by side (each keeps its own camera and colours)
await openAsTab(page, '体验_特征')
const stillOpen = await page.locator('[data-cad-rail][aria-pressed="true"]').count()
if (stillOpen) await page.locator('[data-cad-rail][aria-pressed="true"]').first().click()
await wait(page, 1000)
await shot(page, 'tabs')

// 7. the icon rail itself, at 4x so the glyphs are legible
const zoom = await browser.newPage({ viewport: { width: 520, height: 900 }, deviceScaleFactor: 4, colorScheme: 'dark' })
await openPanel(zoom)
await openAsTab(zoom, '体验_装配')
const railBox = await zoom.evaluate(() => {
  const rail = document.querySelector('[aria-label="CAD 面板工具"]')
  if (!rail) return null
  const box = rail.getBoundingClientRect()
  const last = rail.lastElementChild?.getBoundingClientRect()
  return { x: box.x, y: box.y, width: box.width, height: Math.ceil((last ? last.bottom : box.bottom) - box.y) + 6 }
})
if (railBox) {
  await zoom.screenshot({ path: join(OUT, 'rail.png'), clip: railBox })
  console.log(`shot docs/rail.png (${railBox.width}x${railBox.height} css)`)
} else {
  console.log('WARN no rail element — skipping rail.png')
}

await browser.close()
