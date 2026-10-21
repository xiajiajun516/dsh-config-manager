# 🎨 DESIGN.md — DSH Config Manager 视觉设计规范（Workbench Design System）

> **本文件是项目 UI / UX / Visual Style 的 Single Source of Truth。**
> **2026-10-06 UI v3 重做**（方案与迁移映射见 `docs/design/2026-10-05-ui-redesign-v3.md`）。
> 任何开发者或 AI Agent 在创建、修改前端界面前必读；若本文件与代码冲突，以代码为准并更新本文件。
>
> **v2 章节作废声明**：`docs/design/2026-10-02-ui-rebuild-v2-skeleton.md` 的 §4/§5/§7–§9
> 与本文 2026-10-06 之前的 §1、§1.1、§2、§3–§5、§9 **已被 v3 取代**（该文档仅作评审记录保留）。
> v3 的三处结构性变化：① 一级导航收敛为 4 页（市场退出导航、成流程）；
> ② 语义色改为 `--dsw-*` → `--cm-*` → 组件 的三层单向依赖；③ 字号/间距/圆角/层级有了**源级守卫**。

---

## 0. 定位：DSH 设置弹窗内的「内嵌工作台」

本项目 UI 挂在 DSH GUI 的 **`settings.section`**（「备份与迁移」）内。宿主约束（不可更改）：

- **画布固定 ≈ 564 × 720px**：设置弹窗 800×800（`width:800px; max-width:calc(100vw-48px)`），
  减去宿主导航 188px 与页边距后，插件内容区约 564px 宽、720px 高。
- 不拥有全局外壳/主题/字体栈：颜色字体全部消费 `--dsw-*` token（亮/暗主题与皮肤自适应）。
- 设计语言：**高密度开发者工具**（参考 Linear / Raycast / VS Code settings 的信息密度）。
  禁止：营销文案腔、大卡片堆砌、大留白、装饰性图标、纯填充用的零值 KPI 卡。

**Canvas 纪律**：任何页面都必须消灭「底部空洞」——内容不足时用真实数据块
（如首页的最近活动）填充，或让最后一个数据块成为内部滚动视口
（`.fillCard` / `.fillViewport`），禁止出现无意义的纯背景色区域。

---

## 1. IA（信息架构，UI v3 2026-10-06）

Shell（`ConfigManagerSection`）：导航条 + 内容区（页面 / 流程面板）+ 状态栏。

- **一级导航（图标 + 短标签页签）**：首页 / 产物库 / 同步 / 环境（**v3 收敛为 4 项**）。
  **市场不再是一级页面** —— 它由 Task 面板承载（入口：产物库底栏「逛市场 / 发布到市场」+ ⌘K 两条命令）。
  页签数量**不随功能增长**：放不下的项由 `navLayout` 从末项起移进「更多 ▾」（见 §6 Shell）。
  v3 是「4 页签 + 4 图标」（⌘K / 活动 / 历史 / 关于），中英双语都留有余量。
- **容器判据（唯一规则，v3 三条）**：多阶段向导 → Task 面板；**只读浏览 → Task 面板**（同壳）；
  单次决策 + 报告 → Modal；其余常驻任务域 → 页面。**没有第四种容器。**
- **命令面板**：`⌘/Ctrl+K`，命令表 `src/ui/commands.ts`（21 条，2026-10-08 增「回滚点」；2026-10-10「检查点」整体改名为「工作区 + 会话回滚」）—— 增一个功能 = 注册一条命令。
- **状态栏（28px 圆角条）**：状态点 + 就绪/进行中/恢复待处理 + 进行中**任务名 + 不定态细进度条**
  （本层只有「在跑 / 没跑」的布尔，真实百分比住宿主 `/progress`；编一个百分比就是撒谎）；
  在跑时整句可点开「活动记录」；右侧是插件与 DSH 版本。
- **救援可达性（不变量，不得打折）**：全局 SAFE MODE 横幅常驻；命令面板里**「事故恢复」与「救援模式」两条命令**；
  环境页「维护与诊断」子视图是它们的共同落点（2026-10-08 起同族再加一条「回滚点（工作区 + 会话回滚）」命令，落点相同）。

### 1.1 v3 的页面构成（2026-10-06 重做，替代 v2 的五页签）

| 页面 | PanelId | 回答的问题 | 子视图 |
|---|---|---|---|
| **首页** | `home` | 这台机器现在怎么样？我下一步做什么？ | 无（状态条 + 工具栏 + 最近活动表） |
| **产物库** | `library` | 我手上有什么产物？能对它做什么？ | 源筛选（全部 + 四源） |
| **同步** | `sync` | 跨机同步这条管道通不通？怎么配？ | 无（每通道一张卡：Git / WebDAV / S3 / Gist） |
| **环境** | `environment` | 这台机器有哪些 DSH 实例？健康吗？ | 2 个：档案 / 维护与诊断 |

三条**不得回退**的结构原则（v2 保留 + v3 修订）：

1. **对象 vs 日志分离**：产物库放「东西」，同步页只留「发生过什么」。两个问题的答案不共用一张表。
2. **每页 ≤2 个并列子视图，且必须同域**：跨域一律 Task / Modal / 独立页面
   （v2 的「≤3」改成更本质的「禁止跨域」——数字限制拦不住「一页四种心智」，域归属才拦得住）。
3. **未知值不显示 0**：读不到就是读不到；磁盘未统计的子区标 `unreadable`，进度未知显示占位。

**同步：一切按通道，且只在通道卡内**（`autosync` / `sync-selection` / 加密 / 解密都按通道独立）——
v3 删掉了页面级那张绑定「隐式当前通道」的分区卡（它此前在页面级与通道卡内**重复渲染**两次），
分区选择现在只存在于它所属的通道卡内。四个通道（git / webdav / s3 / gist）**恒显示**，未配置走 56px 矮态：
页面结构不随配置状态变化，配置入口永远在同一位置。
**已配置的通道卡可折叠**（缺省展开活跃通道，行尾 chevron 切换，带 `aria-expanded` + `aria-controls`）——
4 个通道全部展开会超过 564×720 画布；**加密 / 解密 / 远端快照告警都在这张卡自己的折叠体内**
（v3 之前它们挂在页面级、绑定一个由「点某张卡的按钮」悄悄切换的隐式当前通道 —— 用户会以为四个通道共用一份设置）。

---
- **流程任务层（Task Mode，2026-10）**：导出 / 导入 / 逛市场 / 发布市场是**多阶段流程**，
  活动 / 历史 / 关于是**只读视图**，它们统一由内容区上的全宽侧滑面板 `.taskPanel` 承载；
  面板只在 `panel === task.origin` 时渲染（切走收起、切回续做），状态住 `runStore.task` 且**不持久化**。
- **容器判据（选容器的唯一依据）**：多阶段向导 → Task 面板；单次决策 + 报告 → Modal。
- **命令面板**：`⌘/Ctrl+K`，命令表在 `src/ui/commands.ts` —— 增一个功能 = 注册一条命令，
  不必再往 564px 的导航条里挤一个页签。
- **状态栏（28px 圆角条）**：状态点 + 就绪/进行中/恢复待处理 + 插件与 DSH 版本；
  与顶部页签条同款「圆角分段条」外观（四周留白 8px，不再通栏贴底）。
- 页内子视图切换一律用 `Segmented`（如备份页：安全快照 / 备份文件 / 定时备份 / 事故恢复）。

---

## 2. Design Principles

| 原则 | 含义 |
|---|---|
| **Token 驱动，零硬编码** | 颜色/字体/阴影全部 `--dsw-*`；tint 用 `color-mix(in srgb, <token> <pct>, transparent)` |
| **薄壳渲染，逻辑下沉** | React 只装配；渲染模型/状态判定在 `src/ui/` 纯函数（node 单测） |
| **密度优先** | 基准字号 12.5px；行高 1.5；卡片 padding 12px；页面 padding 16px；区块间距 10px |
| **状态即语义** | ok/info/warn/error 四态贯穿 Badge/Banner/StatusDot/choiceCard |
| **危险操作隔离** | 删除/恢复恒 `danger` 变体或 `data-danger` 图标 + ConfirmDialog 二次确认；行内用 `.rowDivider` 与安全操作分隔 |
| **开发者排版** | 路径/文件名/时间戳/命令一律等宽栈（`.mono`）；长文件名**中段省略**（保留尾部时间戳）+ `title` 全文 |
| **无障碍** | 所有交互元素 `:focus-visible` 双环；图标按钮必须 `aria-label`；表格行选择支持 Enter/Space |

---

## 3. Colors（三层单向依赖：DSH token → `--cm-*` → 组件）

**方向不可逆**：组件规则只消费 `--cm-*`；`--dsw-*` 只允许出现在 `--cm-*` 的定义行里。

| 语义角色 | 中间层 token（组件只写这层） | 来源 |
|---|---|---|
| 主要 / 次级 / 弱化文字 | `--cm-text-1/2/3` | `--dsw-alias-label-primary/secondary/tertiary` |
| 主色按钮上的文字 | `--cm-text-on-accent` | `--dsw-alias-label-primary-foreground` |
| 页面 / 卡片表面、hover 底 | `--cm-surface-1/2`、`--cm-surface-hover` | `--dsw-alias-bg-layer-1/2`、`--dsw-alias-interactive-bg-hover` |
| 描边 L1 / L2 | `--cm-line-1/2` | `--dsw-alias-border-l1/l2` |
| 输入框背景 | `--cm-input-bg` | `--dsw-specific-input-major` |
| 聊天流用户消息气泡底 | `--cm-chat-bubble` | `--dsw-specific-bubble`（缺档回落 `color-mix(in srgb, var(--cm-text-1) 12%, transparent)` —— **兜底必须是可见色**，bg-layer-2 在浅色 = #fff 等于没兜底） |
| 主色（focus / 选中 / 进度） | `--cm-accent` | `--dsw-alias-state-business-primary` |
| 主按钮填充 / hover | `--cm-accent-fill` / `--cm-accent-hover` | `--dsw-alias-button-info-fill/hover`（保留原语义别名） |
| 四态 ok / info / warn / error | `--cm-ok` `--cm-info` `--cm-warn` `--cm-error` | `--dsw-alias-state-{success,warn,error}-primary`；**info = `--cm-accent` 同义别名**（DSH **没有** `--dsw-alias-state-info-primary`，见下） |
| 原生主按钮填充 / hover | `--cm-primary-fill` / `--cm-primary-hover` | `--dsw-alias-button-primary-fill/hover`（= 原生 `.button.primary`） |
| 交互态 hover / active / 危险 hover | `--cm-hover` `--cm-active` `--cm-hover-danger` | `--dsw-alias-interactive-bg-hover/active/-hover-danger` |
| 幽灵选中态（页签 / 分段 / 下拉选中） | `--cm-ghost-active-fill` / `--cm-ghost-active-border` | `--dsw-alias-button-ghost-active-fill/border`（= 原生 Pill 的 active） |
| 弹层/菜单表面 + 背板模糊 | `--cm-menu-surface` / `--cm-menu-backdrop` | `--dsw-menu-surface-fill` / `--dsw-menu-backdrop-filter` |
| 菜单图标色 | `--cm-menu-icon` | `--dsw-alias-menu-icon` |
| Tooltip 气泡（ⓘ）底 / 前景 | `--cm-tooltip-bg` / `--cm-tooltip-fg` | `--dsw-alias-tooltip-bg` / `--dsw-static-neutral-bluish-00` |
| 通知（Toast）底 / 前景 | `--cm-toast-bg` / `--cm-toast-fg` | `--dsw-alias-toast-bg` / `--dsw-alias-toast-label`（原生 toast 两个主题下都是深色） |
| 深色 toast 上的警示文字 | `--cm-warn-label` | `--dsw-alias-state-warn-label` |
| 弹窗遮罩 / 背板模糊 | `--cm-mask` / `--cm-mask-blur` | `--dsw-alias-bg-mask-1` / `--dsw-mask-blur` |
| 骨架底色 | `--cm-skeleton` | `--dsw-alias-bg-skeleton` |
| 中性/空转状态点、品牌色（复选框） | `--cm-idle` / `--cm-brand` | `--dsw-alias-state-idle-primary` / `--dsw-alias-brand-primary` |
| 正文字体 | `--dsw-font-family`（基础层直用）；等宽栈 `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` | — |

**2026-10-17 对齐原生**：上表新增的这些 token 全部取自 `dsh-client-ui-theme` **实际发布**的名字
（逐条比对本机 app.asar 的 411 个 `--dsw-*` 定义，脚本核对；插件引用的 59 个 token 里除宿主运行时自带的
`--dsh-content-font-*` / `--dsh-chat-content-width` 外全部命中）。三条硬约束继续成立：
① 组件规则只写 `--cm-*`；② 状态色 / 按钮填充只允许出现在 §1 定义行；③ **每个 `var(--dsw-*)` 都带兜底值** ——
老宿主缺 token 时退化为可读的近似色，而不是整条声明失效。

**修正（同轮发现）**：`--cm-info` 此前指向 `--dsw-alias-state-info-primary` —— **DSH 里没有这个 token**
（状态色只有 business / success / warn / error / idle）。自定义属性「无效于计算值」会让三个消费点
（任务面板底色、状态点、行首色条）静默退化成透明/继承色。现按同义别名接到 `--cm-accent`
（原生 Tag 的 info tone 用的也是 business 主色）。

- tint 一律 `color-mix(in srgb, var(--cm-*) <pct>%, transparent)`；**零硬编码色值**（扫描器已在 `ui-audit` 验证：命中全在注释）。
- 语义映射：成功=ok、业务信息=info、警告=warn、错误/危险=error。
- **执行者**：`src/client/css-token-guard.test.ts` —— 四态/主色 token 只允许出现在 §1 TOKENS 定义行；
  组件规则里出现裸 `--dsw-alias-state-*` / `--dsw-alias-button-info-*` 即红灯。
  结构类 token（label / border / bg / hover / input）**不受约束**：它们语义稳定，直用更短、更易读。

---

## 4. Typography（**4 档**，唯一允许的 scale）

**档位身份取自 DSH 原生字体 token**（2026-10-17 对齐原生）：不再由我们自定 px，而是逐档映射到
`dsh-client-ui-theme` 发布的那套字体 token —— 原生调档时这三档跟着动。

| 档 | 字号 | 原生来源 | 用途 |
|---|---|---|---|
| meta | **11px** | `--dsw-font-xxxs-11-font-size` | 徽章 / hint / 元数据 / 等宽值 / 日志 / 骨架 caption |
| table | **12px** | `--dsw-font-xxs-12-font-size` | 数据表 / 密集列表 / 行内名称与值 |
| base | **12.5px** | **无原生对应档（唯一刻意的偏离）** | 正文 / 按钮 / 输入 / 标签（基准） |
| title | **13px** | `--dsw-font-xs-13-font-size` | 页面与区块标题 |

- **base 为什么不是原生档**：原生最小正文档是 13px（`--dsw-font-xs-13`，即我们的 title 档），
  而插件画布只有 564×720、要装下高密度表格与清单，正文取「比原生最小正文再密半档」。
  它也**不跟随**宿主的「内容字号」轴（`--dsh-content-font-size`，默认 14px）——那条轴属于宿主正文档位，
  跟着放大只会撑破画布；**镜像宿主气泡的 `.chatEntryScope` 例外**（见下条）。
  改这一档 = 全站字号地震；例外逐条登记在 `css-scale-guard.test.ts` 的 `FONT_TOKEN_EXCEPTIONS`。
- 同理：`font-size` 一律消费 `var(--cm-fs-*)`（全表已无裸字面量），守卫同时断言每个 `--cm-fs-*`
  **必须**取自 `--dsw-font-*`（例外表之外一律红灯）。

行高 **2 档**：**1.25**（标题）/ **1.5**（正文）。**唯一例外** = 聊天流用户气泡的 `.chatEntryScope`（`--cm-lh-base`）：那一处不是我们自己的排版，而是**复刻宿主气泡**，用宿主同一条活公式 `calc(22px + var(--dsh-content-font-delta,0px))`（字号那一处同理镜像 `var(--dsh-content-font-size,14px)`）—— 写死 1.5 会在「内容字号」调大后与助手正文脱节（2026-10-17 issue #93）。
v3 收敛记录：9.5 / 10 / 10.5 → 11；14 → 13；30 随死类删除；11.5px（28 处）逐条归类为
「次级文本 → 11、内容/名称/值（表内数字、单元名、恢复计划路径…）→ 12」（见 v3 文档 §12.8）。
**执行者**：`css-scale-guard.test.ts`（font-size 越界即红灯）。

- 数字一律 `font-variant-numeric: tabular-nums`（`.section` 全局启用）。
- 中文文案统一全角标点；插入语遵循 `line-break: strict`（`.quickActionHint` 等）。
- 禁止营销语气（「更省心」类）；状态描述使用名词在前（「定时备份 已开启」）。

---

## 5. Spacing & Shape

- 间距网格（**9 档**）：2 / 4 / 6 / 8 / 10 / 12 / 14 / 16 / 24；区块间距统一 10px。
  `14` 与 `24` 是数据挣来的档位（前者被 `session-dialog-mount.test.ts` 硬钉、是用户实测「挤在一起」后定的值；
  后者用于空态 hero 大内边距与宽间距）。**布局偏移**（`-4px` 图标对齐、`22px/38px` 深层缩进）走显式豁免白名单，
  不污染节奏档 —— 豁免逐条写在 `css-scale-guard.test.ts` 里并注明理由与上限。
  **落地方式（2026-09 修正）**：区块间距由**容器**统一提供，不靠各区块自带外边距 ——
  `.viewBody`（页面主体，纵向 flex）显式 `gap: 10px`，并把**直接子元素**的上/下外边距归零
  （flex 容器不折叠 margin，不归零就变成 20px）。此前间距靠「上一个元素恰好的下外边距」，
  于是「小节标题 → 面板」「说明文字 → 横幅」「列表首个子块 → 面板」这些位置恒为 0，
  表现为面板/按钮紧贴上面的内容。规则块见 CSS §9b（必须留在组件规则之后，源序决定归零胜负）。
  页面末尾另有 `.viewBody::after`（8px 实盒）作**底部呼吸区**：`.pagePad/.viewBody` 是
  `flex:1 1 auto + min-height:0`（缩到视口高），它们的 padding/外边距**不进滚动溢出区** ——
  内容一长，最后一排按钮就被压到底部状态栏上（用户实测）。伪元素是真实盒子，必然计入溢出。
- 嵌套容器里的小节标题（卡片、面板小节）自带 `margin-bottom: 10px`（`.sectionTitleBlock`）；
  页面主体内该外边距被上面的归零规则接管。
- 圆角（**5 档**，2026-10-17 改由**原生 control-radius scale** 派生，按角色挑档）：
  `--cm-r-1` = 原生 `radius-xs` 4px（小标记）、`--cm-r-2` = `radius-sm` 8px（紧凑控件 = 原生 `.button.sm`）、
  `--cm-r-3` = `radius-md` 12px（行 / 卡片 / 输入 = 原生菜单项与设置页输入框）、
  `--cm-r-surface` = `radius-lg` 16px（菜单 / 弹窗 / 通知等浮层表面 = 原生 MenuSurface）、`--cm-r-pill` 999px；
  另有 `0` 与 `50%`（圆形）两个结构性豁免。`border-radius` 一律写 `var(--cm-r-*)`（守卫断言）。
  **激活态统一用原生 Pill 的配方**：`--cm-ghost-active-fill` 底 + `--cm-ghost-active-border` 内描边
  （`.navStrip` 页签、页内分段、下拉选中项、图标按钮同款语言）。
- **描边粗细分两档（原生惯例）**：**控件与行分隔线 0.5px**（原生 `.button.outline` / 输入框 / Tag / 菜单分隔线 /
  设置页字段分隔线全是 0.5px 发丝线），**卡片与表格外框 1px**。控件描边色改用原生的 `border-l3`（按钮）/
  `border-l4`（输入框），而不是自己挑的 `border-l2`。
- **浮层边缘由 elevation 承担**：菜单 / 弹窗 / 通知 / 提示气泡不再自带 1px 边框，改
  `box-shadow: var(--cm-shadow-1|2)` —— 原生 elevation token 内已含 `0 0 0 .5px` 的发丝描边，
  跟着主题走（`--dsw-elevation-stroke-color`）。
- 控件高度（**3 档** `--cm-h-sm/md/lg` = 24 / 28 / 32）：按钮 28px（sm 24）、输入/选择 28px、
  表格行 ~32px、活动行 28px、顶部页签条 32px（条内页签 24px）、状态条 32px、状态栏 28px、图标按钮 26px。
- 层级（**6 档语义** `--cm-z-*`）：raise 1 / sticky 2 / task 90 / mask 100 / modal 101 / pop 110 / toast 120。
- 阴影（**2 档**，取自原生 elevation）：`--cm-shadow-1` = `--dsw-elevation-soft`（浮层 Select/MoreMenu、
  分段控件选中片、Tooltip）、`--cm-shadow-2` = `--dsw-elevation-prominent`（弹窗卡片、菜单、通知）；
  **不得再写一次性阴影值**。
- **焦点环（1 档）改为宿主全局规则的同一枚 token**：`--cm-focus-width` / `--cm-focus-color` =
  `--dsw-focus-ring-width` / `--dsw-focus-ring-color`（兜底主色）。宿主在**指针输入模态**下把
  `--dsw-focus-ring-color` 置为 transparent（`html[data-input-modality=pointer] body :focus-visible`），
  于是**鼠标点击不画环、键盘导航才画** —— 与原生控件完全一致（此前插件自己写死 2px 主色环，
  鼠标点一下也亮，比宿主所有控件都"吵"）。老宿主没有该 token 时回落主色环，可访问性不丢。
- **执行者**：`css-scale-guard.test.ts` 同时钉住 border-radius / line-height / z-index（z-index 必须走 `--cm-z-*`，不得写字面量）。
- 动效：**令牌统一** —— `body` 上定义 `--cm-motion-fast/base/slow`（120/180/300ms；
  slow 就是进度条的 300ms 推进；**2026-10-12 从 .section/:root 的旧位置修回 body** —— 那次 token 作用域
  迁移把它们整段丢掉了，全仓只剩 `var(--cm-motion-*)` 的引用 ⇒ 每一条 animation/transition-duration 都
  在 computed-value 阶段失效、全部动效静默退化成「瞬变」。定义回 body 与其余 `--cm-*` 同层，
  Portal 到 body 的弹窗才继承得到）、
  `--cm-motion-ease-out`（`cubic-bezier(0.16,1,0.3,1)`，入场用）、`--cm-motion-ease-in-out`
  （循环动效用）；各处只引用变量，不再各写一遍毫秒值。现有动效清单：
  颜色过渡 120ms ease（含状态点 / 步骤条的状态色）、进度条 300ms、面板滑入与通知入场 180ms、
  状态点脉冲 1.2s、
  **页面入场 180ms**（`.pagePad` 的 `pageEnter`：opacity + 4px 上浮；React 侧以 `key={panel}`
  重建节点，换页时重放一次）、**弹窗入场/退场**（`.dialogMask` 淡入 120ms + `.dialogContentCenter`
  **纯淡入** 180ms：`dialogIn` 的 keyframes 只写 opacity（2026-10-21 用户反馈「弹窗出现的时候有时候
  动画会发生形变」后，从「淡入 + 4px 上浮」改掉）—— **入场不得用 scale**（卡片靠 `translate(-50%,-50%)`
  自居中，scale 会改变可见尺寸/位置），**也不得用位移**（上浮让每帧落在非整数像素上，1px 外框与
  0.5px 分隔线逐帧重采样 ⇒ 观感是「形变/抖动」；且内滚条在动画中途才出现时会挤压宽度）；
  退场仍是 0.98 微缩。关闭走 `[data-state='closed']` 的
  `maskOut`/`dialogOut` ——
  Radix 的 Presence 会保持节点挂载并等 `animationend` 再卸载，所以退场只需写 CSS）、
  **折叠 180ms**（`.collapse`：`grid-template-rows` 0fr ⇄ 1fr，**展开与收起两端都有动画**；
  用法见 §6 的 `Collapse`）、**视图切换入场**（`.viewEnter`：`ViewSwitch` 的 key 重放）、
  **列表/条目入场**（`.snapshotList > *`、`.dataTable tbody tr`、`.pickerUnit`、`.restorePlan`、
  `.banner`、`.empty`，前 4 项各递进 24ms）、**骨架 shimmer 1.3s**（`.skeletonBar`）。
  图标形变仅限 `ExpandChevron`（折叠展开/收起；临界阻尼、无过冲，见 §6 第三方原语）。
  **`prefers-reduced-motion: reduce` 下关掉装饰性动效**（页面/弹窗/面板/通知入场、状态点脉冲、
  骨架 shimmer —— 骨架退化为静态占位块，信息不丢）——
  旋转与不定态进度**刻意保留**：它们承载「正在进行」这个状态本身，关掉会让用户以为界面卡死。
  形变侧由 morphicons 的 `reducedMotion="user"` 承担（CSS 选择器管不到 SVG 内的属性插值）。
  两条实现约束：页面/弹窗入场**不写 `forwards`**（动画结束回到基础样式，不留残影）；
  `dialogIn` 的 keyframes **只碰 `opacity`**，自居中位移留给 `.dialogContentCenter` 自己的
  `transform: translate(-50%, -50%)`（动画与定位在同一元素上，keyframes 里再写 transform 会接管定位；
  位移本身还会引入上面那条亚像素重采样）。
  **含内滚列表的弹窗给滚动容器加 `scrollbar-gutter: stable`**（`.dialogBodyScroll`、`.mergeScroll`）：
  入场瞬间内容尚未测量完，滚动条可能在动画中途才出现、占掉 8–15px 宽度 ⇒ 整卡片横向跳一下。

