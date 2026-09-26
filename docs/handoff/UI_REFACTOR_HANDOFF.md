# UI_REFACTOR_HANDOFF.md — DSH Config Manager 前端 UI 处理交接文档

> 📦 **历史归档**（阶段交接记录，非当前状态）：本文的「当前任务范围」是针对当时接手的 UI 打磨阶段而写。
> 后续 UI 改动已进 `DESIGN.md`，UI/样式决策一律以 `DESIGN.md` 为唯一权威。

> 为「接手前端 UI 美化的新 AI Agent」而写。生成时间基于当前 main 分支（UI Workbench 全量重建已完成并提交）。
> 本文件不是 README、不是教程、不是产品介绍，而是 **Frontend UI Refactoring Handoff**。

---

## 0. 当前任务范围（最重要，先读）

- ❌ 当前任务**不是**重新设计产品信息架构。
- ❌ 当前任务**不是**重新设计页面布局。
- ❌ 当前任务**不是**增加新的功能。
- ❌ 当前任务**不是**增加信息密度。
- ❌ 当前任务**不是**重新规划 Sidebar / 导航。
- ❌ 当前任务**不是**重新设计业务流程。

- ✅ 当前任务是：

> **在现有布局和功能基础上，对前端 UI 进行高质量 Visual Polish / UI Beautification。**

**已经完成的结构性重构**（本人在上一阶段完成，含 Shell/导航/状态栏/抽屉/各页布局与设计系统重写）**不要推倒**。你现在做的是「第二阶段：打磨」，重点是 **Spacing / Alignment / Component Consistency**，不是改布局或加密度。

---

## 1. 项目是什么

DSH（DeepSeek Harness）配置管理插件 `dsh-config-manager`：备份 / 恢复 / 导出 / 导入 / 迁移 / 远程同步 / 配置市场的双面 Cordis 插件。前端渲染在 **DSH 设置弹窗内的 `settings.section`**（「备份与迁移」入口）。

**硬性画布约束（不可改，决定一切布局）**：
- 宿主设置弹窗固定 `width:800px; max-width:calc(100vw-48px)`。
- 减去宿主导航（`--dsw-*` 外的宿主 DSH 导航，约 188px）与页边距后，**插件内容区 ≈ 564 × 720px**。
- 因此本插件**不是独立 Web 应用**：没有全局页面外壳/路由/登录，只在弹窗内容区渲染。所有布局均按 564px 宽优化，尽量 720px 高内一屏放完。

**重要**：页面底部若数据不足出现「空洞」，应采用「数据块填充」（备份位置/分区构成）或「内部滚动视口」（`.fillCard`/`.fillViewport`），**禁止**留下无意义的纯背景色大块。

---

## 2. 前端在哪里 / 技术栈（逐项从代码确认，勿猜）

| 项 | 实际情况 |
|---|---|
| Framework | React 18（函数组件 + hooks；无 class / 高阶组件） |
| 语言 | TypeScript 5.9，strict + `verbatimModuleSyntax` + `noUncheckedIndexedAccess` |
| 样式 | **CSS Modules，唯一样式表 `src/client/config-manager.module.css`（约 2300 行）** |
| Tailwind / shadcn/ui / Radix / Lucide / 动画库 | **完全没有，且本仓库刻意禁止引入**（发布为 DSH 插件，client 经 tsdown+lightningcss 打包成单文件 cjs；引入 UI 库会破坏构建与加载器） |
| 图标 | **文本符号 / emoji**（`▣ ⇥ ⇤ ⇅ ⟳ ◷ ⓘ ⭳ ⌕ ✕ ⧉ 🎬` 等），无图标字体/SVG 集合 |
| CSS 架构 | 单文件 CSS Modules 类（`.section` 内作用域）；颜色/字体/阴影全部走 DSH Design System 的 `--dsw-*` token（跟随亮/暗主题与皮肤，**禁止 hardcode**，tint 用 `color-mix(in srgb, <token> <pct>, transparent)`） |
| 组件架构 | 双层：**UI 逻辑在 `src/ui/`（纯函数/控制器，node 可测）**；**React 壳在 `src/client/`（只装配渲染 + 交互状态）** |
| 状态管理 | `src/client/run-store.ts` 模块级 store（`useSyncExternalStore`）+ `sessionStorage` 白名单持久化（敏感字段剔除） |
| 路由 | 无路由；Shell 内 `panel/view` 状态驱动页面切换（`run-store.panel`） |
| 构建 | host `tsc`（lib/）+ client `tsdown`（lib/client.js，cjs + `window.__ModuleLoader__.load`）；CSS Modules 由 lightningcss 编译内联注入 |
| 包管理 | npm（`js-yaml` 唯一运行时依赖；peer 是 DSH 官方包；`npm install --legacy-peer-deps` 必带） |

