# AGENTS.md — 规则书

> **只收硬规则**：**非硬规则内容 —— 说明、清单、流程、示例、证据、历史沿革 —— 一律进 `docs/lessons/<域>.md`，本文件只留一行指针**；机制细则 → `DEVELOPERS.md`；UI 规范 → `DESIGN.md`（唯一权威）；对外契约 → `docs/spec/`。
> **预算**：硬上限 28 KiB（workspace instruction 总预算 64 KiB）；>26 KiB 先告警；单行 ≤ 400 B。守卫 `node scripts/check-agents-budget.mjs`（超限时模型只能看到被截断的尾巴）。
> **新增一条坑**：先在 `docs/lessons/<域>.md` 写透证据 → 再回本文件补一行规则 + 指针；**不要把证据写回本文件**。
> **下移存档**：概览 / 目录结构 / 常用命令 / 本机环境注意 / UI 自查清单 → `docs/lessons/repo-overview.md`。

## 🌐 语言
与用户交流一律中文；代码注释/commit/文档以中文为主，技术术语可保留英文。


## 🗂️ 结构与分层
> 目录树（各目录职责）→ `docs/lessons/repo-overview.md`；`src/index.ts` 保留的 7 条路由、`src/routes/` 10 组；下列为硬规则。
1. 业务逻辑放 `src/ui/`，React 壳只装配；页面落位/共享原语/状态中枢清单 → `DEVELOPERS.md`。
2. 新增一条 API = 在所属组文件加一条 `endpoint({ path, methods }, handler)`；路由注册**只经** `src/routes/kit.ts`。
3. `src/client/**` **不得 import node 模块**；跨端共享只能进零依赖模块；`src/profiles/dsh-profile-io.ts` 绝不能被浏览器半 import。
4. 根目录只放对外文档（`README*`/`CHANGELOG`/`SECURITY`/`LICENSE`）与协作规范；其余进 `docs/`。
5. 写/改 CHANGELOG 前先按 `.dsh/skills/changelog-writing` 落位并跑自检；会话相关改动先读 `docs/lessons/sessions-*.md`。

## 🔢 版本三处必须同步（最易漏）
`package.json.version` ≡ `src/index.ts` 的 `PLUGIN_VERSION`(约L124) ≡ `package-lock.json` 根对象 version(L3) 与 `packages[""].version`(L9)。bump 后跑 `npm run typecheck` 确认。
**自动化断言**：`tests/packaging-contract.test.ts` 的 `V-1` 四条（源码级正则读 `PLUGIN_VERSION`，不 import 宿主入口）——任一处漏改即 `npm test` 红灯。

## 🚀 发布（打 tag 全自动）
**发版前两道门禁**（漏了 CI 直接 fail）：① 上述三处 version 同步；② `CHANGELOG.md` 顶部加当前版本双语亮点段。
打 tag 即全自动（`tag v* push` → typecheck → test → build → pack → npm publish(OIDC) → GitHub Release）；完整步骤、OIDC 与产物路径 → `DEVELOPERS.md` §「自动发布」。

