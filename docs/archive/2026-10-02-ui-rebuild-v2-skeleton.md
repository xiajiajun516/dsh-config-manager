> ⚠️ **已被 v3 取代（2026-10-06）**：本文的 §4（IA）/§5（外壳）/§7–§9（页面模式）
> 与它推导出的 DESIGN.md 章节已由 **UI v3 重做**替换 —— 新权威为
> `docs/archive/2026-10-05-ui-redesign-v3.md`（方案 + 迁移映射 + 覆盖矩阵）与改写后的 `DESIGN.md`。
> 本文**只作评审记录保留**：不要按它施工。

# UI 重构 v2 骨架设计（对象 + 动作）（已作废）

> **只读存档（2026-11 文档重建起）**：本文冻结、不再修订；现行结论看 `docs/index.md` 指向的对应文档。与代码冲突时以代码为准。

> **状态**：**骨架已定案**（2026-10-02），细节逐条讨论中；落地进度见 §12。
> **读者**：本仓库维护者。对外契约不受影响（不改 bundle 格式、不改同步快照格式、不动任何引擎）。
> **落地后**：§4（IA）、§5（外壳）、§6-§9（页面模式）合并进 `DESIGN.md`；本文降级为评审记录。
> **命名**：本文把 v0.1.x 当前的 Workbench 界面称为「v1」，本次重构为「v2」。

## 1. 要解决的问题

v1 的界面骨架是「页签 = 功能目录」：把插件的 7 个功能模块各做一个一级页签，页内再分子视图。用户每次来是为了完成**一件事**，却要先做一次「点哪个页签」的导航决策。三个根因：

### 1.1 导航把「装不下」当成了「可发现性」问题

`ConfigManagerSection.tsx#L62-L70` 是 7 个文字页签（总览/备份/导出/导入/同步/市场/档案），`#L319-L362` 在右侧又放两个**文字**动作按钮（活动 / 关于）。564px 画布下英文必然溢出，而 `src/ui/nav-overflow.ts` 的解法是**隐藏滚动条 + 两侧渐隐遮罩**——用户感受就是「要按住 shift 滚」。

结构性事实：**一级导航 + 文字动作按钮在 564px 里放不下是设计前提，不是意外**。继续用滚动去兜，等于把容量问题留到界面上解决。

### 1.2 一级按实现模块切，不按用户任务域

备份页（`snapshots/SnapshotsPanel.tsx#L122`）的 Segmented 四子视图里装着四种**心智完全不同**的东西：

| 子视图 | 它其实是 | 用户心智 |
|---|---|---|
| 安全快照 | 回滚点 | 「我要退回去」 |
| 备份文件 | 可携带的产物 | 「我要带走 / 拿回来」 |
| 定时备份 | 自动化策略 | 「我要它自动做」 |
| 事故恢复 | 故障处置 | 「它坏了」 |

一个页面同时承担「回滚 / 迁移 / 策略 / 急救」四件事，用户找不到东西是必然的。

### 1.3 同一份配置有 4 套 UI，且没有「维护 / 诊断」域

| 形态 | 定义位置 | 形状 |
|---|---|---|
| `SnapshotMeta` | `src/core/restore.ts#L138` | id / createdAt / sourceZip / entryCount / hostFileBackupCount / beforePluginCount / pinned |
| `BackupFileMeta` | `src/sync/backup-files.ts#L36` | name / path / sizeBytes / mtimeMs / source / note / containerType |
| `SyncSnapshotLite` | `src/client/sync/sync-api.ts#L219` | id / createdAt / sectionCount / platform / dshVersion |
| `MarketConfigEntry` | `src/market/market-config.ts#L22` | url / addedAt |

四份形状、四套「列表 + 详情 + 空态 + 删除确认」，**它们是同一种东西**：一份带元数据的配置快照。同时磁盘占用、缓存清理、会话健康、救援模式这些低频诊断项没有归宿，只能寄生在备份页里。

> 附带事实：全仓 `Segmented` 只用在 3 处（`ConfigManagerSection` 抽屉、`SnapshotsPanel` 备份页、`MarketImportReview`）。所以「子 tab 太多」的病灶**集中在备份页与抽屉**，不是全局问题——重构重心也据此确定。

## 2. 目标与非目标

### 目标
1. 一级导航在**中英文**下都不溢出，且未来加页面有明确规则（不靠滚动、不靠隐藏）。
2. 备份页四子视图解散，内容各归其任务域。
3. 「配置产物」收敛为**一个对象、一张列表**；操作记录仍留在原处。
4. 诊断类功能有明确归宿。
5. 不引入任何新的第三方 UI 库；`src/ui/` 承担全部可测逻辑。

### 非目标（本轮明确不做）
- 不改 `src/core/` 与 `src/sync/` 引擎；不改任何路由的语义。
- 不新增聚合路由（第一步只做视图层合并，见 §13.2）。
- 不做主题 / token / 字号体系的重做——`DESIGN.md` §3-§5 全部沿用。
- 不重画恢复计划、差异确认、冲突解决、导入向导等**弹窗/流程内部**（它们已经是成熟设计，见 `DESIGN.md#L555-L676`）。
- 不动主机路由的围栏与会话认证边界。

## 3. 设计原则（在 v1 之上新增三条）

| 原则 | 含义 |
|---|---|
| **对象 vs 日志** | 「我有什么」进产物库；「我做过什么」留在原页面（同步记录、迁移历史）。两者永不混在一张表里 |
| **一页 ≤ 3 个子视图** | 且必须是**同一域的并列视图**。跨域、低频、设置类一律不进 Segmented，改用弹窗或页脚入口 |
| **未知值不显示 0** | 尺寸 / 条目数未探测时显示「—」。0 会被读成「这一项没有内容」，与「读不到」语义相反（沿用 `common/SectionComposition.tsx` 的既有教训）。**读不到 ≠ 不存在**：逐行标 warn，绝不整页失败 |

## 4. 新 IA

### 4.1 一级导航收敛为 4 项

`首页` · `产物库` · `同步` · `环境`

| 页面 | 回答的问题 | 与 v1 的关系 |
|---|---|---|
| **首页** | 这台机器现在怎么样？我要做什么？ | 由 Overview 改造（去掉分区构成卡与活动视口） |
| **产物库** | 我手上有什么配置？在哪？能对它做什么？ | **新增**，吸收 4 处列表 |
| **同步** | 跨机同步这条管道通不通？怎么配？ | 由 SyncSettingsView 瘦身 |
| **环境** | 这台机器有哪些 DSH 实例？健康吗？ | 由 Profiles 改名 + 吸收事故恢复与磁盘占用 |

### 4.2 命令面板是第二入口

`⌘/Ctrl+K` 打开，覆盖全部动作。一级页签降级为「最常去的几个地方」，其余靠命令直达。**这是让 564px 溢出问题消失（而不是缓解）的关键**：导航项不再随功能增长。

### 4.3 保留不动

- **状态栏**（28px 圆角条）：状态点 + 就绪/进行中/恢复待处理 + 插件与 DSH 版本。执行期那行升级为「任务名 + 细进度条」并可点开活动记录（§5.10）。
- **活动 / 历史 / 关于**：不再是右侧抽屉，改为侧滑面板上的三种只读 task（§5.9）。它们是「日志与说明」，与产物的分离正是 §3 第 1 条。
- **Toast / ErrorBanner / ReportView / ProgressBar** 等 `common/` 原语。

### 4.4 急救可达性（三条不得打折）

救援模式（Rescue mode）是 DSH 因插件起不来时**唯一**的逃生通道，而它的入口从「备份页第 4 子视图」移到了「环境 → 维护与诊断」更深一层。必须同时满足：

1. 全局 SAFE MODE 横幅保留（与当前页面无关）。
2. 首页健康区在 `recoveryRequired` 时，「去处理」**直达维护与诊断视图**，不是只到环境页。
3. 命令面板里必须有「救援模式」「事故恢复」两条命令。

## 5. 外壳（Shell）

### 5.1 结构

