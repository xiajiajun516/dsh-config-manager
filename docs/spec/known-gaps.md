# 已知缺口登记（known-gaps）

> 本文件登记 bundle 格式 v1 规格化过程中**实测确证**的实现缺口，并逐条给出**当前状态**。
> 每条缺口都有可执行的证据来源，不是推测。
>
> **性质说明**：这些是「现有实现」与「基础设施应有的行为」之间的真实差距。它们**不是**待办清单，而是两类读者的风险提示：
> - 对**第三方实现者**：照抄**已发布版本**的行为会继承这些缺陷；
> - 对**本项目维护者**：这些是需要按状态决策修复/复核的项。
>
> 权威来源：
> - `docs/spec/bundle-format-v1.md` §10（规格侧缺口表，含逐条取证与「基线 vs 当前工作区」双栏）
> - `tests/conformance/README.md` §3.1（特征化测试断言表）
>
> **修复流程**：见 `tests/conformance/README.md` §4。修好缺口时，特征化测试（`FC-01` / `VER-03` 等）会红灯提醒，需同步更新断言、规格 §10 缺口表与本文件。
>
> **状态口径（必读）**：本文件的「已修复」指**当前仓库工作区**的源码已不再具备该缺陷，且**有可复现的验证方式**（测试或隔离安装）。npm 上**最新已发布**的版本是 `v0.1.58`，它**仍带全部基线缺陷**；当前工作区已修复它们，并将以 `v0.1.59` 发布（原计划的 `v0.1.60` 已并入 `v0.1.59`，因为 `0.1.59` 从未发布）。行号是写作时逐条读源码核对的快照，源码仍在并行修改，检索时请以**符号名 / 消息 key** 为主锚点。
>
> **B1–L4 的性质**：这九条**不在** `0.1.59` 基线里，而是**本轮修复过程中由独立对抗性审计发现的新缺陷**（其中 B1 与 B2 是**本轮修复自身引入**的：新增告警第一次把包内可控字符串送进 UI 通道，而新写的源码守卫只测了符号存在性）。列出它们是为了留下完整记录——**修 bug 的过程本身也会造 bug，这需要被登记而不是被抹掉**。

---

## 0. 状态总览

| 缺口 | 主题 | 当前状态 |
|---|---|---|
| G-01 | 未知分区被静默丢弃 | ✅ 已修复 |
| G-02 | 未知分区告警文案误导 | ✅ 已修复 |
| G-03 | 无「不支持分区」的报告通道 | ✅ 已修复 |
| G-04 | checksums 单向（不检查多余条目） | ✅ 已修复（含表缺失分支，见 G-12） |
| G-05 | 分区 version 无兼容余地 | ⚠️ 部分修复（不对称，见 §1.5） |
| G-06 | 迁移链未接入导入路径 | ✅ 已修复 |
| G-07 | `needsMigration` 分支不可达 | ⚠️ 仍然成立（版本区间的必然结果，非缺陷） |
| G-08 | 密码强度校验（基线形同虚设 → 一度接通 → 按产品决策整体移除） | ➖ 已按产品决策**整体移除**（加密不做密码强度校验，任何非空密码可用） |
| G-09 | 文件类分区内容不扫描 secret | ✅ 已修复（只报告不改写） |
| G-10 | `sections.secrets` 恒 `false` 但语义被复用 | ✅ 已收口（规格侧澄清） |
| G-11 | 条目名侧不拒绝中段反斜杠 | ❌ **仍未修复** |
| G-12 | G-04 残留：表缺失/为空时漏报 | ✅ 已修复（`import.checksumsMissing`） |
| G-13 | G-09 残留：告警按 hit 不去重 → 真凭据文件零告警 | ✅ 已修复（按文件去重 + 截断补汇总） |
| P-1 | peerDependencies 体积（headless 为 UI 付费） | ✅ 已修复 |
| P-2 | `lib/**/*.map` 随包发布 | ✅ 已修复 |
| **B1** | 新增告警未经 `redact()` 渲染到 UI（本轮修复自身引入） | ✅ 已修复 |
| **B2** | VER-03 源码守卫恒绿（只测符号存在，不测接线） | ✅ 已修复（改为钉「受控调用」） |
| **M1** | `config_backup` 未传 scanner → 文件类扫描静默失效 | ✅ 已修复 |
| **M1b** | **定时自动备份**路径同样未传 scanner（第三条导出路径） | ✅ 已修复（三路同一实例） |
| **L1** | P-1/P-2 无自动化回归护栏 | ✅ 已修复（`tests/packaging-contract.test.ts`） |
| **L2** | `exports["./schema"]` 指向纯类型产物（运行时 0 导出） | ✅ 已修复（运行时入口 `lib/schema/index.js`：24 个运行时导出） |
| **L3** | `env-lock` heartbeat 在途写残留 `.tmp` → `rmSync` ENOTEMPTY | ✅ 已修复（写串行化 + release 前 drain） |
| **L4** | `run-store` 测试固定 `sleep` 竞态（全量并发时偶发） | ✅ 已修复（改 `waitFor` 条件等待） |
| G-14 | 同步只搬 `pnpmWorkspace` 声明、不搬 `patches/**` → 目标机 pnpm 拒绝一切安装（issue #35） | ✅ 已修复（`patchFiles` 同进同出 + 导入端剔除不可满足声明 + 市场双端拒收 + journal 状态可辨 + 计划项可回滚 + 工具链变更可见可取消） |
| G-15 | Windows 无 OS process identity → 阈值内的 PID 复用残留锁仍判 UNKNOWN_STATE（issue #36） | ⚠️ **部分修复**（长过期可显式回收；精确区分 PID 复用仍未实现，见 §3） |
| G-16 | 文件类分区静默跳过 junction/符号链接（issue #37） | ✅ 已修复（GUI 与 CLI 同一跟随内核 + 跳过/不可读均留痕；home 外目标仍拒绝且留痕） |
| G-17 | 同步页「导出密钥」无数据源：勾选后不导出任何凭据，只跳过载荷的二次脱敏（issue #38） | ✅ 已修复（凭据作为独立密文载荷随加密快照迁移；拉取侧解密 → 逐条确认 → `credentials.set` 写回） |
| G-18 | `.credentials.yaml` 的 `refs:` 块未被识别：包里带着凭据原文，导入后仍要求人工重填（issue #39） | ✅ 已修复（两处解析共用同一口径，v1 `refs:` 块与预发布扁平布局都认；误导性的「需人工重填」只在确实还缺 ref 时出现） |
| G-19 | 同步快照格式（内容寻址外置）**不做协议协商**：旧版插件读新版快照会把 `sessions` 当成缺失分区 | ⚠️ **有意不修**（契约登记，见 §3.1；要求两端同版本） |
| G-20 | 会话删除墓碑**不代本机删除**数据：对端删掉的对话只被「阻止复活」，本机副本仍在 | ⚠️ **有意不修**（删除是不可回滚的用户动作，见 §3.2） |

---

## 1. 本轮已修复的缺口（含修复位置与验证方式）

> 下列缺口在 `0.1.59` 基线中**真实存在**，当前工作区**已不再成立**。
> 「验证方式」列给出**可复现**的证据（测试用例名或命令），不是「读代码觉得对」。
>
> **G-08 是本节的特例**：它不是「被修好」，而是**该能力被产品决策整体取消**（加密不再做任何密码强度校验）。它保留在本节只为记录完整历史，**不要**读作「闸门已接通」。

### G-01 未知分区被静默丢弃

| 项 | 内容 |
|---|---|
| 基线问题 | 未知 id 的 `sections` 键进不了 `SECTION_JSON_PATHS` / `SECTION_FILE_PREFIXES`，`extractSections` 直接 `continue`；ZIP 内该分区数据从未被读取，也从未被告知（基线 `src/core/analyzer.ts:204-205`）。 |
| 修复位置 | `src/core/analyzer.ts` 的 `extractSections`（`if (!knownIds.has(sectionId)) { unsupportedSections.push(...); continue; }`）；汇总告警在 `src/core/analyzer.ts` 的 `extractSections`（消息键 `import.unsupportedSections`，文案「备份包含本版本不支持的分区: X（已跳过，未导入）」）。 |
| 验证方式 | `tests/conformance/roundtrip.test.ts` → `FC-01`（断言 `analysis.unsupportedSections` 含 `keybindings`，且告警文案为「不支持/已跳过」）；`FC-04`（语义回归）。 |
| 残留边界 | 未知分区的**数据本身仍不被保留**（格式 v1 无「原样保留未知分区」能力）。修复只解决「告知」，不解决「保留」。 |

### G-02 未知分区告警文案误导

| 项 | 内容 |
|---|---|
| 基线问题 | 未知分区落进 `missingSections`，用户看到「备份声明了但缺少的分区: keybindings」——但文件其实在 ZIP 里（基线 `src/core/analyzer.ts:275-280`）。 |
| 修复位置 | `src/core/analyzer.ts` 的 `analyzeImport`（`skippedSections` 从 `missingSections` 剔除），告警在 `src/core/analyzer.ts` 的 `analyzeImport`（`missingSections` 告警）。 |
| 验证方式 | `FC-01`（断言 `missingSections` 不含未知分区、`compatibility === 'excellent'`）；`FC-04`（未知分区与「已知分区文件缺失」互不串味）。 |

### G-03 无「不支持分区」的报告通道

| 项 | 内容 |
|---|---|
| 基线问题 | 全仓库没有 unsupported-section 的报告通道；`ImportAnalysis` 只有 `sectionsInZip`（只含已知分区）与 `warnings`/`errors`（基线 `src/core/types.ts:201-213`）。 |
| 修复位置 | `src/core/types.ts`（`ImportAnalysis.unsupportedSections: string[]`；同文件另有对称的 `unsupportedVersions`）；填充点 `src/core/analyzer.ts` 的 `analyzeImport`（`unsupportedSections` 填充点）。 |
| 验证方式 | `FC-01` / `FC-03`（`FC-03` 断言 `unsupportedVersions` 结构化暴露，且与 `unsupportedSections` 不串味）。 |

### G-04 checksums 单向

| 项 | 内容 |
|---|---|
| 基线问题 | `verifyAgainstTable` 只遍历**表里的键**，不检查「ZIP 里在、表里不在」的条目；普通导入路径对此零告警。 |
| 修复位置 | `src/core/analyzer.ts` 的 `loadBundle`（反向检查，排除 `manifest.json` / `checksums.json` 自身与目录条目），告警消息键 `import.extraEntries`（`src/core/messages.ts`）。 |
| 验证方式 | `tests/conformance/roundtrip.test.ts` → `INT-01`（断言未登记条目被点名列出、`valid=true`、`errors=[]`、Dry Run 零写入）；`CORPUS-02`（篡改数据条目不重算 checksums → 必须被拒）。 |
| 关联 | 「表缺失/为空」这一半是 G-12，**单独登记**。 |

