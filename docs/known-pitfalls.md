# 常见坑与事故记录（详细版）

> **来源**：原 `AGENTS.md`「📌 常见坑」章节全文（2026-10-05 逐字移出，未改写）。
> **为什么移出**：`AGENTS.md` 每轮对话都要进模型上下文，受 DSH 的 workspace instruction 预算（65536 B）限制 —— 项目 `AGENTS.md` 一旦 ≳64 KB，全局 `~/.dsh/AGENTS.md` 会被**整份丢弃**（dsh-agent-instructions 的 `renderInstructionContext`：文件按「最宽泛 → 最具体」排序，超预算时从最宽泛的整份丢弃）。压缩后 `AGENTS.md` 只保留**铁律与硬约束** + 指向本文的指针，本文保留**完整叙事、真机证据、量化数据与复核脚本**。
> **怎么用**：改相关模块前先读 `AGENTS.md` 对应铁律；需要「当时为什么这么定」「真机复现路径」「量化数字」「复核脚本在哪」时来这里。
> **维护约定**：新增坑 → `AGENTS.md` 写铁律 + 本文写细节，**两处都要**，不要只写一处。

---

- **DSH 没有「默认 / 下次启动 profile」这种状态（档案切换的真实根因，2026-09 真机定位并据此重做）**：profile 只由启动参数决定 ——
  `dsh <名>` / `--profile <名>`，`dsh web` 是硬编码别名（`apps/cli/src/args.ts` 里缺 `--profile` 直接报错退出），
  启动日志/状态文件里**没有任何「上次用的是哪个 profile」**；`$DSH_HOME/cordis.patch.yml` 只是叠加在**当前** profile 上的 home 层补丁，
  换不了 profile。**曾经写过 `<dataDir>/next-profile` 标记 + 「设为下次启动」按钮 —— 那是写了个没人读的文件**（用户自己敲的
  `dsh web` 重启后当然还是 web；真机：设 PROVA 为下次启动 → 重启仍进 web）——2026-09 该标记与按钮**整体移除**：它只会让用户以为
  切换成功了。真正可用的切换只有两种：① **另起独立实例**（本插件「启动/停止该档案」= `dsh --profile <名> --port <空闲端口>` detached +
  从子进程日志抓带 token 的认证 URL + HTTP 探活 + 按 `process.kill(pid,0)` 判活；生态里的 dshm / DSH Launcher 走的都是这条）；
  ② 把用户的启动命令/快捷方式换成 `dsh --profile <名>`（插件无法远程改别人的启动入口，所以只能给命令）。**当前档案的识别（issue #52，2026-09）**：宿主在 boot 时 `provide('profileContext', { name, dir, … })`（DSH ≥ 0.1.7 取证）—— Desktop 外壳**不传 `--profile`**，只认 argv 会把 desktop 认成 web（插件清单来源 / 档案页「当前运行」/ 备份·导出·恢复目标全落到 `profiles/web`）；解析链恒为 `config.profile` → `profileContext` → `--profile` → `DSH_PROFILE`/`DSH_PROFILE_DIR` → `web`（`src/index.ts` 的 `resolveProfileName` + `src/core/plugin-cli.ts`，由 `src/core/plugin-cli.test.ts` 钉住）。五条硬约束：
  ⓐ **只对 web 形态可启动**（headless/generic 如 base 模板 spawn 出去是用户看不见的进程 → `notLaunchable` + 终端命令，绝不假装成功）；
  ⓑ **实例台账是唯一事实**（`<dataDir>/launches.json`：pid/port/url/log；`listRunning` 按 pid 存活过滤并清死记录，UI 的「启动 ↔ 停止」就是它的投影——
  DSH 不认识插件启动的进程，不记账就永远关不掉）；
  ⓒ **同一 profile 不许重复启动，判据是「心跳」而不是「台账」**（真机 bug：从 web 启动 cmtest 后，在 cmtest 的界面里还能再启动 web —— web 是手动敲起来的，不在任何台账里）：
  每个加载本插件的实例在 apply 时往 `<dataDir>/running/<profile>.json` 自报 `{pid, port, startedAt, updatedAt}`（`dsh-profile-runtime.ts`；20s 刷、60s 判死、pid 死或过期即清理；**绝不写认证 token**——那等于把该实例的 DSH RPC 交给本机任意进程）。
  `GET /profiles` 的 `running` = 台账 ∪ 心跳的合并视图（`owned` 标谁启动的、`current` 标是不是自己），`launch` 前同时过台账与心跳 → 已在跑就 `alreadyRunning`，**启动当前档案直接 `currentProfile`**；
  心跳里的**别的实例也能被停**（`stopExternal` 按它的心跳 pid 走同一套优雅→强杀），但**不能停自己**（`currentProfile`：进程会死在响应途中，UI 给禁用按钮 + 「关窗口」提示）；
  「实例运行中」的判据同样用合并视图（删除档案前挡住）；存活判定/优雅期/终止只有一份实现（`process-control.ts`，Windows 无优雅通道 → 1.5s 后必然强杀）。
  ⓓ **launch / stop 不过 mutation gate**：它们不写任何配置文件，而 gate 会把环境锁占到 handler 返回（launch 最长等 20s 就绪）——
  真机实测：gated 版本会在「启动完成后 1s 内点删除/停止」时回 423 mutation-locked，且那 20s 里导入/恢复全被挡（无 gate 后改用
  「就绪后再查一次台账，撞名就杀掉自己那个并报 alreadyRunning」兜住双开窗口）；
  ⓔ **绝不静默**：每个失败码都带原因，`launchFailed` / `stopFailed` 附子进程日志尾部或 pid；停止如实区分 graceful / killed / already-stopped。
  ⓕ **进行中态必须住进 runStore 切片**（真机两轮定位）：`launching/stopping/creating/renaming/deleting` 放进 `runStore.profiles`，
  面板用 `useSyncExternalStore(runStore.subscribe, selectProfilesSlice)` **订阅读取**（`PanelState = ProfilesStoreSlice`，不另存 useState 副本）——
  ① 留在组件 state 里，切页签（卸载）就归零：正在启动的按钮切走再回来变回「启动」，用户以为没点上而重复点；
  ② 只写 store 不订阅，上一次挂载遗留的那次请求（launch 最长 20s，必然踩到）回来时界面不刷新 → 「启动中」一直转。
  进行中态/弹窗目标/启动回执**不落 sessionStorage**（发起请求的页面已随刷新销毁，重放 spinner 只会骗人；`launchResult.url` 还带 token）。
  新增字段必须同时进 `toProfilesStoreSlice`（`run-store.test.ts` 的键集合 + 镜像不漏字段用例会红）。详见 `DEVELOPERS.md` 状态管理细则。
  改这块前先读 `src/profiles/dsh-profile-launcher.ts` 的文件头与 `src/profiles/dsh-profile-launcher.test.ts`
  （真机验证脚本：`outputs/launch-verify/`）。
- **DSH Desktop（Electron 桌面端）的保留档案 `desktop`：插件操作必须走桌面端自带的 CLI 载体**（2026-09 真机：导入 10 个插件全红，每条都是 `error: profile "desktop" is managed exclusively by the Electron application`）。硬事实与接线：
  ⓐ `desktop` 是 **Electron 独占保留档案** —— 普通 CLI 对 `--profile desktop` **无条件**拒绝（`@deepseek-ai/dsh@0.1.5-rc.1` / `0.2.0-rc.2` 的 `lib/bin.js` 里 `rejectElectronProfile`；`plugin` 子命令只在 `manageDesktopProfile` 为真时跳过它，0.2.0 还额外要求该档案的 `package.json` 已存在）；
  ⓑ **唯一放行的入口 = 桌面端自带的 `@deepseek-ai/dsh-desktop-host/lib/cli.js`**（它以 `runCli({ manageDesktopProfile: true, packageManager })` 启动，用桌面端内置 runtime + 内置 pnpm）。宿主进程由 Electron 主进程以 Node 模式拉起：`process.argv[1]` 就是同包的 `lib/index.js`，同目录的 `cli.js` 即载体 → 识别在 `src/utils/desktop-carrier.ts`，接线在 `core/plugin-cli.ts` 的 `dshArgv(profile)`（目标是 desktop 时改用它，并补 `ELECTRON_RUN_AS_NODE=1`；检测不到载体则落回原路径，由新的失败分类 `desktop-profile-reserved` 给可操作说明）；
  ⓒ **桌面端在 `app.asar` 里跑 0.2.0-rc.2，磁盘上 `<home>/profiles/node_modules/@deepseek-ai/dsh` 却是 web 档案 hoisted 出来的 0.1.5-rc.1** —— 「当前 DSH 版本」只能从 `profileContext.installAnchor`（= 拉起本宿主的那份 `package.json`）取（`resolveDshVersion`），按磁盘猜一定报错版本号（「关于」页 + 导出 manifest 同源）；
  ⓓ `desktop` 的 bundles 里**确实有** `@deepseek-ai/dsh-web-app`（`classifyShape` 判定为 web），所以**只看形态会误放行「启动」**（spawn 出去只会拿到上面那条英文拒绝）；删除/改名会让桌面端下次启动按 web 模板重建一个空档案（插件全丢）→ 启动/删除/改名三者一律以 `managedProfile` 拒绝（连 `allowCurrent` 也不行），UI 文案不再给 `dsh --profile desktop` 那条本就是被拒的命令；
  ⓔ **只装了桌面端（PATH 上没有 `dsh`）的机器**，启动器此前恒 `launcherUnavailable` → 现在回退到载体；**PATH 上的 `dsh` 仍然优先**（各档案的 `node_modules` 就是那份装的，同一份启动最不容易踩版本混用）；
  ⓕ 插件安装失败提示里的 profile 必须与**实际安装目标**同源（`ctx.target.profile ?? resolveProcessProfileName()`）—— 桌面端外壳不传 `--profile`，只调 `resolveProcessProfileName()` 会写出「装的是 desktop、提示却让用户跑 `--profile web`」的自相矛盾。
- **复制档案（`POST /profiles/copy`）的三条硬约束**（2026-09 实测落地）：① **必须跑链接重指向** —— async
  `fs.promises.cp` 与 `cpSync` 行为不同：cpSync 会把 junction 展开成真实目录，而 `promises.cp` 只把链接照抄，
  留下的是**指向源档案**的绝对路径（实测真机 cmtest：48 个 junction 里 37 个在源档案树内），源档案一删副本就缺包；
  所以拷完走 `relinkCopiedTree`：**只重指向树内链接**（unlink + 重建 junction，Windows 上 junction 不需要管理员权限），
  指向树外的（`link:` 依赖指向用户仓库、DSH 从安装目录投影出的 fallback）一律原样保留。判链接用
  `readdir(withFileTypes).isSymbolicLink()`（Windows 对 junction 也返回 true）→ 无需逐条 lstat。
  ② **整档案拷贝必须走 async fs**：285 MB / 1.7 万条目实测 cpSync 25 s、`promises.cp` + 重指向 ≈ 30 s，但前者把宿主
  事件循环卡住整整 25 s（DSH 界面全冻）；③ `includeNodeModules=false` 时**同时跳过 `node_modules` 与 DSH 投影出来的
  `.dsh-module-fallback`**（后者是派生目录，单独搬运只会留下一堆悬空链接，DSH 启动时会重建），并让缺依赖回到
  回执里（`warnings: ['depsNotInstalled']` + `dsh plugin --profile <副本> install`），绝不静默成功；中途失败回滚目标目录。
  真机复核脚本：`outputs/profile-copy-verify/verify.mjs`（拷 cmtest → 数链接重指向 → 删探针副本）。
- **复制档案的中断残留：标记先行 + 「只认自己的标记」**（cross-F3，t39；真路由 8/8 PASS 见
  `outputs/bug-audit/cross-v3v8/VERIFY-t39-route.{mjs,log}`）。复制是「mkdir 目标 → 逐条 cp → 重写
  package.json」的多步长事务，被强杀/断电会留下「有文件、无 package.json」的半截目录；既有口径
  「有 package.json 才算 profile」会**跳过**它 —— 用户既看不见（不在列表），也删不掉（`requireProfile` → notFound）。
  ① **标记先落盘**：`mkdir(dest)` 之后、拷第一个条目之前写 `.dcm-copy-in-progress.json`
     （`PROFILE_COPY_MARKER_FILENAME`，`dsh-profile-shared.ts:192`；字段
     `sourceName/newName/startedAt/includeNodeModules/pid`，`dsh-profile-manager.ts:215-222`，原子写 `mode 0o644`）。
  ② **三种结局**：成功 → 删标记（`manager.ts:246-251`；删失败也无害，列表以 package.json 为准）；
     抛错 → 整个目标目录回滚（`manager.ts:238-244`），磁盘上不留半截；**只有进程被强杀**才会把标记留在盘上
     —— 这正是要辨识的情形。
  ③ **可见 + 可删**：`list()` 对「无 package.json 但有标记」的目录产出 `incomplete: true` 条目
     （`shape='generic'` ⇒ `isLaunchableShape` 恒假、**绝不给启动按钮**；`dir` 是目标绝对路径；
     `copiedFrom`/`copyStartedAt` 仅在标记可解析且字段非空时出现），同一条判定也用于 `detail()` 与恢复面板的
     `listIncompleteCopies()`（`manager.ts:406-469`）⇒ **不会「列表说没有、面板说有」**。
     删除走既有 `POST /profiles/delete` → `remove()` → `requireManagedDir()`：**有 package.json 或有标记**都接受
     （`manager.ts:344-367`），`managedProfile`（desktop）仍一律拒绝；删除进 mutation gate —— SAFE MODE 下 423
     且**目录保持原位**（真路由实测：base 列 `[]` + 删除 404 `notFound` → 修复后列出条目 + 删除 200 且目录消失）。
  ④ **读标记只判存在性**（`manager.ts:378-395`）：内容坏掉（手工改过/写盘中断）仍算半截副本 —— 宁可多报一个可疑残留，
     也绝不把孤儿目录重新变成「查不到也删不掉」；`pid` 只作诊断（列表/面板都不消费它，也不据此判「是否还在写」——
     pid 会复用）。
  ⑤ **边界不放宽（最重要）**：既无 `package.json` 又无标记的目录仍**跳过**、`detail`/`remove` 仍报 `notFound`；
     判据只有**我们自己的标记**，绝不引入「看着像残留就删」的启发式（否则会删掉用户手工建、还没装好的目录）。
  ⑥ **残余限制（如实登记）**：修复（t39）之前就存在的**无标记**孤儿目录与「用户手工建的目录」在磁盘上**不可区分**，
     没有安全的自动判据 → 唯一处置是用户手工删（t39 倾向不做显式清理通道）。
