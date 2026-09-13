# Changelog

本文档记录 dsh-config-manager 的发布亮点（中英双语）。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。
This file records release highlights of dsh-config-manager (bilingual: 中文 + English). Format: [Keep a Changelog](https://keepachangelog.com/).

> **发布流程**：打 tag 发布时 CI（`.github/workflows/publish.yml`）自动抽取**当前版本段**作为 GitHub Release 描述亮点；
> 如果忘记写当前版本段，CI 会 **fail fast** 拒绝发版，避免漏写。
>
> **Release workflow**: on tag push, CI extracts the current version's section as the release notes highlights;
> the build fails fast if the section is missing, so you cannot forget to update it.

## [v0.1.59] - 2026-09-13

> 本版把两个**尚未发布**的版本合并为一次发布，因此只占一个版本号。它包含前后两轮工作：前半是**自驱的能力补齐轮次**，方向来自对同类工具（restic / kopia / Borg / rclone / Duplicati / Syncthing / chezmoi / yadm / mackup / VS Code / JetBrains）的能力对照与差距分析，落点选在「会真正丢东西」与「可靠性无法自证」两类问题上；后半是**格式规格化 + 全量缺陷修复**轮次，方向是把 bundle 格式从「实现细节」变成**可被第三方独立实现的对外契约**，并在此过程中把审计挖出的缺陷**真正修掉**（而非仅登记）。两轮均不针对任何新提交的 issue。

### 🎯 亮点 / Highlights (zh)

- 🧩 **本地开发中的插件不再随换机丢失（能力补齐轮次最重要）**：以 `link:` / `file:` 安装的插件，其依赖 spec 指向的是**本机绝对路径**（例如 `link:D:/Projects/my-plugin`）。导出备份时会原样记下这条路径，而目标机器上它根本不存在——导入时该插件必然安装失败，且**失败是静默的**（备份看起来完好）。现在导出阶段会对这类插件执行 `npm pack`，把打出的 tarball 一并放进备份；导入阶段先解包到 `$DSH_HOME/dsh-config-manager/local-plugins/`，再把 spec 重写为 `file:<绝对路径>` 交给官方安装通道。单个插件打包失败**不会中断导出**（记 warning 跳过，其余继续），超过 100 MB 的 tarball 会被跳过并告警。**密钥排除规则不受影响**——进入备份的是插件代码，不是凭据
- 🔍 **CLI 补上 `verify`：回答「三个月前那个备份现在还能不能用」**（此前无任何入口）。它把备份 ZIP 从磁盘重读一遍、**一个字节都不写**，给出五种互斥裁决：`OK` / `MISSING` / `CORRUPT` / `UNSUPPORTED` / `VERIFY_ERROR`。逐条目重算 SHA-256 与 `integrity/checksums.json` 比对，不符时**点名具体条目**（而不是只给个总数）；解压全程走既有强化解析器（Zip Slip / 压缩炸弹 / 符号链接 / 重复条目名一律拒绝）。**校验失败绝不降级成"大概没问题"**——`VERIFY_ERROR` 只用于自检自身失败（磁盘 IO 等），明确区别于「备份确实坏了」。退出码语义明确（全 OK → 0，任一非 OK → 1），并支持 `--json` 供 CI 与定时任务断言
- 💾 **CLI 补上 `backup`：DSH 起不来时也能备份**。此前的 CLI 是「能恢复但不能备份」——GUI 与 Agent 工具都能备份，唯独救急通道缺这一半。现在可离线把 `$DSH_HOME` 下**离线可直读**的分区打成与 GUI 同结构的 ZIP（manifest + checksums + 分区目录），并立即自检。**刻意不伪造结构化分区**：`settings` 等必须经 DSH 服务层权威脱敏、离线拿不到，这类分区**不进归档并在输出里列为"离线不可收集"**——宁可如实告知，也不产出一个「声称含设置、实际为空」的假备份（那会让恢复者误以为配置已经保住）
- 🗄️ **保留策略可配置，支持 GFS 分层**：快照与定时备份的保留策略此前是**三处硬编码常量**（快照 10 / 定时备份 10），用户完全不可调；总览页的分母还写死了字符串 `'10'`，改常量会导致 UI 与实际行为不一致。现在策略可配——「最近 N 份 + 每月留 1 份 + 每年留 1 份」（参考 restic `forget` 的分层思路，配置备份这类「体积小、变化频繁」的场景比纯 FIFO 更合用）。**默认值与旧行为逐字节等价**（`keepLast: 10` 且分层关闭时直接走原函数），既存快照的清理结果不会发生任何变化
- 🛡️ **配置市场两端拒绝内嵌插件代码**：本轮给 `plugins` 分区新增的本地插件 tarball 字段（`localTarballs`），在**发布端**（`prepareMarketItem`）与**导入端**（市场条目校验）**同时硬拒绝**。原因：tarball 是不可经公开仓库审阅的不透明二进制，安装时可能执行 `postinstall`——若允许它经市场分发，等于给「分享配置」开了一条携带任意代码、绕过既有 BANNED 分区防线的通道。本地插件迁移只应发生在**自己的备份**里。该字段也因此**不会**成为新的供应链入口

- 🚦 **CI 有了 PR 门禁**：此前 `.github/workflows/` 只有发布流水线（仅 `tag v*` 触发），dependabot 与外部贡献的 PR **全绿与否无人校验**即可合并。现在新增 `ci.yml`：`pull_request` → `main` 与 `push` → `main` 跑完整的 typecheck → test（全量 1600+ 项）→ build → pack，**零发布副作用**（不含 publish、不申请 OIDC 凭据、权限仅 `contents: read`），并带并发取消（同分支新提交自动取消旧运行）与超时兜底

- 📜 **bundle 格式 v1 有了对外规格**（`docs/spec/bundle-format-v1.md`，1312 行）：逐条 `file:line` 取证 + 显式「未验证」清单，配 manifest 的 JSON Schema（`bundle-manifest.schema.json`）与可执行一致性语料（`tests/conformance/`）。规格的核心章节是**向前兼容规则**——导入端遇到「未知分区」「未知顶层字段」「已知分区内的未知字段」时分别保留还是忽略，逐条实测写明。**同时诚实登记了尚存的空白**：各 adapter 的冲突判定规则、`PlanItem.id` 命名约定、对外返回类型契约仍未规格化，第三方据此仍**无法**完整实现兼容 importer
- ⛓️ **迁移链从「死代码」变成真实接入（缺陷修复轮次最重要）**：`migrateToCurrent` 此前**全库零 import**——有定义、有注册、有单测，却**从未被导入路径调用**。叠加 `MIN_SUPPORTED = CURRENT = 1`，整条迁移链**一次都没真正执行过**。这意味着发布 schema v2 那天，旧备份会被判定「可迁移」却**不迁移**，用户拿到静默的错误数据。现在导入路径在 `needsMigration` 为真时真实调用迁移链、用迁移结果替换 manifest，并重新校验结果合法性
- 🔍 **「不认识」与「文件缺失」不再混为一谈**：此前未知分区被**静默丢弃**，而唯一的相关告警还把原因说反了——报「备份声明了但**缺少**的分区: X」，**而文件其实就在 ZIP 里**。用户无法判断该升级插件还是备份坏了。现在未知分区走独立的 `unsupportedSections` 通道与专属告警文案；分区数据版本高于本版本时**跳过该分区并告警**，而不是让**整个 bundle** 无法导入（数据损坏类的非法版本号仍硬失败）
- 🧾 **完整性校验补上反向检查**：此前 checksums 只保证「表内条目未被篡改」，不保证「ZIP 内没有多余条目」，且**剥掉校验表即可无提示通过**。现在未登记条目会明确告警，校验表缺失或为空时也会显式告知「全部条目未被校验」——**不再有静默通过路径**
- 🔐 **加密备份不做任何密码强度校验（刻意的产品决策）**：加密备份的密码策略**完全由用户自己掌握**，插件不施加任何强度约束——`1`、`12345678`、`password` 一律可用。**唯一约束是密码非空**（空字符串会被拒），加密入口除此之外不再做任何判定。这项决策同时**删除**了此前那个强度校验函数：它在上一版（`v0.1.58`）中虽已实现且有单测，却在宿主入口**从未被调用**——一个「看起来在守、实际不跑」的死代码。本版选择**直接移除**而不是把它接通，因为留着一个永不生效的闸门比没有闸门更危险：它会让维护者和审计者误以为防线存在。**解密方向同样不校验**（且现在整个校验面都不存在）——否则历史弱密码备份会**永久打不开**
- 🕵️ **文件类分区纳入凭据扫描**：`skills` / `agentPresets` / `agentInstructions` / `pluginFiles` / `sessions` / `self` 的内容此前**完全不进扫描器**，也不计入 `redactedHits`——「默认不含秘密」这条不变量对它们**不成立**。现在导出时做文本级扫描并告警（**只报告、绝不改写**——那是用户的真实文件），且三条导出路径（HTTP 路由 / `config_backup` / 定时自动备份）注入**同一个** scanner 实例，避免档位漂移
- 📦 **引擎可被 headless 环境零成本消费**：`@radix-ui/*` 与 `lucide-react` 已被内联进 `lib/client.js`，却仍挂在 runtime `dependencies`，迫使只想复用引擎的消费者安装整套 React UI 栈。现在它们归入 `devDependencies`，且全部 16 个 peer 标记 `peerDependenciesMeta.optional`（它们由 DSH 宿主提供）。**默认安装从 74 个包 / 32.25 MB 降到 3 个包 / 8.84 MB**；同时 `files` 排除 140 个 `.map`，发布包从 2.48 MB 降到 1.88 MB。`./schema` 导出位此前指向纯类型产物（运行时 **0 导出**），现在是真实的运行时入口

### Highlights (en)

> This release merges two **as-yet-unpublished** versions into a single release, so it occupies only one version number. It spans two rounds of work. The first is a self-driven **capability-gap round**, scoped by comparing against peer tools (restic / kopia / Borg / rclone / Duplicati / Syncthing / chezmoi / yadm / mackup / VS Code / JetBrains) and targeting two classes of problem: things that **actually lose data**, and reliability that **cannot be self-proven**. The second is a **format-specification and defect-remediation round** that turns the bundle format from an implementation detail into a contract **a third party can implement independently**, and **actually fixes** — rather than merely logs — the defects the audit surfaced. Neither round addresses a newly filed issue.

- 🧩 **Locally developed plugins no longer vanish when you change machines (the capability round's headline fix)**: plugins installed via `link:` / `file:` carry a dependency spec that points at a **machine-local absolute path** (e.g. `link:D:/Projects/my-plugin`). The backup used to record that path verbatim, but it does not exist on the target machine, so the plugin inevitably failed to install — **and failed silently** (the backup looked perfectly fine). Export now runs `npm pack` for such plugins and bundles the resulting tarball; import unpacks it under `$DSH_HOME/dsh-config-manager/local-plugins/` and rewrites the spec to `file:<absolute path>` for the official install path. A single plugin failing to pack **never aborts the export** (recorded as a warning, the rest continue), and tarballs above 100 MB are skipped with a warning. **Secret-exclusion rules are unaffected** — what enters the backup is plugin code, not credentials
- 🔍 **New CLI `verify`: "is that backup from three months ago still usable?"** There was previously no way to ask. It re-reads the backup ZIP from disk and **writes not a single byte**, returning five mutually exclusive verdicts: `OK` / `MISSING` / `CORRUPT` / `UNSUPPORTED` / `VERIFY_ERROR`. It recomputes SHA-256 per entry against `integrity/checksums.json` and **names the offending entries** rather than reporting a bare count; extraction goes through the existing hardened parser (Zip Slip / zip bombs / symlinks / duplicate names all rejected). **A failed check is never downgraded to "probably fine"** — `VERIFY_ERROR` is reserved for failures of the check itself (disk I/O), which is explicitly distinct from "the backup is genuinely broken". Exit codes are unambiguous (all OK → 0, any non-OK → 1) and `--json` is available for CI and scheduled assertions
- 💾 **New CLI `backup`: back up even when DSH cannot start.** The CLI could previously restore but not back up — the GUI and the agent tools could both back up, yet the emergency path was missing exactly that half. It now builds, fully offline, a ZIP with the same structure the GUI produces (manifest + checksums + section directories) from the parts of `$DSH_HOME` that are **directly readable offline**, then self-verifies it. It **deliberately does not fabricate structured sections**: `settings` and friends must be authoritatively redacted through the DSH service layer and are unobtainable offline, so those sections **stay out of the archive and are reported as "not collectable offline"** — honest disclosure rather than a bogus backup that claims to contain your settings while being empty (which would leave a restorer believing the configuration was saved)
- 🗄️ **Configurable retention with GFS tiers**: snapshot and scheduled-backup retention used to be **three hard-coded constants** (10 snapshots, 10 scheduled backups) that users could not change at all, and the overview page hard-coded the string `'10'` as its denominator, so changing a constant would silently desync the UI from real behaviour. Retention is now configurable — "the last N + one per month + one per year" (modelled on restic `forget`'s tiered thinking; a better fit for config backups, which are small and change often, than pure FIFO). **Defaults are byte-for-byte equivalent to the old behaviour** (`keepLast: 10` with tiers disabled calls the original function directly), so pruning results for existing snapshots do not change at all
- 🛡️ **The marketplace rejects embedded plugin code at both ends**: the local-plugin tarball field (`localTarballs`) added to the `plugins` section this round is **hard-rejected on both the publish side** (`prepareMarketItem`) **and the install side** (market item validation). The reason: a tarball is an opaque binary that cannot be reviewed through a public repository and may run `postinstall` on install — allowing it through the marketplace would open a channel for shipping arbitrary code via "shared config", bypassing the existing BANNED-section defenses. Migrating locally developed plugins belongs in **your own backup**, not in a public marketplace item. The field therefore does **not** become a new supply-chain entry point

- 🚦 **CI now has a PR gate**: `.github/workflows/` previously held only the release pipeline (triggered solely by `tag v*`), so dependabot and external-contribution PRs **could be merged with nobody checking whether they passed**. The new `ci.yml` runs the full typecheck → test (1600+ tests) → build → pack on `pull_request` → `main` and `push` → `main`, with **zero release side effects** (no publish step, no OIDC credentials requested, `permissions: contents: read` only), plus concurrency cancellation (a newer push to the same branch cancels the stale run) and a timeout guard

- 📜 **Bundle Format v1 now has a public specification** (`docs/spec/bundle-format-v1.md`, 1312 lines): per-claim `file:line` evidence plus an explicit "unverified" list, alongside a JSON Schema for the manifest and an executable conformance corpus (`tests/conformance/`). Its central chapter is **forward-compatibility**: whether an importer preserves or ignores an unknown section, an unknown top-level field, and an unknown field inside a known section — each determined by measurement, not assumption. It **also honestly records what is still missing**: per-adapter conflict rules, the `PlanItem.id` convention, and the return-type contracts are not yet specified, so a third party still **cannot** fully implement a compatible importer
- ⛓️ **The migration chain went from dead code to genuinely wired in (the defect-remediation round's most important reliability fix)**: `migrateToCurrent` had **zero importers anywhere** — defined, registered, unit-tested, and **never called by the import path**. Combined with `MIN_SUPPORTED = CURRENT = 1`, the entire chain had **never once executed for real**. The consequence: on the day schema v2 ships, an old backup would be judged "migratable" and then **not migrated**, handing the user silently wrong data. The import path now genuinely invokes the chain when `needsMigration` holds, replaces the manifest with the migrated result, and re-validates it
- 🔍 **"I don't recognise this" is no longer conflated with "the file is missing"**: unknown sections used to be **silently dropped**, and the only related warning stated the cause backwards — "sections declared by the backup but **missing**: X" — **while the file was in fact inside the ZIP**. Users could not tell whether to upgrade the plugin or distrust the backup. Unknown sections now travel a dedicated `unsupportedSections` channel with their own message; a section whose data version is newer than this build is **skipped with a warning** instead of making the **whole bundle** unimportable (genuinely invalid version numbers still fail hard)
- 🧾 **Integrity checking gained its reverse direction**: checksums used to guarantee only that "entries in the table were not tampered with", never that "the ZIP contains nothing extra" — and **removing the checksum table made everything pass silently**. Unregistered entries now warn, and a missing or empty table explicitly reports that **no entry was verified**. There is **no longer a silent-pass path**
- 🔐 **Encrypted backups apply no password-strength validation at all (a deliberate product decision)**: the password policy for an encrypted backup belongs **entirely to the user** — the plugin imposes no strength requirement, so `1`, `12345678` and `password` are all accepted. **The only constraint is that the password is non-empty** (an empty string is rejected); beyond that the encryption entry point makes no judgement. This decision also **deleted** the strength-checking function: it existed in the previous release (`v0.1.58`) with unit tests, yet had **zero call sites** in the host entry — dead code that looked like a guard but never ran. This release **removes** it outright instead of wiring it up, because a gate that never fires is more dangerous than no gate: it leads maintainers and auditors to believe a defence exists. **Decryption is likewise never validated** (and no validation surface exists at all now) — doing so would make **historical weak-password backups permanently unopenable**
- 🕵️ **File-type sections are now scanned for credentials**: the contents of `skills` / `agentPresets` / `agentInstructions` / `pluginFiles` / `sessions` / `self` previously **never entered the scanner** and were excluded from `redactedHits` — so "no secrets by default" **did not hold** for them. Export now scans their text and warns (**report only, never rewrite** — these are the user's real files), and all three export paths (HTTP route / `config_backup` / scheduled auto-backup) inject **the same** scanner instance so their strictness cannot drift apart
- 📦 **The engine is now consumable from a headless environment at zero cost**: `@radix-ui/*` and `lucide-react` are already inlined into `lib/client.js` yet still sat in runtime `dependencies`, forcing anyone who wanted only the engine to install a whole React UI stack. They now live in `devDependencies`, and all 16 peers are marked `peerDependenciesMeta.optional` (they are supplied by the DSH host). **A default install drops from 74 packages / 32.25 MB to 3 packages / 8.84 MB**, while `files` now excludes 140 `.map` files, shrinking the published tarball from 2.48 MB to 1.88 MB. The `./schema` export used to point at a types-only artifact (**0 runtime exports**); it is now a real runtime entry point

## [v0.1.58] - 2026-09-12

> 本版为自驱的 UI 打磨与缺陷修复轮次，**不针对任何新提交的 issue**（#27-#30 的修复随 v0.1.57 发布）。

### 🎯 亮点 / Highlights (zh)

- 🧭 **历史页「分类筛选」首次真正生效**：此前后端查询契约（`filterToQuery`）已实现、单测全绿，但历史面板从未把筛选条件传给后端（`list()` 不带参），于是「分类 / 结果」下拉**可点却纹丝不动**——纯函数已写、组件从未接线的空接线缺陷。现改为前端收敛（`filterByKindResult`）：下拉只列出**当前数据里真实出现过**的分类与结果（全部 14 类中多数在本机永远不会出现，列出来只会让人选中"永远为空"的选项），并强制保留当前选中项，避免「选中了却在下拉里找不到」；统计徽章与分组随之反映筛选结果
- 📊 **同步历史改用设计系统数据表 + 顶部统计摘要**：该表此前用字符串 class `sync-history-table`（全仓唯一字面量，且**无任何 CSS 规则**，等同于裸表格）。现改用 `.dataTable/.tableFixed/.tableCompact`（限高内滚 + 固定列宽），并在表头新增统计摘要徽章行（总数 / 快照 / 自动同步 / 失败 / 跳过，**失败与跳过仅在存在时出现**并给语义色）；快照 UUID 中段省略、保留头尾区分信息（悬停仍给全文），时间列等宽 11px 单行显示、悬停给出**含秒**的完整本地时间；自动同步的跳过原因独立成第二行小字，状态徽章带语义色
- 🧹 **「建议依据」去重**：迁移前咨询卡的建议依据是各维度问题文案的直接拼接，同一句可能被重复 push 多次（如「存在需注意的迁移项」按迁移项逐条 push）。现按**原文**去重并保持首次出现顺序，重复项以「×N」标注，空串与纯空白条目丢弃（刻意不做 trim 合并、不做大小写折叠，避免把不同内容误并）
- 📄 **长配置明细不再横向溢出**：导入冲突的「配置更改明细」原用 `<pre>`（`white-space: pre` 不换行），长 JSON 会把卡片撑出左右滚动条。现拆成 `current` / `imported` 两段各自独占一行、中间以 1px 分割线区隔，长值任意位置折行
- 🪟 **导出预览改为弹窗 + 分区构成共用组件**：预览结果由行内横幅改为宽弹窗（加载 / 合计 / 分区构成 / 错误都在弹窗内呈现，点击立即打开不再等待），并与总览页共用新的 `SectionComposition` 分区构成网格，两处视觉与文案完全一致
- 📋 **备份计划卡信息分层**：改为「头部（标题 / 结果徽章 / 动作）→ 事实行（开关状态 / 备份间隔 / 上次运行）→ 说明 → 设置行」。事实行统一取**宿主权威值**，未保存的草稿不再改写它，避免把尚未生效的档位显示成已生效；关闭定时备份时隐藏间隔与时刻下拉，减少无关噪音
- 📐 **布局回归修复（含暗色主题下的突兀色块）**：`.input/.select` 移除全局 `width:100%`（市场筛选、同步快照下拉等**行内**控件曾被撑成各自独占一整行），满宽只在纵向字段内按需生效；`.shellNav` 不再铺底色（暗色下其底色比宿主设置面板底色更暗，会形成一条通栏色块）；弹窗尺寸放大以容纳长内容；新增 `.actionRowTop/.tabRow/.headRow/.authorRow` 行原语，把「行」的语义与间距集中到 CSS，不再各处内联 margin；市场筛选改为 2 列网格
- 🐛 **修复备份页选中行高亮丢失**：快照列表行原本带 `data-selected` 提供选中淡底，随本轮重构被误删，导致 listbox 选中态**只剩语义（`aria-selected`）没有视觉反馈**。已恢复

### Highlights (en)

> This release is a self-driven UI polish and defect-fix round and **does not address any newly filed issue** (the #27-#30 fixes shipped in v0.1.57).

- 🧭 **History category filtering works for the first time**: the backend query contract (`filterToQuery`) was implemented and fully unit-tested, but the history panel never passed the filter to the backend (`list()` took no arguments), so the kind / result dropdowns **could be changed without affecting the list at all** — a pure function written and tested, yet never wired up. Filtering is now applied on the client (`filterByKindResult`); the dropdowns list only the kinds and results that **actually occur in the current data** (most of the 14 kinds never occur on a given machine, and offering them only lets you pick an option that is always empty), the current selection is always kept in the list, and the summary badges and grouping follow the filtered set
- 📊 **Sync history now uses the design-system data table, with a header summary**: the table previously used the string class `sync-history-table` (the only such literal in the repo, and it had **no CSS rules at all** — effectively a bare table). It now uses `.dataTable/.tableFixed/.tableCompact` (height-capped inner scroll with fixed column widths), and gains a summary badge row in the header (total / snapshots / auto sync / failed / skipped, where **failed and skipped appear only when non-zero** and carry semantic colours); snapshot UUIDs are middle-ellipsized so the distinguishing tail survives (the full value stays in the tooltip), timestamps render as a single line of 11px monospace with the **second-precision** local time on hover, and the auto-sync skip reason moves to its own second line with a colour-coded status badge
- 🧹 **"Reasons" de-duplication**: the pre-migration consult card builds its reasons by concatenating dimension issue messages, so the same sentence could be pushed repeatedly (e.g. "there are migration items to review", pushed once per item). Reasons are now de-duplicated **literally**, keeping first-appearance order, with repeats labelled "×N" and empty or whitespace-only entries dropped (deliberately no trim-merging and no case folding, which would merge genuinely different content)
- 📄 **Long conflict details no longer overflow horizontally**: the import conflict "configuration change detail" used a `<pre>` (`white-space: pre`, no wrapping), so a long JSON blob forced a horizontal scrollbar. It is now split into `current` and `imported` lines separated by a 1px rule, wrapping anywhere
- 🪟 **Export preview is now a dialog, sharing the section-composition component**: the preview moved from an inline banner to a wide dialog (loading / totals / section breakdown / errors all render inside it, opening immediately instead of waiting), and it now shares the new `SectionComposition` grid with the overview page so both render identically
- 📋 **Backup schedule card re-layered**: header (title / result badge / actions) → fact rows (enabled state / interval / last run) → notes → settings. The fact rows always read the **host-authoritative** values, so unsaved drafts no longer rewrite them (previously an unsaved interval could appear to be in effect); interval and time dropdowns are hidden while scheduled backup is off
- 📐 **Layout regression fixes (including a dark-theme colour block)**: `.input/.select` no longer default to `width: 100%` (inline controls such as the market filters and the sync snapshot picker were each being stretched onto their own full-width row) — full width now applies only inside vertical field containers; `.shellNav` no longer paints a background (in dark themes its colour is *darker* than the host settings panel, producing a full-width slab); dialogs were enlarged for long content; new row primitives `.actionRowTop/.tabRow/.headRow/.authorRow` centralise row semantics and spacing in CSS instead of scattered inline margins; the market filters became a two-column grid
- 🐛 **Fixed the lost selected-row highlight on the backup page**: snapshot rows carried `data-selected` for their selected tint, which was dropped during this refactor, leaving the listbox selection with **semantics (`aria-selected`) but no visual feedback**. Restored

## [v0.1.57] - 2026-09-11

### 🎯 亮点 / Highlights (zh)

- 🌐 **出站请求现支持代理**（issue #30）：GitHub 登录与市场/同步请求不再受「必须经代理访问 GitHub」的网络限制。插件现在自行读取 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` 并让**自身**出站经代理（`https` 目标走 `CONNECT` 隧道 + TLS，`http` 目标走 absolute-form），覆盖 GitHub API、device flow 登录与 WebDAV 同步三条路径 —— 此前 Node 内置 fetch 默认不读代理变量，导致 device flow 报 `fetch failed`、`/me/status` 返回 500。**未配置代理时行为完全不变**；代理凭据绝不进日志；可用 `DSH_CONFIG_MANAGER_PROXY=off` 强制直连。相比 `NODE_USE_ENV_PROXY` 的进程级开关，本实现**只影响插件自身**，不会改变宿主（含模型 API）的出站行为，也不要求 Node ≥ 24.14
- 🔓 **未配置 token 不再报「登录状态读取失败」**（issue #29）：首次使用（credentials 中尚无同步 token）时「我的配置」会误报错误横幅。现在「未配置 token」与「token 失效（401）」统一视为**未登录**，正常显示「未登录 + 使用 GitHub 登录」；而网络/限流等**真实故障仍如实报错**，不会被伪装成未登录
- 🔧 **残留环境锁可识别、可恢复**（issue #27）：进程被强制结束（任务管理器 / `kill -9`）后留下的环境锁此前与「另一任务运行中」共用同一句「请稍后重试」，但残留锁**永远不会自愈**，导致上传/同步持续失败且无从下手。现在残留锁单独提示「重试或重启 DSH 均无效」并给出恢复方式；`recover-stale-lock` 命令补进 `--help` 与 README（此前是隐藏命令）；自动同步被挡时也会写出同样的可操作指引。**恢复策略不变**：仍只在持有者被确证死亡时回收，绝不自动摘活锁
- 🩺 **插件清单来源可自查**（issue #28）：在「关于」页新增「插件清单来源」诊断位，显示清单**实际读取的目录 / profile 名 / 识别到的插件数量**；当该目录读不到 `package.json` 时会明确告警。用于定位「明明装了插件、备份里却识别不到」（profile 或 `DSH_HOME` 与实际不符）
- ✨ **界面全面翻新（Visual Polish）**：统一图标（Lucide）与弹窗（Radix Dialog，含完整 focus trap / Esc / 焦点还原）、新增 Toast 通知；顶部页签条与底部状态栏改为圆角分段条；概览页指标可**精确跳转**到对应子视图，健康段在存在待处理恢复事项时直达「事故恢复」；移除常驻冗余绿灯提示。视觉仍 100% 走 DSH `--dsw-*` token，不引入第二套视觉体系

### Highlights (en)

- 🌐 **Proxy support for outbound requests** (issue #30): GitHub sign-in and market/sync requests no longer break on networks where GitHub is reachable only through a proxy. The plugin now reads `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` for **its own** egress (`https` via `CONNECT` tunnelling + TLS, `http` via absolute-form), covering the GitHub API, the device-flow login and WebDAV sync — Node's built-in `fetch` ignores proxy variables, which previously produced `fetch failed` on device flow and HTTP 500 on `/me/status`. **No behaviour change when no proxy is configured**; proxy credentials are never logged; `DSH_CONFIG_MANAGER_PROXY=off` forces direct connections. Unlike the process-wide `NODE_USE_ENV_PROXY`, this affects **only the plugin**, leaving host egress (including model API calls) untouched, and does not require Node ≥ 24.14
- 🔓 **Missing token no longer shows "failed to read sign-in status"** (issue #29): on a fresh setup (no sync token in credentials) "My Configs" wrongly rendered an error banner. "No token" and "token rejected (401)" are now treated alike as **not signed in**, showing "Not signed in + Sign in with GitHub", while genuine failures (network / rate limit) still surface as real errors instead of being disguised as a sign-out
- 🔧 **Leftover environment locks are now identifiable and recoverable** (issue #27): after a force-killed process (Task Manager / `kill -9`) the leftover lock shared the generic "please retry later" message with a genuinely busy lock — yet a leftover lock **never clears by itself**, so uploads/syncs kept failing with no way forward. It now reports that retrying or restarting won't help and points at the fix; `recover-stale-lock` is documented in `--help` and the README (it used to be a hidden command); autosync logs the same actionable hint. **Recovery policy is unchanged**: a lock is still reclaimed only when its owner is proven dead — a live lock is never taken over
- 🩺 **Self-service diagnostics for the plugin list** (issue #28): the About page now shows which directory / profile the plugin list was actually read from and how many plugins were detected, with an explicit warning when `package.json` cannot be read — pinpointing "plugins installed but missing from the backup" (a mismatched profile or `DSH_HOME`)
- ✨ **Full UI refresh (Visual Polish)**: unified icons (Lucide) and dialogs (Radix Dialog with proper focus trap / Esc / focus restore), new toast notifications; the top tab strip and bottom status bar became rounded segmented bars; overview metrics now deep-link to the matching sub-view and the health segment jumps straight to "Incident recovery" when recovery items are pending; the redundant always-on green banner was removed. Styling still uses DSH `--dsw-*` tokens exclusively — no second visual system

## [v0.1.56] - 2026-09-03

### 🎯 亮点 / Highlights (zh)

- 🔄 **WebDAV 自动跟随重定向**：同步通道现可自动跟随 301/302/303/307/308 跳转（上限 5 跳）——修复 123pan 等网盘 WebDAV 把下载 GET 302 到带时效签名 CDN 直链导致 list/push/pull 全部失败的问题（issue #25）；跨域跳转自动剥离 Authorization（Basic 凭据不会转发给 CDN 第三方域名），303 且非 GET 时按语义降级为 GET；跳转循环给出清晰报错
- ✏️ **WebDAV 配置弹窗文案修正**：服务器地址帮助文案由过时的 `snapshots/` 子目录更新为实际的 `dsh-config-manager/` 子目录，与 v0.1.55 起的远端存储路径一致

### Highlights (en)

- 🔄 **WebDAV redirect following**: the sync channel now follows 301/302/303/307/308 redirects (up to 5 hops) — fixing syncs that fail entirely on pan-drive WebDAV servers (e.g. 123pan) which redirect download GETs to time-signed CDN direct links (issue #25); cross-origin hops strip `Authorization` so Basic credentials never leak to third-party CDN domains, 303 downgrades non-GET methods to GET per spec, and redirect loops now surface a clear error
- ✏️ **WebDAV setup copy fix**: the server-URL help text now mentions the actual `dsh-config-manager/` subdirectory instead of the stale `snapshots/`, matching the remote storage layout since v0.1.55

## [v0.1.55] - 2026-09-02

### 🎯 亮点 / Highlights (zh)

- 🔄 **WebDAV 同步存储路径变更**：远程快照目录由 `snapshots` 改为 `dsh-config-manager`。**升级注意**：如需保留坚果云（WebDAV）上之前的历史同步数据，请登录坚果云网页版，将原有的 `snapshots` 文件夹重命名为 `dsh-config-manager`，升级新版本后即可直接读取；如无需保留旧历史，新版本会自动在 `dsh-config-manager` 路径下重建索引与快照
- 🌐 **WebDAV 请求改用原生 `node:http/https`**：更可靠地支持 MKCOL/PROPFIND 等全部 WebDAV 方法，并携带准确的 `Content-Length` 与 `User-Agent`，解决部分 WebDAV 服务器对 fetch 兼容性问题导致的同步失败
- 📘 **新增「版本更新内容」弹窗**：打开插件时自动检查 GitHub Releases，检测到新版本即弹出更新说明，支持「永不提示」；也可在「关于」页手动查看全部版本记录
- 🧹 **仓库整理**：移除历史 Phase 设计文档与冗余重复文件（`dsh.bundle.patch` / `dsh.client`），源码与既有功能不变
- 🆕 **兼容 DSH Alpha 版本**：插件现可运行于 DSH 稳定版（`0.1.1`）与 Alpha 版（`0.1.2-alpha.x`）——Settings 命名空间与凭据引用 API 的转换器同时适配两种 DSH 接口，DSH 版本解析亦支持 `-rc` / `-alpha` 预发布后缀

### Highlights (en)

- 🔄 **WebDAV sync storage path changed**: the remote snapshot directory is now `dsh-config-manager` (previously `snapshots`). **Upgrade note**: to keep your existing Nutstore (WebDAV) history, sign in to the Nutstore web app and rename the old `snapshots` folder to `dsh-config-manager`; the new version reads it directly after upgrading. If you do not need the old history, the new version will rebuild the index and snapshots under `dsh-config-manager` automatically
- 🌐 **WebDAV requests now use native `node:http/https`**: full WebDAV method support (MKCOL / PROPFIND / …) with accurate `Content-Length` and `User-Agent`, fixing sync failures on servers that have fetch-compatibility issues
- 📘 **New "Release Notes" dialog**: on opening the plugin it checks GitHub Releases and shows the update notes when a new version is available, with a "Don't show again" option; all versions can still be reviewed manually on the About page
- 🧹 **Repo cleanup**: removed old phase design documents and redundant duplicate files (`dsh.bundle.patch` / `dsh.client`); source code and existing behavior are unchanged
- 🆕 **Compatible with DSH Alpha releases**: the plugin now runs on both DSH stable (`0.1.1`) and alpha (`0.1.2-alpha.x`) — the settings namespace and credential ref API converters adapt to both DSH interfaces, and DSH version parsing handles `-rc` / `-alpha` prerelease suffixes

## [v0.1.54] - 2026-08-25

### 🎯 亮点 / Highlights (zh)

- 🗂️ **导出与导入合并为单一 tab**：顶层 tab 由「导出备份 / 导入恢复」两个合并为「**导出与导入**」，内部用子 tab 切换——导航更紧凑，切 tab/刷新状态照常保留；同时「配置文件」tab 移到「关于」之前
- ✏️ **自定义文件名自动补全 `.zip`**：导出时无需手动输入 `.zip` 后缀（失焦/提交自动补全），校验只针对文件名本体；若与已有备份同名则**自动追加数字后缀**（`foo.zip` → `foo-1.zip` → `foo-2.zip`），不再覆盖之前的备份文件
- 🔍 **备份查看/对比变更明细分组 + 颜色**：冲突（红）/ 变更（蓝）/ 路径映射（黄）/ 已一致（绿）/ 其他 分组展示，组内 kindTag 同色——一眼区分「需决策 / 将写入 / 需处理 / 无需处理」；配置档案切换预览同步为同结构（差异摘要 + 分区清单 + 变更明细分组）
- 🪟 **快照恢复计划预览改为弹窗**：点击快照行 → dry-run 完成后自动弹出恢复计划（与备份文件「查看/对比」同弹窗体系），弹窗内执行恢复仍走二次确认；关闭后可随时重开
- 🖱️ **修复多处横向滚动条**：备份备注过长自动换行不再撑破行；快照列可收缩 + 单元格 ellipsis（置顶/长文件名不再撑宽）；配置档案列表列数据与表头对齐
- 📘 **关于页 CLI 卡补充 `dsh-config-manager help`** 命令（离线列出全部 CLI 用法）

### Highlights (en)

- 🗂️ **Export & Import merged into one tab**: the top-level tabs "Export" and "Import" are merged into a single **Export & Import** tab with inner sub-tabs — tighter navigation, tab/refresh state preserved as before; the Profiles tab also moves before About
- ✏️ **Custom file name auto-appends `.zip`**: no need to type `.zip` on export (auto-appended on blur/submit; validation targets the bare name); if a backup with the same name exists the export **auto-appends a numeric suffix** (`foo.zip` → `foo-1.zip` → `foo-2.zip`) instead of overwriting
- 🔍 **Backup inspect change list grouped + color-coded**: conflicts (red) / changes (blue) / path mappings (amber) / identical skipped (green) / others, with matching kindTag colors per group — see at a glance what needs a decision / will apply / needs handling / needs nothing; the profile-switch preview now mirrors the same structure (diff summary + section list + grouped changes)
- 🪟 **Snapshot restore plan preview in a dialog**: clicking a snapshot row opens the restore plan in the same dialog system as "Inspect / Compare" after dry-run; executing still goes through a second confirm; reopen anytime after closing
- 🖱️ **Various horizontal-scrollbar fixes**: long backup notes wrap instead of widening rows; snapshot columns shrink with cell ellipsis (pin/long filenames no longer widen); profile list columns align with their headers
- 📘 **About CLI card adds `dsh-config-manager help`** (offline command overview)

## [v0.1.53] - 2026-08-24

### 🎯 亮点 / Highlights (zh)

- ✨ **「我的配置」上传/更新免手动点「校验」**：选完 zip 即**自动**执行本地校验（analyzeImport dry-run，无密钥 + 内容合法才放行），通过后直接进入表单页——不再需要先点一次「校验」按钮再点「一键上传」；校验失败停留在校验步骤展示错误并可重新选择 zip（上传与更新两种模式行为一致）

### Highlights (en)

- ✨ **"My Configs" upload/update validates automatically**: after picking a zip, validation (analyzeImport dry-run; no secrets + valid content required) runs automatically and jumps straight to the form on success — no more clicking a separate "validate" button before the one-click publish; on failure it stays on the validate step showing the error with a reselect option (same behavior for both upload and update modes)

## [v0.1.52] - 2026-08-24

### 🎯 亮点 / Highlights (zh)

- 🐛 **修复 git 通道空文件分区同步失败**：当某文件类分区（skills / agentPresets / agentInstructions 等）为空时，`git` 不跟踪空目录导致上传后 `custom/skills/` 等目录在远端仓库丢失，另一台机器全新 clone 后一键同步报「快照缺少文件分区目录 custom/skills/（skills）」——现在上传方（`GitTransport.upload`）给空文件类分区目录写入 `.gitkeep` 占位文件保证远端保留目录，读回时按「文件名 + 内容」双重匹配过滤（不吞用户真实同名文件）；同时 `GitTransport.download` 对旧版插件上传的无占位快照宽容降级（目录缺失 = 空分区，git 提交原子性保证非空目录不会缺失），历史快照也能正常拉取
- 🧩 **市场校验放行空文件分区**：`validateMarketItem` 此前把「manifest 声明 skills=true 但 ZIP 无 `custom/skills/` 条目」判为 invalid（「config.zip 缺少文件分区 skills」），导致未安装 skills 的机器「一键上传」被拒——空文件分区是合法状态（导入侧 `analyzer.extractSections` 对空分区收集空 files、零操作零报错，与 sync 空分区语义一致），现改为仅追加「分区为空」warning 不拒绝；JSON 分区与禁止分区（sessions/pluginFiles/self）仍严格校验

### Highlights (en)

- 🐛 **Fix git-channel sync failure on empty file sections**: when a file section (skills / agentPresets / agentInstructions / …) is empty, git does not track empty directories, so `custom/skills/` etc. vanished from the remote repo after upload and a fresh clone on another machine failed one-click sync with "快照缺少文件分区目录 custom/skills/（skills）" — the uploader (`GitTransport.upload`) now writes a `.gitkeep` placeholder into empty file-section dirs so the remote keeps them, and reads filter it out by name + content (real same-named user files survive); `GitTransport.download` also degrades gracefully for legacy snapshots uploaded without placeholders (a missing dir means an empty section, since git commits are atomic, a non-empty dir can never be missing), so historical snapshots pull fine
- 🧩 **Market validation now accepts empty file sections**: `validateMarketItem` used to reject "manifest declares skills=true but the ZIP has no `custom/skills/` entries" as invalid ("config.zip 缺少文件分区 skills"), which blocked one-click publishing from machines without skills installed — an empty file section is a legitimate state (the importer's `analyzer.extractSections` collects empty files and does nothing, matching the sync channel's empty-section semantics), so it now only appends an "empty section" warning instead of rejecting; JSON sections and banned sections (sessions/pluginFiles/self) stay strictly validated

## [v0.1.51] - 2026-08-24

### 🎯 亮点 / Highlights (zh)

- 🗂️ **快照面板拆分为二级 tab + 一级 tab 更名「备份与快照」**：原先「快照恢复」面板把三类功能挤在一页（快照深度恢复 / 备份文件管理 / 定时备份设置），概念易混淆——现拆为两个清晰的二级 tab：**「快照恢复」**（导入前回滚点列表 → dry-run 计划 → 执行恢复 → 报告，功能原样保留）与**「备份文件」**（导出产物列表：下载 / 一键导入 / 删除 + 定时全量备份设置，联动「立即备份」自动刷新）；一级 tab 由「快照」更名「备份与快照」提示双功能域
- 🔄 **二级 tab 状态持久化**：`SnapshotsStoreSlice.subTab`（restore / files）镜像 runStore——切一级 tab / 刷新均保留上次选择，旧版载荷自动回退「快照恢复」；复用既有 `modeTabs` 模式，零新增样式、零 host 路由改动（纯 UI 重组）

### Highlights (en)

- 🗂️ **Snapshots panel split into sub-tabs, top-level tab renamed "Backup & Snapshots"**: the old "Snapshot Restore" panel crammed three feature areas onto one page (deep snapshot restore / backup-file management / scheduled-backup settings), which blurred their concepts — it is now two clear sub-tabs: **Snapshot Restore** (pre-import rollback points → dry-run plan → execute → report, unchanged) and **Backup Files** (export artifacts: download / one-click import / delete + scheduled full-backup settings, with the list auto-refreshing after "Back up now"); the top-level tab was renamed from "Snapshots" to "Backup & Snapshots" to signal both domains
- 🔄 **Sub-tab state persists**: `SnapshotsStoreSlice.subTab` (restore / files) is mirrored into runStore — the last selection survives tab switches and refresh, and legacy payloads fall back to "Snapshot Restore"; it reuses the existing `modeTabs` pattern with zero new styles and zero host-route changes (pure UI reorganization)

## [v0.1.50] - 2026-08-24

### 🎯 亮点 / Highlights (zh)

- 📁 **快照面板新增「备份文件」管理**：此前定时备份与手动导出的 ZIP 都躺在 `exports/` 目录、GUI 无任何入口可见——现在快照恢复面板统一列出全部导出产物（文件名 + 来源徽章「定时备份 / 手动导出」+ 大小 + 时间），支持**下载**（复用 `/download`）、**一键导入**（切到导入向导直接分析该备份，跳过上传）、**删除**（二次确认弹窗）；顺带修复了「手动导出的文件也无处查看」的老缺口
- 🧹 **定时备份保留最近 10 个**：定时备份产物改用独立前缀 `dsh-config-auto-`（来源标识 + 清理依据），每次成功备份后自动清理超出 10 个的旧文件；cache-cleaner 的 exports 7 天回收**豁免 auto 前缀**——定时备份生命周期由保留策略管理，不再与「按天回收」相互截断；手动导出文件不自动删（仍按 7 天回收）
- 🛡️ **新路由全过 loopback fence**：新增 `GET /backup-files`（列表）与 `POST /backup-files/delete`（删除，服务端文件名防穿越校验），与全仓一致每个方法分支都过 guard
- 🔁 **一键导入状态为一次性瞬态**：`SnapshotsStoreSlice.importBackup`（zipPath + 文件名）随 `view` 切换传给导入向导，消费后立即清空、sessionStorage 白名单剔除、刷新不重放

### Highlights (en)

- 📁 **"Backup Files" management in the snapshot panel**: scheduled backups and manual exports used to sit in `exports/` with no GUI entry — the snapshot restore panel now lists every export artifact (file name + source badge "Scheduled / Manual" + size + time) with **download** (reuses `/download`), **one-click import** (jumps into the import wizard and analyzes that backup directly, no re-upload) and **delete** (confirmed via dialog); this also closes the old gap where manually exported files had no UI to view them
- 🧹 **Scheduled backups keep the latest 10**: scheduled artifacts now use a dedicated `dsh-config-auto-` prefix (source marker + cleanup key), pruning older files past 10 after every successful run; the cache-cleaner's 7-day exports sweep **exempts the auto prefix** so scheduled-backup lifecycle is owned by the retention policy instead of fighting the day-based sweep; manual exports are never auto-deleted (still recycled after 7 days)
- 🛡️ **New routes pass the loopback fence**: `GET /backup-files` (list) and `POST /backup-files/delete` (delete with server-side filename traversal guard) both go through `guard` on every method branch, like the rest of the codebase
- 🔁 **One-click import is a one-shot transient**: `SnapshotsStoreSlice.importBackup` (zipPath + name) is passed to the import wizard along with the view switch, cleared right after consumption, stripped from the sessionStorage whitelist, and never replayed on refresh

## [v0.1.49] - 2026-08-24

### 🎯 亮点 / Highlights (zh)

- 🛟 **快照恢复进度可视化 + 宿主侧权威防重**：`/restore` 真实执行（dryRun=false）经 RunRegistry 登记 `restore` run —— 同 kind 已有 running 时返回 409 拒绝重复恢复（前端 loading 只是 UX，宿主锁才是正确性保障；不同快照并发恢复会交错写文件、同快照并发会互相覆盖 pre-restore 双保险备份，都是真实数据风险）；每执行一个恢复动作经 `onAction` 埋点更新 `/progress`，前端 `watchRunning('restore')` 轮询 + `/runs` 刷新恢复，刷新期间恢复仍在进行则自动回到 running 并回填报告；`SnapshotsStoreSlice.running` 为瞬态镜像——白名单剔除、applyPersisted 硬性归零、以宿主 `/runs` 为权威，不把浏览器陈旧状态当成恢复执行中的依据
- 📜 **导入执行日志冻结修复（500 行封顶不再冻结）**：`RunRegistry.appendLog` 改为**不可变追加**（每次换新数组引用，行数封顶后长度恒定但引用必变），`ImportLogPanel` memo 改以「数组引用 + t 引用」比较——引用未变跳过重渲染、引用已变（含封顶后）必重渲染，杜绝「优化导致日志冻结」；新增**智能自动滚动**：仅当用户贴近底部时跟随最新行，用户上滚查看历史时不强制拉回，改在 `logHeader` 显示「↓ 新输出」胶囊按钮（`logJumpButton`，ghost 语义），点击跳回底部并恢复跟随
- 🏷️ **导入 runId 即时同步**：`watchRunning` 发现活跃 import run 时立即把 runId 写入 store（此前 `/execute` 响应在整段导入完成后才带 runId，fresh run 期间「跳过当前插件」会打到上一次导入的陈旧 runId）
- 🔒 **backup-schedule 路由补全 loopback fence**：GET/PUT `/backup-schedule` 与 POST `/backup-schedule/run` 此前漏 `guard`（loopback 守卫），本次统一补齐——远程调用方不得触发宿主写盘操作，全仓 45+ 路由均过 fence
- 🧹 附带：`BackupScheduleCard` 增加挂载守卫（切 tab 卸载后异步回调只更新 store 草稿，不再 setState）；`restore` 完成/失败回填报告或错误到 `SnapshotsStoreSlice`（切 tab 回来可见结果）

### Highlights (en)

- 🛟 **Snapshot-restore progress + host-side dedup**: real `/restore` execution is now registered in the RunRegistry as a `restore` run — a second restore of the same kind while one is running is rejected with 409 (frontend `running` is just UX; the host lock is the correctness guarantee; concurrent restores of different snapshots interleave file writes and concurrent restores of the same snapshot clobber the pre-restore double-backup). Each action emits progress via `onAction` (`/progress` polling + `/runs` refresh-resume); `SnapshotsStoreSlice.running` is a transient mirror — stripped from persistence by the whitelist, never used as the authority for whether a restore is executing
- 📜 **Import log panel no longer freezes at the 500-line cap**: `RunRegistry.appendLog` now writes immutably (a fresh array reference per append), so `ImportLogPanel`'s memo compares array references — unchanged = skip, changed (incl. post-cap) = must re-render; plus smart auto-scroll: it only follows the latest line when you're near the bottom, otherwise shows a "↓ New output" jump button instead of yanking you down
- 🏷 **Import runId synced immediately**: `watchRunning` now writes the discovered runId into the store the moment an active import run is found (previously the `/execute` response only carried it after the whole import finished, so "skip current plugin" could target a stale runId)
- 📷 **loopback fence added to backup-schedule routes**: GET/PUT `/backup-schedule` and POST `/backup-schedule/run` were missing the `guard` (loopback-only) check; now added so remote callers cannot trigger host write operations
- 🧹 **Also**: `BackupScheduleCard` got a mount guard (callbacks after unmount only update the store draft, no `setState`), and restore completion/failure now writes the report/error back into the store slice

## [v0.1.48] - 2026-08-23

### 🎯 亮点 / Highlights (zh)

- ⏰ **定时全量备份 GUI（快照 tab）**：快照恢复面板新增「定时全量备份」设置卡——总开关 + 间隔档位（6h/12h/24h/7d）+ 上次运行状态（成功/跳过/失败 + 时间或 ZIP 名）+「保存设置」「立即备份」按钮；配置仍存 sync/backup-schedule.json（随 self 分区备份/同步迁移），保存即重排调度器、立即备份复用 runOnce（同一时刻防重）；新增 GET/PUT /backup-schedule 与 POST /backup-schedule/run 三个 host 路由 + src/ui/backup-schedule.ts 纯函数层（校验 / 状态映射 / 脏判定，node 单测 6 例）；草稿镜像 runStore（切 tab / 刷新保留未保存修改）

### Highlights (en)

- ⏰ **Scheduled full backups GUI (snapshots tab)**: the snapshot restore panel now has a "Scheduled Full Backups" settings card — enable toggle + interval (6h/12h/24h/7d) + last-run status (success/skipped/failed with time or zip name) + "Save settings" / "Back up now" buttons; config stays in sync/backup-schedule.json (migrates with the self section); saving re-schedules the scheduler and "back up now" reuses runOnce with a re-entrancy guard; three new host routes (GET/PUT /backup-schedule, POST /backup-schedule/run) plus a pure-function layer src/ui/backup-schedule.ts (validation / status mapping / dirty check, 6 node tests); draft mirrored into runStore (unsaved edits survive tab switches / refresh)

## [v0.1.47] - 2026-08-23

### 🎯 亮点 / Highlights (zh)

- 🛠️ **修复模型工具注册崩溃（v0.1.46 回归）**：安装后启动 DSH 报 `cannot get property "tools" without inject` 导致插件树加载失败——5 个 Agent 模型工具（config_backup 等）改为经 `ctx.get('tools')` 结果注册，不再做 `ctx.tools` 属性访问（Cordis 属性访问要求显式 inject，而 tools 是可选服务不应进 inject）；新增模拟真实 Cordis 守卫的回归测试

### Highlights (en)

- 🛠️ **Fix model-tool registration crash (v0.1.46 regression)**: DSH failed to boot with `cannot get property "tools" without inject` — the 5 agent tools (config_backup etc.) are now registered via the `ctx.get('tools')` result instead of `ctx.tools` property access (Cordis property access requires explicit inject; tools is an optional service and must not be injected); regression test simulating the real Cordis guard added

## [v0.1.46] - 2026-08-23

### 🎯 亮点 / Highlights (zh)

- ⏰ **定时备份调度器**：设置 6 小时 / 12 小时 / 24 小时 / 7 天的固定节奏，DSH 在后台静默产出完整备份——secrets 从不包含，磁盘上无需密码也安全；README 双语宣传同步
- 🔒 **Vault 文件级脱敏**：导出（不含 secrets 模式）时把 `.credentials.yaml` 等敏感文件移入 `dataDir/vault` 并在报告标注刷新动作——备份文件里不再残留凭据明文
- 🧹 **Ghost-sweep 幽灵清扫**：检测备份中「已不存在于宿主」的幽灵条目并提示清理；宿主无归档 API 时降级为本地校验
- 🗑️ **Tombstone 删除记录**：删除动作以 tombstone 记录进同步流，导入时按记录跳过已删除项，报告标注「已按删除记录跳过 N 项」
- ☁️ **WebDAV 快照级跳过**：内容未变的快照自动跳过（`sectionsEqual` 比对），不再重复传输整包；加密快照始终上传（密文不可比对）
- 🕵️ **Secret-scanner 个人化扩展**：新增 `extraValuePatterns` 与 `createConfiguredSecretScanner`，可从插件配置注入自定义敏感值模式
- 🛒 **市场共享模式**：prepare 增加保守档拦截与 deviceSpecific 分区拒绝（机型相关配置不共享），服务端 / UI 全程透传 mode
- 🧪 **架构与 schema 兼容测试**：`architecture-boundaries` 固化分层边界（KNOWN_VIOLATIONS 例外表）；`schema-compat` 固化 manifest 兼容策略（拒绝未来版本、未知字段保留）
- 🚀 **导入体验**：进度条下方实时命令日志面板（RunRegistry 轮询、刷新不丢）；导入中可跳过当前插件（彻底清理半装状态）；结果页支持重试失败 / 跳过的子集

### Highlights (en)

- ⏰ **Scheduled full backups**: pick a fixed cadence (6h / 12h / 24h / 7d) and DSH quietly keeps a fresh full backup in the background — secrets are never included, so it stays safe on disk without a password; bilingual README updated
- 🔒 **File-level vault redaction**: exporting without secrets moves sensitive files (e.g. `.credentials.yaml`) into `dataDir/vault` and flags the refresh in the report — no plaintext credentials left in backup archives
- 🧹 **Ghost-sweep**: detects and flags backup entries that no longer exist on the host (local-validation fallback when the host exposes no archive API)
- 🗑️ **Tombstone deletions**: deletes are recorded as tombstones in the sync stream; import skips deleted items and reports "skipped N items per delete records"
- ☁️ **WebDAV snapshot-level skip**: unchanged snapshots are skipped via `sectionsEqual` — no more re-uploading whole archives; encrypted snapshots always upload (ciphertext cannot be compared)
- 🕵️ **Personalized secret scanning**: `extraValuePatterns` + `createConfiguredSecretScanner` let you inject custom sensitive-value patterns from plugin config
- 🛒 **Market share mode**: prepare adds a conservative-mode gate and rejects device-specific sections (no machine-bound config sharing); mode is threaded through server & UI
- 🧪 **Architecture & schema-compat tests**: `architecture-boundaries` locks layer boundaries (KNOWN_VIOLATIONS exception table); `schema-compat` locks manifest compatibility (future versions rejected, unknown fields preserved)
- 🚀 **Import experience**: live command-log panel under the progress bar (RunRegistry polling, survives refresh); skip the current plugin mid-import (half-installed state fully cleaned); retry failed/skipped subsets from the results page

## [v0.1.45] - 2026-08-21

### 🎯 亮点 / Highlights (zh)

- 🧹 **安装命令简化**：README / DEVELOPERS 的安装命令统一为 `dsh plugin --profile web add dsh-config-manager@latest`，移除 `--config.auto-install-peers=false` 后缀——照着复制即可，无需再关心 peer 解析参数
- 🛒 **README 配置市场描述上线**：两个 README（中英镜像）新增配置市场完整描述——首屏亮点 + Use Cases + 核心亮点表格 + 功能详解小节（内置官方市场 / 搜索筛选排序 / 供应链警示恒展示 + 逐分区批准 / 安装复用安全导入管道 / 「我的配置」一键上传到自有仓库 + 自动收录 PR）；功能截图新增 `assets/screenshot-market.png`
- 🎨 **市场「我的配置」上传向导打磨**：改为三步式（选文件 → 本地校验 → 精简表单，仅 name / description / categories，其余系统自动）；更新模式支持页内换新 ZIP 并自动校验；详情视图 JSX 结构调整

### Highlights (en)

- 🧹 **Simplified install command**: README / DEVELOPERS now use `dsh plugin --profile web add dsh-config-manager@latest` — the `--config.auto-install-peers=false` suffix is gone, so users can just copy-paste
- 🛒 **Marketplace docs shipped**: both READMEs (en + zh mirror) now fully describe the config marketplace — hero bullet, Use Cases, highlights table and a dedicated feature section (built-in official market / search, filter & sort / always-on supply-chain warnings + per-section approval / install reuses the safe import pipeline / "My Configs" one-click upload to your own repo with auto listing PR); new `assets/screenshot-market.png` added to the screenshots
- 🎨 **Marketplace "My Configs" upload wizard polished**: now a three-step flow (pick file → local dry-run validation → slim form with only name / description / categories, the rest auto-filled); update mode lets you swap in a new ZIP inline with auto-validation; detail view JSX restructured

## [v0.1.44] - 2026-08-21

### 🎯 亮点 / Highlights (zh)

- 🔍 **AI 搜索曝光优化（SEO/AEO）**：README 首屏副标题改为「DeepSeek Harness Backup, Restore & Migration Plugin」，一句话价值主张覆盖 backup / restore / export / import / migrate / sync / plugins / MCP / skills 等全部高频搜索词；新增「Use Cases」小节（Backup / Restore / Migrate / Sync 四组自然语言场景，中文版同步镜像「典型使用场景」），让 AI 搜索直接命中句子即可召回
- 🧹 **npm description 修复**：清除双重编码乱码（`â€”`）与残留内部备注，重写为关键词密集的自然描述，末尾补充中文简介；keywords 由 7 个扩至 17 个（新增 dsh-plugin / restore / export / import / migrate / sync / webdav / mcp / skills / configuration）
- 📄 **新增 AI 搜索曝光审计文档**：`docs/seo/2026-08-21-ai-search-exposure-audit.md`——生态收录现状盘点（DSH Get / dshplugins.cc / DSH 插件商店 / awesome-dsh-plugins 全部收录）+ GitHub Description / Topics 建议值 + 后续优化清单

### Highlights (en)

- 🔍 **AI search exposure optimization (SEO/AEO)**: README opening now reads "DeepSeek Harness Backup, Restore & Migration Plugin" with a value proposition covering backup / restore / export / import / migrate / sync / plugins / MCP / skills and more; a new "Use Cases" section (Backup / Restore / Migrate / Sync natural-language scenarios; Chinese mirror added) lets AI search hit the exact sentences
- 🧹 **npm description fixed**: removed a double-encoded mojibake (`â€”`) and a leftover internal note; rewrote a keyword-rich, natural description with a short Chinese intro; keywords expanded from 7 to 17 (added dsh-plugin / restore / export / import / migrate / sync / webdav / mcp / skills / configuration)
- 📄 **AI search exposure audit doc added**: `docs/seo/2026-08-21-ai-search-exposure-audit.md` — ecosystem listing review (indexed by DSH Get / dshplugins.cc / DSH plugin store / awesome-dsh-plugins) + recommended GitHub Description / Topics + follow-up checklist

## [v0.1.43] - 2026-08-22

### 🎯 亮点 / Highlights (zh)

- 📐 **弹窗正文间距统一**：确认弹窗（`dialogBody`）与同步通道配置弹窗（`dialogBodyScroll`）的正文改为 flex 纵向排布 + 统一 10px 间距——message 与自定义内容、表单内的 tab/Banner/字段/操作行不再紧贴，视觉节奏与页面视图一致；纯视觉微调，无行为 / 交互 / API 变化，`DESIGN.md` 同步更新

### Highlights (en)

- 📐 **Unified dialog body spacing**: confirm dialog (`dialogBody`) and sync channel config dialog (`dialogBodyScroll`) bodies now use a flex column layout with a consistent 10px gap — messages, custom content, and form blocks (tabs/banners/fields/actions/hints) no longer collide, matching the page views' vertical rhythm; purely visual, no behavioral / API change; `DESIGN.md` updated accordingly

## [v0.1.42] - 2026-08-21

### 🎯 亮点 / Highlights (zh)

- ⭐ **市场页仓库级 Star 展示**：市场浏览列表每个条目新增「⭐ N」徽章，显示其**来源仓库**的 star 数（官方条目 = 官方市场仓库统一数字；第三方条目 = 作者自托管 `dsh-configs` 仓库），并标注「来源仓库」避免误解；「我的配置」页同步显示自己配置仓库的 star
- 🔍 **来源筛选下拉框**：市场工具栏新增「全部来源 / 官方配置 / 个人配置」筛选，selected 状态随 store 持久化（切 tab / 刷新不丢）
- 🔃 **排序下拉框**：新增「默认 / 最新更新 / ⭐ 最多 / 名称 A–Z」四种排序（升/降与 undefined 值规则确定且稳定）
- 🔒 **零凭据 star 查询**：浏览端点一律**匿名**查询 GitHub（`/repos/{owner}/{repo}`），按仓库 URL 去重 + 1 小时 TTL 内存缓存 + 单仓库失败降级显示「—」，不触碰任何 token，保持市场端点「无凭据」硬不变式
- 📜 **MIT 许可证 + Issue 模板**：仓库新增 MIT `LICENSE` 与中英双语 **Bug 报告 / 功能建议** Issue 模板；npm 包 metadata 同步补齐 `license` 字段

### Highlights (en)

- ⭐ **Repo-level stars in the market**: each market item now shows a "⭐ N" badge with its **source repo** star count (official items share the official market repo's single count; community items show the author's self-hosted `dsh-configs` repo), labeled as "source repo" to avoid confusion; "My Configs" shows your own config repo's stars too
- 🔍 **Source filter dropdown**: new market filter "All / Official / Community", persisted in the store (survives tab switches / refresh)
- 🔃 **Sort dropdown**: "Default / Recently updated / Most starred / Name A–Z" with deterministic, stable ordering (missing values sort last)
- 🔒 **Credential-free star lookup**: browsing queries GitHub **anonymously** (`/repos/{owner}/{repo}`), deduped per repo URL with a 1h in-memory TTL cache and per-repo failure fallback ("—"); no token is ever touched, keeping the market endpoints' credential-free invariant
- 📜 **MIT license + issue templates**: added the MIT `LICENSE` and bilingual **bug report / feature request** issue templates; npm metadata now carries the `license` field

## [v0.1.41] - 2026-08-21

### 🎯 亮点 / Highlights (zh)

- 🧹 **缓存自动清理**：`~/.dsh/dsh-config-manager/` 下的临时文件（`tmp/` 导入/解密/同步暂存）、导出副本（`exports/`，导出时已下载到本地）、市场缓存与 git 工作副本（`market/cache/`、`market/work/`）由插件**自动清理**——DSH 启动时清理一次、此后每 24 小时清理一次，只删除超过保留期（临时文件 24 小时、导出产物与市场缓存 7 天）的条目；导入回滚快照（`snapshots/`）与同步数据（`sync/`）属用户数据/安全网，**不自动清理**
- 🗑️ **「我的配置」删除条目**：列表新增删除入口，点删除弹**确认弹窗**（遮罩/Esc/取消三途径关闭，危险操作默认焦点落取消）——已收录条目自动提交**下架 PR**（独立分支 `dsh-market-delist/<id>`），待审核条目直接关闭收录 PR；收录/下架任务**后台执行 + 状态轮询**，进程重启后仍可一键**重试**（幂等复用已有 fork/PR）
- 📢 **市场操作免责弹窗**：上传 / 下载 / 装回本地三处操作前置免责声明，支持「不再提示」（三操作**分开记忆**，localStorage 持久化；存储不可用时静默降级为每次提示）
- 🪟 **同步设置改弹窗驱动**：远程同步页改为「同步通道」入口卡 + **通道配置弹窗**（Git/WebDAV 子 tab 与登录块移入弹窗，关闭弹窗 = 放弃本次操作含 GitHub 登录流程）；新增 **GitHub 登录态真实校验**（`/sync/github/validate`：token 有效则隐藏登录块，失效自动重新展示）
- 💾 **一键同步差异确认决策持久化**：逐项「采纳/解决」决策镜像进 store，切 tab / 刷新不丢，恢复会话可继续决策
- 🚀 **市场首次打开自动刷新**：本次 DSH 启动后首次打开市场页自动拉取一次最新条目（手动刷新成功即置位，失败可重试）
- 🔒 **秘密扫描宽松档**：市场发布扫描新增 `literalValueOnly` 档位——字段名敏感**且**值像真实字面量凭据才命中（占位符/示例形态/代码表达式/环境引用一律放行），真实密钥形状仍硬拦

### Highlights (en)

- 🧹 **Automatic cache cleanup**: transient files under `~/.dsh/dsh-config-manager/` (`tmp/` import/decrypt/sync staging), export copies (`exports/` — already downloaded to your machine on export), and marketplace cache/git worktrees (`market/cache/`, `market/work/`) are now **cleaned automatically** — once at DSH startup and then every 24 hours, removing only entries older than their retention (24 h for tmp, 7 days for exports and market cache); import rollback snapshots (`snapshots/`) and sync data (`sync/`) are user data / safety nets and are **never auto-removed**
- 🗑️ **"My Configs" item deletion**: each listed item gains a delete action guarded by a **confirm dialog** (mask / Esc / Cancel close paths; focus lands on Cancel for destructive ops) — listed items automatically open a **de-listing PR** (dedicated branch `dsh-market-delist/<id>`), pending-review items just close the listing PR; listing/de-listing jobs run **in background with status polling**, and a failed/lost job can be **retried in one click** (idempotent, reuses the existing fork/PR)
- 📢 **Market operation disclaimers**: upload / download / install-back-local now show a disclaimer first, with a per-operation **"don't ask again"** toggle (remembered independently in localStorage; silently degrades to always-ask when storage is unavailable)
- 🪟 **Sync settings moved to a dialog**: the sync page is now an entry card that opens a **channel-config dialog** (Git/WebDAV tabs and the GitHub login block live inside; closing the dialog abandons the operation, including an in-flight GitHub login); new **real GitHub sign-in validation** (`/sync/github/validate`: valid token hides the login block, an invalid one re-shows it)
- 💾 **One-click-sync confirm decisions persisted**: per-item adopt/resolve choices are mirrored into the store, surviving tab switches / refresh so a session can be resumed
- 🚀 **Market auto-refresh on first open**: the market page auto-fetches once per DSH startup (a successful manual refresh also arms it; failures can be retried)
- 🔒 **Lenient secret-scan tier**: market publishing gains a `literalValueOnly` mode — a sensitive field name only hits when the value looks like a real literal credential (placeholders / example shapes / code expressions / env references always pass); real key shapes are still hard-blocked

## [v0.1.40] - 2026-08-20

### 🎯 亮点 / Highlights (zh)

- 🧭 **「我的配置」体验修复**：移除标题上方的「返回市场」按钮（子视图切换已在顶部，无需重复返回）；update 更新改为**显式按条目 id 定位**（不再靠名称转 id 猜测，中文名/改名场景不再误建新条目，目标条目不存在时明确报错）；秘密扫描**消除技能文档误报**（`token:`/`password:` 等代码示例、类型声明、占位符、环境引用不再误判，真实密钥 sk-/ghp_/JWT/PEM/Bearer 仍强制拦截）

### Highlights (en)

- 🧭 **"My Configs" UX fixes**: removed the "back to market" button above the title (the sub-view tabs already switch back); update now targets the item by its **explicit id** (no more name→slug guessing — Chinese names / renames no longer create a duplicate item, and a missing target id errors clearly); secret scan **no longer false-positives on skill docs** (code samples like `token:`/`password:`, type declarations, placeholders, env references are allowed; real key shapes sk-/ghp_/JWT/PEM/Bearer are still hard-blocked)

## [v0.1.39] - 2026-08-20

### 🎯 亮点 / Highlights (zh)

- 🧹 **上传入口收敛**：移除「配置市场」浏览视图中的旧「发布到市场」向导（PublishView）及其入口按钮，上传配置统一收敛到「我的配置」子视图（一键上传 → 自动建仓 → 自动收录 PR）；fork 创建轮询超时 60s → 180s（GitHub 首次 fork 复制仓库内容可能超过 1 分钟）

### Highlights (en)

- 🧹 **Upload entry consolidated**: the legacy "Publish to Market" wizard (PublishView) and its entry button are removed from the browse view; uploading configs now lives solely in the "My Configs" sub-view (one-click upload → auto repo → auto listing PR); fork creation polling timeout raised 60s → 180s (GitHub's first fork copies the whole repo and can take over a minute)

## [v0.1.38] - 2026-08-20

### 🎯 亮点 / Highlights (zh)

- 🚀 **「一键上传 / 我的配置」**：配置市场新增「我的配置」子视图——GitHub device flow 登录（token 只存本机凭据槽）后，选择配置 zip → 本地 8 道校验 + 秘密扫描 → 一键上传到**你自己的公开仓库**（自动创建 `<login>/dsh-configs`）→ 自动 fork 官方市场仓库、改 `index.json` 收录**自托管引用**并提交自动 PR（固定分支 `dsh-market-sync/<itemId>`：未合并自动更新、已合并基于最新 main 重开）；支持查看已上传（收录状态徽章：未收录 / PR 待审核 / 已收录）、一键更新（元数据全自动：id / author / version / updatedAt / sha256 系统生成，版本纯自动 +1）、装回本地（复用市场下载 + 逐分区批准 + 回滚管道）。目标收录仓库固定 `xiajiajun516/dsh-config-market`，界面不可修改

### Highlights (en)

- 🚀 **One-click upload / "My configs"**: the Market panel gains a "My Configs" sub-view — after GitHub sign-in (device flow; token stays in the local credential slot), pick a config ZIP → local 8-step validation + secret scan → upload in one click to **your own public repo** (auto-created as `<login>/dsh-configs`) → auto-fork the official market repo, add a **self-hosted reference** to `index.json`, and open the listing PR automatically (fixed branch `dsh-market-sync/<itemId>`: auto-updated while unmerged, reopened from latest main after merge); view uploads with listing-status badges (not listed / PR pending / listed), update in one click (all metadata auto-generated — id / author / version / updatedAt / sha256; version bumps automatically), and install back locally (reusing the market download + per-section approval + rollback pipeline). The listing target repo is fixed to `xiajiajun516/dsh-config-market` and not editable in the UI

## [v0.1.37] - 2026-08-19

### 🎯 亮点 / Highlights (zh)

- 🐛 **修复异步操作切 tab 丢失状态**：远程同步的推送/拉取/一键同步、市场下载与确认导入、快照恢复等异步操作，在请求进行中切换 tab 再切回时不再丢状态——结果（推送/拉取报告、差异确认会话、导入结果、恢复计划与报告）在组件卸载期间完成也能落库，切回即恢复；进行中的 busy spinner 也随模块级 store 保留（刷新后清空，凭据仍仅内存白名单剔除）

### Highlights (en)

- 🐛 **Fix state loss for async operations on tab switch**: pushing/pulling/one-click sync, market download & confirmed import, and snapshot restore no longer lose their result when you switch tabs mid-request — results (push/pull reports, diff-confirm session, import outcome, restore plan & report) are persisted into the store even when the request settles after the view unmounted, and restore on return; in-flight busy spinners survive tab switches too (cleared on refresh; credentials stay memory-only behind the whitelist)

## [v0.1.36] - 2026-08-19

### 🎯 亮点 / Highlights (zh)

- 🐛 **修复同步快照二进制损坏（文件分区丢字节）**：文件类分区（技能/插件文件等）在内存为 Uint8Array，整份快照走 JSON 的通道（WebDAV 单文件快照、加密载荷）会把字节序列化成数字索引对象，拉取/解密后 `Buffer.from(对象)` 直接抛错；新增二进制安全序列化（文件字节 ↔ `{ $bin: base64 }`）——三个通道全部接入，往返字节无损
- 🔐 **Git 加密快照改「密文单文件」布局**：加密快照（密文载荷无法平铺为明文 JSON 分区）改走 `snapshots-encrypted/<id>.json` 整体 JSON 提交，与明文散文件目录并存——远端只存密文、本地不产生额外明文审计副本
- 🛡️ **市场条目禁止分区**：sessions（历史会话）/ pluginFiles（任意文件直通）/ self（本地环境）永久禁止进入市场条目——安全校验与条目生成两端强制拒绝（产品决策，详见市场仓库搭建规格书）
- 🏷️ **同步历史标记触发通道**：快照 manifest 与自动同步历史记录各自 transport（git/webdav），快照/历史列表显示通道徽章——多通道同步一次看清哪个通道做了什么
- 📖 **官方市场仓库搭建规格书**：新增 docs/design/2026-08-19-market-repo-setup-guide.md——索引格式、8 道安全校验、条目结构整份规格，可直接复制发给搭建 AI

### Highlights (en)

- 🐛 **Fix binary corruption in synced snapshots (file-section bytes)**: file-based sections (skills/plugin files…) hold `Uint8Array` in memory; any channel that JSON-serializes the whole snapshot (WebDAV single-file snapshots, encrypted payloads) mangled the bytes into numeric-index objects, making `Buffer.from(obj)` throw on pull/decrypt. A binary-safe serializer (bytes ↔ `{ $bin: base64 }`) is now wired into all three channels — lossless round-trips
- 🔐 **Git encrypted snapshots move to a ciphertext-single-file layout**: encrypted snapshots (ciphertext cannot be flattened into plaintext JSON sections) are now committed as a whole `snapshots-encrypted/<id>.json`, coexisting with the plaintext scatter-dir layout — remote keeps only ciphertext, no extra plaintext audit copy locally
- 🛡️ **Banned market sections**: `sessions` (chat history) / `pluginFiles` (arbitrary passthrough files) / `self` (local environment) are permanently forbidden in market items — enforced at both validation and item-generation (product decision, see the market repo setup spec)
- 🏷️ **Sync history records the triggering channel**: each snapshot manifest and autosync history entry now carries its `transport` (git/webdav), shown as a channel badge in the snapshot/history lists — multi-channel sync is now readable at a glance
- 📖 **Official market repo setup spec**: new docs/design/2026-08-19-market-repo-setup-guide.md — index format, 8-step security validation, item structure as a single spec, copy-paste ready for a setup AI

## [v0.1.35] - 2026-08-19

### 🎯 亮点 / Highlights (zh)

- 🛒 **配置市场发布向导（去中心化方案 B）**：配置市场新增「发布到市场」五步向导——选择配置 zip → 本地 dry-run 校验（内容合法且不含密钥）→ 生成条目包（L2 manifest + SHA-256 + sections）→ 推送作者仓库（生成 git 命令模板，插件不做任何 git 写操作、不持有凭据）→ 提交收录申请（index.json 片段 + PR 指引）；官方 index 只收录引用、保持只读零凭据，条目由作者自托管公开 git 仓库
- 🧩 **self 分区：插件自身配置纳入备份/迁移**：新增 self 适配器——导出/同步自动收集 `$DSH_HOME/dsh-config-manager/` 下的 sync-config / sync-autosync / sync-selection / ui-prefs / market-config 白名单配置（不含凭据值），换机器一键恢复
- 🔀 **同步通道独立子 tab**：远程同步面板 Git / WebDAV 改为子 tab 各自持有独立配置——自动同步（启用/间隔/状态）、同步模式与分区勾选、是否加密、远端快照列表均按通道独立（autosync / sync-selection schema v2 按通道命名空间 + v1 自动迁移）
- 💾 **UI 偏好落盘**：上次选择的同步通道从浏览器 localStorage 迁入磁盘 ui-prefs.json——换浏览器/换机器不丢，Host 可读写（浏览器关闭时自动同步也能读到）

- 🐛 **加密备份导入只输一次密码**：导入整体加密备份（DCA1 容器）时不再需要第二个「解密备份」页面——选完 ZIP 输入一次解锁密码即可，Host 解锁时顺带解出内部凭据覆盖清单（refs），该密码同时作为解密密码完成凭据恢复（导出时两者同源）
- 🐛 **修复切 tab / 刷新丢失面板状态**：快照恢复、远程同步、配置市场三个低频面板的非敏感 UI 状态（选中快照 / dry-run 计划 / 执行报告、通道表单 / 同步模式与分区勾选 / 一键同步差异确认会话、搜索词 / 类别筛选 / 条目详情与逐分区批准）现经模块级 runStore + sessionStorage 白名单持久化——切 tab 不丢、刷新后回到原 tab 并恢复现场；同步凭据（token / webdav 密码 / 加密与解密密码）仍仅内存，刷新后清空要求重输

### Highlights (en)

- 🛒 **Marketplace publish wizard (decentralized)**: a five-step "Publish to Marketplace" wizard — pick a config ZIP → local dry-run validation (valid content, no secrets) → generate the item package (L2 manifest + SHA-256 + sections) → push to your own repo (git command template generated; the plugin never performs git writes or holds credentials) → submit an index entry (index.json snippet + PR guidance); the official index stays read-only with zero credentials and only references author self-hosted public repos
- 🧩 **`self` section: the plugin's own config joins backup/migration**: a new `self` adapter collects the plugin's own config files under `$DSH_HOME/dsh-config-manager/` (sync-config / sync-autosync / sync-selection / ui-prefs / market-config whitelist, credential-free) for export & sync — restore everything on a new machine in one shot
- 🔀 **Per-channel sync sub-tabs**: the Sync panel now has Git / WebDAV sub-tabs, each owning independent settings — autosync (enabled / interval / status), sync mode & section selection, encryption toggle, and remote snapshot list are all per-channel (autosync / sync-selection schema v2 with namespaced channels + v1 auto-migration)
- 💾 **UI prefs on disk**: the last-selected sync channel moved from browser localStorage to `sync/ui-prefs.json` — survives browser/device changes and is readable by the Host process (autosync keeps working while the browser is closed)
- 🐛 **Encrypted backup import now asks for the password once**: the separate "decrypt backup" step is gone for fully-encrypted (DCA1) archives — enter the unlock password right after picking the ZIP; the Host returns the covered credential refs with the unlock response and reuses the same password (both layers derive from it at export time) to restore credentials
- 🐛 **Fix state loss on tab switch / page refresh**: non-sensitive UI state of the Snapshots / Sync / Market panels (selected snapshot + dry-run plan + restore report; channel form + sync mode & section selection + one-click sync confirm session; search / category filter / item detail + per-section approvals) is now mirrored into the module-level runStore and persisted via the sessionStorage whitelist — surviving tab switches and restoring after refresh, with the current panel re-opened; sync credentials (token / WebDAV password / encrypt & decrypt passwords) stay memory-only and are cleared after refresh

## [v0.1.34] - 2026-08-19

### 🎯 亮点 / Highlights (zh)

- 🆕 **关于（About）面板**：设置页新增第六个 tab——展示插件元数据（名称/仓库/作者）、当前插件版本与 DSH 版本/平台，并提供 Star / 文档 / Issues 快捷链接；链接恒等派生自仓库 URL，杜绝拼接错误
- ⬇️ **导出下载静默化**：导出 ZIP 完成后默认以 Blob + `<a download>` 静默下载到浏览器「下载」目录（无需另存为对话框）；需要选择保存位置时可走系统保存对话框（saveDialog 模式）
- 🔀 **同步配置 schema v3**：git 与 WebDAV 双命名空间共存——切换通道不再丢失另一通道的 repoUrl/url 配置，status 路由可回填另一通道配置
- 🐛 **修复加密备份解锁后 zipPath 丢失**：导入解锁加密备份时保留已记录的容器路径，避免 store 中已 patch 的 zipPath 被覆盖回 null
- ⚙️ **发布流程改进**：GitHub Release 亮点改为从 CHANGELOG.md 自动抽取（未写当前版本段则 fail fast），发版不再需要手动维护亮点列表

### Highlights (en)

- 🆕 **About panel**: new sixth tab in the settings page showing plugin metadata (name / repo / author), plugin version, DSH version and platform, with Star / Docs / Issues quick links derived from the repo URL (single source, no concatenation bugs)
- ⬇️ **Silent export download**: exported ZIPs now download straight to the browser's download directory via Blob + `<a download>` (no save dialog); opt into the system save dialog with saveDialog mode when a location choice is needed
- 🔀 **Sync config schema v3**: git and WebDAV namespaces now coexist — switching channels no longer drops the other channel's repoUrl/url, and the status route can backfill the inactive channel config
- 🐛 **Fix zipPath loss after unlocking encrypted backups**: the import wizard keeps the recorded container path when unlocking an encrypted archive, so the patched zipPath in the store is no longer overwritten to null
- ⚙️ **Release workflow improvement**: GitHub Release highlights are now auto-extracted from CHANGELOG.md (fail fast when the current version section is missing), no more hand-maintained highlight lists

## [v0.1.33] - 2026-08-19

### 🎯 亮点 / Highlights (zh)

- 🔐 **加密快照同步**：手动推送时可将整个同步快照的 sections 载荷用 AES-256-GCM **整体加密**后上传远端（`manifest.encrypted=true`），拉取/一键同步时输入密码解密——密码仅内存使用，绝不落盘/落日志
- 🛡️ **凭据随同步通道携带（可选）**：手动推送可导出真实凭据值（`includeSecrets`），但**强制要求同时加密**（安全不变量：密钥绝不明文进入同步通道）；自动同步恒不携带凭据
- 🚫 **自动同步智能跳过加密快照**：远端最新快照为加密 → 自动同步无密码无法解密，记录 `skipReason='encrypted'` 整体跳过（不误判失败），提示走手动输入密码同步
- ⚙️ **同步配置保存路由（sync/config）**：UI 表单自动保存 /「保存配置」按钮落盘同步通道配置，凭据走 DSH credentials 槽位；WebDAV `username` 留空时从持久化配置自动回填（挂载/刷新后不再因空用户名失败）
- ⏱️ **WebDAV 通道独立超时**：单请求放宽至 120s（适配坚果云等慢速 WebDAV 上传大快照/读写索引），错误消息携带实际毫秒数便于判断
- 🐛 **修复导入「解锁加密备份」阶段渲染让位**：decrypt-archive 阶段发生时不再停留在文件选择页，正确显示密码输入界面（import-decrypt-archive-render 回归）

### Highlights (en)

- 🔐 **Encrypted snapshot sync**: on manual push, the whole sync snapshot payload can be **encrypted with AES-256-GCM** before upload (`manifest.encrypted=true`); a password is asked on pull / one-click sync to decrypt — kept in memory only, never persisted or logged
- 🛡️ **Credentials may travel with the sync channel (opt-in)**: manual push can export real credential values (`includeSecrets`) but **requires encryption at the same time** (security invariant: secrets never enter the sync channel in plaintext); auto-sync never carries credentials
- 🚫 **Auto-sync skips encrypted snapshots**: when the remote latest snapshot is encrypted and no password is available, the sync records `skipReason='encrypted'` and skips the whole run (not a failure), prompting manual password-based sync
- ⚙️ **Sync config save route (`sync/config`)**: the UI autosaves / the "Save config" button persists channel config; credentials go to DSH credential slots; empty WebDAV `username` is backfilled from persisted config after mount/refresh
- ⏱️ **WebDAV channel timeout**: per-request timeout widened to 120s (for slow WebDAV like Jianguoyun uploading large snapshots / index I/O); error messages carry the actual milliseconds
- 🐛 **Fix import "unlock encrypted backup" step rendering**: the decrypt-archive stage now correctly shows the password input instead of staying on the file-selection page (import-decrypt-archive-render regression)