### 结构树（前端相关）
```
src/client/                     React 壳（只做装配）
  ConfigManagerSection.tsx       Shell（导航条+内容+状态栏+活动抽屉）
  run-store.ts                   状态中枢 + 持久化（勿动业务字段）
  api.ts / sync/sync-api.ts / market/market-api.ts / history/history-api.ts
  common/ui.tsx                  设计系统原语（Button/IconButton/StatusDot/Badge/Banner/Card/Spinner/Field/SectionTitle/Empty/Checkbox/Segmented/Stepper）
  common/ConfirmDialog.tsx       确认弹窗（含 focus trap）
  common/ErrorBanner.tsx / ReportView.tsx / ProgressBar.tsx
  overview/OverviewPanel.tsx     总览控制中心
  snapshots/SnapshotsPanel.tsx   备份页（4 子视图）
  export/ExportView.tsx          导出页
  import/ImportWizardView.tsx    导入向导（9 步） + ConflictList.tsx（冲突选边卡） + PathMappingForm.tsx
  sync/SyncSettingsView.tsx      同步页（git/webdav + OAuth + 确认）
  market/MarketPanel.tsx         市场 + MyConfigsView.tsx
  profiles/ProfilesPanel.tsx     配置档案
  history/HistoryPanel.tsx       迁移历史（抽屉内）
  about/AboutPanel.tsx           关于（抽屉内）
  recovery/RecoveryPanel.tsx     事故恢复
  config-manager.module.css      ★ 唯一样式表（Workbench 设计系统）
src/ui/                          纯函数/控制器（node 单测覆盖；业务逻辑必须留这）
  overview-view.ts / export-flow.ts / import-wizard.ts / conflict-view.ts /
  backup-schedule.ts / backup-inspect.ts / step-*.ts / sync-view.ts / market-view.ts ...
```

---

## 3. 当前 UI 已完成的部分（保留，不要推倒）

**设计系统（Workbench）**：`config-manager.module.css` 已是统一体系——Token 零硬编码、12.5px 基准字号、等宽数字（`tabular-nums`）、`.mono` 等宽栈、卡片 8px/控件 6px/徽章 9px 圆角、区块间距 10px、`.sectionMain/.pagePad` flex 链支持页面伸展填充（`.fillCard/.fillViewport`）、表格三变体（`.tableFixed/.tableCompact`）、`.statStrip`/`.factGrid`/`.sectionGrid`/`.choiceCard` 等。

**Shell**：7 页签导航条（总览/备份/导出/导入/同步/市场/档案）+ 带文字的活动/关于按钮 + 底部状态栏（状态点+运行态+插件与 DSH 版本）+ 右侧活动抽屉。

**页面**：Overview 控制中心（状态条/工具栏/备份位置事实网格/分区构成/活动视口）、Backups 四子视图（数据表+红色隔离删除+居中空态）、Import 向导（Stepper+兼容性分区网格+冲突选边卡+命令日志）、Export 工具栏式、Sync 状态事实行、Profiles 名称/元数据/动作行、抽屉（历史/关于）。

**已固化的规则（勿破坏）**：
- 业务逻辑在 `src/ui/`，React 只装配。
- 文案进 i18n 字典（`locales.ts` zh 源 / en 镜像；`ConfigManagerKey` 编译校验；`src/ui/` 走 `src/ui/i18n.ts`）。
- 错误/报告/历史摘要渲染前 `redact()`；历史中 `[REDACTED]` 展示为「（文件名已脱敏）」。
- 密码/凭据仅内存，绝不入 sessionStorage/日志/回显。
- 危险操作（恢复/删除/回滚）恒 `danger` + `ConfirmDialog` 二次确认。
- 新 i18n 键必须 zh+en 成对加。

---

## 4. 每个页面单独记录

> 页面均为「设置弹窗内容区（564px）内」，Route = 由 `run-store.panel` 切换。无独立 URL。

