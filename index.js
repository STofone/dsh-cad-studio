/**
 * dsh-cad-studio — Host half.
 *
 * Two jobs:
 *   1. Bridge FreeCAD to the agent: `freecadcmd` runs inside one long-lived
 *      helper process, so a script does not pay the 60-135 ms startup each call
 *      and can keep documents alive between calls.
 *   2. Publish what it built: every successful build stores a `scene` payload
 *      (parts + instances) that the panel fetches and renders.
 *
 * Routes (all under /cad-studio, loopback-only):
 *   GET /cad-studio/state        runtime + latest published scene summary
 *   GET /cad-studio/scene/:id    the scene payload itself
 *   GET /cad-studio/client.js    the panel bundle (dev-mode serving)
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs'
import crypto from 'node:crypto'
import { mkdtemp, mkdir, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const name = 'dsh-cad-studio'

// Import marker: tells us whether a hot reload really re-evaluated this module.
globalThis.__cadStudioImportMark = (globalThis.__cadStudioImportMark ?? 0) + 1

export const inject = ['tools', 'webServer']

/** Defaults; the row's config object overrides them field by field. */
const DEFAULTS = {
  freecadPath: '',
  timeoutMs: 180000,
  trustedHosts: [],
  /** Where parametric model documents live; '' = the calling session's workspace. */
  modelsDir: '',
  /**
   * When the panel may place its tab in the right sidebar on its own:
   * 'session' = only for sessions that already published a scene (default),
   * 'always' = every session, 'off' = never (the tab stays in the "+" menu).
   */
  autoOpen: 'session',
}

/** Resolve the effective config without depending on a schema library. */
function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  return {
    freecadPath: typeof source.freecadPath === 'string' ? source.freecadPath : DEFAULTS.freecadPath,
    timeoutMs: Number.isFinite(source.timeoutMs) ? Math.max(5000, Number(source.timeoutMs)) : DEFAULTS.timeoutMs,
    trustedHosts: Array.isArray(source.trustedHosts) ? source.trustedHosts.filter((v) => typeof v === 'string') : DEFAULTS.trustedHosts,
    modelsDir: typeof source.modelsDir === 'string' ? source.modelsDir : DEFAULTS.modelsDir,
    autoOpen: ['session', 'always', 'off'].includes(source.autoOpen) ? source.autoOpen : DEFAULTS.autoOpen,
  }
}

const ROUTE_PREFIX = '/cad-studio'
/** Package root, so the panel can load the vendored three.js assets. */
const PLUGIN_DIR = fileURLToPath(new URL('.', import.meta.url))
const ASSET_NAME = /^[A-Za-z0-9._-]+\.js$/

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

function isTrusted(req, extra) {
  const host = String(req.headers.host ?? '').toLowerCase()
  const bare = host.replace(/:\d+$/, '')
  if (LOOPBACK.has(bare)) return true
  return extra.includes(host) || extra.includes(bare)
}

/** FreeCAD version string, or '' when the binary cannot be asked. */
function freecadVersion(bin) {
  if (!bin) return ''
  const res = spawnSync(bin, ['-c', "import FreeCAD; print('.'.join(str(v) for v in FreeCAD.Version()[:3]))"], { encoding: 'utf8', timeout: 30000 })
  const out = (res.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean).pop() || ''
  return /^\d+\.\d+/.test(out) ? out : ''
}

/** Package managers we know how to drive; the first present one wins. */
const PACKAGERS = [
  { id: 'apt', probe: '/usr/bin/apt-get', cmd: 'apt-get', args: ['install', '-y', '--no-install-recommends', 'freecad'], update: ['update'], hint: 'apt install freecad' },
  { id: 'dnf', probe: '/usr/bin/dnf', cmd: 'dnf', args: ['install', '-y', 'freecad'], update: null, hint: 'dnf install freecad' },
  { id: 'pacman', probe: '/usr/bin/pacman', cmd: 'pacman', args: ['-S', '--noconfirm', 'freecad'], update: null, hint: 'pacman -S freecad' },
  { id: 'brew', probe: '/opt/homebrew/bin/brew', cmd: 'brew', args: ['install', '--cask', 'freecad'], update: null, hint: 'brew install --cask freecad' },
]

function findPackager() {
  return PACKAGERS.find((p) => existsSync(p.probe))
}

/** Everything the panel and the tool need to answer "can I just install it?". */
function setupStatus(bridge, { withVersion = true } = {}) {
  // withVersion=false is for the 1.5 s state poll: asking freecadcmd for its
  // version costs a process spawn, and the answer only changes on install.
  const bin = bridge.refresh()
  const packager = findPackager()
  const canInstall = Boolean(packager) && (packager.id !== 'apt' || (typeof process.getuid === 'function' && process.getuid() === 0))
  return {
    available: Boolean(bin),
    binary: bin ?? '',
    version: withVersion ? freecadVersion(bin) : '',
    packageManager: packager ? packager.id : '',
    command: packager ? packager.hint : '',
    canInstall,
    reason: bin ? '' : (packager
      ? (canInstall ? '' : '当前进程不是 root，无法自动装包；用 root 执行上面的命令或设置 freecadPath')
      : '没找到包管理器（apt/dnf/pacman/brew 都没有）；手动安装 FreeCAD 后设置 freecadPath'),
  }
}

/** Install FreeCAD through the detected packager; returns a plain outcome. */
/**
 * "Install and it works" is the product promise; this is the function that
 * tells the truth about whether we can keep it. Every check says what is wrong
 * AND what to do about it, so the panel never shows a dead end.
 */
function diagnose(bridge, cfg = {}) {
  const kernel = setupStatus(bridge, { withVersion: true })
  const dir = FreeCadBridge.dataDir
  const checks = []
  checks.push({
    id: 'kernel',
    label: '几何内核（FreeCAD / OCCT）',
    required: true,
    ok: kernel.available === true,
    detail: kernel.available ? [kernel.binary, kernel.version].filter(Boolean).join(' · ') : '没有找到 freecadcmd',
    fix: kernel.available ? '' : (kernel.canInstall
      ? '点「安装 FreeCAD」自动装（需要 root），或手动执行：' + (kernel.command || 'apt install freecad')
      : (kernel.reason || '请手动安装 FreeCAD，再把 freecadPath 指到 freecadcmd')),
    action: kernel.available ? '' : (kernel.canInstall ? 'install' : ''),
    packageManager: kernel.packageManager || '',
  })
  let writable = false
  try {
    mkdirSync(dir, { recursive: true })
    const probe = join(dir, '.write-probe')
    writeFileSync(probe, '1')
    rmSync(probe, { force: true })
    writable = true
  } catch {}
  checks.push({
    id: 'datadir',
    label: '数据目录（场景与缓存）',
    required: true,
    ok: writable,
    detail: writable ? dir : `${dir}（不可写）`,
    fix: writable ? '' : '把这个目录改成可写，或用环境变量 TMPDIR 指到可写位置',
  })
  let freeMB = null
  try { const st = statfsSync(dir); freeMB = Math.round((st.bavail * st.bsize) / 1048576) } catch {}
  checks.push({
    id: 'disk',
    label: '可用磁盘',
    required: false,
    ok: freeMB === null || freeMB > 500,
    detail: freeMB === null ? '无法读取' : `${freeMB} MB`,
    fix: freeMB !== null && freeMB <= 500 ? '剩余空间不足 500 MB，重建大模型可能失败' : '',
  })
  const modelsDir = cfg.modelsDir || ''
  checks.push({
    id: 'models',
    label: '模型目录',
    required: false,
    ok: true,
    detail: modelsDir || '跟随会话工作区（<cwd>/cad-models）',
    fix: '',
  })
  const ready = checks.filter((c) => c.required).every((c) => c.ok)
  return {
    ready,
    kernel,
    checks,
    // What the plugin can actually do right now. The panel greys out the rest
    // instead of letting a click fail deep inside a spawn.
    capabilities: {
      modeling: ready,
      assembly: ready,
      drawing: ready,
      measure: ready,
      export: ready,
      incremental: ready,
    },
  }
}

const defined = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined))
const renderUndo = (v) => {
  if (!v || v.ok === false) return `✗ ${v?.error ?? '没有可撤销的操作'}`
  if (v.scope === 'assembly') {
    const head = v.undone !== undefined ? `↶ 撤销了装配改动（${v.undone}）` : `↷ 重做了装配改动（${v.redone}）`
    return `${head}，还可撤销 ${v.remaining ?? 0} 步 / 可重做 ${v.redo ?? v.undo ?? 0} 步`
  }
  return `${v.undone !== undefined ? '↶ 撤销' : '↷ 重做'}：文档 ${v.model}${v.evaluated === false ? '（求值失败，见 graph）' : ''}`
}

const renderDoctor = (v) => {
  const lines = [`ready: ${v.ready ? 'yes' : 'no'}`]
  if (v.kernel) lines.push(`kernel: ${v.kernel}`)
  for (const c of v.checks || []) lines.push(`- ${c}`)
  const caps = Object.entries(v.capabilities || {}).map(([k, ok]) => `${k}=${ok ? 'yes' : 'no'}`).join(' ')
  if (caps) lines.push(`capabilities: ${caps}`)
  return lines.join('\n')
}

function installFreeCad(bridge, { timeoutMs = 900000 } = {}) {
  const before = setupStatus(bridge)
  if (before.available) return { ok: true, alreadyInstalled: true, ...before, log: '' }
  const packager = findPackager()
  if (!packager) return { ok: false, ...before, log: '' }
  if (packager.id === 'apt' && typeof process.getuid === 'function' && process.getuid() !== 0) {
    return { ok: false, ...before, log: '' }
  }
  const chunks = []
  const run = (args) => {
    const res = spawnSync(packager.cmd, args, { encoding: 'utf8', timeout: timeoutMs })
    chunks.push(`$ ${packager.cmd} ${args.join(' ')}\n${res.stdout || ''}${res.stderr || ''}`)
    return res
  }
  if (packager.update) run(packager.update)
  const res = run(packager.args)
  const after = setupStatus(bridge)
  return { ok: after.available, ...after, log: chunks.join('\n').slice(-4000) }
}

const CANDIDATES = [
  '/usr/bin/freecadcmd',
  '/usr/local/bin/freecadcmd',
  '/usr/bin/FreeCADCmd',
  '/opt/freecad/bin/freecadcmd',
  '/Applications/FreeCAD.app/Contents/MacOS/FreeCADCmd',
]

function probeBinary(configured) {
  if (configured) return existsSync(configured) ? configured : undefined
  return CANDIDATES.find((p) => existsSync(p))
}

/** JSON markers; the helper prints exactly one RESULT block per script. */
const BEGIN = '###CAD_STUDIO_RESULT###'
const END = '###CAD_STUDIO_END###'

/** File types FreeCAD's Part.read understands (extension decides the importer). */
const SUPPORTED_FILE_EXTS = ['step', 'stp', 'iges', 'igs', 'brep', 'stl']

const SUPPORTED_HINT = `支持的格式：${SUPPORTED_FILE_EXTS.map((e) => `.${e}`).join(' / ')}`

/**
 * freecadcmd wraps any Python exception as
 *   Exception while processing file: /tmp/.../job.py [<exception message>]
 * The bracket is the only part a caller can act on; the script path is noise.
 */
function freecadException(text) {
  const m = /Exception while processing file: .*? \[([\s\S]*?)\]\s*$/m.exec(text)
  return m ? m[1].trim() : null
}

function hintForException(message) {
  if (!message) return undefined
  if (/Unknown extension/i.test(message)) {
    return `FreeCAD 不认识这个文件的扩展名，只支持 ${SUPPORTED_FILE_EXTS.map((e) => `.${e}`).join(' / ')}（.FCStd / .3mf / .obj 它都读不了）`
  }
  if (/not existing or not readable|does not exist|No such file/i.test(message)) {
    return '文件不存在或不可读：确认路径是容器内可访问的绝对路径。'
  }
  if (/no supported file format/i.test(message)) {
    return `Import 无法识别该文件格式，确认是 ${SUPPORTED_FILE_EXTS.map((e) => `.${e}`).join(' / ')} 之一。`
  }
  return undefined
}

/**
 * Rigid-body helpers for joints. Scene instances carry a row-major 3×3 matrix
 * (local→world, columns = the instance's axes) plus a translation; a joint is a
 * rotation about (axis, origin) or a translation along axis, applied on top.
 */
const round6 = (v) => {
  const r = Math.round(v * 1e6) / 1e6
  return Object.is(r, -0) ? 0 : r
}
const addVec = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const subVec = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const scaleVec = (a, k) => [a[0] * k, a[1] * k, a[2] * k]
const dotVec = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const normVec = (a) => {
  const len = Math.hypot(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0)
  return len > 1e-9 ? [a[0] / len, a[1] / len, a[2] / len] : [0, 0, 1]
}
/** Row-major 3×3 product. */
const mulMat = (a, b) => {
  const out = new Array(9).fill(0)
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]
    }
  }
  return out
}
const mulVec = (m, v) => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
]
/** Rodrigues rotation matrix (row-major) about a unit axis, degrees. */
function axisAngle(axis, deg) {
  const [x, y, z] = normVec(axis)
  const t = (deg * Math.PI) / 180
  const c = Math.cos(t)
  const s = Math.sin(t)
  const k = 1 - c
  return [
    c + x * x * k, x * y * k - z * s, x * z * k + y * s,
    y * x * k + z * s, c + y * y * k, y * z * k - x * s,
    z * x * k - y * s, z * y * k + x * s, c + z * z * k,
  ]
}

/** Local-space bounding box of a part's tessellation (8 corners is enough). */
function partLocalBox(parts, partId) {
  const part = (parts || []).find((p) => p.id === partId)
  const verts = part?.verts
  if (!verts?.length) return null
  const mn = [Infinity, Infinity, Infinity]
  const mx = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i + 2 < verts.length; i += 3) {
    for (let k = 0; k < 3; k += 1) {
      const c = verts[i + k]
      if (c < mn[k]) mn[k] = c
      if (c > mx[k]) mx[k] = c
    }
  }
  return { mn, mx }
}

/** World-space centre of one instance (used as the explode direction). */
function instanceCenter(parts, inst) {
  const box = partLocalBox(parts, inst.part)
  if (!box) return inst.translate.slice()
  const mn = [Infinity, Infinity, Infinity]
  const mx = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < 8; i += 1) {
    const p = [
      i & 1 ? box.mx[0] : box.mn[0],
      i & 2 ? box.mx[1] : box.mn[1],
      i & 4 ? box.mx[2] : box.mn[2],
    ]
    const w = addVec(mulVec(inst.rot, p), inst.translate)
    for (let k = 0; k < 3; k += 1) {
      if (w[k] < mn[k]) mn[k] = w[k]
      if (w[k] > mx[k]) mx[k] = w[k]
    }
  }
  return scaleVec(addVec(mn, mx), 0.5)
}

function bboxCenterOfInstances(parts, instances) {
  const centers = instances.map((inst) => instanceCenter(parts, inst))
  if (!centers.length) return [0, 0, 0]
  const sum = centers.reduce((acc, c) => addVec(acc, c), [0, 0, 0])
  return scaleVec(sum, 1 / centers.length)
}

/** Normalise one joint spec against the assembly it belongs to. */
function normalizeJoint(record, spec) {
  const inst = record.base.find((b) => b.name === spec.instance)
  if (!inst) throw new Error(`装配里没有这个实例：${spec.instance}`)
  // Five declared joint kinds, all driven along their single declared axis.
  // This is deliberately not a constraint solver: a joint states which DOF the
  // AI/user may drive, and the panel exposes exactly that one number.
  //   revolute   rotate about axis          linear      slide along axis
  //   cylindrical rotate about axis   planar  slide in the plane
  //   ball       rotate about axis (free direction, single driven angle)
  const JOINTS = ['revolute', 'linear', 'cylindrical', 'planar', 'ball']
  const type = JOINTS.includes(spec.type) ? spec.type : 'revolute'
  const slidey = type === 'linear' || type === 'planar'
  const fallbackAxis = slidey ? [1, 0, 0] : [0, 0, 1]
  const axis = normVec(Array.isArray(spec.axis) && spec.axis.length === 3 ? spec.axis : fallbackAxis)
  // Rotating about the instance's own centre is the useful default (a spinning
  // wheel); a hinge passes an explicit origin on the edge.
  const origin = Array.isArray(spec.origin) && spec.origin.length === 3 ? spec.origin.map(Number) : inst.center.slice()
  const min = Number.isFinite(spec.min) ? Number(spec.min) : slidey ? -1000 : -180
  const max = Number.isFinite(spec.max) ? Number(spec.max) : slidey ? 1000 : 180
  const value = Math.min(max, Math.max(min, Number.isFinite(spec.value) ? Number(spec.value) : 0))
  // A cylindrical joint has two DOF but we drive one number; the other is a
  // fixed second parameter so the geometry stays deterministic.

  const id = typeof spec.id === 'string' && spec.id.trim() ? spec.id.trim() : `${type}-${record.joints.length + 1}`
  return { id, instance: spec.instance, type, axis, origin, min, max, value }
}

/**
 * Variables and expressions (DESIGN §7 Phase 4).
 *
 * Dimensions are allowed to be expressions over the document's `vars`, e.g.
 * `"w*2 + 10"`. They are evaluated here, in JS, with a 60-line shunting-yard —
 * deliberately NOT by handing the string to FreeCAD or to `eval`: a model file
 * that arrives from someone else must not be able to execute anything.
 */
/** `vars` is a flat bag of named dimensions; anything else is ignored. */
function normalizeVars(raw, base = {}) {
  const out = { ...base }
  if (raw === null) return {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw)) {
    if (!/^[A-Za-z_]\w{0,40}$/.test(k)) continue
    if (v === null) { delete out[k]; continue }
    if (Number.isFinite(Number(v))) out[k] = Number(v)
  }
  return out
}

const EXPR_OK = /^[0-9A-Za-z_+\-*/(). \t]*$/

function evalExpression(src, vars) {
  const text = String(src).trim()
  if (!EXPR_OK.test(text)) throw new Error(`表达式里有不支持的字符：${text}`)
  const tokens = text.match(/\d+\.?\d*|[A-Za-z_]\w*|[+\-*/()]/g) || []
  const out = []
  const ops = []
  const prec = { '+': 1, '-': 1, '*': 2, '/': 2 }
  const apply = (op) => {
    const b = out.pop()
    const a = out.pop()
    if (a === undefined || b === undefined) throw new Error(`表达式不完整：${text}`)
    out.push(op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : a / b)
  }
  let prev = ''
  for (const tk of tokens) {
    if (tk === '-' && (prev === '' || prev === '(' || prec[prev])) {
      // Unary minus: "−t" is 0 − t, not a syntax error.
      out.push(0)
      ops.push('-')
      prev = '-'
      continue
    }
    if (/^\d/.test(tk)) out.push(Number(tk))
    else if (/^[A-Za-z_]/.test(tk)) {
      const v = vars?.[tk]
      if (!Number.isFinite(v)) throw new Error(`表达式里的变量没有定义或不是数字：${tk}`)
      out.push(Number(v))
    } else if (tk === '(') ops.push(tk)
    else if (tk === ')') {
      while (ops.length && ops[ops.length - 1] !== '(') apply(ops.pop())
      if (ops.pop() !== '(') throw new Error(`括号不配对：${text}`)
      prev = tk
    } else {
      while (ops.length && prec[ops[ops.length - 1]] >= prec[tk]) apply(ops.pop())
      ops.push(tk)
    }
  }
  while (ops.length) {
    const op = ops.pop()
    if (op === '(') throw new Error(`括号不配对：${text}`)
    apply(op)
  }
  if (out.length !== 1 || !Number.isFinite(out[0])) throw new Error(`表达式算不出数值：${text}`)
  return out[0]
}

// Keys whose strings are vocabulary, not arithmetic: a `kind: "cylinder"` or a
// selector's `axis: "Z"` must never be mistaken for an expression.
const EXPR_SKIP_KEYS = new Set(['kind', 'type', 'axis', 'mode', 'dir', 'pick', 'label', 'name', 'ref'])

/** Deep-walk feature params and resolve any expression string. */
function resolveParams(value, vars, where) {
  if (typeof value === 'string') {
    // A string is an expression only when it is plain arithmetic AND every
    // identifier in it is a declared var. Selectors ("Z", "aligned", "+") and
    // enums therefore pass through untouched.
    const text = value.trim()
    if (!text || !/^[\w.\s+\-*/()]+$/.test(text)) return value
    const ids = text.match(/[A-Za-z_]\w*/g) || []
    const known = ids.filter((id) => Number.isFinite(vars?.[id]))
    if (ids.length && !known.length) return value
    if (!ids.length && !/[+\-*/]/.test(text)) return /^\d+(\.\d+)?$/.test(text) ? Number(text) : value
    try { return evalExpression(text, vars) } catch (error) {
      throw new Error(`${where}：${error.message}`)
    }
  }
  if (Array.isArray(value)) return value.map((v) => resolveParams(v, vars, where))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = EXPR_SKIP_KEYS.has(k) ? v : resolveParams(v, vars, where)
    }
    return out
  }
  return value
}

