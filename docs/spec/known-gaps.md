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
| **L2** | `exports["./schema"]` 指向纯类型产物（运行时 0 导出） | ✅ 已修复（13 个运行时导出） |
| **L3** | `env-lock` heartbeat 在途写残留 `.tmp` → `rmSync` ENOTEMPTY | ✅ 已修复（写串行化 + release 前 drain） |
| **L4** | `run-store` 测试固定 `sleep` 竞态（全量并发时偶发） | ✅ 已修复（改 `waitFor` 条件等待） |
| G-14 | 同步只搬 `pnpmWorkspace` 声明、不搬 `patches/**` → 目标机 pnpm 拒绝一切安装（issue #35） | ✅ 已修复（`patchFiles` 同进同出 + 导入端剔除不可满足声明 + 市场双端拒收 + journal 状态可辨 + 计划项可回滚 + 工具链变更可见可取消） |
| G-15 | Windows 无 OS process identity → 阈值内的 PID 复用残留锁仍判 UNKNOWN_STATE（issue #36） | ⚠️ **部分修复**（长过期可显式回收；精确区分 PID 复用仍未实现，见 §3） |
| G-16 | 文件类分区静默跳过 junction/符号链接（issue #37） | ✅ 已修复（GUI 与 CLI 同一跟随内核 + 跳过/不可读均留痕；home 外目标仍拒绝且留痕） |
| G-17 | 同步页「导出密钥」无数据源：勾选后不导出任何凭据，只跳过载荷的二次脱敏（issue #38） | ✅ 已修复（凭据作为独立密文载荷随加密快照迁移；拉取侧解密 → 逐条确认 → `credentials.set` 写回） |
| G-18 | `.credentials.yaml` 的 `refs:` 块未被识别：包里带着凭据原文，导入后仍要求人工重填（issue #39） | ✅ 已修复（两处解析共用同一口径，v1 `refs:` 块与预发布扁平布局都认；误导性的「需人工重填」只在确实还缺 ref 时出现） |

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
| 修复位置 | `src/core/analyzer.ts:246-254`（`if (!knownIds.has(sectionId)) { unsupportedSections.push(sectionId); continue; }`）；汇总告警在 `:297-298`（消息键 `import.unsupportedSections`，文案「备份包含本版本不支持的分区: X（已跳过，未导入）」）。 |
| 验证方式 | `tests/conformance/roundtrip.test.ts` → `FC-01`（断言 `analysis.unsupportedSections` 含 `keybindings`，且告警文案为「不支持/已跳过」）；`FC-04`（语义回归）。 |
| 残留边界 | 未知分区的**数据本身仍不被保留**（格式 v1 无「原样保留未知分区」能力）。修复只解决「告知」，不解决「保留」。 |

### G-02 未知分区告警文案误导

| 项 | 内容 |
|---|---|
| 基线问题 | 未知分区落进 `missingSections`，用户看到「备份声明了但缺少的分区: keybindings」——但文件其实在 ZIP 里（基线 `src/core/analyzer.ts:275-280`）。 |
| 修复位置 | `src/core/analyzer.ts:366-373`（`skippedSections` 从 `missingSections` 中剔除），告警在 `:374-375`。 |
| 验证方式 | `FC-01`（断言 `missingSections` 不含未知分区、`compatibility === 'excellent'`）；`FC-04`（未知分区与「已知分区文件缺失」互不串味）。 |

### G-03 无「不支持分区」的报告通道

| 项 | 内容 |
|---|---|
| 基线问题 | 全仓库没有 unsupported-section 的报告通道；`ImportAnalysis` 只有 `sectionsInZip`（只含已知分区）与 `warnings`/`errors`（基线 `src/core/types.ts:201-213`）。 |
| 修复位置 | `src/core/types.ts:217`（`ImportAnalysis.unsupportedSections: string[]`，`src/core/types.ts:219-226` 另有对称的 `unsupportedVersions`）；填充点 `src/core/analyzer.ts:429`。 |
| 验证方式 | `FC-01` / `FC-03`（`FC-03` 断言 `unsupportedVersions` 结构化暴露，且与 `unsupportedSections` 不串味）。 |

### G-04 checksums 单向

| 项 | 内容 |
|---|---|
| 基线问题 | `verifyAgainstTable` 只遍历**表里的键**，不检查「ZIP 里在、表里不在」的条目；普通导入路径对此零告警。 |
| 修复位置 | `src/core/analyzer.ts:196-205`（反向检查，排除 `manifest.json` / `checksums.json` 自身与目录条目），告警消息键 `import.extraEntries`（`src/core/messages.ts:46`）。 |
| 验证方式 | `tests/conformance/roundtrip.test.ts` → `INT-01`（断言未登记条目被点名列出、`valid=true`、`errors=[]`、Dry Run 零写入）；`CORPUS-02`（篡改数据条目不重算 checksums → 必须被拒）。 |
| 关联 | 「表缺失/为空」这一半是 G-12，**单独登记**。 |