## 🔐 安全不变量（硬约束，不得破坏）
> 证据与实现明细：`docs/lessons/security-and-credentials.md`、`docs/lessons/sync-channel.md`、`docs/spec/sync-channel-v1.md`。
- **凭据值与密码绝不回读/落盘/落日志/回传浏览器**：`includeSecrets` 缺省 false；导出密钥 = 独立密文凭据载荷（不进 `sections`）。
- **凭据计划项：值的有无优先于本机状态**：有值一律 `MissingSecret` 并写回（不因本机已配置而跳过）；无值才按 `isCredentialConfigured` 跳过；同步侧值相同→`Skip`；`createImportPlan` 必须收到 `decryptedCredentials`。
- **一键同步差异确认的批量按钮覆盖「全部确认项」、只排除 Error**（`sync-view.isBulkDecidable`）。
- **磁盘占用清理四条不得放宽**：候选只有可重建区 + 显式勾选的过期导出；`snapshots`/`sync` 永不进候选；`categories` 是分区白名单；界面数字由渲染行现算；ENOENT 不计 errors。
- **同步分区放行是「逐分区」而不是布尔**：`syncSectionCatalog` 由注册表派生；放行只看引擎构造期 `optInSections`；自动同步与 model-tools 只传 `'auto'` 档（sessions 绝不悄悄上下行）。
- **同步通道「会话管理」五条**：远端保留接 GFS（刚 push 的恒保留）；重定基贯通（`sourceHome`，缺则不猜）；`sessionsInclude` 优先于 `sessionsLimit`；blob 仓缺 blob 硬失败、加密快照永不外置；删除墓碑不删本机数据（→ `docs/lessons/sync-channel.md`）。
- **同步写路径两条**：索引写入必须**条件写**（远端被改过即中止报错，绝不覆盖别人的条目；gist 弱 ETag 不用做 If-Match）；快照**不进机器专属路径**（pnpm store/cache 导出侧剥离、写回保留本机）（→ `docs/lessons/sync-channel.md`）。
- **日志全程脱敏**：`redactValue` 掩码敏感值；UI 渲染前所有错误/报告再过 `redact()`（`ErrorBanner.tsx`/`ReportView.tsx`）。
- **ZIP 视为不可信**：条目数上限、checksum、Zip Slip 拒绝（`src/security/zip-security.ts`）。
- **导入前强制快照**（可回滚）、Dry Run 零写入、冲突不默认覆盖。
- **加密备份 / 导出**：密码仅内存传入，不落盘/不落日志；解密明文 ZIP 为临时文件用完即清。
- **同步通道的加密/解密密码是唯一例外**：不勾选即删除、不留空；只存 DSH credentials 专用槽位（`DSH_CONFIG_MANAGER_SYNC_ENCRYPT_PASSWORD_<GIT|WEBDAV>` 等），值绝不写入 `sync-*.json`/响应/日志/浏览器；请求体优先于已存、删除优先于写入。
- 同步凭据走 DSH credentials 槽位引用（`SYNC_CREDENTIAL_REF` 等），`passwordConfigured` 仅布尔标记。
- **备份形态判定只有一份实现**：`src/security/container-kind.ts`（只读前 4 字节，读不到回落 `'zip'`）；未解锁容器一律 400 `encrypted-container`；`src/client/**` 只能 import 零依赖的 `utils/shared-constants.ts` 拿码。
- **SAFE MODE**：落盘即跨重启生效；解除判据只有 `resolveSafeMode` 一份（扫描失败 fail-closed）；启动侧陈旧标记复位 = `resolveStartupSafeMode`；`GET /recovery/status` 回传 `safeMode.blocked/clearable`；解除端点不过 mutation gate，但有未解决 incident 必拒。
- **敏感值形状判定是全仓单一来源**（`matchSecretValuePattern`）：`bearer` 大小写不敏感，厂商前缀（`sk-`/`AKIA`/`ghp_`）保持大小写敏感 —— **别顺手加 `i`**（G-36）。
- **sessionStorage 白名单**：`run-store.ts` `toPersistedState()` 解构剔除 `password/passwordConfirm/secretInputs/decryptPassword/decryptRefs/archiveUnlocked/conflictCollector`；新敏感字段不显式放行即不落盘。


