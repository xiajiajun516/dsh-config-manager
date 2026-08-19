# AGENTS.md — DSH Config Manager 仓库协作指南

> 面向在本仓库工作的 AI agent 与人类协作者。**完整架构/测试矩阵/限制清单见 [DEVELOPERS.md](DEVELOPERS.md)；用户文档见 [README.md](README.md)；UI / 视觉设计 System 的唯一权威见 [DESIGN.md](DESIGN.md)。**
> 本文写「做改动前必须知道」的注意点——隐性约定与坑，避免重复造轮子或踩雷。

## 🗣️ 语言与交流

- 与用户交流一律用**中文**。
- 代码注释、commit message、文档以中文为主（与技术术语混排，如 `SyncEngine`、`adapter`）。

## 📦 项目概览

- **用途**：DSH（DeepSeek Harness）配置的备份 / 导出 / 导入 / 迁移 / 远程同步 / 配置市场插件，双面 Cordis 插件。
- **技术栈**：TypeScript 5.9（strict + `verbatimModuleSyntax` + `noUncheckedIndexedAccess`）、Node.js ≥ 22（host 半）、React 18 + CSS Modules（web 半）、`node:test` 零依赖测试、tsdown + lightningcss 打包 client。
- **样式方案**：**CSS Modules（唯一样式表 `src/client/config-manager.module.css`）**，颜色/字体/阴影全部消费 DSH Design System 的 `--dsw-*` CSS 变量，**不引入 Tailwind / CSS-in-JS / Sass / UI 组件库 / 图标库**。
- **不进 node_modules 也能预判结构**：`src/{core,schema,security,adapters,ui,client,sync,market,profiles,migrations,utils}` 分层清晰，见下。

## 🗂️ 仓库结构与职责

```
src/
├── index.ts          host 半 Cordis 入口（name='config-manager'；/api/dsh-config-manager/* 路由，约 2800 行）
├── core/             核心引擎：exporter / importer / restore / rollback / run-registry / plugin-cli，与 DSH 运行时解耦（ConfigAdapter/HostContext 接口 + 内存 mock）
├── schema/           领域类型 / Manifest / 版本判定（CURRENT_SCHEMA_VERSION=1）
├── security/         secret-scanner / redaction / zip-security / integrity / encryption（scrypt + AES-256-GCM）
├── adapters/         13 个真实配置适配器（settings/ui/providers/plugins/mcp/prompts/skills/agentPresets/workspaces/credentials/pluginFiles/sessions/self）
├── sync/             同步体系：SyncEngine + GitTransport/WebDavTransport + AutoSyncScheduler + 配置/状态/历史/sync-selection
├── market/           配置市场：GitMarketReader + index-parser + security 校验 + builtin 内置市场
├── migrations/       schema 迁移链（registry + v1→v2 占位）
├── profiles/         ProfileManager（保存/切换带 Preview+快照+回滚）
├── ui/               框架无关 UI 逻辑层（纯函数 + 控制器，无 React，node 可测）—— 见下「UI 分层」
├── utils/            通用工具（paths/zip/hashing/json/logger）
└── client/           React 界面（浏览器半）—— 见下「页面与组件落位」
tests/                集成式测试（node --test）
docs/                 设计文档（docs/design/，现有 UI 与市场发布设计）
```

### UI 分层（改动前必读，避免放错层）

**任何 UI 改动有两条铁律：**
1. **框架无关逻辑放 `src/ui/`**（纯函数/控制器：`export-flow.ts`、`import-wizard.ts`、`conflict-view.ts`、`path-mapping.ts`、`report.ts`、`errors.ts`、`progress.ts`、`flow.ts`、`types.ts`、`i18n.ts`）——**禁止在 React 组件里写可测试的业务逻辑**；
2. **React 壳只做装配**（`src/client/` 的组件只负责渲染 + 交互状态，把渲染模型/控制器来自 `src/ui/` 的纯函数）。

### 页面与组件落位（`src/client/`）

