# AGENTS.md — DSH Config Manager 仓库协作指南

> 完整架构/测试矩阵/限制见 `DEVELOPERS.md`；用户文档见 `README.md`；UI 唯一权威见 `DESIGN.md`。
> 本文只写改动前必知的隐性约定与坑。

## 🌐 语言
与用户交流一律中文；代码注释/commit/文档以中文为主，技术术语可保留英文。

## 📦 概览
- 用途：DSH 配置的备份/导出/导入/迁移/远程同步/配置市场，双面 Cordis 插件。
- 技术栈：TS 5.9（strict + `verbatimModuleSyntax` + `noUncheckedIndexedAccess`）、Node≥22（host）、React 18 + CSS Modules（web）、`node:test` 零依赖、tsdown + lightningcss 打包 client。
- 样式：**CSS Modules 唯一样式表 `src/client/config-manager.module.css`**；颜色/字体/阴影全走 DSH `--dsw-*` 变量；**默认不引入 Tailwind/CSS-in-JS/Sass/UI 库/图标库/动画库**——确需追加时按下方「第三方 UI 库准入」流程评估后落地。

## 🗂️ 结构与分层
```
src/index.ts   host 入口(name='config-manager'；/api/dsh-config-manager/*，约2800行)
src/core/      引擎(exporter/importer/restore/rollback/run-registry/plugin-cli)，与DSH解耦(ConfigAdapter/HostContext+内存mock)
src/schema/    类型/Manifest/版本(CURRENT_SCHEMA_VERSION=1)
src/security/  secret-scanner/redaction/zip-security/integrity/encryption(scrypt+AES-256-GCM)
src/adapters/  13适配器(settings/ui/providers/plugins/mcp/prompts/skills/agentPresets/agentInstructions/workspaces/credentialsStatus/pluginFiles/self；includeSessions:true 时 +sessions=14)
src/sync/      SyncEngine+Git/WebDav+AutoSyncScheduler+config/state/history/sync-selection
src/market/    GitMarketReader+index-parser+security校验+builtin；github-repos.ts+my-repo.ts+git-file-writer.ts
src/migrations/ schema迁移链(registry+v1→v2占位)
src/profiles/  ProfileManager(保存/切换带Preview+快照+回滚)
src/ui/        框架无关UI逻辑(纯函数/控制器，无React，node可测)  ← 业务逻辑必须在此
src/utils/     paths/zip/hashing/json/logger
src/client/    React壳(浏览器半)  ← 只做装配
tests/ 集成测试(node --test)；docs/design/ 设计文档；docs/spec/ 对外契约(格式规格/schema/兼容矩阵/已知缺口)
```

### UI 分层铁律
1. **逻辑放 `src/ui/`**（纯函数/控制器）——禁止在 React 组件里写可测试业务逻辑。
2. **React 壳只装配**（`src/client/` 组件只渲染+交互状态，模型来自 `src/ui/`）。

### 页面落位（src/client/）
- 七 tab 容器：`index.ts` + `ConfigManagerSection.tsx`（Overview/Export/Import/Snapshots/Sync/Market/Profiles/More；tablist 支持方向键导航）；总览为默认首 tab（`panel:'overview'`，旧 panel 缺省值经 parsePersistedState 迁移）
- 总览 `overview/OverviewPanel.tsx`（纯函数模型 `src/ui/overview-view.ts`：指标/健康判定/建议/最近活动/相对时间）
- 导出 `export/ExportView.tsx`；导入九步 `import/ImportWizardView.tsx`（外层包装 Stepper 步骤条 + `ImportWizardBody` 本体；纯函数 `src/ui/import-stepper.ts`；+`ConflictList/PathMappingForm/import-file-select`）；快照 `snapshots/SnapshotsPanel.tsx`
- 历史 `history/HistoryPanel.tsx`；同步 `sync/SyncSettingsView.tsx`(+`SyncConfirmView/SyncHistoryView/sync-view`)；市场 `market/MarketPanel.tsx`(+`MyConfigsView/my-configs-view/my-configs-api`)；咨询 `consult/ConsultCard.tsx`
- 共享原语 **`common/ui.tsx`**（Button/Badge/Banner/Card/Spinner/Field/SectionTitle/Empty/Checkbox/Stepper）+`common/ErrorBanner.tsx`/`ProgressBar.tsx`/`ReportView.tsx`/`ConfirmDialog.tsx`（含 focus trap）
- 状态中枢 `run-store.ts`（模块级单例+sessionStorage 白名单）；数据访问 `api.ts`/`sync/sync-api.ts`/`market/market-api.ts`；文案字典 `locales.ts`/`sync-locales.ts`/`market-locales.ts`（zh 源/en 镜像）
- 样式全在 `src/client/config-manager.module.css`

