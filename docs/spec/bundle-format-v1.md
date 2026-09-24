# DSH Config Manager 配置 Bundle 格式规格（Bundle Format v1）

> **本文件回答一个问题：第三方在不阅读本仓库源码的前提下，能否实现一个兼容的 exporter / importer。**
>
> 读者对象：任何要读写 `.zip` 配置 bundle 的第三方实现者。
> 写作纪律：每一条断言都给出 `file:line` 取证位置；凡未实际读源码或未实际运行验证的结论，一律显式标注 **「未验证」**，不做推测性陈述。
>
> - 规格版本：Bundle Format **v1**（对应 `CURRENT_SCHEMA_VERSION = 1`）
> - 取证插件版本：`dsh-config-manager@0.1.59`（`package.json:3`）
> - 取证环境：Windows，Node `v24.13.0`
> - 取证方法：读源码 + **实际构造畸形 bundle 跑通 importer 三段式**（见 §0.2），结论以运行结果为准而非以注释为准
> - 本版修订（S-1…S-4 + G-10）：补齐独立审计确认缺失的 4 处关键信息（ZIP 读侧强制/容忍边界、文件类条目名归一化规则、已知分区内未知字段的真实命运、`redactedHits` 语义）并显式澄清 `sections.secrets`；**同时修正了旧版 §1.2「含反斜杠的条目名一律拒绝」这一与实测不符的表述**（实测：仅拒绝以 `\` 开头者，中段 `\` 被接受，见 §3.3.2 与 §10 G-11）
> - **M2 一致性修订（前次）**：让 §10 缺口表、§8.3、§11 未验证清单与「附：一句话结论」与**当前工作区实际状态**一致——原结论段把 §10 已标 ✅ 的 G-01/G-02/G-03/G-06 仍列为「未修复缺口」，§8.3 以现在时断言「导入路径并未调用 `migrateToCurrent`」，§11 把已读码确认的密码强度校验函数调用点仍列为「未验证」，§10 G-09 行标「⏳ 未复核（推测仍成立）」而实测已修复。同时**逐条用 Node 读当前源码行内容**校正了漂移的 `file:line` 取证（G-09 / G-10 / G-04 / G-06 / §11 scanner 与 password 行号、§8.3 的 `isSupported` 行号等），并新增 G-12 / G-13 两条「本轮审计新发现、正在修复」的登记。
> - **M3 产品决策修订（本次）**：**加密备份不再做任何密码强度校验**（产品负责人决策，2026-09-13）。§4.6 的密码强度校验行与「未验证」块、§10 G-08 行、§11 移除块、§10 末尾的「已修复缺口」清单与「附：一句话结论」全部改写为**最终状态**：加密只要求密码**非空**，任何非空密码都可用。原先为实现该闸门而引入的符号（强度校验函数、断言函数、导出路由密码守卫）与消息键 `export.passwordTooWeak` **已从源码整体移除**——本文件不再把它们当作现状描述，仅在下述 G-08 条目中作为**已移除**的历史记录出现。**对第三方实现者的直接要求：不要假设本格式对加密密码有任何强度要求。**
> - **行号时效口径**：本文件的 `file:line` 是**写作时**逐条读源码核对的快照；源码仍在校验期间被并行修改，行号可能再次漂移。检索时请以**符号名 / 消息 key**（如 `runSchemaMigration`、`import.checksumsMissing`、`isFileSection`）为主锚点，行号仅作快速定位。
> - 编码校验：本文件写入后以 Node 逐字节读取校验，确认不含零宽字符（正则 `[\u200b\u200c\u200d\u2060\ufeff]`）且为合法 UTF-8。PowerShell 控制台显示的中文 mojibake 属显示层假象，不作为编码判据。

---

## 0. 范围与取证方法

### 0.1 什么属于本规格，什么不属于

| 属于 Bundle Format v1 | 取证 |
|---|---|
| 导出 ZIP 的顶层布局与文件命名 | `src/core/exporter.ts` |
| `manifest.json` 的字段契约 | `src/schema/manifest.ts:27-44`、`src/schema/manifest.ts:65-123` |
| 13 个分区的落盘形态与 section version | `src/schema/section-registry.ts` 的 `SECTION_REGISTRY`（`payload.zipPath` / `payload.filePrefix`）、`src/schema/section-registry.ts` 的 `SECTION_DATA_VERSION` |
| `integrity/checksums.json` 的格式与校验语义 | `src/utils/hashing.ts:18-52`、`src/core/analyzer.ts:160-205` |
| `security/secrets.enc` 的二进制布局与加密参数 | `src/security/encryption.ts:43-110` |
| 整体加密容器 `DCA1` 的字节布局 | `src/security/encryption.ts:35-41`、`src/security/encryption.ts:203-232` |
| 版本协商与拒绝行为 | `src/schema/versions.ts`、`src/core/analyzer.ts` 的 `loadBundle`（`isTooNew` / `isSupported` 判定与 `import.schemaUnsupported`） |

**不属于本规格**（第三方实现不必兼容，但需要知道它们存在，避免误认为同一格式）：

| 概念 | 实际形态 | 取证 |
|---|---|---|
| sync 通道的「散文件快照目录」 | 目录（非 ZIP），根 `manifest.json` 是 **`SnapshotDirManifest`**（`{id, createdAt, manifest, sectionHashes}`），**不是** bundle manifest | `src/sync/layout.ts`、`src/sync/layout.ts:120-148` |
| 配置市场条目 | `items/<id>/manifest.json`（**`MarketItemManifest`**）+ `config.zip`（**其内部才是本规格的 bundle**） | `src/market/types.ts:99-120` |
| 插件自身运行数据 | `$DSH_HOME/dsh-config-manager/` 下的快照/历史/缓存，不入 bundle | `src/adapters/self.ts:10-11` |

> sync 通道在导入前会把散文件目录**重新组装成标准 bundle ZIP**（`buildManifest` + checksums + 平铺分区，`src/sync/sync-engine.ts`），所以「读 bundle」这一件事只需要实现一次。

### 0.2 本规格的取证方法（可复现）

除读源码外，本文件的关键行为结论由**实际运行**得出：构造标准 bundle → 注入畸形结构（未知分区 / 未知字段 / 分区 version≠1 / 缺失分区文件 / 多余 ZIP 条目 / 加密备份）→ 跑 `Importer.analyzeImport` / `createImportPlan` / `executeImportPlan` → 记录真实返回。§7 的每一条结论都对应一次这样的运行。

本版（S-1…S-4 补全）额外做了一批**字节级**运行验证，方法与产物如下：

| 主题 | 方法 | 结果所在 |
|---|---|---|
| ZIP 读侧强制/容忍边界（method / CRC / EFS / 数据描述符 / 目录条目） | 以真实 `Exporter` 产出 baseline → 在**字节层**改写指定条目的中央目录与本地文件头（含「全 stored 整包」「真实数据描述符整包」两种独立构造）→ 逐条 `parseZip` + `readEntry` + 整包三段式导入 | §1.5 / §1.6 |
| 文件类条目名归一化与 Zip Slip 边界 | 往 ZIP 注入 12 种特制条目名（`//`、`./`、`..`、尾随 `/`、前缀自身、非已知前缀、中段反斜杠、前导斜杠、盘符）→ 三段式导入 → 读目标文件系统键集合 | §3.3.1 / §3.3.2 |
| 已知分区内未知字段是否写回目标 | 在**全部 8 个 JSON 类分区**（`settings`/`ui`/`providers`/`plugins`/`mcp`/`prompts`/`workspaces`/`credentialsStatus`）的载荷里同时注入未知字段标记（其余 5 个文件类分区无 JSON 载荷，结构上无法注入）→ 重算 checksums → 三段式导入到内存 mock 目标 → 逐分区读目标状态 | §7.3 |
| `redactedHits` 的持久化/审计语义 | 全仓库符号检索（`redactedHits` / `redactedFields`）+ 逐个消费点读源码 + 核对 bundle 写入顺序 | §5.3 |

所有探针都是 `%TEMP%` 下的临时脚本（真实 `Exporter` + 内存 mock 目标），**不修改仓库任何文件**，跑完即删；输出为纯文本，已原样抄入对应小节。

---

## 1. ZIP 顶层布局与文件命名规则

### 1.1 布局总表

bundle 是一个普通 ZIP。**顶层是扁平条目，不写显式目录条目**（`src/core/exporter.ts` 只 push 文件条目；读取侧把 `name.endsWith('/')` 视为目录条目并跳过，`src/utils/zip.ts` 的 `parseZip`（`isDirectory: name.endsWith('/')`）、`src/utils/zip.ts` 的 `ZipArchive.readEntry`（`if (meta.isDirectory) return Buffer.alloc(0)`））。

| ZIP 内相对路径 | 形态 | 来源 |
|---|---|---|
| `manifest.json` | JSON | `src/schema/manifest.ts:10`、`src/core/exporter.ts` |
| `integrity/checksums.json` | JSON | `src/schema/manifest.ts:11`、`src/core/exporter.ts` |
| `config/settings.json` | JSON | `src/schema/section-registry.ts` 的 `SECTION_REGISTRY`（`settings` 条目） |
| `config/ui.json` | JSON | `src/schema/section-registry.ts` 的 `SECTION_REGISTRY`（`ui` 条目） |
| `ai/providers.json` | JSON | `src/schema/section-registry.ts` 的 `SECTION_REGISTRY`（`providers` 条目） |
| `plugins/plugins.json` | JSON | `src/schema/section-registry.ts` 的 `SECTION_REGISTRY`（`plugins` 条目） |
| `mcp/servers.json` | JSON | `src/schema/section-registry.ts` 的 `SECTION_REGISTRY`（`mcp` 条目） |
| `custom/prompts.json` | JSON | `src/schema/section-registry.ts` 的 `SECTION_REGISTRY`（`prompts` 条目） |
| `workspaces/workspaces.json` | JSON | `src/schema/section-registry.ts` 的 `SECTION_REGISTRY`（`workspaces` 条目） |
| `security/credentials.json` | JSON | `src/schema/section-registry.ts` 的 `SECTION_REGISTRY`（`credentialsStatus` 条目） |
| `security/secrets.enc` | 二进制（非 JSON） | `src/core/exporter.ts` |
| `custom/skills/**` | 真实文件（递归） | `src/schema/section-registry.ts` 的 `SECTION_REGISTRY`（`skills` 条目） |
| `agents/presets/**` | 真实文件（递归） | `src/schema/section-registry.ts` 的 `SECTION_REGISTRY`（`agentPresets` 条目） |
| `custom/agent-instructions/**` | 真实文件 | `src/schema/section-registry.ts` 的 `SECTION_REGISTRY`（`agentInstructions` 条目） |
| `plugin-files/**` | 真实文件（递归） | `src/schema/section-registry.ts` 的 `SECTION_REGISTRY`（`pluginFiles` 条目） |
| `sessions/**` | 真实文件（递归） | `src/schema/section-registry.ts` 的 `SECTION_REGISTRY`（`sessions` 条目） |
| `self/**` | 真实文件 | `src/schema/section-registry.ts` 的 `SECTION_REGISTRY`（`self` 条目） |

真实产物的条目集合示例（来自 §0.2 的运行结果，未加密、默认分区）：

```
config/settings.json
config/ui.json
ai/providers.json
plugins/plugins.json
mcp/servers.json
custom/prompts.json
workspaces/workspaces.json
security/credentials.json
integrity/checksums.json
manifest.json
```

带密码导出时多一条 `security/secrets.enc`。

### 1.2 文件命名规则（第三方 exporter 必须遵守，否则本实现会拒收）

