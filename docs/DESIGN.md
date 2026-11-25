# CAD Studio 设计文档：从「形状脚本」到「可重算的特征图」

> 版本 0.5 设计稿 · 2026-11-25
> 适用代码：`index.js`（2707 行）、`client.js`（2766 行）、`test/harness.mjs`（736 行 / 165 用例）
> 目标读者：接手这个仓库的人、要给它加特征的人、评审「为什么这么做」的人。
> 读法：第 1 章是事实（有出处，不掺我们的口味）；第 2、3、4 章是「别人怎么做 / 我们现在怎么做的 / 差在哪」；第 5 章是目标架构；第 7 章是落地顺序。**代码按第 5 章写，不要按第 3 章续命。**

---

## 0. TL;DR

1. **内核只有一个**（OCCT / FreeCAD），换不动；真正决定正确性与可维护性的是**历史模型**，不是几何算法。
2. 成熟参数化 CAD 的历史模型是**「特征图 + 稳定引用 + 局部重算」**：FreeCAD 是 Body 内的链（`Group` + `Tip` + `BaseFeature`）[1]，Onshape / Fusion 是时间线 + 回滚条 [2][4]。三者共有的语义是：**每条特征是一次可重放的变换、引用是显式的、失败是可见的、抑制/回滚是文档语义而不是删数据**。
3. 我们现在的模型是**「一个有序数组 → 拼成一段 Python 脚本 → 整段重跑」**。它把「编辑」实现成「重建」，因此：没有依赖粒度（改一条全跑）、没有引用（dress-up 只能作用于所有边）、没有撤销（只有 `revert` 上一版）、没有失败隔离（一次报错整表回滚）、没有抑制/回滚语义（只有 `enabled`）。
4. 目标架构：**Document（版本化 JSON）→ FeatureGraph（DAG，节点=特征，边=类型化引用）→ Evaluator（脏传播 + 拓扑序 + 输入哈希缓存 + 一次批处理）→ KernelSession（freecadcmd）→ Scene（现状不变）**。UI 契约、面板框架、场景 JSON 全部保持不变。
5. 落地分 5 期（第 7 章），**每一期都能独立发版、可回退**；Phase 1（图 + 撤销 + 错误模型）是分水岭，Phase 3（选择器命名）是「能不能叫 CAD」的分水岭。
6. 明确**不做**：自研 BRep、通用草图约束求解器（先做 profile，约束后置）、跨进程并行重算、任意子形状选择的长期稳定保证（第 5.4 节写清我们能承诺到哪一步）。

---

## 1. 事实

### 1.1 内核层事实

| 事实 | 含义（对我们意味着什么） |
|---|---|
| OCCT 的实体是 BRep：面/边/顶点由 `TopoDS_TShape` 指针标识，**跨操作不保证稳定** | 任何「上一次的 Face13」在下一次重算里可能变成 Face14。这不是 bug，是内核的语义 [3] |
| 布尔运算在退化/相切/共面情形下不保证收敛或产生有效体 | 参数化系统必须能**表达失败**并继续用（FreeCAD：把失败标在节点上；Onshape：列表里出红/黄标志）[2][3] |
| 三角化是视图层的事（deflection 参数） | 视图与几何解耦；我们的 `_mesh(shape, deflection)` 已经是对的 |
| STEP 能携带装配树（`NEXT_ASSEMBLY_USAGE_OCCURRENCE` × N + `MANIFOLD_SOLID_BREP` × 1） | 跨文档引用装配不需要自创格式，STEP/XCAF 就是标准答案 |
| 内核没有「历史」概念 | 历史必须由**应用层**自己保存与重放。这就是本文件存在的理由 |

### 1.2 三种历史模型

**(a) 链式（FreeCAD PartDesign Body）** [1]
- Body 持有 `Group`（特征列表）、`Tip`（对外暴露的最后一个特征）、`BaseFeature`（外部形状作为第一特征）。
- `Tip` 可以移到中间特征上——**这就是「回滚」**：「Changing the Tip in effect rolls back its history, making it possible to add features that should have been added earlier.」
- 重算是 `App.ActiveDocument.recompute()`：按依赖顺序重算被 touch 的对象。
- 可见性有明确规则：Body 隐藏则内部全隐藏；同时只能有一个实体可见。

**(b) 时间线（Onshape Part Studio / Fusion 360）** [2][4]
- 左侧是 Features 列表（含默认 origin/planes），带**回滚条**：模型只显示到回滚条为止，下方特征临时抑制。
- 列表上可以：拖拽重排、右键 `Suppress`、分组（folder，可嵌套）、`Show dependencies`（弹窗显示 parents/children）、`Hide/Show`、搜索与过滤（`:type` `:name` `:errors` `:suppressed` …）。
- **重算被当成一等公民**：`Pause regeneration`（暂停重算、批量改参数、再一次性 regenerate）、`Show regeneration times`（每个特征耗时，用来决定抑制谁）。
- **失败可见**：列表左上角错误图标（数量）、缺失选择=黄色三角、未完全定义=蓝色标记。
- **交叉高亮**：选中特征↔几何、选中零件↔影响它的特征。

