# 安全与凭据 — 经验与证据存档

> 本文件是**经验/证据**：真机事故、量化数据、复现与复核脚本；**规则本体在 `AGENTS.md`**（对应小节读取）。
> 条目结构：每个 `###` 是原 `AGENTS.md` 的一条完整条目（逐字搬迁，未改写）。域 → 规则 的对应表见 `docs/lessons/README.md`。

## 同步「导出密钥」= 独立密文凭据载荷

- **同步「导出密钥」= 独立密文凭据载荷**（issue #38）：`includeSecrets=true` 时 `.credentials.yaml` 原文加密为 `SyncSnapshot.credentials`（**绝不进 `sections`**，那是 `FORBIDDEN_SECTIONS` 结构性拒绝分区），拉取侧解密为 `Map<ref,value>` → `MissingSecret` 计划项 → `decryptedCredentials` → `credentials.set`。读不到/为空必须**显式告警**（不得静默成功）；`includeSecrets ⇒ encrypt` 与「非加密快照声明 containsSecrets 即拒绝」两条不放宽；该 Map 只存进程内存（存值不存密码），随同步会话 TTL/消费/取消消失。

## 凭据计划项只在计划生成期产出，判据「值的有无」优先于「本机状态」

- **凭据计划项只在计划生成期产出，判据「值的有无」优先于「本机状态」**（两轮真机反馈的合并结论：先是「已有的重复密钥也会提示」，接着是「导入密钥没真正导入」——只按本机状态跳过会把有值的凭据也挡掉）：
  - **有值**（宿主解开 `security/secrets.enc` / `SyncSnapshot.credentials` 得到的 ref）→ 一律 `MissingSecret`（导入侧文案 `import.secretFromArchive` / 同步侧 `sync.credentialsItemDesc`）并在执行期写回，**不因本机已配置而跳过**（这正是「导出密钥」的语义）。要逐项放过用确认列表的批量按钮（`sync-view.isBulkDecidable`）。
    - **同步侧再加一步「值是否已经相同」**（2026-10-14 真机反馈：WebDAV + 加密 + 导出密钥拉取预览，本机 `refs:` 一条不缺，列表却全标「缺密钥」+ 黄色警告）：`SyncEngine.readLocalCredentials` 读同一个本机 `.credentials.yaml`，值与快照**逐字节相同** → `Skip`(info)，只有真的会改动本机的 ref 才要人工确认；**读不到凭据文件 = 无法比较**（`undefined`）→ 保守按待确认处理，绝不静默跳过。判据收窄的是「要不要确认」，不是「要不要写回」。标签 `sync.kind.missingSecret` 同时由「缺密钥」改为「凭据迁移」（该 kind 在同步侧恒表示「快照带值、确认后写回本机」）。
  - **无值**（普通备份：`credentialsStatus` 声明的 ref）→ 本机已配置 → `Skip`（`import.secretAlreadyConfigured`，保留本机值、不再索要补录）；本机没有 → `MissingSecret`（要求补录）。判据 `isCredentialConfigured`（`src/core/credential-status.ts`；读不到 → false 保守）。凭据值不可回读 ⇒ 无值分支绝不覆盖本机值。
  - 实现与坑：导入 `analyzer.buildCredentialPlanItems`（ref 取**并集** = credentialsStatus ∪ 解密出的 ref；原名 `ensureMissingSecrets`）。**`createImportPlan` 必须收到 `decryptedCredentials`**——只认 credentialsStatus 会漏掉「未被任何 settings namespace 引用」的 ref（`.credentials.yaml` 是原文加密），这些值会静默丢掉：宿主 `/plan` 按 `decryptPassword` 解密后传入，客户端 `api.createImportPlan` 与 `/analyze`、`/execute` 同源传同一个密码（`ImportWizard.planOpts()`）。同步 `sync-engine.appendCredentialPlanItems` 只处理有值 ref，并把先前按「无值」判成 `Skip` 的同 id 项**升级**回 `MissingSecret`（否则有值也被 Skip 挡住），同时让 `plan.missingSecrets` 与 items 同源。注意 `credentialsStatus` 是 `deviceSpecific` → **永不进同步通道**，所以同步侧的值只能来自凭据载荷。
  - 回归护栏：`src/security/security.test.ts`「归档携带的凭据必须全部进计划并写回」（6 类分支：未被引用的 ref / 本机已有仍写回 / 无值未配置要补录 / 无值已配置 → Skip）、`src/adapters/roundtrip.test.ts`（普通备份 + 本机已配置 → Skip）、`src/sync/sync-credentials.test.ts`（有值一律进计划且写回 + 无载荷快照不含 credentialsStatus 的说明）、`src/ui/import-wizard.test.ts`（计划期同样带解密密码）；`tests/core/rollback.test.ts` 的 E-02（凭据不可回滚 → 部分回滚）改为在**计划生成之后**才让目标机拥有旧凭据。