### G-05 分区 version 无兼容余地

| 项 | 内容 |
|---|---|
| 基线问题 | 分区文档 `version` 采用精确 `=== 1` 判定（`src/schema/versions.ts` 的 `sectionDataVersionIssue`（`version === 1` 判定））；任何已知分区 JSON 的 `version != 1` 会让**整个 bundle** 无法导入，而不是跳过该分区。 |
| 修复位置 | `src/core/analyzer.ts` 的 `extractSections`（`import.unsupportedSectionVersion` 跳过该分区并收集 `unsupportedVersions`）`：只有「数字且 `> 1`」才**跳过该分区并告警**（消息键 `import.unsupportedSectionVersion）。 |
| 验证方式 | `FC-03`（`version > 1` → 跳过 + 告警 + 不阻断 + 不进 `sectionsInZip` + 不产生计划项）；同测试的后半段钉住 `version < 1` / 非数字 / 缺失仍**硬失败**。 |
| **仍未修复的不对称** | `version > 1` 跳过、`version < 1` / 非数字 / 缺失**硬失败整个 bundle**。这是**有意保留**的数据损坏语义，但对外部实现者是一个不对称契约，必须在 v2 设计时决策（规格 §3.3 已写明三档实测）。 |

### G-06 迁移链未接入导入路径

| 项 | 内容 |
|---|---|
| 基线问题 | `migrateToCurrent`（`src/migrations/index.ts`）已实现且有单测，但**导入路径从不调用它**——`analyzer.loadBundle` 只用 `isSupported` 判定后直接继续（基线 `src/core/analyzer.ts:165-168`）。一旦 `CURRENT > MIN`，旧备份会被「判定为可迁移」却**不会真的被迁移**。 |
| 修复位置 | `src/core/analyzer.ts` 的 `loadBundle`（`needsMigration` 守卫 + `runSchemaMigration`；`needsMigration` 为真时调用 `runSchemaMigration`，迁移结果重新过 `validateManifest` 才作为后续 manifest）；实现 `src/core/analyzer.ts` 的 `runSchemaMigration`。 |
| 验证方式 | `tests/conformance/roundtrip.test.ts` → `VER-03`（源码级守卫：断言 `loadBundle` **方法体内**存在 `needsMigration` 守卫且 `runSchemaMigration(` 调用**在守卫块内**、未被注释；并断言 v1 包不触发迁移、迁移告警只在真实迁移时出现）。 |
| 残留工作 | 发布 schema v2 前仍应补一条**端到端**「v1 → v2 真实迁移」测试（当前 `MIN = CURRENT = 1`，路径结构上不可达，只能靠 `VER-03` 的源码守卫 + `runSchemaMigration` 的直接单测）。 |

### G-07 `needsMigration` / `describeVersion` 的「将迁移」分支不可达

| 项 | 内容 |
|---|---|
| 问题 | `MIN_SUPPORTED_SCHEMA_VERSION = CURRENT_SCHEMA_VERSION = 1`，不存在 `1 < v < 1` 的整数，该分支当前不可达。 |
| **性质澄清** | 这**不是待修缺陷**，而是「当前版本区间」的**必然结果**。G-06 修复后接线已就绪，一旦上移 `CURRENT` 即会真实执行。 |
| 验证方式 | `tests/schema-compat.test.ts:17-18`、`:154`（测试文件自身已注明该档位不可达）；`VER-03` 的源码守卫保证接线不会悄悄断掉。 |
| 待办（随 v2） | 与 G-06 一并在发布 schema v2 前补端到端迁移测试。 |

### G-08 密码强度校验（基线形同虚设 → 一度接通 → **按产品决策整体移除**）

> **最终状态（当前工作区，也是本条的结论）**：**加密路径不做任何密码强度校验**。任何密码都可用于加密——`1`、`12345678`、`password` 一律被接受。**唯一约束是非空**：空字符串密码抛 `SecurityError('BAD_PASSWORD', '加密密码不能为空')`。
>
> **这不是缺口，也不再是「修复」**——这是产品负责人（用户）的明确决策：加密备份的密码策略由用户自己掌握，插件不施加强度约束。G-08 因此**从缺口登记中退出**，保留此条只为记录历史。

| 项 | 内容 |
|---|---|
| 基线 `0.1.59` | 强度校验函数（**该符号现已从源码移除，此处仅为历史记录**；发布版 `0.1.59` 的 `src/security/encryption.ts:165-174` 即其定义）已实现且有单测，但在 `src/index.ts` 中**零调用**——导出端只要求 `password` 是非空字符串。**形同虚设**：有一个「看起来在守、实际不跑」的强度函数。 |
| 中间态（本轮一度接通） | 三层闸门一度被接通：导出路由入口（400 拒绝 + 可操作文案，在任何文件写入之前）、`config_backup` 模型工具（结构化拒绝）、加密层兜底。当时的判定档位是「< 8 拒绝 / 8–11 且无大小写数字混合仅提示 / ≥12 通过」。 |
| **最终态（产品决策，2026-09-13）** | **上述闸门被整体移除**，而非保留或收紧。用户原话：「我需要加密备份时无需校验，无论是什么密码都可以使用。」**当前加密入口只拒绝空字符串**。 |
| 移除物（全库零残留） | 强度校验函数与断言函数（`src/security/encryption.ts`）、导出路由的密码守卫（`src/index.ts`）、导出路由的 400 弱密码拒绝块、`config_backup` 的弱密码结构化拒绝（`src/core/model-tools.ts`）、消息键 `export.passwordTooWeak`（zh + en，`src/core/messages.ts`），以及 5 个对应的测试用例。**以上符号在当前工作区均已不存在，不得再被引用。** |
| 为什么移除而非接通 | 避免留下「看起来在守、实际不跑」的死代码。若产品不要求强度闸门，正确做法是**删掉**，而不是接通它再放宽到形同虚设。 |
| 验证方式 | 加密入口只对空字符串抛 `BAD_PASSWORD`，其余任何密码均被接受；`src/security/encryption.ts` 的两个加密函数内各留有**刻意注释**（「产品决策（2026-09-13）：加密不做任何密码强度校验……请勿在此重新加入强度闸门」）。全库检索被移除符号**零命中**。 |
| 残留边界（**仍然成立，且现在覆盖整个校验面**） | **解密路径不校验**密码强度——历史备份可能用弱密码加密，任何校验都会让它们**永久打不开**。由于强度校验已整体移除，这条边界现在描述的是**整个密码处理面**的行为：加密与解密两侧都不做强度判定。 |

### G-09 文件类分区内容不扫描 secret

| 项 | 内容 |
|---|---|
| 基线问题 | `skills` / `agentPresets` / `agentInstructions` / `pluginFiles` / `sessions` / `self` 的文件内容**完全不进扫描器**，也不计入 `redactedHits`。 |
| 修复位置 | `src/core/exporter.ts:135-161`（`scanFileSectionText` 定义）、`src/core/exporter.ts`（`else` 分支调用 `scanFileSectionText`：命中计入 `redactedHits`、产出 `export.fileSectionSecrets` 告警）。消息键 `src/core/messages.ts`。 |
| 验证方式 | `tests/core/exporter.test.ts:298`（凭据文件 → 告警 + 计入 `redactedHits`，且内容**原样不改写**）、`:332`（二进制跳过；无 `scanText` 的扫描器不扫）、`src/core/model-tools.test.ts`（模型工具路径与 HTTP 路由同档扫描）。 |
| **仍然成立的边界（勿过度承诺）** | ① **只报告不改写**：命中的文件内容**不剥离**，明文仍在包里——「默认不含秘密」对文件类分区**仍不成立**，缓解手段仍是 `pluginFiles` 默认 `false` + 市场 BANNED，用户显式勾选即可带出明文；② 只走 `scanner.scanText`，core 内置 `defaultSecretScanner` 未实现该方法 → 该分支**返回空**（行为与修复前一致），生产路径注入的是含 `scanText` 的强化扫描器；③ 二进制文件（前 4 KiB 含 NUL）跳过；④ 单文件 1 MiB / 累计 16 MiB 预算超限即停止扫描（不中断导出）；⑤ `redactedHits > 0` **不再**意味着「包里没有明文」（见规格 §5.3.4 / §5.3.5 的修正说明）。 |
| 关联 | 告警去重问题曾作为独立发现登记为 G-13，**修复已落地**（见 §2）。 |

### G-10 `sections.secrets` 恒 `false` 但语义被复用

| 项 | 内容 |
|---|---|
| 问题 | `sections.secrets` 永远是 `false`（无 adapter）；加密事实由 `security.encrypted` 承载。第三方若按「`sections.secrets === true` 表示含凭据」实现，会判断错误。 |
| 收口方式（**规格侧，实现刻意未变**） | `buildSectionFlags` 里 `flags['secrets'] = false` 仍在（当前工作区 `src/core/exporter.ts`）——这不是实现缺陷，而是「键集合恒全量」的**语义设计**。规格 §2.5 已加显式警告块；§9 步骤 4 的验收判据明确「判断『含秘密/需密码』只看 `security.containsSecrets` / `security.encrypted`，不看 `sections.secrets`」。 |
| 验证方式 | 规格 §2.5 / §9 步骤 4 的判据本身（文档级修复）；`FC-*` 系列未覆盖此语义，故不声称有测试护栏。 |

### G-14 同步/备份只搬运 `pnpmWorkspace` 声明，不搬 `patches/**` 文件（issue #35）

| 项 | 内容 |
|---|---|
| 基线问题（0.1.59） | plugins 分区导出时整段读取 `profiles/<profile>/pnpm-workspace.yaml`（含 `patchedDependencies`），但 patch 文件本身不在任何被同步的分区里；全仓对 `patchedDependencies` 零解析、零校验。 |
| 后果 | 目标机拿到「声明存在、文件不存在」的组合后，**任何** `pnpm add`（含 `dsh plugin add`）都失败于 `Failed to read patch file ... (os error 2)`——实测一次「一键同步 → 确认导入」13/13 插件安装全灭，而同步仍报成功。 |
| 修复位置 | ① 导出：`src/adapters/plugins.ts` 解析 `patchedDependencies`，把 `patches/**` 作为 `plugins.patchFiles`（base64）随分区携带（源机缺文件 → 显式告警）；② 导入：`src/adapters/plugins.ts` 先落 patch 文件，再写**剔除不可满足声明**后的 `pnpm-workspace.yaml`（剔除在 `analyzeImport` 以 Warning 计划项显式可见）；③ 纯函数内核 `src/adapters/pnpm-workspace.ts`（按行改写，保留注释/CRLF，不整文件重写）；④ 供应链：`patchFiles` 非空在**发布侧与导入侧**双端拒收（与 `localTarballs` 同级）；⑤ 安装失败分类 `patch-file-missing`（`src/core/plugin-cli.ts`），给出可操作修复路径而不是 13 条「插件装不上」。 |
| 关联缺陷（同轮修复） | journal step 把 `warning`（如安装失败但非致命）记为 `skipped` 且不落 message → 事后审计误判为「用户跳过了这些插件、同步成功」。现在 `warning` → `attention`、`skipped` 只留给真正的跳过，并持久化 `message`（`src/core/analyzer.ts`、`src/core/journal.ts`）。 |
| 验证方式 | `src/adapters/pnpm-workspace.test.ts`（8 例：逐字节不变 / 只删缺失条目 / 全删连键删 / 越界路径 / flow 形态不改写 / CRLF / 无声明零改动）；`src/adapters/plugins.test.ts` → 「issue #35：patch 文件随分区迁移；目标缺失的 patchedDependencies 声明导入时剔除」；`tests/core/import-journal-status.test.ts`（四种结局的 journal 状态）；`src/market/{prepare,market}.test.ts`（双端拒收 + 路径穿越拒绝）。 |
| 规格同步 | `docs/spec/bundle-format-v1.md` §3.2 / §3.4 / §3.5 / §10（`patchFiles` 字段与「声明与文件必须同进同出」的实现者注意）。 |

