# dsh-cad-studio

DeepSeek Harness 的 CAD 插件：**把 FreeCAD 桥接成给 AI 用的工具**，并在 Web 右栏提供一个只读+轻交互的 3D 面板。

![面板](docs/preview.png)

- Host 侧（`index.js`）：13 个工具 + `/cad-studio/*` HTTP 路由 + `freecadcmd` 子进程桥
- 客户端侧（`client.js`）：右栏页签「CAD 工作室」，three.js 视口 + 图标条浮层（零件 / 特征 / 选中项 / 运动 / 视图 / 模型 / 信息）
- 数据：`<modelsDir>/<名字>.json` 存模型工程（脚本或声明式特征 + 参数 + 20 条历史）；场景网格落 `$TMPDIR/dsh-cad-studio/{state.json,scenes/*.json}`

## 能力

| 领域 | 做什么 |
|---|---|
| 建模 | `cad_studio_feature` 声明式特征（box/cylinder/sphere/cone/torus/extrude/revolve/fuse/cut/common/fillet/chamfer/shell/pattern/translate/rotate/mirror）；`cad_studio_run` 跑任意 FreeCAD Python |
| 工程文件 | `cad_studio_doc` 存 `script` 或 `features` 两种模型；`cad_studio_features` 改一条特征→整表重算（0.2–0.6 s），失败整表回滚 |
| 装配 | `cad_studio_assembly` 读 manifest，`App::Link` 语义的实例位姿；零件是 STEP 文件级引用（改零件重开即跟随） |
| 运动 | `cad_studio_joint`（revolute/linear）+ `cad_studio_drive` + `cad_studio_explode`，面板拖滑杆看运动 |
| 出图 | `cad_studio_drawing` HLR → SVG（主/俯/左/等轴） |
| 其它 | `cad_studio_open`（STEP/STL/BREP/IGES 进来看）、`cad_studio_export`、`cad_studio_measure`、`cad_studio_env` |
| 自检/安装 | `cad_studio_setup`：报告 freecadcmd 是否可用、版本、包管理器与可执行命令；`action=install` 直接装 |
| 面板 | 多页签（上限 5，各自记住相机与配色）、点选联动、色块换色、显隐、透明度、线框、隔离、标准视图、网格/轮廓/光影开关 |

## 安装

需要本机有 `freecadcmd`（FreeCAD ≥ 0.20）。装插件不等于装 FreeCAD——它是外部程序，213 MB 左右，不随 npm 包分发。

装法二选一：

1. **让面板装**：打开右栏「CAD 工作室」→ 信息（i）→ 看到黄框点「自动安装 FreeCAD」。后端 `cad_studio_setup` 会自动识别 apt / dnf / pacman / brew 并执行（apt 需要 root）。
2. **自己装**：`apt install freecad`，然后在插件配置里留空 `freecadPath`（自动探测 `/usr/bin/freecadcmd` 等 5 个位置）或显式指定。

```bash
dsh plugin --profile web add /path/to/dsh-cad-studio
# 重启 dsh 使 host 侧工具挂载；client 侧刷新页面即可
```

配置项（cordis 配置）：`freecadPath`（默认自动探测 `/usr/bin/freecadcmd` 等）、`timeoutMs`（默认 180000）、`modelsDir`（默认跟随会话工作区的 `cad-models/`）、`trustedHosts`。

## 场景 JSON 协议

```jsonc
{
  "parts": [{ "id": "p1", "verts": [...], "tris": [...], "volume": 1234.5 }],
  "instances": [{ "name": "底座", "part": "p1", "rot": [1,0,0, 0,1,0, 0,0,1], "translate": [0,0,0] }],
  "assembly": { "id": "asm-1", "title": "运动演示", "explode": 0,
                "joints": [{ "id": "hinge", "instance": "盖板", "type": "revolute",
                             "axis": [1,0,0], "origin": [0,0,40], "value": 0, "min": -90, "max": 90 }] }
}
```

`rot` 是行主序 3×3，`translate` 是 mm。几何按**逐面三角化**，平面与孔壁不共享顶点（避免法线平均出暗色扇形）。

## 开发

```bash
node test/harness.mjs      # 133 条回归：无浏览器，stub cordis ctx 直接调工具
node test/stale-bridge.mjs # 热重载后旧 bridge 实例自愈
```

`test/replicate.mjs`、`scripts/*.mjs` 是我自己造场景/验证用的夹具，按需改路径。

## 已知限制

- 依赖外部 `freecadcmd`（约 213 MB），不是纯 wasm
- 关节只支持 revolute / linear，没有约束求解器
- 没有草图参数化与约束求解
- 工具粒度比 dsh-cad 的 34 个增量工具粗：常见活走 `feature`，特殊活写脚本

## License

MIT
