# Profile 与隔离实例 — 经验与证据存档

> 本文件是**经验/证据**：真机事故、量化数据、复现与复核脚本；**规则本体在 `AGENTS.md`**（对应小节读取）。
> 条目结构：每个 `###` 是原 `AGENTS.md` 的一条完整条目（逐字搬迁，未改写）。域 → 规则 的对应表见 `docs/evidence/README.md`。

## DSH 没有「默认 / 下次启动 profile」这种状态

- **DSH 没有「默认 / 下次启动 profile」这种状态**：profile 只由启动参数决定（`dsh <名>` / `--profile <名>`；`dsh web` 是硬编码别名）；`$DSH_HOME/cordis.patch.yml` 只是叠加在**当前** profile 的 home 层补丁；曾写的 `<dataDir>/next-profile` 标记已整体移除。切换只有两条路：**另起独立实例**（实现细节见 known-pitfalls.md）或让用户改自己的启动命令。**当前档案识别（issue #52）**：`config.profile` → `profileContext`（DSH ≥ 0.1.7 `provide('profileContext', { name, dir, … })`）→ `--profile` → `DSH_PROFILE`/`DSH_PROFILE_DIR` → `web`（`src/index.ts` 的 `resolveProfileName` + `src/core/plugin-cli.ts`）；Desktop 外壳**不传 `--profile`**，只认 argv 会把 desktop 认成 web。六条硬约束：ⓐ 只对 web 形态可启动（否则 `notLaunchable` + 终端命令，绝不假装成功）；ⓑ 实例台账 `<dataDir>/launches.json` 是唯一事实（`listRunning` 按 pid 存活过滤并清死记录）；ⓒ 判重靠**心跳** `<dataDir>/running/<profile>.json`（`dsh-profile-runtime.ts`；20s 刷、60s 判死；**绝不写认证 token**），`running` = 台账 ∪ 心跳；别的实例可停（`stopExternal`），**不能停自己**（`currentProfile`）；ⓓ launch / stop **不过 mutation gate**（gate 会占环境锁且 launch 最长等 20s）；ⓔ 失败绝不静默（`launchFailed`/`stopFailed` 附日志尾部或 pid；停止区分 graceful / killed / already-stopped）；ⓕ 进行中态（`launching/stopping/creating/renaming/deleting`）住 `runStore.profiles` 并用 `useSyncExternalStore` 订阅、**不落 sessionStorage**，新增字段必须进 `toProfilesStoreSlice`。改这块前先读 `src/profiles/dsh-profile-launcher.ts` 文件头。

## `desktop` 是 Electron 独占保留档案

- **`desktop` 是 Electron 独占保留档案**：普通 CLI 对 `--profile desktop` 无条件拒绝（`rejectElectronProfile`），**唯一入口**是桌面端自带的 `@deepseek-ai/dsh-desktop-host/lib/cli.js`（`manageDesktopProfile: true`）→ 载体识别 `src/utils/desktop-carrier.ts`、接线 `core/plugin-cli.ts` 的 `dshArgv(profile)`（补 `ELECTRON_RUN_AS_NODE=1`；认不到则失败分类 `desktop-profile-reserved`）。「当前 DSH 版本」只能从 `profileContext.installAnchor` 取（`resolveDshVersion`），按磁盘猜必错。**启动 / 删除 / 改名一律以 `managedProfile` 拒绝**（`classifyShape` 会把 desktop 判成 web —— 只看形态会误放行启动）。安装失败提示里的 profile 必须与实际安装目标同源（`ctx.target.profile ?? resolveProcessProfileName()`）。

## 复制档案 `POST /profiles/copy`

- **复制档案 `POST /profiles/copy`**：① 拷完必须 `relinkCopiedTree`（`promises.cp` 只照抄链接 → 副本指向源档案；**只重指向树内链接**，判链接用 `readdir(withFileTypes).isSymbolicLink()`）；② 整档案拷贝必须走 async fs（cpSync 卡住宿主 25 s）；③ `includeNodeModules=false` 时同时跳过 `node_modules` 与 `.dsh-module-fallback`，缺依赖进回执（`warnings: ['depsNotInstalled']` + `dsh plugin --profile <副本> install`），中途失败回滚目标目录。

