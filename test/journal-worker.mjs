/**
 * One half of the "restart" test: run this file in a fresh node process so the
 * in-memory journal is gone and only journal.json remains. Modes:
 *   seed <name>  create a feature document (writes journal.json)
 *   undo <name>  undo the newest journal entry (should remove the document)
 */
const tools = new Map()
const ctx = {
  effect(fn) { fn(); return () => {} },
  get() { return null },
  logger: { info() {}, warn() {}, error() {} },
  tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name) } },
  webServer: { register() { return () => {} } },
  on() { return () => {} },
}
const mod = await import('/workspace/cad-studio/index.js')
await mod.apply(ctx, {})
const call = (name, args) => tools.get(name).execute(args ?? {}, {})
const [mode, name] = process.argv.slice(2)
if (mode === 'seed') {
  const out = await call('cad_studio_doc', { action: 'create', name, kind: 'features', features: [{ kind: 'box', size: [12, 12, 12] }] })
  console.log(JSON.stringify({ mode, ok: out.ok, volume: out.volume }))
} else if (mode === 'undo') {
  const out = await call('cad_studio_undo', { scope: 'doc', model: name })
  console.log(JSON.stringify({ mode, ok: out.ok, undone: out.undone ?? null, error: out.error ?? '' }))
} else {
  console.log(JSON.stringify({ mode, ok: false, error: 'unknown mode' }))
}