- **pnpm 发布年龄**：`@latest` 装旧版是 pnpm 11 `minimumReleaseAge`（<30天被排除）；解决：精确版本装一次白名单，或 `pnpm-workspace.yaml` 设 `minimumReleaseAge: 0`。
- **MemFs 测试**：内存 fs key 与宿主 path 解耦（win32 home 注入 cwd）。
- **通配删除源文件之前，必须先确认目标里没有「未跟踪但在用」的文件**（2026-10-03 实测事故：
  `Remove-Item src/client/snapshots/*.tsx` 一次删掉了三个仍在使用的组件，其中
  `DiskUsageCard.tsx` / `BackupScheduleCard.tsx` 在 git 里**从未被跟踪**（一直是 `??`）
  —— 它们在更早的会话里创建后就没提交过，所以**没有可 `git show` 的版本**，只能从
  `lib/client.js` 的**编译产物**逐段翻译还原（JSX→jsx()、CSS Modules→对象、类型全丢）。
  铁律：① 删任何源文件前先跑 `git status --porcelain <路径>`，**看到 `??` 就必须停下**，
  逐个确认它是不是活代码；② 存活时间长的组件应尽早提交，别让「工作区里有、git 里没有」
  变成常态；③ 真要整目录清理，先 `git add -A <目录>` 把它纳管，再删——至少留得住。
  **为什么编译产物救得回来**：`lib/client.js` 是自包含单文件，每个组件连同文件头注释都在里面，
  按 `function <Name>(` 定位、前后取 `/**` 与 `//#endregion` 就能切出完整实现；
  还原后必须逐项核对**文案键与 CSS 类**（脚本比对 `t("...")" 与 `css.xxx`）才算数。
  **绝对不要**用「看起来对」的重写冒充原文件——还原版要在文件头注明是还原的。
- **绝不要用 `git checkout -- <文件>` 回滚这个仓库的工作区文件**（2026-10-03 实测事故，比通配删除更隐蔽）：
  为了撤销一次过度剪枝，我对四本字典跑了 `git checkout --`，它们的**工作区版本比 HEAD 新得多**
  —— 本仓库长期有大量**未提交**改动，回滚一个文件 = 抹掉此前所有会话的在途工作。
  `npm run typecheck` 从 0 个错误变成 **170 个**，其中 130 个是「字典键凭空消失」。
  铁律：① 回滚任何文件前，先 `git diff --stat HEAD -- <文件>` 看清**差异是不是自己造成的**；
  ② 要撤销自己的改动，用**针对性的 edit 反向操作**，不要用 git 的整文件回滚；
  ③ 真要整文件回滚，先把当前版本 `cp` 到 `.tmp/` 备份。
  **怎么救回来（可复用）**：`lib/client.js` 是**回滚前构建产物的快照**，字典整本内联在其中
  （`"key": "值"`）。写脚本按「tsc 报错点名的键 → 正则回捞 zh/en 值 → 注入字典」逐轮迭代，
  直到 tsc 不再报新键为止——130 个键两轮补完，且**值逐字与回滚前一致**（抽样比对通过）。
  三个必须注意的坑：① 编译产物里的转义是 `\\"` 形态，注入时要还原；② 值里含单引号
  （如 "DSH's plugin page"）必须转义，否则整行语法崩；③ `PaletteTitleKey` /
  `CompatibilityNoteKey` 这类**联合类型**的键不会被 tsc 的报错文本点名（只报类型名），
  必须**去类型定义处逐个抄**——只靠报错文本会永远修不完。
- **Windows LF→CRLF 警告**：无害噪音。
- 根目录勿提交：`lib/dist/node_modules/outputs/my-video/.vibeskills/.agent-teams` 均已 gitignore。
- `dist/` 需先创建再 `npm pack --pack-destination ./dist`（fresh checkout 否则 ENOENT）。
- **client bundle 是 cjs + `window.__ModuleLoader__.load`**（tsdown.config.ts），改 format/入口会破坏加载器；CSS Modules 只认 `.module.css`。
- **`src/client/` 不 import node 模块**（`PathMappingForm` 因 `utils/paths.ts` 依赖 node:path 做了轻量等价实现，刻意为之）。
- **style 属性只允许极小修补**（如 MarketPanel `paddingTop:4`），常规布局用 CSS 类。
- **文件类分区收集一律走 `utils/recursive-walk.ts`**：`readdir` 对目录 junction/符号链接返回 `isSymbolicLink()===true`（`isDirectory()` 为 false），自己写 `if (isDirectory())` 分支会**静默丢掉整块内容**且备份仍报成功（issue #37 实测丢 12 MB）。新文件类 adapter 用 `adapters/link-report.ts` 的 `listFilesDetailed` + `linkWarnings`，别直接调 `ctx.fs.listRecursive`。
- **`pnpmWorkspace` 与 `plugins.patchFiles` 必须同进同出**（issue #35）：只搬 `pnpm-workspace.yaml` 文本会让目标机 pnpm 拒绝**一切** `add`（`Failed to read patch file`）。导入端写入前必须剔除目标机无法满足的 `patchedDependencies` 条目（`adapters/pnpm-workspace.ts`），并让剔除在计划里可见；市场通道对 `patchFiles` 与 `localTarballs` 同级双端拒收。
- **会话日志的字节改写只允许在宿主侧**（issue #45）：DSH 会话日志（`session*.jsonl.zstd`）是**拼接的多帧 zstd 容器**，改写 cwd 必须只换第 1 帧 + 尾部**流式**拷贝 + 发布前自检（长度 / 首帧 cwd / 尾部抽查），且 **Windows 上 rename 覆盖前必须关闭读句柄**（否则 EPERM，实测踩过）。`src/utils/zstd-frame.ts` 是纯字节帧工具；`src/utils/session-log.ts`（首帧 cwd 读取 / 多 generation 改写 / 发布前自检 / 失败回滚）是**宿主适配器与 CLI 的唯一实现**——core 禁止 import（不得把 DSH 存储格式带进引擎）。改写后尽力刷新注册表索引（`reindexSessionHeader`，d.ts 标 private、已能力探测；不要用会清空 sessionPaths 的 replaceHeaderIndex），刷新不了就如实汇报、绝不谎报。**头等硬约束（实测）**：DSH 启动时校验「日志位置 == `projectKey(header.cwd)/id`」，位置与 header 不一致会让 `dsh web` 直接报 `corrupt session log ... header id ... and cwd identify ...`（同一 id 出现在两个 projectKey 目录则报 `duplicate JSONL session id ... in multiple project directories`）——所以**改写 header 必须连目录一起归位**，搬不动就回滚改写，绝不留半套。**应用内修复（T8，2026-10）**：`utils/session-repair-service.ts` + `POST /recovery/sessions/{repair,rollback}`（recovery prefix 内子路径，**不新增注册路由条目**）只做**能从字节证明的修复**（重放重复行 / 可证明的合成收尾块 = 零损失；seq 空洞 / 不可解析行的截断 = **有损，需显式 allowLossy**）：三道写入门（unitId 只能解析到会话根内 / 无 `session.lock` / 文件不在 30s 静止期内）+ 预览-应用指纹一致（TOCTOU）+ SAFE MODE 与 mutation lock + 写前自校验 / 时间戳备份 / 原子换入 / 写后复验；**回滚只认台账 `repairId`**（`<dataDir>/session-repairs.json`，客户端不传路径）。其余损坏类别仍只给离线命令。**一键修复全部（T11）**必须逐条独立（一条被拒不牵连其余）、**有损不批量**（lossy 计划跳过并计入被拒）、结果如实计数；列表默认只显示「需要处理」的行，被隐藏的正常会话数必须在界面上说明（绝不静默少显示）。不要因为「有了按钮」就放宽这几道门。
- **本插件是 bundle 包，隔离实例里挂载必须进 `dsh.profile.bundles`**（E2E 实测）：包的 `package.json` 有 `dsh.bundle.patch`，DSH 只会把它作为 bundle 组合进 profile 树；只往 profile 的 `cordis.patch.yml` 写 `{id, name}` 激活行是**非 bundle 包**的做法，插件不会挂载（表现为宿主路由 404、启动日志无报错）。隔离 E2E 配方：`$env:DSH_HOME=<临时 home>` → `dsh --profile cmtest --from-default-profile web --dump-config` → `profiles/cmtest/node_modules/dsh-config-manager` 用 **Junction** 指向本仓库（免 pnpm 联网）→ 把 `dsh-config-manager` 加进 `dsh.profile.bundles` → `dsh --profile cmtest --port 3099 --no-open`。**抓 cookie 只对 DSH 自身路由有意义**（`/` 与 DSH 的 `/api` 承载路由；插件 exact 路由无 cookie 同样可达，见「安全不变量 / 架构心智」的认证边界条）：先 `curl.exe -c jar "http://127.0.0.1:3099/?token=<token>"`（token 取自启动输出），再 `-b jar` 调那些路由；POST 体用 `--data-binary @<file>`（PowerShell 传 `-d '{"x":1}'` 会丢引号 → 路由报 `invalid JSON body`）。脚本留存于 `outputs/e2e-45/`。
- **文件集合分区永不参与导入期前缀映射**（issue #45）：`ConfigAdapter.fileCollection`（`FileCollectionAdapter` 置 true）标记的分区（sessions / pluginFiles / skills …）里，`relativePath` 是**身份**不是配置 —— 前缀映射一旦命中它的首段（`--projectKey--`），文件就会落到 `projectKeyOf(首帧 cwd)` 之外，目标机**下次启动直接失败**；`analyzer.applyMappingsToSections` 已按该标记整段跳过（`src/core/analyzer-mapping.test.ts` 钉住）。会话侧走**专用通道**：`SessionsAdapter.finalizeApply` 在整个分区写完后逐会话把 `ctx.pathMappings` 应用到**首帧 cwd**（`rewriteLogDir` 只换第 1 帧）再归位到 `projectKeyOf(映射后 cwd)`，搬不动就回滚首帧；没命中映射只做原有位置护栏。**导出会话时自动连带其所属工作区**（`exporter.coupleSessionWorkspaces`），因为会话要在目标机显示就必须有工作区指向它的 cwd；**这条不变量必须硬保证**（真机事故：用户只勾「历史会话」时导出过一个 `sections.sessions=true / workspaces=false` 的包，目标机上会话看不见 = 「对话丢了」）：① 归属匹配不上时**整分区带上全部工作区记录**，② 本机一条记录都没有 / 注册表读不到时如实告警，③ 连带白名单与分区选定**共用同一份 includeItems**（否则用户「全部取消勾选工作区」下发的 `includeItems.workspaces = []` 会在第二道过滤里把刚强制选中的分区再挡掉），④ 四种结果各有一条报告文案（`export.sessionsWorkspacesCoupled` / `export.sessionsWorkspacesCarriedAll` / `export.sessionsWithoutWorkspaces` / `export.sessionsWorkspacesUnreadable`）绝不静默，⑤ 导入侧对「有会话但没有任何工作区数据」的包（旧构建导出的历史包就是这种）在**分析阶段**告警 `import.sessionsWithoutWorkspaces`（`analyzer.analyzeBundle` 共享给分析与执行两条路径）；宿主半在 DSH 启动时加载、**没有热重载**——改了导出/导入逻辑后必须重启 DSH 才生效；工作区记录里的 `sessionIds` 由 `WorkspacesAdapter.finalizeImport` 在**全部分区收尾之后**（APPLY_ORDER 里 workspaces 在 sessions 之前）逐个 `attachSession` 登记，未登记成功记 warning。DSH 起不来时的唯一通道仍是离线 CLI（`dsh-config-manager sessions repair`）；隔离实例里复位 `storages/workspace.json` **必须先停宿主再改文件**（插件运行时 DSH registry 的内存是权威域）。**选择器层的联动**：勾了会话自动勾上拥有它的工作区、取消工作区自动取消它的会话（`src/ui/selection-model.ts` 的 `applySessionWorkspaceCoupling`；导出页与导入向导共用 `ContentPicker`，所以只写一份）。**方向必须显式传入**（`focus: 'sessions' | 'workspaces' | 'both'`）：这两条规则在「会话勾着、它的工作区被取消」时会互相抵消，按本次动作方向定夺才确定。工作区单元与会话单元配对用**两套判据**（`WorkspacesAdapter.listUnits` / `analyzeImport` 带上 `sessionIds` 与 `projectKey`）：
① 注册表 `sessionIds`（经 `sessionIdKey` 去掉 `session-` 前缀后比较 —— 会话目录名有 `session-<uuid>` / 裸 `<uuid>` 两种形态并存）；
② **cwd 目录键相同**（工作区 `path` 的 `projectKeyOf(path)`，客户端在旧宿主未回传该字段时用单元 `detail`=绝对路径现算）。
**为什么必须有 ②**（真机实测）：DSH 的 `sessionIds` 覆盖率极低 —— 一次可选择的 **570 条会话里只有 23 条**在里面，只认 sessionIds 时「点一个对话不带工作区」是常态；
而界面又按 cwd 目录键把会话显示在该工作区下（`session-meta` 分组同口径），联动必须与看到的一致。**绝不按会话路径做前缀匹配**（跨机路径不可靠）。
导出页的清单是逐分区惰性拉的：勾了会话就必须把 `workspaces` 清单一起读（`couplingInventorySections`），清单到货后再补一次联动（`ExportView` 的 effect，方向固定 `sessions`，用 `sameSelection` 防自激）。**跨机基础路径自动重定基**：导出时把本机 `$DSH_HOME` 写进 `manifest.sourceHome`；导入时若与本机 home 不同，`analyzer.rebaseMapping` 生成一条 `{oldPrefix: 源home, newPrefix: 本机home, appliesTo: []}` 并**插到用户映射之前**（`createImportPlan` 与 `executeImportPlan` 都走 `plan.pathMappings`，所以结构化分区路径 + 会话首帧 cwd + 目录归位一起生效），计划里通过 `ImportPlan.automaticMappings` 可见。只对**绝对路径**、且落在**段边界**的前缀生效（相对路径 / 两边相同 / 旧包缺字段一律不猜，行为与改造前一致）；用户映射排在其后可覆盖。
- **导出/导入的会话可见性必须由「包内实际带走的会话」驱动**（issue #45 ③，真机事故）：DSH 工作区注册表的 `sessionIds` 覆盖率极低（真机实测 570 条会话里只有 23 条），所以**绝不能只搬注册表原样的 `sessionIds`** —— 导出侧 `declareBundledSessionsInWorkspaces`（`src/core/session-select.ts`，由 `Exporter.export` 在收集完分区后调用）按「cwd 目录键相同」把本次真正带走的会话声明进所属工作区记录（按 `sessionIdKey` 裸键去重、只增不减、写**日志侧原名**），报告出 `export.sessionsDeclaredInWorkspaces`；导入侧 `WorkspacesAdapter.finalizeImport` 的登记目标 = 记录声明的 ∪ 包内带数据的，失败**必须按「这次有没有带它的数据」分类**（带数据的失败 = warning + 真实原因；包外会话 = 不计失败的信息行 `adapter.workspaceSessionsOutsideBundle`），且每个 id 先试声明形态、再试另一种命名形态 —— DSH 只认会话日志首帧 header 的 `id`，它 `session-<uuid>` / 裸 `<uuid>` 两种并存（实测目录名与 header id 逐字相同），只试一种会以 `session persistence holds no such session` 被拒，用户看到的就是「导入后对话不显示」。复核：`outputs/e2e-45b/run.ps1`（隔离实例真导入，直接看 `storages/workspace.json` 的 `sessionIds`）。
- **子代理会话（origin='subagent'）不是工作区里的对话：导出时必须连带父对话**（真机事故：导入全部「成功」，工作区里一条都看不见）：DSH 客户端 `dsh-client-ui-workspace` 的 `sessionVisible()` 是 `session.origin !== "subagent" && ...` —— 工作区列表**只显示**顶层会话，子代理会话只作为**父对话的下一级**出现；只把子会话导出/同步过去，目标机导入侧一切成功（文件落盘、`workspace.json` 也登记了），用户在 DSH 工作区里却一条都看不到（真机：用户勾了 4 条子代理会话导出再导入，全无踪影 —— 它们的父对话都不在包里）。修复（**双向**）：`SessionsAdapter.export()` 收尾调用 `coupleSessionParents`（`src/adapters/sessions.ts`）——① **向上**：选中子代理会话就补父对话（父对话本身也可能是子代理会话 → 继续往上追），报告 `export.sessionParentsCoupled`；② **向下（2026-09 改为界面联动，引擎不再自己做）**：勾父时由**界面**自动勾上它的子代理会话（`src/ui/selection-model.ts` 的 `applySessionParentCoupling`，ContentPicker 的 `commit` 在每次单元点击后调用）——为什么要挪走：条目级白名单是用户意图的唯一事实，而引擎看不到「界面为什么没勾这条子会话」，自己向下补会把「用户单独取消的子会话」无声加回包里（真机：只勾 2 条 → 导出 41 个目录）；子会话清单由宿主 `SessionStoreFacade.parentRelations()`（`src/index.ts` 用 DSH `sessionPersistence.list()` 的 header `parentSession`+`origin` 实现，**不读日志字节**）提供，只收 `origin='subagent'` 的子会话（非 subagent 的会话即使带 parentSession 也是顶层行），经 `/export-preview` 的 `ExportUnit.parentSessionId`（裸键）下发给浏览器；**注意 `export.sessionChildrenCoupled` 已不再产生**（字典键保留备用）；追不到（本机没有 / 超出分区上限）报 `export.sessionParentsUncoupled`，绝不静默；**BFS 的「已排队」与「已展开」必须分成两个集合**（某个会话可能既是被选中的父对话、又是别人的子会话；混用一个集合会把它当「已见过」而不再展开 → 它的子代理会话静默丢失，真机实测踩过）；导入侧 `finalizeApply` 对「父对话不在包内」的子代理会话报 `import.subagentSessionsWithoutParents`（旧包兜底，把「导入成功却看不见」变成可读告警）。**父对话 id 在磁盘 header 里叫 `parentSession`，DSH 的 RPC 投影才改名 `parentSessionId`**（只认后者一个都认不出来，静默失效 —— 已由 `src/utils/session-log.test.ts` 钉住两种写法）。复核：`outputs/subagent-fix/export-check.ps1`（只勾 4 条子会话 → 包内 8 个会话文件 + 「已连带导出 4 个父对话」）与 `import-check.ps1`（干净目标导入 → DSH `session/list` 8 条，其中 4 条顶层会话 `cwd == workspace.path` 且在 `sessionIds` 里 = 工作区可见，4 条子会话按其父之下显示）。**②.1 父子联动的方向语义（白名单即权威）**（真机第二轮：用户只勾 2 条子代理会话，导出却打了 41 个会话目录 = 2 个父对话 + 37 条**从未勾选**的兄弟子会话，导入页显示「43 个历史会话」）：界面侧 = 勾父带子（传递）、勾子带父（父链向上）、取消父连带取消子、**取消子只取消这一条**；批量动作（分区/分组/全选、清单到货后补跑）走**正向闭包**（只补齐、绝不取消任何勾选项）。方向必须显式传入（`SessionParentChange`）——这两条规则会互相抵消（取消父后若还跑「已勾选的子 ⇒ 勾上父」，父立刻被勾回来，与工作区联动同一个坑）。引擎侧**只保留向上补父对话**（父缺席 = 导入后完全看不见）、**绝不再向下展开**：白名单即权威。复核测试：`src/ui/selection-model.test.ts` 的 5 条「父对话 ↔ 子代理会话联动」与 `src/adapters/sessions.test.ts` 的「只勾子会话 …不把用户没勾的兄弟会话一起打包」。
- **导出选择器里「历史对话」的排序时间有两个来源**（用户报告「没有按最新到最旧排」）：第一口径 = `storages/session_projcache.json` 的 `lastPromptAt`（缺则 `identity.createdAt`），第二口径 = `SessionsAdapter.unitActivityTimes()` 现算的**会话日志 mtime**（`/export-preview` 注入 `applySessionMeta`）。为什么必须有第二口径：那份缓存只覆盖一部分会话（真机实测同一项目 **731 个目录里 347 个不在缓存内**），缺时间的会话会退化成组尾的 uuid 字典序。**索引键必须用 `sessionIdKey()` 归一化后再查**（缓存键是裸 `<uuid>`，单元 id 末段是目录名，`session-<uuid>` / 裸 `<uuid>` 两种形态并存 —— 不归一化会同时丢掉标题与时间）。
- **journal step 的 `skipped` 只能表示「用户主动跳过」**：`warning`（非致命失败，§34.17）与 `failed` 都必须记 `attention`，否则事后审计会把「安装失败」读成「用户跳过了」（issue #35 实测）。