## 复制档案的中断残留（cross-F3）：标记先行 + 只认自己的标记

- **复制档案的中断残留（cross-F3）：标记先行 + 只认自己的标记**：复制**开始前**先在目标目录写 `.dcm-copy-in-progress.json`（`sourceName/newName/startedAt/includeNodeModules/pid`），成功删标记、**失败回滚整个目标目录**、**进程被强杀则标记留盘**。`/profiles` 以 `incomplete: true` 列出「有标记但无 `package.json`」的目录（`shape='generic'` ⇒ `isLaunchableShape` 恒假、绝不给启动按钮），`POST /profiles/delete` 可直接删。**判据只有我们自己的标记，边界不放宽**：既无 `package.json` 又无标记的目录仍**跳过**、仍 `notFound`、仍删不掉 —— 绝不引入「看着像残留就删」的启发式；修复前已存在的**无标记**孤儿目录与用户手工建的目录在磁盘上不可区分，只能手工删（细节与真机证据见 `docs/archive/2026-10-known-pitfalls.md`）。

## 本插件是 bundle 包，隔离实例挂载必须进 `dsh.profile.bundles`

- **本插件是 bundle 包，隔离实例挂载必须进 `dsh.profile.bundles`**：只往 profile 的 `cordis.patch.yml` 写 `{id, name}` 激活行不会挂载（宿主路由 404、启动日志无报错）。隔离 E2E 配方：`$env:DSH_HOME=<临时 home>` → `dsh --profile cmtest --from-default-profile web --dump-config` → `profiles/cmtest/node_modules/dsh-config-manager` 用 **Junction** 指向本仓库 → 加进 `dsh.profile.bundles` → `dsh --profile cmtest --port 3099 --no-open`。**抓 cookie 只对 DSH 自身路由有意义**；POST 体用 `--data-binary @<file>`（PowerShell `-d '{"x":1}'` 会丢引号）。

## `cordis.patch.yml` 是 DSH 的专用 YAML 方言，读写只有一份实现

- **`cordis.patch.yml` 是 DSH 的专用 YAML 方言，读写只有一份实现**（issue #75）：DSH 用 `JSON_SCHEMA` 叠加自定义标量标签 `!!js`（`dsh-app-boot` 的 `entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr)`，构造 `{__jsExpr: <源码>}`）。三条不得回退：① 载入/写回一律走 `src/utils/patch-yaml.ts`（方言单一事实源，含 `boot-safety` 注入的 `parseYaml` —— 它解析的启动关键 yaml 里就有两层 patch 文件），**别在别处用 `yaml.load` 读 patch 文件** —— 缺省 schema 遇到 `!!js` 直接抛 unknown tag，被 catch 成空数组就是「整层 patch 行从导出/同步/预览里消失」；② `raw` 里的 `{__jsExpr}` 是对外契约（`docs/contracts/bundle-format-v1.md`），它是普通 JSON、写回必须还原成 `!!js`，且载入必须用 `JSON_SCHEMA`（`~` 在缺省 Core 下是 null、在 JSON_SCHEMA 下是字符串，DSH 用后者）；③ `applyPatchChanges` 对「存在但解析不了 / 读不到」的原文件**拒绝覆盖**（`host.patchRefuseClobber`），`readPatchLines` 解析失败**上抛**（`host.patchUnreadable`）经 failures 通道变可见告警；**ENOENT 仍是空层**（边界不放宽）。外流摘要一律走 `describePatchYamlError()`（js-yaml 的 message 会附带源码片段，patch 文件里可能内联密钥）。见 known-pitfalls.md 同序条目。

