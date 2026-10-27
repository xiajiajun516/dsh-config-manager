# AGENTS.md

> 只放硬判据：证据与实测 → `docs/lessons/<域>.md`；机制细则 → `DEVELOPERS.md`；UI → `DESIGN.md`；对外契约 → `docs/spec/`。
> 加规则：先在 `docs/lessons/<域>.md` 写透证据，再回下面对应域补一行判据 + 指针，不另起小节。与代码冲突以代码为准，并当轮修本文件。
> 预算：≤28 KiB、单行 ≤400 B —— `node scripts/check-agents-budget.mjs`。

## Rules

### 通用（任何改动）
- **验证顺序**：`npm run typecheck` → `npm test` →（动 client/样式）`npm run build` →（大改）`npm run smoke`；build 前 `TEMP`/`TMP` → `.tmp/buildtmp`；无 lint/format，typecheck 兜底。
- **版本三处同步**：`package.json.version` ≡ `src/index.ts` 的 `PLUGIN_VERSION` ≡ `package-lock.json` 根 version 与 `packages[""].version`；`tests/packaging-contract.test.ts` 的 `V-1` 钉住。
- **发版**：打 `tag v* push` 后全自动（阶段表 → `DEVELOPERS.md`）；前置 = 三处版本 + `CHANGELOG.md` 顶部亮点段；发布成功后按 `.dsh/issue-ledger.md` 的 `awaiting-release` 行回版本号并标 `fixed`。
- **用户可见的功能/行为/修复同轮进 `CHANGELOG.md` 的 `## [Unreleased]`**（落位见 skill `changelog-writing`）。
- **git**：工作副本 `origin` 每次跟随 `repoUrl`（含 `--push`，不一致即 `set-url`）；同一工作副本操作一律经 `GitTransport.withWorkdir()`；拉取只许 `fetch` + `merge --ff-only`，禁 `git pull`（坏 FETCH_HEAD ⇒ SAFE MODE）。
- **删源文件前先 `git status --porcelain <路径>`**：见 `??` 必须停下；禁 `git checkout -- <文件>` 回滚，撤销改动用针对性 edit 反向。
- **只读端点必须有界**：取值体碰不可控依赖（credentials 服务、子进程、工作副本自检、外部 HTTP）一律 `withTimeout` + 明确错误码；客户端首屏不得让单一慢请求垄断骨架。
- **只读端点别在 GET 里 spawn 外部进程**：同一事实被反复索取（首页/切页/轮询）改「按需 detail + 短 TTL 缓存」，缓存 key 含 repoUrl，写路径经 `withWorkdir` 失效。
- **锁等待也是不可控依赖**：只读自检自带 1.5 s 短上限，超时变成「冲突/可重试」错误码；锁回收先判 holder 进程存活，判不了才退回 mtime；等待上限要覆盖进程内链上排队。
- **EOL 由根 `.gitattributes` 钉死**，源码字面量守卫必须在读取入口折 LF；pnpm 11 `minimumReleaseAge` 会让 `@latest` 装旧版 —— 用精确版本或设 0。
- **`import` 一律带 `.ts`**；`import type` 强制（`verbatimModuleSyntax`）；类型合并用 `declare module` + `import type{}`。
- **依赖**：运行时只有 `js-yaml`（peer 是 DSH 官方包）；不加 UI/CSS/图标/动画/工具库，也不引入已准入库的同类替代品；新增后同步 `package.json` + `package-lock.json`（两处 + 根对象）。
- **复用优先**：新建 Component/Hook/Utility/Style/Type/API 前 ①Reuse ②Extend ③Refactor ④Create；查库序 `src/client/common/*` → `src/ui/*` → `src/core/*` → `src/utils/*` → `src/security/*` → `DESIGN.md`。
- **根目录只放**对外文档（`README*`/`CHANGELOG`/`SECURITY`/`LICENSE`）与协作规范，其余进 `docs/`。

