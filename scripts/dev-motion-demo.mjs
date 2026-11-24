// Builds a hinged-lid assembly inside the same container, using the plugin's
// own tools through a stub ctx (same trick as test/harness.mjs). The live dev
// process then serves it from disk — which also exercises loadAssembly().
import { mkdirSync } from 'node:fs'
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
const call = async (name, args) => {
  const def = tools.get(name)
  if (!def) throw new Error('no tool ' + name)
  return def.execute(args, { agent: { session: { header: { cwd: '/workspace' } } } })
}
mkdirSync('/tmp/motion-parts', { recursive: true })
const base = await call('cad_studio_feature', {
  title: '运动演示_底座',
  export: '/tmp/motion-parts/base.step',
  ops: [{ kind: 'box', size: [120, 80, 10], at: [0, 0, 0] }],
})
const lid = await call('cad_studio_feature', {
  title: '运动演示_盖板',
  export: '/tmp/motion-parts/lid.step',
  ops: [{ kind: 'box', size: [120, 80, 4], at: [0, 0, 40] }],
})
console.log('parts', base.volume, lid.volume)
const asm = await call('cad_studio_assembly', {
  title: '运动演示',
  parts: [
    { name: 'base', path: '/tmp/motion-parts/base.step' },
    { name: 'lid', path: '/tmp/motion-parts/lid.step' },
  ],
  instances: [
    { name: '底座', part: 'base', at: [0, 0, 0] },
    { name: '盖板', part: 'lid', at: [0, 0, 0] },
  ],
  joints: [{ id: 'hinge', instance: '盖板', type: 'revolute', axis: [1, 0, 0], origin: [0, 0, 40], min: -90, max: 90, value: 0 }],
})
console.log('assembly', JSON.stringify(asm))