---

## 6. Components（config-manager.module.css 类）

### 与 DSH 原生组件的对齐（2026-10-17）

**复用优先的三层策略**（判据 = 稳定接口 + 回落可用）：

| 层 | 做法 | 现状 |
|---|---|---|
| ① **直接用原生组件** | 帧内惰取 `@deepseek-ai/dsh-client-ui-primitives`（`common/host-primitives.ts` 是**唯一出口**：三态缓存 + try/catch，老宿主回落本地实现） | **徽章 `Badge` → 原生 `Tag`**（tone 映射在 `src/ui/badge-tone.ts`，可单测）；另有 `FileTypeIcon`、`projectUserText` |
| ② **规格对齐（CSS 层）** | 原生组件 API 与本插件语义不匹配时（如 `Button` 没有 danger/loading/href、`Select` 需要自绘键盘与 ARIA、Modal 走 Radix 且 Portal 必须回收插件根容器），**不硬换组件**，而是把视觉规格逐值抄成原生取值 | 按钮 / 输入 / 下拉 / 复选 / 状态点 / 分段 / 卡片 / 表格 / 弹窗 / 通知 / 提示（下表） |
| ③ **自研** | 原生没有对应物（高密度数据表、内容选择树、恢复计划视图、步骤条、任务中心） | 保持不变 |

**逐组件规格（取自 `dsh-client-ui-primitives/lib/*.module.css` 实测值）**：

| 组件 | 原生取值（抄进本插件的部分） |
|---|---|
| Button | `.button.sm` = 28px 高 / `radius-sm` / `padding: 0 10px` / 12px 字 / 0.5px 透明边框；ghost 描边 `border-l3`、hover `interactive-bg-hover`、active `interactive-bg-active`；disabled `opacity: .4`；danger hover = `interactive-bg-hover-danger` |
| IconButton | 原生关闭钮 = **28×28** / `radius-sm` / 透明底 / hover `interactive-bg-hover`（小尺寸 18px 档保持不变：级联树的展开 chevron） |
| Input / Select 触发器 | 32px 高（本插件沿用紧凑 28px 档）/ `0.5px` `border-l4` / `radius-sm`；**聚焦只换描边色**（不再叠 box-shadow 环）；placeholder `label-dimmed`；disabled 用 `label-tertiary`（原生不用 opacity） |
| 复选 / 单选 | **16×16**（原 14）/ `accent-color: --cm-brand`（原生 `brand-primary`）/ 焦点环走原生配方 |
| Tag 语义（徽章 / 横幅） | 同色 **10%** tint 作底（warning 用 **12%**）+ 同色文字；药丸圆角（`corner-shape: round` 由宿主全局 `*` 规则提供） |
| 状态点 | 原生 `StateDot` 几何：**10px 槽位**里 `::after` 画 60% 实心核、色走 `currentColor`；idle 用 `state-idle-primary` |
| 分段控件 | 轨道 = `interactive-bg-hover`（无边框）+ 2px 内距；选中片 = `bg-layer-1` + `--cm-shadow-1`（原生指示片用 soft elevation） |
| 菜单 / 下拉弹层 | `--cm-menu-surface` + `--cm-menu-backdrop`；`radius-lg`；`border: 0`（边缘由 elevation-prominent 提供）；行 `radius-md`、hover `--cm-hover`、disabled `.4`、分隔线 `0.5px border-l2` |
| 弹窗 | 遮罩 `--cm-mask` + `--cm-mask-blur`；卡片 `bg-layer-2` + `--cm-shadow-2` + `radius-lg`（原生模态是 `radius-panel` 28px —— 那是**顶层**模态的档，本插件的弹窗嵌在设置面板里，取 MenuSurface 的 16px）；标题 500 字重；底部 `0.5px border-l2` 分隔线 |
| 通知（Toast） | 原生 toast 表面：`--cm-toast-bg` / `--cm-toast-fg`（**两个主题下都是深色**）、`radius-lg`、`--cm-shadow-2`、`padding: 12px 16px`、14px 字、仅用图标表达状态色（不再给整条加状态描边）、warn 文字用 `--cm-warn-label` |
| Tooltip（ⓘ 气泡） | 原生 Tooltip 表面：`--cm-tooltip-bg` / `--cm-tooltip-fg`（深色气泡、两主题一致）、`radius-sm`、`--cm-shadow-1`；12px 字与 8/10 内边距**刻意保留**（这里装的是多行机制说明，不是一行短提示） |
| 数据表 | 行分隔线 `0.5px border-l2`（含全站 9 处行分隔线），表头 11px `label-tertiary` |
| 骨架 | `--cm-skeleton`（原生 skeleton 底色） |

**徽章四态修复**：`ui.tsx` 原先拼的 `badgeOk/badgeInfo` 等类名在 CSS Modules 表里**从未存在**，
四态徽章长得一模一样；现在 ① 走原生 Tag 调色板（success/info/warning/danger），② 回落路径也补上了
`.badge[data-kind]` 的同口径 tint —— 两条路径语义来自同一张映射表。

### Primitives（common/ui.tsx）
- `Button`（primary/ghost/danger × sm/md；`href` 外链同款外观）。**`loading=true` 时由原语自动前置
  `Spinner`**（同时自动 `disabled` + `aria-busy`）—— 调用方只给普通文案；既然图标由原语给，
  同一个按钮上**不要**再手写一个 `<Spinner/>`（会得到两个转圈）。此前「有没有加载图标」取决于
  每个调用点是否记得写，漏写处只换文案、没有任何进行中反馈（用户实测：任务中心的终止/确认、
  灾备页的撤销/重做、历史导出）。**新代码一律用 `loading`**；历史遗留的
  `{busy ? <Spinner label={…}/> : 文案}` 写法仍有图标，可读性略差、不必为它单独改一波。
- `IconButton`（`.iconBtn`；`active`/`danger` 修饰；必须 `aria-label`）
- `StatusDot`（idle/ok/info/warn/error + `pulse`）
- `Badge`（info / ok / warn / error → **原生 `Tag` 的 info / success / warning / danger tone**；
  原生包不可用时回落同口径的 `.badge[data-kind]`）
- `Banner`（四态；操作按钮一律**内嵌右侧**）
- `Segmented`（页内子视图切换；受控）
- `Card` / `Field` / `SectionTitle` / `Empty` / `Checkbox` / `Stepper`
- `InfoHint`（`common/InfoHint.tsx`，ⓘ 说明原语，2026-10）：**说明性文案的唯一承载体**。
  触发元素是 `<button type="button">`（复用既有 `InfoIcon`）；悬停 / 键盘聚焦 / 点击固定三通道打开，
  再次点击取消固定，**固定态下按下任意位置（触发按钮自身除外）同样取消固定并关闭**（`mousedown` 捕获阶段、
  不 `stopPropagation`，守卫 `t10`），Esc 关闭（捕获阶段 + `stopPropagation`，不连带关掉外层 Modal/侧滑面板），
  鼠标移出且未固定时关闭。**键盘聚焦通道只认「用户在弹窗内把焦点移过来」**：Radix 弹窗挂载会把初始焦点
  派给容器内第一个可聚焦元素（标题行的 ⓘ 常常正是它），该次聚焦的 `relatedTarget` 在弹窗之外 → 不打开，
  焦点环也只在气泡打开时才画（`.infoHintBtn[data-open]:focus-visible`）—— 程序化初始焦点于是既不弹气泡
  也不亮蓝框（2026-10-04 用户反馈「一进弹窗就自动选中 ⓘ」，守卫 `t11`）。
  说明文本走 `aria-describedby`（多实例 id 由 `useId` 保证唯一），
  可访问名取各自命名空间的字典键 `common.infoHint`；**不依赖原生 title**。
  气泡**必须经 `createPortal` 渲进插件根容器**（`resolveModalRoot()` = `MODAL_ROOT_ID`，与 Modal 共用同一份
  实现，**绝不 `document.body`**）—— 否则会被 `.dialogContentCenter` 的常驻 `transform` 变成 fixed 包含块
  并遭 `.dialogBody` 的 `overflow-y:auto` 裁剪；定位仍走 `getBoundingClientRect()` 量测，
  但夹紧基准是**宿主画布 ∪ 锚点**（画布 = 插件根容器可见矩形 ∩ 窗口；并进锚点只为让气泡贴得住自己的 ⓘ ——
  弹窗卡片是 fixed、相对窗口居中，会伸出画布左缘，见 §7），下方空间不足且上方更宽裕 → 向上翻转，
  多行折行（`white-space: pre-wrap` + `max-width`），因此 564×720 画布内不出界、**不被任何父级
  overflow 裁剪**。哪些文案该进它、哪些必须常驻，见 §7「说明性文案分层」。
- `Select`（`common/Select.tsx`，2026-09 替换**全部**原生 `<select>`，15 处）：自绘下拉。
  为什么必须自绘：`appearance: none` 只改触发器，**展开后的弹层仍是系统控件**（深色主题下是亮底
  系统菜单），且吃不到 `--dsw-*` token（§3 硬约束）。触发器复刻 `.input` 盒模型，弹层走
  layer-2 + 阴影 + 120ms 入场，chevron 180° 旋转标示展开态。
  自绘要多扛三件事，缺一不可：① **键盘语义**（↑/↓ 跳过禁用项并环绕、Home/End、Enter/Space 提交、
  Esc 关闭且必须 `stopPropagation`——它可能位于 Radix 弹窗 / 侧滑面板内，冒泡会连带关掉外层）、
  ② **ARIA**（combobox + listbox + option，`aria-expanded`/`aria-activedescendant`/`aria-selected`/`aria-disabled`）、
  ③ **贴边翻转**（`data-align`：右侧剩余不足 260px 时改右对齐，否则弹层会被 `.section` 的 overflow 裁掉）。
  可测的索引推导（初始高亮/移动/首尾）在 `src/ui/select-model.ts`（node 单测）；组件只装配。
  选中项**不用右侧对勾**（用户要求移除），改为「主色加粗 + 10% 主色底 + 左侧 2px 主色条」。
- `Spinner`（13px 转圈 + 可选文案）。**环是 SVG 几何**（两个 `<circle>`：底环 30% 对比度的完整圆
  + 25% 实色圆弧 `stroke-dasharray`，共用同一个 `@keyframes spin`）—— **不是**
  `border + border-radius: 50%`：13px 的盒子上 2px 边框占直径 15%，且只有 `border-top` 实色、
  其余三边仅 25% 不透明度，栅格化后视觉上只剩一条亮弧、形状读不出来（2026-09 用户实测反馈
  「加载的 icon 不是圆形」：像素测量显示形状**本来就是**近圆 20×19，问题在观感不在几何）。
  着色一律 **`currentColor`**（与 lucide 图标同一约定）：写死 `--dsw-alias-state-business-primary`
  会在**主色按钮**（蓝底）上变成蓝画蓝、图标「隐形」，用户只看到按钮莫名变宽（真机截图）。

- `Skeleton` / `SkeletonList` / `SkeletonTable` / `SkeletonRows`（`common/Skeleton.tsx`）：**整块内容首次加载**
  的骨架占位（列表 / 表格 / 详情）。与 `Spinner` 的分工是**硬的**：**有布局轮廓可给 → 骨架**
  （首屏列表、数据表、详情正文）；**没有轮廓可给 → Spinner**（按钮内联的 `Button loading`、
  大分区读取遮罩 `.pickerOverlay`、轮询中的小区域）。骨架先给出「这里将出现什么」，
  数据到货时页面不跳变；转圈则只表达「正在进行」。无障碍：视觉块统一 `aria-hidden`，
  加载语义由外框的 `role="status"` + `aria-busy` + **可见 caption 文案**承担 ——
  文案复用各调用点**已有的** `xxx.loading` 键（Spinner 的 label 同源，不新增字典项），
  骨架**不得**只留色块不留文案。着色只用「弱化文字色」的低透明 tint + 一条同色高光，
  不引入第二个色系；`prefers-reduced-motion: reduce` 下退化为静态占位块（§15）。
  形态：`line` 正文行 / `title` 区块标题 / `block` 区块 / `row` 行条目，
  多行时按 `nth-child` 做长短交错 + 逐条递进延迟（避免整块齐闪）。
  `SkeletonRows` 是**紧凑行**骨架：单行高度对齐真实行（产物库/回退点 52px，图标 20px、
  标题 38% / 说明 24% / 右侧动作 56×20），用于「行结构已知的密集列表」—— 行高对齐后
  数据到货不跳变，因此优先于 `SkeletonList` 的通用卡片块。
  **判据（硬）**：页面 / 面板 / 弹窗**正文**的首次加载**一律骨架**，不得只留一个居中转圈
  （用户会先看到空页面再整页跳变；2026-10 全站统一过一次）。`Spinner` 只剩三种场合 ——
  按钮内联（`Button loading`）、`.pickerOverlay` 这类**读取遮罩**、以及
  **已有内容之上的局部刷新/轮询**（骨架会把已读内容清空，反而更差）。

- `Collapse` / `ViewSwitch`（`common/Motion.tsx`）：**内容出现/消失**的两个动效原语。
  - `Collapse`（折叠容器）：`grid-template-rows` 0fr ⇄ 1fr + 内层 `overflow: hidden`，
    展开/收起**两端**都有高度动画（`height: auto` 不可插值；`{open && …}` 只能做出现一侧）。
    硬约定：内容**始终挂载**（收起时有高度可插值才谈得上动画），收起态靠
    `visibility: hidden`（延迟到高度动画结束）退出 tab 序与绘制；容器 `id` 恒存在，
    触发器的 `aria-controls` 不再写 `open ? id : undefined`。
    代价：收起后内部 DOM 仍常驻（ContentPicker 单元行上限 1000 行、`RestorePlanView` 的
    diff 面板同理）—— 这是本仓库明确接受的取舍，换来两端都有动画。
    当前调用点：ContentPicker 的分区级与分组级、RestorePlanView 的「无动作」分组与行 diff。
  - `ViewSwitch`（视图切换入场）：带 `key` 的包装层，key 变化 = 重建节点 = 入场动画重放。
    **只用于「分支渲染不同组件」的视图级切换**（备份页 4 个子视图）。
    包装层透传纵向 flex 填充链（`.viewEnter` 自带 `flex: 1 1 auto` + column），
    否则子视图的 `flex: 1` 会失效、页面底部重新出现空洞。
    反例（禁用）：包住带 `useState` 的容器（如导入向导体）—— key 变化会把本地态归零（§9 #15）。

- `FoldToggle`（`common/ui.tsx`）：**卡头行尾的折叠开关**（图标按钮 + `ExpandChevron` 形变，
  2026-10-12 维护与诊断瘦身时抽出）。与 `Collapse` 成对使用：调用方自持 `open` 状态并用 `Collapse`
  包住正文，本原语只管触发器（`aria-expanded` + `aria-controls`，`aria-label`/`title` 取展开与收起
  两个方向的已翻译文案）。形态与 `ContentPicker` 分区行、`SyncChannelEntryCard` 完全一致。
  **摆放判据**：折叠只收**说明与明细**；卡头必须留下「收起后仍读得懂的摘要」——
  状态徽章、计数与主操作（含危险操作按钮）一律留在标题行，绝不藏进折叠体。
  **边界**：§7 KEEP 的 8 类文案（尤其安全与不可逆操作告警）不得只活在折叠体里 ——
  首屏看不到等于藏起来（救援模式卡即按此：危险按钮与机制说明在标题行下方常驻，
  折叠体只收「已开启时的生效状态」明细，且无明细时连开关都不渲染）。
  **不适用**：需要「收起即卸载」的内容（`Collapse` 契约是始终挂载，收起也要有高度可插值）；
  **固定高度 + 内滚视口**的卡（`.diskUsageCard` / `.fillCard` / `.fillViewport` 一类）——
  折叠容器是 flex 项、其自动最小尺寸 = 内容高度，会把卡盒撑破并把内滚容器从高度链里摘出去。

### 第三方原语（2026-09 Visual Polish 引入，按 `DEVELOPERS.md` 「第三方 UI 库准入」评估落地）
仅引入**无样式/行为级**原语，视觉仍 100% 走 `--dsw-*` token + 本文件规范，不引入第二套视觉体系：
- **图标 = lucide-react**（`common/Icon.tsx`）：取代散落文本符号图标（跨平台字形/基线漂移）。
  统一尺寸（默认 14px）/ 描边（1.75）/ `currentColor` 继承父级语义色。
  **体积纪律**：从各图标独立模块路径 `lucide-react/dist/esm/icons/<name>.mjs` 导入
  （非桶导出），保证 rolldown 在 cjs 单文件打包下精确 tree-shake（~18 图标仅 +12KB raw）；
  深路径无类型，由 `src/client/lucide-icons.d.ts` 全局 ambient 声明兜底
  （该文件刻意不含顶层 import，保持全局脚本态，否则 `declare module` 退化为 augmentation 而部分失效）。
  新增图标须同步登记 `Icon.tsx` 映射表 + `lucide-icons.d.ts`。
- **图标形变 = morphicons**（`common/Icon.tsx` 的 `ExpandChevron` / `CopyStateIcon` + `common/morph-icons.ts`）：
  MIT、零运行时依赖。它**不提供图标**，而是让状态切换时两个 stroke 图标做物理形变
  （2D Procrustes + 极坐标插值，旋转自动涌现）。体积：raw ≈ +40KB / gzip ≈ +13KB（**未压缩产物口径**；
  minified 约 8KB gzip —— 本仓库 bundle 不 minify，故按前者记账）。
  **收录判据（唯一判据，不得放宽）**：该 DOM 节点的图标会**随用户可见的状态变化而改变**，
  且形变让「状态变了」这件事被看见。**不满足判据的一律不套形变** —— 静态图标套形变是**纯亏**：
  要多打一份 vanilla `lucide` 数据，却永远不触发形变（§9 反模式 #13）。

  **当前全部落点（两对图标；折叠展开/收起 8 处 + 复制 2 处）**：
  ① **折叠展开/收起 chevron**（同一对 chevron-right ↔ chevron-down）：`ContentPicker` 分区行 + 分组行、
  `RestorePlanView` 分组头（无动作分组，默认折叠）+ 行内差异展开、`ArtifactRow` 产物行、
  `SyncChannelEntryCard` 通道卡、`ChatEntryView` 聊天内回退入口，以及 `FoldToggle`（`common/ui.tsx`；
  调用点 = 磁盘占用 / 会话体检 / 救援模式 / 工作区 + 会话回滚）。实测 θ 恒为 90°、lnSigma = 0。
  `RestorePlanView` 两处此前是**手写文本符号 ▸/▾**（§9 反模式 #9 的最后残留），已一并收归形变层。
  ② **复制 → 已复制**（2 处：`OverviewPanel` 的备份目录行与活动行，经 `common/CopyButton.tsx`）：
  空闲 copy ↔ 已复制 copy-check。

  **⚠ 复制对是特制几何，别「简化」它**：自然的 `copy`(2 条子路径) → `copy-check`(3 条) 是**拓扑不匹配** ——
  morphicons 只能把一条已有子路径复用给新对勾，实测那条要缩到 **0.20 倍**并转 **−159°**（`lnSigma = −1.62`、
  `res = 0.66`，对照 chevron 是 0/0），中途是一团乱线；整个 lucide「A + 对勾」家族同理（clipboard-check
  ×0.50、file-check ×0.72、square-check ×0.20，全部实测否决）。因此 `MORPH_ICONS.copy` 用的是
  `copy-check` 的结构 + 一个**退化的「隐藏对勾」**（绕 (8,15) 缩到 4%，落进矩形左边框的描边带里，
  被 round cap 的圆点吞掉 → 空闲态与 lucide `copy` 视觉一致）。拓扑 3↔3 后：矩形与后板 `lnSigma = 0`、
  `res = 0`（纹丝不动），对勾 `lnSigma = 3.22`、`res = 0`（纯生长、零旋转）。
  实测依据与三条断言见 `common/morph-icons.ts` 的 `HIDDEN_CHECK_D` 与 `morph-icons.test.ts`。

  **明确不适用（两类，别硬套）**：
  ① 无状态切换的语义图标（导航、删除、下载、信息…）—— 见上「纯亏」；
  ② `Spinner ↔ 图标` 的切换（`ExportView` 的「加载中 ↔ 预览」、`OverviewPanel` 的「备份中 ↔ 备份」）——
  MorphIcon 只做 **IconNode → IconNode** 的形变，跨组件（旋转环 ↔ 图形）不支持，且把环变成眼睛语义上也不对；
  这类用「条件渲染」+ 各自的静止态即可。

  新增一处形变的配方（两步 + 一步验证）：① 图标对若不在 `MORPH_ICONS` 里，先在 `common/morph-icons.ts` 登记
  （vanilla `lucide` 深路径 + `lucide-icons.d.ts` 补声明）；② 在 `common/Icon.tsx` 加一个**语义命名**的出口
  （如 `ExpandChevron`），不要在调用点裸传图标名 —— 语义出口才能让「为什么这里用形变」留在代码里；
  ③ 用 `morph-icons.test.ts` 的纯核心断言这对图标形变成立（能建出计划、端点落在两个图标上）。
  两条硬约定：`reducedMotion="user"`（morphicons 缺省 `"never"` = **无视**系统减弱动效设置，
  必须显式覆盖）、`spring={MORPH_SPRING}`（临界阻尼 ζ=1.0 **无过冲**，刚度 k=420 ≈ **1.6 倍速**；
  不用 morphicons 的 `smooth`（太慢）也不用 `snappy`（ζ=0.73 有回弹）；参数与理由见
  `common/morph-icons.ts`，由 `morph-icons.test.ts` 断言 ζ≈1 且 170 < k ≤ 700）。
  数据走 vanilla `lucide` 深路径（`lucide/dist/esm/icons/<name>.mjs`，导出的是 IconNode **数据**而非组件，
  因为 `MorphIcon` 只吃数据）；`lucide` 与 `lucide-react` **必须同版本**，否则静态/形变两套图形
  （`morph-icons.test.ts` 断言相等）；深路径类型同样由 `lucide-icons.d.ts` 兜底。
- **弹窗 = @radix-ui/react-dialog**（`common/Modal.tsx`）：统一原先两套弹窗
  （ConfirmDialog 手写 focus trap + 各页内联 `dialogMask` 无 trap）为一套，获得成熟
  focus trap / Esc / 初始焦点与关闭后焦点还原 / body 滚动锁 / Portal 渲染。
  `Modal`（容器，`open/onClose/title/wide/busy/cardStyle/onOpenAutoFocus`）+
  `Modal.Header`（标题行 + 可选关闭按钮 + trailing）/ `Modal.Body`（`scroll/innerRef/onScroll/style`）/
  `Modal.Footer`。Radix Content 用 `.dialogContentCenter` 自居中（Portal 下与 Overlay 平级）；
  旧 `.dialogMask/.dialogCard` 类保留供未迁移弹窗兼容。busy 时守卫 `onOpenChange` +
  `onEscapeKeyDown/onPointerDownOutside/onInteractOutside` 双保险禁闭。
  **已迁移（全部弹窗）**：ConfirmDialog、Profiles 切换预览、Market 条目详情、MyConfigs 上传向导 + 装回本地、
  Snapshots 恢复计划预览 + 备份查看、ReleaseNotes、关于页 `PluginUpdateDialog`（新版本 → 立即更新，2026-10）、
  **SyncSettingsView 全部 5 个弹窗**（通道配置 / 推送预览 /
  推送结果 / 拉取差异 / 一键同步确认 —— 实测为同级独立弹窗而非嵌套，逐个迁为 `<Modal>`，自定义宽度走
  `cardStyle`、限高走 `Modal.Body style`；通道配置弹窗的刷新快照按钮 `🔄` 亦改 Lucide `RefreshIcon`）。
  迁移后全仓再无手写 `dialogMask+dialogCard` 弹窗（`grep css.dialogMask` 仅余注释）。
  **Release 正文渲染是共享原语**（`src/client/about/ReleaseBody.tsx`）：ReleaseNotes 与新版本弹窗共用同一份
  纯文本 Markdown 分块 + 行内格式渲染（零 `dangerouslySetInnerHTML`），**不得各自实现一份**。