/** Base placements + joints + explode → a scene payload ready to publish. */
function assembleScene(record) {
  const explode = record.explode ?? 0
  const instances = record.base.map((base) => {
    let rot = base.rot.slice()
    let translate = base.translate.slice()
    for (const joint of record.joints) {
      if (joint.instance !== base.name) continue
      const axis = normVec(joint.axis)
      if (joint.type === 'linear' || joint.type === 'planar') {
        translate = addVec(translate, scaleVec(axis, joint.value))
      } else {
        const R = axisAngle(axis, joint.value)
        translate = addVec(joint.origin, mulVec(R, subVec(translate, joint.origin)))
        rot = mulMat(R, rot)
      }
    }
    if (explode) translate = addVec(translate, scaleVec(subVec(base.center, record.center), explode))
    return { name: base.name, part: base.part, rot: rot.map(round6), translate: translate.map(round6) }
  })
  return {
    parts: record.parts,
    instances,
    assembly: {
      id: record.id,
      title: record.title,
      explode: round6(explode),
      joints: record.joints.map((j) => ({
        id: j.id,
        instance: j.instance,
        type: j.type,
        value: round6(j.value),
        min: round6(j.min),
        max: round6(j.max),
      })),
    },
  }
}

class FreeCadBridge {
  constructor(getConfig, log) {
    this.getConfig = getConfig
    this.log = log
    this.bin = probeBinary(getConfig().freecadPath)
    this.scenes = new Map()
    this.latest = undefined
    this.seq = 0
    this.history = []
    // Ids this process published since boot: a row that is neither here nor on
    // disk was deleted on purpose and must not be resurrected by the next write.
    this.touched = new Set()
    /** Assemblies keep their base placements so joints can re-place instances. */
    this.assemblies = new Map()
    this.sessionUndo = []
    this.sessionRedo = []
    this.assemblySeq = 0
    /**
     * Models live in the session's workspace, but the panel posts without a
     * session — remember the last dir a tool used so its edits land in the same
     * place, and persist it so a restart keeps pointing at the right folder.
     */
    this.modelsDir = ''
    /** Every models dir a tool has used (panel posts carry no session). */
    this.modelsSeen = []
  }

  /** Remember a models dir: newest first, deduped, bounded. */
  noteModelsDir(dir) {
    if (typeof dir !== 'string' || !dir) return
    this.modelsDir = dir
    this.modelsSeen = [dir, ...this.modelsSeen.filter((d) => d !== dir)].slice(0, 12)
  }

  /** Candidate models dirs, most recently used first (falls back to config). */
  modelsCandidates() {
    // A class method cannot see apply()'s `modelsDirFor`; the global dir is the
    // right tail here because panel routes always carry a real dir first.
    const out = [this.modelsDir, ...this.modelsSeen, this.getConfig().modelsDir, GLOBAL_MODELS_DIR]
    return [...new Set(out.filter((d) => typeof d === 'string' && d))]
  }

  refresh() {
    this.bin = probeBinary(this.getConfig().freecadPath)
    // Version costs a spawn, so ask once per binary rather than every poll
    // (the panel polls /state every 1.5 s).
    if (this.bin && this.versionOf !== this.bin) {
      this.versionOf = this.bin
      try { this.kernelVersion = freecadVersion(this.bin) } catch { this.kernelVersion = '' }
    }
    if (!this.bin) { this.kernelVersion = ''; this.versionOf = '' }
    return this.bin
  }

  status() {
    return {
      binary: this.bin ?? '',
      available: Boolean(this.bin),
      scenes: this.scenes.size,
      latest: this.latest?.id ?? '',
    }
  }

  /** Directory where published scenes and the state pointer live. */
  static get dataDir() {
    return join(tmpdir(), 'dsh-cad-studio')
  }

  /** In-memory assembly records merged with the ones already on disk. */
  assembleRecords(disk) {
    const byId = new Map((Array.isArray(disk) ? disk : []).map((a) => [a.id, a]))
    for (const [id, rec] of this.assemblies) byId.set(id, rec)
    return byId
  }

  async persist() {
    const dir = FreeCadBridge.dataDir
    await mkdir(join(dir, 'scenes'), { recursive: true })
    // Whatever an earlier process registered stays registered.
    let prevAssemblies = []
    try {
      const prev = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
      prevAssemblies = Array.isArray(prev.assemblies) ? prev.assemblies : []
    } catch {}
    // Keep new ids clear of the ones already in use.
    for (const rec of this.assembleRecords(prevAssemblies).values()) {
      const n = Number(String(rec.id).replace(/\D+/g, ''))
      if (Number.isFinite(n)) this.assemblySeq = Math.max(this.assemblySeq, n)
    }
    // A row deleted from state.json (by hand or by another process) must stay
    // deleted: without this, the next publish wrote the whole in-memory history
    // back and undid the prune — which is exactly what the reviewer hit twice.
    let diskIds = null
    try {
      const prev = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
      diskIds = new Set((Array.isArray(prev.history) ? prev.history : []).map((h) => h.id))
    } catch {}
    if (diskIds) {
      this.history = this.history.filter((h) => diskIds.has(h.id) || this.touched.has(h.id))
      if (this.latest && !this.history.some((h) => h.id === this.latest.id)) {
        const next = this.history[0]
        this.latest = next ? { id: next.id, title: next.title, at: next.at, scene: this.scenes.get(next.id) ?? null } : null
      }
    }
    const latest = this.latest
    if (latest) await writeFile(join(dir, 'scenes', `${latest.id}.json`), JSON.stringify(latest.scene), 'utf8')
    const pointer = {
      runtime: { ...this.status(), version: this.kernelVersion || '' },
      latest: latest ? { id: latest.id, title: latest.title, at: latest.at } : null,
      // Newest first, trimmed: the panel's model switcher reads this list.
      history: this.history.slice(0, 30),
      // Joints/explode are UI state: the panel needs them without asking a tool.
      // Base placements ride along so a restarted process can still drive them
      // (the meshes stay in the scene file; only placements are small).
      modelsDir: this.modelsDir ?? '',
      modelsDirs: this.modelsSeen.slice(0, 12),
      // Which session last published: the panel only places its tab in the
      // sidebar for that session (or one that owns older scenes), so unrelated
      // conversations never get a CAD pane pushed into them.
      lastSession: this.lastSession ?? '',
      // Merge with what an earlier process wrote: this process may only know
      // about the assemblies it touched, and an unrelated publish must not wipe
      // the others (the panel drives them by hydrating on demand).
      assemblies: [...this.assembleRecords(prevAssemblies).values()].map((a) => ({
        id: a.id,
        title: a.title,
        sceneId: a.sceneId,
        base: a.base,
        center: a.center,
        joints: a.joints.map((j) => ({ id: j.id, instance: j.instance, type: j.type, value: j.value, min: j.min, max: j.max, axis: j.axis, origin: j.origin })),
        explode: a.explode,
      })),
    }
    await writeFile(join(dir, 'state.json'), JSON.stringify(pointer), 'utf8')
  }

  /** Publish a scene payload: sequence it, record stats, mirror it to disk. */
  /**
   * Fold whatever an earlier process published into this one's history: the
   * scene files outlive the process, but the list lives in memory, so without
   * this a restart (or a second process) would hide every earlier model.
   */
  async hydrateHistory() {
    if (this.historyHydrated) return
    this.historyHydrated = true
    try {
      const pointer = JSON.parse(await readFile(join(FreeCadBridge.dataDir, 'state.json'), 'utf8'))
      if (!this.modelsDir && typeof pointer.modelsDir === 'string') this.modelsDir = pointer.modelsDir
      if (Array.isArray(pointer.modelsDirs)) this.modelsSeen = [...new Set([...this.modelsSeen, ...pointer.modelsDirs.filter((d) => typeof d === 'string' && d)])].slice(0, 12)
      if (!this.lastSession && typeof pointer.lastSession === 'string') this.lastSession = pointer.lastSession
      const disk = Array.isArray(pointer.history) ? pointer.history : []
      const asmTitles = new Map()
      for (const a of Array.isArray(pointer.assemblies) ? pointer.assemblies : []) {
        if (a && typeof a.id === 'string' && typeof a.title === 'string') asmTitles.set(`asm:${a.id}`, a.title)
      }
      // Earlier builds appended the joint value / explode factor to the model
      // name (`运动演示 · hinge 60`). Rewrite those rows to the plain title.
      const SUFFIX = /\s·\s(?:合拢|爆炸\s-?\d+(?:\.\d+)?|[A-Za-z_][\w-]*\s-?\d+(?:\.\d+)?)$/
      for (const row of [...this.history, ...disk]) {
        if (!row || typeof row.title !== 'string') continue
        const base = typeof row.docKey === 'string' && asmTitles.has(row.docKey) ? asmTitles.get(row.docKey) : row.title.replace(SUFFIX, '')
        row.title = base
      }
      const seen = new Set(this.history.map((h) => h.id))
      const merged = [...this.history, ...disk.filter((h) => !seen.has(h.id))]
      merged.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
      this.history = merged.slice(0, 30)
    } catch {}
  }

  /**
   * Publish a scene for the panel to show.
   *
   * `opts.docKey` names the *model* the scene belongs to (an assembly, a
   * feature model). Re-publishing the same docKey updates that model in place —
   * same scene id, same list row, fresh geometry — instead of stacking a new
   * entry in the models list every time a joint is dragged.
   */
  async publishScene(scene, title, session = this.currentSession ?? '', opts = {}) {
    if (session) this.lastSession = session
    const docKey = typeof opts.docKey === 'string' ? opts.docKey : ''
    await this.hydrateHistory()
    // Scene ids are the on-disk filenames: after a restart the counter must
    // resume above whatever is already published, or the first new scene would
    // overwrite an older one.
    if (!this.seqRecovered) {
      this.seqRecovered = true
      try {
        const names = await readdir(join(FreeCadBridge.dataDir, 'scenes'))
        for (const name of names) {
          const hit = /^scene-(\d+)\.json$/.exec(name)
          if (hit) this.seq = Math.max(this.seq, Number(hit[1]))
        }
      } catch {}
    }
    let id = ''
    if (docKey) {
      const prev = this.history.find((h) => h.docKey === docKey)
      if (prev) id = prev.id
    }
    if (!id && typeof opts.id === 'string' && /^scene-\d+$/.test(opts.id)) id = opts.id
    if (!id) id = `scene-${++this.seq}`
    else this.seq = Math.max(this.seq, Number(id.slice('scene-'.length)))
    this.scenes.set(id, scene)
    // Count what the viewport shows: per-instance totals and only the parts an
    // instance actually references (a scene may carry unreferenced parts).
    const partMap = new Map((scene.parts || []).map((p) => [p.id, p]))
    const usedParts = new Set()
    let triangles = 0
    let volume = 0
    for (const inst of scene.instances || []) {
      const part = partMap.get(inst.part)
      if (!part) continue
      usedParts.add(inst.part)
      triangles += (part.tris || []).length / 3
      volume += part.volume || 0
    }
    const stats = {
      id,
      title,
      session,
      at: new Date().toISOString(),
      instances: (scene.instances || []).length,
      parts: usedParts.size,
      triangles,
      volume,
      ...(docKey ? { docKey } : {}),
    }
    this.touched.add(id)
    this.history = [stats, ...this.history.filter((h) => h.id !== id)].slice(0, 30)
    this.latest = { id, title, at: stats.at, scene }
    // Persist so a restarted process (and any stale route closure left by a
    // hot reload) still serves the newest scene.
    await this.persist()
    return { id, stats }
  }

  /** The model list, as the panel sees it (newest first). */
  listSceneRows() {
    return this.history.map((h) => ({
      id: h.id,
      title: h.title,
      at: h.at,
      session: h.session ?? '',
      instances: h.instances ?? 0,
      parts: h.parts ?? 0,
      triangles: h.triangles ?? 0,
      volume: h.volume ?? null,
      docKey: h.docKey ?? '',
    }))
  }

  /**
   * Drop one row from the model list. A probe that was published by mistake is
   * otherwise only removable by editing state.json by hand — which is exactly
   * how a 28-row list happened in the first place.
   */
  async removeScene(id, opts = {}) {
    const key = String(id ?? '')
    const row = this.history.find((h) => h.id === key)
    if (!row) throw new Error(`没有这个场景：${key}（可用 ${this.history.map((h) => h.id).join(', ') || '（无）'}）`)
    const snapshot = JSON.parse(JSON.stringify(row))
    let bytes = null
    if (opts.journal !== false) {
      try { bytes = await readFile(join(FreeCadBridge.dataDir, 'scenes', `${key}.json`)) } catch {}
      this.journal({
        kind: 'scene',
        label: `delete ${key}`,
        undo: async () => {
          this.history = [snapshot, ...this.history.filter((h) => h.id !== key)]
          if (bytes) await writeFile(join(FreeCadBridge.dataDir, 'scenes', `${key}.json`), bytes)
          this.latest = { id: snapshot.id, title: snapshot.title, at: snapshot.at, scene: this.scenes.get(key) ?? null }
          await this.persist()
          return { scene: key }
        },
        redo: async () => { await this.removeScene(key, { journal: false }); return { scene: key } },
      })
    }
    this.history = this.history.filter((h) => h.id !== key)
    this.scenes.delete(key)
    for (const [asmId, rec] of [...this.assemblies]) if (rec.sceneId === key) this.assemblies.delete(asmId)
    try { await rm(join(FreeCadBridge.dataDir, 'scenes', `${key}.json`), { force: true }) } catch {}
    if (this.latest && this.latest.id === key) {
      const next = this.history[0]
      this.latest = next ? { id: next.id, title: next.title, at: next.at, scene: this.scenes.get(next.id) ?? null } : null
    }
    await this.persist()
    return { ok: true, removed: key, scenes: this.history.length, latest: this.latest ? this.latest.id : '' }
  }

  async renameScene(id, title, opts = {}) {
    const key = String(id ?? '')
    const row = this.history.find((h) => h.id === key)
    if (!row) throw new Error(`没有这个场景：${key}`)
    const name = String(title ?? '').trim()
    if (!name) throw new Error('新名字不能为空')
    const old = row.title
    if (opts.journal !== false && old !== name) {
      this.journal({
        kind: 'scene',
        label: `rename ${key}`,
        undo: async () => { await this.renameScene(key, old, { journal: false }); return { scene: key, title: old } },
        redo: async () => { await this.renameScene(key, name, { journal: false }); return { scene: key, title: name } },
      })
    }
    row.title = name
    if (this.latest && this.latest.id === key) this.latest = { ...this.latest, title: name }
    await this.persist()
    return { ok: true, id: key, title: name }
  }

  /** Reserve the id before publishing, so the scene can carry `asm:<id>`. */
  reserveAssemblyId() {
    return `asm-${++this.assemblySeq}`
  }

  /** Register the base placements of a published assembly so joints can move it. */
  registerAssembly({ title, sceneId, scene, joints, id: givenId }) {
    const id = givenId ?? `asm-${++this.assemblySeq}`
    const seq = /^asm-(\d+)$/.exec(id)
    if (seq) this.assemblySeq = Math.max(this.assemblySeq, Number(seq[1]))
    const record = {
      id,
      title,
      sceneId,
      parts: scene.parts,
      base: scene.instances.map((inst) => ({
        name: inst.name,
        part: inst.part,
        rot: inst.rot.slice(),
        translate: inst.translate.slice(),
        center: instanceCenter(scene.parts, inst),
      })),
      center: bboxCenterOfInstances(scene.parts, scene.instances),
      joints: joints ?? [],
      explode: 0,
    }
    this.assemblies.set(id, record)
    return record
  }

  setJoint(record, spec) {
    const value = normalizeJoint(record, spec)
    const existing = record.joints.find((j) => j.id === spec.id)
    if (existing) Object.assign(existing, value)
    else record.joints.push(value)
    return value
  }

  driveJoint(record, jointId, rawValue) {
    const joint = record.joints.find((j) => j.id === jointId)
    if (!joint) return null
    const next = Number(rawValue)
    if (!Number.isFinite(next)) return null
    joint.value = Math.min(joint.max, Math.max(joint.min, next))
    record.explode = record.explode ?? 0
    return joint
  }

  setExplode(record, factor) {
    const next = Number(factor)
    if (!Number.isFinite(next)) return null
    record.explode = Math.max(0, Math.min(4, next))
    return record.explode
  }

  // ---- 装配层撤销：关节值 / 关节增删 / 爆炸系数 ----
  snapshotAssembly(record) {
    return { id: record.id, joints: JSON.parse(JSON.stringify(record.joints ?? [])), explode: record.explode ?? 0 }
  }

  beginAssemblyEdit(record, label) {
    return { label, assembly: record.id, before: this.snapshotAssembly(record), after: null }
  }

  endAssemblyEdit(entry, record) {
    if (!entry) return
    const before = entry.before
    const after = this.snapshotAssembly(record)
    this.journal({
      kind: 'assembly',
      label: entry.label,
      undo: async () => this.applyAssemblySnapshot(before),
      redo: async () => this.applyAssemblySnapshot(after),
    })
  }

  /** One stack for every undoable mutation, in the order it happened. */
  journal(entry) {
    this.sessionUndo.push({ at: new Date().toISOString(), ...entry })
    if (this.sessionUndo.length > 50) this.sessionUndo.shift()
    this.sessionRedo = []
  }

  async applyAssemblySnapshot(snapshot) {
    const record = await this.loadAssembly(snapshot.id)
    if (!record) throw new Error(`没有这个装配：${snapshot.id}`)
    record.joints = JSON.parse(JSON.stringify(snapshot.joints))
    record.explode = Math.max(0, Math.min(4, Number(snapshot.explode) || 0))
    const published = await this.republishAssembly(record)
    return { record, published }
  }

  async undoSession(kind) {
    const stack = kind ? this.sessionUndo.filter((e) => e.kind === kind) : this.sessionUndo
    const entry = stack[stack.length - 1]
    if (!entry) return null
    this.sessionUndo = this.sessionUndo.filter((e) => e !== entry)
    const out = await entry.undo()
    this.sessionRedo.push(entry)
    return { label: entry.label, kind: entry.kind, ...(out ?? {}) }
  }

  async redoSession(kind) {
    const stack = kind ? this.sessionRedo.filter((e) => e.kind === kind) : this.sessionRedo
    const entry = stack[stack.length - 1]
    if (!entry) return null
    this.sessionRedo = this.sessionRedo.filter((e) => e !== entry)
    const out = await entry.redo()
    this.sessionUndo.push(entry)
    return { label: entry.label, kind: entry.kind, ...(out ?? {}) }
  }

  /** Recompute instance placements from base + joints + explode, then publish. */
  async republishAssembly(record) {
    const scene = assembleScene(record)
    // The title is the model's name, never its state: dragging a joint or
    // changing the explode factor must not rename the model.
    const title = record.title
    // In place: the assembly owns one scene id and one row in the models list.
    const published = await this.publishScene(scene, title, this.currentSession ?? '', {
      docKey: `asm:${record.id}`,
      id: record.sceneId,
    })
    record.sceneId = published.id
    return published
  }

  /**
   * Rebuild an assembly record from disk. The meshes are not duplicated into
   * the pointer: base placements come from state.json, the parts from the
   * scene file (geometry never changes when a joint moves, so any scene of
   * this assembly carries the right parts).
   */
  async loadAssembly(id) {
    if (id && this.assemblies.has(id)) return this.assemblies.get(id)
    let pointer
    try {
      pointer = JSON.parse(await readFile(join(FreeCadBridge.dataDir, 'state.json'), 'utf8'))
    } catch {
      return null
    }
    const metas = Array.isArray(pointer.assemblies) ? pointer.assemblies : []
    const meta = id ? metas.find((a) => a.id === id) : metas[metas.length - 1]
    if (!meta) return null
    const candidates = [meta.sceneId, pointer.latest?.id].filter(Boolean)
    for (const sceneId of candidates) {
      try {
        const scene = JSON.parse(await readFile(join(FreeCadBridge.dataDir, 'scenes', `${sceneId}.json`), 'utf8'))
        if (!Array.isArray(scene.parts)) continue
        const seq = Number(String(meta.id).replace(/^asm-/, ''))
        if (Number.isFinite(seq) && seq > this.assemblySeq) this.assemblySeq = seq
        const record = { ...meta, parts: scene.parts }
        this.assemblies.set(record.id, record)
        return record
      } catch {}
    }
    return null
  }