- **备份有两种物理形态，而「形态判定」必须只有一份实现（issue #55，2026-10）**：勾了加密的导出产物是
  **DCA1 整包容器**（整份 ZIP 被 AES-256-GCM 包住），文件名却仍是 `.zip`、还躺在备份文件列表里。三条硬约束：
  ① **判定单一事实源 = `src/security/container-kind.ts`**（`containerKindOfBytes` / `readContainerKind`）——
  凡是「拿到一个备份路径或字节」的入口（上传 / 备份列表 / analyze / plan / execute）都要走它，各写一份必然分叉；
  ② **文件形态只读前 4 字节**（open+read(4)+close）——上传接口此前为看这 4 个字节把整份备份 `readFile` 进内存，
  `container-kind.test.ts` 有「只允许读 4 字节」的实测断言；**读不到一律回落 `'zip'`**（判不出形态 ≠ 判定为加密，
  交给 ZIP 解析器给精确错误，绝不猜）；
  ③ **未解锁的容器必须得到可判别的错误**：`/analyze`、`/plan`、`/execute` 一律
  `400 { code: 'encrypted-container' }`（`ENCRYPTED_CONTAINER_CODE`）+ `import.encryptedContainerNeedsUnlock`
  文案；客户端据码**自动进入解锁阶段**（旧宿主 / 脚本直调也兜得住）。历史事故：备份列表的「一键导入」把宿主
  路径直送分析 → 用户看到「不是合法的 ZIP 文件（缺少中央目录结束记录）」，以为备份坏了，其实只差解锁一步
  （浏览器选文件那条入口一直有探测）。**形态字段在列表里是可选探测**（`listBackupFiles(dir, { withContainerKind: true })`
  → `BackupFileMeta.containerType`），保留策略 / 磁盘体检保持零额外 I/O。
  **客户端半铁律**：`src/client/**` 只能 import **零依赖**的 `utils/shared-constants.ts` 拿
  `ENCRYPTED_CONTAINER_CODE` —— 若 import `security/container-kind.ts`，会把 security 桶 → `encryption.ts`
  （`node:crypto`/`node:util`）打进 `lib/client.js`，DSH 的 client loader 报 missed the module table，
  **整个插件不加载**（本轮实测踩到，已由 `bundle-selfcontained` 护栏复核）。

- **SAFE MODE 的可见性与出口（issue #56，2026-10；与 issue #31 的残留锁同一类缺陷复发）**：durable标记
  `<dataDir>/transactions/safe-mode` 一旦落盘就跨重启生效，而**解除它的判据必须只有一份实现**
  （`recovery-orchestrator` 的 `resolveSafeMode`：active 全部为已解决终态才清，NEEDS_ATTENTION 视为未解决，
  扫描失败 fail-closed）。四条不得回退：
  ① **dismiss 之后必须调用它** —— 「放弃恢复」= 该 incident 结案；此前 dismiss 只 quarantine，唯一的清除点挂在
  `verify(ROLLED_BACK)` 上，而事务已移出 `active/` ⇒ 那条分支永远走不到，用户看到的是「面板显示暂无待处理、
  写操作持续 423、重启无效」，只能手工删标记；
  ② **阻断态必须可见**：`GET /recovery/status` 回传 `safeMode: { blocked, clearable }`（`clearable` = 没有未解决
  incident，即「结案但保护仍开着」），投影为 `safeModeStuck`/ `recoveryRequired`，面板据此渲染**显式解除入口**
  —— 这正是 issue #31 「423 文案指向空面板」在 SAFE MODE 上的重演；
  ③ **显式出口** `POST /recovery/safe-mode/clear`（recovery prefix 子路径，不新增注册路由条目）**故意不过
  withMutationGate**（要解开的正是挡住写操作的保护，走 gate 必然 423），但**绝不无条件清标记**：还有未解决
  incident 时拒绝并给 `reason: 'unresolved-incidents'`，本来没阻断则幂等回 `not-blocked`；
  ④ **注入面是动态探测**（`RecoveryOrchestratorDeps.safeModeBlocked` ← 宿主 `phase3Recovery.safeModeActive`）：
  与 mutation gate 的 `isBlocked` 同源，保证「界面说保护开着 ⟺ 写操作真的被 423 挡着」，绝不能创建期捕获快照。

- **灾备快照线已按产品定位收敛下线（2026-09），只保留崩溃归因 + 救援模式**：定位 = 迁移 / 同步 / 市场 ——
  自动快照（watcher）、撤销/重做、手动快照、快照库与 `/lifecycle` 路由整体删除（`core/{watcher,undo,config-state,config-snapshot,config-lifecycle}.ts`、
  `client/lifecycle/`、`ui/lifecycle-view.ts`、`LIFECYCLE_ENABLED` / `SHOW_LIFECYCLE_NAV` 双开关）。**保留**：`core/crash-report.ts`
  （崩溃检测 / 归因 / boot-state）与 `core/boot-rescue.ts`（救援模式），两者并入「事故恢复」子 tab（`client/recovery/RecoveryPanel.tsx`）——
  崩溃后的处置只剩「先让 DSH 起得来」（救援模式）与「从最近备份恢复」（备份文件），**不再自建第二条恢复通道**（`/crash` 已无 `lastGoodSnapshotId`）。
  三条不许回退的接线：① `boot-state.json` 独立在 `<dataDir>/boot-state/`，老位置 `<dataDir>/config-snapshots/` 由 `adoptLegacyBootState` 一次性搬迁（幂等、best-effort）；
  ② `BOOT_CRITICAL_RELS` / `profileCriticalRels` 搬进 `core/boot-paths.ts` —— **导入安全闸门 `boot-safety.ts` 仍在用，删灾备不许连带删**；
  ③ `PanelId` 不再含 `'lifecycle'`，旧持久化值在 `run-store` 迁移到 `snapshots` + `subTab='recovery'`。守卫：`src/core/incident-wiring.test.ts`（源码级接线）
  + `tests/route/route-parity.test.ts`（71 条路由快照）+ `src/core/crash-report.test.ts`（归因与老位置搬迁）。
  分区注册表的 `configSnapshot` 字段保留为**语义声明**（配置类 vs 内容数据类），当前无消费者；旧实现与踩坑史见 `docs/handoff/PHASE1_HANDOFF.m
d`。

- **救援模式与 `reconcileBundles` 的硬冲突（2026-09 真机复现「救援完全没用」的根因，两条修法不许拆开）**：
  进入救援会把 `dsh.profile.bundles` 收窄为「DSH 核心 + 本插件」，但插件自己的 `reconcileBundles`
  （`src/core/plugin-cli.ts`，规则 = 「声明 `dsh.bundle.patch` 的依赖必须出现在 `bundles`」，由
  `listInstalledPlugins` 在**每次读插件清单**时调用：导出预览 / 自动快照的 `plugins` 分区 / 插件页都会触发）
  会在**约 1.5 秒**内用 `dependencies` 里的依赖行把用户插件全部加回 —— 用户重启 DSH 后插件一个不少，
  救援名存实亡（实测轨迹：`t+0ms` 收窄到 3 条 → `t+1500ms` 变回 5 条）。因此：① `enterRescueMode`
  （`disableUserBundles`）**必须同时把被禁用的包从 profile 的 `dependencies` 摘掉**（`stripDependencies`；
  包不卸载，退出时整份 `package.json` 从备份逐字节还原）——manifest 自洽后**任何** reconcile（含 DSH 官方
  `dsh plugin`）都无从加回；② `reconcileBundles` 在救援激活期间**一律停手**（`isRescueActiveSync`，
  同步探测，与 `rescueModeStatus().active` 同口径、stale 不算激活），因为救援是操作者的显式决定。
  **验证口径**：只在文件层断言「bundles 被收窄」不够 —— 必须真机四阶段（救援前挂载 → 进救援且清单持续
  数秒不被改写 → 重启后用户插件不挂载 → 退出后逐字节还原 → 重启后插件回来）。夹具有一个坑：假插件若
  同时进 `dependencies` 又由 home patch 插入，会被 reconcile 加进 bundles 并与 patch 行重复挂载
  （`duplicate loader entry id`）—— 走 patch 层的插件**不要**写进 `dependencies`。
  复核脚本：`outputs/rescue-e2e/`（隔离 `DSH_HOME` + 两个假插件，浏览器实操）。

- **会话日志的格式版本（`header.version` = DSH 的 `SESSION_FORMAT_VERSION`）跨版本是「单向兼容 + 静默跳过」，必须体检而不是等用户发现**（2026-09 源码 + 真机取证，登记为 known-gaps **G-23**）：DSH 读会话时对**非本 build 的版本直接拒绝**（`refuseForeignFormatVersion` → `SessionFormatUnsupportedError`），而会话列表 `listArtifacts()` 对该错误 **`continue`** —— 不报错、不在工作区列表里，用户看到的只是「对话消失」。高版本可读低版本（DSH 自带 V0→V4 迁移链），**反向不可读**；实测桌面端内置 0.2.0-rc.2 = **v4**，磁盘 CLI 档案 0.1.5-rc.1 = **v3**（本机 401 个日志分布 `{v0:200, v3:201}`，多版本共存是常态）。本插件的导出/导入/同步是**逐字节搬运** `.jsonl.zstd`，不体检就会「导入全部成功、对话一个不显示」。接线：宿主探针 `src/utils/session-format.ts`（只解**首帧**、每会话一条、上限 200、读不出如实计数；常量解析优先从 `installAnchor` 同树的 `@deepseek-ai/dsh-session` 读，**绝不拿 semver 猜格式版本**）→ `HostContext.sessionFormatVersion` + `AnalyzerOptions.sessionFormatProbe`（`ImporterOptions` 同名）→ `Analyzer.sessionFormatWarnings` 产出 `import.sessionsFormatUnsupported` / `import.sessionsFormatSampled`；同步 `pull()` 把 `analysis.warnings` 并进差异报告 message（那条链路只有 message 通道）。档案页用 `profileVersionFacts` / `sessionFormatRisk`（`src/ui/dsh-profiles-view.ts`）展示每个档案的 DSH 版本与会话格式版本并提示错配；**任一侧读不到版本一律不提示**（不猜、不给假结论）。**core 侧仍禁止 import 会话日志存储格式**（只消费数字）。

- **离线救急台（`dsh-config-manager web` / `dcm web`，阶段 1，2026-10）**：只读的**本机网页**，
  给「DSH 已经起不来」的场景用。四条不得回退：
  ① **服务端复用 `src/routes/kit.ts`**（`endpoint()` 声明 + `registerRoutes` 注册）—— 围栏/方法白名单/统一错误映射
     与插件那 70 余条宿主路由**同一份实现**，不另写围栏；页面**服务端直出 HTML**（零脚本、零外链，
     `writeHtml` 里收口的 CSP `default-src 'none'`），因此它没有 client bundle 自包含问题、也不进 `lib/client.js`。
  ② **token 是这一层的边界，不是可选项**：kit 的 `isLoopbackRequest` 对「无 Origin 头的请求」直接放行
     （本机任何进程都满足），所以必须 启动时生成 32 字节随机 token → 只打印到当前终端 → `/?token=…` 换
     HttpOnly + SameSite=Strict 的会话 cookie（**用过即废**）；其余请求一律 403。
  ③ **读路径只读、写路径有门**（旧口径「本阶段只暴露 GET，写动作留到后续阶段」已过期）：打开任何页面**不产生任何写入**
     （`web.test.ts` 的 W-04 断言连目录都不建），但实现已有 **11 条 POST 写路由**：`/sessions/repair`、`/sessions/inline-repair`、
     `/disk/cleanup`、`/lock/recover`、`/profiles/launch`、`/profiles/stop`、`/unlock/run`、`/restore/run`、`/export/run`、
     `/reinstall/plan`、`/reinstall/run`（`src/cli/web/routes.ts:253-479`，唯一声明处）。`GET /healthz` 自报 `readOnly: false` +
     `writes`（3 项能力名，既有契约刻意不动）+ `writeRoutes`（由已声明路由派生，cli-F6 修，杜绝手写清单漂移）。
     **写路径的真实边界**：① 回环围栏（非回环 403，`server.ts:141`）；② 一次性 token → HttpOnly + SameSite=Strict 会话
     cookie，之后**每个请求（含写）**都要 cookie，缺 token/cookie 一律 403（`server.ts:146-174`）；③ 方法白名单 405（HTML，
     cli-F4）。**写动作各自过 CLI 同源的写入门**（`src/cli/actions.ts` 的 `checkWriteGates`：SAFE MODE → 残留锁 → DSH 未运行，
     fail-closed）；`/reinstall/*` 另持环境锁 `runWithMutationLock({ op: 'console-reinstall' })`（`actions.ts:1365-1396`）。
     两个**刻意例外**（都被测试钉住）：磁盘清理只碰可重建缓存（tmp / 过期导出产物 / market cache+work），故**不过**
     SAFE MODE 门（`web.test.ts` W2-03「清理缓存不受该门影响」）；档案启动/停止是「DSH 起不来」时的出口，**不过** SAFE MODE
     与「DSH 已停止」两道门（`web.test.ts` W3-04）。**不得据此写成「插件 API 无认证」**：这是救急台自己的 token 边界；
     宿主插件路由的边界仍是 `src/routes/kit.ts` 的 `endpoint()` 围栏（见本文件「插件 HTTP API 的真实认证边界」一节）。
  ④ **判定不许重写**：网页与 CLI 共用 `src/cli/actions.ts`（只读动作层）—— `verify` 的收集、磁盘体检、会话体检、
     心跳/锁/SAFE MODE 读取都只有一份实现；CLI 只负责排版。**改判定就改 actions.ts**，不许在页面里再算一遍。
  附带的两个修正：**心跳候选根**（旧 `runningDshInstances` 把 `--data-dir`（快照目录）当 dataDir 用 → 缺省路径下
  永远找不到心跳，「DSH 在跑就别写会话字节」那道门形同虚设；现在与 SAFE MODE 同一套 `resolveControlRoots` 候选根）；
  **退出必须真的退出**（`close()` 之后进程仍持有 stdin/stdout，事件循环不会排空 → 空闲超时 / Ctrl+C 用
  `close().finally(() => process.exit(0))`，测试注入 `shouldSelfExit: false`）。