## 写回 patch 的 dump 必须能被 js-yaml 4.x 读回（#135，2026-11-13 源码 + 真机读端实测）

- **规则一句话**：`dumpPatchDocument` 是 patch 方言唯一的写出口，它必须显式 `forceQuotes: true`；否则「插件写的」与「DSH 读的」跨大版本不等价，用户看到的是「我什么都没改，重启后配置自己坏了」。
- **为什么不是同一个库就等价**：DSH 随包的 js-yaml 是 **4.x**（本机 `D:\Apps\DSH\resources\app.asar` 内 `/dsh/node_modules/js-yaml` 与 `/node_modules/js-yaml` 两份都是 **4.3.2**），而本插件 `dependencies` 是 `js-yaml: ^5.4.1`（`JSON_SCHEMA` 语义在两代间改了，5.x 按 YAML 1.2 core 解析纯量、4.x 按 1.1 风格猜类型）。同一个文档，两边读出的值不同，往返/自检都在 5.x 内部打转，所以也测不出来。
- **发散面（探针实测 24 种字符串 / 48 处，map 与 list 各 24；探针 = `.tmp/probe/audit.mjs` 同款，2026-11-13）**：不加引号的当前 dump 下，4.3.2 与 5.5.0 读回不一致 —— `""` `Null` `NULL` `~` → 4.x 得 **null**；`True` `TRUE` `False` `FALSE` → 布尔；`007` `-007` `+7` `012` `-012` `+1` `0x10` `0x1F` `0o17` `0b101` `0b1010` → 4.x 得 7 / -7 / 7 / 12 / -12 / 1 / 16 / 31 / 15 / 5 / 10；`.inf` `.Inf` `-.inf` `.nan` `.NaN` `-.5` `.5` → 4.x 得 Infinity / Infinity / -Infinity / NaN / NaN / -0.5 / 0.5。**不受影响**：`yes` `no` `on` `off` `y` `n`（`JSON_SCHEMA` 根本不是布尔）、`1_000` `1:20` `12:34:56`（4.x 的 JSON_SCHEMA 不认下划线/性数基数）、字面量 `"null"` 与 `" "`（5.x 自己就会加引号），以及一切首字符会被 5.x 判为不安全而自动加引号的串。
- **清单只是回归样本，不是完备性证明**：完备性来自机制 —— `forceQuotes` 把**每一个**字符串值写成带引号标量，而带引号的标量在任何 schema（含 4.x 的 JSON_SCHEMA）下都解析成 string。所以清单漏了某个怪串也不会漏数据；反过来，**别把清单当成「只有这些要修」**去改写正则。
- **影响窗口是 v0.1.57 – v0.8.2**（报告的「0.7.0 起」偏小）：`js-yaml: ^5.4.1` 从 v0.1.57 起才进 `dependencies`（v0.1.56 及更早是 `^4.1.0`，与 DSH 同代、不会发散）；`git show <tag>:package.json` 逐 tag 核实，中间没有回退。
- **两道护栏为什么拦不住（同一自洽盲区）**：① `src/utils/patch-yaml.test.ts:47` 的「写回保真」是 `load(dump(doc))` 自环 —— 两端都是 5.x；② 写后自检 `src/index.ts:1748-1756` 拿 `describePatchLayoutDrift(plan, describePatchDocument(loadPatchDocument(text)))` 比对，读回同样走 5.x，且 `src/core/patch-document.ts:171` 的实现只比 `insertIds` / `topLevelIds` **集合**，不看标量类型 ⇒ 值被写坏时事务照样 `COMMITTED`、报告照样 `validated: true`。
- **修法与实测**：`dump(value, { schema: PATCH_YAML_SCHEMA, forceQuotes: true })` 把 48 处发散清零；`!!js` 短标签与 `!!js |-` 块标量形态不变（4.x 仍还原成 `{__jsExpr}`）；`null` 仍写 `null`、数字与布尔不受影响。`forceQuotes` 在依赖下限 **5.4.1** 就存在（`dist/js-yaml.mjs:2861 applyForceQuotesOption`、d.ts `DumpOptions extends PresenterOptions`），不必抬 depend。
- **代价（别在下次「优化掉引号」）**：所有字符串值带引号（含键值对的键以外的普通值），普通多行字符串从 `|-` 块标量退化为双引号 + `\n` 转义（`!!js` 块标量不受影响）。可读性下降是可接受的，因为它换来的是跨大版本可读回；想改回块标量就只能让 4.x 读错。
- **跨版本断言怎么钉**：`devDependencies` 用别名 `js-yaml4: npm:js-yaml@^4.3.2`（运行时依赖仍只有 `js-yaml`，`packaging-contract` 的 P-1 不变），测试里用 4.x + `JSON_SCHEMA.extend([!!js])` 真读回，对 24 种边界串 × map/list（48 处）做 `deepEqual`，并加两条结构性断言：①「`loadAsDsh(text)` 与 `loadPatchDocument(text)` 必须相等」；②「每个字符串值输出必带引号」（`^k: ['"]`，不依赖清单完整性）。
- **真机往返实测（2026-11-13，本机 5 份真 patch 文件）**：`~/.dsh/cordis.patch.yml`、`plugins/dsh-purge/`、`profiles/{desktop,open-design,superagent}/` 各 217–3304 B（含 `!!js` 行与块标量），`dumpPatchDocument(loadPatchDocument(text))` 后用 4.3.2 读回，与原文件 4.x 读出的值 **0 差异**（5.x 侧同样 0 差异）；而**旧写路径**（不加 `forceQuotes`）在同一份 `plugins/dsh-purge/cordis.patch.yml` 上把 3 个空串写成 null（`[5].config.personaPrefix` / `[5].config.personaSuffix` / `[6].config.postPrompt`）—— 这就是 #135 的真机指纹，说明这类字段在真实 patch 里并不罕见。
- **两条相邻缺口（修复前就存在，未在 #135 处理，别当成已修）**：① **键名不在 `forceQuotes` 覆盖范围**（js-yaml 5 只对值生效）：键名 `012` `0x10` `007` `.5` `TRUE` `~` 被 4.x 解析成数字/布尔/null 再被 JS 强制成字符串 ⇒ 键名变形（`012`→`12`、`0x10`→`16`、`~`→`null`）；空键名 dump 成 `: v`，4.x 直接 `incomplete explicit mapping pair`；普通标识符键名（插件名、config 字段名）不受影响。② **`!!js` 空源码**：`{__jsExpr: ''}` dump 成裸 `!!js`，5.x 读回 `""`、4.x 读回 `{__jsExpr: null}`（空表达式本身无意义，判为可接受）。
- **历史坏数据不会自动修**：写侧修复只保证「下次被写就复原」，已写坏的字段仍是 `null`/`true`/`7`。判定与手工改法见 `docs/known-issues/known-limits.md` §18。
## 同步导入装插件必须钉备份记录的精确版本