### Page: Overview（总览）
- Purpose：配置状态健康一览 + 快速操作 + 分区构成 + 最近活动。
- Current layout：状态条(`.statStrip`，名词在前可点) → 动作工具栏（立即备份 primary + 导出/导入/同步 ghost + 右侧「活动→」）→ 备份位置卡（路径+copy / 四列事实网格 / 下次备份估算）→ 分区构成卡（两列网格+合计）→ 活动视口（fit-content，上限 8 行内滚，成功=绿点）。
- Important components：`OverviewPanel.tsx`；模型 `src/ui/overview-view.ts`（勿动）。
- Reusable：`.statStrip/.statSeg/.factGrid/.sectionGrid/.activityRow/.todoRow`，`StatusDot/Badge/Button/Segmented`。
- Known visual problems：见 §6 列表（主要是空数据时活动视口内部仍偏空；分区构成里 0 项 0 B 的行略噪）。
- Potential risks：`nextRunText` 是近似估算（固定间隔=上次+间隔；custom=下个匹配周几），仅在 schedule 开启时才显示。
- Do NOT change：健康判定/指标语义/相对时间模型（`overview-view.ts`）；`exportPreview` 调用。

### Page: Backups（备份）
- Purpose：安全快照 / 备份文件管理 / 定时备份 / 事故恢复 四个子视图。
- Current layout：`Segmented` 四段 + 刷新按钮 → 子视图内容。
  - 安全快照：数据表（时间/来源 ZIP/状态/条目/插件/操作=置顶+删除）；
  - 备份文件：数据表（名称中段省略+来源+大小+完整时间戳+图标操作：下载/导入/查看/分隔线/红删除）；
  - 定时备份：单行头（标题+结果徽章+上次+保存/立即备份）+ 设置行（开关+间隔+custom 周几时刻）；
  - 事故恢复：直接复用 `RecoveryPanel`。
- Important components：`SnapshotsPanel.tsx`（+ `BackupFilesCard` / `BackupScheduleCard` / `BackupInspectView`）。
- Reusable：`.dataTable/.tableFixed/.tableCompact/.num/.dim/.cellMain/.cellTitle/.cellMeta/.rowDivider/.emptyHero/.factGrid`。
- Known visual problems：快照表「来源 ZIP」列内容较长被省略；空态（安全快照无数据）是居中空态页（已 OK）；备份文件表 name 列 20 字符中段省略较激进（title 有全文）。
- Potential risks：`BackupScheduleCard` 有 `backupDraft` 草稿镜像 run-store；custom 周几/时刻选择器在窄屏会换行。
- Do NOT change：保留策略(10)、置顶豁免、删除/恢复确认流程、运行态以宿主 RunRegistry 为权威。

### Page: Export（导出）
- Purpose：Quick/Custom 两种模式导出分区 ZIP。
- Current layout：工具栏（Segmented 快速/自定义 + 预览 + 立即导出 primary）→ 自定义模式两列分区勾选网格（说明入 title，portability/secret 徽章内联）→ 选项行（加密备份/导出密钥联动）→ 命名行（文件名+备注双列）→ 预览横幅/进度/报告/自动下载。
- Important components：`ExportView.tsx`；模型 `src/ui/export-flow.ts`。
- Reusable：`.exportGrid/.exportGroup/.exportItems/.optionsRow/.secretFields`。
- Known visual problems：两列分区网格在窄屏会单列（有 media 降级）；选项行与命名行的 `.secretFields` 复用（密码网格与命名网格共用样式，语义上可再分离）。
- Potential risks：加密密码仅内存（`api.exportPassword`）；文件名失焦补 `.zip`。
- Do NOT change：includeSecrets⇒encrypt 联动、密码校验、`quickSelection` 模型。

### Page: Import（导入）
- Purpose：9 步向导：选择 ZIP → 分析 → 兼容性 → 预览 → 解决冲突（如有）→ 路径映射（如有）→ 密钥补录（如有）→ 确认 → 执行 → 结果。
- Current layout：顶部 6 阶段 `Stepper`（选择/分析/预览与决策/确认/执行/完成）→ 分步页面。
- Reusable：`.stepper/.statRow/.sectionGrid/.conflictList/.conflictItem/.choiceCard/.pathMappingList/.logPanel/.dialogMask/.dialogCard`。
- Known visual problems：**兼容性/冲突/预览阶段在数据稀疏时底部有较大空洞**（向导页未做 fit-content 填充）；`SCORE_LABEL` 残留常量（已用 i18n score 键替代，可确认是否可删）；预览页「建议依据」与「可迁移性」要点有重复（来自 consult 数据结构）。
- Potential risks：`ImportWizard` 控制器状态在 run-store 缓存复用（勿重建每渲染 new）；冲突项不携带当前配置值（可能含秘密，不回显）——**不要做值级 diff**；import 预览/结果经 `redact()`。
- Do NOT change：分析/计划/执行链路、confirm=true 安全阀、rollbackOnError 默认、密钥补录仅内存、日志面板自动滚动逻辑。

