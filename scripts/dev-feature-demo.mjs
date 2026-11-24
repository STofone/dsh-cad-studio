// Dev fixture: a feature-list model the panel can edit. Run inside the dev
// container:  node /workspace/cad-studio/scripts/dev-feature-demo.mjs
// It boots the plugin the same way the host does (stub cordis ctx) and drives
// the tools directly — no browser needed to publish the first scene.
import { apply } from '../index.js'

const tools = new Map()
const disposers = []
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  effect: (fn) => { const d = fn(); disposers.push(d) },
  tools: { register: (def) => { tools.set(def.name, def); return () => tools.delete(def.name) } },
  webServer: { register: () => () => {} },
  get: () => undefined,
}
apply(ctx, {})
const call = async (name, args) => {
  const def = tools.get(name)
  if (!def) throw new Error(`no tool ${name}`)
  return def.execute(args, { agent: { session: { header: { cwd: '/workspace/cad-studio' } } } })
}

const model = '特征演示'
await call('cad_studio_doc', { action: 'delete', name: model })
const made = await call('cad_studio_doc', {
  action: 'create',
  kind: 'features',
  name: model,
  features: [
    { kind: 'box', label: '底板', size: [80, 50, 12] },
    { kind: 'cut', label: '通孔', with: { kind: 'cylinder', r: 9, h: 40, at: [40, 25, -5] } },
    { kind: 'fillet', label: '圆角', r: 2 },
  ],
})
console.log(JSON.stringify({ ok: made.ok, error: made.error, sceneId: made.sceneId, volume: made.volume, features: made.features && made.features.map((f) => f.id) }, null, 2))