## 🏗️ 架构心智
- 双面插件：host `src/index.ts`（Cordis `name='config-manager'`，`/api/dsh-config-manager/*`）+ web `src/client/`（React，settings.section，经 api 调 host）。
- **宿主路由只经 kit 的 `endpoint()` 声明 + `registerRoutes()` 注册**（围栏与方法白名单在注册点统一包装；`registerRoutes()` 兜底断言未经 kit 的路由直接抛错）。
- 路由源 = `src/index.ts`（被窗口守卫**钉住的 7 条**）+ `src/routes/*.ts`（**其余 75 条**；合计 82 条）；源码级守卫必须扫**全部**路由源。
- **插件 HTTP API 的真实认证边界 = kit 的围栏，不是 DSH 的 cookie**：DSH 的 cookie 拒绝只挂在 `kind:'prefix'`、`path:'/api'` 的 RPC 承载路由上，而派发顺序是 **exact 表先命中** ⇒ 本插件 82 条路由永不进入该认证路由。
- 推论：**不得把 DSH 会话认证当兜底，也不得写成「插件 API 无认证」**——本机任意非浏览器进程无 token 即可调用全部 82 条路由（远程/LAN 与跨站 CSRF 被围栏挡掉；经代理/隧道暴露时必须在注册点统一加认证，→ `DEVELOPERS.md`）。
- 新功能优先加 `src/core/`，适配器/UI 薄壳；15 adapter 与 `self` 分区口径 → `DEVELOPERS.md` 架构节。
- 同步：`SyncEngine`+`Git/WebDavTransport`+`AutoSyncScheduler`（事件驱动）；**autosync 与 sync-selection 按通道独立**（schema v2）。
- **import 一律带 `.ts` 后缀**（Deno-style）。
- 设计决策看 `docs/design/`；**对外契约看 `docs/spec/`**，改格式行为必须同步 `docs/spec/` 并重跑 `tests/conformance/`。
- **client bundle 自包含护栏**：`src/utils/bundle-scan.ts` + `src/client/bundle-selfcontained.test.ts`；**必须 Build 之后单独跑**（`npm test` 时产物不存在 → 跳过），CI 有独立步骤。
- **只读预览与导出必须同口径**（共用 `collect()`；无内容形态不得交给 exporter/importer/快照；收窄收集面必须覆写 `listRelPaths()`）；**归档缓存**只在只读入口读、`executeImportPlan` 一律 refresh（→ `docs/lessons/sessions-import-export.md`）。
- **更新检查与自更新**：检查只读、**绝不自动安装**；`POST /update-apply` 过 mutation gate、钉精确版本、非 registry 安装与 desktop 档案带码拒绝；成功后**必须重启才生效、绝不自动重启**（→ `DEVELOPERS.md`）。
- **兼容性评分必须能解释自己**：`compatibilityReasons()` 单一事实源、评分口径已冻结；界面只做「原因 → 字典键」映射，**禁止渲染裸枚举**。（→ `DEVELOPERS.md`）
- DI 走 Cordis fiber：client 经 `ctx.slots.inject('settings.section')`；host 可选服务**一律 `ctx.get()` 惰取，禁止属性访问 `ctx.<svc>`**（未声明 inject 即使服务存在也抛错、致宿主启动崩溃）。


## 🛠️ 开发规范

### TS/命名
- **import type**（`verbatimModuleSyntax` 强制）；类型合并用 `declare module`+`import type{}`。
- React：函数组件+hooks，无 class/高阶组件（**唯一显式例外** = `ChatEntryErrorBoundary`，边界见 `docs/lessons/recovery-console.md`）；props 显式 `XxxProps`；导出类型汇总于 `src/client/index.ts`。
- 命名：组件/类型/类 PascalCase，函数/变量 camelCase，常量 UPPER_SNAKE，CSS 类名 camelCase。
- 分号暂未统一——跟随所在文件风格，勿同一次 diff 混改。

### 状态管理
- 状态归属：高频可恢复流程（Export/Import）进 `run-store.ts`；低频面板进切片（**进行中操作也算状态**）；凭据只存内存并被 `toPersistedState` 白名单剔除（细则 → `DEVELOPERS.md`）。

### 数据访问/错误
- 一律走类型化 api 类(`ConfigManagerApi/SyncApi/MarketApi`)，实现 `src/ui/types.ts` port 契约；**组件禁止直接 fetch**。
- 错误链：`toActionableError()` → `ErrorBanner`；**展示文本渲染前过 `redact()`**。
- 进行中任务 `runStore.watchRunning(kind,500)` 轮询真实进度；定时器卸载清理+防重。


