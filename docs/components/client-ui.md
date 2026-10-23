# 客户端组件体系与 UI 落点（client-ui）

> 本文只回答两件事：代码里长什么样、规则由哪个守卫兜住。**视觉决策与数值以 `DESIGN.md` 为唯一权威**（颜色 `DESIGN.md:98`、字号 `DESIGN.md:145`、间距 `DESIGN.md:176`、组件 `DESIGN.md:253`、反模式 `DESIGN.md:1563`），本文不复制数值。
> 读者：接手的 AI agent 与人类维护者。每条断言对应一处代码或守卫；无法由代码证明的判断标「待验证」。

## 1. 职责与边界

- 三层分工：`src/client/**` 是 React 装配壳；`src/ui/**` 是与框架无关的纯逻辑（可单测）；`src/core/**` 是宿主引擎。
- 规则出处：业务逻辑放 `src/ui/`、React 壳只装配；这条规则的守门方式是代码评审，不是自动守卫。
- 客户端入口 `src/client/index.ts:123`（`apply(ctx)`）。
- 页面枚举 `src/client/run-store.ts:86`：`'home' | 'library' | 'sync' | 'environment'`。
- 页面分派唯一位置 `src/client/ConfigManagerSection.tsx:464`；`panel` 读自 store `src/client/ConfigManagerSection.tsx:92`。
- 「市场」不是页面，由 Task 流程承载；Task 的 origin 恒为当前页 `src/client/ConfigManagerSection.tsx:328`。

## 2. 装配与注入

### 2.1 渲染管线

1. `settings.section` 插槽注册：`src/client/index.ts:178`。
2. 壳组件 `ConfigManagerSection` 持有 store、api 实例、翻译器。
3. 按 `panel` 分派四个页面组件（`src/client/ConfigManagerSection.tsx:464`）。
4. 页面内的流程面板（导出/导入/市场）由 Task 层叠加，不占用一级页面。

### 2.2 翻译器注入

- 字典注册 6 个 namespace：`src/client/index.ts:124`（主）、`:125` sync、`:126` market、`:127` recovery、`:128` history、`:129` chat。
- 壳层 `t` = 主 namespace 绑定 `src/client/index.ts:131`。
- 展示层 `uiT` 用**活翻译器** `makeLiveUiT(readLanguage)` `src/client/index.ts:138`：语言在「取文案那一刻」解析。
- 模块级单例（runStore 等）没有调用方传 `UiT`，经 `setUiLanguageSource` 接线 `src/client/index.ts:137`。

### 2.3 api 注入

- api 实例：`ConfigManagerApi` `src/client/api.ts:344`、`SyncApi`、`MarketApi`、`RecoveryApi` 等，在壳层构造后经 props 交给页面。
- **组件禁止直接 fetch**；请求封装收敛由 `src/client/common/http-usage-guard.test.ts:28` 的源码级清单锁住。
- 其它插槽：聊天节点 `src/client/index.ts:279`、回滚 diff `src/client/index.ts:331`。

## 3. 页面与状态

### 3.1 加一个页面 = 改五处

1. `PanelId` 枚举 `src/client/run-store.ts:86`。
2. `parsePersistedState` 的映射与旧值迁移 `src/client/run-store.ts:1176`。
3. 迁移用例（样板 `src/client/run-store.test.ts:1063` 起的旧载荷用例）。
4. 导航条 `NAV_ITEMS` `src/client/ConfigManagerSection.tsx:77-82`（含图标与顺序）。
5. `ConfigManagerSection` 的 switch `src/client/ConfigManagerSection.tsx:464`。

> 漏第 4 步 = 页面存在但导航里点不到；漏第 5 步 = 永不渲染。命令面板的跳转项另有一处 `src/ui/commands.ts:93-102`（`go.*`），不改只影响快捷跳转，不影响可达性。

### 3.2 状态归属