### 安全不变量（不得破坏）
- **凭据值与密码绝不回读/落盘/落日志/回传浏览器**：`includeSecrets` 缺省 false；导出密钥是独立密文凭据载荷（不进 `sections`）；密码仅内存，明文 ZIP 用完即清。
- **凭据计划项：值的有无优先于本机状态**：有值一律 `MissingSecret` 写回，无值才按 `isCredentialConfigured` 跳过；同步侧值相同 → `Skip`；`createImportPlan` 必须收到 `decryptedCredentials`。
- **同步凭据与加密密码**：凭据走 DSH credentials 槽位（`SYNC_CREDENTIAL_REF` 等），`passwordConfigured` 只是布尔；加密密码只存专用槽位，不勾选即删不留空，绝不进 `sync-*.json`/响应/日志/浏览器。
- **日志全程脱敏**：`redactValue` 掩码；UI 渲染前错误与报告再过 `redact()`（`ErrorBanner.tsx`/`ReportView.tsx`）。
- **ZIP 视为不可信**：条目数上限、checksum、Zip Slip 拒绝（`src/security/zip-security.ts`）；导入前强制快照、Dry Run 零写入、冲突不默认覆盖。
- **备份形态判定只一份实现**：`src/security/container-kind.ts`（前 4 字节，读不到回落 `'zip'`）；未解锁一律 400 `encrypted-container`。
- **SAFE MODE**：落盘即跨重启生效；解除判据只有 `resolveSafeMode`（扫描失败 fail-closed），启动复位 `resolveStartupSafeMode`；解除端点不过 gate，有未解决 incident 必拒。
- **敏感值形状全仓单一来源**（`matchSecretValuePattern`）：`bearer` 大小写不敏感，厂商前缀（`sk-`/`AKIA`/`ghp_`）**敏感** —— 别加 `i`（G-36）。
- **sessionStorage 白名单**：`run-store.ts` 的 `toPersistedState()` 显式白名单、默认拒绝；新敏感字段不放行即不落盘。
- **磁盘清理候选只含可重建区 + 显式勾选的过期导出**：`snapshots`/`sync` 永不进候选；`categories` 是分区白名单；数字由渲染行现算；ENOENT 不计 errors。
- **一键同步差异确认**的批量按钮覆盖「全部确认项」、只排除 Error（`sync-view.isBulkDecidable`）。

### 架构与路由
- **双面插件**：host `src/index.ts`（Cordis `name='config-manager'`，前缀 `/api/dsh-config-manager/*`）；web `src/client/`（React，settings.section），经 api 调 host。
- **宿主路由只经 kit 的 `endpoint()` + `registerRoutes()`**（围栏与方法白名单在注册点统一包装；未经 kit 的路由注册直接抛错）。
- 路由源 = `src/index.ts`（窗口守卫**钉住的 7 条**）+ `src/routes/*.ts` 其余 75 条（合计 82 条）；源码级守卫必须扫**全部**路由源。
- **真实认证边界 = kit 围栏，不是 DSH cookie**：cookie 拒绝只挂 `kind:'prefix'`/`path:'/api'` 的 RPC 路由，派发 exact 表先命中。
- 推论：**不得把 DSH 会话认证当兜底，也不得写成「插件 API 无认证」**；经代理/隧道暴露必须在注册点加认证（远程/LAN/CSRF 已由围栏挡住）。
- **新增一条 API** = 组文件里加 `endpoint({ path, methods }, handler)`；组文件不得 import `../index.ts`，共享工具进 `src/routes/route-support.ts`。
- 业务逻辑放 `src/ui/`，React 壳只装配；新功能优先 `src/core/`，适配器与 UI 做薄壳。
- `src/client/**` 不得 import node 模块；跨端共享只能进零依赖模块；`src/profiles/dsh-profile-io.ts` 绝不能被浏览器半 import。
- **DI 走 Cordis fiber**：client 经 `ctx.slots.inject('settings.section')`；host 可选服务一律 `ctx.get()`，禁 `ctx.<svc>`。
- **宿主服务与方法抽取**：抽出方法必须 bind 回服务对象；「查看」进右侧栏需 `sidebarRightTabs.register` + 正文位 `sidebar.right.pane.tab`（key = 实现 id）各注册一次；服务惰取、补试幂等、形态不符不注册。
- **对外契约 → `docs/spec/`**：改格式行为必须同步文档并重跑 `tests/conformance/`。
- **client bundle 护栏**：`src/utils/bundle-scan.ts` + `src/client/bundle-selfcontained.test.ts`，必须 Build 之后单独跑（CI 独立步骤）。
- **只读预览与导出同口径**：共用 `collect()`；无内容形态不交给 exporter/importer/快照；收窄收集面必须覆写 `listRelPaths()`；归档缓存只在只读入口读，`executeImportPlan` 一律 refresh。
- **更新检查与自更新**：检查只读、绝不自动安装；`POST /update-apply` 过 mutation gate、钉精确版本、非 registry 与 desktop 档案带码拒绝；成功后必须重启、绝不自动重启。
- **兼容性评分必须能解释自己**：`compatibilityReasons()` 单一事实源、口径冻结；界面只做「原因→字典键」，禁渲染裸枚举。