- **同步导入装插件必须钉备份记录的精确版本**（issue #101，2026-10）：`dsh plugin add <裸包名>` 由 pnpm 解析，而 pnpm 会**尊重该 profile 里 `package.json` 已有的 spec** —— 源机写的是 `0.9.3` 这类精确 pin 时，远端已到 `0.9.5` 也照样「安装成功」，事务还会报「已触发更新（npm 最新版）」而版本一字未变。三条边界：① 安装目标只有一个决策点 `pluginInstallTarget(pkg, { version, spec, tarballPath })`（`src/core/plugin-cli.ts`），顺序 tarball → 非 registry spec 原样 → **具体 semver 走 `pkg@version`** → 其余 spec 走 `pkg@spec` → 都没有才裸名（旧备份兼容）；② 门面 `PluginsFacade.install(pkg, target)` 是**哑执行器**，绝不在内部二次推导，日志与实际 argv 必须同一个变量；③ 退出码不算数 —— 装完必须 `readInstalledVersion()` 回读 `node_modules/<pkg>/package.json` 与备份 `entry.version` 比对，不一致要标 warning 并给出可复制的 `dsh plugin --profile <p> add <pkg>@<version>`（精确 pin 的版本从 npm 撤版时只能明确失败，不能静默停旧版）。semver 判据复用 `src/core/validator.ts` 的 `isConcreteVersion()`（不得再添第 N 份 `SEMVER_RE`）。
## 读插件清单是纯读：对账（reconcileBundles）只属于安装写路径