- `StoreState` 切片 `src/client/run-store.ts:500`：export / import / sync / market / snapshots / profiles / recovery / library，加**永不落盘**的 `task`。
- 高频可恢复流程（导出/导入）进 `run-store`；低频面板组件内 `useState` 自持 + 镜像切片。
- 进行中任务轮询：`watchRunning` `src/client/run-store.ts:1922`、`stopRunWatch` `:1956`、每 kind 单定时器 `:1961`、按 runId 防重 `:1966`。
- 组件卸载必须 `stopRunWatch`（样板 `src/client/export/ExportView.tsx:345`）。

### 3.3 sessionStorage 白名单

- `toPersistedState()` **默认拒绝、显式放行** `src/client/run-store.ts:1001`（设计说明 `:986`）：新增字段不显式放行即不落盘。
- 落盘前对宿主载荷做值级脱敏 `redactPersistedValue` `src/client/run-store.ts:958`。
- 断言兜底：未知字段默认不落盘 `src/client/run-store.test.ts:1567`、落盘前已脱敏 `:1480`。
- **不要把「解构剔除敏感字段」当实现**：那是旧形态，`src/client/run-store.ts:988` 起明确写它默认放行、会静默泄露。

### 3.4 Task 面板

- Task 是有 origin 的流程层，不持久化：刷新后不重放空白向导（`src/client/run-store.ts:500` 的 `task` 字段注释）。
- origin 决定「返回哪一页」，所以新增页面要同步检查 `origin` 的类型使用点：`src/client/ConfigManagerSection.tsx:328`。

## 4. 原语与复用规则

`src/client/common/ui.tsx` 的 14 个原语：

| 原语 | 定义 | 用途 / 约束 |
|---|---|---|
| Button | `src/client/common/ui.tsx:45` | 三变体 primary/ghost/danger；`loading` 自动 disabled + aria-busy |
| IconButton | `src/client/common/ui.tsx:111` | 仅图标动作，必须有 `label` |
| FoldToggle | `src/client/common/ui.tsx:148` | 展开/收起，带 `aria-expanded`/`aria-controls` |
| StatusDot | `src/client/common/ui.tsx:177` | 五态 idle/ok/info/warn/error，`pulse` 表进行中 |
| Badge | `src/client/common/ui.tsx:207` | 四态 info/ok/warn/error；优先宿主 Tag，缺能力回落 `.badge` |
| Banner | `src/client/common/ui.tsx:226` | 四态说明横幅 ok/error/info/warn |
| Card | `src/client/common/ui.tsx:240` | 卡片容器（bg-layer-2 + 细边框） |
| Spinner | `src/client/common/ui.tsx:276` | 加载指示 |
| Field | `src/client/common/ui.tsx:308` | 标签 + hint + ⓘ |
| SectionTitle | `src/client/common/ui.tsx:336` | 区块标题 + 副标题 |
| Empty | `src/client/common/ui.tsx:355` | 空态文案 |
| Checkbox | `src/client/common/ui.tsx:369` | 受控勾选 |
| Segmented | `src/client/common/ui.tsx:407` | 按钮组（role=group + aria-pressed），**不是 tabs** |
| Stepper | `src/client/common/ui.tsx:448` | 只读步骤指示器，不推断状态 |

共用层：

| 组件 | 位置 | 职责 |
|---|---|---|
| ErrorBanner | `src/client/common/ErrorBanner.tsx:32` | 错误 → 可操作文案，渲染前 redact |
| ProgressBar | `src/client/common/ProgressBar.tsx:41` | 运行事件 → 进度视图 |
| ReportView | `src/client/common/ReportView.tsx:233` | 导出/导入报告体，正文全部 redact |
| Modal | `src/client/common/Modal.tsx:83` | Radix Dialog；根容器 `:42`（Portal 到 body 才拿得到 token） |
| Icon | `src/client/common/Icon.tsx:103` | lucide 深导入；形变仅 `ExpandChevron` `:177` 与 `CopyStateIcon` `:213` |
| InfoHint | `src/client/common/InfoHint.tsx:80` | ⓘ 解释气泡；气泡 Portal 到同一 `#dsh-config-manager-root`（弹窗内不受 transform 包含块影响）；有守卫 `info-hint-guard.test.ts` |
| Skeleton | `src/client/common/Skeleton.tsx:64`（另有 `SkeletonList` `:87`/`SkeletonTable` `:114`/`SkeletonRows` `:143`） | 加载骨架，替代 spinner 撑布局 |
| ConfirmDialog | `src/client/common/ConfirmDialog.tsx:54` | 二次确认；危险操作走 `kind` 而非 primary |
| toast | `src/client/common/toast-store.ts:174`（store `:164`，宿主 `ToastViewport.tsx`） | 轻提示；不进 run-store，不进 sessionStorage |