- **Hook**：本仓库无自定义 hooks 目录，组件内联 state + `useSyncExternalStore` 消费 runStore，复用逻辑下沉 `src/ui/`。不要新造 hooks 层。
- **Type**：领域类型 `src/core/types.ts`/`src/schema/types.ts`/`src/sync/*`/`src/market/types.ts`；UI 类型 `src/ui/types.ts`；client 专属 `src/client/client-types.ts`。
- **Utility**：`src/utils/` 或模块私有；带业务语义的纯函数优先 `src/ui/`。

## 🔢 版本三处必须同步（最易漏）
`package.json.version` ≡ `src/index.ts` 的 `PLUGIN_VERSION`(约L124) ≡ `package-lock.json` 根对象 version(L3) 与 `packages[""].version`(L9)。bump 后跑 `npm run typecheck` 确认。

## 🚀 发布（打 tag 全自动）
CI `.github/workflows/publish.yml`：tag `v*` push → typecheck → test → build → pack → npm publish(OIDC) → GitHub Release。
步骤：①bump 三处版本；②`CHANGELOG.md` 顶部加当前版本双语亮点段（漏写 CI fail-fast，release 由 `.github/scripts/extract-release-notes.py` 抽取）；③push main；④`git tag -a vX.Y.Z && push`。
注意：手动 `workflow_dispatch` 不建 Release；npm 用 OIDC 无长令牌；版本 `0.1.x`；commit 惯例 `chore: bump to X.Y.Z`；不配 `.github/release.yml`（无 PR+label，GitHub 默认 conventional 分组更好）。
CI 门禁：`.github/workflows/ci.yml` 对 `pull_request`→main 与 `push`→main 跑 typecheck/test/build/pack（最小权限、零发布副作用）；**发版仍只走 tag → `publish.yml`**，两条流水线互不重叠。

## 🔐 安全不变量（硬约束，不得破坏）
- **Secret 默认不导出**：`includeSecrets` 缺省 false；凭据值绝不写入同步文件/日志/回传浏览器。
- **凭据不可回读**：`ctx.credentials` 永不回读值，只经 `HostContext.fs` 文件级读 `.credentials.yaml`；`encryption.ts` 只做字节级加解密。
- **日志全程脱敏**：`redactValue` 掩码敏感值；UI 渲染前所有错误/报告再过 `redact()`（`ErrorBanner.tsx`/`ReportView.tsx`）。
- **ZIP 视为不可信**：条目数上限、checksum、Zip Slip 拒绝（`src/security/zip-security.ts`）。
- **导入前强制快照**（可回滚）、Dry Run 零写入、冲突不默认覆盖。
- **加密备份**：密码仅内存传入，不落盘/不落日志；解密明文 ZIP 为临时文件用完即清。
- 同步凭据走 DSH credentials 槽位引用（`SYNC_CREDENTIAL_REF` 等），`passwordConfigured` 仅布尔标记。
- **sessionStorage 白名单**：`run-store.ts` `toPersistedState()` 解构剔除 `password/passwordConfirm/secretInputs/decryptPassword/decryptRefs/archiveUnlocked/conflictCollector`；新敏感字段不显式放行即不落盘。

