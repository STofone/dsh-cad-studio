#!/usr/bin/env node
/**
 * Trim a *test* instance's model list down to the 体验_* demo set.
 * Run inside the container: node scripts/dev-keep-demos.mjs [--dry]
 *
 * The list grows every time a probe script publishes a scene; the README
 * screenshots and a human poking at the plugin both want a short, meaningful
 * list instead of `harness_prune` / `post` / `switch-b`.
 */
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const KEEP = /^体验/
const dry = process.argv.includes('--dry')

const tools = new Map()
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  effect(fn) { const d = fn(); return d },
  tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name) } },
  webServer: { register() { return () => {} } },
  get() {},
}
const mod = await import(`${HERE}../index.js`)
mod.apply(ctx, {})
const call = (name, args) => tools.get(name).execute(args, {})

const before = await call('cad_studio_scene', { action: 'list' })
const rows = before.items ?? []
const drop = rows.filter((r) => !KEEP.test(String(r.title ?? '')))
console.log(`models=${rows.length} keep=${rows.length - drop.length} drop=${drop.length}`)
if (dry) { console.log(drop.map((r) => `${r.id} ${r.title}`).join('\n')); process.exit(0) }
let done = 0
for (const row of drop) {
  const out = await call('cad_studio_scene', { action: 'delete', id: row.id })
  if (out.ok !== false) done += 1
}
const after = await call('cad_studio_scene', { action: 'list' })
console.log(`deleted=${done} left=${after.models} →`, (after.items ?? []).map((r) => r.title).join(' | '))
