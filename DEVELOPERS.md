# 🛠️ DSH Config Manager — 开发者 / 维护者文档

> 面向开发者与维护者。**用户请直接看 [README.md](README.md)（英文）或 [README.zh-CN.md](README.zh-CN.md)。**

---

## 📦 开发命令

```bash
npm install --legacy-peer-deps   # 安装依赖（部分 DSH 核心包未发布公共 registry，需跳过 peer 解析）
npm run typecheck                # 类型检查：根 tsconfig（只覆盖 src/**）
npm run typecheck:tests          # 类型检查：tsconfig.tests.json（src/** + tests/**，CI 已接）
npm run build                    # 构建：Host 半 lib/（tsc）+ client bundle lib/client.js（tsdown）
npm run bundle                   # 仅重建 client bundle（tsdown）
# 注意：client 半（src/client/**，含文案/样式）改动后必须重新 build（或 bundle）并重启 DSH 才生效
#     —— 宿主半在 DSH 启动时加载、没有热重载；只改源码不 build，界面仍是旧 UI。
#     产物：lib/client.js（CSS Modules 内联其中）+ lib/（host）。
npm test                         # 运行全部测试（node --test，192 个）
npm run smoke                    # 仅核心引擎冒烟测试
```

## 🏗️ 架构

```
src/
├── core/       核心引擎（与 DSH 运行时解耦，ConfigAdapter/HostContext 接口 + 内存 mock 可测）
│               exporter / analyzer(三段式) / importer(14步) / backup(快照) / rollback(逆序补偿)
│               cache-cleaner（缓存自动清理：tmp 暂存 / exports 导出副本 / market cache+work，保留期可配）
├── schema/     领域类型 / Manifest / 版本判定（集中，CURRENT_SCHEMA_VERSION=1）
├── security/   secret-scanner / redaction / zip-security / integrity / encryption(scrypt+AES-256-GCM)
├── adapters/   13 个真实配置适配器（settings/ui/providers/plugins/mcp/prompts/skills/
│               agentPresets/workspaces/credentials/pluginFiles/sessions/self）
├── migrations/ schema 迁移链（registry + v1→v2 占位）
├── ui/         框架无关 UI 逻辑层（九步导入向导 / 冲突 / 路径映射 / 进度 / 报告）
├── client/     React 界面（settings.section 挂载，/api/dsh-config-manager/* 调 Host）
├── profiles/   档案 = DSH 自带 profile（$DSH_HOME/profiles/<name>）：
│               shared（零依赖类型/常量/纯函数）→ dsh-profile-manager（node fs 引擎）→ src/ui/dsh-profiles-view.ts
└── index.ts    Host 半 Cordis 插件入口（name='config-manager'，7 端点路由）
```

**安全不变量**：Secret 默认不导出 / 导入前强制快照 / Dry Run 零写入 / 冲突不默认覆盖 / ZIP 视为不可信输入 / 日志全程脱敏。

## 🔐 插件 API 的真实认证边界（W2，2026-09 实测）

> 下移自 `AGENTS.md` §🏗️ 架构心智：这里是完整论证与证据；规则句仍留在 AGENTS.md。

- **插件 HTTP API 的真实认证边界 = kit 的围栏，不是 DSH 的 cookie**（W2；证据见 known-pitfalls）：DSH 的 browser-session cookie 拒绝只挂在 **`kind:'prefix'`、`path:'/api'` 的 RPC 承载路由**上（源码行号见 `docs/known-pitfalls.md`「t93 容量腾挪」§1），而 host-webserver 的派发顺序是 **exact 表先命中**。本插件 79 条路由（口径见 parity 快照）都命中 exact 或更长的私有 prefix，**永不进入** DSH 的 `/api` 认证路由——实测打点见 `docs/known-pitfalls.md`「t93 容量腾挪」§1。**影响面**：本机任意非浏览器进程（含本机其它本地用户）**无 token/cookie 即可调用全部 79 条路由**（含破坏性路由，清单见 known-pitfalls）；**远程/LAN 来源**被 kit 的 `remoteAddress ∈ {127.0.0.1, ::1, ::ffff:127.0.0.1}` 判定挡掉，**浏览器跨站 CSRF** 被同源/Host 围栏挡掉——**围栏确实在生效，不得把这条写成「插件 API 无认证」**。两个不得误解的推论：① **不得把 DSH 会话认证当作插件 API 的兜底**——认证挂在通用 prefix 路由 `/api` 上 + exact 优先的派发顺序是**平台级性质**，任何在 `/api` 下注册 exact 路由的 DSH 插件同理；插件 API 的边界只能是 kit 的 `endpoint()` 围栏。② 若将来要在**共享机器**或**经本机代理/隧道转发**（非回环来源、`trustedHosts`/LAN 绑定）的场景暴露插件 API，**必须**在 kit 里自行对接认证（方向：在 `endpoint()` 注册点统一加一道校验，勿逐路由散写），届时应重新评级本条的残余风险。**复核路径**见 `docs/known-pitfalls.md`「t93 容量腾挪」§1（含 DSH 源码位置与 `outputs/e2e-w2/run-e2e.ps1 -Strict`）。

## 🚀 自动发布（npm + GitHub Release）

**发版顺序**（顺序有意义：publish.yml 抽取的是**被打 tag 的那个提交**里的 CHANGELOG，所以 CHANGELOG 收口必须先提交再打 tag）：

```bash
# 1) 收口 CHANGELOG：[Unreleased] → ## [0.1.70] - <今天>，并在顶部开好下一轮骨架
node .github/scripts/changelog-section.mjs release 0.1.70
git add CHANGELOG.md && git commit -m "docs(changelog): 0.1.70"

# 2) 同步版本号三处并打 tag（全自动：typecheck → test → build → pack → npm publish → GitHub Release）
npm version patch          # 0.1.x → 0.1.x+1（改版本 + 打 tag）
git push origin main --tags
```

- **CHANGELOG 版本段有通用骨架**：`.github/changelog-template.md` 定义固定结构 —— `## [x.y.z] - ISO日期` +
  `> 中文主题` / `> **Theme**: 英文主题` + 可选 `### 中文 / English` 小节 + 可选 `> **致谢 / Thanks**`。
  `changelog-section.mjs release` 负责收口并开下一轮骨架（结构与骨架同源），`check` 在 **npm publish 之前**
  做格式门禁（标题带日期 / 有中英主题 / `###` 小节非空 / 不留 `{{...}}` 占位符 —— 骨架没填完发不出去）；
  行为门禁见 `tests/changelog-section.test.ts`。

CI 流水线：`typecheck → 192 测试 → build → npm pack → npm publish（OIDC）→ 创建 GitHub Release（tgz 附件 + CHANGELOG 双语亮点 + 自动变更记录）`