### G-15 Windows 仍无 OS process identity（#36 的残余边界，**部分修复**）

| 项 | 内容 |
|---|---|
| 现状 | `canGetOsIdentity()` 仍只在 Linux 为 true（`src/utils/env-lock.ts` 的 `defaultProbe`）。Windows 上 Node 无原生 API 读**其它进程**的创建时间；实现需 spawn `Get-Process`/WMI，而锁探测在每次 acquire 上都会跑，代价不可接受。 |
| 已缓解 | 心跳**长过期**（阈值 `max(30 × staleAfterMs, 30 分钟)`，可注入 `longExpiredAfterMs`）时，把「心跳过期 + pid 存活 + 身份不可验证」判为 `STALE_LOCK_DETECTED`，使 `recover-stale-lock` 与 GUI「回收残留锁」可成功回收（issue #36 的期望行为）。 |
| 未解决 | ① 阈值内（< 30 分钟无心跳）的 PID 复用残留锁仍判 `UNKNOWN_STATE`，只能等待阈值过去；② 无法把「PID 复用」与「owner 真存活但心跳降级」精确区分——两者都靠「心跳长过期」这一代理判据，属**启发式**而非确证。 |
| 为什么不更激进 | 缩短阈值会提高「误回收活锁」的风险（活着的 owner 在 ACL/磁盘异常下可能长时间写不进心跳）。当前取值是「用户实测等 9 天」与「误删活锁」之间的折中；要真正解决需注入平台级 identity 探测（`ProcessIdentityProbe` 已是可注入接口，宿主可自行实现）。 |
| 验证方式 | `src/utils/env-lock.test.ts` 的 `§11.1-c11b`（9 天长过期 → 可识别 + 可显式回收 + acquire 仍不自动摘锁）与 `§11.1-c11c`（未达阈值仍保守 `UNKNOWN_STATE`；heartbeat 缺失不放宽；阈值可注入）。 |

### G-17 同步通道的「导出密钥」没有数据源（issue #38）

| 项 | 内容 |
|---|---|
| 基线问题 | `includeSecrets=true` 在同步通道里**没有任何数据源**：没有任何 adapter 读取 `ExportOptions.includeSecrets`（结构化分区在源头就已 `redactSecrets`，凭据分区被 `FORBIDDEN_SECTIONS` 结构性排除，`.credentials.yaml` 在 `SECTION_JSON_PATHS` / `SECTION_FILE_PREFIXES` 里没有映射）。它唯一真实生效的效果是**跳过同步载荷的第二道 SecretScanner 脱敏**。 |
| 后果 | 用户勾选「导出密钥」后推送载荷与不勾时**逐字节相同**（唯一差异是 `manifest.containsSecrets` 由 `false` 变 `true`），却以为密钥已随同步迁移到另一台机器——文案与实现不符，且勾选动作实际**降低了防护**（结构化分区里的字面量凭据原样进快照）。 |
| 修复位置 | ① 数据源：`SyncEngine.buildCredentialsPayload`（`src/sync/sync-engine.ts`）在 `includeSecrets` 时经 `ctx.fs.readFile` 读 `$DSH_HOME/.credentials.yaml` 原文，用本次调用的密码加密为**独立载荷** `SyncSnapshot.credentials`（`src/sync/transport.ts` 的 `EncryptedCredentials`；不进 `sections`，否则被 `FORBIDDEN_SECTIONS` 断言拒绝）；读不到 / 解析不出凭据 → **显式告警且不带载荷**，不静默成功。② 编解码：`src/sync/snapshot-crypto.ts` 的 `encryptCredentialsPayload` / `decryptCredentialsPayload` / `credentialsMapFromYaml`（与宿主导入路径 `tryDecryptCredentials` 同口径）；`src/sync/snapshot-json.ts` 透传（git 密文单文件 / WebDAV 通道）；`src/sync/layout.ts` 对散文件布局显式拒绝（绝不静默丢弃）。③ 拉取接线：`pull`/`preview` 解密出 `Map<ref, value>` 并生成 `MissingSecret` 计划项（`appendCredentialPlanItems`）；`applyItems` 把该 Map 作为 `executeImportPlan.decryptedCredentials`（此前硬编码 `undefined`）交给 credentials adapter → `credentials.set(ref, value)`。④ 会话：`SyncSessionStore` 仅内存保管该 Map（存值不存密码——能力更窄），apply-items 消费 / cancel / TTL 即消失。⑤ 可见性：推送预览新增「本次推送包含真实凭据值」提示（`SyncPushPreview.credentialsIncluded`）。 |
| 不变量（未放宽） | `includeSecrets ⇒ encrypt` 仍强制；凭据载荷**只**存在于加密快照；非加密快照声明 `containsSecrets=true` 仍拒绝拉取；自动同步恒 `includeSecrets=false`（无密码，遇到加密快照跳过）；密码仅内存，绝不落盘 / 落日志 / 进响应体。 |
| 验证方式 | `src/sync/sync-credentials.test.ts`（8 例：push 密文载荷 + 明文不入载荷 / v1 `refs:` 布局同口径 / 只加密不导密钥不带载荷 / 无凭据文件明确告警 / pull+preview 生成迁移项且报告不含值 / applyItems 带 Map 写回、不带则跳过 / 未加密快照携带凭据载荷被拒 / 散文件布局拒绝）；`src/client/sync/sync-push-preview.test.ts`（含凭据提示）。 |
| 已知有损点 | 只搬运 `.credentials.yaml` 的**凭据字符串值**（v1 布局的 `refs:` 块 + 预发布扁平布局的顶层键，解析口径见 G-18；与导出路径 `security/secrets.enc` 同口径）；`records` 等嵌套结构 / 非字符串值不迁移。凭据写回**不可回滚**（DSH 不回读凭据值，属既有的技术限制）。 |

### G-20 路径映射页把内部枚举当文案渲染：源路径「永远是 missing」（真机反馈，本轮修复）

| 项 | 内容 |
|---|---|
| 基线问题 | `PathMappingForm` 直接渲染 `{issue.kind}`（core 的内部枚举字面量）。core 只做**形态**判定（`judgePath`）：跨平台盘符冲突 → `platformMismatch`，**其余绝对路径一律 `missing`**（确切语义 = 「需为本机指定新位置」，**不做存在性探测**）。于是同平台导入时每一条都显示 `missing`，用户读成「源路径不存在 / 坏了」，且该文本未走 i18n（英文界面下也是中文环境之外的裸字面量）。 |
| 修复位置 | `src/client/import/PathMappingForm.tsx` 增 `PATH_ISSUE_LABEL: Record<PathIssue['kind'], 字典键>`（`missing` → 「需指定新位置」/「Set a new location」；`platformMismatch` → 「跨平台路径」/「Cross-platform path」；`homeMismatch` 目前 core 不产出，仍补键以保持穷尽）；`src/client/locales.ts` 新增 `import.paths.kind.*`（zh/en）。 |
| 验证方式 | `npm run typecheck`（`Record<PathIssue['kind'], ...>` 穷尽性由编译期保证）+ 构建后 grep `lib/client.js` 确认新文案已进产物。 |
| 未改变 | 路径映射阶段本身仍对**所有**绝对路径列一行（留空 = 跳过，合法），只是不再用误导性的 `missing` 字面量；跨机基础路径仍由 `rebaseMapping` 自动重定基（见 G-18 之后的条目）。 |

### G-19 加密备份里的凭据「有值却不进计划」+ 本机已配置就被跳过（真机反馈，本轮修复）