- 形变硬约定：`reducedMotion="user"` `src/client/common/Icon.tsx:160` + `spring={MORPH_SPRING}` `:159`；不得扩大形变范围。
- 下拉唯一出口 `src/client/common/Select.tsx:2`；现存违规见 §8。
- 复用顺序：`src/client/common/*` → `src/ui/*` → `src/core/*` → `src/utils/*` → `src/security/*` → `DESIGN.md`；已有原语能解决即禁止重建。

## 5. 样式与 token

- 唯一样式文件 `src/client/config-manager.module.css`；CSS Modules，类名以 `css.xxx` 引用。
- token 必须定义在 `body`：DSH 的 `--dsw-*` 定义在 body，`var()` 只在**声明它的元素**上替换 ⇒ 挂 `:root` 断链。挂 `.section` 看似可行（Modal 的 Portal 根正是 `.section` 本身：`src/client/common/Modal.tsx:42`、`src/client/ConfigManagerSection.tsx:523`），但本插件还有 `.section` 之外的挂载面（聊天节点 `src/client/index.ts:279`、回滚 diff `:331`），它们拿不到 token。
- 三层单向：组件只写 `--cm-*`；`--dsw-*` 只允许出现在 `--cm-*` 定义行；tint 用 `color-mix(in srgb, var(--cm-*) N%, transparent)`。
- 守卫（均源码级、跑在 `node --test`）：
  - `src/client/css-token-guard.test.ts:24` 受约束的 `--dsw-*`（清单 6 条，`:24-38`；2026-10-17 起 `--cm-info` 接 `--cm-accent`，`--dsw-alias-state-info-primary` 已不在清单）、`:39` 必备 `--cm-*`。**新 token 不登记进清单就不受约束**。
  - token 用例：token-01 `:48`、token-02 `:59`、token-03 `:71`、token-04 `:77`、token-05 `:84`（反自检）。
  - `src/client/css-scale-guard.test.ts:25` 字号、`:26` 圆角、`:27` 行高、`:29` 间距。
  - scale 用例：scale-01 `:93`、scale-02 `:107`、scale-03 `:117`、scale-04 `:123`、scale-05 `:130`、scale-06 `:183`（反自检）、scale-07 `:171`。
- **覆盖边界**：scale 守卫只读 `*.module.css`，`tsx` 里的 inline style 不受任何样式守卫约束。
- 新档位先改 `DESIGN.md` §4/§5，再动守卫；守卫外写法视为待治理债务。

## 6. i18n

- 两套载体：6 个 `ctx.locale` namespace（§2.2）+ `src/ui/i18n.ts` 的 `uiZh`/`uiEn`（供 `UiT`，不经 `ctx.locale`）。
- 翻译器：`makeLiveUiT` `src/ui/i18n.ts:1185`、`liveUiT` 单例 `:1213`；`makeUiT` 是**加载期快照** `:1156`，不得在 `apply()` 里用（会把语言钉死）。
- 非 zh 语言一律回落 en（英文界面不回落中文），由 `makeLiveUiT` 的取值决定 `src/ui/i18n.ts:1185`。
- 缺键回退链 `src/ui/i18n.ts:1161`：en → zh → 键名，绝不抛错。故「缺 key」不会报错，只能靠类型与守卫预防。
- 动态键目前只有映射表路径一处：`src/client/common/section-labels.ts:43`。
- 硬编码守卫：`node --test tests/i18n-hardcoded-guard.test.ts`。
- 作用域自检：`DCM_I18N_GUARD_SCOPE` `tests/i18n-hardcoded-guard.test.ts:6`；用例 A0 `:67`、A1 `:74`、A5 `:85`。
- 扫描集与 `.css` 排除见 `tests/helpers/i18n-scan.ts:43`：`.css` 当前不在扫描面，将来 `content:'中文'` 会漏。
- 既有键指纹冻结：`src/core/engine-locale.test.ts:193`，基线键数 `:219`；规则 = 只许追加，不得改既有 zh/en 取值。
- 新增文案：zh 与 en 同轮补齐 → 不改既有键取值 → 跑硬编码守卫。

