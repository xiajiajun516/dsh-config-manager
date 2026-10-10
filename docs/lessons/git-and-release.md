# Git / 版本发布 — 经验与证据存档

> 本文件是**经验/证据**：真机事故、量化数据、复现与复核脚本；**规则本体在 `AGENTS.md`**（对应小节读取）。
> 条目结构：每个 `###` 是原 `AGENTS.md` 的一条完整条目（逐字搬迁，未改写）。域 → 规则 的对应表见 `docs/lessons/README.md`。

## git 同步的工作副本 origin 必须每次跟随 repoUrl（issue #79）

- **git 同步的工作副本 origin 必须每次跟随 repoUrl（issue #79）**：`ensureRepo()` 复用已有 `.git` 时**必须**核对 `remote get-url origin`（含 `--push`）并在不一致时 `set-url`（一致时**零写命令**；读不出 origin → `remote add`）—— 此前只在首次 clone 用 `repoUrl`，改地址后 pull/push 全走旧 `origin`，失败面却是旧地址的网络超时（真机：局域网 → Tailscale 后静默失效数日）。同族五条：① 引擎与「重建工作副本」共用同一份 workDir（`makeGitTransport` 单点）；② `rebuildWorkDir('reclone')` **只**删有 `.git` 的目录（非空且无 `.git` 一律拒绝），路由要求 `confirm: true`（丢弃未上行提交）；③ 冲突只挡**下行**（绝不写本地），纯上行 push 照走并记 `partial`；④ 连续失败计数只在真失败 +1（其余归零），`lastRunMessage`/跳过原因**每轮覆盖**，跳过原因传**码**不传文案（界面按 `skipReasonKey` 取字典）；⑤ 环境锁 ownership 缺失如实报 `FREE`，**acquire 不据此放行**（改有界重试独占创建）。护栏与细节见 `docs/known-pitfalls.md`（同序「git 同步工作副本」节）。

## pnpm 发布年龄

- **pnpm 发布年龄**：`@latest` 装到旧版 = pnpm 11 `minimumReleaseAge`；用精确版本，或 `pnpm-workspace.yaml` 设 `minimumReleaseAge: 0`。

## 删任何源文件前先 `git status --porcelain <路径>`，看到 `??` 必须停下确认

- **删任何源文件前先 `git status --porcelain <路径>`，看到 `??` 必须停下确认**（2026-10-03 事故：`Remove-Item src/client/snapshots/*.tsx` 删掉两个**从未被 git 跟踪**的在用组件）。存活久的文件尽早提交；整目录清理先 `git add -A <目录>` 纳管再删。还原靠 `lib/client.js` 编译产物切片（`function <Name>(` + `/**` … `//#endregion`），还原后必须核对文案键与 `css.xxx` 并在文件头注明是还原版。

## 绝不用 `git checkout -- <文件>` 回滚本仓库

- **绝不用 `git checkout -- <文件>` 回滚本仓库**（2026-10-03 事故：抹掉整批未提交在途工作，`npm run typecheck` 0 → 170 错）。回滚前先 `git diff --stat HEAD -- <文件>`；撤销自己的改动用**针对性 edit 反向操作**；真要整文件回滚先 `cp` 到 `.tmp/`。字典可从 `lib/client.js` 回捞（键 → zh/en 值 → 注入），注意 `\\"` 转义、值内单引号转义、以及 `PaletteTitleKey`/`CompatibilityNoteKey` 这类联合类型键要去类型定义处抄。

## Windows LF→CRLF 警告

- **Windows LF→CRLF 警告**：EOL 已由仓库根 `.gitattributes`（`* text=auto eol=lf`，issue #70，2026-10-05）钉死 —— ubuntu / windows / macOS 三端检出同一份字节；**源码字面量守卫**仍须按既有先例在读取入口折 LF（`readFileSync(src,'utf8').replace(/\r\n/g,'\n')`），否则 CRLF 工作区（老检出 / 编辑器写 CRLF）会假红（内容无差异，`git diff` 为空）。根目录勿提交：`lib/dist/node_modules/outputs/my-video/.vibeskills/.agent-teams` 均已 gitignore；`dist/` 需先创建再 `npm pack --pack-destination ./dist`。

## CI 平台矩阵与 tests 类型检查（下移自 AGENTS.md §🧪 命令）

- **CI 是平台矩阵**（2026-09）：`.github/workflows/ci.yml` 的 `verify` 在 **ubuntu + windows + macOS** 跑同一套阶梯
  （`fail-fast: false`；pack 步骤显式 `shell: bash` —— PowerShell 的 `mkdir` 没有 `-p`）——全仓 32 处
  非测试 `process.platform` 分支此前只被 ubuntu 覆盖。**macOS 是观察期**（`experimental: true` +
  job 级 `continue-on-error`）：连续 1~2 次绿灯后删掉那一行即变硬门禁（不做长期「允许失败」）。详见 `DEVELOPERS.md`。
- **`tests/**` 的类型检查是独立一条命令**（`tsconfig.tests.json`）：根 config 只 include `src/**`，历史上 228 个测试文件长期在类型检查之外（实测曾积压 43 条错误，已修完并接进 CI）。改动测试后请跑 `npm run typecheck:tests`。
