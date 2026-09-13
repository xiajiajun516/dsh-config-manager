# `tests/conformance/` —— Bundle 格式 v1 一致性语料与往返测试

本目录把「DSH 配置 bundle 的格式」从**文档描述**变成**可执行的、可被外部实现复用的验收证据**。

- 规格：`docs/spec/bundle-format-v1.md`
- 测试本体：`roundtrip.test.ts`（`node:test`，零依赖）
- 语料构造器：`corpus.ts`（真实 Exporter 造包 → 字节级注入 → **重算 checksums**）

```bash
# 只跑一致性套件
node --test tests/conformance/roundtrip.test.ts

# 全量回归（含本目录）
npm test
```

---

## 1. 这些语料是什么

语料**不是**手写的 JSON 假设，而是**本仓库真实 `Exporter` 的产物**：

| 语料 | 构造方式 | 用途 |
|---|---|---|
| `baseline` | `Exporter.export({ includeSecrets:false, only:[...7 分区] })` | 明文 v1 往返无损的基线 |
| `baseline + encryption` | 同上 + `createEncryptionProvider(password)` + `includeSecrets:true` | 加密包往返（正确/错误密码） |
| `unknown-sections` | baseline → 在 `manifest.sections` 追加 `keybindings`/`workflows` + 把它们的文件放进 ZIP → **重算 checksums** | 未知分区的前向兼容行为 |
| `unknown-fields` | baseline → 追加未知顶层字段与 `exporter.*` 未知子字段 | 未知字段的保留语义 |
| `schema-v2` / `schema-v0` | baseline → 改 `manifest.schemaVersion` → **重算 checksums** | 版本协商（过新 / 过旧） |
| `tampered` | baseline → 改 `config/settings.json` 字节 + **保留原 checksums** | 完整性校验语义（`CORPUS-02`） |
| `no-checksums` | baseline → **剥掉** `integrity/checksums.json`（其余条目逐字节保留） | 校验表缺失时的语义（`INT-02`） |
| `empty-checksums` | baseline → 把 `integrity/checksums.json` 覆盖为 `{}` | 校验表为空时的语义（`INT-03`） |

语料**小而可读**，且只含合成数据：合成 home（`C:\Users\fixture-src`）、合成密码
（`conformance-password-123`）、合成凭据（`sk-conformance-fixture-value`）。
**不含任何真实凭据、真实个人路径或 secret。**

### 为什么必须重算 checksums

`analyzer.loadBundle` 的第 4 步会拿 `integrity/checksums.json` 逐条比对 SHA-256，
不一致就直接抛 `备份完整性校验失败`。若不重算，你测到的永远是完整性错误，
而**打不到**想测的分支（未知分区、版本协商……）。`corpus.ts` 的 `rebuildBundle()`
负责这件事：改 manifest / 追加条目 → 重新生成覆盖「除 `manifest.json` 与
`checksums.json` 自身之外全部条目」的 checksum 表。

精确一点（实测结论，`CORPUS-02` 钉住）：

- `manifest.json` **不在** checksums 表内（导出与校验两侧都显式排除），
  所以**只改 manifest**（本套件的 `unknown-sections` / `unknown-fields` / `schema-v2`）
  即使不重算也不会被拦下；
- **追加**新条目同样不会被拦下——`verifyAgainstTable` 遍历的是**表里的键**，
  不是 ZIP 里的条目，所以 ZIP 里多出来的文件不参与校验。但**「不参与校验」不等于「无声」**：
  修复 G-04 后，`analyzer.loadBundle` 会做一次反向比对，把「在 ZIP 里、却不在校验表里」的条目
  （排除 `manifest.json`、`integrity/checksums.json` 自身与以 `/` 结尾的目录条目）
  记为 `import.extraEntries` **warning——不阻断导入**，但用户会被明确告知有未被校验的内容；
- **修改或删除已有数据条目**则一定会被拦下，必须先重算才能打到目标分支。