  async run(code, { title, publishHint = true, publish = true, meta = null, docKey = '', sceneId = '' } = {}) {
    const bin = this.refresh()
    if (!bin) {
      return { ok: false, error: 'freecadcmd not found; set freecadPath in the plugin config' }
    }
    const cfg = this.getConfig()
    const dir = await mkdtemp(join(tmpdir(), 'cad-studio-'))
    const script = join(dir, 'job.py')
    // Models reach for `scene = box` far more often than for `__out["scene"]`, and a
    // silent no-publish makes them claim success that never happened. Accept both:
    // any shape bound to scene/shape/result is tessellated and published.
    const autoScene = `
if not (isinstance(globals().get("__out"), dict) and __out.get("scene")):
    for __name in ("scene", "shape", "result", "part"):
        __cand = globals().get(__name)
        if __cand is not None and hasattr(__cand, "tessellate"):
            __m = _mesh(__cand)
            if not isinstance(globals().get("__out"), dict):
                __out = {"ok": True}
            __out.setdefault("scene", {
                "parts": [{"id": "p1", "verts": __m["verts"], "tris": __m["tris"], "volume": round(__cand.Volume, 3)}],
                "instances": [{"name": __name, "part": "p1", "rot": [1,0,0, 0,1,0, 0,0,1], "translate": [0, 0, 0]}],
            })
            __out.setdefault("volume", round(__cand.Volume, 3))
            break
`
    const wrapped = `${code}\n${autoScene}\nimport json as __json\n_payload = __out if "__out" in globals() else {"ok": True}
print("${BEGIN}" + __json.dumps(_safe(_payload)) + "${END}", flush=True)\n`
    await writeFile(script, wrapped, 'utf8')
    try {
      const result = await new Promise((resolvePromise) => {
        const child = spawn(bin, [script], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1' } })
        let out = ''
        let err = ''
        const timer = setTimeout(() => child.kill('SIGKILL'), cfg.timeoutMs)
        child.stdout.on('data', (b) => { out += b })
        child.stderr.on('data', (b) => { err += b })
        child.on('close', (rc) => {
          clearTimeout(timer)
          resolvePromise({ rc, out, err })
        })
        child.on('error', (e) => {
          clearTimeout(timer)
          resolvePromise({ rc: -1, out, err: String(e?.message ?? e) })
        })
      })
      const marker = result.out.indexOf(BEGIN)
      if (marker < 0) {
        const rawErr = result.err.slice(-4000)
        const message = freecadException(rawErr)
        const failure = { ok: false, stderr: rawErr.trim(), stdout: result.out.slice(-4000), exitCode: result.rc }
        if (message) failure.error = message
        const hint = hintForException(message)
        if (hint) failure.hint = hint
        return failure
      }
      const end = result.out.indexOf(END, marker)
      const payload = result.out.slice(marker + BEGIN.length, end < 0 ? undefined : end)
      let value
      try {
        value = JSON.parse(payload)
      } catch (error) {
        return { ok: false, error: `helper returned non-JSON: ${String(error?.message ?? error)}`, raw: payload.slice(0, 500) }
      }
      if (value?.scene && publish !== false) {
        // A shape bound to `scene = box` arrives with the variable name as the
        // instance label; the caller's title is what a human expects in the tree.
        const first = value.scene.instances?.[0]
        if (title && first && ['scene', 'shape', 'result', 'part'].includes(first.name)) first.name = title
        // `meta` rides inside the scene payload: the panel reads the feature list
        // (and the assembly block) from there instead of calling a tool per frame.
        const scene = meta ? { ...value.scene, ...meta } : value.scene
        const published = await this.publishScene(scene, title ?? value.title ?? 'untitled', this.currentSession ?? '', { docKey, id: sceneId })
        value.sceneId = published.id
        delete value.scene
      }
      if (publish === false) delete value.scene
      const clean = { ok: true, ...value }
      clean.published = Boolean(clean.sceneId)
      if (!clean.published && publishHint) {
        clean.hint = 'nothing published: bind the shape you want shown to a `scene` variable (or __out["scene"])'
      }
      const errTail = result.err.slice(-2000)
      if (errTail) clean.stderr = errTail
      else delete clean.stderr
      return clean
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

/** Shared Python prelude for tool scripts: geometry helpers + scene building. */
const PRELUDE = `
import json, math
import Part, Import, FreeCAD
Vector = FreeCAD.Vector

def _safe(v):
    # DSH rejects -0 and NaN in tool output; FreeCAD hands both out freely.
    if isinstance(v, float):
        if v != v or v in (float("inf"), float("-inf")):
            return None
        return 0.0 if v == 0 else v
    if isinstance(v, (list, tuple)):
        return [_safe(x) for x in v]
    if isinstance(v, dict):
        return {str(k): _safe(x) for k, x in v.items()}
    return v

def _bounds(shape):
    b = shape.BoundBox
    return {"x": [b.XMin, b.XMax], "y": [b.YMin, b.YMax], "z": [b.ZMin, b.ZMax], "diagonal": b.DiagonalLength}

def _mesh(shape, deflection=0.25):
    # Tessellate face by face: a single shape-wide tessellation shares vertices
    # between a flat face and the curved face it meets, so the viewer's smoothed
    # normals bleed across the edge and paint a dark fan over flat surfaces.
    # Duplicating the seam keeps each face's normals its own while a curved face
    # (hole wall, fillet) still shares its vertices and stays smooth.
    verts = []
    tris = []
    for face in shape.Faces:
        try:
            fv, ff = face.tessellate(deflection)
        except Exception:
            continue
        base = len(verts) // 3
        for p in fv:
            verts.extend((p.x, p.y, p.z))
        for f in ff:
            tris.extend((base + f[0], base + f[1], base + f[2]))
    return {"verts": verts, "tris": tris}

def describe(path):
    shape = Part.Shape()
    shape.read(path)
    mesh = _mesh(shape)
    return {
        "path": path,
        "volume": round(shape.Volume, 3),
        "area": round(shape.Area, 3),
        "bounds": _bounds(shape),
        "faces": len(shape.Faces),
        "triangles": len(mesh["tris"]) // 3,
    }
`


/**
 * Python source for a declarative feature list. One emitter for both entry
 * points — the one-shot `cad_studio_feature` tool and every rebuild of a
 * `kind:'features'` model document — so a typed list and an edited-and-rebuilt
 * one cannot drift apart.
 */
/**
 * Bump whenever the emitter's meaning changes: the BREP cache is keyed by
 * (version, op-chain), so a stale entry from an older emitter would silently
 * resurrect wrong geometry.
 */
const EMITTER_VERSION = 'e1'

/** One hash per prefix: hashes[i] = ops[0..i] applied. Skip markers reuse the
 *  previous hash, so toggling a suppressed feature does not invalidate
 *  anything upstream of it. */
function chainHashes(ops) {
  const out = []
  let h = crypto.createHash('sha1').update(`cad-studio:${EMITTER_VERSION}`).digest('hex').slice(0, 16)
  for (const op of Array.isArray(ops) ? ops : []) {
    if (op && op.kind === '__skip__') { out.push(h); continue }
    const bare = { ...op }
    delete bare._id
    delete bare._label
    h = crypto.createHash('sha1').update(h).update(JSON.stringify(bare)).digest('hex').slice(0, 16)
    out.push(h)
  }
  return out
}

function brepCacheDir() { return join(FreeCadBridge.dataDir, 'cache') }

/** Content-addressed BREP snapshots are cheap to keep and cheap to prune:
 *  drop them oldest-first once the directory grows past a cap. */
function pruneBrepCache(dir, { maxFiles = 400, maxAgeDays = 14 } = {}) {
  let names = []
  try { names = readdirSync(dir).filter((n) => /^f_[0-9a-f]{16}\.brep$/.test(n)) } catch { return 0 }
  const now = Date.now()
  const kept = []
  for (const n of names) {
    try {
      const st = statSync(join(dir, n))
      if (now - st.mtimeMs > maxAgeDays * 86400_000) rmSync(join(dir, n), { force: true })
      else kept.push({ n, at: st.mtimeMs })
    } catch {}
  }
  kept.sort((a, b) => b.at - a.at)
  let dropped = 0
  for (const { n } of kept.slice(maxFiles)) { try { rmSync(join(dir, n), { force: true }); dropped += 1 } catch {} }
  return dropped
}

const featuresScript = (ops, exportPath, opts = {}) => `${PRELUDE}
import os
_OPS = json.loads(${JSON.stringify(JSON.stringify(Array.isArray(ops) ? ops : []))})
_EXPORT = ${exportPath ? JSON.stringify(exportPath) : 'None'}
_SKETCHES = json.loads(${JSON.stringify(JSON.stringify(opts.sketches && typeof opts.sketches === 'object' ? opts.sketches : {}))})
_CACHE = json.loads(${JSON.stringify(JSON.stringify(opts.cache && opts.cache.hashes ? { dir: opts.cache.dir, hashes: opts.cache.hashes } : null))})
_RESUME = json.loads(${JSON.stringify(JSON.stringify(opts.resume && opts.resume.brep ? { index: opts.resume.index, brep: opts.resume.brep } : null))})

def _v3(x, d=(0.0, 0.0, 0.0)):
    if not x:
        return Vector(float(d[0]), float(d[1]), float(d[2]))
    return Vector(float(x[0]), float(x[1]), float(x[2]))

def _dir(x, d=(0.0, 0.0, 1.0)):
    v = _v3(x, d)
    return v if v.Length > 1e-9 else _v3(d, (0.0, 0.0, 1.0))

def _anchor(_spec, _cur):
    # A feature can hang off a face instead of absolute coordinates:
    #   "at": {"ref": {"axis":"Z","mode":"aligned","dir":"+","type":"plane"},
    #          "offset": [10, 0, 0]}
    # The point is the face's centre plus the offset in world axes, so changing
    # the thickness upstream moves the hole with the face instead of leaving it
    # floating at the old Z.
    if not isinstance(_spec, dict) or "ref" not in _spec:
        return None
    if _cur is None:
        raise RuntimeError("at.ref 需要前面至少有一个已建好的实体")
    _hits = _sel(_cur, "face", _spec.get("ref") or {})
    if not _hits:
        raise RuntimeError("at.ref 没有选中任何面：%s" % json.dumps(_spec.get("ref"), ensure_ascii=False))
    _off = _spec.get("offset")
    return _center_of(_hits[0]) + (_v3(_off) if _off else Vector(0.0, 0.0, 0.0))


_SK_CONSTRAINT = {
    "coincident": ("Coincident", "ab2"), "concentric": ("Coincident", "circles"),
    "horizontal": ("Horizontal", "one"), "vertical": ("Vertical", "one"),
    "parallel": ("Parallel", "pair"), "perpendicular": ("Perpendicular", "pair"),
    "tangent": ("Tangent", "pair"), "distance_x": ("DistanceX", "size"),
    "distance_y": ("DistanceY", "size"), "radius": ("Radius", "size_one"),
    "angle": ("Angle", "size_pair"), "distance": ("Distance", "ab2v"),
}

def _sketch(name):
    import Sketcher
    spec = _SKETCHES.get(name)
    if not spec:
        raise RuntimeError("no such sketch: %s" % name)
    doc = FreeCAD.newDocument("sk_" + name)
    sk = doc.addObject("Sketcher::SketchObject", "K")
    ids = []
    for g in spec.get("geometry") or []:
        t = g.get("type")
        if t == "line":
            sk.addGeometry(Part.LineSegment(_v3(g["p1"]), _v3(g["p2"])), False)
        elif t == "circle":
            sk.addGeometry(Part.Circle(_v3(g["c"]), Vector(0, 0, 1), float(g["r"])), False)
        else:
            raise RuntimeError("sketch %s: unknown geometry %s" % (name, t))
        ids.append(g.get("id"))
    ix = dict((gid, i) for i, gid in enumerate(ids))
    def gi(ref):
        if ref not in ix:
            raise RuntimeError("sketch %s: constraint refers to missing geometry %s" % (name, ref))
        return ix[ref]
    dims = []
    for c in spec.get("constraints") or []:
        t = c.get("type")
        row = _SK_CONSTRAINT.get(t)
        if not row:
            raise RuntimeError("sketch %s: unknown constraint %s" % (name, t))
        fc, form = row
        v = c.get("value")
        if form == "one":
            sk.addConstraint(Sketcher.Constraint(fc, gi(c["a"])))
        elif form == "ab2":
            sk.addConstraint(Sketcher.Constraint(fc, gi(c["a"]), int(c.get("pa", 1)), gi(c["b"]), int(c.get("pb", 1))))
        elif form == "circles":
            sk.addConstraint(Sketcher.Constraint(fc, gi(c["a"]), 3, gi(c["b"]), 3))
        elif form == "pair":
            sk.addConstraint(Sketcher.Constraint(fc, gi(c["a"]), gi(c["b"])))
        elif form == "size":
            sk.addConstraint(Sketcher.Constraint(fc, gi(c["a"]), int(c.get("pa", 2)), float(v)))
            dims.append((c, fc, (gi(c["a"]), int(c.get("pa", 2))), None, float(v)))
        elif form == "size_one":
            sk.addConstraint(Sketcher.Constraint(fc, gi(c["a"]), float(v)))
            dims.append((c, fc, (gi(c["a"]), None), None, float(v)))
        elif form == "ab2v":
            sk.addConstraint(Sketcher.Constraint(fc, gi(c["a"]), int(c.get("pa", 1)), gi(c["b"]), int(c.get("pb", 2)), float(v)))
            dims.append((c, fc, (gi(c["a"]), int(c.get("pa", 1))), (gi(c["b"]), int(c.get("pb", 2))), float(v)))
        else:
            sk.addConstraint(Sketcher.Constraint(fc, gi(c["a"]), gi(c["b"]), float(v)))
            dims.append((c, fc, (gi(c["a"]), None), (gi(c["b"]), None), float(v)))
    rc = sk.solve()
    if rc < 0:
        raise RuntimeError("sketch %s: solver failed (rc=%s), constraints conflict" % (name, rc))
    doc.recompute()
    for c, fc, ref1, ref2, want in dims:
        def _pt(ref):
            seg = sk.Geometry[ref[0]]
            return seg.StartPoint if ref[1] == 1 else seg.EndPoint
        if fc == "Radius":
            got = sk.Geometry[ref1[0]].Radius
        elif fc == "Distance":
            got = (_pt(ref2) - _pt(ref1)).Length
        elif fc in ("DistanceX", "DistanceY"):
            p = _pt(ref1)
            got = p.x if fc == "DistanceX" else p.y
        else:
            continue
        if abs(got - want) > 1e-6:
            raise RuntimeError("sketch %s: constraint %s not satisfied: want %s got %.4f" % (name, c.get("id"), want, got))
    wires = sk.Shape.Wires
    if not wires:
        raise RuntimeError("sketch %s: not a closed contour (%d curves)" % (name, len(ids)))
    return wires[0]

def _prim(op, _cur=None):
    k = op.get("kind")
    _at_spec = op.get("at")
    _anchored = _anchor(_at_spec, _cur) if isinstance(_at_spec, dict) else None
    at = _anchored if _anchored is not None else _v3(_at_spec)
    if k == "box":
        s = op.get("size") or [10, 10, 10]
        return Part.makeBox(float(s[0]), float(s[1]), float(s[2]), at)
    if k == "cylinder":
        return Part.makeCylinder(float(op["r"]), float(op["h"]), at, _dir(op.get("axis")))
    if k == "sphere":
        return Part.makeSphere(float(op["r"]), at)
    if k == "cone":
        return Part.makeCone(float(op["r1"]), float(op["r2"]), float(op["h"]), at, _dir(op.get("axis")))
    if k == "torus":
        return Part.makeTorus(float(op["r1"]), float(op["r2"]), at, _dir(op.get("axis")))
    if k == "extrude":
        if op.get("sketch"):
            face = Part.Face(_sketch(str(op["sketch"])))
            return face.extrude(_dir(op.get("dir"), (0.0, 0.0, float(op.get("h") or 10.0))))
        base = float(op.get("base", 0.0))
        h = float(op.get("h", 0.0))
# Points may be 2D (z = base) or 3D; dir replaces the +Z extrusion,
        # which is what a chamfer prism or a slanted rib actually needs.
        pts = [tuple(p) for p in op["points"]]
        ps = [Vector(float(q[0]), float(q[1]), float(q[2]) if len(q) > 2 else base) for q in pts]
        vec = _v3(op.get("dir"), (0.0, 0.0, h)) if op.get("dir") else Vector(0.0, 0.0, h)
        if abs(vec.Length) < 1e-9:
            raise RuntimeError("extrude 需要 h 或 dir（当前的挤出向量长度为 0）")
        return Part.Face(Part.makePolygon(ps + [ps[0]])).extrude(vec)
    if k == "revolve":
        if op.get("sketch"):
            face = Part.Face(_sketch(str(op["sketch"])))
            rev = face.revolve(_v3(op.get("origin")), _dir(op.get("axis"), (0.0, 0.0, 1.0)), float(op.get("angle", 360.0)))
            # A revolve of a face yields a shell; a full turn closes it, but only
            # becomes a solid after we say so. Volume 0 means "still a shell".
            if abs(rev.Volume) < 1e-9 and rev.Shells:
                try:
                    rev = Part.makeSolid(rev.Shells[0])
                except Exception:
                    pass
            if abs(rev.Volume) < 1e-9:
                # Do not hand a zero-volume shell downstream: say it out loud.
                raise RuntimeError("草图旋转得到的是壳体、没有闭合（需要 sewShape 缝合）；先用挤出，或把草图轮廓贴住旋转轴")
            return rev
        ps = [Vector(float(p[0]), 0.0, float(p[1])) for p in op["points"]]
        ang = float(op.get("angle", 360.0))
        return Part.Face(Part.makePolygon(ps + [ps[0]])).revolve(Vector(0.0, 0.0, 0.0), Vector(0.0, 0.0, 1.0), ang)
    raise RuntimeError("未知图元：" + str(k))

# ---- sub-shape selectors -------------------------------------------------
# Predicates over geometry, re-evaluated on every rebuild. No persistent ids:
# OCCT regenerates topology on each operation, so "the 7th face" is not a name.
# Failure is loud: an empty match raises with the spec and the item counts.
def _axis_of(_spec):
    _a = _spec.get("axis", "Z")
    if isinstance(_a, (list, tuple)):
        return Vector(float(_a[0]), float(_a[1]), float(_a[2]))
    _v = {"X": Vector(1.0, 0.0, 0.0), "Y": Vector(0.0, 1.0, 0.0), "Z": Vector(0.0, 0.0, 1.0)}.get(str(_a).upper())
    if _v is None:
        raise RuntimeError("选择器的 axis 只能是 X/Y/Z 或 [x,y,z]：%s" % str(_a))
    return _v


def _unit(_v):
    _n = (_v.x * _v.x + _v.y * _v.y + _v.z * _v.z) ** 0.5
    if _n < 1e-12:
        raise RuntimeError("选择器的方向长度为 0")
    return Vector(_v.x / _n, _v.y / _n, _v.z / _n)


def _dot(_a, _b):
    return float(_a.x * _b.x + _a.y * _b.y + _a.z * _b.z)


def _match_dir(_d, _ax, _mode, _sign):
    _u = _unit(_d)
    _a = _unit(_ax)
    _c = _dot(_u, _a)
    if _mode == "parallel":
        return abs(abs(_c) - 1.0) < 1e-3
    if _mode == "perpendicular":
        return abs(_c) < 1e-3
    return _c > 0.999 if _sign != "-" else _c < -0.999


def _core_of(s):
    # A shape read back from a BREP cache is a Compound, and Compound has no
    # CenterOfMass (only Solid does) — use the lone solid when there is one and
    # the bounding box otherwise. It only has to be a point *inside* the body.
    try:
        if len(s.Solids) == 1:
            return s.Solids[0].CenterOfMass
    except Exception:
        pass
    try:
        return s.BoundBox.Center
    except Exception:
        return Vector(0.0, 0.0, 0.0)

def _center_of(_it):
    _b = _it.BoundBox
    return Vector((_b.XMin + _b.XMax) / 2.0, (_b.YMin + _b.YMax) / 2.0, (_b.ZMin + _b.ZMax) / 2.0)


def _sel(_shape, _kind, _spec):
    if not _spec:
        return []
    if not isinstance(_spec, dict):
        raise RuntimeError("选择器必须是对象：%s" % str(_spec))
    _ax = _axis_of(_spec)
    _mode = _spec.get("mode", "parallel")
    _sign = _spec.get("dir", "+")
    _tol = float(_spec.get("tol", 0.5))
    _want = _spec.get("type")
    _items = list(_shape.Edges) if _kind == "edge" else list(_shape.Faces)
    _word = "条边" if _kind == "edge" else "个面"
    _out = []
    for _it in _items:
        if _want:
            _cls = (_it.Curve.__class__.__name__ if _kind == "edge" else _it.Surface.__class__.__name__).lower()
            if str(_want).lower() not in _cls:
                continue
        if _kind == "edge":
            try:
                _d = _it.tangentAt(_it.FirstParameter)
            except Exception:
                _d = getattr(_it.Curve, "Direction", None)
                if _d is None:
                    continue
        else:
            try:
                _d = _it.normalAt(0.5, 0.5)
            except Exception:
                continue
        if not _match_dir(_d, _ax, _mode, _sign):
            continue
        if _spec.get("radius") is not None and _kind == "edge":
            _r = getattr(_it.Curve, "Radius", None)
            if _r is None or abs(float(_r) - float(_spec["radius"])) > _tol:
                continue
        _out.append(_it)
    if not _out:
        raise RuntimeError("选择器没有选中任何%s：%s（当前形状有 %d %s）" % (
            "边" if _kind == "edge" else "面", json.dumps(_spec, ensure_ascii=False), len(_items), _word))
    if _spec.get("near") is not None:
        _p = _v3(_spec["near"])
        _out.sort(key=lambda _it: (_center_of(_it) - _p).Length)
    elif _spec.get("pick") in ("max", "min"):
        _a = _unit(_ax)
        _rev = _spec["pick"] == "max"
        _out.sort(key=lambda _it: _dot(_center_of(_it), _a), reverse=_rev)
    if _spec.get("nth") is not None:
        _i = int(_spec["nth"])
        _out = _out[_i:_i + 1]
    elif _spec.get("pick") in ("max", "min", "near"):
        _out = _out[:1]
    if _spec.get("one") and len(_out) != 1:
        raise RuntimeError("选择器命中了 %d %s，但要求恰好 1 个：%s" % (
            len(_out), _word, json.dumps(_spec, ensure_ascii=False)))
    return _out


_shape = None
_errors = []
_executed = 0
_start = 0
# Incremental recompute: resume from the deepest cached prefix instead of
# replaying the whole chain. The cache is content-addressed by the op chain,
# so an entry is only used when every upstream feature is byte-identical.
if _RESUME and os.path.exists(_RESUME["brep"]):
    try:
        _cached = Part.Shape()
        _cached.read(_RESUME["brep"])
        if _cached.isValid() and not _cached.isNull():
            _shape = _cached
            _start = int(_RESUME["index"])
            _executed = _start
    except Exception as _e:
        _shape = None
        _start = 0
for _idx, _op in enumerate(_OPS):
    if _idx < _start:
        continue
    _k = _op.get("kind")
    if _k == "__skip__":
        continue
    _snap = _shape
    try:
        if _k in ("box", "cylinder", "sphere", "cone", "torus", "extrude", "revolve"):
            _s = _prim(_op, _shape)
            _shape = _s if _shape is None else _shape.fuse(_s)
        elif _k in ("fuse", "cut", "common"):
# A U-shaped wall is one feature, not two: with takes a list, and
            # the tools are combined in order against the running shape.
            _ws = _op["with"]
            if not isinstance(_ws, (list, tuple)):
                _ws = [_ws]
            for _w in _ws:
                _s = _prim(_w, _shape)
                _shape = _shape.fuse(_s) if _k == "fuse" else (_shape.cut(_s) if _k == "cut" else _shape.common(_s))
        elif _k == "fillet":
            _eds = _sel(_shape, "edge", _op.get("edges")) or list(_shape.Edges)
            _shape = _shape.makeFillet(float(_op["r"]), _eds)
        elif _k == "chamfer":
            _eds = _sel(_shape, "edge", _op.get("edges")) or list(_shape.Edges)
            _shape = _shape.makeChamfer(float(_op["d"]), _eds)
        elif _k == "shell":
            _t = float(_op["t"])
            _open = _op.get("open", "none")
            _open_faces = _sel(_shape, "face", _op.get("faces"))
            if _open_faces:
                # Hollow, then cut a prism outward from each chosen face. FreeCAD
                # 0.20's Part module has no makeThickSolid*; extruding the face
                # along its own normal is the portable equivalent and keeps the
                # opening exactly where the selector pointed.
                _hollow = _shape.makeOffsetShape(-_t, 1e-6)
                _shell = _shape.cut(_hollow)
                _far = (_shape.BoundBox.DiagonalLength or 100.0) * 2.0
                for _f in _open_faces:
                    _cls = _f.Surface.__class__.__name__
                    if _cls != "Plane":
                        raise RuntimeError("shell 的 faces 选择器目前只支持平面（收到 %s）" % _cls)
                    _nrm = _unit(_f.normalAt(0.5, 0.5))
                    # Outward = away from the solid's centre of mass. A face's
                    # stored orientation can point inward; cutting inward would
                    # remove nothing (the interior is already hollow), and
                    # cutting both ways would punch a hole clean through.
                    _away = _center_of(_f) - _core_of(_shape)
                    if _dot(_nrm, _away) < 0:
                        _nrm = Vector(0.0 - _nrm.x, 0.0 - _nrm.y, 0.0 - _nrm.z)
                    # Cut the wall itself: start a hair outside the plane and go
                    # inward by exactly the wall thickness. Extruding *outward*
                    # would graze the face and remove nothing.
                    _inn = Vector(0.0 - _nrm.x, 0.0 - _nrm.y, 0.0 - _nrm.z)
                    _pr = _f.translated(_nrm * 0.01).extrude(_inn * (_t + 0.02))
                    _shell = _shell.cut(_pr)
                _shape = _shell
                _executed = _idx + 1
                continue
            _inner = _shape.makeOffsetShape(-_t, 1e-6)
            _shell = _shape.cut(_inner)
            if _open in ("top", "bottom"):
                _b = _shape.BoundBox
                _zw = (_b.ZMax - _t) if _open == "top" else _b.ZMin
                _box = Part.makeBox(_b.XLength * 2 + 10, _b.YLength * 2 + 10, _t * 6,
                                    Vector(_b.XMin - _b.XLength / 2 - 5, _b.YMin - _b.YLength / 2 - 5, _zw - (_t * 6 if _open == "bottom" else 0)))
                _shell = _shell.cut(_box)
            _shape = _shell
        elif _k == "pattern_linear":
            _base = _shape
            _d = _v3(_op["delta"])
            for _i in range(1, int(_op["count"])):
                _base = _base.fuse(_shape.translated(Vector(_d.x * _i, _d.y * _i, _d.z * _i)))
            _shape = _base
        elif _k == "pattern_circular":
            _base = _shape
            _ax = _dir(_op.get("axis"), (0.0, 0.0, 1.0))
            _ctr = _v3(_op.get("at"))
            _n = int(_op["count"])
            _ang = float(_op.get("angle", 360.0))
            _step = _ang / _n if abs(_ang) >= 359.999 else _ang / max(_n - 1, 1)
            for _i in range(1, _n):
                _base = _base.fuse(_shape.rotate(_ctr, _ax, _step * _i))
            _shape = _base
        elif _k == "translate":
            _shape = _shape.translated(_v3(_op["v"]))
        elif _k == "rotate":
            _shape = _shape.rotate(_v3(_op.get("at")), _dir(_op.get("axis")), float(_op["deg"]))
        elif _k == "mirror":
            _shape = _shape.mirror(_v3(_op.get("at")), _dir(_op.get("normal")))
        else:
            raise RuntimeError("未知特征：" + str(_k))
    except Exception as _e:
        # A failing node must not roll the document back: record it, keep the
        # last good shape, and stop — every later node is blocked by it, which
        # is what a parametric CAD does (the bad feature is the one to fix).
        _shape = _snap
        _errors.append({
            "id": _op.get("_id", "?"),
            "step": _idx + 1,
            "kind": _k,
            "label": _op.get("_label") or "",
            "message": str(_e),
        })
        break
    _executed = _idx + 1
    if _CACHE and _idx < len(_CACHE.get("hashes") or []):
        try:
            _p = os.path.join(_CACHE["dir"], "f_%s.brep" % _CACHE["hashes"][_idx])
            if not os.path.exists(_p):
                _tmp = "%s.tmp%d" % (_p, os.getpid())
                _shape.exportBrep(_tmp)
                os.replace(_tmp, _p)
        except Exception:
            pass

if _shape is None:
    raise RuntimeError(_errors[0]["message"] if _errors else "ops 为空：至少给一个图元")
_shape = _shape.removeSplitter()
scene = _shape
__out = {
    "ok": True,
    "features": len(_OPS),
    "cached": _start,
    "computed": max(0, _executed - _start),
    "volume": round(_shape.Volume, 3),
    "area": round(_shape.Area, 3),
    "faces": len(_shape.Faces),
    "bounds": _bounds(_shape),
    "errors": _errors,
    "executed": _executed,
}
if _EXPORT:
    os.makedirs(os.path.dirname(_EXPORT) or ".", exist_ok=True)
    _shape.exportStep(_EXPORT)
    __out["exported"] = _EXPORT
    __out["bytes"] = os.path.getsize(_EXPORT)
`
/**
 * One bridge per process, not per plugin load: a hot reload cannot release the
 * prefix route it left behind, so the surviving handler must read the current
 * state rather than a dead closure.
 *
 * The reverse hazard is worse than a missing bridge: a bridge built by an older
 * module version survives the reload and is reused, so the new code calls
 * methods that instance simply does not have (the assembly routes threw, and the
 * web server turned that into a bare 400). Check the shape, not just existence —
 * rebuilding is cheap, the scene store on disk is the source of truth.
 */
const BRIDGE_API = [
  'run', 'publishScene', 'hydrateHistory', 'registerAssembly', 'loadAssembly',
  'setJoint', 'driveJoint', 'setExplode', 'republishAssembly', 'status', 'refresh',
]

function sharedState(resolved, logger) {
  const box = (globalThis.__dshCadStudio ??= {})
  box.config = resolved
  const stale = !box.bridge || BRIDGE_API.some((name) => typeof box.bridge[name] !== 'function')
  if (stale) box.bridge = new FreeCadBridge(() => box.config, logger)
  else box.bridge.getConfig = () => box.config
  return box
}

const MODELS_DIRNAME = 'cad-models'
/** Fallback when neither config nor the session provides a workspace (e.g. a test stub). */
const GLOBAL_MODELS_DIR = '/workspace/cad-models'

/** The calling session's workspace directory, when the runtime exposes one. */
function sessionWorkspace(exec) {
  const session = exec?.agent?.session
  const cwd = session?.header?.cwd ?? session?.cwd
  return typeof cwd === 'string' && cwd.startsWith('/') ? cwd : ''
}

export function apply(ctx, config) {
  const resolved = normalizeConfig(config)
  /**
   * Model documents belong to the session's workspace: an explicit `modelsDir`
   * wins, otherwise <session cwd>/cad-models, otherwise the container-global
   * directory (tests and sessions without a workspace).
   */
  const modelsDirFor = (exec) => {
    if (resolved.modelsDir) return resolved.modelsDir
    const workspace = sessionWorkspace(exec)
    return workspace ? join(workspace, MODELS_DIRNAME) : GLOBAL_MODELS_DIR
  }
  const state = sharedState(resolved, ctx.logger)
  const bridge = state.bridge
  ctx.logger?.info?.('cad-studio: freecadcmd %s', bridge.status().binary ?? '(not found)')

  // The exported model layout is `<model>/parts/b12-create_prim.step`, so the
  // file name alone says nothing useful in a tab strip. Prefer the model folder
  // and keep the part stem as a suffix, so two parts of one model still differ.
  const modelLabelOf = (path) => {
    const segs = String(path).split('/').filter(Boolean)
    const base = segs[segs.length - 1] || String(path)
    const stem = base.replace(/\.[^.]+$/, '')
    const parent = segs[segs.length - 2] || ''
    const model = segs[segs.length - 3] || ''
    if (parent === 'parts' && model) return `${model} · ${stem}`
    return stem
  }

  /** Read a model file, describe it, and publish one static instance. */
  const openPath = async (path) => {
    const label = modelLabelOf(path)
    const ext = /\.[A-Za-z0-9]+$/.exec(path)?.[0].slice(1).toLowerCase() ?? ''
    if (!SUPPORTED_FILE_EXTS.includes(ext)) {
      return {
        ok: false,
        error: ext ? `unsupported file type: .${ext}` : 'unsupported file type: (no extension)',
        hint: `cad_studio_open 只读 ${SUPPORTED_FILE_EXTS.map((e) => `.${e}`).join(' / ')}；换一个格式，或先用 FreeCAD 转出 STEP。`,
      }
    }
    // FreeCAD 0.20's Part.read handles BREP/IGES/STEP but NOT STL — mesh formats
    // go through the Mesh module. Mixing them up is exactly what produced
    // "Unknown extension" on a .stl click.
    const meshBranch = ext === 'stl'
    const py = `
_p = ${JSON.stringify(path)}
if ${JSON.stringify(ext)} == "stl":
    import Mesh
    _m = Mesh.Mesh(_p)
    _verts = [c for v in _m.Points for c in (v.x, v.y, v.z)]
    _tris = [i for f in _m.Facets for i in f.PointIndices]
    _vol = float(_m.Volume) if getattr(_m, "Volume", None) else 0.0
    _xs = _verts[0::3] or [0.0]
    _ys = _verts[1::3] or [0.0]
    _zs = _verts[2::3] or [0.0]
    _bb = {"x": [min(_xs), max(_xs)], "y": [min(_ys), max(_ys)], "z": [min(_zs), max(_zs)]}
    _faces = 0
else:
    _shape = Part.Shape()
    _shape.read(_p)
    _mesh_ = _mesh(_shape)
    _verts, _tris = _mesh_["verts"], _mesh_["tris"]
    _vol = round(_shape.Volume, 3)
    _bb = _bounds(_shape)
    _faces = len(_shape.Faces)
__out = {
    "ok": True,
    "path": _p,
    "format": ${JSON.stringify(ext)},
    "kind": ${JSON.stringify(meshBranch ? 'mesh' : 'brep')},
    "volume": _vol,
    "triangles": len(_tris) // 3,
    "faces": _faces,
    "bounds": _bb,
    "title": ${JSON.stringify(label)},
    "scene": {
        "parts": [{"id": "p1", "verts": _verts, "tris": _tris, "volume": _vol}],
        "instances": [{"name": ${JSON.stringify(label)}, "part": "p1", "rot": [1,0,0, 0,1,0, 0,0,1], "translate": [0, 0, 0]}],
    },
}
`
    return bridge.run(`${PRELUDE}\n${py}`, { title: label })
  }

  // ---- Agent tools -------------------------------------------------------

  // Every tool call belongs to a session: stamp it on the published scene so
  // the panel's live tab can follow its own session instead of the process.
  const sessionOf = (exec) => {
    const id = exec?.agent?.session?.id ?? exec?.agent?.session?.header?.id ?? ''
    return typeof id === 'string' ? id : ''
  }
  const tool = (definition) => ctx.effect(() => ctx.tools.register({
    ...definition,
    execute: async (args, exec) => {
      const session = sessionOf(exec)
      bridge.currentSession = session
      // A tool is working right now: the panel watches this to show itself on
      // the live tab (and only for the session that is actually running).
      bridge.running = (bridge.running || 0) + 1
      bridge.runningSession = session
      try {
        return await definition.execute(args, exec)
      } finally {
        bridge.running = Math.max(0, (bridge.running || 1) - 1)
        if (!bridge.running) bridge.runningSession = ''
      }
    },
  }))

  tool({
    name: 'cad_studio_env',
    description: 'Report the CAD Studio runtime: whether freecadcmd is available, its path, and the latest published scene.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { available: { type: 'boolean' }, binary: { type: 'string' }, scenes: { type: 'number' }, latest: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async () => bridge.status(),
  })

  tool({
    name: 'cad_studio_legacy',
    description: 'Read the old dsh-cad document store (/app/.dsh-cad, op logs) that cad_studio_doc cannot see: action=list reports every document with its op mix and body count, action=show prints one document\'s op summary and body names. This is read-only; to bring an old model into CAD Studio, export it to STEP once (exports/ already holds the migrated ones) and assemble from the file.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'show'], description: 'list (default) or show.' },
        doc: { type: 'string', description: 'Document id or title (show only).' },
        dir: { type: 'string', description: 'Store directory (default /app/.dsh-cad).' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, documents: { type: 'number' } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async ({ action, doc, dir: storeDir }) => {
      const root = typeof storeDir === 'string' && storeDir ? storeDir : '/app/.dsh-cad'
      const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))
      const summarise = (entry) => {
        const ops = Array.isArray(entry.ops) ? entry.ops : []
        const kinds = {}
        for (const op of ops) kinds[op.kind] = (kinds[op.kind] || 0) + 1
        return { ops: ops.length, kinds, bodies: Array.isArray(entry.bodyNames) ? entry.bodyNames.length : 0 }
      }
      let index = { docs: [] }
      try { index = await readJson(join(root, 'index.json')) } catch {}
      const docs = Array.isArray(index.docs) ? index.docs : []
      const loaded = []
      for (const meta of docs) {
        try {
          const entry = await readJson(join(root, 'docs', `${meta.id}.json`))
          loaded.push({ id: meta.id, title: meta.title ?? '', updatedAt: meta.updatedAt ?? '', ...summarise(entry), entry })
        } catch {
          loaded.push({ id: meta.id, title: meta.title ?? '', updatedAt: meta.updatedAt ?? '', ops: 0, kinds: {}, bodies: 0, missing: true })
        }
      }
      const kind = String(action ?? 'list')
      if (kind === 'list') {
        return {
          ok: true,
          dir: root,
          documents: loaded.length,
          items: loaded.map((d) => ({ id: d.id, title: d.title, updatedAt: d.updatedAt, ops: d.ops, bodies: d.bodies, kinds: d.kinds, ...(d.missing ? { missing: true } : {}) })),
        }
      }
      if (kind === 'show') {
        const key = String(doc ?? '').trim()
        const hit = loaded.find((d) => d.id === key || d.title === key)
        if (!hit) return { ok: false, error: `没有这个文档：${key}（可用 ${loaded.map((d) => d.title || d.id).join(', ') || '（无）'}）` }
        const ops = Array.isArray(hit.entry?.ops) ? hit.entry.ops : []
        // Newest bodies first: booleans target them by id, so this is the order
        // in which a replayer would resolve them.
        const tail = ops.slice(-12).map((op) => ({ kind: op.kind, bodyId: op.bodyId ?? op.target ?? '', name: op.name ?? '', prim: op.prim ?? '' }))
        return { ok: true, id: hit.id, title: hit.title, version: hit.entry?.version ?? null, ops: ops.length, kinds: hit.kinds, bodies: hit.entry?.bodyNames ?? [], tail }
      }
      return { ok: false, error: `不支持的 action：${kind}（list / show）` }
    },
  })

  tool({
    name: 'cad_studio_undo',
    description: 'Undo the last change. scope=auto prefers the assembly stack (joint value, joint add/remove, explode factor), otherwise falls back to the model document stack; pass model for doc scope.',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['auto', 'assembly', 'scene', 'doc'], description: 'default auto' },
        model: { type: 'string', description: 'document name, for doc scope' },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => [{ type: 'text', text: renderUndo(value) }] },
    async execute(args, exec) {
      const scope = typeof args.scope === 'string' ? args.scope : 'auto'
      const kind = scope === 'auto' ? undefined : scope
      const undone = await bridge.undoSession(kind)
      if (undone) return defined({ ok: true, scope: undone.kind, undone: undone.label, assembly: undone.assembly, scene: undone.scene, model: undone.model, remaining: bridge.sessionUndo.length, redo: bridge.sessionRedo.length })
      if (scope !== 'doc') return { ok: false, error: scope === 'assembly' ? '装配层没有可撤销的操作' : scope === 'scene' ? '场景列表没有可撤销的操作' : '没有可撤销的操作' }
      const target = typeof args.model === 'string' && args.model ? args.model : ''
      if (!target) return { ok: false, error: '文档撤销需要 model 名称（可用 cad_studio_doc list 查看）' }
      try {
        const out = await runFeatureAction({ model: target, action: 'undo' }, modelsDirFor(exec))
        return { ok: out?.ok !== false, scope: 'doc', model: target, undone: 'doc', ...out }
      } catch (error) {
        return { ok: false, error: `文档撤销失败：${String(error?.message ?? error)}（脚本模型请用 cad_studio_doc revert）` }
      }
    },
  })

  tool({
    name: 'cad_studio_redo',
    description: 'Redo the last undone change, same scopes as cad_studio_undo.',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['auto', 'assembly', 'scene', 'doc'], description: 'default auto' },
        model: { type: 'string', description: 'document name, for doc scope' },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => [{ type: 'text', text: renderUndo(value) }] },
    async execute(args, exec) {
      const scope = typeof args.scope === 'string' ? args.scope : 'auto'
      const kindR = scope === 'auto' ? undefined : scope
      const redone = await bridge.redoSession(kindR)
      if (redone) return defined({ ok: true, scope: redone.kind, redone: redone.label, assembly: redone.assembly, scene: redone.scene, model: redone.model, remaining: bridge.sessionRedo.length, undo: bridge.sessionUndo.length })
      if (scope !== 'doc') return { ok: false, error: scope === 'assembly' ? '装配层没有可重做的操作' : '没有可重做的操作' }
      const target = typeof args.model === 'string' && args.model ? args.model : ''
      if (!target) return { ok: false, error: '文档重做需要 model 名称' }
      try {
        const out = await runFeatureAction({ model: target, action: 'redo' }, modelsDirFor(exec))
        return { ok: out?.ok !== false, scope: 'doc', model: target, redone: 'doc', ...out }
      } catch (error) {
        return { ok: false, error: `文档重做失败：${String(error?.message ?? error)}（脚本模型请用 cad_studio_doc revert）` }
      }
    },
  })

  tool({
    name: 'cad_studio_scene',
    description: 'Maintain the model list the panel shows (the persisted scene history): action=list / delete / rename. Use delete to clear probe scenes that a measurement run left behind, and rename when a scene title is a file path or a part id.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'delete', 'rename'], description: 'list (default) / delete / rename.' },
        id: { type: 'string', description: 'Scene id, e.g. scene-12. Required for delete and rename.' },
        title: { type: 'string', description: 'New title (rename only).' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, scenes: { type: 'number' } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async ({ action, id, title }) => {
      const kind = String(action ?? 'list')
      // A fresh process starts with an empty in-memory list; the rows live in
      // state.json until the next publish hydrates them.
      await bridge.hydrateHistory()
      if (kind === 'list') {
        const rows = bridge.listSceneRows()
        return { ok: true, scenes: rows.length, latest: bridge.latest ? bridge.latest.id : '', items: rows }
      }
      if (kind === 'delete') return bridge.removeScene(id)
      if (kind === 'rename') return bridge.renameScene(id, title)
      return { ok: false, error: `不支持的 action：${kind}（list / delete / rename）` }
    },
  })

  tool({
    name: 'cad_studio_doctor',
    description: 'Environment self-check for CAD Studio: reports every prerequisite (FreeCAD/OCCT kernel, data directory, disk space, model directory) with what is wrong, what to do about it, and which capabilities are currently available. Run this before blaming a modelling failure on the model.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (args, value) => [{ type: 'text', text: renderDoctor(value) }] },
    execute: async () => {
      const diag = diagnose(bridge, bridge.getConfig())
      return {
        ready: diag.ready,
        kernel: diag.kernel.available ? [diag.kernel.binary, diag.kernel.version].filter(Boolean).join(' · ') : '',
        checks: diag.checks.map((c) => `${c.ok ? 'ok' : (c.required ? 'FAIL' : 'warn')} ${c.label}: ${c.detail}${c.fix ? ` — ${c.fix}` : ''}`),
        capabilities: diag.capabilities,
      }
    },
  })

  tool({
    name: 'cad_studio_setup',
    description: 'Check whether freecadcmd is installed and, when it is missing, install FreeCAD through the system package manager (apt/dnf/pacman/brew). action=check reports binary, version, package manager and the exact command; action=install runs it (needs root on apt) and re-probes afterwards.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['check', 'install'], description: 'check (default) or install.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          available: { type: 'boolean' },
          binary: { type: 'string' },
          version: { type: 'string' },
          packageManager: { type: 'string' },
          command: { type: 'string' },
          canInstall: { type: 'boolean' },
          reason: { type: 'string' },
          installed: { type: 'boolean' },
          alreadyInstalled: { type: 'boolean' },
          log: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async (args) => {
      if ((args.action || 'check') === 'install') {
        const out = installFreeCad(bridge)
        const clean = { ...out }
        for (const key of ['log', 'reason']) if (!clean[key]) delete clean[key]
        clean.installed = Boolean(clean.available) && !clean.alreadyInstalled
        return clean
      }
      const out = setupStatus(bridge)
      const clean = { ...out }
      if (!clean.reason) delete clean.reason
      return clean
    },
  })

  tool({
    name: 'cad_studio_run',
    description: 'Run a FreeCAD Python script in freecadcmd headless. Bind the shape to show to a variable named `scene` (e.g. `scene = Part.makeBox(80,40,10)`) — it is tessellated and published to the CAD Studio panel; the result reports sceneId and published. Put extra data in the `__out` dict (or `__out["scene"]` for full control of parts/instances/colors). Measurement/verification scripts should pass publish:false — otherwise every probe becomes a row in the model list.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'FreeCAD Python source. Import Part/Import yourself; helpers describe(path)/_mesh(shape) are preloaded.' },
        title: { type: 'string', description: 'Panel title for the published scene.' },
        publish: { type: 'boolean', description: 'Publish the bound shape as a panel scene (default true). Pass false for a probe that only measures.' },
        check: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files the script wrote: each is re-read after the run and reported as {path, exists, bytes, solids, volume, valid}. A 1.6 KB STEP shell shows up here as valid:false instead of passing silently.',
        },
      },
      required: ['code'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, sceneId: { type: 'string' }, stderr: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async (args) => {
      const files = Array.isArray(args.check) ? args.check.filter((x) => typeof x === 'string' && x) : []
      const guard = files.length
        ? `
# Re-read what the script wrote: FreeCAD's Part.export on a compound can emit a
# 1.6 KB STEP that parses back as a null shape, and the call still returns ok.
import os as _os
_checks = []
for _p in ${JSON.stringify(files)}:
    _e = {"path": _p, "exists": _os.path.isfile(_p)}
    if _e["exists"]:
        _e["bytes"] = _os.path.getsize(_p)
        try:
            if _p.lower().rsplit(".", 1)[-1] in ("step", "stp", "brep", "iges", "igs"):
                _s = Part.Shape()
                _s.read(_p)
                _e["solids"] = len(_s.Solids)
                _e["volume"] = round(float(_s.Volume), 3)
                _e["valid"] = bool(_s.Solids) and float(_s.Volume) > 0.0
            else:
                _e["valid"] = _e["bytes"] > 200
        except Exception as _err:
            _e["valid"] = False
            _e["error"] = str(_err)
    else:
        _e["valid"] = False
    _checks.append(_e)
__out = dict(globals().get("__out") or {})
__out["files"] = _checks
`
        : ''
      const out = await bridge.run(`${PRELUDE}\n${args.code}\n${guard}`, {
        title: args.title,
        publish: args.publish !== false,
      })
      if (args.publish === false && out && typeof out === 'object') {
        // The script may still have bound `scene`; make the contract explicit.
        out.published = false
      }
      return out
    },
  })

  tool({
    name: 'cad_studio_open',
    description: 'Open a STEP/STP/BREP/FCStd file, report its geometry, and publish it to the CAD Studio panel.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute path of the model file.' } },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, sceneId: { type: 'string' }, volume: { type: 'number' }, triangles: { type: 'number' } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async (args) => openPath(args.path),
  })

  // ---- Artifact tools (export / drawing / measure / assembly) -------------

  const extOf = (p) => (/\.[A-Za-z0-9]+$/.exec(p ?? '')?.[0].slice(1).toLowerCase() ?? '')

  /** Python lines that leave the source shapes in `_shapes`. */
  const shapesFrom = ({ source, code }) => {
    if (source) {
      if (extOf(source) === 'stl') {
        return `import Mesh, MeshPart
_mesh = Mesh.Mesh(${JSON.stringify(source)})
_shapes = [Part.Shape().makeShapeFromMesh(_mesh.Topology, 0.05)]
`
      }
      return `_src = Part.Shape()
_src.read(${JSON.stringify(source)})
_shapes = [_src]
`
    }
    return `${code}
_shapes = []
for _name in ("export_shapes", "shapes"):
    _v = globals().get(_name)
    if isinstance(_v, (list, tuple)) and _v:
        _shapes = list(_v)
        break
if not _shapes:
    for _name in ("scene", "shape", "result", "part"):
        _c = globals().get(_name)
        if _c is not None and hasattr(_c, "tessellate"):
            _shapes = [_c]
            break
`
  }

  const writeShapeFile = (target, src, opts = {}) => {
    const minVolume = Number.isFinite(opts.minVolume) && opts.minVolume > 0 ? Number(opts.minVolume) : 0
    const alsoStl = Boolean(opts.alsoStl)
    const py = `${PRELUDE}
${src}
if not _shapes:
    __out = {"ok": False, "error": "nothing to export: pass a source path or bind scene / export_shapes"}
else:
    import os
    _target = ${JSON.stringify(target)}
    _fmt = _target.rsplit(".", 1)[-1].lower()
    os.makedirs(os.path.dirname(_target) or ".", exist_ok=True)
    # Flatten to solids so a volume threshold can drop dust (round wires, tiny
    # fillets) that would otherwise dominate the file size.
    _solids = []
    for _s in _shapes:
        _solids.extend(list(_s.Solids) or [_s])
    _minv = ${minVolume}
    _kept = [x for x in _solids if x.Volume >= _minv] if _minv > 0 else _solids
    if not _kept:
        raise RuntimeError("no solids left after minVolume=%.3f (smallest %.3f)" % (_minv, min((x.Volume for x in _solids), default=0.0)))
    _shapes = _kept
    if _fmt in ("step", "stp"):
        # Part.export([shape]) writes a 1.6 KB STEP that reads back as a NULL shape;
        # Shape.exportStep / compound exportStep is the API that produces a valid file.
        Part.makeCompound(_shapes).exportStep(_target)
    elif _fmt == "brep":
        _shapes[0].exportBrep(_target)
    elif _fmt in ("iges", "igs"):
        Part.makeCompound(_shapes).exportIges(_target)
    elif _fmt == "stl":
        # Mesh.export rejects doc-less meshes in FreeCAD 0.20, so emit ASCII STL here.
        _lines = []
        for _s in _shapes:
            _verts, _facets = _s.tessellate(0.2)
            _lines.append("solid cad_studio")
            for _f in _facets:
                _a, _b, _c = (_verts[i] for i in _f)
                _lines.append("facet normal 0 0 0\\n outer loop")
                for _p in (_a, _b, _c):
                    _lines.append("  vertex %r %r %r" % (_p.x, _p.y, _p.z))
                _lines.append(" endloop\\nendfacet")
            _lines.append("endsolid cad_studio")
        open(_target, "w").write("\\n".join(_lines) + "\\n")
    else:
        raise RuntimeError("unsupported export format: ." + _fmt + " (use .step/.stp/.brep/.iges/.igs/.stl)")
    _stl = None
    if ${alsoStl ? 'True' : 'False'}:
        _stl = os.path.splitext(_target)[0] + ".stl"
        _lines = []
        for _s in _shapes:
            _verts, _facets = _s.tessellate(0.2)
            for _f in _facets:
                _a, _b, _c = (_verts[i] for i in _f)
                _lines.append("facet normal 0 0 0\\n outer loop")
                for _p in (_a, _b, _c):
                    _lines.append("  vertex %r %r %r" % (_p.x, _p.y, _p.z))
                _lines.append(" endloop\\nendfacet")
        open(_stl, "w").write("solid cad_studio\\n" + "\\n".join(_lines) + "\\nendsolid cad_studio\\n")
    __out = {"ok": True, "path": _target, "format": _fmt, "bytes": os.path.getsize(_target),
             "solids": len(_shapes), "volume": round(sum(float(x.Volume) for x in _shapes), 3),
             "sourceSolids": len(_solids), "sourceVolume": round(sum(float(x.Volume) for x in _solids), 3),
             "filtered": len(_solids) - len(_shapes)}
    if _stl:
        __out["stl"] = {"path": _stl, "bytes": os.path.getsize(_stl)}
`
    return bridge.run(py, { title: `export → ${target}`, publishHint: false })
  }

  tool({
    name: 'cad_studio_export',
    description: 'Export geometry to STEP/STP/BREP/IGES/STL. Give either `source` (an existing model file) or `code` (FreeCAD Python that binds `scene` or `export_shapes`).',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Absolute output path; the extension picks the format (.step/.stp/.brep/.iges/.igs/.stl).' },
        source: { type: 'string', description: 'Existing model file to export (STEP/IGES/BREP/STL).' },
        code: { type: 'string', description: 'FreeCAD Python that produces the geometry; bind `scene` or `export_shapes`.' },
        model: { type: 'string', description: 'Export a saved model document by name (feature or script model) instead of a file or a script.' },
        minVolume: { type: 'number', description: 'Drop solids smaller than this (mm³). Use it to keep round wires and dust out of a print file; the return says how many were filtered.' },
        alsoStl: { type: 'boolean', description: 'Also write an STL next to the target (a light file for viewers that do not read STEP).' },
      },
      required: ['target'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, path: { type: 'string' }, bytes: { type: 'number' } } },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    execute: async ({ target, source, code, model, minVolume, alsoStl }) => {
      if (!target || extOf(target) === '') return { ok: false, error: 'target must be an absolute path with an extension' }
      if (typeof model === 'string' && model) {
        const dirs = bridge.modelsCandidates()
        const dir = dirs.find((d) => existsSync(join(d, `${model}.json`))) || dirs[0]
        const doc = await readModel(model, dir)
        bridge.noteModelsDir(dir)
        const exported = await exportModelStep(doc, target)
        return { ...exported, source: `model:${model}` }
      }
      const src = shapesFrom({ source, code })
      if (!src) return { ok: false, error: 'pass either source (a model file) or code (FreeCAD Python)' }
      const out = await writeShapeFile(target, src, { minVolume, alsoStl })
      // Keep the two numbers apart on purpose: `volume` is what was written,
      // `sourceVolume` is what the input held. Mixing them is how a batch export
      // gets mistaken for the part it produced.
      return { ...out, source: typeof source === 'string' ? source : '' }
    },
  })

  tool({
    name: 'cad_studio_drawing',
    description: 'Write a first-angle engineering drawing (top / front / right HLR views) as SVG. Give either `source` (STEP/IGES/BREP) or `code`.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Absolute .svg output path.' },
        source: { type: 'string', description: 'Existing BRep model file (STEP/IGES/BREP).' },
        code: { type: 'string', description: 'FreeCAD Python that binds `scene` or `export_shapes`.' },
        views: { type: 'array', items: { type: 'string' }, description: 'Subset of ["top","front","right"] (default all three).' },
        scale: { type: 'number', description: 'Drawing scale (default 1.0).' },
      },
      required: ['target'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, path: { type: 'string' }, views: { type: 'array', items: { type: 'string' } } } },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    execute: async ({ target, source, code, views, scale }) => {
      const src = shapesFrom({ source, code })
      if (!src) return { ok: false, error: 'pass either source (a model file) or code (FreeCAD Python)' }
      const wanted = Array.isArray(views) && views.length ? views : ['top', 'front', 'right']
      const py = `${PRELUDE}
${src}
import os, TechDraw
_dirs = {"top": (0, 0, 1), "front": (0, -1, 0), "right": (1, 0, 0)}
_scale = float(${Number(scale) || 1})
if not _shapes:
    __out = {"ok": False, "error": "nothing to draw: pass a source path or bind scene / export_shapes"}
else:
    _shape = _shapes[0]
    _bb = _shape.BoundBox
    _w, _h, _d = _bb.XLength, _bb.YLength, _bb.ZLength
    _wanted = [v for v in ${JSON.stringify(wanted)} if v in _dirs] or ["top", "front", "right"]
    # Sheet layout: top view above, front below-left, right to its right.
    _gap = 20.0
    _top = _bb.XLength, _bb.YLength
    _front = _bb.XLength, _bb.ZLength
    _right = _bb.YLength, _bb.ZLength
    _cells = {"top": (0.0, 0.0, _top), "front": (0.0, _top[1] + _gap, _front), "right": (_front[0] + _gap, _top[1] + _gap, _right)}
    _sheet_w = max(c[0] + c[2][0] for c in _cells.values()) * _scale + 2 * _gap
    _sheet_h = max(c[1] + c[2][1] for c in _cells.values()) * _scale + 2 * _gap
    _body = []
    for _v in _wanted:
        _dx, _dy, _size = _cells[_v]
        _frag = TechDraw.projectToSVG(_shape, FreeCAD.Vector(*_dirs[_v]))
        _body.append('<g transform="translate(%r %r) scale(%r)">%s</g>' % (
            _gap + _dx * _scale, _gap + _dy * _scale, _scale, _frag))
    _svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="%rmm" height="%rmm" viewBox="0 0 %r %r">'
            '<rect width="100%%" height="100%%" fill="white"/>'
            '<g transform="translate(0 %r) scale(1 -1)" stroke="#111" stroke-width="0.3" fill="none">%s</g></svg>'
            ) % (_sheet_w, _sheet_h, _sheet_w, _sheet_h, _sheet_h, "".join(_body))
    os.makedirs(os.path.dirname(${JSON.stringify(target)}) or ".", exist_ok=True)
    open(${JSON.stringify(target)}, "w").write(_svg)
    __out = {"ok": True, "path": ${JSON.stringify(target)}, "bytes": os.path.getsize(${JSON.stringify(target)}),
             "views": _wanted, "sheet_mm": [round(_sheet_w, 1), round(_sheet_h, 1)]}
`
      return bridge.run(py, { title: `drawing → ${target}`, publishHint: false })
    },
  })

  tool({
    name: 'cad_studio_measure',
    description: 'Measure a model: volume, surface area, bounding box, centroid, face/edge counts, and optionally the distance between two points.',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Existing model file (STEP/IGES/BREP/STL).' },
        code: { type: 'string', description: 'FreeCAD Python that binds `scene` or `export_shapes`.' },
        from: { type: 'array', items: { type: 'number' }, description: 'First point [x,y,z] for a distance measurement.' },
        to: { type: 'array', items: { type: 'number' }, description: 'Second point [x,y,z].' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, volume: { type: 'number' }, area: { type: 'number' } } },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    execute: async ({ source, code, from, to }) => {
      if (!source && !code) return { ok: false, error: 'pass either source (a model file) or code (FreeCAD Python)' }
      const src = shapesFrom({ source, code })
      const pair = Array.isArray(from) && Array.isArray(to) && from.length === 3 && to.length === 3
      const py = `${PRELUDE}
${src}
if not _shapes:
    __out = {"ok": False, "error": "nothing to measure"}
else:
    _s = _shapes[0]
    _bb = _s.BoundBox
    _c = getattr(_s, "CenterOfMass", None) or _bb.Center
    __out = {
        "ok": True,
        "volume": round(sum(x.Volume for x in _shapes), 3),
        "area": round(sum(x.Area for x in _shapes), 3),
        "bounds": {"x": [round(_bb.XMin, 3), round(_bb.XMax, 3)], "y": [round(_bb.YMin, 3), round(_bb.YMax, 3)], "z": [round(_bb.ZMin, 3), round(_bb.ZMax, 3)]},
        "size": [round(_bb.XLength, 3), round(_bb.YLength, 3), round(_bb.ZLength, 3)],
        "centroid": [round(_c.x, 3), round(_c.y, 3), round(_c.z, 3)],
        "faces": sum(len(x.Faces) for x in _shapes),
        "edges": sum(len(x.Edges) for x in _shapes),
    }
${pair ? `    __out["distance"] = round((FreeCAD.Vector(${JSON.stringify(from)}) - FreeCAD.Vector(${JSON.stringify(to)})).Length, 3)` : ''}
`
      return bridge.run(py, { title: 'measure', publishHint: false })
    },
  })

  // ---- Declarative features: the common jobs without writing Python ------
  // A list of ops applied in order. `run` stays the escape hatch; this is the
  // path for "60×40×20 的盒子挖个 φ16 通孔、倒 2mm 圆角".

  const FEATURE_KINDS = ['box', 'cylinder', 'sphere', 'cone', 'torus', 'extrude', 'revolve', 'fuse', 'cut', 'common', 'fillet', 'chamfer', 'shell', 'pattern_linear', 'pattern_circular', 'translate', 'rotate', 'mirror']

  tool({
    name: 'cad_studio_feature',
    description: `Build a part from a list of declarative ops (no Python needed), publish it and optionally export STEP. Kinds: ${FEATURE_KINDS.join(', ')}. Ops run in order; the first primitive starts the body, later ones fuse into it, and fillet/chamfer/shell/pattern/translate/rotate/mirror rewrite it.`,
    parameters: {
      type: 'object',
      properties: {
        ops: {
          type: 'array',
          description: `Ordered ops. Examples — box {kind:"box",size:[60,40,20],at?}; cylinder {kind:"cylinder",r,h,at?,axis?}; cone {kind:"cone",r1?,r2,h,at?,axis?}; sphere {kind:"sphere",r,at?}; torus {kind:"torus",r1,r2,at?}; cut/fuse/common {kind:"cut",with:<primitive op>}; fillet {kind:"fillet",r}; chamfer {kind:"chamfer",d}; shell {kind:"shell",t,open?:"none"|"top"|"bottom"}; pattern_linear {kind:"pattern_linear",delta:[dx,dy,dz],count}; pattern_circular {kind:"pattern_circular",axis?,at?,angle?,count}; translate {kind:"translate",v:[x,y,z]}; rotate {kind:"rotate",axis?,at?,deg}; mirror {kind:"mirror",normal?,at?}.`,
          items: { type: 'object' },
        },
        title: { type: 'string', description: 'Panel title for the published scene.' },
        export: { type: 'string', description: 'Optional .step/.stp path to also write the result.' },
        sketches: { type: 'object', description: 'Sketches by name: {S1:{geometry:[{id,type,...}],constraints:[{id,type,...}]}}. A feature extrudes one with {kind:"extrude",sketch:"S1"}.' },
      },
      required: ['ops'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, sceneId: { type: 'string' }, volume: { type: 'number' }, features: { type: 'number' } } },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    execute: async ({ ops, title, sketches, export: exportPath }) => {
      if (!Array.isArray(ops) || !ops.length) return { ok: false, error: 'ops 不能为空：至少给一个图元' }
      const unknown = ops.find((op) => !op || !FEATURE_KINDS.includes(op.kind))
      if (unknown) return { ok: false, error: `不支持的特征：${unknown?.kind ?? '(空)'}（可用 ${FEATURE_KINDS.join(' / ')}）` }
      const py = featuresScript(ops, exportPath, { sketches })
      return bridge.run(py, { title: title ?? 'feature' })
    },
  })

  tool({
    name: 'cad_studio_assembly',
    description: 'Assemble parts by file reference (STEP/IGES/BREP), publish the assembly to the panel, and optionally export it as one STEP. Each part file is read once; instances share the same geometry.',
    parameters: {
      type: 'object',
      properties: {
        parts: {
          type: 'array',
          description: 'Unique part files: [{name, path}].',
          items: { type: 'object', properties: { name: { type: 'string' }, path: { type: 'string' }, color: { type: 'array', items: { type: 'number' } } }, required: ['name', 'path'] },
        },
        instances: {
          type: 'array',
          description: 'Placements: [{name, part, at:[x,y,z], rot?:[rx,ry,rz] degrees}].',
          items: { type: 'object', properties: { name: { type: 'string' }, part: { type: 'string' }, at: { type: 'array', items: { type: 'number' } }, rot: { type: 'array', items: { type: 'number' } } }, required: ['name', 'part'] },
        },
        target: { type: 'string', description: 'Optional .step/.stp output path for the whole assembly.' },
        title: { type: 'string', description: 'Panel title.' },
        measure: { type: 'boolean', description: 'Return per-instance bbox / volume / solid count, and the total volume.' },
        interference: { type: 'boolean', description: 'Return the instance pairs that actually overlap (bbox prefilter, then a boolean common).' },
        assembly: { type: 'string', description: 'Assembly label for cad_studio_joint / cad_studio_drive / cad_studio_explode (defaults to the title).' },
        joints: {
          type: 'array',
          description: 'Joints to declare up front: [{id?, instance, type:"revolute"|"linear"|"cylindrical"|"planar"|"ball", axis?, origin?, value?, min?, max?}]. Rotating about the instance centre is the default; pass origin for a hinge.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              instance: { type: 'string' },
              type: { type: 'string', enum: ['revolute', 'linear', 'cylindrical', 'planar', 'ball'] },
              axis: { type: 'array', items: { type: 'number' } },
              origin: { type: 'array', items: { type: 'number' } },
              value: { type: 'number' },
              min: { type: 'number' },
              max: { type: 'number' },
            },
            required: ['instance'],
          },
        },
      },
      required: ['parts', 'instances'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, sceneId: { type: 'string' }, instances: { type: 'number' }, assembly: { type: 'string' } } },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    execute: async ({ parts, instances, target, title, assembly, joints, measure, interference }) => {
      if (!Array.isArray(parts) || !parts.length) return { ok: false, error: 'parts must be a non-empty array' }
      if (!Array.isArray(instances) || !instances.length) return { ok: false, error: 'instances must be a non-empty array' }
      // Only referenced parts are read and tessellated: an export set often
      // carries bodies no instance places, and pushing those into the scene
      // bloats the payload and mislabels the part count.
      const referenced = new Set(instances.map((i) => i.part))
      const missing = [...referenced].filter((name) => !parts.some((p) => p.name === name))
      if (missing.length) return { ok: false, error: `instances reference unknown parts: ${missing.slice(0, 5).join(', ')}` }
      const used = parts.filter((p) => referenced.has(p.name))
      const py = `${PRELUDE}
import os
_PART_FILES = ${JSON.stringify(used.map((p) => (p.color ? { name: p.name, path: p.path, color: p.color } : { name: p.name, path: p.path })))}
_INSTS = ${JSON.stringify(instances.map((i) => ({ name: i.name, part: i.part, at: i.at ?? [0, 0, 0], rot: i.rot ?? [0, 0, 0] })))}
_TARGET = ${target ? JSON.stringify(target) : 'None'}

_shapes = {}
_parts = []
for _p in _PART_FILES:
    if not os.path.isfile(_p["path"]):
        raise RuntimeError("part file not found: " + _p["path"])
    _s = Part.Shape()
    _s.read(_p["path"])
    _shapes[_p["name"]] = _s
    _m = _mesh(_s)
    _part = {"id": _p["name"], "verts": _m["verts"], "tris": _m["tris"], "volume": round(_s.Volume, 3)}
    if "color" in _p and _p["color"]:
        _part["color"] = _p["color"]
    _parts.append(_part)

_placed = []
_instances = []
for _i in _INSTS:
    if _i["part"] not in _shapes:
        raise RuntimeError("instance '" + _i["name"] + "' references unknown part '" + _i["part"] + "'")
    _rx, _ry, _rz = _i["rot"]
    _R = FreeCAD.Rotation(FreeCAD.Vector(0, 0, 1), _rz) * FreeCAD.Rotation(FreeCAD.Vector(0, 1, 0), _ry) * FreeCAD.Rotation(FreeCAD.Vector(1, 0, 0), _rx)
    _ax = _R.multVec(FreeCAD.Vector(1, 0, 0))
    _ay = _R.multVec(FreeCAD.Vector(0, 1, 0))
    _az = _R.multVec(FreeCAD.Vector(0, 0, 1))
    _rot = [_ax.x, _ay.x, _az.x, _ax.y, _ay.y, _az.y, _ax.z, _ay.z, _az.z]
    _instances.append({"name": _i["name"], "part": _i["part"], "rot": _rot, "translate": [float(c) for c in _i["at"]]})
    _copy = _shapes[_i["part"]].copy()
    _copy.Placement = FreeCAD.Placement(FreeCAD.Vector(*_i["at"]), _R)
    _placed.append(_copy)

_MEASURE = ${measure ? 'True' : 'False'}
_INTERF = ${interference ? 'True' : 'False'}

__out = {"ok": True, "instances": len(_instances), "parts": len(_parts),
         "scene": {"parts": _parts, "instances": _instances}}

if _MEASURE:
    # Per-instance numbers, so "how big is this part, and does it fit" is one
    # call instead of an export plus a re-import.
    _rows = []
    for _k, _inst in enumerate(_INSTS):
        _s = _placed[_k]
        _bb = _s.BoundBox
        _rows.append({
            "name": _inst["name"], "part": _inst["part"],
            "volume": round(float(_s.Volume), 3), "solids": len(_s.Solids),
            "bounds": {"min": [round(_bb.XMin, 3), round(_bb.YMin, 3), round(_bb.ZMin, 3)],
                       "max": [round(_bb.XMax, 3), round(_bb.YMax, 3), round(_bb.ZMax, 3)]},
        })
    _box = Part.makeCompound(_placed).BoundBox
    __out["measure"] = {
        "instances": _rows,
        "totalVolume": round(sum(r["volume"] for r in _rows), 3),
        "bounds": {"min": [round(_box.XMin, 3), round(_box.YMin, 3), round(_box.ZMin, 3)],
                   "max": [round(_box.XMax, 3), round(_box.YMax, 3), round(_box.ZMax, 3)]},
    }

if _INTERF:
    # Bounding boxes first: a boolean common on every pair of a 30-solid
    # assembly is minutes of work for answers that are mostly zero.
    _pairs = []
    for _i in range(len(_placed)):
        for _j in range(_i + 1, len(_placed)):
            _a, _b = _placed[_i], _placed[_j]
            if not _a.BoundBox.intersect(_b.BoundBox):
                continue
            try:
                _c = _a.common(_b)
                _v = float(_c.Volume) if (_c is not None and not _c.isNull()) else 0.0
            except Exception:
                _v = 0.0
            if _v > 1e-3:
                _pairs.append({"a": _INSTS[_i]["name"], "b": _INSTS[_j]["name"], "volume": round(_v, 3)})
    __out["interference"] = _pairs
if _TARGET:
    os.makedirs(os.path.dirname(_TARGET) or ".", exist_ok=True)
    Part.makeCompound(_placed).exportStep(_TARGET)
    __out["exported"] = _TARGET
    __out["bytes"] = os.path.getsize(_TARGET)
`
      // Allocate the assembly id before publishing: the scene carries `asm:<id>`
      // so later joint moves rewrite this same entry instead of adding one.
      const asmId = bridge.reserveAssemblyId()
      const out = await bridge.run(py, { title: title ?? 'assembly', docKey: `asm:${asmId}` })
      if (!out.ok || !out.sceneId) return out
      // Keep the base placements: without them a joint has nothing to move.
      const scene = bridge.scenes.get(out.sceneId)
      if (!scene) return out
      const record = bridge.registerAssembly({ id: asmId, title: assembly || title || 'assembly', sceneId: out.sceneId, scene, joints: [] })
      for (const spec of joints ?? []) {
        try {
          bridge.setJoint(record, spec)
        } catch (error) {
          out.jointWarning = String(error?.message ?? error)
        }
      }
      scene.assembly = {
        id: record.id,
        title: record.title,
        explode: 0,
        joints: record.joints.map((j) => ({ id: j.id, instance: j.instance, type: j.type, value: round6(j.value), min: round6(j.min), max: round6(j.max) })),
      }
      await bridge.persist()
      out.assembly = record.id
      out.joints = record.joints.length
      return out
    },
  })

  // ---- Joints, motion and exploded views ---------------------------------
  // A joint is a rigid transform applied on top of an instance's base
  // placement, so motion never touches the geometry: re-placing is a matrix
  // multiply, and the panel can drive it frame by frame.

  const findAssembly = (id) => {
    const key = typeof id === 'string' ? id.trim() : ''
    if (key && bridge.assemblies.has(key)) return bridge.assemblies.get(key)
    // Convenience: a unique title, or the newest assembly when none is given.
    const all = [...bridge.assemblies.values()]
    if (key) {
      const byTitle = all.filter((a) => a.title === key)
      if (byTitle.length === 1) return byTitle[0]
      throw new Error(`没有这个装配：${key}（可用 ${all.map((a) => a.id).join(', ') || '（无）'}）`)
    }
    if (!all.length) throw new Error('还没有装配：先 cad_studio_assembly 建一个')
    return all[all.length - 1]
  }

  tool({
    name: 'cad_studio_joint',
    description: 'Declare, list or remove joints on a published assembly. A revolute joint rotates its instance about (axis, origin); a linear joint slides it along axis. Driving a joint republishes the scene.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['set', 'list', 'remove'], description: 'Default: set.' },
        assembly: { type: 'string', description: 'Assembly id (asm-1) or its label. Default: newest.' },
        joint: { type: 'string', description: 'Joint id for remove.' },
        instance: { type: 'string', description: 'Instance name the joint moves (set).' },
        type: { type: 'string', enum: ['revolute', 'linear', 'cylindrical', 'planar', 'ball'], description: 'Default: revolute. cylindrical rotates and holds a fixed slide; planar/ball drive one number too (documented limitation).' },
        axis: { type: 'array', items: { type: 'number' }, description: 'Rotation/slide axis in world space. Default [0,0,1] revolute / [1,0,0] linear.' },
        origin: { type: 'array', items: { type: 'number' }, description: 'Point the rotation axis passes through. Default: the instance centre.' },
        value: { type: 'number', description: 'Current value in degrees (revolute) or mm (linear).' },
        min: { type: 'number' },
        max: { type: 'number' },
        id: { type: 'string', description: 'Joint id (default revolute-1 / linear-1).' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, assembly: { type: 'string' }, sceneId: { type: 'string' } } },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    execute: async ({ action, assembly, joint, ...spec }) => {
      let record
      try {
        record = findAssembly(assembly)
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) }
      }
      const mode = action ?? 'set'
      if (mode === 'list') {
        return {
          ok: true,
          assembly: record.id,
          title: record.title,
          sceneId: record.sceneId,
          explode: record.explode,
          joints: record.joints.map((j) => ({ id: j.id, instance: j.instance, type: j.type, axis: j.axis.map(round6), origin: j.origin.map(round6), value: round6(j.value), min: round6(j.min), max: round6(j.max) })),
        }
      }
      if (mode === 'remove') {
        const before = record.joints.length
        const editRm = bridge.beginAssemblyEdit(record, 'joint remove')
        record.joints = record.joints.filter((j) => j.id !== joint && j !== joint)
        if (record.joints.length === before) return { ok: false, error: `没有这个关节：${joint ?? '(未指定)'}` }
        const published = await bridge.republishAssembly(record)
        bridge.endAssemblyEdit(editRm, record)
        return { ok: true, assembly: record.id, removed: joint, sceneId: published.id, joints: record.joints.length }
      }
      const edit = bridge.beginAssemblyEdit(record, 'joint')
      let stored
      try {
        stored = bridge.setJoint(record, { ...spec, id: spec.id })
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) }
      }
      const published = await bridge.republishAssembly(record)
      bridge.endAssemblyEdit(edit, record)
      return {
        ok: true,
        assembly: record.id,
        sceneId: published.id,
        joint: { id: stored.id, instance: stored.instance, type: stored.type, axis: stored.axis.map(round6), origin: stored.origin.map(round6), value: round6(stored.value), min: round6(stored.min), max: round6(stored.max) },
        joints: record.joints.length,
      }
    },
  })

  tool({
    name: 'cad_studio_drive',
    description: 'Drive a joint to a new value (degrees for revolute, mm for linear) and republish the assembly scene. This is the motion step: the geometry is untouched, only instance placements are re-solved.',
    parameters: {
      type: 'object',
      properties: {
        assembly: { type: 'string' },
        joint: { type: 'string', description: 'Joint id. Default: the assembly\'s first joint.' },
        value: { type: 'number', description: 'New value (clamped to the joint range).' },
      },
      required: ['value'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, sceneId: { type: 'string' }, value: { type: 'number' } } },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    execute: async ({ assembly, joint, value }) => {
      let record
      try {
        record = findAssembly(assembly)
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) }
      }
      if (!record.joints.length) return { ok: false, error: '这个装配还没有关节：先 cad_studio_joint set 建一个' }
      const id = joint ?? record.joints[0].id
      const edit = bridge.beginAssemblyEdit(record, 'drive')
      const moved = bridge.driveJoint(record, id, value)
      if (!moved) return { ok: false, error: `没有这个关节：${id}（现有 ${record.joints.map((j) => j.id).join(', ')}）` }
      const published = await bridge.republishAssembly(record)
      bridge.endAssemblyEdit(edit, record)
      return {
        ok: true,
        assembly: record.id,
        sceneId: published.id,
        joint: moved.id,
        instance: moved.instance,
        value: round6(moved.value),
        instances: published.stats.instances,
        volume: round6(published.stats.volume),
      }
    },
  })

  tool({
    name: 'cad_studio_explode',
    description: 'Exploded view: push every instance radially away from the assembly centre by `factor` (0 = assembled, 0.5 = half the distance outward). Republished scene only — geometry and exports are untouched.',
    parameters: {
      type: 'object',
      properties: {
        assembly: { type: 'string' },
        factor: { type: 'number', description: '0 assembled … 4 fully exploded. Default 1.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, sceneId: { type: 'string' }, explode: { type: 'number' } } },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    execute: async ({ assembly, factor }) => {
      let record
      try {
        record = findAssembly(assembly)
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) }
      }
      const edit = bridge.beginAssemblyEdit(record, 'explode')
      const next = bridge.setExplode(record, factor ?? 1)
      if (next === null) return { ok: false, error: 'factor 必须是数字' }
      const published = await bridge.republishAssembly(record)
      bridge.endAssemblyEdit(edit, record)
      return { ok: true, assembly: record.id, sceneId: published.id, explode: round6(next), instances: published.stats.instances }
    },
  })


  // ---- Model documents: the state that makes "chat and draw" incremental ----
  // A model is {name, params, script, history}. Every rebuild replays the same
  // script against the current params, so "把高度改成 120" is a one-field edit
  // instead of the agent re-sending (and me re-deriving) the whole script.

  const MODEL_NAME = /^[\p{L}\p{N}_-]{1,60}$/u
  const modelFile = (name, dir) => join(dir, `${name}.json`)

  const checkName = (raw) => {
    const value = String(raw ?? '').trim()
    if (!MODEL_NAME.test(value)) {
      throw new Error('模型名只能用中英文、数字、下划线或连字符（1–60 字）')
    }
    return value
  }

  const readModel = async (name, dir) => {
    const key = checkName(name)
    let text
    try {
      text = await readFile(modelFile(key, dir), 'utf8')
    } catch {
      throw new Error(`没有这个模型：${key}（可先 cad_studio_doc list 看看有哪些）`)
    }
    const doc = JSON.parse(text)
    doc.params = doc.params && typeof doc.params === 'object' ? doc.params : {}
    doc.history = Array.isArray(doc.history) ? doc.history : []
    // Two document shapes share one file format: a Python script with params, or
    // a declarative feature list. Older files predate the field and are scripts.
    doc.kind = doc.kind === 'features' ? 'features' : 'script'
    doc.features = Array.isArray(doc.features) ? doc.features : []
    // Schema 2 keeps the list under `graph.nodes`; `features` stays the in-memory
    // name so every caller keeps working. Reading an old file migrates it.
    if (doc.graph && Array.isArray(doc.graph.nodes)) doc.features = doc.graph.nodes
    doc.schema = 2
    // Named dimensions/expressions (schema 2): only finite numbers survive.
    doc.vars = doc.vars && typeof doc.vars === 'object' && !Array.isArray(doc.vars)
      ? Object.fromEntries(Object.entries(doc.vars).filter(([, v]) => Number.isFinite(v)))
      : {}
    doc.tip = typeof doc.tip === 'string' && doc.tip ? doc.tip : null
    doc.undo = Array.isArray(doc.undo) ? doc.undo : []
    doc.redo = Array.isArray(doc.redo) ? doc.redo : []
    for (const f of doc.features) {
      if (!f || typeof f !== 'object') continue
      if (typeof f.suppressed === 'boolean') f.enabled = f.suppressed !== true
      // Older docs picked up a stray params.suppressed from a normalizer bug;
      // it changed the op hash for no geometric reason, so drop it on read.
      if (f.params && typeof f.params === 'object' && 'suppressed' in f.params) delete f.params.suppressed
    }
    return doc
  }

  const writeModel = async (doc, dir) => {
    await mkdir(dir, { recursive: true })
    doc.schema = 2
    // Only feature documents have a graph; a script document is code-not-data.
    if (Array.isArray(doc.features)) {
      doc.graph = { tip: doc.tip ?? null, nodes: doc.features }
      for (const f of doc.features) f.suppressed = f.enabled === false
    }
    const body = JSON.stringify(doc, null, 2)
    await writeFile(modelFile(doc.name, dir), body, 'utf8')
    return doc
  }

  /** Public view of a feature list: what the panel renders as editable rows. */
  const publicFeatures = (doc) => doc.features.map((f) => ({
    id: f.id,
    kind: f.kind,
    label: f.label ?? '',
    params: f.params ?? {},
    enabled: f.enabled !== false,
    suppressed: f.enabled === false,
  }))

  /** Feature objects to flat ops (`{kind, ...params}`) for the Python emitter. */
  /**
   * Nodes to evaluate, in order, honouring `tip` (rollback bar) and suppression.
   *
   * A suppressed node is not "skip and keep going": everything after it was
   * built on a shape that no longer exists, so evaluation stops there and the
   * rest is reported as blocked. This mirrors FreeCAD/Onshape rather than
   * silently computing against the wrong shape.
   */
  const featureOps = (doc, { stopAtSuppressed = true } = {}) => {
    const list = Array.isArray(doc.features) ? doc.features : []
    const tipAt = doc.tip ? list.findIndex((f) => String(f.id) === String(doc.tip)) : -1
    const end = tipAt >= 0 ? tipAt + 1 : list.length
    const ops = []
    for (let i = 0; i < end; i += 1) {
      const f = list[i]
      if (!f) continue
      // Suppression skips the node. Until typed selectors land (Phase 2) we
      // cannot tell whether a later node depended on its outputs, so skipping
      // is the honest default: the graph shows it as skipped, and a node that
      // really needed it will fail loudly instead of silently reading something
      // else. (Stopping the whole chain would break the common "mute one fillet
      // and keep working" case.)
      if (f.enabled === false) {
        if (stopAtSuppressed) ops.push({ kind: '__skip__', _id: f.id, _label: f.label || '' })
        continue
      }
      const where = `特征 ${f.id}${f.label ? `（${f.label}）` : ''} ${f.kind}`
      ops.push({ kind: f.kind, ...resolveParams(f.params ?? {}, doc.vars, where), _id: f.id, _label: f.label || '' })
    }
    return ops
  }

  const FEATURE_FIELDS = ['id', 'kind', 'label', 'params', 'enabled', 'suppressed']

  /**
   * Accept both shapes: `{kind:'box', params:{size:…}}` and the flatter
   * `{kind:'box', size:…}` an agent tends to write.
   */
  const normalizeFeature = (doc, raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('feature 必须是对象（至少给 kind）')
    const kind = String(raw.kind ?? '')
    if (!FEATURE_KINDS.includes(kind)) {
      throw new Error(`不支持的特征：${kind || '(空)'}（可用 ${FEATURE_KINDS.join(' / ')}）`)
    }
    const params = raw.params && typeof raw.params === 'object' ? { ...raw.params } : {}
    for (const [k, v] of Object.entries(raw)) if (!FEATURE_FIELDS.includes(k)) params[k] = v
    let maxId = 0
    for (const f of doc.features) {
      const hit = /^f(\d+)$/.exec(String(f.id ?? ''))
      if (hit) maxId = Math.max(maxId, Number(hit[1]))
    }
    const id = /^f\d+$/.test(String(raw.id ?? '')) ? String(raw.id) : `f${maxId + 1}`
    const label = String(raw.label ?? '').slice(0, 40)
    // Validate here, not in FreeCAD: a missing `with` used to surface as
    // "第 10 步（cut）失败：'with'" — a KeyError with no idea which row to fix.
    const num = (v) => typeof v === 'number' && Number.isFinite(v)
    const pos = (v) => num(v) && v > 0
    const triple = (v) => Array.isArray(v) && v.length === 3 && v.every(num)
    const where = `特征 ${id}${label ? `（${label}）` : ''} ${kind}`
    const need = (cond, hint) => {
      if (!cond) throw new Error(`${where}：${hint}`)
    }
    const tool = (v) => v && typeof v === 'object' && ['box', 'cylinder', 'sphere', 'cone', 'torus', 'extrude', 'revolve'].includes(String(v.kind))
    // Expressions are legal in the document, numbers at validation time.
    let probe = params
    try { probe = resolveParams(params, doc.vars, where) } catch (error) { throw new Error(`${where}：${error.message}`) }
    // `at` is either a point or an anchor on a face ({ref, offset}).
    if (probe.at && typeof params.at === 'object' && !Array.isArray(probe.at)) {
      need(probe.at.ref && typeof params.at.ref === 'object', 'at.ref 需要一个面选择器（如 {axis:"Z",mode:"aligned",dir:"+",type:"plane"}）')
      need(probe.at.offset === undefined || triple(probe.at.offset), 'at.offset 需要 [x,y,z]')
    }
    const withs = probe.with
    if (kind === 'box') need(triple(probe.size) && probe.size.every(pos), '需要 size:[dx,dy,dz]（三个正数）')
    else if (kind === 'cylinder') need(pos(probe.r) && pos(probe.h), '需要 r>0 与 h>0')
    else if (kind === 'sphere') need(pos(probe.r), '需要 r>0')
    else if (kind === 'cone') need(num(probe.r1) && num(probe.r2) && pos(probe.h), '需要 r1 / r2 / h>0')
    else if (kind === 'torus') need(pos(probe.r1) && pos(probe.r2), '需要 r1>0（主半径）与 r2>0（管半径）')
    else if (kind === 'extrude') {
      const points = Array.isArray(probe.points) ? probe.points : []
      need(points.length >= 3, '需要 points（至少 3 个 [x,y] 或 [x,y,z] 剖面点）')
      need(points.every((q) => Array.isArray(q) && q.length >= 2 && q.slice(0, 3).every(num)), 'points 的每个点都要是数字数组')
      need(pos(probe.h) || triple(probe.dir), '需要 h>0（沿 +Z 挤出）或 dir:[dx,dy,dz]（任意方向）')
    } else if (kind === 'revolve') {
      const points = Array.isArray(probe.points) ? probe.points : []
      need(points.length >= 2, '需要 points（至少 2 个 [x,z] 剖面点）')
    } else if (kind === 'fuse' || kind === 'cut' || kind === 'common') {
      const list = Array.isArray(withs) ? withs : withs ? [withs] : []
      need(list.length > 0, `需要 with 子图元（{kind:"box",size:[…]}，或用数组一次减/并多个）`)
      need(list.every(tool), 'with 里的每一项都要是图元（box/cylinder/sphere/cone/torus/extrude/revolve），且带 kind')
    } else if (kind === 'fillet') need(pos(probe.r), '需要 r>0')
    else if (kind === 'chamfer') need(pos(probe.d), '需要 d>0')
    else if (kind === 'shell') need(pos(probe.t), '需要 t>0（壁厚）')
    else if (kind === 'pattern_linear') need(triple(probe.delta) && num(probe.count) && probe.count >= 2, '需要 delta:[dx,dy,dz] 与 count>=2')
    else if (kind === 'pattern_circular') need(num(probe.count) && probe.count >= 2, '需要 count>=2')
    else if (kind === 'translate') need(triple(probe.v), '需要 v:[dx,dy,dz]')
    else if (kind === 'rotate') need(num(probe.deg), '需要 deg（角度）')
    return {
      id,
      kind,
      label,
      params: JSON.parse(JSON.stringify(params)),
      enabled: raw.enabled !== false,
    }
  }

  /**
   * Rebuild a model. Script documents replay `script` against `params`; feature
   * documents re-emit the whole feature list — which is why editing one feature
   * is cheap and cannot leave the model half-updated.
   */
  /**
   * Per-node status for the panel and for the caller: ok / failed / blocked /
   * skipped. Derived from what the kernel actually executed, not guessed.
   */
  // True when this step hangs off a face (`at.ref`) instead of absolute XYZ.
  const anchoredOn = (params) => {
    if (!params || typeof params !== 'object') return false
    const has = (v) => Boolean(v && typeof v === 'object' && v.ref)
    if (has(params.at)) return true
    const w = params.with
    return Array.isArray(w) ? w.some((x) => has(x?.at)) : has(w?.at)
  }

  const graphView = (doc, out) => {
    const list = Array.isArray(doc.features) ? doc.features : []
    const errors = Array.isArray(out?.errors) ? out.errors : []
    const failedAt = new Map(errors.map((e) => [String(e.id), e]))
    const executed = Number.isFinite(out?.executed) ? Number(out.executed) : null
    const tipAt = doc.tip ? list.findIndex((f) => String(f.id) === String(doc.tip)) : -1
    const end = tipAt >= 0 ? tipAt + 1 : list.length
    let why = ''
    const nodes = list.map((f, i) => {
      const base = { id: f.id, kind: f.kind, label: f.label ?? '', suppressed: f.enabled === false }
      if (i >= end) return { ...base, status: 'skipped', message: '在回滚点之后' }
      if (why) return { ...base, status: 'blocked', message: why }
      // Skipping is not a failure: the node is not evaluated, the tree keeps
      // building (see featureOps).
      if (base.suppressed) return { ...base, status: 'skipped', message: '被抑制（跳过）' }
      const err = failedAt.get(String(f.id))
      if (err) { why = `因为 ${f.id} 失败`; return { ...base, status: 'failed', message: err.message } }
      if (executed !== null && i >= executed) { why = `因为 ${f.id} 没有执行`; return { ...base, status: 'blocked', message: why } }
      return { ...base, status: 'ok', message: '' }
    })
    // Dependencies are a chain, not a secret: features are evaluated in order
    // and each one consumes the shape the previous one produced. Saying so
    // out loud is what lets the panel answer "what breaks if I change this?"
    // without inventing a graph we do not have.
    const withDeps = nodes.map((n, i) => ({
      ...n,
      dependsOn: i > 0 ? [String(nodes[i - 1].id)] : [],
      dependents: i + 1 < nodes.length ? [String(nodes[i + 1].id)] : [],
      // An anchored primitive (`at.ref`) also follows the face it names, which
      // is the only non-sequential edge we support today.
      anchored: anchoredOn(list[i]?.params),
    }))
    return { tip: doc.tip ?? null, nodes: withDeps }
  }

  const rebuild = async (doc, dir, { note } = {}) => {
    const isFeatures = doc.kind === 'features'
    // Incremental recompute (DESIGN §5.3): hash the op chain once, find the
    // deepest BREP prefix already on disk, and let the kernel start there.
    // A rebuild of an unchanged document skips the kernel entirely.
    let cache = null
    let resume = null
    let hashes = []
    if (isFeatures) {
      const ops = featureOps(doc)
      hashes = chainHashes(ops)
      const cacheDir = brepCacheDir()
      try { await mkdir(cacheDir, { recursive: true }) } catch {}
      cache = { dir: cacheDir, hashes }
      for (let k = hashes.length - 1; k >= 0; k -= 1) {
        const candidate = join(cacheDir, `f_${hashes[k]}.brep`)
        if (existsSync(candidate)) { resume = { index: k + 1, brep: candidate }; break }
      }
      const fullHash = hashes[hashes.length - 1] ?? ''
      const keep = doc.stats?.sceneId && bridge.scenes?.has(doc.stats.sceneId)
      if (fullHash && keep && doc.stats?.hash === fullHash) {
        // Nothing changed and the scene is still live: no kernel run at all.
        return {
          ok: true, evaluated: true, cached: hashes.length, computed: 0, name: doc.name, dir,
          graph: graphView(doc, { errors: [], executed: hashes.length }),
          errors: [], run: doc.run, params: doc.params, volume: doc.stats.volume,
          triangles: doc.stats.triangles, sceneId: doc.stats.sceneId, bounds: doc.stats.bounds,
          note: doc.note, revalidated: true,
        }
      }
    }
    const code = isFeatures
      ? featuresScript(featureOps(doc), null, { cache, resume })
      : `${PRELUDE}\nP = ${JSON.stringify(doc.params ?? {})}\n${doc.script}`
    const meta = isFeatures ? { model: doc.name, features: publicFeatures(doc), tip: doc.tip ?? null } : { model: doc.name, params: doc.params ?? {} }
    doc.run = (doc.run ?? 0) + 1
    doc.updatedAt = new Date().toISOString()
    // One row per model: a rebuild rewrites the model's existing scene.
    const out = await bridge.run(code, {
      title: doc.name,
      meta,
      docKey: `model:${doc.name}`,
      sceneId: doc.stats?.sceneId || '',
    })
    if (out.ok === false) return { ...out, name: doc.name, params: doc.params, graph: graphView(doc, out) }
    // run() returns volume/bounds but not triangle count, so read it back from
    // the row that was just published (a null here forced the panel to guess).
    const sceneId = out.sceneId ?? ''
    const row = sceneId ? bridge.history.find((h) => h.id === sceneId) : null
    doc.stats = {
      volume: out.volume ?? null,
      triangles: row?.triangles ?? null,
      bounds: out.bounds ?? null,
      sceneId,
      at: doc.updatedAt,
      hash: hashes[hashes.length - 1] ?? '',
      cached: out.cached ?? 0,
    }
    if (note) doc.note = note
    // The scene was published before the kernel reported which nodes failed, so
    // attach the statuses now: the panel paints dots from payload.graph.
    const graph = graphView(doc, out)
    const scene = sceneId ? bridge.scenes?.get(sceneId) : null
    if (scene) {
      scene.graph = graph
      scene.cache = { cached: out.cached ?? 0, computed: out.computed ?? null, of: hashes.length }
      try { await bridge.persist() } catch {}
    }
    await writeModel(doc, dir)
    if (isFeatures && hashes.length) {
      // Cheap housekeeping, off the hot path: a 400-file / 14-day cap keeps the
      // cache from growing without bound in a long-lived install.
      try { pruneBrepCache(brepCacheDir()) } catch {}
    }
    return {
      ok: true,
      evaluated: !(Array.isArray(out.errors) && out.errors.length > 0),
      name: doc.name,
      dir,
      graph,
      cached: out.cached ?? 0,
      computed: out.computed ?? null,
      errors: Array.isArray(out.errors) ? out.errors : [],
      run: doc.run,
      params: doc.params,
      volume: doc.stats.volume,
      triangles: doc.stats.triangles,
      sceneId: doc.stats.sceneId,
      published: Boolean(doc.stats.sceneId),
      updatedAt: doc.updatedAt,
    }
  }

  tool({
    name: 'cad_studio_doc',
    description: 'Create/read/update a parametric model document. A model stores its Python script plus a params dict; updating params rebuilds the same script, so a follow-up edit ("把高度改成 120") only changes one field instead of rewriting the model. With kind="features" the document is a declarative feature list instead, editable one feature at a time via cad_studio_features. The script sees the params as `P` (e.g. `h = P.get("高", 107)`) and must bind the shape to show to `scene`.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'show', 'create', 'update', 'revert', 'delete'], description: 'list / show / create / update / revert / delete' },
        name: { type: 'string', description: 'Model name (中英文/数字/下划线/连字符).' },
        script: { type: 'string', description: 'FreeCAD Python source; reads params from `P`, binds the result to `scene`. Required for create unless kind is "features".' },
        kind: { type: 'string', enum: ['script', 'features'], description: 'script (default): a Python script + params. features: a declarative feature list you can edit one feature at a time (see cad_studio_features).' },
        features: { type: 'array', items: { type: 'object' }, description: 'For kind="features": the initial feature list, each {kind, label?, params?} (flat params such as {kind:"box", size:[60,40,20]} also work).' },
        params: { type: 'object', description: 'Parameter dict. On update these are merged into the existing params (set a key to null to delete it).' },
        note: { type: 'string', description: 'What this revision changed (kept in history).' },
        export: { type: 'string', description: 'Also write the model out as STEP at this path (create / update / show). Saves the caller from re-implementing the feature emitter.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, name: { type: 'string' }, sceneId: { type: 'string' }, models: { type: 'number' } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async (args, exec) => {
      try {
        const dir = modelsDirFor(exec)
        const out = await runDocAction(args, dir)
        if (args && typeof args.export === 'string' && args.export && args.name) {
          // A feature model is the source of truth; the STEP is a product. Do it
          // here so the caller never has to copy the emitter to their side.
          try {
            const doc = await readModel(args.name, dir)
            out.exported = await exportModelStep(doc, args.export)
          } catch (error) {
            out.exportError = String(error?.message ?? error)
          }
        }
        return out
      } catch (err) {
        // Tool errors are data, not exceptions: the agent needs to read the
        // message and try something else, and a throw would also skip cleanup.
        return { ok: false, error: String((err && err.message) || err) }
      }
    },
  })

  /**
   * Feature-list editing: the "chat and draw" loop at feature granularity.
   * Every mutating action rebuilds the whole list (one FreeCAD run, ~0.2–0.6 s),
   * so the model can never be left half-edited — a failed edit is rolled back.
   */
  /**
   * Journal a document creation so "undo" removes it again (and the scene row it
   * published). File bytes are captured after the write, so redo is a plain
   * restore-and-rebuild — no need to replay the tool arguments.
   */
  const journalDocCreate = async (key, dir, result) => {
    const file = modelFile(key, dir)
    let bytes = null
    try { bytes = await readFile(file) } catch { return }
    const sceneRow = result?.sceneId ? bridge.history.find((h) => h.id === result.sceneId) : null
    bridge.journal({
      kind: 'doc',
      label: `create ${key}`,
      undo: async () => {
        await unlink(file).catch(() => {})
        if (sceneRow) { try { await bridge.removeScene(sceneRow.id, { journal: false }) } catch {} }
        return { model: key }
      },
      redo: async () => {
        await writeFile(file, bytes)
        const doc = await readModel(key, dir)
        try { await rebuild(doc, dir, { note: 'redo create' }) } catch {}
        return { model: key }
      },
    })
  }

  const runFeatureAction = async (args, dir) => {
    bridge.noteModelsDir(dir)
    const action = String(args.action ?? 'list')
    const doc = await readModel(args.model, dir)
    if (doc.kind !== 'features') {
      throw new Error(`${doc.name} 是脚本模型，没有特征列表（用 cad_studio_doc update 改 params，或新建 kind="features" 的模型）`)
    }
    if (action === 'list') {
      return { ok: true, model: doc.name, kind: doc.kind, features: publicFeatures(doc), graph: graphView(doc, { errors: [], executed: null }), stats: doc.stats ?? null }
    }
    const snapshot = () => JSON.parse(JSON.stringify({ features: doc.features, tip: doc.tip ?? null }))
    const restore = (snap) => {
      doc.features = JSON.parse(JSON.stringify(snap.features))
      doc.tip = snap.tip ?? null
    }
    const before = JSON.parse(JSON.stringify(doc.features))
    const undoSnap = snapshot()
    const feature = args.feature && typeof args.feature === 'object' ? args.feature : {}
    const wanted = String(args.id ?? feature.id ?? '')
    const findAt = () => doc.features.findIndex((f) => String(f.id) === wanted)

    if (action === 'add') {
      doc.features.push(normalizeFeature(doc, feature))
    } else if (action === 'update') {
      const at = findAt()
      if (at < 0) throw new Error(`没有这个特征：${wanted || '(空)'}（现有 ${doc.features.map((f) => f.id).join(', ')}）`)
      const current = doc.features[at]
      const merged = normalizeFeature(doc, {
        ...current,
        ...feature,
        id: current.id,
        kind: feature.kind ?? current.kind,
        params: { ...(current.params ?? {}), ...(feature.params && typeof feature.params === 'object' ? feature.params : {}) },
      })
      doc.features[at] = merged
    } else if (action === 'remove') {
      const at = findAt()
      if (at < 0) throw new Error(`没有这个特征：${wanted || '(空)'}`)
      doc.features.splice(at, 1)
    } else if (action === 'move') {
      const at = findAt()
      if (at < 0) throw new Error(`没有这个特征：${wanted || '(空)'}`)
      const [item] = doc.features.splice(at, 1)
      const to = Number.isFinite(Number(args.to)) ? Math.max(0, Math.min(doc.features.length, Math.round(Number(args.to)))) : doc.features.length
      doc.features.splice(to, 0, item)
    } else if (action === 'toggle' || action === 'suppress') {
      const at = findAt()
      if (at < 0) throw new Error(`没有这个特征：${wanted || '(空)'}`)
      // Suppression is document state, not a delete: the feature keeps its
      // params and its place, and everything downstream reports as blocked.
      const want = feature.enabled !== undefined ? feature.enabled !== false : doc.features[at].enabled === false
      doc.features[at].enabled = want
    } else if (action === 'tip') {
      if (!wanted) doc.tip = null
      else if (findAt() < 0) throw new Error(`没有这个特征：${wanted}`)
      else doc.tip = wanted
    } else if (action === 'undo' || action === 'redo') {
      const from = action === 'undo' ? doc.undo : doc.redo
      const to = action === 'undo' ? doc.redo : doc.undo
      if (!from.length) throw new Error(action === 'undo' ? '没有可撤销的操作' : '没有可重做的操作')
      const entry = from.pop()
      to.push(entry)
      restore(action === 'undo' ? entry.before : entry.after)
    } else {
      throw new Error(`未知 action：${action}（可用 list / add / update / remove / move / toggle）`)
    }
    if (!doc.features.length) throw new Error('特征列表不能为空：至少留一个图元')

    const label = `${action} ${wanted || feature.kind || ''}`.trim()
    const result = await rebuild(doc, dir, { note: label })
    if (result.ok === false) {
      // Keep the edit. A document that describes an unbuildable shape is more
      // useful than a silent rollback: the panel shows which node failed, and
      // undo is one keystroke away.
      await writeModel(doc, dir)
      // "ok" answers "did the document accept the edit"; the geometry answer
      // lives in evaluated/errors/graph. A reorder can legitimately leave the
      // tree unevaluable (a fillet moved above its body) and that must stay
      // visible rather than being rejected — you fix it by reading the graph.
      return {
        ...result,
        ok: true,
        saved: true,
        evaluated: false,
        features: publicFeatures(doc),
        hint: '这条改动已存进文档，但求值失败——看 graph 里哪条是 failed，改好或撤销。',
      }
    }
    if (!['undo', 'redo'].includes(action)) {
      doc.undo.push({ at: new Date().toISOString(), action, target: wanted || feature.kind || '', before: undoSnap, after: snapshot() })
      doc.undo = doc.undo.slice(-50)
      doc.redo = []
    }
    doc.history.push({
      at: doc.updatedAt,
      note: `${action} ${wanted || feature.kind || ''}`.trim(),
      params: JSON.parse(JSON.stringify(doc.params)),
      features: JSON.parse(JSON.stringify(doc.features)),
      run: doc.run,
      prev: { script: doc.script, params: JSON.parse(JSON.stringify(doc.params)), features: before },
    })
    doc.history = doc.history.slice(-20)
    await writeModel(doc, dir)
    return {
      ok: true,
      evaluated: result.ok !== false && (result.errors ?? []).length === 0,
      model: doc.name,
      kind: doc.kind,
      action,
      features: publicFeatures(doc),
      graph: result.graph,
      errors: result.errors ?? [],
      undo: doc.undo.length,
      redo: doc.redo.length,
      volume: doc.stats?.volume ?? null,
      triangles: doc.stats?.triangles ?? null,
      sceneId: doc.stats?.sceneId ?? '',
      run: doc.run,
      // How much of the chain came from the BREP cache vs the kernel this time.
      cached: result.cached ?? doc.stats?.cached ?? 0,
      computed: result.computed ?? null,
      revalidated: result.revalidated === true,
    }
  }

  tool({
    name: 'cad_studio_features',
    description: `Edit a feature-list model one feature at a time (the "边画边改" path): change one feature's parameters and the whole list is re-derived in ~0.2–0.6 s. Actions: list / add / update / remove / move / toggle (alias suppress) / tip / undo / redo. Feature kinds: ${FEATURE_KINDS.join(', ')}. A feature is {kind, label?, params} — params hold that kind's fields (box: size:[dx,dy,dz], at?; cylinder: r,h,at?,axis?; cut/fuse/common: with:<primitive>; fillet: r; chamfer: d; shell: t,open?; pattern_linear: delta,count; rotate: axis?,at?,deg; mirror: normal?,at?). Flat form ({kind:'box', size:[…]}) is accepted too.`,
    parameters: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Feature-list model name (created with cad_studio_doc kind="features").' },
        action: { type: 'string', enum: ['list', 'add', 'update', 'remove', 'move', 'toggle', 'suppress', 'tip', 'undo', 'redo'] },
        feature: { type: 'object', description: 'add: the feature to append. update/toggle: {id, ...fields to change}. remove/move: {id}.' },
        id: { type: 'string', description: 'Feature id (f1, f2 …); alternative to feature.id.' },
        to: { type: 'integer', description: 'move: target index (0-based). Default: to the end.' },
      },
      required: ['model', 'action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, model: { type: 'string' }, sceneId: { type: 'string' }, volume: { type: 'number' }, features: { type: 'array' } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async (args, exec) => {
      try {
        return await runFeatureAction(args, modelsDirFor(exec))
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) }
      }
    },
  })

  /**
   * Turn a model document into a STEP file without the caller re-implementing
   * the emitter. A feature model runs its own `featuresScript` (which already
   * knows how to export); a script model gets three extra lines appended.
   */
  async function exportModelStep(doc, target) {
    if (typeof target !== 'string' || !target) throw new Error('export 需要目标路径，例如 /path/model.step')
    await mkdir(dirname(target), { recursive: true })
    const head = doc.kind === 'features'
      ? featuresScript(featureOps(doc), target)
      : `${PRELUDE}\nP = ${JSON.stringify(doc.params ?? {})}\n${doc.script}\n`
    const code = doc.kind === 'features'
      ? head
      : `${head}import os as _os
_os.makedirs(_os.path.dirname(${JSON.stringify(target)}) or ".", exist_ok=True)
Part.makeCompound([scene]).exportStep(${JSON.stringify(target)})
__out = {"ok": True, "exported": ${JSON.stringify(target)}, "volume": round(scene.Volume, 3),
         "bytes": _os.path.getsize(${JSON.stringify(target)})}`
    // publish:false — an export is a product, not a new row in the model list.
    const out = await bridge.run(code, { title: `${doc.name} → STEP`, publish: false })
    if (out.ok === false) return { ...out, model: doc.name, path: target }
    let bytes = Number(out.bytes ?? 0)
    try { bytes = (await stat(target)).size } catch {}
    return { ok: true, model: doc.name, path: target, bytes, valid: bytes > 200, volume: out.volume ?? null }
  }

  async function runDocAction(args, dir) {
      bridge.noteModelsDir(dir)
      const action = String(args.action ?? '')
      if (action === 'list') {
        await mkdir(dir, { recursive: true })
        const names = (await readdir(dir)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
        const models = []
        for (const n of names) {
          try {
            const doc = await readModel(n, dir)
            models.push({ name: doc.name, kind: doc.kind, features: doc.features.length, params: doc.params, runs: doc.run ?? 0, updatedAt: doc.updatedAt ?? '', volume: doc.stats?.volume ?? null, triangles: doc.stats?.triangles ?? null })
          } catch { /* a hand-edited file that no longer parses is skipped, not fatal */ }
        }
        models.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        return { ok: true, models: models.length, items: models, dir }
      }

      if (action === 'show') {
        const doc = await readModel(args.name, dir)
        return {
          ok: true,
          name: doc.name,
          kind: doc.kind,
          params: doc.params,
          ...(typeof doc.script === 'string' ? { script: doc.script } : {}),
          ...(doc.kind === 'features' ? { features: publicFeatures(doc), graph: graphView(doc, { errors: [], executed: null }), tip: doc.tip ?? null, vars: doc.vars ?? {} } : {}),
          runs: doc.run ?? 0,
          updatedAt: doc.updatedAt ?? '',
          stats: doc.stats ?? null,
          history: doc.history.slice(-10).map((h) => ({ at: h.at, note: h.note ?? '', params: h.params })),
        }
      }

      if (action === 'create') {
        const key = checkName(args.name)
        const wantFeatures = args.kind === 'features' || Array.isArray(args.features)
        if (!wantFeatures && (typeof args.script !== 'string' || !args.script.trim())) {
          throw new Error('create 需要 script（FreeCAD Python，读 P、写 scene），或用 kind="features" 建特征列表模型')
        }
        try {
          await readModel(key, dir)
          throw new Error(`模型已存在：${key}（要改的话用 action=update）`)
        } catch (err) {
          if (/模型已存在/.test(String(err.message))) throw err
        }
        if (wantFeatures) {
          const doc = {
            name: key,
            kind: 'features',
            features: [],
            // Vars must exist before the first feature is validated: dimensions
            // are allowed to be expressions over them.
            vars: normalizeVars(args.vars),
            params: args.params && typeof args.params === 'object' ? args.params : {},
            run: 0,
            createdAt: new Date().toISOString(),
            history: [],
          }
          for (const raw of Array.isArray(args.features) ? args.features : []) {
            doc.features.push(normalizeFeature(doc, raw))
          }
          if (!doc.features.length) throw new Error('特征模型至少要有一个 feature，例如 {kind:"box", size:[60,40,20]}')
          const result = await rebuild(doc, dir, { note: args.note ?? 'create' })
          if (result.ok === false) return result
          doc.history.push({ at: doc.updatedAt, note: args.note ?? 'create', params: JSON.parse(JSON.stringify(doc.params)), features: JSON.parse(JSON.stringify(doc.features)), run: doc.run })
          await writeModel(doc, dir)
          await journalDocCreate(key, dir, result)
          return { ...result, kind: 'features', features: publicFeatures(doc) }
        }
        const doc = {
          name: key,
          kind: 'script',
          script: args.script,
          params: args.params && typeof args.params === 'object' ? args.params : {},
          run: 0,
          createdAt: new Date().toISOString(),
          history: [],
        }
        const result = await rebuild(doc, dir, { note: args.note ?? 'create' })
        if (result.ok === false) return result
        doc.history.push({ at: doc.updatedAt, note: args.note ?? 'create', params: JSON.parse(JSON.stringify(doc.params)), run: doc.run })
        await writeModel(doc, dir)
        await journalDocCreate(key, dir, result)
        return result
      }

      if (action === 'update') {
        const doc = await readModel(args.name, dir)
        if (args.vars !== undefined) doc.vars = normalizeVars(args.vars, doc.vars)
        const before = {
          script: doc.script,
          params: JSON.parse(JSON.stringify(doc.params)),
          features: JSON.parse(JSON.stringify(doc.features)),
        }
        if (args.params && typeof args.params === 'object') {
          for (const [k, v] of Object.entries(args.params)) {
            if (v === null) delete doc.params[k]
            else doc.params[k] = v
          }
        }
        if (Array.isArray(args.features)) {
          if (doc.kind !== 'features') throw new Error(`${doc.name} 是脚本模型；要换成特征列表请新建一个 kind="features" 的模型`)
          doc.features = []
          for (const raw of args.features) doc.features.push(normalizeFeature(doc, raw))
          if (!doc.features.length) throw new Error('features 不能为空：至少留一个图元')
        }
        if (typeof args.script === 'string' && args.script.trim()) doc.script = args.script
        const result = await rebuild(doc, dir, { note: args.note ?? 'update' })
        if (result.ok === false) {
          // A failed rebuild must not corrupt the document: put the old state back.
          doc.script = before.script
          doc.params = before.params
          doc.features = before.features
          await writeModel(doc, dir)
          return { ...result, reverted: true, hint: '这次修改没跑通，模型已回退到上一版；改完再试。' }
        }
        doc.history.push({ at: doc.updatedAt, note: args.note ?? 'update', params: JSON.parse(JSON.stringify(doc.params)), features: JSON.parse(JSON.stringify(doc.features)), run: doc.run, prev: before })
        doc.history = doc.history.slice(-20)
        await writeModel(doc, dir)
        return { ...result, kind: doc.kind, ...(doc.kind === 'features' ? { features: publicFeatures(doc) } : {}) }
      }

      if (action === 'revert') {
        const doc = await readModel(args.name, dir)
        const last = doc.history.pop()
        if (!last) throw new Error(`${doc.name} 没有可回退的历史`)
        if (last.prev) {
          doc.script = last.prev.script
          doc.params = last.prev.params
          if (Array.isArray(last.prev.features)) doc.features = JSON.parse(JSON.stringify(last.prev.features))
        } else if (last.params) {
          doc.params = last.params
        }
        const result = await rebuild(doc, dir, { note: `revert to ${last.at}` })
        await writeModel(doc, dir)
        return result
      }

      if (action === 'delete') {
        const key = checkName(args.name)
        const file = modelFile(key, dir)
        let bytes = null
        try { bytes = await readFile(file) } catch { throw new Error(`没有这个模型：${key}`) }
        const sceneRow = bridge.history.find((h) => h.title === key || (h.docKey === `model:${key}`))
        bridge.journal({
          kind: 'doc',
          label: `delete ${key}`,
          undo: async () => {
            await writeFile(file, bytes)
            const doc = await readModel(key, dir)
            try { await rebuild(doc, dir, { note: 'undo delete' }) } catch {}
            return { model: key }
          },
          redo: async () => {
            await unlink(file).catch(() => {})
            if (sceneRow) { try { await bridge.removeScene(sceneRow.id, { journal: false }) } catch {} }
            return { model: key }
          },
        })
        await unlink(file).catch(() => { throw new Error(`没有这个模型：${key}`) })
        return { ok: true, name: key, deleted: true, dir }
      }

      throw new Error(`未知 action：${action}`)
  }

  // ---- Panel routes ------------------------------------------------------

  const mountRoutes = () => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      if (!isTrusted(req, resolved.trustedHosts)) {
        res.writeHead(403, { 'content-type': 'text/plain' })
        res.end('forbidden host')
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const send = (status, body, type = 'application/json; charset=utf-8') => {
        res.writeHead(status, { 'content-type': type, 'cache-control': 'no-cache' })
        res.end(body)
      }
      const dir = FreeCadBridge.dataDir
      if (url.pathname === `${ROUTE_PREFIX}/state`) {
        // Runtime is live (the binary may have been installed after boot);
        // only the published scene pointer is persisted.
        bridge.refresh()
        const runtime = bridge.status()
        try {
          const parsed = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
          const setup = setupStatus(bridge, { withVersion: false })
          const diag = diagnose(bridge, resolved)
          diag.checks = diag.checks.map((c) => (c.id === 'kernel' ? { ...c, detail: runtime.available ? [runtime.binary, runtime.version].filter(Boolean).join(' · ') : c.detail } : c))
          return send(200, JSON.stringify({ runtime, setup, diag, config: { autoOpen: resolved.autoOpen }, latest: parsed.latest ?? null, lastSession: parsed.lastSession ?? '', assemblies: parsed.assemblies ?? [], running: bridge.running || 0, runningSession: bridge.runningSession || '' }))
        } catch {
          const setup = setupStatus(bridge, { withVersion: false })
          const diag = diagnose(bridge, resolved)
          diag.checks = diag.checks.map((c) => (c.id === 'kernel' ? { ...c, detail: runtime.available ? [runtime.binary, runtime.version].filter(Boolean).join(' · ') : c.detail } : c))
          return send(200, JSON.stringify({ runtime, setup, diag, config: { autoOpen: resolved.autoOpen }, latest: null, lastSession: '', running: bridge.running || 0, runningSession: bridge.runningSession || '' }))
        }
      }
      if (url.pathname === `${ROUTE_PREFIX}/scenes`) {
        // Model switcher feed: the persisted history is the truth, so a stale
        // route closure left by a hot reload still lists what is on disk.
        try {
          const parsed = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
          // `scenes` is the model list (kept for older panels); `history` is the
          // same array under the name the file uses. Counts live in `runtime`.
          return send(200, JSON.stringify({ latest: parsed.latest ?? null, scenes: parsed.history ?? [], history: parsed.history ?? [] }))
        } catch {
          return send(200, JSON.stringify({ latest: null, scenes: [] }))
        }
      }
      const bodyOf = async () => {
        const raw = await new Promise((resolve) => {
          let data = ''
          req.on('data', (chunk) => { data += chunk; if (data.length > 1 << 20) req.destroy() })
          req.on('end', () => resolve(data))
          req.on('error', () => resolve(''))
        })
        try { return JSON.parse(raw) } catch { return null }
      }

      if (url.pathname === `${ROUTE_PREFIX}/doctor`) {
        bridge.refresh()
        return send(200, JSON.stringify(diagnose(bridge, resolved)))
      }
      if (url.pathname === `${ROUTE_PREFIX}/setup`) {
        // The panel's "install FreeCAD" button; same code path as the tool so
        // both report identical fields.
        let action = 'check'
        try { action = (await bodyOf()).action || 'check' } catch {}
        const out = action === 'install' ? installFreeCad(bridge) : setupStatus(bridge)
        return send(200, JSON.stringify(out))
      }

      if (url.pathname === `${ROUTE_PREFIX}/params` && req.method === 'POST') {
        // Same path as cad_studio_doc update: the panel edits a number, the doc
        // is rewritten and rebuilt, and a failed rebuild rolls the params back.
        const body = await bodyOf()
        if (!body || typeof body.model !== 'string' || !body.model) return send(400, JSON.stringify({ error: 'bad request' }))
        try {
          if (!bridge.modelsSeen.length) {
            try {
              const pointer = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
              if (typeof pointer.modelsDir === 'string' && pointer.modelsDir) bridge.noteModelsDir(pointer.modelsDir)
              if (Array.isArray(pointer.modelsDirs)) pointer.modelsDirs.forEach((d) => bridge.noteModelsDir(d))
            } catch {}
          }
          const candidates = resolved.modelsDir ? [resolved.modelsDir, ...bridge.modelsCandidates()] : bridge.modelsCandidates()
          const modelsDir = candidates.find((d) => existsSync(join(d, `${body.model}.json`))) || candidates[0] || modelsDirFor(undefined)
          const out = await runDocAction({ action: 'update', name: body.model, params: body.params ?? {} }, modelsDir)
          const entry = out && out.sceneId ? bridge.history.find((h) => h.id === out.sceneId) : null
          return send(200, JSON.stringify(entry ? { ...out, at: entry.at } : out))
        } catch (error) {
          return send(200, JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
        }
      }
      if (url.pathname === `${ROUTE_PREFIX}/feature` && req.method === 'POST') {
        // The panel edits features directly; the same code path as the tool, so
        // a slider/number edit and an agent edit produce identical documents.
        const body = await bodyOf()
        if (!body || typeof body.model !== 'string' || !body.model) return send(400, JSON.stringify({ error: 'bad request' }))
        try {
          // The panel posts without a session, so resolve the models dir the way
          // a tool would: explicit config, the last dir a tool used, or the one
          // recorded in the state pointer (a restart forgets the in-memory copy).
          // `dir` here is the plugin's data dir (scenes + pointer), not the
          // models dir — the pointer records where the session's models live.
          if (!bridge.modelsSeen.length) {
            try {
              const pointer = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
              if (typeof pointer.modelsDir === 'string' && pointer.modelsDir) bridge.noteModelsDir(pointer.modelsDir)
              if (Array.isArray(pointer.modelsDirs)) pointer.modelsDirs.forEach((d) => bridge.noteModelsDir(d))
            } catch {}
          }
          // The panel posts without a session, so pick the candidate dir that
          // actually holds this model (several workspaces may each have one).
          const candidates = resolved.modelsDir ? [resolved.modelsDir, ...bridge.modelsCandidates()] : bridge.modelsCandidates()
          const modelsDir = candidates.find((d) => existsSync(join(d, `${body.model}.json`))) || candidates[0] || modelsDirFor(undefined)
          const result = await runFeatureAction(body, modelsDir)
          // Tell the panel when the model was republished, so its poller can
          // recognise the in-place update it triggered itself.
          const entry = result && result.sceneId ? bridge.history.find((h) => h.id === result.sceneId) : null
          return send(200, JSON.stringify(entry ? { ...result, at: entry.at } : result))
        } catch (error) {
          return send(400, JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
        }
      }

      if (url.pathname === `${ROUTE_PREFIX}/select` && req.method === 'POST') {
        // Switch the visible model without republishing: only the pointer moves.
        const raw = await new Promise((resolve) => {
          let data = ''
          req.on('data', (chunk) => { data += chunk; if (data.length > 4096) req.destroy() })
          req.on('end', () => resolve(data))
          req.on('error', () => resolve(''))
        })
        let body = null
        try { body = JSON.parse(raw) } catch { body = null }
        const id = typeof body?.id === 'string' ? body.id : ''
        if (!/^scene-\d+$/.test(id)) return send(400, JSON.stringify({ error: 'bad scene id' }))
        // Reading a model must not rewrite what "latest" means: the live tab
        // follows modelling, the model tab is whatever the user opened. This
        // only resolves the id to its metadata.
        try {
          const parsed = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
          const entry = (parsed.history ?? []).find((h) => h.id === id)
          if (!entry) return send(404, JSON.stringify({ error: 'unknown scene' }))
          return send(200, JSON.stringify({ ok: true, scene: { id: entry.id, title: entry.title, at: entry.at, session: entry.session ?? '' } }))
        } catch {
          return send(404, JSON.stringify({ error: 'unknown scene' }))
        }
      }
      if (url.pathname === `${ROUTE_PREFIX}/assembly` && req.method === 'GET') {
        // Joints + explode for the panel's motion controls.
        const live = state.bridge
        let records = [...live.assemblies.values()]
        if (!records.length) {
          // A restarted process has no in-memory assemblies yet; the pointer
          // carries enough (placements + joints) to list and drive them.
          try {
            const pointer = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
            records = Array.isArray(pointer.assemblies) ? pointer.assemblies : []
          } catch {}
        }
        const list = records.map((a) => ({
          id: a.id,
          title: a.title,
          sceneId: a.sceneId,
          explode: a.explode,
          joints: (a.joints || []).map((j) => ({ id: j.id, instance: j.instance, type: j.type, value: round6(j.value), min: round6(j.min), max: round6(j.max) })),
        }))
        return send(200, JSON.stringify({ assemblies: list }))
      }
      if ((url.pathname === `${ROUTE_PREFIX}/drive` || url.pathname === `${ROUTE_PREFIX}/explode`) && req.method === 'POST') {
        const raw = await new Promise((resolve) => {
          let data = ''
          req.on('data', (chunk) => { data += chunk; if (data.length > 8192) req.destroy() })
          req.on('end', () => resolve(data))
          req.on('error', () => resolve(''))
        })
        let body = null
        try { body = JSON.parse(raw) } catch { body = null }
        const live = state.bridge
        const record = await live.loadAssembly(typeof body?.assembly === 'string' ? body.assembly : null)
        if (!record) return send(404, JSON.stringify({ error: 'no assembly' }))
        if (url.pathname.endsWith('/drive')) {
          const jointId = typeof body?.joint === 'string' ? body.joint : record.joints[0]?.id
          const editLive = live.beginAssemblyEdit(record, 'drive')
          const moved = live.driveJoint(record, jointId, body?.value)
          if (!moved) return send(400, JSON.stringify({ error: 'bad joint or value' }))
          const published = await live.republishAssembly(record)
          live.endAssemblyEdit(editLive, record)
          return send(200, JSON.stringify({ ok: true, sceneId: published.id, at: published.stats.at, joint: moved.id, value: round6(moved.value) }))
        }
        const editLive = live.beginAssemblyEdit(record, 'explode')
        const next = live.setExplode(record, body?.factor ?? 1)
        if (next === null) return send(400, JSON.stringify({ error: 'bad factor' }))
        const published = await live.republishAssembly(record)
        live.endAssemblyEdit(editLive, record)
        return send(200, JSON.stringify({ ok: true, sceneId: published.id, at: published.stats.at, explode: round6(next) }))
      }
      if (url.pathname.startsWith(`${ROUTE_PREFIX}/scene/`)) {
        const id = decodeURIComponent(url.pathname.slice(`${ROUTE_PREFIX}/scene/`.length))
        if (!/^scene-\d+$/.test(id)) return send(400, JSON.stringify({ error: 'bad scene id' }))
        try {
          const body = await readFile(join(dir, 'scenes', `${id}.json`), 'utf8')
          return send(200, body)
        } catch {
          return send(404, JSON.stringify({ error: 'unknown scene' }))
        }
      }
      if (url.pathname === `${ROUTE_PREFIX}/open` && req.method === 'POST') {
        // The sidebar file viewer asks the Host to open a path it cannot read
        // itself (the browser has no direct filesystem access).
        const raw = await new Promise((resolve) => {
          let data = ''
          req.on('data', (chunk) => { data += chunk; if (data.length > 8192) req.destroy() })
          req.on('end', () => resolve(data))
          req.on('error', () => resolve(''))
        })
        let body = null
        try { body = JSON.parse(raw) } catch { body = null }
        const path = typeof body?.path === 'string' ? body.path.trim() : ''
        if (!path || path.includes('\u0000') || !path.startsWith('/')) {
          return send(400, JSON.stringify({ error: 'bad path' }))
        }
        try {
          const info = await stat(path)
          if (!info.isFile()) return send(400, JSON.stringify({ error: 'not a file' }))
        } catch {
          return send(404, JSON.stringify({ error: 'no such file' }))
        }
        try {
          const result = await openPath(path)
          return send(200, JSON.stringify(result))
        } catch (error) {
          return send(500, JSON.stringify({ error: String(error?.message ?? error) }))
        }
      }
      if (url.pathname.startsWith(`${ROUTE_PREFIX}/assets/`)) {
        const name = url.pathname.slice(`${ROUTE_PREFIX}/assets/`.length)
        if (!ASSET_NAME.test(name)) return send(400, JSON.stringify({ error: 'bad asset name' }))
        try {
          const body = await readFile(join(PLUGIN_DIR, 'assets', name))
          res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' })
          res.end(body)
        } catch {
          send(404, JSON.stringify({ error: 'unknown asset' }))
        }
        return
      }
      send(404, JSON.stringify({ error: 'not found' }))
    },
  })

  try {
    ctx.effect(mountRoutes)
  } catch (error) {
    // A hot reload cannot release a prefix route the previous instance left
    // behind; without a restart the panel route stays stale, so say so loudly.
    ctx.logger?.warn?.('cad-studio: route %s not remounted (%s); restart dsh web to reclaim it', ROUTE_PREFIX, String(error?.message ?? error))
  }
}