| 内容 | 位置 |
|---|---|
| 设置页入口 / 五 tab 容器 | `src/client/index.ts` + `src/client/ConfigManagerSection.tsx`（Export / Import / Snapshots / Sync / Market 五 tab） |
| 导出视图 | `src/client/export/ExportView.tsx` |
| 导入九步向导 | `src/client/import/ImportWizardView.tsx`（阶段子页：`ConflictList.tsx`、`PathMappingForm.tsx`、`import-file-select.ts`） |
| 快照恢复 | `src/client/snapshots/SnapshotsPanel.tsx` |
| 远程同步 | `src/client/sync/SyncSettingsView.tsx`（+ `SyncConfirmView.tsx`、`SyncHistoryView.tsx`、`sync-view.ts` 纯函数模型、`history-model.ts`） |
| 配置市场 | `src/client/market/MarketPanel.tsx`（+ `market-view.ts` 纯函数模型） |
| **共享 UI 原语** | **`src/client/common/ui.tsx`（Button/Badge/Banner/Card/Spinner/Field/SectionTitle/Empty/Checkbox）+ `common/ErrorBanner.tsx`、`common/ProgressBar.tsx`、`common/ReportView.tsx`** |
| 状态中枢 | `src/client/run-store.ts`（模块级单例 + sessionStorage，敏感字段白名单剔除） |
| 数据访问 | `src/client/api.ts`、`sync/sync-api.ts`、`market/market-api.ts`（类型化 fetch 封装，实现 `src/ui/types.ts` 的 port 契约） |
| 文案字典 | `src/client/locales.ts`（ns `config-manager`）、`sync/sync-locales.ts`（ns `config-manager-sync`）、`market/market-locales.ts`（ns `config-manager-market`），zh 源 / en 镜像 |
| **全部样式** | **`src/client/config-manager.module.css`（唯一样式表，类名经 CSS Modules 哈希）** |

- **Hook 放哪里**：本仓库不使用自定义 hooks 目录——React 组件直接内联 state + `useSyncExternalStore` 消费 `runStore`；复用逻辑一律下沉到 `src/ui/` 纯函数。**不要新造 hooks 层**。
- **Type 放哪里**：领域类型在 `src/core/types.ts` / `src/schema/types.ts` / `src/sync/*.ts` / `src/market/types.ts`；UI 层类型在 `src/ui/types.ts`；client 专属类型在 `src/client/client-types.ts`。
- **Utility 放哪里**：`src/utils/`（跨层通用）或模块内私有函数（单文件用）。带业务语义的纯函数优先 `src/ui/`。

## 🔢 版本号：三处必须同步（最容易漏）

发版时 `version` 同时存在于三处，**漏改任何一处都会产生不一致**（历史上出现过 package.json=0.1.30 而 PLUGIN_VERSION=0.1.28、lockfile=0.1.26 的漂移，0.1.31 起已修复同步）：

1. `package.json` → `"version"`
2. `src/index.ts` → `const PLUGIN_VERSION`（约 L124，注释声明 "kept in sync with package.json"）
3. `package-lock.json` → 根对象 `"version"`（约 L3 **和** `packages[""]` 的 `"version"` 约 L9，两处都要改）

bump 后跑 `npm run typecheck` 即可确认无引用遗漏。

## 🚀 发布流程（打 tag 即全自动）

CI：`.github/workflows/publish.yml`，tag `v*` push 触发全自动流水线：

```
typecheck → npm test → build → npm pack → npm publish（Trusted Publishing/OIDC）→ 创建 GitHub Release
```

发版步骤（按序）：

1. **bump 三处版本号**（见上）
2. **在 `CHANGELOG.md` 顶部新增当前版本的双语亮点段**：release 描述由 CI 从 `CHANGELOG.md` 抽取当前版本段（`.github/scripts/extract-release-notes.py`）拼接到 GitHub Release，**漏写会 CI fail fast**（不会静默发出亮点缺失的 release）
3. 提交 + `git push origin main`
4. `git tag -a vX.Y.Z -m "..." && git push origin vX.Y.Z` —— **tag push 触发发布**

