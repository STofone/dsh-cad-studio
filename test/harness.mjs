/**
 * Minimal end-to-end harness for dsh-cad-studio.
 * Stubs the cordis context, then exercises every public surface:
 * tools (env/run/open), persistence, and the three HTTP routes.
 * Run inside the container that has freecadcmd:
 *   node /workspace/cad-studio/test/harness.mjs
 */
import { writeFile } from 'node:fs/promises'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { apply } from '../index.js'

const tools = new Map()
let handler = null
let disposed = []
const ctx = {
  logger: { info: () => {}, warn: (...a) => console.log('  [plugin warn]', ...a) },
  effect(fn) { const d = fn(); if (typeof d === 'function') disposed.push(d); return d },
  tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name) } },
  webServer: { register({ path, handler: h }) { if (path !== '/cad-studio') throw new Error('bad path ' + path); handler = h; return () => { handler = null } } },
  get() { return undefined },
}

apply(ctx, {})

let pass = 0
const fail = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}${detail ? '  ' + detail : ''}`) }
  else { fail.push(name); console.log(`FAIL  ${name}  ${detail}`) }
}
const near = (a, b, eps = 0.01) => typeof a === 'number' && Math.abs(a - b) <= eps

/** Reject -0 / NaN / Infinity anywhere in a tool result (DSH's lossless-JSON gate). */
function lossless(v, path = 'value') {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return `${path} is ${v}`
    if (Object.is(v, -0)) return `${path} is -0`
    return null
  }
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { const e = lossless(v[i], `${path}[${i}]`); if (e) return e } return null }
  if (v && typeof v === 'object') { for (const k of Object.keys(v)) { const e = lossless(v[k], `${path}.${k}`); if (e) return e } return null }
  if (v === undefined) return `${path} is undefined`
  return null
}

const call = async (name, args, exec) => {
  const def = tools.get(name)
  if (!def) throw new Error('tool not registered: ' + name)
  const value = await def.execute(args ?? {}, exec)
  const bad = lossless(value)
  if (bad) throw new Error(`${name} returns non-lossless JSON: ${bad}`)
  def.output?.schema // schema presence checked below
  return value
}

// ---- 0. registration surface -------------------------------------------
ok('registers 3 tools', ['cad_studio_env', 'cad_studio_open', 'cad_studio_run'].every((n) => tools.has(n)), [...tools.keys()].join(','))
ok('mounts /cad-studio route', typeof handler === 'function')
ok('every tool has an output schema', [...tools.values()].every((d) => d.output?.schema && typeof d.output.render === 'function'))

// ---- 1. env -------------------------------------------------------------
const env = await call('cad_studio_env')
ok('env.available', env.available === true, JSON.stringify(env))
ok('env.binary is freecadcmd', /freecadcmd$/.test(env.binary), env.binary)
ok('env strings never null', typeof env.latest === 'string' && typeof env.binary === 'string')

// ---- 2. run: primitive + scene publish ----------------------------------
const box = await call('cad_studio_run', {
  code: 's = Part.makeBox(30,20,10)\n__out = {"ok": True, "volume": s.Volume, "scene": {"parts": [{"id":"p1","verts":[c for v in s.Vertexes for c in (v.X,v.Y,v.Z)],"tris":[],"color":[0.8,0.5,0.2],"volume":s.Volume}], "instances": [{"name":"box","part":"p1","rot":[1,0,0,0,1,0,0,0,1],"translate":[0,0,0]}]}}',
  title: 'harness-box',
})
ok('run returns ok', box.ok === true, JSON.stringify(box).slice(0, 160))
ok('run volume 6000', near(box.volume, 6000, 0.5), String(box.volume))
ok('run publishes scene-1', box.sceneId === 'scene-1', String(box.sceneId))
ok('run has no stderr leak', !('stderr' in box) || typeof box.stderr === 'string')

// ---- 3. run: boolean cut (the exact number verified earlier) ------------
const cut = await call('cad_studio_run', {
  code: [
    'b = Part.makeBox(60,40,20)',
    'c = Part.makeCylinder(8,20,Vector(30,20,0))',
    'r = b.cut(c)',
    'm = _mesh(r)',
    '__out = {"ok": True, "volume": r.Volume, "scene": {"parts":[{"id":"p1","verts":m["verts"],"tris":m["tris"],"color":[0.4,0.6,0.8],"volume":r.Volume}],"instances":[{"name":"cut","part":"p1","rot":[1,0,0,0,1,0,0,0,1],"translate":[0,0,0]}]}}',
  ].join('\n'),
  title: 'harness-cut',
})
ok('cut ok', cut.ok === true)
ok('cut volume 43978.76', near(cut.volume, 43978.76, 1), String(cut.volume))
ok('cut publishes scene-2', cut.sceneId === 'scene-2', String(cut.sceneId))

// ---- 4. STEP export then open ------------------------------------------
await call('cad_studio_run', {
  code: "s = Part.makeBox(40,30,10)\ns.exportStep('/tmp/harness_part.step')\n__out = {'ok': True, 'path': '/tmp/harness_part.step'}",
  title: 'harness-export',
})
const opened = await call('cad_studio_open', { path: '/tmp/harness_part.step' })
ok('open ok', opened.ok === true, JSON.stringify(opened).slice(0, 200))
ok('open volume 12000', near(opened.volume, 12000, 1), String(opened.volume))
ok('open triangles > 0', opened.triangles > 0, String(opened.triangles))
ok('open publishes next scene id', opened.sceneId === 'scene-3', String(opened.sceneId))

// ---- 5. failure paths must not crash the bridge ------------------------
const badPy = await call('cad_studio_run', { code: 'raise RuntimeError("boom")\n__out = {"ok": True}' })
ok('python error returns ok:false', badPy.ok === false, JSON.stringify(badPy).slice(0, 160))
ok('python error carries stderr', typeof badPy.stderr === 'string' && badPy.stderr.includes('boom'))

const badOpen = await call('cad_studio_open', { path: '/tmp/does-not-exist.step' })
ok('missing file returns ok:false', badOpen.ok === false, JSON.stringify(badOpen).slice(0, 160))

// env must still work after failures (bridge not wedged)
const env2 = await call('cad_studio_env')
ok('bridge alive after failures', env2.available === true)

// ---- 6. HTTP routes -----------------------------------------------------
const mkRes = () => {
  const out = { status: 0, headers: null, body: '' }
  const res = {
    writeHead(s, h) { out.status = s; out.headers = h },
    end(b) { out.body = typeof b === 'string' ? b : JSON.stringify(b); return out },
  }
  return { res, out }
}
const hit = async (url, host = '127.0.0.1:3180') => {
  const { res, out } = mkRes()
  await handler({ url, method: 'GET', headers: { host } }, res)
  return out
}

const st = await hit('/cad-studio/state')
const stJson = JSON.parse(st.body)
ok('route /state 200', st.status === 200 && st.body.length > 2, String(st.status))
ok('route /state runtime live', stJson.runtime.available === true && /freecadcmd$/.test(stJson.runtime.binary), JSON.stringify(stJson.runtime))
ok('route /state latest tracked', stJson.latest && stJson.latest.id === 'scene-3', JSON.stringify(stJson.latest))

const sc = await hit('/cad-studio/scene/scene-3')
const scJson = JSON.parse(sc.body)
ok('route /scene/<id> 200', sc.status === 200)
ok('scene has parts+instances', Array.isArray(scJson.parts) && scJson.parts.length === 1 && Array.isArray(scJson.instances), `parts=${scJson.parts?.length}`)
const verts = scJson.parts[0].verts
const tris = scJson.parts[0].tris
ok('scene mesh sane', verts.length % 3 === 0 && verts.length >= 9 && tris.length % 3 === 0 && tris.every((i) => i >= 0 && i < verts.length / 3), `verts=${verts.length} tris=${tris.length}`)
ok('scene numbers lossless', lossless(scJson) === null, String(lossless(scJson)))

const badId = await hit('/cad-studio/scene/..%2Fetc%2Fpasswd')
ok('bad scene id rejected', badId.status === 400, String(badId.status))

const asset = await hit('/cad-studio/assets/three.min.js')
ok('asset three.min.js 200', asset.status === 200 && asset.body.length > 100000, `bytes=${asset.body.length} type=${asset.headers?.['content-type']}`)
const badAsset = await hit('/cad-studio/assets/../index.js')
ok('asset traversal rejected', badAsset.status === 400 || badAsset.status === 404, String(badAsset.status))

const forbidden = await hit('/cad-studio/state', 'evil.example.com')
ok('non-loopback host 403', forbidden.status === 403, String(forbidden.status))

// ---- 6b. POST /open (sidebar file viewer path) --------------------------
const post = async (url, bodyObj, host = '127.0.0.1:3180') => {
  const { res, out } = mkRes()
  const listeners = {}
  const req = {
    method: 'POST',
    url,
    headers: { host },
    on(ev, fn) { (listeners[ev] ||= []).push(fn); return req },
    destroy() {},
  }
  const done = handler(req, res)
  const payload = JSON.stringify(bodyObj)
  for (const fn of listeners.data || []) fn(payload)
  for (const fn of listeners.end || []) fn()
  await done
  return out
}

const openedRoute = await post('/cad-studio/open', { path: '/tmp/harness_part.step' })
const openedJson = JSON.parse(openedRoute.body || '{}')
ok('POST /open 200', openedRoute.status === 200, `status=${openedRoute.status} body=${openedRoute.body.slice(0, 120)}`)
ok('POST /open publishes scene', openedJson.ok === true && /^scene-\d+$/.test(String(openedJson.sceneId)), JSON.stringify(openedJson).slice(0, 160))
ok('POST /open result lossless', lossless(openedJson) === null, String(lossless(openedJson)))

const relPath = await post('/cad-studio/open', { path: 'relative/x.step' })
ok('POST /open relative path 400', relPath.status === 400, String(relPath.status))
const missing = await post('/cad-studio/open', { path: '/tmp/nope-xyz.step' })
ok('POST /open missing file 404', missing.status === 404, String(missing.status))
const notFile = await post('/cad-studio/open', { path: '/tmp' })
ok('POST /open directory 400', notFile.status === 400, String(notFile.status))

// ---- 7. persistence -----------------------------------------------------
const { readFile } = await import('node:fs/promises')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const stateFile = join(tmpdir(), 'dsh-cad-studio', 'state.json')
const persisted = JSON.parse(await readFile(stateFile, 'utf8'))
const liveLatest = JSON.parse((await hit('/cad-studio/state')).body).latest
ok('state.json persisted', persisted.latest?.id === liveLatest?.id, `${persisted.latest?.id} vs ${liveLatest?.id}`)
const sceneFile = join(tmpdir(), 'dsh-cad-studio', 'scenes', 'scene-3.json')
const onDisk = JSON.parse(await readFile(sceneFile, 'utf8'))
ok('scene file persisted', Array.isArray(onDisk.parts) && onDisk.parts.length === 1)

// ---- 7b. natural contract: `scene = <shape>` publishes automatically ----
const auto = await call('cad_studio_run', {
  code: 'scene = Part.makeBox(120,60,20)\n__out = {"ok": True, "volume_mm3": scene.Volume}',
  title: 'harness-auto',
})
ok('auto scene published', /^scene-\d+$/.test(String(auto.sceneId)), String(auto.sceneId))
ok('auto published flag', auto.published === true, String(auto.published))
ok('auto volume 144000', near(auto.volume, 144000, 1), String(auto.volume))
const autoSceneRes = await hit(`/cad-studio/scene/${auto.sceneId}`)
ok('auto scene served over http', autoSceneRes.status === 200 && JSON.parse(autoSceneRes.body).parts.length === 1, String(autoSceneRes.status))

// a script that publishes nothing must say so instead of looking like a success
const noScene = await call('cad_studio_run', { code: 'x = 1\n__out = {"ok": True, "note": "no geometry"}', title: 'harness-noscene' })
ok('no-scene published=false', noScene.published === false, String(noScene.published))
ok('no-scene carries hint', typeof noScene.hint === 'string' && noScene.hint.length > 10, String(noScene.hint))

// ---- 7f. unsupported file type + decoded FreeCAD errors -----------------
{
  const bad = await call('cad_studio_open', { path: '/tmp/whatever.FCStd' })
  ok('open rejects .FCStd before spawning', bad.ok === false && /unsupported file type: \.fcstd/i.test(String(bad.error)), JSON.stringify(bad).slice(0, 200))
  ok('rejection carries supported-format hint', /step/.test(String(bad.hint)) && /stl/.test(String(bad.hint)), String(bad.hint).slice(0, 120))

  const junk = '/tmp/harness_unknown_ext.unknown'
  await writeFile(junk, 'not a cad file')
  const decoded = await call('cad_studio_run', {
    code: `import Part\ns = Part.Shape()\ns.read(${JSON.stringify(junk)})\nscene = s`,
    title: 'decode_unknown_extension',
  })
  ok('unknown extension surfaces as decoded error', decoded.ok === false && decoded.error === 'Unknown extension', JSON.stringify({ error: decoded.error, stderr: String(decoded.stderr).slice(0, 80) }))
  ok('unknown extension carries hint naming formats', /扩展名/.test(String(decoded.hint)) && /stl/.test(String(decoded.hint)), String(decoded.hint).slice(0, 120))

  const raised = await call('cad_studio_run', { code: 'raise RuntimeError("boom-demo")', title: 'decode_raise' })
  ok('python raise is decoded, not the wrapper line', raised.ok === false && raised.error === 'boom-demo', JSON.stringify({ error: raised.error }))
  ok('no wrapper text leaks into error', !/Exception while processing file/.test(String(raised.error)), String(raised.error).slice(0, 80))
}

// ---- 7g. STL goes through the Mesh module (Part.read rejects .stl) ------
{
  const tmpDir = mkdtempSync(join(tmpdir(), 'cad-harness-'))
  const tetra = `${tmpDir}/harness_tetra.stl`
  await writeFile(tetra, `solid t