- **现象（issue #111，2026-10 真机）**：用户把某个插件关掉（从 `dsh.profile.bundles` 移除），此后**只要打开「设置 → 备份与迁移」**，`package.json` 里的 `dsh.profile.bundles` 就被改回全量，被关掉的插件下次启动照常挂载。报告者日志指向 `listInstalledPlugins()` 第一行调 `reconcileBundles(dir)`。
- **根因**：读路径挂写操作。`src/core/plugin-cli.ts` 的 `listInstalledPlugins()` 曾先 `reconcileBundles()`「顺手把清单对账好」，而对账会 `writeProfileManifest` 写盘；调用方遍布只读入口 —— 备份页列表（`src/adapters/plugins.ts` → `DshPluginsFacade.listInstalled`）、导出预览（`src/core/backup.ts`）、自动快照（`src/core/verify-recovery.ts`）。用户「只是看一眼」= 一次静默写盘 + 行为回退（关掉的插件复活）。
- **修法**：① `listInstalledPlugins()` 改为**纯读零写入**，清单需要的 `isBundle/inBundles/bundlesOnly` 全部现算（读包内 `cordis.patch.yml` 判定），不再依赖「先对账」这个副作用；② 对账挪到唯一写路径 `DshPluginsFacade.install()` 成功后（导入/恢复/市场安装最终都到这里），封装成 `reconcileBundlesAfterInstall(profileDir): boolean`（失败返回 false、不抛 —— 包已装好，不因对账写失败否掉成功）；③ 救援模式守卫仍留在 `reconcileBundles` 内部（写路径在救援期间同样不得加回）。
- **回归测试**：`src/core/plugin-cli.fs.test.ts`（读清单前后 `package.json` **逐字节相等**、`bundles` 不变，随后显式调用写路径才变）/ `src/index.facade.test.ts`（`listInstalled` 零写入 + `install` 成功后 bundle 仍进 `bundles`）。
- **教训**：**任何「为了让后续逻辑好写」而挂在读函数开头的对账/迁移/补写，都会变成用户视角的「它自己改我配置」**；清单字段能现算就现算，写操作只挂在语义上就是写的入口（安装成功、用户点保存）。
- **顺带发现并已修（同一 issue 的第二个缺陷）**：`reconcileBundles` 的「移除」循环原先只对「加回」那一路跳过 in-box 层；profile 模板常把 `@deepseek-ai/dsh-base` **同时**写成 `dependencies` 行，而其实体在 DSH 安装树、profile 的 `node_modules` 下并不存在 ⇒ `hasDshBundlePatch` 读不到 ⇒ 核心层被判「已不是依赖」而从 `bundles` 移出（下次启动少挂一层，日志无报错）。修法：移除循环首行 `if (INBOX_BUNDLES.has(name)) continue`（`INBOX_BUNDLES` = dsh-base / dsh-web-app / dsh-headless，定义在 `src/core/plugin-cli.ts`），函数 doc 同步写成「加回与移出两条路都跳过」。回归测试 `src/core/plugin-cli.fs.test.ts`：in-box 层被写成依赖行且 `node_modules` 无实体时 `reconcileBundles` 返回 false 且 `package.json` **逐字节相等**；同树另有真 bundle 时返回 true 且只追加它。判据：**in-box 层永远不是依赖，两条路都不许碰**。

## pnpm 隔离安装的「同树布局」有三种，推导只能有一处