## 🏗️ 架构心智
- 双面插件：host `src/index.ts`（Cordis `name='config-manager'`，`/api/dsh-config-manager/*`）+ web `src/client/`（React，settings.section，经 api 调 host）。
- `src/core/` 与 DSH 解耦：`ConfigAdapter`/`HostContext`+内存 mock；**新功能优先加 core，适配器/UI 薄壳**。
- 13 adapter 见结构；`self`=插件自身配置（`$DSH_HOME/dsh-config-manager/` 下 `sync-*.json`/`market-config.json`/`ui-prefs.json` 白名单收，portable 默认包含；`dataDir` 在 `~/.dsh` 外不挂载）。
- 同步：`SyncEngine`+`Git/WebDavTransport`+`AutoSyncScheduler`(事件驱动,远端新快照才拉/本地改动才推)+`sync-selection`；**autosync 与 sync-selection 按通道(git/webdav)独立**(schema v2，v1→git)，调度器双通道各自排期。
- **import 一律带 `.ts` 后缀**(Deno-style，勿写无后缀)。
- 设计决策看 `docs/design/`（上游依据，实现规格在下游）。
- **对外契约看 `docs/spec/`**：与 `docs/design/` 性质不同——`design/` 是**上游设计依据**（写给本仓库），`spec/` 是**对外契约**（写给第三方实现者，应能在不读 `src/` 的前提下据此实现兼容的 exporter/importer）。含：`bundle-format-v1.md`（格式规格）、`bundle-manifest.schema.json`（机器可校验）、`compat-matrix.md`（DSH 兼容区间与升级风险）、`headless-consumption.md`（无 UI 栈消费引擎）、`known-gaps.md`（已知缺口登记）。**改格式行为必须同步 `spec/`，并重跑 `tests/conformance/`。**
- **client bundle 自包含护栏**：`src/utils/bundle-scan.ts`（零依赖扫描内核，**多趟并集**避免注释内反引号导致的状态失衡假阴性）+ `src/client/bundle-selfcontained.test.ts`（产物护栏，白名单仅 react/react-dom/react-dom/client/react/jsx-runtime）。**必须 Build 之后单独跑**——`npm test` 在 Build 前执行，此时 `lib/client.js` 不存在，测试会跳过；故 `ci.yml`/`publish.yml` 各有一独立步骤。注释里的同名字符串会造成假阳性（本仓库实测过）。
- DI 走 Cordis fiber：client 经 `ctx.slots.inject('settings.section')`+`inject:()=>({api,syncApi,...})`；host 可选服务 `ctx.get()` 惰取。

## 🛠️ 开发规范
### TS/命名
- **import type**（`verbatimModuleSyntax` 强制）；类型合并用 `declare module`+`import type{}`。
- React：函数组件+hooks，无 class/高阶组件；props 显式 `XxxProps`；导出类型汇总于 `src/client/index.ts`。
- 命名：组件/类型/类 PascalCase，函数/变量 camelCase，常量 UPPER_SNAKE，CSS 类名 camelCase。
- 分号暂未统一——跟随所在文件风格，勿同一次 diff 混改。

### 状态管理
- 高频可恢复流程(Export/Import)状态在 `run-store.ts`；新视图需「切 tab 不丢/刷新恢复」就入 runStore。
- 低频面板(Snapshots/Sync/Market)组件自持(state+ref) + 非敏感切片镜像 runStore（`toSyncStoreSlice/toMarketStoreSlice/toSnapshotsStoreSlice`）；状态变更统一走 `commit(next)`（更新 stateRef→setState→**总是** `runStore.patch`），不依赖 effect flush；凭据仅内存、瞬态为内存切片，均被 `toPersistedState` 白名单剔除。
- 面板开关存 runStore `panel` 字段。
- 控制器(`ExportFlow/ImportWizard`)由 runStore 缓存复用，**禁止每次渲染 new**；刷新恢复经 `writeWizardSnapshot()` 受控 rehydrate。