- **npm 发布走 Trusted Publishing（OIDC）**：无任何长期令牌；workflow 需 `id-token: write` + npm ≥ 11.5.1（workflow 会先升级 npm）
- **Release 描述由模板渲染**：CI 从 `CHANGELOG.md` 抽取当前版本段（中英双语亮点，漏写会 **fail fast**），
  再由 `node .github/scripts/render-release-notes.mjs <tag> <模板> <亮点> <自动记录>` 套用
  **`.github/release-notes-template.md`** 渲染成最终描述并 `gh release edit --notes-file` 写回。
  文案只改模板即可，不必动 workflow；占位符 `{{highlights}}` / `{{autoNotes}}`（必填）/ `{{version}}`（去 v）/ `{{tag}}`，
  未知占位符原样保留，HTML 注释视为模板注释不进描述。
- **模板在 npm publish 之前先 dry-run 一次**（与亮点段同一个门禁步骤）：模板写坏会在发 npm 包之前就红，
  避免出现「包已发到 npm、GitHub Release 描述没写」的半成品；dry-run 用桩自动记录，正式渲染在 release 步骤。
- **自动变更记录的分类**：`.github/release.yml` 把 dependabot（`dependencies` 标签）归入「🔧 依赖更新」、其余进
  「📦 其它变更」兜底类；若要彻底不显示依赖升级，把该标签移到 `changelog.exclude.labels`。
- **本地预览描述**：`node .github/scripts/render-release-notes.mjs v0.1.70 .github/release-notes-template.md <亮点文件> <自动记录文件>`
  （亮点可用 `python3 .github/scripts/extract-release-notes.py 0.1.70 CHANGELOG.md` 生成）；行为门禁见 `tests/release-notes-template.test.ts`
- 一次性配置（首次）：
  ```bash
  npm login
  npm trust github dsh-config-manager --file publish.yml --repo xiajiajun516/dsh-config-manager --allow-publish
  ```
- `dist/` 目录需先创建（`mkdir -p dist && npm pack --pack-destination ./dist`），否则 npm pack 报 ENOENT

## 🔒 CI 门禁（PR / 主干）

`.github/workflows/ci.yml` 与发布流水线**分离**，对 `pull_request`（目标 `main`）、`push`（`main`）与 `workflow_dispatch` 触发：

```
install → typecheck（src）→ typecheck:tests（tests/**）→ npm test（全量套件，不按目录裁剪）→ build（tsc + tsdown）→ bundle 自包含护栏 → npm pack（打包与 files 白名单校验）
```

- **零发布副作用**：不含向 registry 推送的步骤，不申请 OIDC 发布凭据，权限仅 `permissions: contents: read`
- **单 job 跑完整阶梯**：install → typecheck → typecheck:tests → test → build → pack，一步失败即整体红；**禁用「允许失败」、不加自动重试**（全量测试实测 1558 项约 88 秒，无需拆 job；耗时由 concurrency + timeout 控制）
- **`tests/**` 是独立一条类型检查**：根 tsconfig 只 include `src/**`，历史上 228 个测试文件长期在类型检查之外并积压 43 条错误（2026-09 修完并接进 CI）；`tsconfig.tests.json` 未进版本库时该 step 会 TS5083 报错，提交时必须带上它
- **安装契约与发布一致**：Node 24 + `npm ci --legacy-peer-deps`（部分 DSH 核心包只声明在 peerDependencies，普通 `npm ci` 必红）
- **并发**：`concurrency.group: ci-${{ github.ref }}` + `cancel-in-progress`，同一分支的新提交自动取消旧运行
- **PR 要求**：合并进 `main` 前需 ci.yml 全绿；**发布仍是打 tag → `publish.yml`**（见上一节），两条流水线互不触发
- **已知间歇性失败（非必然红灯）**：`src/utils/env-lock.test.ts` 与 `src/client/run-store.test.ts` 存在**负载相关的间歇性**失败（多数运行 0 fail 全绿，单独跑必过）。若 CI 首次红灯，可先 `gh run rerun <id> --failed` 确认是否为该间歇，**而非直接认定为缺陷**——但也不要因为「可能是间歇」而放松警觉。
- **平台矩阵（2026-09）**：`verify` job 用 `strategy.matrix`（`include`：`ubuntu-latest` / `windows-latest` / `macos-latest`，`fail-fast: false`）
  —— 全仓有 32 处非测试 `process.platform` 分支（env-lock / atomic-write / process-control / plugin-cli / recursive-walk / 档案启动器…），
  此前只有 ubuntu 被 CI 覆盖：Windows 侧只有作者本机能跑、macOS 侧（env-lock 的 darwin 分支等）零真实执行。
  - **macOS 是观察期**：矩阵里带 `experimental: true` + job 级 `continue-on-error: ${{ matrix.experimental == true }}`，
    因为作者只有 Windows、无法在合入前本地验证。**连续 1~2 次绿灯后删掉 `experimental` 那一行**即变硬门禁 —— 不做长期「允许失败」。
  - **pack 步骤显式 `shell: bash`**：`mkdir -p dist && npm pack` 里的 `-p` 是 POSIX 语义，Windows 默认 PowerShell 的 `mkdir` 不认识它；
    `windows-latest` 自带 Git Bash，三个平台用同一条命令才能保证「跑的是同一套步骤」。
  - **`publish.yml` 保持单平台**：发版只做一次，平台覆盖由 PR/主干门禁负责（避免发布流水线三倍耗时）。

## 🧪 测试矩阵

**192 个测试全部通过**（node:test，零额外依赖），覆盖规范 §33 + 验收场景 A–G：

| 类别 | 覆盖 |
|---|---|
| 导出 | 正常 / 空 / 大配置(1MB+) / Unicode / 特殊字符 / Secret 过滤 |
| 导入 | 正常 / Merge / Replace / Skip(不删目标独有) / Conflict / 缺失插件 / 缺失依赖 / 缺失密钥 / 未确认拒绝 |
| 回滚（场景 E） | 多适配器混合中途失败 → 整体恢复；rollbackOnError=false 对照；部分回滚诚实报告 |
| 迁移（场景 G） | migrateToCurrent 机制级边界（当前 v1 即最新，无真实 v2 可端到端验证） |
| 安全（场景 F） | 恶意 ZIP / 超大条目 / checksum 不匹配 / Zip Slip / 绝对路径 |
| 跨平台（场景 B） | win32↔darwin↔linux 批量前缀映射 |
| 冲突导航（回归） | 只前进的阶段导航（path-mapping 后不回跳 conflicts） |

## 📋 完整技术限制