| 规则 | 细节 | 取证 |
|---|---|---|
| 分隔符 | **写侧**恒为正斜杠 `/`。**读侧**：`isPathSafe` 只拒绝「以 `/` 或 `\` 开头」的名字与「含 `..` 段」的名字，**中段反斜杠会被接受**（实测见 §3.3.2 的 C10 与「isPathSafe 逐值」段；缺口登记见 §10 G-11） | `src/utils/paths.ts:45-54`（`isPathSafe`，`src/utils/zip.ts` 的 `parseZip`（条目名 `isPathSafe` 闸） 引用）；checksums 侧另有 `relPath.includes('\\')` 拒绝（`src/security/integrity.ts:63`） |
| 绝对路径 | 拒绝（`/abs`、`C:\`、`C:/`、UNC） | `src/utils/zip.ts` 的 `parseZip`（条目名 `isPathSafe` 闸）、`src/core/smoke.test.ts:480-485` |
| 目录穿越 | 拒绝含 `..` 段的条目名（Zip Slip） | `src/utils/zip.ts` 的 `parseZip`（条目名 `isPathSafe` 闸） |
| 文件名编码 | UTF-8；写侧置 general purpose flag bit 11（`0x0800`）；**读侧不校验该 flag**（见 §1.5） | `src/utils/zip.ts` 的 `buildLocalHeader` / `buildCentralHeader`（`0x0800` UTF-8 文件名 flag）、`src/utils/zip.ts` 的 `parseZip`（不校验 general purpose flag） |
| 压缩方法 | 写侧恒 deflate（method=8）；读侧只接受 0（store）与 8（deflate），其余抛错 | `src/utils/zip.ts` 的 `buildLocalHeader` / `buildCentralHeader`（method 字段 = 8）、`src/utils/zip.ts` 的 `ZipArchive.readEntry`（`method ∈ {0, 8}`，其余抛错） |
| CRC32 | 每条目必带；读侧逐条校验，不符即整体拒绝 | `src/utils/zip.ts` 的 `zipToBuffer`（写侧 CRC32）与 `ZipArchive.readEntry`（CRC32 校验） |
| 解压尺寸 | 必须与中央目录声明的 `uncompressedSize` 一致 | `src/utils/zip.ts` 的 `ZipArchive.readEntry`（`uncompressedSize` 校验） |
| 数据描述符（bit 3） | 写侧**从不**设置；读侧**不解析也不校验**该 flag（见 §1.5） | `src/utils/zip.ts` 的 `buildLocalHeader` / `buildCentralHeader`（写 `0x0800` UTF-8 文件名 flag，flag 不含 `0x0008`）与 `parseZip`（不解析该 flag） |
| 显式目录条目 | 允许存在但会被跳过（不产生文件） | `src/utils/zip.ts` 的 `parseZip`（`isDirectory: name.endsWith('/')`）、`src/utils/zip.ts` 的 `ZipArchive.readEntry`（`if (meta.isDirectory) return Buffer.alloc(0)`） |
| 条目顺序 | 无契约保证；不要依赖顺序 | `src/core/exporter.ts`（顺序由 adapter registry 与收尾写入决定，未在格式层固定） |

### 1.3 安全限额（读侧默认值，第三方 exporter 的产物必须落在限额内）

| 限额 | 默认值 | 取证 |
|---|---|---|
| 条目数 `maxEntries` | 10000 | `src/utils/zip.ts` 的 `DEFAULT_ZIP_SAFETY_LIMITS.maxEntries` |
| 解压后累计字节 `maxTotalBytes` | 500 MiB | `src/utils/zip.ts` 的 `DEFAULT_ZIP_SAFETY_LIMITS.maxTotalBytes` |
| 压缩数据累计字节 `maxCompressedBytes` | 200 MiB | `src/utils/zip.ts` 的 `DEFAULT_ZIP_SAFETY_LIMITS.maxCompressedBytes` |
| 单条目解压后 `maxSingleBytes` | 100 MiB | `src/utils/zip.ts` 的 `DEFAULT_ZIP_SAFETY_LIMITS.maxSingleBytes` |
| 单条目压缩比 `maxRatio` | 200 | `src/utils/zip.ts:40` |
| JSON 嵌套深度 | 64 | `src/utils/json.ts:7` |
| JSON 单文档字节 | 64 MiB | `src/utils/json.ts:8` |
| 市场条目 `config.zip` 字节上限 | 64 MiB（**仅市场通道**，普通导入不受此限） | `src/market/types.ts:30` |

超出限额的后果是**抛错并整体拒绝**，不是部分导入（`src/utils/zip.ts` 的 `assertZipEntryCount` 与 `ZipArchive.readEntry`（超限即抛 `ZipSafetyError`）、`src/utils/zip.ts:231-239`）。

### 1.4 更严格的「加固解析」差异（第三方需知）

本实现的**默认解析器** `parseZip`（`src/utils/zip.ts`）上就已强制下列强化检查（`src/security/zip-security.ts` 的 `parseZipHardened` 现为该默认解析器的**兼容别名**：注入它与不注入等价），它在 §1.3 之上额外**拒绝**：

- 重复条目名（`src/utils/zip.ts` 的 `parseZip` 条目名闸：`seenNames` 重复检测）；
- symlink 条目（按 external attrs 的 Unix mode `S_IFLNK` 判定，`src/utils/zip.ts` 的 `parseZip`）。

> **未验证**：普通导入（GUI 导入向导）是否恒使用 `parseZipHardened`。`ImporterOptions.parseZipOverride` 缺省为 `parseZip`（`src/core/analyzer.ts` 的 `AnalyzerOptions.parseZipOverride` 与 `Analyzer` 的 `parseZipFn` 缺省），是否注入由宿主决定；本文件只确认该强化解析器**存在**且被市场校验路径使用（`src/market/security.ts`）。第三方 exporter 不应依赖「重复条目名会被容忍」。

### 1.5 读侧强制 vs 容忍的精确边界（压缩方法 / CRC / UTF-8 flag / 数据描述符 / 目录条目）

§1.2 只给出「写什么、读什么会抛错」的结论。本节把**每一条的判定位置、判定时机与真实容差**写清楚——这是第三方 importer 决定「该接受还是该拒绝」的唯一依据。全部结论来自 §0.2 的运行验证（构造畸形 bundle → 跑 `analyzeImport` / `createImportPlan` / `executeImportPlan`，观察真实返回），命令与输出见 §1.6。

#### 1.5.1 判定分两个阶段：`parseZip` 阶段 vs `readEntry` 阶段

**关键区分**：读侧有**两道**闸，二者时机不同、失败后果也不同。

| 阶段 | 做什么 | 不做什么 | 取证 |
|---|---|---|---|
| ① `parseZip(buf, limits)`（构造 `ZipArchive`） | 解析 EOCD → 遍历中央目录 → 逐条 `isPathSafe(name)` → 累计条目数与压缩体积 | **不读本地文件头、不解压、不校验 CRC、不校验尺寸、不看 method 是否受支持、不看 flag** | `src/utils/zip.ts` 的 `parseZip`（EOCD + 中央目录：累计条目数与压缩体积） |
| ② `archive.readEntry(name)`（真正取字节） | 定位本地文件头 → 取压缩数据 → 按 method 解压 → 校验 `uncompressedSize` → 校验 CRC32 → 累计解压体积与压缩比 | 不重新校验条目名 | `src/utils/zip.ts` 的 `ZipArchive.readEntry`（解压 → `uncompressedSize` → CRC32 → 体积/压缩比累计） |

因此：**method=12（bzip2）与 CRC 不符的条目，`parseZip` 会成功返回**，错误只在 `readEntry` 时才抛出（实测 V2 / V3）。第三方 importer 若把「`parseZip` 成功」当作「bundle 合法」，会得到一个静默半合法的中间态。

#### 1.5.2 压缩方法：写侧恒 8；读侧接受 {0, 8}，其余抛错

| 项 | 真实行为 | 取证 |
|---|---|---|
| 写侧 | 恒 `deflateRawSync` + 本地头/中央目录 method 字段 = `8` | `src/utils/zip.ts` 的 `zipToBuffer` / `writeZip`（`deflateRawSync`）与 `buildLocalHeader` / `buildCentralHeader`（method 字段 = 8：`local.writeUInt16LE(8, 8)`） |
| 读侧 method = `0`（store） | **接受**：直接把压缩数据切片当解压结果，不做 inflate | `src/utils/zip.ts` 的 `ZipArchive.readEntry`（`meta.method === 0` 直接取切片） |
| 读侧 method = `8`（deflate） | **接受**：`zlib.inflateRawSync(raw, { maxOutputLength: maxSingleBytes })`；inflate 失败 → `ZipSafetyError`（`条目 "X" 解压失败: ...`） | `src/utils/zip.ts` 的 `ZipArchive.readEntry`（`inflateRawSync` 失败 → `ZipSafetyError`） |
| 读侧其它 method | **抛错**：`条目 "X" 使用未知压缩方法 {n}` | `src/utils/zip.ts` 的 `ZipArchive.readEntry`（未知压缩方法 → 抛错） |

**实测**（§1.6 命令 `V2`）：把 `config/settings.json` 的 method 改为 `12` → `parseZip OK`；`readEntry` 抛 `条目 "config/settings.json" 使用未知压缩方法 12`。

**方法 0 的一个反直觉后果（第三方必须知道）**：`method === 0` 时 `out = raw`，而 `raw` 的长度**就是中央目录声明的 `compressedSize`**。于是紧接着的尺寸校验（`out.length !== uncompressedSize`）在 stored 条目上等价于「**`compressedSize` 必须等于 `uncompressedSize`**」。因此一个「stored 但声明的 compSize ≠ uncompSize」的条目会被判为**解压尺寸不符**而不是「压缩比异常」（实测 §1.6 `S2`/`S3`/`S5`）。

**应然边界（给第三方 importer）**：

- **必须接受** `method ∈ {0, 8}`——本实现自己的写侧只产 8，但读侧明确接受 0（`tests/security/import-security.test.ts:44-75` 的 `buildRawZip` 就以 method=0 构造合法备份并被 `analyzeImport` 接受；实测 §1.6 `V8` 整包全 stored 导入 `valid=true` 且目标数据正确）。
- **必须拒绝**其余 method（不可猜解压算法）。
- **不要**因为「写侧只用 8」就只接受 8：那会拒掉本实现自己接受的一类 bundle。
- **不要**在 stored 条目上省略 `compressedSize === uncompressedSize` 的检查：本实现会在 `readEntry` 阶段以「解压尺寸不符」拒绝，且 `parseZip` 阶段不会提前发现。

#### 1.5.3 CRC32：读侧**强制**逐条校验，不符即整体拒绝

| 项 | 真实行为 | 取证 |
|---|---|---|
| 写侧 | 本地头 `crc` 字段（偏移 14）与中央目录 `crc` 字段（偏移 16）都写真实 CRC32 | `src/utils/zip.ts` 的 `buildLocalHeader`（`writeUInt32LE(crc, 14)`）、`src/utils/zip.ts` 的 `buildCentralHeader`（`writeUInt32LE(crc, 16)`）、`src/utils/zip.ts` 的 `zipToBuffer`（写侧传入 `crc32(data)`） |
| 读侧取值来源 | **只读中央目录的 CRC**（`src/utils/zip.ts` 的 `parseZip`：`crc = b.readUInt32LE(pos + 16)`，即中央目录的 `c.readUInt32LE(pos + 16)`），本地头的 CRC 字段**被忽略** | `src/utils/zip.ts` 的 `parseZip`（中央目录解析） |
| 校验 | `crc32(解压结果) !== meta.crc32` → 抛 `条目 "X" CRC32 校验失败（ZIP 已损坏）` | `src/utils/zip.ts` 的 `zipToBuffer`（写侧 CRC32）与 `ZipArchive.readEntry`（CRC32 校验） |
| 校验时机 | `readEntry` 阶段（不是 `parseZip` 阶段） | 同上 |

**实测**（§1.6 `V3`）：中央目录与本地头的 CRC 各翻转 1 bit → `parseZip OK`；`readEntry` 抛 `CRC32 校验失败（ZIP 已损坏）`。

**实测**（§1.6 `V7`）：**只**把本地头的 CRC/`compressedSize`/`uncompressedSize` 三个字段清零（中央目录保持正确）+ 置 bit3 → `readEntry OK(504B)`。这**证明**本地头的这三个字段对读取路径完全无影响。

**第三方 importer 应然边界**：CRC 是**强制**项，不是可选优化。且**必须取中央目录的值**——若第三方取本地头的值，就会在本实现明确接受的 bundle（V7 形态）上误报损坏。

#### 1.5.4 UTF-8 flag（EFS，general purpose bit 11 = `0x0800`）：写侧恒置，读侧**完全不看**

| 项 | 真实行为 | 取证 |
|---|---|---|
| 写侧 | 本地头（偏移 6）与中央目录（偏移 8）都写 `0x0800` | `src/utils/zip.ts` 的 `buildLocalHeader` / `buildCentralHeader`（`0x0800` UTF-8 文件名 flag：`buildLocalHeader` 写 `local.writeUInt16LE(0x0800, 6)`，`buildCentralHeader` 写 `cen.writeUInt16LE(0x0800, 8)`） |
| 读侧 | **没有任何代码读取 general purpose flag 字段**（`parseZip` 只取 method / crc / 尺寸 / 名字长度 / extra / comment / localOffset） | `src/utils/zip.ts` 的 `parseZip`（无 flag 读取；只额外读 `externalAttrs`） |
| 条目名解码 | 恒 `b.subarray(...).toString('utf8')`，**与 flag 无关** | `src/utils/zip.ts` 的 `parseZip`（条目名解码） |

**实测**（§1.6 `V5`）：把本地头与中央目录的 bit11 都清掉 → `parseZip OK`；`readEntry OK(504B)`；条目名仍是正确的 UTF-8。

**实测**（§1.6 `V7`）：同时清 EFS + 置 bit3 + 清本地头 CRC → 仍然 `OK`。

**应然边界**：

- 写侧**必须**置 bit11（本实现自己的产物会置；不置虽不会被本实现拒收，但对只认 flag 的通用 ZIP 工具会造成乱码）。
- 读侧**不得**因 flag 未置而拒绝，也**不得**据此改用 CP437/本地代码页解码——本实现恒按 UTF-8 解码。第三方若按 flag 切换解码表，会在「未置 flag 但内容其实是 UTF-8」的 bundle 上与本实现产生**不同的文件名**（进而是不同的 `relativePath`），这是真实分歧点，不是理论问题。

#### 1.5.5 数据描述符（bit 3 = `0x0008`）：写侧不产生，读侧不解析

| 项 | 真实行为 | 取证 |
|---|---|---|
| 写侧 | flag 恒为 `0x0800`（**不含** `0x0008`），因此**从不**产生数据描述符 | `src/utils/zip.ts` 的 `buildLocalHeader` / `buildCentralHeader`（`0x0800` UTF-8 文件名 flag：`buildLocalHeader` 写 `local.writeUInt16LE(0x0800, 6)`，`buildCentralHeader` 写 `cen.writeUInt16LE(0x0800, 8)`） |
| 读侧定位数据 | `dataStart = localOffset + 30 + nameLen + extraLen`；`raw = buf.subarray(dataStart, dataStart + compressedSize)` —— `compressedSize` 取自**中央目录**，本地头的 `compressedSize` 字段被忽略 | `src/utils/zip.ts` 的 `parseZip`（中央目录 `compressedSize`）与 `ZipArchive.readEntry`（按中央目录尺寸切片） |
| 读侧对 bit3 | **不检查**该 flag，也不跳过任何描述符字节 | `src/utils/zip.ts` 的 `parseZip`（不检查 bit3、不读取该 flag） |

**实测**（§1.6 `V6`）：只置 bit3（本地头仍写正确 CRC/尺寸）→ `readEntry OK`。

**实测**（§1.6 `V9`）：构造**真实**数据描述符形态——本地头 bit3=1 且 CRC/`compressedSize`/`uncompressedSize` 三个字段置 0，压缩数据之后附 16 字节描述符（`0x08074b50` + crc + compSize + uncompSize），中央目录保持正确值 → `readEntry OK(504B)`，整包导入 `valid=true`，目标 namespace 数据正确。

**为什么能容忍**：读取路径完全靠**中央目录**的 `compressedSize` 与 `localOffset` 定位数据，从不依赖本地头里被置零的字段，因此描述符字节只是被「跳过」（不在任何条目的 `[dataStart, dataStart+compressedSize)` 区间内，因为 `localOffset` 与 `compressedSize` 都来自中央目录）。

**应然边界**：

- 写侧**不应**产生数据描述符（本实现不产生；产生的包也能被本实现读，但会平白增加一类兼容面）。
- 读侧**应当容忍**数据描述符（本实现容忍，且容忍度来自「只信中央目录」这一更普适的规则）。
- 第三方 importer 若打算用本地头字段校验尺寸/CRC，必须先检查 bit3 并回退到中央目录，否则会在合法 bundle 上误判。

#### 1.5.6 目录条目：允许存在，一律跳过，**不产生文件**

| 项 | 真实行为 | 取证 |
|---|---|---|
| 识别 | `isDirectory: name.endsWith('/')`（只看名字，不看 external attrs） | `src/utils/zip.ts` 的 `parseZip` 条目元数据（`isDirectory: name.endsWith('/')`）、`src/security/zip-security.ts` 的 `safeExtractHardened`（`meta.isDirectory` 跳过） |
| `readEntry` | 目录条目**直接返回 0 字节**，不读本地头、不解压 | `src/utils/zip.ts` 的 `ZipArchive.readEntry`（目录条目返回 0 字节） |
| 解压（`safeExtract`） | `if (meta.isDirectory) continue;` —— 跳过，不建目录、不写文件 | `src/utils/zip.ts` 的 `safeExtract`（同款跳过）、`src/security/zip-security.ts` 的 `safeExtractHardened`（同款 `if (meta.isDirectory) continue`） |
| 分区提取 | `if (rel === '' \|\| rel.endsWith('/')) continue;` —— 文件类分区也跳过目录条目 | `src/core/analyzer.ts` 的 `extractSections`（`if (rel === '' || rel.endsWith('/')) continue;`） |

**实测**（§1.6 `S-2 C6` / `C7`）：往 ZIP 里加 `custom/skills/probe/dir-entry/`（0 字节）与 `custom/skills/`（0 字节）→ `analysis.valid=true`；skills 计划项为 `[]`；目标文件系统**没有**新增任何条目。

**应然边界**：

- **必须接受**显式目录条目（不报错、不拒绝整个 bundle）。
- **必须跳过**它们，不得据此创建空文件或空目录。
- 目录条目的 `uncompressedSize` 通常为 0；由于 `readEntry` 在 `isDirectory` 时提前返回 0 字节，**`checksums.json` 若覆盖目录条目，其值必须是空缓冲的 SHA-256**（`e3b0c442...`）。本实现自己的写侧从不写目录条目，因此正常产物不会触发这条；但第三方若在 checksums 表里登记目录条目并写了「非空内容的哈希」，本实现会在第 4 步完整性校验直接拒绝（实测：`备份完整性校验失败: "custom/skills/probe/dir-entry/"`）。

#### 1.5.7 一句话总结（第三方 importer 的最小强制集）

| 检查项 | 强制？ | 取值来源 |
|---|---|---|
| 条目名安全（绝对路径 / 盘符 / UNC / `..` 段 / NUL） | **强制** | 中央目录的 name（`src/utils/zip.ts` 的 `parseZip`（条目名 `isPathSafe` 闸）） |
| 条目数与压缩体积限额 | **强制** | EOCD + 中央目录（`src/utils/zip.ts` 的 `parseZip`：EOCD + 中央目录的条目数/压缩体积限额，以及中央目录逐条校验） |
| method ∈ {0, 8} | **强制**（其它拒绝） | 中央目录（`src/utils/zip.ts` 的 `parseZip`（中央目录 `method`）） |
| `解压结果长度 === uncompressedSize` | **强制** | 中央目录（`src/utils/zip.ts` 的 `ZipArchive.readEntry`（`uncompressedSize` 校验）） |
| CRC32 === 解压结果 CRC | **强制** | **中央目录**（`src/utils/zip.ts` 的 `zipToBuffer`（写侧 CRC32）与 `ZipArchive.readEntry`（CRC32 校验）） |
| UTF-8 flag 已置 | **不检查** | — |
| 数据描述符 | **不解析、不拒绝** | — |
| 目录条目 | **跳过，不拒绝** | name 尾随 `/` |
| 解压总体积 / 单条压缩比限额 | **强制** | `readEntry` 累计（`src/utils/zip.ts` 的 `ZipArchive.readEntry`（累计解压体积与压缩比）） |
| 重复条目名 / symlink | **默认解析器**即强制（`parseZip`，§1.4） | 中央目录 externalAttrs（`src/utils/zip.ts` 的 `parseZip`；`parseZipHardened` 即其别名） |

### 1.6 §1.5 的实测命令与输出（可复现）

探针脚本（临时文件，跑完即删）以真实 `Exporter` 产出 baseline bundle，再在**字节层**改写指定条目的中央目录与本地文件头，最后逐条 `parseZip` + `readEntry` + 整包三段式导入。Node `v24.13.0`，Windows。

```text
目标条目 meta = {"name":"config/settings.json","method":8,"compressedSize":236,"uncompressedSize":504,"crc32":3195251988,"isDirectory":false,"localOffset":0}
V1 method 改为 0（stored，但字节仍是 deflate）        → parseZip OK；readEntry THROW: 条目 "config/settings.json" 解压尺寸不符（236 ≠ 504）
V2 method 改为 12（bzip2）                          → parseZip OK；readEntry THROW: 条目 "config/settings.json" 使用未知压缩方法 12
V3 CRC 翻转一位                                     → parseZip OK；readEntry THROW: 条目 "config/settings.json" CRC32 校验失败（ZIP 已损坏）
V4 uncompressedSize 篡改 +1                          → parseZip OK；readEntry THROW: 条目 "config/settings.json" 解压尺寸不符（504 ≠ 505）
V5 清掉 UTF-8 flag(EFS) bit11                       → parseZip OK；readEntry OK(504B)
V6 置 bit3（数据描述符标志）                          → parseZip OK；readEntry OK(504B)
V7 清 EFS + 置 bit3 + 清本地头 CRC/尺寸                → parseZip OK；readEntry OK(504B)
V8 全 stored（method=0）整包导入                       → valid=true；plan={"settings":2,"ui":1,"providers":1,"plugins":1,"mcp":1,"prompts":1,
                                                       "skills":1,"agentPresets":1,"agentInstructions":1,"workspaces":2,"pluginFiles":1,
                                                       "self":2,"credentialsStatus":1}；dst.general={"theme":"dark","language":"zh-CN"}