### Page: Conflict Resolution（冲突解决，属于 Import 阶段 + Backups 差异查看）
- Purpose：导入时逐项选择「保留当前 / 使用备份」；备份文件「查看/对比」只读差异。
- Current layout：顶部批量决策（保留当前 ghost / 使用备份 ghost，均为次操作）→ 每个冲突一张选边卡（`.choiceCard`，radio 语义，选中高亮）。
- Reusable：`.conflictItem/.conflictHead/.conflictId/.kindTag/.choiceCard`；差异查看 `BackupInspectView`（`.inspectGroup/.kindTag*`）。
- Known visual problems：单冲突时卡片下空洞；`kindTag` 等宽/颜色变体可再统一。
- Potential risks：**禁止值级 Local vs Imported diff**（当前值可能含秘密，安全不变量；已用选边卡代替）。
- Do NOT change：`ConflictCollector`、`resolveAll`、`toResolutions`、差异摘要模型（`backup-inspect.ts`）。

### Page: Remote Sync（同步）
- Purpose：git/webdav 通道配置 + 自动同步 + 同步模式 + 加密 + 确认会话 + 历史。
- Current layout：通道卡（通道/未配置徽章 + **状态事实行**：配置状态/上次同步/可同步分区/当前地址）→ 同步模式（默认/高级 toggle）→ 加密与密钥导出 → 解密密码 → 动作。
- Reusable：`.factGrid/.segGroup(默认/高级)/.optionsRow`。
- Known visual problems：多段长说明文字（文字墙）；未配置时仍暴露 模式/加密/解密 设置（信息前置程度）；通道配置弹窗内容多。
- Potential risks：OAuth device flow、凭据走 DSH credentials 槽位引用（仅布尔回显）；`byChannel` 双通道独立状态。
- Do NOT change：同步/推送/拉取/回滚逻辑、确认会话、凭据不落盘。

### Page: Configuration Market（市场）
- Purpose：浏览/安装社区配置 + 我的配置（发布）。
- Current layout：「浏览市场/我的配置」分段 → 市场仓库卡（拉取最新/浏览）→ 搜索 + 类别/分区/来源/排序 下拉（`.statRow` 已加 `flex-wrap` 防溢出）→ 条目列表（官方/个人徽章 + 分区 + 未缓存/⭐）→ 条目详情弹窗（分区批准）。
- Reusable：`.modeTabs(segGroup)/.input/.select/.badge/.dialogMask/.dialogCard`。
- Known visual problems：条目列表仍是旧式卡（`.snapshotList` 过渡样式，可升级为行列表）；描述元数据未清洗（个别作者行含敏感词说明）；行内无直接安装动作（需进详情）。
- Potential risks：供应链警示恒展示；`BANNED_MARKET_SECTIONS` 禁止分区（sessions/pluginFiles/self）两端强制拒绝（勿动安全校验）。
- Do NOT change：市场安全校验、批准表、来源/排序模型、发布链路（`my-configs-view.ts`）。

### Page: Profiles（配置文件/迁移档案）
- Purpose：把当前配置保存为可切换档案（Work/Personal/…），切换含预览+自动快照+失败回滚。
- Current layout：保存卡（名称输入+保存档案）→ 档案列表（名称按钮 + 分区·时间 meta + 切换/重命名/删除）→ 导入档案卡 → 切换预览弹窗。
- Reusable：`.profileRow/.profileRowHeader/.profileRowMain/.cellMeta/.factGrid`。
- Known visual problems：无「当前使用」指示（需确认 API 是否可暴露）；名称按钮透明化已修复但仍建议复核 hover；切换预览弹窗内容密集。
- Potential risks：档案天然不含秘密值；切换走快照+分阶段+回滚。
- Do NOT change：档案保存/切换/回滚、校验、导入导出内容。