1. Workspace 只能创建/改标题（DSH 无整体覆盖写通道；路径与会话列表由 DSH 维护）
2. MCP 无管理 API——以组合 patch 行导入，需重启生效
3. 插件安装需重启（installPlugin 返回 needsRestart）
4. 浏览器 localStorage UI 状态不迁移（Host 无通道）
5. keybindings / workflows 配置 / commands / rules——DSH 无此概念，不实现假分区
6. 凭据值无法回滚（DSH 不回读值，回滚需人工补录）
7. 新建项无法回滚删除（settings 无删除语义）
8. Schema 迁移 v1→v2 为占位（CURRENT=1）
9. 历史会话默认不迁移（v1 仅文件级复制）
10. 加密备份密码丢失无法解密（设计使然）
11. **DSH 无法在运行中切换 profile**（且**没有「默认 / 下次启动 profile」状态**）：profile 由启动参数 `--profile <name>` 决定（`dsh <名>` 是简写，`dsh web` 是硬编码别名；缺 `--profile` 直接报错退出），bundle 层在启动时解析，运行中的进程无法更换自身 profile。DSH 也没有 profile 管理 HTTP 路由（已核对 0.1.5-rc.1 / 0.1.5-rc.2 / 0.1.6-alpha.2 全无 profile-admin/ui-profile-admin/profileManagement），**更没有任何「上次用的是哪个 profile」的持久状态** —— 所以任何「下次启动用哪个」的标记**都没有消费者**（本插件曾据此写过 `<dataDir>/next-profile` + 「设为下次启动」按钮，真机定位「设 PROVA 为下次启动 → 重启仍进 web」后，**2026-09 标记与按钮一并移除**：它只会让用户以为切换成功了；`$DSH_HOME/cordis.patch.yml` 只是叠加在**当前** profile 上的 home 层补丁，换不了 profile）。**插件把「切换」做成进程级的启动/停止**（`src/profiles/dsh-profile-launcher.ts`）：`dsh --profile <名> --port <空闲端口>` 拉起 detached 独立实例，从子进程日志抓带 token 的认证 URL 并 HTTP 探活；实例台账落 `<dataDir>/launches.json`（pid/port/url/log），`listRunning` 按 pid 存活过滤并清死记录，`stop` 先优雅后强杀并如实回报三种终态；**只对 web 形态开放**（headless/generic spawn 出去是隐形进程），失败一律带码（`notLaunchable` / `launcherUnavailable` / `launchFailed` + 日志尾部 / `alreadyRunning`）。**launch / stop 刻意不走 mutation gate**：它们不写配置文件，而 gate 会把环境锁占到 handler 返回（launch 最长 20s 就绪）——真机实测那 20s 内导入/恢复全被 423 挡住，且启动完成后 1s 内点停止也会被挡。生态里 dsh-profile-manager（dshm）与 DSH Launcher 走的也是「外部启动器 spawn 实例」这条路。
**「哪些 profile 在跑」必须靠心跳而不是启动方台账**（真机 bug：从 web 启动 cmtest 后，在 cmtest 的界面里还能再启动 web —— web 是手动敲起来的，不在任何台账里）：每个加载本插件的实例在 apply 时往 `<dataDir>/running/<profile>.json` 自报 `{pid, port, startedAt, updatedAt}`（`src/profiles/dsh-profile-runtime.ts`；20s 刷新、60s 判死、pid 死或过期即清理；**绝不写认证 token**），`GET /profiles` 的 `running` 是「台账 ∪ 心跳」的合并视图（`owned` = 本插件启动的、`current` = 就是自己），因此：已在跑（含手动启动的）→ `alreadyRunning` 拒绝启动、启动当前档案 → `currentProfile`、实例在跑 → 拒绝物理删除、**别的实例也能从本界面用 `stopExternal` 停掉**（同一套优雅→强杀，`src/profiles/process-control.ts` 是唯一实现），而**当前实例自己不给停止**（停自己会死在响应途中）。
12. **当前档案（profile）的解析顺序**（2026-09 issue #52 修正）：`config.profile` → 宿主 `profileContext` 服务（DSH ≥ 0.1.7 在 boot 时 `hostCtx.provide('profileContext', { name, dir, … })`；**DSH Desktop 外壳不传 `--profile`**，只有它知道真正启动的是哪个档案）→ `--profile` 启动参数 → `DSH_PROFILE` / `DSH_PROFILE_DIR` 环境变量 → `web`。**DSH 自身从不写这两个环境变量**（对 0.1.5-rc.1 / 0.1.7-rc.2 / 0.2.0-rc.1 全量扫描确认），它们只是启动外壳可能注入的兜底。实现：`src/index.ts` 的 `resolveProfileName`（读 `ctx.get('profileContext')`）与 `src/core/plugin-cli.ts` 的 `profileNameFromProfileContext` / `resolveProfileNameFromEnv` / `resolveProcessProfileName`；守卫见 `src/core/plugin-cli.test.ts`。

## 📌 常见坑

- **收集面需要收窄的文件类分区（单文件 / 白名单）必须覆写 `listRelPaths()`**（2026-09 首例、2026-10 复发）：
  `FileCollectionAdapter.preview()`（v0.1.68 引入）走 `collect() → listRelPaths(baseDir)`，而**覆写 `export()` 不参与预览**
  —— 只覆写 `export()` 的分区，预览会落到基类的目录递归。两起实测：
  - `agentInstructions`（2026-09）：`baseDir` 是 `''`（AGENTS.md 就在 `$DSH_HOME` 根），**预览**递归了整个 home：
    4.8 s / 4016 个文件 / 242 MB，选择器还冒出 21 个假单元（`profiles/`、`sessions/`、`attachments/`…）；
    总览页调 `/export-preview`，**5.0 s 里 4.8 s 都来自这一项**，而真实导出只读一个文件。
  - `self`（2026-10 复发）：只覆写 `export()`（7 条白名单），预览递归了整个 `$DSH_HOME/dsh-config-manager`
    （快照 / config-snapshots / `sync/work` 的 Git 工作副本与远端快照 / transactions / exports / 遗留 profiles）：
    **2460 个文件 / 11.44 MB**，界面显示「插件自身配置 已选 2460/2460 11.5 MB」，而真实导出只有 6 个文件 / 1936 B。
  **后果不止数字错**：单元 id 要与 `includeItems` 求交 —— 假单元一旦被用户取舍（全不选后只勾几项），
  白名单里的真实配置文件会被静默挡在导出之外。
  修法：覆写 `listRelPaths()` 返回白名单（存在性判定走 `ctx.fs.statSize`，旧门面退回读一次文件；路径用 **POSIX 分隔符**，
  它同时是 `relativePath` 与单元 id，不能随平台漂移），并**删掉原来的 `export()` 覆写** —— 预览与导出因此共用同一份清单与同一个 `collect()` 内核。
  回归护栏：`src/adapters/agent-instructions.test.ts`、`src/adapters/self.test.ts`（后者用快照/同步工作副本造出真机同款场景，
  断言预览只列白名单且与导出逐项一致；修复前该断言必然失败）。
  新增文件类分区时自检：`baseDir` 是否为 `''`/过宽？收集面是不是靠覆写 `export()` 收窄的（是 → 必须改成覆写 `listRelPaths()`）？