### 代码
- React：函数组件 + hooks，无 class/高阶组件（唯一例外 `ChatEntryErrorBoundary`）；props 显式 `XxxProps`；导出类型汇总在 `src/client/index.ts`。
- 命名与分号跟随所在文件及周边同类（组件/类型 PascalCase、函数/变量 camelCase、常量 UPPER_SNAKE、CSS 类 camelCase），勿混改。
- 状态归属：高频可恢复流程（Export/Import）进 `run-store.ts`；低频面板进切片（进行中操作也算状态）；凭据只存内存、不落盘。
- 一律走类型化 api 类（`ConfigManagerApi/SyncApi/MarketApi`），实现 `src/ui/types.ts` port 契约；组件禁止直接 fetch。
- 错误链：`toActionableError()` → `ErrorBanner`，展示文本渲染前过 `redact()`；进行中任务用 `runStore.watchRunning(kind, 500)`，定时器卸载清理 + 防重。
- **i18n 禁硬编码**：文案进字典（`src/ui/` 用 `UiT`，React 壳用 `t()`，宿主用 `engineMsg`）；语言在取文案那一刻解析，不得装配期快照。
- **新增文案必须进目录**：zh 逐字保留、en 补齐；既有键指纹冻结在 `src/core/engine-locale.test.ts`（只许追加）；字典对照与排查见 `DEVELOPERS.md`。
- **i18n 静态守卫**：`node --test tests/i18n-hardcoded-guard.test.ts`（退出码 0 = 零命中）；作用域自检用 `DCM_I18N_GUARD_SCOPE`；白名单新增只能走 captain。
- **测试**：`node:test` + `node:assert`（零依赖），`*.test.ts` 与实现同目录；`src/ui/` 纯函数与 `src/core/` 引擎必须有单测；新功能必带测试，加密/同步/安全类尤其。

