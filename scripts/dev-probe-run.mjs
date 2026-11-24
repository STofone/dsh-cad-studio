// Repro probe for two reports from the fish-tank session:
//   1. does one cad_studio_run execute the script twice?
//   2. does cad_studio_export report the source volume instead of the export?
import { apply } from '../index.js'
import { appendFileSync, writeFileSync, existsSync, statSync } from 'node:fs'

const tools = new Map()
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  effect: (fn) => fn(),
  tools: { register: (def) => { tools.set(def.name, def); return () => tools.delete(def.name) } },
  webServer: { register: () => () => {} },
  get: () => undefined,
}
apply(ctx, {})
const call = async (name, args) => {
  const def = tools.get(name)
  const out = await def.execute(args, { agent: { session: { header: { cwd: '/workspace/cad-studio' } } } })
  return out
}

const counter = '/tmp/probe-run-count.txt'
writeFileSync(counter, '')

// A run that stamps its execution count, then publishes a 20 mm cube.
const out1 = await call('cad_studio_run', {
  title: 'probe-run-count',
  code: `
import FreeCAD, Part
with open(${JSON.stringify(counter)}, 'a') as fh:
    fh.write('x\\n')
    fh.flush()
scene = Part.makeBox(20, 20, 20)
`,
})
const lines = existsSync(counter) ? (await import('node:fs')).readFileSync(counter, 'utf8').split('\n').filter(Boolean).length : -1

// Export a two-part source: does `volume` describe the source or the export?
await call('cad_studio_run', {
  title: 'probe-export-src',
  code: `
import FreeCAD, Part
a = Part.makeBox(40, 40, 10)
b = Part.makeCylinder(5, 30, FreeCAD.Vector(20, 20, 0))
__out = {'scene': {'parts': [], 'instances': []}, 'shapes': 'two'}
`,
}).catch(() => null)

const src = '/tmp/probe-src.step'
await call('cad_studio_export', {
  target: src,
  code: 'import Part\nscene = Part.makeCompound([Part.makeBox(40, 40, 10), Part.makeBox(10, 10, 10)])\n',
})
const exp = await call('cad_studio_export', {
  target: '/tmp/probe-out.step',
  source: src,
})
console.log(JSON.stringify({
  runExecutions: lines,
  runOut: { ok: out1 && out1.ok, volume: out1 && out1.volume, sceneId: out1 && out1.sceneId },
  exportFromFile: exp,
  outBytes: existsSync('/tmp/probe-out.step') ? statSync('/tmp/probe-out.step').size : -1,
}, null, 2))