**(c) 代码即模型（CadQuery / build123d / replicad）**
- 没有历史树：**脚本本身就是权威**，重跑脚本得到形状。
- 优点：表达力无限、版控友好、可单元测试。
- 缺点：没有「改一个数字」的 UI 语义（除非自己定义参数表）、没有特征级抑制/回滚、没有选择器语义（选中一条边要靠代码位置）。

### 1.3 拓扑命名问题（必须读的一段）

FreeCAD 官方文档给了最小复现 [3]：
1. XY 平面草图 → Pad 1；2. 在 Pad 1 顶面画草图 → Pad 2；3. 在 Pad 2 顶面画草图 → Pad 3；
4. 改草图 2 的长度方向 → Pad 2 重建 → **Pad 2 的顶面从 `Face13` 变成 `Face14`**；
5. 草图 3 仍绑定 `Face13`，于是跑到侧面 → Pad 3 失效。

官方给出的三档处理（Realthunder 算法，FreeCAD 1.0 起默认）：
1. **识别**并报错（最重要）——明确告诉用户「哪一个操作改变了名字」；
2. 给出**候选**修复（如 fillet/chamfer 的边选择）；
3. 高置信度时**自动修复**；原则是 *First, do no harm*——宁可报错也不猜。

缓解手段（官方推荐）：把草图/特征挂到**datum 平面、主平面、局部坐标系**上，而不是挂到上一个实体的面；依赖链越短越稳。文档也明确指出：这个算法**不是**让问题消失，而是让失败可定位。

> 对我们的直接结论：**我们不能承诺「任意面选择永久稳定」**。能承诺的是：①选择器是显式的、可序列化的；②重算后发现选择器解析失败时**显式报错**（节点级），而不是静默算出一个错形状；③对常见选择器（主平面、轴、圆柱面、包围盒极值面）给出确定性解析规则；④提供「按几何签名 relink」的显式修复入口。

### 1.4 重算的工程面（Onshape 教给我们的四件事）

1. **重算是一等操作**：可暂停、可计耗时、可只跑一部分（回滚条 / 抑制）。
2. **列表是控制台**：错误数、缺失选择、未完全定义、抑制态，都在列表上可读。
3. **依赖是可查询的**：`Show dependencies` 直接给 parents/children 两张表——这要求图是真的图，不是数组。
4. **选择是可以交叉高亮的**：特征 ↔ 几何双向；这要求几何实体带可回指的 id（我们的场景 JSON 已经有 `instances[].name` / `parts[].id`，但**特征级**还没有）。

---

## 2. 业界对照表

| 维度 | FreeCAD PartDesign [1] | Onshape Part Studio [2] | Fusion 360 [4] | CadQuery / build123d / replicad | 我们（现状） |
|---|---|---|---|---|---|
| 历史表示 | Body 内线性 `Group` + `Tip` | Feature 列表（可分组/重排）+ 回滚条 | 时间线（timeline）+ 回滚 | 无（脚本即模型） | 有序数组 `features[]` |
| 依赖表达 | 隐式（链式：每条吃前一条的结果） | 显式（特征有引用，可查 parents/children） | 隐式链 + 显式选择 | 代码表达 | 隐式（数组顺序） |
| 引用粒度 | 面/边/顶点/基准对象 | 面/边/顶点/平面/草图 | 面/边/草图/组件 | 代码里的对象引用 | **无**（只能「所有边」） |
| 选择器稳定性 | 拓扑命名算法（识别/候选/自动） | 私有实现（对外表现为「一般不炸」） | 私有实现 | 不适用 | 不适用 |
| 重算范围 | 被 touch 的下游 | 脏下游（可暂停） | 脏下游 | 全脚本 | **全表** |
| 失败处理 | 节点标记 + 下游阻断 | 列表红/黄标记 + 错误计数 | 时间线红标 | 异常 | 整表回滚（`reverted`） |
| 抑制 | `Suppress`（可逆，不删） | `Suppress`（特征/文件夹） | `Suppress` | 注释掉代码 | `enabled:false`（只跳过、无 UI 语义） |
| 回滚 | 移动 `Tip` | 拖回滚条 | 拖回滚条 | 无 | 无 |
| 撤销/重做 | 事务（`doc.openTransaction`） | 完整 undo/redo | 完整 undo/redo | 编辑器的 undo | 只有 `revert` 上一版 |
| 参数化 | Spreadsheet / 表达式 | 变量、配置、表达式 | 参数、用户参数 | 脚本变量 | `params`（仅脚本模型） |
| 装配 | Assembly 工作台（1.0）/ A2plus 等 | Assembly（mate + 实例） | 组件 + 关节 | 无（第三方） | 实例 + 2 种关节（revolute/linear） |
| 草图 | Sketcher（带约束求解） | Sketch（带约束） | Sketch（带约束） | 无（profile 由代码给） | **无**（只有坐标点序列） |

---