⚠️ 注意：
- `workflow_dispatch`（手动触发）**不会**创建 GitHub Release，只有 tag push 才会走 release 段
- npm 发布靠 OIDC trusted publishing，无长期令牌；workflow 会先 `npm install -g npm@latest`
- 历史版本号格式：`0.1.x`；commit 惯例 `chore: bump to X.Y.Z (...)`，功能提交用 conventional commits（`feat/fix/docs`）
- release 描述 = CHANGELOG 双语亮点段 + 安装指引 + 自动变更记录（`gh release create --generate-notes`）；**本仓库不配 `.github/release.yml`**——release.yml 分组按 PR label 匹配，而仓库是直推 commit + conventional commits，GitHub 默认的 conventional 自动分组（🚀 Features / 🐛 Bug Fixes / Docs）效果更好；等将来引入 PR + label 体系再考虑

## 🔐 安全不变量（硬约束，改动时不得破坏）

- **Secret 默认不导出**：`includeSecrets` 缺省 false；凭据值（token/password/密钥）**绝不**写入同步文件、日志或回传浏览器
- **凭据不可回读**：`ctx.credentials` 永不回读值（DSH 硬约束），只经 `HostContext.fs` 文件级读取 `.credentials.yaml`；`encryption.ts` 只做字节级加解密
- **日志全程脱敏**：`redactValue` 掩码 `=`/`:`/JSON 形态的敏感值；导出/导入全链路日志不泄 secret；**UI 渲染前所有错误/报告文本再过 `redact()` 兜底**（见 `src/client/common/ErrorBanner.tsx`、`ReportView.tsx`）
- **ZIP 视为不可信输入**：zip bomb 条目数上限、checksum 校验、Zip Slip（`../` 与绝对路径）拒绝——`src/security/zip-security.ts`
- **导入前强制快照**（可回滚）、Dry Run 零写入、冲突不默认覆盖
- **加密备份**：密码仅内存传入、`secrets.enc`（DSC1）与整体容器（DCA1，AES-256-GCM 外层加密整个备份 ZIP）的密码不落盘/不落日志；解密出的明文 ZIP 为临时文件用完即清，磁盘不残留明文备份
- 同步凭据走 DSH credentials 槽位引用（`SYNC_CREDENTIAL_REF` 等），`passwordConfigured` 只是布尔标记
- **UI 状态持久化（sessionStorage）必须走白名单**：`run-store.ts` 的 `toPersistedState()` 解构剔除 `password/passwordConfirm/secretInputs/decryptPassword/decryptRefs/archiveUnlocked/conflictCollector`；任何新的敏感 UI 字段若不显式放行，自动不落盘

## 🏗️ 架构心智（改代码前先定位）

- 双面插件：**host 半**（`src/index.ts`，Cordis 入口 `name='config-manager'`，挂 `/api/dsh-config-manager/*` 路由）+ **web 半**（`src/client/`，React，`settings.section` 挂载，经 api 调 host）
- `src/core/` 与 DSH 运行时**解耦**：`ConfigAdapter`/`HostContext` 接口 + 内存 mock，可独立测试——**新功能优先加进 core，适配器/UI 只做薄壳**
- 13 个 adapter：`settings/ui/providers/plugins/mcp/prompts/skills/agentPresets/workspaces/credentials/pluginFiles/sessions/self`（`src/adapters/`）；`self` 分区 = 插件自身配置（`$DSH_HOME/dsh-config-manager/` 下 `sync-*.json` / `market-config.json` / `ui-prefs.json` 白名单收集，文件类分区，portable 默认包含；`dataDir` 在 `~/.dsh` 之外时宿主不挂载）
- 同步体系：`SyncEngine` + `GitTransport`/`WebDavTransport` + `AutoSyncScheduler`（事件驱动：远端有新快照才拉、本地有改动才推）+ `sync-selection`（分区选择持久化，自动同步与手动推送共用）；**autosync 与 sync-selection 均按通道（git/webdav）独立**（schema v2，v1 迁移到 git 通道），调度器双通道各自排期
- **import 一律带 `.ts` 后缀**（Deno-style，全仓统一，勿写成无后缀）
- 设计决策有上游文档：`docs/design/`（现有 UI 与市场发布设计；历史 sync/安全设计文档已随旧 `Docs/` 目录清理移除，当前依据以代码文件头注释为准）—— 对应领域先读，**设计文档是上游依据，实现规格在下游**
- 依赖注入走 Cordis fiber：client 面经 `ctx.slots.inject('settings.section', ...)` 注册 + `inject: () => ({ api, syncApi, ... })` 注入服务；host 面可选服务用 `ctx.get()` 惰取

