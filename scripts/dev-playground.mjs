// Dev fixture: a playground set that exercises every panel in one go.
//   node /workspace/cad-studio/scripts/dev-playground.mjs   (inside dsh-dev)
//
// It publishes three models so the tester has something real to click:
//   体验_特征    feature-list model  (edit a number, eye a step, add a step)
//   体验_参数化  script model driven by params (change P and rebuild)
//   体验_装配    STEP-reference assembly with a hinge and a slider
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
  const out = await def.execute(args, { agent: { session: { header: { cwd: '/workspace/cad-studio' } } } })
  if (out && out.ok === false) throw new Error(`${name}: ${out.error}`)
  return out
}

// Deleting a model that is not there is fine on a fresh container.
const soft = async (name, args) => { try { return await call(name, args) } catch { return null } }

const FEATURES = '体验_特征'
const PARAM = '体验_参数化'
const ASM = '体验_装配'
const parts = '/tmp/playground'
const report = {}

// ---------------------------------------------------------------- features ---
await soft('cad_studio_doc', { action: 'delete', name: FEATURES })
const feat = await call('cad_studio_doc', {
  action: 'create',
  kind: 'features',
  name: FEATURES,
  // Order matters on B-rep: chamfer the plain box first, then cut, then fillet
  // the outer edges the cuts produced.
  features: [
    { kind: 'box', label: '底板', size: [160, 100, 12] },
    { kind: 'chamfer', label: '倒角 1.4', d: 1.4 },
    { kind: 'cut', label: '大孔', with: { kind: 'cylinder', r: 26, h: 40, at: [50, 50, -6] } },
    { kind: 'cut', label: '小孔', with: { kind: 'cylinder', r: 11, h: 40, at: [124, 50, -6] } },
    { kind: 'fuse', label: '凸台', with: { kind: 'cylinder', r: 18, h: 16, at: [124, 50, 12] } },
  ],
})
report.features = { sceneId: feat.sceneId, volume: feat.volume, ids: (feat.features || []).map((f) => f.id) }

// ------------------------------------------------------------- parametric ---
await soft('cad_studio_doc', { action: 'delete', name: PARAM })
const script = [
  'w = float(P.get("w", 140))',
  'd = float(P.get("d", 90))',
  't = float(P.get("t", 10))',
  'hole = float(P.get("hole", 16))',
  'ribs = int(P.get("ribs", 3))',
  'base = Part.makeBox(w, d, t)',
  'for i in range(ribs):',
  '    x = w * (i + 1) / (ribs + 1)',
  '    base = base.cut(Part.makeCylinder(hole / 2.0, t * 3, Vector(x, d * 0.5, -t)))',
  'boss = Part.makeCylinder(d * 0.22, t * 1.6, Vector(w * 0.5, d * 0.5, t))',
  'shape = base.fuse(boss).removeSplitter()',
].join('\n')
const param = await call('cad_studio_doc', {
  action: 'create',
  name: PARAM,
  script,
  params: { w: 140, d: 90, t: 10, hole: 16, ribs: 3 },
})
report.parametric = { sceneId: param.sceneId, volume: param.volume, params: param.params }

// ---------------------------------------------------------------- assembly ---
// Three parts, exported as STEP so the assembly references files (real
// cross-document reference, not bodies copied into the same document).
const plateStep = `${parts}/底板.step`
const postStep = `${parts}/立柱.step`
const lidStep = `${parts}/盖板.step`
await call('cad_studio_feature', { title: '底板', export: plateStep, ops: [{ kind: 'box', size: [220, 130, 12] }] })
await call('cad_studio_feature', { title: '立柱', export: postStep, ops: [{ kind: 'box', size: [26, 26, 96] }] })
await call('cad_studio_feature', { title: '盖板', export: lidStep, ops: [{ kind: 'box', size: [220, 130, 9] }] })

const asm = await call('cad_studio_assembly', {
  title: ASM,
  assembly: ASM,
  parts: [
    { name: '底板', path: plateStep, color: [0.62, 0.66, 0.72] },
    { name: '立柱', path: postStep, color: [0.78, 0.55, 0.42] },
    { name: '盖板', path: lidStep, color: [0.55, 0.68, 0.62] },
  ],
  instances: [
    { name: '底板', part: '底板', at: [0, 0, 0] },
    { name: '立柱_A', part: '立柱', at: [24, 24, 12] },
    { name: '立柱_B', part: '立柱', at: [170, 24, 12] },
    { name: '盖板', part: '盖板', at: [0, 0, 108] },
  ],
  joints: [
    { id: 'hinge', instance: '盖板', type: 'revolute', axis: [1, 0, 0], origin: [0, 0, 108], value: 0, min: -80, max: 80 },
    { id: 'slide', instance: '立柱_B', type: 'linear', axis: [1, 0, 0], value: 0, min: -60, max: 40 },
  ],
})
report.assembly = { sceneId: asm.sceneId, assembly: asm.assembly, instances: asm.instances, joints: asm.joints, volume: asm.volume }

// One part STEP on disk as well, so "export" has something to write next to.
report.export = await call('cad_studio_export', { source: plateStep, target: `${parts}/底板_副本.step` })

console.log(JSON.stringify(report, null, 2))
