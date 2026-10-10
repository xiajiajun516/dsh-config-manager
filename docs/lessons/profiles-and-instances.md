# Profile 与隔离实例 — 经验与证据存档

> 本文件是**经验/证据**：真机事故、量化数据、复现与复核脚本；**规则本体在 `AGENTS.md`**（对应小节读取）。
> 条目结构：每个 `###` 是原 `AGENTS.md` 的一条完整条目（逐字搬迁，未改写）。域 → 规则 的对应表见 `docs/lessons/README.md`。

## DSH 没有「默认 / 下次启动 profile」这种状态

- **DSH 没有「默认 / 下次启动 profile」这种状态**：profile 只由启动参数决定（`dsh <名>` / `--profile <名>`；`dsh web` 是硬编码别名）；`$DSH_HOME/cordis.patch.yml` 只是叠加在**当前** profile 的 home 层补丁；曾写的 `<dataDir>/next-profile` 标记已整体移除。切换只有两条路：**另起独立实例**（实现细节见 known-pitfalls）或让用户改自己的启动命令。**当前档案识别（issue #52）**：`config.profile` → `profileContext`（DSH ≥ 0.1.7 `provide('profileContext', { name, dir, … })`）→ `--profile` → `DSH_PROFILE`/`DSH_PROFILE_DIR` → `web`（`src/index.ts` 的 `resolveProfileName` + `src/core/plugin-cli.ts`）；Desktop 外壳**不传 `--profile`**，只认 argv 会把 desktop 认成 web。六条硬约束：ⓐ 只对 web 形态可启动（否则 `notLaunchable` + 终端命令，绝不假装成功）；ⓑ 实例台账 `<dataDir>/launches.json` 是唯一事实（`listRunning` 按 pid 存活过滤并清死记录）；ⓒ 判重靠**心跳** `<dataDir>/running/<profile>.json`（`dsh-profile-runtime.ts`；20s 刷、60s 判死；**绝不写认证 token**），`running` = 台账 ∪ 心跳；别的实例可停（`stopExternal`），**不能停自己**（`currentProfile`）；ⓓ launch / stop **不过 mutation gate**（gate 会占环境锁且 launch 最长等 20s）；ⓔ 失败绝不静默（`launchFailed`/`stopFailed` 附日志尾部或 pid；停止区分 graceful / killed / already-stopped）；ⓕ 进行中态（`launching/stopping/creating/renaming/deleting`）住 `runStore.profiles` 并用 `useSyncExternalStore` 订阅、**不落 sessionStorage**，新增字段必须进 `toProfilesStoreSlice`。改这块前先读 `src/profiles/dsh-profile-launcher.ts` 文件头。

## `desktop` 是 Electron 独占保留档案

- **`desktop` 是 Electron 独占保留档案**：普通 CLI 对 `--profile desktop` 无条件拒绝（`rejectElectronProfile`），**唯一入口**是桌面端自带的 `@deepseek-ai/dsh-desktop-host/lib/cli.js`（`manageDesktopProfile: true`）→ 载体识别 `src/utils/desktop-carrier.ts`、接线 `core/plugin-cli.ts` 的 `dshArgv(profile)`（补 `ELECTRON_RUN_AS_NODE=1`；认不到则失败分类 `desktop-profile-reserved`）。「当前 DSH 版本」只能从 `profileContext.installAnchor` 取（`resolveDshVersion`），按磁盘猜必错。**启动 / 删除 / 改名一律以 `managedProfile` 拒绝**（`classifyShape` 会把 desktop 判成 web —— 只看形态会误放行启动）。安装失败提示里的 profile 必须与实际安装目标同源（`ctx.target.profile ?? resolveProcessProfileName()`）。

## 复制档案 `POST /profiles/copy`

- **复制档案 `POST /profiles/copy`**：① 拷完必须 `relinkCopiedTree`（`promises.cp` 只照抄链接 → 副本指向源档案；**只重指向树内链接**，判链接用 `readdir(withFileTypes).isSymbolicLink()`）；② 整档案拷贝必须走 async fs（cpSync 卡住宿主 25 s）；③ `includeNodeModules=false` 时同时跳过 `node_modules` 与 `.dsh-module-fallback`，缺依赖进回执（`warnings: ['depsNotInstalled']` + `dsh plugin --profile <副本> install`），中途失败回滚目标目录。

## 复制档案的中断残留（cross-F3）：标记先行 + 只认自己的标记

