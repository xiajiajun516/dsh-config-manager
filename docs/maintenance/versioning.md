# 版本管理规范（Semantic Versioning 2.0.0）

> 这份文档是**版本号怎么定**的唯一权威：三数字语义、预发布命名、历史版本保留、发布前检查、版本变更判断模板。
> 不重复的内容：发版命令与 CI 阶段表 → `DEVELOPERS.md`；CHANGELOG 体例 → skill `changelog-writing`；
> 四处数字与活文档声明由 `tests/packaging-contract.test.ts` 的 `V-1` 与 `scripts/check-doc-versions.mjs` 机械钉住。

- 适用插件版本：`dsh-config-manager@0.2.3`（`package.json:3`；与 `src/index.ts` 的 `export const PLUGIN_VERSION`、`package-lock.json` 根 version、`packages[""].version` 四处一致）
- 本规范自版本切换点起生效；切换点与理由见 §9。取证时间 2026-10-27（npm registry / `gh release list` / `git tag` / 提交信息实查）。

## 1. 三个数字代表什么

格式：`MAJOR.MINOR.PATCH[-PRERELEASE][+BUILD]`。

| 位 | 含义 | 什么时候 +1 | 示例 |
|---|---|---|---|
| MAJOR | 不兼容变更 | 公开契约被破坏：备份包格式/manifest 字段、同步通道索引与快照格式、CLI 与模型工具的参数或输出、路由/错误码语义、配置或数据落盘格式 | `1.4.2 → 2.0.0` |
| MINOR | 向后兼容的新增 | 新功能、新分区、新来源、新传输、新的可选字段；旧输入仍可用 | `1.4.2 → 1.5.0` |
| PATCH | 向后兼容的修复 | 修 Bug、安全问题、性能回归、错字与文案错误；**不含新功能** | `1.4.2 → 1.4.3` |

判据是**用户可观察的行为契约**，不是改动行数、提交数、作者的主观感受，也不是「感觉改动挺大」。
拿不准就看一个问题：**旧版本产出的数据/配置/调用，在新版本里是否仍然被正确接受？** 否 → 不兼容（MAJOR）；是且新增能力（MINOR）；是且只修错（PATCH）。

## 2. 0.x 阶段怎么读

SemVer 2.0.0 §4 规定 `0.y.z` 期间任何东西都可能变，公开 API 不算稳定。本项目当前处于 `0.x`，**不因此把规则放宽**，而是加一条更严的本地约定：

- `0.1.z` 只放**修复**（与 PATCH 同义）。
- 凡是新增用户可见功能、或改变既有行为语义（哪怕旧输入仍可读），**递增 MINOR**：`0.1.86 → 0.2.0`。
- 历史事实是 `0.1.0`–`0.1.85` 共 84 个版本全部落在 `0.1.z`，功能与修复混在一起（发版只用 `npm version patch`）。**这段历史不回改、不重编号**（§5），从切换点之后的第一个功能版本起按本节执行。
- 不为了「版本号好看」跳 `1.0.0`；`1.0.0` 的条件见 §7。

## 3. 预发布与构建元数据

- 预发布标识只允许 `alpha` / `beta` / `rc`，格式 `X.Y.Z-alpha.N`、`X.Y.Z-beta.N`、`X.Y.Z-rc.N`，`N` 从 `1` 起连续递增，不跳号、不复用已发过的 `N`。
- 预发布是「正式版前需要外部先验」的通道，不是日常开发节奏。准备工作做完就发 `rc`，`rc` 通过即发正式版，不长期停在预发布。
- 预发布当前**从未使用过**（npm 与 GitHub Release 上没有任何 `alpha/beta/rc` 记录）。首次启用时固定四件事：
  1. Git tag 用全名 `vX.Y.Z-rc.1`（附注 tag）；
  2. npm 用 `npm publish --tag next`，**绝不占 `latest`**；
  3. GitHub Release 勾选 `prerelease`；
  4. CHANGELOG 同样要有该段（`## [X.Y.Z-rc.1] - 日期`）。
- **正式版不得带预发布标识**：正式 tag 必须匹配 `^v[0-9]+\.[0-9]+\.[0-9]+$`；npm `latest` 只能指向正式版。
- `+BUILD` 元数据不参与版本优先级排序，**不用于**对外发布的 tag 与 npm 版本，只允许出现在内部临时产物名里。

## 4. 不该涨版本的情况