### 数据访问/错误
- 一律走类型化 api 类(`ConfigManagerApi/SyncApi/MarketApi`)，实现 `src/ui/types.ts` port 契约；**组件禁止直接 fetch**。
- 错误链：`toActionableError()` → `ErrorBanner`；**展示文本渲染前过 `redact()`**。
- 进行中任务 `runStore.watchRunning(kind,500)` 轮询真实进度；定时器卸载清理+防重。

### i18n
- 文案进字典：React 壳 `t('key')`(zh 源/en 镜像，`ConfigManagerKey` 编译校验)；`src/ui/` 走 `src/ui/i18n.ts` `UiT`(`makeUiT`)。
- **禁止硬编码用户可见字符串**。

#### 字典共 7 套；「查不到 key」不等于是缺陷（排查前必读）
写文案时要放进**正确的那一套**；反过来，**判断「某 key 是否存在」时必须先确认 `t` 的来源**，否则会系统性误报：

| 字典 | zh/en | `t` 的来源 | 缺 key 行为 |
|---|---|---|---|
| `src/client/locales.ts` | 464 / 464 | 组件 props `t`（`ConfigManagerKey`） | **编译期报错** |
| `src/ui/i18n.ts` | 267 / 267 | `UiT`（`api.t` / `zhUiT` / props） | **静默返回 key 本身** |
| `src/core/messages.ts` | 261 / 261 | host/adapter `msg()` | 编译期（`keyof typeof zh`） |
| `history-locales.ts` | 51 / 51 | `historyT` → ns `config-manager-history` | 静默 |
| `market-locales.ts` | 138 / 138 | `marketT` → ns `config-manager-market` | 静默 |
| `recovery-locales.ts` | 95 / 95 | `recoveryT` → ns `config-manager-recovery` | 静默 |
| `sync-locales.ts` | 198 / 198 | `syncT` → ns `config-manager-sync` | 静默 |

**第四个坑：`t` 可经 props 注入 → 静态归属不可判。**
`ConsultCard` 声明 `t: UiT`（不是本地字典），由调用方传 `t={api.t}`。因此「按文件在哪个目录就查哪套字典」**永远判不对**；实测这种静态归属扫描会产生 **600+ 处假阳性**（`error.*`/`history.*`/`myconfigs.*`/`report.*` 等全是注入式 `t`）。

**正确排查姿势**：①先判 `t` 来自 import（编译校验）还是 `api.t` / props 注入（宽松）；②宽松字典里「查不到」**必须**先把 7 套字典取并集再下结论；③真正可靠的护栏是 `ConfigManagerKey` 的编译校验 + `UiT` 的运行时回退，而不是旁路扫字典。

### 测试
- `node:test`+`node:assert`(零依赖)，同文件 `*.test.ts` 同目录。
- `src/ui/` 纯函数与 `src/core/` 引擎必须有单测；React 无组件框架，逻辑提炼到 `src/ui/` 保证可测。
- 新功能必带测试，加密/同步/安全类尤其（样板：`src/security/security.test.ts`、`src/sync/sync-engine.test.ts`）。

## 🧪 命令
```bash
npm install --legacy-peer-deps   # 必须带：部分 DSH 核心只在 peerDependencies
npm run typecheck                # tsc --noEmit
npm run build                    # tsc(host lib/) + tsdown(client lib/client.js)
npm test                         # node --test src/**/*.test.ts tests/**/*.test.ts
npm run smoke                    # 仅 core 冒烟
npm run bundle                   # 仅重建 client bundle
```
- 无 lint/format 脚本，只以 typecheck 兜底（历史 `eslint-disable` 是遗留）。
- CSS Modules 由 tsdown+lightningcss 编译为内联注入，单文件 `lib/client.js` 自带样式；**新增样式只能在 `config-manager.module.css`**。

## 🎨 UI / DESIGN SYSTEM（最高优先级）
> **`DESIGN.md` 是 UI/样式决策唯一权威**。涉及 UI/Layout/CSS/颜色/字体/间距/图标/动效/响应式/视觉状态前必读。