## 🛠️ 开发规范

### TypeScript / 命名

- **Type-only import 用 `import type`**（`verbatimModuleSyntax` 强制，混用会编译失败）；类型合并用 `declare module` + `import type {}` 拉入
- React 组件：**函数组件 + hooks**（无 class 组件、无高阶组件）；props 一律显式接口（`XxxProps`），导出类型在 `src/client/index.ts` 汇总
- 命名：组件/类型/类 PascalCase，函数/变量 camelCase，常量 UPPER_SNAKE；CSS 类名 camelCase（`viewTabs`、`progressTrack`）
- client 半文件尾注：**注释以中文为主**，文件头块注释说明职责 + 绑定的规范/控制器 + 安全约束
- 分号：历史上两部分文件混用（`api.ts` 等带分号，`run-store.ts` 等不带），**Not currently standardized**——跟随所在文件的既有风格，不要在同一次 diff 里混改

### 状态管理

- 高频/可恢复流程（Export / Import）状态集中在 `src/client/run-store.ts`（模块级单例，`useSyncExternalStore` 消费，sessionStorage 白名单持久化）；**新视图若状态需要「切 tab 不丢 / 刷新恢复」，加入 runStore 而非另造 store**
- 低频面板（Snapshots / Sync / Market）状态组件内自持（`useState` + `useRef` 镜像），**同时把非敏感切片镜像进 runStore**（`toSyncStoreSlice` / `toMarketStoreSlice` / `toSnapshotsStoreSlice`，实现切 tab 不丢 / 刷新恢复）：组件 `useEffect` 监听自身状态变化 → `runStore.patch({ sync|market|snapshots })`，挂载时从 store 切片重建初始状态，卸载时最后 flush 一次；同步凭据（token / webdav 密码 / 加密与解密密码）仅内存，由 `toPersistedState` 白名单硬性剔除，刷新后清空要求重输
- 面板开关（`ConfigManagerSection` 当前打开的 tab）存 runStore `panel` 字段：切 tab 不丢、刷新后回到原 tab
- 控制器实例（`ExportFlow` / `ImportWizard`）由 runStore 缓存复用，**禁止每次渲染 new 一个**（切 tab 会重建，破坏 m2 状态恢复）；刷新恢复经 `writeWizardSnapshot()` 受控 rehydrate

### 数据访问 / 错误处理

- 数据访问一律走类型化 api 类（`ConfigManagerApi` / `SyncApi` / `MarketApi`），实现 `src/ui/types.ts` 的 port 契约；**组件禁止直接 `fetch`**
- 错误统一处理链：`toActionableError()` → 可操作错误对象 → `ErrorBanner` 展示（标题/原因/建议动作/重试）；**所有展示文本渲染前过 `redact()`**
- 进行中任务用 `runStore.watchRunning(kind, 500)` 经 `/runs` + `/progress` 轮询显示真实进度；轮询定时器必须卸载清理 + 防重

### i18n

- 所有用户可见文案进字典文件：React 壳走 `t('key')`（对应 ns 字典，zh 源 / en 镜像，`ConfigManagerKey` 类型编译期校验缺键）；`src/ui/` 纯渲染层文案走 `src/ui/i18n.ts` 的 `UiT`（`makeUiT('zh'|'en')`）
- **禁止在组件里硬编码用户可见字符串**（现有个别混杂英文的展示文案如 `included`/`Download` 属历史遗留，新代码一律走字典）

### 测试