- **构建接线**：`tsdown.config.ts` 的 `deps.alwaysBundle: [/^lucide-react(\/.*)?$/, /^@radix-ui\//]`
  强制把二者打进单文件 cjs（否则被当 dependencies 外部化 → 运行时 `require` 命中 DSH loader
  「module table miss」崩溃）。注意 tsdown 0.22 读 `deps.alwaysBundle`，旧的顶层 `noExternal`
  从 config 根读取、放在 `deps` 内会被静默忽略。bundle 增量约 +136KB raw / +30KB gzip。
- **依赖归类**：二者已被内联进 `lib/client.js`，因此是**构建期依赖** → 放 `devDependencies`
  （放 `dependencies` 会迫使只想复用引擎的 headless 消费者安装整套 React UI 栈）。
  这条不变量由 `src/client/bundle-selfcontained.test.ts` 钉死（build 后跑）；消费方式见
  `docs/spec/headless-consumption.md`。

### 数据展示
- **数据表**：`.tableWrap > .tableScroll > .dataTable`；变体 `.tableFixed`（固定布局 +
  th 显式宽度 + 内容 ellipsis）、`.tableCompact`（padding 8px）。行 hover 高亮、
  `data-selected` 选中淡底、数字列 `.num` 右对齐等宽、次级列 `.dim`。
  - **操作列**（`.cellActions`）：`overflow: visible; text-overflow: clip` 覆盖 `.tableFixed`
    给所有单元格加的省略号 —— 该列是按钮组，列宽略紧时浏览器会在按钮后补一个「…」
    （备份页两张表都出现过）。宁可略微溢出也不截断；并给 `.tableFixed` 单元格左右各留 12px。
- **磁盘占用卡**（备份页 → 备份文件子页，2026-09）：`.dataTable + .tableFixed + .tableCompact`（列 = 内容 /
  占用 / 文件数 / 回收策略）+ 下方 `.actionRow[data-inline]` 的「立即清理」行。三条约定：
  - **三档回收语义必须显式表达**：`可随时重建`（`Badge kind="ok"`，缓存/暂存）、`{保留期} 后自动回收`
    （`Badge kind="info"`，导出产物/定时备份）、`用户数据 / 安全网（不自动清理）`（`.dim` 文本，快照/同步）。
    可重建区**不显示保留期**（随时可清，给一个「7 天后自动回收」会误导）；到期的量另起一行
    `.cellMetaNoteText`（`其中 X 已到回收条件`）。
  - **未统计 ≠ 0 字节**：子区目录读不到时体积与文件数都留空并显示 `未统计`（`.dim`），顶部补一条
    「部分目录读不到，合计不含它们」—— 显示 0 会让用户以为盘是空的。
  - **数字同源**：卡里的合计、可回收量、按钮上的数字全部由**渲染出来的行现算**
    （`src/ui/disk-usage-view.ts`），不直接用接口的聚合字段；否则宿主聚合与明细一旦漂移，
    用户会按「可释放 600 B」点下去却只释放 0。清理是写操作：只清可重建区，导出产物必须显式勾选
    （`Checkbox`）且确认框转 `danger`；**快照与同步数据永不在候选集内**。
- **状态条**（Overview）：`.statStrip`（健康点 + 可点指标段，名词在前值加粗）。**单行 32px**；**必须带 `flex: none`** —— 它是页头行，绝不参与纵向收缩（`.viewBody` 是 column flex 容器，默认 `flex-shrink:1` 会把它压回 32px，折行的第二行就溢出到工具栏底下被按钮盖住；2026-10-08 真机两轮回归）。放不下时**折行**（不隐藏、不横向滚动）：折行靠 `row-gap: 6px` + 段内 `padding: 4px 8px` 保证两行不贴边框。
  **中英文都必须按 564px 画布实测收窄**：健康段 + 4 个指标段合计须 ≤ 527px（现测 en 441px / zh 491px；英文直译 688px、中文原文配 12px 内边距 547px ⇒ 都会折行）。复核口径：用 Segoe UI / Microsoft YaHei 11/12px 量文本宽度（与截图像素实测误差 2%）。
- **事实网格**：`.factGrid/.factCell/.factLabel/.factValue`（四列 label/value）。
- **键值行** `.kvRow`、**分区构成** `.sectionGrid/.sectionRow`（共享组件
  `common/SectionComposition.tsx`，总览卡的「分区构成」与**导出页的「本次将导出」数据块**共用；
  列用 `repeat(auto-fit, minmax(210px, 1fr))` 以便窄容器自动退化为单列）。
  组件带可选 `sectionLabel`（`SectionId → 文案`）：**用户可见场合一律传
  `sectionLabeler(t)`**（见 §7「分区显示名」），只有给开发者看的场合才允许省略。
  （旧文档里的「导出预览弹窗」已不存在，导出侧改由内容选择器 + 页内合计块承担。）
- **可点列表行 + 行内按钮**（通则，2026-09）：整张行是「打开详情」的点击目标（hover 描边），
  **但容器本身不加 `role="button"`/`tabIndex`** —— 里面还有删除等按钮，`role=button` 套 `button`
  是非法嵌套，且会与全局焦点环规则（`.section :is(button, a, …)`）打架。键盘/读屏走行内那颗
  `IconButton`（如 `InfoIcon`），同排按钮一律 `stopPropagation`。
  需要「整行可点 + 行内还有按钮」时照此办理，禁止给容器加 `role=button`。
  （原用例 = 灾备页快照卡；灾备页已于 2026-09 收敛下线，通则保留。）
- **只读详情弹窗**：`.kvRow/.kvKey/.kvValue` 是「只读键值行」的固定搭配（档案详情仍在使用），
  底部只放关闭（`Modal.Footer`），**不在详情里制造第二条执行通道**。
  （原灾备页「快照详情 · 分区明细」的 `.detailSectionList/.detailSectionRow/.detailSectionName`
  已随该页面删除。）
- **导出报告的分区清单**（2026-09 优化）：`.reportBody`（padding 8/12 + 纵向 flex，块间距
  由子块 `.groupLabel` 的 8px 下边距承担）+ 共享的 `.sectionGrid/.sectionRow`。
  **不再把 `renderExportReport` 的整块等宽文本直接铺在面板里** —— 那段文本的分区名是适配器 id、
  计数单位是英文键（namespaces/patchLines），与界面上别处的中文分区名自相矛盾。现在：
  分区名走 `sectionLabel`（`sectionLabeler(t)`），计数单位走 `report.unit.*` 字典
  （`exportCountsText`，未知键原样回退）。首行状态「备份已创建」用 `.reportHeadline` 保留
  （比区块标题高一级；结构化不能凭空丢掉这条状态）。`renderExportReport` 保留给非 UI 场合
  （文本报告 / `run-store` 记录），两者不是替代关系。
- **报告 / 错误文本块**（`ReportView`/`ErrorBanner`/`ErrorList`）：纯文本用 `<pre>` 呈现时
  **必须**同时给 `white-space: pre-wrap` + `overflow-wrap: anywhere`，并置于
  `.reportScroll`（限高 380px，与 `planScroll` 同规则）之内；报告卡内的该容器由
  `.reportView .reportScroll` 去掉自带描边/圆角/底色（否则与卡片边框贴合成双线）。`<pre>` 的 UA 默认
  `white-space: pre` 会让长行（导入失败原因 / 回滚项 / 警告文本）横向溢出，再被卡片
  `overflow: hidden` 直接裁掉 —— 用户既看不到内容也滚不过去；且 `.errorLine` 上只写
  `overflow-wrap` 落在 `<pre>` 上是**无效声明**（换行未获允许）。
  同类已修点：`.cliCommand`（导入日志里的命令行，F-05）与 `SyncConfirmView` 的变更明细
  （原 `<pre className={css.conflictDetail}>`，现为普通块元素）。`.diffScroll` 例外 ——
  它是 diff 视图、容器自带横向滚动（内容不会被裁），保留 `<pre>` 对齐语义。
- **内容选择器**（ContentPicker，2026-09 Phase 1 条目级导出选择）：共享组件
  `common/ContentPicker.tsx` + 纯逻辑 `src/ui/selection-model.ts`（**全部选择语义在后者**，
  React 侧只装配，node 可测）。
  - 结构：`.pickerRoot`（纵向 flex）→ `.pickerToolbar`（搜索 + 全选/全不选）→
    `.pickerList`（**限高内滚**，与 `planScroll/reportScroll` 同规则，禁止把弹窗撑长）→
    `.pickerFooter`（实时合计）。类清单（全部登记于此，勿在别处另起）：
    `.pickerRoot / .pickerToolbar / .pickerList / .pickerGroup / .pickerRow / .pickerTreeRow /
    .pickerUnit / .pickerUnitName / .pickerUnitDetail / .pickerCount / .pickerMore / .pickerFooter /
    .pickerOverlay / .pickerChevronSpacer / .pickerSubgroup / .pickerSubgroupName / .pickerUnitNested`。
    其中 `.pickerTreeRow` = 级联树行（左侧固定宽度 chevron + 可伸缩勾选框；与 `.pickerRow` 的唯一区别
    是首子节点不可伸缩），`.pickerChevronSpacer` = 无子节点行/子单元行用来对齐树左缘的等宽占位。
    其中 `.pickerOverlay` = 大分区清单读取中的半透明遮罩 + 加载动画（列表仍可见但不可点，
    避免「读 sessions 很久」被当成卡死）；`.pickerUnitDetail` = 单元副标题
    （`max-width: 220px` + 省略号，与 `.pickerUnitName` 的 280px 分工：副标题更弱、更短）；
    `.pickerCount` = 「已选 n/m」「N 个文件」这类计数（`font-variant-numeric: tabular-nums`）。
  - 两级树：`.pickerTreeRow`（分区行；三态用「部分」徽章 + `已选 n/m` 表达 ——
    `Checkbox` 只支持二态，**不为三态改造共享原语**）；`.pickerUnit`（单元行，左缩进 18px 表示从属）。
  - **捆绑（lockedWith）**：必须与同组条目同进同出的项显示 `捆绑` 徽章（warn）+ tooltip
    （如 pnpm-workspace ↔ patch 文件，见 issue #35 与 `src/adapters/units.ts`）。
  - **不可细分分区**（`units: []`）不渲染展开按钮，自然退化为整体开关 —— 不写第二套分支。
  - **分区行三态（UI-07）**：`读取中…`（在途）/ `读取失败 · 将整体导出`（该分区清单没拿到，
    引擎按整体导出处理）/ `已选 n/m`。**没读到清单时绝不显示 0/0** —— 那会被读成「这一项没有内容」。
    失败分区逐分区记账（`failedSections: SectionId[]`，不是一个数字），顶部复用
    `picker.unitsUnavailable` 提示；`failedSections` 缺省为空数组。判定**不写在 React 壳里**：宿主
    `/export-preview` 除既有 `sectionsFailed`（计数，必填）外还回精确 id 列表 `failedSections?: SectionId[]`
    （可选字段，旧宿主缺失即回退）；客户端由 API 层 `resolveFailedSections(requested, response)`
    （`src/client/api.ts`，node 可测）把「宿主点名」与「请求了但没回来」的推断取并集（推断复用
    `src/ui/export-flow.ts` 的 `failedSectionsFromResponse`），保持 `requested` 顺序并忽略本次请求之外的 id。
  - **勾选态的唯一口径（2026-09 用户实测：点「全不选」后子项仍然打勾）**：稀疏表示下「不在 `excluded`
    里」只等于「没有显式排除」，**分区整体没勾时同样成立** —— 所以渲染层一律走
    `unitChecked(sel, section, unitId)`（先看分区、再看排除集），分组的三态与计数同口径
    （`groupPickState` / `groupSelectedCount` 必须传所属分区）。直接在组件里写
    `!sel.excluded.includes(u.id)` 会渲染出「分区 已选 0/13、13 个子项却全部打勾」的自相矛盾
    （`src/ui/selection-model.test.ts` 有专门回归）。
  - **设备相关 / 敏感徽章（UI-09）**：`SelectionSection.portability === 'deviceSpecific'` 渲染
    `设备相关` 徽章、`sensitive === true` 渲染 `敏感` 徽章（均 `Badge kind="warn"`）。
    勾选含设备相关分区时，调用方在页内与弹窗内就地渲染 `export.selectionWarnings` 提示
    （**非阻断**）：一键「全选」不得静默把 sessions / pluginFiles / credentialsStatus 勾上。
    portability 来自调用方的分类目录（导出侧 `ExportFlow.categories`）；来源未知时留空 = 不猜、不渲染徽章。
  - **大列表实测（2026-09，真实会话库）**：sessions 为 **631 个单元 / 369.6 MB**，
    整列表在 `.pickerList` 内滚动渲染正常（弹窗不撑长）。
  - **渐进披露（UI-15；2026-09 按用户反馈调整上限）**：`.pickerMore`（居中，「显示全部（共 N 条）」
    按钮，`picker.showAll`）仍在，但 `UNIT_RENDER_LIMIT` 由 **100 提到 1000** —— 真实会话库是
    660 个单元，100 的上限让用户展开后只看到前 100 条，被读成「只有这些 / 只选了这些」，
    必须再点一次才敢确认（用户实测反馈）。现在真实规模**展开即全量**，折叠只在异常大的分区上兜底。
    纯前端方案，**不引入第三方虚拟列表**（AGENTS.md 默认禁止新增第三方 UI 库）；判定下沉为纯函数
    `visibleUnits(units, showAll, limit)`（`src/ui/selection-model.ts`，node 可测）。
    单元数**上万**时再谈虚拟化（届时按 `DEVELOPERS.md` 的「第三方 UI 库准入」7 步流程评估）。
  - **二级分组 + 级联树（2026-09，两轮用户要求：先「按工作区分类」、再「级联展开 + 展开控件放左边」）**：
    `.pickerSubgroup` = 分组标题行（左缩进 18px；标题 `.pickerSubgroupName` 11.5px/600/secondary，
    同行带组内 `已选 n/m` 与「部分」徽章，整组可一键勾选/取消）+ `.pickerUnitNested` = 组内单元
    （勾选框与父分组勾选框同一左缘，标签与父标签对齐 —— 树形层级靠 chevron 与标签缩进表达）。
    **展开控件是左侧的 chevron 图标**（`.iconBtn[data-size="sm"]` 18px + `Icon` 的
    `chevronRight`/`chevronDown`，14px）：右对齐的文字按钮已全部取消（用户明确要求），
    `aria-expanded` / `aria-controls` / `aria-label` / `title` 一个不少（图标按钮必须有可访问名）。
    **级联语义（默认全部折叠）**：展开分区只列出工作区分组；点某个分组的 chevron **只展开这一棵子树**，
    不会一次铺开全部分组。折叠**只影响渲染**：收起的工作区里已勾选的会话保持勾选，
    分组行的勾选框在折叠状态下照常可整组选/取消（不必先展开）。
    约束与语义：① 分组名（工作区标题）与单元名同为**宿主直出字符串**，渲染前必须过 `redact()`；
    ② 分组**只影响展示**，勾选/导出契约仍只认单元 id，`ExportUnit.group` 缺省 = 平铺（skills /
    pluginFiles / self 等分区的渲染零变化）；③ 点一个分组 = **只勾这一组** —— 稀疏表示下
    `toggleUnitGroup` 必须在分区未勾选时把其余单元**显式排除**，否则「勾一个工作区」会静默变成
    「该分区全选」（`src/ui/selection-model.test.ts` 有专门回归）。
  - **分区组标题（2026-10）**：`.pickerGroupTitle` = 只在**分组变化处**插一行的组标题
    （`.pickerGroupTitleName` 11px/600/secondary、字距 0.02em、非首组带 1px 分隔线），与
    `CommandPalette` 的分组标题同一口径：**它不是选项**（更小更淡、不可选中，用 `span` 而不是
    `Checkbox`），否则会被读成「灰掉的选项」。标题顺序 = 调用方给的节点顺序（宿主目录已按
    `EXPORT_GROUPS` 排好，UI **不重排**；`SelectionSection.group` 缺省 = 不渲染标题，
    导入向导 / 市场通道零变化）。
  - **「插件与扩展」组内嵌的插件树（2026-10；同日按用户反馈从「视图切换 tab」改为内嵌）**：
    这一组里的四个插件分区（plugins / pluginFiles / pluginData / pluginAssets）合并成**一棵按插件
    分组的树**，只在其中**第一个出现**的分区处渲染一次（其余成员就地跳过）—— 顺序仍由调用方给的
    节点顺序决定，不引入第二个排序来源；`self`（配置管理器设置）**不在**那四项里，照旧按普通分区行
    渲染。**没有视图切换控件**（用户明确要求移除「按分区 / 按插件」的 tab）：树就是这一组的渲染方式，
    不引入第二个视图状态。搜索把树过滤空时**回落完整树** —— 分区名命中（如搜「插件数据目录」）应当
    仍能看到这一组，否则组标题下面会出现一句自相矛盾的「没有匹配」。
    树仍是**纯展示**：叶子是原来的单元 id，勾选仍走 `toggleUnit` / `toggleSection`；
    `PLUGIN_TREE_SECTIONS` / `isPluginTreeSection` / `pluginTree` / `filterPluginTree` /
    `pluginEntryPickState` / `togglePluginEntry` 住在 `src/ui/selection-model.ts`（node 可测）。
    **入口是一个「插件」区块（2026-10 同日按用户要求补）**：全部插件收在这一行下面，**默认折叠**
    （展开才列出插件；搜索时**自动展开**，否则结果会藏在折叠节点里看起来像「没有匹配」）。
    它的勾选框 = 所有插件名下**存在的**单元（逐个 `toggleUnit`），**不含**两个桶 ——
    桶里是「没人认领的东西」，不该被「全选所有插件」顺手带上。
    **计数与三态的分母用「已知」叶子**（存在 + 还没读到的区域声明，`pluginEntryTotalCount` /
    `pluginTreeTotalCount`）：否则折叠时 1/1、展开（触发了读取）后变 1/3 —— 用户看到的是「数字自己变了」
    （2026-10-17 实测反馈）。`absent`（注册表说有、盘上没有）不进分母，它永远不可勾。
    **勾选会补齐**：清单是惰性的，勾一级区块/插件时它名下可能还有区域没读到 —— 此刻先勾已知的、
    把没到齐的键入队（`applyPluginPendingChecks`），清单到货后自动补勾并出队；绝不「假装全选」。
    取消勾选会把队列里对应的请求一并撤掉（否则到货后又把它勾回来）。
    **桶只有两个**（都在「插件」区块之外、组内同级渲染）：插件分区的其他条目（补丁行 /
    pnpm-workspace.yaml）与 pluginFiles（无归属配置）。**桶有普通分区行同款的三态勾选框**
    （`toggleSection`，2026-10-17 用户要求补）+ 设备相关徽章 —— 整块带走/整块不带不必先展开逐条勾。**「未安装插件的遗留数据」不再单列**
    （用户 2026-10-17 明确要求：不需要看到）——那些单元仍会随该分区整体勾选导出，只是不占一行。
    **不给「读取该分区」按钮**（用户明确要求移除）：**展开就是读取入口**，与其他分区行同一套惰性
    语义；插件清单自己没读到时，展开「插件」区块也会触发读取（`pluginTreeUnreadSections`）。
    **四条语义**：
    ① 插件节点 = `plugin:<包名>` 单元 + 它**声明的**数据区域（宿主下发的 `relatedAreas`，
    静态知识、零数据目录 I/O）；② **不猜归属** —— pluginFiles（白名单文件 + `plugin-config/`）
    没有任何包名信息，整块进「未归属」桶；
    ③ 「注册表说它在哪儿」与「磁盘上真有」分开渲染：分区清单没读到 = `未读取`（不可勾，展开时才读），
    读到却没有该单元 = `无内容`（不可勾）—— 绝不产生幽灵勾选（引擎只带走清单里真实存在的单元）；
    ④ 树节点标签是宿主直出文本（包名 / home 相对路径），渲染前同样过 `redact()`，文案按 `kind` 映射字典键。
  - **树的层级必须「看得出来」（2026-10-17，两轮用户实测）**：只靠缩进不够 ——「未归属到插件的配置」
  下面的 `pet.json` 会被读成同级；而**只给叶子行加缩进也不够** —— 中间层（「插件」→ 某个插件 →
  它的数据目录）会没有竖线也没有缩进，只要有中间层层级就又看不出来。
  定案 = **容器式逐层缩进**：每个 `<Collapse>` 的内容外面包一层 `.pickerChildren`
  （`margin-left: 8px; padding-left: 4px; border-left: 1px solid var(--dsw-alias-border-l1)`），
  层级因此**逐层累加**：父行勾选框 22px → 子层 35px → 孙层 48px（**每层只推进 13px**），
  每层都有自己的竖线，竖线落在父行 chevron 的中线下。`.pickerUnitNested` 只保留 `gap: 4px`（左缘由容器给），
  **分区下的单元行也走这套子行样式** —— 原先用 `.pickerUnit` 的 16px 内缩、比父级勾选框（22px）
  还靠左，正是「看起来平级」的根因之一。
  **间距的第二轮定案（同日）**：第一版 padding-left 14px（每层 23px）被用户判为「子项离父项太远」——
  层级感由**竖线**承担，**不靠大间距**；间距只用 8 / 4 两档（`css-scale-guard` 只放行 §4 的节奏档）。
  **新增任何一层嵌套，必须把该层的 Collapse 内容包进 `.pickerChildren`**，否则那一层会「断开」。
- **单元行排版（UI-16）**：`.pickerUnitName` = 中段省略 + `title` 全文（`tailWeightedEllipsis(label, 44)`，
    保留尾部时间戳/版本等区分信息，见 §9 anti-pattern 5）+ `min-width:0 / max-width:280px /
    text-overflow: ellipsis` 兜底 —— 长路径/长会话标题不得撑宽列表产生横向滚动条。
    `.pickerUnitName` 的完整值进 `title`（值是脱敏后的）；`.pickerUnitDetail`（副标题）**只做 CSS 省略、不进 `title`**
    —— 两者分工不同，不要按「都进 title」理解。
  - **无障碍（UI-22）**：展开/收起是原生 `<button>`（复用 `.ghostButton[data-size="sm"]` 样式，
    共享 `Button` 原语不透传额外属性），带 `aria-expanded={open}` + `aria-controls`（指向单元列表容器
    `picker-units-<section>`）。
  - 与 **分区构成** 的分工：那个只读展示、这个可勾选，**禁止合并**。
  - **公告位恒定高度（2026-09，用户实测抖动后确立）**：提示类 Banner **不得**以「条件渲染」的方式直接插进内容流 —— 出现/消失会改变内容高度，垂直居中的弹窗与页面会跳。做法：把互斥的提示合并进同一个 `.noticeSlot`（`min-height` ≥ 单行 banner 盒高，并抵消 banner 自带 `margin`），提示文本用 `.noticeLine` 单行截断（完整文案放 `title`）。**底线：内容一旦会换行，不抖动的保证即失效。**
  - **三处复用同一个组件**（Phase 2 起导出/导入，2026-09 起含市场）：导出页（`mode="export"`，带体积）、
    导入向导 preview 步与**市场条目导入审阅**（均 `mode="import"`，**计划项没有体积，因此不渲染体积、
    也不要编一个数字**）。导入侧的单元由 `PlanItem.unitId`（适配器声明）归并 —— 与导出的 `listUnits()`
    同一套规则。**市场通道与导入页共用同一套选择语义**（默认全选、「全选」含高风险分区），
    差异只由调用方传入的 `highRisk` 回调表达（下一个要点）。
  - **高风险徽章（`highRisk?: (id: SectionId) => boolean`，2026-09 市场通道）**：命中时在分区行渲染
    `高风险` 徽章（`Badge kind="warn"`，`picker.highRisk`，tooltip 为 `picker.highRiskHint`）。
    **缺省不传 = 导出页/导入页零变化**（那两个调用点的分区风险由 portability/sensitive 表达，
    且没有「条目来自公共仓库」这层语义）。徽章**只是标记**：三态、全选、原子组联动仍全部由
    `selection-model.ts` 决定，**不得**在组件里为它写第二套勾选规则。
  - **单元级徽章（`unitBadge?: (section, unitId) => ReactNode`，2026-09 市场通道）**：渲染在单元行
    名称之后（市场传入「将改动 / 已一致 / 不导入」）。为什么开这个口子：市场审阅要在**树上**表达
    「这一项会不会写盘」；没有它，调用方只能在树旁边再铺一份逐项列表 —— 同一批条目渲染两遍正是
    「61 行挤爆弹窗」的根因。**缺省不传 = 导出页/导入页零变化**；文案与语义全部由调用方决定，
    组件不猜、也不为它推导任何勾选状态。