`rebuildBundle()` 因此**无条件重算**（除非显式传 `recomputeChecksums: false`），
让三种 mutation 都安全；`CORPUS-02` 用 `recomputeChecksums: false` 构造了一份
被篡改的 bundle，断言它**必须**被完整性校验拒绝，从而证明重算不是可有可无的形式。

### 校验表**缺失 / 为空**时不得静默通过（H2）

`integrity/checksums.json` 不存在，或者内容为 `{}`，都意味着**没有任何条目被校验**。
修复前整段完整性逻辑（含上面的 G-04 反向检查）都嵌在
`if (archive.has(CHECKSUMS_FILE))` 内，于是「剥掉校验表」或「把它置空」会让一个
完全未经校验的 bundle 以 `valid=true` / `errors=[]` / `warnings=[]` 通过分析——**零提示**。

修复后两种形态都产出 `import.checksumsMissing` warning：
`备份未提供完整性校验表，全部条目未被校验`。

- **两种形态共用同一条消息键**（不复用 `import.extraEntries`，也不新增第二条近重复文案）：
  对用户而言「表缺失」与「表为空」是同一件事——**没有任何条目被校验**，
  文案说的是后果而不是文件形态，因此一条就够，也避免两条 99% 相同的字典项。
- 表**存在且非空**时语义完全不变：逐条 SHA-256 校验照旧（不符/缺失仍硬失败），
  反向「未登记条目」检查照旧只 warning（`INT-04` 钉住回归）。
- 仍然是 **warning 而非 error**：格式 v1 里校验表本就是可选的，缺表不阻断导入，
  只是不再假装「校验通过」。

### 为什么每次都要写新的 zip 路径

`Analyzer` 有 `zipPath → Bundle` 的**会话级缓存**（`src/core/analyzer.ts` 的
`bundleCache`）。同一个路径覆写后再分析会命中旧缓存。`rebuildBundle()` 因此
要求调用方给出独立的 `outZipPath`。

---

## 2. 外部实现如何复用这些语料

### 2.1 最省事的用法：把本仓库当语料生成器

```bash
git clone <this repo> && cd dsh-config-manager
npm install --legacy-peer-deps
node --test tests/conformance/roundtrip.test.ts   # 确认基线语料在本机可复现
```

然后在你的实现里，用 `corpus.ts` 导出的两个函数造语料：

```ts
import { rebuildBundle } from './tests/conformance/corpus.ts';
```

- `rebuildBundle(srcZipPath, outZipPath, { manifest?, extraEntries? })`
  读出任意 bundle 的全部条目 → 应用变更 → 重算 checksums → 写出新 bundle。
- 只做「原样复制」时传空 mutation 也成立（`CORPUS-01` 就断言了这一点：
  未追加条目时条目集合与字节完全一致）。

### 2.2 断言你自己的 importer

对每一份语料，按下面的**可观察契约**断言。括号里是本仓库实测的真实行为，
括号后的 `✅/❌` 表示它是否符合规格要求。

**明文 v1（`baseline`）**

| # | 断言 | 本仓库实测 |
|---|---|---|
| 1 | `manifest.schemaVersion === 1`、`security.encrypted === false`、`security.encryption === null` | ✅ |
| 2 | `manifest.sections` 覆盖**全部** 15 个分区 id；未导出的显式为 `false` | ✅ |
| 3 | `checksums` 的键集合 == ZIP 内除 `manifest.json`/`integrity/checksums.json` 外的条目集合 | ✅ |
| 4 | 每个数据条目的 SHA-256 == checksums 表中的值 | ✅ |
| 5 | 校验方向：`checksums` 表里的每个键必须在 ZIP 中存在且哈希一致；**ZIP 中多出的条目不参与校验**，但必须**显式告警**（未登记 ⇒ 未被校验） | ✅（`CORPUS-02` + `INT-01` 钉住） |
| 6 | 分析阶段**零写入**（Dry Run 不变量） | ✅ |
| 7 | 同平台同版本 → 兼容性 `excellent` | ✅ |
| 8 | 导入后：namespace 值逐字段等价（含嵌套对象/Unicode）、文件类分区**逐字节**等价、patch persona 文本等价 | ✅（见 §3 的已知有损点） |
| 9 | 不删除目标独有配置（§32 合并语义） | ✅ |
| 10 | 重复导入幂等（无失败项） | ✅ |