### G-05 分区 version 无兼容余地

| 项 | 内容 |
|---|---|
| 基线问题 | 分区文档 `version` 采用精确 `=== 1` 判定（`src/schema/config.ts:66-69`）；任何已知分区 JSON 的 `version != 1` 会让**整个 bundle** 无法导入，而不是跳过该分区。 |
| 修复位置 | `src/core/analyzer.ts:278-288`：只有「数字且 `> 1`」才**跳过该分区并告警**（消息键 `import.unsupportedSectionVersion`）。 |
| 验证方式 | `FC-03`（`version > 1` → 跳过 + 告警 + 不阻断 + 不进 `sectionsInZip` + 不产生计划项）；同测试的后半段钉住 `version < 1` / 非数字 / 缺失仍**硬失败**。 |
| **仍未修复的不对称** | `version > 1` 跳过、`version < 1` / 非数字 / 缺失**硬失败整个 bundle**。这是**有意保留**的数据损坏语义，但对外部实现者是一个不对称契约，必须在 v2 设计时决策（规格 §3.3 已写明三档实测）。 |

### G-06 迁移链未接入导入路径

| 项 | 内容 |
|---|---|
| 基线问题 | `migrateToCurrent`（`src/migrations/index.ts`）已实现且有单测，但**导入路径从不调用它**——`analyzer.loadBundle` 只用 `isSupported` 判定后直接继续（基线 `src/core/analyzer.ts:165-168`）。一旦 `CURRENT > MIN`，旧备份会被「判定为可迁移」却**不会真的被迁移**。 |
| 修复位置 | `src/core/analyzer.ts:213-222`（`needsMigration` 为真时调用 `runSchemaMigration`，迁移结果重新过 `validateManifest` 才作为后续 manifest）；实现 `src/core/analyzer.ts:870-885`。 |
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
| 修复位置 | `src/core/exporter.ts:135-161`（`scanFileSectionText` 定义）、`:243-275`（`else` 分支调用，`:248` 调用点、`:251` 计入 `redactedHits`、`:264-273` 产出 `export.fileSectionSecrets` 告警）。消息键 `src/core/messages.ts:28`。 |
| 验证方式 | `tests/core/exporter.test.ts:298`（凭据文件 → 告警 + 计入 `redactedHits`，且内容**原样不改写**）、`:332`（二进制跳过；无 `scanText` 的扫描器不扫）、`src/core/model-tools.test.ts`（模型工具路径与 HTTP 路由同档扫描）。 |
| **仍然成立的边界（勿过度承诺）** | ① **只报告不改写**：命中的文件内容**不剥离**，明文仍在包里——「默认不含秘密」对文件类分区**仍不成立**，缓解手段仍是 `pluginFiles` 默认 `false` + 市场 BANNED，用户显式勾选即可带出明文；② 只走 `scanner.scanText`，core 内置 `defaultSecretScanner` 未实现该方法 → 该分支**返回空**（行为与修复前一致），生产路径注入的是含 `scanText` 的强化扫描器；③ 二进制文件（前 4 KiB 含 NUL）跳过；④ 单文件 1 MiB / 累计 16 MiB 预算超限即停止扫描（不中断导出）；⑤ `redactedHits > 0` **不再**意味着「包里没有明文」（见规格 §5.3.4 / §5.3.5 的修正说明）。 |
| 关联 | 告警去重问题曾作为独立发现登记为 G-13，**修复已落地**（见 §2）。 |

### G-10 `sections.secrets` 恒 `false` 但语义被复用

| 项 | 内容 |
|---|---|
| 问题 | `sections.secrets` 永远是 `false`（无 adapter）；加密事实由 `security.encrypted` 承载。第三方若按「`sections.secrets === true` 表示含凭据」实现，会判断错误。 |
| 收口方式（**规格侧，实现刻意未变**） | `buildSectionFlags` 里 `flags['secrets'] = false` 仍在（当前工作区 `src/core/exporter.ts:404`）——这不是实现缺陷，而是「键集合恒全量」的**语义设计**。规格 §2.5 已加显式警告块；§9 步骤 4 的验收判据明确「判断『含秘密/需密码』只看 `security.containsSecrets` / `security.encrypted`，不看 `sections.secrets`」。 |
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

### G-18 含 vault 的备份里带着凭据原文，导入后仍要求人工重填（issue #39）

