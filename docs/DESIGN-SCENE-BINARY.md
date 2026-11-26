# 场景几何的二进制传输（DCS2）

状态：v0.33.0 起默认开启；旧场景（内联 `verts`/`tris`）继续可读。
目的：把「一份模型在面板里显示」所需的几何，从 JSON 十进制数组换成紧凑二进制，
同时解决三个已发生的问题：加载慢、场景文件大、30 行列表里挤满多 MB 文件。

## 1. 我们现在的做法与代价

`publishScene()` 把网格写成 `scenes/scene-N.json`：
`{parts:[{id, verts:[x,y,z,…], tris:[i,j,k,…], volume}], instances:[…]}`。

一个中等零件（约 5 万个三角）的 `verts` 有 15 万个数字。JSON 里每个浮点约
**9–12 字节**（`-12.345678,`），而它表示的只是 4 字节的 f32；
浏览器还要把这串数字**逐个 parse 回 double 再转 f32**。
体积与解析成本都在这里，而不在几何本身。

## 2. 外部方案读到的三件事

- **GLB（glTF 二进制容器）**：把 JSON 与几何分开——JSON 只放结构，几何放 BIN chunk，
  用 typed array 直接映射。它明确避免的正是「把几何塞进 JSON / 用 base64」：
  base64 会让二进制**多 33%**，而十进制文本更糟。结论：容器要有，但**不要 base64**。
- **meshopt / KHR_mesh_quantization**：顶点坐标按包围盒**量化成整数**
  （u16/i16 + `scale`/`offset`），法线用 i8。相对 Draco，meshopt 换来的压缩率略低，
  但**解码快、不需要额外 WASM 解码器**——对「打开面板就要看到模型」的交互场景，
  解码延迟比极限压缩率更重要。结论：量化，但不引入 Draco。
- **OCCT 的 `BRepGraph_MeshCache`**：三角化结果按面缓存、只对变化的面重算。
  我们的 BREP 缓存已经按 `(EMITTER_VERSION, op 链哈希)` 做了同样的分层，
  所以这次**不再重复造缓存**，只换传输层。

## 3. 设计

### 3.1 容器

```
DCS2 文件 = [4B "DCS2"][4B headerLen LE][header JSON utf8][payload]
header = { v:2, units:"mm", parts:[{ id, vcount, tcount, posOff, idxOff,
                                     min:[x,y,z], step:[x,y,z] }] }
payload = 每个零件依次：[positions u16 LE × vcount×3][indices u32 LE × tcount×3]
```
- `posOff`/`idxOff` 相对 payload 起点（不是文件起点），客户端只建一个 DataView。
- `step[k] = (max-min)/65535`；`extent=0` 时 `step=0`（避免除零）。
- 解码：`v = min[k] + q * step[k]`。精度 = 包围盒跨度 / 65535：
  60 mm 零件 ≈ **0.0009 mm**，远小于三角化弦差 0.25 mm，肉眼与测量（测量在
  服务端按 B-rep 算，不受此影响）都够用。
- **不存法线**：客户端 `computeVertexNormals()` 从量化后的位置算。
  `_mesh()` 已经按面复制顶点，所以平面保持硬边、曲面保持光滑——和 JSON 版逐字一致。

### 3.2 谁打包

**Host 打包**，不在 FreeCAD 侧打包：
所有产出几何的入口（`run` / `open` / `assembly` / `doc rebuild` / `drive` / `explode`）
最终都汇到 `publishScene()`，在那里统一打包一次，就覆盖全部路径；
若在 Python 侧写，得改五个发射器，且 `marker + JSON` 协议本身也过不了二进制。

`publishScene()` 打包后：磁盘 JSON 只留元数据（`bin:{file,bytes,parts}` + 零件 id/颜色/体积），
内存 `this.scenes` 同样只留元数据；几何只在 `.dcs` 里。

### 3.3 怎么送到浏览器

- `GET /cad-studio/scene/scene-N.json` —— 元数据（原来的路径，形状不变，`verts/tris` 消失）。
- `GET /cad-studio/scene/scene-N.dcs` —— 二进制；`accept-encoding: gzip` 时 gzip，
  u16 量化数据本身熵低，gzip 还能再省 1.5–2 倍。
- 客户端 `loadScene()`：拿到 JSON 后若 `scene.bin` 存在，再取一次 `.dcs`，
  一次解码填回 `part.verts/part.tris`（`Float32Array`/`Uint32Array`），
  后面的 `buildGraph` 不用改——`Float32BufferAttribute` 与 `setIndex` 本来就吃 typed array。

### 3.4 兼容与回退

- 老场景文件没有 `bin` → 客户端走原来的内联数组路径，一个字节都不用改。
- `.dcs` 缺失/损坏 → `catch` 后保持 `part.verts` 未定义，`buildGraph` 已有的
  「没有三角就跳过该零件」分支生效，画面缺一个零件而不是整块崩。
- 想比较新旧体积：`cad_studio_scene list` 每行的 `triangles` 不变（统计仍在内存算），
  文件大小看 `stat scenes/scene-N.{json,dcs}`。

## 4. 预期与验收

- 场景 JSON 体积降到原来的 **1/8–1/12**（几何搬走 + 量化 + 去十进制文本），
  `.dcs` 再经 gzip 后约为 JSON 的 **1/15**。
- 加载时不再解析百万级十进制数字；一次 `ArrayBuffer` 拉取 + 三个 `Uint16`/`Uint32` 视图。
- 验收（harness）：发布一个长方体场景后，
  ① `.dcs` 存在且字节数 = `8 + headerLen + payload`；
  ② 场景 JSON 里没有 `verts`；`bin.parts[0].vcount` 与三角数对得上；
  ③ 用 Node 解码回来，每个顶点与原始坐标差 ≤ `step`；
  ④ 路由返回 `application/octet-stream`，带 `accept-encoding: gzip` 时有 `content-encoding: gzip`；
  ⑤ 老格式场景（无 `bin`）仍能通过 JSON 路由取到。

## 5. 不做什么

- 不引入 Draco/meshopt 编解码器（多一个 WASM、解码更慢，收益只有磁盘）。
- 不做渐进式 LOD / 流式分块（当前瓶颈是整包体积，不是首屏可见时间）。
- 不自研 CAD 文档格式（我们的 features/graph 文档 + undo 栈已在用，不动）。