- **pnpm 隔离安装的「同树布局」有三种，推导只能有一处**（issue #74）：`@deepseek-ai/dsh/package.json` 的候选根反推为 `dirname/../..` 后，先试 hoisted 同级、再试 `dsh/node_modules` 嵌套，**最后**用 `sessionFormatRoots()` 扫最近 `.pnpm` 里的 `@deepseek-ai+dsh-session@*`（前缀末尾的 `@` 必须有，否则 `-projection` 误命中）。三条不得回退：① 多版本共存取与本机 dsh **同版本**者，**版本读不出来或对不上且多候选 → 不猜**（宁可体检跳过，也不谎报格式）；② `session-verify.ts`（复验门的权威版本）与 `dsh-profile-manager` 必须共用这一份实现，**禁止再写第二份布局推导**；③ 解析失败要把**已尝试的路径**写进日志（`resolveSessionFormatVersion(candidates, tried)`）。见 known-pitfalls.md 同序条目。

## 档案启动：Windows 上 .cmd 包装 + detached 会吞掉孙进程 stdio（拿不到 token URL）

- **现象（2026-10 真机）**：档案页点「启动」后，实例其实起来了（`curl http://127.0.0.1/<port>/` 返回 401，端口 LISTENING），但界面报「档案「web」的进程已启动（端口 3081），但 20 秒内未确认就绪」＋「没能从启动日志里抓到带 token 的认证 URL」。
- **决定性证据**：`C:\Users\<user>\.dsh\dsh-config-manager\logs\launch-web-3081.log` 只有 140 字节 = 70 个 `^C` 字符，**没有任何 `dsh web:` 行**；而同目录旧的成功样本 `launch-cmtest-3081.log`（2026-09-27）里有 20 行 `dsh web: http://127.0.0.1:3081/?token=…`。
- **隔离实验（`.tmp/` 下 repro2/repro3/sim2–sim9/timing/e2e-launch*.mjs）**：都以 fd 重定向写文件，再比对文件字节数：
  · `cmd.exe /d /s /c node --version` + `detached:true` → **文件 0 字节**；同命令非 detached → `v24.13.0` ✔
  · `dsh.cmd --version` + detached → 0 字节；非 detached → `0.2.0-rc.2` ✔
  · 直启 `node --version`（或 `node <bin.js>`）+ detached → 正常写入 ✔
  · `windowsHide:false` 版 detached → 仍 0 字节 ⇒ 与 windowsHide 无关
  · 批处理内部自己写 `>> file 2>&1`（`cmd /c wrap-redirect.cmd`）+ detached → 仍 0 字节
  ⇒ **Windows 上任何「中间 cmd 层（shell 或显式 cmd.exe）+ detached:true」都会丢掉孙进程的 stdout/stderr**，与命令内容、dsh 版本无关。
- **为什么必须抓到 stdout**：带 token 的地址是**进程内**的 —— `@deepseek-ai/dsh-client-connection/lib/index.js:374-377` `authenticatedUrl(baseUrl){ url.searchParams.set(TOKEN_QUERY, this.launchToken) }`，`launchToken` 不落盘，**除了 stdout 没有第二条获取路径**（探活只能拿到 401）。
- **修法**：`defaultResolveCli()` 从 PATH 上的 `dsh.cmd` 反解真正的 `…/@deepseek-ai/dsh/lib/bin.js`（先试同目录/上级 `node_modules`，再退回读脚本内嵌路径，含 `..\node_modules\…` 形态），然后用 `process.execPath` 直启（宿主是 Electron 时加 `ELECTRON_RUN_AS_NODE=1`），**`shell:false`**。反解不出来才退回包装脚本（此时日志无 URL，UI 如实报 `urlNotFound`）。
- **直启实测**：`spawn(process.execPath, [bin.js,'--profile','web','--port','3087','--no-open'], {detached:true, windowsHide:true, stdio:['ignore',fd,fd]})` → 2 秒写入 11162 字节、8 秒出现 token URL；Electron 宿主形态（`DeepSeek Harness.exe` + `ELECTRON_RUN_AS_NODE=1`）同样 8 秒出 URL。
- **20 秒为什么不够**：URL 打印被夹在 `loader.await()`（整棵插件树 settle）+ `auditStartupEntries`（纯本地遍历，不联网）之后；web 档案有 10 个 bundle 因 peerDependencies 与 dsh 0.2.0-rc.2 不兼容被跳过（每条约 1KB 警告），实测 URL 到达 8–10 秒，也有 >20 秒的样本 ⇒ `DSH_PROFILE_LAUNCH_TIMEOUT_MS` 由 20_000 放宽到 30_000（UI 文案引用同一常量，自动同步显示）。
- **判据（别退回旧写法）**：Windows 上 `spawn` 长驻 node 子进程必须直启入口文件；`shell:true` 只允许出现在「拿不到入口、且不依赖子进程输出」的降级路径上。单测钉住：`findCliEntryForShim`（三布局）、`resolveDirectCliRunner`（Electron/node）、以及「直启时 spawn 不带 shell」。