| 项 | 内容 |
|---|---|
| 基线问题 | 宿主导入路径 `tryDecryptCredentials`（`src/index.ts`）与同步引擎 `credentialsMapFromYaml`（`src/sync/snapshot-crypto.ts`）解析 `.credentials.yaml` 时**只认顶层字符串项**（DSH 预发布扁平布局）。DSH v1 布局把凭据值放在顶层 `refs:` 块下（文档形状：`version: 1` / `refs:` / `records:`，见 `dsh-credentials-local` 的 `parseCredentialsDocument`），而 `refs` 是对象 → 被 `typeof v === 'string'` **整段**过滤 → 解出的 Map 为空。 |
| 后果 | `includeSecrets=true` 的加密备份里明明带着凭据原文（`security/secrets.enc` 可用导出密码解开），导入时 `/decrypt` 回传的 `refs` 恒为 `[]` → 导入向导的 `!decryptRefs.includes(s.ref)` 过滤失效（`ImportWizardView.tsx`）→ 所有 ref 进「待补录」清单；`/execute` 拿到的 `decryptedCredentials` 为空 → `result.missingSecrets` 非空。用户无从判断是「包里没有」还是「插件没认出来」。 |
| 修复位置 | ① 新增唯一解析口径 `src/security/credentials-yaml.ts` 的 `collectCredentialRefs`：顶层字符串项（扁平布局）**与**顶层 `refs:` 块下的字符串项（v1 布局）都收，`records` / `payload` 等嵌套结构忽略（会话秘密不是凭据 ref）；两处调用点（`src/index.ts`、`src/sync/snapshot-crypto.ts`）改为共用它，杜绝「同一文件格式两处口径漂移」。② 收窄 `import.vaultMissing` 的误导：`includeSecrets=true` 时导出侧**不**镜像明文 vault（`src/core/exporter.ts` 的 4b），跨机 vault 必然为空；值已由包内密文回填（plan 的 ref 全部被 `decryptedCredentials` 满足）时改用新消息 `import.vaultCredentialsFromArchive` 如实说明，确实还缺 ref 时才保留「人工重填」。 |
| 验证方式 | `src/security/credentials-yaml.test.ts`（8 例：v1 `refs:` 块 / 扁平布局 / 混排取并集且同名以 refs 为准 / 非字符串与空值丢弃 / 顶层非对象 / `refs` 块非对象 / 空 `refs`）；`tests/security/credentials-refs-import.test.ts`（2 例，走宿主真实路径 Exporter→`tryDecryptCredentials`→`executeImportPlan`：refs 块被认出 → `missingSecrets` 为空 + `credentials.set` 写回 + 不出现「需人工重填」；只覆盖部分 ref 时仍如实列出缺口）；`src/sync/sync-credentials.test.ts` 新增 v1 布局用例。**修复前实测**：两条集成用例失败（`decrypted.get('DEEPSEEK_API_KEY')` = `undefined`，`missingSecrets` = 两个 ref）。 |
| 附带改动 | `tryDecryptCredentials` 由模块私有改为具名导出（供集成测试走宿主真实路径）；新增消息 key `import.vaultCredentialsFromArchive`（zh/en 同步，`src/core/messages.ts`）。 |
| 未覆盖 | `src/adapters/workspaces.ts` 的 `applyItem` 用备份记录**整条覆盖**，会丢本机独有键（如 `archivedSessionIds`）—— 报告人自述「另开 issue」，本次未动。 |
| 后续已补（本轮） | 报告人列的 API 三项已落地（同一 issue 的 Feature 1–3，语义见 `docs/spec/headless-consumption.md` §4.5）：① `/export` / `ExportOptions.sessions: { limit }` —— 0 = 不带 / 负数 = 全带 / 正数 = 最新 N 个；单位 = 会话目录（同一会话的新旧日志一起走），文件名判据 `^session(\.[A-Za-z0-9]+)*\.jsonl(\.zstd)?$` 不写死（`session.lock` 不算会话），排序用会话日志的最新 mtime（`FileSystemFacade.mtimeMs`；未实现则退回全量 + 告警，绝不把未知当最旧）；核心 `src/core/session-select.ts` + `SessionsAdapter.restrictUnits` + `Exporter` 的显式选中。② `/analyze` 可选 `decryptPassword` → `ImportAnalysis.credentials: { inArchive, refs, satisfied }`（只回传 ref 名，永不回传值）。③ `/execute` → `ImportResult.credentialsRestored`（从加密归档内解出并回填的条数，只增不改）。**仍未做**：`POST /sessions/group` —— 报告人自标「可选、量级较大」，需改写 DSH 会话存储（多帧 zstd 首帧 header）+ 写前备份 / 写后自检 / 失败回滚，属数据变更类高影响改动，留待单独决策。 |

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
| 工作区现状 | `src/core/analyzer.ts:167-172`：`table` 为 `null`（表缺失）**或**键数为 0（表为空）时，统一产出 `import.checksumsMissing` 告警（文案「备份未提供完整性校验表，全部条目未被校验」）。此时反向检查（`:196-205`）不再运行——无表可对照。 |
| 回归测试（已存在于工作区） | `tests/conformance/roundtrip.test.ts` → `INT-02`（表缺失）、`INT-03`（表为空）、`INT-04`（非空表语义不变，防误报回归）。 |
| 收口状态 | ✅ 已修复并验收。变异验证：去掉新告警 → `INT-02`/`INT-03` 红灯；还原后逐字节一致。 |