**硬性规则：**
1. 颜色/字体/阴影必走 `--dsw-*` token；**禁止 hardcode**(`#fff`等)，tint 用 `color-mix(in srgb, <token> <pct>%, transparent)`。
2. 样式只能进 `src/client/config-manager.module.css`；禁止新增 css/内联 `<style>`/第三方 css；类名用 CSS Modules 引用(`css.xxx`)，**勿写字符串 class**(`sync-history-table` 属遗留)。
3. 复用 `src/client/common/ui.tsx` 原语 + Common 的 `ErrorBanner/ErrorList/ProgressBar/ReportView`；已有公共组件能解决禁止重建，新页面先搜库。
4. **默认不引入第二套视觉体系**(Tailwind/CSS-in-JS/Sass/UI库/图标库/动画库)；图标默认用文本符号/emoji。确需追加第三方 UI 库时，按下方「第三方 UI 库准入」流程评估后落地。
5. 按钮语义：`variant="primary"`(主操作)/默认 ghost(次)/`variant="danger"`(危险如恢复/回滚)；勿用 primary 做危险操作。
6. 徽章：`Badge kind="ok|info|warn|error"` 与 `Banner` 四态一一对应；先想语义再选 kind。
7. 文案走 i18n 字典；展示文本渲染前进 `redact()`。
8. 长列表/大报告限高内滚(`planScroll/reportScroll/confirmScroll/pullScroll/diffScroll`)，禁止撑长整页。

### Missing Design Rule（DESIGN.md 未覆盖）
①搜库确认无类似 ②能扩展先扩展(加 variant/props) ③尝试 token+color-mix+现有比例组合 ④确实不存在才按既有语言设计新规范(复用既有 Color/Typography/Spacing/Radius/Pattern) ⑤**写入 DESIGN.md** ⑥再使用。
> Never introduce a new visual pattern without documenting it in DESIGN.md.

### Style Change Workflow
读 DESIGN.md → 识别相关规则 → 搜可复用组件 → 尽量用现有 token/组件 → 新 pattern 则先定义→更新 DESIGN.md → 实现 → 与既有页面对比验证。

### Existing UI Protection
除非明确要求 redesign，否则最小范围修改(fix only asked)、保持既有视觉/交互/Pattern、不顺便改无关页面、与既有页面观感不一致时以既有为准。

### 第三方 UI 库准入（按需追加）
默认不引入第二套视觉体系；当现有原语(`common/ui.tsx`)和 DESIGN.md token 无法满足需求时，按以下流程评估后落地：

1. **必要性**：确认 `common/*` → `src/ui/*` → `src/core/*` 无等价方案；能扩展先扩展(加 variant/props)。
2. **Token 对齐**：库必须能消费 `--dsw-*` token（颜色/字体/阴影），不允许 hardcode；tint 仍走 `color-mix`。亮暗主题与皮肤切换下表现一致。
3. **CSS 隔离**：优先 CSS Modules / CSS Variables / Shadow DOM；避免全局注入污染宿主样式。若库自带全局 css，必须在入口做 scope 包裹或 prefix。
4. **体积评估**：tree-shakable 优先；bundle 增量需在 PR 描述中注明（`npm run bundle` 前后对比）。
5. **依赖同步**：新增后同步更新 `package.json` + `package-lock.json`（两处+根对象版本）；peer/dev 区分清楚。
6. **文档落位**：在 `DESIGN.md` 写入新 pattern / 组件用法 / token 映射表；在 `AGENTS.md` 本段记录库名与用途，避免重复引入。
7. **验证**：`npm run typecheck && npm run build && npm test`；UI 自查覆盖 Hover/Focus/Disabled/Loading/Empty/Error + Dark Mode。

> 图标库同理：默认文本符号/emoji；确需图标库时按上述流程评估，优先支持 SVG sprite / icon font 的按需加载形态。