- **`sessions` 预览的成本与两项优化**（2026-09，均已落地）：真实遍历 324 ms（983 文件 / 517 MB）+ 逐文件 stat ≈ 64 ms
  + DSH `parentRelations()` ≈ 0.7 s（走 `sessionPersistence.list()`，每次预览都要）。两项改法：
  ① **`parentRelations()` 短 TTL 缓存**（`src/utils/ttl-cache.ts` 的通用缓存，5 s + 同 key 并发合并 + 失败不缓存；
  `PARENT_RELATIONS_CACHE_TTL_MS` 在 `src/index.ts` 的会话门面里），连续预览只付一次；
  ② **体积与时间合并成一次 stat**：`FileSystemFacade.statInfo` → `SectionPreview.statTimes` →
  `unitActivityTimes(ctx, section, statTimes)`，真机实测**1361 次 stat → 983 次**，结果逐项相同。
  两处都保留旧路径（未实现 `statInfo` / 未传 `statTimes` 时退回逐文件 `mtimeMs`），**旧宿主只慢不坏**。
  它只在 `sessions` 显式放行时发生（该分区 `defaultIncluded = false`），所以不影响总览页默认加载。
- **pnpm 裸名 add 不升级**：`dsh plugin add dsh-config-manager`（无版本）会保留已记录版本；用 `@latest` 或精确版本
- **`@latest` 装到旧版 = pnpm 11 发布年龄策略（不是缓存）**：`minimumReleaseAge` 默认把发布不足 30 天的新版本排除出版本解析，只有 `minimumReleaseAgeExclude` 白名单里的版本可用。`pnpm cache delete` 无效。解决：
  1. **精确版本装一次即自动白名单**（推荐）：
     ```bash
     dsh plugin --profile web add dsh-config-manager@0.1.5
     # pnpm 自动把 0.1.5 追加进 pnpm-workspace.yaml 的 minimumReleaseAgeExclude，之后 @latest 即可解析到它
     ```
  2. 或彻底关闭年龄门槛：在 profile 的 `pnpm-workspace.yaml` 加 `minimumReleaseAge: 0`
- **MemFs 测试路径**：内存 fs 的 key 必须与宿主 path 解耦（POSIX 上 path.resolve 对 win32 home 会注入 cwd）
- **插件控制台日志默认静音**：宿主入口（`src/index.ts` 的 `ConfigManagerHostContext`）用 `parseLogLevel(process.env.DSH_CONFIG_MANAGER_LOG_LEVEL)` 解析级别，**缺省 warn**——启动 `dsh web` 后只留 warn/error，常规 info（挂载横幅、调度器跳过、导出/备份完成、保留策略清理）不再刷屏；排查时设 `DSH_CONFIG_MANAGER_LOG_LEVEL=info`（或 `debug`）。级别只在入口解析一次，勿在调用点加 `if (debug)` 分支。

## ⬆️ 插件版本更新检查（m-update-check，2026-09）

入口：`GET /api/dsh-config-manager/update-check`（声明在 `src/routes/prefs.ts`，与 star / 更新内容提示同组）
实现：`src/core/update-check.ts`（`UpdateChecker` / `probeLatestVersion` / `parseLatestVersion` / `wantsForcedUpdateCheck`）

- **只读**：请求 `https://registry.npmjs.org/dsh-config-manager/latest`（约 3 KB），**绝不安装/升级**；界面给的是可复制的命令。
- **缓存**：进程内 10 分钟（`UPDATE_CHECK_CACHE_MS`）；`?force=1` 由「关于」页的「重新检查」触发 —— 不把 registry 当轮询端点。
- **失败分类**（全部结构化 `{ ok:false, current, error }`，HTTP 仍 200）：`registry returned HTTP <n>` /
  `registry response is not valid JSON` / `registry response has no usable version` / `registry response too large`（> 64 KiB）/
  `timed out after <n> ms` / `network error: <msg>`。**绝不「失败当最新」**；失败不写缓存，下次仍会重试。
- **HTTP 为什么仍 200**：离线 / 公司网络 / registry 抖动不是插件故障；界面据 `ok` 显示可重试提示而不是错误横幅。
- **版本比较**：复用 `src/core/validator.ts` 的 `compareVersionStrings`（同一份 semver 解析，`1.10.0 > 1.9.0`、预发布 < 正式版）；
  只有**严格更新**才提示（本地跑更新的预发布版时不提示降级）。
- **升级命令用精确版本**（`dsh plugin --profile <档案> add dsh-config-manager@<latest>`）：pnpm 的 `minimumReleaseAge`
  会让 `@latest` 解析到旧版（README「安装」段有实测记录），而我们刚拿到确切的 latest —— 精确版本既不会装旧版，也与界面显示一致。
- **`desktop` 档案与未知档案不给终端命令**（前者被 DSH 无条件拒绝，见 AGENTS「DSH Desktop」条），界面改提示去插件页更新。
- **不读代理设置**（Node 的 fetch 默认不认 `HTTP_PROXY`/`HTTPS_PROXY`）：公司网络下可能直接失败 —— 如实报错，不影响其它功能。
- 测试：`src/core/update-check.test.ts`（注入 `fetchImpl` + 注入时钟，**绝不真连 registry**）+ `src/client/about/about-view.test.ts`
  （`aboutUpdateView` / `aboutUpgradeCommand` 的 upToDate / available / desktop / failed 四档）。

### 自更新（「立即更新」按钮，2026-10）

入口：`POST /api/dsh-config-manager/update-apply`（同一组文件 `src/routes/prefs.ts`，**写操作**）。
实现：`src/core/self-update.ts`（`planSelfUpdate` 纯校验 + `runSelfUpdate` 注入式执行器）、`src/ui/types.ts` 的 `PluginUpdateApplyResult`、
宿主接线 `src/index.ts` 的 `makeRouteEnv().selfUpdate`。

- **只在用户显式点按钮后执行**：检查更新本身仍只读；没有定时器 / 自动升级路径（硬边界 —— 不要把写动作并进 `update-check`）。
- **钉住精确版本**：`dsh plugin --profile <档案> add dsh-config-manager@<latest>`（复用 `runDshPlugin` + `installErrorFor`），
  与界面给出的命令逐字同源；避免 pnpm `minimumReleaseAge` 把 `@latest` 解析回旧版。