- `node:test` + `node:assert`（零依赖），测试文件与被测文件同名 `*.test.ts` 同目录
- 分层测试纪律：`src/ui/` 纯函数与 `src/core/` 引擎必须有单测；React 组件本身无组件测试框架，**逻辑必须提炼到 `src/ui/` 以保证可测**；`src/client/*.test.ts` 测的是 client 侧的纯函数（`progress-view`、`sync-view`、`history-model`、`run-store` 等）
- 新功能必须带测试：加密/同步/安全类改动尤其——`src/security/security.test.ts`、`src/sync/sync-engine.test.ts` 等是现有覆盖样板

## 🧪 开发命令与测试

```bash
npm install --legacy-peer-deps   # 必须带 --legacy-peer-deps：部分 DSH 核心包只在 peerDependencies 且未发布公共 registry
npm run typecheck                # tsc --noEmit
npm run build                    # tsc（host 半 lib/）+ tsdown（client bundle lib/client.js）
npm test                         # node --test src/**/*.test.ts tests/**/*.test.ts（数百用例，零额外依赖）
npm run smoke                    # 仅核心引擎冒烟
npm run bundle                   # 仅重建 client bundle（改 .module.css / client 代码后验证用）
```

- 本仓库**无 lint / format 脚本与配置**（无 eslint / prettier 配置文件；历史代码中的 `eslint-disable` 注释是遗留）——只以 `npm run typecheck` 兜底
- client bundle 的 CSS Modules 由 tsdown + lightningcss 编译为内联 style 注入（`tsdown.config.ts` 的 `cssModulesPlugin()`），单文件 `lib/client.js` 自带样式，无独立 css 资源——**新增样式只能在 `src/client/config-manager.module.css`**（lightningcss 插件只处理 `.module.css`）

## 🎨 UI AND DESIGN SYSTEM RULES（最高优先级约束）

> **`DESIGN.md` is the single source of truth for all UI and styling decisions in this project.**

**任何涉及以下内容的修改，都必须先阅读并遵守 `DESIGN.md`：**

- UI / Layout / Component appearance
- CSS / CSS Modules 类名 / 样式表
- Color / Typography / Spacing / Border / Radius / Shadow
- Icon / Animation / Motion
- Responsive behavior / Visual states（hover / focus / disabled / loading / error / empty）

**硬性规则（违反即破坏设计语言）：**

1. **颜色/字体/阴影必须走 DSH Design System token（`--dsw-*` CSS 变量）**，跟随 DSH 活动主题（亮/暗/皮肤）；**禁止 hardcode 颜色值**（`#fff`、`rgba(...)` 等），需要 tint 时用 `color-mix(in srgb, <token> <pct>%, transparent)`
2. **样式只能加进 `src/client/config-manager.module.css`**（全仓库唯一样式表）——禁止新增其他 css 文件、禁止内联 `<style>`、禁止第三方 css；类名必须 CSS Modules 引用（`css.xxx`），**不要写字符串 class（如 `className="foo"`）**（现有 `sync-history-table` 等字符串类属遗留）
3. **复用 `src/client/common/ui.tsx` 的原语**：Button / Badge / Banner / Card / Spinner / Field / SectionTitle / Empty / Checkbox；以及 Common 的 ErrorBanner / ErrorList / ProgressBar / ReportView。**已有公共组件能解决的问题，禁止重新创建重复组件**；新页面先搜代码库确认没有可复用的
4. **不引入第二套视觉体系**：不引入 Tailwind / CSS-in-JS / Sass / UI 组件库 / 图标库 / 动画库。需要图标时用文本符号或 emoji（项目现状），需要新动效时先确认现有 motion 规则不够用
5. **按钮语义分层**：`Button variant="primary"`（页面主操作）/ 默认 ghost（次操作）/ `variant="danger"`（危险操作如恢复/回滚）——不要用 primary 做危险操作，不要给所有按钮加 primary
6. **状态徽章语义**：`Badge kind="ok|info|warn|error"`（成功/业务信息/警告/错误）与 `Banner` 四态一一对应，表达状态必须先想语义再选 kind
7. **文案必须走 i18n 字典**（见上「i18n」）；UI 展示文本渲染前进 `redact()`（安全不变量）
8. **长列表/大报告必须限高内滚**（`planScroll` / `reportScroll` / `confirmScroll` / `pullScroll` / `diffScroll` 模式），禁止把整页撑长