### Page: Migration / Settings / History / About（边界说明）
- **没有独立「Migration」页**：迁移 = 导出到另一台机器 + 导入恢复 + 档案切换（覆盖于 Import/Export/Profiles）。
- **没有独立「Settings」页**：设置（插件配置）由 DSH 宿主设置弹窗管理；本插件无独立设置面板。
- **History（迁移历史）**：在 Shell 的「活动与关于」抽屉内（`HistoryPanel`）；About 同样在抽屉内（`AboutPanel`）。
- Reusable：`.drawerPanel/.drawerHeader/.drawerBody`；抽屉 Esc 已被 `stopPropagation` 处理（避免关闭宿主弹窗，勿回退）。

---

## 5. Design System 当前状态

**已比较完善（统一）**：Token 零硬编码、dark/light 由 `--dsw-*` 承载、基础字号 12.5px、`tabular-nums`、`.mono` 等宽栈、按钮三变体×两尺寸（`Button size=sm/md`）、`IconButton`（26px + active/danger）、`StatusDot`、`Badge` 四态、`Banner` 四态、`Segmented`、`Stepper`、`ProgressBar`、表格三变体、`.dialogMask/.dialogCard(.dialogWide)`、`.drawerPanel`、`.statStrip/.factGrid/.sectionGrid/.choiceCard/.emptyHero`。

**需要视觉统一（重点打磨区）**：
- **Spacing 节奏**：有人用 `.actionRow`/`.groupHeader`/`.card` 类间距（10px），有人用内联 `style={{ marginBottom: N }}`（6/8/10/14 混用）——应统一到 4/8/10/12 网格，清掉散落的内联 margin。
- **圆角一致性**：`.card/.conflictItem/.choiceCard/.tableWrap` 8px，但 `.segGroup/.modeTabs` 7px、`.logPanel/progressTrack` 8/3px——次级圆角有漂移。
- **边框/表面**：`.card` 用 `border-l1`；`.choiceCard/.conflictItem` 内嵌 `bg-base` 边框；`.tableWrap` 外框 vs `.dataTable` 表头分隔线层级需统一。
- **图标**：全部文本符号，跨平台渲染不一致（个别字形宽度/基线不稳）；icon+text 间距在 `.navTab/.segItem/.iconBtn/.rowActions/.toolRow` 各处 gap 不统一。
- **Typography 层级**：正文 12.5 / 元数据 11-11.5 / 卡片头 11 / 页标题 13——**层级几乎只靠颜色和字重**，少字号锚点；标签/正文尺寸接近，扫读层级弱。
- **空态/空洞**：导入（兼容性/冲突/预览）与市场在数据稀疏时底部空洞（未做 fit-content）；总览活动视口已 fit-content，其余页未统一。
- **Dialog 双体系**：`ConfirmDialog`（带 focus trap）与各页内联 `dialogMask+dialogCard`（计划预览/差异查看/市场详情）并存，后者无完整 focus trap——建议后者抽成共享 `Modal`（但要小心不改业务）。

---

## 6. 当前已发现的 UI 问题清单（Spacing / Alignment / Typography / Consistency）

> 以下为本次重建后真实观察到的问题（非臆测），按严重度列出。

1. **P0 底部空洞未统一**：导入（兼容性/冲突/预览）与市场条目页在数据稀疏时底部留大块空白（向导页未做 `.fillCard`/`.fillViewport`），与总览/备份的「视口填充」策略不一致。
2. **P1 间距网格漂移**：多处内联 `style={{ marginTop/marginBottom: N }}`（6/8/10/14）与系统节奏（10px）冲突；`actionRow` 里部分按钮与文本靠得过近（banner 内 button 与文案 gap 偏小）。
3. **P1 icon+text 间距不统一**：`.navTab` gap 5px、`.segItem` gap 5px、`.toolRow` gap 8px、`.iconBtn` 单图标、`.rowActions` gap 2px——图标与文字间距在不同组件尺度不一致；尤其 `.iconBtn`（纯图标）与「带图标文本按钮」混排时视觉基线不齐。
4. **P2 圆角/边框漂移**：7px（`segGroup/modeTabs`）与 8px（`card/choiceCard`）并存；`.conflictItem`/`profileRow` 边框与 `.card` 边框强度不一。
5. **P2 Typography 层级偏平**：13px 页标题 → 12.5px 正文 → 11px 标签，差值 <2px，层级依赖颜色/字重；部分卡片头标题与正文标签几乎同权重。
6. **P2 双 Dialog 体系**：`ConfirmDialog` 有 focus trap，其余内联 `dialogMask` 弹窗无；关闭路径（遮罩/Esc/×）行为不完全一致。
7. **P2 文本符号图标**：`⭳ ⇤ ⌕ ✕ ⧉ ▣ ⇥ ⇅ ◷ ⓘ ⟳` 为文本符号，跨平台字形/基线不稳；部分（如 `✕` 删除）已用红色隔离，但仍建议统一视觉重量。
8. **P3 旧过渡样式残留**：市场条目列表（`.snapshotList/.conflictHead`）、sync 横条等仍用过渡类，可升级为与其余页一致的列表/表格范式（不影响功能）。
9. **P3 文案**：同步「同步通道」长说明（多行文字墙）；预览「建议依据」与「可迁移性」要点重复（源于 consult 数据，展示层可去重）；市场条目描述偶含作者说明等未被清洗。