```
ConfigManagerSection（#dsh-config-manager-root）
├─ ShellNav
│   ├─ NavStrip   [首页][产物库][同步][环境]     图标 + 短标签
│   ├─ NavMore    放不下的项自动进入的「更多 ▾」菜单
│   └─ NavActions [⌘K][活动][关于]              纯图标 + aria-label + tooltip
├─ GlobalBanner（SAFE MODE / 恢复待处理）       沿用现有逻辑
├─ <Page>        home | library | sync | environment
├─ StatusBar                                     沿用
├─ ActivityDrawer                                沿用
└─ CommandPalette（Radix Dialog）
```

中文 4 项、英文 4 项都远小于 564px。「更多」菜单是**为将来加页面准备的机制**，不是当前的需要——这正是「未来可扩展性」的落点。

### 5.2 `src/ui/nav-model.ts`（新增，替代 `nav-overflow.ts`）

```ts
export interface NavLayout { visible: number[]; overflow: number[] }

/** 纯函数：给定各项与「更多」按钮的实测宽度，返回显示哪几项、哪几项进更多。 */
export function navLayout(itemWidths: number[], availWidth: number, moreWidth: number, gap: number): NavLayout
```

- 输入宽度必须是**实测值**（标签文案随语言变化），由壳层用 `ResizeObserver` + 隐藏测量节点取值。**不许按字数估算**：中英混排、字号变化、系统缩放都会让估算失准。
- 放得下就全部可见（`overflow = []`、不渲染「更多」）；放不下时从末项开始移入 `overflow`，并计入「更多」按钮自身宽度。
- **失败兜底**：任何测量不可得（0 宽 / 未挂载）时，退化为「全部可见 + 允许横向滚动」，绝不因为测不到而隐藏页签。

**`src/ui/nav-overflow.ts` 删除**：它解决的「隐藏滚动条后可发现性」问题在新结构下不再存在。

### 5.3 命令面板

- `src/ui/commands.ts`（纯）：`CommandItem { id; group; titleKey; keywords: string[]; enabled(ctx): boolean }` + `filterCommands(items, query)`（子串匹配 + 前缀加权，分组保序，空查询显示全部）。
- `src/client/common/CommandPalette.tsx`：Radix Dialog + input + 分组列表 + ↑↓/Enter/Esc。**只装配，判定都在 `commands.ts`**。
- 第一版覆盖：三个大动作（导出 / 导入 / 回到过去）、四个页面、产物库五个来源筛选、同步四个动作（一键同步 / 推送 / 拉取 / 编辑通道）、环境三个动作（新建 / 启动 / 停止）、维护与诊断与救援模式两条。
- **待实测**：宿主是否已占用 `⌘K`。冲突则退到 `⌘J`（结论记入 §14）。
- **硬约束**：Radix `Dialog.Portal` 容器必须指回 `#dsh-config-manager-root`（`common/Modal.tsx` 的 `MODAL_ROOT_ID`）。挂 `document.body` 会被宿主 overlay（z-index 1000）遮成隐形弹窗，并连带 body `pointer-events` 失效。

### 5.4 导航项形态（定案：图标 + 文字）

| 页 | 图标（新增 / 复用） | zh | en |
|---|---|---|---|
| 首页 | `home`（新增，lucide `house`） | 首页 | Home |
| 产物库 | `library`（新增，lucide `package`） | 产物库 | Library |
| 同步 | `sync`（复用现成） | 同步 | Sync |
| 环境 | `environment`（新增，lucide `server`） | 环境 | Environment |

**新增图标的施工纪律（三处必须同时改，漏一处不是 TS7016 就是运行时缺图标）**：

1. `common/Icon.tsx` 顶部按 `lucide-react/dist/esm/icons/<name>.mjs` **深路径**导入 —— 不许从 `lucide-react` 桶导出，那会破坏 rolldown 的精确 tree-shake（现有注释已写明这条体积纪律）。
2. 同文件 `ICONS` 映射加一行 `语义名: 组件`（`satisfies Record<string, LucideIcon>` 会校验类型）。
3. `common/lucide-icons.d.ts` 为该深路径补一行 `declare module`。**该文件必须保持"无顶层 import/export"**，一旦变成模块，内部所有 `declare module` 会退化为增量合并而**静默失效**。

### 5.5 容量与降级阶梯

定案的阶梯（容量紧张时按序降级，每一级都保持可点）：

| 级别 | 形态 | 宽度成本 |
|---|---|---|
| 1（默认） | 图标 + 文字 | 基准 |
| 2（本轮不实现） | 纯图标 + `aria-label` + tooltip | 约 -40% |
| 3 | 进「更多 ▾」菜单 | 0 |

第 2 级现在没有触发条件：4 项在中文（余 ≈176px）与英文（余 ≈116px）下都放得下。它存在的意义是**未来加页时的中间档** —— 这也是选「图标 + 文字」而不是纯文字的理由。

### 5.6 「更多 ▾」与命令面板的行为契约

| 场景 | 行为 |
|---|---|
| 打开「更多」 | 点击 / ↑↓；`aria-haspopup="menu"` + `aria-expanded` |
| 高亮移动 | ↑/↓ + Home/End，跳过 disabled；复用 `ui/select-model.ts`（已有 node 单测） |
| 选中 | Enter / 点击 → `goto(id)`，菜单关闭 |
| 关闭 | Esc（**必须 stopPropagation**）/ Tab / 点击外部（`mousedown`）；焦点回「更多」按钮 |
| 弹层定位 | absolute 留在原地、**不 portal**；贴画布右边界时右对齐（复用 `Select` 的 `menuAlign`） |
| 命令面板开关 | `⌘K` / `Ctrl+K`（宿主占用待实测）；挂 `window` keydown，仅当 `event.target` 不是 input/textarea/contenteditable 时响应 |
| 命令面板过滤 | 输入即过滤；↑↓ 跳过 `enabled=false`；Enter 执行并关闭；Esc 关闭并还原焦点 |
| 与抽屉并存 | 不联动关闭：命令面板是 Radix modal，遮罩盖住抽屉即可 |

### 5.7 本步删除清单

- 删 `ui/nav-overflow.ts` 与 `ui/nav-overflow.test.ts`（**同一次提交**，否则 `npm test` 留下孤儿用例）。
- 删壳里的 `navOverflow` state / `useEffect` / `data-overflow` 属性。
- 删 CSS：`.navStrip::-webkit-scrollbar` 与三条 `.navStrip[data-overflow=…]`。
- i18n **只增不删**（删键留到第 6 步，见 §11）。

### 5.8 流程任务层（Task Mode，定案）

导出 / 导入 / 逛市场 / 发布市场这些流程在 4 页 IA 里**没有页面**：它们由产物库底栏、行内动作、首页大动作或命令面板发起。

**判据（一句话）**：**多阶段向导 → Task Mode；单次决策 + 报告 → Modal。**

- 进 Task Mode：导出（选内容 → 安全选项 → 命名 → 进度 → 报告）、导入（6 阶段 Stepper）、逛市场、发布市场。
- 仍是 Modal：**恢复**（dry-run 计划预览 → 确认 → 报告）、咨询、查看与对比、inspect —— 它们是「一个弹窗里做完决策」，套进任务层只是白加一层。

**呈现：内容区上的全宽侧滑面板。** 所有 task 共用这一个容器，没有第二种呈现；活动 / 历史 / 关于也并入它（§5.9）—— 于是全站只剩「页面」与「面板」两个概念。

**为什么不是「同屏侧栏」（已评估并否决）**：在 564px 画布上让页面与面板并排是算不过来的 ——

| 同屏方案 | 面板需要 | 页面剩余 | 结果 |
|---|---|---|---|
| 侧栏 + 页面并排 | 440px（面板最低需求） | 124px | 产物库一行约需 420px，直接崩 |
| 窄侧栏 + 页面并排 | 300px | 264px | 面板连 picker 缩进树都放不下，页面也放不下 |
| 浮层面板覆盖右侧 | 280px | 可见 284px | 装不下任何向导步骤；被盖住的 280px 也不可点 |

面板的 440px 下限来自三处：diff 双栏（固定布局四列）、冲突解决的两个并排选边卡、三层缩进的 picker 树；页面的 420px 下限来自产物库的行。440 + 420 = 860 > 564 —— **不是取舍问题，是放不下**。

