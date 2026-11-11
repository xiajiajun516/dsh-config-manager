# dsh-config-manager · UI 全量重构设计稿（Stitch）

把 `src/client/` 下每个页面、每个可跳转独立页面、每个弹窗入口及其子级，用 Stitch 各产出一版**优化后**的设计稿，并给出逐屏缺陷/改动清单与跨屏一致性报告。

- 生成方式：Stitch MCP（项目 `3562749276376933419`「DSH Config Manager · UI v4 全量重构」，DESKTOP）
- 写稿口径：真实源码结构 + 真实 DSH 亮色 token + 真实文案，不做「美化想象」
- 本轮范围：**只画稿，不改代码**（落地代码是阶段 F，需单独批准）

## 目录

```
.stitch-refactor/
  pages.md                     # 阶段 A 清单：53 项、DFS 顺序、范围外说明
  base-prompt.md               # 每屏必带的统一视觉规范（BASE）
  consistency.md               # 阶段 C：跨屏一致性报告（18 条 C 行 + 成因）
  pages/<ID>.md                # 逐屏记录：源码行号 / 保留清单 / 缺陷与轮次 / 终态 id
  prompts/<ID>.md              # 实际发给 Stitch 的提示词（BASE 全文 + 页面段）
  shots/<ID>-after.png         # 设计稿（Stitch 渲染）
  shots/<ID>-before.png        # 真实实现截图（对照，11 张页面级）
  out/<ID>.html                # Stitch 导出的 HTML（已做 token 归一）
```

## 方法与顺序

阶段 A（清单）→ B（单页深耕：写提示词 → 生成 → 独立审查 → 我逐条核实 real/false → `edit_screens` 合并修订 → 每屏最多 3 轮 → 压入该页的跳转/弹窗入口进 DFS）→ C（一致性：横向比对 → `consistency.md` → 只回修 real 项）→ E（导出与汇总，即本文件）→ F（落地代码，**未执行，需批准**）。

每条审查结论写成一行：`D-<n> | 类型 | 位置 | 证据 | P0/P1/P2 | 建议改法`，类型只用 重复信息/丢失入口/无关元素/栅格与布局偏离/视觉 token 不一致/状态缺失/交互歧义/文案问题。证据必须指到源码行号或实测值，否则不计入。

## 屏幕清单（54 项，全部出图）