**未知分区（`unknown-sections`）**

| # | 规格要求 | 本仓库实测 |
|---|---|---|
| 1 | 未知分区**不**阻塞整个 bundle | ✅ `valid=true`、无 error |
| 2 | 明确告警「该分区不受支持、已跳过、数据未导入」 | ✅ **G-01/G-02/G-03 已修复**：`备份包含本版本不支持的分区: keybindings, workflows（已跳过，未导入）` |
| 3 | 不得把它混进「声明但缺失」 | ✅ **已修复**：未知分区单独收集进 `analysis.unsupportedSections`（required 字段）；`missingSections` 只统计「已知分区但 ZIP 内文件缺失」 |
| 4 | 未知分区不产生计划项（数据不落目标） | ✅（且**不再静默**：已明确告知） |

**分区数据版本过高（分区内 `version > 1`）**

| # | 规格要求 | 本仓库实测 |
|---|---|---|
| 1 | 单个分区数据版本高于本版本支持 → **跳过该分区**，不阻断整个 bundle | ✅ **G-05 已修复**（`FC-03` 钉住）：修复前 `version !== 1` 一律 error，一个未来分区就能让**整包无法导入** |
| 2 | 明确告警「哪个分区、什么版本、已跳过」 | ✅ `分区 ui 的数据版本 2 高于本版本支持的 1（已跳过该分区）` |
| 3 | 被跳过的分区不得算进「声明但缺失」，也不得拖低兼容性 | ✅ |
| 4 | `version < 1` / 非数字 / 缺失 → **仍是硬错误**（数据损坏，不可前向兼容） | ✅ `分区 ui 数据无效: …` |

**未知顶层字段（`unknown-fields`）**

| # | 规格要求 | 本仓库实测 |
|---|---|---|
| 1 | 解析后**保留**在内存结果里 | ✅ |
| 2 | 不报错、不告警、不参与任何逻辑 | ✅ `valid=true`、`warnings=[]`、兼容性仍 `excellent` |

**加密包（`baseline + encryption`）**

| # | 规格要求 | 本仓库实测 |
|---|---|---|
| 1 | `security.encrypted === true`，`security.encryption` 记录 `aes-256-gcm` / `scrypt` / salt / iv / authTag | ✅ |
| 2 | 密码与明文凭据**绝不出现在**除 `security/secrets.enc` 外的任何条目 | ✅ |
| 3 | 正确密码解出的明文 == 导出时的 `.credentials.yaml` 原文 | ✅ |
| 4 | `encrypted === true` 且未提供解密结果 → **拒绝执行**（不得静默降级） | ✅ |
| 5 | 错误密码 → `SecurityError(BAD_PASSWORD)`（不是「损坏」、不是静默成功） | ✅ |
| 6 | 解密失败路径**零写入**（无半写入状态） | ✅ |

**版本协商（`schema-v2` / `schema-v0`）**

| # | 规格要求 | 本仓库实测 |
|---|---|---|
| 1 | `schemaVersion > CURRENT` → **硬失败**，错误含版本号且指向「需升级插件」 | ✅ `备份 schema v2（高于当前 1，需升级插件），无法导入（当前支持 v1）` |
| 2 | `< MIN_SUPPORTED` → 硬失败，说明低于最低支持 | ✅ `…（低于最低支持 1，不受支持）…` |
| 3 | 不得报成完整性/损坏错误（避免误导用户重导） | ✅ |
| 4 | 版本不受支持时零写入 | ✅ |

> 版本判定有**两处**，实际可达的只有第一处：
> ① `loadBundle` 用 `isSupported(v)` → 抛错终止；
> ② `analyzeImport` 用 `canImport(v)` → 追加到 `errors`（防御性冗余，`v>1` 与 `v<1` 都会先在 ① 抛错）。
> 外部实现可以只保留 ①，但**不要**做成「尽力而为的部分导入」。