- **issue #57–#60 的四条硬约束（2026-10，均为真机复现后修复）**：
  ⓐ **`file:` spec 有两种形态，打包前必须 `stat` 判形态**（`src/core/local-plugin-pack.ts` 的 `statKind`）：目录走 `npm pack`，
  **`.tgz` 文件直接读取收编**（它本身就是 `npm pack` 的产物），**判不出来一律回落目录流程**（绝不猜成文件）。此前一律当目录 `cwd`
  → `file:/abs/x.tgz` 必然 `spawn ENOTDIR`，插件静默不进备份而**备份仍报 `ok:true`**；归档名用 `safeTarballFileNameFor`（保留源文件名，
  丢目录 + 折叠非法字符）。profile 目录用 `HostContext.profileDir`，**不要**按 `<home>/profiles/<name>` 硬拼。
  ⓑ **同步快照的 JSON 体积上限必须读写同口径**（issue #59）：`deserializeSnapshot` 走 `MAX_OWN_PAYLOAD_JSON_BYTES`（512 MiB，**自产载荷**），
  **不是** `parseJsonSafe` 的缺省 64 MiB（那是防不可信输入的闸门）。加密单文件布局经 base64 双膨胀 ~1.78×，勾 sessions 后轻易越界；
  越界的后果是**静默**（列表恒空 / download 报损坏 / 自动同步恒 upToDate，而 push 报成功）—— 现在读不出来的一律经 `unreadableSnapshots` 回传可见。
  改这条链路时必须同时想「写侧产出什么、读侧拿什么上限读」两件事。
  ⓒ **`runStore.patch()` 会清空密码字段**（持久化白名单把 token/webdav 密码写成空串，是**安全不变量**）：任何**无关** patch
  （远端快照到货、GitHub 轮询结束）都会抹掉用户正在输入的密码 → 「输入几个字符就被清空、粘贴也清空」。修法固定为：`commit()` 在 patch 之后
  调 `runStore.patchSyncPasswords()` 把**在途输入**写回**内存**（绝不触发落盘）。新增任何 patch 路径都要检查这一条。
  ⓓ **git 源安装需要 `scripts.prepare`**（npm 上是预构建 `lib/`，git 安装是现构建）：本包已补 `prepare: npm run build`；
  **pnpm 11 仍会拦截**，用户必须在 profile 的 `pnpm-workspace.yaml` 里加 `allowBuilds`，键要**逐字照抄 pnpm 打印的那一行**（含 URL + sha，
  只写包名不生效）。三条门禁在 `tests/packaging-contract.test.ts` 的 `G-21`；README 中英各有「从 GitHub 源码安装」段。

- **`skippedLinks` 的 `too-deep` 不再必然等于「链接」**（cli-F2 让普通目录超深可见 + t37 修正措辞，2026-10）：
  深度上限 `MAX_DEPTH = 64`（`src/utils/recursive-walk.ts:42`）在 `walk()` 顶端判定；cli-F2 之前只在 `viaLink !== null` 时记
  too-deep，**普通目录**超深时整块内容被裁掉却既不在 `skippedLinks` 也不在 `unreadableDirs` 里 —— 备份照样报成功但缺内容
  （issue #37 同类症状）。cli-F2 起改为 `skippedLinks.push({ path: viaLink ?? rel(dir), reason: 'too-deep' })`（同文件 `:78-81`）；
  于是 `too-deep` 既可能来自链接、也可能来自**普通目录**，措辞必须按真实来源分派（t37，`src/core/backup-plan.ts:196-199`）：
  `too-deep` → 「层级超过上限未进备份（目录或链接目标超出深度上限） / nesting limit exceeded…」；
  `loop` / `outside-home` / `broken` / `unreadable`（皆为链接特有原因）→ 保留「链接未进备份 / link NOT in this backup」。
  修前实测（base 3f42a8b + cli-F2 增量 + 仅测试）：用例红，断言打印的 base 措辞是
  `链接未进备份 / link NOT in this backup: skills/skills/d/d/…（too-deep）` —— 「为什么会缺内容」的原因被误述成链接问题。
  回归护栏：`src/core/backup-plan.test.ts:150`（t37：70 层普通目录 + 指向 home 之外的 junction 两条对照，断言超深条目措辞匹配
  「层级超过上限」且**不得**匹配「链接未进备份」，链接条目仍须是链接措辞）、`src/utils/recursive-walk.test.ts` 的 cli-F2 用例
  （普通目录超深必须记 too-deep）。原始输出与证据：`outputs/bug-audit/message-t37/`。
- **文件类分区「存在但读不到」必须显式失败，不得静默跳过**（ui-F2，t23；2026-10）：
  收集内核（`src/adapters/file-collection.ts`）对 `ctx.fs.readFile` 失败是**上抛**的 —— 分区 `export()` 抛错由
  `src/core/exporter.ts:340` 收敛成 `export.sectionFailed` + 一条 warning，属**分区级可见失败**（EACCES 从不静默）。
  `pluginFiles`（`src/adapters/plugin-files.ts`）此前把「读不到」与「不存在」一视同仁地 `continue` → 同一类输入在基类与子类之间
  出现两种语义（同一份 ACL 故障在一处是警告、在另一处是无声缺项）。修法：两个读失败分支改成
  `if (await this.absentOnDisk(ctx, rel)) continue; throw err;`（`:60` / `:82`；`absentOnDisk` 在 `:102`）——
  只有真不存在（ENOENT）才跳过，其余 errno 一律上抛。**判据方向不能反**：`exists()` 自己抛错时按「**存在**」处理
  （读不到 ≠ 没有），否则一次 ACL 故障会把「读不到」降级成「本来就没有」。
  回归护栏：`src/adapters/files.test.ts:517`、`:534`（白名单文件 / 约定配置目录里「存在但读不到」都必须显式失败；base 红 → 修复后绿）。
- **清理时「缺失的可选目录」（ENOENT）不计入 `errors`**（e2e-F3，t14 修订；即 `AGENTS.md`「磁盘占用体检与手动清理的硬边界」的 ⑤）：
  `src/core/cache-cleaner.ts` 四处可选目录（`:212-218` tmp、`:238-239` exports、`:297-300` market/cache、`:320-323` market/work）
  一律 `if (!isENOENT(err)) result.errors += 1` —— **ENOENT（不存在）≠ 读失败**：全新安装时 `market/cache`、`market/work`
  尚未创建，若计入 `errors`，前端就会在**本次真的删掉了文件**的那次清理里弹红色「清理失败 N 项」（真机 p9b：`errors` 恰等于缺失目录数，
  `detail` 为空、无可操作信息）。其它 errno（EACCES / EBUSY / …）仍必须计数。判据单点在 `src/utils/guards.ts` 的 `isENOENT`。
  回归护栏：`src/core/cache-cleaner.test.ts:334-337`（四个可选目录缺失 → `errors === 0`）与 `:344-362`
  （「可选目录不存在时，真删了文件也不得报错」）。

- **值形状判定（`matchSecretValuePattern`）的大小写边界**（t58-F1 / t72；即 `AGENTS.md`「值形状判定的大小写边界」那条，known-gaps **G-36**）：
  `src/security/secret-scanner.ts` 的 `SECRET_VALUE_PATTERNS` 全是**大小写敏感**正则。**收口的是 `Bearer`**：RFC 7235 / 6750 规定 auth-scheme 名
  **大小写不敏感**，所以 `Authorization: bearer <token>` / `BEARER <token>` 都是合法写法，改动前在「键名不敏感」的通道（MCP `headers:{'X-Custom':'bearer …'}`、`env`、url 段）
  **明文进包且完全不可见**（`refs=[]`、`skipped=[]`）。现在由新增的 `bearer-token-anycase` 命中（scheme 用逐位大小写类 `[Bb][Ee][Aa][Rr][Ee][Rr]`，**刻意不给整条正则加 `i`**
  —— 加了会让 token 侧「含大写」「含小写」两个 lookahead 互相等价而失效）。防英文散文过剥的边界：token 需**含非字母字符**、或**大小写混排**、或**长度 ≥ 24**，因此
  `bearer credentials are required` / `bearer authentication failed` / `BEARER HEADER NOT SET` 都**不**命中；规范 `Bearer …` 仍由原条目命中（命中名 `bearer-token`、行为逐字不变）。
  **厂商前缀（`sk-` / `AKIA` / `ghp_` / `github_pat_`）刻意保持大小写敏感**：`SK-…` / `Sk-…` / `akia…` / `GHP_…` / `GITHUB_PAT_…` **不会被剥离**（真实厂商形态大小写固定；
  判定是全仓共用单一来源，加 `i` 会连带放宽日志脱敏 `src/utils/logger.ts`、导出/导入的字段值扫描、界面渲染前的 `redact()` 三条通道）—— 已知残余见 known-gaps G-36；其中「`redaction.ts` 另有独立重复表」一条**已由 t78 订正**：
  `REDACTION_VALUE_PATTERNS` 现派生自 `secret-scanner.ts` 的 `SECRET_VALUE_PATTERNS`（单一来源，仅补 `g` flag），守卫 = `src/security/redaction.test.ts` 的 `t78-a`（结构）/ `t78-b`（行为）。
  **仍存的差异**（如实保留）：显示层比 scanner **更宽** —— 示例/占位形态（`sk-your-key-here` / `Bearer example-token-here`）scanner **放行**、`redact()` **仍掩**；base 与现状同结果，属显示层**既有产品取舍**，由 `t78-f` 钉成 characterization。**要收先单独决策**，别顺手改。
  另两条同批口径：① `env:{K:'<sk-…>'}` 这类**尖括号占位符在值形状通道同样被剥空**（降噪只看命中片段，而 `sk-…` 的命中片段不含尖括号；多剥是安全方向）；
  ② `redactMcpSection` **自身**过滤非字符串载体（`env` 嵌套对象 / headers 数组 / `args` 对象元素按上游 `mcpEntryOf` 同口径**丢弃**，被滤空的字段直接删）—— 此前这条保证只活在上游，
  而 `antigravity.ts:103` 是直连调用点。
  证据：来源 = t58 评审（`outputs/bug-audit/review-foreign-envhdr/REVIEW-t58-t40-report.md` §1 的 payload 原文、`t58-pipeline-check.mjs` 的真实管道复现、BASE↔FIXED 谓词逐字对照）；
  回归护栏 = `src/security/secret-scanner.test.ts`（`t72-a` 大小写命中 / `t72-b` 规范形态不变 / `t72-c` 过剥控制 / `t72-d` 厂商前缀边界钉事实）与 `src/foreign/mcp-value-shape.test.ts` 的 `t72-e/f/g`。


- **v0 打包行不得被当成 seq 空洞 + 帧粒度规则**（与 `AGENTS.md` §📌 常见坑 同序；2026-10-06 M1；known-gaps **G-24**）：
  **成因**：v0 打包行（`type ∈ {text-chunks, reasoning-chunks, tool-call-chunks}`）**没有 `seq` 成员**，一行按 `{type, seq0, time0, data}` 展开成 `payload.length` 个事件（官方 `@deepseek-ai/dsh-session-format-v0-to-v1/lib/index.js` 的 `decodePackedRun`：`assertReleasedV0Keys(row, ['type','seq0','time0','data'], [], label)`、`firstSeq = seq0`、`eventCount = payload.length`；`scanRows` 用 `seq !== eventCount` 判空洞并按 `eventCount += run.eventCount` 推进）。旧判据只读 `seq`（`src/utils/session-row-facts.ts`），打包行 `seq === undefined` → 被 `firstAnomalyIndex` / `planIsContiguous`（`src/utils/session-log-repair.ts`）**跳过却保留 `lastSeq`** → 打包行之后的第一条标量行被判成 seq 空洞。
  **真机量化（2026-10-06 快照）**：units **1195**、日志 **1194**；`planSessionLogRepair(bytes,{allowLossy:false})` = **lossy-required 407 / nothing-to-fix 787**；按 `allowLossy:true` 的计划 = 保留 **11,582** 行、丢弃 **865,098 / 876,680 行 = 98.7%**。407 份**全部是 v0 代际**（`session.jsonl.zstd`，header `version:0`），最新代际分布 {v0: **442** / v3: **522** / v4: **231**}（< v4 占 **80.67%**），v3/v4 零误判。复核脚本：`.tmp/probe-session-repair.mjs`（reason 计数）、`.tmp/probe-session-repair2.mjs`（丢弃量）。
  **判据分两层，不得混同**：(i) **形状不可判定**（缺 `seq0` / 载荷非数组 / 长度非安全整数 / `dt` 长度 ≠ `len-1` / 带严格键集外的多余成员 / 无 `seq0` 的未知非 packed 类型）→ **不透明跨度**：禁止跨越它下连续性/截断结论，计划 **refuse**（不得截断）。`payload.length` **只有在这一层全部通过之后才是可信跨度**（否则 `'abcdef'.length === 6` 这类会造出假的「已覆盖」）。(ii) **形状可判定但 `seq0` 与运行计数不衔接** → **真实 seq 空洞**，与标量行空洞**同待遇**（默认 refuse；显式 `allowLossy` 才在首个异常处截断）。依据：官方 `scanRows` 展开后就是 gap；把它当 opaque 会让同一语义因前一行的物理编码不同而有两种待遇。
  **帧粒度规则**：`≤200 行/帧` 只约束**本次重编码**的帧；**未触及帧（帧内无被丢行且全部保留）必须逐字节复用**，即使它原本超过 200 行。真机实测（`.tmp/m1/frame-census.mjs`，1201 份日志）：事件帧 **455,278** 个，每帧行数分桶 `<=10: 452,166` / `11-50: 2,852` / `51-200: 34` / **`>200: 226`**，**最大 8,654 行/帧**（`ed579b90-…/session.jsonl.zstd` 第 1 帧，1,575,469 B）—— 那是 DSH 自己写出的形态，**字节保真优先于自定上限**。
  **最强动机（同一批数据）**：这 407 份里那份 `session-66add64c-a546-491b-ada8-56fc180ddd43/session.jsonl.zstd`（1160 行）**本身能被真 codec 读出**（`createRestore + decodeRow + finish` = ok，339 events），旧的有损路径却只保留 **23 行、丢掉 1137 行**。