- 只改文档、注释、格式、测试结构，行为与产物不变 → 不产生版本，也不发版。
- 内部重构但对外行为、格式、性能特征都不变 → 不产生版本。
- **合并到 main 不等于一次发布**：是否发版由发布节奏决定，不由提交数决定。
- 但「用户可见的功能 / 行为 / 修复」必须当轮写入 `CHANGELOG.md` 的 `## [Unreleased]`，等下次发版带上（落位见 skill `changelog-writing`）。
- 有未提交改动时不得发版：先提交或明确排除，发布提交必须由干净的 `git status --porcelain` 产生。

## 5. 历史版本保留（硬规则）

- 已出现在 npm 的版本、GitHub Release、公开 Git tag **一律保留**：不删除、不覆盖、不重新编号、不把 tag 改指别的提交。
- 不为「格式统一」重写历史；不为旧提交补 tag（`0.1.0` 就是这种情况，见 §6）。
- 已发布版本有严重缺陷 → **发新的 PATCH 修**，不删旧版本。npm 同号不可重发（撤回后 24 小时内连恢复都受限，之后彻底不可再发该号）。
- 历史不符合 SemVer 的部分按原样保留，并在 §6 如实记录。
- 已发布的 `1.2.3` 永远不是 `1.0.0`；不得为了整理版本号新建指向旧提交的新 tag。
- 例外流程（撤回已发版本、补 tag、迁移发布渠道）必须**先说明再执行**，见 §8。

## 6. 审计结果（2026-10-27 实查）

### 6.1 事实

| 面 | 现状 | 取证 |
|---|---|---|
| 代码内版本 | `package.json:3` = `src/index.ts:183` `PLUGIN_VERSION` = `package-lock.json` 根 version = `packages[""].version` = `0.1.85`；`docs/spec/compat-matrix.md:6` 声明同步 | `node scripts/check-doc-versions.mjs` → `current=0.1.85 声明句=1 不一致=0` |
| Git tag | 84 个：`v0.1.1` … `v0.1.85`，**缺 `v0.1.74`**；21 个轻量 tag（早期）+ 63 个附注 tag | `git tag`（计数）、`git cat-file -t` |
| npm | 84 个版本：`0.1.0` … `0.1.85`，**缺 `0.1.74`、`0.1.75`**；`dist-tags.latest = 0.1.85`（2026-10-27T22:19:37Z） | `npm view dsh-config-manager versions`、`dist-tags` |
| GitHub Release | 81 个：`v0.1.4` … `v0.1.85`，**缺 `v0.1.74`**；`v0.1.1`–`v0.1.3` 有 tag 无 Release；全部 `prerelease=false` | `gh release list`、`gh release view v0.1.n` |
| 工作区 | 审计时 HEAD `bd56c1c`，比 `v0.1.85`（`3ecdfff`）多 5 个提交，`git status --porcelain` 为空（审计后工作区另有他人的未提交文档重构，不属审计基线） | `git log v0.1.85..HEAD --oneline` |

关键提交：`v0.1.85` = `3ecdfff`（`chore(release): v0.1.85`，单个提交内含 `CHANGELOG.md`、`docs/spec/compat-matrix.md`、`package-lock.json`、`package.json`、`src/index.ts`，配附注 tag）；v0.1.85 之后 5 个提交里唯一的用户可见变更是 `c802dd8`（同步工作副本锁按 holder 存活回收 + 只读自检 1.5s 有界），其余为文档与 issue 台账。

### 6.2 发现的问题