## 3. 我们的现状（代码级）

**数据模型**（`cad-models/<名字>.json`，`readModel` / `writeModel`）：

```jsonc
{
  "name": "体验_特征",
  "kind": "features",              // 或 "script"
  "params": {},                    // script 模型才有
  "script": "...",                 // script 模型才有（注入 P = params）
  "features": [                    // features 模型才有
    {"id": "f1", "kind": "box", "label": "底板", "params": {"size": [160,100,12]}, "enabled": true},
    {"id": "f2", "kind": "cut", "label": "大孔", "params": {"with": {"kind": "cylinder", "r": 26, "h": 40, "at": [50,50,-6]}}}
  ],
  "run": 12,
  "createdAt": "...", "updatedAt": "...",
  "stats": {"volume": 177188.219, "triangles": 520, "bounds": [...], "sceneId": "scene-66"},
  "history": [ {"at": "...", "note": "参数 高: 12 → 14", "params": {...}, "run": 11, "prev": {...}} ]
}
```

**执行路径**：`featureOps(doc)` 把启用的特征摊平成 `{kind, ...params, _id, _label}` → `featuresScript(ops, exportPath)` 拼成一段 Python（`_prim` 分派 + 顺序 fuse/cut/common + dress-up + pattern + transform）→ `FreeCadBridge.run()` 起一个 `freecadcmd` 进程跑整段 → 末尾 `scene = _shape` 自动发布 `scene-N`（`publishScene`，按 `docKey` 原地更新）→ 面板轮询 `/state` 拿到新场景。

**已有能力**：19 种特征 kind（5 图元 + extrude/revolve + fuse/cut/common + fillet/chamfer/shell + 2 种 pattern + translate/rotate/mirror）；`params` 参数化（script 模型）；`cad_studio_features`（list/add/update/remove/move/toggle）；`cad_studio_scene`（list/delete/rename）；装配（实例 + revolute/linear 关节 + 驱动 + 爆炸 + measure/interference）；导出（STEP/STL，`minVolume` 过滤）；出图（HLR→SVG）；165 条回归用例。

**可用的实测数字**（用来判断「够不够快」）：单特征编辑整表重算 **0.25–0.6 s**（`体验_特征` 5 条特征）；`freecadcmd` 冷启 60–135 ms；三角化 box+孔 ~0.03 s；`/scenes` 原地更新后面板刷新 < 1 s。

---

## 4. 诊断（为什么必须现在改）

> 每条给「现象 → 根因（代码位置）→ 代价 → 正确做法」。

**F1 没有依赖图，只有数组顺序。**
`featureOps(doc)` 直接把 `doc.features` 按数组顺序摊平；下游无法知道「我依赖谁」。代价：改 `f2` 必须重跑 `f3..f5`（无所谓），但**无法回答「f4 依赖 f2 的哪个面」**，因此无法做选择器、无法做局部重算、无法做 `Show dependencies`。
→ 图（5.2/5.3）。

**F2 编辑 = 全量重建。**
`rebuild(doc)` 总是整段脚本重跑。5 条特征 0.25–0.6 s 可接受；**30 条特征就会到 3–5 s**（线性增长），而成熟 CAD 只重算脏下游。
→ 脏传播 + 节点缓存（5.3）。

**F3 没有引用/选择器，dress-up 只能作用于「全部边」。**
发射器里 `fillet` 是 `_shape.makeFillet(r, _shape.Edges)`，`chamfer` 同理。后果：①做不出「只倒这一个角」；②对 STEP 导入的体，全边倒角立刻炸（`There are no suitable edges for chamfer or fillet`）。
→ 选择器（5.4）。

**F4 没有撤销/重做。**
`history[].prev` 只支持「回退上一版」，`revert` 一次退一步、不能重做；改了三个参数想回到两步前只能连点。
→ 命令日志 + 逆操作（5.5）。

**F5 失败是「整表回滚」，不是「节点失败」。**
`runFeatureAction` 失败时 `doc.features = before` 并返回 `{reverted:true}`。这保证不脏，但**丢掉了「哪一条坏了、坏在下游哪几条」**这种信息；用户看到的是一句话，且下游是否还能算无法表达。
→ 节点状态 `ok/failed/blocked`（5.7）。

**F6 抑制只有布尔位，没有语义。**
`enabled:false` 只是跳过；没有「抑制后下游引用失效怎么办」的问题——因为还没有引用。加了引用以后这必须补上（FreeCAD/Onshape 都是「抑制=该节点及其下游不可用，但不删数据」）。
→ 抑制语义（5.6）。

**F7 没有回滚（Tip / rollback bar）。**
「回到第 3 步看看」现在只能靠临时 `toggle` 掉 4..N，且状态会写进文档、影响别人。
→ `tip` 指针，只影响求值，不删特征（5.6）。

