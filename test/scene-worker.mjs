#!/usr/bin/env node
// A second process that publishes one scene, used to prove persist() merges the
// history instead of overwriting it with the rows only this process knew.
import { apply } from '../index.js'

const label = process.argv[2] || 'worker'
const tools = new Map()
const ctx = {
  logger: { info() {}, warn() {} },
  effect(fn) { return fn() },
  tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name) } },
  webServer: { register() { return () => {} } },
  get() { return undefined },
}
apply(ctx, {})
const call = (name, args) => tools.get(name).execute(args ?? {}, undefined)

const out = await call('cad_studio_run', { code: 'import Part\nscene = Part.makeBox(10,10,10)', title: `worker ${label}` })
console.log(JSON.stringify({ ok: out.ok === true, sceneId: out.sceneId }))