### i18n
- **禁止硬编码用户可见字符串**：文案进字典；`src/ui/` 走 `UiT`（活翻译器），React 壳走 `t()`（zh 源 / en 镜像），宿主/引擎走 `engineMsg`。**语言在「取文案那一刻」解析**，不得在装配期快照（→ `DEVELOPERS.md`）。
- **新增用户可见文案必须进目录**：zh 逐字保留、en 补齐；既有键的 zh/en 指纹冻结在 `src/core/engine-locale.test.ts`（只许追加）。
- **静态守卫**：`node --test tests/i18n-hardcoded-guard.test.ts`（退出码 0 = 零命中）；作用域自检用 `DCM_I18N_GUARD_SCOPE`；白名单新增**只能走 captain**。
- 7 套字典对照表与「查不到 key 不等于缺陷」的排查姿势 → `DEVELOPERS.md`。

### 测试
- `node:test`+`node:assert`(零依赖)，同文件 `*.test.ts` 同目录。
- `src/ui/` 纯函数与 `src/core/` 引擎必须有单测；React 无组件框架，逻辑提炼到 `src/ui/` 保证可测。
- 新功能必带测试，加密/同步/安全类尤其（样板：`src/security/security.test.ts`、`src/sync/sync-engine.test.ts`）。

## ⚙️ 命令与验证
- **改完必须按序验证**：`npm run typecheck` → `npm test` →（动 client/样式）`npm run build` →（大改动）`npm run smoke`；`npm run build` 前把 `TEMP`/`TMP` 指向工作区内 `.tmp/buildtmp`，`npm test` 用系统 TEMP。
- **没有 lint/format 脚本**（typecheck 是唯一兜底）；命令全表、本机环境注意与 UI 自查清单 → `docs/lessons/repo-overview.md`。

## 🎨 UI / DESIGN SYSTEM（最高优先级）
> **`DESIGN.md` 是 UI/样式决策唯一权威**；涉及 UI/Layout/CSS/颜色/字体/间距/图标/动效/响应式前必读。
- **设计 token 必须定义在 `body`**：DSH 的 `--dsw-*` 定义在 **body** 上（`dsh-client-ui-theme`），而 var() 在**声明它的元素**上替换 ⇒ 挂 `:root` 时 `--cm-*` 链在 html 就失效、挂 `.section` 时 Portal 到 body 的弹窗看不见（→ `docs/lessons/recovery-console.md`）。
- **颜色三层单向依赖**：组件只写 `--cm-*`，`--dsw-*` 只允许出现在 `--cm-*` 定义行；禁止 hardcode；tint 用 `color-mix(in srgb, var(--cm-*) <pct>%, transparent)`（`css-token-guard.test.ts`）。
- **样式只能进 `src/client/config-manager.module.css`**：禁止内联 `<style>`/第三方 css；类名用 CSS Modules（`css.xxx`）；**scale 有源级守卫**（字号/间距/圆角/行高/z-index，`css-scale-guard.test.ts`），新档位先改 DESIGN.md §3–§5。
- **复用优先**：`common/ui.tsx` 原语 + `ErrorBanner/ProgressBar/ReportView` 等；已有组件能解决就禁止重建，新页面先搜库。
- **默认不引入第二套视觉体系**。**图标 = `lucide-react`**（`common/Icon.tsx`）；**形变仅 `ExpandChevron`/`CopyStateIcon`**（`morphicons`，硬约定 `reducedMotion="user"`/`spring={MORPH_SPRING}`，**不得扩大范围**）。
- 按钮语义：primary(主操作)/ghost(次)/danger(危险)，勿用 primary 做危险操作；徽章 `Badge kind="ok|info|warn|error"` 对应 Banner 四态；展示文本渲染前过 `redact()`。
- **长列表/大报告必须限高内滚**（`planScroll` 等 5 个类），禁止撑长整页。
- **页面/文案克制**：页面/预览/弹窗只留能改变决定的信息，**不加无用描述**；解释进 ⓘ 或文档。→ `DESIGN.md §7`
- **页落位**：`home`/`library`/`sync`/`environment` 四页；**市场不是页面**（Task 承载）；**加页面/改 id 必须同改 `parsePersistedState` 映射与 `run-store.test.ts` 迁移用例**。
- DESIGN.md 未覆盖时：搜库确认 → 能扩展先扩展 → token+color-mix → **写回 DESIGN.md** → 再使用；**除非明确要求 redesign，否则最小范围修改**、与既有页面观感不一致时以既有为准。第三方 UI 库须走 7 步准入（→ `DEVELOPERS.md` / `DESIGN.md §6`）。