---

## 7. UI 修改边界

**可以修改（Visual Polish 主战场）**：`config-manager.module.css` 全部类；组件内 className/内联样式间距；spacing/padding/margin/gap；typography；colors（token + `color-mix`）；borders/shadows/radius；icon 尺寸与基线；button/input/card/table/dialog/badge/tab 样式；alignment；**局部组件结构**（不影响跨组件的逻辑）。

**谨慎修改（需说明理由并小步验证）**：页面级布局（564px 内的列/栅格）、`run-store.ts` 的 UI 字段/切片、组件间 `props` 契约、跨页复用组件（`common/ui.tsx` / `common/ConfirmDialog.tsx`）。

**不要修改（业务边界，安全）**：`src/core/*`（备份/导入/导出/迁移/同步/加密/数据结构）、`src/ui/*` 纯函数与控制器、`src/schema/*`、`src/security/*`、`src/sync/*`、`src/market/*`、`src/adapters/*`、`src/index.ts` 的 Host 逻辑与路由、所有 API 契约（`src/client/*api.ts` 方法与 `CONFIG_MANAGER_API` 常量）、`run-store.ts` 的持久化/白名单/敏感字段、`src/client/index.ts` 的插件注册与 inject。

**特别注意**：
- **禁止 Tailwind/CSS-in-JS/Sass/UI 库/图标库/动画库**（构建与加载器约束）。
- **禁止 hardcode 颜色**（必须 `--dsw-*` + `color-mix`）。
- 新样式只能进 `config-manager.module.css`；类名用 `css.xxx` 引用，勿写字符串类名。
- 新文案进 i18n 字典（zh+en 成对）；展示文本渲染前 `redact()`。
- 卡片/组件能被现有原语解决就不新建；新 pattern 先写入 `DESIGN.md` 再使用。

---

## 8. 运行 / 查看 / 截图 / 验证

### 构建与验证
```bash
npm install --legacy-peer-deps   # 必带：部分 DSH 核心只在 peerDependencies
npm run typecheck                # tsc --noEmit（所有改动后跑）
npm run build                    # tsc(host lib/) + tsdown(client lib/client.js)
npm test                         # node --test src/**/*.test.ts tests/**/*.test.ts（1497 用例）
npm run smoke                    # 仅 core 冒烟
```
无 lint/format 脚本（历史 eslint-disable 是遗留）；typecheck 是 main 兜底。改 client/样式后用 `npm run build`（单文件 bundle）。

### 查看 UI（必须有 DSH 宿主，本插件不是独立应用）
本机已装 DSH CLI（`dsh`）。查看真实 UI 需要起一个 web profile。**关键：用隔离 home，不要用真实 `~/.dsh`**，否则会撞 task-board 等插件的单实例锁（真实 DSH 运行中会报 `task-board ledger is already owned by process …`）。