| 项 | 内容 |
|---|---|
| 基线问题 | 导入路径的凭据计划项只由 `credentialsStatus` 分区（`configured=true` 的 ref）反推，而 `createImportPlan` **拿不到**宿主解出的 `decryptedCredentials`。可 `includeSecrets=true` 加密的是 `.credentials.yaml` **原文**（`security/secrets.enc`），其中可能含**未被任何 settings namespace 引用**的 ref。同时凭据适配器的 ref 收集（`defaultCredentialRefs`）只认 `apiKeyEnv` / `providers[].apiKeyEnv` / secrets 引用字段，收不全。 |
| 后果 | ① 这些 ref 的值**永远不进计划** → 执行期没有对应计划项 → `credentials.set` 从不被调用，密钥「静默丢失」；UI 却在确认页写着「已随加密备份恢复 N 个凭据」（`decryptRefs` 来自 secrets.enc 的全部 ref）——**承诺大于实现**。② 中途引入的「本机已配置 → Skip」规则按**本机状态**判定，把「归档带值」的凭据也跳过了 → 用户勾了「导出密钥」导入后密钥一个都没写回（真机反馈：导入密钥没生效）。 |
| 修复位置 | ① `Analyzer.createImportPlan(zipPath, decisions, opts?)` 新增 `opts.decryptedCredentials`；计划项生成改为 `buildCredentialPlanItems`（原 `ensureMissingSecrets`）：ref 取**并集**（credentialsStatus ∪ 解密出的 ref），**值的有无优先于本机状态** —— 有值 → `MissingSecret`（`import.secretFromArchive`，执行期写回）；无值 → 本机已配置 ? `Skip`（`import.secretAlreadyConfigured`）: `MissingSecret`（`import.secretMissingDesc`）。② 宿主 `POST /plan` 接受 `decryptPassword`（与 `/analyze`、`/execute` 同源）并交给计划生成；`ImportPort.createImportPlan` 增可选 `opts`，客户端 `api.createImportPlan` / `ImportWizard.planOpts()` 传同一个仅内存密码。③ 同步侧 `appendCredentialPlanItems` 只处理有值 ref，并把先前按「无值」判成 `Skip` 的同 id 项**升级**为 `MissingSecret`，同时刷新 `plan.missingSecrets`（与 items 同源）。④ 前端：确认列表的批量按钮覆盖**全部确认项**（`sync-view.isBulkDecidable`，只排除 Error）——此前只认 Conflict，含 N 条凭据迁移项（`缺密钥`）时按钮恒灰。 |
| 不变量（未放宽） | 凭据值只在加密载荷里；只在进程内存流转，绝不进计划文本 / 响应 / 日志；`hasValue` 恒 false；无值分支**绝不覆盖**本机已有值。 |
| 验证方式 | `src/security/security.test.ts`「归档携带的凭据必须全部进计划并写回」：6 类分支（未传解密结果 → 只有被引用的 ref 进计划＝复现 / 传了 → 未经引用的 ref 也进计划且写回 / 本机已配置 + 归档有值 → 仍写回并覆盖 / 结果 `credentialsRestored=2` / 无值未配置 → 要求补录 / 无值已配置 → Skip）；`src/sync/sync-credentials.test.ts`（有值一律进计划 + 写回；无载荷快照不含 credentialsStatus 的成因说明）；`src/adapters/roundtrip.test.ts`（普通备份 + 本机已配置 → Skip）；`src/ui/import-wizard.test.ts`（计划期也带解密密码）。**修复前实测**：①②两条集成用例失败（`OTHER_PLUGIN_KEY` 缺失、本机已有值未被覆盖）。 |
| 真机证据（用户报告） | 用户机器 `$DSH_HOME/.credentials.yaml`（5 个 ref：DEEPSEEK / A6API / OPENCODE_GO / 两个同步槽位）mtime 停在导入前，且 `settings.yaml` 只引用其中 2 个（`llm-pi-ai.providers.*.apiKeyEnv`）→ 未被引用的 3 个 ref 无论怎么导入都不会被写回；导出的 `dsh-config-*.zip` 实测是 `DCA1` 容器（走解锁 → secrets.enc 全量 ref）。 |
| 校验方式的边界 | 计划期解密失败（错密码 / 密文被篡改）时 `/plan` 返回 400（与 `/analyze` 同口径），**不**静默降级为「没有凭据」。 |

### G-18 含 vault 的备份里带着凭据原文，导入后仍要求人工重填（issue #39）