## 一键同步差异确认的批量按钮覆盖「全部确认项」

- **一键同步差异确认的批量按钮覆盖「全部确认项」**（`sync-view.isBulkDecidable`）：`keepLocalAll`/`useRemoteAll` 作用于确认列表里的每一项（Conflict 项连带给 resolution），**只排除 Error**（硬失败项被采用后必记 failed，不能由批量按钮代裁）。此前批量只认 Conflict → 含 N 条凭据迁移项（`缺密钥`）时按钮恒灰、只能逐条勾（用户报告）。

## 磁盘占用体检与手动清理的硬边界

- **磁盘占用体检与手动清理的硬边界**（m-disk-usage，2026-09）：备份页的「磁盘占用」卡走 `GET /disk-usage`（**只读**：`src/core/disk-usage.ts` 递归统计、不跟随符号链接/junction、读不到的子区标 `unreadable` 而不是 0）
  与 `POST /disk-usage/cleanup`（写操作，过 mutation gate）。四条不得放宽：① **候选集只有可重建区**（`tmp` / `market/cache` / `market/work`）**与显式勾选的过期导出产物**；
  `snapshots`（导入前快照）与 `sync`（同步配置/历史/Git 工作副本）**永远进不了候选集**；② 请求里的 `categories` 是**分区白名单**（`cleanupCaches` 的 `sections`）——
  用户没勾 `expired-exports` 时**一个导出文件都不碰**（即使有过期项；守卫 = `tests/route/disk-usage-routes.test.ts`）；
  ③ 手动清理对可重建区忽略保留期（`includeRecent: true`，与自动清理的保留期语义并存但分开），导出产物**永远只按保留期**，绝不「立即清空」；
  ④ 界面数字（合计/可回收/按钮）一律由**渲染出的行现算**（`src/ui/disk-usage-view.ts`），不用接口聚合字段 —— 避免「按钮说能释放 600 B、实际 0」。⑤ **清理时「缺失的可选目录」（ENOENT）不计入 errors**（新装机器上 `market/cache` / `market/work` / `exports` 本来就不存在；其它 errno 仍计）—— 否则前端会把「本来就没有」误报成红色「清理失败 N 项」。

## 备份有两种物理形态，「形态判定」只有一份实现

- **备份有两种物理形态，「形态判定」只有一份实现**（issue #55）：加密产物是 **DCA1 整包容器**（AES-256-GCM 包住整份 ZIP），文件名却仍是 `.zip`。① 判定单一事实源 = `src/security/container-kind.ts`（`containerKindOfBytes` / `readContainerKind`）；② **只读前 4 字节**（open+read(4)+close），**读不到一律回落 `'zip'`**（判不出 ≠ 判为加密）；③ 未解锁容器一律 `400 { code: 'encrypted-container' }`（`ENCRYPTED_CONTAINER_CODE`）+ `import.encryptedContainerNeedsUnlock`，客户端据码自动进解锁阶段。**客户端半铁律**：`src/client/**` 只能 import 零依赖的 `utils/shared-constants.ts` 拿码 —— import `security/container-kind.ts` 会把 `node:crypto` 打进 `lib/client.js`，DSH loader 报 missed the module table，**整个插件不加载**。

## SAFE MODE 的可见性与出口