- **回滚点时间线**（环境 → 维护与诊断 → 「工作区 + 会话回滚」卡上的「查看回滚点」，2026-10-11 重排、2026-10-12 台账整块搬进弹窗；用户反馈「UI 太丑」+「要能一眼看到有回滚点的对话」）：
  卡内 = `.rollbackToolbar`（`.rollbackSummary` 数字摘要「共 N 个回滚点 · M 个会话」+ 主操作「查看回滚点」）；
  **卡不再折叠**（摘要与入口常驻可见）。台账本体在 `Modal`（`rollback.dialog.title` = 「回滚点台账」，`{open && …}` 条件挂载）里：
  弹窗标题行（`Modal.Header` 的 `trailing` = `.shHeaderTrailing` 内的留存口径 ⓘ + 刷新）→ `.rollbackToolbar`（同一份数字摘要）
  → **左右分栏**（2026-10-12 用户要求「左边是侧边栏、右边是列表」）：`.rollbackLedger`（**高度锁死 340px** —— 切换对话不得让弹窗高度变化，
  否则居中重排 = 整页抖动，用户同日第二条反馈）= `.rollbackSessions`（左栏：**拥有回滚点的对话**，
  `.rollbackSessionItem` 两行式 = `.rollbackSessionId` **优先显示对话标题**（拿不到才回落等宽会话 id）+ `.rollbackSessionMeta` 计数/最新时间；
  默认**新 → 旧**，顺序由 `rollbackPointGroups` 定死；选中态 `data-active` = 主色描边 + layer-2 底）+ `.rollbackLedgerMain`（右栏：选中那条对话的
  `.rollbackGroup` 组头 = `.rollbackGroupTitle` **优先显示标题** + 计数 `Badge` + `.rollbackGroupUnit` 右对齐省略的工作区路径 →
  `.rollbackPointsScroll`（`flex:1` + 自身内滚）内的 `.rollbackPoints`）→ `.rollbackPoint` 行卡。
  标题来源 = 宿主侧 `applySessionTitles`（与 `/recovery/sessions` **同一份**索引），三层依次兜底、**只增不改**：
  ① 聚合缓存 `storages/session_projcache.json` → ② **逐会话投影** `storages/session_projcache/sessions/<名>.json`（按需读、mtime 缓存）
  → ③ **会话日志的 `session/title` 事件**（`core/session-title.ts`：只读日志前缀 1 MiB、按 mtime+size 缓存、一次请求最多补 24 个会话）。
  三层都读不到就不带该字段，界面回落显示会话 id —— **绝不从首条消息编造标题**。
  硬约定两条：① 行卡是**两行式**（`.rollbackPointTop` = 回合号 + 来源/告警徽章 + 右对齐的 `.rollbackPointActions`；
  `.rollbackPointMeta` = 时间 / 文件数 / 会话游标 / `.rollbackPointNote`），左侧 2px 语义色条按 `data-kind` 区分来源
  （`auto` = `--cm-ok` / `guard` = `--cm-info` / `unknown` = `--cm-text-3`）；② **长句只进 `title`**，屏上只放短标签键
  （`rollback.kind.guardShort` / `rollback.row.sessionShort` / `rollback.row.workspaceShort` / `rollback.row.notice.skippedShort`…），
  完整句仍在原键里 —— 旧实现把整句逐行重复，正是「一坨灰字」的根因。
  行内危险动作（删除回滚点）用 `IconButton danger`（禁用原因进 `title`），不再常驻一颗 danger 文本按钮。
  执行者：`src/client/recovery/recovery-panel-layout.test.ts`（禁止退回 `.actionRow[data-inline]`；并钉住「两块诊断卡退出折叠 + 回滚台账在条件挂载的弹窗内」）。
- **聊天内「回退预览」弹窗**（每条用户消息气泡里的「↺ 回退」；2026-10-12 按 Cursor「Confirm Undo」对齐，用户七条要求；
  同日第二轮按用户「弹窗太丑」反馈做了列对齐 + 汇总 + 目录前缀）：
  版式自上而下 = **汇总选择行** `.previewChoiceRow`（左侧 `Checkbox` 原语 `chat.preview.revertFiles`「回退文件的更改」——
  勾 = `files+session`、取消 = `session`，工作区态没有可用记录时**禁用**；该行**右对齐**跟一条汇总 `.previewScope`）
  → 文件清单 `.rollbackFileList`（**平铺清单**：无容器描边、无圆角、**无底色**、无行间分隔线，
  清单感只由每行左侧 2px 语义色条承担；行内容与上方标题行**共用同一条左缘**（左内边距只留色条那一档）——
  2026-10-12 用户要求「移除列表的边框」，2026-10-13 追加「移除黑色背景色 + 调整与边框的间距」）
  → 底部 `.dialogFooter`（主按钮「回退」+「取消」，恒两颗）。
  ⚠️ 说明行 `.previewSummary` 已于 2026-10-12 **删除渲染**（DESIGN §7：只留能改变决定的信息），类名一并下线；
  源级守卫钉住「`chat.preview.summary` 不得回到对话框」。
  硬约定六条：
  ① 文件行 = 文件类型图标 · **目录（弱化 `.rollbackFileDir`）+ 基名（主色）** · **右对齐**的 ±行数 或「删除」：
     行是 `display: grid` 三列（`auto minmax(0,1fr) auto`），统计列 `justify-self: end` ⇒
     数字位数不同也不跳、纵向扫读成一列（第二轮修的就是「文件名长短不一把统计列挤得左右乱跳」）；
     完整路径仍进 `title`（信息不丢）；
  ② **整文件删除写「删除」**（`.rollbackDeleted` / `rollback.preview.file.deleted`），**不写 `+0 −N`** ——
     那是「把文件清空」的意思；数据源 = `preview.workspace.removals`（引擎 `planCreatedRemovals` 的产物，
     与**执行阶段同一个函数** ⇒ 预览列出的 = 实际删的；`leftovers` 含永不删除的拒删项，**不得**拿它当删除清单）；
  ③ 文件图标 `RollbackFileIcon`：装了 `dsh-better-sidebar` 用它的 `betterSidebar.fileIcon`，
     否则惰取 DSH 自带的 `FileTypeIcon`（`@deepseek-ai/dsh-client-ui-primitives`，DSH 文件树同一颗），
     两条都不通才用本地极简 SVG（`currentColor`）。**绝不在模块顶层 import 那个包**：老宿主没有模块表 seed 时
     顶层 require 会让整个浏览器半加载失败；
  ④ 「查看」= **路径那一格本身**（2026-10-12 用户要求：移除尾部独立按钮，**点文件名直接跳转**）。
     它是真 `<button>`（留在 tab 序、Enter/Space 可触发），无边框无内边距，悬停/聚焦把**整格**（目录段 + 基名）
     一起换成 `--cm-accent` —— 只让基名变蓝会看起来「只有一半能点」（2026-10-12 用户反馈）；
     静止态目录段仍保持弱化；
     **热区只覆盖名字与目录，不覆盖右侧 `+N −M`**（整行做热区会让鼠标停在统计上像是要点它）。
     删除行的文件名**不是**按钮（引擎的 file-diff 读不出该路径 ⇒ 不给假入口）；
     **打开成功即关闭弹窗**，侧栏不可用时降级为弹窗内展示同一份差异（两种原因两句话）；
  ⑤ 选择框关掉时**不再**把整份清单降透明度（旧 `.reasonList[data-off]` 已下线 —— 半透明清单会被读成
     「弹窗坏了」）：改成汇总条 `.previewScope[data-off='true']` 降为弱化色 + 改写一句
     `chat.preview.scope.off`「只回退对话，文件不改动」；清单本身保持满可读（行序/图标/路径不丢）。
  ⑥ **汇总** `.previewScope` = `{n} 个文件 · +A · −D · {n} 项删除`（`chat.preview.scope.*`，等宽数字、右对齐）：
     这一屏的**第一决策信息** —— 用户先判规模、再逐行核文件。三个数字与文件行**同一份口径**
     （`src/ui/rollback-view.ts` 的 `rollbackPreviewScope`）：行数只累加两侧都可信的（null 不计成 0）、
     删除集单独计数。语义色条 `.rollbackFileRow::before`（2px：create 绿 / overwrite 蓝 / delete 红）
     只在 `data-kind` 可判定时上色。
  执行者：`src/client/chat/rollback-entry-view.test.ts`（源级：恰好一颗选择框 / 统计块类 / 删除键 / 图标 / 打开成功关弹窗 /
  第二轮版式六条）+ `src/ui/rollback-view.test.ts`（`splitRollbackPath`、`rollbackPreviewScope` 的逐条口径）。
- **会话体检弹窗**（环境 → 维护与诊断 → 会话体检，2026-10-12 重排，同一条用户反馈「UI 太丑」）：
  弹窗标题行（`Modal.Header` 的 `trailing` = `.shHeaderTrailing` 内的说明 ⓘ + 主操作「开始体检 / 重新体检」）
  → `.shSummary`（`.shMetrics` 数字 tiles：会话总数 / 需要处理 / 会话格式 → `.shSeverities` 严重级 chips
  → `.shNotes` 数据口径：未深度校验 / 被隐藏的正常会话 / 超上限 / 读不出条目）
  → `.shSectionHead`（`.shSectionTitle` 13px 区块标题 + 计数 `Badge` + 右对齐主操作）
  → `.snapshotList`+`.reportScroll`+`.shScroll`（限高内滚）内的 `.shRow`。
  硬约定四条：① 行卡是**两行式**（`.shRowTop` = 严重级短标签 `Badge` + 等宽会话 id + 右对齐 `.shRowActions`；
  `.shRowMeta` = 问题 chip（最多 2 条 + 「还有 N 条」，全文进 `title`）+ `.shRowFacts` 版本/体积/时间），
  左侧 2px 语义色条按 `data-severity` 上色（`blocksStartup`/`unloadable` = `--cm-error`、
  `nextRequestFails`/`invisible` = `--cm-warn`）；② **长句只进 `title`**，屏上只放短标签键
  （`sessions.severityShort.*` / `sessions.issues.more` / `sessions.hidden.healthyShort`…），完整句仍在原键里；
  ③ 摘要 chips 与行徽章走**同一个短标签出口**（`sessionSeverityShortKey` 纯函数）—— 两处各判一次必然术语漂移；
  ④ 机制散文（布局归位的 3 段、应用内可修的完整说明、操作指引）进 ⓘ 或只在**真有动作可执行时**常驻，
  安全口径（运行时写入门 / 隔离目录不删会话 / 禁用原因）**一个字都不删**，只换承载位置。
  执行者：`src/client/recovery/session-dialog-mount.test.ts` 的 T15/T16。
- **Stepper**：紧凑圆点 17px + 连接线，只读指示器。
- **进度条**：`.progressTrack` 5px + 确定宽度过渡 / `.progressIndeterminate`。

### Shell 与 Overlays
- Shell：`.shellNav/.navStrip/.navTab/.navMore/.navActions/.shellContent/.shellMain/.pagePad/.statusBar`；
  **v3**：状态栏在执行期显示「任务名 + `.statusProgress` 不定态细条」（本层只有在跑/没跑的布尔，
  真实百分比住宿主 `/progress`；**绝不编造百分比**）；SAFE MODE 横幅槽位用 `.bannerSlot` 类
  （v2 的壳层内联 `style` 已删除）；语义 token 层定义在 `.section` 的 §1 TOKENS 块，由
  `css-token-guard.test.ts` 与 `css-scale-guard.test.ts` 钉住。
  `.shellMain` 与 `.pagePad` 构成纵向 flex 链，页面可伸展填充（`.fillCard/.fillViewport`）。
  - **导航容量（v2，取代 v1 的溢出遮罩）**：放不下就从**末项**开始移进「更多 ▾」，
    绝不把页签藏在视口外（v1 是隐藏滚动条 + 两侧渐隐遮罩，用户得按住 shift 才滚得动）。
    判定 = 纯函数 `navLayout(itemWidths, availWidth, moreWidth, gap) → { visible, overflow }`
    （`src/ui/nav-model.ts`，node 可测）；宽度由壳层用 `.navMeasure` 实测 —— 它是
    absolute + `visibility:hidden` 的**逐字节同构副本**（同一批 class、同一段文案），
    因为标签文案随语言变化，按字数估算必然失准。
    **度量不可信（未量到 / avail≤0）→ 一律全部可见**：宁可横向溢出这种视觉瑕疵，
    也绝不因为量不出来就藏页签 —— 那是功能丢失，不是外观问题。
    `.navMore` 与 `.navTab` **共用同一批 CSS 规则**（分组选择器）：同处一个分段条，
    必须长得一模一样，分成两套写必然会漂移；且根节点必须 `flex: none`
    （`.selectRoot` 缺省可收缩，空间一紧就被压扁，`navLayout` 的算账就白算了）。
    当前页被藏进「更多」时按钮高亮（`.navMore[data-active]`），否则用户看不出「我在哪」。
  - **动作区是三个纯图标按钮**（⌘K / 活动 / 关于）：v1 那两个文字按钮在英文界面下
    各吃掉约 90px，等于每加一个动作就压缩一格页签容量。
  - **`.shellNav` 不铺背景色**（与 `.statusBar` 一致）：宿主设置面板底色随主题变化，
    实测暗色下 `--dsw-alias-bg-base`=#151517 而面板底色=#2c2c2e，铺底色会在导航条两侧
    形成一条比面板更暗的通栏色块（亮色下两者同为 #fff 才看不出来）。页签分组感由
    `.navStrip` 自身的 `bg-layer-2` 底色 + 描边承担。
- Dialog：`.dialogMask/.dialogCard(.dialogWide)/.dialogHeaderRow/.dialogHeader/.dialogBody(.dialogBodyScroll)
  / .dialogFooter`，遮罩点击/Esc/取消三途径关闭，busy 禁闭，focus trap，焦点还原。
  - **标题行缩进（UI-10）**：`.dialogHeader` 原本是**独立块级标题行**（自带 `padding: 12px 16px 0`），
    在 `.dialogHeaderRow`（flex 行）里复用时内边距会与父级叠加 → 标题比正文多缩进 16px、下沉 12px。
    归零规则：`.dialogHeaderRow .dialogHeader { padding: 0 }`，缩进统一由行容器提供
    （只传 title 的弹窗走独立块分支，缩进本就正确）。
  - **关闭按钮文案（UI-17）**：`Modal.Header` 的 `closeLabel`（aria-label）**必填于传了 `onClose` 的调用点**
    （联合类型由编译器强制），值一律是各自字典的 `common.close` —— 原先硬编码中文，英文界面下
    屏幕阅读器仍读中文。**底部动作一律走 `Modal.Footer`**（`.dialogFooter` 固定底栏；UI-23），
    不要放进 `Modal.Body` 的正文流（会随内容滚动、条目多时被裁到折线以下）。
  - **确认后的「进行中」必须有处可看（UI-25，2026-10-16 磁盘清理实测反馈）**：二选一 —— ① 弹窗自担 busy
    （`ConfirmDialog` 的 `busy`，或让 `onConfirm` 返回 Promise ⇒ 弹窗与确认按钮一起 loading、期间禁闭）；
    ② **点击那一刻就关窗**，把进度交给页面上那颗触发按钮（`Button loading` + 文案换「正在…」）。
    两者都不做 = 操作确实在跑，但屏幕上毫无变化，用户判定「点了没反应」（真机反馈原文）。选 ② 时**必须**
    保证页面不掉：不重载列表、不回骨架，成功与失败分别走 toast（清理磁盘占用即此档）。
  - **尺寸**（2026-09 放大，长内容可读性）：`.dialogCard` = `min(640px, calc(100vw - 48px), 95%)`
    × `min(600px, calc(100vh - 64px), 92%)`；`.dialogWide` = `min(720px, …, 96%)` ×
    `min(620px, …, 92%)`；`.dialogBodyScroll` 限高 460px。旧值 380×480 在「配置更改明细 /
    分区构成」这类长内容下会被压成很窄一列且过早内滚。百分比上限用于兜底宿主导航占宽。
  **Portal 容器必须是插件根节点**（`ConfigManagerSection` 的 `#dsh-config-manager-root`，
  常量 `MODAL_ROOT_ID`）：宿主设置弹窗 overlay 为 `position: fixed; z-index: 1000`，
  弹窗若按 Radix 默认挂到 `document.body` 就成为它的兄弟节点、被 1000 层完全盖住而"隐形"，
  叠加 Radix modal 给 body 加的 `pointer-events: none` → 表现为"打开后整页点不动，
  必须先点一下屏幕"（那一下正是关掉隐形弹窗的外部点击）。挂回插件根节点即恢复
  与宿主同一层叠上下文（与迁移前内联 `dialogMask` 的层级语义一致）。
  **容器必须在渲染期同步解析，且不得回退 `document.body`**（2026-09 档案详情弹窗「先闪现在
  别处、再跳到页面中心」的真机根因）：Radix `Portal` 的容器为空时会回退到 `document.body`，
  而该回退判定发生在它的 layout effect（**首次绘制之前**）—— 若用 `useEffect` 去查根节点，
  查询发生在**绘制之后**，于是「弹窗与 `open=true` 同一次 commit 挂载」的路径（刷新后详情目标
  由 run-store 保留、切页签回来面板重挂、宿主重挂 section）会**先在 body 里画一帧**：
  `position:fixed` 此时相对视口居中而不是相对宿主面板，随后才被搬进插件根节点 = 可见的跳闪。
  三条纪律：① 惰性 `useState(() => 查根节点)`（渲染期同步命中）；② `useLayoutEffect` 兜底
  （同一 commit 内根节点尚未进 DOM 时，重解析在绘制前完成）；③ 容器未知时**不渲染 Portal**
  （宁可晚一帧，也绝不走 body 回退）。
- **Task 面板（Task Mode，2026-10，取代 v1 的 Drawer）**：`.taskPanel/.taskHead/.taskTitle/.taskBody`。
  删抽屉的四条理由与四条硬约束：
  ① **定位必须 `absolute; inset: 0`**（贴合 `.shellContent`，它 `position: relative`），
     不是 `fixed` —— 抽屉用 `fixed` 是相对**视口**解析的，才需要
     `@media (max-width:900px){ width: 100vw }` 那条错误补丁（已随抽屉删除）。
     层叠 `z-index: 90`（Modal 是 101）。
  ② **它不是模态**：不带遮罩、`role="region"`（**不是** `dialog`/`aria-modal`），
     导航条 / 全局横幅 / 状态栏全部保持可点 —— 横幅可见是急救可达性的硬要求。
  ③ **底下的页面保持挂载**：关闭是瞬时的，滚动位置、展开的那一行、已拉到的数据都还在。
  ④ **入场只做 24px 轻位移**（`.taskPanelIn`，180ms）：面板本身满宽（564px），
     「整幅滑入」要在 180ms 内扫过整屏，看着像闪一下。
  ④.1 **换视图不重挂外壳**：`TaskShell` 不按 `kind` 加 `key` —— 按 kind 重挂会「先卸载旧面板、
     再让新面板从 `opacity: 0` 入场」，两步之间露出的那一帧就是用户报告的闪烁。
     外壳只在「无面板 ⇄ 有面板」时挂载/卸载，`.taskPanelIn` 因此每次开面板只放一次；
     同一面板内的 kind 切换是**原地换内容**（头部、背景、层叠都不动）。
  关闭途径集中在容器里：`← 返回` 恒有；`escToClose` **只给只读视图** ——
  多阶段流程里可能有未保存的计划或已输入的密码，Esc 误退的代价太大。
  删抽屉的直接理由：① 它带遮罩却只占画布 71%（564px 里的 400px），遮罩之下那 164px 没有价值；
  ② 宽度绑的是**视口**而插件画布恒为 564px，同一个插件在不同窗口尺寸下是两副样子；
  ③ 运行中心与迁移历史都是数据表，400px 一直在挤。
- **MoreMenu**（`common/MoreMenu.tsx`）：导航条溢出的「更多 ▾」。四条实现契约**照抄 Select**
  （absolute 不 portal / Esc 必须 `stopPropagation` / mousedown 关闭外部点击 / 高亮移动走
  `ui/select-model.ts`）；差异只有语义：`aria-haspopup="menu"` + `role="menu"` +
  `role="menuitemradio"` + `aria-checked`。弹层样式与 Select **共用** `.selectMenu/.selectOption`
  （含 `[aria-checked='true']` 选中态），对齐量测共用 `common/menu-align.ts`
  —— 宿主设置弹窗恒比视口窄，按 window 宽度判断必然误判（弹层会被 `.section` 裁掉）。
- **CommandPalette**（`common/CommandPalette.tsx`）：`⌘/Ctrl+K`。命令表是**纯数据**
  （`src/ui/commands.ts` 的 `COMMANDS` + `filterCommands`，node 单测覆盖匹配优先级 / 跳过禁用 /
  稳定排序），组件只装配。走 `Modal`（Radix），focus trap / Esc / Portal 全部现成。
  空查询按**分组**渲染、有查询按**相关度**平铺（有查询还插分组标题会打乱排序语义）。
  **分组标题不是选项**：字号更小、更淡、不可选中，且非首组先起一条分隔线 ——
  否则它和「灰掉的选项」长得一模一样（真机反馈：用户把三个分组标题当成了点不动的灰条）。
  **目的地命令（页面 / 只读视图 / 流程面板）不设 `enabled`**：它们任何时候都能打开，
  面板自己渲染空状态；灰显这个口子只留给「当前上下文真的做不了」的动作，且必须给得出原因
  （`CommandItem.enabled`，今天没有一条命令用它）。
  五条实现纪律：① 渲染顺序与高亮顺序**必须是同一个数组**，否则方向键跳得莫名其妙；
  ② 快捷键**不抢输入框**里的 ⌘K（宿主别处也可能用它）；
  ③ **只注册壳层真能执行的命令**：命令表的 id 与壳层 `runCommand` 的 `case` 必须逐条对应
     （`commands.test.ts` 有双向源码守卫）—— 认不出的 id 会变成点了什么都不做的死选项；
  ④ **每次打开复位** query 与高亮（面板组件常驻，不复位会把上次的过滤结果带出来）；
  ⑤ **高亮必须滚进可视区**（列表限高，↑↓ 走到看不见的位置与键盘失灵没有区别）。