1. **版本号从未按变更类型判定**：84 次发布全是 `0.1.z` 递增，功能版与修复版不可区分，外部无法从版本号判断「这次能不能放心升」。根因是发版流程只有 `npm version patch` 一条路径。
2. **`0.1.74` 被撤回并删 tag**：`7156cb0` 发布 → `5827721`「撤回 v0.1.74 发布（删除 GitHub Release + tag）」→ `232ae18` 修根因 → `960649b`「fix 0.1.75」。npm 上同号 E404，registry `time` 仍保留 0.1.74/0.1.75 两条记录（无 `time.unpublished` 字段）。该版本永不可复现。
3. **`0.1.75` 是「半撤回」**：tag `v0.1.75`、GitHub Release（2026-10-15T23:40:41Z）与资产 `dsh-config-manager-0.1.75.tgz` 都在，npm 上 E404 → 「已发布」此前没有定义，到底以哪一面为准不明。**处置（2026-10-28，§11.3）**：登记为「仅 GitHub 资产可用」—— 需要 `0.1.75` 只能装 Release 资产 `dsh-config-manager-0.1.75.tgz`，不删 tag、不删 Release、不重发 npm。
4. **`0.1.0` 已发 npm 但无 tag、无 Release**（最早的发布早于「tag 与 Release 同步」的惯例），且历史已重写（见 5），无法补 tag，只能登记。
5. **历史断链**：`v0.1.1`–`v0.1.17` 不是 `main` 的祖先（`main` 首个提交是 `f6418f3`「chore: baseline before vibe XL execution」）。这 17 个 tag 指向另一条已废弃的线：npm 包与 Release 还在，但「tag → 可评审提交」对它们不成立。
6. **`publish.yml` 不校验 tag 与版本号一致**：Release 说明按 tag 抽取 CHANGELOG 段，`npm publish` 按 `package.json.version` 发布。tag 落后 → 发布失败；tag 领先 → 把包发成另一个版本号，而 Release 描述写的还是 tag 那个号。**已修（2026-10-28，§11.1/§11.2）**：`Tag guard` 步骤在 `npm publish` 之前校验 tag 形态与 tag↔`package.json.version` 的一致性。
7. **发版文档与实际做法不符**：`DEVELOPERS.md` 原文写 `npm version patch`（该命令会自行 commit + 打 **轻量** tag）再 `git push origin main --tags`，与实证的「单提交 + 附注 tag」不一致，且没有 SemVer 判定这一步。

## 7. 版本衔接与 `1.0.0`

- **切换点**：本规范自**下一次发布**起生效（当前工作区对应的下一个版本见 §9）。
- **`1.0.0` 的条件**（三条同时成立，且由用户确认）：`docs/spec/` 三份对外契约（`bundle-format-v1`、`sync-channel-v1`、`headless-consumption`）宣布稳定、承诺向后兼容一个 MAJOR 周期；`docs/maintenance/known-limits.md` 不再有会破坏契约的 P0 项；兼容矩阵对最近一个 MAJOR 周期给出实测结论。
- 在此之前不跳 `1.0.0`：`0.x` 的 MINOR 位承载「可能有破坏」的变更，本身就是诚实的表达。

## 8. 「已发布」的定义与一致性

### 8.1 一处定义

**已发布 = 四项同时成立**：
1. tag `vX.Y.Z`（附注 tag，消息 `vX.Y.Z`）指向的提交里 `package.json.version` = `X.Y.Z`；
2. npm 上存在 `X.Y.Z`；
3. GitHub Release 的 tag 名为 `vX.Y.Z`；
4. `CHANGELOG.md` 有 `## [X.Y.Z]` 段且内容与该版本相符。

缺任何一项 = **未完成发布**，必须当轮补完或按撤回流程处理；不得对外称「已发布」。

### 8.2 四个数字、三面发布

- 四个数字：`package.json:3`、`src/index.ts` 的 `PLUGIN_VERSION`、`package-lock.json` 根 `version`、`packages[""].version`。**`npm version` 只改前两者所在的 `package.json` 与 lock，不会改 `PLUGIN_VERSION`，必须手改**；`tests/packaging-contract.test.ts` 的 `V-1` 会在漏改时红。
- 第五处：`docs/spec/compat-matrix.md:6` 的版本声明行（`check-doc-versions.mjs` 强制），以及本文档顶部的同一行声明——两处都要随版本一起改。
- 顺序（顺序有意义）：CHANGELOG 收口 → bump 四处 + 兼容矩阵 → 单个 `chore(release): vX.Y.Z` 提交 → 附注 tag → `git push origin main --tags` → CI 全绿 → 回查 `npm view … dist-tags` 与 Release。**npm dist-tags 可能延迟十几分钟才可见，以 `npm view …@X.Y.Z version` 为准，不要因 dist-tags 未更新就重发。**
- 发布成功后按 `.dsh/issue-ledger.md` 的 `awaiting-release` 回填版本号并标 `fixed`（见 `AGENTS.md`）。

### 8.3 撤回（例外流程，需用户确认）