### 2.3 不需要 DSH

整套测试走的是 `src/adapters/test-helpers.ts` 的内存 mock
（`MockHostContext` + `MemFs` / `MemSettings` / `MemCredentials` / `MemPlugins` /
`MemWorkspace` / `MemPatch` / `MemSnapshotStore`）与 `createAdapters()` 的真实 adapter。
核心引擎只依赖 `HostContext` / `ConfigAdapter` 契约（`src/core/types.ts`），
**不 import 任何 DSH 运行时包**。因此你可以：

- 在无 DSH 的 CI 里跑；
- 或者把 `src/core` + `src/schema` + `src/adapters` + `src/utils` 当作参照实现，
  只实现 `HostContext` 即可驱动完整往返。

### 2.4 独立实现的「互操作」自检建议

1. **你的 exporter → 本仓库 importer**：用你的 exporter 产包，跑本仓库
   `Importer.analyzeImport` / `createImportPlan` / `executeImportPlan`，比对 §2.2 的表。
2. **本仓库 exporter → 你的 importer**：用 `corpus.ts` 造 baseline 与三份畸形语料，
   跑你的 importer，逐条对照 §2.2。
3. **字节级契约**：ZIP 条目路径（`config/settings.json`、`custom/skills/<rel>`、
   `agents/presets/<rel>`、`security/credentials.json`、`security/secrets.enc`、
   `integrity/checksums.json`、`manifest.json`）、
   `secrets.enc` 头部布局（`magic "DSC1"` + version + salt16 + iv12 + authTag16 + ciphertext）
   见规格 §1–§4。`CORPUS-01` 断言了「只改 manifest 时其余条目逐字节不变」，
   可作为你实现「无损改写」时的对照。

---

## 3. 测试清单与缺口状态

| 用例 | 覆盖 |
|---|---|
| `RT-01` | 明文 v1 多分区往返：导出产物契约 + Dry Run 零写入 + 7 分区计划 + 数据等价 + 幂等 |
| `RT-02` | 合并语义：不删除目标独有 namespace / 文件 |
| `FC-01` | 未知分区 → 明确告知「不支持、已跳过」+ 独立 `unsupportedSections`（**G-01/G-02/G-03 已修复**） |
| `FC-02` | 未知顶层字段 / 已知对象内未知子字段 → 保留且无副作用 |
| `FC-03` | 分区数据 `version > 1` → 跳过该分区并告警、不阻断；`version` 损坏仍硬失败（**G-05 已修复**） |
| `FC-04` | 语义回归：`missingSections` 只统计「已知分区但文件缺失」，与「未知分区」互不串味 |
| `ENC-01` | 加密往返：正确密码、密码与明文不落盘、无解密结果拒绝执行、凭据按值恢复 |
| `ENC-02` | 加密往返：错误密码 `BAD_PASSWORD` + 解密失败路径零写入 |
| `VER-01` | `schemaVersion=2` → `isTooNew` 硬失败 + 可操作错误 + 零写入 |
| `VER-02` | `schemaVersion=0` → 低于最低支持硬失败 |
| `VER-03` | **G-06/G-07 已修复**：`loadBundle` **方法体内**受 `needsMigration` 守卫地调用 `runSchemaMigration`（B2 加固：解析方法体边界 + 断言调用点落在守卫的受控块内，而非只 grep 文件级符号）+ 每个已应用步骤产生 `import.migrated` 告警 + 迁移结果重新校验 |
| `CORPUS-01` | 语料构造器自身的契约（只改指定结构、checksums 有效） |
| `CORPUS-02` | 完整性语义：篡改数据条目且不重算 checksums → 必须被拒绝；重算后放行 |
| `INT-01` | 完整性反向语义：ZIP 内含未登记进校验表的条目 → 明确告警但不阻断（**G-04 已修复**） |
| `INT-02` | 校验表**缺失** → 必须显式告警「全部条目未被校验」，不得静默通过（**H2 已修复**） |
| `INT-03` | 校验表**为空**（`{}`）→ 同样必须显式告警（**H2 已修复**） |
| `INT-04` | 回归：表存在且非空时语义不变（完整性照旧、未登记条目照旧只告警、不得误报 H2 告警） |

