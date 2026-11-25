# 草图与约束：FreeCAD 0.20.2 headless 实测 + 我们怎么接

> 目的：不自己写求解器。FreeCAD 自带 `Sketcher`（SolveSpace/planegcs 血统），
> 我们要做的是**把它接进我们的历史模型**：草图的 JSON 表示、稳定 id、
> 求解失败可见、增量缓存、面板交互。本文只记实测事实，不写愿望。

## 1. 事实：headless 可用（dev，freecadcmd 0.20.2，无 DISPLAY）

| 动作 | 结果 |
|---|---|
| `doc.addObject('Sketcher::SketchObject','K')` | ✅ |
| `addGeometry(Part.LineSegment(...), False)` 多次 | ✅ |
| `addConstraint(Sketcher.Constraint('Coincident', a, 2, b, 1))` 四点闭合 | ✅ |
| `addConstraint(('Horizontal'|'Vertical', i))` | ✅ |
| `solve()` 成功 | 返回 **0** |
| `solve()` 遇矛盾约束 | 返回 **-3** |
| `doc.recompute()` 后 `sk.Shape.Wires` | ✅ 1 条 wire，可 `Part.Face(...).extrude()` |
| 单次「建+约束+求解+挤出」 | **~210 ms** |

`sk` 上确实有：`solve` / `getDatum` / `setDatum` / `FullyConstrained` / `ConstraintCount`。
（`detectConflicts` / `getConflicting` **不存在**，冲突只能靠 `solve()` 的返回码。）

## 2. 事实：尺寸约束的 API 会「报成功但没做到」（最危险的一条）

- 写成 `('DistanceX', 0, 1, 0, 2, 80.0)`（四点式 + 值）时，`solve()` 返回 **0**，
  但几何只走到 `x = 58.56`，不是 80。
- 改成 `setDatum(idx, Quantity('120 mm'))` 再 `solve()`，结果是 `x = 67.11`，也不是 120。
- 结论：**返回码 0 不代表尺寸被满足**。0.20 的尺寸约束签名与 1.0 文档不一致，
  且不会报错。

### 因此本项目立一条硬规则（写进实现）

> **求解后必须自检。** 每个尺寸约束在 `solve()` 之后，从结果几何里重新量一遍
> （两点距/半径/夹角），与请求值比对，容差 1e-6；不一致就把这条约束判为
> `unsatisfied` 并**回滚到上一次成功的几何**，绝不把错形状交给下游特征。

这条规则同时覆盖三种情况：签名写错、求解器发散、约束互相打架。

## 3. 数据模型（存在文档 JSON 里，不用 FreeCAD 的索引当身份）

```jsonc
sketch: {
  name: "S1",
  plane: { at: [0,0,0], normal: [0,0,1] },      // 挂主平面或某个面上
  geometry: [
    { id: "g1", type: "line", p1: [0,0], p2: [50,0] },
    { id: "g2", type: "arc",  c: [50,15], r: 15, a1: -90, a2: 90 }
  ],
  constraints: [
    { id: "c1", type: "coincident", a: ["g1", 2], b: ["g2", 1] },
    { id: "c2", type: "horizontal", a: ["g1"] },
    { id: "c3", type: "distance_x", a: ["g1", 1], b: ["g1", 2], value: 80 }
  ]
}
```

- **id 是身份，索引是临时的**：每次重建把 `g1..gn` 映射成当时的 `GeoId` 顺序号，
  绝不把 `GeoId` 存进 JSON（重排一次就全错）。
- 特征引用草图用名字：`{ kind: "extrude", sketch: "S1", h: 10 }`。
- 草图哈希参与增量缓存的 op 链（草图的点/约束任一变化 → 下游全部失效）。

## 4. 第一版约束集（8 种）与自检量