- **会话检测口径：严重级按「代际 + 载体」分级，且前台读盘管线是分层的**（与 `AGENTS.md` §📌 常见坑 同序；t4 + t4b(97c3b5c) + t4c(b12aeae) + t18(3facd19)；known-gaps **G-24**）：
  **分级表**（`src/utils/session-health-scan.ts` 的 `missingMessageIdSeverity` / `emptyToolCallIdSeverity`，逐条由真机 codec 实测校准）：**v4 与 pre-v4** 下 —— `user/message.data.id` 缺失、`assistant/message.message.id` 缺失、`tool/result.message.id` 缺失、`tool/result.message.toolCallId` 与 `message.source.callId` 不一致、空 tool-call id（`tool/call.callId` 或 assistant 内容块 id）、重复通告同一 advertised tool call —— 全部 **`unloadable`**；**版本读不出**（header 无 `version`）时一律降为 **`nextRequestFails` 且 detail 记 `codec-uncalibrated`**（静态回落表无法表达「版本未知」，该降级是刻意的，方向更重=保守）。
  **口径层次（写文档/注释时最容易写错的地方）**：官方前台管线 = ① `@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js` 的 `parseHeaderRecord` → `sessionFormatCatalog.createRestore(parsed, { recovery:'strict', validation:'transformed' })`（先 `refuseForeignFormatVersion`；**既解首帧 header，也被 `readZstdPrefix` 构造的 `SessionLogScanner` 用来逐行 `decodeRow`**）② 同文件 `assertV4RowAdmission`（逐行）/ `assertReleasedV4Relationships`（`SessionLogScanner.finish()`）③ `@deepseek-ai/dsh-session-persistence` 的 `validateStoredEvents` → `adoptSessionEvent` → `assertMessageEventShape`（逐事件）④ 迁移/校验路径上的 `Session.fromRestore` + `assertCurrentAssistantStreams`；历史代际（version ≤ 3）另走 `historicalSessionFormatCatalog.createRestore(header, { recovery:'recoverable', validation:'current' })`。**只有 ① 的 `decodeRow`/`finish` 那一层**会对「user/assistant 缺 id」「空 tool-call id」放行 —— 所以**不要写成「transformed 容忍」**（会低估前台确实会拒），但 `transformed` 单独跑确实是另一套结论（这正是我 R1 补遗-1 与 W3b §3 两次订正的由来）。
  **三条官方错误文本与出处**：`seed user|assistant/message at index N lacks an identified message` = `@deepseek-ai/dsh-session/lib/index.js` 的 `assertMessageEventShape`（`message.id` 必须非空字符串）；`tool call id requires a nonempty string` = `@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js` 内的 `text(value, subject)`（调用点 subject = `tool call id`）；`assistant/message repeats advertised tool call <id>` = 同包的 v4 关系校验器与 v0→v1 / v3→v4 迁移器。独立复现脚本：`.tmp/m1/t14/real.mjs`（真机 v4 `03160f18-…` 875 行 + 真机 v0 `66add64c-…` 1160 行，对照样本都 ok）。
  **不得写成**：「缺 id 一律整份拒载」（v4 的 user/assistant 由 ③ 拒，不在 ① 的 `decodeRow` 路径上）；也不得写成「v4 的 user/assistant 缺 id 只是下次请求会失败」（前台管线确实拒读）。真机命中数：五类新码在 **120 个真机静止单元行档全扫 + 实时抽样 100 单元**上 **0 命中**（只有自造 fixture 有正例）—— 本轮是「新增检测能力」，**不是**「发现了一批坏会话」（原始输出见 `.tmp/m1/V3.md` / `.tmp/m1/W3.md`）。

- **复核门 `unavailable` ≠ 成功验证**（与 `AGENTS.md` §📌 常见坑 同序；t3/t17；known-gaps **G-24**）：**操作完成（`ok`）与可加载验证（`verify`）是两件事**。落地口径：`unavailable`（能力拿不到 / catalog 装的是别的代际 / 该代际没有 children 版 API）时结果与台账必须带 `verify.verified=false`、**绝不标记为已验证**；`unavailable` **仍写台账**（否则已经应用了的修复就无法回滚）但**不写成功台账、不触发自动回滚**；**确定性失败**（codec 明确判 `failed`）才用备份自动回滚。**UI（React 面板）、CLI 与离线救急台两侧**都必须把三态（**现役可读 / 迁移链可还原 / 未验证**）写进**用户可见输出**，不得把「写完了」说成「已可加载」。**动机（真机）**：407 份里有 2 份能被真 codec 还原，但那 2 份的正确表述是「**可被迁移链还原**」；官方 `resolveCurrentLog` 对 `sourceVersion < SESSION_FORMAT_VERSION` 直接返回 `undefined`（注释原文 *only a historical generation exists*）⇒ pre-v4 根本没有「当前日志」。

- **复验门的 catalog 解析不得只按 root 缓存，等价性用 `equivalentToReadPath` 判定**（与 `AGENTS.md` §📌 常见坑 同序；t22 = V2-F1/F2；known-gaps **G-24**）：`createRestore(strict+transformed)` **只在 `header.version === 当前代际`**（本机 v4）时可达；pre-v4 走**迁移链**（并可能触发 `v0→v1` 的拒绝），**不等价于 DSH 读盘路径**（`equivalentToReadPath` 就是这条判定）。两条硬要求：① 缓存**只存与日志无关的候选事实**（例如「哪个 root 下有哪个包」），任何依赖 header 的判定（**代际闸门 / API 闸门 / `equivalentToReadPath`**）都**必须按该日志的 `headerVersion` 重跑**；② 已安装版本优先走 `installAnchor` 同源解析。**踩过的坑**：把 catalog 解析结果按 root 缓存后，同进程内同一输入会给出不同结论 —— 实测出现过等价性翻转、以及 v4 被误判 `decode-failed` 并触发回滚。另：官方 catalog 只在 DSH 安装树（桌面端在 `app.asar` 内），磁盘副本可能是旧代际且没有 children 版 API ⇒ 真 codec 门是**低覆盖护栏**（本机 < v4 占 80.67%，默认解析下 v0 与 v4 多为 `unavailable`）。

---

## t93 容量腾挪：从 `AGENTS.md` 下移的细节（与 `AGENTS.md` §📌 常见坑 **同序**）

> AGENTS.md 与全局 `~/.dsh/AGENTS.md` 合计受 65536 B 预算约束（超限会让全局那份被整份丢弃）。按仓规「AGENTS.md 只留铁律/硬约束，证据与量化数据进本文件」，以下三段的**证据/行号/清单**自 AGENTS.md 下移；技术结论与铁律未变。

### 1) 插件 HTTP API 的真实认证边界（下移自 AGENTS.md 同名条目）

- **DSH 源码位置**：`@deepseek-ai/dsh-client-connection/lib/index.js` 的 `requestRejection()` **L553-556** = Host/Origin 403 + browserAuth 401，只被 `register()` **L605-618** 的 prefix 路由调用；`@deepseek-ai/dsh-host-webserver/lib/index.js` 的 `match()` **L321-331**：先查 exact 表，未命中才按 prefix 最长匹配。安装位置 `.../node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/{dsh-host-webserver,dsh-client-connection}/lib/index.js`。
- **四路实测打点**：无 cookie 的 `GET /api/dsh-config-manager/status` → **200 + 完整 JSON**；DSH 自己的 `GET /api/<未认领路径>` 与 `GET /` 无 cookie → **401**（认证确实存在，只是不覆盖插件 exact 路由）；跨站 `Origin` → **403**，同源对照 → **200**（CSRF 围栏在生效）。
- **复核路径**：线上复核 `powershell -NoProfile -File outputs/e2e-w2/run-e2e.ps1 -Strict`（本机无 pwsh 7，脚本支持 5.1；探针 `outputs/e2e-w2/probe.mjs`）；原始打点与结论见 `outputs/e2e-w2/FINDINGS.md` **§4 / §6 D1**。

### 2) 离线救急台（下移自 AGENTS.md 同名条目）

- **11 条 POST 写路由清单**（`src/cli/web/routes.ts:253-479`）：`/sessions/repair`、`/sessions/inline-repair`、`/disk/cleanup`、`/lock/recover`、`/profiles/launch`、`/profiles/stop`、`/unlock/run`、`/restore/run`、`/export/run`、`/reinstall/plan`、`/reinstall/run`。
- **行号**：真实边界里的会话 cookie 判定在 `server.ts:141/167`；GET 打开页面零写入由 `web.test.ts` 的 **W-04** 钉住（连目录都不建）。
- **两个已修的坑**：① 心跳候选根必须与 SAFE MODE 同一套 `resolveControlRoots`（旧实现把 `--data-dir` 当 dataDir → 缺省路径永远找不到心跳）；② 退出必须真退出（`close().finally(() => process.exit(0))`，测试注入 `shouldSelfExit: false`）。

### 3) 值形状判定 / G-36：显示层细节 + t83 载荷形状守卫（下移/写实自 AGENTS.md 同名条目）

- **附带两条口径**：`env:{K:'<sk-…>'}` 这类**尖括号占位符在值形状通道同样被剥空**（多剥是安全方向）；`redactMcpSection` **自身**过滤非字符串载体（`env` 嵌套对象 / `args` 对象元素按上游同口径**丢弃**，不再依赖调用方先过滤）。
- **t78 订正（此前注记已不实）**：`src/security/redaction.ts` **不再有独立重复表** —— `REDACTION_VALUE_PATTERNS` 直接派生自 `secret-scanner.ts` 的 `SECRET_VALUE_PATTERNS`（同一份，仅补 `g` flag）；守卫 = `src/security/redaction.test.ts` 的 `t78-a`（结构：每个形状都在）/ `t78-b`（行为：scanner 判 secret 的语料 `redact()` 必须真掩）。**仍然存在的差异（不得写成「已彻底一致」）**：显示层比 scanner **更宽** —— 示例/占位形态（`sk-your-key-here` / `Bearer example-token-here`）scanner **放行**、`redact()` **仍掩**；base 与现状同结果，属显示层**既有产品取舍**，由 `t78-f` 钉成 characterization（t83 后其范围已收窄）。
- **t83 载荷形状守卫（写实）**：`sk-` 由 `/sk-[A-Za-z0-9_-]{8,}/` 改为 **载荷形状守卫** `/sk-(?![a-z-]{1,24}(?![A-Za-z0-9_-]))[A-Za-z0-9_-]{8,}/` —— `sk-` 后若是 **1–24 个纯小写字母/连字符**（词形态）则放行；直接动因是修**既有过剥**：`task-management` / `risk-assessment` / `disk-space-report` / `mosk-abcdefgh` / `ask-management`（误剥 = 静默改写用户内容，属数据保真问题，实测 `redact('risk-assessment')` → `ri***REDACTED***`）。
- **边界 ①（残余，如实登记）**：`sk-` + **≤24 个纯小写字母/连字符**（无数字、无大写）**不再命中**；**≥25 位**纯小写载荷仍命中（`t83-g` 钉成事实）。真实 OpenAI 形态（`sk-` + 40+ 位 base62，含数字/大写）与 `sk-proj-…` / `sk-ant-api03-…` 不受影响。
- **边界 ②（为什么不用左词边界）**：左边界 `(?<![A-Za-z0-9])` 会漏剥 **`'p'.repeat(10000) + 'sk-<key>'`** 这种真实**长串内嵌**形态（密钥紧贴长串之后）⇒ **明文进包**；第一版左边界方案因此让 `t40-b` / `t40-c` / `t78-g` 变红。**取舍**：为治「词误剥」绝不能削弱「真检测」——载荷形状守卫两者兼得。
- **其余模式未加任何边界，理由各异**：`AKIA` / `ghp_` / `github_pat_`（无自然语言触发词，普通文本不会产出这些前缀）、`jwt` / `pem`（加边界会与 `sk-` 同样削弱长串内嵌检出）、`bearer`（t72 已用 token 侧 guards 控制过剥）。守卫用例：`t83-a`（左邻字母数字的普通内容不被误剥）/ `t83-b`（被剥侧不削弱，含紧贴 `=`/`:`/引号）/ `t83-c`（t72 边界未回退）/ `t83-d`（未加边界的模式行为逐字不变）/ `t83-e`（`redact()` 通道同步受益）/ `t83-f`（1 万字符内嵌仍被剥）/ `t83-g`（残余边界钉事实）。

### 4) 其余下移碎片（t93 第二批；与 AGENTS.md 同序）

- **认证边界**：`recovery` 是本插件的**私有前缀**（不是 DSH 的 `/api`）；破坏性路由清单 = `/profiles/delete`、`/execute`、`/sync/rollback`、`/snapshots/delete`、`/recovery/**` 等。
- **只读预览与导出同口径的实测收益**：本机会话树 941 个文件 / 528 MB，预览从 **2271 ms / RSS +306 MiB** 降到 **~0.4 s / 近零常驻**。
- **已验证归档缓存的配套实测**：29 MiB 归档全量同步解压曾阻塞事件循环 **108 ms**（改走 `readEntryAsync` 后消除）。
- **profile 切换两条路的实现细节**：`dsh --profile <名> --port <空闲端口>` detached + 从子进程日志抓带 token 的认证 URL + HTTP 探活 + 按 `process.kill(pid,0)` 判活。
- **事件驱动递归遍历/救援/子代理复核路径**：真机四阶段验证复核 `outputs/rescue-e2e/`；子代理会话导出连带的复核 `outputs/subagent-fix/`。
- **会话日志格式版本**：拒绝实现 = `refuseForeignFormatVersion` → `SessionFormatUnsupportedError`。
- **救急台过期口径提醒**：旧文档曾写「只读（写方法 405）」——已过期，现在读路径只读、写路径有门（原因见 §2）。
- **只读预览 vs 真实导出的量化数据（第二批）**：真机 agentInstructions 预览 4.8 s／4016 文件；self 预览 2460 文件／11.44 MB，而真实导出 1936 B；本机会话树 941 文件 / 528 MB 的预览已降至 ~0.4 s。
- **`readSessionMeta` 缓存动机的量化数据**：`storages/session_projcache.json` = **1.57 MB**，每次预览 / 每次 `/plan` 都要解析，实测 **7.3 ms**。
- **磁盘清理那次的原始症状（2026-09）**：`includeRecent` 只影响可重建区，但导出区仍按保留期回收 ⇒ 界面说「只清缓存」却删了备份；守卫 = `tests/route/disk-usage-routes.test.ts`。

---

## 外部 Agent 会话导入的行形状（2026-10-07 真机事故）

**症状**：导入 Hermes 历史会话后，DSH 会话列表对该会话报
`历史加载失败：stored session "<id>" is corrupt: stored session "<id>" failed validation: Error: session event at seq 5 message must have model source（gateway/internal）`。

**根因**（`src/foreign/session-ir.ts` 的 `synthesizeDshRows`，2026-10-06 起 24 个会话来源 + Claude Code 共用）：

| # | 我们产出的形状 | DSH 要求（`dsh-session/lib/index.js`） |
|---|---|---|
| 1 | assistant `message.source = {kind:'assistant', provider, model}` | `assertMessageEventShape`（:946-948）：`source.kind === 'model'` **且** `hasProviderModel`（:958-961，provider 与 model 都非空） |
| 2 | assistant 行**没有** `stream` 字段 | 真实日志必有；`assertAssistantSettlementShape`（:904-908）要求 `Array.isArray(data.stream)` |
| 3 | assistant `message.content` 只有 text 块 | `deriveEventMessage`（:209-215）对**空 content 返回 null**；DSH 的 interrupted-turn 修复（:634）按 `content[].type === 'tool-call'` 记录未决调用 → 只有工具调用的助手消息会整条消失 |
| 4 | 工具结果块 `{type:'tool_result', tool_use_id, content, is_error}`，`source.callId` 可能为空串 | `assertMessageEventShape`（:950-955）：`source.kind === 'tool'`、`callId` 非空、`content` 恰好一块且 `type === 'tool-result'`、`block.toolCallId === source.callId` |

**权威形态来源**（不是猜的）：① DSH 校验器源码（上面行号）；② 本机真实日志逐行取样 —— `~/.dsh/sessions/--D-Projects-…--/session-…/session.v3.jsonl.zstd` 解帧后 8023 行里，assistant 行的 `data` 键恒为 `turn,step,message,usage,stream`、`source` 恒为 `{kind:'model',provider,model}`，工具结果块恒为 `{type:'tool-result',toolCallId,content,isError}`。

**修法**：`session-ir.ts` 四处对齐（kind → `'model'` + 非空兜底；补 `stream: []`；content 里补与 `tool/call` 同 id 的 `tool-call` 块；工具结果块改 `tool-result`/`toolCallId`/`isError`，空 id 按「最早未决调用」FIFO 回填、无主结果计数丢弃）。

