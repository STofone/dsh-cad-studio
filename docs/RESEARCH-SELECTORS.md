# 子形状选择器：业界做法与我们能兑现的语义

> 范围：Phase 2a 的地基调研。问题只有一个——**fillet/chamfer/shell 这类"作用在某个面/某条边上"的特征，怎么在不引入持久命名（persistent naming）的前提下，把"哪条边"写成可序列化、可复现、失败可见的参数。**

## 1. 事实：持久命名是无解的，业界的答案是"每次重建重新选"

FreeCAD Wiki 的 *Topological naming problem* 与我们的实测一致：OCCT 每次重建都会重新生成拓扑，`Face13` 在新形状里可能变成 `Face14`。FreeCAD 至今没有解决，官方口径是"识别 → 给候选 → 高置信才自动修，*First, do no harm*"，并建议用户把草图挂到 datum/主平面而不是"上一个面"。

也就是说，成熟系统没有一家靠"记住 shape 的指针"过关，它们靠的是**下一次重建时用几何谓词重新找一次**。我们要照抄的是这条路线，而不是去发明持久 ID。

## 2. CadQuery 的选择器（一手来源：[Selectors Reference](https://cadquery.readthedocs.io/en/stable/selectors.html)）

字符串语法，按对象类型分三类过滤：

| 面向 | 语义 | 例 |
|---|---|---|
| 方向 | 法向/切向对齐某个轴 | `+Z` 法向朝 +Z；`\|Z` 平行于 Z；`#Z` 垂直于 Z；`-X` 朝 −X |
| 类型 | 只取某类 | `%Plane`（面）、`%Line`（边） |
| 极值 | 沿某轴最远/最近 | `>Y` 最远、`<Y` 最近；`>Y[-2]` 第 2 远（按法向）；`>>Y` 按**质心**排序 |

- 可组合：`and` / `or` / `not` / `except`，例 `.edges("|Z and >Y")`。
- 自定义方向：`>(-1, 1, 0)`。
- 拓扑关系：`ancestors()` / `siblings()`。

**官方警告（我们要照抄进自己的文档）**：

1. 非平面面按**质心**处的法向判定，结果"可能非常意外"；
2. 非线性边**除 `%`/`>>` 外一律选不到**——圆角边、圆弧边对 `|Z` 这类方向选择器天然失效。

## 3. build123d 的同类 API（索引级旁证）

`build123d`（gumyr）把它做成对象式：`shape.edges().filter_by(Axis.Z)`、`.sort_by(SortBy.LENGTH)[-1]`、`.group_by(...)`。语义与 CadQuery 同族——**谓词 + 排序 + 取第几个**，同样是"每次重建重新选"，没有持久 ID。（页面正文未取到，此处只作索引级引用。）

## 4. 我们的选择（写进 schema 2 的 `select` 语法）

原则：只做**能说清失败**的那部分，宁可窄。

```json
{"kind": "fillet", "r": 2, "edges": {"axis": "Z", "mode": "parallel", "type": "line", "pick": "max"}}
{"kind": "chamfer", "d": 1.5, "edges": {"axis": "Z", "mode": "aligned", "dir": "+"}}
{"kind": "shell", "t": 2, "faces": {"axis": "Z", "mode": "aligned", "dir": "+", "type": "plane"}}
```

字段（全部可序列化，缺省值写死）：

| 字段 | 取值 | 说明 |
|---|---|---|
| `axis` | `X`/`Y`/`Z` 或 `[x,y,z]` | 判定基准方向，默认 `Z` |
| `mode` | `parallel` / `aligned` / `perpendicular` | 边按切向、面按法向判定 |
| `dir` | `+` / `-` | 仅 `aligned` 用；缺省 `+` |
| `type` | 边：`line`/`circle`；面：`plane`/`cylinder` | 缺省不过滤 |
| `radius` | number | 边为圆时按半径过滤（容差 `tol`） |
| `pick` | `max` / `min` | 沿 `axis` 取质心极值的一个 |
| `nth` | int | 与 `pick` 合用取第 n 个（0 起） |
| `near` | `[x,y,z]` | 取离该点最近的一个（配合 `tol`） |
| `one` | bool | 为真时要求恰好命中 1 个，否则报错 |
| `tol` | number | 几何容差，默认 0.5 mm |

**失败即报错**（节点级隔离会把它显示成 `failed` + 具体文案）：

- 一个都没有 → `选择器没有选中任何边：{…}`（附当前形状的边数/面数，方便判断是不是轴写错了）；
- `one:true` 且命中多个 → `选择器命中了 N 条边，但要求恰好 1 条：{…}`。

**不做**：`and/or/not` 布尔组合（先看真实用法再决定要不要引入表达式求值）、`ancestors/siblings` 拓扑关系（需要整套拓扑图，Phase 3 再说）。

## 5. 与"持久引用"的关系

装配层的 `ref = model@version`（DESIGN §5.8）解决的是"引用哪个模型版本"，与这里的"引用模型里的哪条边"是两件事：

- 模型内引用：**谓词每次重算**（本节），不做持久 ID；
- 跨模型引用：**版本化指针**（§5.8），因为 STEP 是文件、可哈希。

两者都遵守同一条承诺：引用失效必须**可见**，绝不静默换成另一条边。