**F8 三套状态各自为政：文档（cad-models）↔ 场景（$TMPDIR/dsh-cad-studio）↔ 装配（state.json.assemblies）。**
`docKey` 只是把场景行钉到文档身上；装配实例引用的是 STEP 文件路径，不是「模型文档 + 版本」。所以「改零件 → 装配跟着变」目前要靠覆盖同名 STEP 文件（我们验过，但它是个 trick，不是语义）。
→ 装配引用 `model@version`（5.8）。

**F9 参数是 JSON 字面量，没有表达式/变量/跨文档引用。**
`params` 只能被脚本读；两处尺寸要一致只能靠人。成熟做法是变量表 + 表达式（Onshape variables / FreeCAD Spreadsheet / Fusion user parameters）。
→ Phase 4 的 `variables` + 受限表达式（5.2）。

**F10 持久化是「整文件覆盖 + 内存历史」。**
`writeModel` 直接覆盖 JSON；`history` 20 条快照（我们刻意保留，因为 `revert` 要它）；`state.json` 由多进程并发写（我们用 `hydrateHistory` + `touched` 对账兜住）。当前能用，但**没有版本号/事务**，多客户端同时改一个模型会丢写。
→ 单 writer + `rev` + 乐观锁（5.10）。

---

## 5. 目标架构

### 5.1 分层与所有权

```
┌────────────────────────────────────────────────────────────┐
│ Panel (client.js)      ← 只读契约：payload + 写操作走 REST  │  UI 不变
├────────────────────────────────────────────────────────────┤
│ Document store         ← 唯一权威：<models>/<name>.json     │  5.2 / 5.10
│   { rev, kind, graph|features|script, params, history }    │
├────────────────────────────────────────────────────────────┤
│ FeatureGraph + Evaluator ← 脏传播 / 拓扑序 / 缓存 / 失败隔离 │  5.3
├────────────────────────────────────────────────────────────┤
│ KernelSession (freecadcmd) ← 一次批处理，一个进程            │  现状沿用
├────────────────────────────────────────────────────────────┤
│ Scene store + /state /scenes /scene/:id                     │  现状沿用
└────────────────────────────────────────────────────────────┘
```

原则：
- **文档是权威，场景是投影**。任何时刻删掉场景缓存都能从文档重建（现在也成立，`rebuild-scenes.mjs` 就是证明）。
- **求值器无状态**：给定 `(doc, tip)` 必得同一形状；不依赖上一次运行的副作用。
- **内核会话只执行代码，不做决策**：它接收「按拓扑序排好的 ops」，返回每个节点的产物摘要（volume/solids/bounds/mesh/error）。

### 5.2 数据模型

```jsonc
{
  "schema": 2,                       // 新文档写 2；读到无 schema 的按 1 迁移
  "name": "体验_特征",
  "rev": 37,                         // 单调递增，写时校验（乐观锁）
  "kind": "graph",                   // graph | script（旧 features 迁移成 graph）
  "units": "mm",
  "variables": {                     // Phase 4；可在参数里用 "#w" 引用
    "w": {"value": 160, "note": "底板长"}
  },
  "graph": {
    "tip": "f5",                     // null = 求值到末尾（回滚条语义）
    "nodes": [
      {
        "id": "f1",                  // 稳定 id，永不复用
        "kind": "box",
        "label": "底板",
        "suppressed": false,         // 文档语义；与 enabled 合并为 suppressed
        "params": {"size": [160, 100, 12]},
        "inputs": [],                // 显式依赖：节点 id 列表（本 kind 无引用）
        "status": "ok"               // 运行期投影，不写盘（写盘只写前面字段）
      },
      {
        "id": "f3",
        "kind": "cut",
        "label": "大孔",
        "params": {
          "with": {"kind": "cylinder", "r": 26, "h": 40},
          "at": {"ref": "face", "of": "f1", "selector": {"type": "plane", "normal": [0,0,1], "pick": "max-z"}}
        },
        "inputs": ["f1"]             // 由 params 里的 ref 自动推导
      },
      {
        "id": "f5",
        "kind": "fillet",
        "label": "上沿圆角",
        "params": {
          "r": 2,
          "edges": {"ref": "edges", "of": "f4", "selector": {"type": "circle", "axis": [0,0,1], "pick": "all"}}
        },
        "inputs": ["f4", "f1"]
      }
    ]
  },
  "history": [ ... ],                // 20 条快照（revert 用）+ 命令日志（undo 用，见 5.5）
  "stats": {"volume": 177188.219, "triangles": 520, "sceneId": "scene-66"}
}
```

兼容规则：
- 读到 `schema` 缺省 / `kind: "features"` → 迁移为 `graph`：`nodes = features`、`tip = null`、`inputs` 按顺序推出（`n.inputs = [n-1]`，只影响展示，不影响求值）。
- 读到 `kind: "script"` → 保持原样（脚本模型是「代码即模型」的正当逃生口，不强行图化）。
- 工具参数 `features: [...]` 继续接受（老调用方不受影响），内部转成 graph。

### 5.3 重算

**算法**（每次编辑）：