| ID | 页面 / 弹窗 | 真实实现入口 | 终态 screen id |
| --- | --- | --- | --- |
| D-01 | D-01 定时备份 | `src/client/home/BackupScheduleCard.tsx` | `1821188adb024788a3bce10bcd32570a` |
| D-02 | D-02 恢复计划预览 | `src/client/library/RestorePlanView.tsx` | `afccbb899cac40be957d4c1537607254` |
| D-03 | D-03 迁移前咨询 | `src/client/library/LibraryActions.tsx` | `fbc390ecd2e5454d8c1f33217ad0b9b6` |
| D-04 | D-04 拉取远端快照（进行中） | `src/client/library/LibraryActions.tsx` | `14a43470e0d04ac2ae0a4d89baf3e35d` |
| D-05 | D-05 查看 / 对比（备份内容查看） | `src/client/library/LibraryActions.tsx` | `f4bd30f7d8224c21836d5b1622102f75` |
| D-06 | D-06 恢复报告 | `src/client/library/LibraryActions.tsx` | `8a6d42fbd63746b69108f28a81cceae4` |
| D-07 | D-07 删除远端快照（确认） | `src/client/library/LibraryActions.tsx` | `2c670a9333bd4d3fa7a8283899569fea` |
| D-08 | D-08 同步通道配置（Git 私有仓库） | `src/client/sync/SyncPanel.tsx` | `d43ae1db6a3c4265a42537228a326970` |
| D-09 | D-09 断开同步通道配置（危险确认） | `src/client/sync/ChannelClearConfirmDialog.tsx` | `04609199e6f342cebdc69d93d765fb81` |
| D-10 | D-10 从远端合并到本机（差异确认） | `src/client/sync/SyncPanel.tsx` | `1a4999f5a86d4a6e81a105476d2a781b` |
| D-11 | D-11 确认推送（推送预览） | `src/client/sync/SyncPanel.tsx` | `e23f26410f494e41a1b59d0a62d76da6` |
| D-12 | D-12 推送结果（结果报告） | `src/client/sync/SyncPanel.tsx` | `9d1c3b12c308445e86b8e63abc6b94d5` |
| D-13 | D-13 远程合并弹窗（裁决态） | `src/client/sync/MergeModal.tsx` | `0713b5b97e5741008af0601ca8616f4f` |
| D-14 | D-14 选择同步分区 | `src/client/sync/SyncSectionPickerDialog.tsx` | `ede572d4801744248a8bda4f40bdec16` |
| D-14b | D-14b 选择要同步的历史对话（D-14 第二视图） | `src/client/sync/SyncSectionPickerDialog.tsx` | `93e9170a8c1f406d8385d9b63ec16ea1` |
| D-15 | D-15 重新克隆工作副本？（确认弹窗） | `src/client/sync/WorkDirCard.tsx` | `7538be6f73034bd2bd7e3de8f06c7db5` |
| D-16 | D-16 档案详情：work（只读详情弹窗） | `src/client/environment/EnvironmentPanel.tsx` | `6478913acf5f44898f5a2cd55a2d9a5b` |
| D-17 | D-17 复制档案（带输入的表单确认弹窗） | `src/client/environment/EnvironmentPanel.tsx` | `407e49ca5cbe48c0909ebeb1d21a5739` |
| D-18 | D-18 停止实例（危险确认弹窗） | `src/client/environment/EnvironmentPanel.tsx` | `9e94ec82ce4a4564ba27290ae95e2aff` |
| D-19 | D-19 删除档案（物理删除危险确认 + 勾选校验） | `src/client/environment/EnvironmentPanel.tsx` | `3b311221481e4436bf0cb12e41fa1927` |
| D-20 | D-20 环境恢复确认 | `src/client/recovery/RecoveryPanel.tsx` | `36c32809daca45ad819d4707bb5e3841` |
| D-21 | D-21 恢复风险确认 | `src/client/recovery/RecoveryPanel.tsx` | `660d30cab7654de88dbeb594f8b51260` |
| D-22 | D-22 会话体检报告 | `src/client/recovery/SessionHealthDialog.tsx` | `b7f0332a673341dea443eca0d4c247c1` |
| D-23 | D-23 回滚点预览（实为回滚点台账） | `src/client/recovery/RollbackCard.tsx` | `48f19c3c5bb34f43a321d453fc386c6f` |
| D-24 | D-24 回滚确认（实为回退预览） | `src/client/recovery/RollbackCard.tsx` | `8904bf404e0744c1b447fd7958768072` |
| D-25 | D-25 回滚三确认（画「清理回滚点台账」） | `src/client/recovery/RollbackCard.tsx` | `8f0c63cf954d4cc181acac8dd553ef66` |
| D-26 | D-26 磁盘清理确认 | `src/client/environment/maintenance/DiskUsageCard.tsx` | `ab21d3245801463bb3faaf7c6905a66e` |
| D-27 | D-27 版本更新 | `src/client/about/PluginUpdateDialog.tsx` | `b2486d16c34b46b5bd3f5346f0e2f3cd` |
| D-28 | D-28 版本更新内容 | `src/client/about/ReleaseNotesDialog.tsx` | `47a7f703658f4834a8309014790422b4` |
| D-29 | D-29 Star 引导弹窗 | `src/client/ConfigManagerSection.tsx` | `0e7da8141b634132ada3b2b579010755` |
| D-30 | D-30 ⌘K 命令面板 | `src/client/common/CommandPalette.tsx` | `ef844ed404a444b19a5f9ef8dd0add5d` |
| D-31 | D-31 终止运行（危险确认）—— 被 Stitch 每日额度阻断 | `src/client/common/RunsCenter.tsx` | `53f469bf1eb94022b20534224e3661c1` |
| D-32 | D-32 内容选择（导出分区/条目树） | `src/client/export/ExportView.tsx` | `ea2e1eaab8e345afa23dc0fc207420a0` |
| D-33 | D-33 路径选择（本机目录） | `src/client/import/PathPickerDialog.tsx` | `946350e64cd6472590470fb201cb85f6` |
| D-34 | D-34 市场免责确认（下载档） | `src/client/market/MarketPanel.tsx` | `cce18f89b420486192023e5e1fc179a7` |
| D-35 | D-35 市场·回滚到导入前快照确认 | `src/client/market/MarketImportReview.tsx` | `b7bd93e3c8f34379844ee58f478bcff5` |
| D-36 | D-36 我的配置·上传/更新向导（表单步） | `src/client/market/MyConfigsWizard.tsx` | `41d5ec4f01ee4e508b1ffcf29b4c629a` |
| D-37 | D-37 市场·装回本地（导入复核确认步） | `src/client/market/MarketImportReview.tsx` | `9a353b34d84d4957b196f112cab7f013` |
| D-38 | D-38 我的配置·删除条目二次确认 | `src/client/market/MyConfigsView.tsx` | `317bb8e059e34a91b2a07e3d73f1b0f0` |
| P-01 | P-01 首页 | `src/client/home/HomePanel.tsx` | `b9f4bdea66014ea289f5ff9771c209a6` |
| P-02 | P-02 产物库 | `src/client/library/LibraryPanel.tsx` | `0a8f79103b804750909c58d1500f363c` |
| P-03 | P-03 同步 | `src/client/sync/SyncPanel.tsx` | `1404e8c489d34dfbbbf3fd7d63b6be46` |
| P-04 | P-04 环境 · 档案 | `src/client/environment/EnvironmentPanel.tsx` | `dccd7c003bf849a6b019ffe7c10cc9f9` |
| P-05 | P-05 环境 · 维护与诊断 | `src/client/recovery/RecoveryPanel.tsx` | `47ae1e223aa8401183e948b213f432b6` |
| T-01 | T-01 导出面板 | `src/client/export/ExportView.tsx` | `941f823eb11c4d43affa45e55fc9ed85` |
| T-02a | T-02a 导入向导 · 选择备份文件 | `src/client/import/ImportWizardView.tsx` | `f2e83b0072f44e5083902df27c85b556` |
| T-02b | T-02b 导入向导 · 兼容性与导入预览 | `src/client/import/ImportWizardView.tsx` | `24b3c09c5119431db51c1f56d831eeeb` |
| T-02c | T-02c 导入向导 · 冲突裁决与确认闸门 | `src/client/import/import-wizard-steps.tsx` | `8d184486097e44589f6099720f2fec11` |
| T-03 | T-03 从其它 agent 导入 | `src/client/import/ForeignImportView.tsx` | `dfdd9c37c8034c75b34bcc9bb067b383` |
| T-04 | T-04 配置市场 | `src/client/market/MarketPanel.tsx` | `6d4f6e636b9b4bd9bd623fcf2a3a773c` |
| T-05 | T-05 市场 · 我的配置 | `src/client/market/MyConfigsView.tsx` | `e5cb0d3d340d4152af99603df6186dde` |
| T-06 | T-06 活动记录（运行中心） | `src/client/common/RunsCenter.tsx` | `1f762f6aaf9446de9e7886ed6609bd2a` |
| T-07 | T-07 迁移历史 | `src/client/history/HistoryPanel.tsx` | `6159f322548f41e2859f4295f0ee37a3` |
| T-08 | T-08 关于 | `src/client/about/AboutPanel.tsx` | `96543ddf27ea4174bb2a281793544e43` |

