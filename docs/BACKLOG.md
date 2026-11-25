# BACKLOG（按顺序消，做完一项打勾）

> 规则：一项必须走完「改码 → harness 全绿 → 发版 → 同步 dev 跑 dev harness」才算勾掉。
> 每项做完在 README / DESIGN 对应处补一句，避免只有代码没有说明。

## P0 收口
- [x] 1. 模型改名 / 复制（`cad_studio_doc {action:'rename'|'duplicate'}`），改名要改 `stats.sceneId` 行的标题与 docKey
- [x] 2. 旋转出实体：定位 `revolve` 返回 volume 0 的原因（拿完整 traceback；试 `Part.makeRevolution` / `Wire.revolve` / `sewShape` 组合）
- [ ] 3. 拔模（阻塞：0.20 的 makeLoft 从两个面宿出零体积壳，需要换构造方式） `draft`：从底面轮廓向内偏移 `h*tan(angle)` 再 makeLoft
- [x] 4. 旋转切除（= cut + revolve，已由 harness 钉住） `groove`（依赖 #2）

## P1 草图
- [x] 5. 草图→`loft` / `sweep`（多草图截面）+ 草图存进文档
- [x] 6. 面板草图页签：几何与约束列表、数值可改、冲突标红（特征抽屉里的「草图 N」，改数值即重建）
- [x] 7. 草图约束补全：angle / symmetric / equal（angle 用户按度、内核按弧度，solve 后自检重测）

## P2 交付链
- [x] 8. Mesh 修复与减面（`MeshPart.meshFromShape` + 去重/补洞/减面），导出前自检
- [x] 9. 几何自检 `cad_studio_check`：isValid / 是否闭合 / 反向面 / 最小壁厚提示
- [x] 10. 正式图纸 `cad_studio_sheet`（A4/A3/A2 图框 + 标题栏 + 三视图 + 尺寸 + 第一/三角法；`dxf:true` 走 `TechDraw.writeDXFPage`）。TechDraw 0.20 headless 没有 PDF/整页 SVG 导出，所以图框与标注自己拼。
- [x] 11. 展开图 DXF（钣金式平铺）——`cad_studio_unfold`，0.25.0：平面面片按共享边等距铺开（面积与模型一致），带孔件每个孔各自成环，曲面如实报 `curvedSkipped` 而不是瞎编

## P3 装配
- [x] 12. mate 约束求解 `cad_studio_mate`（concentric 轴心+轴向距离 / flush 贴合 / distance 面距；按顺序解算，一次求解后固定，与关节驱动分开）
- [x] 13. 依赖 UI 与 relink：`record.spec` 记「零件名 → 文件路径」并随指针落盘；`cad_studio_deps {action:'list'|'relink'}` + `GET /cad-studio/deps` + `POST /cad-studio/relink`；relink 用同一份 spec 重跑装配、`rebaseAssembly` 保住 id/关节/mate/外观，读不到文件则回滚路径；面板「信息」抽屉里的「来源文件」列出存在/缺失（`data-cad-dep`、`data-cad-dep-state`、`data-cad-relink-input`、`data-cad-relink`）；`hydrateAssemblies()` 修掉重启后依赖表空掉。

## P4 系统
- [x] 14. journal 落盘：`<数据目录>/journal.json` 存最近 20 条可重放记录（`doc-create` / `doc-delete` 带 base64 字节 / `doc-rename`），插件启动时 `loadJournal` 重建；`undoSession` 先 `await bridge.journalReady` 再取栈（否则会误报「没有可撤销的操作」）。装配/视图类 journal 是活对象闭包，仍只在本会话有效——重启后没有这条记录，面板会说没有可撤销，而不是错撤别的东西。
- [x] 15. P5 外观持久化：外观（颜色/显隐/透明度/线框）按**模型**存（`docKey` 如 `asm:asm-3`），`POST /cad-studio/appearance` 校验后写进 `state.json.appearances` 并镜像进该模型的每个场景文件；面板载入时先取服务端外观，改动用 700 ms 防抖回写。撤销仍是纯客户端快照栈（服务端 doc.undo 管不到外观），两者时序各自独立但互不覆盖。
- 装配改为可原地重建：`cad_studio_assembly {assembly:'asm-3'}` 复用同一 id（保留关节/mate/外观），只有形如 `asm-N` 才当 id，其它字符串仍当显示名。

## 明确不做
- 旧 op 日志重放导入（静默算错几何的风险不可接受）
- Path/Fem/Arch/Robot/Ship/Idf/Plot/Raytracing/Web/Points/ReverseEngineering/Inspection/AddonManager/Start/Tux