## ♻️ Reuse Before Creating
新建任何 Component/Hook/Utility/Style/Type/API 前按序：①Reuse ②Extend ③Refactor ④Create。
检查顺序：`src/client/common/*` → `src/ui/*` → `src/core/*` → `src/utils/*` → `src/security/*` → DESIGN.md。避免功能相同实现不同。

## 📦 Dependency Rules
- 已有库能满足优先用现有（运行时依赖仅 `js-yaml`；peer 是 DSH 官方包）。
- 不为小功能随意加 UI/CSS/Icon/Animation/Utility 库；**也不引入已准入库的同类替代品**（图标/形变/弹窗）。
- 加依赖前确认现有方案无合适选择；新增后同步更新 `package.json`+`package-lock.json`（两处 + 根对象）。



## 📚 文档同步
| 代码变化 | 更新 |
|---|---|
| 新 Design Pattern/Shared Component/Token/主题/新页面 | `DESIGN.md` |
| 新目录约定/架构Pattern/开发规范/脚本/CI | `AGENTS.md` |
| 新增/修订常见坑（规则） | `AGENTS.md` §📌 常见坑 **和** `docs/lessons/<域>.md`（规则 + 证据两处同步） |
| 新增/调整 CHANGELOG 体例或分组约定 | `CHANGELOG.md` 头部 + `changelog-writing` skill + 版本段模板（三处同步） |
| **用户可见的功能 / 行为 / 修复**（含 UI 体验与文案诚实性） | **同轮**写进 `CHANGELOG.md` 的 `## [Unreleased]`（按 `changelog-writing` skill 落位并跑 §4 自检）—— 漏写实测过 |
| 新增/修订经验或证据（真机事故/量化数据/复现脚本） | `docs/lessons/<域>.md`（**只写证据**；规则回 `AGENTS.md` 对应小节补一行 + 指针） |

代码与文档同步；冲突时以代码为准修正文档。

## 📌 常见坑
> 只留规则判据；**真机证据、量化数据、复现与复核脚本见 `docs/lessons/<域>.md`**（索引 = `docs/lessons/README.md`）。

**Git / 版本发布** → `docs/lessons/git-and-release.md`
- git 同步工作副本的 `origin` **必须每次跟随 `repoUrl`**（含 `--push`；不一致即 `set-url`，一致时零写命令）。
- **删任何源文件前先 `git status --porcelain <路径>`**：看到 `??` 必须停下确认。
- **绝不用 `git checkout -- <文件>` 回滚本仓库**；撤销自己的改动用针对性 edit 反向操作。
- **EOL 由根 `.gitattributes` 钉死**；源码字面量守卫必须在读取入口折 LF，否则 CRLF 假红。
- **pnpm 11 `minimumReleaseAge`**：`@latest` 可能装到旧版 —— 用精确版本，或设 `minimumReleaseAge: 0`。

