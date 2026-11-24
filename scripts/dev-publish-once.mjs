// Publishes one scene from a separate process — used to prove that the model
// tab does not follow new modelling activity while the live tab does.
const mod = await import('/workspace/cad-studio/index.js')
const tools = new Map()
const ctx = {
  logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  effect(fn) { const d = fn(); return () => { try { d && d() } catch {} } },
  on() { return () => {} },
  get() { return undefined },
  tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name) } },
  webServer: { register() { return () => {} } },
  inject() {},
}
await mod.apply(ctx, {})
// A distinct size per call so the panel shows an obviously different model.
const size = process.argv[2] || String(60 + (Date.now() % 30))
const res = await tools.get('cad_studio_run').execute({
  title: `活动新增_${size}_${String(Date.now()).slice(-5)}`,
  code: `import Part\nscene = Part.makeBox(${size}, ${size}, ${size})`,
}, { agent: { session: { id: 'external-publisher' } } })
console.log(JSON.stringify(res))