## 用桌面 asar 里的同版本 CLI 做真机 E2E（2026-11-06 实测，dsh 0.2.2-rc.1）

- **动机**：`npm i -g` 的 dsh 常落后桌面端（本例全局 0.2.0-rc.2、桌面 asar 0.2.2-rc.1），要验证「新版宿主 + 本插件」的真实往返，不必先重装全局。
- **命令**（asar 内的 bin 用 Electron 当 node 跑，asar 路径可直接 require）：
  `ELECTRON_RUN_AS_NODE=1 "D:/Apps/DSH/DeepSeek Harness.exe" "D:/Apps/DSH/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" --profile web --host 192.168.0.205 --port 3080 --no-open`
- **入口别名**：`dsh web` 就是 `--profile web`（`dsh-web-app/lib/startup.js:25` 的 `Command().name("dsh --profile web")`）；`--host` 只接受**一个具体接口字面量**，通配地址直接 `program.error`；另有 `--trusted-host <authority...>`、`--public-url`（只广告不授权）、`--tls-cert/--tls-key`。
- **启动产出**：日志尾部 `dsh web: listening on <host> over plain HTTP` + `http://<host>:<port>/?token=…`（token 仅进程内，见上节）。
- **用 curl 复现围栏三态**（都带 `--interface <LAN IP>` 保证源地址不是回环）：无 cookie → `401 {"error":"unauthorized: browser-session","code":"browser-session"}`；先 `curl -c jar "http://<host>:<port>/?token=…"` 拿 `dsh-auth-*` cookie → `200` 真实 payload；同一 cookie 换成外来 `Host: 10.9.9.9:3080` → `403 {"error":"forbidden: untrusted-authority"}`。
- **坑**：`web` 档案若长期没跟宿主升级，会有一串 `skipping profile bundle … is incompatible with dsh 0.2.2-rc.1`（本例 7 条），只影响那些插件，不影响本插件的围栏结论。

## profile patch 的 `insert` 与顶层行不等价（#133，2026-11-11 源码核实）