- **运行中心（2026-09，现为 task 面板的「进行中」）**：`.runsCenter/.runsSummary/.runsCardHead/
  .runsCardTitle/.runsCounts/.runsLogTail/.runsLogLine/.runsCardActions/.runsOption(.runsOptionTitle
  / .runsOptionDesc/.runsOptionTag)` + 状态栏入口 `.statusAction`。
  - **入口双点、正文一处**：状态栏那句「N 个任务进行中」（`.statusText`）在有任务时**整句变成按钮**
    （`.statusAction`，无边框无底色，只加 hover 下划线 + 焦点环 —— 它是状态文本，不该看起来像按钮），
    点开 **task 面板**的「进行中」；正文只有面板里的运行中心一份。**不新增一级页签**：
    运行任务跨页面，而页签容量早已由 `navLayout` 自动收敛。
  - **三段是三种 task kind，不再用 Segmented**：`runs`（瞬时态，`/runs?scope=recent`）/
    `history`（持久审计）/ `about`，由面板的 `key={kind}` 重挂承担切换动效。
    它们**不得合并成一个视图**：`runs` 的终态 30 分钟后会被宿主 prune，混进历史页会出现
    「刷新后历史里少了一半」的认知撕裂。
  - **决策框不是普通确认框**：`Modal` + `.runsOption` 单选卡（两个语义不同的出口：回滚 / 保留），
    代价数字（已应用 / 未执行）写在正文顶部，默认项带 `.runsOptionTag`「推荐」标记（推荐项跟随用户
    既有的「失败不回滚」偏好），底部动作走 `Modal.Footer`（`.statusSpacer` 推靠右）。
    「保留」下方**必须**带 `Banner kind="warn"`：审计只能压低 DSH 启动失败的概率，不能保证。
  - 长内容纪律：日志尾部 `.runsLogTail` 限高 108px 内滚（同 §2 长列表规则），卡片列表靠在面板
    自身的 `.taskBody` 滚动里，**不得**再嵌套一层滚动容器。
  - **进度轨道三态（真机 bug 修复，用户报告「定时备份 / 自动同步 一直在加载」）**：轨道形态由
    `progressBarMode(view, active)`（纯函数，`src/client/common/progress-view.ts`）决定 ——
    有百分比 → 定长；**无百分比且在跑** → `.progressIndeterminate` 不定态动画；
    **无百分比且已结束 → 静止满格条**（此前不看 `active`，只要没百分比就渲染无限动画，于是
    「已完成」的任务永远在滚动）。结束态默认 `.progressBarDone`（success 绿），失败时由
    ProgressBar 的 `failed` 换 `.progressBarFailed`（state-error）—— 失败的任务**不得**染成成功绿。
  - **阶段文案按 run 类型分开**（`src/client/run-store.ts` 的 `RUN_STAGE`）：备份 / 同步 / 快照恢复 /
    档案切换 / 事故恢复各有措辞（`progress.backingUp` / `syncing` / `restoring` / `switchingProfile` /
    `recovering`），**不得**再用导入的「正在应用配置…」兜住所有类型；已结束的 run 用
    `progress.done` / `progress.failed` 结论文案，不再显示进行时。
  - **终止等待必须可见（`.runsWarnNote`，2026-09）**：终止是**协作式**的（只在计划项边界生效），
    所以卡片必须写出「已请求终止：等当前计划项结束后暂停（已等待 N 分钟）」（`.hint` 灰底），
    超过 `CANCEL_STUCK_AFTER_MS`（2 分钟）升级为 `.runsWarnNote`（warn 描边 + warn tint）+
    `.runsWarnNoteDetail` 给出路：先「跳过当前插件」、否则重启 DSH。**绝不**留一个还能点、
    但点了没有任何新效果的「终止」按钮（已请求过就不再渲染该按钮）。
  - **环境锁卡片（同段，2026-09）**：残留锁此前只存在于「备份 → 事故恢复」，用户在运行中心里看不见它 ——
    而它正是「导入终止不了、写操作一直被 423」的当事者。三态语义必须分开：
    `FREE` **不渲染卡片**（空闲是常态）；`LOCKED` 渲染为 `Badge kind="info"`「使用中」**且不给回收按钮**
    （宿主按设计拒绝回收活锁，给按钮只会让人反复点）；其余（`STALE_LOCK_DETECTED` / `UNKNOWN_STATE` /
    IO/权限）渲染为 `Badge kind="warn"`「需要处理」+ 主按钮「回收残留锁」；失败/被拒必须如实提示
    （`runs.lock.recoverRefused` / `recoverFailed`），**不得**报成功。回收动作 `userConfirmed=true`
    只由用户点击表达。
  - **每张卡片带相对时间**（`.runsCardTime`，右贴）：没有它，「正在跑」与「几小时前就结束的僵尸卡片」
    在界面上完全一样。保留期说明（`runs.retentionHint`）属 MOVE 类（机制怎么工作 + 省事提示），
    收进列表头部摘要行的 `InfoHint`（ⓘ）；空列表「为什么什么都没有」的**常驻**解释由
    `<Empty>`（`runs.empty`）承担，不得一并移入 ⓘ。

### 远程合并弹窗（2026-10-21 重设计，替代页内联的旧裁决视图）
结构层次（**四层，表面与间距逐层收窄，不靠颜色堆叠**）：概览指标 → 分区卡 → 冲突片 → 结果卡。
- **概览指标块**：`.mergeOverview`（4 等分 grid，gap 8）+ `.mergeTile[data-tone='ok'|'info'|'warn'|'error']`
  + `.mergeTileValue`（fs-title/600/tabular-nums）+ `.mergeTileLabel`（fs-meta）。
  **语义走 `data-tone` 而不是四个类名**（与 Badge/Banner 同一套四态词表）；着色只用
  `color-mix(in srgb, var(--cm-<tone>) 8%, transparent)` 底 + 40% 边框 —— 数字先被读到，颜色只做分级。
  概览是**决策依据**（可自动应用 / 待裁决 / 冲突 / 无变化），因此常驻在正文最上方，不折叠、不进 ⓘ。
- **分区卡**：`.mergeSection` = 0.5px `--cm-line-1` 外框 + `--cm-r-3` + `--cm-surface-1`，
  相邻卡之间用 `.mergeSection + .mergeSection { margin-top: 8px }` **而不是分隔线**（卡片化后分隔线
  会与卡边框叠成双层）。卡头 `.mergeSectionHead`：名称 + 裁决 Badge + `.statusSpacer` + 冲突/自动并入计数。
- **冲突片**：`.mergeConflictRow` 是卡内第二层，用 `--cm-r-2` + `color-mix(in srgb, var(--cm-text-1) 4%)`
  抬一档明度（**不再用 `--dsw-alias-bg-layer-1`**：弹窗底色本就随主题变，叠宿主层色会脏）；
  `.mergeKind` 是字号 11 / 行高 1.5 的芯片（padding `0 6px` + 8% tint），只标注冲突类型。
- **裁决片**：`.mergeActionActive` = ghost-active 配方（`--cm-ghost-active-fill/border`）+ `font-weight:600`
  + 按内 `CheckIcon`（12px，包在 `.mergeIconLabel`）。**当前裁决必须同时有底色、描边与对勾**：
  只靠底色在暗色主题下几乎看不出差别。
- **动作按可用性条件渲染，而不是「灰着不能点」**（2026-10-21）：分区行的「采用自动合并」只在
  该分区 `decision === 'merge'`（有 merged 载荷）时出现；批量的「全部采用自动合并」只在至少一个分区
  可用时出现。「冲突留到下次」只在还有待裁决分区时出现。灰按钮在这类弹窗里无法自证原因
  （用户实测提问「为什么自动合并按钮永远都是灰色的」—— 它其实只对可自动合并的分区有意义，
  对冲突分区永远不可用，于是整屏都是灰），判据能量化到行时就不要用 `disabled` 表达。
- **没有「跳过」这个动作**（2026-10-21 移除）：跳过既没有解决冲突，又与「什么都不点」在引擎侧完全
  等价（空草稿 = 未点名的分区不应用），多一个动作只会让人以为「已经处理过」。草稿缺省为空，
  待裁决分区由正文脚注如实告知（「还有 N 个分区待裁决：本次不会应用它们，下次同步仍会出现」）。
- **执行通道只有一条（UI-23 的强化用例）**：`.mergeFooterSummary`（裁决进度 `merge.apply.summary`
  · 本次会应用的分区数 `merge.apply.willApply`，可收窄换行）+ `.statusSpacer` + 关闭 ghost +
  「执行合并」primary 三件套**固定在 `Modal.Footer`**；正文里不再出现第二个执行按钮，也不放「关闭」。
  primary 的 disabled 只由「在途 / 预览未就绪 / `hasApplicableSections(preview) === false`」决定 ——
  **不再看草稿是否写了 skip**（草稿为空不代表无事可做：可自动合并的分区不需要用户裁决）。
- **长列表在弹窗内滚动**：`.mergeScroll[data-fit='modal']`（padding 8 + `max-height: 46vh`）——
  高度让位给概览与底栏，564×720 画布下都不撑出宿主面板滚动条。
- **职责切分**：弹窗壳 / 状态 / 请求 → `MergeModal.tsx`；列表与视觉 → `MergePreviewView.tsx`（纯展示，
  无请求无状态，便于单测与复用）。概览/分区/冲突的判定仍在 `merge-view.ts` 纯函数里。
- **在途活动条**（`.syncActivity` + `.syncActivityTrack` + `.syncActivityLabel`，`SyncActivityBar.tsx`）：
  一键同步的触发按钮 `loading` **之外**，整张卡上再加一条不定态细条 + 阶段文案（先「正在检查远端变更」、
  确认要同步后转「正在同步」）。规则属 UI-25 的加强版：凡「点击后要等几秒才有第一个可见结果」的操作，
  **必须**在等待期间给出阶段文案，且不定态进度**不得**因 `prefers-reduced-motion` 被关掉（它是状态）。

### 布局行原语（2026-09 补：把「行」的语义与间距集中定义，禁止各处内联 margin）
- `.actionRow`：通用操作行（flex + nowrap→wrap，`margin: 0 0 10px`）。
- `.actionRowTop`：上方紧跟说明文案的操作行（同 `.actionRow` 但**上边距 10px**），
  用于「hint / 计数行之后才是按钮」的场景（同步页「配置同步通道」与「选择同步分区」）。
  **普通 `.actionRow` 没有上边距** —— 直接跟在文字后面会把按钮与文字贴在一起（实测过）。
- `.tabRow`：**独占一行**的分段/页签行（`.modeTabs` 是 inline-flex，直接跟在文案后
  会与文案同行）。**当前无调用点**：同步页的「默认 / 高级」模式分段已移除（分区恒由用户
  手动勾选），本类保留为原语，供后续需要独占一行的分段控件使用。
- `.headRow`：卡头单行（标题左、动作/徽章右）。与 `.groupHeader` 的区别：不做
  baseline 对齐（按钮组需居中），且 `.headRow .groupLabel { margin-bottom: 0 }`，
  否则标题的 8px 下边距会把整行撑高。右侧推靠用既有的 `.statusSpacer`。
- `.authorRow`：标签 + 值的居中行（关于页作者行），同样带 `.groupLabel{margin-bottom:0}`。
- `.sectionOptionRow`：同步分区弹窗里「分区勾选行 + 该分区专属参数」（历史会话的「最新 N 个」）
  的纵向容器。**必须包在 `Checkbox` 之外** —— `Checkbox` 内部是 `<label>` 元素，
  把输入控件放进去会让「点输入框」也切换勾选状态。
- `.kvRow + .actionRow`：**分隔线之后紧跟操作行**必须补 `margin-top: 8px`
  （`.kvRow` 只有下边框、没有下外边距，`.actionRow` 没有上外边距 → 按钮紧贴分隔线；
  用户实测：档案页「运行状态」里的「停止」按钮贴在横线上）。
- `.historyRow`：`padding: 6px 8px`（左右各 8px）。行位于带边框的滚动容器 `.historyScroll` 内，
  此前只有纵向 padding → 时间/摘要文字紧贴容器左边框（实测仅 1px = 边框本身）。
- **教训（本轮踩到）**：`.field` 自带 `margin-bottom:10px`，任何用 `align-items:flex-end`
  把「字段」与「按钮」并排的对齐都会因此差 10px（实测 select 底 1042 / 按钮底 1052）。
  在并排容器里必须把该字段的 margin 归零（见 `.snapshotPickerRow .field`）。

### 表单宽度纪律（本轮修正的回归）
`.input/.select` **不得**全局 `width:100%`：它们大量出现在行内 flex 容器里
（市场筛选、同步快照下拉），全局满宽会让每个控件各占一整行。
满宽只在**纵向**容器内按需生效：`.field > .input/.selectRoot { width:100% }`
（`.selectRoot` = 自定义下拉的根节点，见 §6 `Select`）
（`.field` 是 column flex），路径映射则用 `.pathOld/.pathNew { display:flex;
flex-direction:column }` 让内部 input 拉满。市场筛选用 `.marketFilterGrid`
（2 列 grid）+ `.marketFilterSearch`（跨列）+ `.marketFilterMeta`（元信息行）。

### 页面级模式
- **Overview 控制中心**：状态条 → 动作工具栏（主操作 + 活动入口右对齐）→
  最近活动（**首页最后一个数据块**：吃掉剩余高度、列表自身内滚 —— 用户真机反馈「太空旷」后由 fit-content 272px 上限改为填充）。**备份位置与配额整组下线**（首页与设置弹窗都没有，2026-10-06 用户要求；备份目录仍可从产物库行读到的路径得知）
  （fit-content 上限 8 行内滚；成功=绿点降噪，失败/跳过=徽章）。
  - **首用空态**（备份与快照均为空）不走上面这条流，而用 `Stepper`（`.emptySteps` 容器）给出
    **三步主线**：创建第一份备份 → 导出 ZIP 带走 → 在新机器导入回来。步骤序列来自纯函数
    `overviewFirstSteps()`（`ui/overview-view.ts`，有单测），组件不写死顺序与文案；
    首用恒为「第一步 current、其余 todo」——**不做状态推断**，推断属模型层职责。
- 状态条指标段**精确跳转**（v2 重写）：备份文件 / 安全快照 → **产物库并预置来源筛选**
  （`navMetric` 写 `panel: 'library'` + `library.sourceFilter`，只写 panel 会停在默认筛选）；
  定时备份 → **本页开设置弹窗**（它是设置不是对象，不必跳走）；远程同步 → 同步页。
- 健康段仅在「存在未解决恢复事项」时渲染为按钮，直达**环境页「维护与诊断」**；正常态是纯展示 span。
  - 活动行容器 `.activityRows` 取 `flex: 0 1 auto; min-height: 0`（**不可用 `flex: none`**）：
    页面被压缩时列表须随之收缩并自身内滚，否则内容溢出卡片边框（曾实测 274px 内容 vs 205px 卡片）。
- **产物库**（v2）：源筛选 Segmented（全部 / 本机快照 / 备份文件 / 远端快照 / 市场产物）+ **扁平列表**。
  行 = `.kindTag` 来源标签 + 标题 + 元信息 + 时间；展开态给详情对（`.artifactDetail`）。
  能力集合 `ArtifactCapability = restore|import|pull|install|inspect|download|consult|pin|unpin|delete`
  由 `src/ui/artifact-view.ts` 统一判定（四源共用一份模型），**行只冒泡能力，弹窗由页面级持有**。
  **不做批量操作**、排序只有时间/名称；「改备注」已砍（收益低、状态多）。
  - **高度契约（2026-10-04 用户要求）**：列表 `.artifactList` 与加载态 / 空态 `.libraryListState`
    都是 `flex: 1 1 auto`，**永远吃掉剩余高度**（哪怕只有一两行）；工具栏（`.libraryFilters` /
    `.librarySearch`）与底栏 `.libraryFooter` 是 `flex: none`。行数少时底栏恒贴底，不会吊在半空
    留一大片空洞；内容超出由列表**自身内滚**（页面不整页滚）。
  - **市场条目只有一个动作**：`install`（2026-10-04 用户要求）—— 它打开「逛市场」流程并**直达该条目**
    （下载 + 校验 + 免责 + 分步审阅），与它同入口的「查看与对比」是重复项，已从能力集合里移除。
- **环境**：Segmented 两子视图 ——「档案」（本机概况卡 + 档案列表；启动/停止/复制/删除沿用 v1 判定）
  与「维护与诊断」。
  - **维护与诊断（2026-10-12 重排，用户反馈「太杂乱」）**：顺序 = 崩溃归因 → **状态与待处理事项**
    （SAFE MODE 横幅 / 未解决事项 / 残留锁 / 空态；异常一律在诊断之前）→ 事故处置（救援模式）→
    复制残留 → **诊断三块**（会话体检与「工作区 + 会话回滚」**不折叠**（2026-10-12 用户要求）：卡上常驻标题 / 状态徽章 / 数字摘要 / 主操作，
    台账与体检结果各自搬进弹窗（`{open && …}` 条件挂载）；救援模式那一块仍有 `FoldToggle`，且只在真有明细时才渲染开关。
    **磁盘占用卡同样不参与折叠** —— 它是**固定高度 + 内滚视口**卡（`.diskUsageCard` 三值锁死高度、
    `.diskUsageScroll` 吃掉剩余高度）：折叠①会留下一个固定高的空盒，②会把内滚容器从纵向 flex 链里
    摘出去（`.collapse` 是 flex 项、自动最小尺寸 = 内容高度 ⇒ 撑破卡盒、内容溢出盖住后续卡片，
    2026-10-12 真机截图复现）。
    副标题只在**真有待处理事项**时渲染（`recoveryRequired` 口径）——健康态不再出现
    「检测到一次操作未正常完成…」这句假警报；空态只在**确知没有事项**时渲染（枚举失败 ≠ 没有）。
    页级副标题（档案说明）只在档案子视图下渲染。
- **恢复计划预览（git 风格，2026-09 用户要求）**：计划弹窗从「一行条流水账」改为
  「摘要条 → 状态分组 → 点开逐行对照」三级：
  - 摘要条（`.statRow` + `Badge`）：将被还原 / 新增 / 将被删除 / 卸载插件 / 需人工处理 /
    无动作（各自计数）+ 行数合计（`.diffStatAdd` 绿 / `.diffStatDel` 红）。
  - 分组顺序固定：`changes`（修改+新增）→ `deletes` → `plugins` → `hints` → `skips`；
    **`skips` 默认折叠**（`.diffGroupToggle`）—— 几十条「跳过」不再淹没真实变更。
  - 文件行（`.restorePlanRow`）：状态标签（复用 `.kindTag` 四态）+ 等宽路径
    （`.restorePlanPath`，单行中段/尾部省略）+ 行数（`.restorePlanStat`）+ 展开箭头；
    不可展开的行（插件/提示/跳过）用 `.restorePlanRowStatic`（保留可读性，不置灰）。
  - 展开后为**左右双栏对照**（`.diffTable`：行号 + 内容 ×2，`table-layout: fixed`）：左=当前磁盘内容、
    右=快照内容；成对修改 = 左 `.diffCellDel` 红底 + 右 `.diffCellAdd` 绿底，单侧增/删只着色一侧；
    **行号栏同样按语义着色**（`.diffNoDel` / `.diffNoAdd`：红/绿行号 + 12% 底色），并用
    `box-shadow: inset 3px 0 0` 在**该栏左缘**画 3px 实心色条（左栏 = 整表左缘、右栏 = 两栏分界处）；
    块头 `@@ -a,b +c,d @@` 用 `.diffHunkRow`，**两栏各一格、同一段文本**（编辑器式单文件 diff 的观感）；
    两栏之间的竖线由 `.diffTable tbody td:nth-child(3)` + `.diffHunkRow td + td` 的左边框画（表头仍是
    `.diffNoHead + .diffNoHead`）——只画表头会让正文两栏看起来连成一片。
    **行节奏（2026-10-14 用户参考图）**：`font-size: 12px` + `line-height: 1.5` + 单元格上下 `1px` 内边距
    ⇒ 每行 **20px**。参考图是 22px，但 845px 宽的侧栏里 24 行会折成 35 个视觉行：22px 比宿主给的那一屏高
    一行 ⇒ 表格自己冒滚动条（用户两轮实测），故收到 20px 换掉它。
    块头与正文同档字号（`.diffHunkRow td` 不再单独写 11px），文件头 `.diffFileHead` 同 12px；
    列头 `.diffNoHead` 仍是 11px 的小字幕。正文仍 `pre-wrap` 折行（参考图是横向滚动不折行 ——
    `table-layout: fixed` 下改成不折行会让两栏互相挤压，不采用）。
    **不再截断渲染**（2026-10-15 用户：「为什么最多只能加载 400 行？我需要能完整的加载」）：宿主给多少行就画多少行 ——
    到渲染层的数据已被宿主侧的单文件字节上限收窄（回滚预览 1 MiB / 恢复计划 `maxSideBytes`），
    渲染层再砍一刀只会让同一份数据少半截、而用户无从看到剩下的（原先「最多 400 行对」的上限与
    「只画了前 N 行」话术连同字典键一起删除）。容器复用 `.diffScroll`，
    但**高度按上下文分两档**（2026-10-14 用户实测「22px 行高下一屏只剩 10 行」）：`.diffPane .diffScroll`
    吃满可用高度（`min(80vh, 800px)`，与市场审阅步内区同一上限），**弹窗内**
    （`.dialogCard .diffPane .diffScroll`）回落到列表那条 380px —— 卡片本身只有 600/620px 高，
    撑大会让正文溢出卡片边框。
  - **行号列宽 = 实际最宽行号的位数 + 18px 呼吸**（`maxLineDigits` → `.diffNoColW3/4/5/6` 四档 `calc(Nch + 18px)`，
    `<colgroup>` 固定；那 18px 落在色条与数字之间 —— 行号右对齐，不加时数字贴着 3px 语义色条）：
    fixed 布局下四列平分会让两条行号列吃掉一半宽度、代码列被挤到反复折行；行号列必须只占自身需要的宽度，
    剩余空间由两条代码列平分（`.diffPane` 左外边距归零，别在行号列左侧再留缩进）。
  - **行数统计一律分色**：`+N` 用 `.diffStatAdd`（绿）、`−M` 用 `.diffStatDel`（红）——单条
    `'+{added} −{removed}'` 字典文本无法分别着色，故该字典键已删除，改由 `RowStat` 两个 span 拼装。
  - **分组头严格一行**（`.restorePlanGroupHead`）：`.groupLabel` 是卡内小节头（`display:block` +
    `margin-bottom:8px`），直接塞进 `.statRow` 会被下外边距顶得与徽章/行数不在同一视觉行，
    故分组头用独立类并复位 `.groupLabel` 的 `display`/外边距。
  - **弹窗不再内嵌「迁移前咨询」卡**（v3，用户要求）：恢复计划弹窗的职责是「这次恢复会改什么 +
    确认执行」，报告改由**独立入口**打开（产物库行 ⋯ 菜单 →「迁移前咨询」，走自己的弹窗）。
    原先的分割线类 `.sectionDivider` 随之删除（只剩这一处引用 = 死样式）。
  - 无法逐行对照时按原因给一句话（二进制 / 过大 / 不可读 / 快照缺内容 / 路径越界），
    两侧一致时显示「无逐行差异」——三种状态都占位，不出现空白面板。
  - 数据来源：宿主 `POST /restore`（dryRun）附带 `changeSummary`（轻量统计，带读取上限），
    单文件 hunks 由 `POST /snapshots/file-diff` 在点开时懒加载 —— 会话类快照几百个文件也不拖死弹窗。
  - 分层：分组/统计在 `src/ui/restore-plan-view.ts`、双栏对齐在 `src/ui/diff-view.ts`（纯函数 + node 单测）；
    行级 diff 内核 `src/utils/line-diff.ts`（零依赖 Myers，**超预算才**降级为整块替换）；
    **保真度预算**：编辑距离上限缺省 2000、回滚单文件按需查看 4000（400 那条老口径会让几千行文件的普通改动
    一律变成「整块替换」＝用户看到的假信号）；预算的时间与内存实测（≤115 ms / RSS ≤+175 MB）与取证见
    `docs/lessons/recovery-console.md`，再往上要换线性空间算法而不是继续加预算；
    组件 `src/client/library/RestorePlanView.tsx` 只装配（v3 随产物库归位搬移）。
  - **双栏表已抽成共享原语**（2026-10-12）：`src/client/common/DiffTable.tsx` —— 快照恢复计划与
    「回退预览 → 查看」共用同一副骨架（`.diffTable` / `.diffScroll` / `.diffCell*` / `.diffHunkRow` /
    `.diffNoColW*`），单元格文本**缺省即 redact**（`sanitize` 的缺省值就是 `redact`，调用方只能换成别的脱敏器）。
    **2026-10-14 起多一个可选文件头** `title`（`.diffFileHead` = 路径 + `+A`/`−R`，行数由 `diffLineCounts` 现算；
    **只画路径文字，不画文件类型图标** —— 曾经接过 `RollbackFileIcon`，同日用户改口径「文件路径前面不需要 icon」，
    整条链已撤掉；那颗图标改去画**芯片**（见 §「查看」的芯片段），别再加回文件头）：
    只在调用方**没在别处写过路径**时传 —— 回滚侧栏标签页与聊天/设置页的就地差异块传 path（它们原先各画一行
    `.hint.mono` 路径，已由该文件头顶掉）；恢复计划行自己那格已写路径，**不传**（同一路径不画两遍）。