V9 真实数据描述符（bit3=1，本地头 CRC/尺寸=0 + 16B 描述符） → readEntry OK(504B)；整包 valid=true；目标 namespace 数据正确
```

```text
--- method=0 的尺寸/比例边界（独立探针）---
S1 正常 stored                                    → readEntry OK len=22
S2 stored：声明 compressedSize = 0                 → readEntry THROW: 解压尺寸不符（0 ≠ 22）
S3 stored：声明 compressedSize > 实际               → readEntry THROW: 解压尺寸不符（26 ≠ 22）
S4 stored：compSize=uncompSize=5 但内容 22 字节      → readEntry THROW: CRC32 校验失败（ZIP 已损坏）
S5 stored：压缩比 > 200（compSize=1, uncompSize=22） → readEntry THROW: 解压尺寸不符（1 ≠ 22）
```

```text
--- 目录条目语义（独立探针）---
meta = [{"name":"custom/skills/probe/dir/","method":8,"compressedSize":2,"uncompressedSize":0,"crc32":0,"isDirectory":true,"localOffset":0}]
readEntry("custom/skills/probe/dir/") 长度 = 0
--- 空文件条目（非目录） ---
meta = [{"name":"custom/skills/empty.md","method":8,"compressedSize":2,"uncompressedSize":0,"crc32":0,"isDirectory":false,"localOffset":0}]
readEntry("custom/skills/empty.md") 长度 = 0
crc32(空) = 0
```

> 说明：`S4` 之所以报 CRC 而非尺寸，是因为 `compSize = uncompSize = 5` 使尺寸校验通过（`out.length === 5`），随后 CRC 校验失败——即**尺寸与 CRC 是两道独立闸**，前者先跑。

---

## 2. `manifest.json` 字段规格

### 2.1 序列化形态

- pretty JSON，缩进 2 空格（`src/core/exporter.ts` 调 `stringifyJsonSafe(manifest, { space: 2 })`）。
- 无尾随换行（`JSON.stringify` 语义）。
- 解析侧：先 `JSON.parse`，再按 §2.3 逐字段校验；**任一 `error` 级问题即整体拒绝**（`src/schema/manifest.ts:52-60`）。

### 2.2 字段表

类型记号：`T?` = 可选（缺省合法）；其余为必需。

| 字段 | 类型 | 必需 | 语义 | 校验（不满足即 error → 拒绝导入） | 取证 |
|---|---|---|---|---|---|
| `schemaVersion` | `number` | 必需 | bundle 结构版本，v1 恒为 `1` | 必须是数字 | `src/schema/manifest.ts` |
| `exporter.name` | `string` | 必需 | 导出器名；本实现恒为 `"DSH Config Manager"` | 必须是字符串 | `src/schema/manifest.ts:12`、`src/schema/manifest.ts` |
| `exporter.version` | `string` | 必需 | 导出器（插件）版本，如 `"0.1.59"` | 必须是字符串 | `src/schema/manifest.ts` |
| `source.dshVersion` | `string` | 必需 | 源机器 DSH 版本；CLI 离线导出写 `"cli-offline"` | 必须是字符串 | `src/schema/manifest.ts`、`src/cli/index.ts` |
| `source.platform` | `Platform` | 必需 | 源平台，见 §2.4 取值表 | 必须是字符串（**不校验是否在枚举内**） | `src/schema/manifest.ts` |
| `source.arch` | `string` | 必需 | 源架构，如 `"x64"` | 必须是字符串 | `src/schema/manifest.ts` |
| `exportedAt` | `string` | 必需 | 导出时间，ISO-8601 UTC | 必须是字符串且 `Date.parse` 非 NaN | `src/schema/manifest.ts` |
| `sourceHome` | `string?` | 可选 | **导出机的 DSH home 绝对路径**（Linux 形如 `/opt/dsh/.dsh`，Windows 为盘符加反斜杠形态）。导入时与**本机** home 比较：不同则自动把「位于导出机 home 之下的绝对路径」（会话首帧 cwd / 工作区 path / mcp cwd…）**重定基**到本机 home（同一后缀），并排在用户路径映射之前 | **不校验**（宽容读取：缺失 / 非字符串一律按「未知」处理，此时不做任何自动改写，行为与改造前逐字一致） | `src/schema/types.ts`（Manifest.sourceHome）、`src/core/analyzer.ts`（rebaseMapping） |
| `sections` | `Record<SectionId, boolean>` | 必需 | 分区开关表，见 §2.5 | 必须是对象；每个**值**必须是布尔 | `src/schema/manifest.ts:97-109` |
| `security.containsSecrets` | `boolean` | 必需 | bundle 是否携带真实凭据明文 | 必须是布尔 | `src/schema/manifest.ts` |
| `security.encrypted` | `boolean` | 必需 | 是否需要密码才能导入 | 必须是布尔 | `src/schema/manifest.ts` |
| `security.encryption` | `EncryptionInfo \| null` | 必需（可为 `null`） | 加密参数元数据，见 §4 | 必须是对象或 `null` | `src/schema/manifest.ts` |

> **`sourceHome` 的语义**：DSH 的基础路径（`$DSH_HOME`）在不同设备上可能不同（`/opt/.../.dsh` vs Windows 盘符形态），而备份里的路径是绝对路径 —— 即使目标机把目录建出来，路径语义仍然错。因此导出时把基础路径随包带走，导入时若不同就**自动重定基**（只对位于导出机 home 之下、且落在段边界的路径生效；相对路径与不相关的绝对路径一律不动）。基础路径是机器身份、本机可精确得知，故比让用户手填自由前缀映射更安全可控；用户映射仍排在其后依次生效，可覆盖本规则。**schema 不声明该字段**：实现对它只做宽容读取（不校验类型），按本节 2.3 的约束强度原则（schema 不得比实现更严），不声明即为正确形态。

### 2.3 未知字段的处理（manifest 层）

`validateManifest` **不做白名单重写**，只对已知字段做类型检查（`src/schema/manifest.ts:65-123`），`parseManifest` 返回的仍是同一个解析结果（`src/schema/manifest.ts:52-60`）。因此：

- **顶层未知字段**：解析后**保留**在结果对象里（不报错、不丢弃）。测试固定：`tests/schema-compat.test.ts:96-125`（SC-07，断言 `x-future-manifest-key` 与 `exporter.futureExporterField` 均保留）。
- **已知对象内的未知子字段**：同上保留（`tests/schema-compat.test.ts:120-124`）。
- **`sections` 内的未知分区键**：产生 **warning（不是 error）**，因此**不会**阻止解析。测试固定：`tests/schema/manifest.test.ts:81-89`（M-04）。

> ⚠️ 这里有一个容易踩的落差：**manifest 层「未知分区」只是 warning 且被保留**，但**导入层会把它丢掉**。这是 §7 的核心议题。

### 2.4 `source.platform` 取值表

`src/schema/types.ts:9-11`：

```
win32 | darwin | linux | freebsd | openbsd | aix | sunos | android | cygwin | haiku | netbsd | other
```

### 2.5 `sections` 的键集合（15 个，恒全量出现）

> **分区清单的唯一权威是 `SECTION_REGISTRY`（机器可读）**：`src/schema/section-registry.ts` 的
> `SECTION_REGISTRY: Record<SectionId, SectionMeta>` 逐分区声明 id / 载荷形态 / 可移植性 / 同步可选 /
> 默认勾选 / 风险分级；`SECTION_IDS`（按 `applyOrder` 升序）、`SECTION_JSON_PATHS`、
> `SECTION_FILE_PREFIXES`、`isFileSection` 都是它的**派生视图**，第三方可经 `dsh-config-manager/schema`
> 导入（见 `headless-consumption.md` §3），**不必读 `src/`**。本节下面的清单是注册表的**人读快照**：
> 分区增删时**以注册表为准**（不要照抄本节）；`tests/schema/manifest-schema.test.ts` 的 K-04 断言
> `bundle-manifest.schema.json` 的 `x-section-ids` 副本与 `SECTION_IDS` 逐项一致（漂移即红灯）。

`buildSectionFlags` 先为**全部已知分区**置 `false`，再把实际导出的置 `true`（`src/core/exporter.ts`）。所以：

- `sections` 恒包含全部 **15 个键**（= `SECTION_IDS`；`SECTION_IDS.length === 15` 由 `tests/schema/manifest-schema.test.ts` 的 S-02 断言），缺一不可：`settings, ui, providers, plugins, mcp, prompts, skills, agentPresets, agentInstructions, workspaces, pluginFiles, credentialsStatus, secrets, sessions, self`。
- 这 15 个键要按**两种性质**分开读，否则极易误读为「只写 14 个键」（判据在注册表的 `payload.kind` 上）：
  - **14 个真实数据分区 id**：上表里的 `settings, ui, providers, plugins, mcp, prompts, skills, agentPresets, agentInstructions, workspaces, pluginFiles, credentialsStatus, sessions, self`——即注册表中 `payload.kind !== 'none'` 的全部条目，每个都对应一个 adapter / ZIP 目录，可被置 `true` 或 `false`；
  - **1 个状态位 `secrets`**：注册表里**唯一** `payload.kind === 'none'` 的条目——**不是数据分区**，全仓库没有它的 adapter（见 §3.2），因此它在 `sections` 里**恒为 `false`**（`src/core/exporter.ts`）。它出现在表里只为「键集合恒全量」这一条不变量，**不代表 bundle 含凭据**——是否含凭据由 `security.containsSecrets` / `security.encrypted` 承载（见 §4）。
- **所以第三方 exporter 应当写满 15 个键**（14 个数据分区 + `secrets: false`）：本实现自己的导出端**永远**写满。需要留意校验强度——`validateManifest` 对 `sections` 只检查「值必须是布尔」与「键是否已知（未知键仅 warning）」（`src/schema/manifest.ts:97-104`），**并不强制 15 个键齐全**；但缺键会让接收端把该分区当作「未声明」，因此不建议依赖这种宽松。**取证**：§0.2 运行产物中 `manifest.sections` 的键集合与 `SECTION_IDS`（派生自 `SECTION_REGISTRY`，**15 项**，其中 `secrets` 亦在列）逐项一致。
- **未知分区键可以存在**（仅 warning），但本实现的导出端**永不会**产生它们。

> ### ⚠️ G-10：`sections.secrets` 语义澄清（**第三方必读，误读会直接导致安全判断错误**）
>
> **第三方实现不得用 `sections.secrets === true` 判断「该 bundle 含秘密」。**
>
> | 你想知道的事 | 正确来源 | **错误来源** |
> |---|---|---|
> | bundle 里是否有凭据**明文** | `security.containsSecrets`（`boolean`，必需字段，`src/schema/manifest.ts`） | ❌ `sections.secrets` |
> | 导入是否需要密码 | `security.encrypted`（`boolean`，必需字段，`src/schema/manifest.ts`）+ `security.encryption`（参数或 `null`） | ❌ `sections.secrets` |
> | 是否声明了 `secrets` 分区 | 无意义——该键**恒为 `false`** | ❌ `sections.secrets` |
>
> **为什么不能：**
>
> 1. `secrets` **没有 adapter**，不在 `createAdapters()` 的挂载列表里（`src/adapters/index.ts:52-74`），其产物 `security/secrets.enc` 由 `Exporter` **直接写**（`src/core/exporter.ts`），**从不经过** `buildSectionFlags` 的 `sections[section.sectionId] = true` 那条赋值路径。
> 2. `buildSectionFlags` 显式硬写 `flags['secrets'] = false`（`src/core/exporter.ts`），且它在遍历 `sections` 之前就写死了；`sections` 数组里根本不可能出现 `secrets` 条目。
> 3. 因此 `sections.secrets` 在**任何**本实现产物里都恒为 `false`——**包括 `includeSecrets=true` 且 `containsSecrets=true` 的加密备份**。
> 4. 反向也成立：第三方若把 `sections.secrets` 置 `true`，只会得到一条 `备份声明了但缺少的分区: secrets` 告警，`sectionsInZip` 里不会出现 `secrets`（§0.2 实测），导入行为与置 `false` 完全相同。
>
> **`secrets.enc` 的存在性也不等于「含秘密」**：`includeSecrets=false` 但提供密码时，本实现仍会生成 `secrets.enc`（内容是**空串**的密文占位），`containsSecrets` 保持 `false`、`encrypted` 为 `true`（`src/core/exporter.ts` 的 `Exporter.export`（`secrets.enc` 写入分支））。所以：
>
> | 观测 | `security.encrypted` | `security.containsSecrets` | 是否含真实凭据明文 |
> |---|---|---|---|
> | 无密码导出 | `false` | `false` | 否 |
> | 有密码、`includeSecrets=false`（只加密不导密钥） | `true` | `false` | 否（`secrets.enc` 是空占位） |
> | 有密码、`includeSecrets=true`、凭据文件非空 | `true` | `true` | **是** |
> | 有密码、`includeSecrets=true`、凭据文件读不到/为空 | `true` | `false` | 否 |
>
> **一句话**：判断「含秘密」只认 `security.containsSecrets`；判断「要密码」只认 `security.encrypted`。**`sections.secrets` 是一个恒假的占位键，不具备任何安全语义。**（该缺口登记为 §10 G-10。）

### 2.6 完整示例

```json
{
  "schemaVersion": 1,
  "exporter": {
    "name": "DSH Config Manager",
    "version": "0.1.59"
  },
  "source": {
    "dshVersion": "0.1.0-rc.6",
    "platform": "win32",
    "arch": "x64"
  },
  "exportedAt": "2026-08-14T12:00:00.000Z",
  "sections": {
    "settings": true,
    "ui": true,
    "providers": true,
    "plugins": true,
    "mcp": true,
    "prompts": true,
    "skills": true,
    "agentPresets": true,
    "agentInstructions": true,
    "workspaces": true,
    "pluginFiles": false,
    "credentialsStatus": true,
    "secrets": false,
    "sessions": false,
    "self": true
  },
  "security": {
    "containsSecrets": false,
    "encrypted": false,
    "encryption": null
  }
}
```

> 注：上例中 `pluginFiles` / `sessions` 为 `false` 是默认行为（`defaultIncluded = false`，`src/adapters/plugin-files.ts`、`src/adapters/sessions.ts`），不是「未导出」的特殊标记。

### 2.7 `integrity/checksums.json` 规格

扁平对象：`{ "<ZIP 内相对路径>": "<sha256 hex>" }`（`src/utils/hashing.ts:18-24`）。

| 规则 | 细节 | 取证 |
|---|---|---|
| 覆盖范围 | **除 `manifest.json` 与 `checksums.json` 自身外的全部条目** | `src/core/exporter.ts`（`buildChecksums(entries)` 在两者 push 之前调用）、`src/utils/hashing.ts:18-24` |
| 哈希算法 | SHA-256，小写 hex（64 字符） | `src/utils/hashing.ts:9` |
| 校验方向 | **单向**：表内每个路径必须在 ZIP 中存在且哈希一致；ZIP 内**多出的**条目**不参与校验、不报错** | `src/utils/hashing.ts:42-51`；§0.2 运行验证（额外条目未入表 → `valid=true`，无告警） |
| 序列化 | pretty JSON，缩进 2 空格 | `src/core/exporter.ts` |
| 表缺失时 | 本实现**跳过**完整性校验（不报错） | `src/core/analyzer.ts` 的 `loadBundle`（`archive.has(CHECKSUMS_FILE)` 与 `import.checksumsMissing`；守卫 `if (archive.has(CHECKSUMS_FILE))`） |
| 表存在但不符 | 抛 `备份完整性校验失败: ...`，**整体拒绝** | `src/core/analyzer.ts` |

强化解析器 `parseChecksumsTable`（`src/security/integrity.ts:45-72`）额外拒绝：危险键（`__proto__` / `constructor` / `prototype`）、空路径、含反斜杠或前导 `/` 的路径、非 64 位 hex 的值、超过 10000 条的表（`src/security/integrity.ts:24-27`）。

> **注意**：`src/core/analyzer.ts` 的普通导入路径使用 `JSON.parse` 语义的宽松读取（`loadBundle`：`parseJsonSafe` 读 checksums），**不是** `parseChecksumsTable`。上表最后一段的强化规则属于 `backup-verify`（自检）与市场校验路径（`src/core/backup-verify.ts:237`、`src/market/security.ts`）。第三方 exporter 应同时满足宽松与强化两套要求。

---

## 3. 13 个分区（+ `secrets`）的语义

### 3.1 两类分区的落盘形态差异（**本规格最容易被误读的一点**）

| | JSON 类分区 | 文件类分区 |
|---|---|---|
| ZIP 内形态 | **单个 JSON 文件**，路径见 §1.1 | **真实文件 + 目录前缀**，无独立 JSON 文件 |
| 内存表示 | 各自的 `XxxSection` 接口 | 统一为 `FilesSection`（`src/schema/types.ts` 的 `interface FilesSection`） |
| ZIP 内是否落 `FilesSection` JSON | — | **不落**。`src/schema/types.ts` 的 `interface FilesSection`（文件类分区专用；ZIP 内不落此 JSON） 明写「ZIP 内不落此 JSON，见 exporter」；`src/core/exporter.ts` 对文件类分区直接按前缀写真实文件 |
| `version` 字段在哪 | 在 JSON 文件内 | 在内存对象里（`{version:1, files}`，由 `FileCollectionAdapter` 在导出时构造：`src/adapters/file-collection.ts`）；**ZIP 内不存在**这个 JSON |
| 导入侧重建 | 读 JSON → `validateSectionData` | 按前缀扫描条目 → 就地构造 `{version:1, files}`（`src/core/analyzer.ts` 的 `extractSections`（按前缀扫描 → `{version: 1, files}`）） |
| 空分区 | 导出的 JSON 仍存在（内容为空结构） | 可能**一个条目都没有**（目录不存在即空）；导入侧不报错（`src/market/security.ts:141-150` 明写这是合法状态；§0.2 运行验证：`valid=true` 且零告警） |

`relativePath` 语义：**相对该分区 baseDir**，不是相对 `$DSH_HOME`。归档条目名 = `SECTION_FILE_PREFIXES[section] + relativePath`（`src/core/backup-plan.ts:21-25`）。各分区 baseDir：`skills → skills`、`agentPresets → .agent-presets`、`agentInstructions → ''`（仅 `AGENTS.md` 单文件）、`pluginFiles`/`sessions`/`self → 各自目录`（`src/adapters/skills.ts`、`src/adapters/agent-presets.ts`、`src/adapters/agent-instructions.ts`、`src/adapters/self.ts`）。

### 3.2 分区总表

`section version` 是**每个分区 JSON 载荷内的 `version` 字段**，与 `manifest.schemaVersion` 是**两个独立轴**（`src/schema/versions.ts` 的 `sectionDataVersionIssue` 校验前者；`src/schema/versions.ts` 管后者）。

| # | 分区 id | 形态 | ZIP 路径 / 前缀 | 载荷形状 | section version | defaultIncluded | portability |
|---|---|---|---|---|---|---|---|
| 1 | `settings` | JSON | `config/settings.json` | `{version:1, namespaces}` | 1 | true | portable |
| 2 | `ui` | JSON | `config/ui.json` | `{version:1, namespaces, uiMigrationNotes}` | 1 | true | portable |
| 3 | `providers` | JSON | `ai/providers.json` | `{version:1, providers}` | 1 | true | portable |
| 4 | `plugins` | JSON | `plugins/plugins.json` | `{version:1, plugins, patch, pnpmWorkspace?, localTarballs?, patchFiles?}` | 1 | true | portable |
| 5 | `mcp` | JSON | `mcp/servers.json` | `{version:1, servers}` | 1 | true | platformSpecific |
| 6 | `prompts` | JSON | `custom/prompts.json` | `{version:1, prompts}` | 1 | true | portable |
| 7 | `skills` | 文件 | `custom/skills/` | 递归真实文件 | 1（内存） | true | portable |
| 8 | `agentPresets` | 文件 | `agents/presets/` | 递归真实文件 | 1（内存） | true | portable |
| 9 | `agentInstructions` | 文件 | `custom/agent-instructions/` | 真实文件（本实现仅 `AGENTS.md`） | 1（内存） | true | portable |
| 10 | `workspaces` | JSON | `workspaces/workspaces.json` | `{version:1, workspaces}` | 1 | true | platformSpecific |
| 11 | `pluginFiles` | 文件 | `plugin-files/` | 递归真实文件 | 1（内存） | **false** | deviceSpecific |
| 12 | `credentialsStatus` | JSON | `security/credentials.json` | `{version:1, credentials}` | 1 | true | deviceSpecific |
| 13 | `secrets` | 二进制 | `security/secrets.enc` | 见 §4 | 由 blob 内 `version` 字节承载（当前 `1`） | 恒 false | — |
| 14 | `sessions` | 文件 | `sessions/` | 递归真实文件 | 1（内存） | **false** | deviceSpecific |
| 15 | `self` | 文件 | `self/` | 白名单配置文件 | 1（内存） | true | portable |

> **计数说明（必须读，否则会数错）**：`SectionId` 共 **15** 个（`src/schema/types.ts:18-21`）。其中：
> - `secrets` **没有 adapter**、没有 JSON 载荷、不参与 adapter 循环，其产物由 exporter 直接写（`src/core/exporter.ts`）。
> - `sessions` 的 adapter 仅在 `includeSessions: true` 时挂载（`src/adapters/index.ts:72`）。
>
> 因此仓库文档里「13 adapter」指的是：`createAdapters()` 在 `includeSessions` 缺省（false）+ `selfDir !== ''` 时的实际挂载数 = settings / ui / providers / plugins / mcp / prompts / skills / agentPresets / agentInstructions / workspaces / credentialsStatus / pluginFiles / self = **13**（`src/adapters/index.ts:54-71`）。`sessions` 与 `secrets` 都不在这 13 之内，但都在 §2.5 的 `sections` 键集合里。

取证（表内各列）：`src/schema/section-registry.ts` 的 `SECTION_REGISTRY`（`payload.zipPath` / `payload.filePrefix`，即路径与前缀）、`src/adapters/index.ts:52-74`（挂载）、各 adapter 的 `defaultIncluded`/`portability` 字段（`src/adapters/*.ts`，例如 `src/adapters/plugins.ts`、`src/adapters/mcp.ts`、`src/adapters/credentials.ts`、`src/adapters/workspaces.ts`）。

### 3.3 各分区载荷的必需字段（不满足即 **error → 整体拒绝导入**）

校验分两道：`validateSectionData`（结构，`src/schema/config.ts` 的 `validateSectionData`（`payload.kind` 判别 switch））与各 adapter 的 `validate()`。**第一道失败会抛错中断整个导入**（`src/core/analyzer.ts` 的 `extractSections`（`validateSectionData` 失败 → 抛错中断）），第二道失败只把该分区从计划中剔除并记 error（`src/core/analyzer.ts` 的 `analyzeBundle`（adapter `validate()` 失败 → 剔除该分区并记 error））。

| 分区 | `validateSectionData` 要求的顶层形状 | 取证 |
|---|---|---|
| `settings` / `ui` | `namespaces` 必须是对象；每条记录是对象、`revision` 是数字、必须存在 `value` 键、`secrets`（若有）是数组 | `src/schema/config.ts` 的 `validateSectionData`（`namespaces` 分支） |
| `providers` | `providers` 必须是对象 | `src/schema/config.ts` 的 `validateSectionData`（`object` 分支） |
| `plugins` | `plugins` 必须是数组；`patch`（若有）必须是数组 | `src/schema/config.ts` 的 `validateSectionData`（`array` 分支） |
| `mcp` | `servers` 必须是数组 | `src/schema/config.ts` 的 `validateSectionData`（`array` 分支） |
| `prompts` | `prompts` 必须是数组 | `src/schema/config.ts` 的 `validateSectionData`（`array` 分支） |
| `workspaces` | `workspaces` 必须是数组 | `src/schema/config.ts` 的 `validateSectionData`（`array` 分支） |
| `credentialsStatus` | `credentials` 必须是数组 | `src/schema/config.ts` 的 `validateSectionData`（`array` 分支） |
| 文件类 6 个 | `files` 必须是数组（仅内存模型路径会走到） | `src/schema/config.ts` 的 `validateSectionData`（`files` 分支） |

**所有分区**（除文件类在 ZIP 内无 JSON 的情形）都要求 `version === 1`（`src/schema/versions.ts` 的 `sectionDataVersionIssue`（`version === 1` 判定））。但**校验强度按「低于 / 等于 / 高于 1」三档不同**，这一点极易误读：

| 载荷 `version` | 当前行为 | 取证 / 实测 |
|---|---|---|
| `=== 1` | 正常读取 | `src/schema/versions.ts` 的 `sectionDataVersionIssue` |
| `> 1`（如 `2`） | **跳过该分区**（不读入、不产生计划项），记一条 warning：`分区 settings 的数据版本 2 高于本版本支持的 1（已跳过该分区）`；**整个 bundle 仍可导入**（`valid=true`），其余分区照常 | `src/core/analyzer.ts` 的 `extractSections`（`import.unsupportedSectionVersion` → 跳过该分区；判据 `typeof rawVersion === 'number' && rawVersion > 1` → `unsupportedVersions.push` + `warnings.push` + `continue`）；**§3.3.3 实测** |
| `< 1`、非数字、缺失 | **error → 整个 bundle 无法导入**：`分区 settings 数据无效: 分区 settings 的 version 必须为 1（收到 {v}）` | `src/schema/versions.ts` 的 `sectionDataVersionIssue`（`version === 1` 判定）、`src/core/analyzer.ts` 的 `extractSections`（`validateSectionData` 失败 → 抛错中断）；§0.2 运行验证 |

> ⚠️ **这是一个真实的不对称**：**过高**的分区版本被优雅跳过（前向兼容），**过低/缺失**的分区版本反而让整个 bundle 硬失败。第三方 exporter 必须写 `version: 1`；第三方 importer 若照抄「任何 `version != 1` 都硬失败」，会在「更高版本的分区」上比本实现**更严格**（拒绝整个 bundle，而本实现只跳过该分区）。

#### 3.3.1 文件类分区条目名的归一化规则（**S-2：本规格此前缺失的一节**）

§3.1 只给了 `SECTION_FILE_PREFIXES[section] + relativePath` 这条公式与各分区的 baseDir，**没有定义 `relativePath` 本身被允许长什么样、以及读侧如何还原**。第三方若照抄公式而不定义归一化，会在含 `//`、`./`、尾随 `/`、反斜杠的条目名上与本实现产生**不同的目标路径**。本节把写侧构造、读侧还原、非法路径处理三段写死。

##### A. 写侧如何构造条目名

| 分区类别 | 构造规则 | 取证 |
|---|---|---|
| `skills` / `agentPresets` / `sessions`（`FileCollectionAdapter` 子类） | `relativePath` = **homeDir 相对路径裁掉 `baseDir` 前缀**：`rel.replace(new RegExp('^' + escapeRegExp(baseDir) + '[\\/]'), '')`。注意正则只吃**一个**分隔符，且接受 `\` | `src/adapters/file-collection.ts` |
| `agentInstructions` | `baseDir === ''` → `relativePath` = homeDir 相对路径**原样**（本实现恒为 `AGENTS.md`） | `src/adapters/agent-instructions.ts:30-35`、`src/adapters/file-collection.ts` |
| `pluginFiles` | `relativePath` = **相对 `~/.dsh` 根的完整路径**（白名单文件如 `dsh-ssh.json`，或 `collectDir` 下的递归路径） | `src/adapters/plugin-files.ts:42-67` |
| `self` | `relativePath` = **相对 baseDir（`dsh-config-manager`）的路径**，来自固定白名单（`sync/sync-config.json` 等），**不递归** | `src/adapters/self.ts:32-42`、`src/adapters/self.ts:59-77` |
| 归档条目名（全部分区统一） | `name = SECTION_FILE_PREFIXES[sectionId] + relativePath` —— **纯字符串拼接，无归一化、无 `path.join`、无去重** | `src/core/exporter.ts` |
| CLI 离线备份路径 | 同一公式，但**先过 `isPathSafe(zipName)`**，不安全则跳过该条目并计入 `excludedCount`（写侧唯一做条目名校验的地方） | `src/core/backup-plan.ts` 的 `collectBackupEntries`（`isPathSafe` 闸） |

`SECTION_FILE_PREFIXES` 全部以 `/` 结尾：`custom/skills/`、`agents/presets/`、`custom/agent-instructions/`、`plugin-files/`、`sessions/`、`self/`（`src/schema/section-registry.ts` 的 `SECTION_REGISTRY`（各文件类条目的 `payload.filePrefix`））。

> **注意 `pluginFiles` 与 `self` 的 baseDir 不一致**：`pluginFiles` 的 `relativePath` 是**相对 home 根**（`baseDir = ''`），而 `self` 的 `relativePath` 是**相对 `dsh-config-manager`**（`baseDir = 'dsh-config-manager'`）。同一个「看起来像完整相对路径」的字符串在这两个分区里含义不同——这是第三方最容易搞错的一处（`src/core/backup.ts` 的 `FILE_BASES` 是权威表）。

##### B. 读侧如何还原 `relativePath` 与目标路径

| 步骤 | 规则 | 取证 |
|---|---|---|
| 1. 前缀匹配 | 遍历 ZIP 条目名，`name.startsWith(prefix)` 且 `name !== prefix` | `src/core/analyzer.ts` 的 `extractSections`（`name.startsWith(prefix) && name !== prefix`） |
| 2. 裁剪前缀 | `rel = name.slice(prefix.length)` —— **纯 `slice`，不做任何归一化**（不去 `./`、不折叠 `//`、不转 `\`、不去尾随 `/`） | `src/core/analyzer.ts` 的 `extractSections`（`const rel = name.slice(prefix.length)`） |
| 3. 跳过目录/空前缀 | `if (rel === '' \|\| rel.endsWith('/')) continue;` | `src/core/analyzer.ts` 的 `extractSections`（`if (rel === '' || rel.endsWith('/')) continue;`） |
| 4. 记录哈希 | `contentHash = sha256Hex(data)`；`FilesSection = {version:1, files:[{relativePath: rel, data, contentHash}]}` | `src/core/analyzer.ts` 的 `extractSections`（`files.push({ relativePath: rel, data, contentHash })`） |
| 5. 计划项 id / ref | `id = '<section>:<relativePath>'`；`target.ref = relativePath`（**原样**，仍是未归一化的 `rel`） | `src/adapters/file-collection.ts`、`src/adapters/file-collection.ts:77`、`src/adapters/file-collection.ts` |
| 6. 还原目标路径 | `path.join(baseDir, relativePath)` —— **由宿主 `node:path` 完成归一化**（折叠 `.`/`//`、按平台把 `\` 当分隔符） | `src/adapters/file-collection.ts` 的 `path.join(baseDir, relativePath)` 还原 |
| 7. 引擎侧同一公式 | `resolveFileTarget` / `resolveFileTargetRel` = `path.join(homeDir, FILE_BASES[adapter], ref)`，再 `normalizePath` 成 posix | `src/core/backup.ts` |

**由此产生的三个可观测后果（全部实测，见 §3.3.2）**：

1. **归档条目名与 `relativePath` 不是同一根字符串**：条目名含前缀、`relativePath` 不含前缀。第三方 exporter 必须写 `prefix + relativePath`，第三方 importer 必须 `slice(prefix.length)`。
2. **`relativePath` 保留原样、目标路径被归一化**：`custom/skills/probe//empty-seg.md` → `relativePath = 'probe//empty-seg.md'` → 目标文件实际落在 `skills/probe/empty-seg.md`。**同一个文件在 `FilesSection` 里的 `relativePath` 与它最终落盘的位置不是字面相等**——第三方做幂等比对时若拿 `relativePath` 当目标键，必须自己用 `path.join` 归一化，否则第二次导入会误判为「新增」。
3. **反斜杠是平台相关陷阱**：`isPathSafe` 允许中段 `\`（见 §1.5 / §3.3.2 的 C10），而 `path.join` 在 Windows 上把 `\` 当分隔符、在 POSIX 上当普通字符。因此同一个条目 `custom/skills/probe/back\slash.md` 在 Windows 目标上落到 `skills/probe/back/slash.md`，在 Linux 目标上落到 `skills/probe/back\slash.md`（单文件名字面含反斜杠）。**跨平台不一致**。

##### C. 非法路径（Zip Slip 类）的处理：三层，边界必须写清

| 层 | 规则 | 位置 | 效果 |
|---|---|---|---|
| **L1：`parseZip` 条目名闸** | `isPathSafe(name)` 为假 → 抛 `ZipSafetyError`，**整个 bundle 被拒**（不是跳过该条目） | `src/utils/zip.ts` 的 `parseZip`（条目名闸） | 拒绝 `../`、以 `/` 或 `\` 开头、盘符 `C:/`、UNC `\\`、NUL |
| **L2：`isPathSafe` 的实际覆盖** | 拒绝：空串、含 `\0`、以 `/` 或 `\` 开头、`^[a-zA-Z]:[\\/]`、`^\\\\`、**任一分段 === `..`**。**不拒绝**：中段反斜杠、`//`（空段）、`./`、尾随 `/`、`~` | `src/utils/paths.ts:45-54` | 见 §3.3.2 实测表 |
| **L3：F23 预留命名空间闸** | `isReservedInternalRel(normalizePath(path.join(baseDir, ref)))` 为真 → 计划项标 `Error`（不执行）；`applyItem` 前再查一次（纵深防御） | `src/adapters/file-collection.ts` 的 `analyzeImport`（F23 闸）、`src/adapters/file-collection.ts` 的 `applyItem`（前再查一次）、`src/utils/paths.ts:107-114` | 拒绝写 `dsh-config-manager/{snapshots,transactions,locks,recovery-history,migration-history}/`、`safe-mode`、`environment-fingerprint.token`、`sync/{snapshots,work}/` |
| **L4：解压目标越界闸** | `safeExtract` / `safeExtractHardened` 用 `isSameOrChild(target, destDir)` 复查 | `src/utils/zip.ts` 的 `safeExtract`（`isSameOrChild(target, destDir)` 复查）、`src/security/zip-security.ts` 的 `safeExtractHardened`（`isSameOrChild(target, destDir)` 复查） | 仅用于「解压到目录」路径（本实现的 bundle 导入走内存解析，不走这条） |

**必须注意的落差**：L1 依赖 `isPathSafe`，而 `isPathSafe` **不折叠 `..`、也不拒绝中段反斜杠**。实测（§3.3.2）：

- 含 `..` 段的条目名会被 L1 拒绝 → 这一点是好的，且**写侧 `zipToBuffer` 也会先拒**（`src/utils/zip.ts` 的 `zipToBuffer`（条目名 `isPathSafe` 闸）），因此正常导出产物永远不会出现这种名字。
- **中段反斜杠既不被写侧拒绝、也不被读侧拒绝**（C10 实测 `parseZip ACCEPT`、`skills plan=["Create:skills:probe/back\\slash.md"]`、目标落到 `skills/probe/back/slash.md`）。这是**真实缺口**，不是理论问题：`src/security/integrity.ts:63` 对 checksums 表里的键明确拒绝 `\`，但**条目名侧没有同等检查**。

##### D. 给第三方实现者的规范建议（明确区分「现状」与「建议」）

| 场景 | 现状 | 建议 |
|---|---|---|
| `relativePath` 含 `//`、`./`、尾随 `/` | 接受；`relativePath` 保留原样，目标路径被 `path.join` 归一化 | **归一化后再比对**：`normalizePathCollapsed(path.join(baseDir, rel))` 之类的等价折叠，否则幂等判断会漂移 |
| `relativePath` 含中段 `\` | **接受**，且平台相关（Windows 当分隔符、POSIX 当字符） | **拒绝**（比现状更严格）：跨平台语义不一致，且与本实现自己的写侧产物永不冲突 |
| `relativePath` 含 `..` 段 | 条目名层已被 L1 拒绝 | 保持拒绝；不要只靠 `path.join` 兜底 |
| 条目名等于前缀本身（`custom/skills/`）或尾随 `/` | 跳过，不产生文件 | 保持跳过 |
| 条目名前缀不匹配任何已知分区 | **静默忽略**（C9 实测：`valid=true`、无告警、无计划项） | 至少计数并告警（与 §7.5「未知 ZIP 条目」同款建议） |

#### 3.3.2 §3.3.1 的实测命令与输出（可复现）

探针：真实 `Exporter` 产出 baseline → 往 ZIP 注入一个特制条目名 → 三段式导入到内存 mock 目标 → 打印 skills 计划项与目标文件系统键集合。前缀取 `custom/skills/`（skills 分区）。

```text
C1  正常嵌套            custom/skills/probe/normal.md                 | isPathSafe=true  | skills plan=["Create:skills:probe/coding.md","Create:skills:probe/normal.md"] | dst keys=[...,"skills/probe/coding.md","skills/probe/normal.md"] | valid=true
C2  双斜杠（空段）       custom/skills/probe//empty-seg.md            | isPathSafe=true  | skills plan=[...,"Create:skills:probe//empty-seg.md"]                        | dst keys=[...,"skills/probe/empty-seg.md"]        | valid=true
C3  点段 ./             custom/skills/probe/./dot-seg.md             | isPathSafe=true  | skills plan=[...,"Create:skills:probe/./dot-seg.md"]                         | dst keys=[...,"skills/probe/dot-seg.md"]          | valid=true
C4  上跳段 ..           custom/skills/probe/../../escape.md          | isPathSafe=false | 写侧 zipToBuffer 拒绝: 拒绝写入不安全的条目名
C5  深层上跳            custom/skills/../../../../../../../../x.md    | isPathSafe=false | 写侧 zipToBuffer 拒绝: 拒绝写入不安全的条目名
C6  尾随斜杠（目录条目）  custom/skills/probe/dir-entry/              | isPathSafe=true  | skills plan=[]                                                              | dst keys=[...无新增]                              | valid=true
C7  前缀自身（rel 为空）  custom/skills/                              | isPathSafe=true  | skills plan=[]                                                              | dst keys=[...无新增]                              | valid=true
C8  预留命名空间投毒      custom/skills/../dsh-config-manager/snapshots/x.json | isPathSafe=false | 写侧 zipToBuffer 拒绝: 拒绝写入不安全的条目名
C9  非已知前缀          unknown-dir/x.json                          | isPathSafe=true  | skills plan=["Create:skills:probe/coding.md"]                                | dst keys=[...无新增]                              | valid=true（无告警）
C10 反斜杠条目名（字节级绕过写侧） custom/skills/probe/back\slash.md    | isPathSafe=true  | skills plan=["Create:skills:probe/back\\slash.md"]                          | dst keys=[...,"skills/probe/back/slash.md"]       | valid=true
C11 前导斜杠            /custom/skills/lead.md                      | isPathSafe=false | THROW ZIP 条目名不安全: /custom/skills/lead.md
C12 盘符               C:/custom/skills/drive.md                   | isPathSafe=false | THROW ZIP 条目名不安全: C:/custom/skills/drive.md
```

```text
--- isPathSafe / zipToBuffer 逐值 ---
isPathSafe("custom/skills/a\\b.md")     = true  | zipToBuffer = ACCEPT
isPathSafe("custom/skills/\\lead.md")   = true  | zipToBuffer = ACCEPT      ← 中段反斜杠被接受
isPathSafe("\\lead.md")                 = false | zipToBuffer = REJECT      ← 仅「以反斜杠开头」被拒
isPathSafe("custom/skills/trail\\")     = true  | zipToBuffer = ACCEPT
isPathSafe("a\\..\\b.md")               = false | zipToBuffer = REJECT      ← 分段判定对 \ 生效
isPathSafe("/abs/x")  = false | isPathSafe("C:/x")  = false | isPathSafe("..")   = false
isPathSafe("a/../b")  = false | isPathSafe("a//b")  = true  | isPathSafe("a/b/") = true
isPathSafe("./a")     = true  | isPathSafe("a/./b") = true

--- 读侧 parseZip 对反斜杠条目名 ---
parseZip("custom/skills/back\\slash.md") = ACCEPT；names=["custom/skills/back\\slash.md"]
parseZip("custom/skills/\\lead.md")      = ACCEPT；names=["custom/skills/\\lead.md"]
```

> **因此 §1.2 表中「含反斜杠的条目名一律拒绝」的旧表述是错的**，本版已修正为「仅拒绝以 `\` 开头或含 `..` 段的名字；中段 `\` 被接受（真实缺口，见 §10 G-11）」。

#### 3.3.3 分区 `version` 三档行为的实测（与 §3.3 表格配套）

```text
=== C 已知分区 config/settings.json 的 version 改为 2（其余条目不动，重算 checksums）===
valid        = true
errors       = []
warnings     = ["分区 settings 的数据版本 2 高于本版本支持的 1（已跳过该分区）"]
sectionsInZip= ["ui","providers","plugins","mcp","prompts","workspaces","credentialsStatus","skills",
                "agentPresets","agentInstructions","self"]        ← settings 已不在列
（settings 分区零计划项；其余分区照常）

=== E manifest.schemaVersion 改为 2 ===
THROW 备份 schema v2（高于当前 1，需升级插件），无法导入（当前支持 v1）   ← 与 §6.2 一致，仍是硬失败
```

> 对比要点：**分区 `version` 过高 = 跳过该分区**（软失败），**bundle `schemaVersion` 过高 = 拒绝整个 bundle**（硬失败）。两个轴的失败强度不同，第三方实现必须分别处理。

### 3.4 各分区载荷的可选字段（字段级语义）

| 分区 | 字段 | 必需 | 语义 | 取证 |
|---|---|---|---|---|
| `settings`/`ui` namespace 记录 | `value` | 必需 | 该 namespace 的值（已脱敏） | `src/schema/types.ts` 的 `interface NamespaceRecord` |
| | `base` | 可选 | 基线值（DSH 侧概念） | `src/schema/types.ts` 的 `NamespaceRecord.base` |
| | `revision` | 必需 | 乐观锁 revision，导入时作为 `expectedRevision` | `src/schema/types.ts` 的 `NamespaceRecord.revision`、`src/adapters/settings.ts:117-124` |
| | `applies` | 可选 | 适用面标记 | `src/schema/types.ts` 的 `NamespaceRecord.applies` |
| | `secrets` | 可选 | `{path: string[], set: boolean}[]`，DSH `describe({redactSecrets:true})` 报告的秘密**位置**（不含值） | `src/schema/types.ts` 的 `NamespaceRecord.secrets` |
| `ui` | `uiMigrationNotes` | 必需（导出端恒写） | Host 不可迁移项（localStorage 等）的**纯说明**，不含值 | `src/schema/types.ts` 的 `UiSection.uiMigrationNotes`、`src/adapters/ui.ts:78-83` |
| `providers.providers[route]` | `apiKeyEnv` | 可选 | **只记环境变量名**，值在 credentials | `src/schema/types.ts` 的 `ProviderEntry.apiKeyEnv` |
| | `displayName`/`baseURL`/`models`/`modelOverrides`/`reasoning`/`transport`/`retryPolicy` | 可选 | 透传字段 | `src/schema/types.ts` 的 `ProviderEntry` 的 `models` / `modelOverrides` / `reasoning` / `transport` / `retryPolicy` |
| `plugins.plugins[]` | `name`/`version`/`isBundle`/`inBundles`/`enabled` | 必需 | 插件清单 | `src/schema/types.ts` 的 `interface PluginEntry`（`name` / `version` / `isBundle` / `inBundles` / `enabled`） |
| | `spec` | 可选 | 声明依赖 spec（`^0.3.6`、`github:user/repo`、`file:` 等） | `src/schema/types.ts` 的 `PluginEntry.spec` |
| | `fiberPhase` | 可选 | 运行时相位标记 | `src/schema/types.ts` 的 `PluginEntry.fiberPhase` |
| `plugins.patch[]` | `file`/`lineId`/`raw` | 必需 | patch 行；**`raw` 原样写回目标**（未知子字段在此被保留） | `src/schema/types.ts` 的 `interface PatchLine`、`src/adapters/plugins.ts` |
| `plugins.pnpmWorkspace` | `string \| null` | 可选 | `pnpm-workspace.yaml` 原文 | `src/schema/types.ts` 的 `PluginsSection.pnpmWorkspace` |
| `plugins.localTarballs` | `LocalPluginTarball[]` | 可选 | 本地源插件 tarball（base64）。**市场通道两端拒绝**；仅本地备份合法 | `src/schema/types.ts:131-157`、`src/market/security.ts` |
| `plugins.patchFiles` | `{relativePath: string, base64: string}[]` | 可选 | `pnpmWorkspace.patchedDependencies` 引用的 `patches/**` 文件，`relativePath` 相对 **profile 目录**。**市场通道两端拒绝**；仅本地备份合法 | `src/schema/types.ts:158-171`、`src/market/security.ts`、`src/market/prepare.ts` |
| `mcp.servers[]` | `serverName`/`type` | 必需 | `type ∈ {stdio, streamable-http}` | `src/schema/types.ts` 的 `McpServerEntry.serverName` / `.type` |
| | `command`/`args`/`env`/`cwd`（stdio）或 `url`/`headers`（http） | 可选 | 写回时按白名单重建 patch 行 → **条目内未知字段会丢失** | `src/adapters/mcp.ts:69-81` |
| `prompts.prompts[]` | `id`/`name`/`kind`/`text` | 必需 | `kind ∈ {systemPrompt, planMode}` | `src/schema/types.ts` 的 `interface PromptEntry` |
| `workspaces.workspaces[]` | `id`/`path`/`sessionIds` | 必需 | `path` 是**绝对路径**，跨设备必须路径映射。`sessionIds` 是**会话可见性的唯一凭据**（目标机上 `workspace.path` 必须等于会话首帧 cwd 的 realpath，且 id 在其中）：导出侧必须把**本次包里真的带走的会话**声明进来（`declareBundledSessionsInWorkspaces`；DSH 自己的 `sessionIds` 覆盖率极低，原样搬过去会让目标机看不见这些对话）。id 写法 = 会话日志首帧 header 的 `id`（`session-<uuid>` 与裸 `<uuid>` 两种形态并存）；消费方按某个形态匹配不上时，应换另一种形态再试一次 | `src/schema/types.ts` 的 `interface WorkspaceRecord`（`id` / `path` / `sessionIds`）、`src/core/session-select.ts` |
| `credentialsStatus.credentials[]` | `ref`/`required`/`configured`/`hasValue` | 必需 | **永不含值**；普通备份 `hasValue` 恒 `false` | `src/schema/types.ts` 的 `interface CredentialStatus` |

### 3.5 市场（market）通道的分区禁用规则

以下 3 个分区**在发布与下载两端都被硬拒绝**（不是 warning）：

| 禁用分区 | 理由 | 取证 |
|---|---|---|
| `sessions` | 历史会话含个人交互记录/上下文 | `src/market/types.ts:32-39` |
| `pluginFiles` | 任意文件直通、无内容过滤，最易泄漏 token/密钥文件 | 同上 |
| `self` | 本地环境专属（同步通道 URL / WebDAV 地址 / 市场配置 / UI 偏好） | 同上 |

另有两条同级硬约束：`security.containsSecrets === true` 的 bundle 市场拒收（`src/market/security.ts`）；`plugins.localTarballs` 非空市场拒收（`src/market/security.ts`）。

`plugins.patchFiles` 非空同样**发布侧与导入侧双端拒收**（issue #35）：patch 会在 `pnpm install` 时改写依赖代码，与内嵌 tarball 同属「未经公开仓库审阅即执行」的内容，不得经公共市场分发（`src/market/prepare.ts`、`src/market/security.ts`）。本地备份/迁移通道不受此限制。

**实现者注意（issue #35）**：`pnpmWorkspace` 与 `patchFiles` 必须**同进同出**。若只搬运 `pnpmWorkspace` 文本而目标机没有对应 patch 文件，目标机 pnpm 会拒绝**一切** `add`（`Failed to read patch file ... (os error 2)`）。本实现的导入端在写入 `pnpmWorkspace` 前，会剔除目标机无法满足的 `patchedDependencies` 条目（并在计划里给出 Warning 项），再写配置。

> 这属于**市场通道的产品决策**，不是 bundle 格式本身的限制。第三方 exporter 若目标是市场分发，必须遵守；若只做本地备份/迁移，不需要。

---

## 4. 加密语义

### 4.1 两个独立的加密层（**不要混淆**）

| 层 | 产物 | 形态 | 触发条件 |
|---|---|---|---|
| **内层**：凭据密文 | `security/secrets.enc` | ZIP **内部**的一个二进制条目 | 导出时提供密码即生成（即使不含凭据值，也生成空明文占位） |
| **外层**：整体加密容器 | 整个输出文件（**不是 ZIP**） | magic `DCA1` 的二进制 blob | 导出时提供密码即用同一密码加密整个明文 ZIP |

取证：`src/index.ts` 的备份导出路由（外层：`encryptArchive(plainZip, password)`）、`src/core/exporter.ts` 的 `Exporter`（内层：`entries.push({ name: 'security/secrets.enc', … })`）、`src/security/encryption.ts:191-232`。

**同一密码同时用于两层**（`src/index.ts` 的备份导出路由：`createEncryptionProvider(password)` 与 `encryptArchive(plainZip, password)`）。因此导入侧只需一次密码输入：先解外层容器 → 得到明文 ZIP → 再用同一密码解内层 `secrets.enc`（`src/ui/import-wizard.ts` 的 `unlockArchive` 与 `decryptRefs`）。

### 4.2 `security/secrets.enc` 二进制布局

```
偏移   长度   内容
0      4      magic "DSC1"（ASCII）
4      1      version（当前 1）
5      16     salt（随机）
21     12     iv（随机）
33     16     authTag（GCM 认证标签）
49     ...    ciphertext（明文 = .credentials.yaml 原文的 UTF-8 字节）
```

总头部长度 = 4+1+16+12+16 = **49 字节**（`src/security/encryption.ts:47-48`）。

### 4.3 加密参数

| 项 | 值 | 取证 |
|---|---|---|
| 算法 | AES-256-GCM | `src/security/encryption.ts` 的 `encryptCredentials` / `decryptCredentials` |
| KDF | scrypt | `src/security/encryption.ts:77` |
| `N` | 16384（2^14） | `src/security/encryption.ts:43` |
| `r` | 8 | 同上 |
| `p` | 1 | 同上 |
| `keyLength` | 32 | 同上 |
| salt 长度 | 16 字节 | `src/security/encryption.ts:44` |
| iv 长度 | 12 字节 | `src/security/encryption.ts:45` |
| authTag 长度 | 16 字节 | `src/security/encryption.ts:46` |
| 随机性 | 每次加密 salt 与 iv 全随机 | `src/security/encryption.ts` |
| 派生调用 | `crypto.scrypt(password, salt, 32, {N,r,p})` | `src/security/encryption.ts:77` |

KDF 参数值域校验（防 manifest 被篡改成超大 `N` 造成 DoS）：`N ∈ [2^14, 2^20]`、`r ∈ [1,32]`、`p ∈ [1,32]`、`keyLength === 32`；不满足即 `UNSUPPORTED_FORMAT`（`src/security/encryption.ts:62-69`、`src/security/encryption.ts:129-131`）。

### 4.4 `manifest.security.encryption` 字段

```json
{
  "algorithm": "aes-256-gcm",
  "kdf": "scrypt",
  "kdfParams": { "N": 16384, "r": 8, "p": 1, "keyLength": 32 },
  "salt": "<base64, 16 bytes>",
  "iv": "<base64, 12 bytes>",
  "authTag": "<base64, 16 bytes>",
  "version": 1
}
```

类型：`src/schema/types.ts:24-32`。`salt`/`iv`/`authTag` **同时**存在于 blob 头部与 manifest 中；解密前必须比对两者一致，不一致即判定 `TAMPERED`（`src/security/encryption.ts:136-142`）。

### 4.5 错误分类（第三方实现应对齐的用户可见语义）

| 错误码 | 触发条件 | 取证 |
|---|---|---|
| `UNSUPPORTED_FORMAT` | magic 不是 `DSC1`（或容器不是 `DCA1`）；blob 内 version 不等于 1；manifest 加密参数非法/不受支持 | `src/security/encryption.ts:122-131` |
| `TAMPERED` | blob 长度 < 49；blob 头部参数与 manifest 不一致 | `src/security/encryption.ts:118-120`、`src/security/encryption.ts:136-142` |
| `BAD_PASSWORD` | GCM 认证失败（密码错或密文被改）；密钥派生失败；密码为空串 | `src/security/encryption.ts:85`、`src/security/encryption.ts:144-161` |

### 4.6 密码如何传递

| 环节 | 方式 | 取证 |
|---|---|---|
| 导出（HTTP） | `POST /api/dsh-config-manager/export` 的 JSON body 字段 `password`（非空字符串才生效） | `src/index.ts` 的备份导出路由（`body['password']` 取值点） |
| 导出（构造） | `createEncryptionProvider(password)` 注入 `ExporterOptions.encryption` | `src/index.ts` 的备份导出路由（`createEncryptionProvider(password)`）、`src/security/encryption.ts` |
| 密码强度校验 | **无**——加密**不做任何密码强度校验**（产品决策）。任何非空密码都被接受，包括 `1`、`12345678`、`password` | 唯一约束是**非空**：空字符串抛 `SecurityError('BAD_PASSWORD', '加密密码不能为空')`（`src/security/encryption.ts:85`、`src/security/encryption.ts:197`） |
| 导入（HTTP） | `POST /api/dsh-config-manager/decrypt-archive`，body 带 `password` | `src/routes/import.ts` 的 `endpoint({ path: '/api/dsh-config-manager/decrypt-archive', methods: ['POST'] }, …)` |
| 落盘 | **绝不落盘、绝不入日志**；内存使用后丢弃 | `src/index.ts` 的备份导出路由「Encryption password is in-memory only (never persisted / logged)」注释与 `body['password']` 取值、`src/security/encryption.ts:14-15` |

> **产品决策（2026-09-13，已复核）**：加密路径**不施加任何密码强度要求**——这是刻意的产品决策（密码策略由用户自己掌握，插件不施加约束），不是遗漏。**第三方实现者不要假设本格式对加密密码有强度要求**：任何非空字符串都是合法密码。历史上曾存在一个强度校验函数（已从源码移除，见 §10 G-08），它甚至在基线版本中**从未被调用**；本版选择**整体删除**而非接通，以免留下「看起来在守、实际不跑」的死代码。
>
> **解密侧同样不校验**（且现在整个校验面都不存在）：历史备份可能用弱密码加密，任何强度校验都会让它们**永久打不开**。因此加密与解密两侧对密码的唯一要求都是**非空**（解密侧连非空也不强制——错误密码走 GCM 认证失败 → `BAD_PASSWORD`）。

### 4.7 整体加密容器 `DCA1`

```
偏移   长度   内容
0      4      magic "DCA1"（ASCII）
4      1      version（当前 1）
5      16     salt
21     12     iv
33     16     authTag
49     ...    ciphertext（明文 = 完整 bundle ZIP 的字节）
```

布局与 `secrets.enc` 同构，区别仅在 magic/version 与 KDF 参数**恒为默认常量**（不写进任何元数据，`src/security/encryption.ts:35-41`、`src/security/encryption.ts:203-232`）。`isArchiveBlob()` 只探测前 4 字节（`src/security/encryption.ts:40-42`）。

**重要**：外层容器加密后，磁盘上**看不到任何明文**（包括 `manifest.json`）。第三方 importer 若遇到一个「不是 ZIP」的文件，应先探测 magic `DCA1`（`src/core/backup-verify.ts:175-178` 就是这样识别并给出「需先解密」结论的）。

### 4.8 加密的导入侧不变量

`manifest.security.encrypted === true` 时，**未提供解密结果即拒绝执行**：

- `src/core/analyzer.ts` 的 `executeImportPlan`（`decryptedCredentials === undefined` → 抛错）`：`decryptedCredentials === undefined → 抛 `该备份已加密，必须提供解密密码才能导入（拒绝无密码导入）`。
- §0.2 运行验证：加密 bundle 直接 `executeImportPlan({confirm:true})` → 抛出上述错误，零写入。

即：**不允许把加密备份静默降级为「缺凭据照常导入」**（`src/core/analyzer.ts` 的 `EXECUTABLE_EXTENSIONS` 扫描（见 `loadBundle`）9-521 明写该设计意图）。

---

## 5. Secret 语义

### 5.1 默认不含秘密（安全不变量）

| 规则 | 取证（**当前工作区**行号 + 符号锚点） |
|---|---|
| `includeSecrets` 缺省 `false` | `src/core/types.ts:18-19`（`ExportOptions.includeSecrets`）；备份导出路由 `src/index.ts`（`body['includeSecrets'] === true`，未传即 `false`） |
| `includeSecrets=true` **必须**注入 `EncryptionProvider`，否则拒绝导出 | `src/core/exporter.ts`（`if (includeSecrets && !this.encryption) throw ... 'export.encryptionRequired'`） |
| 明文 `.credentials.yaml` 只在 `includeSecrets=true` 时被读取并加密进 `secrets.enc` | `src/core/exporter.ts`（`if (includeSecrets)` 才 `ctx.fs.readFile(credentialsFile)`） |
| `includeSecrets=false` 时仍生成 `secrets.enc`，但明文是**空串**；`containsSecrets` 保持 `false` | `src/core/exporter.ts`（`plaintext = ''` → `encryption.encrypt(plaintext)` → push `security/secrets.enc`）、`src/core/exporter.ts`（`containsSecrets = includeSecrets && plaintext !== ''`） |
| `credentialsStatus` 分区的 `hasValue` 普通备份恒 `false` | `src/schema/types.ts` 的 `CredentialStatus.hasValue` |
| 凭据值经 `ctx.credentials` **永不回读**，只经文件级读 | `src/core/types.ts`、`src/security/encryption.ts:16-18` |

### 5.2 `scanAndRedact` 的行为

导出时按**分区类型**走两条不同的 secret 通道（`src/core/exporter.ts`，精简自真实代码）：

```ts
if (!isFileSection(adapter.id)) {
  // 结构化分区：scanAndRedact 会**剥离**命中值（改写导出数据）
  const scanned = this.scanner.scanAndRedact(section.data);
  redactedHits.push(...scanned.hits);
  sanitized = scanned.sanitized;
} else {
  // 文件类分区（G-09 已修复）：只做**文本级扫描 + 告警**，绝不改写/剥离用户文件内容
  const fileHits = scanFileSectionText(this.scanner, section.data);
  if (fileHits.length > 0) {
    redactedHits.push(...fileHits);                 // 报告统计通道：全量命中
    // 告警通道：按**文件路径**去重，再截断到 MAX_FILE_SECTION_WARNINGS_PER_SECTION，
    // 被截断的**文件数**另出一条汇总告警（截断不得变成静默丢失）
    ...
  }
}
```

| 行为 | 细节 | 取证 |
|---|---|---|
| 作用范围 | **结构化分区**走 `scanAndRedact`（剥离值）；**文件类分区**（`skills`/`agentPresets`/`agentInstructions`/`pluginFiles`/`sessions`/`self`）走 `scanFileSectionText`（**只报告、不改写**）——**G-09 已修复**，两类的命中**都**计入 `redactedHits` | `src/core/exporter.ts`（`if (!isFileSection(adapter.id))` 在 `:243`）、`:135-161`（`scanFileSectionText` 定义）、`src/core/exporter.ts`（调用点）、`src/core/messages.ts`（`export.fileSectionSecrets`） |
| 文件类扫描的边界（**勿过度承诺**） | ① 只走 `scanner.scanText`；未实现该方法的扫描器（含 core 内置 `defaultSecretScanner`）→ **返回空**，行为与修复前一致；② 二进制文件（前 4 KiB 含 NUL）跳过；③ 单文件 `FILE_SECTION_SCAN_MAX_BYTES`、累计 `FILE_SECTION_SCAN_TOTAL_BUDGET_BYTES`（16 MiB）超限即停止扫描（不中断导出）；④ **不剥离**内容——命中的文件仍会带出明文，只给告警 | `src/core/exporter.ts:122-161`（含 `:136-137` 的 `scanText` 能力探测）、`src/core/exporter.ts`（单文件上限）、`:105`（累计上限）、`:110-115`（`BINARY_SNIFF_BYTES` + `looksBinary`） |
| 告警去重与截断（**本轮 H1 修复**） | 告警按**文件路径**去重（同一路径只告警一次）；上限 `MAX_FILE_SECTION_WARNINGS_PER_SECTION = 5` 语义是「不同**文件**数」；被截断的文件数另出一条汇总告警。`redactedHits` 仍计**全量命中**（报告统计通道，非告警通道） | `src/core/exporter.ts:107-108`（常量与语义注释）、`src/core/exporter.ts`（去重 + 截断 + 汇总） |
| 剥离对象 | **只剥离字符串叶值**；对象/数组整体递归，不整块剥离 | `src/security/secret-scanner.ts:8-9`、`src/security/secret-scanner.ts:330-337` |
| 剥离产物 | 空字符串 `''`（保留字段名与位置，供「需补录」提示） | `src/security/secret-scanner.ts:31`、`src/security/secret-scanner.ts:333` |
| 不可变性 | 返回**全新对象**，不改原数据 | `src/security/secret-scanner.ts:24`、`src/security/secret-scanner.ts:282` |
| 深度保护 | 默认 64，超限抛 `JsonDepthError` | `src/security/secret-scanner.ts:283`、`src/security/secret-scanner.ts:306` |
| 循环引用 | 检测到即抛错 | `src/security/secret-scanner.ts:315`、`src/security/secret-scanner.ts:340` |
| 命中记录 | `{path, field}`，**值永不外泄** | `src/core/types.ts`、`src/security/secret-scanner.ts:25` |

**两种判定档位**（`src/security/secret-scanner.ts:16-21`）：

| 档位 | 触发 | 判定 |
|---|---|---|
| 保守档（默认） | `literalValueOnly` 缺省 `false` | 值形状强信号命中 → 剥离；否则引用字段/env 名豁免；否则字段名敏感即剥离 |
| 宽松档 | `literalValueOnly: true`（市场发布扫描用） | 值形状强信号命中 → 剥离；字段名敏感**且**值像真实字面量凭据才剥离 |

字段名判定：规范化（小写、去 `_-. ` 与其它非字母数字）后做「精确命中 / 敏感后缀 / 敏感前缀」三级匹配（`src/security/secret-scanner.ts:178-188`）。名单见 `src/security/secret-scanner.ts:38-63`。值形状模式见 `src/security/secret-scanner.ts:67-75`（`sk-` / JWT / `AKIA` / GitHub PAT / PEM 私钥 / Bearer）。

**豁免**（值是「名字」不是秘密，一律保留）：引用字段名（`apiKeyEnv` 等，`src/security/secret-scanner.ts:49-53`）、全大写环境变量名（`src/security/secret-scanner.ts:157-159`）、模板引用 `${VAR}`/`{{VAR}}`/`%VAR%`/`$VAR`（`src/security/secret-scanner.ts:164-176`）。

> 导出器缺省使用**较弱的** `defaultSecretScanner`（纯字段名黑名单，`src/core/exporter.ts:59-94`）。生产宿主注入了强化版 `createConfiguredSecretScanner`（构造 `src/index.ts` 的 `const secretScanner = createConfiguredSecretScanner(config?.personalPatterns)`，注入 `deps.scanner` 见 `src/index.ts` 的 `makeRoutes({ scanner: secretScanner, … })`）。第三方 exporter **不应**假定最弱实现：产物的「无秘密」强度取决于所注入的扫描器。

### 5.3 `redactedHits` 的含义、持久化与审计语义

`redactedHits` 是**导出报告里的一个计数**（`ExportReport.security.redactedHits`，类型 `number`，接口 `ExportReport` 与字段定义均在 `src/core/types.ts`）。

#### 5.3.1 它是什么

| 问题 | 答案 | 取证 |
|---|---|---|
| 它是什么 | 本次导出中被脱敏/命中的**字符串叶值条数**——结构化分区取 `scanned.hits.length` 累加，**文件类分区取 `scanFileSectionText` 的命中累加**（G-09 已修复，两类都计入） | `src/core/exporter.ts`（`const redactedHits: SensitiveHit[] = []`）、`src/core/exporter.ts`（`redactedHits.push(...scanned.hits)`）、`src/core/exporter.ts`（`redactedHits.push(...fileHits)`）、`src/core/exporter.ts`（`redactedHits: redactedHits.length`） |
| 累积粒度 | **一次导出一个总数**，不是每分区一个数（分区级只有 `included[].counts`，与 redaction 无关） | `src/core/exporter.ts` |
| 中间量 `SensitiveHit[]` | `{path: string, field: string}`——**只有位置，没有值**（`src/core/types.ts`）；该数组**在导出函数返回前就丢掉了**，只有 `.length` 进入报告 | `src/core/exporter.ts` 的 `Exporter.export` |
| 它**不是**什么 | **不是**被剥离的值本身，**不是**路径清单（清单只存在于内存中间量），**不是** manifest 字段。**注意**：自 G-09 修复后它**包含文件类分区的命中**，但那些命中**不伴随内容剥离**（只告警）——所以「`redactedHits > 0` ⇒ 秘密已被剥离」**只对结构化分区成立** | 同上；文件类分支见 `src/core/exporter.ts` |

#### 5.3.1b 计入与不计入的四个边界（决定计数大小）

| # | 边界 | 细节 | 取证 |
|---|---|---|---|
| 边界 1 | 文件类分区（`skills`/`agentPresets`/`agentInstructions`/`pluginFiles`/`sessions`/`self`）的内容**现在会计入**（G-09 已修复），但走的是**另一条通道**：`scanFileSectionText`（文本级扫描，**只报告不改写**），因此它们的命中**不产生内容剥离** | 导出器对文件类分区走 `else` 分支：`src/core/exporter.ts`（`scanFileSectionText` 调用与命中的累加都在该文件内） |
| 边界 2 | 已经是空串的值不命中 | 剥离产物就是空串（`REDACTED_PLACEHOLDER = ''`），二次扫描时 `value === ''` 直接放行 → **重复导出同一份已被剥离的数据，计数会变成 0** | `src/security/secret-scanner.ts:31`、`src/security/secret-scanner.ts:265`、`src/core/exporter.ts`（缺省扫描器同款判断） |
| 边界 3 | 非字符串值（数字/布尔/null/对象/数组本身）不计入 | `judgeFieldValue` 只对字符串叶值调用；`typeof v === 'string'` 才判 | `src/security/secret-scanner.ts:328-337` |
| 边界 4 | `includeSecrets=true` 时，凭据原文进 `secrets.enc`（不经结构化扫描），该计数只反映**其余分区**的命中 | 凭据文件按字节读入并加密，从不经过 `scanAndRedact` | `src/core/exporter.ts` |

#### 5.3.2 它出现在哪里（完整消费点清单，全仓库检索）

| 出现位置 | 形态 | 是否持久化 | 取证 |
|---|---|---|---|
| `ExportReport.security.redactedHits` | `number` | 否（返回值，随进程生命周期） | `src/core/types.ts` |
| 导出日志 | `this.ctx.log.info('导出完成', {..., redactedFields: redactedHits.length, ...})` —— **日志字段名是 `redactedFields`，值是同一个数** | 否（进宿主日志 sink，不进 bundle） | `src/core/exporter.ts`（日志字段名 `redactedFields`） |
| UI 徽章 | `<Badge kind="error">{report.security.redactedHits} redacted</Badge>`（仅 `> 0` 时渲染） | 否 | `src/client/common/ReportView.tsx` 的 `ExportSummary`（`redactedHits` 徽章） |
| UI 文本报告 | `if (report.security.redactedHits > 0) lines.push('⚠ {n} 个敏感字段已脱敏')` | 否 | `src/ui/report.ts`、文案 `src/ui/i18n.ts:43`（zh）/ `src/ui/i18n.ts`（en） |
| 模型工具返回值 | `redactedHits: report.security.redactedHits`（`config_backup` 工具的 JSON 结果字段） | 否（单次工具调用返回值） | `src/core/model-tools.ts`（工具描述也在该文件） |

**全仓库检索 `redactedHits` 只有 5 处命中**（定义 1 + 产出 1 + 消费 3）：`src/core/types.ts`、`src/core/exporter.ts`、`src/core/model-tools.ts`、`src/client/common/ReportView.tsx`、`src/ui/report.ts`。检索 `redactedFields` 只有 `src/core/exporter.ts` 一处。

#### 5.3.3 它**不**持久化进 bundle（本规格的明确结论）

| 断言 | 取证 |
|---|---|
| bundle 的 `manifest.json` **没有** `redactedHits` 字段；manifest 的安全信息只有 `security.{containsSecrets, encrypted, encryption}` | `src/schema/manifest.ts:26-44`（`buildManifest` 的全部字段）、`src/schema/manifest.ts:111-121`（`validateManifest` 对 security 的全部校验项） |
| `integrity/checksums.json` 不含它（该表只有路径 → SHA-256） | `src/utils/hashing.ts:18-24` |
| 分区载荷里没有它（`validateSectionData` 的 13 个分支均不涉及） | `src/schema/config.ts` 的 `validateSectionData`（`payload.kind` 判别 switch） |
| 导出产物写入顺序中，报告是在 `writeZip` **之后**才构造的，从未参与 ZIP 条目组装 | `src/core/exporter.ts`（条目组装）→ `src/core/exporter.ts`（`await writeZip(outPath, entries)`）→ `src/core/exporter.ts`（报告对象） |
| 导出报告本身也**不落盘**：`ExportReport` 只作为返回值/内存状态流转（UI run store），不在任何持久化白名单里 | `src/client/api.ts`（返回值类型）、`src/ui/export-flow.ts`（内存字段）、`src/client/run-store.ts`（内存 run 结果） |
| 同步通道的快照元信息也**没有**它：`ManifestSummary` 只有 `schemaVersion/dshVersion/platform/sectionIds/containsSecrets/encrypted/transport` | `src/sync/transport.ts:9-21` |

> **结论（S-4）**：`redactedHits` **不是 bundle 格式的一部分**。它是**导出侧（producer）自省报告**的一个数字，**不写进 bundle、不由 importer 读取、不参与任何版本协商或完整性校验**。第三方 exporter **可以**产生它（用于自己的 UI/日志），第三方 importer **无需**消费它，也**不能**从 bundle 里推出它——bundle 里没有任何字段能反推「导出时脱敏了几个字段」。

#### 5.3.4 第三方实现应如何产生与消费它

| 角色 | 建议 |
|---|---|
| 第三方 **exporter** | 若实现结构化分区扫描（§5.2），**应当**在导出报告里给出该计数（与 `included`/`excluded`/`security` 同级），并**只给计数、不给路径、绝不给值**。`SensitiveHit[]` 中间量应在返回前丢弃。 |
| 第三方 **exporter**（日志） | 日志里只写计数（本实现写 `redactedFields`），**不得**写 `path`/`field` 明细到持久日志——本实现刻意只记长度（`src/core/exporter.ts`，注释：「日志不泄值：只记分区与命中数量」）。 |
| 第三方 **importer** | **不需要**做任何事。不要尝试从 bundle 读取或校验它；不要因为「bundle 里没有 redaction 记录」就假设 bundle 未脱敏。 |
| 任何角色 | **不得**把 `redactedHits > 0` 解读为「bundle 含秘密」。对**结构化分区**它意味着秘密已被剥离；对**文件类分区**（G-09 后也计入）它只意味着**检测到**疑似凭据并已告警，**内容并未被剥离**——那部分明文仍在包里。因此「有计数 ⇒ 包里没有明文」**不成立**，是否含真秘密仍只看 `security.containsSecrets`。 |

#### 5.3.5 与 `containsSecrets` 的区别（两个正交的概念，勿混用）

| 维度 | `redactedHits` | `containsSecrets` |
|---|---|---|
| 所属 | `ExportReport.security`（**报告**，`src/core/types.ts`） | `manifest.security`（**bundle 内**，`src/schema/types.ts` 的 `interface Manifest`（`security` 字段）、`src/schema/manifest.ts`） |
| 是否进 bundle | ❌ 否 | ✅ 是（必需字段） |
| 类型 | `number`（计数） | `boolean` |
| 语义 | 导出时**被剥离（结构化分区）/ 被命中（文件类分区）**的敏感字段**数量** | bundle 是否**真的携带**了凭据明文 |
| 置真条件 | 任一结构化分区命中 `scanAndRedact` **或**任一文件类分区命中 `scanFileSectionText`（后者只告警、不剥离） | `includeSecrets === true` **且** `.credentials.yaml` 读取成功且非空（`src/core/exporter.ts`：`containsSecrets = includeSecrets && plaintext !== ''`） |
| 用户可见面 | 「{n} 个敏感字段已脱敏」提示（`src/ui/report.ts`） | manifest 徽章 / 市场与同步通道的硬拒绝闸门（`src/market/security.ts`、`src/sync/sync-engine.ts`） |
| 典型组合 | 高 `redactedHits` + `containsSecrets=false` = **结构化分区扫描工作正常**（剥离了秘密）。**但 G-09 后该组合不再保证「包内无秘密」**：文件类分区的命中**只告警不剥离**，明文仍在包里，而 `containsSecrets` 不反映它们 | `containsSecrets=true` + `encrypted=false` = 危险组合（市场/同步通道拒收） |

**一句话**：`containsSecrets` 回答「**包里有没有真秘密**」，`redactedHits` 回答「**导出时命中了几个敏感位置**」。二者可以同时为 `false`/`0`（没有敏感字段，也没有秘密），也可以一个是高计数、另一个是 `false`。**任何把两者互相推导的实现都是错的**——尤其是「`redactedHits > 0` 就说明包里干净」：G-09 之后文件类分区的命中**并未被剥离**。

---

## 6. 版本协商

### 6.1 常量与判定函数

| 符号 | 值 | 取证 |
|---|---|---|
| `CURRENT_SCHEMA_VERSION` | `1` | `src/schema/versions.ts` |
| `MIN_SUPPORTED_SCHEMA_VERSION` | `1` | `src/schema/versions.ts` |
| `isCurrent(v)` | `v === 1` | `src/schema/versions.ts` |
| `isSupported(v)` | `1 <= v <= 1` | `src/schema/versions.ts` |
| `needsMigration(v)` | `1 <= v < 1`（**当前恒 false，无真值档**） | `src/schema/versions.ts`、`tests/schema-compat.test.ts:133-136` |
| `isTooNew(v)` | `v > 1` | `src/schema/versions.ts` |
| `canImport(v)` | `isCurrent(v) \|\| needsMigration(v)` → 当前等价于 `v === 1` | `src/schema/versions.ts` |
| `describeVersion(v)` | 可读描述，四档 | `src/schema/versions.ts` |

### 6.2 判定时机与用户可见后果

导入分两处判定，**行为不同**：

| 时机 | 条件 | 行为 | 用户可见后果 | 取证 |
|---|---|---|---|---|
| ① 读 manifest 后（`loadBundle`） | `isTooNew(v) \|\| !isSupported(v)` | **抛错，流程立即终止** | 导入向导收到一条错误：`备份 {version}，无法导入（当前支持 v1）`，其中 `{version}` 由 `describeVersion` 生成 | `src/core/analyzer.ts` 的 `loadBundle`（`isTooNew` / `isSupported` 判定）、`src/core/messages.ts`（`import.schemaUnsupported`） |
| ② 分析阶段（`analyzeImport`） | `!canImport(v)` | 追加到 `errors`，返回 `valid=false` | 报告列出错误，兼容性评为 `unsupported` | `src/core/analyzer.ts` 的 `analyzeImport`（`canImport` 判定）、`src/core/validator.ts` 的 `computeCompatibility` |

因为 ① 在 ② 之前，**实际可达的只有 ①**（`v > 1` 与 `v < 1` 都会在 ① 抛错）。② 是防御性冗余。

**`isTooNew` 的用户可见后果**（§0.2 运行验证，`schemaVersion = 2`）：

```
THROW 备份 schema v2（高于当前 1，需升级插件），无法导入（当前支持 v1）
```

即：**过新版本是硬失败，不是「尽力而为的部分导入」**。用户唯一出路是升级插件（`describeVersion` 的文案就指向这一点，`src/schema/versions.ts`）。

**版本不受支持 ≠ 备份损坏**：`backup-verify` 明确把这种情况判为 `UNSUPPORTED` 而不是 `CORRUPT`，避免误导用户重导（`src/core/backup-verify.ts:224-228`、`src/core/backup-verify.ts:175-178`）。

### 6.3 兼容性评分（受版本影响，但不是版本判定）

`computeCompatibility`（`src/core/validator.ts:49-69`）：

| 评分 | 条件 |
|---|---|
| `unsupported` | `!canImport(schemaVersion)` |
| `partial` | 跨平台 / 有缺失分区 / 源 DSH 比目标新 |
| `good` | 源 DSH 比目标旧 |
| `excellent` | 同平台、无缺失、schema 支持 |

---

## 7. 向前兼容规则（本规格的核心价值）

> 这一章回答一个问题：**导入端遇到「不认识的东西」时，应该保留还是忽略？**
> 下面每一条都标注了**现有实现的真实行为**（源码 + §0.2 运行验证）。凡现有实现与「基础设施应有的行为」不一致的，写进 §10「已知缺口」，**不粉饰**。

### 7.1 四种「不认识」的总表

| 输入形态 | 现有实现的真实行为 | 数据是否幸存 | 取证 |
|---|---|---|---|
| **① `manifest` 顶层未知字段** | 解析后**保留**在结果对象；不报错、不告警、不参与任何逻辑 | 保留在内存结果里，但**不产生任何效果**，且**不会被再序列化**（导入不回写 manifest） | `src/schema/manifest.ts:65-123`（无白名单）；`tests/schema-compat.test.ts:96-125`（SC-07）；§0.2 运行：`valid=true, warnings=[]` |
| **② `manifest` 已知对象内的未知子字段** | 同上 | 同上 | `tests/schema-compat.test.ts:120-124`（SC-07 断言 `exporter.futureExporterField` 保留） |
| **③ `manifest.sections` 内的未知分区 id** | **当前工作区**：`extractSections` 用 `knownIds = new Set(SECTION_IDS)` 单独识别未知分区 → 收集进 `unsupportedSections` → 产出独立告警 `备份包含本版本不支持的分区: {ids}（已跳过，未导入）`；**不再**混入 `missingSections`。**基线 0.1.59**：静默 `continue` + 误报为「声明但缺失」 | ❌ **数据丢弃**（该分区在 ZIP 内的内容不被读取，计划项为零）；但**存在性会被明确告知** | 当前：`src/core/analyzer.ts` 的 `extractSections`（`unsupportedSections` 收集）、`src/core/analyzer.ts` 的 `extractSections`（未知 id 拦截，`knownIds` 判定）、`src/core/analyzer.ts` 的 `extractSections`（`SECTION_JSON_PATHS` 查找）；基线：`src/core/analyzer.ts:204-205`、`src/core/analyzer.ts:275-280`；§7.2 实测 |
| **④ 已知分区 JSON 内的未知字段** | `validateSectionData` 只检查已知形状，**不重写**；但**没有任何代码路径保留它** | ⚠️ **因分区而异**（`workspaces[]` / `plugins.patch[].raw` / `providers.raw` 会写回，其余不写回，见 §7.3） | `src/schema/config.ts` 的 `validateSectionData`（`payload.kind` 判别 switch，无白名单）；§7.3 实测 |

### 7.2 未知分区（③）——**最可能暴露真实缺口的一处**

§0.2 运行验证（构造 `sections.keybindings = true` + ZIP 内 `keybindings/keybindings.json` + `sections.workflows = true` + ZIP 内 `custom/workflows/x.json`）：

```
[P1 未知分区] valid=true
              errors=[]
              warnings=["备份声明了但缺少的分区: keybindings, workflows"]
              sectionsInZip=["settings","ui","providers","plugins","mcp","prompts","workspaces",
                             "credentialsStatus","skills","agentPresets","agentInstructions","self"]
              compat=partial
[P1 未知分区] plan items adapters=["settings","skills"]   ← 无任何 keybindings/workflows 项
              estimatedActions={"settings":1,"skills":1}
```

**结论（三条，全部为实测）**：

1. **未知分区不阻塞导入**：`valid=true`，不报 error。这一点是好的。
2. **未知分区的数据被完全丢弃**，且**没有任何一条消息告诉用户「这个分区我不认识」**。
3. **唯一的相关告警是误导性的**：它来自 `missingSections` 计算（`src/core/analyzer.ts:275-280`），文案是 `备份声明了但缺少的分区: {sections}`（`src/core/messages.ts`）。它把「我不认识」和「声明了但文件不在」**归为同一类**。对未知分区而言，文件其实**在** ZIP 里（`keybindings/keybindings.json` 确实存在），只是从没被读取。

**为什么数据会被丢**：`extractSections` 只遍历 `manifest.sections` 的条目，且只处理两类：

```ts
for (const [sectionId, enabled] of Object.entries(manifest.sections)) {
  if (!enabled) continue;
  if (isFileSection(sectionId)) { ... }              // 仅 SECTION_FILE_PREFIXES 内的 id
  const jsonPath = SECTION_JSON_PATHS[sectionId];
  if (jsonPath === undefined) continue;              // ← 未知分区在此静默 continue
  ...
}
```

（基线 `src/core/analyzer.ts:189-219`）——未知 id 既不在 `SECTION_FILE_PREFIXES` 也不在 `SECTION_JSON_PATHS`，于是在基线的第 205 行 `continue`，**静默丢弃**；当前工作区在 `src/core/analyzer.ts` 的 `extractSections`（未知 id 拦截，`knownIds` 判定） 显式拦截并告警。

### 7.2 未知分区（③）——**基线有缺口，当前工作区已修复**

> **两个版本的实测结论都要读**：第三方实现者可能对接的是**已发布版本**（`v0.1.58`，有缺口），也可能是**当前工作区**（已修复）。下面的表格把两栏并列。

#### 当前工作区实测（修复后）

构造 `sections.keybindings = true` + ZIP 内 `keybindings/keybindings.json`，走三段式导入：

```text
valid              = true
errors             = []
warnings           = ["备份包含本版本不支持的分区: keybindings（已跳过，未导入）"]
sectionsInZip      = ["settings","ui","providers","plugins","mcp","prompts","workspaces","credentialsStatus",
                      "skills","agentPresets","agentInstructions","self"]   ← 不含 keybindings
unsupportedSections= ["keybindings"]                                        ← 有独立报告通道
（该分区零计划项；其余分区照常导入）
```

#### 基线 `0.1.59` 实测（修复前，保留作为风险提示）

构造 `sections.keybindings = true` + ZIP 内 `keybindings/keybindings.json` + `sections.workflows = true` + ZIP 内 `custom/workflows/x.json`：

```text
[P1 未知分区] valid=true
              errors=[]
              warnings=["备份声明了但缺少的分区: keybindings, workflows"]
              sectionsInZip=["settings","ui","providers","plugins","mcp","prompts","workspaces",
                             "credentialsStatus","skills","agentPresets","agentInstructions","self"]
              compat=partial
[P1 未知分区] plan items adapters=["settings","skills"]   ← 无任何 keybindings/workflows 项
              estimatedActions={"settings":1,"skills":1}
```

#### 两版对照

| 行为 | 基线 `0.1.59` | 当前工作区 |
|---|---|---|
| 未知分区是否阻塞导入 | 否（`valid=true`） | 否（`valid=true`） |
| 未知分区的数据 | ❌ 完全丢弃 | ❌ 仍然丢弃（格式 v1 无「原样保留未知分区」能力） |
| 是否有「不受支持分区」的独立告警 | ❌ 无；只有一条**措辞错误**的 missingSections 告警 | ✅ 有：`备份包含本版本不支持的分区: X（已跳过，未导入）` |
| 是否有机器可读的 unsupported 通道 | ❌ 无 | ✅ `ImportAnalysis.unsupportedSections: string[]` |
| 是否与「声明但缺失」混淆 | ❌ 是（同一类告警） | ✅ 否（`missingSections` 显式剔除被跳过的分区，`src/core/analyzer.ts` 的 `analyzeImport`（`skippedSections` 从 `missingSections` 剔除），告警在 `src/core/analyzer.ts` 的 `analyzeImport`（`missingSections` 告警）） |
| 为未来 schema 预留「原样保留并回传未知分区」 | ❌ 无 | ❌ 仍无（导入不产出新 bundle） |

**为什么数据仍会被丢（两版一致）**：`extractSections` 只遍历 `manifest.sections`，且只处理「文件类前缀」与「JSON 路径表」两类；未知 id 既不在 `SECTION_FILE_PREFIXES` 也不在 `SECTION_JSON_PATHS`，因此在当前工作区里被 **显式** `continue`（`src/core/analyzer.ts` 的 `extractSections`（未知 id 显式 `continue`）），在基线里被**静默** `continue`（基线 `src/core/analyzer.ts:204-205`）。区别只在「是否告知用户」。

**结论（对第三方 importer 的要求）**：

1. **未知分区不得阻塞导入**——两版都满足（`valid=true`），这是必须保持的。
2. **未知分区必须显式告警**，且文案要与「声明但缺失」区分开——基线**不满足**，当前工作区满足。第三方应做到当前工作区的水平（§7.5）。
3. **未知分区的原始字节不会幸存**（两版都不幸存）。若第三方需要前向兼容地「保留未知分区」，必须自己扩展（本实现没有这条路径）。

### 7.3 已知分区内的未知字段（④）——**因分区而异，务必逐分区对待**

这一条**不能一句话概括**。现有实现里，`validateSectionData` 只做形状检查、从不重写数据（`src/schema/config.ts` 的 `validateSectionData` 的 `parseSectionJson` 直接返回 `parsed`），但**真正决定未知字段命运的，是各 adapter 的 `applyItem` 怎么写目标**。

§0.2 运行验证（在 `config/settings.json` 注入 `x-future-section-key` 与 `namespaces.general['x-future-ns-key']`，然后真正执行导入）：

```
[A] plan item kinds=["settings:Create"]
[A] 目标 general = {"theme":"dark"}      ← 未知字段未进入目标
```

**下表已全部由实测补齐**（不再有「未验证」项）：一份 bundle 内同时覆盖**全部 8 个 JSON 类分区**（其余 5 个文件类分区无 JSON 载荷，结构上无法承载未知字段——这一点本身也是实测结论），走完整三段式导入后逐一读目标状态；命令与逐分区输出见本节末尾的「实测命令与输出」。表内「原因」列是对实测结果的源码解释，「取证」列给出决定该行为的那一行。

| 分区 | 未知字段是否写回目标 | 原因 | 取证 |
|---|---|---|---|
| `settings` / `ui` | ❌ 否（分区级与 namespace 级未知字段均丢失） | `applyNamespaceItem` 只取 `data.namespaces[ref].value` 并整体替换目标 namespace | `src/adapters/settings.ts:107-126` |
| `providers` | ⚠️ **分区级 / route 条目级 = 否；`raw` 内部 = 是** | 写回值是 `entry.raw ?? stripEntry(entry)`，`raw` 是**整个 namespace 值的深拷贝**，因此 `raw` 内部的未知字段随 namespace 一起落到目标；而 `stripEntry` 只取 8 个已知字段，故**无 `raw` 时**未知字段丢失 | `src/adapters/providers.ts:34-40`（`stripEntry` 白名单）、`src/adapters/providers.ts:131-145`（`const value = entry.raw ?? stripEntry(entry)`） |
| `mcp` | ❌ 否（且**连条目自身的 `type` 字段都不写回**） | 写回时由白名单字段**重建** patch 行（`buildMcpPatchLine`），只输出 `serverName` + 按 `type` 分支的 `url/headers` 或 `command/args/env/cwd`；`type` 本身不进 patch 行 | `src/adapters/mcp.ts:68-81`、`src/adapters/mcp.ts:159-162` |
| `prompts` | ❌ 否 | 写回走两条路径，都重建：Create → `buildPromptLine`（只写 `id/name/config.systemPrompt.persona` 或 `config.planMode.sections`）；Update → `mergePromptIntoLine`（只改 `persona` / `sections[].text`，其余取自**目标行**） | `src/adapters/prompts.ts:100-107`、`src/adapters/prompts.ts:79-98`、`src/adapters/prompts.ts:184-208` |
| `workspaces` | ✅ **是**（条目级未知字段原样落到目标记录） | `applyItem` 直接把 `data.workspaces.find(...)` 的**整个记录对象**交给 `ctx.target.workspace.writeRecord(rec)`，无字段过滤 | `src/adapters/workspaces.ts:67-77` |
| `credentialsStatus` | ❌ 否（**该分区根本不写条目字段**） | `analyzeImport` 恒返回 `[]`；`applyItem` 只做 `credentials.set(ref, value)`，`value` 来自 `secretInputs` / `decryptedCredentials`，**从不读分区载荷里的条目字段** | `src/adapters/credentials.ts:105-118`、`src/core/analyzer.ts` 的 `executeImportPlan`（凭据写入路径；`ensureMissingSecrets` 只读 `ref` 与 `configured`） |
| `plugins.patch[].raw` | ✅ **是**（原样写回） | `applyPatchChanges(pl.file, [{ lineId: ref, raw: pl.raw, action }])`，不做字段过滤 | `src/adapters/plugins.ts` |
| 文件类 6 个（`skills` / `agentPresets` / `agentInstructions` / `pluginFiles` / `sessions` / `self`） | ⛔ **不适用**（无 JSON 载荷可注入） | ZIP 内没有这些分区的 JSON 文件；导入侧按前缀扫描真实条目**就地重建** `{version:1, files}`，任何「注入到 JSON 里的未知字段」根本没有承载位置 | `src/schema/section-registry.ts` 的 `SECTION_REGISTRY`（各文件类条目的 `payload.filePrefix`）、`src/core/analyzer.ts` 的 `extractSections`（文件类分区就地重建 `{version: 1, files}`）、`src/core/exporter.ts` |

**§7.3 实测命令与输出（S-3，可复现）**

探针：真实 `Exporter` 用**全部 13 个 adapter 分区**（`includeSessions` 缺省 false，故不含 `sessions`；`secrets` 无 adapter）产出 baseline → 在**每个 JSON 类分区**的载荷里注入未知字段标记 → 重算 checksums → 三段式导入（`analyzeImport` → `createImportPlan({strategy:'replace'})` → `executeImportPlan({confirm:true})`）到内存 mock 目标 → 逐一读目标状态。文件类分区无法注入 JSON 字段，改为核对「ZIP 内确实没有该分区的 JSON 条目」。

注入点（每条都在同一份 bundle 里同时注入，避免多次运行引入差异）：

```text
config/settings.json      : o['x-future-section-key']='S'; o.namespaces.general['x-future-ns-key']='NS'
config/ui.json            : o['x-future-section-key']='S'; o.namespaces.theme['x-future-ns-key']='NS'
ai/providers.json         : o['x-future-section-key']='S'; o.providers['llm-deepseek']['x-future-entry-key']='E'
                            o.providers['llm-deepseek'].raw['x-future-in-raw']='RAW'
mcp/servers.json          : o['x-future-section-key']='S'; o.servers[0]['x-future-item-key']='I'
custom/prompts.json       : o['x-future-section-key']='S'; o.prompts[0]['x-future-item-key']='I'
workspaces/workspaces.json: o['x-future-section-key']='S'; o.workspaces[0]['x-future-item-key']='I'
security/credentials.json : o['x-future-section-key']='S'; o.credentials[0]['x-future-item-key']='I'
plugins/plugins.json      : o['x-future-section-key']='S'; o.patch[lineId='probe-user-line'].raw['x-future-patch-key']='P'
```

运行结果（控制运行与注入运行的计划项分布**逐项一致**，说明未知字段既不产生计划项、也不改变计划项）：

```text
=== 控制运行（无注入）===
analysis.valid = true   errors = 0   warnings = 0
plan items by adapter = {"settings":2,"ui":1,"providers":1,"plugins":1,"mcp":1,"prompts":1,"skills":1,"agentPresets":1,
                         "agentInstructions":1,"workspaces":2,"pluginFiles":1,"self":2,"credentialsStatus":1}
result.ok = true   executed = 16   failed = 0

=== 未知字段注入运行 ===
analysis.valid = true   errors = 0
plan items by adapter = {"settings":2,"ui":1,"providers":1,"plugins":1,"mcp":1,"prompts":1,"skills":1,"agentPresets":1,
                         "agentInstructions":1,"workspaces":2,"pluginFiles":1,"self":2,"credentialsStatus":1}   ← 与控制运行完全一致
result.ok = true   failed = 0

--- 目标侧观测 ---
[settings]           dst ns general value        = {"theme":"dark","language":"zh-CN"}                    ← 'S'/'NS' 均未出现
[ui]                 dst ns theme value          = {"mode":"dark","accent":"blue"}                      ← 'S'/'NS' 均未出现
[providers]          dst ns llm-deepseek value   = {"apiKeyEnv":"DEEPSEEK_API_KEY","baseURL":"https://api.deepseek.com",
                                                    "model":"deepseek-chat","x-future-in-raw":"RAW"}    ← 仅 raw 内部的存活
[mcp]                dst patch line probe-mcp    = {"id":"probe-mcp","name":"dsh-mcp-client",
                                                    "config":{"serverName":"filesystem","command":"npx","args":["-y","x"]}}
                                                                                                        ← 'I' 未出现；且条目原有的 type="stdio" 也未写回
[prompts]            dst patch line probe-persona= {"id":"probe-persona","name":"@deepseek-ai/dsh-web",
                                                    "config":{"systemPrompt":{"persona":"You are a probe fixture."}}}
                                                                                                        ← 'I' 未出现（整行被重建）
[plugins]            dst patch line probe-user-line = {"id":"probe-user-line","name":"some-plugin",
                                                    "config":{"enabled":true},"x-future-patch-key":"P"} ← 'P' 存活
[workspaces]         dst records                 = [{"id":"ws-1","path":"C:\\Users\\probe-src\\proj",
                                                    "sessionIds":["s1"],"x-future-item-key":"I"}]       ← 'I' 存活
[credentialsStatus]  dst credentials             = []                                                    ← 无写入（分区不产生写入项）
[files]              dst fs keys                 = [".agent-presets/probe/agent.cordis.yml","AGENTS.md",
                                                    "dsh-config-manager/market/market-config.json",
                                                    "dsh-config-manager/sync/sync-config.json","dsh-ssh.json",
                                                    "skills/probe/coding.md"]                           ← 6 个文件全部正确落盘
```

**由此修正 §7.3 的结论**：旧版「**已知分区内的未知字段一律不写回**」是**错的**。正确表述是三条：

1. **`workspaces[]` 条目级未知字段会原样写回目标记录**（`writeRecord(rec)` 无字段过滤）——与 `plugins.patch[].raw` 同类。
2. **`providers` 的 `raw` 内部未知字段会写回**（因为 `raw` 承载的是整个 settings namespace 值）；但 `providers` 的**分区级**与 **route 条目级**未知字段丢失。
3. 其余结构化分区（`settings` / `ui` / `mcp` / `prompts` / `credentialsStatus`）的未知字段**确实不写回**；`mcp` 更极端——连**已知字段 `type`** 都不写回（因为写回是白名单重建，不是字段合并）。

**判定**：对 importer 而言，**「未知字段是否写回」是分区相关的，不能一句话概括**。第三方实现**不得**声称「未知字段一律被保留」，也**不得**声称「一律被丢弃」——两种说法都会在真实 bundle 上给出错误的兼容性预期。就「导入配置」这一语义而言，本实现的真实取向是「**按已知语义重建**」，只有把「原始值整体搬过去」当成语义的分区（`workspaces` 记录、`plugins` patch 行、`providers.raw`）才会连带搬走未知字段。

### 7.4 未知 ZIP 条目（未列入 checksums 表）

§0.2 运行验证（往 ZIP 里加一个不在 checksums 表中的条目）：

```
[P9 多余条目未入 checksums] valid=true  errors=[]  warnings=["备份包含可执行文件 ..."]      ← 基线 0.1.59
```

**当前工作区实测**（同一构造：baseline 的 checksums 表**保持原样**，另追加 `stray/extra.txt` 后重打包）：

```text
原 checksums 表键 = ["config/settings.json","config/ui.json","ai/providers.json","plugins/plugins.json",
                    "mcp/servers.json","custom/prompts.json","workspaces/workspaces.json","security/credentials.json"]
valid    = true
warnings = ["ZIP 内含未登记进校验表的条目: \"stray/extra.txt\"（未被校验）"]      ← 独立、可读的告警
errors   = []
```

| 事实 | 取证（**当前工作区**行号；基线行号另注） |
|---|---|
| **基线 `0.1.59`**：普通导入路径不检查「ZIP 里有但 checksums 表没覆盖」的条目 | 基线 `src/core/analyzer.ts:141-163`（只做表 → 条目的单向校验） |
| **当前工作区**：检查并产出 warning（不阻断），但**仅在 checksums 表存在且非空时** | `src/core/analyzer.ts` 的 `loadBundle`（`table` 取值 + 空表判定 + 多余条目检查）、`src/core/analyzer.ts` 的 `loadBundle`（`verifyAgainstTable` + 反向「未登记条目」检查） |
| **表缺失或为空** → 整段完整性逻辑跳过，改为产出**独立告警** `import.checksumsMissing`（`备份未提供完整性校验表，全部条目未被校验`） | `src/core/analyzer.ts` 的 `loadBundle`（表缺失/为空 → `import.checksumsMissing`）；一致性测试 `INT-02` / `INT-03`（`tests/conformance/roundtrip.test.ts:945-1006`） |
| 目录条目（尾随 `/`）被排除在「多余条目」判定之外 | `src/core/analyzer.ts` 的 `loadBundle`（`!name.endsWith('/')` 排除目录条目） |
| **自检路径**（`backup-verify`）也会把它列为 warning（不是 error） | `src/core/backup-verify.ts:265-272` |
| 只有扩展名命中可执行黑名单时才产生一条 warning | `src/core/analyzer.ts` 的 `loadBundle`（`EXECUTABLE_EXTENSIONS` 扫描 → `import.executableWarning`）、`src/core/analyzer.ts` 的 `EXECUTABLE_EXTENSIONS` 扫描（见 `loadBundle`） |

即：**checksums 的校验方向是单向的**（保证表内条目未被篡改，`src/utils/hashing.ts:42-51`）——当前工作区**额外**做了一次反向「未登记条目」计数告警，但**不把它变成 error**，也**不拒绝**这类条目。第三方不应假定「ZIP 内没有多余内容」是被保证的。

> **⚠️ 行为正在变更（本轮 H2 修复）**：上表第 3 行是**当前工作区**状态，不是基线行为。基线（`v0.1.58`）在 checksums 表缺失或为空时**整段跳过、零告警**（`valid=true` 静默通过）；本轮已改为显式告警。若你对照的是**已发布版本**，请以「表缺失 ⇒ 一个条目都没校验且不告知」为基线行为。

### 7.5 给第三方实现者的规范建议（明确区分「现状」与「建议」）

下面是**建议**，不是现有实现的行为。第三方实现可以选择比本实现更严格：

| 场景 | 建议行为 |
|---|---|
| 未知分区 id | 必须**显式告警**（说明「不受支持、已跳过、数据未导入」），不得复用「声明但缺失」的文案；不得因此拒绝整个 bundle |
| 未知顶层 / 已知对象内未知字段 | **保留在内存解析结果中**，不要因未知字段报错；不要尝试解释它们 |
| 已知分区内的未知字段 | **按分区对待**（实测见 §7.3）：`settings`/`ui`/`mcp`/`prompts`/`credentialsStatus` → 忽略；`workspaces[]` 记录、`plugins.patch[].raw`、`providers.raw` → 会随「整体搬运」落到目标。**不要因未知字段报错**，也**不要对外承诺「未知字段一定保留」或「一定丢弃」** |
| 已知分区内的**已知**字段 | 注意 `mcp.servers[].type` 这类「读得到、写不回」的字段：本实现按白名单重建 patch 行，`type` 本身不进 patch 行（§7.3 实测）。第三方若需要 `type` 存续，必须自己扩展写回形状 |
| 文件类分区条目名 | 归一化后再比对目标路径（§3.3.1 D）；拒绝中段反斜杠（比现状更严格） |
| 未知 ZIP 条目 | 至少**计数并告警**（可参考 `src/core/backup-verify.ts:265-272` 的做法） |
| 目录条目（尾随 `/`） | 跳过，不拒绝、不创建文件（§1.5.6） |
| `sections` 中声明但 ZIP 内缺文件 | 与「未知分区」区分开：前者是 `missingSections`（本实现已有告警，`src/core/analyzer.ts` 的 `analyzeImport`（`skippedSections` 从 `missingSections` 剔除）），后者是 unsupported |

---

## 8. 迁移链契约

### 8.1 现状

| 项 | 值 | 取证 |
|---|---|---|
| 注册表 | `MIGRATIONS: MigrationStep[]`，当前含一个占位步骤 `V1_TO_V2` | `src/migrations/index.ts:27` |
| 占位步骤行为 | `migrate(doc)` **原样返回同一引用**（不建新对象、不展开白名单） | `src/migrations/v1-to-v2.ts`（`src/migrations/index.ts:8` 引用）、`tests/schema-compat.test.ts:89-94`（SC-06） |
| 触发条件 | `CURRENT = 1` 时**永不触发**（不存在 `1 < v < 1` 的整数） | `tests/schema-compat.test.ts:17-18`、`tests/schema-compat.test.ts:133-136` |
| 版本判定唯一出口 | 所有模块经 `src/schema/versions.ts` 判定；`if (v === 1)` 式散落判断是**禁止项** | `src/schema/versions.ts:1-6` |

### 8.2 未来新增 schema 版本时，实现者**必须**做什么

按 `src/migrations/index.ts:1-6` 与 `migrateToCurrent` 的实现（`src/migrations/index.ts:44-71`）反推，发布 schema v2 的完整契约如下：

| # | 必须做的事 | 依据 | 不做的后果 |
|---|---|---|---|
| 1 | 新增一个 `MigrationStep`：`{from: N, to: N+1, migrate(doc): unknown}`，纯函数、不触碰目标 DSH | `src/migrations/index.ts:10-15` | `migrateToCurrent` 抛「没有从 schema vN 到 vN+1 的迁移路径」（`src/migrations/index.ts:60-62`） |
| 2 | 注册到 `MIGRATIONS`（`registerMigration` 或直接入表），保持 `from` 严格递增、无重叠 | `src/migrations/index.ts:30-35` | `registerMigration` 抛「迁移步骤冲突」（`src/migrations/index.ts:31-32`） |
| 3 | 更新 `CURRENT_SCHEMA_VERSION` | `src/schema/versions.ts` | 新版本仍被 `isTooNew` 拒绝 |
| 4 | **决定 `MIN_SUPPORTED_SCHEMA_VERSION` 是否上移**。若保持 `1`，则 v1 备份必须能一路迁到 v2；若上移到 `2`，则 v1 备份**立即变为不可导入**（抛错，不是降级） | `src/schema/versions.ts`、`src/migrations/index.ts:51-53` | 误上移会让所有历史备份变成废纸 |
| 5 | **迁移函数必须保持未知字段透传**（不得引入白名单重写） | `tests/schema-compat.test.ts:79-87`（SC-05）、`tests/schema-compat.test.ts:157-176`（SC-10） | 用户自定义/未来字段被静默抹掉 |
| 6 | 每个步骤必须真的前进（`to > from`），否则引擎抛「未前进（注册表损坏）」 | `src/migrations/index.ts:63-65` | 死循环防护触发 |
| 7 | 新版本若**不**保持对 v1 的读取能力，按仓库规则属于 breaking → 必须升 major 并在 CHANGELOG 给出迁移说明 | `docs/spec/compat-matrix.md:295-298`（规则 M5） | 违反既有发布纪律 |

### 8.3 迁移与分区 version 是**两个独立轴**（易错点）

| 轴 | 字段 | 判定点 | 迁移能力 |
|---|---|---|---|
| bundle schema | `manifest.schemaVersion` | `src/core/analyzer.ts` 的 `loadBundle`（`isSupported` 判定） | **有**迁移链（`migrateToCurrent`） |
| 分区载荷 | 每个分区 JSON 的 `version` | `src/schema/versions.ts` 的 `sectionDataVersionIssue`（`version === 1` 判定，精确 `=== 1`） | **没有**迁移链，直接 error |

> ⚠️ 这意味着：未来若要演进**某个分区**的结构，实现者只有两条路——(a) 提升 `manifest.schemaVersion` 并在迁移步骤里改写该分区 JSON；或 (b) 保持 `version: 1` 并**只新增可选字段**（向后兼容的加法演进）。**推荐 (b)**：它是当前唯一被证明可用的路径。
>
> **(a) 的当前工作区状态（勿沿用旧表述）**：迁移链**已经接入导入路径**——`analyzer.loadBundle` 在 `needsMigration(manifest.schemaVersion)` 为真时调用 `runSchemaMigration`（`src/core/analyzer.ts` 的 `needsMigration` 守卫分支（调用 `runSchemaMigration`），实现见 `src/core/analyzer.ts` 的 `runSchemaMigration`），迁移结果重新过 `validateManifest` 后才作为后续 manifest 使用。因此「迁移链只作用于文档、导入路径从不调用 `migrateToCurrent`」**不再成立**（该表述对应基线 `0.1.59`，见 §10 G-06 的「基线」列）。但**当前 `MIN_SUPPORTED_SCHEMA_VERSION = CURRENT_SCHEMA_VERSION = 1`**，`needsMigration` 恒假，所以这条路径在真实导入中**结构上仍不可达**（§10 G-07 仍成立）：接线已就绪，只是还没有可迁移的版本区间。

---

## 9. 最小实现清单（第三方只读 importer）

按「照做就能通过一致性测试」的顺序列出。每条给出验收判据。

| # | 步骤 | 验收判据 |
|---|---|---|
| 1 | 按 §1 读 ZIP：正斜杠条目名、UTF-8（按 §1.5.4，**不依赖 EFS flag**）、method ∈ {0,8}、**CRC32 取中央目录值**、`解压长度 === uncompressedSize`、容忍数据描述符（§1.5.5）与目录条目（§1.5.6）、拒绝 Zip Slip / 绝对路径 / 以 `\` 开头的名字、强制 §1.3 限额 | 对 `../evil.txt`、`C:/evil.txt`、`/abs` 条目**整体拒绝**；对 method=12、CRC 不符、尺寸不符**整体拒绝**；对 method=0（真 stored）、EFS 未置、bit3 置位、目录条目**接受** |
| 1b | 条目名归一化（**文件类分区专用**，见 §3.3.1）：`relativePath = name.slice(prefix.length)`，跳过 `rel === ''` 与 `rel.endsWith('/')`，目标路径 = `join(baseDir, relativePath)` 归一化后再比对 | 含 `//` / `./` 的条目名必须落到归一化后的同一路径；含 `..` 段的条目名在条目名层就被拒（不依赖 `join` 兜底） |
| 2 | 探测外层容器：前 4 字节 == `DCA1` → 要求密码，解密后得到明文 ZIP 再继续；否则按 ZIP 解析 | 对加密容器不报「ZIP 损坏」，而是报「需先解密」（对齐 `src/core/backup-verify.ts:175-178`） |
| 3 | 要求 `manifest.json` 存在；不存在 → 明确报「不是本格式的 bundle」 | 对齐 `import.noManifest` 文案语义（`src/core/analyzer.ts` 的 `loadBundle`（ZIP 存在性检查 → `import.noManifest`）） |
| 4 | 解析 manifest 并按 §2.2 逐字段校验；任一 error → 拒绝；`sections` 内未知键 → **warning 不拒绝**；**判断「含秘密/需密码」只看 `security.containsSecrets` / `security.encrypted`，不看 `sections.secrets`**（§2.5 G-10） | 对齐 M-04（`tests/schema/manifest.test.ts:81-89`）；`sections.secrets` 无论真假都不得影响安全判断 |
| 5 | 版本协商：`schemaVersion > CURRENT` → 硬失败并提示「需升级插件」；`< MIN_SUPPORTED` → 硬失败；**不得静默降级** | 对齐 §6.2；错误文案含版本号 |
| 6 | 若 `integrity/checksums.json` 存在：逐条比对 SHA-256，**不符或缺失 → 整体拒绝**；表缺失 → 跳过校验 | 对齐 `src/core/analyzer.ts` 的 `loadBundle`（checksums 比对 → `import.integrityFailed`；表缺失 → `import.checksumsMissing`） |
| 7 | 遍历 `manifest.sections` 中为 `true` 的项：JSON 分区按 §1.1 路径读并校验 `version === 1` + §3.3 形状；文件类分区按前缀收集真实文件（**条目名规则见 §3.3.1**） | 已知分区 `version > 1` → **跳过该分区并告警**（不拒绝整个 bundle）；`version < 1` / 非数字 / 缺失 → 拒绝（对齐 §3.3 三档实测） |
| 8 | **未知分区 id**：明确告警（不受支持/已跳过），**不**因此拒绝整个 bundle，**不**把它混入「声明但缺失」 | 见 §7.2；这是本规格要求第三方**做得比现有实现更好**的一条 |
| 9 | 声明为 `true` 但 ZIP 内无对应文件的 JSON 分区 → 记入 `missingSections` 并告警（不拒绝） | 对齐 `src/core/analyzer.ts` 的 `analyzeImport`（`skippedSections` 从 `missingSections` 剔除） |
| 10 | 未列入 checksums 表的额外 ZIP 条目 → 至少计数并告警（建议） | 参考 `src/core/analyzer.ts` 的 `loadBundle`（未登记条目 → `import.extraEntries` 告警，当前工作区已做）、`src/core/backup-verify.ts:265-272` |
| 11 | `security.encrypted === true` → 未拿到解密结果时**拒绝执行任何写入** | 对齐 `src/core/analyzer.ts` 的 `executeImportPlan`（`security.encrypted` 未拿到解密结果 → 拒绝写入）；§0.2 运行验证 |
| 12 | 未显式 `confirm` → 拒绝执行（只读分析与预览必须零写入） | 对齐 `ImportNotConfirmedError`（`src/core/types.ts`）、`src/core/analyzer.ts` 的 `EXECUTABLE_EXTENSIONS` 扫描（见 `loadBundle`）6 |
| 13 | 执行前对将被修改的目标做快照；执行失败可回滚 | `src/core/analyzer.ts` 的 `executeImportPlan`（强制快照：`createSnapshot`）、`src/core/analyzer.ts` 的 `executeImportPlan`（失败回滚） |
| 14 | 逐分区落盘时**按已知语义重建**（见 §7.3 实测表）：`settings`/`ui`/`mcp`/`prompts`/`credentialsStatus` 忽略未知字段；`workspaces[]` 记录、`plugins.patch[].raw`、`providers.raw` 会**整体搬运**（连带未知字段） | 不得声称「未知字段一律被保留」，也不得声称「一律被丢弃」——两种说法都会给出错误的兼容性预期 |
| 15 | 凭据值：`credentialsStatus` 分区**永不含值**；补录值只经凭据写入通道，绝不落盘/落日志 | `src/schema/types.ts` 的 `interface CredentialStatus`、`src/core/analyzer.ts` 的 `executeImportPlan`（凭据写入通道：只认 `decryptedCredentials`，绝不落盘） |
| 16 | 导出报告里的 `redactedHits` **不参与** bundle 读写：第三方 importer **不需要**从 bundle 读取它，也**不能**反推它（§5.3.3） | bundle 内不存在该字段的任何载体 |

**只读 importer 可以跳过**：加密导出（§4.1 内层生成）、checksums 生成、`localTarballs` 解包、`patchFiles` 落盘（`profiles/<profile>/<relativePath>`）、市场通道约束（§3.5）、插件安装副作用。

---

## 10. 已知缺口（不粉饰）

> 下列条目是**现有实现与「基础设施应有的行为」之间的真实差距**。它们不是「待办清单」，而是给第三方实现者的**风险提示**：照抄现有行为会继承这些缺陷。
>
> **⚠️ 时效性声明（必读）**：本规格的取证基线是提交 `696cb17`（曾被标记为 `0.1.59`，但**从未发布**；`v0.1.60` 已并入 `v0.1.59`，本版将以 `v0.1.59` 发布）。在**格式相关行为**上，该基线与 npm 上**最新已发布**的 `v0.1.58` 一致，故「基线版本」列可视为**已发布版本**的真实行为；「当前工作区状态」列是**本文件写作时仓库工作区**的实测/读码结论，两列**刻意分开**——已发布版本仍可能带这些缺陷，第三方实现者需要知道它们存在过、以及修好之后应该长什么样。
>
> **当前工作区状态汇总**：✅ 已修复 G-01 / G-02 / G-03 / G-04（含本轮补齐的表缺失分支）/ G-06 / G-09 / G-10（规格侧澄清）；➖ **G-08 已按产品决策整体移除**（不是「修复」——加密不再做任何密码强度校验，该能力被有意取消，任何非空密码可用）；⚠️ G-05 部分修复（不对称）；⚠️ G-07 **仍然成立**（`MIN = CURRENT = 1` 未变，迁移分支结构上仍不可达，但接线已就绪）；✅ G-11 仍然成立（本版新增登记）。
>
> 行号口径：**「当前工作区状态」列引用的行号是当前源码行号**（写作时逐条用 Node 读行内容核对过）；「基线」列的行号指 `0.1.59` 发布版源码。源码仍在并行修改，若行号漂移请以符号名（函数/消息 key）为准检索。

| # | 缺口 | 具体表现（基线版本） | 取证 | 影响面 | **当前工作区状态** |
|---|---|---|---|---|---|
| **G-01** | **未知分区被静默丢弃** | 未知 id 的 `sections` 键进入不了 `SECTION_JSON_PATHS`/`SECTION_FILE_PREFIXES`，`extractSections` 直接 `continue`；ZIP 内该分区的数据从未被读取，也从未被告知 | 基线：`src/core/analyzer.ts:204-205`；§0.2 运行验证 | 前向兼容的核心缺陷 | ✅ **已修复**：`src/core/analyzer.ts` 的 `extractSections`（`unsupportedSections` 收集） 单独收集 `unsupportedSections`，`src/core/analyzer.ts` 的 `extractSections` 的汇总告警（`import.unsupportedSections`）产出独立告警 `备份包含本版本不支持的分区: keybindings（已跳过，未导入）`（§7.2 实测）。**注意**：数据本身仍不被保留（格式 v1 无此能力） |
| **G-02** | **告警文案误导** | 未知分区落进 `missingSections`，用户看到「备份声明了但缺少的分区: keybindings」——但文件其实在 ZIP 里 | 基线：`src/core/analyzer.ts:275-280`、`src/core/messages.ts`（`import.missingSections`） | 用户无法判断「我该升级插件」还是「备份坏了」 | ✅ **已修复**：`missingSections` 现在剔除被跳过的分区（`src/core/analyzer.ts` 的 `analyzeImport`（`skippedSections` 从 `missingSections` 剔除），告警在 `src/core/analyzer.ts` 的 `analyzeImport`（`missingSections` 告警）），未知分区不再混入 |
| **G-03** | **无「不支持分区」的概念** | 全仓库没有 unsupported-section 的报告通道；`ImportAnalysis` 只有 `sectionsInZip`（只含**已知**分区）与 `warnings`/`errors` | 基线：`src/core/types.ts:201-213` | 第三方无法从现有 API 学到正确做法 | ✅ **已修复**：`ImportAnalysis.unsupportedSections` 已存在（`src/core/types.ts`，填充点 `src/core/analyzer.ts` 的 `analyzeImport`（`unsupportedSections` 填充点）），§7.2 实测返回 `["keybindings"]` |
| **G-04** | **checksums 单向** | 只校验「表内条目未被篡改」，不校验「ZIP 内没有多余条目」；普通导入路径对此零告警 | `src/utils/hashing.ts:36-52`、`src/core/analyzer.ts:141-163`；§0.2 运行验证（P9） | 可向 bundle 注入任意未登记文件而不被普通导入察觉 | ✅ **已修复**：表存在且非空时，`src/core/analyzer.ts` 的 `loadBundle`（反向检查未登记条目 → `import.extraEntries`） 产出 `import.extraEntries` warning。**表缺失/为空**这一半（本轮审计新发现的漏报）修复已进入工作区（同一 `loadBundle` 另产出 `import.checksumsMissing`，一致性测试 `INT-02`/`INT-03` 钉住），但**由并行任务收口，本文件不声称已验收完成**——详见 §7.4 的「行为正在变更」提示 |
| **G-05** | **分区 version 无兼容余地** | 精确 `=== 1` 判定；任何已知分区 JSON 的 `version != 1` 都会让**整个 bundle** 无法导入（而非跳过该分区） | 基线：`src/schema/versions.ts` 的 `sectionDataVersionIssue`（`version === 1` 判定）；§0.2 运行验证（P4 抛错） | 未来分区结构演进没有加法之外的空间 | ⚠️ **部分修复**：`version > 1` 现在**跳过该分区**并告警（`src/core/analyzer.ts` 的 `extractSections`（`import.unsupportedSectionVersion` → 跳过该分区），§3.3.3 实测）；`version < 1` / 非数字 / 缺失**仍让整个 bundle 硬失败**（不对称，见 §3.3） |
| **G-06** | **迁移链未接入导入路径** | `migrateToCurrent` 已实现且有测试，但**导入路径从不调用它**：`analyzer.loadBundle` 只用 `isSupported` 判定后直接继续 | 基线：`src/core/analyzer.ts:165-168` | 一旦 `CURRENT > MIN`，旧备份会被「判定为可迁移」却**不会真的被迁移** | ✅ **已修复**：`src/core/analyzer.ts` 的 `needsMigration` 守卫分支（调用 `runSchemaMigration`） 在 `needsMigration` 为真时调用 `runSchemaMigration`（`runSchemaMigration` 的实现），迁移结果重新过 `validateManifest` 才作为后续 manifest 使用。当前 `MIN = CURRENT = 1` 故路径仍不可达（见 G-07） |
| **G-07** | **`needsMigration` / `describeVersion` 的「将迁移」分支当前不可达** | `MIN = CURRENT = 1`，不存在 `1 < v < 1` 的整数 | `tests/schema-compat.test.ts:17-18`、`tests/schema-compat.test.ts:154` | 迁移链在真实导入中**从未被执行过**，其正确性是理论值 | ⚠️ **仍然成立**（`MIN = CURRENT = 1` 未变）；但迁移链已接入导入路径（G-06），一旦上移 `CURRENT` 即会真实执行。**这不是待修缺陷，而是版本区间的必然结果**——修复动作只在发布 v2 时随 G-06 一并生效 |
| **G-08** | **密码强度校验（基线形同虚设 → 一度接通 → 按产品决策整体移除）** | 基线 `0.1.59` 中强度校验函数已实现且有单测，但在 `src/index.ts` 中**零调用**——导出端只要求 `password` 是非空字符串。**形同虚设**：有一个「看起来在守、实际不跑」的强度函数 | 基线：`src/security/encryption.ts:165-174`（函数定义）、`src/index.ts` 的备份导出路由（基线唯一校验是 `!== ''`） | 基线：弱密码可被接受（当时无闸门）；**现状：这是刻意的产品决策，不是缺陷** | ➖ **已按产品决策整体移除**（2026-09-13）：本轮一度接通的三层闸门（导出路由 400 拒绝、`config_backup` 结构化拒绝、加密层兜底）**被全部删除**，而非保留或收紧。**当前唯一约束是非空**：空字符串抛 `BAD_PASSWORD`（`src/security/encryption.ts:85`、`:197`），其余任何密码（含 `1` / `12345678` / `password`）一律接受。被移除的符号与消息键（强度校验函数、断言函数、导出路由密码守卫、`export.passwordTooWeak`）**在当前工作区已不存在**，第三方**不得**假设本格式有密码强度要求。 |
| **G-09** | **文件类分区内容不扫描 secret** | `skills`/`agentPresets`/`agentInstructions`/`pluginFiles`/`sessions`/`self` 的文件内容**完全不进扫描器**，也不计入 `redactedHits` | 基线：`src/core/exporter.ts:161-167`、`src/adapters/self.ts:21-22` | 「默认不含秘密」对文件类分区**不成立**；`pluginFiles` 默认 `false` 与市场 BANNED 是对此的缓解，但**用户显式勾选即可带出明文** | ✅ **已修复（已实测复核）**：文件类分区改走 `scanFileSectionText`（定义 `src/core/exporter.ts:135-161`，调用点 `src/core/exporter.ts`），命中**计入 `redactedHits`** 并逐条产出 `export.fileSectionSecrets` 告警（`src/core/messages.ts`）。**边界（仍然成立）**：只报告**不改写**（绝不剥离用户文件内容）；默认 `defaultSecretScanner` 未实现 `scanText` → 该分支返回空、行为与修复前一致（`src/core/exporter.ts:130-131`、`:137`），生产路径注入的是含 `scanText` 的强化扫描器。**遗留的告警去重问题**见本表 G-13 |
| **G-10** | **`secrets` 在 `sections` 中恒 `false` 但语义被复用** | `sections.secrets` 永远是 `false`（无 adapter）；加密事实由 `security.encrypted` 承载。若第三方按「`sections.secrets === true` 表示含凭据」理解会出错 | 基线：`src/core/exporter.ts:296`（基线行号）；§0.2 运行验证 | 格式语义的坑（文档级，非实现缺陷） | ✅ **已收口（规格侧澄清，实现未变）**：`buildSectionFlags` 里 `flags['secrets'] = false` 仍在（**当前工作区** `src/core/exporter.ts`），这不是实现缺陷而是**语义设计**；§2.5 已加显式警告块，§9 步骤 4 的验收判据明确「含秘密/需密码只看 `security.containsSecrets` / `security.encrypted`，不看 `sections.secrets`」。第三方按该判据实现即不会误判 |
| **G-11** | **条目名侧不拒绝中段反斜杠（与 checksums 侧不一致）** | `isPathSafe` 只拒绝「以 `/` 或 `\` 开头」与「含 `..` 段」的名字，**中段 `\` 被接受**：`isPathSafe('custom/skills/back\\slash.md') === true`，写侧 `zipToBuffer` 也接受，读侧 `parseZip` 也接受。后果：① 同一份 bundle 在 Windows 目标上把 `\` 当分隔符（`skills/probe/back/slash.md`），在 POSIX 目标上当普通字符（`skills/probe/back\slash.md`）——**跨平台路径语义不一致**；② 而 `checksums.json` 的键侧**明确拒绝**含 `\` 的路径（`src/security/integrity.ts:63`），两套规则不对齐 | `src/utils/paths.ts:45-54`（无 `\` 检查）、`src/utils/zip.ts` 的 `zipToBuffer`（条目名 `isPathSafe` 闸）、`src/utils/zip.ts` 的 `parseZip`（条目名 `isPathSafe` 闸）；§3.3.2 实测 C10 | 条目名安全边界；跨平台不一致；第三方若照抄 `isPathSafe` 会继承该缺陷 | ✅ **仍然成立**（本版新增登记，实测确认）。**这是本表唯一一条「未修复的格式行为缺陷」** |
| **G-12** | **G-04 的收窄残留：checksums 表缺失/为空时「未登记条目」漏报** | 反向完整性检查（「ZIP 里在、校验表里不在」的条目）原本整段嵌在「表存在」分支内：剥掉 `integrity/checksums.json` 或把它置为 `{}` ⇒ 一个条目都不校验、也零告警，却 `valid=true` | 基线：`src/core/analyzer.ts:163`（`if (archive.has(CHECKSUMS_FILE))` 包住整段） | 与 G-04 同源：可静默绕过完整性校验 | 🚧 **本轮审计新发现，正在修复（未收口）**。**工作区已见修复**：`src/core/analyzer.ts` 的 `loadBundle`（表缺失/为空 → `import.checksumsMissing`） 把「表缺失或为空」统一映射为 `import.checksumsMissing` 告警，反向检查（同一 `loadBundle`）此时不再运行（无表可对照）；回归测试 `INT-02` / `INT-03` / `INT-04`（`tests/conformance/roundtrip.test.ts:945-1031`）。**但由并行任务负责收口与验收，本文件不声称已修完**——详见 §7.4「行为正在变更」提示与 `docs/spec/known-gaps.md` §2 |
| **G-13** | **G-09 的告警去重问题** | 文件类分区的 secret 命中告警原本按 **hit** 计数且不去重：同一行同时命中「字段名」与「值形状」会产出两条**同路径**告警，少数文件就吃满 `MAX_FILE_SECTION_WARNINGS_PER_SECTION` 上限，使含真实明文凭据的其它文件被静默淹没 | 基线：`src/core/exporter.ts` 按 hit 逐条 push | 告警噪声，可淹没真正需要关注的命中；**不改变**「命中是否被检出」这一安全事实（计数始终可信） | 🚧 **本轮审计新发现，正在修复（未收口）**。**工作区已见修复**：`src/core/exporter.ts` 先按**文件路径**去重、再截断到 `MAX_FILE_SECTION_WARNINGS_PER_SECTION`（语义 = 不同**文件**数，常量在 `:107-108`），并对被截断的文件数补一条**汇总告警**；`redactedHits` 仍计**全量命中**。回归测试 `tests/core/exporter.test.ts:381` / `:436` / `:456`。**但由并行任务负责收口，本文件不声称已修完** |

> 说明：G-07 目前**没有可观测后果**（因为 `MIN = CURRENT = 1`，迁移路径不可达）。**G-06 已修复后，这条定时问题已解除**：一旦发布 schema v2，`loadBundle` 会沿迁移链真实执行迁移（`src/core/analyzer.ts` 的 `needsMigration` 守卫分支（调用 `runSchemaMigration`）），而不是「判定可迁移却按新格式直接用」。v2 发布前仍应补一条「v1 → v2 真实迁移」的端到端测试。
>
> G-11 的**实际可利用性有限**（`\` 不是 `..`，无法越出 baseDir 之外，且 L3 的 `isReservedInternalRel` 会在折叠后拦截保留命名空间），但它是**真实的行为不一致**，且会让跨平台幂等比对出错，因此按缺口登记，不粉饰。
>
> G-12 / G-13 是**本轮审计新发现**（不在基线 `0.1.59` 的登记范围内），状态一律标 🚧「正在修复」——**不要**把它们当作已解决；收口结论以负责该修复的任务与 `docs/spec/known-gaps.md` 为准。

---

## 11. 未验证清单

| 未验证项 | 原因 | 已完成的替代验证 |
|---|---|---|
| 普通导入（GUI 向导）是否恒使用 `parseZipHardened` | 需追宿主注入链，超出本规格取证范围 | 确认强化解析器存在且被市场路径使用（`src/market/security.ts`）；缺省为 `parseZip`（`src/core/analyzer.ts` 的 `Analyzer` 的 `parseZipFn` 字段与构造缺省） |
| `source.platform` 取值是否被严格校验为枚举 | 源码只校验 `typeof === 'string'` | 确认校验宽松（`src/schema/manifest.ts`），因此第三方写任意字符串不会被拒 |
| 条目顺序是否有契约 | 未在格式层找到固定顺序的断言 | 确认写入顺序由 adapter registry 与收尾写入决定（`src/core/exporter.ts` 为导出主流程、`:351-353` 落盘），格式层未固定 |
| `sessions` 分区（`includeSessions: true` 时挂载）内未知字段的行为 | 该分区与 `skills`/`agentPresets` 共用 `FileCollectionAdapter`（`src/adapters/sessions.ts`），无独立 JSON 载荷，因此**结构上不可能**承载未知字段；未单独跑一次 `includeSessions: true` 的实测 | 已实测同基类的 `skills`/`agentPresets`/`agentInstructions`/`pluginFiles`/`self` 五个文件类分区（§7.3）：ZIP 内无 JSON 载荷，导入侧按前缀重建，未知字段无承载位置 |
| 真实宿主（`src/index.ts`）注入的 scanner 是否与本规格 §5.2 描述一致 | 本规格取证范围是 core + adapters；宿主注入链只确认了 `deps.scanner`（`src/index.ts` 的 `makeRoutes({ scanner: secretScanner, … })`，构造点 `src/index.ts` 的 `const secretScanner = createConfiguredSecretScanner(config?.personalPatterns)`） | 确认缺省 `defaultSecretScanner` 的完整行为（`src/core/exporter.ts:59-94`），并说明强化版由宿主注入（§5.2 末段） |

> **已从本清单移除的四项**（本轮已实测补齐 / 已读码复核，不再是「未验证」）：
>
> - ~~`prompts` / `providers` / `workspaces` / `credentialsStatus` 分区内未知字段是否写回目标~~ → **已实测**，见 §7.3（含 `providers.raw` 与 `workspaces[]` 两个反例）。
> - ~~`redactedHits` 除 UI/日志外的持久化/审计用途~~ → **已查清**，见 §5.3（全仓库 5 处命中，不落 bundle、不落盘）。
> - ~~密码强度校验函数在 host 侧的实际调用点~~ → **已不再适用**：该函数本身已按产品决策**从源码整体移除**（见 §4.6 与 §10 G-08）。现状不是「调用点在哪」，而是**没有强度校验这回事**——加密只要求密码非空。基线 `0.1.59` 的旧表述「在 `src/index.ts` 中检索该符号零命中」描述的正是「已实现但从不调用」的形同虚设状态，该状态随移除一并终结。
> - ~~checksums 表**缺失或为空**时，ZIP 内多余条目是否告警~~ → **已查清并正在变更**：当前工作区在表缺失/为空时产出 `import.checksumsMissing` 告警（`src/core/analyzer.ts` 的 `loadBundle`（表缺失/为空 → `import.checksumsMissing`）），「未登记条目」反向检查（同一 `loadBundle`）此时不再运行（无表可对照）；基线 `0.1.59` 是整段跳过、零告警。行为正在变更，见 §7.4 的提示块与 §10 G-12。
>
> ~~G-09 / G-10 在**当前工作区**是否仍成立~~ → **已逐条读码复核**：G-09 ✅ 已修复（含边界说明）、G-10 ✅ 已在规格侧澄清；两者的当前状态见 §10 表内「当前工作区状态」列。~~G-08~~ **不再是「未验证」问题**：它已按产品决策整体移除，状态为 ➖ 而非 ✅（§10 G-08）。

---

## 附：一句话结论

Bundle Format v1 的**文件布局、manifest 契约、checksums 语义、加密字节布局、ZIP 读侧强制/容忍边界（§1.5）、文件类条目名归一化规则（§3.3.1）、各分区未知字段的真实命运（§7.3）、`redactedHits` 的非持久化语义（§5.3）**都已写明，第三方可以照 §1–§6 实现一个兼容的 exporter/importer。

**当前工作区仍需注意的真实缺口**（与 §10 缺口表的「当前工作区状态」列**逐条一致**，不含任何已在 §10 标 ✅ 的条目）：

- **G-11「条目名侧不拒绝中段反斜杠」**——跨平台路径语义不一致（本版新增登记；`src/utils/paths.ts:45-54` 与 `src/security/integrity.ts:63` 两套规则不对齐）。**这是本表唯一一条未修复的格式行为缺陷。**
- **G-07「`needsMigration` / `describeVersion` 的『将迁移』分支不可达」**——`MIN_SUPPORTED = CURRENT = 1` 未变，迁移链虽已接入导入路径（G-06 已修复），该分支在真实导入中仍结构上不可达。它不是待修缺陷，而是版本区间的必然结果。
- **G-12 / G-13（本轮审计新发现，🚧 正在修复、未收口）**——G-12：G-04 的收窄残留（checksums 表缺失/为空时「未登记条目」漏报）；G-13：G-09 的告警去重问题。**不要**当作已解决；收口以负责修复的任务与 `docs/spec/known-gaps.md` 为准。

**基线（已发布版本 `v0.1.58`）曾有、当前工作区已修复的缺口**（G-01 / G-02 / G-03 / G-04 / G-06 / G-09 / G-10；逐条取证见 §10）：它们**不再是**本文件的未修复缺口，但**已发布版本仍带这些缺陷**。**G-08 不在这一清单里**——它不是「已修复」，而是**已按产品决策整体移除**（见下方单独说明）。其中对第三方实现者仍然适用的只有两条：

- **G-01/G-02/G-03「未知分区」必须显式告警**——基线把未知分区**静默丢弃**并复用「声明但缺失」的误导文案（`src/core/analyzer.ts:204-205`、`:275-280`）；当前工作区已改为**独立通道 + 独立文案 + 从 `missingSections` 剔除**（`src/core/analyzer.ts` 的 `extractSections`（未知 id 收集）、`extractSections`（`import.unsupportedSections` 汇总告警）、`analyzeImport`（`skippedSections` 从 `missingSections` 剔除），§7.2 实测）。但**格式 v1 没有「原样保留未知分区」的能力**：未知分区的字节两版都不幸存。因此「显式告警、不混入『声明但缺失』、不拒绝整包」仍是本规格要求第三方**主动做得比基线更好**的**主要**一条（§7.5、§9 步骤 8）。
- **G-06「迁移链已接入导入路径」**——基线是「已实现但从不调用」的定时问题；当前工作区已在 `needsMigration` 为真时调用 `runSchemaMigration`（`src/core/analyzer.ts` 的 `needsMigration` 守卫分支（调用 `runSchemaMigration`））。发布 schema v2 前仍需补一条「v1 → v2 真实迁移」的端到端测试（§10 G-06 / G-07）。
- **G-08「加密密码强度」——第三方必须主动做得比基线更少，而不是更多**——基线与本轮中间态都曾存在强度闸门（基线是形同虚设的函数，中间态是三层接通）。**最终状态是按产品决策整体移除**：加密**不做**任何密码强度校验，任何非空密码都可用（§4.6、§10 G-08）。**第三方实现者不要假设本格式对加密密码有强度要求，也不要在自己的实现里加闸门**——那会与格式行为不一致，并可能让用户在跨实现迁移备份时被拒。

**本版已消除的规格空白**（独立审计确认缺失的 4 处 + 1 处澄清）：

| 空白 | 补全位置 |
|---|---|
| S-1 压缩方法 / CRC / UTF-8 flag 的「读侧强制 vs 容忍」边界 | §1.2（表已修正）+ **§1.5**（七个强制项判定表）+ §1.6（实测输出） |
| S-2 文件类分区条目名的归一化规则 | **§3.3.1**（写侧构造 / 读侧还原 / 四层非法路径处理 / 第三方建议）+ §3.3.2（12 例实测） |
| S-3「已知分区内的未知字段是否写回目标」 | **§7.3**（13 个分区全部实测补齐，含 `providers.raw` 与 `workspaces[]` 两个反例）+ §9 步骤 14 同步修正 |
| S-4 `redactedHits` 的持久化 / 审计语义 | **§5.3**（5 处消费点 + 明确「不进 bundle」+ 与 `containsSecrets` 的正交对照表） |
| G-10 `sections.secrets` 语义澄清 | **§2.5 的显式警告块** + §9 步骤 4 验收判据 + §10 G-10 |

**仍未验证的项**已在 §11 逐条列出（原因 + 已完成的替代验证）。本轮共把**四项**原先的「未验证」实测/读码补齐并移出清单（见 §11 末尾的移除块），并逐条复核了 G-09 / G-10 在当前工作区的真实状态（§10）；**G-08 不再属于「未验证」范畴**——它已按产品决策整体移除，最终状态是「加密不做密码强度校验」（➖，非 ✅，见 §4.6 与 §10 G-08）。