**替代保障（三层）**：① 切页签 → 面板收起、`task` 保留，什么都不丢；② 切回发起页 → 接着上次那一步；③ 执行期任务在宿主侧运行，与面板开不开无关。第三层由下面的状态栏补强承接。

```
.section（插件根节点，flex column，height 100%，position: relative）
├─ .shellNav        46px    ← 保留，始终可见可点
├─ GlobalBanner            ← 保留（§4.4 的急救可达性）
├─ .shellContent    flex:1 / min-height:0 / position:relative   ← 新增的一层容器
│    ├─ .shellMain        overflow-y:auto —— 页面（**保持挂载，不卸载**）
│    └─ .taskPanel        position:absolute; inset:0 —— 侧滑面板
│          ├─ .taskHead   44px  [← 返回{发起页}] + 任务标题 + Stepper/进度
│          └─ .taskBody   flex:1 / 内部滚动
└─ .statusBar       28px    ← 保留（「N 个任务进行中」与版本）
```

| 项 | 规则 |
|---|---|
| 状态 | `runStore.task: { kind: TaskKind; payload?: unknown; origin: PanelId } \| null`；`TaskKind = 'export' \| 'import' \| 'market' \| 'publish' \| 'runs' \| 'history' \| 'about'` |
| 持久化 | **不持久化**。发起它的页面已随刷新销毁，重放一个空白向导只会骗人（与档案面板「进行中态不落 sessionStorage」同一条理由） |
| 可见性 | `panel === task.origin` 时才渲染面板。切到别的页签 → 面板收起、`task` 保留；切回发起页 → 重新滑出、接着上次进度。既不让「点了导航没反应」，也不丢流程 |
| 覆盖范围 | **只覆盖 `.shellContent`**，不盖导航条、全局横幅、状态栏 —— 横幅是急救可达性的硬要求（§4.4），状态栏挂着「进行中」与版本 |
| 定位 | `absolute`（**不是 `fixed`**）。`.shellContent` 是 `position: relative`，`inset: 0` 自动贴合内容区，与浏览器窗口尺寸无关。v1 抽屉的 `@media (max-width:900px){ width:100vw }` 正是 `fixed` 相对视口导致的错误补丁，整条删除 |
| 宽度 | 内容区宽（≈532px），**不是 400px**：导出/导入里是表格、diff 双栏、内容选择器树 |
| 遮罩 | **没有**。全宽面板 + 全宽遮罩 = 遮罩被完全盖住，既无视觉效果也无点击区域 |
| 入场动效 | 复用现有 `drawerIn`：`translateX(24px) + opacity`，`--cm-motion-base`（180ms）。面板本身满宽，位移只承担「这是新来的一层」的提示 |
| 关闭 | 头部「← 返回{发起页}」= `task = null`（所有 task 都有）；**Esc 只对只读视图**（活动 / 历史 / 关于）绑定，多阶段流程不绑（可能有未保存的计划或已输入的密码） |
| 替换 | 打开新 `task` 直接替换旧的；**不中断任何进行中的运行**（运行归宿主的 run registry 管，活动记录里始终可见） |
| 层级 | `z-index: 90`（沿用 v1 抽屉档位），低于 Modal 的 101 —— Modal 打开时应当盖住面板 |
| 复用 | `ExportView` / `ImportWizardView` **组件本体基本不动**，只摘掉它们的页面外壳（padding / 页标题），改由 `.taskBody` 提供 |

**面板是覆盖层，因此底下的页面不卸载**：关闭是瞬时的，产物库的滚动位置、展开的那一行、已经拉到的数据都还在。这是它优于「in-flow 替换」的核心原因。

**代价**：全宽面板意味着窄内容（如「关于」）要靠自身排版填满画布（Canvas 纪律，`DESIGN.md` §0）。

### 5.9 抽屉并入面板（定案）

「活动 / 历史 / 关于」不再是右侧 400px 抽屉，而是 `task.kind = 'runs' | 'history' | 'about'` 三种只读 task，复用同一个侧滑面板。

- **删除**：`ConfigManagerSection` 里内联的抽屉 JSX（`aside.drawerPanel` 那段），以及 `.drawerMask` / `.drawerPanel` / `.drawerHeader` / `.drawerTitle` / `.drawerBody` 五个类，连同 `@media (max-width: 900px)` 里对 `.drawerPanel` 的那条覆盖。
- `runStore.more.moreSub` 并入 `task`（迁移见 §10.1）。
- 三个入口不变：导航条右端的「活动」「关于」图标按钮、状态栏的「N 个任务进行中」。
- 只读 task 支持 Esc 关闭（无未保存输入），多阶段流程不支持。

### 5.10 状态栏（补强）

| 情形 | 显示 | 点击 |
|---|---|---|
| 无任务 | ● 就绪 / 备份 2 小时前 / 需处理 | 有恢复事项 → 环境 · 维护与诊断；否则纯展示 |
| 1 个任务 | ● 进行中 · 导出配置 · ▓▓▓░░ 42% | 打开活动记录（`task.kind = 'runs'`） |
| ≥2 个任务 | ● 进行中 · 2 个任务 · ▓▓▓░░（取最长者） | 打开活动记录 |
| 右侧 | 插件 v0.1.68 · DSH 0.1.5-rc.1 | —— |

- 进度条：4px 高、60px 宽、`--dsw-alias-state-business-primary`；不确定进度用既有 `.progressIndeterminate`（`prefers-reduced-motion` 下刻意保留 —— 它承载「正在进行」这个状态本身）。
- 状态栏高度维持 28px 不变；任务名过长时中段省略（复用 `ui/mid-ellipsis.ts`）。

**为什么要它**：执行期用户会切走。没有这行，切走后唯一的进度线索是「N 个任务进行中」这句话；有了它，「一边跑一边干别的」才真正成立。

## 6. 产物库（详设）


### 6.1 布局（默认 = 混合平铺）

```
┌──────────────────────────────────────────────────────┐
│ [全部 6] [本机快照 3] [备份文件 2] [远端 1] [更多 ▾]   │ 32px 来源筛选
│ 🔍 搜索文件名 / 备注 / 快照 id                        │ 32px 搜索
├──────────────────────────────────────────────────────┤
│ 共 6 个 · 2 个加密                                  │ 24px 统计（非空才显示）
├──────────────────────────────────────────────────────┤
│ ▸ 本机快照 · 2026-10-01 22:36       [置顶] [恢复] [⋯]  │
│     1,204 条目 · 42 插件                              │
├──────────────────────────────────────────────────────┤
│ ▸ 备份文件 · dsh-config-1bb8c.zip   [加密] [导入] [⋯]  │
│     自动 · 12.1 MB                                    │
├──────────────────────────────────────────────────────┤
│ ▸ 远端快照 · 2026-09-28 19:03     [当前基线] [拉取] [⋯]│
│     Git · 12 分区 · DSH 0.2.0                         │
│                       ⋮ 列表内部滚动 ⋮                │
├──────────────────────────────────────────────────────┤
│ ＋ 新增产物 ▾  手动导出 / 从文件导入 / 逛市场 / 发布市场│ 48px 固定底栏
└──────────────────────────────────────────────────────┘
```

**混合平铺** = 全部来源按时间倒序排在一张表里，来源只是筛选维度。理由：用户找「我上周那份」时不该先想它在哪个源里。

### 6.2 行结构（定案：来源标签上标题行）

```
┌ li.artifactRow ──────────────────────────────────────────────────┐
│  [▸]  │  title: [kindTag] 主标识            │ badges │ 主操作 + ⋯ │
│       │  meta:  「·」分隔的元数据             │        │           │
└──────────────────────────────────────────────────────────────────┘
```

| 层 | 作用 |
|---|---|
| `li.artifactRow` | 整行 = **鼠标**点击展开；**不加 `role`/`tabIndex`**（DESIGN.md「可点列表行 + 行内按钮」通则：`role=button` 套 `button` 非法，且与全局焦点环规则打架） |
| `button.artifactExpand` | 20×20 置于行首，**键盘与读屏的唯一入口**；`aria-expanded` + `aria-controls`；内容为 `ExpandChevron`（morphicons 形变，折叠展开是它的合法用途） |
| `div.artifactMain` | `.artifactTitle`（`.kindTag` + 主标识）与 `.artifactMeta` 两行 |
| `div.artifactBadges` | ≤3 枚 `Badge`，`flex: none` 防挤压标题 |
| `div.artifactActions` | 1 个主操作 + `⋯`（MoreMenu）；**全部 `stopPropagation`** |
| `div.artifactDetail` | 展开态；id 由 `useId()` 提供，与 `aria-controls` 对应 |