- **回退预览弹窗（Cursor「Confirm Undo」式，2026-10-12 用户要求）**：底盘沿用 `.dialogCard` 宽版，
  正文顺序固定 = 汇总选择行（`.previewChoiceRow` + `.previewScope`，见 §「聊天内回退预览弹窗」）→
  会被回退的文件列表（`.rollbackFileList` 内的 `.rollbackFileRow`）→ 可选的原因/告警；
  底部**恰好两颗**按钮（回退 / 取消）。说明行 `.previewSummary` **已下线**（删渲染）。
  - 文件行 = **可点的等宽路径**（`.rollbackFilePath` 是 `<button>`，内部 = 弱化目录 `.rollbackFileDir` + 基名）
    + `+N`（`.rollbackAdded` 绿）/ `−M`（`.rollbackRemoved` 红）；**点文件名即打开该文件差异**（无独立「查看」按钮）。
  - 「查看」把该文件的差异开进 **DSH 右侧栏**（本插件注册自己的 tab 类型 `cm-rollback-diff`）；
    本客户端没有侧栏能力时降级为弹窗内展示（`.inlineDiffBox`）并说明为什么在这里看 —— 不出现空白面板、不假装打开过。
    **芯片（标签条上那颗标签）由我们自己画**：`sidebar.right.pane.tab.title`（keyed，key 同正文位）
    = `RollbackDiffTabTitle` → 「文件类型图标 + 文件名」（`.rollbackTabIcon`，与 better-sidebar 的 `.chipIcon`
    同档：inline-flex + 右 6px）。为什么必须自己画：**宿主的 tab 类型定义没有 icon 字段**（芯片只由 title
    文字画出来，dsh-better-sidebar 的 tab-adapter 注释写明）；形态探测不过 ⇒ 不注册，芯片退回宿主画的标题文字。
    侧栏正文**撑满宿主给的那一屏**（`RollbackDiffPane` 的 `fill` 档 / `.diffPaneFill`：`height: 100%` +
    表格 `flex: 1 1 auto`，flex 链每环 `min-height: 0`，且 **`margin: 0`** —— `.diffPane` 那 2px+8px 落在
    100% 之外会让宿主面板自己冒一条滚动条，真机截图实测「我们的滚动条在容器内、宿主那条贯穿整窗」）：
    不再自己留一道 vh/px 上限（2026-10-14 用户要求「容器的大小 === 侧边栏的大小」）；
    **`.diffPaneFill .diffScroll` 那条限高必须写在 `.diffPane .diffScroll` 之后**（两条特异性同为 (0,2,0)，
    **顺序决定胜负**：写在前面时列表量级的 `min(80vh, 800px)` 会盖掉它，侧栏比它高时差异区就停在 800px ——
    2026-10-15 用户复现「预览高度不跟侧栏走」；headless 用仓库真实 CSS 实测：修前 726px、修后 778px = 那一屏减文件头）；
    撑满档下**加载 / 一致 / 看不了 / 读失败四种状态也套同一个整块容器**，否则状态切换时一屏高度会跳。
    弹窗内的就地差异**不给 fill**（卡片高度不是它那一屏）。
  - **不引入**无功能的勾选框：回退是整体语义，放一个取消不掉的勾选框只是装饰（诚实性优先于形似）。
- **冲突解决**（ConflictList）：选边卡片模式——每项一张卡（kindTag 适配器 + 等宽描述），
  两个并排 `.choiceCard` 选边（radio 语义，选中高亮），**可见文案取字典**
  `import.conflicts.keepCurrent` / `useImported`（zh「保留当前 / 使用备份」、en「Keep current / Use backup」）；
  批量决策在顶部。
  安全：不做值级 diff。冲突明细里的 `current=…` / `imported=…` 是**宿主拼装的标记 + 配置值**
  （settings / providers 已在适配器侧按 `redactSecrets` 掩码，但 MCP 的 `env` / `headers` 等由
  `extractMcpServers` 原样给出）—— 标记本身**从不作为文案显示**，因此**不得**把这一行读成
  「冲突项不含当前值」，UI 侧仍必须逐点过 `redact()`（依据见 §7）。
- **配置更改明细**（`.conflictDetail`）：host 拼接的 `[prefix] current=… imported=…` 单行文本，
  在纯展示层用 `splitConflictDetail` 切成 prefix / current / imported 三段（切分只依赖 host 的
  `current=` / `imported=` 字面标记，两标记互不干扰），渲染为两行（`.conflictLine` +
  `.conflictLine + .conflictLine` 的 border-top 分隔），长 JSON 用 `overflow-wrap: anywhere` 折行。
  **可见的行内标签不是 host 标记**，而是字典文案：`import.conflicts.detailCurrent` / `detailImported`
  （zh「当前 / 备份」、en「Current / Backup」）—— 与代码一致（`ConflictList.tsx` 直接 `t(...)` 渲染，
  host 的 `current=` / `imported=` 永不显示），改文案只改字典。
  **不再用 `<pre>`**：`white-space: pre` 会让长配置横向溢出、出现左右滚动条。
  注意 `.conflictDetail` 亦被 `SyncConfirmView` 的 `<details>` 复用（该处非 pre，不受影响）。
- **一键同步差异确认弹窗**（`SyncConfirmView`，2026-10-04 排版收敛）：
  - 顶部**两行**：状态 Banner（需人工决策 / 差异数）→ `.statRow` 徽章行（兼容性 + 差异数 + 采用数 +
    告警数，兼容性徽章并入本行，不再独占一行）；下面两行 `.hint`：勾选语义、**列表范围**
    （`syncflow.listScope`：列表逐项确认 N 项 / 其余 M 项自动采用 —— 摘要徽章统计全量差异、
    列表只渲染需人工决策项，必须把这个差集说出来，否则「共 57 项差异」而列表只有 1 行无解释）。
  - 批量按钮（`.actionRow`，**全部 ghost**）与说明文字**各占一行**：primary 只留给弹窗底部的「确认导入」；
    说明与按钮同排时换行位置随按钮文案乱跳。
  - 列表行 `.confirmItem`（分隔线代替间距，末行不画线）：首行 `.confirmItemHead` = 勾选 + 类型标签 +
    级别徽章 + `.confirmItemDesc`（`flex:1 1 200px` + `overflow-wrap:anywhere`，占满剩余宽度并允许折行）；
    冲突的解决方式（`.conflictItem`）**另起一行**（`.confirmItemHead + .conflictItem` 补 8px 上边距）——
    此前整条挤在一个 flex 行里，描述被压成窄列、勾选框被撑高的冲突块顶到垂直居中。
  - 判定与数字全部来自 `src/client/sync/sync-view.ts` 的纯函数（`reviewItems` / `isListedItem` /
    `confirmListSummary` / `hasBulkDecidable`），组件只装配。
- **路径映射**（`PathMappingForm`）：每条 issue 一块 `.pathRow`，**纵向**堆叠 ——
  「原路径」块（标题 + 等宽路径 + kind）在上、「新路径」块（标题 + input）在下，各自整宽。
  两个块内的标题用块级元素（`.fieldLabel` 无 display 时是行内元素，会与 input 挤同一行）；
  `.pathValue` 须 `white-space: pre-wrap`（长路径折行）。
- **迁移前咨询卡**（`ConsultCard`）：`.consultSection` 包裹「将应用 / 评分维度」两个小节
  （小节间距 10px）；「建议依据」用 `.reasonList`（`flex-basis: 100%`，在 `.banner` 的
  flex+wrap 中独占整行）+ `.reasonLine`（每条一行，重复项以 `×N` 徽章标注，去重见
  `consultReasonGroups`）。`.consultScroll` 带左右 6px 内边距 —— **评分维度行的徽章胶囊
  原本紧贴容器左边框**（实测 inset 仅 1px，即边框本身），必须留内边距。
  - **咨询是独立一页（2026-09，用户要求）**：导入预览拆成两页 —— 第 1 页「迁移前咨询」
    （`ConsultCard` + 「下一步：选择要导入的内容」），第 2 页才是内容选择面板（`ContentPicker`）。
    结论徽章旁恒显示**硬阻断 N 项 / 需处理 N 项**两个计数（`consult.blockers` / `consult.attention`），
    让「为什么是 review / block」可直接核对，而不是只有一个分数 —— 用户实测抱怨过
    「健康评分 89 / 建议：阻止执行」这种自相矛盾的展示（根因：结论曾由分数阈值决定，
    现在只由证据决定，见 `src/core/migration-consult.ts` 的 `HARD_BLOCKER_CODES`）。
- **导出页（Export）**：工具栏（末尾是 `export.hint` 的 ⓘ）→ **安全选项**（`.groupLabel` = `export.security`）→
  **命名行**（`.groupLabel` = `export.naming`）→ 进度/报告 → **「本次将导出」构成卡**
  （最后一个数据块，`Card.fillViewport` + `.compositionViewport` 内滚；合计口径与选择器 footer
  同源 = 同一个 `pickerSummary`，构成行只列真正会导出的分区）。
  - **模式提示不再常驻**（2026-10 ⓘ 迁移，见 §7）：`export.hint`（默认导出推荐分区 + 去哪儿调整勾选）
    已从页面正文收进工具栏 ⓘ（`ExportView.tsx` 工具栏末尾），首屏不再有那一行提示。
  - **分组标题（UI-11）**：两组输入区（安全选项 / 文件名与备注）外观相同，必须各有分组标题，
    否则读不出边界；文件名与备注的规则说明（UI-12 的 `export.fileNameHint` / `export.noteHint`）
    已收进字段标签旁的 ⓘ —— **常驻的只有非法时的 `.formError`**（`export.fileNameInvalid`，KEEP ①，
    它本身重申了允许的字符集）。UI-12 的「先说明规则后报错」随之改写为「出错时由错误文案重申规则」。
  - **并排字段间距（UI-21）**：`.secretFields` 双列栅格内的 `.field` 归零下边距
    （`.secretFields .field { margin-bottom: 0 }`），分组说明行用 `.groupHintRow`（10px）
    —— 不得用内联 `style` 覆盖（AGENTS.md：style 属性只允许极小修补）。
  - 该卡承担 Canvas 纪律（消灭底部空洞），且**恒常渲染**：无勾选时块内显示
    `export.compositionEmpty`（「无内容可导出」本身就是需要用户看到的状态，整块消失 = 空洞回归）。
  - **未读取的分区不显示 0**（F-03）：`SectionComposition` 的行带 `state`（loading / failed），
    未读到的行显示 `读取中…` / `读取失败 · 将整体导出` + 体积 `—`；只要存在未读取分区，
    合计改用 `export.compositionPartial`（「已读取 … 约 …（含未读取分区，实际不少于该值）」）。
    勾选状态是唯一事实（无「快速/自定义」第二套流程）。
- **导入向导**：6 阶段 Stepper + 分步页面；导入执行页含命令日志面板（`.logPanel`，
  智能贴底滚动 + 「↓ 新输出」提示）。稀疏步骤（选择 ZIP）用 `.sparseFill` **顶部对齐**
  （`justify-content: flex-start`）：内容贴顶、紧跟步骤条，不再垂直居中悬在页面中段。
  - **步骤条的阶段输入（2026-09 修复）**：向导 `step` 一旦进入 `importing`/`result`，它就压过
    `phase`（规则 = `ui/import-stepper.ts` 的 `importStepperSource`）。原因：`phase` 会**停在最后一道
    闸门 `confirm`**（向导流程不回退，也没有「执行/完成」这两个 `FlowPhase`），只看 `phase` 会让
    步骤条在执行中与导入完成后都卡在「4 确认」——用户报告的原始现场。
  - **执行日志面板（.logPanel，2026-09 可读性改造）**：宿主 `RunRegistry.log` 是扁平行流水
    （`▶ item` / `$ dsh plugin …` / `✓|⚠|✗|–|⏭ item`），由纯函数 `ui/import-log.ts`
    （`buildImportLogModel` / `filterImportLogEntries`）**按 itemId 合并成一条记录**：状态行
    按级别着色（`.logLine[data-level='fail'|'warn'|'ok'|'skip'|'running']`），命令与说明缩进为
    `.logDetail`（`data-kind='command'|'text'`），表头显示计数（`.logCounts`：
    成功/跳过/警告/失败）并提供 `.logFilterButton`「只看问题」（警告+失败+进行中）。
    组件在 `import/ImportLogPanel.tsx`；两条脱敏登记点随之指向该文件
    （`plan-text-redaction.test.ts` 的 `import-log-*`）。
  - **结果页布局纪律（用户报告「导入完成后没有完成按钮」）**：结果正文（报告卡 + 收尾清单）
    独占一个滚动区 `.resultScroll`（`flex: 1 1 auto; min-height: 0; overflow-y: auto`），
    收尾操作栏 `.resultFooter`（`flex: none`）固定在底部。**不得**把报告卡与操作按钮放在同一个
    受挤压的 flex 列里：`.reportView` 是 `overflow: hidden` 的 flex 项（自动最小尺寸为 0），
    被压缩后会把底部的动作行**整行裁掉** —— 特征现象是「内容都在、按钮凭空消失」。
    同类清单（收尾清单 `.nextStepsList`）按 §第 8 条限高内滚，避免把结果页撑成长页。
  - **导入结果报告（2026-09 结构化）**：`ReportView` 的 import 分支渲染
    总览徽章（`importTotals`：✓/≈/⚠/✗ 四个数）+「需要你关注」清单（`importProblems`：
    分区 + 计划项 id + 原因，限高内滚）+ 分区明细（`importSectionStats` + `sectionLabeler(t)`，
    不再让用户看见 `pluginFiles` 这类适配器 id）+ 回滚块 + **完整文本报告**（`<details>` 渐进披露，
    仍走 `renderImportReport` 过 `redact()`）。分区显示名走 `report.other` 兜底未知前缀。
    **动作按钮不在报告卡里**：导入的收尾动作（完成/重试）属于向导的 `.resultFooter`。
  - **空选择守卫（UI-05）**：预览步勾选被清空时，`Banner kind="warn"`（`import.nothingSelected`）
    就地提示并禁用「下一步」，确认页的「确认导入」同样禁用 —— 与导出侧 `nothingSelected`
    同一套语义（空选择不推进、也不允许执行成一次「成功但什么都没做」的导入）。
  - **补录密钥页是受控表单（UI-06）**：输入值直接来自 store 的 `secretInputs`（组件不持有输入
    状态），单字段改动经 `mergeSecretInput`（`src/ui/import-wizard.ts`）合并 ——
    该页可来回切换、组件会卸载重挂，**看到什么就提交什么**；否则会出现「回到该页输入框全空
    但旧值仍被提交」与「编辑一个字段丢掉其它 ref 的值」。
  - **确认页（UI-13/UI-14）**：提示语随「失败时整体回滚」勾选状态切换
    （`import.confirm.warning` / `import.confirm.warningNoRollback`）—— 复选框可取消，
    取消后仍承诺「失败时整体回滚」是自相矛盾的文案。确认页同时给出一行
    「将导入 N 个分区 · M 个条目」（`picker.summaryImport`，与预览步选择器**同源**）
    + 被取消项数（`import.excludedByUser`）：最后一道闸门必须能核对。
  - **路径映射页是中性提示（UI-18）**：留空 = 跳过该路径是合法操作且不拦截「下一步」，
    因此计数横幅用 `Banner kind="info"`（文案含「留空将跳过」），**不用 warn** ——
    黄色横幅在首屏会被读成「出错了」（§9 anti-pattern 3），与相邻「解决冲突」页的
    「未决策则禁用下一步」行为刻意不同。
- **配置市场 · 条目导入审阅（MarketImportReview，2026-09）**：浏览条目详情 与「我的配置 → 装回本地」
  **共用同一个组件**（两处此前各写一套平铺分区批准表 + 导入执行 —— 即 AGENTS.md 明确要消灭的
  「同样的勾选框不一样的行为」）。
  - **页面级分步向导（P1 分步 + P2 换载体，2026-09 用户要求）**：`预览 → 选择内容 →（冲突）→ 确认 → 结果`，
    步骤条复用 `Stepper`（`.wizardStepperRow`），步骤序列由纯函数 `marketReviewSteps(hasConflicts)` 给出
    （**有冲突才有「冲突」步**），`nextMarketStep` / `prevMarketStep` 负责前后移动（首尾夹紧）。
    起因是实测 3 分区 / 61 个计划项：「警示 + 级联树 + 逐项摘要 + 冲突 + 按钮」同屏会出现
    **三重滚动**（弹窗自身 + 树内滚 320px + 摘要内滚 380px）。
    **载体是页面，不是弹窗（P2）**：市场侧「列表 → 点「查看详情」→ 免责确认 → 进入向导页」，
    我的配置侧「已上传列表 → 装回本地 → 进入向导页」；两侧都由父页给出**页头 = 标题 + 返回列表**
    （`.headRow` + `Button`），列表视图整块让位（我的配置侧用提前 return 实现，所有 hooks 仍在
    提前 return 之前声明）。Tab 栏（浏览市场 / 我的配置）保留，随时可切走。
  - **步内内容区的高度（2026-09 用户要求，自适应版；2026-10-04 修正 shrink）**：`.marketReviewPage`
    （`flex: 1 0 auto; min-height: 200px`）吃满 `.viewBody` 的剩余高度；**所有步骤的内容区共用同一条高度规则** ——
    `flex: 1 1 auto; min-height: 200px; max-height: 800px; overflow: auto`，适用对象是
    「预览 / 冲突 / 结果 / 确认」的 `.marketReviewScroll` 与「选择内容」的
    `.marketReviewPage .pickerList`（**不改导出页选择器弹窗与导入页的既有规则**）。
    要点：① 高度**随可用空间自适应**，200px 是硬下限（选择步的树曾因纯 flex 收缩压到 ~85px）、
    800px 是上限（超长内容不把步骤撑爆）；② 外层 `.marketReviewPage .pickerRoot` 保持
    `flex: 1 1 auto` 且**不写 `min-height: 0`** —— 保留 flex 项的自动最小尺寸（= 内容），
    否则空间不足时树会溢出根盒、把底部按钮顶到重叠位置；③ 空间不足时**整页由 `.shellMain` 滚动**
    （溢出的后代内容仍可达，不会被裁掉）；④ **`.marketReviewPage` 的 `flex-shrink` 必须为 0**
    （`flex: 1 0 auto`）：shrink:1 会在空间不足时把本页压得比内容矮，内容**视觉溢出**自己的盒子，
    最后一行按钮正好盖住 `.viewBody` 末尾那块 8px 呼吸区 —— 表现为「上一步 / 下一步」贴住底部
    状态栏、零间距（2026-10-04 用户实测截图定位）。
  - **分区小结的行间节奏**：小结卡片复用冲突卡的 `.conflictItem` + `.conflictHead`，**必须**包在
    `.conflictList` 容器里 —— 间距由容器的 `gap: 8px` 提供，`.conflictItem` 自己不带上外边距，
    直接并排会贴在一起（2026-09 实测反馈）。
  - **逐项摘要降维（同一批条目只渲染一遍）**：摘要不再铺 61 行，而是`marketSectionSummaries` 的
    **分区级小结**（一行一个分区：分区名 + 已选 n/m 个条目 + 将改动 / 已一致 + 高风险徽章）；
    逐项信息回到树上 —— `ContentPicker.unitBadge(section, unitId)` 在单元行渲染
    「将改动 / 已一致 / 不导入」。三处判定同源：`marketUnitIndex` / 筛选 / 执行都读同一个
    `isPlanItemExcluded`。
  - **选择步筛选**：复用 `Segmented`（全部 / 将改动 / 高风险 / 未勾选，带计数）。
    **筛选只影响渲染**，不改变勾选语义：`selectAll` 本来就作用于当前可见集合；
    不可细分分区（`units: []`）在任何筛选下都保留 —— 它没有单元可判断，藏起来只会让人以为分区消失。
  - **风险默认态与导入页一致（用户 2026-09 决策）**：默认**全选**（含 plugins / mcp / agentPresets /
    agentInstructions 等高风险分区），原「高风险分区默认不勾、须逐项批准」（`MarketApprovals` 布尔批准表）
    已删除。风险改由三层承担：**就地警示**（已勾选的高风险分区名 + 后果，`review.highRiskHint`）、
    进入向导页前的**免责确认**、以及**导入前快照 + 导入后一键回滚**。
  - **冲突决策**：决策变化后由**宿主重算计划**（`createImportPlan`，与导入向导 `execute()` 同一路径），
    **不在前端改 `planItem.kind`** —— 那等于把 `analyzer.applyItemResolution` 抄一份进 UI。
    未决策的冲突按「保留本机」处理（引擎记为 skipped，不覆盖）。
  - **回滚入口**：`ImportResult.snapshotId`（引擎在导入第一步创建）非空时给 `variant="danger"` 按钮，
    `ConfirmDialog danger` 二次确认后调 `restoreSnapshot(id, false)`，结果列恢复/卸载/失败计数；
    **没有快照就如实说明「无法回滚」，不给假入口**（结果步里呈现）。
  - 状态归属：勾选（`selectionState`，绑 `zipPath` 失效）与冲突决策（`conflictResolutions`）进
    run-store 市场切片（切 tab / 刷新不丢）；旧持久化载荷缺这两个字段时回落默认（全选 / 无决策）。
    **步骤与筛选是纯瞬态**（组件自持，刷新回到第一步 —— 勾选与决策不丢）。
- **事故恢复**：仅在 `recoveryRequired === true` 时显示红色 SAFE MODE 横幅；
  正常态（无待处理事项）不渲染任何横幅——「已恢复正常，可继续操作」绿灯提示已移除
  （恢复成功后的确认由操作结果本身承载，常驻绿灯属冗余噪音）。
- **档案（Profiles，2026-09 语义替换）**：页面 = **DSH 自带 profile** 的管理器
  （`$DSH_HOME/profiles/<name>`），不再是插件自有的「配置快照」。四段垂直结构：
  ①**运行状态卡**（`.kvRow` 显示当前 profile；下接**在跑的实例**清单 —— 数据源是「台账 ∪ 心跳」的合并视图，
  所以手动 `dsh web` 起来的实例也在这里：每条 = 档案名 `.mono` + 「端口 N」（心跳没端口就省略）+ 来源标签
  （`当前实例` / `本插件启动` / `其他实例`）+ `打开`（`Button href` 新窗口，**只有本插件启动的才有带 token 的 URL**）
+ `停止`（**当前实例禁用**：停自己会死在响应途中，tooltip 指向「关窗口」）；没有实例时一行 `.hint` 说明
  「点档案行的启动会另起一个独立实例」）；**没有实例 = 空态提示，绝不显示悬空的「下次启动」标记**
  （2026-09 移除：DSH 根本没有「默认 profile」状态，那个标记只会让用户以为切换成功了）；
  卡下是**启动/停止的反馈横幅**：非 web 形态被点「启动」→ `Banner kind="warn"` + 等宽终端命令
  `dsh --profile <name>` + 复制（**不静默失败**：发按钮却不告诉用户为什么不行最糟）；
  新实例就绪 → `Banner kind="ok"` + 「打开新实例」+ 复制带 token 的 URL；未就绪 → `Banner kind="warn"`
  + 逐条告警 + 日志路径（`.kvRow` + `.mono`），绝不谎报成功；
  ②**新建卡**（name `.input` + 模板 `.select` + primary 按钮，非空即内联 `.formError` 校验）；
  ③**列表**（`.listHeaderRow` = 标题 + `profiles.list.hint` 的 ⓘ + 统计 + 刷新 —— 2026-10 ⓘ 迁移后
  **不再下接一行 `.hint`**；同一键仍保留在行内可点信息区的 `title=`（KEEP ⑥ 防截断全量提示）；
  行 = `.profileRow` 内 `.profileRowHeader`：左为**整块可点信息区** `button.profileRowMain`（两行：
  `.profileRowTitle` = 档案名 `.profileRowName` + `.badgeRow` 徽章组（当前运行 / `:端口 运行中` / 形态 / 损坏），
  `.profileRowMeta` = **计数摘要**「N 个层 · patch M 条 · 依赖 K」+ node_modules + patchReload + 更新时间），
  右为 `.actionRow[data-inline]` 操作组（**启动 / 停止 / 当前运行** 三态之一 / 复制 / 重命名 / danger 删除）；
  **同一个位置按运行状态换形态**（判据 `profileRowAction`，UI 不得各写一份）：该档案没有实例 → `启动`
  （primary，唯一真正生效的切换动作，见 README「档案」节的根因说明）；有实例在跑且**不是自己** → `停止`
  （ghost，先 `ConfirmDialog`：本插件启动的说「会中断那个实例里的会话」，别的实例/手动启动的说「停止会关闭那个实例」）；
  **就是当前这个实例** → `当前运行`（禁用，tooltip 指向关窗口）——**绝不给第二次「启动」**（同名多开是用户报过的 bug）；
  **进行中态是页面级状态**（`launching/stopping/creating/renaming/deleting` 住在 run-store 的档案切片里，见 `AGENTS.md` 状态管理）：
  按钮就地换成 `Spinner`（`启动中…` / `停止中…` / `创建中…`），同一时刻其余启动/停止按钮一律 `disabled`；
  **切页签（组件卸载重挂）不丢**（模块级单例 + 订阅），**刷新不恢复**（发起请求的页面已随刷新销毁——重放一个等不到回执的转圈只会骗人）；
  启动回执横幅（带认证 URL）同理只在内存，须由用户点「关闭」收起；
  **复制档案**（行内 `复制`，源档案在跑也能复制）→ `ConfirmDialog`：副本名 `.input`（预填 `suggestCopyName` =
  `<name>-copy`，被占用顺延 `-copy-2`…；超长只截前缀，免得一打开就吃 tooLong）+ 源档案有 node_modules 时给
  `Checkbox`「同时复制 node_modules」（默认勾选；`.hint` 如实写代价：与源档案同体积、实测 285 MB ≈ 30 秒；
  不勾选则只搬清单与 patch、秒级完成）；回执走 `Banner`：无告警 `ok`，缺依赖 `warn` + 安装命令
  `dsh plugin --profile <副本> install` + 复制按钮（**副本不能启动必须当场说清**，不静默成功）；
  **行内绝不铺开包名清单**：web 档案 13 个 bundle 名的实测回归会把元信息挤成窄列；
  完整清单只在详情弹窗展开（`profileRowFacts` 只给计数）。
  ④**详情弹窗**（`.detailLines` 逐行列 bundle 层（带序号 = patch 应用顺序）与依赖（按包名排序），
  概览徽章组给形态 / 层数 / patch 条目与体积 / patchReload / node_modules / 更新时间 + 目录 kv +
  损坏告警；其后是只读原文：`package.json` 与 `cordis.patch.yml` 进 `.reportScroll` + `<pre class="reportText">`，
  **两处原文均先过 `redact()`**，见 §7）。
  - 新增原语类：`.listHeaderRow`（表头行：`.groupLabel` 归零下边距、`.cellMeta` 占余宽）、
    `.badgeRow`（`inline-flex; flex: none`，徽章不与档案名抢宽）、`.actionRow[data-inline]`（同排操作组，去块级外边距）、
    `.profileRowTitle` / `.profileRowName`（名字省略，徽章不压缩）、`.profileRowMeta`（单行省略的计数摘要）、
    `.detailLines`（详情弹窗内清单：flex column + 等宽）。
  - 删除 = **物理删除目录**（含 node_modules，不可恢复）→ `ConfirmDialog danger`；目标为当前运行中的
    profile 时额外渲染 `Checkbox`（`profiles.deleteCurrentConfirm`），未勾选点确认只就地报错、不执行。
  - 旧的「切换预览」弹窗（计划项 diff + 咨询卡）随该功能一并移除；
    `ConsultCard` 仍在导入向导使用。