- 默认处理是**发新的 PATCH**，不撤回。
- 仅在「包会让用户数据受损或安装即崩」时才考虑撤回，且必须一次说清：受影响版本、影响面、tag/Release/npm 三面各自怎么处置、用户如何恢复到上一版。
- 撤回是删而非改：删 tag、删 Release、`npm unpublish`。**本文档不提供默认撤回脚本**；执行前必须得到用户明确同意，执行后把结果登记进 §6.2。

## 9. 每次发布前先填的版本变更判断

打 tag 之前，把七项写进发布提交说明或 issue：

1. **当前已发布版本**（以 §8.1 为准的四项交叉结果）
2. **本次变更摘要**（用户可见的：新增 / 改变 / 修复各几条）
3. **兼容性判断**（旧备份包、旧同步索引、旧 CLI 调用、旧配置是否仍可用）
4. **建议的新版本号**（含预发布时的 `N`）
5. **依据**（对到 §1 的哪一行；0.x 阶段对到 §2）
6. **需要同步的文件与发布目标**（四处数字 + 兼容矩阵 + CHANGELOG；tag / npm / Release）
7. **验证与检查结果**（§10 清单的逐项结论）

缺这份判断不许打 tag。**重大版本（MAJOR）、撤回/补 tag、发布渠道迁移、兼容性无法确定**四类情形必须先说明并等用户确认。

## 10. 发布前检查清单（全部通过才允许打 tag）

1. `node scripts/check-doc-versions.mjs` → 四处数字与活文档声明一致。
2. `node scripts/check-doc-paths.mjs`、`node scripts/check-agents-budget.mjs`。
3. `CHANGELOG.md`：`## [Unreleased]` 已收口为 `## [X.Y.Z] - YYYY-MM-DD`，`node .github/scripts/changelog-section.mjs check vX.Y.Z` 通过。
4. `npm run typecheck` → `npm test` → `npm run build`（build 前把 `TEMP`/`TMP` 指到 `.tmp/buildtmp`）；动 client 时另跑 `src/client/bundle-selfcontained.test.ts`。
5. `git status --porcelain` 为空。
6. 同号未用过：`git tag -l vX.Y.Z` 为空，且 `npm view dsh-config-manager@X.Y.Z version` 为 404。
7. tag 形态：正式版匹配 `^v[0-9]+\.[0-9]+\.[0-9]+$`；预发布匹配 `^v[0-9]+\.[0-9]+\.[0-9]+-(alpha|beta|rc)\.[1-9][0-9]*$`。

## 11. 缺口处置结果（2026-10-28 落地）

> 审计列的 4 项缺口已按用户确认执行；「已实施」指代码/文档已在仓库里可核对，不指「计划中」。

1. **`publish.yml` 已加 `Tag guard` 步骤（已实施）**：位置在 `Doc version guard` 之后、`npm publish` 之前，校验 ① tag 形态 ② tag 名 == `package.json.version`。任一不成立即 `::error::` 退出 1，包不会发出去；取证 = `.github/workflows/publish.yml` 的 `Tag guard (形态 + tag↔版本)` 步骤。
2. **tag 形态守卫（已实施）**：正式版 `^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`，预发布只允许 `-(alpha|beta|rc).N`（N 为正整数）。`v1`、`v0.1.86-beta`、`v0.1.86+build` 都会在发布前被拒。
3. **`0.1.75` 收口 = 保持现状（已采纳）**：不动 tag、不动 Release、不重发 npm；登记为「仅 GitHub 资产可用」—— 需要 `0.1.75` 只能装 Release 资产 `dsh-config-manager-0.1.75.tgz`，npm 上没有任何可用包（§6.2 第 3 条）。
4. **`0.1.0` 无 tag（已登记）**：按 §5 不补 tag，只在 §6 登记为历史遗留。

## 12. 本次审计的结论与建议

- **下一个版本号：`0.1.86`（PATCH）**。理由：`v0.1.85` 之后 5 个提交里用户可见变更只有 `c802dd8` 的同步锁回收修复（已在 `[Unreleased]`），其余为文档与台账；无新功能、无契约变化 → 按 §1 只能是 PATCH。
- **再下一个版本起分叉**：第一条新增用户可见功能或不兼容变更 → `0.2.0`（§2）；`1.0.0` 等 §7 三条成立并由用户确认。
- 本次**不**改版本号、不打 tag、不发 npm、不改 Release、不动 `publish.yml`；§11 四项已按用户确认落地（2026-10-28）；`0.1.86` 是规范生效后的第一个版本，也是 §1/§9 的一次实例：只有修复 → PATCH。