### 3.1 缺口状态（G-01…G-07）

> **本节的缺口已全部修复**，对应的断言已从「特征化当前错误行为」改为「断言新的正确行为」。
> 修复过程遵守 `§4` 的纪律：**先修实现，再改断言**，并对每条修复做了**变异验证**
> （故意回退该处修复 → 确认对应用例红灯 → 还原）。

| 编号 | 缺口 | 修复要点 | 钉住它的用例 |
|---|---|---|---|
| **G-01** | 未知分区被静默丢弃 | `analyzer.extractSections` 识别「不在 `SECTION_IDS` 里」的分区 id 并单独收集，不再 `continue` 丢弃 | `FC-01` |
| **G-02** | 告警文案误导（把「不认识」说成「缺失」） | 新增消息键 `import.unsupportedSections`；`missingSections` 只统计「已知分区但文件缺失」 | `FC-01` |
| **G-03** | 未知分区无法被消费方感知 | `ImportAnalysis` 新增 **required** 字段 `unsupportedSections: string[]`（构造点：analyzer + 测试夹具） | `FC-01` |
| **G-04** | checksums 校验单向：ZIP 内多余条目不校验也不告警 | `loadBundle` 反向比对 → `import.extraEntries` warning（**不阻断**）；排除 `manifest.json` / `checksums.json` / 目录条目 | `INT-01` |
| **G-05** | 分区 `version` 无兼容余地：`!== 1` 一律 error → 整包无法导入 | `extractSections` **前置判定** `version`：数字且 `> 1` → 跳过该分区 + `import.unsupportedSectionVersion` warning；`< 1` / 非数字 / 缺失仍硬错误 | `FC-03` |
| **G-06** | 迁移链是死代码（有定义、有单测、从不执行） | `loadBundle` 在 `needsMigration` 为真时调用 `migrateToCurrent`，**用返回的 doc 作为后续 manifest**，并把 `applied` 步骤记为 `import.migrated` warning | `VER-03` |
| **G-07** | 迁移后不校验结果 | 迁移结果必须通过 `validateManifest`，不合法则抛 `import.migrateInvalidManifest` 明确错误 | `VER-03` |
| **H2** | 校验表缺失/为空时整段完整性逻辑（含 G-04 反向检查）被跳过 → 未校验却零告警 | 校验表**缺失或为空** → `import.checksumsMissing` warning；表存在且非空时语义完全不变 | `INT-02` / `INT-03`（回归：`INT-04`） |

**关于 H2（校验表缺失/为空）**：`integrity/checksums.json` 在格式 v1 里是**可选**的，
缺表本身不构成拒绝理由；H2 修的是「**缺表/空表 = 一个条目都没校验，却当作校验通过**」这个静默。
因此它只加 warning，不改 `verifyAgainstTable` 的既有方向语义（表内键 → ZIP 条目），
也**不**要求「ZIP 条目必须全在表里」。

**关于 G-06 的可达性（务必读）**：`MIN_SUPPORTED_SCHEMA_VERSION = CURRENT_SCHEMA_VERSION = 1`，
所以 `needsMigration(v)` 恒为假，`loadBundle` 里的迁移分支在当前版本**结构上不可达**。
这是**接线**问题，不是**执行**问题：修复后迁移链已被真实引用，`CURRENT > MIN` 的那一天它会真的跑。
为了让「接线」可被独立验证，`VER-03` 直接驱动接线点 `runSchemaMigration(doc, 1, 2)`，
用注册表里真实存在的 v1→v2 步骤跑完整条链。

**待办（不在本目录职责内）**：