- **拒绝矩阵**（全部结构化 `{ ok:false, code, error }`，HTTP 200；码 → 客户端文案键由 `src/client/about/plugin-update-view.ts` **穷尽映射**）：
  `invalid-version`（非 semver）/ `not-newer`（不高于当前）/ `profile-unknown` / `unsupported-profile`（desktop）/
  `non-registry-install`（当前依赖 spec 是 `link:` / `file:` / `git:` 等 —— 隔离测试 home 与开发安装都会命中）/ `install-failed`。
- **过 mutation gate、不 journal**（`withMutationGate('plugin-update', …, { journaled: false })`）：要 SAFE MODE 与环境锁，
  但插件安装失败是普通用户错误，不该记成 NEEDS_ATTENTION 事故。
- **成功 ≠ 生效**：回 `needsRestart: true`；弹窗保持打开并提示重启，**绝不自动重启**用户的 DSH。
- 界面：`GET /update-check` 得到 `available` 且 `command !== null` 时自动弹 `PluginUpdateDialog`（拉 GitHub Releases 该版本正文，
  由共享原语 `src/client/about/ReleaseBody.tsx` 安全渲染），底部「立即更新」；卡片同时给「立即更新」按钮，成功后改显「已更新到 vX，重启后生效」。
- 测试：`src/core/self-update.test.ts`（纯计划 + 注入 runner，不真起子进程）+ `src/client/about/plugin-update-view.test.ts`
  + `release-notes-view.test.ts` 的版本匹配用例（`findReleaseForVersion` / `normalizeReleaseVersion`）。

## 🧭 兼容性评分与结构化原因（2026-09）

- **单一事实源**：`src/core/validator.ts` 的 `compatibilityReasons(input)` 产出原因数组，`computeCompatibility(input)` **由它派生**评分：
  `schemaUnsupported` → unsupported；含 `sourceOlder` → good；其余非空 → partial；空 → excellent。
  原因与评分出自同一份输入，界面解释与评分**不可能漂移**。
- **评分口径冻结**：旧实现里「来源更旧」会覆盖先前判定的 partial，因此「来源更旧 + 跨平台」仍是 good。这是历史行为，
  **本次刻意不改**（改它会让既有导入报告变脸），已由 `src/core/compatibility-reasons.test.ts` 的「历史行为（冻结）」用例显式写下。
- **回传字段**（`ImportAnalysis`，全部可选 → 旧宿主 / 旧测试零改动）：`compatibilityReasons`（结构化原因）、
  `source`（来源 DSH 版本 / 平台 / schema 版本）、`target`（本机 DSH 版本 / 平台）。缺省时界面**不显示对照行、也不编原因**
  （「不知道为什么」与「没有问题」必须可区分）。
- **界面只做映射**：`src/ui/import-wizard.ts` 的 `compatibilityNotes(reasons)` → `{ key, params }[]`（五类原因 → 五条字典键），
  导入向导渲染「来源与兼容性」卡；原因里的平台 / 版本字符串来自**包内**，渲染前一律过 `redact()`（B1 教训）。
- **禁止渲染裸枚举**：同步确认页此前直接显示 `{compatibility}`（中文界面里出现 `partial`）且 Badge 恒 `info`；现在两处都走
  `src/ui/import-wizard.ts` 的 `compatibilityLevel` / `compatibilityBadgeKind`，评分标签映射只有 `src/client/common/compat-label.ts` 一份
  （`src/client/common/compat-label.test.ts` 用源码级断言禁止第二份与裸枚举回归）。
- 测试：`src/core/compatibility-reasons.test.ts`（8 例，含「评分 = 原因的函数」跨用例校验）、`src/ui/import-wizard.test.ts`（`compatibilityNotes` 3 例）。

## 📥 从 AGENTS.md 下移的细则（2026-09）

> 背景：`AGENTS.md` **每轮对话都会进入模型上下文**，而这里是「实现细节级」的权威依据。
> 下移不改变任何约定，只是把按需查阅的内容从常驻文档挪到这里；`AGENTS.md` 中保留了硬性规则与指针。

#### 页面落位（src/client/）
- 七 tab 容器：`index.ts` + `ConfigManagerSection.tsx`（Overview/Export/Import/Snapshots/Sync/Market/Profiles/More；tablist 支持方向键导航）；总览为默认首 tab（`panel:'overview'`，旧 panel 缺省值经 parsePersistedState 迁移）
- 总览 `overview/OverviewPanel.tsx`（纯函数模型 `src/ui/overview-view.ts`：指标/健康判定/建议/最近活动/相对时间）
- 导出 `export/ExportView.tsx`；导入九步 `import/ImportWizardView.tsx`（外层包装 Stepper 步骤条 + `ImportWizardBody` 本体；纯函数 `src/ui/import-stepper.ts`；+`ConflictList/PathMappingForm/import-file-select`）；快照 `snapshots/SnapshotsPanel.tsx`
- 历史 `history/HistoryPanel.tsx`；同步 `sync/SyncSettingsView.tsx`(+`SyncConfirmView/SyncHistoryView/sync-view`)；市场 `market/MarketPanel.tsx`(+`MyConfigsView/my-configs-view/my-configs-api`)；咨询 `consult/ConsultCard.tsx`
- 共享原语 **`common/ui.tsx`**（Button/Badge/Banner/Card/Spinner/Field/SectionTitle/Empty/Checkbox/Stepper）+`common/ErrorBanner.tsx`/`ProgressBar.tsx`/`ReportView.tsx`/`ConfirmDialog.tsx`（含 focus trap）/`Skeleton.tsx`（加载骨架 `Skeleton`/`SkeletonList`/`SkeletonTable`；与 Spinner 的分工见 `DESIGN.md §6`）/`Motion.tsx`（`Collapse` 折叠容器 + `ViewSwitch` 视图切换入场）
- 状态中枢 `run-store.ts`（模块级单例+sessionStorage 白名单）；数据访问 `api.ts`/`sync/sync-api.ts`/`market/market-api.ts`；文案字典 `locales.ts`/`sync-locales.ts`/`market-locales.ts`（zh 源/en 镜像）
- 样式全在 `src/client/config-manager.module.css`

- **Hook**：本仓库无自定义 hooks 目录，组件内联 state + `useSyncExternalStore` 消费 runStore，复用逻辑下沉 `src/ui/`。不要新造 hooks 层。
- **Type**：领域类型 `src/core/types.ts`/`src/schema/types.ts`/`src/sync/*`/`src/market/types.ts`；UI 类型 `src/ui/types.ts`；client 专属 `src/client/client-types.ts`。
- **Utility**：`src/utils/` 或模块私有；带业务语义的纯函数优先 `src/ui/`。