| 项 | 内容 |
|---|---|
| 基线问题 | 宿主导入路径 `tryDecryptCredentials`（`src/index.ts`）与同步引擎 `credentialsMapFromYaml`（`src/sync/snapshot-crypto.ts`）解析 `.credentials.yaml` 时**只认顶层字符串项**（DSH 预发布扁平布局）。DSH v1 布局把凭据值放在顶层 `refs:` 块下（文档形状：`version: 1` / `refs:` / `records:`，见 `dsh-credentials-local` 的 `parseCredentialsDocument`），而 `refs` 是对象 → 被 `typeof v === 'string'` **整段**过滤 → 解出的 Map 为空。 |
| 后果 | `includeSecrets=true` 的加密备份里明明带着凭据原文（`security/secrets.enc` 可用导出密码解开），导入时 `/decrypt` 回传的 `refs` 恒为 `[]` → 导入向导的 `!decryptRefs.includes(s.ref)` 过滤失效（`ImportWizardView.tsx`）→ 所有 ref 进「待补录」清单；`/execute` 拿到的 `decryptedCredentials` 为空 → `result.missingSecrets` 非空。用户无从判断是「包里没有」还是「插件没认出来」。 |
| 修复位置 | ① 新增唯一解析口径 `src/security/credentials-yaml.ts` 的 `collectCredentialRefs`：顶层字符串项（扁平布局）**与**顶层 `refs:` 块下的字符串项（v1 布局）都收，`records` / `payload` 等嵌套结构忽略（会话秘密不是凭据 ref）；两处调用点（`src/index.ts`、`src/sync/snapshot-crypto.ts`）改为共用它，杜绝「同一文件格式两处口径漂移」。② 收窄 `import.vaultMissing` 的误导：`includeSecrets=true` 时导出侧**不**镜像明文 vault（`src/core/exporter.ts` 的 4b），跨机 vault 必然为空；值已由包内密文回填（plan 的 ref 全部被 `decryptedCredentials` 满足）时改用新消息 `import.vaultCredentialsFromArchive` 如实说明，确实还缺 ref 时才保留「人工重填」。 |
| 验证方式 | `src/security/credentials-yaml.test.ts`（8 例：v1 `refs:` 块 / 扁平布局 / 混排取并集且同名以 refs 为准 / 非字符串与空值丢弃 / 顶层非对象 / `refs` 块非对象 / 空 `refs`）；`tests/security/credentials-refs-import.test.ts`（2 例，走宿主真实路径 Exporter→`tryDecryptCredentials`→`executeImportPlan`：refs 块被认出 → `missingSecrets` 为空 + `credentials.set` 写回 + 不出现「需人工重填」；只覆盖部分 ref 时仍如实列出缺口）；`src/sync/sync-credentials.test.ts` 新增 v1 布局用例。**修复前实测**：两条集成用例失败（`decrypted.get('DEEPSEEK_API_KEY')` = `undefined`，`missingSecrets` = 两个 ref）。 |
| 附带改动 | `tryDecryptCredentials` 由模块私有改为具名导出（供集成测试走宿主真实路径）；新增消息 key `import.vaultCredentialsFromArchive`（zh/en 同步，`src/core/messages.ts`）。 |
| 未覆盖 | `src/adapters/workspaces.ts` 的 `applyItem` 是否会「整条覆盖丢本机键」（报告人描述）：**本轮核实后不成立** —— 真实宿主的 `DshWorkspaceFacade.writeRecord` 只 `setTitle`（必要时 `create`），从不写 `path` / `sessionIds`，本机独有键不可能被它覆盖。真正缺的是**会话归属**通道，已由本轮的 `attachSession`（见下）补齐。 |
| 真机验证（本轮 E2E） | 隔离 `DSH_HOME` + 独立 profile（`cmtest`，插件以 junction + `dsh.profile.bundles` 挂载）跑真实 DSH 实例：造两个真实会话（`session.v3.jsonl.zstd`，header `version: 3`）——① cwd 指向真实项目目录 ② cwd 为跨机路径 `D:/Ghost/proj`。**实测结果**：无映射 dry-run → `already-grouped`×2 + `ungrouped/cwd-unresolvable`×1；带映射 dry-run → `rewrite`（含 from/to 与目标工作区）；执行 → `status=ok`、`movedTo=…/--C-…-proj--/session-e2e0002`（目录已按映射后 cwd 的 projectKey 归位）、`note=restart-required`；**重启后**再跑 → 变为 `attach`，执行后 DSH 的 `storages/workspace.json` 中 `sessionIds` 出现 `session-e2e0002`（会话真正被登记）。**观察到的回退**：本轮 DSH 版本下改写后的注册表刷新（`indexHeader`）未返回成功（`typeof` 探测为 function，但整条路径最终 false，**根因未定位**），因此每个跨机改写会话需要「重启 DSH 后重跑一次归位」才能完成登记——该行为已如实体现在报告的 `note` 与 UI 文案里，未伪装成已完成。 |
| 浏览器真机验证（本轮，Agent Window 驱动真实 DSH Web） | 在隔离实例上走完整 UI 流程：导入页「会话归位」卡片 → 「检查（只读）」→ 报告（扫描 4 / 已归位 2 / 无法归位 1 / 使用中 1，并列出逐条计划）→ 「执行归位」→ ConfirmDialog → 执行 → 横幅变为**「本次已执行 2 条」**、行尾出现「已执行」→ 再点「重新检查」→ 变为**「已归位 2」**；DSH 侧 `storages/workspace.json` 的 `sessionIds` 同步出现 `session-e2e0001` / `session-e2e0002`，**左侧会话列表从 1 条 proj 变为 3 条**（恢复的会话真的显示出来了）。网络面板：`POST /api/dsh-config-manager/sessions/group` ×2 = 200；控制台除「我手动重启实例」造成的 SSE/WS 断连外**无插件报错**。 |
| 导入期位置护栏（本轮，Fix 1/2/5） | ① **前缀映射不再碰文件集合分区**（`ConfigAdapter.fileCollection` + `analyzer.applyMappingsToSections` 白名单）：`relativePath` 是身份不是配置，改写它等于把会话文件搬到 DSH 期望之外（诚实说明：真实命中形态是「映射 oldPrefix 恰好匹配 projectKey 段」或外来归档本来就错位，绝对路径前缀映射本来就匹配不到 `--…--` 开头的相对路径，所以这条是**防线**而非主因）。② **导入收尾自动归位**（新增 `ConfigAdapter.finalizeApply` + `SessionStoreFacade.readLogCwd/relocateDir`）：写完 sessions 分区后逐会话比对「目录段 == `projectKeyOf(首帧 cwd)`」，不一致就归位到推导目录（同根内、不覆盖、有锁不搬、搬后自检）；读不出 cwd（非 zstd/首帧不完整）→ 跳过并如实报告，绝不猜；归位失败记 failed（默认硬问题）。③ **缺工作区可一键补齐**（`provision` 动作 + `provisionWorkspace` 开关）：目录在本机存在但没有工作区指向它时，报告里给「添加工作区并登记 N 条」按钮，用户点了才用 DSH 官方 `workspaceRegistry.create` 建/复用工作区再 `attachSession`（**默认不自动执行**：工作区列表是用户自己的组织方式）。 |
| 相关单测/真机验证 | 单测：`src/core/analyzer-mapping.test.ts`（文件集合分区不被改写，含「不传白名单就会改写」的反证）、`src/adapters/sessions.test.ts`（收尾归位的 4 类分支）、`src/core/session-group.test.ts`（provision 的 4 类分支：默认只报告 / 显式执行 / 中途已在 GUI 建好则复用 / 目录不存在则失败）、`tests/route/sessions-group-store.test.ts`（`relocateDir` 真机文件系统：搬迁 + 拒绝越界）。**实测踩点**：会话日志**位置与 header cwd 不一致**会让 `dsh web` 直接拒绝启动（`corrupt session log … header id and cwd identify …`；同一 id 落在两个 projectKey 目录则 `duplicate JSONL session id …`），而那时插件也加载不了 —— 所以护栏**必须**在导入期或离线做，事后进不去。 |
| 真机测试发现并修掉的两个缺陷 | ① **UI 谎报**：执行成功后横幅仍写「可归位 N 条（尚未写入）」——新增执行态结论码 `SessionGroupVerdictCode`（`applied` / `ready` 分离）+ 行级「已执行」提示 + `sessionsGroup.verdict.applied` 文案（含单测）。② **半套改写会炸下次启动**：DSH 启动时硬校验「会话日志位置 == `projectKey(header.cwd)/id`」，实测只改 header 不搬目录会直接报 `corrupt session log ... header id ... and cwd identify ...`（同一 id 出现在两个 projectKey 目录则报 `duplicate JSONL session id ... in multiple project directories`，两者都让 `dsh web` 起不来）。因此改写类会话现在**必须**连目录一起归位，搬不动（conflict/locked 等）就**回滚首帧改写**并记 `note=rewrite-rolled-back`，绝不留半套（含单测）。 |
| 浏览器真机复验（本轮，Fix 5「缺工作区一键补齐」） | 在隔离实例（空注册表：storages/workspace.json = initialized:true + workspaceIds:[]）里放 3 个会话：2 条 cwd 指向本机真实目录、1 条 D:/Ghost/proj3（跨机）。Agent Window 走完整 UI：「检查（只读）」→ 扫描 4 / 使用中 1 / **缺工作区 2** / 无法归位 1，按钮**「添加工作区并登记 2 条」**；点击 → 横幅**「本次已执行 2 条」**、徽章变**「已建工作区 2」**、两行变**「已归入工作区 · 已创建工作区并登记」**、按钮消失；DSH 侧 storages/workspace.json 新增工作区（path=…cm-e2e-45\home\proj、title=proj、sessionIds=[session-e2e0001, session-e2e0002]）；再点「重新检查」→ **已归位 2** / 无法归位 1 / 使用中 1，吐司「检查完成：待处理 0 条」。 |
| 同一轮修掉的第 3 个 UI 谎报（Fix 5 后续） | **提示数字取自「计划」而不是「实况」**：点完「添加工作区并登记」后，工作区确实建了、2 条会话也确实登记了，吐司却说**「登记 0 条、搬迁 0 条」**，横幅还从 applied 退化成「缺工作区…可一键添加」——因为 sessionGroupCounts.actionable 按定义不含 provision（它本就不属于默认「执行归位」按钮）。修法：① src/ui/session-group-view.ts 新增 sessionGroupOutcome(report)（**只统计 status === 'ok' 的真实写入**：registered / moved（按 movedTo）/ rewritten / created（按 workspaceId 去重）），吐司改用它；② 新增计数 provisioned（outcome==='provision' && status==='ok'）与行类别 provisioned（语义色 ok），徽章只显示「还没补上的缺工作区」（provision - provisioned）；③ 结论码 applied 的判定提前到 provisionable 之前（建工作区 + 登记也是写入）；④ 「检查」吐司口径与卡片一致（actionable + provision - provisioned，实测**「待处理 2 条」**，旧文案是自相矛盾的「可归位 0 条」）。单测 src/ui/session-group-view.test.ts 16 例（新增 provision 执行后语义翻转 / 执行实况统计 / 零写入不虚报 3 例）。 |
| 本轮实测踩点（给后来者） | 插件**运行中**时 $DSH_HOME/storages/workspace.json **不是**权威：宿主 registry 的内存状态才是，插件 listRecords() 读的是内存 → 想复位隔离实例必须**先停宿主再改文件**（本轮第一次复位没停宿主，规划读到的还是旧记录；手改文件与内存不一致还会让 dsh web 启动报 workspace domain is inconsistent: registry order references missing workspace，修法是让 workspaceIds 与 tables.workspaces 保持一致或同时清空）。 |
| Fix 3：离线 CLI `sessions repair`（本轮落地） | DSH 起不来时插件也加载不了，在线路径全部失效，因此新增唯一可用的离线通道：`dsh-config-manager sessions repair [--home <dir>] [--fix] [--keep <dir>] [--map old=new]...`。语义：读每条会话首帧 cwd → 目录归位到 `projectKeyOf(cwd)`（与在线 planner 同一个实现，**不用映射也能修**：位置与 header 一致后 DSH 就能启动）→ `--map` 命中则先改写首帧 cwd（其余帧逐字节保留）再搬 → 默认 dry-run 零写入；目标已存在拒绝覆盖；session.lock / 缺 cwd / 多 generation cwd 不一致只报告；重复 id 只在 `--keep` 点名保留谁时把其它副本移进 `sessions/.cm-repair-quarantine-<时间戳>/`（**只搬不删**）；改写后搬不动则回滚改写，绝不留半套。实现：纯规划 `src/core/session-repair.ts`（零 IO）；读盘/改写/搬迁在 `src/cli/sessions-repair.ts`（不 import 任何 DSH 运行时）。单测：`src/core/session-repair.test.ts`（8 例）、`tests/cli/sessions-repair.test.ts`（8 例，真实临时目录：dry-run 零写入 / --fix 归位 / --map 改写+搬 / --keep 隔离 / 冲突退出 1 / 缺 sessions 目录 / --map 形状非法 / --json）。 |
| Fix 3 的顺带重构（单一来源） | 会话日志的字节级读写原本只存在于 `src/index.ts` 的 DshSessionStoreFacade 内；CLI 需要同一套语义，于是抽出 `src/utils/session-log.ts`（readLogCwdFromBytes / readLogFileCwd / rewriteSessionLogFile / rewriteSessionLogDir / PROJECT_KEY_RE / sessionLogNames），宿主适配器与 CLI 共用同一份改写序列（只换第 1 帧 + 尾部流式拷贝 + 发布前自检 + 多 generation 回滚）。回归证据：`tests/route/sessions-group-store.test.ts` 12/12 通过（真实文件系统的 moveSession / rewriteCwd / relocateDir），新增 `src/utils/session-log.test.ts`（8 例）。 |
| Fix 4：路径映射接进「会话归位」卡片（本轮落地） | 此前 UI 没有映射来源，跨机会话在界面上永远只报「无法归位」（只有 headless API 能带 mappings），卡片文案也如实写着「本面板暂未提供映射来源」。现在：① 卡片订阅 run store，自动复用导入计划里的 pathMappings（用户改过就以用户的为准）；② 报告里 reason=cwd-unresolvable / mapped-unresolvable 的会话由 `src/ui/session-group-view.ts` 的 sessionGroupPathIssues 转成可填的映射条目（按 cwd 去重、带当前映射作建议值、已有映射一并列出）；③ 复用 PathMappingForm 收集输入；④ 输入改动即标记 stale（横幅提示「请重新检查」）并禁用执行按钮 —— 保证**执行用的映射与规划用的是同一份**；⑤ 重新检查时把生效映射写进报告。i18n 新增 sessionsGroup.mapping.*（zh/en），并改掉 hint 里「本面板暂未提供映射来源」。单测：`src/ui/session-group-view.test.ts` 18 例（新增 2 例）。 |
| Fix 3 真机验证（本轮） | 隔离实例上把 `session-e2e0001` 的目录挪到错误的 projectKey 段 → `dsh web` **直接拒绝启动**（实测报 `corrupt session log … header id … and cwd identify …`，并指出该日志「应该」在哪个项目目录下）→ `dsh-config-manager sessions repair --home <home>` 先给出零写入计划（扫描 4 / 位置正确 3 / 待搬家 1，exit 0）→ `--fix` 搬回 → 再启动 DSH 成功（打印 token，exit 0）。另用 `--map <本机 proj 目录>=D:/Ghost/proj3 --fix` 反向把 5 个会话一次性改写+搬回跨机状态（5/5 成功、无失败；每条都只换第 1 帧），随后 DSH 仍正常启动 —— 证明「只换首帧 + 连目录一起归位」这条不变量在真实 DSH 上成立。 |
| 同一轮真机发现并修掉的第 5 处谎报（Fix 4 后续） | 执行确认弹窗写着「不修改任何会话日志内容」，但带映射执行时**确实会改写首帧**：真机测试里弹窗这么写、执行后 5 个会话的首帧 cwd 被改写、目录也被搬走。修法：新增 `sessionsGroup.confirm.messageRewrite` 与 `sessionsGroup.action.executeTitleRewrite`（zh/en），判定提成纯函数 `src/ui/session-group-view.ts` 的 sessionGroupRewritesPlanned(report)（计划里存在 rewrite 即视为会改写），卡片按它二选一。真机复验：改写计划 → 弹窗「…其中跨机会话会先只替换会话日志第 1 帧 header 的 cwd（其余帧逐字节保留）…」；重启 DSH 后变成纯登记计划 → 弹窗回到「不修改任何会话日志内容」。单测：`src/ui/session-group-view.test.ts` 19 例（新增 1 例）。 |
| 「重启 DSH 后再跑一次归位」这条 workaround 的真机闭环（本轮） | 跨机改写在真机上仍拿不到注册表索引刷新（`note=restart-required`，根因未定位）；本轮把这条 workaround 走完：改写+归位 5 条 → 停 DSH 重启 → 重新「检查」→ 5 条全部变成「登记」（不再需要改写）→「执行归位」→ `storages/workspace.json` 的 `sessionIds` 真的出现这 5 个会话（含此前缺席的 `session-e2e0003`）。即 note 里的指引是可执行的，不是托词。 |
| 会话恢复流程重构（本轮，用户拍板）：**彻底移除「会话归位」**，改为「导出连带工作区 + 导入期一条映射改两处」 | 用户不喜欢独立的归位面板；新流程把归属关系交给导出/导入这对动作本身：① **导出耦合**：只要导出含 sessions 分区，`exporter.coupleSessionWorkspaces` 就把拥有这些会话的工作区记录（含 `sessionIds`）一并纳入 `workspaces`，并在报告里给一行 `export.sessionsWorkspacesCoupled`（条目级选择按 sessionIds 精确匹配；只给 `sessions.limit` 时按「凡声明了 sessionIds 的工作区都带上」宽进）。② **导入期一条映射改两处**：`SessionsAdapter.finalizeApply` 用 `ctx.pathMappings` 命中后先 `rewriteLogDir` 只换首帧、再 `relocateDir` 归位到 `projectKeyOf(映射后 cwd)`、搬不动就回滚首帧（回滚失败按硬失败上报）；未命中退回原有位置护栏。③ **登记挪到收尾之后**：`ConfigAdapter.finalizeImport`（新增钩子，APPLY_ORDER 全部跑完再执行）让 `WorkspacesAdapter` 用 DSH `attachSession` 逐个登记 `sessionIds` —— 旧实现在 `applyItem` 里登记时会话文件还没写完/首帧还没改写，必然失败（正是「数据恢复了却显示不出来」的旧症结）。④ **移除物**：`core/session-group.ts`、`core/session-relocate.ts`（拆出 `core/path-mapping.ts`）、`ui/session-group-view.ts`、`client/sessions/`、`POST /sessions/group` 路由与 `groupSessions` 导出、宿主门面 `listStored/liveSessionIds/moveSession/rewriteCwd` 与 `StoredSessionInfo`、会话归位的界面文案（zh/en 共 208 行）、三处卡片样式。⑤ **保留**：离线 CLI `sessions repair`（DSH 起不来时唯一通道）、`utils/session-log.ts` 字节改写、导入期位置护栏、`reindexSessionHeader` 尽力刷新。单测：`src/core/export-coupling.test.ts`（3：精确连带 / limit 宽进 / 不导会话不连带）、`src/core/finalize-order.test.ts`（1：finalizeImport 必须在所有 finalizeApply 之后）、`src/adapters/sessions.test.ts`（+3：改写+归位 / 搬不动回滚 / 无改写能力只报告）、`src/adapters/workspaces.test.ts`（3 改为 finalizeImport 语义）。 |
| 导出耦合加固（本轮，真机事故复盘）：**绝不产出「有会话、没工作区」的包** | 事故现场：用户在运行中的 DSH 实例里导出「历史会话」（未勾工作区），得到的包 `sections.sessions=true` / `sections.workspaces=false`，目标机导入后会话在工作区列表里看不见，被理解成「对话丢了」。取证：① 该包 manifest 写着 `exporter.version=0.1.63`，但导出那一刻的运行进程**早于**耦合逻辑那次构建（宿主半只在 DSH 启动时加载，构建产物换了进程没重启）；② 本机 7 条工作区记录**全部**声明了 `sessionIds`，只要耦合生效就一定会被带上；③ 对运行中的 3080 实例直接 `POST /api/dsh-config-manager/export`（`only:['sessions']`、`sessions:{limit:1}`）实测返回 `sections.workspaces=true` + 「已连带导出 7 条与会话相关的工作区记录」+ `report.included` 含 workspaces —— 证明**当前构建**的耦合是好的，问题只出在未重启的旧进程。加固：① `exporter.coupleSessionWorkspaces` 改为回报 `{ ids, total, matched, unreadable }`：匹配不到归属时**整分区带上全部工作区记录**（多带纯元数据无害，漏带 = 用户以为丢数据）；② 分区选定的第二道 `includeItems` 过滤改用**连带后的**白名单（`src/core/exporter.ts`）——此前用户「把工作区全部取消勾选」下发的 `includeItems.workspaces = []` 会把刚被强制选中的分区再挡掉；③ 四种结果各有一条报告文案（`export.sessionsWorkspacesCoupled` / `sessionsWorkspacesCarriedAll` / `sessionsWithoutWorkspaces` / `sessionsWorkspacesUnreadable`），绝不静默；④ 导入侧 `analyzer.analyzeBundle` 在「有 sessions 分区、无 workspaces 分区」时给出 `import.sessionsWithoutWorkspaces`（分析阶段即可见，历史包会被自动指出来）。单测：`src/core/export-coupling.test.ts`（+4：整分区带上 / 本机无记录告警 / 空工作区白名单不得挡掉连带 / 注册表不可读时导出照常+告警）、`src/core/import-sessions-visibility.test.ts`（+2：有会话无工作区必告警、有工作区不误报）。**残余**：运行中的 DSH 实例必须重启才会加载新构建（宿主半无热重载），这正是本次事故的直接原因。 |
| 选择器层会话↔工作区联动（本轮，用户要求） | 规则：**勾了会话 → 自动勾上拥有它的工作区；取消工作区 → 它的会话一起取消**（导出页与导入向导同规则，因为共用 `ContentPicker`）。实现：`SelectionUnit.sessionIds`（`WorkspacesAdapter.listUnits` 给导出清单、`analyzeImport` 给计划项带上；新增 `PlanItem.sessionIds`）→ `src/ui/selection-model.ts` 的 `applySessionWorkspaceCoupling(sel, nodes, focus)`；`ContentPicker` 用一个 `commit()` 出口统一调用，`focus` 由本次动作所在分区决定（`sessions` / `workspaces` / `both`）—— 两条规则在「会话勾着、工作区被取消」时会互相抵消，必须按方向定夺；配对只认 sessionIds，不按路径（跨机路径不可靠）。另加提示文案 `picker.sessionWorkspaceLinked`（仅当会话与工作区单元同时存在时显示）。单测：`src/ui/selection-model.test.ts` 新增 4 例。**真机 GUI 复验**（隔离实例，导入后 7 条会话 + 1 个工作区）：起态 工作区 1/1、历史会话 7/7 → 取消工作区 → **工作区 0/1、历史会话 6/7（部分）**（只撤销了该工作区自己的会话）→ 重新勾上会话分区 → **历史会话 7/7、工作区自动回到 1/1**；提示行同时可见。导入侧数据面已实测：`/plan` 返回的工作区项带 `sessionIds`（6 条）、会话项 `unitId` 为 `sessions:<projectKey>/<sessionId>`，与导出侧同命名空间。
**真机补漏（本轮，用户复验「链式选择还是不动」）**：三处缺陷，均在真机复现并修掉 —— ① **清单未读 = 联动空转**：导出页单元清单逐分区惰性拉取，用户先取消「工作区」再勾一个对话时，
`sessionIds` 的数据源（工作区单元）根本不在选择器里，联动只能 no-op（真机复现：勾一条对话 → workspaces 分区 none、0/7 工作区被勾）。修法：`couplingInventorySections`（勾了 sessions 必须连 `workspaces` 清单一起读）
+ `ExportView` 清单到货后补一次联动（方向固定 `sessions`，`sameSelection` 幂等防自激）。② **id 形态失配**：本机 806 个会话目录里 **158 个是 `session-<uuid>`、648 个是裸 `<uuid>`**，而注册表 `sessionIds` 一律是全量 `session-<uuid>`；
会话单元末段是**目录名**，直接比较对不上（新增零依赖 `sessionIdKey` 归一化，core 与 UI 共用；`projectKeyOf` 同时下移到零依赖 `core/session-select.ts`，`session-meta.ts` 继续 re-export）。③ **判据不足**：`sessionIds` 覆盖率极低（真机实测一次可选择 **570 条会话里只有 23 条**在内），
而 DSH 自己按「会话 cwd 的目录键 == 工作区 path 的目录键」把会话显示在工作区下。修法：新增第二判据 `projectKey`（宿主 `listUnits` / `analyzeImport` 直出；旧宿主未回传时客户端用单元 `detail`=绝对路径现算），core 连带匹配同口径（`exporter.coupleSessionWorkspaces`）。
**真机数据复验（现行运行的宿主，未重启）**：`/export-preview` 实测 payload 不带 `projectKey`，客户端由 `detail` 现算后 **570/570** 会话都能认到工作区（此前 23/570）；勾一条新形态（裸 uuid）会话 → workspaces 分区 partial、**恰好 1/7** 工作区被勾上；
反向取消该工作区 → 这条会话被取消、其它目录的会话不动。单测：`src/ui/selection-model.test.ts`（+4）、`src/core/export-coupling.test.ts`（+2）。**残余**：导出页**刷新页面**即可生效（客户端半）；导入页链式选择依赖宿主回传 `PlanItem.projectKey`，需**重启 DSH**（宿主半无热重载）。 |
| 跨机基础路径自动重定基（本轮，用户补充） | 问题：DSH 基础路径（`$DSH_HOME`）在不同设备上可能不同（如 `/opt/dsh/.dsh` vs Windows 盘符形态），而备份里的路径是绝对路径 —— 目标机即使把目录建出来，路径语义依旧是源机的，会话/工作区仍然对不上。做法：① 导出时把本机 home 写进 `manifest.sourceHome`（可选字段；旧包无此字段 → 行为与改造前逐字一致）；② 导入时 `analyzer.rebaseMapping(sourceHome, 本机home)` 生成一条 `{oldPrefix, newPrefix, appliesTo: []}`，**插到用户映射之前**并入 `plan.pathMappings`（`createImportPlan` 与 `executeImportPlan` 都读它 → 结构化分区路径叶值 + 会话首帧 cwd + 目录归位一起生效），计划里用 `ImportPlan.automaticMappings` 如实暴露；③ 安全边界：只处理**绝对路径**、前缀必须落在**段边界**（`applyPrefixMappings` 语义，`/opt/.dsh` 不会误伤 `/opt/.dsh-extra`），相对路径 / 两边相同 / 缺字段一律不猜；用户映射排在后面可覆盖。单测：`src/core/base-path-rebase.test.ts`（3 例：规则生成边界 + 不同 home 时规则排在用户映射之前并写进 `automaticMappings` + 相同 home 时零自动改写）。**UI 展示（本轮补齐）**：`src/ui/import-wizard.ts` 的 `importBasePathNotices(plan)` 从 `plan.automaticMappings` 取出规则 → 导入向导「内容选择」阶段渲染一条信息 Banner（`import.preview.rebase`，zh/en），文案为「已自动重定基：源机基础路径 → 本机基础路径」；单测覆盖 `importBasePathNotices`。**未验证**：向导的备份选择是原生系统文件对话框，浏览器自动化无法驱动，故未做像素级真机复验（`npm run typecheck` / `npm test` 通过 / `npm run build` + 产物 grep 已过）。 |
| 后续已补（本轮） | 报告人列的 API 三项已落地（同一 issue 的 Feature 1–3，语义见 `docs/spec/headless-consumption.md` §4.5）：① `/export` / `ExportOptions.sessions: { limit }` —— 0 = 不带 / 负数 = 全带 / 正数 = 最新 N 个；单位 = 会话目录（同一会话的新旧日志一起走），文件名判据 `^session(\.[A-Za-z0-9]+)*\.jsonl(\.zstd)?$` 不写死（`session.lock` 不算会话），排序用会话日志的最新 mtime（`FileSystemFacade.mtimeMs`；未实现则退回全量 + 告警，绝不把未知当最旧）；核心 `src/core/session-select.ts` + `SessionsAdapter.restrictUnits` + `Exporter` 的显式选中。② `/analyze` 可选 `decryptPassword` → `ImportAnalysis.credentials: { inArchive, refs, satisfied }`（只回传 ref 名，永不回传值）。③ `/execute` → `ImportResult.credentialsRestored`（从加密归档内解出并回填的条数，只增不改）。**本轮已落地 P1+P2**：`POST /api/dsh-config-manager/sessions/group`（缺省 dry-run）+ 引擎 `groupSessions`（`src/core/session-group.ts` 编排 + `src/core/session-relocate.ts` 纯规划）：按 header cwd 的 realpath 认到本机工作区 → 走 DSH registry 的 `attachSession` 原子登记（插件**不**直写 `workspace.json`：那是内存权威域，直写会被后续 workspace 写覆盖）→ 在同一会话根内把目录归位到 `projectKeyOf(cwd)`（目标已存在不覆盖 / 目录内有 `session.lock` 不搬 / 搬后自检失败回滚）；活跃会话跳过，读不到活跃列表则只报告不落盘。**P3 已落地（本轮）**：跨机 cwd 变化（源机路径在本机 realpath 不解析）的会话，在调用方提供导入时用过的 `mappings` 时按四档判定 —— 映射目标不解析 / 目标机无对应工作区 / 宿主无改写能力 → 只报告 `rewrite-required`；三者齐备 → `rewrite`（**只替换会话日志第 1 帧 header**、其余帧逐字节保留、同 id 的全部 generation 一起改、失败回滚、发布前自检；随后刷新注册表索引 → 登记进工作区 → 目录归位）。宿主无法刷新注册表索引时如实给出 `note: restart-required`（重启 DSH 后重跑一次归位即走 P2 路径完成登记）。**唯一越界点**：依赖 DSH `WorkspaceRegistry.indexHeader`（d.ts 标 private，已能力探测，不整体重建索引）；该实现全部隔离在宿主适配器内、可整体删除。判定与规划口径（含 `report.actions[]` 形状与写入边界）见 `docs/spec/headless-consumption.md` §4.6。 |