```
apply(cmd) → doc'                       // 纯函数：改 JSON
dirty = nodesAffectedBy(cmd) ∪ downstream(dirty)   // inputs 反向边
order = topoSort(doc'.graph.nodes ∩ (dirty ∪ tipPrefix))
for n in order:
    key = hash(n.kind, resolvedParams(n), inputShapesHashes)
    if cache.has(key): shape[n] = cache.get(key); continue
    batch.push(n)                        // 同一次 freecadcmd 里按序执行
run(batch)  → shape[n] / error[n]
if error[n]: n.status = failed; downstream(n).status = blocked; stop 该支路，继续其它支路
publish(sceneFrom(tip 的有效节点))
```

**关键点**
1. **输入哈希**：`hash(kind + JSON(params 解析后) + 每个 input 的 shape 摘要)`。形状摘要当前可用 `(solids, volume, bounds±1e-6, faceCount, edgeCount)`；升级路径是内核侧回传 `BRepTools::Hash` 之类的指纹。
2. **一次批处理**：多个脏节点合成一段 Python 脚本（减少进程启动）。失败时脚本按节点 `try/except` 包裹，把 `(nodeId, message)` 写回 JSON——这样「一条坏不影响另一条」。
3. **前缀求值（tip）**：`tip` 非空时只求值到该节点（回滚条语义），下游标 `skipped`。
4. **抑制**：`suppressed` 节点不执行，其下游 `blocked`（并给出「因为 f2 被抑制」的原因），**不删除**。
5. **缓存位置**：内存 LRU（进程内）+ 侧车文件 `cad-models/.cache/<name>-<hash>.json`（内核产物摘要 + 可选 BRep 快照，Phase 3 再谈）。首次实现只做内存。

**复杂度**：编辑一条末端特征 = O(1) 次内核调用；编辑第一条 = O(N)。这正好对上成熟 CAD 的手感。

### 5.4 命名与选择器（我们能承诺什么）

**选择器是显式的、可序列化的**，四种类型：

| type | 字段 | 例 | 解析规则（确定性） |
|---|---|---|---|
| `plane` | `normal`, `pick: max-z/min-z/...`，或 `plane: "XY"` | 顶面 | 在父形状里取指向该法向、沿该轴最远的平面；同分取面积最大 |
| `axis` | `origin`, `dir` | 圆柱轴 | 唯一匹配的圆柱面轴；多个则报 `ambiguous` |
| `circle` | `axis`, `diameter?`, `pick` | 孔的边 | 半径匹配（±0.01）+ 轴向匹配；多个按面积/坐标排序取 `all` 或 `pick: index` |
| `box` | `min/max` 或 `pick: corner` | 包围盒角 | 精确匹配包围盒 |

**承诺**：
- 选择器解析失败 → 节点 `failed`，消息形如 `f5 fillet：选择器 edges/face 在 f4 上找不到（normal=[0,0,1], pick=max-z；候选 3 个面）`，**绝不静默退化**。
- 重算后若选择器命中的面数量变了（如 1 个变 3 个），按「数量不符」报错而不是随便取第一个。
- 提供 `rebuild --relink`（Phase 3）：按几何签名（面积/中心/法向/半径）在候选集里找最接近的，**要求用户确认**（对应 FreeCAD 的「候选修复」档，不做自动修复）。

**不承诺**：跨任意修改的永久稳定（见 1.3）。文档里要写这一句，避免用户以为我们解决了一个业界没解决的问题。

### 5.5 撤销 / 重做

- **命令**（写进 `doc.history` 的子集）：`{op: "feature.update", id: "f2", before: {...}, after: {...}}`。
- **撤销** = 应用 `before`；**重做** = 应用 `after`。栈在内存 + 落盘（`doc.undo`/`doc.redo` 各 50 条，掉电不丢）。
- 破坏性操作（`doc delete`、`scene delete`）不进 undo（明确不可逆，需确认）——与成熟 CAD 一致。
- 快照（`history[].prev`）保留，仅用于「回到某一版」这种粗粒度操作；**不再是 undo 的实现**。

### 5.6 抑制与回滚

- `suppressed: true`：文档语义，可逆，不删数据；下游 `blocked` 并在 UI 上灰显 + 说明。
- `tip: "<nodeId>" | null`：只影响求值，不影响文档内容；UI 上是回滚条。
- 二者都不写 `history`（它们不是几何变更），只 bump `rev`。

### 5.7 错误模型

节点状态机：`pending → ok | failed | blocked | skipped`。

- `failed`：本节点执行出错（带 `message`、`hint`、`at` 时间）。
- `blocked`：上游 failed/suppressed 导致不可执行（带 `because: "f2 failed"`）。
- `skipped`：在 `tip` 之后。
- 发布场景时：只有 `ok` 的节点参与；装配/视图照常显示「能算出来的部分」，与 FreeCAD 行为一致。
- **永不**因为一个节点失败而整表回滚——那是现在的行为（F5），改掉。

### 5.8 装配层

现状：实例引用 **STEP 文件路径**（`parts[].file`），关节挂在实例上。目标：