- `docs/spec/bundle-format-v1.md` §10 与 `docs/spec/known-gaps.md` 的缺口表需要同步为「已修复」
  （`docs/spec/**` 由契约维护者负责）；具体到 H2：§7.4 与 §10 的 G-04 行仍写着
  「**但 checksums 表缺失时整段跳过 → 零告警**」，该描述在本次修复后**已过时**，
  应改为「表缺失或为空 → `import.checksumsMissing` warning」；
- 按 `§4` 的要求，本次行为变更应在 `CHANGELOG.md` 记一条（修复改变对外行为，属发布亮点）。

**这些断言是「当前真实行为」，不是「期望行为」。**
写法的用意：

- CI 保持绿——测试钉住事实，不制造永久红灯；
- 缺口被永久记录——谁无意中改变了现状会红灯；
- **一旦缺口被修好**，`FC-01` / `VER-03` 会红灯，提醒维护者更新特征化断言，
  并同步 `docs/spec/bundle-format-v1.md` §10 的缺口表。

> **本节的历史写法保留在此作为流程说明，但 G-01…G-07 已经修好**：
> 上表已不再是「特征化断言」，`FC-01` / `FC-03` / `VER-03` / `INT-01` 现在断言的是
> **新的正确行为**。留下的纪律是：**缺陷被修好时，红灯是提醒，不是障碍——
> 先确认「是修好了还是改坏了」，再更新断言（而不是放宽断言）。**

### 3.2 已知有损点（非缺口，规格 §7.3 明示）

- **`prompts` 的 `systemPrompt` 形态**：源 namespace/patch 行里是字符串
  `systemPrompt: "…"`，导入落盘形态为对象 `{ persona: "…" }`。persona **文本**无损，
  但字段**形状**改变。`RT-01` 已注明。
- **已知分区内的未知字段**：不写回目标（导入不是 round-trip 复制，而是把已知语义
  落到目标）。因此**不要**声称「未知字段会被保留到目标」。

---

## 4. 维护须知

- 改 `src/core/analyzer.ts` 的未知分区/版本/加密行为，或改
  `src/core/exporter.ts` 的 ZIP 布局，**必须**重跑本套件。
- 断言红灯时，**不要**为了变绿而放宽断言——先确认是修好了还是改坏了：
  - 修好了 → 更新断言 + 更新规格缺口表 + **在 `CHANGELOG.md` 记一条**（修复行为变更属于发布亮点）；
  - 改坏了 → 修实现。
- 改断言时请顺带做**变异验证**：把刚修好的那处实现**故意回退**，确认对应用例**真的红灯**，
  再还原。本目录的 G-01…G-07 修复都做过这一步（否则「新断言」可能只是恒真的装饰）。
- **源码守卫必须钉「接线」而不是「符号存在」**（B2 教训）：旧 `VER-03` 只断言
  「`src/core/*.ts` 里出现过 `migrateToCurrent`」，而该符号唯一代码行在 `runSchemaMigration`
  函数体内——把 `loadBundle` 的 `if (needsMigration(...))` 改成 `if (false)`，守卫**照样绿**。
  现在 `VER-03` 解析 `loadBundle` 的**方法体边界**，并断言 `runSchemaMigration(` 调用点落在
  `needsMigration` 守卫的**受控块内**（顺序 + 花括号范围）。任何新增源码守卫都要用这条突变
  （`if (false)`）自检：**改坏了必须红灯**，否则它只是装饰。
- **「缺口登记」与「缺口修复」是两件事，不要混淆**：
  - **登记**（记录「现状是什么」）只写 `docs/spec/known-gaps.md` 与
    `docs/spec/bundle-format-v1.md` §10，**不写 CHANGELOG**——既有行为不是本次发布的亮点，
    且 CHANGELOG 的当前版本段会被 CI 抽成 GitHub Release 描述，塞入既有缺口会污染 Release notes；
  - **修复**（改变行为）才写 CHANGELOG，因为那是对外可见的变更。
- 新增语料请沿用 `corpus.ts`（真实 Exporter 造包 + 重算 checksums + 独立输出路径），
  不要在测试里手写 `manifest.json` / `checksums.json` 文本。