| 会话导入后仍看不见（本轮真机，issue #45 ③） | 真机复现（隔离 home + 真实 DSH 实例）：用户导出 3 次对话 + 7 条工作区记录，导入后**这 3 次对话在工作区里全都看不见**，报告反倒刷出 7 行「0 个会话已登记，126/5/7/6/1/9/2 个未能登记（cwd 在本机不存在或未映射）」。取证两条根因：① **包不自洽** —— 注册表 `sessionIds` 覆盖率极低（真机实测 570 条会话里只有 23 条），用户勾选的这 3 个 id **根本不在**任何工作区记录里，而记录里那 156 个 id 又**一个都没被导出**（sessions 分区只有 3 个文件）→ 导入侧只按记录的 `sessionIds` 登记 = 「该登记的没登记、不该登记的 156 个全失败」，且失败文案把原因猜成「cwd 未映射」，用户照它改映射永远无效。② **id 形态失配** —— DSH 只认会话日志首帧 header 里的 `id`，而它 `session-<uuid>` / 裸 `<uuid>` 两种形态并存（实测目录名与 header id 逐字相同）；照目录名推成 `session-<uuid>` 后 `attachSession` 被 `session persistence holds no such session` 拒掉。修复位置：① 导出侧新增 `declareBundledSessionsInWorkspaces`（`src/core/session-select.ts`）：按 cwd 目录键把**本次真正带走的会话**声明进所属工作区记录（按裸键去重、只增不减、写日志侧原名），报告新增 `export.sessionsDeclaredInWorkspaces` 行（`src/core/exporter.ts`）；② 导入侧 `WorkspacesAdapter.finalizeImport`（`src/adapters/workspaces.ts`）登记目标 = 记录声明的 ∪ 包内带数据的，失败**按「这次有没有带它的数据」分类**（带数据的失败 = warning + 真实原因；包外会话 = 不计失败的信息行 `adapter.workspaceSessionsOutsideBundle`），并对每个会话先试声明形态、再试另一种命名形态。 |
| 会话导入后仍看不见：复核路径与单测 | 复核：`outputs/e2e-45b/run.ps1` 在隔离实例（`DSH_HOME=D:\dsh-cm-home`，profile `cmtest`，插件 junction 到本仓库）真导入该包，直接看 `storages/workspace.json` 的 `sessionIds` 与 `/execute` 返回的逐项结果。单测：`src/adapters/workspaces.test.ts`（包内未声明会话也登记 / 声明与 header 形态不同时自动兜底 / 带数据失败报真实原因 / 包外会话不计失败）、`src/core/session-select.test.ts`（bundledSessionDirs 两种形态原名 + 不可信输入 + 按裸键去重）、`src/core/export-coupling.test.ts`（从产物 zip 读回 `workspaces/workspaces.json` 断言声明结果）。 |