```jsonc
{"instances": [
  {"name": "盖板", "ref": {"model": "体验_特征", "version": 37, "selector": {"type": "solid", "pick": "all"}},
   "at": [0,0,108], "rot": [1,0,0, 0,1,0, 0,0,1]}
]}
```

- `ref.model` 指向 `cad-models/<name>.json`，`version` 是 `rev`（或 `"latest"`）。
- 求值时：先算被引用的模型（带它自己的缓存），再把产物作为实例几何。
- **未指定 version 时跟 latest**（这就是用户要的「改零件装配跟着变」的正解，而不是覆盖同名文件）。
- STEP 引用保留（外部件、无源模型的情况）。
- 关节仍是 `revolute/linear`；Phase 4 再加 `cylindrical/planar/ball` —— 但**不引入通用约束求解器**（那是另一个项目）。

### 5.9 场景与 UI 契约（保持不变）

`payload` 不变：`{parts, instances, assembly, model, features, params, bounds, ...}`。新增字段只增不改：
- `payload.graph = {tip, nodes: [{id, kind, label, suppressed, status, message}]}`（面板画状态点用）
- `payload.params` 在 graph 模型下也返回（解析后的变量值）

面板改动（小）：
- 特征行加状态点（绿/红/灰）与 `blocked` 原因（hover）。
- 顶部加回滚条（`data-cad-tip`）；点某行的「滚到这里」= 设 tip。
- 抑制用眼睛图标（沿用现有交互），但语义变成 `suppressed`。
- `⌘Z / Ctrl+Z`、`⇧⌘Z` 接 undo/redo。

**UI 框架、图标条、页签、属性面板、运动面板全部不动**（用户已明确认可）。

### 5.10 并发与持久化

- `rev` 单调递增；写时 `expectedRev` 不匹配 → 409 + 当前内容（面板提示「已被别处修改」）。
- 单 writer：所有写经 `writeModelAtomic`（写 `.tmp` + `rename`）。
- `state.json` 继续由 `persist()` 写，但改成「读-合并-写」并带 `rev`（已有 `assembleRecords` 合并逻辑，扩展成通用）。
- 文档级锁：进程内 `Map<name, Promise>` 串行化同名写。

---

## 6. API 面（工具与路由）

| 变更 | 说明 |
|---|---|
| `cad_studio_doc` 增 `schema`/`variables`/`tip` | 读写新字段；旧字段继续兼容 |
| `cad_studio_features` 增 `suppress`（替换 `toggle`，`toggle` 保留为别名）、`move` 保持 | 语义改为 5.6 |
| 新 `cad_studio_tip {model, id\|null}` | 回滚条 |
| 新 `cad_studio_undo / redo {model}` | 5.5 |
| `run`/`export`/`assembly` 不变 | 契约稳定 |
| 路由新增 `POST /cad-studio/undo`、`/redo`、`/tip` | 面板用 |
| `GET /state` 增 `payload.graph`（已是场景 JSON 的一部分） | 兼容 |

---

## 7. 迁移计划（每期可独立发版）

**Phase 0（0.5 天）— 文档先行**
- 本文件进仓库；README 链到它；在 `docs/DECISIONS.md` 记 ADR-0001（为什么不用 op 日志）。
- 验收：设计评审通过（人来评）；无代码改动。

**Phase 1（1.5–2 天）— 图 + 撤销 + 错误模型**
- `schema: 2` 文档；`features` → `graph.nodes` 迁移（读旧写新）。
- `FeatureGraph`：`inputs` 推导（先从「顺序前驱」推，等价现状）、拓扑序、脏集合。
- 节点 `try/except` 批处理 + `status`；**去掉整表回滚**，改节点失败。
- undo/redo（命令 + before/after）。
- 面板：状态点、Ctrl+Z。
- 验收：harness 新增 ≥ 20 条（迁移幂等、脏集合、失败隔离、undo/redo 各 3 条）；UI 实拍；旧文档全部可打开。

**Phase 2（1–1.5 天）— 增量重算 + 抑制/回滚 + 缓存**
- 输入哈希缓存（内存 LRU）；只重算脏下游。
- `suppressed` 语义 + `tip` 回滚条（面板）。
- `Show dependencies`（面板弹窗：parents/children）。
- 验收：30 条特征的模型，改末端 < 0.3 s；改首条 < 2 s；harness 覆盖 `tip`/`suppressed`/缓存命中。

**Phase 3（2–3 天）— 选择器 + 引用（分水岭）**
- 四种选择器（5.4）+ 解析失败可见化。
- `fillet/chamfer/shell` 支持 `edges`/`faces` 选择器；`cut/fuse` 支持 `at.ref`。
- 装配 `ref: model@version`（5.8）。
- relink 入口（显式、需确认）。
- 验收：`只倒 4 条竖边`、`孔口圆角`、`改零件→装配跟 latest` 三个场景在 dev 通过；harness ≥ 30 条新用例。

**Phase 4（按需）— 变量/表达式、更多关节、草图**
- `variables` + `#name` 引用 + 受限算式（四则）。
- 关节扩到 `cylindrical/planar/ball`。
- 草图：先做 profile（点序列 + 约束标记但不求解），约束求解器单独立项。