**已落地（2026-09 Visual Polish，按上述 7 步评估通过）**：
- `lucide-react`（图标）+ `@radix-ui/react-dialog`（弹窗 a11y）——均为**无样式/行为级**原语，视觉仍走 `--dsw-*` token，不引入第二套视觉体系。**devDependencies**（经 `tsdown.config.ts` 的 `deps.alwaysBundle` 打进单文件 cjs，已被内联故非运行时依赖；放 dependencies 会迫使 headless 消费者安装整套 React UI 栈）。bundle +136KB raw / +30KB gzip。封装层 `common/Icon.tsx`、`common/Modal.tsx`；细节与未迁移弹窗清单见 `DESIGN.md §6`。护栏：`src/client/bundle-selfcontained.test.ts`（build 后跑）；消费方式见 `docs/spec/headless-consumption.md`。

## ♻️ Reuse Before Creating
新建任何 Component/Hook/Utility/Style/Type/API 前按序：①Reuse ②Extend ③Refactor ④Create。
检查顺序：`src/client/common/*` → `src/ui/*` → `src/core/*` → `src/utils/*` → `src/security/*` → DESIGN.md。避免功能相同实现不同。

## 📦 Dependency Rules
- 已有库能满足优先用现有（运行时依赖仅 `js-yaml`；peer 是 DSH 官方包）。
- 不为小功能随意加 UI/CSS/Icon/Animation/Utility 库。
- 加依赖前确认现有方案无合适选择，评估发布限制；新增后同步更新 `package.json`+`package-lock.json`（两处+根对象）。

## ✅ Verification
```bash
npm run typecheck   # 所有改动
npm test            # 动逻辑/纯函数/引擎/适配器
npm run build       # 动 client/样式
npm run smoke       # 大改动
```
UI 自查：DESIGN.md 一致(token/组件/spacing/radius/状态语义)、响应式、Hover/Focus/Disabled/Loading/Empty/Error 齐全、Dark Mode 无 hardcode、未建重复组件、新样式进 css+DESIGN.md、新文案进 locale(zh/en)、敏感字段未落 storage/日志/回显。

## 📚 文档同步
| 代码变化 | 更新 |
|---|---|
| 新 Design Pattern/Shared Component/Token/主题/新页面 | `DESIGN.md` |
| 新目录约定/架构Pattern/开发规范/脚本/CI | `AGENTS.md` |
代码与文档同步；冲突时以代码为准修正文档。

## 📌 常见坑
- **pnpm 发布年龄**：`@latest` 装旧版是 pnpm 11 `minimumReleaseAge`（<30天被排除）；解决：精确版本装一次白名单，或 `pnpm-workspace.yaml` 设 `minimumReleaseAge: 0`。
- **MemFs 测试**：内存 fs key 与宿主 path 解耦（win32 home 注入 cwd）。
- **Windows LF→CRLF 警告**：无害噪音。
- 根目录勿提交：`lib/dist/node_modules/outputs/my-video/.vibeskills/.agent-teams` 均已 gitignore。
- `dist/` 需先创建再 `npm pack --pack-destination ./dist`（fresh checkout 否则 ENOENT）。
- **client bundle 是 cjs + `window.__ModuleLoader__.load`**（tsdown.config.ts），改 format/入口会破坏加载器；CSS Modules 只认 `.module.css`。
- **`src/client/` 不 import node 模块**（`PathMappingForm` 因 `utils/paths.ts` 依赖 node:path 做了轻量等价实现，刻意为之）。
- **style 属性只允许极小修补**（如 MarketPanel `paddingTop:4`），常规布局用 CSS 类。

## ⛔ 技术限制（勿突破）
凭据值无法回滚(DSH 不回读)、插件安装需重启、MCP 无管理 API(组合 patch 行导入)、localStorage UI 状态不迁移、Schema v1→v2 为占位(CURRENT=1)、历史会话默认不迁移、加密备份密码丢失无法解密。完整清单见 DEVELOPERS.md §「完整技术限制」。