**不再放 kind 图标**：B 方案下来源已由 `.kindTag` 表达，再放一个图标属重复表达兼装饰性图标（DESIGN.md §9 禁止）。

尺寸（行高与页面预算）：

| 量 | 值 |
|---|---|
| 行高 | 52px = 标题 19 + 元数据 17 + padding 8×2 |
| 水平内边距 / 段间距 | 10px / 8px |
| 来源标签 | 复用 `.kindTag`，其后 `margin-right: 6px` |
| 标题 | 12.5px / 600；单行 ellipsis + `title` 全文（中段省略复用 `ui/mid-ellipsis.ts`） |
| 元数据 | 11px / `--dsw-alias-label-tertiary`；数字化段用 `.mono` |
| 列表 | `.artifactList`：`overflow-y: auto; min-height: 0`（沿用 `.tableScroll` 的限高内滚约定） |
| 首屏行数 | 内容区 606 = 工具区 64（筛选 32 + 搜索 32）+ 8 + 列表 478 + 8 + 底栏 48 → **约 9 行** |

四源的字段映射：

| 来源 | 标题 = `.kindTag` + 主标识 | 元数据行 | 徽章 | 主操作 |
|---|---|---|---|---|
| 本机快照 | 本机快照 · 2026-10-01 22:36 | 1,204 条目 · 42 插件 | 置顶 | 恢复（先出 dry-run 计划） |
| 备份文件 | 备份文件 · dsh-config-161a9.zip | 自动 · 38.4 KB | 加密 | 导入 |
| 远端快照 | 远端快照 · 2026-09-28 19:03 | Git · 12 分区 · DSH 0.2.0 | 当前基线 | 拉取 |
| 市场配置 | 市场配置 · 某配置名 | 作者 · v1.2.0 | — | 安装 |

> **数据源更正（2026-10-03）**：这一源的输入**不是** `MarketConfigEntry` —— 那个类型是
> 「已添加的市场仓库」（`{ url, addedAt }`，属设置不属产物）。可安装的条目来自
> `marketApi.browse()` → `MarketListItem`（id/name/author/version/updatedAt）。

徽章配色（`Badge` 四态）：置顶 `info`、当前基线 `ok`、加密 `warn`（它确实多一步解锁）、读不到 `error`。

**`aria-label` 恒给完整句子**（「本机快照 2026-10-01 22:36」）——屏幕阅读器不该依赖视觉分组。

### 6.3 视图模型 `src/ui/artifact-view.ts`（新增）

```ts
export type ArtifactKind = 'snapshot' | 'backup-file' | 'remote-snapshot' | 'market'

export interface ArtifactRow {
  key: string                     // 全局唯一：`<kind>:<id>`
  kind: ArtifactKind
  title: string
  subtitle: string
  at: string | null               // ISO；未知 = null（不猜）
  sizeBytes?: number              // 未知 = undefined → 渲染「—」
  origin: string                  // 本机 / 通道名 / 仓库名
  locked?: boolean                // 加密容器未解锁
  pinned?: boolean                // 快照置顶
  current?: boolean               // 远端快照命中 sync-state.lastSnapshotId = 当前基线
  unreadable?: { reason: string } // 读不到 → 行标 warn
  capabilities: ArtifactCapability[]
}

export type ArtifactCapability =
  | 'restore' | 'import' | 'pull' | 'install'
  | 'inspect' | 'download' | 'consult'
  | 'pin' | 'unpin' | 'delete'

// 落地修正（2026-10-03）：草案里的 'unlock' 与 'diff' 删掉 ——
//  · 'unlock' 不是独立行内动作，它是**导入流程的第一个阶段**：动作恒为 import，
//    只有**文案**随 locked 徽章切换（library.cap.unlockImport）；
//  · 'diff' 与本机快照的 'restore' 同入口（就是 dry-run 计划预览，§6.8 ②），单列会让同一次调用有两个按钮。
// 另加 'unpin'：置顶与取消置顶的文案不同，拆成两个能力，渲染层不必回看 row.badges。

export function toArtifactRows(input: ArtifactInput): ArtifactRow[]
export function artifactCapabilities(row: ArtifactRow, ctx: ArtifactContext): ArtifactCapability[]
export function filterArtifacts(rows: ArtifactRow[], q: ArtifactQuery): ArtifactRow[]
export function librarySummary(rows: ArtifactRow[]):
  { count: number; bytes: number | null; encrypted: number; unknownSize: number }
```

**关键：动作由 `capabilities` 分派，不由 `kind` 分派。** 行只渲染它真正支持的动作——远端快照的「删除」删的是**远端仓库里的那一份**（从不碰本机文件），市场项不能「恢复」只能「安装」。这是「不再每种来源写一套列表」的落点。

### 6.4 动作矩阵

（行内三段显示见 §6.2；此表只列动作。）

| 来源 | 主操作（行内唯一） | ⋯ 菜单 |
|---|---|---|
| 本机快照 | 恢复（先出 dry-run 计划） | 迁移前咨询 / 置顶 / 删除 |
| 备份文件 | 导入（加密先解锁） | 迁移前咨询 / 查看与对比 / 下载 / 删除 |
| 远端快照 | 拉取 | 迁移前咨询 / 查看与对比 / 下载 / 删除 |
| 市场配置 | 安装 | 查看详情 / 打开来源 |

**「改备注」已砍掉**（决策见 §14）：`BackupFileMeta.note` 只有读、没有写——写入只发生在导出时，改备注要新增一条路由，收益不值。

### 6.5 交互

- 行点击 = **就地展开**（不跳页、不弹窗）。展开态 = 完整元数据 + 次级动作（**不含变更摘要**：那要跑一次 dry-run，见 §6.8）。
- 主操作按钮**永远只有一个**，其余进 `⋯`，降低误点；删除恒 `danger` + 二次确认。
- 加密行主操作是「解锁后导入」，直接消除 v1 那种「备份坏了」的错觉（issue #55 的界面侧根因）。
- **可展开行与删除按钮必须分离**：删除只能走 `⋯` 菜单，且 `⋯` 内点击不得冒泡到行的展开处理器，否则会出现「想展开却删了」（见 §13.4）。

### 6.6 筛选 / 搜索 / 排序

- 来源 Segmented：全部 / 本机快照 / 备份文件 / 远端 / 市场。**放不下时复用 `navLayout`** 收进「更多 ▾」。
- 搜索：文件名、备注、快照 id、市场条目名（客户端本地过滤，不发请求）。
- 排序：时间倒序（缺省）/ 名称。**去掉「按大小」**：四源里只有备份文件有 `sizeBytes`，按大小排会让另外三种全落进「未知」桶 —— 排不出结果的选项不如不给。
- 三项状态持久化到 `run-store.library`（全部非敏感，见 §10.2）。
- 筛选计数（如「本机快照 3」）**只在对应来源加载成功后显示**；加载中或失败时只显示来源名，绝不显示 0。
- **没有批量操作**（定案）：不做多选、不做批量删除。删除低频且不可逆，逐条 `⋯` → 二次确认是现成的安全路径；磁盘压力由定时备份的保留策略与「环境 → 维护与诊断」的磁盘清理承担。
- 底栏 = `＋ 新增产物 ▾` 菜单（复用 MoreMenu），四项：手动导出 / 从文件导入 / 逛市场 / 发布到市场。

### 6.7 四种态

| 情形 | 呈现 |
|---|---|
| 加载中 | `SkeletonList` |
| 全部为空 | 底栏「＋ 新增产物」高亮 + 一句引导 |
| 某来源为空 | 「这里会有什么 + 去哪产生」+ 直达按钮（例：无远端快照 → 去同步页配置通道） |
| 部分读不到 | 该行标 warn + 原因；**不整页报错** |
| **某个来源接口失败** | 顶部一条 warn「1 个来源读取失败」+ 重试；该来源筛选下显示自己的错误态与重试。既不静默跳过，也不让一路失败拖垮整页 |