### P-1 peerDependencies 体积：headless 消费者为浏览器半付费

| 项 | 内容 |
|---|---|
| 基线问题 | `react` / `react-dom` 在 `peerDependencies`（16 个 peer 中的 2 个），且 **`peerDependenciesMeta` 字段完全不存在** → headless 消费者 `npm i` 时被自动安装约 4.7 MB，而 host 半（`lib/index.js`）完全不引用 react。 |
| 修复位置 | `package.json` 新增 `peerDependenciesMeta`，16 个 peer **全部** `optional: true`（`package.json:108-157`）；`lucide-react` / `@radix-ui/react-dialog` 已在 `devDependencies`（经 `tsdown.config.ts` 的 `deps.alwaysBundle` 内联进 `lib/client.js`）。 |
| 验证方式 | **隔离安装实测**：`npm pack` → 空目录 `npm install <tarball>`（**不加任何 flag**）→ `node_modules` 顶层仅 `argparse` / `dsh-config-manager` / `js-yaml`，**无** `@deepseek-ai/*`、`react`、`react-dom`、`lucide-react`、`@radix-ui/*`。**回归护栏**：`tests/packaging-contract.test.ts`（`P-1` 两条断言：peer ↔ meta 一一对应且 `optional === true`；`dependencies` 仅含 `js-yaml`）。 |
| 未验证边界 | 其他包管理器（pnpm / yarn）对 `peerDependenciesMeta.optional` 的处理**未实测**；本结论只覆盖 npm。 |

### P-2 `lib/**/*.map` 随包发布

| 项 | 内容 |
|---|---|
| 基线问题 | `package.json` 的 `files` 会带上 `lib/client.js.map`（1.81 MB）与 host 侧 `.map`，每个消费者为体积付费。 |
| 修复位置 | `package.json` 的 `files` 含排除项 `!lib/**/*.map`（且排在 `lib` 之后，否则 npm 的 `files` 求值顺序会让排除失效）。 |
| 验证方式 | `npm pack` 产物文件清单中不含 `*.map`；**回归护栏**：`tests/packaging-contract.test.ts`（`P-2` 两条断言：`files` 含 `!lib/**/*.map` 且顺序正确；`files` 仍含 `lib` / `src` / `cordis.patch.yml`）。 |
| 附带说明 | `src/` 仍随包发布（约 3.9 MB）。这是**有意的可审计性取舍**，未改；如未来要减小体积需单独决策。 |

---

## 2. 本轮审计新发现的缺陷（**均已修复并收口验收**）

> 这两条**不在** `0.1.59` 基线的登记范围内，是本轮审计发现的**收窄残留**——即「修 A 时留下的 A 的边缘」。
> **收口状态**：修复已落地，且已由独立验收确认（回归测试可复现、变异验证证明测试有牙）。

### G-12 G-04 的收窄残留：checksums 表缺失/为空时「未登记条目」漏报

| 项 | 内容 |
|---|---|
| 问题 | 反向完整性检查（「ZIP 里在、校验表里不在」的条目）原本整段嵌在「表存在」分支内：剥掉 `integrity/checksums.json` 或把它置为 `{}` ⇒ 一个条目都不校验、也零告警，却 `valid=true`。 |
| 工作区现状 | `src/core/analyzer.ts` 的 `loadBundle`（表缺失/为空 → `import.checksumsMissing`）：`table` 为 `null`（表缺失）**或**键数为 0（表为空）时，统一产出 `import.checksumsMissing` 告警（文案「备份未提供完整性校验表，全部条目未被校验」）。此时反向检查（同一 `loadBundle`）不再运行——无表可对照。 |
| 回归测试（已存在于工作区） | `tests/conformance/roundtrip.test.ts` → `INT-02`（表缺失）、`INT-03`（表为空）、`INT-04`（非空表语义不变，防误报回归）。 |
| 收口状态 | ✅ 已修复并验收。变异验证：去掉新告警 → `INT-02`/`INT-03` 红灯；还原后逐字节一致。 |

### G-13 G-09 的告警去重

| 项 | 内容 |
|---|---|
| 问题 | 文件类分区的 secret 命中告警原本按 **hit** 计数且不去重：同一行同时命中「字段名」与「值形状」会产出两条**同路径**告警，少数文件就吃满 `MAX_FILE_SECTION_WARNINGS_PER_SECTION` 上限，导致含真实明文凭据的其它文件被静默淹没。 |
| 工作区现状 | `src/core/exporter.ts`：先按**文件路径**去重，再截断到 `MAX_FILE_SECTION_WARNINGS_PER_SECTION`（语义 = 不同**文件**数），并对被截断的文件数补一条**汇总告警**（截断不得静默）。`redactedHits` 仍计**全量命中**（报告统计通道 ≠ 告警通道）。常量与语义注释见 `:107-108`。 |
| 回归测试（已存在于工作区） | `tests/core/exporter.test.ts:381`（按文件去重 + 真有凭据的文件不被淹没）、`:436`（同一文件多形态命中只一条告警）、`:456`（超上限按文件截断 + 汇总告警）。 |
| 收口状态 | ✅ 已修复并验收。变异验证：回退为逐 hit 告警 → 3 个用例红灯（含「含真实凭据的文件必须被告警」）；去掉汇总告警 → 1 个红灯；还原后逐字节一致。 |

---

## 2b. 审计发现、且**由本轮修复自身引入**的两条（已修复）

> 这两条是**修 bug 的过程造出来的 bug**，单独登记。它们的价值不在于「又多修了两个」，而在于说明**为什么修复必须配独立对抗性审计**：两次都是「新写的防线看起来在守，实际没守住」。

### B1 新增告警把包内可控字符串送进未经 `redact()` 的 UI 通道

| 项 | 内容 |
|---|---|
| 问题 | `ImportWizardView` 渲染 `analysis.warnings` 时**没有**过 `redact()`（同一文件渲染日志行时**是**过的）。而本轮新增的三条告警文案恰好插值**包内/攻击者可控字符串**：ZIP 条目名（`import.extraEntries`）、`manifest.sections` 的键（`import.unsupportedSections` / `import.unsupportedSectionVersion`）。实测条目名 `rogue/sk-A1b2C3d4…txt` 会被**原样显示**。 |
| 为什么是本轮新引入 | 修复前 `analysis.warnings` 的内容全是**固定枚举**（分区 id、已知常量），没有可控输入，因此该渲染点从不需要 redact。**是修复本身创造了这个暴露面。** |
| 修复 | `src/client/import/ImportWizardView.tsx` 渲染点改为 `{redact(w)}`（与同文件日志行同档）。 |
| 回归测试 | `tests/client/import-wizard-redaction.test.ts`（源码守卫：定位 `analysis.warnings.map` 回调体，断言必须调用 `redact(`）。变异验证：改回 `{w}` → 红灯。 |

### B2 VER-03 源码守卫恒绿：只测「符号存在」，不测「接线」