## 怎么读这些稿

- `shots/*-after.png` 是**优化后**的样子；`shots/*-before.png` 是同一页的真实实现截图（564×722 原尺寸裁切，零写入采集）。
- 每屏的「改了什么、为什么、还差什么」在 `pages/<ID>.md`，三节固定：源码路径 / 保留清单（现有入口一条不落）/ 缺陷与修订轮次。
- 跨屏问题不要逐屏找，直接看 `consistency.md` 的 C 行与 S-1/S-2/S-3 三条成因。

## 生成链路上的硬事实（复现必读）

1. `generate_screen_from_text({ projectId, prompt, deviceType: "DESKTOP" })`；`edit_screens({ projectId, selectedScreenIds: [id], prompt })` —— 参数名是 `selectedScreenIds`，且**每次新建一屏**，必须用返回的新 id 重新下载，旧 id 内容不变。
2. 单次调用约 120s 硬超时：提示词 2000–3300 字符最稳（BASE 640 字 + 页面段 1200–2000 字）；页面段 >1600 字符起超时概率陡增，>3500 基本连续超时。超时后同参数重试通常 90–100s 成功。并发 4–6 个 agent 会显著加剧超时。
3. `get_screen({ name: "projects/<pid>/screens/<sid>" })` 可拿截图/HTML 的 fileId；`download_file({ name: "projects/<pid>/files/<fid>" })` 返回 JSON（`image` base64 或 `html` 源码）。`list_screens` **只回上传的 DESIGN.md 那一屏，生成屏不可枚举**，id 必须自己记账。
4. `create_design_system` / `create_design_system_from_design_md` 在该项目上全部报 invalid argument / entity not found —— 设计系统改由「每屏提示词内嵌 BASE 全文」实现。
5. Stitch 不接受截图作为图片入参：`before` 截图只能人工对照，不能喂给模型（已在 `consistency.md` 记为限制）。
6. Stitch 常输出 2560×2048 / 2880×2048 横版，把 564×720 面板放在中间；需要正方形成品时用 Pillow 按面板外接框裁切（`D-26/D-27` 即如此处理）。
7. `edit_screens` 偶发返回新 id 但截图字节与旧版完全相同（改动未生效）——以 HTML 为准并在 `pages` 里写明，必要时换措辞重发。
8. 每日生成额度有限：`D-31` 就是被 `User is over the daily rate limit for screen generations.` 挡住（提示词已备好，见 `prompts/D-31.md`，额度重置后一条命令即可续跑）。

## 已完成 / 未完成

- **已完成**：53 张设计稿（PNG + HTML + 提示词 + 页面记录）、11 张真实实现对照截图、`pages.md` 全量清单、`consistency.md` 一致性报告。
- **未完成（有意留在阶段 F 之前）**：
  - `D-31` 终止运行确认：额度恢复后已补出图，残留遮罩未压暗 + 底部空白（详见 `pages/D-31.md`）。
  - `consistency.md` 里 P0 的两条系统性偏差（状态栏内缩、导航胶囊激活态）与 P1 的遮罩/按钮族问题：本轮优先保覆盖率，未逐屏重画。
  - 落地代码：全部未动。

## 环境

- 截图实例：`dsh --profile web --no-open` 独立实例（端口 5802x）+ token URL + Chrome DevTools Protocol；插件根 `#dsh-config-manager-root` 在视口 1400×1100、dpr 1 下精确 564×722。
- 本项目无法使用 `ops_bash`（`EXECUTOR_UNAVAILABLE`/awk.exe 硬链接失败），全部文件读写走 `run_code` + `node:fs`。