- **离线救急台（`dcm web`，2026-10，独立于 DSH 设置弹窗）**：这是**唯一不挂在 DSH GUI 内的界面** ——
  DSH 都起不来时它要在浏览器里可用，所以它**不消费 `--dsw-*` token、也不走 CSS Modules**：样式内联在
  `src/cli/web/page.ts` 的 `STYLE` 常量里，由**服务端直出 HTML**（零脚本、零外链；CSP `default-src 'none'`）。
  仍遵守本文件的精神与结构：
  - **颜色仍按语义命名**（`--fg/--muted/--bg/--card/--surface/--line/--accent/--accent-hover/--on-accent/--ok/--warn/--bad/--scrim`），
    并给出 `prefers-color-scheme: dark` 暗色一套 —— 因为 DSH 的 token 在这里不存在，只能自带；
    token 的**语义**与本文 §3 对齐（ok=成功、warn=需注意、bad=危险/失败）。
  - **救急台的设计系统有外部出处（2026-10）**：亮色取 **IBM Carbon**（`docs/design/reference/ibm-DESIGN.md`）的语义四色与 surface 画布，
    暗色取 **Raycast**（`docs/design/reference/raycast-DESIGN.md`）的 surface 阶梯与语义 accent。逐条映射、只取的四节、
    以及**全部偏离记录**在 `docs/design/2026-10-04-cli-rescue-console-carbon.md`。四条硬约束：
    ① **处方角**（一律 `border-radius:0` —— Carbon 的「半径为 0 才是品牌」，胶囊 chip / cov 一并改方）；
    ② **文字色取「能读的那一档」**：Carbon 的 `#24a148` / `#f1c21b` 只做填充，正文用 `#198038` / `#8e6a00`（AA 对比度由 `web.test.ts` 的 R3-02 逐对钉住）；
    ③ **层级只用 surface 变化 + 1px hairline，禁止阴影**（Carbon 的 do/don't）；④ 字体仍走**系统栈（含中文字族）**，
    绝不外链字体或任何资源（CSP `default-src 'none'` 不变，R3-01/R3-02 双守卫）。
    ⑤ **三态主题（自动 / 浅色 / 深色，2026-10）**：页头品牌行右侧的三方按钮，选中态用 `--surface` 填充 + `aria-pressed` 表达；
    载体是 **cookie `dcm-theme`（非敏感、`SameSite=Lax`、1 年）**—— 救急台每次启动换随机端口，只有 cookie 不区分端口能跨次记住，
    且 R1-01 明确禁止该脚本使用 `localStorage`；脚本因此从 `<body>` 末尾移到 `<head>`（`data-theme` 必须在首帧前落地，否则强制主题会闪）；
    **无脚本时整组隐藏**（`:root[data-dcm-js="1"]` 才显示），页面回落「自动跟随系统」= 改造前的行为；
    暗色 token 刻意写两次（媒体查询 + `[data-theme="dark"]`）并由 R3-02 断言**逐字相同**（防漂移），详见设计文档 §8。
  - **结构 = 页头（品牌 + 版本 + 只读徽章 + 页签 + 路径事实行）→ 内容区（每块一个 `.card`）→ 页脚（CLI 等价命令清单）**；
    页签为八个（首页 / 磁盘占用 / 会话体检 / 档案与实例 / 恢复 / 导出 / 解锁 / 重装）：**每组页签对应一类
    明确动作**（看 / 修 / 救 / 装），首页只放动作卡与能力边界，不重复渲染各页内容。
  - **状态一律横幅优先**（`.banner.ok|warn|bad`）：SAFE MODE 激活 / 状态无法判定 / 有项目读不出来，
    必须在页面顶部先说，再谈数据；「正常」用 `ok` 横幅明确说出口径（不靠「没有红字」暗示）。
  - **表格是主数据结构**（`.card` 内的 `table`）：等宽列用 `td.num`（`tabular-nums`），路径/ID 用 `code`；
    镜像本文件的两条纪律 —— ① **读不到的不显示 0**（磁盘子区未统计就写「未统计（读不到）」，
    会话体检必须显示「未做深度校验 N 条」）；② **未体检 ≠ 没问题**，「另有 N 条未检查」必须常驻。
  - **每个动作给等价 CLI 命令**（页脚 + 相关卡片）：即使有了写按钮也恒给命令行等价入口 —— 出问题时用户至少能复制走。
  - **写动作 = 两段式（计划 → 确认 → 结果），页面无脚本**（2026-10 阶段 2）：确认页与执行页是两个独立请求，
    靠 `<form method="post">` + **一次性 action token**（hidden input，用过即废，重复提交 400）串起来。三条呈现纪律：
    ① **先给计划再给按钮**（会话修复页展示与 CLI 同源的逐条步骤表；磁盘页给出「可回收 / 已超期」字节数）；
    ② **副作用写在按钮上方**（`.consequence` 块，先读后点）；③ **结果页逐条如实**（`.resultList`；被安全门拒绝时
    写清门名与原因，绝不出现「已成功」而实际没做）。危险动作用 `.btnDanger`（描边红），普通动作用 `.btnPrimary`。
  - **页签为四个**（首页 / 磁盘占用 / 会话体检 / 档案与实例）：档案页是「实例启停」的唯一入口，
    每个可启动档案一张确认卡、不可启动的写清原因（桌面端独占 / 非 web 形态 / 已在运行）；
    运行中的实例给「停止」卡，并区分 `本插件启动` 与 `外部实例`（后者按心跳 pid 停）。
  - **高危动作的摩擦是设计的一部分**：重装页的确认码**只在终端打印**（页面里搜不到），
    颜色上整页用 `banner bad` 起头；恢复页先渲染**零写入的计划表**再给执行按钮。
    摩擦不能省 —— 这两件事的失败代价是「DSH 没了」，而救急台本身是给「已经出问题」的时刻用的。
  - **展示文本一律先 `redact()` 再转义**（`page.ts` 的 `esc()` 是唯一出口）：救急台会渲染磁盘路径、
    日志尾部与失败原因，里面可能夹带 `"apiKey": …` / `?token=…` —— §7 的纪律在插件 UI 之外同样适用。
  - **页签为四个**（首页 / 磁盘占用 / 会话体检 / 档案与实例）：档案页是「实例启停」的唯一入口，
    每个可启动档案一张确认卡、不可启动的写清原因（桌面端独占 / 非 web 形态 / 已在运行）；
    运行中的实例给「停止」卡，并区分 `本插件启动` 与 `外部实例`（后者按心跳 pid 停）。
  - **展示文本一律先 `redact()` 再转义**（`page.ts` 的 `esc()` 是唯一出口）：救急台会渲染磁盘路径、
    日志尾部与失败原因，里面可能夹带 `"apiKey": …` / `?token=…` —— §7 的纪律在插件 UI 之外同样适用。
  - 响应式：`.grid` 用 `auto-fit/minmax(280px)` 收窄即换行；表格允许横向滚动，不做移动端专属布局
    （救急台的使用场景是本机浏览器）。

---

## 7. 文案与安全呈现

- **文案克制（2026-10-12 用户要求；2026-10-21 扩到整页）**：**页面** / 预览 / 弹窗 / 卡片只留**用户要判断或操作**的信息。
  机制、范围、内部判据的解释（「留点时记录了 N 个目录」这类）**不铺陈** —— 要解释就进
  `InfoHint`(ⓘ) 或文档；同一屏不重复同一件事。判据：**删掉这句后用户还能不能做出同样的决定**
  —— 能，就删。
- **页面保持简洁（2026-10-21 用户要求）**：新增页面 / 区块先做减法 —— 功能背景介绍、说明段落、
  重复的区块标签、装饰性副标题**一律不加**；能在既有区块承载的内容不新开区块；每个新增元素
  必须能回答「它改变了用户哪个决定或操作」，答不上来就不加。
- 全部用户可见文案走 i18n 字典（zh 源 / en 镜像；`ConfigManagerKey` 编译校验）。
  - **两套字典各管一段**：React 壳（`src/client/`）走 `t()`（`config-manager` namespace，
    `ConfigManagerKey`）；`src/ui/*` 与 `src/client/common/*` 的渲染器走 `UiT`
    （`src/ui/i18n.ts`，`UiTextKey`）。报告/错误/进度文本属于后者 —— 传给渲染器的
    `t` 必须一路带下去（`renderExportReport(report, t)`），否则英文界面里报告正文会是中文。
  - **动作 id 不是文案**：`suggestedActions()` 之类返回的是动作 id（`done`/`fixIssues`），
    渲染前必须映射到字典键（导入结果页的收尾按钮走 `import.done`），禁止把 id 直接渲染进按钮。
  - **分区显示名**：`SectionId → 文案` 的单一映射是 `common/section-labels.ts`
    （`SECTION_LABEL_KEY` / `sectionLabel(id, t)` / `sectionLabeler(t)`，`Record<SectionId, …>`
    全量覆盖 ⇒ 新增分区忘配文案会编译失败）。导出选择器、导入选择器、兼容性页分区网格、
    分区构成卡一律传同一个 `sectionLabeler(t)`；`ExportFlow.categories[].label` 保留给
    报告/日志等非 UI 场合，**不再**作为界面显示名（同屏术语漂移见 §9 anti-pattern 8）。
    配套：`ExportFlow.validateSelection()` 返回**结构化结果**（`{ valid, unknown, deviceSpecific }`），
    不再拼中文警告文本 —— 纯逻辑层只说「哪些分区有问题」，文案与分区名由展示层走 i18n 组装。
- 错误/报告/历史摘要渲染前 `redact()`；历史条目中的 `[REDACTED]` 在展示层
  可读化为「（文件名已脱敏）」。
- **计划 / 分析文本同样是「展示文本」**（t6 评审登记的 high）：宿主把 `analyzeImport` /
  `export-preview` 的结果直接回传浏览器，`PlanItem.description` / `detail` 可能含**未脱敏的本地明文值**
  （实测 MCP 的 env / headers，如 `env.MCP_TOKEN`、`headers.Authorization`），全仓没有 plan 级脱敏
  —— UI 是最后一道闸门。渲染点必须逐个过 `redact()`：`ConflictList`（description + detail，
  先整体脱敏再 `splitConflictDetail` 切分）、`ImportWizardView` 收尾清单、`ProfilesPanel` 档案原文
  （`package.json` / `cordis.patch.yml` 文本，patch 里可能内联字面量密钥）、
  `SnapshotsPanel` 恢复计划 / 差异查看、`SyncConfirmView`（description / detail / diff）、
  `ContentPicker` 单元副标题（`u.detail`）、市场条目导入审阅面板（`MarketImportReview`：
  逐项摘要的条目名与明细，两处调用点共用该组件故只需登记一处）。
  `ContentPicker` 的**单元名**同样要过 `redact()`：**先脱敏、后中段省略**（顺序不可反 —— 先截断会让
  被切掉的密钥不再匹配值形状模式而漏网），`title` 用脱敏后的值；`ProgressBar` 的 `view.label` /
  `view.detail` / 徽章 label 亦按同一规则处理（评审 G-01 / G-03 登记后已落地）。
  该组渲染点由源码守卫 `src/client/common/plan-text-redaction.test.ts` 钉死，且已按评审 G-09 升级为
  **按渲染点断言**（原先是文件级 `contains`：同文件里去掉某一处 `redact()` 仍会绿灯 —— 例如只断言
  `description`、`detail`/`diff` 裸渲染照样通过）。现在 `RENDER_POINTS` 表里每个渲染点两条断言
  （已脱敏写法**恰好出现 1 次** + 裸写法**不得出现**），并校验每个登记文件都真的 import 了 `redact`
  ⟹ **去掉任意一处 `redact()` 都会红灯**（24/24 逐点变异验证通过，恢复后全绿）。
  维护约定：新增「宿主文本 → JSX」的渲染点**必须**登记进 `RENDER_POINTS`（该表是这类渲染点的单一登记表）；
  本守卫仍是源码级（组件无测试框架），不覆盖运行时行为，也不覆盖未登记的新渲染点。
- 备注等自由文本若编码损坏（全问号）显示「（备注不可读）」。
- 密码/凭据绝不落 sessionStorage、绝不回显（run-store 白名单单一出口）。
  - **导出/备份密码**：仅内存传入，用完即弃。
  - **同步通道的加密/解密密码**（product requirement）：勾选「加密备份」后保存到 DSH credentials
    的独立槽位（值永不进 sync-*.json / 响应 / 日志 / 备份），取消勾选即删除；解密密码只在
    拉取的快照**确实加密**时被使用。UI 只拿得到 `configured` 布尔，据此显示
    「密码已保存到本机 / 留空即沿用」与危险语义的「删除已保存密码」按钮（`variant="danger"`）。
- **字典不留死键**（UI-24）：描述**已不存在交互**的键必须删除或接线；确认死键后再删，
  zh / en 两侧同时删（`Record<keyof typeof zh, string>` 保证键集合一致，漏删一侧即编译失败）。
  刻意例外：`import.conflicts.review` 保留无引用态（`ConflictList` 有注释说明：
  Review 会被收集器计为 unresolved → 「下一步」永久禁用，属死路，故不提供该选项）。
  **`overview.*` 死键清理（评审 G-08，2026-09 已完成）**：删除 16 个零引用键
  （`overview.subtitle` / `overview.loading` / `overview.running` / `overview.quick.{title,export,import,
  exportHint,importHint,syncHint,backupHint,backupFailed}` / `overview.suggest.{title,schedule,sync}` /
  `overview.activity.viewAll` / `overview.location.scheduleOn`，zh/en 同步删）。
  **动态键族必须保留**（复核方法：逐个模板串 + 键类型联合）：`overview.${health.textKey}`
  （`overview.health.*`，4 个）、`overview.kind.${e.kind}`（`KNOWN_KINDS` 的 13 个 + `kind.other`）、
  `overview.metric.<OverviewMetricKey>`、`overview.meta.<OverviewMetaKey>`、`overview.state.on/off`
  —— 这些键在源码里没有 `'overview.x'` 字面量，**不是**死键。
  配套已清理（t15）：`overviewSuggestions()` 及其类型（`src/ui/overview-view.ts`）曾无 UI 消费者，
  随 `overview.suggest.*` 死键一并删除（全仓 grep 确认零引用，含字符串/动态引用；对应单测同步移除），
  `src/ui/overview-view.ts` 不再产出 `overview.suggest.*` 键。

### 聊天内入口：接管 `conversation.chat.node` / user（2026-10-10）

**定位**：本插件在 ui-chat 聊天流里渲染的那条**用户消息气泡 + 「回退」按钮**。它渲染在会话消息流里、不在插件设置页子树内（§1 的 token 挂在 `body` 上本就会继承；`.chatEntryScope` 再就地声明一次，是为了不依赖宿主把聊天流渲染在哪个根下）——
重声明的那一小撮（`--cm-text-1/2/3`、`--cm-surface-2`、`--cm-chat-bubble`、`--cm-line-1/2`、`--cm-fs-*`、`--cm-lh-*`、`--cm-sp-*`、`--cm-r-*` + 2026-10-17 起那组**宿主活值镜像**：`--cm-r-chat` / `--cm-r-act` / `--cm-chat-action` / `--cm-chat-glyph` / `--cm-chat-card-bg` / `--cm-chat-hover-bg` / `--cm-fs-second` / `--cm-fs-card` / `--cm-lh-second` / `--cm-lh-ref` / `--cm-lh-card` / `--cm-lh-meta`），**不新增任何 scale 档位**（间距/圆角新档位必须先改 §3–§5；`--cm-chat-bubble` 是 §3 的语义色，不是 scale 档）。**判据：凡是「宿主自己就是这么写的」的取值，一律以镜像 token 的形式带宿主兜底值落在这里，而不是把数字抄进组件规则**（红色禁令：组件规则里不得出现裸 `--dsw-*`）。其中**字号 / 行高 / 限宽是「宿主活值的镜像」，不是我们的档位**（2026-10-17 issue #93）：`--cm-fs-base` = `var(--dsh-content-font-size,14px)`、`--cm-lh-base` = `calc(22px + var(--dsh-content-font-delta,0px))`、气泡列 `max-width` = `min(calc(var(--dsh-chat-content-width,748px) * .702), 82%)` —— 三条与宿主 `.bubble` / `.userStack` 逐字同式。类清单 = `config-manager.module.css` §15b。

- **接管是唯一路径**：宿主 `conversation.chat.node` 的 `user` key 是 keyed 遮蔽位且**没有 children 表**，framework 没有「往每条用户消息里追加 UI」的位子；我们以 `priority -1` 遮蔽宿主的 `UserMessageNodeView`
  （同一 cell 的同一 priority 再注册会抛，故 -1 是与宿主并存的唯一合法值），并**复刻**那条气泡的外观（宿主组件与其 CSS Modules 是 ui-chat 私有的，不可导入）。图片**必须**走 owner 给的
  `renderMessageImages`（逐张一次调用，与宿主 `attachments.map` 同形），本仓库不自己实现图片渲染。
- **错误边界是 class 组件**（`ChatEntryErrorBoundary`）：React 18 只有 class 能声明 `getDerivedStateFromError` / `componentDidCatch` —— 这是本仓「函数组件 + hooks，无 class」规范的
  **唯一显式例外**，**不得**照此扩大范围。降级 = **纯文本气泡**（`.chatFallbackBubble`，左侧一条警示线 + `data-chat-entry-fallback` 标记 + ASCII `console.warn`），语义是「用户消息绝不消失」。
- **动作行的三颗图标 = DSH 原生的那三颗（2026-10-17 用户要求「复制 icon 和 icon 动画也使用 DSH 原生的」）**：经 `common/host-primitives.ts` 的 `hostIcon()`（**唯一出口**，闭集 `DshIconName`）取 `IconCopyOutlineRegular` / `IconCheckOutlineRegular` / `IconRefreshOutlineRegular`；拿不到（老宿主没有那份模块表 / 未来改名）一律回落本仓库的 `CopyStateIcon`（morphicons）与 `RefreshIcon`（lucide）——**绝不出现空白按钮**。宿主口径（ui-primitives 抽出）：三颗都是普通 `(props) => svg` 组件（`size` 缺省 16、`…OutlineRegular` = 1px 描边、`currentColor`）；宿主的复制反馈是 `IconCopyOutlineRegular → IconCheckOutlineRegular` 的**直接换图**（`.action svg` 没有任何 transition/animation）——宿主图标路径上**不播形变动画**，形变只留给回落路径的 `CopyStateIcon`。
- **入口 = 只有图标（icon-only，2026-10-10 用户第二条要求）**：复用 `.chatActionBtn` 24px 无边框图标位 + `RefreshIcon`，与时间戳 / 复制图标同一行；**按钮内不得出现可见文字标签**，文案只走 `aria-label` / `title`。语义 = ghost（回退不是删除，不用 danger）；禁用原因走原生 `title`（`InfoHint` 的 Portal 钉在插件设置页根节点，聊天区不存在）。
- **差距 ①② 已于 2026-10-15 收回**（生态既有做法：宿主模块表可以 `require` 到 ui-primitives，见下方那一条）：① 引用 / 技能 chip —— 正文交给宿主自己的 `projectUserText`（`openFile` / `openSkill` 在时可点开）；② 文件类型图标 —— 用宿主 `FileTypeIcon`，拿不到才回落 `.chatFileExt` 扩展名徽标。
  **2026-10-17（用户要求「与 DSH 原生气泡完全一致」）：上一版登记的近似档全部收回** —— 圆角 `--cm-r-3`=8px（宿主 `--dsw-radius-xl`=**20px**，旧注释里的「14px」是错的）、动作行 24px（宿主 28px+delta）、时刻 11px（宿主次级 13px 档）、附件行 gap 4px（宿主 8px）、文件卡「小 chip」（宿主 240×64 卡）、`.chatBubble` 的 `display:flex` 列（宿主是**块**，flex 会把技能/引用 chip 挤成独立行）。现在这些位置**逐值消费宿主的同一条变量**：`--cm-r-chat` = `var(--dsw-radius-xl,20px)`、`--cm-r-act` = `var(--dsw-radius-sm,8px)`、`--cm-chat-action` = `calc(28px + var(--dsh-content-font-delta,0px))`、`--cm-chat-glyph` = `calc(15px + …)`、`--cm-chat-card-bg` = `var(--dsw-specific-input-major,transparent)`、`--cm-chat-hover-bg` = `var(--dsw-alias-interactive-bg-hover, …)`、`--cm-fs-second` = `var(--dsh-content-font-size-secondary,13px)`、文件卡 `240px / min-height 64px / padding 8px 12px / gap 10px`；**动作行的显现语义**也照抄宿主（`:is([data-chat-flow-kind=user],…):has(~ :is(…)) ⟹ 默认 `opacity:0`，`:hover`/`:focus-within` 才显）—— 即「后面还有用户消息的那几条默认收起，最后一条常亮」。
  **仍未做（如实登记）**：③ 时间**文案**只显示时刻、不做宿主那种「今天 / 昨天」自动切换（需要宿主 `clock.*` 词典，我们没有）；④ rest 块的 `JsonBlock` 外观仍是我们的 `<details>`；⑤ 无宿主同款 tooltip；⑥ 崩溃降级只保留正文。宿主 `--dsw-radius-*` 档位（ui-theme 抽出）= xs 4 / sm 8 / md 12 / lg 16 / xl 20 —— 镜像 token 一律写宿主兜底值，宿主换档时自动跟随。
- **字号 / 行高 / 限宽跟随宿主的「内容字号」而不是我们的字号档（2026-10-17 修 issue #93，收回上一版登记的「正文 12.5px 近似档」）**：宿主 `.bubble` = `font-size: var(--dsh-content-font-size,14px)` + `line-height: calc(22px + var(--dsh-content-font-delta,0px))`，`.userStack` = `max-width: min(calc(var(--dsh-chat-content-width,748px) * .702), 82%)`（三处取值都是**从本机 `app.asar` 抽出的宿主产物**，见 `docs/spec/known-gaps.md` G-39 增量（七））。
  我们此前写死 `--cm-fs-base: 12.5px` + `line-height: 1.5` + `min(620px, 82%)` —— 那不是「近似」，而是**用户设置完全失效**：DSH 的「内容字号」（10–22）对用户自己发出的消息没有任何作用（真机 21px 下助手正文字形高 19px / 气泡 11px，比例 0.58），且换行位置与宿主不一致。
  `--cm-fs-meta` 11px 档仍在（扩展名徽标等我们自己的小字）；但**时刻 / 引用行 / 文件卡上屏文字已改成宿主的档**（`--cm-fs-second`、`--cm-fs-card`、12px 元信息），见上面 2026-10-17 那一条。护栏 = `src/client/chat/chat-entry-view.test.ts` 的两条：①「气泡字号/行高/限宽跟随宿主内容字号」；②「气泡与动作行逐值对齐宿主：圆角 xl(20px) / 内边距 10·16 / 动作行 28+delta / 文件卡 240·64」。
- **气泡底色不再算近似档（2026-10-15，用户报「浅色主题下气泡看不见」）**：宿主的用户气泡底是 `--dsw-specific-bubble`，本仓库 token 层此前没有这一档，于是借用了 `--cm-surface-2`（= `--dsw-alias-bg-layer-2`）
  —— **浅色主题下它 = `#fff`，而页面底 `--dsw-alias-bg-base` 也是 `#fff`** ⇒ 气泡与页面同色、用户消息看起来「没有气泡」（深色下两者恰好同为 bluish-850，所以只在浅色暴露）。
  现在新增 `--cm-chat-bubble`（§3 表）指向宿主那一档，带 `--dsw-alias-bg-layer-2` 兜底：宿主换主题/换档时自动跟随，宿主删档时不至于变透明。
  **同轮把文件卡描边也对齐到宿主那一档**：`.5px` + `--cm-line-2`（= `--dsw-alias-border-l2`，浅色 ≈10% 黑；此前用 `--cm-line-1` = ≈4% 黑，比宿主淡一档），`.chatEntryScope` 据此补声明 `--cm-line-2`。