- **SAFE MODE 的可见性与出口**（issue #56）：`<dataDir>/transactions/safe-mode` 一旦落盘即跨重启生效，**解除判据只有 `recovery-orchestrator` 的 `resolveSafeMode` 一份**（NEEDS_ATTENTION 视为未解决、扫描失败 fail-closed）。四条不得回退：dismiss 之后必须调用它；`GET /recovery/status` 回传 `safeMode: { blocked, clearable }` 并渲染显式解除入口；`POST /recovery/safe-mode/clear` **故意不过 withMutationGate** 但绝不无条件清（有未解决 incident 拒绝 `reason: 'unresolved-incidents'`，本来没阻断幂等回 `not-blocked`）；阻断态与 mutation gate 的 `isBlocked` 同源**动态探测**，绝不创建期捕获。

## 值形状判定（`matchSecretValuePattern`）的大小写边界

- **值形状判定（`matchSecretValuePattern`）的大小写边界**（t58-F1 / t72，known-gaps **G-36**）：**auth-scheme `bearer` 按 RFC 7235 / 6750 大小写不敏感剥离**（规范 `Bearer …` 的命中名 `bearer-token` 与行为逐字不变），但 token 侧刻意更严以防英文散文过剥 —— 需含非字母字符、或大小写混排、或长度 ≥ 24（`bearer credentials are required` 因此**不**命中）。**厂商前缀（`sk-` / `AKIA` / `ghp_` / `github_pat_`）保持大小写敏感**：`SK-…` / `GHP_…` / `akia…` **不会被剥离**（不是真实厂商形态；判定是全仓共用单一来源，加 `i` 会连带放宽日志 / 导出扫描 / 界面 `redact()` 三条通道）。**别「顺手加 `i`」**（红在 `t72-d`；要收先单独决策并同步本条与 known-pitfalls）。附带两条口径（细则见 `docs/known-pitfalls.md`「t93 容量腾挪」§3）：尖括号占位符在值形状通道同样被剥空；`redactMcpSection` **自身**过滤非字符串载体。**`sk-` 的误剥边界（t83）**：`sk-` 用**载荷形状守卫** `/sk-(?![a-z-]{1,24}(?![A-Za-z0-9_-]))[A-Za-z0-9_-]{8,}/`（`sk-` 后 1–24 个纯小写字母/连字符 = 词形态 → 放行，修 `task-management` / `risk-assessment` 等误剥），**别改回左边界** `(?<![A-Za-z0-9])`（会漏剥 `'p'.repeat(10000)+'sk-…'` 这类真实长串内嵌 ⇒ 明文进包）。另注（**t78 后已订正**）：`redaction.ts` **不再有独立重复表**，`REDACTION_VALUE_PATTERNS` 派生自 `SECRET_VALUE_PATTERNS`；**仍存差异**是显示层比 scanner **更宽**（示例/占位形态 scanner 放行、`redact()` 仍掩）。残余/取舍/守卫见 `docs/known-pitfalls.md` G-36 与「t93 容量腾挪」§3。

## Secret 默认不导出（下移自 AGENTS.md §🔐 安全不变量）

- **Secret 默认不导出**：`includeSecrets` 缺省 false；凭据值绝不写入同步文件/日志/回传浏览器。

## 凭据不可回读（下移自 AGENTS.md §🔐 安全不变量）

- **凭据不可回读**：`ctx.credentials` 永不回读值，只经 `HostContext.fs` 文件级读 `.credentials.yaml`；`encryption.ts` 只做字节级加解密。

## 同步通道的加密/解密密码（下移自 AGENTS.md §🔐 安全不变量）

- **同步通道的加密/解密密码**（唯一例外，product requirement）：用户不勾选加密就删除、不留空；勾选后保存到 DSH credentials 的独立槽位（`syncPasswordRef('ENCRYPT'|'DECRYPT', 通道)` → `DSH_CONFIG_MANAGER_SYNC_ENCRYPT_PASSWORD_<GIT|WEBDAV>` / `..._DECRYPT_...`），由 `POST /sync/selection` 写/删、`GET /sync/status` 只回 `configured` 布尔。**值绝不写入 sync-*.json / 响应 / 日志 / 直出浏览器**；请求体里的密码优先于已存密码，删除优先于写入。