### 6.8 字段真实性核对（本轮修正两处）

**① 只有备份文件带体积。** `SnapshotMeta`（`core/restore.ts#L138`）只有 `entryCount / hostFileBackupCount / beforePluginCount`，**没有字节数**；`SyncSnapshotLite` 也只有 `sectionCount`。四条来源里唯一带 `sizeBytes` 的是 `BackupFileMeta`。

两条由此确定的口径：

- 行的体积**只对备份文件显示**；其余三种在该位置显示「—」，绝不显示 0（§3 第三条原则）。
- **统计条不显示「合计体积」**。四源里只有一源有体积，求和会把「未知」混进「合计」里。改为「共 N 个」+（有加密项时）「M 个加密」。`librarySummary` 仍保留 `bytes` / `unknownSize` 字段——等第 2 步之后给快照补体积（需宿主改动）时再用。

**② 「查看内容 / 差异」按来源不同，但「迁移前咨询」是统一的。**

`POST /consult`（`src/routes/consult.ts#L33`）支持**四种**可迁移源：`export-zip` / `local-snapshot` / `remote-snapshot` / `profile`。所以「迁移前咨询」是四个来源**都能用**的通用次动作，应一律进 `⋯`；不要为它按来源造分叉入口，也不要漏掉它。

| 来源 | 「查看内容 / 差异」的真实接口 | 语义 |
|---|---|---|
| 本机快照 | `api.restoreSnapshot(id, dryRun=true)` | **就是**恢复计划预览，与主操作「恢复」同入口，因此不单列次动作 |
| 备份文件 | `api.inspectBackup(path)` | 查看内容 + 与当前配置的差异（只读；加密包被明确拒绝并给解锁指引）。与「迁移前咨询」不是一回事，两者并存 |
| 远端快照 | `syncApi.download(通道+id)` → `api.inspectBackup(zipPath)` | 与备份文件**同一份实现**（2026-10-04 用户要求对齐）：先把快照落地成本机 ZIP（只读，不改远端/本机），再走那条只读分析 —— 于是「客户端拿不到分区明细」不再是限制（`SyncSnapshotLite` 只有 `sectionCount`，落地后分析的就是真包）。代价是一次完整下载 |
| 市场配置 | `marketApi.browse()` + `prepare()` | 详情在「逛市场」流程里看，列表行只给「安装」 |

**③ 行的展开态不含变更摘要。** `RestoreResponse` 的 `changeSummary` 只有跑过 dry-run 才有，而 dry-run 要读快照内容（有读取上限，但仍是重活）。展开是**零请求**的本地渲染，不能为每一行触发一次 dry-run —— 变更摘要只在点「恢复」时随计划弹窗出现。

这两条同时关掉 §13.3 的开放问题 ①。

## 7. 首页

```
首页
├─ StatusLine        40px：● 健康 · 备份文件 · 安全快照 · 定时备份 · 远程同步 ··· [立即备份]
├─ ActionGrid        三张动作卡：带走配置 / 装进配置 / 回到过去
├─ HealthList        仅在不健康时渲染（备份失败 / 同步失败 / 更新可用）
├─ RecentArtifacts   最近 3 行产物（复用 ArtifactRow 只读模式）
└─ FirstSteps        首用空态：既有 Stepper，三步对齐新 IA
```

**状态行**（沿用 v1 已验证的 `.statStrip`：健康点 + 可点指标段，名词在前、值加粗）：

| 分段 | 常态显示 | 点击去哪 |
|---|---|---|
| ● 健康 | 就绪 / 备份 2 小时前 / 需处理 | 正常 = 纯展示；有待处理恢复事项 → 环境 · 维护与诊断（§4.4 第二条） |
| 备份文件 | 12 个 · 最新 2 小时前 | 产物库 · 备份文件 |
| 安全快照 | 3 个 | 产物库 · 本机快照 |
| 定时备份 | 每 24h · 下次 03:00 | 自动备份设置弹窗 |
| 远程同步 | Git 已连接 / 未配置 | 同步页 |
| **[立即备份]** | primary 按钮，右端对齐 | 直接执行 `backupScheduleRun` |

`METRIC_TARGET` 那张映射表按新 IA 重写一遍即可，跳转逻辑不新写。

**为什么「立即备份」放状态行右端**：三张动作卡是三个**任务域**（带走 / 装进 / 回去），而「立即备份」是**即时动作**；它与「备份状态」同处一行更贴——看见「最新 2 小时前」的右边就是「立即备份」。四张卡会把每张压到约 128px，标题加副标题必然挤。

**提醒区只列非全局的三件事**（恢复待处理已有全局 SAFE MODE 横幅 + 状态行健康段，首页不再重复）：

| 优先级 | 提醒项 | 触发条件 | 动作 |
|---|---|---|---|
| 1 | 最近一次定时备份失败 | 最近 run 结果为 failed | 打开自动备份设置弹窗 |
| 2 | 某个同步通道最近一次失败 | 任一通道最近 run 为 failed | 去同步页 |
| 3 | 插件有新版本 | `update-check` ok 且版本更高 | 打开「关于」抽屉 |

其余三块：

- **动作网格**：三张卡 —— 带走配置（`task=export`）/ 装进配置（`task=import`）/ 回到过去（产物库 + 本机快照筛选）；每卡一行标题 + 一行副标题（副标题说明「会发生什么」）。
- **最近产物**：`ArtifactRow` 只读模式，限 3 行；点任意一行 → 切到产物库**并自动展开该行**（`library.expandedKey = row.key`），让首页与产物库之间有连续性。
- **首用空态**：仍是三步 Stepper（创建第一份备份 → 导出 ZIP 带走 → 在新机器导入回来），三个按钮分别接「立即备份」API、`task=export`、`task=import`。

**移出首页**：分区构成卡（改在产物库展开态与导出流程里呈现）、活动视口（抽屉已有）、备份位置卡（压成状态行一格，完整信息进设置弹窗）。

## 8. 同步

```
同步
├─ Git 通道卡（已配置）
│    徽章行：Git · 已配置 · 令牌已保存                    ⋯
│    事实行：配置状态 / 上次同步 / 可同步分区
│    自动同步行：开关 + 间隔（5m / 15m / 30m / 60m / 6h / 12h / 24h）
│    同步内容行：12 个分区 · 含历史会话                  [编辑]
│    动作行：[一键同步]
├─ WebDAV 通道卡（未配置 → 矮态）
├─ 同步记录（仅操作日志，限高内滚）
└─ 指路行：「远端快照已移至产物库 → 远端」+ 去看看
```

**关键修正：分区选择在通道卡内，不是全局一节。** `autosync` 与 `sync-selection` 都**按通道独立**（schema v2），所以「同步内容」是每个通道自己的设置，必须跟着通道卡走；做成全局一节会让用户以为两个通道共用一份选择。

**通道卡两态**（控制高度，让 564×720 同时放得下两块）：

| 态 | 内容 | 高度 |
|---|---|---|
| 未配置 | 名称 + 未配置徽章 + `[配置]` | ≈56px |
| 已配置 | 徽章行 + 事实行 + 自动同步行 + 同步内容行 + 动作行 | ≈176px |

两个通道通常只有一个已配置 ⇒ 56 + 176 之后，日志仍有 300px 以上。**不做手动折叠**：少一层用户状态，也少一个「我上次折叠了哪张卡」的持久化字段。

**两个通道恒显示**（定案）：未配置的走矮态。一致、可发现，配置入口永远在同一位置；不做「只显示已配置的」那种随状态变化的页面结构——用户配完 Git 回来后发现另一个通道的卡消失了，只会当成 bug。

**沿用与拆分**：

