/**
 * Minimal end-to-end harness for dsh-cad-studio.
 * Stubs the cordis context, then exercises every public surface:
 * tools (env/run/open), persistence, and the three HTTP routes.
 * Run inside the container that has freecadcmd:
 *   node /workspace/cad-studio/test/harness.mjs
 */
import { writeFile } from 'node:fs/promises'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
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

  const listed = await call('cad_studio_features', { model, action: 'list' })
  ok('feature list action', listed.ok === true && listed.features.length === 3 && listed.kind === 'features', String(listed.features?.length))

  // A bad edit must leave the document exactly as it was.
  const broken = await call('cad_studio_features', { model, action: 'update', feature: { id: 'f2', params: { with: { kind: 'cylinder', r: 500, h: 30, at: [30, 20, -5] } } } })
  ok('bad feature edit is rejected or rolled back', broken.ok === false || broken.reverted === true, JSON.stringify({ ok: broken.ok, reverted: broken.reverted }))
  const shown = await call('cad_studio_doc', { action: 'show', name: model })
  ok('feature doc survives a bad edit', shown.ok === true && shown.features.length === 3, String(shown.features?.length))

  const removedFeature = await call('cad_studio_features', { model, action: 'remove', id: 'f3' })
  ok('feature remove', removedFeature.ok === true && removedFeature.features.length === 2, String(removedFeature.features?.length))

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
  const listed = await call('cad_studio_joint', { action: 'list', assembly: asm.assembly })
  ok('joint list reports the hinge', listed.ok === true && listed.joints?.[0]?.id === 'hinge', JSON.stringify(listed.joints))
  const before = JSON.parse((await hit(`/cad-studio/scene/${asm.sceneId}`)).body)
  const armBefore = before.instances.find((i) => i.name === 'arm')
  const driven = await call('cad_studio_drive', { assembly: asm.assembly, joint: 'hinge', value: 90 })
  ok('drive publishes a new scene', driven.ok === true && driven.sceneId !== asm.sceneId, JSON.stringify({ ok: driven.ok, id: driven.sceneId, err: driven.error }))
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

// ---- 8. teardown --------------------------------------------------------
for (const d of disposed.reverse()) { try { d() } catch (e) { console.log('  [dispose warn]', e.message) } }
ok('all tools unregistered on dispose', tools.size === 0, [...tools.keys()].join(','))

console.log(`\n${fail.length === 0 ? 'ALL PASS' : 'FAILURES'}  ${pass} passed, ${fail.length} failed`)
if (fail.length) { console.log('failed: ' + fail.join(' | ')); process.exit(1) }