**回退**：每期都把旧 `kind:'features'` 读路径保留（只写新格式），出问题可用 `git revert` + 读旧文档。

---

## 8. 不做（Not doing）

1. 自研 BRep / 布尔 / 倒角（用 OCCT；我们只做应用层）。
2. 通用几何约束求解器（草图层：先 profile，后议）。
3. 跨进程并行重算（单 worker 已能 0.25–0.6 s；并行会引入一致性灾难，收益低）。
4. 「任意子形状选择永久稳定」的承诺（业界未解，我们只做 5.4 的承诺）。
5. 把面板改成 FreeCAD 那种全功能工作台（用户已认可当前 UI）。
6. 兼容 dsh-cad 的 op 日志格式（已卸载；旧的只读列举保留在 `cad_studio_legacy`）。

---

## 9. 验收与回归

**每期必过**：
1. `TMPDIR=/tmp/h-xxx node test/harness.mjs` 全绿（当前 165 → Phase 1 后 ≥ 185）。
2. dev（3180）Playwright 实拍：特征面板改一条 → 视口变、状态点正确、console 0 error。
3. 生产同步前在 dev 跑满 30 分钟交互（不能只跑脚本）。
4. 旧文档（6 个真实模型）全部能打开、体积与迁移前一致（±1e-6 按 `volume` 字段比）。

**判据（不靠感觉）**：
- 增量重算：同一模型把最后一条特征改 10 次的墙钟时间中位数。
- 缓存命中率：同一会话内重复编辑的命中比例。
- 失败隔离：故意写坏 f3，f1/f2/f4 仍 `ok`（且 f4/f5 `blocked`）。

---

## 10. 参考

1. FreeCAD Wiki — *PartDesign Body*（Group / Tip / BaseFeature / recompute / visibility）  
   https://wiki.freecad.org/PartDesign_Body
2. Onshape Help — *Features and Parts Lists*（回滚条、抑制、分组、Show dependencies、pause regeneration、regeneration times、错误/缺失选择标记、交叉高亮）  
   https://cad.onshape.com/help/Content/PartStudio/features_and_parts_lists.htm
3. FreeCAD Wiki — *Topological naming problem*（Face13→Face14 复现、三档处理、do no harm、datum 缓解）  
   https://wiki.freecad.org/Topological_naming_problem
4. Fusion 360 *Timeline*（时间线 + 回滚；第三方教学页，仅作索引级旁证）  
   https://gstarcademy.com/kb/concepts/timeline-fusion
5. 本仓库实测数字：`docs/` 截图与 `test/harness.mjs` 输出；单特征重建 0.25–0.6 s（`体验_特征` 5 条）。

---

## 11. Phase 1 落地记录（2026-11-25）

本节记录文档写完之后**实际落进代码**的部分，以及实现中发现、文档原先没写对的地方。

### 11.1 已完成（host + panel）

| 文档条目 | 落地形式 | 代码位置 |
|---|---|---|
| §5.2 schema 2 | `doc.schema = 2`；`graph.nodes` 为权威存储、`features` 为兼容镜像；读旧文件自动迁移 | `readModel()` / `writeModel()` |
| §5.6 tip / 回滚 | `doc.tip`；`featureOps()` 按 tip 截断，其后节点标 `skipped`；`action: 'tip'` | `featureOps()` / `runFeatureAction()` |
| §5.6 抑制 | `enabled === false` → 发射器收到 `__skip__` 标记并跳过；graph 标 `skipped`；`suppress` 为 `toggle` 别名 | `featureOps()` / `featuresScript()` |
| §5.7 错误模型 | 发射器逐步 `try/except`：失败节点记 `{id, step, kind, label, message}`、回到上一步形状、后续节点不执行；`__out.errors` / `__out.executed` | `featuresScript()` |
| §5.7 失败可见 | 图状态 `ok / failed / blocked / skipped`，面板每行一个状态点 + hover 文案；`evaluated:false` 不再当 HTTP 失败 | `graphView()`、`postFeature()` |
| §5.5 undo | `doc.undo` / `doc.redo` 两个栈（各 50）；`action: 'undo' / 'redo'`；面板 `Ctrl+Z` / `⇧Ctrl+Z`（输入框内不劫持） | `runFeatureAction()`、Panel keydown |
| §5.7 不静默回滚 | 求值失败时**保留文档**并返回 `ok:true, saved:true, evaluated:false` + graph；只有参数校验失败（不可能产生文档）才拒 | `runFeatureAction()` |

### 11.2 实现中被证伪/修正的设计假设