### 🚀 发布（打 tag 全自动）
CI `.github/workflows/publish.yml`：tag `v*` push → typecheck（src + tests）→ test → build → 护栏 → pack → **CHANGELOG 亮点段门禁** → npm publish(OIDC) → GitHub Release。
步骤：①bump 三处版本；②`CHANGELOG.md` 顶部加当前版本双语亮点段（漏写 CI fail-fast，release 由 `.github/scripts/extract-release-notes.py` 抽取）；③push main；④`git tag -a vX.Y.Z && push`。
**门禁顺序**（2026-09 修正）：亮点段抽取 + 非空校验是**独立 step，排在 `npm publish` 之前**且不带 `if:` —— 两条触发路径都会执行。此前它嵌在「Create GitHub Release（tag-only）」步骤里，于是 CHANGELOG 漏写时流水线会红但包**已经发到 npm**（同版本号不可重发），而 `workflow_dispatch` 路径更是整段跳过该门禁、照常发布。
注意：手动 `workflow_dispatch` 不建 Release（该步骤仍为 tag-only），但**发布与亮点段门禁照常执行**（无 tag 时版本号取 `package.json.version`）；npm 用 OIDC 无长令牌；版本 `0.1.x`；commit 惯例 `chore: bump to X.Y.Z`；不配 `.github/release.yml`（无 PR+label，GitHub 默认 conventional 分组更好）。
CI 门禁：`.github/workflows/ci.yml` 对 `pull_request`→main 与 `push`→main 跑 typecheck（src）/ typecheck:tests / test / build / 护栏 / pack（最小权限、零发布副作用）；**发版仍只走 tag → `publish.yml`**，两条流水线互不重叠。

#### 状态管理
- 高频可恢复流程(Export/Import)状态在 `run-store.ts`；新视图需「切 tab 不丢/刷新恢复」就入 runStore。
- 低频面板(Snapshots/Sync/Market)组件自持(state+ref) + 非敏感切片镜像 runStore（`toSyncStoreSlice/toMarketStoreSlice/toSnapshotsStoreSlice`）；状态变更统一走 `commit(next)`（更新 stateRef→setState→**总是** `runStore.patch`），不依赖 effect flush；凭据仅内存、瞬态为内存切片，均被 `toPersistedState` 白名单剔除。
- **档案面板（ProfilesPanel）是「状态即切片」的形态，改它前必读**：`PanelState = ProfilesStoreSlice`（`src/client/run-store.ts`），组件用 `useSyncExternalStore(runStore.subscribe, selectProfilesSlice)` 直接订阅读取，**不另存 useState 副本**；写只经 `patch()`（基线取 store 当前值，非同闭包旧快照）。
  两个真机 bug 决定了这两条：① 进行中态（`launching/stopping/creating/renaming/deleting`）若留在组件 state，切页签（卸载）就归零 → 回来按钮变回「启动」，用户以为没点上而重复点；② 只写 store 不订阅，过去那次挂载遗留的请求回来时界面不会刷新 → 「启动中」一直转（启动最长 20s，必然踩到）。
  新增面板字段必须同时进 `toProfilesStoreSlice`（`run-store.test.ts` 的键集合断言 + 镜像不漏字段用例会红）：可持久化（列表视图 / 新建草稿）进 `toPersistedState` 显式放行；进行中态、弹窗目标、`launchResult`（带 token 的认证 URL）一律 `null/false` 剔除 —— 发起请求的页面已随刷新销毁，重放一个等不到回执的 spinner 只会骗人。
  弹窗目标存**档案名**（`renameTargetName/deleteTargetName/stopTargetName`），渲染期从列表/运行态即时解析 → 列表一刷新目标就自动消失，不需要额外清理逻辑。
- 面板开关存 runStore `panel` 字段。
- 控制器(`ExportFlow/ImportWizard`)由 runStore 缓存复用，**禁止每次渲染 new**；刷新恢复经 `writeWizardSnapshot()` 受控 rehydrate。

#### i18n
- 文案进字典：React 壳 `t('key')`(zh 源/en 镜像，`ConfigManagerKey` 编译校验)；`src/ui/` 走 `src/ui/i18n.ts` `UiT`；宿主 / 引擎走 `src/core/engine-locale.ts` 的 `engineMsg`（各域目录经 `registerMessageCatalog` 并入）。
- **禁止硬编码用户可见字符串**。
- **语言在「取文案那一刻」解析，不在装配那一刻**（2026-10-08 根因修复）：客户端 `makeLiveUiT(read)`（`src/ui/i18n.ts`；模块级 `liveUiT` 由 `setUiLanguageSource(read)` 接线在 `src/client/index.ts`），宿主 / 引擎 `engineMsg` + `setEngineLanguageSource(() => resolveAppLanguage(ctx))`（`src/index.ts` 构造期），路由注册点 `src/routes/kit.ts` 的 `endpoint()` 每请求 `invalidateEngineLocale()`；`LANGUAGE_TTL_MS = 1000` 只给非请求路径（调度器 / 后台任务）兜底。**不得**在 `apply()` 里写 `makeUiT(...)` / `makeMsg(...)` 快照（那是「切到 English 后界面仍有中文」的根因）。
- **静态守卫（回归门禁）**：全量 `node --test tests/i18n-hardcoded-guard.test.ts`（退出码 0 = 全仓零命中；摘要行 `DCM_I18N_GUARD scope=ALL files=<扫描文件数> hits=0 allowlisted=128`（**不变量是 `hits=0` / `allowlisted=128`**；`files=` 随新增源文件增长））；作用域自检 `$env:DCM_I18N_GUARD_SCOPE='src/client,src/ui'; node --test tests/i18n-hardcoded-guard.test.ts`。
  `DCM_I18N_GUARD_SCOPE` = 逗号分隔的 **workspace 相对 POSIX 前缀**，按**目录段边界**匹配（`src/client` 不命中 `src/client2`），**只收窄文件列表**（E1–E3 豁免、白名单过期断言、内核自检始终全局生效）；未设置 / 全空白 = 全量；非法值（绝对路径 / 反斜杠 / `..` 段）**直接失败**，绝不静默当空集。内核 `tests/helpers/i18n-scan.ts`、用例 `tests/i18n-hardcoded-guard.test.ts`（扫描集 = `src/**` − `src/cli/**` − `*.test.ts` − `fixtures/**`，+ `locale/en.json` / `locale/zh.json`；注释 / `log.*`·`console.*` 实参 / 目录 zh 区豁免）。