| 约束 | FreeCAD 调用 | 求解后自检 |
|---|---|---|
| coincident | `('Coincident', a1, p1, a2, p2)` | 两点距 < 1e-6 |
| horizontal / vertical | `('Horizontal'/'Vertical', gi)` | 端点 y（或 x）相等 |
| parallel / perpendicular | `('Parallel'/'Perpendicular', a, b)` | 方向叉积/点积 |
| tangent | `('Tangent', a, b)` | 圆心到线距离 ≈ r |
| distance_x / distance_y | 两点式（见 §2 备注） | 实测差值与 value 一致 |
| angle | `('Angle', a, b, value)` | 实测夹角 |
| radius / diameter | `('Radius', gi, value)` | 实测半径 |
| concentric | `('Coincident', c1, 3, c2, 3)` | 圆心距 < 1e-6 |

## 5. 失败语义（不做静默退化）

- `solve()` < 0 → `evaluated:false`，`errors:[{constraintId, code, message}]`；
  **下游被 skip**，场景保持上一次成功几何。
- 自检不一致（§2）→ 同上，但额外标出「哪一条尺寸没被满足、实测多少」。
- 过约束（`solve()` 返回 0 但 `FullyConstrained` 与 DoF 矛盾）→ 只警告，不失败。
- 面板：约束行标红 + 底部提示「第 3 条距离约束冲突（实测 58.56，要求 80）」。

## 6. 分期

1. **API 摸准**（本文）：签名矩阵 + 自检函数 `verify_solution(sk, sketch)`（半天）
2. 数据模型 + 发射器（JSON → Sketcher → wire → 现有 extrude/revolve/loft/sweep）
3. 面板草图页签：几何列表（点坐标可改）、约束列表（值可改）、冲突标红
4. harness：闭合矩形→挤出体积、改 value 驱动、矛盾约束必须 `evaluated:false`、
   自检不一致必须报错（用错签名构造一个 case 当牙）
5. 与增量缓存对齐：草图哈希进 op 链

## 7. 参考

- FreeCAD `Sketcher::SketchObject` Python API（`addGeometry` / `addConstraint` /
  `solve` / `setDatum` / `getDatum` / `FullyConstrained`）
- SolveSpace / planegcs：FreeCAD 求解器来源，约束语义的权威定义
- 我们的 `docs/DESIGN.md` §5（历史模型）与 §11（落地记录）

## 8. 实测补充：0.20 上真正能用的尺寸签名（2026-11-25）

| 写法 | 返回 | 实际效果 |
|---|---|---|
| `('DistanceX', geo, pos, value)` | 0 | ✅ 把该点的**绝对 X 坐标**设为 value |
| `('DistanceX', geo1, pos1, geo2, pos2, value)` | 0 | ❌ 值被忽略（几何走到 58.56 这种位置） |
| `('Distance', geoA, posA, geoB, posB, value)` | 0 | ✅ **两点距离** = value（我们用它做宽度/高度） |
| `setDatum(idx, Quantity('80 mm'))` | 0 | ✅ 但需先有该约束，且 idx 要拿对 |

结论：**宽度/高度这类「两点距离」必须用 `Distance`，不能用 `DistanceX`**；
`DistanceX/Y` 是绝对坐标约束。我们的自检函数按语义分别测量：
`Distance` → 两点欧氏距离；`DistanceX/Y` → 该点坐标；`Radius` → 半径。

### 已完成的最小闭环（0.9.0）

- 数据模型：`sketches: {S1: {geometry:[{id,type,line|circle}], constraints:[{id,type,...}]}}`，
  特征写 `{kind:"extrude", sketch:"S1", h:10}`。
- 发射器：JSON → `Sketcher` 调用 → `solve()`（rc<0 直接失败）→ **逐条尺寸自检** →
  `sk.Wires[0]` → `Part.Face().extrude()`。
- 实测：80×40 矩形挤出 h10 = **32000 mm³**；改宽度 120 → **48000 mm³**（尺寸驱动成立）；
  加一条矛盾尺寸 → `solve()=-3`，工具返回 `ok:false` 且文案点明冲突（不静默）。
- 回归：**213 passed / 0 failed**（新增 3 条草图用例）。