**复核方式（可复现）**：用 DSH 自己的校验器逐行跑真机产物 —— `import { adoptSessionEvent } from '<dsh>/node_modules/@deepseek-ai/dsh-session/lib/index.js'`，对每条行的 `JSON.parse` 结果调用它。修复后：hermes 71 会话 / 29687 行、antigravity 7 / 2474、claude-code 2 / 6，**0 拒绝**；修复前正是这条链在拒绝。

**护栏**：`src/foreign/session-ir.test.ts` 钉四条形状（CI 里不依赖 DSH）；`claude-sessions-bytes.test.ts` 的字节基线随之有意更新（该文件头部要求「从旧值变更必须写明理由」，理由已写在 `GOLDEN` 上方）。

**已导入的坏会话需要重导**：旧产物在磁盘上仍是旧字节，导入计划会按 `session-id-conflict` 跳过；重导前先删掉那批会话目录。
- **救援冲突的时间尺度**：`reconcileBundles` 约 **1.5 s** 内就把插件加回（文档正文表述为「秒级」）。

---

## 外部来源会话的目标格式版本与 `session/title` 形状（2026-10-08 真机事故）

**症状**：在桌面端（DSH Desktop 0.2.0-rc.2）用「从其它 agent 导入」，产出的包里**没有 `sessions` 分区** ——
界面上看不到任何历史对话，用户的原话是「现在无法正常导入历史会话，之前可以」。

**根因（两层，都在 `src/foreign/`）**：

1. **版本闸门**：`SUPPORTED_DSH_SESSION_FORMAT_VERSIONS` 只写 `[3]`，而桌面端运行时的
   `SESSION_FORMAT_VERSION = 4`（直接量自 `D:\Apps\DSH\resources\app.asar` 内
   `@deepseek-ai/dsh-session/lib/index.js`），宿主又如实把 4 透传成 `targetSessionFormatVersion`
   （`src/routes/foreign.ts`）⇒ **每一条**会话都返回 `session-format-unsupported`（`detail: "4"`），
   包里只剩 `mcp` / `skills`。真机路由实测：`POST /api/dsh-config-manager/foreign-import {"source":"claude-code"}`
   → 200 + `sections:["mcp","skills"]`、`counts.sessions.transcoded = 0`；同一份本机 `~/.claude` 数据只改目标版本：
   target=3 → `["mcp","skills","sessions","workspaces"]`、transcoded=2，target=4 → 无 sessions 分区。
   本机同时存在两套运行时（G-23 已记）：**桌面端 = v4**、`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-session`
   （CLI 档案树）= **v3** —— 所以「在 CLI / `dsh web` 那套里能导、在桌面端不行」不是代码漂移，是**目标机代际不同**。
2. **标题行形状**：`synthesizeDshRows` 把标题行停在 **seq 0** 且恒写 `messageSeqs: []`。DSH 的
   `assertTitleSources`（`dsh-session` 与 v3/v4 迁移器**同一份校验**）要求 `messageSeqs` 为空 **⟺**
   `source.kind === 'user'`，非空时每个 seq 必须**早于**本条事件、指向 `source.kind === 'user'` 的
   `user/message`、且互不重复；两处调用方给的都是 `{kind:'fallback'}` ⇒ 恒违反①。后果不是「读不了」
   （v4 读盘路径仍接受），而是 **v3→v4 迁移把整份产物拒收**：
   `finish-failed: Session migration from v3 to v4 refuses the transformed artifact: session/title messageSeqs must be empty exactly for a user title`。

**真 codec 复验（可复现，2026-10-08 本机）**：`src/utils/session-verify.ts` 的 `verifySessionLogBytes` + 显式锚点
（v3 档 = `~/.dsh/profiles/node_modules/@deepseek-ai/dsh/package.json`；v4 档 = `D:\Apps\DSH\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\package.json`，走 asar 抽取）：

| 产物 | v3 codec | 桌面端 v4 codec |
|---|---|---|
| 修前 · `version=3` | verified，但 strict 报 `messageSeqs` | **finish-failed**（迁移拒收） |
| 修后 · `version=3` | verified / strong / `equivalentToReadPath=true` | verified / strong / `equivalentToReadPath=false`（走迁移链，**可读**） |
| 修后 · `version=4` | — | verified / strong / `equivalentToReadPath=true` |

**修法（三条一起才成立）**：① `SUPPORTED_DSH_SESSION_FORMAT_VERSIONS = [3, 4]`，`header.version` 与日志名
（`session.vN.jsonl.zstd`）**按目标机版本**写 —— 反向不可读（v3 主机读不了 v4 日志），**绝不一律写最高版本**；
版本读不到时仍旧一条都不转（`session-format-version-unknown`，路由回 400 `nothing-to-import`）；
② 非 user 来源的标题行**插在首条人类 `user/message` 之后**并把它的 seq 写进 `messageSeqs`（真机日志同形：
`{"type":"session/title","seq":12,"messageSeqs":[7],"source":{"kind":"fallback"}}`），插入后按行序统一重编 seq；
③ 整场没有任何人类消息时**不产标题行**（该会话如实 `session-empty`），不编一条指不到人的引用。

**行为变化（已进 CHANGELOG）**：只有标题、没有任何消息的会话（Claude 的 summary/attachment-only）从
「产出只有标题行的会话」变为 `skip:session-empty`。

**护栏**：`src/routes/foreign.test.ts`（路由层：目标 v4 必须产出 `sessions` 分区且 `sessions.transcoded=1`；
同一用例并排钉住「读不到版本仍 400 nothing-to-import」，避免被误读成「以后直接硬写 v4」）；
`src/foreign/claude-sessions.test.ts`（v4 的文件名与 header 同步）；`src/foreign/session-ir.test.ts`（标题行三条规则）；
`src/foreign/claude-sessions-bytes.test.ts`（字节基线，理由写在 `GOLDEN` 上方）；
`src/foreign/reasonix.test.ts`（原按「rows[0] 就是标题行」断言，随行序更新）。

---

## `cordis.patch.yml` 的 `!!js` 方言 与 pnpm 隔离安装的布局解析（2026-10-07，issue #75 / #74）

### 1) issue #75：导出 / 同步 / 预览丢掉 `!!js`（**整层** patch 行消失）

**症状**：`cordis.patch.yml` 里带 `!!js` 表达式时（真机形态：`- id: llm-pi-ai` / `disabled: !!js (function(){ … })()`），备份 / 导出 / 同步里这一层的 patch 行全部丢失。

**根因**：这份文件是 DSH 的**专用 YAML 方言**。`@deepseek-ai/dsh-app-boot` 用
`const entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr)`，其中
`JsExpr = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (data) => ({ __jsExpr: data }), predicate: isJsExpr, represent: (data) => data['__jsExpr'] })`。
本插件此前用缺省 schema 的 `yaml.load` —— 遇到该标签直接抛 `unknown scalar tag !<tag:yaml.org,2002:js>`（js-yaml 5 实测），旧实现把它 `catch` 成空数组。

**影响面比「丢一条配置」大**：解析针对**整份文档** → 只要该层有任何一处 `!!js`，这一层**全部** patch 行都从导出 / 同步 / `/export-preview` 消失（plugins / mcp / prompts 三处 adapter 都读 `readEffectivePatchLines`）。本地快照里的 `cordis.patch.yml` 是**整文件字节备份**，不受这条影响。

**第二段数据丢失（同一根因）**：`applyPatchChanges` 同样建不出 rows/order → 重建后的文件**只包含本次导入的行**，用户手写的其余行被整段删掉。

**同一根因的第三个出口（假警报）**：`core/boot-safety.ts` 的启动自洽审计用宿主注入的 `parseYaml` 解析**全部**启动关键 yaml，其中就有两层 `cordis.patch.yml`（`BOOT_CRITICAL_RELS`）。宿主注入一度是缺省 schema 的 `yaml.load` → 带 `!!js` 的 patch 层会在导入分析里被报成 `criticalFileUnparsable`（「启动关键文件无法解析」）：用户看到的是关于自己配置的假错误。现在注入口同样走方言（`parseYaml: (text) => loadPatchDocument(text)`），并由源码级接线守卫（`patch-yaml.test.ts` 末条）钉住。

**修法**：新增 `src/utils/patch-yaml.ts` 作为方言**单一事实源**（`JSON_SCHEMA.withTags(defineScalarTag('tag:yaml.org,2002:js', …))`；载入 `!!js <源码>` → `{__jsExpr: <源码>}`，写回反向），`DshPatchFileFacade` 的读取与写回都走它。两道护栏：① `applyPatchChanges` 遇到「存在但解析不了 / 读不到」的原文件**拒绝覆盖**（`host.patchRefuseClobber`）；② `readPatchLines` 解析失败**上抛**（`host.patchUnreadable`），经既有 `failures` 通道变成三处 adapter 的可见告警。**ENOENT 仍是「按需创建、本来就没有」→ 空层**（边界不放宽）。

**三条必须记住的口径**：
- `plugins.patch[].raw` 里的 `{__jsExpr: "<源码>"}` **是对外契约**（`docs/spec/bundle-format-v1.md` §3.4）：它是普通 JSON（可安全过 `JSON.stringify` 与分区 JSON），写回时必须还原成 `!!js`。
- 载入用 `JSON_SCHEMA` 而非缺省 schema **不是随手选的**：`~` 在缺省（Core）下是 `null`、在 JSON_SCHEMA 下是字符串 `"~"`，而 DSH 用后者 —— 用错 schema 会让导出的 `raw` 与 DSH 读到的值不一致（`patch-yaml.test.ts` 钉住这条差异）。
- js-yaml 的 `Error.message` **会附带出错处的源码片段**，而 patch 文件里可能内联字面量密钥（就写在 `!!js` 表达式旁）。所有外流摘要一律走 `describePatchYamlError()`（只取首行）。

**护栏**：`src/utils/patch-yaml.test.ts`（方言往返 / JSON 往返 / schema 口径 / 摘要截断）；`src/index.facade.test.ts` 的 4 条 #75 用例（整层读得出来 / 写回保真 / 解析不了拒绝覆盖且文件逐字节不变 / ENOENT 仍为空层）。

### 2) issue #74：pnpm 隔离安装下解析不到会话格式版本

**症状**：pnpm 全局安装 DSH 时，每次启动打 warn「无法解析本机 DSH 的会话格式版本」→ 导入 / 同步的「格式超前」体检整体跳过（本机读不了的会话被静默导入）。

**根因**：`resolveSessionFormatVersion` 把 node_modules 根反推为 `dirname(candidate)/../..`，只试「hoisted 同级」与「`dsh/node_modules` 嵌套」两种布局。隔离安装下唯一存在的候选是 installAnchor
`…\node_modules\.pnpm\@deepseek-ai+dsh@0.2.1-alpha.1_<hash>\node_modules\@deepseek-ai\dsh\package.json` —— 它的同级 `@deepseek-ai` 下只有 `dsh-session-projection` / `dsh-session-reference`（`dsh` 的 83 个 dependencies 里**没有** `@deepseek-ai/dsh-session`），`dsh/node_modules` 也不存在 → 两处都 miss。真实位置在**同一 store 的另一个段**：
`…\node_modules\.pnpm\@deepseek-ai+dsh-session@0.2.1-alpha.1_<hash>\node_modules\@deepseek-ai\dsh-session\lib\index.js`。与有没有会话、会话新旧无关。

**修法**：`src/utils/session-format.ts` 新增第三种布局 —— `findPnpmStore()` 从 node_modules 根向上找最近的 `.pnpm`（上限 8 层），`pnpmSessionFormatRoots()` 按段名前缀 `@deepseek-ai+dsh-session@` 扫段（前缀末尾的 `@` 必须有，否则 `-projection` 会被误命中）。多版本共存时取**与本机 dsh 同版本**者（`pnpmSessionEntryVersion()` 剥掉 `_<peerHash>`，semver 标识符不含 `_`）；**版本读不出来或对不上、且不止一个候选 → 返回空（不猜）**。`resolveSessionFormatVersion(candidates, tried?)` 顺带收集**所有尝试过的路径**，启动 warn 直接给出（issue 的直接诉求：原实现只说「解析不到」，没有线索）。

**同源要求（不改会复发）**：`session-verify.ts` 的 `nodeModulesRootsFor`（复验门用的「权威已装版本」）与 `dsh-profile-manager` 的档案列表都改走同一份 `sessionFormatRoots` —— 布局推导**只能有一处实现**，否则同一个坑会换个入口复发。

**护栏**：`src/utils/session-format.test.ts` 新增 8 条（合成 pnpm 段骨架：真机形状必须解析成功 / 多版本取同版本 / 版本对不上不猜 / dsh 版本缺失但单候选可用 / `tried` 收集 / 段名解析 / `findPnpmStore` / `sessionFormatRoots` 顺序）。

## 面板侧的「布局归位 / 重复 id 隔离」写路径与「两侧诚实」的三次实证（2026-10-07，M2）

> 与 `AGENTS.md` §📌 常见坑 **同序**：这里是证据、量化数据与复现路径。

### 1) 面板侧写路径：在 DSH 运行时动会话目录，护栏必须逐条现算

**入口与服务**：`POST /recovery/sessions/layout`（`/recovery` 前缀端点下的子路由，声明处 `src/routes/recovery.ts:217`，安全模型注释 `:223-227`）；服务 `src/utils/session-layout-repair-service.ts`（568 行，**禁止 import `src/cli/**`**），规划复用 core 的 `planSessionRepair`，响应只回**相对身份**（`unitId=<fromProjectKey>/<sessionId>`）与 `needsKeep[]`，**不含任何绝对路径**。

**为什么不能照抄 CLI 的安全假设**：CLI 的前置条件是「DSH 已停」，而面板**只能在 DSH 运行时执行** —— 所以这里不靠「没人用」保证安全，靠四条逐条现算的护栏：① `apply!==true` 只读计划（`readOnly:true`），**零写入**；② 逐条门前置 = 目标单元无 `session.lock` + 不在静止期内（复用**同一个常量** `SESSION_REPAIR_QUIESCENT_MS`，`session-layout-repair-service.ts:398`，与字节级门 `session-repair-service.ts:243` 同源）；③ **每次移动/改写后必须 `reindexSessionHeader` 成功，失败必须把该条搬回原位并如实报 `rolledBack`**；④ 宿主没给刷新端口就**一条也不执行**（`reindex-unavailable`）。先例：导入链的 `SessionsAdapter.finalizeApply` 本来就在运行时做「改写首帧 + 归位 + 重新登记」的同类操作。

**与 CLI 的有意差异（必须写进文案，不得当成实现漂移）**：面板不暴露路径映射 ⇒ `rewrite` 恒缺席、**只搬目录不改写首帧**（改写首帧只在离线 `dcm sessions repair --map` 路径可达）；重复 id **未点名 keep 拒绝执行**（CLI 只是跳过该条）；keep 必须指向**已扫描副本**，否则 `keep-not-a-candidate` 拒绝该 id —— CLI 的 `--keep` 指错路径会把**所有**副本都隔离，面板不继承这个脚坑。隔离目录与 CLI 同名同形：`.cm-repair-quarantine-<stamp>/<fromProjectKey>/<sessionId>`。

**复现（独立探针，不复用实现者的测试）**：`node .tmp/m2/e3/probe.mjs` → **PASS=21 / FAIL=0**（exit 0）。夹具 = 真机日志副本（325 B，cwd `D:\Projects\personal\SephiriaReconnect`）+ 临时 home，mtime 回拨 10 分钟绕开静止期门。六组断言：① 计划前后目录树逐字节一致（零写入）、`readOnly:true`、错位项 `applies=true` 且 `toProjectKey` = `projectKeyOf(首帧 cwd)`、`rewrite` 恒缺席、加锁项 `applies=false/reason=locked`、重复 id 进 `needsKeep`、计划 JSON **零绝对路径**；② 无刷新端口 → `reason=reindex-unavailable` + `applied=0` + 盘上未变；③ 真搬：`applied=1`、`movedUnitId` 正确、索引刷新被调用、**首帧 sha256 与源一致**；④ 未点名 keep → 两条均 `missing-keep`、两份都在；⑤ 点名 keep → 非保留副本进 `.cm-repair-quarantine-e3stamp/<fromKey>/<sid>`、保留者不动、响应零绝对路径；⑥ **刷新失败 → `reindex-failed` + `rolledBack:true` + 搬回原位 + 字节与原文一致**。