- **复制档案的中断残留（cross-F3）：标记先行 + 只认自己的标记**：复制**开始前**先在目标目录写 `.dcm-copy-in-progress.json`（`sourceName/newName/startedAt/includeNodeModules/pid`），成功删标记、**失败回滚整个目标目录**、**进程被强杀则标记留盘**。`/profiles` 以 `incomplete: true` 列出「有标记但无 `package.json`」的目录（`shape='generic'` ⇒ `isLaunchableShape` 恒假、绝不给启动按钮），`POST /profiles/delete` 可直接删。**判据只有我们自己的标记，边界不放宽**：既无 `package.json` 又无标记的目录仍**跳过**、仍 `notFound`、仍删不掉 —— 绝不引入「看着像残留就删」的启发式；修复前已存在的**无标记**孤儿目录与用户手工建的目录在磁盘上不可区分，只能手工删（细节与真机证据见 `docs/known-pitfalls.md`）。

## 本插件是 bundle 包，隔离实例挂载必须进 `dsh.profile.bundles`

- **本插件是 bundle 包，隔离实例挂载必须进 `dsh.profile.bundles`**：只往 profile 的 `cordis.patch.yml` 写 `{id, name}` 激活行不会挂载（宿主路由 404、启动日志无报错）。隔离 E2E 配方：`$env:DSH_HOME=<临时 home>` → `dsh --profile cmtest --from-default-profile web --dump-config` → `profiles/cmtest/node_modules/dsh-config-manager` 用 **Junction** 指向本仓库 → 加进 `dsh.profile.bundles` → `dsh --profile cmtest --port 3099 --no-open`。**抓 cookie 只对 DSH 自身路由有意义**；POST 体用 `--data-binary @<file>`（PowerShell `-d '{"x":1}'` 会丢引号）。

## `cordis.patch.yml` 是 DSH 的专用 YAML 方言，读写只有一份实现

- **`cordis.patch.yml` 是 DSH 的专用 YAML 方言，读写只有一份实现**（issue #75）：DSH 用 `JSON_SCHEMA` 叠加自定义标量标签 `!!js`（`dsh-app-boot` 的 `entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr)`，构造 `{__jsExpr: <源码>}`）。三条不得回退：① 载入/写回一律走 `src/utils/patch-yaml.ts`（方言单一事实源，含 `boot-safety` 注入的 `parseYaml` —— 它解析的启动关键 yaml 里就有两层 patch 文件），**别在别处用 `yaml.load` 读 patch 文件** —— 缺省 schema 遇到 `!!js` 直接抛 unknown tag，被 catch 成空数组就是「整层 patch 行从导出/同步/预览里消失」；② `raw` 里的 `{__jsExpr}` 是对外契约（`docs/spec/bundle-format-v1.md`），它是普通 JSON、写回必须还原成 `!!js`，且载入必须用 `JSON_SCHEMA`（`~` 在缺省 Core 下是 null、在 JSON_SCHEMA 下是字符串，DSH 用后者）；③ `applyPatchChanges` 对「存在但解析不了 / 读不到」的原文件**拒绝覆盖**（`host.patchRefuseClobber`），`readPatchLines` 解析失败**上抛**（`host.patchUnreadable`）经 failures 通道变可见告警；**ENOENT 仍是空层**（边界不放宽）。外流摘要一律走 `describePatchYamlError()`（js-yaml 的 message 会附带源码片段，patch 文件里可能内联密钥）。见 known-pitfalls 同序条目。

## pnpm 隔离安装的「同树布局」有三种，推导只能有一处

- **pnpm 隔离安装的「同树布局」有三种，推导只能有一处**（issue #74）：`@deepseek-ai/dsh/package.json` 的候选根反推为 `dirname/../..` 后，先试 hoisted 同级、再试 `dsh/node_modules` 嵌套，**最后**用 `sessionFormatRoots()` 扫最近 `.pnpm` 里的 `@deepseek-ai+dsh-session@*`（前缀末尾的 `@` 必须有，否则 `-projection` 误命中）。三条不得回退：① 多版本共存取与本机 dsh **同版本**者，**版本读不出来或对不上且多候选 → 不猜**（宁可体检跳过，也不谎报格式）；② `session-verify.ts`（复验门的权威版本）与 `dsh-profile-manager` 必须共用这一份实现，**禁止再写第二份布局推导**；③ 解析失败要把**已尝试的路径**写进日志（`resolveSessionFormatVersion(candidates, tried)`）。见 known-pitfalls 同序条目。
