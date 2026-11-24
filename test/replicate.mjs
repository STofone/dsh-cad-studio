// Rebuild the exported dsh-cad models inside the cad-studio plugin (dev), then
// reopen each resulting STEP through the same open path the panel uses.
import { readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../index.js'

const ROOT = '/workspace/cad-studio/exports'

const tools = new Map()
const registered = []
const ctx = {
  logger: { info: () => {}, warn: (...a) => console.log('  [warn]', ...a) },
  effect(fn) { const d = fn(); if (typeof d === 'function') registered.push(d); return d },
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

const models = ['钢圈_138x38_丝3_开口5', '网篮_方丝_1mm_孔4_框3_228x76x80', '魔袋托架_150x62_高107', '多合一进水模块_150x62', '背滤鱼缸_800x400x400', '鱼缸总体']
const out = []
for (const model of models) {
  const dir = join(ROOT, model)
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
  const parts = manifest.parts.map((p) => ({ name: p.id, path: join(dir, 'parts', p.file) }))
  let instances = manifest.instances.map((i) => ({ name: i.name, part: i.part, at: i.at, rot: i.rot }))
  if (!instances.length) instances = [{ name: model, part: manifest.parts[0].id, at: [0, 0, 0] }]
  const target = join(ROOT, `${model}.step`)
  const t0 = Date.now()
  const built = await call('cad_studio_assembly', { parts, instances, target, title: model })
  const ms = Date.now() - t0
  let opened = null
  const bytes = existsSync(target) ? (await stat(target)).size : 0
  if (built.ok) opened = await call('cad_studio_open', { path: target })
  const expected = manifest.parts.reduce((sum, p) => sum + (p.volume ?? 0), 0) * 1
  out.push({
    model,
    parts: manifest.parts.length,
    instances: instances.length,
    ms,
    bytes,
    volume: opened?.volume ?? null,
    triangles: opened?.triangles ?? null,
    ok: Boolean(built.ok && opened?.ok),
    error: built.error ?? opened?.error ?? '',
  })
  console.log(JSON.stringify(out[out.length - 1]))
}
const bad = out.filter((m) => !m.ok)
console.log(JSON.stringify({ done: true, models: out.length, failed: bad.length }))
if (bad.length) process.exitCode = 1