**护栏**：`tests/route/session-layout-routes.test.ts`（8 条，含 SAFE MODE 423 / 零写入 / 未去 acquire 锁）+ 服务单测 14 条；受保护测试 `tests/route/session-repair-routes.test.ts` 未被触碰（blob `278a54222ff178f1ed5f232bbfc5fc555ed34aae`）。

### 2) 「两侧诚实」的三次实证：文案说得到、代码要做得成

**(a) 会话体检整片误报 `subagent-without-parent`（真机 798/801 → 0）**：调用方不提供 `knownSessionIds` 时，旧实现用 `?? new Set()` 把「未知」伪造成「确知为空集」，于是父对话存在性判据对**每一条**子代理会话都成立 —— 真机 **801 条里 798 条**被误报（`bySeverity.invisible=798`；更早一次口径 1199 条里 800 条）。修法：`knownSessionIds` **可选三态**（缺省 = 不判、显式空集才判），采集器从第一趟遍历的**目录名**自证集合（`sessionIdKey` 归一），`header.id` 只在 `scanned < maxUnits` 的循环里补（窄边界已写进注释：超限未扫单元的父对话在极端情形下会被多报一次，方向是**宁可多报**）。复算：游客（默认解析）误报 **0**；显式空集模拟仍判 **801** —— 证明修的是「未知被当成空」，不是放宽判据。

**(b) 救急台渲染文本里的字面 `\*\*` 与「断言宽于覆盖」**：导出页 banner 走 `esc(text)`，写 `<strong>` 会被转义、写 `\*\*` 会原样显示星号 ⇒ 按「esc 上下文**去标记**」处理（`src/cli/web/page.ts:1063` 附近），并注释写明原因。真正的教训在测试侧：原用例名写「各页正文无字面 `\*\*`」却**只渲染 7 页**，导出页的两变体根本没进集合 —— 修法 = 按 `page.ts` 导出的全部 **12 个** `render*Page`（Message/Home/Disk/Sessions/Result/Lock/Unlock/Restore/Export/Reinstall/Verify/Profiles）做**集合相等**断言 + 每页**非空证明**（导出页的 proof 就是被改的那句），并做变异三连（塞回 `\*\*` → 红；另处塞 → 红；删 sweep 条目 → 集合断言红）。

**(c) 批量修复的失败分支丢 `verify`/`rolledBack`**：一键修复在「某条失败」分支里丢掉了逐条 `verify` 与 `rolledBack`，于是 **`rolledBack:false`（可能处于中间态）在面板上与成功无异**，而承诺文案（「已回滚」）与实际状态分叉。修法：三态（现役可读 / 迁移链可还原 / 未验证）与回滚结果**逐条回传**，各自有文案键，「未执行 / 已回滚」**绝不显示为成功**，回滚失败单独显红。

**(d) 条件渲染的功能入口会被读成「功能不存在」（2026-10-07 用户实测）**：布局归位入口原本只在「有候选行」时渲染，而真机 1218 个单元全是 `already-placed` ⇒ 用户打开会话体检只看到「没有要修的东西」，**根本不知道有这个入口**（构建产物里明明有它）。修法：可见性判定收进 `src/ui/session-layout-view.ts` 的 `sessionLayoutSectionState`（`hidden` = 还没扫过；`empty` = 扫过但本机无此档；`ready` = 有候选或有计划/结果），**扫过之后始终渲染**并显示空态说明（`sessions.layout.noCandidates`，zh/en 双键 —— 注意这个键此前**从不存在**，是补上的）；有计划/结果时更不得消失（否则刚做完的逐条结果被吞掉）。教训与 (b) 同源：**断言覆盖不到用户体验** 比代码错更难发现 —— 单测只钉了「有候选时渲染」，没有钉「没候选时用户是否还看得见」。

**同源缺陷（复验门）**：catalog 解析曾只按 `plan.root` 缓存、等价性也只按 root 判 ⇒ **同进程内同一输入结论翻转**，本机 v4 被误判 `decode-failed` 并触发回滚。修法：任何依赖日志 header 的判定**按该日志的 `headerVersion` 重跑**，等价性用 `equivalentToReadPath`（`createRestore(strict+transformed)` 只在 `header.version ===` 当前代际可达；pre-v4 走迁移链 ⇒ 可 `verified` 但**不等价于 DSH 读盘路径**）。护栏：`src/utils/session-verify.test.ts` 的等价性翻转用例 + 真机探针（`scanned=1225 / lossyRequired=0 / OK`）。

### 4) 真 codec 复验门的锚点链与 asar 抽取（2026-10-07，known-gaps G-24 ⑤）

**为什么要锚点**：catalog 来自官方 `@deepseek-ai/dsh-session`，只存在于 DSH 安装树里；桌面端把它放在 `app.asar` 内，而普通 node 进程的 `fs` 打不开 asar（`ENOENT`），所以复验必须先拿到一个**显式**锚点。锚点链（顺序即真伪顺序）：install-anchor（宿主 `profileContext.installAnchor`）→ env-anchor（`DSH_CM_DSH_INSTALL`，值是**安装根**：含 `resources/app.asar` 的那一层，**不是 asar 本身**）→ runtime-anchor（`process.resourcesPath`）→ profiles 树（`homeDir`/`profile`）。**版本解析与 catalog 候选规划共用同一条链**（否则两者从不同锚点互相自证，实测过这种自证）。

**实测（2026-10-07，本机）**：
- 设 `process.resourcesPath = 'D:/Apps/DSH/resources'` → 真机 v4 日志 **10/10** 得到 `{verified:true, strong:true, equivalentToReadPath:true, via:'asar-extract'}`（样本含 6,022,151 B / events=3683 的大日志与 334 B 的小日志；响应零绝对路径）；**清掉这个唯一锚点后，同一份日志变 `unavailable(children-required)`** —— 成功确实来自 asar 抽取。
- 只给 env-anchor（`DSH_CM_DSH_INSTALL` 指安装根）：catalog 能解析（不再全 `unavailable`），但抽样的 80 份**混合代际**日志里只有 1 份 `verified`、79 份 `decode-failed` —— 那批绝大多数是 pre-v4，且缺少宿主同源的 `homeDir`/`profile` 上下文，与宿主侧结论**不可比**。**别用「混合样本 + 单一锚点」的数字判门的好坏**（踩过）。
- 裸 node（无任何锚）→ 全 `unavailable`。**`unavailable` ≠ 已验证、也 ≠ 失败**。

**覆盖边界（如实）**：`equivalentToReadPath` 只在 `header.version === 当前代际` 时为真（本机 v4）；pre-v4 走迁移链 ⇒ 可 `verified` 但**不等于 DSH 读盘路径**（官方 `resolveCurrentLog` 对 pre-v4 视为「没有当前日志」）。本机最新代际里 v0/v3 占多数 ⇒ 这门是**低覆盖护栏**，不是全库体检。

**护栏**：`src/utils/session-verify.test.ts`（锚点链顺序 / env-anchor / install-anchor / 等价性翻转 / catalog 缓存按 `headerVersion` 重跑）；`src/utils/asar-read.test.ts`（asar 抽取 / 路径拆分 / 缓存根）；对照复核脚本 `.tmp/m2/g1/e2e.mjs`（带锚 vs 不带锚）。

## 技能自带 `node_modules` 撞 ZIP 条目上限：定时备份永久失败（2026-10-08，issue #76）

> 与 `AGENTS.md` §📌 常见坑「文件类分区收集一律走 `utils/recursive-walk.ts`」同序：这里是证据、量化数据与复现路径。

**真机现场（报告者提供；Windows 11 26100 / 桌面端 0.2.0-rc.2 / 插件 0.1.71）**：`C:\Users\ll\.dsh\skills\md2pdf` 自带 `scripts/convert.js` 与它自己的 `node_modules`（marked / mermaid / puppeteer-core 的传递依赖，148.6 MB / 11 625 个文件）。于是 `skills` 分区条目数 = **11 629**、全量备份 = **11 681** —— 撞上 `src/utils/zip.ts:41` 的 `DEFAULT_ZIP_SAFETY_LIMITS.maxEntries = 10_000`，`backup-schedule.json` 连续 3 次失败（`consecutiveFailures: 3`），产物目录里一份 auto 备份都没有。同一文本出现在三处（界面提示 / `lastRunMessage` / `dsh-config-manager/migration-history/*.backup-manual.json` 的 `result: "failed"`）。

**为什么用户侧无解（本条真正要记住的部分）**：定时备份与「立即备份」共用 `BackupScheduler.runOnce` —— `src/sync/backup-scheduler.ts:280` 的 `exporter.export()` 只传 `includeSecrets/outPath`、不传 `only` ⇒ `src/core/exporter.ts:303` 落回 `defaultIncluded`（`skills` 缺省 true）；`src/routes/backup.ts:232` 的「立即备份」就是同一条 `runOnce({manual:true})`（`manual` 只绕过 `enabled` 开关）。`backup-schedule.json` 的 schema（`src/sync/backup-schedule-config.ts:59-81`）没有分区/排除字段，界面上也没有可勾选的范围 —— **能选分区的只有导出**。

**口径不一致（修复前）**：`plugins` 分区按 `npm pack` 的产物度量，`src/core/local-plugin-pack.ts:19` 明写「绝不递归整个插件目录（node_modules 由 npm pack 自身排除）」，宿主 `dirSizeBytes` 也在 `src/index.ts:1419` 显式 `continue` 掉 `node_modules`；而 `skills` 走 `src/utils/recursive-walk.ts` 的通用递归时没有任何排除项 —— 同一个概念两套口径。

**不得用「调大上限」修**：写侧上限被 `src/utils/zip.ts:107` 钳到读侧默认值（只允许收紧），`src/utils/zip.test.ts:143` 有一条断言钉住读侧 10 000「不得调整」，`docs/spec/bundle-format-v1.md:123` 又把这个数写进了对外契约。「导出必须能导回」优先于「把巨树塞进包」。

**修法**：`utils/recursive-walk.ts` 新增 `EXCLUDED_DEP_DIR_NAMES = ['node_modules']`，在遍历里对**任意深度**的同名目录（目录本体，或 junction 指向的目录；**同名普通文件不误伤**）整棵跳过，并记进 `RecursiveListing.skippedDepDirs`（`path` + `files`）。文件数是 readdir-only 的**有界计数**（全局预算 `MAX_DEP_FILES_COUNTED = 100_000`，超预算记 `null` —— **不猜、也不假装是 0**）。两个消费侧同源告警：`adapters/link-report.ts`（GUI 导出报告与只读预览，`adapter.depsDirsSkipped` / `adapter.depsDirFiles`）与 `core/backup-plan.ts`（离线 CLI `dcm backup`）。排除落在**内核**，所以宿主门面 `ctx.fs.listRecursiveDetailed`、预览与离线 CLI 三处口径天然一致（预览与导出必须逐项相等的既有约束，见 AGENTS.md「只读预览与导出必须同口径」）。

**护栏**：`src/utils/recursive-walk.test.ts`「issue #76：node_modules（任意深度）整棵跳过并留痕；同名文件与相似名不受影响」（钉住 25 个文件的计数、深层命中、`plain/node_modules` 普通文件与 `notes-node_modules` / `node_modules.md` 保留、不混进 `skippedLinks`）、`src/adapters/link-report.test.ts`（文案含路径 / 文件数 / 「重新安装依赖」；未统计不猜）、`src/adapters/files.test.ts`（skills 导出报告可见，措辞不得混成链接问题）、`src/core/backup-plan.test.ts`（真实临时目录跑 `collectBackupEntries`：归档里没有 `node_modules/`，warnings 里有依赖目录行）。

**顺带修正**：离线 CLI 的跳过告警此前把分区前缀叠在**已是 homeDir 相对**的路径上（真机规模探针打出 `skills/skills/md2pdf/node_modules`），现只打印一次（`src/core/backup-plan.test.ts` 的 t37 用例同时钉住 `skills/outlink` 且不含 `skills/skills/`）。

**残留（如实）**：① 包内不含依赖树 ⇒ 目标机恢复后需在该技能目录重新 `npm install`（包内保留 `package.json` / lock，告警文案已写明）；② 定时备份 / 立即备份**仍然不支持分区范围** —— 排除依赖树消除了本条现场成因，但「无人值守路径没有收敛手段」这个结构性缺口仍在（issue #76 里列为备选 2/3，本轮未做）。





## 宿主整文件快照的「存在但读不出来」与保留清理的 fail-open（2026-10-08，UX 审查；known-gaps G-37）

**现象 ①（数据安全，会删用户文件）**：导入前快照登记 `$DSH_HOME` 关键文件（settings.yaml / settings.json / cordis.patch.yml / `profiles/<p>/cordis.patch.yml` / `profiles/<p>/pnpm-workspace.yaml`）时，`backupHostFiles`（`src/core/backup.ts`）把 `ctx.fs.readFile` 的失败写成了 `{ existed: false, blobPath: '' }`。恢复侧 `planRestore`（`src/core/restore.ts`）对 `existed === false` 的分支是「快照时不存在、现在存在 → `hostFileRemove`」，于是**一次回滚会删掉用户真实的 settings.yaml**，并在 `report.restored` 里算作已还原。触发面很普通：Windows 上 settings.yaml 被别的进程占用（EBUSY）或 EACCES。注意这与「文件类分区存在但读不到必须显式失败」是同一条铁律，只是宿主整文件这条路径此前把它吞掉了（文件类分区走 `engineSnapshotEntry` 时读失败会抛错）。

**修法**：读失败与「存在性探测本身失败」一律登记 `existed: true` + `unreadable: true`（无 blob）。`planRestore` 对 `existed && blobPath === ''` 的条目**只 `skip`**，且按 `unreadable` 选用专门文案 `restore.hostUnreadable`（「拍快照时存在但读不出来（占用/权限），本次不动它；请手动核对」），**绝不进入删除分支**。`verify-recovery.ts` 对 `existed=true` + 无 blob 本来就判 `unverifiable`（不是失败），所以这条改动不破坏快照一致性校验。

**现象 ②（保留清理 fail-open）**：`FileSnapshotStore.prune` 的 recovery 豁免是 `this.options.referencedSnapshotIds?.().catch(() => new Set())` —— journal 扫描一次瞬时失败（EACCES / IO）就被当成「无人引用」，随后按保留策略正常删最旧快照，**可能删掉未收敛 incident 指向的回滚点**（那是 SAFE MODE 恢复唯一的证据）。

**修法**：引用集合**读不到就放弃本轮清理**（`return`，宁可少删），并新增 `FileSnapshotStoreOptions.onWarn`（宿主接 `host.log.warn`），让「这轮为什么没清理 / 清理为什么失败」第一次可查；`finalizeSnapshot` 里 prune 失败的那个空 catch 也接上同一回调（快照本身已 READY，不因此判为失败）。

**护栏**：`src/core/backup.test.ts` —— ①「存在但读不出来 → existed/unreadable/blobPath 三字段 + durable+verified 不破」；②「引用扫描抛错 → 两个快照都留着 + 有告警」。`tests/core/restore.test.ts` 的 `R-host-unreadable`：目标机上文件真实存在时，计划里**零 `hostFileRemove`**、说明含「读不出来」。

**未做（如实）**：宿主整文件与文件类分区仍是两条读失败口径（后者上抛成分区级告警）；把宿主文件的 `unreadable` 也接进导出报告的告警面属另一条线。

## CLI 与救急台的一致性三条（2026-10-08 UX 审查）

**① 同一个动作，两端的写入门必须同源。** `dcm restore` 此前只过 `checkSafeModeBlocked` + 环境锁，而救急台走 `checkWriteGates(..., { needsDshStopped: true })`（src/cli/actions.ts）—— 结果是「浏览器里被拒的动作，终端里能直接覆盖 $DSH_HOME 的 settings/plugins/workspaces 登记」。现在 CLI 补上第三道门（顺序与救急台一致：SAFE MODE → 环境锁 → DSH 未运行），拒绝时给出两条出路（先关 DSH / 改用 `dcm web`），`--dry-run` 仍只打印计划（门只在真实执行前）。护栏：`src/cli/index-guards.test.ts` 的 G-06（DSH 在跑 → 拒绝且 settings.yaml 一字节未改）/ G-07（dry-run 不受门影响）。

