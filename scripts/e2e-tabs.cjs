const { chromium } = require('/tmp/node_modules/playwright-core')

const TOKEN = process.env.TOK || ''
const URL = `http://192.168.3.33:3180/?token=${TOKEN}`

;(async () => {
  const browser = await chromium.launch({
    executablePath: '/root/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader',
      '--use-gl=angle', '--use-angle=swiftshader', '--in-process-gpu'],
  })
  const page = await browser.newPage({ viewport: { width: 1160, height: 860 }, colorScheme: 'dark' })
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) })
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e.message).slice(0, 200)))

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForSelector('[data-cad-panel-root]', { timeout: 60000 })
  await page.waitForSelector('[data-cad-tab-add]', { timeout: 20000 })
  await page.waitForTimeout(1500)

  const tabIds = () => page.$$eval('[data-cad-tab]', (els) => els.map((e) => ({
    k: e.getAttribute('data-cad-tab'), id: e.getAttribute('data-cad-tab-id'), scene: e.getAttribute('data-cad-tab-scene'),
    text: e.innerText.trim(), sel: e.getAttribute('aria-selected'),
  })))
  const addVisible = () => page.$$eval('[data-cad-tab-add]', (e) => e.length)

  const out = {}
  out.initial = await tabIds()
  out.addBtn0 = await addVisible()

  // open a model via "+" -> models panel -> pick the first row
  const pickRow = async (n) => {
    // "+" opens the model list, but the list stays open after a pick, so the
    // second click on "+" would just close it again.
    const open = await page.$$eval('[data-cad-panel="models"]', (e) => e.length)
    if (!open) await page.click('[data-cad-tab-add]')
    await page.waitForSelector('[data-cad-scene]', { state: 'attached', timeout: 15000 })
    const rows = await page.$$('[data-cad-scene]')
    await rows[n % rows.length].evaluate((el) => el.click())
    await page.waitForTimeout(1600)
  }
  await pickRow(0)
  out.afterFirst = await tabIds()

  // same model again -> its own tab, disambiguated title
  await pickRow(0)
  out.afterSame = await tabIds()
  out.addBtnAfter2 = await addVisible()

  // independent cameras: front on tab A, top on tab B, back to A
  const cam = () => page.evaluate(() => (window.__cadStudioCamera ? window.__cadStudioCamera() : null))
  const setView = async (name) => {
    await page.click('[data-cad-rail="view"]')
    await page.waitForSelector(`[data-cad-view="${name}"]`, { timeout: 8000 })
    await page.click(`[data-cad-view="${name}"]`)
    await page.click('[data-cad-rail="view"]')
    await page.waitForTimeout(900)
  }
  const tabs = await tabIds()
  const tabA = tabs[1], tabB = tabs[2]
  await page.click(`[data-cad-tab-id="${tabA.id}"]`)
  await page.waitForTimeout(700)
  await setView('front')
  const camA = await cam()
  await page.click(`[data-cad-tab-id="${tabB.id}"]`)
  await page.waitForTimeout(900)
  await setView('top')
  const camB = await cam()
  await page.click(`[data-cad-tab-id="${tabA.id}"]`)
  await page.waitForTimeout(1200)
  const camA2 = await cam()
  const close = (a, b) => Math.max(...a.p.map((v, i) => Math.abs(v - b.p[i])), ...a.t.map((v, i) => Math.abs(v - b.t[i])))
  out.cam = { aToB: close(camA, camB), aToA: close(camA, camA2) }

  // fill to the cap, then check "+" disappears
  for (let i = 0; i < 4; i += 1) {
    const n = await addVisible()
    if (!n) break
    await pickRow(i + 1)
  }
  out.atCap = await tabIds()
  out.addBtnAtCap = await addVisible()

  // close the focused tab -> "+" comes back, fallback tab focused
  const before = await tabIds()
  const focused = before.find((t) => t.sel === 'true')
  await page.click(`[data-cad-tab-close="${focused.id}"]`)
  await page.waitForTimeout(1200)
  out.afterClose = await tabIds()
  out.addBtnAfterClose = await addVisible()
  out.errors = errors
  out.title = await page.$eval('[data-cad-model-title]', (e) => e.getAttribute('data-cad-model-title'))
  console.log(JSON.stringify(out, null, 1))
  await page.screenshot({ path: '/workspace/cad-studio/shots/plus1.png' })
  await browser.close()
})().catch((e) => { console.error('FAIL', e && e.message); process.exit(1) })