### UI
- `DESIGN.md` 是 UI/样式唯一权威；动 Layout/CSS/颜色/字体/间距/图标/动效/响应式/文案前必读。
- **token 必须定义在 `body`**：`--dsw-*` 定义在 body，var() 只在声明它的元素上替换 ⇒ 挂 `:root`/`.section` 覆盖不全（聊天节点/侧栏拿不到）。
- **颜色三层单向依赖**：组件只写 `--cm-*`，`--dsw-*` 只出现在 `--cm-*` 定义行；禁 hardcode；tint 用 `color-mix(in srgb, var(--cm-*) <pct>%, transparent)`（`css-token-guard.test.ts`）。
- **样式只进 `src/client/config-manager.module.css`**：禁内联 `<style>` 与第三方 css；类名走 CSS Modules；scale 有源级守卫（`css-scale-guard.test.ts`），新档位先改 `DESIGN.md`。
- **不引第二套视觉体系**：图标只 `lucide-react`（`common/Icon.tsx`）；形变仅 `ExpandChevron`/`CopyStateIcon`（`morphicons`，`reducedMotion="user"`/`spring={MORPH_SPRING}`，不得扩大）。
- **原语复用**：`common/ui.tsx` 原语 + `ErrorBanner/ProgressBar/ReportView`，能解决就禁重建；按钮 primary/ghost/danger，勿用 primary 做危险操作。
- **长列表/大报告限高内滚**（`*Scroll` 系列，新增先看 `DESIGN.md`），禁止撑长整页。
- **页落位**：`home`/`library`/`sync`/`environment` 四页，市场不是页面；加页/改 id 必须同改 `parsePersistedState` 与 `run-store.test.ts` 迁移用例。
- `DESIGN.md` 未覆盖：搜库 → 能扩展先扩展 → token + color-mix → 写回 `DESIGN.md` → 再用；非明确 redesign 一律最小修改。
- **接管聊天用户消息后正文不得自绘**：必须 `renderFactorySlot('conversation.chat.user.content', …)` 委托宿主，自绘气泡当 `options.fallback`；回滚点开关关闭时不得接管 user cell。

### 同步（`src/sync/`）
- **分区放行逐分区、不是布尔**：`syncSectionCatalog` 由注册表派生；放行只看构造期 `optInSections`；自动同步与 model-tools 只传 `'auto'` 档。
- **索引条件写**：远端改过即中止、绝不覆盖别人；gist 例外 = 不做条件头（PATCH 回 400），改写后复核、冲突报 `index-conflict`。
- **快照不进机器专属路径**（导出剥 store/cache、写回保留本机）；S3 授权头逐字序列化；祖先副本只落密文。
- **「本地有改动」与导出载荷必须同一份字节**：`hasLocalChanges` 比 `hashSection(export())` ⇒ 比对里剔掉的易变字段必须同时从载荷剔除，否则每轮轮询都真推一次；身份字节只有 `src/adapters/file-collection.ts` 的 `comparableContent()` 一处。
- **会话管理五条**：远端保留接 GFS（刚 push 恒保留）；重定基贯通（`sourceHome`，缺则不猜）；`sessionsInclude` 优先于 `sessionsLimit`；blob 仓缺 blob 硬失败、加密快照永不外置；墓碑不删本机数据。

### 备份 / 恢复 / 回滚点
- **恢复崩溃后可续跑，但只在逐项可证时**（`judgeRestoreResume`：同快照 + 盘面只等于 beforeFp/afterFp + 不跨入口 + 不重建 WAL；否则 423）。
- **CLI 与救急台同一道写入门**（SAFE MODE → 环境锁 → DSH 未运行）；`sessions doctor --json` 的 `ok` 必须 `blocking === 0`；`sessions repair` 读不到会话根 exit 1。
- **离线救急台（`dcm web`）**：一次性 token → HttpOnly cookie，其余 403；读路径只读、写路径过 CLI 同源门；判定不许重写。
- **不自建第二条恢复通道**（灾备快照线已下线）；`BOOT_CRITICAL_RELS`/`profileCriticalRels` 在 `core/boot-paths.ts`，不得连带删 `boot-safety.ts`。
- **救援模式与 `reconcileBundles` 冲突**：`enterRescueMode` 必须同时 `stripDependencies`（退出逐字节还原）；救援激活期 `reconcileBundles` 停手；崩溃残留只放行可自证形状（仅 `backup-schedule`）。
- **回滚点 = 工作区 + 会话两态**（`core/rollback-point.ts`；`core/rollback.ts` 是导入补偿引擎，勿混用）：按回合自动留点、只覆盖记录在案路径、校验失败整体回滚；工作区态 = 该回合开始前（`turn/start`）；旧 `checkpoints/` 不读不删。
- **回滚点采集**：台账一条一写 + 内容寻址载荷；自动留点缺省关闭，关闭即解绑 `session/event`；子代理绝不自动留点；回退前先落盘（暂存建不出 = 零写入失败）。
- **捕获**：覆盖率必须 100%；不走 temp+fsync+rename；绝不碰 `.asar` 段（宿主当容器 ⇒ 闪退）；在飞闸门只接 `captureInFlightBytes`。
- **删除集只有一份规划、拒删按分子树**：`planCreatedRemovals`（预览 = 执行）判据是能证明「留点时不存在」，名单截断不算；忽略目录/读不出目录/未走查子树只让自己不删，范围说不清才全局 fail-closed。
- **回退只能「fork + 归档」**：就地截断对运行中的 DSH 无效；fork 必走 `sessionController.fork`（落盘 + 归位），绝不直接 `SessionStore.fork`；归位 cwd 多源 + 重试 + 失败写诊断。
- **客户端读回滚点要收尾后有界重试**：留点在收尾之后，即时查询可能是空（暂态）；窗口关且为空才能说「没有回滚点」，每次挂载只跑一轮。
- **救援点（guard）不占自动点预算、用户不可删**，但有自己的两道上限（每会话 20 → 全局 50，超出淘汰最旧），不得写成「无上限」。
- **目标侧真实路径围栏两侧必须同一坐标系**：home 尚不存在时也走「最近存在祖先 + 剩余段」投影，不得拿未解析字符串当基准，否则 macOS `/var→/private/var`、Windows 8.3/junction 会把合法恢复误判 `parent-escape`（`tests/core/restore.test.ts` R-09 复现）。