推荐（用 `.qa` 已有的隔离环境，本仓库 `.gitignore` 已忽略 `.qa/`）：
```powershell
# 隔离 DSH_HOME + 独立端口；profile 只含本插件 + dsh-base/dsh-web-app，不含 task-board
$env:DSH_HOME='D:\Projects\personal\dsh-config-manager\.qa\home'
Set-Location 'D:\Projects\personal\dsh-config-manager\.qa\home'
dsh web --port 3277 --no-open   # 想开浏览器就去掉 --no-open
```
浏览器访问 `http://127.0.0.1:3277` → 首次会弹「内测声明/添加 API Key」→ 点「稍后配置」关闭 → 左下「设置」→ 左侧「备份与迁移」→ 即插件 UI。（若 `.qa/home` 不存在，先重建：`.qa/home/profiles/web` 放一个 bundless 的 `package.json`（dsh.profile.bundles 含 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`dsh-config-manager`(link 到仓库)），`dsh plugin --profile web add link:D:\Projects\personal\dsh-config-manager`。）

> 注意：本项目 **无 mock、无登录**（loopback 信任）、无需额外配置。插件把 UI 渲染在宿主设置弹窗内（非整页）。

### 截图建议
本仓库无自带截图脚本；用 DSH 的浏览器工具（Harness 的 `browser_*`）。要点：
- 每页截全图（弹窗外宿主 chrome 属宿主，正常会带入）。
- **已知坑**：浏览器截图有一帧渲染滞后——导航后**连拍两张用第二张**，或先 `window.scrollBy(0,1)` 触发重绘再截。
- 暗色是主主题；如需亮色在 DSH 设置 → 外观 → 浅色。
- 检查尺寸：564 宽主画布；至少验证 1366/1440/1920 视口是否改变弹窗（弹窗固定 800px，故主要验窄屏降级）。

### 视觉验证纪律（交接后强烈建议）
- 每完成一处样式修改，`npm run typecheck` + `npm run build`，然后在 `.qa` 隔离实例里真实截图核对。
- 不要“只改代码不截图”；**Code review 不能代替 visual review**。

---

## 9. 当前视觉目标

> 目标：**Premium Developer Tool UI**。

参考（仅作质量基准，不复制其设计）：VS Code / Cursor / Linear / Raycast / GitHub / Vercel / Docker Desktop。
重点：**polished / clean / precise / consistent / modern / professional / balanced / excellent spacing**。
- 不追求更高信息密度（上一阶段已做），不追求更大留白。
- 目标是把现有每一处的 spacing、对齐、组件一致性打磨到「看不出拼凑感」。

---

## 10. 最重要的问题（优先级）

当前最大问题**不是空间利用**，而是 **Visual Polish 不足**，尤其 **Spacing / Alignment / Component Consistency**。

系统性检查示例（不要只修一两个）：
```
❌ [Icon][Text]           ← 图标与文字紧贴
✓ [Icon]   [Text]        ← 图标与文字有稳定间距（统一到 system scale）
❌ {marginTop: 8} 内联    ← 一个页面里出现多种 margin
✓ 统一 4/8/10/12 网格
❌ 8px 与 7px 圆角混用
✓ 统一圆角语义（卡片 8 / 控件 6 / 徽章 9）
❌ 卡片头标题 ≈ 正文标签字重
✓ 建立明确 hierarchy（标题 13/700，标签 11/600，正文 12.5/400）
```

### 若只做 5 件事（按影响排序）
1. **统一 spacing 网格**：清掉散落的内联 `style={{ margin*}}`，全站归一 4/8/10/12；banner 内按钮与文案、toolRow 图标与文字间距统一。
2. **统一图标与文字间距 & 基线**：`.navTab/.segItem/.toolRow/.rowActions` 的 gap 对齐；纯图标按钮与「图标+文本」按钮混排时基线对齐。
3. **消灭底部空洞**：给导入（兼容性/冲突/预览）与市场条目页套用 `.fillCard`/`.fillViewport` 视口填充策略，与总览/备份一致。
4. **统一 secondary 视觉**：圆角（7↔8）、边框强度、`.conflictItem/.profileRow` 与 `.card` 一致性；`.dataTable` 表头/行分隔线层级。
5. **Typography 层级**：为卡片头/标签/正文建立明确字号+字重锚点，减少只靠颜色区分。

---

## 11. 交接底线

- 当前 UI **已完成结构性重构**（Shell/导航/设计系统/各页布局），现在做的是**第二阶段 Visual Polish**。
- **不要**重新设计 IA/布局/业务流程，**不要**新增功能，**不要**改业务逻辑。
- 修改前先读 `DESIGN.md`（唯一视觉规范）与本文件；改完更新 `DESIGN.md`（若引入新 pattern）。
- 每步验证：typecheck + build + 隔离实例真实截图。安全与 token 纪律是红线。
