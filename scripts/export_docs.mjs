// Replay dsh-cad documents into per-body STEP files + a manifest, so the same
// models can be rebuilt and inspected by cad-studio (on any machine).
import { Worker } from 'node:worker_threads'
import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const WORKER = '/root/.dsh/profiles/web/node_modules/dsh-cad/lib/modeling/modeling-worker.cjs'
const DOCS = '/app/.dsh-cad/docs'
const OUT = '/workspace/cad-studio/exports'

const MODELS = [
  ['28ca99be-5ef8-49cb-bb18-95c88546dace', '钢圈_138x38_丝3_开口5'],
  ['88f215a3-abc5-4571-adbb-660c757061b9', '网篮_方丝_1mm_孔4_框3_228x76x80'],
  ['dc830663-7ba5-45c3-a185-7af672f58ac6', '魔袋托架_150x62_高107'],
  ['2b5f0f8d-d8c4-4d5d-aeee-12bb15a83cbe', '多合一进水模块_150x62'],
  ['83dfda5e-7112-4c27-af55-3d5b99c16ddd', '背滤鱼缸_800x400x400'],
  ['c7e1322c-0135-4818-97e2-88578d02df0b', '鱼缸总体'],
]

class Session {
  constructor() {
    this.worker = new Worker(WORKER)
    this.seq = 0
    this.pending = new Map()
    this.worker.on('message', (msg) => {
      const p = this.pending.get(msg.jobId)
      if (!p) return
      this.pending.delete(msg.jobId)
      if (msg.ok) p.resolve(msg.result)
      else p.reject(new Error(msg.error))
    })
  }
  run(op) {
    const jobId = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(jobId, { resolve, reject })
      this.worker.postMessage({ jobId, op })
    })
  }
  close() { this.worker.terminate() }
}

const SKIP = new Set(['export', 'export_assembly', 'drawing', 'volume'])

async function exportModel(session, docId, name) {
  const file = join(DOCS, `${docId}.json`)
  const doc = JSON.parse(await readFile(file, 'utf8'))
  await session.run({ kind: 'reset' })
  let replayed = 0
  const failures = []
  for (const [i, op] of doc.ops.entries()) {
    if (SKIP.has(op.kind)) continue
    try {
      await session.run(op)
      replayed++
    } catch (err) {
      failures.push({ i, kind: op.kind, error: String(err.message).slice(0, 120) })
    }
  }
  const meshes = await session.run({ kind: 'tessellate_all' })
  const bodies = (meshes.meshes ?? []).filter((m) => m.bodyId)
  const asm = await session.run({ kind: 'assembly_list' })
  const instances = asm.instances ?? []

  // Bodies that came from import_step have no in-worker shape: their geometry
  // is the referenced STEP asset, which we copy into the part set verbatim.
  for (const op of doc.ops) {
    if (op.kind !== 'import_step' || !op.path) continue
    for (const raw of op.bodies ?? []) {
      const bodyId = typeof raw === 'string' ? raw : (raw?.bodyId ?? raw?.id)
      if (!bodyId || typeof bodyId !== 'string') continue
      if (!existsSync(op.path)) continue
      bodies.push({ bodyId, name: `${bodyId}-import_step`, indices: [] })
      // remember the asset so the export loop copies instead of re-exporting
      ;(bodies[bodies.length - 1]).assetPath = op.path
    }
  }

  const dir = join(OUT, name)
  const partsDir = join(dir, 'parts')
  await mkdir(partsDir, { recursive: true })
  const parts = []
  for (const body of bodies) {
    if (body.assetPath) {
      const label = `${body.bodyId}-import_step.step`
      const target = join(partsDir, label)
      await copyFile(body.assetPath, target)
      parts.push({ id: body.bodyId, name: body.name, file: label, volume: null, triangles: null })
      continue
    }
    const ops = doc.ops.filter((o) => o.bodyId === body.bodyId)
    const label = ops.length ? `${body.bodyId}-${ops[0].kind}` : body.bodyId
    const target = join(partsDir, `${label}.step`)
    try {
      const out = await session.run({ kind: 'export', target: body.bodyId, format: 'step' })
      await writeFile(target, Buffer.from(out.bytes))
      const vol = await session.run({ kind: 'volume', target: body.bodyId }).catch(() => ({ volume: null }))
      parts.push({ id: body.bodyId, name: body.name ?? body.bodyId, file: `${label}.step`, volume: vol.volume, triangles: Math.floor((body.indices?.length ?? 0) / 3) })
    } catch (err) {
      failures.push({ body: body.bodyId, error: String(err.message).slice(0, 120) })
    }
  }
  const manifest = {
    model: name,
    docId,
    version: doc.version,
    ops: doc.ops.length,
    replayed,
    parts,
    instances: instances.map((i) => ({ name: i.name, part: i.bodyId, at: i.translate, rot: i.rotate })),
    failures,
  }
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  session.close()
  return {
    model: name,
    ops: doc.ops.length,
    parts: parts.length,
    instances: instances.length,
    bytes: parts.reduce((sum, p) => sum + (existsSync(join(partsDir, p.file)) ? 1 : 0), 0),
    failures: failures.length,
  }
}

const started = Date.now()
const only = process.argv[2]
const results = []
for (const [docId, name] of MODELS) {
  if (only && !name.includes(only)) continue
  const t0 = Date.now()
  try {
    const summary = await exportModel(new Session(), docId, name)
    summary.ms = Date.now() - t0
    results.push(summary)
    console.log(JSON.stringify(summary))
  } catch (err) {
    results.push({ model: name, error: String(err.message).slice(0, 200) })
    console.log(JSON.stringify({ model: name, error: String(err.message).slice(0, 200) }))
  }
}
console.log(JSON.stringify({ done: true, totalMs: Date.now() - started, models: results.length }))