- **宿主原语复用（2026-10-15；全仓唯一入口 `src/client/common/host-primitives.ts`）**：正文与文件图标**优先用宿主自己的** `projectUserText` / `FileTypeIcon`（ui-primitives），
  这样会话引用 / 技能 chip 与文件类型图标天然与 DSH 同款（G-39 差距①②据此收回）。**只能是帧内惰取 + try/catch + 回落**：该包由 DSH shell 的模块表作为 static module seed 预置（较新宿主才有），
  顶层 `import` 会被打包器改写成模块体顶层的 `require` —— 老宿主一抛就是**整个浏览器半加载失败**（设置页一起没）。取证：生态里 dsh-reedit / dsh-better-sidebar / dsh-agent-teams / dsh-mnemon 都这么做；
  本仓 `RollbackFileIcon` 自 2026-10-12 起也这么做。回落链：正文 → 我们自己的 `projectChatEntryText` 纯文本投影；图标 → `.chatFileExt` 扩展名徽标 → 本地极简 SVG。白名单登记 = `src/utils/bundle-scan.ts`。
- **key=user 是单占位：别人先占就让位（2026-10-15）**：`conversation.chat.node` 是 keyed 遮蔽位，语义是「**最低的 priority 渲染**」，而该 key **没有 children 表**
  ⇒ 两个插件**不可能**同时渲染同一条用户消息（框架层不支持）。因此登记前先读 `ctx.slots.entriesOfSlot` 的赢家：若它比我们（-1）更低，**让位并打一条 ASCII 告警**（不抢格、不静默 —— 静默失效是框架默认行为）；
  同优先级冲突仍由登记处的 `try/catch` 兜住（宿主会抛错并点名占用者）。老宿主没有 `entriesOfSlot` 时不做探测，行为与之前一致。
- **只有一种形态：每条用户消息一颗**（2026-10-12 用户要求）：**「整回合」档整体删除** —— 偏好模块 `chat-entry-pref.ts`（含 localStorage 键 `dcm.chat-entry-mode`）、同源挂载 `chat-entry-mount.ts` 与回合尾入口组件 `RollbackTurnEntry.tsx`（槽位 `conversation.chat.turnTail`）一并下线，设置页回滚卡上那颗两档开关（`.rollbackChatEntry` + `Segmented`）与 `rollback.chatEntry.*` 五个键同步删除。
  装配点因此退回最简形态：`ctx.slots.inject(CHAT_NODE_SLOT, () => registerChatNodeEntry({ probe, register }))` —— 单入口没有「切档互斥」问题（T13）也不再需要为后到的槽位声明补试（T17 的有界补试随双入口一起消失）。
- **回退预览对话框 = 简洁版（2026-10-10 用户第三条要求）**：标题固定「回退预览」；正文只有**会被回退的文件**（路径 + 「+N 行」/「−M 行」；内容已一致的一项都不列，空数组显示「工作区与该回退点一致，无需恢复」；行数算不出来显示「行数未统计」而**不是 0**）；底部只有主按钮「回退」与「取消」。**没有**三选一 mode 单选、二次确认勾选、`allowPartial` 勾选、工作区 / 会话计数面板、救援点说明段、逐段结果详情面板、留点期 notice 面板 —— 这是**有意替换**（点「回退」即确认，对话框本身就是「预览 + 确认」两步）。视觉复用既有 `dialogMask` / `dialogCard` / `dialogWide` / `dialogBodyScroll` / `actionRow` 类，**不新增样式档位**；设置页 `RollbackCard` 的预览弹窗仍保留完整能力。**描述性文案清零（2026-10-12 用户第 8 条「移除回退弹窗中的所有描述」）**：说明行「这次回退会做以下改动：」与「这些文件的行数没有统计出来…」整段都不再渲染 —— 弹窗只留能改变决定的信息（§7）；`.previewSummary` 样式随之删除，逐文件那格的「行数未统计」保留。
- **升级风险**：宿主改用户消息渲染器 / 槽位契约 → 复刻老旧或错位。软失败：声明形态不是 `keyed` 就**跳过注册**（只丢这一个入口），回合号取不到就**如实禁用按钮**（每个禁用原因有自己的字典键）。
  风险与差距登记 = `docs/spec/known-gaps.md` G-39。

### 说明性文案分层（InfoHint，2026-10）

判定规则**已冻结**，逐字适用，**不得自行扩大或缩小**。承载体是 `common/InfoHint.tsx`；
落地形态统一为 **v2**：`<InfoHint text={t('原键')} label={t('common.infoHint')} />`
—— **可访问名取各自命名空间的 `common.infoHint`**（主字典 + market / sync / recovery 各有一份同口径副本，
history 无 ⓘ 故不要求）；**不跨命名空间传 `t`**（`TranslateNS<'config-manager'>` 与其它命名空间的 `t`
类型不兼容），也**不用可能 undefined 的 `copyT`**（组件内置的源语言回落只作兜底，调用点必须显式给可访问名）。

**MOVE → ⓘ**（改为 `<InfoHint text={t('原键')} label={t('common.infoHint')} />`，并删掉原来那一行可见说明）：
- 纯说明性文案：机制怎么工作 / 为什么这样设计 / 补充背景 / 边界与限制 / 示例 / 省事提示；
- 输入规则类文案（如「仅允许字母数字、空格、- _ .」）—— 因为校验失败时错误文案本身会重申规则。

**KEEP 常驻**（渲染与文案必须与改动前**逐字一致**，一处都不许动）：
1. **动态**校验错误 / 失败原因（`css.formError`、`ErrorBanner`、`ErrorList`、`ReportView` 的失败文本）；
2. **动态**安全与不可逆操作告警 —— **当下就要拦住用户**的那些句子：锁定中 / SAFE MODE 生效中 / 恢复失败 /
   「取消勾选会删除已保存的密码」/ 隔离与回滚的逐条后果（`sessions.layout.keepHint`、`quarantineNote`、`refreshHint`）。
   **静态**机制说明（加密算法、密码存在哪、凭据写到哪个槽位、救援模式会改写哪几层、清理只动可重建区）
   自 **2026-10-12** 起属 MOVE —— 见下方 t7 清单；
3. 状态 / 进度 / 等待文本（运行中、已停止、等待 N 分钟、下载中）；
4. 按钮与选项的禁用原因（`title=` 上的解释）；
5. 空态解释（列表为空时说明「为什么什么都没有」的那一行）；
6. 行内防截断的 `title=`（表格/列表/长路径上的全量提示，**不是**页面文案）；
7. `SectionTitle` 的 `subtitle` / `css.cellMeta`：**只允许承载动态或元数据**（当前条目名、计数、时间、
   状态说明、必须看到的「下一步」指引）；**静态说明性副标题一律改走 `SectionTitle.info`**（ⓘ，2026-10-12）；
8. `ConfirmDialog` / `Modal` 内的危险操作说明（点下去之前必须读到的规则与后果）。

**用法与边界**：
- ⓘ 只承载**可选的补充信息**：任何用户「**当下**必须看到才能安全决策」的文本都不得移入（那正是 KEEP 的 8 类）
  —— 判据是**动态还是静态**：会随状态出现/消失的（校验失败、锁定中、SAFE MODE 生效中、逐条回滚后果）常驻；
  一句话说清的**静态**机制 / 安全 / 边界说明自 2026-10-12 起进 ⓘ（见下方 t7 清单）；
- 输入规则类文案移入后，校验失败的错误文案**必须仍然重申规则**，否则规则变得不可见；
- **摆放：ⓘ 必须与它说明的标题/操作/控件**同一行**（贴在右侧），不得单独成行**（2026-10-03 用户反馈：
  同步页与通道配置 / 分区选择弹窗里出现「孤零零一个图标」的断行）。五种落地形态：
  ① 放进承载标题/标签的元素内（`<span className={css.groupLabel}>标题 <InfoHint … /></span>`，
  见 AboutPanel / EnvironmentPanel）；② 放进该操作所在的 flex 行（`.actionRowTop` / `.actionRow`，
  如「选择同步分区」「完成」旁）；③ **弹窗级说明**放进 `Modal.Header` 的 `trailing`（渲在标题与
  `.dialogClose` 之间 —— 后者 `margin-left:auto`，所以 ⓘ 紧贴标题右侧）；④ **控件旁的说明**用
  `.controlRow`（控件 + ⓘ 同一行，控件按自身宽度）；⑤ **页级 / 分区级副标题**用 `SectionTitle.info`、
  **表单字段说明**用 `Field.info`（两者都接受一个 `<InfoHint>` 节点，渲在标题 / 字段标签同一行右侧；
  标题行的行容器 = `.sectionTitleRow`，标题可换行、ⓘ 不收缩）。新增调用点按此摆放，下次迁移不再另起一套。
- 触发按钮 18px、颜色取 `--dsw-alias-label-tertiary`，hover 必须给出可见 affordance
  （`--dsw-alias-interactive-bg-hover` 底 + `label-primary` 前景）；固定态用主色 tint；
- 样式只进 `config-manager.module.css`（`.infoHint / .infoHintBtn / .infoHintBubble`），
  颜色/底色/边框/阴影全走 `--dsw-*` token；位置由组件量测后写入内联 `top/left`
  （动态坐标无法用静态类表达，是本仓库「style 属性只允许极小修补」的正当例外，与 `Select` 的 `data-align` 同源）；
- **渲染契约（t9 修 T7-F1，源码级守卫 `common/info-hint-guard.test.ts` 的 t9-1）**：气泡**必须经
  `createPortal` 渲进插件根容器**（`resolveModalRoot()` = `#dsh-config-manager-root`，与 `Modal.tsx`
  共用同一份实现；**绝不挂 `document.body`** —— 会被宿主 overlay z-index:1000 盖住，并连带 body
  `pointer-events` 失效）。为什么非 portal 不可：`.dialogContentCenter` 带常驻
  `transform: translate(-50%,-50%)`，按 CSS Transforms L1 会成为后代 `position: fixed` 的**包含块** ——
  裸 fixed 的气泡在 Modal 内会整体偏移卡片位移，并被 `.dialogBody{overflow-y:auto}` 裁剪。
- **气泡边界 = 宿主画布 ∪ 锚点，不是浏览器视口（t9 修 T7-F2 / 2026-10-04 修偏移，守卫 t9-2 + t11-2）**：
  夹紧矩形取**插件根容器的可见矩形 ∩ 窗口**，容器缺失 / 尺寸为 0 / 交集退化时才回落窗口矩形；
  再**并进锚点矩形**（只放宽、不收紧）—— 弹窗卡片是 `position:fixed`（相对浏览器窗口居中），而画布在宿主
  设置弹窗里靠右（左边还有宿主导航），弹窗左半边的 ⓘ 会比画布左缘更靠左，严格夹进画布会把气泡整体推进
  画布、与自己的 ⓘ 脱开（用户报告「提示文字位置有偏移」）；并入锚点后右侧 / 下方仍以画布为界。
  「下方空间不足且上方更宽裕 → 向上翻转」保留。
  `window.innerWidth/innerHeight` 在 `InfoHint.tsx` 里只允许各出现一次（即仅兜底分支）。

- **Select 弹层：portal 进弹层容器 + 容器内绝对定位 + 夹紧（2026-10-04 两轮修复：先「被裁掉一截」，
  再「位置偏移 / 选项点不动」）**：容器 = 弹窗内为**弹窗卡片**（`Modal.tsx` 的 `data-cm-dialog`），
  否则为插件根容器（`resolveModalRoot()`）。为什么弹窗内非进卡片不可（`@radix-ui/react-dismissable-layer`
  源码实证）：① 弹窗打开时执行 `body.style.pointerEvents = "none"`，只给 `Dialog.Content` 写回 `auto` ——
  卡片外的菜单**收不到任何指针事件**（点不动、无 hover）；② 卡片外在 radix 眼里是「点了弹窗外」→ 弹窗被关掉；
  ③ radix 的 `RemoveScroll` 只放行内容子树（`shards=[contentRef]`）→ 卡片外的长菜单滚不动；
  ④ 卡片是 `position: fixed` 且相对**窗口**居中，而插件画布 `.section` 在宿主设置弹窗里靠右 ——
  拿画布当夹紧基准会把卡片左半边的菜单整块推进画布（触发器 x≈18、菜单被推到画布左缘 + 8 ≈ 185）。
  进卡片后菜单的包含块就是卡片（包含块链不经过 `.section` ⇒ 不被画布的 `overflow` 裁剪），
  夹紧基准相应改用**视口**；画布内的普通下拉仍用 `canvasBounds()`（= 画布 ∩ 窗口）。
  放置判据在 `src/ui/menu-placement.ts`（纯函数 + node 单测，与高亮模型同一分层）：下方放不下且上方更宽裕
  → 向上翻转；左右越界 → 先右对齐再夹紧；空间不足 → 限高内滚。量测完成前靠 `[data-ready]` 不绘制
  （同 `.infoHintBubble`）；打开期间跟随滚动 / 缩放重算。留在原地的弹层（导航条 MoreMenu）
  继续用 `absolute + data-align`：它贴顶展开，没有下方的裁剪风险。
- **ⓘ 的键盘聚焦必须由用户发起（2026-10-04，守卫 t11-1）**：Radix 的 FocusScope 在弹窗挂载时
  `focusFirst(...)`，初始焦点落在容器内第一个可聚焦元素上 —— 标题行 trailing 的 ⓘ 常常正是它，
  于是「一进弹窗就自动选中 ⓘ 并弹出气泡」。判据 = 聚焦事件的 `relatedTarget` 是否在同一
  `[role=dialog]` 内（初始焦点来自弹窗外的触发器 / body / null → 忽略）；焦点环同时只在气泡打开时绘制，
  所以程序化初始焦点既无气泡也无蓝框，而用户 Tab 到 ⓘ 时两者同时出现。
- **本次落地（t1–t5 全量清单，共 42 键；机器化台账 `common/info-hint-guard.test.ts` 的 `MOVE_PINS`。
  原为 43 键 —— 2026-10-04 用户要求移除产物库页首行，`snapshots.retentionHint` 随之退出台账）**：
  - **common/（t1，2）**：`runs.retentionHint`（运行中心列表头部 ⓘ）、`picker.sessionWorkspaceLinked`
    （选择器工具栏 ⓘ，仅当「会话 ↔ 工作区」配对确实存在时出现）；
  - **sync/（t2，16）**：`channel.perChannelHint` / `config.repoUrlHint` / `github.description` /
    `webdav.presetHint` / `webdav.urlHint` / `webdav.usernameHint` / `config.saveHint`（通道配置弹窗 7 处）、
    `mode.sessionsPickHint` / `mode.pickerHint` / `mode.sessionsLimitHint` / `mode.sectionsHint`
    （分区选择弹窗 4 处）、`mode.hint` / `mode.persistHint`（同步页）、`channel.openHint`（通道入口卡）、
    `autosync.description` / `autosync.intervalHint`（自动同步卡）；
  - **snapshots/ + export/（t3，13）**：`backupFiles.hint`、
    `diskUsage.backupRetention`、`backupSchedule.hint` / `enabledHint` / `customHint`、
    `retention.hint` / `keepLastHint` / `keepMonthlyHint` / `keepYearlyHint` / `retention.appliesTo`、
    `export.hint`（工具栏）、`export.fileNameHint` / `export.noteHint`（字段标签旁）——**导出页 3 处**；
  - **market/ + about/ + profiles/（t4，9）**：`myconfigs.login.hint`、`myconfigs.update.zipHint`、
    `myconfigs.upload.form.nameHint`、`about.diag.hint`、`about.feedbackHint`、`about.update.offline`、
    `about.cli.hint`、`profiles.create.hint`、`profiles.list.hint`（**档案列表 1 处**，
    同一键在行内 `title=` 仍常驻）；
  - **recovery/（t5，2）**：`sessions.desc`、`recovery.preview.hint`；
  - **零 MOVE 的面板**：history / overview / import / consult（`.hint` 类全部命中 KEEP）。
  `common/ui.tsx` 的 `Field.hint` / `SectionTitle.subtitle` 由调用方传入且大量命中 KEEP
  （如 `export.encryptHint` 是安全告警），**不整体自动迁移**。逐键台账与 deferred 见
  `docs/design/info-hint-migration.md`。
- **t7（2026-10-12，用户要求「把**所有**描述都收进 ⓘ，页面更简洁」）：41 键** —— 把上一轮按
  「安全 / 副标题」判为 KEEP 的**静态**文案一并收进 ⓘ（判据仍是上方 KEEP 的 8 类，变的是第 2 / 第 7 条的边界）：
  - **页级 / 分区级副标题 → `SectionTitle.info`**：`profiles.subtitle`、`section.description`（同步页 + 市场页）、
    `about.subtitle`、`history.subtitle`（3 个分支同一文案）、`rollback.desc`、`import.select.hint` /
    `import.consult.hint` / `import.decryptArchive.hint` / `import.conflicts.hint` / `import.paths.hint` /
    `import.picker.hint` / `import.secrets.hint` / `foreign.source.hint`（两处渲染点同改）；
  - **卡片 / 字段说明 → 标题行或字段标签行的 ⓘ**（`span.groupLabel` / `span.fieldLabel` / `.controlRow` /
    `Modal.Header.trailing` / `SectionTitle.info`，`Field.info` 是新加的原语入口）：
    `mode.encryptHint` + `mode.encryptAutosyncNotice`（合成同一颗 ⓘ）、`mode.includeSecretsHint`、
    `mode.passwordSavedHint`、`mode.decryptPasswordHint`、`export.encryptHint`、`export.includeSecretsHint`、
    `export.compositionHint`、`config.tokenHint`、`webdav.passwordHint`、`cloud.secretHint`、`cloud.tokenHint`、
    `repoPicker.privateOnly`、`diskUsage.clean.hint`、`recovery.safeMode.detail`、`sessions.repair.desc`、
    `recovery.rescue.desc`、`sessions.layout.planReadOnly`、`recovery.incomplete.hint`、`snapshots.selectHint`、
    `foreign.lossy.hint`、`foreign.previewDryRun`、`myconfigs.upload.selectHint`、`myconfigs.upload.mode.shareHint`、
    `rollback.preview.hint`；`cloud.gistLargeSectionHint`（走常量而非字面量，
    故不进 `MOVE_PINS`，但同样已进 ⓘ）；
  - **`rollback.autopoint.hint` 下线渲染点**：它与卡头 ⓘ 的 `rollback.desc` 同义（后者是超集），
    字典键保留、界面上不再重复一行；
  - **同轮仍常驻（有意为之，不是漏改）**：动态错误 / 状态 / 空态 / 禁用原因 `title=`；
    `ConfirmDialog` 内的危险操作说明；`nextSteps.restart.hint` / `nextSteps.sessionsRestart.hint` /
    `about.update.dialog.restart`（必须看到的「下一步」）；`foreign.conflict.policy`（导入前必读的冲突规则）；
    `sessions.layout.keepHint` / `quarantineNote` / `refreshHint`（隔离与回滚的逐条后果）；
    `mode.passwordClearNotice`（取消勾选会删除已保存的密码）；`recovery.crash.guidance`（处置指引）；
    `diskUsage.location` 与计数类元数据；`myconfigs.upload.form.autoHint`（「以下字段由系统自动生成：」引导行）。

---

## 8. Responsive

- 弹窗收缩（视口 <900px，弹窗变 100vw-48px）：`.ovGrid` 单列、统计/快捷网格 2 列、
  `.secretFields` 单列、`.pagePad` padding 12px。
- 表格列宽用 th 显式宽度 + `table-layout: fixed` + 内容 ellipsis；先压缩次级列，
  最后主列；固定开销（时间/操作列）优先于内容列。

---

## 9. Anti-patterns（禁止）

1. 零值/纯状态装饰卡（为填格子而存在的 KPI 卡）。
2. 与一级导航重复的第二套入口卡。
3. warn/error 语义色用于建议性/营销性内容。
4. 无标签的 utility 图标混在导航行（图标按钮必须 aria-label + title）。
5. 尾部截断文件名/时间戳（区分信息在后缀时用中段省略）。
6. 固定高度容器内容不满（空黑块）——用 fit-content 或真实内容填充。
7. 全同徽章列（同一状态重复 n 次）——降级为状态点。
8. 同屏术语漂移（同一概念多个名字）。
9. 手写文本符号图标（▣⇥⇤⟳◷⭳⌕✕⧉→ 等）——统一用 `common/Icon.tsx`（lucide-react）。
   **已有防线**：`src/client/icon-layer-guard.test.ts` 扫全部 UI 源码的**字符串字面量**（注释与测试夹具除外），
   发现形状符号即失败 —— 这条规则此前只是散文，`RestorePlanView` 的 `▸/▾` 因此长期没被发现。
10. 新建弹窗用手写 `dialogMask+dialogCard` 而无 focus trap——统一用 `common/Modal.tsx`（Radix Dialog）。
11. 加载中的按钮**只把文案换掉（没有加载图标）**——进行中态必须给出可见的加载图标，
    新调用点直接传 `Button loading`（原语自动渲染图标 + 禁用 + aria-busy）。
    自造状态会让「有没有图标」「按钮多宽」随调用点漂移（用户实测：同一排按钮有的转圈有的不转）。
12. 用形变/动画**装饰静态图标**，或把形变铺到导航与语义图标上——形变是「状态确实变化」的可见化
    手段，仅限 `ExpandChevron`（折叠展开/收起）。新调用点**必须显式传 `reducedMotion="user"`**
    （morphicons 缺省 `"never"`，会无视系统减弱动效设置）。
13. **给没有状态切换的静态图标套 Morphicons**（或为「以后可能要形变」预先登记数据）——形变的收益只在
    「同一个 DOM 节点换了图标」时兑现；静态图标套形变 = 多打一份 vanilla `lucide` 数据却永远不触发，
    是纯体积亏损。判据见 §6。
14. 骨架与转圈用反：用骨架替换**按钮内联 / 遮罩**里的进行中反馈（那里没有布局轮廓可给），
    或给整块首屏加载只留一个居中转圈（用户先看到一个空页面再整页跳变）。另外骨架**不得**
    只给色块不留文案 —— `role="status"` 之外必须有可见 caption。判据见 §6 的 `Skeleton` 条。
15. 给「视图级切换」加动画却用 key 重建了**需要保状态**的容器（把带 `useState` 的向导主体、
    带进行中态的卡片塞进 key 变化的包装层）—— key 变化会卸载重挂整棵子树，本地态归零
    （与 AGENTS.md「进行中操作也算状态」是同一个坑）。判据：只对**分支渲染不同组件**的视图用
    `ViewSwitch`；容器内部有要保留的状态时改用 `Collapse`（不重建，只改高度）。
    `Collapse` 侧的同款红线：**不得**为省 DOM 在收起时卸载内容 —— 那条路只能得到展开侧动画
    （被卸载的子树没有高度可插值，收起必然瞬塌）。
16. **绕过 `--cm-*` 直接写 `--dsw-alias-state-*` / `--dsw-alias-button-info-*`**（v3）——
    四态与主色必须经语义中间层，否则改一次语义要扫全文件（v2 实测 140 处散落、四态 5 份实现）。
    执行者：`css-token-guard.test.ts`。
17. **在 scale 之外新造字号 / 间距 / 圆角 / z-index**（v3）—— 先改 §3–§5 的档位表与守卫白名单，再改代码；
    就地写一个「差不多」的值是这条规范此前失效的唯一原因（实测 10 档字号 / 9 档圆角 / 10 档 gap）。
    执行者：`css-scale-guard.test.ts`（含反自检：注入越界值必须被抓到）。
18. **把隐式全局状态做成看起来全局的控件**（v3）—— 例：页面级的「加密与密钥 / 解密密码」卡绑定一个
    被别的按钮悄悄切换的「当前通道」。控件必须与它**作用的实体同屏**（在通道卡内 / 或在以该通道为题的弹窗内），
    否则用户会以为两个通道共用一份设置（不变量 §3-19）。