## 🆕 Missing Design Rule（DESIGN.md 未覆盖时）

如果当前需求需要一种 `DESIGN.md` 中没有定义的 Style / Component / Pattern：

1. 先检查项目是否已有类似实现（代码库搜索 + DESIGN.md 的 Components / Common UI Patterns 章节）
2. 检查现有 Component 是否可以扩展（如给 `Button` 加 variant、给 `ui.tsx` 加原语）
3. 检查现有 Design Token 是否可以组合实现（`--dsw-*` 变量 + `color-mix` + 现有 spacing / radius 比例）
4. 确实不存在时：根据现有设计语言设计新规范——**必须复用**既有 Color / Typography / Spacing / Radius / Component Pattern
5. 将新 Style / Component / Pattern **写入 `DESIGN.md`**（正式加入 Design System）
6. 然后再在代码中使用该规则

> **Never introduce a new visual pattern without documenting it in DESIGN.md.**
>
> 新 UI Pattern 一旦被引入项目，就必须被文档化；禁止只在代码中新增 Style 而不更新 DESIGN.md。DESIGN.md 随项目一起演进。

## 🔄 Style Change Workflow（强制流程）

Before making any UI/style change:

1. Read `DESIGN.md`.
2. Identify existing relevant design rules.
3. Search the codebase for reusable components/patterns.
4. Implement using existing tokens/components whenever possible.
5. If a new pattern is necessary, define it consistently with the existing design system.
6. Update `DESIGN.md`.
7. Implement the code.
8. Verify consistency with surrounding pages/components（对比 ExportView / SyncSettingsView 等既有页面）。

## 🛡️ Existing UI Protection（现有 UI 保护）

不要因为"可以做得更漂亮"就主动重新设计现有页面。除非任务明确要求 redesign，否则：

- 保持现有视觉语言、已有交互方式、用户已熟悉的 Pattern
- 优先做**最小范围修改**（fix only what was asked）
- 不要在实现一个功能时顺便大规模修改无关页面样式
- 与既有页面观感不一致时，以既有页面为准，不要反过来改既有页面

## ♻️ Reuse Before Creating

在创建任何新的 **Component / Hook / Utility / Style / Type / API abstraction** 之前，必须先搜索项目是否已经存在类似实现：

1. **Reuse**（直接用）
2. **Extend**（扩展现有：加 props / variant / 参数）
3. **Refactor**（先重构现有实现使其可复用）
4. 最后才是 **Create**

**Reuse 检查清单（按序）：**
- `src/client/common/ui.tsx` 与 `src/client/common/*`（UI 原语）
- `src/ui/*`（控制器 / 纯函数 / 渲染模型）
- `src/core/*`（引擎能力）
- `src/utils/*`（通用工具：`paths.ts` / `zip.ts` / `hashing.ts` / `json.ts`）
- `src/security/*`（脱敏 / 校验）
- DESIGN.md 的 Components 与 Common UI Patterns 章节

避免项目出现多个功能相同但实现不同的组件（历史教训：先搜再写，写前读同目录相似文件）。

## 📦 Dependency Rules

- 如果已有 Library 可以完成需求，**优先使用已有 dependency**（当前运行时依赖仅 `js-yaml`；peer 依赖是 DSH 官方包）
- 不要为了很小的功能随意增加：UI Library / CSS Framework / Icon Library / Animation Library / Utility Library
- 增加新的 dependency 前必须确认：现有方案（含 DSH 官方 peer 包）里没有合适选择；且需要评估发布限制（部分 DSH 核心包未发布公共 registry，peer 安装需 `--legacy-peer-deps`）
- 新增依赖后必须同步更新 `package.json` + `package-lock.json`（两处 + 根对象）

## ✅ Verification（改完代码后的检查）

按改动范围执行（`package.json` 实际存在的脚本，禁止编造）：