facet normal 0 0 -1
 outer loop
  vertex 0 0 0
  vertex 0 1 0
  vertex 1 0 0
 endloop
endfacet
facet normal 0 -1 0
 outer loop
  vertex 0 0 0
  vertex 1 0 0
  vertex 0 0 1
 endloop
endfacet
facet normal -1 0 0
 outer loop
  vertex 0 0 0
  vertex 0 0 1
  vertex 0 1 0
 endloop
endfacet
facet normal 1 1 1
 outer loop
  vertex 1 0 0
  vertex 0 1 0
  vertex 0 0 1
 endloop
endfacet
endsolid t
`)
  const stl = await call('cad_studio_open', { path: tetra })
  ok('open reads STL through Mesh', stl.ok === true && stl.kind === 'mesh', JSON.stringify({ ok: stl.ok, kind: stl.kind, error: stl.error }))
  ok('STL reports 4 triangles', stl.triangles === 4, String(stl.triangles))
  ok('STL volume computed', near(stl.volume, 1 / 6, 0.01), String(stl.volume))
  ok('STL publishes a scene', typeof stl.sceneId === 'string' && stl.sceneId.startsWith('scene-'), String(stl.sceneId))

  const real = '/workspace/fish/多合一进水模块.stl'
  if (existsSync(real)) {
    const one = await call('cad_studio_open', { path: real })
    ok('opens the real 多合一进水模块.stl', one.ok === true && one.triangles === 104, JSON.stringify({ ok: one.ok, tris: one.triangles, vol: one.volume, error: one.error }))
  }
}

// ---- 7h. artifact tools: export / drawing / measure / assembly -----------
{
  const dir = mkdtempSync(join(tmpdir(), 'cad-harness-art-'))
  const step = `${dir}/box.step`
  const exported = await call('cad_studio_export', {
    target: step,
    code: 'import Part\nscene = Part.makeBox(60, 40, 20)',
  })
  ok('export writes STEP', exported.ok === true && exported.bytes > 1000, JSON.stringify({ ok: exported.ok, bytes: exported.bytes }))
  ok('exported STEP is readable', (await call('cad_studio_open', { path: step })).triangles === 12, 'tris')

  const stl = `${dir}/box.stl`
  const stlOut = await call('cad_studio_export', { target: stl, source: step })
  ok('export writes STL', stlOut.ok === true && stlOut.bytes > 500, JSON.stringify({ bytes: stlOut.bytes }))
  const stlBack = await call('cad_studio_open', { path: stl })
  ok('exported STL reopens', stlBack.ok === true && stlBack.triangles === 12, String(stlBack.triangles))

  const badFormat = await call('cad_studio_export', { target: `${dir}/x.xyz`, source: step })
  ok('export rejects unknown format', badFormat.ok === false && /unsupported export format/i.test(String(badFormat.error)), String(badFormat.error).slice(0, 90))

  const svg = `${dir}/box.svg`
  const drawing = await call('cad_studio_drawing', { target: svg, source: step })
  ok('drawing writes SVG', drawing.ok === true && drawing.bytes > 300, JSON.stringify({ bytes: drawing.bytes, views: drawing.views }))
  ok('drawing lays out three views', Array.isArray(drawing.views) && drawing.views.length === 3, String(drawing.views))

  const measured = await call('cad_studio_measure', { source: step, from: [0, 0, 0], to: [60, 40, 20] })
  ok('measure reports volume', near(measured.volume, 48000, 1), String(measured.volume))
  ok('measure reports size', Array.isArray(measured.size) && near(measured.size[0], 60, 0.01), JSON.stringify(measured.size))
  ok('measure reports point distance', near(measured.distance, Math.hypot(60, 40, 20), 0.01), String(measured.distance))
}

// ---- 7i. assembly by file reference -------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'cad-harness-asm-'))
  const post = `${dir}/post.step`
  const made = await call('cad_studio_export', { target: post, code: 'import Part\nscene = Part.makeBox(20, 20, 100, FreeCAD.Vector(0, 0, 0))' })
  ok('assembly: part exported', made.ok === true, JSON.stringify({ bytes: made.bytes }))

  const asm = await call('cad_studio_assembly', {
    parts: [{ name: 'post', path: post }],
    instances: [
      { name: 'left', part: 'post', at: [0, 0, 0] },
      { name: 'right', part: 'post', at: [120, 0, 0], rot: [0, 0, 45] },
    ],
    target: `${dir}/asm.step`,
    title: 'harness_assembly',
  })
  ok('assembly publishes two instances', asm.ok === true && asm.instances === 2, JSON.stringify({ ok: asm.ok, inst: asm.instances }))
  ok('assembly exports STEP', typeof asm.exported === 'string' && asm.bytes > 1000, JSON.stringify({ bytes: asm.bytes }))
  const scene = JSON.parse((await hit(`/cad-studio/scene/${asm.sceneId}`)).body)
  ok('assembly scene has 1 part / 2 instances', scene.parts?.length === 1 && scene.instances?.length === 2, `${scene.parts?.length}/${scene.instances?.length}`)
  ok('assembly instances rotate independently', JSON.stringify(scene.instances[1].rot) !== JSON.stringify(scene.instances[0].rot), 'rot differs')
}

// ---- 7j. parametric model documents (chat-and-draw layer) ----------------
{
  const name = 'harness_模型'
  const script = 'import Part\nL = P.get("长", 100)\nscene = Part.makeBox(L, 20, 10)'
  const created = await call('cad_studio_doc', { action: 'create', name, script, params: { 长: 100 } })
  ok('doc create publishes', created.ok === true && created.published === true, JSON.stringify({ run: created.run, vol: created.volume }))
  ok('doc create volume', near(created.volume, 20000, 1), String(created.volume))

  const updated = await call('cad_studio_doc', { action: 'update', name, params: { 长: 250 }, note: '加长' })
  ok('doc update reruns with new param', near(updated.volume, 50000, 1), String(updated.volume))
  ok('doc update bumps run', updated.run === 2, String(updated.run))

  const shown = await call('cad_studio_doc', { action: 'show', name })
  ok('doc show returns script+params', typeof shown.script === 'string' && shown.params['长'] === 250, JSON.stringify(shown.params))
  ok('doc show keeps history', Array.isArray(shown.history) && shown.history.length >= 1, String(shown.history?.length))

  const reverted = await call('cad_studio_doc', { action: 'revert', name })
  ok('doc revert restores previous params', near(reverted.volume, 20000, 1), String(reverted.volume))

  const bad = await call('cad_studio_doc', { action: 'update', name, script: 'raise RuntimeError("boom")' })
  ok('doc failed rebuild reverts the doc', bad.ok === false && bad.reverted === true, String(bad.error).slice(0, 60))
  const afterBad = await call('cad_studio_doc', { action: 'show', name })
  ok('doc survives a failed rebuild', afterBad.ok === true && near(afterBad.stats.volume, 20000, 1), String(afterBad.stats.volume))

  const listed = await call('cad_studio_doc', { action: 'list' })
  ok('doc list includes the model', listed.ok === true && listed.items.some((m) => m.name === name), String(listed.models))
  const removed = await call('cad_studio_doc', { action: 'delete', name })
  ok('doc delete', removed.deleted === true, JSON.stringify(removed))
  const gone = await call('cad_studio_doc', { action: 'show', name })
  ok('doc show after delete fails cleanly', gone.ok === false && /没有这个模型/.test(String(gone.error)), String(gone.error).slice(0, 40))
  const badName = await call('cad_studio_doc', { action: 'create', name: '../evil', script })
  ok('doc rejects path traversal in the name', badName.ok === false && /模型名/.test(String(badName.error)), String(badName.error).slice(0, 40))
}

// ---- 7j1b. feature-list documents (edit one feature at a time) ----------
{
  const model = 'harness_特征'
  // Idempotent: a previous aborted run may have left the document behind.
  await call('cad_studio_doc', { action: 'delete', name: model })
  const made = await call('cad_studio_doc', {
    action: 'create',
    kind: 'features',
    name: model,
    features: [
      { kind: 'box', label: '底板', size: [60, 40, 20] },
      { kind: 'cut', label: '通孔', with: { kind: 'cylinder', r: 8, h: 30, at: [30, 20, -5] } },
    ],
  })
  ok('feature doc creates and publishes', made.ok === true && made.published === true, JSON.stringify({ ok: made.ok, err: made.error }))
  ok('feature doc volume after cut', near(made.volume, 43978.76, 2), String(made.volume))
  ok('feature doc keeps ids', Array.isArray(made.features) && made.features.map((f) => f.id).join(',') === 'f1,f2', JSON.stringify(made.features?.map((f) => f.id)))

  // The whole point: change one number, nothing else moves.
  const wider = await call('cad_studio_features', {
    model, action: 'update', feature: { id: 'f2', params: { with: { kind: 'cylinder', r: 9, h: 30, at: [30, 20, -5] } } },
  })
  ok('feature update rebuilds', wider.ok === true && near(wider.volume, 42910.44, 2), String(wider.volume))

  const added = await call('cad_studio_features', { model, action: 'add', feature: { kind: 'fillet', label: '圆角', r: 2 } })
  // A fillet rounds the edges, so the volume goes DOWN from the sharp body.
  ok('feature add appends and rebuilds', added.ok === true && added.features.length === 3 && added.volume < 42910 && added.volume > 41000, String(added.volume))

  const off = await call('cad_studio_features', { model, action: 'toggle', feature: { id: 'f3', enabled: false } })
  ok('feature toggle suppresses a step', off.ok === true && off.features.find((f) => f.id === 'f3').enabled === false && near(off.volume, 42910.62, 2), String(off.volume))

  const moved = await call('cad_studio_features', { model, action: 'move', id: 'f3', to: 0 })
  ok('feature move reorders', moved.ok === true && moved.features[0].id === 'f3', JSON.stringify(moved.features?.map((f) => f.id)))

  // Every rebuild must reuse one row in the models list, not stack new ones.
  const modelRows = JSON.parse((await hit('/cad-studio/scenes')).body).scenes.filter((s) => s.title === model)
  ok('feature rebuilds keep one row in the models list', modelRows.length === 1, `rows=${modelRows.length} ids=${modelRows.map((r) => r.id).join(',')}`)

  const listed = await call('cad_studio_features', { model, action: 'list' })
  ok('feature list action', listed.ok === true && listed.features.length === 3 && listed.kind === 'features', String(listed.features?.length))

  // A bad edit is *saved and flagged*, not silently rolled back: the document
  // answers "accepted", the graph answers "this node failed, the rest is blocked".
  const shown = await call('cad_studio_doc', { action: 'show', name: model })
  ok('feature doc survives edits and a bad value', shown.ok === true && Array.isArray(shown.features) && shown.features.length === 3, String(shown.features?.length))
  const removedFeature = await call('cad_studio_features', { model, action: 'remove', id: 'f3' })
  ok('feature remove', removedFeature.ok === true && removedFeature.features.length === 2, String(removedFeature.features?.length))

  // ---- Phase 1: graph semantics on a model of its own -------------------
  const gModel = 'harness_图'
  await call('cad_studio_doc', { action: 'delete', name: gModel })
  const gMade = await call('cad_studio_doc', {
    action: 'create', name: gModel, kind: 'features',
    features: [
      { kind: 'box', label: '底板', size: [60, 40, 20] },
      { kind: 'cut', label: '通孔', with: { kind: 'cylinder', r: 8, h: 30, at: [30, 20, -5] } },
      { kind: 'fillet', label: '圆角', r: 2 },
    ],
  })
  ok('graph model builds', gMade.ok === true && gMade.volume > 42000 && gMade.volume < 43978, String(gMade.volume))

  // Failure isolation: a node that throws is named, kept, and blocks the rest.
  const bad = await call('cad_studio_features', { model: gModel, action: 'add', feature: { kind: 'fillet', label: '太大', r: 5000 } })
  ok('a failing node is saved as failed, not rejected', bad.ok === true && bad.evaluated === false, JSON.stringify({ ok: bad.ok, evaluated: bad.evaluated }))
  const badNode = (bad.graph?.nodes || []).find((n) => n.status === 'failed')
  ok('graph names the failing node', badNode?.id === 'f4' && Boolean(badNode?.message), JSON.stringify(badNode || {}))
  const after = await call('cad_studio_features', { model: gModel, action: 'list' })
  ok('a failed node stays in the document', after.features.length === 4, String(after.features?.length))

  const undoBad = await call('cad_studio_features', { model: gModel, action: 'undo' })
  ok('undo removes the failed node', undoBad.ok === true && undoBad.features.length === 3 && undoBad.evaluated !== false, JSON.stringify({ n: undoBad.features?.length, v: undoBad.volume }))
  const redoBad = await call('cad_studio_features', { model: gModel, action: 'redo' })
  ok('redo brings it back', redoBad.ok === true && redoBad.features.length === 4, String(redoBad.features?.length))
  await call('cad_studio_features', { model: gModel, action: 'undo' })

  // Tip = evaluate only up to this feature (FreeCAD Tip / Onshape rollback bar).
  const tipped = await call('cad_studio_features', { model: gModel, action: 'tip', id: 'f1' })
  ok('tip evaluates only up to the chosen feature', tipped.ok === true && near(tipped.volume, 48000, 1), String(tipped.volume))
  ok('nodes past the tip are skipped', (tipped.graph?.nodes || []).filter((n) => n.status === 'skipped').length === 2, JSON.stringify((tipped.graph?.nodes || []).map((n) => n.id + ':' + n.status)))
  await call('cad_studio_features', { model: gModel, action: 'tip' })
  const untipped = await call('cad_studio_doc', { action: 'show', name: gModel })
  ok('clearing the tip brings the whole tree back', untipped.ok === true && untipped.stats.volume > 42000 && untipped.stats.volume < 43978, String(untipped.stats?.volume))

  // Suppress is an alias of toggle and shows as skipped, not as an error.
  const sup = await call('cad_studio_features', { model: gModel, action: 'suppress', id: 'f3', value: true })
  ok('suppress aliases toggle', sup.ok === true && sup.features.find((f) => f.id === 'f3').enabled === false, JSON.stringify(sup.features?.map((f) => f.id + ':' + f.enabled)))
  ok('a suppressed node is skipped in the graph', (sup.graph?.nodes || []).find((n) => n.id === 'f3')?.status === 'skipped', JSON.stringify((sup.graph?.nodes || []).map((n) => n.id + ':' + n.status)))
  await call('cad_studio_features', { model: gModel, action: 'suppress', id: 'f3', value: false })

  // schema 2 on disk: graph is the canonical store, features is the mirror.
  const rawDoc = JSON.parse(readFileSync(join(gMade.dir, gModel + '.json'), 'utf8'))
  ok('doc is written as schema 2 with a graph', rawDoc.schema === 2 && Array.isArray(rawDoc.graph?.nodes) && rawDoc.graph.nodes.length === 3, JSON.stringify({ schema: rawDoc.schema, nodes: rawDoc.graph?.nodes?.length }))

  const scriptDoc = await call('cad_studio_doc', { action: 'create', name: 'harness_脚本', script: 'import Part\nscene = Part.makeBox(10,10,10)' })
  const wrong = await call('cad_studio_features', { model: 'harness_脚本', action: 'list' })
  ok('feature tool rejects a script document', wrong.ok === false && /脚本模型/.test(String(wrong.error)), String(wrong.error).slice(0, 40))
  await call('cad_studio_doc', { action: 'delete', name: 'harness_脚本' })
  await call('cad_studio_doc', { action: 'delete', name: model })
}

// ---- 7j2. assembly without an export target (publish only) ---------------
{
  const asm2 = await call('cad_studio_assembly', {
    parts: [{ name: 'p1', path: '/tmp/harness_part.step' }],
    instances: [{ name: 'p1', part: 'p1', at: [0, 0, 0] }, { name: 'p2', part: 'p1', at: [50, 0, 0], rot: [0, 0, 45] }],
    title: 'no-target',
  })
  ok('assembly without a target still publishes', asm2.ok === true && asm2.instances === 2 && typeof asm2.sceneId === 'string', JSON.stringify({ ok: asm2.ok, sceneId: asm2.sceneId }))
}

// ---- 7j3. assembly only reads the parts its instances place -------------
{
  const asm3 = await call('cad_studio_assembly', {
    parts: [
      { name: 'used', path: '/tmp/harness_part.step' },
      { name: 'unused', path: '/tmp/does-not-exist.step' },
    ],
    instances: [{ name: 'a', part: 'used', at: [0, 0, 0] }],
    title: 'prune',
  })
  ok('assembly ignores unreferenced parts', asm3.ok === true && asm3.parts === 1, JSON.stringify({ ok: asm3.ok, parts: asm3.parts, err: asm3.error }))
  const asm4 = await call('cad_studio_assembly', {
    parts: [{ name: 'p1', path: '/tmp/harness_part.step' }],
    instances: [{ name: 'a', part: 'nope', at: [0, 0, 0] }],
  })
  ok('assembly names the unknown part', asm4.ok === false && /unknown parts: nope/.test(String(asm4.error)), String(asm4.error).slice(0, 50))
}

// ---- 7j4. colours: host must not force one blue on every part -----------
{
  const opened = await call('cad_studio_open', { path: '/tmp/harness_part.step' })
  const scene = JSON.parse((await hit(`/cad-studio/scene/${opened.sceneId}`)).body)
  const part = (scene.parts || [])[0]
  ok('open() leaves part colour to the client palette', part && part.color === undefined, JSON.stringify(part && part.color))
  const asmC = await call('cad_studio_assembly', {
    parts: [{ name: 'p1', path: '/tmp/harness_part.step', color: [1, 0, 0] }],
    instances: [{ name: 'a', part: 'p1', at: [0, 0, 0] }],
    title: 'colour',
  })
  const sc2 = JSON.parse((await hit(`/cad-studio/scene/${asmC.sceneId}`)).body)
  ok('explicit part colour survives', JSON.stringify(sc2.parts[0].color) === '[1,0,0]', JSON.stringify(sc2.parts[0].color))
}

// ---- 7j5. declarative features (common jobs without Python) -------------
{
  const feat = await call('cad_studio_feature', {
    ops: [
      { kind: 'box', size: [60, 40, 20] },
      { kind: 'cut', with: { kind: 'cylinder', r: 8, h: 40, at: [30, 20, -10], axis: [0, 0, 1] } },
    ],
    title: 'harness_feature',
  })
  ok('feature builds and publishes', feat.ok === true && /^scene-\d+$/.test(String(feat.sceneId)), JSON.stringify({ ok: feat.ok, err: feat.error, vol: feat.volume }))
  ok('feature volume = box minus through hole', near(feat.volume, 48000 - Math.PI * 64 * 20, 80), String(feat.volume))
  const rounded = await call('cad_studio_feature', {
    ops: [{ kind: 'box', size: [60, 40, 20] }, { kind: 'fillet', r: 2 }],
    title: 'harness_fillet',
  })
  ok('feature fillet shaves volume', rounded.ok === true && rounded.volume < 48000 && rounded.volume > 47000, JSON.stringify({ ok: rounded.ok, vol: rounded.volume, err: rounded.error }))
  const bad = await call('cad_studio_feature', { ops: [{ kind: 'nope' }] })
  ok('feature rejects an unknown kind', bad.ok === false && /不支持的特征/.test(String(bad.error)), String(bad.error).slice(0, 40))
  const empty = await call('cad_studio_feature', { ops: [] })
  ok('feature rejects empty ops', empty.ok === false, String(empty.error).slice(0, 40))
}

// ---- 7j6. joints, motion and exploded views ----------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'cad-harness-motion-'))
  const postStep = `${dir}/post.step`
  await call('cad_studio_export', { target: postStep, code: 'import Part\nscene = Part.makeBox(20, 20, 100)' })
  const asm = await call('cad_studio_assembly', {
    parts: [{ name: 'post', path: postStep }],
    instances: [
      { name: 'base', part: 'post', at: [0, 0, 0] },
      { name: 'arm', part: 'post', at: [100, 0, 0] },
    ],
    title: 'harness_motion',
    assembly: 'motion',
    joints: [{ id: 'hinge', instance: 'arm', type: 'revolute', axis: [0, 0, 1], origin: [100, 0, 0], min: -90, max: 90, value: 0 }],
  })
  ok('assembly declares joints', asm.ok === true && asm.joints === 1, JSON.stringify({ ok: asm.ok, joints: asm.joints, warn: asm.jointWarning }))
  const scenesBeforeMotion = JSON.parse((await hit('/cad-studio/scenes')).body).scenes.length
  const listed = await call('cad_studio_joint', { action: 'list', assembly: asm.assembly })
  ok('joint list reports the hinge', listed.ok === true && listed.joints?.[0]?.id === 'hinge', JSON.stringify(listed.joints))
  const before = JSON.parse((await hit(`/cad-studio/scene/${asm.sceneId}`)).body)
  const armBefore = before.instances.find((i) => i.name === 'arm')
  const driven = await call('cad_studio_drive', { assembly: asm.assembly, joint: 'hinge', value: 90 })
  // A parameter change updates the model in place: same scene id, same row.
  ok('drive updates the assembly scene in place', driven.ok === true && driven.sceneId === asm.sceneId, JSON.stringify({ ok: driven.ok, id: driven.sceneId, first: asm.sceneId, err: driven.error }))
  const after = JSON.parse((await hit(`/cad-studio/scene/${driven.sceneId}`)).body)
  const armAfter = after.instances.find((i) => i.name === 'arm')
  ok('drive rotates the driven instance', JSON.stringify(armAfter.rot) !== JSON.stringify(armBefore.rot), `${JSON.stringify(armBefore.rot)} -> ${JSON.stringify(armAfter.rot)}`)
  ok('drive leaves the other instance fixed', JSON.stringify(after.instances.find((i) => i.name === 'base')) === JSON.stringify(before.instances.find((i) => i.name === 'base')), 'base unchanged')
  const clamped = await call('cad_studio_drive', { assembly: asm.assembly, joint: 'hinge', value: 999 })
  ok('drive clamps to the joint range', clamped.ok === true && clamped.value === 90, String(clamped.value))
  const scenario = JSON.parse((await hit(`/cad-studio/scene/${clamped.sceneId}`)).body)
  const exploded = await call('cad_studio_explode', { assembly: asm.assembly, factor: 1 })
  ok('explode publishes', exploded.ok === true && exploded.explode === 1, JSON.stringify({ ok: exploded.ok, ex: exploded.explode, err: exploded.error }))
  const exScene = JSON.parse((await hit(`/cad-studio/scene/${exploded.sceneId}`)).body)
  ok('explode separates the instances', JSON.stringify(exScene.instances.map((i) => i.translate)) !== JSON.stringify(scenario.instances.map((i) => i.translate)), 'moved')
  const routeList = JSON.parse((await hit('/cad-studio/assembly')).body)
  ok('route /assembly lists joints', Array.isArray(routeList.assemblies) && routeList.assemblies.some((a) => a.joints.length === 1), String(routeList.assemblies?.length))
  const routeDrive = await post('/cad-studio/drive', { assembly: asm.assembly, joint: 'hinge', value: 30 })
  ok('route /drive republishes', routeDrive.status === 200 && JSON.parse(routeDrive.body).value === 30, String(routeDrive.status) + ' ' + routeDrive.body.slice(0, 80))
  const routeEx = await post('/cad-studio/explode', { assembly: asm.assembly, factor: 0 })
  ok('route /explode collapses again', routeEx.status === 200 && JSON.parse(routeEx.body).explode === 0, String(routeEx.status))
  // The models list must not grow when a joint or the explode slider moves:
  // every republish rewrote the assembly's own scene instead of adding one.
  const sceneCount = async () => JSON.parse((await hit('/cad-studio/scenes')).body).scenes.length
  const afterMotion = await sceneCount()
  ok('driving and exploding add no new scenes', afterMotion === scenesBeforeMotion, `before=${scenesBeforeMotion} after=${afterMotion}`)
  const noJoint = await call('cad_studio_drive', { assembly: 'motion', joint: 'nope', value: 1 })
  ok('drive rejects an unknown joint', noJoint.ok === false && /没有这个关节/.test(String(noJoint.error)), String(noJoint.error).slice(0, 30))
  const unknownAsm = await call('cad_studio_joint', { action: 'list', assembly: 'asm-999' })
  ok('joint names an unknown assembly', unknownAsm.ok === false && /没有这个装配/.test(String(unknownAsm.error)), String(unknownAsm.error).slice(0, 30))
}

// ---- 7j7. model switcher: list + select published scenes -----------------
{
  await call('cad_studio_run', { code: 'import Part\nscene = Part.makeBox(30, 30, 30)', title: 'switch-b' })
  const list = JSON.parse((await hit('/cad-studio/scenes')).body)
  ok('route /scenes lists published scenes', Array.isArray(list.scenes) && list.scenes.length >= 2, String(list.scenes && list.scenes.length))
  ok('route /scenes is newest-first', list.scenes[0] && list.scenes[0].title === 'switch-b', JSON.stringify(list.scenes[0] && list.scenes[0].title))
  const older = list.scenes[1] && list.scenes[1].id
  const before = JSON.parse((await hit('/cad-studio/state')).body)
  const picked = await post('/cad-studio/select', { id: older })
  const pickedBody = picked.status === 200 ? JSON.parse(picked.body) : {}
  ok('route /select resolves a scene', picked.status === 200 && pickedBody.scene && pickedBody.scene.id === older, String(picked.status))
  const after = JSON.parse((await hit('/cad-studio/state')).body)
  // Reading a model is a view, not a modelling event: the live pointer must not move.
  ok('reading a model leaves the live pointer alone', after.latest && before.latest && after.latest.id === before.latest.id, JSON.stringify([before.latest && before.latest.id, after.latest && after.latest.id]))
  ok('published scenes carry their session', 'session' in (list.scenes[0] || {}), JSON.stringify(Object.keys(list.scenes[0] || {})))
  const unknown = await post('/cad-studio/select', { id: 'scene-9999' })
  ok('select rejects unknown scene', unknown.status === 404, String(unknown.status))
  const bad = await post('/cad-studio/select', { id: '../../etc/passwd' })
  ok('select rejects a bad id', bad.status === 400, String(bad.status))
}

// ---- 7k. model documents default to the calling session's workspace -----
{
  const ws = '/tmp/cad-studio-ws-test'
  rmSync(join(ws, 'cad-models'), { recursive: true, force: true })
  const sessionExec = { agent: { session: { header: { cwd: ws } } } }
  const script = 'import Part\nscene = Part.makeBox(10, 10, 10)'
  const inWs = await call('cad_studio_doc', { action: 'create', name: 'ws_模型', script }, sessionExec)
  ok('doc create lands in the session workspace', inWs.ok === true && inWs.dir === `${ws}/cad-models`, String(inWs.dir))
  ok('doc file exists under the workspace', existsSync(`${ws}/cad-models/ws_模型.json`), `${ws}/cad-models/ws_模型.json`)
  const listedInWs = await call('cad_studio_doc', { action: 'list' }, sessionExec)
  ok('doc list reads the workspace dir', listedInWs.dir === `${ws}/cad-models` && listedInWs.items.some((m) => m.name === 'ws_模型'), String(listedInWs.models))
  const withoutExec = await call('cad_studio_doc', { action: 'list' })
  ok('doc falls back to the global dir without a session', withoutExec.dir === '/workspace/cad-models', String(withoutExec.dir))

  // An explicit modelsDir in the row config still wins over the session.
  const tools2 = new Map()
  const ctx2 = { logger: ctx.logger, effect: (fn) => fn(), get: () => undefined, tools: { register: (d) => { tools2.set(d.name, d); return () => {} } }, webServer: { register: () => () => {} } }
  apply(ctx2, { modelsDir: '/tmp/cad-studio-explicit' })
  const explicit = await tools2.get('cad_studio_doc').execute({ action: 'list' }, sessionExec)
  ok('explicit modelsDir beats the session workspace', explicit.dir === '/tmp/cad-studio-explicit', String(explicit.dir))
}

// ---- 7l. setup: report the binary, and install is a no-op when present --
{
  const check = await call('cad_studio_setup', {})
  ok('setup reports an available binary', check.available === true && /freecadcmd$/.test(check.binary), JSON.stringify(check))
  ok('setup reports a version string', /^\d+\.\d+/.test(check.version), check.version)
  ok('setup knows the package manager', typeof check.packageManager === 'string', check.packageManager)
  const again = await call('cad_studio_setup', { action: 'install' })
  ok('install short-circuits when already installed', again.alreadyInstalled === true && again.ok === true, JSON.stringify({ ok: again.ok, ai: again.alreadyInstalled }))
  ok('install does not run the package manager twice', again.installed === false, String(again.installed))
}

// ---- 7m. field feedback: export accounting, run checks, scene upkeep -----
// Every case here comes from the fish-tank session: a 1.6 KB STEP that
// "exported fine", probe runs filling the model list, no way to measure an
// assembly, and no way to see the old dsh-cad documents at all.
{
  const dir = mkdtempSync(join(tmpdir(), 'cad-harness-fb-'))
  const two = `${dir}/two.step`
  const exported = await call('cad_studio_export', {
    target: two,
    code: 'import Part\nexport_shapes = [Part.makeBox(10,10,10), Part.makeBox(5,5,5, FreeCAD.Vector(100,0,0))]',
  })
  ok('export counts the solids it wrote', exported.ok === true && exported.solids === 2, JSON.stringify({ solids: exported.solids, filtered: exported.filtered }))
  ok('export volume is the written set', near(exported.volume, 1125, 1), String(exported.volume))
  ok('export keeps source volume separate', near(exported.sourceVolume, 1125, 1) && exported.sourceSolids === 2, JSON.stringify({ s: exported.sourceVolume }))

  const kept = await call('cad_studio_export', { target: `${dir}/kept.step`, source: two, minVolume: 200, alsoStl: true })
  ok('minVolume drops the dust', kept.ok === true && kept.solids === 1 && kept.filtered === 1, JSON.stringify({ solids: kept.solids, filtered: kept.filtered }))
  ok('minVolume keeps the big solid', near(kept.volume, 1000, 1), String(kept.volume))
  ok('alsoStl writes a companion file', Boolean(kept.stl?.path) && kept.stl.bytes > 100, JSON.stringify(kept.stl))

  // run: a probe must not become a model row, and a check must catch a shell.
  const scenesBefore = (await call('cad_studio_scene', { action: 'list' })).scenes
  const probe = await call('cad_studio_run', {
    code: 'import Part\nscene = Part.makeBox(30,30,30)',
    title: 'probe must not publish',
    publish: false,
  })
  const scenesAfter = (await call('cad_studio_scene', { action: 'list' })).scenes
  ok('run publish:false leaves the list alone', probe.published === false && scenesAfter === scenesBefore, JSON.stringify({ before: scenesBefore, after: scenesAfter }))

  const shell = `${dir}/shell.step`
  await writeFile(shell, 'ISO-10303-21;\nHEADER;\n', 'utf8')
  const checked = await call('cad_studio_run', {
    code: 'import Part\nprint("noop")',
    check: [two, shell],
    publish: false,
  })
  const files = checked.files ?? []
  ok('run check reports every file', files.length === 2, JSON.stringify(files.map((f) => f.path)))
  ok('run check accepts a real STEP', files[0]?.valid === true && files[0].solids === 2, JSON.stringify(files[0]))
  ok('run check flags a 33-byte shell', files[1]?.valid === false, JSON.stringify(files[1]))

  // scene maintenance
  const published = await call('cad_studio_run', { code: 'import Part\nscene = Part.makeBox(12,12,12)', title: 'upkeep_probe' })
  const renamed = await call('cad_studio_scene', { action: 'rename', id: published.sceneId, title: 'renamed probe' })
  ok('scene rename works', renamed.ok === true && renamed.title === 'renamed probe', JSON.stringify(renamed))
  const dropped = await call('cad_studio_scene', { action: 'delete', id: published.sceneId })
  ok('scene delete works', dropped.ok === true && dropped.removed === published.sceneId, JSON.stringify(dropped))
  const gone = (await call('cad_studio_scene', { action: 'list' })).items.some((r) => r.id === published.sceneId)
  ok('deleted scene leaves the list', gone === false, '')

  // assembly measurements: two 20mm cubes, the second offset by 10mm in X
  const cubeA = await call('cad_studio_export', { target: `${dir}/cube.step`, code: 'import Part\nscene = Part.makeBox(20,20,20)' })
  const asm = await call('cad_studio_assembly', {
    parts: [{ name: 'cube', path: cubeA.path }],
    instances: [{ name: 'a', part: 'cube', at: [0, 0, 0] }, { name: 'b', part: 'cube', at: [10, 0, 0] }],
    title: 'measure demo',
    measure: true,
    interference: true,
  })
  ok('assembly measures each instance', asm.measure?.instances?.length === 2 && near(asm.measure.instances[0].volume, 8000, 1), JSON.stringify(asm.measure?.instances?.[0]))
  ok('assembly reports the total volume', near(asm.measure?.totalVolume, 16000, 1), String(asm.measure?.totalVolume))
  ok('assembly finds the overlapping pair', Array.isArray(asm.interference) && asm.interference.length === 1 && near(asm.interference[0].volume, 4000, 5), JSON.stringify(asm.interference))

  // legacy store: read-only, and it must not throw when the store is absent
  const legacy = await call('cad_studio_legacy', { action: 'list' })
  ok('legacy list answers', legacy.ok === true && typeof legacy.documents === 'number', JSON.stringify({ docs: legacy.documents, dir: legacy.dir }))
}

// ---- 7n. second round of reviewer feedback ------------------------------
// A feature model could only reach STEP by re-implementing the emitter; the
// validation lived in FreeCAD and named a step number instead of the row; a
// boolean took one tool; extrude only knew +Z; and a pruned row came back on
// the next publish.
{
  const dir = mkdtempSync(join(tmpdir(), 'cad-harness-fb2-'))
  const model = `fb_特征_${Date.now() % 100000}`
  await call('cad_studio_doc', { action: 'delete', name: model }).catch(() => {})

  const made = await call('cad_studio_doc', {
    action: 'create',
    name: model,
    kind: 'features',
    features: [
      { kind: 'box', size: [160, 100, 12] },
      { kind: 'cut', with: [{ kind: 'cylinder', r: 8, h: 40, at: [40, 50, -10] }, { kind: 'cylinder', r: 8, h: 40, at: [120, 50, -10] }] },
    ],
  })
  ok('a boolean takes a list of tools', made.ok === true && near(made.volume, 160 * 100 * 12 - 2 * Math.PI * 64 * 12, 2), JSON.stringify({ volume: made.volume }))
  ok('feature rebuild reports triangles', typeof made.triangles === 'number' && made.triangles > 0, JSON.stringify({ triangles: made.triangles }))

  const stepFromModel = `${dir}/from-model.step`
  const viaExport = await call('cad_studio_export', { target: stepFromModel, model })
  ok('export accepts a model name', viaExport.ok === true && viaExport.valid === true, JSON.stringify({ bytes: viaExport.bytes, source: viaExport.source }))
  const back = await call('cad_studio_open', { path: stepFromModel })
  ok('the exported STEP carries the same volume', near(back.volume, made.volume, 2), JSON.stringify({ step: back.volume, model: made.volume }))

  const stepFromDoc = `${dir}/from-doc.step`
  const withExport = await call('cad_studio_doc', { action: 'show', name: model, export: stepFromDoc })
  ok('doc export writes the STEP in one call', withExport.exported?.ok === true && withExport.exported.valid === true, JSON.stringify(withExport.exported))

  // validation must name the row, before FreeCAD ever runs
  const rejected = await call('cad_studio_doc', {
    action: 'create',
    name: `${model}_bad`,
    kind: 'features',
    features: [{ kind: 'box', size: [50, 50, 10] }, { kind: 'cut', label: '忘了 with' }],
  })
  const bad = String(rejected.error ?? '')
  ok('a cut without with is rejected early', /f2/.test(bad) && /with/.test(bad), bad.slice(0, 160))
  await call('cad_studio_doc', { action: 'delete', name: `${model}_bad` }).catch(() => {})

  // extrude in an arbitrary direction, from 3D points
  const prism = await call('cad_studio_feature', {
    ops: [
      { kind: 'extrude', points: [[0, 0, 0], [40, 0, 0], [0, 30, 0]], dir: [0, 0, 20] },
    ],
    title: 'prism probe',
  })
  ok('extrude honours dir', prism.ok === true && near(prism.volume, 0.5 * 40 * 30 * 20, 1), JSON.stringify({ volume: prism.volume }))

  // a pruned row must stay pruned across the next publish
  const first = await call('cad_studio_run', { code: 'import Part\nscene = Part.makeBox(9,9,9)', title: 'prune_probe_a' })
  await call('cad_studio_scene', { action: 'delete', id: first.sceneId })
  await call('cad_studio_run', { code: 'import Part\nscene = Part.makeBox(8,8,8)', title: 'prune_probe_b' })
  const rows = (await call('cad_studio_scene', { action: 'list' })).items.map((r) => r.id)
  ok('a deleted row is not resurrected by the next publish', rows.includes(first.sceneId) === false, JSON.stringify(rows.slice(0, 4)))

  await call('cad_studio_doc', { action: 'delete', name: model }).catch(() => {})

  // ---- 7o. sub-shape selectors (Phase 2a) --------------------------------
  // A predicate, not a persistent id: OCCT renumbers topology on every rebuild,
  // so "the 4 vertical edges" is the only honest way to say it.
  const sModel = 'harness_选择器'
  await call('cad_studio_doc', { action: 'delete', name: sModel })
  const sRun = async (features, note) => {
    await call('cad_studio_doc', { action: 'delete', name: sModel })
    const made = await call('cad_studio_doc', { action: 'create', name: sModel, kind: 'features', features })
    return { ...made, note }
  }
  const sAll = await sRun([{ kind: 'box', size: [60, 40, 20] }, { kind: 'fillet', r: 2 }])
  const sZ = await sRun([{ kind: 'box', size: [60, 40, 20] }, { kind: 'fillet', r: 2, edges: { axis: 'Z', mode: 'parallel', type: 'line' } }])
  const sOne = await sRun([{ kind: 'box', size: [60, 40, 20] }, { kind: 'fillet', r: 2, edges: { axis: 'Z', mode: 'parallel', pick: 'max', one: true } }])
  ok('fillet on every edge is the widest cut', sAll.volume < sZ.volume && sZ.volume < sOne.volume && sOne.volume < 48000,
    JSON.stringify({ all: sAll.volume, z: sZ.volume, one: sOne.volume }))

  const sMiss = await sRun([{ kind: 'box', size: [60, 40, 20] }, { kind: 'fillet', r: 2, edges: { axis: 'Z', type: 'circle' } }])
  ok('an empty match fails the node, with the spec in the message', sMiss.evaluated === false && /选择器没有选中任何边/.test(JSON.stringify(sMiss.errors)), JSON.stringify(sMiss.errors?.[0]?.message || ''))
  ok('a failed selector keeps the geometry it could build', near(sMiss.volume, 48000, 1), String(sMiss.volume))

  const sAmb = await sRun([{ kind: 'box', size: [60, 40, 20] }, { kind: 'fillet', r: 2, edges: { axis: 'Z', mode: 'parallel', one: true } }])
  ok('one:true rejects an ambiguous match', sAmb.evaluated === false && /要求恰好 1 个/.test(JSON.stringify(sAmb.errors)), JSON.stringify(sAmb.errors?.[0]?.message || ''))

  const sShell = await sRun([
    { kind: 'box', size: [60, 40, 20] },
    { kind: 'shell', t: 2, faces: { axis: 'Z', mode: 'aligned', dir: '+', type: 'plane' } },
  ])
  const sClosed = await sRun([{ kind: 'box', size: [60, 40, 20] }, { kind: 'shell', t: 2 }])
  ok('shell opens exactly the selected face', sShell.volume < sClosed.volume && sShell.volume > 0,
    JSON.stringify({ open: sShell.volume, closed: sClosed.volume }))
  await call('cad_studio_doc', { action: 'delete', name: sModel }).catch(() => {})

  // ---- 7p. incremental recompute (Phase 2) ------------------------------
  // BREP prefixes are content-addressed by the op chain, so an edit only
  // recomputes from the first changed feature onward.
  const iModel = 'harness_增量'
  const iFeats = [{ kind: 'box', size: [120, 80, 16] }, { kind: 'cut', with: { kind: 'cylinder', r: 8, h: 40, at: [30, 30, -5] } }, { kind: 'fillet', r: 2, edges: { axis: 'Z', mode: 'parallel' } }]
  await call('cad_studio_doc', { action: 'delete', name: iModel })
  const i0 = await call('cad_studio_doc', { action: 'create', name: iModel, kind: 'features', features: iFeats })
  ok('a fresh build computes every step', i0.cached === 0 && i0.computed === 3, JSON.stringify({ cached: i0.cached, computed: i0.computed }))

  const iNoop = await call('cad_studio_features', { model: iModel, action: 'update', id: 'f1', feature: { params: { size: [120, 80, 16] } } })
  ok('an unchanged rebuild does not run the kernel', iNoop.revalidated === true && iNoop.computed === 0 && near(iNoop.volume, i0.volume, 0.001),
    JSON.stringify({ revalidated: iNoop.revalidated, computed: iNoop.computed }))

  const iLast = await call('cad_studio_features', { model: iModel, action: 'update', id: 'f3', feature: { params: { r: 4 } } })
  ok('editing the last feature resumes from a 2-step prefix', iLast.cached === 2 && iLast.computed === 1 && iLast.volume < i0.volume,
    JSON.stringify({ cached: iLast.cached, computed: iLast.computed, before: i0.volume, after: iLast.volume }))

  const iFirst = await call('cad_studio_features', { model: iModel, action: 'update', id: 'f1', feature: { params: { size: [140, 80, 16] } } })
  ok('editing the first feature recomputes everything', iFirst.cached === 0 && iFirst.computed === 3 && iFirst.volume > iLast.volume,
    JSON.stringify({ cached: iFirst.cached, computed: iFirst.computed }))

  const iHash = await call('cad_studio_doc', { action: 'show', name: iModel })
  ok('the doc remembers the chain hash for the next no-op', typeof iHash.stats?.hash === 'string' && iHash.stats.hash.length === 16, String(iHash.stats?.hash))
  const iAgain = await call('cad_studio_features', { model: iModel, action: 'update', id: 'f1', feature: { params: { size: [140, 80, 16] } } })
  ok('suppressing nothing still short-circuits', iAgain.revalidated === true, JSON.stringify({ revalidated: iAgain.revalidated }))
  await call('cad_studio_doc', { action: 'delete', name: iModel }).catch(() => {})

  // ---- 7o1. five declared joint kinds --------------------------------------
  {
    const mkPart = async (name, size) => {
      // The feature tool returns the run result; the export path is the one we
      // asked for (it writes it through writeShapeFile).
      await call('cad_studio_feature', { ops: [{ kind: 'box', size }], title: name, export: `${dir}/joint-${name}.step` })
      return `${dir}/joint-${name}.step`
    }
    const base = await mkPart('jbase', [80, 60, 10])
    const arm = await mkPart('jarm', [20, 20, 60])
    const asm = await call('cad_studio_assembly', {
      parts: [{ id: 'base', name: 'base', path: base }, { id: 'arm', name: 'arm', path: arm }],
      instances: [{ name: 'base', part: 'base', at: [0, 0, 0] }, { name: 'arm', part: 'arm', at: [30, 0, 10] }],
      title: 'harness_关节',
      joints: [
        { id: 'cyl', instance: 'arm', type: 'cylindrical', axis: [0, 0, 1], value: 45 },
        { id: 'pl', instance: 'base', type: 'planar', axis: [1, 0, 0], value: 5 },
      ],
    })
    ok('cylindrical and planar joints are accepted', asm.ok === true && asm.joints === 2, `${asm.joints} joints ${asm.error || ''}`.trim())
    const rows = await call('cad_studio_joint', { action: 'list', assembly: asm.assembly })
    const cyl = (rows.joints || []).find((j) => j.id === 'cyl')
    ok('cylindrical is listed with its own type', cyl && cyl.type === 'cylindrical', JSON.stringify(cyl))
    const driven = await call('cad_studio_drive', { assembly: asm.assembly, joint: 'cyl', value: 90 })
    ok('a cylindrical joint drives its rotation', driven.ok === true, String(driven.error || ''))
    const badKind = await call('cad_studio_joint', { action: 'set', assembly: asm.assembly, joint: 'x', instance: 'arm', type: 'screw' })
    ok('an unknown joint kind falls back to revolute', badKind.ok === true && badKind.joint.type === 'revolute', JSON.stringify(badKind.joint?.type))
  }

  // ---- 7o2. vars + expressions, and the three extra joint kinds ----------
  {
    const m = 'harness_表达式'
    await call('cad_studio_doc', { action: 'delete', name: m })
    const mk = (w) => [{ kind: 'box', size: ['w', 'd', 't'] }, { kind: 'cut', with: { kind: 'cylinder', r: 'w/10', h: 't*3', at: ['w/2', 'd/2', '-t'] } }]
    const c1 = await call('cad_studio_doc', { action: 'create', name: m, kind: 'features', vars: { w: 100, d: 80, t: 10 }, features: mk(100) })
    const c2 = await call('cad_studio_doc', { action: 'update', name: m, vars: { w: 200 } })
    const shown = await call('cad_studio_doc', { action: 'show', name: m })
    // 160000 − π·20²·10 = 147433.63
    ok('expressions over vars build geometry', c1.evaluated === true && near(c1.volume, 76858.41, 1), String(c1.volume))
    ok('changing a var moves every dependent dimension', near(c2.volume, 147433.63, 1), String(c2.volume))
    ok('the document keeps its vars', shown.vars && shown.vars.w === 200 && shown.vars.d === 80, JSON.stringify(shown.vars))
    const bad = await call('cad_studio_features', { model: m, action: 'add', feature: { kind: 'box', size: ['nope', 1, 1] } })
    ok('an undefined var never silently becomes 0', bad.ok === false && /size|变量/.test(String(bad.error)), String(bad.error).slice(0, 70))
    const hostile = await call('cad_studio_features', { model: m, action: 'add', feature: { kind: 'box', size: ['__import__("os")', 1, 1] } })
    ok('a non-arithmetic string is rejected, never evaluated', hostile.ok === false, String(hostile.error).slice(0, 60))
    await call('cad_studio_doc', { action: 'delete', name: m })
  }

  // ---- 7p. at.ref: a feature anchored to a face follows that face ----------
  {
    const m = 'harness_锚定'
    const feats = (t) => [
      { kind: 'box', size: [100, 80, t] },
      { kind: 'fuse', with: { kind: 'cylinder', r: 10, h: 12, at: { ref: { axis: 'Z', mode: 'aligned', dir: '+', type: 'plane' }, offset: [0, 0, -6] } } },
    ]
    await call('cad_studio_doc', { action: 'delete', name: m })
    const thin = await call('cad_studio_doc', { action: 'create', name: m, kind: 'features', features: feats(16) })
    await call('cad_studio_doc', { action: 'update', name: m, features: feats(30) })
    const thick = await call('cad_studio_doc', { action: 'show', name: m })
    const grew = thick.stats?.volume - thin.volume
    // 100×80×14 thicker plate = 112000 mm³ extra; the boss rides along.
    ok('at.ref follows the face it names', near(grew, 112000, 5), `${thin.volume} → ${thick.stats?.volume} (Δ${Math.round(grew)})`)
    ok('graph marks the anchored node', Boolean(thick.graph?.nodes?.some((n) => n.anchored)), JSON.stringify(thick.graph?.nodes?.map((n) => n.anchored)))
    ok('graph exposes the evaluation chain', (thick.graph?.nodes || []).every((n) => Array.isArray(n.dependsOn)), JSON.stringify(thick.graph?.nodes?.[1]?.dependsOn))
    const miss = await call('cad_studio_features', { model: m, action: 'add', feature: { kind: 'cut', with: { kind: 'cylinder', r: 4, h: 8, at: { ref: { axis: 'Z', type: 'circle' } } } } })
    ok('a selector that matches nothing fails loudly', miss.evaluated === false && /没有选中任何面/.test(JSON.stringify(miss.errors || [])), JSON.stringify(miss.errors?.[0]?.message || '').slice(0, 80))
    await call('cad_studio_doc', { action: 'delete', name: m })
  }

  // ---- 7q. install-and-run: the doctor must answer "why can't I use this?" --
  const doc = await call('cad_studio_doctor', {})
  ok('doctor reports a ready or a fixed-able state', typeof doc.ready === 'boolean', JSON.stringify(doc.ready))
  ok('doctor lists the kernel check first', Array.isArray(doc.checks) && /内核|FreeCAD/.test(doc.checks[0]), JSON.stringify(doc.checks.slice(0, 2)))
  ok('doctor exposes per-capability flags', doc.capabilities && typeof doc.capabilities.modeling === 'boolean' && typeof doc.capabilities.drawing === 'boolean', JSON.stringify(doc.capabilities))
  ok('a check that fails always carries a fix', (doc.checks || []).every((c) => !/^FAIL/.test(c) || /—/.test(c)), JSON.stringify(doc.checks))
}

// ---- undo journal: documents and assembly joints ------------------------
{
  const model = 'harness_建撤'
  await call('cad_studio_doc', { action: 'delete', name: model }).catch(() => {})
  const made = await call('cad_studio_doc', { action: 'create', name: model, kind: 'features', features: [{ kind: 'box', label: '板', size: [50, 40, 10] }] })
  ok('journal: create ok', made.ok === true, JSON.stringify(made).slice(0, 120))
  const undone = await call('cad_studio_undo', { scope: 'auto' })
  ok('journal: undo removes a new model', undone.ok === true && undone.scope === 'doc', JSON.stringify(undone).slice(0, 140))
  const gone = await call('cad_studio_doc', { action: 'show', name: model })
  ok('journal: model is gone after undo', gone.ok === false, JSON.stringify(gone).slice(0, 120))
  const redone = await call('cad_studio_redo', { scope: 'auto' })
  const back = await call('cad_studio_doc', { action: 'show', name: model })
  ok('journal: redo brings it back', redone.ok === true && back.ok === true, `redo=${redone.ok} back=${back.ok}`)
  await call('cad_studio_doc', { action: 'delete', name: model }).catch(() => {})
}

{
  const model = 'harness_删撤'
  await call('cad_studio_doc', { action: 'delete', name: model }).catch(() => {})
  await call('cad_studio_doc', { action: 'create', name: model, kind: 'features', features: [{ kind: 'box', label: '板', size: [40, 30, 8] }] })
  const del = await call('cad_studio_doc', { action: 'delete', name: model })
  const undone = await call('cad_studio_undo', { scope: 'auto' })
  const back = await call('cad_studio_doc', { action: 'show', name: model })
  ok('journal: undo restores a deleted model', del.ok === true && undone.ok === true && back.ok === true, `del=${del.ok} undo=${undone.ok} back=${back.ok}`)
  await call('cad_studio_doc', { action: 'delete', name: model }).catch(() => {})
}

{
  const jdir = mkdtempSync(join(tmpdir(), 'cad-harness-journal-'))
  const jstep = `${jdir}/post.step`
  await call('cad_studio_export', { target: jstep, code: 'import Part\nscene = Part.makeBox(20, 20, 100, FreeCAD.Vector(0, 0, 0))' })
  const asm = await call('cad_studio_assembly', {
    parts: [{ name: 'post', path: jstep }],
    instances: [{ name: 'left', part: 'post', at: [0, 0, 0] }, { name: 'right', part: 'post', at: [120, 0, 0] }],
    joints: [{ id: 'j1', instance: 'right', type: 'revolute', axis: [0, 0, 1], origin: [120, 0, 0], min: -90, max: 90, value: 20 }],
  })
  const rm = await call('cad_studio_joint', { assembly: asm.assembly, action: 'remove', joint: 'j1' })
  const undone = await call('cad_studio_undo', { scope: 'assembly' })
  const after = await call('cad_studio_joint', { assembly: asm.assembly, action: 'list' })
  ok('journal: undo restores a removed joint', asm.ok === true && rm.ok === true && undone.ok === true && Array.isArray(after.joints) && after.joints.length === 1, `asm=${asm.ok} err=${asm.error ?? ''} rm=${rm.ok} undo=${undone.ok} joints=${after.joints?.length}`)
}


// ---- 7r. sketches: geometry + constraints, solved by FreeCAD -----------
{
  const rect = (w, h) => ({
    geometry: [
      { id: 'g1', type: 'line', p1: [0, 0, 0], p2: [50, 0, 0] },
      { id: 'g2', type: 'line', p1: [50, 0, 0], p2: [50, 30, 0] },
      { id: 'g3', type: 'line', p1: [50, 30, 0], p2: [0, 30, 0] },
      { id: 'g4', type: 'line', p1: [0, 30, 0], p2: [0, 0, 0] },
    ],
    constraints: [
      { id: 'c1', type: 'coincident', a: 'g1', pa: 2, b: 'g2', pb: 1 },
      { id: 'c2', type: 'coincident', a: 'g2', pa: 2, b: 'g3', pb: 1 },
      { id: 'c3', type: 'coincident', a: 'g3', pa: 2, b: 'g4', pb: 1 },
      { id: 'c4', type: 'coincident', a: 'g4', pa: 2, b: 'g1', pb: 1 },
      { id: 'c5', type: 'horizontal', a: 'g1' }, { id: 'c6', type: 'vertical', a: 'g2' },
      { id: 'c7', type: 'horizontal', a: 'g3' }, { id: 'c8', type: 'vertical', a: 'g4' },
      { id: 'd1', type: 'distance', a: 'g1', pa: 1, b: 'g1', pb: 2, value: w },
      { id: 'd2', type: 'distance', a: 'g2', pa: 1, b: 'g2', pb: 2, value: h },
    ],
  })
  const box = await call('cad_studio_feature', { ops: [{ kind: 'extrude', sketch: 'S1', h: 10 }], sketches: { S1: rect(80, 40) } })
  ok('sketch: a constrained rectangle extrudes to w*h*h', box.ok === true && near(box.volume ?? 0, 32000, 1), `ok=${box.ok} volume=${Math.round(box.volume ?? 0)} err=${box.error ?? ''}`)
  const wide = await call('cad_studio_feature', { ops: [{ kind: 'extrude', sketch: 'S1', h: 10 }], sketches: { S1: rect(120, 40) } })
  ok('sketch: changing one dimension drives the shape', wide.ok === true && near(wide.volume ?? 0, 48000, 1), `volume=${Math.round(wide.volume ?? 0)}`)
  const clash = rect(80, 40)
  clash.constraints.push({ id: 'd3', type: 'distance', a: 'g1', pa: 1, b: 'g1', pb: 2, value: 20 })
  const bad = await call('cad_studio_feature', { ops: [{ kind: 'extrude', sketch: 'S1', h: 10 }], sketches: { S1: clash } })
  ok('sketch: contradictory dimensions fail loudly', bad.ok === false && /conflict|failed/i.test(String(bad.error ?? '')), String(bad.error ?? '').slice(0, 120))
}

// ---- 7s. sketches drive revolve too -------------------------------------
{
  const ring = {
    geometry: [
      { id: 'g1', type: 'line', p1: [20, 0, 0], p2: [30, 0, 0] },
      { id: 'g2', type: 'line', p1: [30, 0, 0], p2: [30, 10, 0] },
      { id: 'g3', type: 'line', p1: [30, 10, 0], p2: [20, 10, 0] },
      { id: 'g4', type: 'line', p1: [20, 10, 0], p2: [20, 0, 0] },
    ],
    constraints: [
      { id: 'c1', type: 'coincident', a: 'g1', pa: 2, b: 'g2', pb: 1 },
      { id: 'c2', type: 'coincident', a: 'g2', pa: 2, b: 'g3', pb: 1 },
      { id: 'c3', type: 'coincident', a: 'g3', pa: 2, b: 'g4', pb: 1 },
      { id: 'c4', type: 'coincident', a: 'g4', pa: 2, b: 'g1', pb: 1 },
      { id: 'c5', type: 'horizontal', a: 'g1' }, { id: 'c6', type: 'vertical', a: 'g2' },
      { id: 'c7', type: 'horizontal', a: 'g3' }, { id: 'c8', type: 'vertical', a: 'g4' },
    ],
  }
  // Profile 10x10 centred at x=25, revolved about the in-plane Y axis:
  // area 100 x 2*pi*r(25) = 15707.96 mm3 (measured on 0.20.2).
  const made = await call('cad_studio_feature', { ops: [{ kind: 'revolve', sketch: 'R1', origin: [0, 0, 0], axis: 'Y', angle: 360 }], sketches: { R1: ring } })
  ok('sketch: revolve about an in-plane axis yields a solid', made.ok === true && near(made.volume ?? 0, 15707.96, 1), `ok=${made.ok} vol=${made.volume} err=${String(made.error ?? '').slice(0, 80)}`)

  const perp = await call('cad_studio_feature', { ops: [{ kind: 'revolve', sketch: 'R1', origin: [0, 0, 0], axis: 'Z', angle: 360 }], sketches: { R1: ring } })
  ok('sketch: perpendicular axis is refused instead of silently giving 0 mm3', perp.ok === false && /零体积|零厚度|平面内/.test(String(perp.error ?? '')), `ok=${perp.ok} err=${String(perp.error ?? '').slice(0, 100)}`)

  const noAxis = await call('cad_studio_feature', { ops: [{ kind: 'revolve', sketch: 'R1', angle: 360 }], sketches: { R1: ring } })
  ok('sketch: revolve demands an explicit axis', noAxis.ok === false && /显式给 axis/.test(String(noAxis.error ?? '')), `ok=${noAxis.ok} err=${String(noAxis.error ?? '').slice(0, 90)}`)
}

// ---- 7t. standard holes -------------------------------------------------
{
  const plate = { ops: [{ kind: 'box', size: [60, 40, 20] },
    { kind: 'cut', with: { kind: 'hole', d: 10, at: [30, 20, 20] } }] }
  const thru = await call('cad_studio_feature', plate)
  // 48000 - pi*25*20 = 46429.20
  ok('hole: simple through hole subtracts a cylinder', thru.ok === true && near(thru.volume ?? 0, 46429.2, 1), `vol=${Math.round((thru.volume ?? 0) * 100) / 100} err=${thru.error ?? ''}`)

  const cb = { ops: [{ kind: 'box', size: [60, 40, 20] },
    { kind: 'cut', with: { kind: 'hole', d: 10, type: 'counterbore', cb_d: 16, cb_depth: 6, at: [30, 20, 20] } }] }
  const cbore = await call('cad_studio_feature', cb)
  // 46429.20 - pi*(64-25)*6 = 45694.07
  ok('hole: counterbore adds the wider seat', cbore.ok === true && near(cbore.volume ?? 0, 45694.07, 2), `vol=${Math.round((cbore.volume ?? 0) * 100) / 100} err=${cbore.error ?? ''}`)

  const bad = await call('cad_studio_feature', { ops: [{ kind: 'box', size: [10, 10, 10] }, { kind: 'cut', with: { kind: 'hole', at: [5, 5, 10] } }] })
  {
    const text = JSON.stringify(bad.errors ?? bad.error ?? '')
    ok('hole: missing diameter is refused with a readable message', (bad.ok === false || (bad.errors ?? []).length > 0) && /hole|直径|图元/.test(text), `ok=${bad.ok} errors=${text.slice(0, 120)}`)
  }
}

// ---- 7u. mass from density ----------------------------------------------
{
  const massDir = mkdtempSync(join(tmpdir(), 'cad-harness-mass-'))
  const path = join(massDir, 'mass.step')
  await call('cad_studio_feature', { ops: [{ kind: 'box', size: [60, 40, 20] }], export: path })
  const m = await call('cad_studio_measure', { source: path, density: 2.7 })
  // 48000 mm3 = 48 cm3, x2.7 g/cm3 = 129.6 g
  ok('measure: density turns volume into grams', m.ok === true && near(m.mass_g ?? 0, 129.6, 0.01), `mass=${m.mass_g} vol=${m.volume}`)
  const noRho = await call('cad_studio_measure', { source: path })
  ok('measure: no density means no mass field', noRho.mass_g === undefined, `mass=${noRho.mass_g}`)
}

// ---- 7v. cross-section -------------------------------------------------
{
  const secDir = mkdtempSync(join(tmpdir(), 'cad-harness-sec-'))
  const blk = join(secDir, 'blk.step')
  await call('cad_studio_feature', { ops: [{ kind: 'box', size: [60, 40, 20] }], export: blk })
  const svg = join(secDir, 'cut.svg')
  const mid = await call('cad_studio_section', { source: blk, axis: 'Z', at: 10, target: svg })
  ok('section: area and perimeter of a 60x40 box', mid.ok === true && near(mid.area ?? 0, 2400, 0.5) && near(mid.perimeter ?? 0, 200, 0.5), `area=${mid.area} per=${mid.perimeter}`)
  ok('section: writes an SVG outline', mid.ok === true && existsSync(svg) && readFileSync(svg, 'utf8').includes('<svg'), `svg=${mid.svg}`)

  const dxf = join(secDir, 'cut.dxf')
  const asDxf = await call('cad_studio_section', { source: blk, axis: 'Z', at: 10, target: dxf })
  ok('section: writes DXF when the target ends with .dxf', asDxf.ok === true && existsSync(dxf) && readFileSync(dxf, 'utf8').includes('SECTION'), `dxf=${asDxf.dxf} bytes=${existsSync(dxf) ? readFileSync(dxf).length : 0}`)

  const miss = await call('cad_studio_section', { source: blk, axis: 'Z', at: 500 })
  ok('section: a plane outside the solid yields zero loops', miss.ok === true && miss.loops === 0 && miss.area === 0, `loops=${miss.loops} area=${miss.area}`)
}

// ---- 7w. rename / duplicate ---------------------------------------------
{
  const base = `harness_改名_${process.pid}`
  const copy = `${base}_副本`
  const next = `${base}_新`
  for (const n of [base, copy, next]) { try { await call('cad_studio_doc', { action: 'delete', name: n }) } catch {} }
  const made = await call('cad_studio_doc', { action: 'create', name: base, kind: 'features', features: [{ kind: 'box', size: [40, 30, 20] }] })
  ok('doc rename: baseline model builds', made.ok === true && near(made.volume ?? 0, 24000, 1), `vol=${made.volume}`)

  const dup = await call('cad_studio_doc', { action: 'duplicate', name: base, to: copy })
  ok('doc duplicate: copy builds its own scene with the same volume', dup.ok === true && dup.copiedFrom === base && near(dup.volume ?? 0, 24000, 1), JSON.stringify(dup).slice(0, 160))

  const ren = await call('cad_studio_doc', { action: 'rename', name: base, to: next })
  ok('doc rename: renames in place', ren.ok === true && ren.renamed === true && ren.to === next, JSON.stringify(ren).slice(0, 140))

  const list = await call('cad_studio_doc', { action: 'list' })
  const names = (list.items ?? []).map((i) => i.name)
  ok('doc rename: list shows the new name only', names.includes(next) && !names.includes(base), names.join(','))

  const back = await call('cad_studio_undo', { scope: 'auto' })
  const afterUndo = (await call('cad_studio_doc', { action: 'list' })).items.map((i) => i.name)
  ok('doc rename: undo brings the old name back', back.ok === true && afterUndo.includes(base) && !afterUndo.includes(next), JSON.stringify(back).slice(0, 120))

  for (const n of [base, copy, next]) { try { await call('cad_studio_doc', { action: 'delete', name: n }) } catch {} }
}

// ---- 7w2. groove by composition (cut + revolved profile) ----------------
{
  // A groove is not a separate op: cut a revolved profile out of a body. This
  // pins the composition so a revolve regression cannot hide behind it.
  const ring = {
    geometry: [
      { id: 'g1', type: 'line', p1: [20, 0, 0], p2: [32, 0, 0] },
      { id: 'g2', type: 'line', p1: [32, 0, 0], p2: [32, 12, 0] },
      { id: 'g3', type: 'line', p1: [32, 12, 0], p2: [20, 12, 0] },
      { id: 'g4', type: 'line', p1: [20, 12, 0], p2: [20, 0, 0] },
    ],
    constraints: [
      { id: 'c1', type: 'coincident', a: 'g1', pa: 2, b: 'g2', pb: 1 },
      { id: 'c2', type: 'coincident', a: 'g2', pa: 2, b: 'g3', pb: 1 },
      { id: 'c3', type: 'coincident', a: 'g3', pa: 2, b: 'g4', pb: 1 },
      { id: 'c4', type: 'coincident', a: 'g4', pa: 2, b: 'g1', pb: 1 },
      { id: 'c5', type: 'horizontal', a: 'g1' }, { id: 'c6', type: 'vertical', a: 'g2' },
      { id: 'c7', type: 'horizontal', a: 'g3' }, { id: 'c8', type: 'vertical', a: 'g4' },
    ],
  }
  const g = await call('cad_studio_feature', {
    ops: [
      { kind: 'cylinder', r: 30, h: 40 },
      { kind: 'cut', with: { kind: 'revolve', sketch: 'G1', axis: 'Y', origin: [0, 0, 20], angle: 360 } },
    ],
    sketches: { G1: ring },
  })
  ok('groove: cutting a revolved profile removes material and stays valid', g.ok === true && (g.volume ?? 0) > 0 && (g.volume ?? 0) < Math.PI * 900 * 40, `ok=${g.ok} vol=${g.volume} err=${String(g.error ?? '').slice(0, 80)}`)
}

// ---- 7x. geometry self-check --------------------------------------------
{
  const chkDir = mkdtempSync(join(tmpdir(), 'cad-harness-chk-'))
  const boxPath = join(chkDir, 'box.step')
  await call('cad_studio_feature', { ops: [{ kind: 'box', size: [60, 40, 20] }], export: boxPath })
  const good = await call('cad_studio_check', { source: boxPath })
  ok('check: a clean box reports no problems', good.ok === true && (good.problems ?? []).length === 0 && near(good.volume ?? 0, 48000, 1), `ok=${good.ok} vol=${good.volume} p=${JSON.stringify(good.problems ?? []).slice(0, 120)}`)

  // A lone face is a shape that opens fine but is not a solid: the check has to
  // say so instead of letting it go to the printer.
  const faceCode = "export_shapes = [Part.Face(Part.makePolygon([Vector(0,0,0), Vector(10,0,0), Vector(10,10,0), Vector(0,10,0), Vector(0,0,0)]))]"
  const face = await call('cad_studio_check', { code: faceCode })
  const faceText = (face.problems ?? []).join(' | ')
  ok('check: a lone face is flagged as not a solid', face.ok === false && /没有实体/.test(faceText), `ok=${face.ok} p=${faceText.slice(0, 140)}`)
}

// ---- 7y. mesh repair / decimate -----------------------------------------
{
  const mDir = mkdtempSync(join(tmpdir(), 'cad-harness-mesh-'))
  const src = join(mDir, 'box.step')
  await call('cad_studio_feature', { ops: [{ kind: 'box', size: [60, 40, 20] }], export: src })
  const stl = join(mDir, 'box.stl')
  const m = await call('cad_studio_mesh', { source: src, target: stl })
  ok('mesh: box meshes to 12 facets and writes an STL', m.ok === true && m.facets === 12 && existsSync(stl) && (m.bytes ?? 0) > 0, `facets=${m.facets} pts=${m.points} bytes=${m.bytes}`)

  const small = join(mDir, 'small.stl')
  const d = await call('cad_studio_mesh', { source: src, target: small, targetSize: 6 })
  ok('mesh: targetSize decimates instead of ignoring the budget', d.ok === true && (d.facets ?? 99) <= 12 && d.decimated === true, `facets=${d.facets} dec=${d.decimated}`)
}

// ---- 7z. sketches in documents, loft, sweep ------------------------------
{
  const rectSketch = (w, h) => ({
    geometry: [
      { id: 'g1', type: 'line', p1: [0, 0, 0], p2: [w, 0, 0] },
      { id: 'g2', type: 'line', p1: [w, 0, 0], p2: [w, h, 0] },
      { id: 'g3', type: 'line', p1: [w, h, 0], p2: [0, h, 0] },
      { id: 'g4', type: 'line', p1: [0, h, 0], p2: [0, 0, 0] },
    ],
    constraints: [
      { id: 'c1', type: 'coincident', a: 'g1', pa: 2, b: 'g2', pb: 1 },
      { id: 'c2', type: 'coincident', a: 'g2', pa: 2, b: 'g3', pb: 1 },
      { id: 'c3', type: 'coincident', a: 'g3', pa: 2, b: 'g4', pb: 1 },
      { id: 'c4', type: 'coincident', a: 'g4', pa: 2, b: 'g1', pb: 1 },
      { id: 'c5', type: 'horizontal', a: 'g1' }, { id: 'c6', type: 'vertical', a: 'g2' },
      { id: 'c7', type: 'horizontal', a: 'g3' }, { id: 'c8', type: 'vertical', a: 'g4' },
    ],
  })
  const skName = `harness_草图_${process.pid}`
  try { await call('cad_studio_doc', { action: 'delete', name: skName }) } catch {}
  const made = await call('cad_studio_doc', {
    action: 'create', name: skName, kind: 'features',
    sketches: { S1: rectSketch(80, 40) },
    features: [{ kind: 'extrude', sketch: 'S1', h: 10 }],
  })
  ok('document sketches: a stored sketch drives extrude', made.ok === true && near(made.volume ?? 0, 32000, 1), `ok=${made.ok} vol=${made.volume} err=${String(made.error ?? '').slice(0, 90)}`)

  const wider = await call('cad_studio_doc', { action: 'update', name: skName, sketches: { S1: rectSketch(120, 40) } })
  ok('document sketches: editing the sketch rebuilds the model', wider.ok === true && near(wider.volume ?? 0, 48000, 1), `ok=${wider.ok} vol=${wider.volume} err=${String(wider.error ?? '').slice(0, 90)}`)

  const lofted = await call('cad_studio_feature', {
    ops: [{ kind: 'loft', sections: [{ sketch: 'A' }, { sketch: 'B', at: [0, 0, 40] }] }],
    sketches: { A: rectSketch(20, 20), B: rectSketch(20, 20) },
  })
  ok('loft: two sections 40 mm apart give a prism', lofted.ok === true && near(lofted.volume ?? 0, 16000, 2), `ok=${lofted.ok} vol=${lofted.volume} err=${String(lofted.error ?? '').slice(0, 90)}`)

  const swept = await call('cad_studio_feature', {
    ops: [{ kind: 'sweep', sketch: 'A', path: [[0, 0, 0], [0, 0, 30], [0, 30, 30], [0, 30, 60]] }],
    sketches: { A: rectSketch(20, 20) },
  })
  // 400 mm2 profile along ~90 mm of path: corner rounding eats a few percent.
  ok('sweep: a sketch profile follows the path', swept.ok === true && (swept.volume ?? 0) > 30000 && (swept.volume ?? 0) < 36000, `ok=${swept.ok} vol=${swept.volume} err=${String(swept.error ?? '').slice(0, 90)}`)

  try { await call('cad_studio_doc', { action: 'delete', name: skName }) } catch {}
}

// ---- 7aa. equal / angle sketch constraints -------------------------------
{
  const pin = (id, pa, v) => ({ id, type: 'distance_x', a: 'g1', pa, value: v })
  const square = {
    geometry: [
      { id: 'g1', type: 'line', p1: [0, 0, 0], p2: [80, 0, 0] },
      { id: 'g2', type: 'line', p1: [80, 0, 0], p2: [80, 40, 0] },
      { id: 'g3', type: 'line', p1: [80, 40, 0], p2: [0, 40, 0] },
      { id: 'g4', type: 'line', p1: [0, 40, 0], p2: [0, 0, 0] },
    ],
    constraints: [
      { id: 'c1', type: 'coincident', a: 'g1', pa: 2, b: 'g2', pb: 1 },
      { id: 'c2', type: 'coincident', a: 'g2', pa: 2, b: 'g3', pb: 1 },
      { id: 'c3', type: 'coincident', a: 'g3', pa: 2, b: 'g4', pb: 1 },
      { id: 'c4', type: 'coincident', a: 'g4', pa: 2, b: 'g1', pb: 1 },
      { id: 'c5', type: 'horizontal', a: 'g1' }, { id: 'c6', type: 'vertical', a: 'g2' },
      { id: 'c7', type: 'horizontal', a: 'g3' }, { id: 'c8', type: 'vertical', a: 'g4' },
      // g1 is pinned to x=0..50; equal(g1,g2) then forces the height to 50 too.
      { id: 'c9', type: 'equal', a: 'g1', b: 'g2' },
      pin('c10', 1, 0), pin('c11', 2, 50),
    ],
  }
  const eq = await call('cad_studio_feature', { ops: [{ kind: 'extrude', sketch: 'E1', h: 10 }], sketches: { E1: square } })
  ok('sketch equal: equal(g1,g2) plus a pinned side gives 50x50x10', eq.ok === true && near(eq.volume ?? 0, 25000, 1), `ok=${eq.ok} vol=${eq.volume} err=${String(eq.error ?? '').slice(0, 90)}`)

  const tri = {
    geometry: [
      { id: 'g1', type: 'line', p1: [0, 0, 0], p2: [80, 0, 0] },
      { id: 'g2', type: 'line', p1: [80, 0, 0], p2: [40, 60, 0] },
      { id: 'g3', type: 'line', p1: [40, 60, 0], p2: [0, 0, 0] },
    ],
    constraints: [
      { id: 't1', type: 'coincident', a: 'g1', pa: 2, b: 'g2', pb: 1 },
      { id: 't2', type: 'coincident', a: 'g2', pa: 2, b: 'g3', pb: 1 },
      { id: 't3', type: 'coincident', a: 'g3', pa: 2, b: 'g1', pb: 1 },
      { id: 't4', type: 'horizontal', a: 'g1' },
      // 60 deg is documented in degrees; the emitter converts and then re-measures
      // the angle after solve, so a silent "solved but wrong" would fail here.
      { id: 't5', type: 'angle', a: 'g1', b: 'g2', value: 60 },
      pin('t6', 1, 0), pin('t7', 2, 80),
    ],
  }
  const ang = await call('cad_studio_feature', { ops: [{ kind: 'extrude', sketch: 'T1', h: 10 }], sketches: { T1: tri } })
  ok('sketch angle: 60 deg constraint solves and passes its own re-measure', ang.ok === true && (ang.volume ?? 0) > 0, `ok=${ang.ok} vol=${ang.volume} err=${String(ang.error ?? '').slice(0, 100)}`)
}

// ---- 8. teardown --------------------------------------------------------
for (const d of disposed.reverse()) { try { d() } catch (e) { console.log('  [dispose warn]', e.message) } }
ok('all tools unregistered on dispose', tools.size === 0, [...tools.keys()].join(','))

console.log(`\n${fail.length === 0 ? 'ALL PASS' : 'FAILURES'}  ${pass} passed, ${fail.length} failed`)
if (fail.length) { console.log('failed: ' + fail.join(' | ')); process.exit(1) }