1. **`JSON.stringify` 进 Python 不是合法字面量**。`{"enabled":false}` 里的 `false` 不是 Python —— 历史代码碰巧没往 op 里放布尔值，加了 `suppressed` 之后整条特征链开始报 `name 'false' is not defined`。现在统一 `_OPS = json.loads(...)`，JSON 由 Python 自己解析。
2. **"抑制 = 阻断下游"不成立**。最初按 CAD 语义让抑制节点 break，结果"静音一个圆角继续干活"这种最常见操作被整棵树锁死。在拿到类型化选择器（Phase 2）之前无法判断下游是否真的依赖它，因此改为**跳过 + 标 skipped**，并在文档里写明这条限制。
3. **`ok` 的语义必须区分"文档接受"与"几何成立"**。重排一个 fillet 到 body 之前，文档完全合法而几何不成立；此时返回 `ok:false` 会让 UI 假装操作没发生。现在 `ok` = 文档接受，`evaluated` = 几何成立。
4. **`runFeatureAction` 的 `list` 不重算**。它只读 stats，所以任何"改完看体积"的断言都必须走 `doc show` 或发布行，不能读 `list`。

### 11.3 回归

- `test/harness.mjs`：165 → **176 条**（新增 11 条覆盖 schema 2 落盘、失败节点命名与滞留、undo/redo、tip 截断、suppress 别名与 skipped 状态、`evaluated` 语义）。
- 测试基座须 `TMPDIR=/tmp/h-xxx` 隔离（否则会清掉 `state.json` 与 `scenes/`）。

### 11.4 Phase 2a 已落地：子形状选择器

- 语法与语义见 `docs/RESEARCH-SELECTORS.md`（CadQuery 一手对照 + 我们的取舍）。
- `fillet` / `chamfer` 支持 `edges`、`shell` 支持 `faces`，全部是**谓词**：`{axis, mode, dir, type, radius, pick, nth, near, one, tol}`。
- 失败可见：空命中 → `选择器没有选中任何边：{spec}（当前形状有 N 条边）`；`one:true` 多变 → `命中了 N 条边，但要求恰好 1 个`。
- 实测（box 60×40×20 + `fillet r2`）：全边 47,598.678 → Z 向平行边 47,931.327 → 单条 47,982.832；`shell t2` + 顶面选择器 10,940.16（全封闭 15,744）。
- 面板：选择器的字符串字段（`axis/mode/dir/type`）也可直接编辑，改完 260 ms 合并重建。

### 11.5 Phase 2 已落地：增量重算（BREP 前缀缓存）

- 每条特征的前缀算一个哈希（`sha1(EMITTER_VERSION ⊕ 前一哈希 ⊕ 规范化后的 op)`，`_id`/`_label` 不参与，改名不失效；抑制的节点沿用前一哈希）。
- 每个成功步骤把 `shape.exportBrep()` 原子写到 `<dataDir>/cache/f_<hash>.brep`；重算时从**最深命中前缀**恢复，只跑后面的步骤。
- 整链哈希与 `doc.stats.hash` 相同且场景还在 → **完全不起内核进程**（`revalidated: true`）。
- 失败节点不写缓存；缓存按「400 个文件 / 14 天」上限淘汰；`EMITTER_VERSION` 变更即整体失效。
- 实测（dev，freecadcmd 0.20.2，17 条特征）：首次 354 ms；**无改动 1 ms**；只改末条 264 ms（16/17 来自缓存）；改首条 ~350 ms。
- 结论：算力已经不是瓶颈，**剩下的是每次 spawn 的 150–200 ms**；下一步才是常驻内核会话（不在本期内）。

### 11.6 仍是 Phase 3+

- 选择器布尔组合（`and/or/not/except`）与拓扑关系（`ancestors/siblings`）——先看真实用法。
- 输入哈希缓存与增量重算（当前一次改动 = 一次全量进程，0.3–0.6 s）。
- 输入哈希缓存与增量重算——现在一次改动 = 一次全量 freecadcmd 进程（0.3–0.6 s）。
- 装配的 `ref = model@version`（当前是 `asm:N` 指针 + 快照）。
- 草图/约束求解。

## 11.6 落地记录（Phase 3 尾 + Phase 4 起步）

| 项 | 状态 | 实测 |
|---|---|---|
| `at.ref`（特征挂在面上） | 已实现 | 板 16→30 厚，凸台随顶面走，Δ = 112000 mm³；选空时报错 |
| 五类关节声明（revolute/linear/cylindrical/planar/ball） | 已实现 | 一律只驱动一个数；cylindrical 的第二个自由度**未接线**，故不提供 `slide` 参数（避免半接线的参数） |
| 变量与表达式 | 已实现 | `vars` + 表达式，shunting-yard 求值，禁 eval；100→200 实测 76858.41→147433.63 |
| 依赖边 | 已实现 | `dependsOn / dependents / anchored` |
| 环境自检与安装引导 | 已实现 | `cad_studio_doctor` + 面板三步引导 + `POST /doctor` |

**产品原则（用户 2026-11-25 定）**：一切功能应当安装即用；不能安装即用的**必要**功能必须有
引导，不能安装即用的**可选**功能必须有安装引导与状态检测。当前唯一的必要外部件是
`freecadcmd`，已按此实现（引导 + 自检 + 一键安装 + 失败给命令与原因）。
