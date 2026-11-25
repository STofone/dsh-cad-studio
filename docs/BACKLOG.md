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
- [ ] 6. 面板草图页签：几何与约束列表、数值可改、冲突标红
- [ ] 7. 草图约束补全：angle / tangent / symmetric / equal

## P2 交付链
- [x] 8. Mesh 修复与减面（`MeshPart.meshFromShape` + 去重/补洞/减面），导出前自检
- [x] 9. 几何自检 `cad_studio_check`：isValid / 是否闭合 / 反向面 / 最小壁厚提示
- [ ] 10. TechDraw 正式图纸（多视图 + 尺寸标注 + 图框）——HLR SVG 已有，缺标注
- [ ] 11. 展开图 DXF（钣金式平铺）

## P3 装配
- [ ] 12. mate 约束求解（同心 / 贴合 / 距离），不只有关节
- [ ] 13. 依赖 UI（Show dependencies 面板）与 relink

## P4 系统
- [ ] 14. journal 落盘（重启后撤销栈还在）
- [ ] 15. P5 外观持久化（视图状态进文档，与文档撤销统一时序）

## 明确不做
- 旧 op 日志重放导入（静默算错几何的风险不可接受）
- Path/Fem/Arch/Robot/Ship/Idf/Plot/Raytracing/Web/Points/ReverseEngineering/Inspection/AddonManager/Start/Tux