- **新增用户可见文案必须进目录**（zh 逐字保留、en 补齐）；新增白名单豁免只能走 captain → `tests/helpers/i18n-scan.ts`（条目计数精确锚定：**4 条 / 128 命中**）。

##### 字典共 7 套；「查不到 key」不等于是缺陷（排查前必读）
写文案时要放进**正确的那一套**；反过来，**判断「某 key 是否存在」时必须先确认 `t` 的来源**，否则会系统性误报：

| 字典 | zh/en | `t` 的来源 | 缺 key 行为 |
|---|---|---|---|
| `src/client/locales.ts` | 873 / 873 | 组件 props `t`（`ConfigManagerKey`） | **编译期报错** |
| `src/ui/i18n.ts` | 528 / 528 | `UiT`（`api.t` / `liveUiT` / props） | **静默返回 key 本身** |
| `src/core/messages.ts` | 380 / 380 | host/adapter `msg()`（`engineMsg`） | 编译期（`keyof typeof zh`） |
| `history-locales.ts` | 54 / 54 | `historyT` → ns `config-manager-history` | 静默 |
| `market-locales.ts` | 184 / 184 | `marketT` → ns `config-manager-market` | 静默 |
| `recovery-locales.ts` | 385 / 385 | `recoveryT` → ns `config-manager-recovery` | 静默 |
| `sync-locales.ts` | 336 / 336 | `syncT` → ns `config-manager-sync` | 静默 |

> 上表数量为 **2026-10-08 重数**（「英文界面零中文」迁移收口时实测，node 直读字典对象逐个计数）：7 套字典的 zh / en **键集合完全相等**、无重复键、**en 零 CJK**。
> **本轮（2026-10-08）的净增**：`locales.ts` 695→873、`ui/i18n.ts` 370→528、`core/messages.ts` **372→380**（8 个 `host.*` 来自 t2 的宿主入口迁移，其余来自各域迁入；**口径注意**：本行上方「2026-10-02 重数」记的 `353` 是**更早的旧实测**，本轮**迁移前基线是 372**，两个数字不得混用）、
> `market-locales.ts` 182→184、`recovery-locales.ts` 170→385、`sync-locales.ts` 219→336；`history-locales.ts` 54→54（无新增）。
> **迁移只新增键**：既有键的 zh 取值逐字不变（372 键指纹冻结在 `src/core/engine-locale.test.ts`），en 一律补齐 ——
> 因此**必须按重数更新，不得按旧值 +1 硬算**。
> 数量历史（不同时点，勿混用）：`locales.ts` HEAD 517（本机脚本按 `'key':` 字面量统计；t1 审计报告写 533 属其统计口径）
> → t3 复核 558（批次一新增文案后）→ t12 收口前 522 → 2026-09-20 最终态 506（t12 删除 16 个 `overview.*` 死键）
> → **2026-10-02 重数 695**（此后工作树累计新增，含 ⓘ 的 +1）→ **2026-10-08 重数 873**（英文界面零中文迁移收口）。
> 改动文案后如要引用数量，请重新实测，不要沿用旧数字。

**重数命令（仓库根；逐套打印 zh / en 键数与键集合相等判定）**：

```bash
node --input-type=module -e "for (const r of [['./src/client/locales.ts','zh','en'],['./src/ui/i18n.ts','uiZh','uiEn'],['./src/core/messages.ts','zh','en'],['./src/client/history/history-locales.ts','zh','en'],['./src/client/market/market-locales.ts','zh','en'],['./src/client/recovery/recovery-locales.ts','zh','en'],['./src/client/sync/sync-locales.ts','zh','en']]) { const m = await import(new URL(r[0], new URL('file://' + process.cwd() + '/')).href); const z = Object.keys(m[r[1]]); const e = Object.keys(m[r[2]]); console.log(r[0], 'zh=' + z.length, 'en=' + e.length, 'same=' + (z.length === e.length && z.every((k) => k in m[r[2]]))) }"
```

实测输出（2026-10-08）：`locales.ts` 873/873 · `ui/i18n.ts` 528/528 · `core/messages.ts` 380/380 ·
`history-locales.ts` 54/54 · `market-locales.ts` 184/184 · `recovery-locales.ts` 385/385 · `sync-locales.ts` 336/336
（七套全部 `same=true`、`enCJK=0`）。

##### 引擎侧域目录（`registerMessageCatalog` 并入，2026-10-08 现测）
`src/core/messages.ts` 的 zh/en 是**基础目录**（迁移前 372 键，t2 起 380）；各域另有一本**自注册目录**
（`registerMessageCatalog({ id, zh, en })`，模块加载即注册，**只在基础目录未命中时生效**，键类型 = `keyof typeof zh`）：

| 目录 | zh/en | 目录 | zh/en |
|---|---|---|---|
| `src/core/messages-core.ts` | 268 / 268 | `src/sync/s3/messages.ts` | 25 / 25 |
| `src/market/messages-market.ts` | 127 / 127 | `src/sync/gist/messages.ts` | 16 / 16 |
| `src/utils/messages-utils.ts` | 85 / 85 | `src/adapters/messages.ts` | 12 / 12 |
| `src/sync/messages.ts` | 57 / 57 | `src/foreign/messages.ts` | 9 / 9 |
| `src/schema/messages.ts` | 41 / 41 | `src/migrations/messages-migrations.ts` | 5 / 5 |
| `src/routes/messages.ts` | 36 / 36 | `src/profiles/messages.ts` | 1 / 1 |
| `src/security/messages.ts` | 24 / 24 | | |

> **20 本目录合计 3446 个 zh 键**（含上面 7 套；每本 zh/en 键集合相等、en 零 CJK）。
> **口径**：目录数按 **20 本**（7 套客户端字典 + 13 本引擎侧域目录，**含既有的 s3 / gist 命名空间目录**）计；t8 独立验证报告的「19 本 / 3430 键」是**不含 gist** 的口径 —— 两个都对，引用时必须写清口径。
> 引擎侧查找顺序：**基础目录 → en 回退基础 zh → 注册目录（同语言 → zh）→ 键名**；`engineMsg` 与 `makeMsg` 同口径，
> 未知键回退键名、绝不抛错。各域目录只许**追加**键（基础目录的 372 键有冻结指纹，改既有键即红）。

**全量重数命令（20 本目录；含 `same` 与 `enCJK` 判定）**：