### 会话 / 导入导出 / 外部来源
- **文件类分区的收集与「存在但读不出」**：走 `src/utils/recursive-walk.ts`（整棵跳过 `node_modules`，跳过项必须告警）；「存在但读不出」必须显式失败（ENOENT 才算没有）；宿主整文件快照只跳过，绝不写 `existed:false`/`hostFileRemove`。
- **会话日志改写与导出**：字节改写只在宿主侧；改写 header 必须连目录归位（搬不动就回滚）、索引用 `reindexSessionHeader`；会话只改写首帧 cwd，导出会话必须连带工作区。
- **会话导出范围**：可见性由「包内实际带走的会话」驱动（每个 id 先试声明形态再试另一种命名）；白名单即权威、引擎绝不向下展开，但子代理必须连带父对话。
- **会话元数据与跳过项**：排序键先经 `sessionIdKey()` 归一化；journal `skipped` 只表示用户主动跳过（`warning`/`failed` 记 `attention`）；格式版本「单向兼容 + 静默跳过」，探针从 `installAnchor` 同树读，不拿 semver 猜。
- **`readSessionMeta` 有 mtime 失效缓存**：任一 storage 文件读不到 mtime 就不缓存；测试用 `clearSessionMetaCache()`。
- **v0 打包行不得当成 seq 空洞**：先展开跨度；形状不可判定 = 不透明（禁跨它下结论，计划 refuse）；未触及帧逐字节复用。
- **会话检测口径按「代际 + 载体」分级**：缺 message id / 空 tool-call id / id 不一致 / 重复 advertised tool call 均前台拒读；版本读不出降 `nextRequestFails`（`codec-uncalibrated`），不得写成「transformed 容忍」。
- **复核门与锚点链**：`unavailable` ≠ 成功验证（不标已验证、不写成功台账、不触发回滚，三态进可见输出）；catalog 按 `headerVersion` 重跑；真 codec 锚点链必须外部显式给出，拿不到就 `unavailable`。
- **外部来源合成会话**：行必须满足 `assertMessageEventShape`（绝不产出空 callId）；按目标机版本写（不写最高，读不到不转），标题行不停 seq 0。
- **面板侧布局归位/重复 id 隔离与离线 CLI 不同**：`apply!==true` 零写入；每次移动后 `reindexSessionHeader` 必须成功，失败搬回并报 `rolledBack`；差异必须写进文案。
- **两侧诚实**：UI 文案每句都要能被代码逐条证明；「未知」与「确知为空」必须分开；入口扫过后始终可见。