## 7. 测试口径

- 浏览器侧**没有组件测试框架**（自述 `src/client/common/http-usage-guard.test.ts:4`），因此：逻辑下沉 `src/ui/` 做单测，UI 规则用源码级断言兜。
- 规则类守卫：
  - `src/client/common/http-usage-guard.test.ts:28`：api 文件清单，禁裸 fetch / 本地 readJson。
  - `src/client/css-token-guard.test.ts`、`src/client/css-scale-guard.test.ts`：样式。
  - `tests/i18n-hardcoded-guard.test.ts`：文案。
  - `tests/architecture-boundaries.test.ts:64-67`：分层（对 client 只禁 `node:`）。
- 页面级测试多为布局/文案断言，例 `src/client/recovery/recovery-panel-layout.test.ts`；它们证明不了交互正确性。
- `src/client/bundle-selfcontained.test.ts` 必须 **build 之后单独跑**（`npm test` 时产物不存在会跳过）。
- 判定口径：源码级断言证明「写法没漂移」，不证明「运行时行为正确」；交互正确性目前只能人工点。

## 8. 已知限制（已确认，勿当设计意图）

- `src/client/recovery/RecoveryPanel.tsx` 1946 行，已登记全局行数棘轮（`tests/file-size-ratchet.test.ts:28`，只许降不许升）：单文件承载维护页与约 600 行的会话健康对话框。
- `src/client/sync/SyncPanel.tsx` 1591 行，已登记全局行数棘轮 1591（`tests/file-size-ratchet.test.ts:31`，只许降不许升）。
- 第二套徽章族 `.kindTag` 仍在 `src/client/config-manager.module.css:4401`，消费点如 `src/client/library/RestorePlanView.tsx:59`；与「已收敛」的说法不一致。
- 原生 `<select>` 违反 Select 唯一出口：`src/client/recovery/RollbackCard.tsx:767`。
- inline style 绕过样式守卫：`src/client/market/MarketPanel.tsx:524` 裸用 `--dsw-alias-state-warn-primary`。
- 同理 `src/client/about/ReleaseNotesDialog.tsx:264` 内联 `padding: '20px 0'` 不在间距档位内。
- client/ui → core 的**值** import 无自动拦截：`tests/architecture-boundaries.test.ts:64-67` 对 client 只禁 `node:`。
- 长写盘操作（会话修复/布局归位）只有组件内 busy `src/client/recovery/RecoveryPanel.tsx:671`，未进 run-store，切页会丢进行中视图。
- 待验证：`src/ui/i18n.ts` 在途修改后 `src/core/engine-locale.test.ts` 的指纹断言是否仍绿（本文未运行测试）。

## 9. 与其它文档的分工

- 视觉决策、token 数值、组件视觉规范 → `DESIGN.md`。
- 页面/原语/状态中枢速查与命令 → `DEVELOPERS.md`（其页面落位段落后于代码，以本文 §3.1 为准）。
- 证据与真机事故 → `docs/lessons/`；本文不重复证据，只指向代码与守卫。
- 本文件已被文档路径守卫扫描（`scripts/check-doc-paths.mjs` 的扫描目录含 `docs/components/`）；新增引用请写成仓库相对路径 + 行号（例：src/client/run-store.ts:86），别用不带目录的裸文件名。