```bash
node --input-type=module -e "for (const r of [['./src/client/locales.ts','zh','en'],['./src/ui/i18n.ts','uiZh','uiEn'],['./src/core/messages.ts','zh','en'],['./src/client/history/history-locales.ts','zh','en'],['./src/client/market/market-locales.ts','zh','en'],['./src/client/recovery/recovery-locales.ts','zh','en'],['./src/client/sync/sync-locales.ts','zh','en'],['./src/core/messages-core.ts','zh','en'],['./src/market/messages-market.ts','zh','en'],['./src/utils/messages-utils.ts','zh','en'],['./src/sync/messages.ts','zh','en'],['./src/schema/messages.ts','zh','en'],['./src/routes/messages.ts','zh','en'],['./src/security/messages.ts','zh','en'],['./src/adapters/messages.ts','zh','en'],['./src/foreign/messages.ts','zh','en'],['./src/migrations/messages-migrations.ts','zh','en'],['./src/profiles/messages.ts','zh','en'],['./src/sync/s3/messages.ts','s3Zh','s3En'],['./src/sync/gist/messages.ts','gistZh','gistEn']]) { const m = await import(new URL(r[0], new URL('file://' + process.cwd() + '/')).href); const z = Object.keys(m[r[1]]); const e = Object.keys(m[r[2]]); const same = z.length === e.length && z.every((k) => k in m[r[2]]); const cjk = e.filter((k) => /[\u2E80-\u2EFF\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF01-\uFF60\uFFE0-\uFFE6]/u.test(m[r[2]][k])).length; console.log(r[0].padEnd(44), 'zh=' + z.length, 'en=' + e.length, 'same=' + same, 'enCJK=' + cjk) }"
```

**第四个坑：`t` 可经 props 注入 → 静态归属不可判。**
`ConsultCard` 声明 `t: UiT`（不是本地字典），由调用方传 `t={api.t}`。因此「按文件在哪个目录就查哪套字典」**永远判不对**；实测这种静态归属扫描会产生 **600+ 处假阳性**（`error.*`/`history.*`/`myconfigs.*`/`report.*` 等全是注入式 `t`）。

**正确排查姿势**：①先判 `t` 来自 import（编译校验）还是 `api.t` / props 注入（宽松）；②宽松字典里「查不到」**必须**先把 7 套字典取并集再下结论；③真正可靠的护栏是 `ConfigManagerKey` 的编译校验 + `UiT` 的运行时回退，而不是旁路扫字典。

#### Missing Design Rule（DESIGN.md 未覆盖）
①搜库确认无类似 ②能扩展先扩展(加 variant/props) ③尝试 token+color-mix+现有比例组合 ④确实不存在才按既有语言设计新规范(复用既有 Color/Typography/Spacing/Radius/Pattern) ⑤**写入 DESIGN.md** ⑥再使用。
> Never introduce a new visual pattern without documenting it in DESIGN.md.

#### 第三方 UI 库准入（按需追加）
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

**追加（2026-09 图标形变试点，同样按 7 步评估通过）**：
- `morphicons`（图标形变运行时）+ vanilla `lucide`（形变图标的 **IconNode 数据**）——MIT / ISC，
  **零运行时依赖**，同样进 **devDependencies** + `deps.alwaysBundle`
  （`/^morphicons(\/.*)?$/`、`/^lucide(\/.*)?$/`；后者按 `/` 分隔，**不误伤** `lucide-react`）。
  实测边际成本 **+40.5KB raw / +13.6KB gzip**（**未压缩产物口径**；minified 约 8KB gzip —— 本仓库 bundle 不 minify，
  故按前者记账；量法：隔离探针只打新增模块，与 `npm run build` 前后对比 `lib/client.js` 互相印证）。
  **为什么还要 vanilla `lucide`**：`MorphIcon` 消费 IconNode **数据**，而 `lucide-react` 只导出**组件**；
  两包并存是 morphicons 的既定设计，但**版本必须与 `lucide-react` 相同**，否则静态/形变两套图形。
  封装层：`common/Icon.tsx` 的 `ExpandChevron` + `common/morph-icons.ts`（数据表）。
  护栏：`src/client/common/morph-icons.test.ts`（形变必须是纯 90° 旋转、无缩放 + 端点恰好落在两个图标上 + 两包版本相等）。
  使用边界与两条硬约定（`reducedMotion="user"` / `spring="smooth"`）见 `DESIGN.md §6`。

## 🧭 路由围栏 / adapter / 同步心智（下移自 AGENTS.md §🏗️ 架构心智）

> 规则句仍在 `AGENTS.md` §🏗️；这里是原文（含审核 finding id 与实现要点）。

- **宿主路由只经 `src/routes/kit.ts` 的 `endpoint()` 声明**（W1，host-entry#F-02/F-03/F-05）：围栏（loopback + 同源）与方法白名单由 kit 在**注册点**统一包装（`registerRoutes()` 兜底断言「未经 kit 的路由直接抛错」），**禁止**再写逐路由的 `guard`/裸 `isLoopbackRequest` 样板；新增一条 API 只改一处（组文件里那一条 `endpoint({ path, methods }, handler)`）。路由源 = `src/index.ts`（被源码级窗口守卫钉住的 7 条）+ `src/routes/*.ts`（其余 72 条；合计 **79** 条，见 parity 快照）——**源码级守卫必须扫全部路由源**（见 `tests/route/route-fence.test.ts`、`route-parity.test.ts`、`route-channel-guard.test.ts`），只扫 index.ts 会静默失去覆盖。

- **宿主路由只能经 `src/routes/kit.ts` 的 `registerRoutes()` 注册**（W1，约定级防线）：全仓唯一调用点是 `src/index.ts`（也是唯一 webServer 消费点），它逐条断言路由出自 `endpoint()`；**绕过它直接 `webServer.register(...)` 的旁路当前不存在，但未来新增第二个注册点会静默失去围栏覆盖**（route-fence 只覆盖现有注册路径）。新增注册路径时必须同时接上 `registerRoutes`，或补一条同等的结构守卫。

- 15 adapter 见结构（`pluginData` / `pluginAssets` 是同一个 `PluginDataAdapter` 类的两个实例：第三方插件数据迁移；这两个分区是**唯一换根**的分区 —— 根 = 系统主目录，见 `core/backup.ts` 的 `OS_HOME_FILE_SECTIONS` / `fsForSection()` 与 `HostContext.osHomeDir` / `homeFs`）；`self`=插件自身配置（`$DSH_HOME/dsh-config-manager/` 下 `sync-*.json`/`market-config.json`/`ui-prefs.json` 白名单收，portable 默认包含；`dataDir` 在 `~/.dsh` 外不挂载）。

- 同步：`SyncEngine`+`Git/WebDavTransport`+`AutoSyncScheduler`(事件驱动,远端新快照才拉/本地改动才推)+`sync-selection`；**autosync 与 sync-selection 按通道(git/webdav)独立**(schema v2，v1→git)，调度器双通道各自排期。