**Profile 与隔离实例** → `docs/lessons/profiles-and-instances.md`
- **DSH 没有「默认 / 下次启动 profile」状态**：只由启动参数决定；不写 `<dataDir>/next-profile`。
- **`desktop` 是 Electron 独占保留档案**：启动/删除/改名一律以 `managedProfile` 拒绝；版本只取 `profileContext.installAnchor`。
- **复制档案**：拷完必须 `relinkCopiedTree`；整树拷贝走 async fs；`includeNodeModules=false` 同时跳过 `node_modules` 与 `.dsh-module-fallback`；失败回滚。
- **复制档案中断残留 = 标记先行 + 只认自己的标记**（`.dcm-copy-in-progress.json`）；**不得引入「看着像残留就删」的启发式**。
- **本插件是 bundle 包**：隔离实例挂载必须进 `dsh.profile.bundles`。
- **`cordis.patch.yml` 的 `!!js` 方言**：读写只有 `src/utils/patch-yaml.ts` 一份实现，别在别处 `yaml.load`；「存在但解析不了」拒绝覆盖（ENOENT 才是空层）。
- **pnpm 隔离安装同树布局的推导只有一处**；多候选版本对不上就**不猜**；`session-verify.ts` 与 `dsh-profile-manager` 必须共用。
- **档案启动子进程必须直启入口文件**（`shell:false`；Electron 用 `ELECTRON_RUN_AS_NODE=1`）：Windows「cmd 包装 + `detached`」会吞掉孙进程 stdio ⇒ 日志恒空、**抓不到带 token 的 URL**；上限 30 秒。→ `docs/lessons/profiles-and-instances.md`

**会话与导入导出** → `docs/lessons/sessions-import-export.md`
- **宿主整文件快照「存在但读不出来」绝不写 `existed:false`**（只跳过，绝不产生 `hostFileRemove`）。
- **文件类分区收集一律走 `utils/recursive-walk.ts`**；内核整棵跳过 `node_modules`，跳过项必须进告警。
- **`pnpmWorkspace` 与 `plugins.patchFiles` 必须同进同出**。
- **`bundles` 里无依赖的层只声明、不装 npm**。
- **会话日志的字节改写只允许在宿主侧**；改写 header 必须连目录一起归位，搬不动就回滚；索引刷新用 `reindexSessionHeader`。
- **文件集合分区永不参与导入期前缀映射**；会话只改写首帧 cwd；**导出会话必须连带所属工作区**。
- **会话可见性必须由「包内实际带走的会话」驱动**；每个 id 先试声明形态，再试另一种命名形态。
- **子代理会话导出必须连带父对话**，但**白名单即权威，引擎绝不向下展开**。
- **「历史对话」排序索引键必须用 `sessionIdKey()` 归一化后再查**。
- **journal step 的 `skipped` 只能表示「用户主动跳过」**（`warning`/`failed` 记 `attention`）。
- **会话日志格式版本是「单向兼容 + 静默跳过」**：版本探针从 `installAnchor` 同树读，**绝不拿 semver 猜**，读不到就不提示。
- **`skippedLinks` 的 `too-deep` 不等于「链接」**（深度上限对普通目录同样生效，措辞按真实原因分派）。
- **文件类分区「存在但读不到」必须显式失败**（只有 ENOENT 才算本来就没有）。
- **`readSessionMeta` 有 mtime 失效的缓存**；任一 storage 文件读不到 mtime 就不缓存；测试用 `clearSessionMetaCache()`。

**会话修复与诊断口径** → `docs/lessons/sessions-repair-diagnostics.md`
- **v0 打包行不得被当成 seq 空洞**：必须先展开打包跨度；形状不可判定 = 不透明（**禁止跨它下结论，计划 refuse**）；**未触及帧必须逐字节复用**。
- **会话检测口径按「代际 + 载体」分级**：缺 message id / 空 tool-call id / id 不一致 / 重复 advertised tool call 都被前台拒读；版本读不出时降为 `nextRequestFails`（`codec-uncalibrated`）；**不得写成「transformed 容忍」**。
- **复核门 `unavailable` ≠ 成功验证**：不得标记已验证；仍写台账但不写成功台账、不触发回滚；三态必须进用户可见输出。
- **复验门 catalog 解析不得只按 root 缓存**：依赖日志 header 的判定必须按该日志的 `headerVersion` 重跑。
- **外部来源合成的会话行必须满足 `assertMessageEventShape`**：model source 非空、`data.stream` 是数组、`content` 含 `tool-call`；`tool/result` 用连字符 camelCase 且 `callId` 非空逐字相同；**绝不产出空 callId**。
- **外部来源合成会话要按目标机的版本写**（**绝不一律写最高**；读不到就不转）；标题行不能停在 seq 0。
- **面板侧「布局归位 / 重复 id 隔离」口径与离线 CLI 不同**：`apply!==true` 零写入；每次移动后 `reindexSessionHeader` 必须成功，失败搬回并报 `rolledBack`；**有意差异必须写进文案**。
- **「两侧诚实」：UI 文案每句都要能被代码逐条证明**；**「未知」与「确知为空」必须分开**；功能入口必须在扫过之后始终可见；**用户可见修复必须同轮进 CHANGELOG**。
- **真 codec 复验门的锚点链必须由外部显式给出**（install-anchor → `DSH_CM_DSH_INSTALL` → `process.resourcesPath` → profiles 树）；拿不到锚点如实 `unavailable`。