**② 机器可读字段必须与退出码同源。** `sessions doctor --json` 的 `ok` 曾恒为 `true`，而退出码可能是 1（`blocking > 0`）—— 用 `jq .ok` 判健康的 CI 会把「阻断启动 N 条」读成一切正常。现在 `ok = blocking === 0`。同族：`sessions repair` 在会话根存在但读不出来时不再打印「无需修复」+ exit 0，而是明说「读不到 ≠ 没有会话」并 exit 1（`--json` 回 `ok:false`）；护栏 `src/cli/sessions-repair.test.ts` RP-01/02。

**③ 面向用户的清单必须从单一事实源派生。** 救急台 404 / 405 / 错误页的「可用页面」提示此前有三份互不相同的硬编码（还把 JSON 端点 `/healthz` 当页面推荐）。现在统一由 `page.ts` 的 `CONSOLE_PAGE_NAV` 经 `consolePagesHint()` 派生，并新增 `src/cli/web/console-route-parity.test.ts` 做**双向**断言（路由 `(method,path)` ↔ 硬编码快照、导航表 ↔ 路由集合）—— 多一条/少一条都红，这正是这类漂移能长期存活的原因。

**未做（如实）**：`--profile` 有意放行 `web`（runWeb 真的把它当救急台目标档案用）；「可用页面」严格等于 8 项头部导航，因此 `/lock` / `/verify`（首页动作卡入口）不在该提示里；`runWeb` 的 `locksDir` 现恒为 `<root>/locks`（不再走 `resolveRecoverLocksDir` 的候选根探测，`recover-stale-lock` 命令未改）。


## git 同步工作副本的 origin / 冲突连坐 / 环境锁误报（2026-10-10，issue #79）

**真机现场（报告者提供；Windows / 桌面端 0.2.0-rc.2 / 插件 0.1.71）**：git 通道的 `repoUrl` 从局域网地址改成同一台 NAS 上同一仓库的另一个可达地址（走 Tailscale）后，
同步再没成功过；设置页显示新地址、`credentialConfigured: true`，但自动同步报的是**旧地址** `Connection timed out`。手工
`git --git-dir=work/.git remote set-url origin <新地址>` 后同一命令立刻 1 秒内成功（`ls-remote` + `push --dry-run` 都正常）。

**根因（四条，均已复现/用测试钉住）**：

1. **工作副本 origin 不跟随 `repoUrl`（主因）**：`src/sync/git/git-transport.ts` 的 `ensureRepo()` 见到 `<workDir>/.git` 就直接
   `repoReady = true; return` —— `repoUrl` 只在首次 clone 时被使用，此后 `pullFromRemote()`（`git pull --ff-only`）与所有 push
   全走 `origin`。于是「改仓库地址」对已存在的工作副本**完全无效**，失败现象却是旧地址的网络超时，极易被误判成网络/凭据问题。
   `POST /sync/config`（`src/routes/sync.ts`）也只写配置、不碰 `<syncDir>/work`；路由与客户端 API 里没有 reclone / reset-workdir
   入口 —— App 内无自救路径。
2. **冲突连坐纯上行**：`src/sync/autosync-scheduler.ts` 在 merge 计划含 conflict 时整轮记 `skipped/conflict` 后直接 return，
   Phase C 的 push 永远到不了 ⇒「把本机配置推上去当备份」这条链路被一并封死（真机：连续多次 `skipped/conflict`）。
3. **陈旧错误与计数**：`writeFinalConfig` 只在 `result.error !== undefined` 时写 `lastRunMessage` ⇒ 连续跳过期间面板一直挂着
   几天前的「旧地址连接超时」；`consecutiveFailures` 只在成功分支归零。而该轮跳过原因只写 `host.log.info`（默认日志级别 warn）
   ⇒ 用户侧完全看不到「为什么没同步」。
4. **环境锁误报**：`inspectLockState()` 在 ownership 文件缺失时返回 `LOCKED`（`mapLockStateForStartup` 的非 STALE/UNKNOWN 兜底
   同样映射成 LOCKED）⇒ `GET /recovery/status` 会显示一个**并不存在的锁**（真机：用户自测 acquire/release 正常，面板却一直 LOCKED）。
   注意：那 16 次 `skipped/mutation-locked` 的**单一根因未定论**（LOCKED / STALE / UNKNOWN / IO / PERM / SAFE MODE 在历史里被统一记成
   同一类，只有 `stale` 写 warn），修可见性之后才能用真实日志复核 —— 本条只修「误报 LOCKED」这一条可证的部分。

**改法与边界**：

- `reconcileOrigin()`：`remote get-url origin` 读得出来且**非空**才比对（空串 = 读不到 ⇒ 不改写，不拿不确定的读取覆盖用户配置）；
  无 origin ⇒ `remote add`（否则 `push -u origin` 永远失败）；push URL 单独配置过也一并跟随。一致时**一条写命令都不发**。
- 与网络无关的两类失败给专用文案：SSH `Host key verification failed`（给 `ssh-keyscan` / `known_hosts` 做法，**绝不自动信任主机**）
  与 `refusing to merge unrelated histories` / `not possible to fast-forward`（指向「改回原地址或重建工作副本」）。
  全仓（含 git 历史）此前**没有任何** `known_hosts` / `StrictHostKeyChecking` / `GIT_SSH_COMMAND` 处理。
- `inspectWorkDir()` 默认只做 **2 条本地只读命令**（`remote get-url` ×2）——它挂在每次打开面板都会跑的 `GET /sync/status` 上；
  `rev-list` / `status --porcelain` 在大工作副本（会话 blob 上千文件）上明显更慢，放进 `detail: true`。
- `rebuildWorkDir(mode)`：`relink` 非破坏；`reclone` 先判「有 `.git`」，目录非空且无 `.git` 一律抛既有 `workDirNotRepo`（绝不删来路不明的目录）。
- 冲突解耦后状态语义：`partial` = 上行成功 + 下行待确认（带 `conflictedSections`）；本地无改动或 startup 变体仍是 `skipped/conflict`。
- 锁的 `FREE` 只改**分类与报告**：acquire 侧改为「EEXIST 但 inspect 读不到」时重试独占创建（有界 5 次），把「上一次占用刚释放」的竞态
  从「另一个任务正在运行」里摘出来；stale/unknown 的语义与显式回收一字未动。

**复核**：`node --test src/sync/git/git-transport.test.ts tests/route/sync-workdir-reset-route.test.ts src/sync/autosync-scheduler.test.ts src/utils/env-lock.test.ts`
（含真机 git 集成：clone A → 改指同一仓库的另一个地址 B → 断言快照落到 B、A 不再收到；relink/reclone/非仓库拒绝）。

## 英文界面零中文：守卫口径、白名单与残余（2026-10-08；与 AGENTS.md §i18n 同源）

**根因（两个一次性语言绑定）**：① 客户端 `src/client/index.ts` 在插件加载时用 `makeUiT(ctx.locale.getLocale().active === 'en' ? 'en' : 'zh')` 把 `uiT` **快照**进闭包 —— 而 `ctx.locale.getLocale()` 的官方契约是「当前不可变快照」（不是活查询），DSH 官方 `ctx.locale.bind(ns)` 的 `t` 才是活函数（每次读 `snapshot.active`）⇒ 用户切到 English 后，所有走 `UiT` 的报告 / 错误 / 进度 / 导入向导 / 同步 / 市场文案**永远是加载时那门语言**；② 宿主 `this.msg = makeMsg(resolveAppLanguage(ctx))` 同样在装配期冻结，而 `src/routes/kit.ts` 的 `errorMessage` 会把 `error.message` 原样回浏览器 ⇒ 引擎里的中文**逐字出现在 ErrorBanner**。

**修法**：语言在「取文案那一刻」解析 —— `makeLiveUiT(read)`（客户端 `src/ui/i18n.ts`，`setUiLanguageSource` 接线）+ `engineMsg` / `setEngineLanguageSource` / `invalidateEngineLocale`（`src/core/engine-locale.ts`；路由注册点 `endpoint()` 每请求失效，`LANGUAGE_TTL_MS = 1000` 只兜底调度器 / 后台任务）+ `registerMessageCatalog`（各域目录并入既有 zh/en，**只在既有目录未命中时生效**）。**不得**再在 `apply()` 里出现 `makeUiT(...)` / `makeMsg(...)` 快照。

**守卫口径（冻结）**：`tests/helpers/i18n-scan.ts`（逐字符词法状态机 code/comment/string；命中单位 = 字面量 × 行）+ `tests/i18n-hardcoded-guard.test.ts`。

- 扫描集 = `src/**/*.{ts,tsx,json}` − `src/cli/**` − `**/*.test.ts(x)` − `src/**/fixtures/**` + `locale/en.json` + `locale/zh.json`（后者整文件豁免）。**`src/**/*.css` 不在扫描集**：实测 `src/client/config-manager.module.css` 14917 个 CJK **全在注释内**（剥离注释后 0）⇒ 当前无漏，但将来 `content: '中文'` 或中文字体名会静默漏过（属契约级留白，需另行决策）。
- 三条豁免：E1 注释、E2 `log.*` / `console.*` 实参区间、E3 目录 zh 区。**E2 的 callee 判定要求 `(` 紧贴 callee** ⇒ `log.info ('中文')`（括号前有空格）不享豁免（保守误红，方向安全）。
- 命令：全量 `node --test tests/i18n-hardcoded-guard.test.ts`（退出码 0 = 零命中，摘要行 `DCM_I18N_GUARD scope=ALL files=… hits=0 allowlisted=128`）；作用域 `$env:DCM_I18N_GUARD_SCOPE='src/client,src/ui'`（只收窄文件列表；非法值直接失败；空集不算通过）。
- 白名单 4 条 / 128 命中（**整文件豁免** + 计数精确锚定；新增只能走 captain）：`src/foreign/truth-table.ts` 61（取证数据，从不渲染）、`src/ui/test-helpers.ts` 12（仅供 `*.test.ts`，不进 bundle）、`src/ui/commands.ts` 49（`COMMANDS[].keywords` 是命令面板**检索同义词**：`matchScore` 只做 toLowerCase/startsWith/includes 折成分档数值，返回值只带 `{item, disabled}`，可见标题走 `titleOf(titleKey)` → 壳层 `t()`）、`src/ui/errors.ts` 6（`buildErrorRules()` 的 `match` 正则只对宿主错误消息 `.test()` 挑规则，正则不进返回值；显示文本走 `error.*.title/.action`）。
- 实测基线（同一工作树口径）：迁移前红 **1107 + 白名单 73 = 1180** → t2 落守卫后 **1084 + 73 = 1157** → t12 落两条白名单后 hits **再减 55**（49 + 6）→ 最终 `hits=0 / allowlisted=128`；扫描文件数 412 → 424。

**并发期门禁口径（迁移期，2026-10-08）**：多个实现任务并行改同一棵工作树时，整树 `npm run typecheck` / `npm run typecheck:tests` / `npm test` 的报错**若全部落在自己作用域之外**，不作为个体任务失败判据 —— 实测同一命令连续三次运行的报错文件集不断变化（`src/client/sync/**` → `src/schema/**`，错误数 5 → 85 → 70）且零条涉及当事任务的文件。个体任务只跑 `DCM_I18N_GUARD_SCOPE` 作用域门禁 + 自己文件的隔离类型检查；全树门禁由 t8（独立验证）与 t11（集成）在全部实现落地后统一执行。**t12 是这条口径的第一次实际适用**：交付完成、作用域门禁 `exit 0`，但 verify 的 `typecheck:tests` 被在途编辑挡住 ⇒ 走 amend 报回 captain，**没有**为了绿灯放宽口径。

**残余（如实登记，不得隐去）**：

1. `src/core/model-tools.ts` 的 5 条工具描述在 `apply()` 期解析（DSH 工具注册是「**注册即快照**」）⇒ 会话中途切语言不即时更新，要重启 DSH。
2. 各域目录的键归属自检口径 = 「调用点引用的键必须存在于**已注册**目录」；键类型另由 `tsc` 强制。新增域目录必须同时 `registerMessageCatalog`，否则 `engineMsg` 只回退键名（可见缺陷，不崩溃）。
3. `src/cli/index.ts:1025` 仍按文案子串 `detail.includes('无有效 owner')` 判 corrupt 锁 —— CLI 恒 zh 故当前正确；**若 CLI 将来接语言源必须改成结构性判据**（参照 `src/utils/env-lock.ts` 的 `corruptOwnership`）。
4. 语言映射边界：只有**精确 `'zh'`** 视为中文，`'zh-Hans'` / `'zh-TW'` 等语言包 id 回落 en（DSH 内建仅 zh/en，当前无实际影响；引入 zh-* 语言包前必须决策是否改前缀匹配）。
5. 白名单是**整文件**豁免（无按行锚定 / 无到期日）—— 新增中文仍会因计数漂移立刻变红，但通道本身可被审批拓宽（t9 评审 F1）。
6. **E3 归属门禁：t16 首版有旁路 → t17 判 failed → t18 修复 → t19 独立复验 verdict=pass（另报 2 条 low 残余 V1-①/②）；fail-closed 已由 t17/t19 认可**：
   · **旁路（F2，重开）**：t16 的 `isCatalogOwnerFile`（`tests/helpers/i18n-scan.ts:229-231`）直接在**原始文本**上跑 `CATALOG_OWNER_CALL_RE` ⇒ 注释 / 字符串里提一句 `registerMessageCatalog(` 就给整文件授予 zh 豁免。t17 探针 `src/ui/__t17_probe_comment.ts` 复现 ★ 反例（全量守卫 `exit 0`）。**现树影响面 0**（没有这种文件），但通道可被无声拓宽。修复：**t18** 把判据收紧为「只认 **code 位置**的 `register*MessageCatalog` / `makeCatalogMsg` 调用」（`codeOnlyText` 掩码 + 原始文本快速预筛 + 自检 **S12**），**t19 独立复验 verdict=pass**（注释版 / 字符串版 → `exit 1` 并点名、真实调用 → `exit 0`、掩码不拼假匹配、fail-closed 与边界回归全过、两个守卫产物 SHA256 与探针前逐字相同）。**残余 low（V1）**：① 正则**无左边界** ⇒ `myregisterMessageCatalog(` 这类后缀名仍授予整文件豁免；② **类型注解 / 声明形态**（`registerMessageCatalog(id: string, …): void`）也算「调用」——**不得**写「任何文本形态都不能绕开归属」；**现树无假属主**（14 个含匹配文件里只有 engine-locale.ts 的定义形态与 s3/messages.ts，均不持有用户可见 zh 字典）。
   · **已认可**：fail-closed（词法区间 / E2 括号 / E3 大括号未闭合 ⇒ 不豁免 + `ScanAnomaly`；守卫 A3 报「不可判定（扫描区间未闭合）」、S10 六种样本）与归属门禁的**正例**（S9 / S11）—— t17 结论原文：「t16 的 fail-closed（A3）与归属门禁的正例都成立」。
   · **仍然存在**：白名单整文件豁免（F1）与 F4 的三条口径留白（`log.info ('中文')` 保守误红、A2 的门禁是全量运行、`.css` 不在扫描集）。
   · 实测（收尾）：全量 `exit 0 / files=424 hits=0 allowlisted=128`、守卫 17/17、`npm test` 4057 用例 / 4055 pass / 0 fail / 2 skipped；`files=` 随新增源文件与在途探针浮动，**不变量是 `hits=0` / `allowlisted=128`**。

**验证口径（未做即如实）**：结论来自静态守卫 + `npm test`（4052 用例 4050 pass / 0 fail / 2 skipped）+ `typecheck` / `typecheck:tests` / `build`；**真机逐页签 DOM 抽查未做**（验证会话无浏览器通道），不当作已通过。