- 通道卡本体就是现有 `SyncChannelEntryCard`（徽章行 + `.factGrid` 事实行已就绪），**只加两段**：自动同步行（吸收 `AutosyncCard`）与动作行（`[一键同步]` + `⋯` = 编辑配置 / 立即推送 / 立即拉取 / 清除配置）。
- 弹窗全部保留：`ChannelConfigDialog` / `SyncSectionPickerDialog` / `SyncConfirmView`；两张凭据卡并入 `ChannelConfigDialog`（见下）。
- `SyncHistoryView` 拆成 `SyncLogList`：**只留操作日志**（`projectAutosyncEntry` + `summarizeSyncHistory` 汇总行），远端快照行搬进 `artifact-view.ts`。v1 遗留的字符串 class `sync-history-table` 一并清掉。

**加密 / 解密设置要搬家。** `SecurityOptionsCard` 与 `DecryptPasswordCard` 现在是**页面级挂载**（`SyncSettingsView.tsx#L1069-L1080`，渲染在通道选择之下），而它们本质是「推送怎么加密 / 拉取怎么解密」的**通道配置**。v2 把它们收进 `ChannelConfigDialog`：页面高度才装得下两张通道卡 + 日志，用户去配通道时也自然能看见它们。通道卡的事实行只留一行只读摘要（「推送加密：开 · 含密钥：否」），安全提示仍由弹窗内的 `InfoHint` 承担。

## 9. 环境 + 维护与诊断

```
环境
├─ 档案列表（主视图，fit-content 高度）
│    ● web      当前运行 · 0.1.5-rc.1 · 42 插件            [详情]
│      cmtest   运行中 :3099                    [停止] [详情] [⋯]
│      desktop  桌面独占 · 不可启动               [详情]
│      prova    可启动                          [启动] [详情] [⋯]
├─ ProfileDetailDialog（只读键值行，底部只放关闭）
└─ 本机概况卡（整卡可点 → 维护与诊断）
     磁盘占用 5.7 MB · 可清理 503 KB   待处理事项 0 · 会话健康 未检查
```

**档案行**复用 `dsh-profiles-view.ts` 的全部投影（`profileRowFacts` / `profileVersionFacts` / `launchBlockReason` / `isProfileRunning` / `sessionFormatRisk` / `summarizeProfiles`），`ProfilesPanel` 的判定逻辑**一行不改**，只换外壳。

行内动作按态分派（与产物库同一条「能力决定动作」的规则）：

| 档案态 | 主操作 | ⋯ 菜单 |
|---|---|---|
| 当前运行（`current`） | ——（禁用，提示「关窗口」：进程会死在响应途中） | 详情 |
| 其它运行中 | 停止 | 详情 / 复制名称 |
| 桌面独占（`managed`） | ——（不可启动 / 删除 / 改名） | 详情 |
| 可启动 | 启动 | 详情 / 复制名称 / 重命名 / 删除 |

**不做成数据表**：档案行要同时表达「运行态 + 版本 + 插件数 + 会话格式风险」，列会很多；而且它与产物库的行语言完全一致（`.kindTag` + 主标识 + 徽章 + 动作），两个页面看起来才像一套东西。

**维护与诊断**（全屏子视图，不是 Segmented）四块纵向排列，顺序固定：

| 顺序 | 卡 | 说明 |
|---|---|---|
| 1 | 事故处理 | **仅有未解决事项时置顶**；含 SAFE MODE 状态、崩溃归因、事故列表与处置——issue #31 / #56 的解除入口在这里，不在别处 |
| 2 | 磁盘占用与清理 | `DiskUsageCard` 原样搬入；三条硬边界（候选集只有可重建区与显式勾选的过期导出、`snapshots`/`sync` 永不在候选集、界面数字由渲染行现算）一字不动 |
| 3 | 会话健康检查 | 只读扫描（由 `RecoveryPanel` 的对应块拆出） |
| 4 | 救援模式 | `RescueModeCard` 原样搬入 |

**为什么救援模式排最后却最可达**：它是 DSH 起不来时的唯一通道，可达性由**全局 SAFE MODE 横幅 + 首页健康段直达 + 命令面板**保证（§4.4），而不是靠它在列表里排第一。

**本机概况卡（定案）**：维护与诊断的入口升级为一张常驻卡，显示四个真实值 ——

| 值 | 来源 | 请求成本 |
|---|---|---|
| 磁盘占用 / 可清理 | `GET /disk-usage` | 首屏**懒加载**；骨架屏占位，失败显示「—」（不显示 0，§3 第三条） |
| 待处理事项 | recovery 状态轮询 | 零额外请求（宿主已有轮询） |
| 会话健康 | 未扫描时显示「未检查」 | 零额外请求（要进维护视图点「运行检查」才扫） |

整卡可点 → 维护与诊断。**单档案时它填满画布**（满足 `DESIGN.md` 的 Canvas 纪律：消灭底部空洞），多档案时它就是那段低频入口。

**其余三条保留**：

- 「维护与诊断」用页脚入口而不是第 3 个 Segmented：低频诊断不该和「档案」平起平坐，同时守住 §3 的「≤3 子视图」。
- `RecoveryPanel` 只**拆文件**，safe mode / clearable / incident 状态机与文案完全不动（issue #31 / #56 的硬约束）。
- 档案列表的既有硬语义全部保留：当前实例不可停止、`desktop` 独占不可启动/删除/改名、进行中态住 `runStore.profiles` 切片、`launch`/`stop` 不过 mutation gate。
- 市场不再是页签：**逛市场**与**发布到市场**都是 Task Mode 流程（见 §5.8 / §14）。

## 10. 路由与状态迁移

### 10.1 `PanelId` 收敛

```ts
// src/client/run-store.ts#L85
export type PanelId = 'home' | 'library' | 'sync' | 'environment'
```

旧值迁移（`run-store.ts` 的 `parsePersistedState`，#L1158 一带）：

| 旧 panel | 旧 subTab | 新落位 |
|---|---|---|
| `overview` | — | `home` |
| `snapshots` | `restore` | `library`（来源筛选保持「全部」——四源本就混排，替用户预先过滤反而更迷惑） |
| `snapshots` | `files` | `library`（同上） |
| `snapshots` | `schedule` | `home` + 打开自动备份弹窗 |
| `snapshots` | `recovery` | `environment` + 打开维护与诊断 |
| `export` | — | `library` + 打开导出流程 |
| `import` | — | `library` + 打开导入流程 |
| `sync` | — | `sync` |
| `market` | — | `library` + `sourceFilter='market'` |
| `profiles` | — | `environment` |
| `lifecycle` / `recovery`（更旧） | — | `environment` + 打开维护与诊断 |

抽屉的 `more.moreSub`（`runs` / `history` / `about`）**直接丢弃，不做迁移**：

| 旧 `more.moreSub` | 新落位 |
|---|---|
| `runs` / `history` / `about` | **不恢复**（`task` 是瞬态；v1 的抽屉开关本来也没恢复） |

**为什么不迁到 `task`**：`task` 明确不持久化（§10.2），而 v1 的抽屉开关（`drawerOpen`）本来就是组件内
`useState` —— 刷新后永远不恢复。把 `moreSub` 迁成 `task` 会变成「刷新后自动弹出一个面板」，比 v1 更烦人。
旧载荷里仍带 `more` 字段的，`parsePersistedState` **只忽略、不报错**（`run-store.test.ts` 有用例钉住）。

**迁移不写全的表现就是「刷新后回到旧页面」**。`run-store.test.ts` 的键集合与镜像用例必须同步。

### 10.2 新增切片

| 切片 | 字段 | 持久化 |
|---|---|---|
| `library` | `sourceFilter` / `query` / `sort` / `expandedKey` | 是（全部非敏感） |
| `shell` | `paletteOpen` | 否（瞬态） |
| `home` | `autoBackupOpen` | 否（瞬态） |
| `task` | `kind` / `payload` / `origin` | 否（瞬态；见 §5.8） |

`sessionStorage` 白名单与 `toPersistedState()` 的剔除逻辑沿用（`run-store.ts`）；新字段**不显式放行即不落盘**。

## 11. 文件处置清单