### G-13 G-09 的告警去重

| 项 | 内容 |
|---|---|
| 问题 | 文件类分区的 secret 命中告警原本按 **hit** 计数且不去重：同一行同时命中「字段名」与「值形状」会产出两条**同路径**告警，少数文件就吃满 `MAX_FILE_SECTION_WARNINGS_PER_SECTION` 上限，导致含真实明文凭据的其它文件被静默淹没。 |
| 工作区现状 | `src/core/exporter.ts:252-273`：先按**文件路径**去重，再截断到 `MAX_FILE_SECTION_WARNINGS_PER_SECTION`（语义 = 不同**文件**数），并对被截断的文件数补一条**汇总告警**（截断不得静默）。`redactedHits` 仍计**全量命中**（报告统计通道 ≠ 告警通道）。常量与语义注释见 `:107-108`。 |
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
| **L2** | `exports["./schema"]` 指向纯类型产物 `types.js` → 第三方 `import` 得到**空对象**；且 `CURRENT_SCHEMA_VERSION` 等版本工具**包外无法导入** | 新增 `src/schema/index.ts`（零 DSH / 零 `node:` 依赖）导出 13 个运行时值 + 类型；`exports` 改指它 | 隔离默认安装后 `import('dsh-config-manager/schema')` 返回 **13 个导出**（修复前 `{}`）；`SECTION_IDS.length === 15` |
| **L3** | `env-lock` 的 heartbeat 走 `atomicWriteFile`（同目录 tmp 写 → rename）；`release()` 不等在途写 ⇒ `.dshcm.*.tmp` 残留在 locks 目录 → after-hook `rmSync` **ENOTEMPTY**（Windows 偶发） | heartbeat 写**串行化** + `release()` 前 `drainHeartbeat()`（顺带修掉 interval 写之间的并发 rename 竞态） | 连续 10 次单文件全绿；变异（移除 drain）→ 红灯。**拒绝用 `maxRetries` 掩盖**——那会留下真实缺陷 |
| **L4** | `run-store` 测试用固定 `sleep` 等轮询收敛，全量套件并发时定时器被拖慢 → 偶发 `actual: 'importing', expected: 'result'` | 改为 `waitFor(predicate, timeout)` 条件等待（**不削弱断言语义**，超时仍抛错） | 连续 10 次全绿；变异（破坏收敛）→ `waitFor` 超时抛错 |

---

## 3. 仍未修复的缺口

### G-11 条目名侧不拒绝中段反斜杠（与 checksums 侧不一致）

| 项 | 内容 |
|---|---|
| 问题 | `isPathSafe`（`src/utils/paths.ts:45-54`）只拒绝「以 `/` 或 `\` 开头」与「含 `..` 段」的名字，**中段 `\` 被接受**：`isPathSafe('custom/skills/back\\slash.md') === true`；写侧 `zipToBuffer`（`src/utils/zip.ts:95-97`）与读侧 `parseZip`（`src/utils/zip.ts:289`）也接受。 |
| 后果 | ① **跨平台路径语义不一致**：同一份 bundle 在 Windows 目标上把 `\` 当分隔符（`skills/probe/back/slash.md`），在 POSIX 目标上当普通字符（`skills/probe/back\slash.md`）；② 与 `checksums.json` 的键侧规则**不对齐**——后者明确拒绝含 `\` 的路径（`src/security/integrity.ts:63`）。 |
| 可利用性 | **有限**：`\` 不是 `..`，无法越出 baseDir 之外，且 L3 的 `isReservedInternalRel` 会在折叠后拦截保留命名空间。但它是**真实的行为不一致**，且会让跨平台幂等比对出错。 |
| 验证方式 | 规格 §3.3.2 实测 C10（12 例条目名注入）。 |
| 建议动作 | 在写侧与读侧统一拒绝中段 `\`（比现状更严格），并同步 `checksums` 侧规则；这属**格式行为变更**，需与版本策略一起决策。 |

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