**恢复 / 救急台 / 救援模式** → `docs/lessons/recovery-console.md`
- **CLI 与救急台必须同一道写入门**（SAFE MODE → 环境锁 → DSH 未运行）；`sessions doctor --json` 的 `ok` 必须 `blocking === 0`；`sessions repair` 读不到会话根必须 exit 1。
- **灾备快照线已收敛下线**：不再自建第二条恢复通道；`BOOT_CRITICAL_RELS`/`profileCriticalRels` 在 `core/boot-paths.ts`（**不得连带删 `boot-safety.ts`**）。
- **救援模式与 `reconcileBundles` 的硬冲突**：`enterRescueMode` 必须同时 `stripDependencies`（退出时逐字节还原）；救援激活期间 `reconcileBundles` 一律停手。
- **离线救急台（`dcm web`）**：一次性 token → HttpOnly 会话 cookie，其余 403；读路径只读、写路径各自过 CLI 同源写入门；判定不许重写；**绝不等于「插件 API 无认证」**。
- **回滚点台账 = 一条一写 + 内容寻址载荷 + 字节预算**；**自动留点缺省关闭**，关闭即**解绑** `session/event` 订阅；活切换经进程内 gate（→ `docs/lessons/recovery-console.md`）。
- **回滚点采集必须有时间预算与取消**；**子代理会话绝不自动留点**；**回退前像落盘**（暂存建不出 = 零写入失败）。→ `docs/lessons/recovery-console.md`
- **捕获必须并发 + 自适应 + 缺口优先**：读/写并发、对象仓写入**不走 temp+fsync+rename**、预算 10–120 s 自适应、缺口优先 + **条目与读预算解耦** ⇒ 覆盖率随回合收敛到 100%。→ `docs/lessons/recovery-console.md`
- **捕获绝不碰含 `.asar` 段的路径**（宿主当容器解析 ⇒ 畸形夹具带走整个宿主 = 桌面闪退），在飞内容闸门只接 `captureInFlightBytes`（缺省 32 MiB；接 `maxFileBytes` = 允许整点预算同时驻留）。→ `docs/lessons/recovery-console.md`
- **拒删按分子树、不按全局**：忽略目录 / 读不出的目录 / 没走查到的子树（`unwalkedDirs`）只让**它们自己**不删；只有范围说不清（列表被记录上限截断 / 老台账）才全局 fail-closed。→ `docs/lessons/recovery-console.md`
- **回滚点 = 工作区 + 会话两态**（引擎 `src/core/rollback-point.ts`；`src/core/rollback.ts` 是导入补偿引擎，勿混用）：按回合自动留点、只覆盖记录在案路径、校验失败整体回滚；旧 `checkpoints/` 不再读取也不删。
- **客户端读回滚点必须收尾后有界重试（空列表在窗口内是暂态）**：留点在收尾**之后**，即时查询都可能早于它；窗口关且仍为空才说「没有回滚点」；每个挂载只跑一轮窗口、**不得**无限轮询。
- **救援点（guard）不占自动点的 20/50 预算、用户不可删，但有自己的两道上限**（每会话 20 → 全局 50，超出淘汰最旧）：**不得**写成「无上限保留」或「受保护的点永不淘汰」。
- **回滚点的「工作区态」必须是「该回合开始前」**：留点在 `turn/start` 拍（`turn/end` 只更新缺省边界）；在回合结束拍会固定成「改完之后」⇒ 用户看到「文件没被撤回」（→ `docs/lessons/recovery-console.md`）。
- **回退删除集只有一份规划**（`planCreatedRemovals`；预览 = 执行）、**判据 = 能证明「留点时不存在」**（只有证明名单不完整才不删，`truncated` 不算）。证据 → `docs/lessons/recovery-console.md`
- **会话日志「就地截断」在运行中的 DSH 里不可能生效**：宿主内存里的活动会话不重读磁盘（离开再回来 / 整页刷新都不重读），平台也没有 drop/reload API ⇒ 回退只能是「fork + 归档原会话」（A 无感替换）。
- **宿主服务的方法抽出来必须 bind 回服务对象**；三档降级判据不动，只补 receiver。
- **回退 fork 必走 DSH 的 `sessionController.fork`（落盘 + 归位），绝不直接 `SessionStore.fork`；归位 cwd 必须多源 + 失败重试 + 失败写诊断** → `docs/lessons/recovery-console.md`。
- **「查看」进 DSH 右侧栏**：`sidebarRightTabs.register` + 正文位 `sidebar.right.pane.tab`（key = 实现 id）各注册一次；服务惰取、抽出方法必须 bind、补试幂等、形态不符即不注册，缺能力降级为弹窗内展示 → `docs/lessons/recovery-console.md`。
- **接管聊天用户消息后正文不得自绘**：必须 `renderFactorySlot('conversation.chat.user.content', …)` 委托宿主 + 自绘气泡当 `options.fallback`（判据 = 那条 factory 注册与否）；**回滚点开关关闭时不得再接管 user cell**（→ `docs/lessons/recovery-console.md`）。
- **崩溃残留只放行可自证形状**：自证门仅 `backup-schedule` → `docs/lessons/recovery-console.md`。