| 现有文件 | 处置 |
|---|---|
| `client/ConfigManagerSection.tsx` | 改造：`NAV_ITEMS` 7→4；`navOverflow` 换成 `nav-model`；接命令面板；新增 `.shellContent` 层与 `.taskPanel`；**删掉内联的抽屉 JSX** |
| `client/run-store.ts` | 改造：`PanelId` 4 项 + 迁移表 + `library` 切片 |
| `client/overview/OverviewPanel.tsx` | 改造为 `home/HomePanel.tsx`（去掉分区构成卡与活动视口） |
| `client/snapshots/SnapshotsPanel.tsx` | 拆解：外壳与 4 子视图 Segmented 删除，内容各归其位 |
| `client/snapshots/SnapshotsListTable.tsx` | 替换为 `library/ArtifactRow.tsx` |
| `client/snapshots/BackupFilesCard.tsx` | 替换为 `library/ArtifactRow.tsx` |
| `client/snapshots/DiskUsageCard.tsx` | 原样搬到 `environment/maintenance/` |
| `client/recovery/RecoveryPanel.tsx` | 拆成救援 / 会话健康 / 待处理三块，状态机不动 |
| `client/profiles/ProfilesPanel.tsx` | 改名 `environment/EnvironmentPanel.tsx`，业务逻辑不动 |
| `client/sync/SyncSettingsView.tsx` | 瘦身为 `sync/SyncPanel.tsx`：通道卡 + 内容摘要 + 日志 |
| `client/sync/SyncHistoryView.tsx` | 拆出 `sync/SyncLogList.tsx`（快照行搬去产物库） |
| `client/market/MyConfigsView.tsx` | 保留，降级为全屏「发布到市场」流程 |
| `ui/nav-overflow.ts` | 删除（被 `ui/nav-model.ts` 取代） |
| `.drawerMask` / `.drawerPanel` / `.drawerHeader` / `.drawerTitle` / `.drawerBody` | 删除（§5.9）；`@media (max-width:900px)` 里对 `.drawerPanel` 的覆盖一并删 |
| `client/common/ui.tsx` 等原语 | 全部复用；本轮**不引入任何新的第三方库** |

新增：`ui/{nav-model,commands,artifact-view,home-view}.ts`、`client/common/CommandPalette.tsx`、`client/home/HomePanel.tsx`、`client/library/{LibraryPanel,ArtifactRow,ArtifactDetail}.tsx`、`client/sync/SyncLogList.tsx`、`client/environment/EnvironmentPanel.tsx`、`client/environment/maintenance/{MaintenanceView,SessionHealthCard,RescueModeCard,IncidentList}.tsx`。

## 12. 落地顺序

每一步都能独立构建与测试，不留半截。

1. ✅ **外壳（2026-10-02 落地）**：`ui/nav-model.ts` + `ui/commands.ts` + `client/common/{menu-align,MoreMenu,CommandPalette}.tsx`
   + `client/task/TaskShell.tsx`；`run-store` 加 `task` 切片、`PanelId` 去掉 `export`、删 `more` 切片；
   抽屉整体并入面板（§5.9 完成）；`ui/nav-overflow.ts` 与其单测已删。

   **与计划的两处偏差（都记在决策日志）**：
   ① 一级导航**暂时仍是 6 项**（去掉导出）而不是 4 项 —— 产物库 / 环境两个页面还不存在（第 2、3 步）。
   ② 命令面板只注册**壳层真能执行**的命令（导航 6 + 开导出面板 + 活动 / 关于 / 事故恢复）：
      「一键同步」「立即备份」的执行入口分别住在同步页与首页的内部状态里，壳层调不动，
      留一条只会跳页的假命令不如不加（第 4、5 步有了真实入口再注册）。

   验证：中英文均不溢出；加一个假页签时自动进「更多」；导出流程从 Task Mode 进出且切页签后能续。
   门禁：`typecheck` / `typecheck:tests` / `npm test` 2835 项 / `build` / `bundle-selfcontained` 全绿。
2. 🚧 **产物库（进行中）**
   - ✅ `ui/artifact-view.ts` + 17 项单测；`ui/i18n.ts` 补 `library.*`（UiT 侧）；
     `client/library/{ArtifactRow,ArtifactDetail,LibraryPanel}.tsx`；`run-store` 的 `library` 切片；
     `PanelId` 加 `library`，旧 `export` → `library`、旧 `snapshots`(restore/files) → `library`；
     导航加「产物库」，⌘K 加 `go.library`。
   - ⏳ 行内动作分派（恢复 / 导入 / 拉取 / 安装 / 查看对比 / 下载 / 咨询 / 置顶 / 删除）
     与 `SnapshotsPanel` 的解散（删 restore/files 子视图 + `SnapshotsListTable` + 内联 `BackupFilesCard`）。

   **落地修正**：① 市场源不是 `MarketConfigEntry`（那是「已添加的市场仓库」设置，属设置不属产物），
   实际数据源是 `marketApi.browse()` 的 `MarketListItem`；② 能力 union 删掉 `'unlock'` 与 `'diff'`，加 `'unpin'`（见 §6.3）。

   验证：`artifact-view.test.ts` 的四源投影 / 能力分派 / 过滤排序；混合平铺顺序正确。
3. ✅ **环境（2026-10-03 落地）**：`client/environment/EnvironmentPanel.tsx`（档案列表 + 维护与诊断两个子视图）；
   `DiskUsageCard` 接进维护视图（成为 §9 的第 2 块）；`PanelId` 的 `profiles` 沿用但语义升级为「环境」；
   `ProfilesPanel.tsx` 删除。导航文案改 `environment.title`。

   **与计划的一处偏差**：`RecoveryPanel` **没有拆成四块**。它的渲染顺序本来就是
   「事故处理 → 会话健康 → 救援模式」，拆成独立卡片就得把「确认 → 执行 → 验证」的状态机提到父级，
   反而更脆；磁盘卡以子组件形式插进去即可。第 6 步收口时按 §9 重排顺序并重写 DESIGN.md §9。

   验证：救援模式与 SAFE MODE 解除路径端到端可用（issue #31 / #56 的回归）。
4. ✅ **首页（2026-10-03 落地）**：`client/home/HomePanel.tsx`（由 `overview/OverviewPanel.tsx` 演进）；
   `METRIC_TARGET` 按新 IA 重写（备份文件 / 安全快照 → 产物库 + 来源筛选；定时备份 → **本页开弹窗**）；
   「立即备份」上移到状态行右端；自动备份设置卡并入首页（Modal）；恢复类入口改指环境页；
   `SnapshotsPanel.tsx` 与 `panel:'snapshots'` 一并删除，导航收敛为 6 项 → 5 项（首页/产物库/导入/同步/市场/环境）。

   ⚠️ **本步落地时发生一次事故**：清理 `client/snapshots/` 目录用了通配删除，误删三个仍在使用的组件
   （`DiskUsageCard` / `BackupScheduleCard` / `RestorePlanView`）。前两者在 git 里从未被跟踪，
   已从 `lib/client.js` 的编译产物逐段还原（文件头已注明），第三者有 git 版本直接恢复。
   三者现回到 `client/snapshots/`，**下一步应连同这两个文件一起搬进 `environment/maintenance/`**
   —— 它们现在挂在「维护与诊断」与首页，`snapshots` 这个目录名已名不副实。教训已写进 AGENTS.md。
5. ✅ **同步（2026-10-03 落地）**：`client/sync/SyncPanel.tsx`（由 `SyncSettingsView.tsx` 演进并改名）。
   **两个通道卡恒显示**（未配置走矮态），为此把 14 个 handler 从「隐式读 `state.channel`」改成
   **显式收 channel 参数**（`channelStateOf` / `patchChannelOf` / `saveSelection` / `toggleSyncSection` /
   `setSessionsLimit` / `setSessionsInclude` / `setEncrypt` / `setIncludeSecrets` / `persistEncryptPassword` /
   `persistDecryptPassword` / `clearSavedDecryptPassword` / `toggleAutosync` / `updateAutosyncInterval` / `remoteReadyOf`）
   ——参数缺省仍取激活通道（弹窗路径沿用），通道卡内一律显式传自己的。弹窗（配置 / 分区选择 / 推送预览 /
   差异确认）留在页面级：点哪张卡的按钮就先 `switchChannel` 再开，因此只可能有一个。同步分区从**页面级一段**
   移进通道卡；同步记录拆出 `SyncLogList.tsx`（只留操作日志、去掉「类型」列 —— 远端快照行已搬进产物库），
   并加一条「远端快照已移至产物库 → 去看看」指路行。
   ⚠️ 实现期由 `info-hint-guard` 的 KEEP 断言发现一次真实回归：重写 render 时把「选择历史快照」整块
   连同空态一起删了（`syncflow.noSnapshots` 失去渲染点）。已按 v1 行为补回卡内。
