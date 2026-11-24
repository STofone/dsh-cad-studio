/**
 * The hot-reload trap that broke the assembly routes on the live instance:
 * a bridge built by an older module version survives the reload, so the new
 * route handler calls methods the old instance does not have — the web server
 * answers a bare 400. This pins the self-heal: a stale instance must be
 * REPLACED on the next apply, and the routes must work again.
 */
import { apply as mount } from '../index.js'

const calls = []
const state = { code: 0, body: '' }
const routes = new Map()
const ctx = (over = {}) => ({
  logger: { warn: (...a) => calls.push(['warn', ...a]), info: () => {}, error: () => {} },
  effect: (fn) => { const d = fn(); return () => (typeof d === 'function' ? d() : undefined) },
  tools: { register: (def) => { calls.push(['tool', def.name]); return () => {} } },
  webServer: { register: (opts) => { routes.set(opts.path, opts.handler); return () => {} } },
  get: () => undefined,
  ...over,
})

const boot = async () => {
  const local = ctx()
  await mount(local, {})
  return routes.get('/cad-studio')
}

const hit = async (handler, path, method = 'GET') => {
  state.code = 0
  state.body = ''
  const res = {
    writeHead: (code) => { state.code = code },
    end: (body) => { state.body = String(body ?? '') },
  }
  // The POST routes collect the body with req.on('data'|'end'); the stub just
  // reports an empty body so the handler can finish.
  const req = {
    url: path, method, headers: { host: '127.0.0.1' }, destroy: () => {},
    on: (event, cb) => { if (event === 'end') setTimeout(cb, 0); return req },
  }
  await handler(req, res)
  return { code: state.code, body: state.body }
}

let bad = 0
const check = (name, ok, extra) => {
  if (ok) console.log('PASS ', name)
  else { bad += 1; console.log('FAIL ', name, extra === undefined ? '' : JSON.stringify(extra)) }
}

// Fresh boot: the routes work.
let handler = await boot()
let r = await hit(handler, '/cad-studio/assembly')
check('fresh bridge serves /assembly', r.code === 200, r)

// Simulate the reload trap: an old instance with none of the assembly methods.
globalThis.__dshCadStudio.bridge = { getConfig: () => ({}) }
handler = await boot()
r = await hit(handler, '/cad-studio/assembly')
check('stale bridge is replaced, /assembly works again', r.code === 200, r)

// A partially-old instance (has run/status but not the assembly methods) is stale too.
globalThis.__dshCadStudio.bridge = { run: () => {}, status: () => {}, refresh: () => {}, getConfig: () => ({}) }
handler = await boot()
r = await hit(handler, '/cad-studio/assembly')
check('partial bridge is replaced too', r.code === 200, r)

// A complete instance is NOT replaced (same object survives).
const kept = globalThis.__dshCadStudio.bridge
handler = await boot()
check('complete bridge is kept', globalThis.__dshCadStudio.bridge === kept)

// drive/explode answer cleanly (no assembly yet) instead of throwing a 400.
r = await hit(handler, '/cad-studio/drive', 'POST')
check('POST /drive without an assembly answers 404', r.code === 404, r)
r = await hit(handler, '/cad-studio/explode', 'POST')
check('POST /explode without an assembly answers 404', r.code === 404, r)

console.log(bad === 0 ? '\nALL PASS  stale-bridge' : `\n${bad} FAILED`)
process.exit(bad === 0 ? 0 : 1)
