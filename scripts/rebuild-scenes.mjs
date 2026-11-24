// Re-publish the exported models into this process's scene store.
//
// The scene store lives in the OS temp dir (`<tmp>/dsh-cad-studio`), so it can
// be lost while the models themselves (exports/, cad-models/) survive. This
// script rebuilds one row per model from the exported STEP parts: no `open`
// call, so each model gets a single entry in the panel's models list.
//
//   node scripts/rebuild-scenes.mjs [模型名 ...]
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { apply } from '../index.js'

const ROOT = '/workspace/cad-studio/exports'
const ALL = [
  '钢圈_138x38_丝3_开口5',
  '网篮_方丝_1mm_孔4_框3_228x76x80',
  '魔袋托架_150x62_高107',
  '多合一进水模块_150x62',
  '背滤鱼缸_800x400x400',
  '鱼缸总体',
]

const tools = new Map()
const registered = []
const ctx = {
  logger: { info: () => {}, warn: (...a) => console.warn('  [warn]', ...a) },
  effect(fn) {
    const d = fn()
    if (typeof d === 'function') registered.push(d)
    return d
  },
  tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name) } },
  webServer: { register: () => () => {} },
  get: () => undefined,
}
apply(ctx, {})

const call = async (name, args) => {
  const def = tools.get(name)
  if (!def) throw new Error(`tool not registered: ${name}`)
  return await def.execute(args ?? {})
}

const wanted = process.argv.slice(2)
const models = wanted.length ? wanted : ALL
const out = []
for (const model of models) {
  const dir = join(ROOT, model)
  let manifest
  try {
    manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
  } catch (error) {
    out.push({ model, ok: false, error: `no manifest: ${String(error?.message ?? error)}` })
    console.log(JSON.stringify(out[out.length - 1]))
    continue
  }
  const parts = manifest.parts.map((p) => ({ name: p.id, path: join(dir, 'parts', p.file) }))
  let instances = manifest.instances.map((i) => ({ name: i.name, part: i.part, at: i.at, rot: i.rot }))
  if (!instances.length) instances = [{ name: model, part: manifest.parts[0].id, at: [0, 0, 0] }]
  const t0 = Date.now()
  const built = await call('cad_studio_assembly', { parts, instances, title: model, assembly: model })
  const row = {
    model,
    ok: Boolean(built.ok),
    ms: Date.now() - t0,
    assembly: built.assembly ?? '',
    sceneId: built.sceneId ?? '',
    volume: built.published ? Number(built.volume ?? 0) : null,
    error: built.error ?? '',
  }
  out.push(row)
  console.log(JSON.stringify(row))
}
const bad = out.filter((m) => !m.ok)
console.log(JSON.stringify({ done: true, models: out.length, failed: bad.length }))
if (bad.length) process.exitCode = 1