6. ✅ **收口（2026-10-03）**：删 `SnapshotsPanel` / `OverviewPanel` / `ProfilesPanel` / `SyncSettingsView` /
   `SyncHistoryView` / `nav-overflow` 及其专属测试（共 10 个文件，全仓零活引用）；三个源码级守卫
   （info-hint / plan-text-redaction / mid-ellipsis）改指新路径；`DESIGN.md` §1 + 新增 §1.1（页面构成与三条
   不得回退的结构原则）+ §6 页面级模式按 v2 重写；`typecheck` / `typecheck:tests` / `test` 2849 / `build` /
   `bundle-selfcontained` 全绿。

## 13. 风险与开放问题

1. **`⌘K` 可能被宿主占用**（未实测）。冲突则退 `⌘J`。
2. **第一步不新增聚合路由**：产物库并发调现有四个只读接口。其中 `syncApi.snapshotsList(payload)`（`sync-api.ts#L502`）**需要 `SyncPushPayload`（通道 + 分区）**，不是无参只读。因此第一步让「远端」来源**只在同步通道已配置时出现**，不把分区选择耦合进产物库；其余三个来源（`api.snapshots()` / `api.listBackupFiles()` / `marketApi.browse()`）都是无参只读。第二步才把「来源」抽成 `ArtifactSource` 接口并在宿主侧收敛为一张注册表。
3. **两个行的语义细节待定**：① 「与当前对比」对备份文件与远端快照分别意味着什么（快照有 `file-diff`，其余两者没有对应接口）；② 市场条目进列表后，社区信息（作者 / 星标）的展示深度（已决定浏览走全屏流程，但列表行仍要一个最小标识）。
4. **可展开行与删除的行内竞争**：行点击展开、`⋯` 里删除，两者必须在视觉与事件冒泡上明确分离，否则会出现「想展开却删了」。
5. **混合平铺在数据量大时**：本机会话快照可达数百条。首屏只渲染可视区间是可选优化（`DESIGN.md` 的长列表限高内滚是硬要求，虚拟滚动不是）——先不引入，实测卡顿再加。

## 14. 决策日志

| 日期 | 决策 | 理由 |
|---|---|---|
| 2026-10-02 | 结构走「对象库为中心」+ 导航走「动作优先 + 命令面板」（D + E），分两步落地 | 「同一份配置 4 套 UI」是杂乱的结构性来源，挪页签治不好 |
| 2026-10-02 | 产物库默认**混合平铺**（不按来源分组） | 找「我上周那份」时不该先想它在哪个源里 |
| 2026-10-02 | **砍掉「改备注」** | `BackupFileMeta.note` 只有读没有写，改备注需新增路由，收益不值 |
| 2026-10-02 | **逛市场 / 发布市场做成全屏流程**（不再是页签，也不并进列表） | 市场要陈列 README / 作者 / 星标，塞进行展开态展示不下 |
| 2026-10-02 | 「维护与诊断」用页脚入口而非第 3 个 Segmented | 低频诊断不该与「档案」平起平坐；守住「每页 ≤3 子视图」 |
| 2026-10-02 | 导航项 = **图标 + 文字**（首页 / 产物库 / 同步 / 环境） | 「仅图标」是容量紧张时的第二级降级档，纯文字方案没有中间档 |
| 2026-10-02 | 统计条**不显示合计体积**，只有备份文件带 `sizeBytes` | 四源里只有一源有体积，求和会把「未知」混进「合计」（「未知显示 0」的变体） |
| 2026-10-02 | 「查看内容 / 差异」按来源分别落地；但「**迁移前咨询**」是通用次动作（`/consult` 支持四源） | 前者确有四个不同接口，硬统一会造出假能力；后者本就统一，不该按来源分叉 |
| 2026-10-02 | 行结构 = **来源标签上标题行**（`.kindTag` + 主标识），元数据行不再重复来源，也不再放 kind 图标 | 本机快照与远端快照的主标识都是时间，只靠 14px 图标区分不够；来源与主标识同处一视觉块最易扫读 |
| 2026-10-02 | 导出/导入/逛市场/发布市场走 **Task Mode**（独占内容区、`task` 与 `panel` 正交）；恢复/咨询/查看对比仍是 Modal | 判据 = 多阶段向导 vs 单次决策+报告；`PanelId` 因此保持 4 个值 |
| 2026-10-02 | 产物库**不做批量操作**；排序只留时间/名称 | 删除低频且不可逆，逐条二次确认更安全；体积只有一源有，「按大小」是个排不出结果的选项 |
| 2026-10-02 | 首页「立即备份」= 状态行右端 primary 按钮，动作网格保持三张卡 | 四张卡会把每张压到约 128px；即时动作与「备份状态」同处一行更贴 |
| 2026-10-02 | 同步页的「同步内容」（分区选择）**放进通道卡内**，不做全局一节 | `autosync` 与 `sync-selection` 按通道独立（schema v2），全局呈现会让人以为两通道共用一份选择 |
| 2026-10-02 | 同步页**两个通道卡恒显示**，未配置的走 56px 矮态 | 页面结构不随配置状态变化；配置入口位置固定，WebDAV 始终可发现 |
| 2026-10-02 | 环境页的维护入口升级为**常驻「本机概况」卡**（磁盘/可清理/待处理/会话健康），整卡可点 | 多数用户只有一个档案，纯入口行会留下大片空洞；磁盘统计做首屏懒加载 + 骨架屏兜住成本 |
| 2026-10-02 | task 呈现 = **内容区上的全宽侧滑面板**（`absolute` 定位、无遮罩、`drawerIn` 轻位移），取代 in-flow 替换 | 覆盖层让底下的页面**保持挂载**：关闭瞬时，滚动位置与展开态都还在；`absolute` 相对 `.shellContent` 顺带修掉 v1 用 `100vw` 打错地方的补丁 |
| 2026-10-02 | **抽屉并入 task**：活动 / 历史 / 关于 = 三种只读 task，删掉 `ActivityDrawer` 与 5 个 `.drawer*` 类 | 全站只剩「页面 / 面板」两个容器概念；三个表格拿到 532px 而不是 400px |
| 2026-10-02 | **否决「同屏侧栏」**（页面与面板并排）；改为「切走收起 / 切回续做」+ 执行期状态栏补进度 | 面板下限 440px、页面下限 420px，合计 860 > 564 的画布 —— 物理上放不下；用户的真实顾虑是「被关在流程里」，三层保障即可覆盖 |
| 2026-10-04 | 远端快照的 ⋯ 菜单与备份文件**逐项对齐**（咨询 / 查看与对比 / 下载 / 删除） | 同一份「远端产物」在备份文件里能做的事，在远端快照上不该缺；「查看与对比」不再受「客户端拿不到分区明细」限制 —— 落地成本机 ZIP 后走备份文件那条只读分析（同一条实现） |
| 2026-10-04 | 远端删除**只删远端那一份**，不动本机配置与同步基线（新增 `POST /sync/snapshot-delete`，过 mutation gate） | 删除是不可恢复动作，但改本机是另一件事：本机 `lastSnapshotId` 只是「上次共同祖先」的记录，远端少一份不影响本机可用性 |
| 2026-10-04 | 「拉取」的进度文案从「正在拉取并比对差异…」改为「**正在拉取并导入…**」 | 拉取不是只读预览：宿主落地 ZIP 后直接进导入向导，旧文案让用户以为只做了比对（用户报告） |
| 2026-10-04 | 产物库**移除页首标题行**（标题「产物库」+ 保留期 ⓘ + 手刷按钮）：标题与页签重复、手刷与壳层 `refreshTick` 重复；**保留期说明整体移除**（先下移计数条、再按用户要求删掉） | 用户要求；该行只占高度不透出新信息（见 §6.1 布局图） |