```bash
npm run typecheck   # 所有改动必跑（tsc --noEmit）
npm test            # 动了逻辑 / 纯函数 / 引擎 / 适配器必跑
npm run build       # 动了 client / 样式必跑（tsdown 验证 bundle 可出）
npm run smoke       # 仅 core 冒烟（大改动后跑）
```

UI 修改额外自查清单：

- [ ] 与 `DESIGN.md` 一致（token / 组件 / spacing / radius / 状态语义）
- [ ] Responsive behavior：flex-wrap / auto-fit grid 是否足够，长内容是否限高内滚
- [ ] Hover / Focus / Disabled / Loading / Empty / Error 状态齐全
- [ ] Dark Mode：颜色全部来自 `--dsw-*` token（跟随主题），无 hardcode
- [ ] 未错误创建已有组件的重复实现（`ui.tsx` 检查过没有更合适的）
- [ ] 新增样式已在 `config-manager.module.css` 且已进 DESIGN.md（新 Pattern 时）
- [ ] 新文案已进对应 locale 字典（zh + en 镜像）
- [ ] 敏感字段未落入 sessionStorage / 日志 / 回显（白名单 + redact 检查）

## 📚 Documentation Maintenance（文档同步）

`AGENTS.md` 与 `DESIGN.md` 不是一次性文件，代码变化时同步维护：

| 代码变化 | 要更新的文档 |
|---|---|
| 新 Design Pattern / 新 Shared Component（涉及 UI Pattern） | `DESIGN.md` |
| Design Token / 主题 / 全局样式变化 | `DESIGN.md` |
| 新目录约定 / 新架构 Pattern / 新开发规范 | `AGENTS.md` |
| 新页面 / 新视图（布局模式变化） | `DESIGN.md`（Common UI Patterns） |
| 新脚本 / CI 变化 | `AGENTS.md`（开发命令 / 发布流程） |

**代码和文档必须保持同步**；两文件冲突时，以实际代码为准修正文档（不要反过来改代码迁就文档）。

## 📌 常见坑（改动前记得）

- **pnpm 发布年龄策略**：`@latest` 装到旧版 ≠ 缓存问题，是 pnpm 11 `minimumReleaseAge`（发布不足 30 天的新版本被排除）；解决：精确版本装一次自动白名单，或在 `pnpm-workspace.yaml` 设 `minimumReleaseAge: 0`
- **MemFs 测试路径**：内存 fs 的 key 必须与宿主 path 解耦（POSIX 的 `path.resolve` 对 win32 home 会注入 cwd）
- **Windows LF→CRLF 警告**：git 提示 "LF will be replaced by CRLF" 为无害噪音，勿惊慌
- **根目录勿提交**：`lib/`、`dist/`、`node_modules/`、`outputs/`、`my-video/`、`.vibeskills/`、`.agent-teams/` 均已 gitignore
- `dist/` 目录需先创建再 `npm pack --pack-destination ./dist`（fresh checkout 上否则 ENOENT）
- **client bundle 是 cjs + `window.__ModuleLoader__.load` 形态**（`tsdown.config.ts`），改 `format`/入口会破坏加载器；**CSS Modules 构建链只认 `.module.css`**，加别的样式文件不会被打包
- **`src/client/` 不 import 任何 node 模块**（纯浏览器 bundle；`PathMappingForm` 因 `utils/paths.ts` 依赖 node:path 而做了轻量等价实现，是刻意为之）
- **style 属性（inline style）只允许极小修补**（如 MarketPanel 里的 `paddingTop: 4` / 应急颜色），常规布局必须用 CSS 类

## ⛔ 技术限制（不要试图突破）

凭据值无法回滚（DSH 不回读值）、插件安装需重启、MCP 无管理 API（组合 patch 行导入）、浏览器 localStorage UI 状态不迁移、Schema 迁移 v1→v2 为占位（CURRENT=1）、历史会话默认不迁移、加密备份密码丢失无法解密（设计使然）。完整清单见 DEVELOPERS.md §「完整技术限制」。