**第三方插件数据** → `docs/lessons/plugin-data-migration.md`
- **插件数据分区的收录面只有两个来源**：内置来源表 + **已安装插件**自述的 `dsh.dataDirs`；**包内声明的路径绝不构成写入授权**。
- **`cache` 区域与 `excludeRel` 命中的内容永不收录**；`excludeRel` 是**区域相对**路径。
- **区域被环境变量覆盖（取值 ≠ 默认位置）即报码跳过**：绝不按默认位置读、也不猜。
- **这两个分区的根是系统主目录（`HostContext.osHomeDir` / `homeFs`），不是 `$DSH_HOME`**：I/O 一律 `fsForSection()`；缺 `homeFs` 必须显式报码，**绝不退回 `ctx.fs`**（→ `docs/lessons/plugin-data-migration.md`）。
- **离线 CLI 不收集 `pluginData` / `pluginAssets`**（`OFFLINE_EXCLUDED_SECTIONS`）；显式 `--sections` 请求时提示改用 GUI，不静默少收。
- **「按插件看」归属键只有 npm 包名**：`pluginFiles` 无包名信息 ⇒ 不猜归属；注册表有而清单无的单元一律**不可勾**。

**打包与 client bundle** → `docs/lessons/packaging-and-bundle.md`
- **client bundle 是 cjs + `window.__ModuleLoader__.load`**；CSS Modules 只认 `.module.css`；`style` 属性只允许极小修补；**宿主模块表里的包（如 ui-primitives）只能帧内惰取 + try/catch + 回落**（`src/client/common/host-primitives.ts`，→ `docs/lessons/packaging-and-bundle.md`）。
- **issue #57–#60 四条**：`file:` spec 打包前 `stat` 判形态；同步快照 JSON 读写同口径（512 MiB）；`runStore.patch()` 后必须 `patchSyncPasswords()` 写回内存；git 源安装需 `scripts.prepare` + pnpm 11 `allowBuilds`。
- **MemFs 测试**：内存 fs key 与宿主 path 解耦（win32 home 注入 cwd）。

## ⛔ 技术限制（勿突破）
凭据值无法回滚(DSH 不回读)、插件安装需重启、MCP 无管理 API(组合 patch 行导入)、localStorage UI 状态不迁移