- **宿主语义（读 asar 里内嵌的合并循环逐行核实）**：对每条 `{ id, insert, name, ...overrides }` —— 有 `insert` 时：带 `id` ⇒ 深拷贝其数组并 push 进**已存在** group 的 `config`（目标不存在打 `patch insert: entry %C not found`、非 group 打 `patch insert: entry %C is not a group`，都 `continue`）；**不带 `id` ⇒ `data.push(...clone)` + `buildMap(clone)`，这是唯一的新增路径**。无 `insert` 时：无 `id` ⇒ `patch: id is required for non-insert patches`；`entryMap` 查不到该 id ⇒ `patch: entry %C not found` 丢弃；`name` 与目标不一致 ⇒ `patch: name mismatch … skipping` 整行跳过。⇒ **顶层行只做覆盖、绝不新增**；「顶层 `{id,name}` 行 ≡ `- insert:` 成员」是不成立的前提。
- **插件里的假前提**：`DshPatchFileFacade.applyPatchChanges` 载入时把 insert 块成员摊平进 `rows`/`order`，重建时统一输出顶层行，注释写「The loader treats a top-level { id, name } row exactly like an `- insert:` block member (dsh-base patch precedent), so the document stays semantically equal.」—— 与宿主源码直接冲突，是 issue #133 的根因。
- **真机后果**：一次 `sync-merge-apply`（导入/合并共用这条写路径）后，profile patch 里所有纯新增条目（典型是 MCP server）变成顶层行 ⇒ DSH 每次加载 `patch: entry "…" not found` 并丢弃；bundle 层本来就有的条目因顶层行恰好合法而毫发无伤 —— 「只有纯新增条目全灭」正是这件事的指纹。
- **单测级复现（无业务改动，`.tmp/repro-133.cjs`）**：用 `lib/index.js` 的 `DshPatchFileFacade` + `lib/adapters/mcp.js` 的 `buildMcpPatchLine`，在临时 home 写 1 个顶层行 + 1 个 insert 块（成员带 `name: '@deepseek-ai/dsh-mcp-client'`、`config.transport: stdio`）+ 一行注释，再跑一次 `update`：结果 insert=0、顶层 2 行、注释丢失、`name` 变裸名 `dsh-mcp-client`、`transport` 整行消失。**一条 update 就够，不需要多次合并**。
- **修复判据（留给实现）**：重建文档时按「id 是否已存在于生效 patch 链（bundle 层 + 本文件之外的层）」分流 —— 已存在 ⇒ 顶层覆盖行；不存在 ⇒ 必须重新包回 `- insert:`。仓内已有正确形状可参照：`boot-rescue.ts` 写「新增挂载」时**只用** `- insert:` 块，包已在 bundles 时一行都不写（同 id 重复会让 loader 抛错）；`patchRowActivates()` 已兼容单行与 insert 成员，层身份解析在 `patch-layers.ts`。
- **同一写路径的第二个缺陷（字段损失，独立于摊平）**：`buildMcpPatchLine()` 按白名单重建 patch 行，只输出 `serverName` + 按 type 分支的 `url/headers` 或 `command/args/env/cwd`，**不写 `transport`，`name` 也不带 `@deepseek-ai/` scope**（白名单本身写在 `docs/contracts/bundle-format-v1.md` 的 mcp 一节）。即使摊平修好，insert 成员的 `name` 与 `transport` 仍会被改写。
- **为什么事务自检全绿**：patch 行项没有文件 `rel`，`analyzer` 按 `external: rel === null` 处理 ⇒ `beforeFp`/`afterFp` 恒 null，校验只能空过（既有可证限制，见 `docs/evidence/recovery-console.md` 的 external step 一节）。⇒ 这条写路径缺的不是指纹，而是**写后语义自检**（重读并断言「原本 insert 的 id 仍在 insert 里」）。
- **未验证**：宿主是否接受裸名 `dsh-mcp-client` 解析到 `@deepseek-ai/dsh-mcp-client`（insert 路径读到的那段代码只对「带 id 的 insert」做校验，未读到 name 归一化逻辑）；报告者观察到的 7 处 `""` → `null` 归一化本机未复现。
- **修复落点（2026-11-11，两提交）**：写回不再摊平 —— `src/core/patch-document.ts` 只按原文档的归属重排（insert 成员留在块里、`update` 不改归属），`applyPatchChanges` 落盘前做结构自检（`describePatchLayoutDrift`）与跨层提升守卫（`promotedTopLevelIds`），任一不过即零写入报码。MCP 写回同时补齐 `config.transport` 与 scoped 行名 `@deepseek-ai/dsh-mcp-client`，因此**不再依赖宿主对裸名的归一化**（上面那条未验证项对本插件已不构成风险）。


