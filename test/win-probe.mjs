/**
 * Windows self-check: boots the plugin against a stub cordis context and prints
 * what it can see on THIS machine — which directories were searched, whether a
 * FreeCAD binary was found, and the doctor's verdict. The point is to run on a
 * real Windows box; on Linux/macOS it still shows the discovery paths.
 *
 *   node test/win-probe.mjs
 */
import { apply, __binSearch } from '../index.js'
import { tmpdir } from 'node:os'

const tools = new Map()
const ctx = {
  tools: { register(d) { tools.set(d.name, d); return () => tools.delete(d.name) }, get: (n) => tools.get(n) },
  effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
  logger: { info() {}, warn() {}, error() {} },
  webServer: { register() { return () => {} } },
  get() { return undefined },
}
apply(ctx, {})

const env = await tools.get('cad_studio_env').execute({})
const doctor = await tools.get('cad_studio_doctor').execute({})
console.log(JSON.stringify({
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  tmpdir: tmpdir(),
  binaryNames: __binSearch.BINARY_NAMES(),
  searchDirs: __binSearch.searchDirs(),
  pathMatches: __binSearch.pathDirs().filter((d) => /freecad|nodejs/i.test(d)),
  env,
  doctor,
}, null, 2))