| 项 | 内容 |
|---|---|
| 问题 | G-06 的守卫只 grep `src/core/*.ts` 中是否存在 `migrateToCurrent` 符号。而该符号的**唯一代码行在 `runSchemaMigration` 函数体内**（恒存在）——**把 `loadBundle` 的 `needsMigration` 接线删掉，守卫照样全绿**。这是「只测了实现所做的事」的循环论证：断言的是「文件里有这个符号」，而缺陷是「这个符号在导入路径上从未被调用」。 |
| 修复 | 守卫改为按花括号配平**解析 `loadBundle` 方法体边界**，断言方法体内存在 `needsMigration` 守卫，且 `runSchemaMigration(` 调用点**落在该守卫的受控块内**。 |
| 验证 | 独立复跑审计当初判定恒绿的突变（`if (needsMigration(...))` → `if (false)`）→ 守卫**红灯**，报「loadBundle 方法体内必须存在 needsMigration 守卫」；还原后逐字节一致。 |
| 已知代价 | 守卫是源码级：若将来有人改成等价间接形式（`const g = needsMigration(...); if (g) {...}`）会**误报红灯**（偏严，需人工判断）。`CURRENT > MIN` 真正发生时，建议补一条端到端迁移测试。 |

---

## 2c. 审计发现的其余缺陷（已修复）

| 编号 | 问题 | 修复 | 验证 |
|---|---|---|---|
| **M1** | `config_backup` 构造 `Exporter` 时未传 `scanner` → 落回无 `scanText` 的默认扫描器 → 文件类分区扫描**静默失效**（HTTP 导出会报、Agent 工具不报） | `ModelToolsDeps` 新增可选 `scanner`，注入与 HTTP 路由同一个实例 | 行为测试（注入时告警 / 未注入零告警）+ 源码守卫；变异验证红灯 |
| **M1b** | **定时自动备份**（第三条导出路径）同样未传 `scanner`，且它是**无人值守**的——用户更不可能自己发现 | `BackupSchedulerOptions` 新增可选 `scanner`；`src/index.ts` 把 `createConfiguredSecretScanner(...)` 提为**单一实例**并注入三处 | 三处同一标识符（独立复核：`createConfiguredSecretScanner` 仅 1 处调用、3 处 `scanner: secretScanner`）；变异验证红灯 |
| **L1** | P-1/P-2 无自动化回归护栏（回归时不会报警） | 新增 `tests/packaging-contract.test.ts`（5 个断言：peer 全 optional、`dependencies` 仅 `js-yaml`、`files` 含 map 排除且顺序正确、`./schema` 指向运行时入口） | 6 种变异逐个红灯后还原（SHA-256 一致） |
| **L2** | `exports["./schema"]` 指向纯类型产物 `types.js` → 第三方 `import` 得到**空对象**；且 `CURRENT_SCHEMA_VERSION` 等版本工具**包外无法导入** | 新增 `src/schema/index.ts`（零 DSH / 零 `node:` 依赖）导出运行时值 + 类型：版本判定 9 + 分区表 4 + 分区注册表 11 = **24 个运行时导出**；`exports["./schema"]` 改指它（修复时该出口只有 13 个，后来分区注册表并入该出口才成 24 个） | 隔离默认安装后 `import('dsh-config-manager/schema')` 返回 **24 个运行时导出**（修复前 `{}`）；`SECTION_IDS.length === 15`。**回归测试位置**：`tests/packaging-contract.test.ts`（断言 `exports["./schema"]` 指向 `lib/schema/index.{js,d.ts}`，而非纯类型产物 `types.js`）+ `src/schema/registry.test.ts`（注册表零 node 依赖 / 分区集合一致） |
| **L3** | `env-lock` 的 heartbeat 走 `atomicWriteFile`（同目录 tmp 写 → rename）；`release()` 不等在途写 ⇒ `.dshcm.*.tmp` 残留在 locks 目录 → after-hook `rmSync` **ENOTEMPTY**（Windows 偶发） | heartbeat 写**串行化** + `release()` 前 `drainHeartbeat()`（顺带修掉 interval 写之间的并发 rename 竞态） | 连续 10 次单文件全绿；变异（移除 drain）→ 红灯。**拒绝用 `maxRetries` 掩盖**——那会留下真实缺陷 |
| **L4** | `run-store` 测试用固定 `sleep` 等轮询收敛，全量套件并发时定时器被拖慢 → 偶发 `actual: 'importing', expected: 'result'` | 改为 `waitFor(predicate, timeout)` 条件等待（**不削弱断言语义**，超时仍抛错） | 连续 10 次全绿；变异（破坏收敛）→ `waitFor` 超时抛错 |

---

## 3. 仍未修复的缺口

### G-11 条目名侧不拒绝中段反斜杠（与 checksums 侧不一致）

| 项 | 内容 |
|---|---|
| 问题 | `isPathSafe`（`src/utils/paths.ts:45-54`）只拒绝「以 `/` 或 `\` 开头」与「含 `..` 段」的名字，**中段 `\` 被接受**：`isPathSafe('custom/skills/back\\slash.md') === true`；写侧 `zipToBuffer`（`src/utils/zip.ts` 的 `zipToBuffer`（条目名 `isPathSafe` 闸））与读侧 `parseZip`（`src/utils/zip.ts` 的条目名 `isPathSafe` 闸）也接受。 |
| 后果 | ① **跨平台路径语义不一致**：同一份 bundle 在 Windows 目标上把 `\` 当分隔符（`skills/probe/back/slash.md`），在 POSIX 目标上当普通字符（`skills/probe/back\slash.md`）；② 与 `checksums.json` 的键侧规则**不对齐**——后者明确拒绝含 `\` 的路径（`src/security/integrity.ts:63`）。 |
| 可利用性 | **有限**：`\` 不是 `..`，无法越出 baseDir 之外，且 L3 的 `isReservedInternalRel` 会在折叠后拦截保留命名空间。但它是**真实的行为不一致**，且会让跨平台幂等比对出错。 |
| 验证方式 | 规格 §3.3.2 实测 C10（12 例条目名注入）。 |
| 建议动作 | 在写侧与读侧统一拒绝中段 `\`（比现状更严格），并同步 `checksums` 侧规则；这属**格式行为变更**，需与版本策略一起决策。 |

### G-19 同步快照格式不做协议协商（内容寻址外置的跨版本后果）

| 项 | 内容 |
|---|---|
| 背景 | P1-4 起，`sessions` 分区在同步通道上以**内容寻址引用**形态存放（`blobs/<sha256>` + `<section>.blobs.json` / `blobRefs`），格式见 `docs/spec/sync-channel-v1.md`。 |
| 后果 | **旧版插件**读新版快照：git 通道因 `missingFileDir='empty'` 把该分区降级为**空分区**（丢会话内容但不崩），WebDAV 通道同样得到空分区；反向（新版读旧版）无问题 —— 旧快照没有引用形态，按内联文件读即可。 |
| 为什么有意不修 | 同步通道从设计起就不做协议协商（也没有版本握手字段）；引入协商要改远端格式 + 两端状态机，收益仅是「跨版本混用」这一非目标场景。 |
| 缓解 | 两端插件版本应一致（与「本插件是 bundle 包、升级需重启 DSH」同一条运维约束）。 |
| 验证方式 | `src/sync/blob-store.test.ts` 的 layout 集成用例（散文件布局只写引用文件）+ `src/sync/webdav/webdav-transport.test.ts`（旧格式快照仍按内联文件读回）。 |

### G-20 会话删除墓碑不代本机删除（只阻止复活）

| 项 | 内容 |
|---|---|
| 背景 | P1-5 的墓碑（`manifest.deletedSessions`）解决的是「旧快照把已删除的对话带回来」（见 `docs/spec/sync-channel-v1.md` §4）。 |
| 未做的部分 | 对端删除的会话**不会**在本机被删掉：本机那份副本仍然存在，界面也不会出现「删除」计划项。 |
| 为什么有意不修 | 删除会话是**不可回滚**的破坏性动作（DSH 无回收站、快照回滚不覆盖会话字节）。把它做成同步的自动副作用，会在「对端误删 / 对端只是没勾选」时静默毁掉本机数据。当前实现把它降级为**信息**（墓碑在拉取报告里可见），把删除留给用户显式动作。 |
| 若将来要做 | 需要：① 适配器侧的会话删除能力（宿主 `sessionPersistence` 支持 + 审计）；② 新的计划项种类 + 逐项确认 UI（不得并入自动应用）；③ 与「导入前强制快照」的可回滚语义对齐（会话字节当前不可回滚）。 |

---

## 4. 不是缺口、但已知的有损点

来自 `tests/conformance/README.md` §3.2 与规格 §7.3：

- **`prompts` 的 `systemPrompt` 形态**：源 namespace / patch 行里是字符串 `systemPrompt: "…"`，导入落盘形态为对象 `{ persona: "…" }`。persona **文本**无损，但字段**形状**改变（`RT-01` 已注明）。
- **已知分区内的未知字段不写回目标（分区相关，勿一句话概括）**：导入不是 round-trip 复制，而是把已知语义落到目标。规格 §7.3 实测结论是**分区相关**的：`settings` / `ui` / `mcp` / `prompts` / `credentialsStatus` → 未知字段不写回；`workspaces[]` 记录、`plugins.patch[].raw`、`providers.raw` → 会随「整体搬运」落到目标。因此**不要声称「未知字段会被保留到目标」，也不要声称「一律被丢弃」**。
- **文件类分区的 secret 命中不剥离内容**：G-09 修复后只「报告 + 告警」，命中的文件内容**原样进包**（见 §1 G-09 的边界）。

---

## 5. 明确未验证的空白（不是「已验证」）

以下区域本轮**未被测试覆盖**，列为空白而非通过：

| 空白 | 原因 |
|---|---|
| `plugins` / `mcp` / `agentInstructions` / `pluginFiles` / `sessions` / `self` 的往返 | 需要 `npm install` 或更多 mock 编排 |
| 整体加密容器 `DCA1`（`encryptArchive` / `verifyEncryptedBlob`） | 本轮一致性套件只覆盖 `secrets.enc`（`DSC1`）路径 |
| 规格可独立实现性的 4 处缺规格 | 见 `docs/spec/bundle-format-v1.md` §11 与 T6 审计结论：压缩方法容错边界、`relativePath` 归一化、5 个分区的未知字段写回行为、`redactedHits` 的持久化语义 |
| `tests/**` 未被根 `tsconfig` 的 `include` 覆盖 | 根 tsconfig 只 include `src/**`；`tests/` 的类型检查是盲区（本轮用临时 tsconfig 单独验证通过，但未改工程配置） |
| 非 npm 包管理器对 `peerDependenciesMeta.optional` 的处理 | P-1 的隔离安装结论只覆盖 npm（见 §1 P-1 的「未验证边界」） |
| 普通导入（GUI 向导）是否恒使用 `parseZipHardened` | 需追宿主注入链，超出取证范围（规格 §11 已登记） |
| `source.platform` 取值是否被严格校验为枚举 | 源码只校验 `typeof === 'string'`（规格 §11 已登记） |
| `sessions` 分区（`includeSessions: true`）内未知字段的行为 | 结构上不可能承载未知字段，未单独跑一次实测（规格 §11 已登记） |