### Profile / 插件数据 / 打包
- **DSH 没有「默认 / 下次启动 profile」状态**：只由启动参数决定，不写 `<dataDir>/next-profile`。
- **`desktop` 是 Electron 独占保留档案**：启动/删除/改名一律以 `managedProfile` 拒绝；版本只取 `profileContext.installAnchor`。
- **复制档案**：拷完必须 `relinkCopiedTree`；整树走 async fs；`includeNodeModules=false` 同时跳过 `node_modules` 与 `.dsh-module-fallback`；失败回滚；中断残留 = 标记先行 + 只认自己的标记。
- **本插件是 bundle 包**：隔离实例挂载必须进 `dsh.profile.bundles`；读路径零写入，对账只在安装成功后。
- **档案启动子进程必须直启入口文件**（`shell:false`，Electron 用 `ELECTRON_RUN_AS_NODE=1`）：Windows「cmd 包装 + `detached`」会吞孙进程 stdio ⇒ 日志恒空、抓不到 token URL；上限 30 秒。
- **`cordis.patch.yml` 的 `!!js` 方言读写只有 `src/utils/patch-yaml.ts` 一处**：「存在但解析不了」拒绝覆盖（ENOENT 才是空层）；pnpm 同树布局推导也只有一处，多候选对不上不猜。
- **插件数据分区收录面**：只有内置来源表 + 已安装插件自述的 `dsh.dataDirs`（包内声明绝不构成写入授权）；`cache` 与 `excludeRel` 命中永不收录；区域被环境变量覆盖即报码跳过。
- **两个分区的根是系统主目录（`HostContext.osHomeDir`/`homeFs`），不是 `$DSH_HOME`**：I/O 一律 `fsForSection()`；缺 `homeFs` 显式报码，绝不退回 `ctx.fs`。
- **离线 CLI 不收集 `pluginData`/`pluginAssets`**（显式 `--sections` 提示改用 GUI）；归属键只有 npm 包名，`pluginFiles` 无包名即不猜，注册表有而清单无不可勾。
- **client bundle 是 cjs + `window.__ModuleLoader__.load`**：CSS Modules 只认 `.module.css`；`style` 只允许极小修补；宿主模块表里的包只能帧内惰取 + try/catch + 回落（`common/host-primitives.ts`）。
- **打包/安装四条**：`file:` spec 打包前 `stat` 判形态；同步快照 JSON 读写同口径（512 MiB）；`runStore.patch()` 后必须 `patchSyncPasswords()`；git 源安装需 `scripts.prepare` + pnpm 11 `allowBuilds`。
- **`pnpmWorkspace` 与 `plugins.patchFiles` 必须同进同出**；`bundles` 里无依赖的层只声明、不装 npm。

### 技术限制（勿突破）
- 凭据值无法回滚（DSH 不回读）；装/卸插件需重启；MCP 无管理 API（只能组合 patch 行导入）；localStorage 里的 UI 状态不随迁移。

## Documentation
- `docs/index.md` — 文档总索引；不知该读哪份时先看它。
- `docs/architecture.md` — 分层、目录约定、守卫与脚本；改架构或多个模块时查阅，硬规则回本文件补一行。
- `docs/maintenance/doc-maintenance.md` — 载体归属表；判断某类内容该写进哪份文档。
- `docs/lessons/README.md` — 证据库按域索引；查某条规则的实测依据、事故成因与量化数据。
- `docs/maintenance/known-limits.md` — 已知限制全表；判断某能力是否已支持时查阅。
- `docs/spec/` — 对外契约（同步通道、bundle 格式等）；改格式或跨版本行为前必读并同步。
- `docs/design/` — 设计决策记录；改契约、结构或跨模块边界前查阅。
- `DEVELOPERS.md` — 机制细则、发版阶段表、字典与适配器口径。
- `DESIGN.md` — UI/样式唯一权威；动 UI 前必读。
