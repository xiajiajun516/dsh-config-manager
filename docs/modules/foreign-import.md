# 外部来源导入（foreign-import）

把**本机已装的其他 AI agent**（Claude Code、Codex、Cursor、Gemini、OpenCode…共 30 个来源）的配置与会话，
翻译成**标准 bundle v1 ZIP**，之后完全复用既有导入管道。

为什么单开一层而不是再写一批 ConfigAdapter：`src/adapters/*` 的契约前提是「源机也是 DSH，只是 homeDir 不同」，
而第三方工具没有 `$DSH_HOME`、没有分区语义，硬套会污染 schema 与分区注册表（`src/foreign/types.ts` 文件头）。

---

## 1. 边界

| | 内容 |
|---|---|
| 进来 | 外部 agent 的配置目录与会话日志（**只读**，绝不改动源目录） |
| 出去 | 一个标准 bundle v1 ZIP（`src/foreign/bundle.ts` 的 `writeForeignBundle`）+ `manifest.foreign` 溯源块（`src/schema/manifest.ts:31`，只有来源标识与计数，**绝不含值**） |
| 不负责 | 写盘、快照、冲突判定、dry-run —— 全部由 `Importer`/`src/core/analyzer.ts` 负责；本层只到「包」为止 |
| 不代表 | 「已支持 = 已验证」。每个来源的取证强度是必填字段（`measured` / `fixture` / `documented`），由 `src/foreign/truth-table.test.ts` 钉住 |

## 2. 入口（三处必须共用同一份上下文构造）

| 入口 | 位置 | 说明 |
|---|---|---|
| `GET /foreign-sources` | `src/routes/foreign.ts:89` | 只读发现：没装的来源也列出来（`found=false`） |
| `POST /foreign-import` | `src/routes/foreign.ts:101` | 翻译成 bundle 落受控临时目录，交给导入向导 |
| `dcm import --from <来源> [--dry-run]` | `src/cli/import-source.ts` | CLI 侧同一条翻译路径；来源词表 `src/cli/help.ts:14` 必须与 `FOREIGN_SOURCE_IDS` 逐项一致 |
| 界面 | `src/client/import/ForeignImportView.tsx` | 导入向导里的一步；文案映射 `src/ui/foreign-view.ts` |

三处都调 `foreignSourceContext()`（`src/routes/foreign-context.ts`）。**不要各写一份**：这里的 home 是**用户 home**，
不是宿主 context 的 `homeDir`（后者是 `$DSH_HOME`）；历史上 GET 与 POST 分叉过一次，症状是「GET 说找到、POST 稳定回 400
`nothing-to-import`」（`FOREIGN_IMPORT_EMPTY_CODE`，`src/routes/foreign-context.ts:89`）。

## 3. 流水线（五段，各段只做一件事）

```
源目录/日志 --(read-<id>.ts)--> 原始数据 --(<id>.ts)--> TranscriptRecord[]
   --(session-source.ts)--> IR --(session-ir.ts 的 synthesizeDshRows)--> DSH 行
   --(claude-sessions.ts 的 encodeDshSessionLog)--> 字节 --(kernel.ts 的 collectSessionSections)--> sessions/workspaces 分区
   --(bundle.ts)--> 标准 bundle v1 ZIP --(既有 Importer)--> 写盘
```

| 段 | 文件族 | 纪律 |
|---|---|---|
| ① 读盘 | `read-<id>.ts` | 唯一允许 `node:fs` 的层；不跟随符号链接、单文件上限 8 MiB（`DEFAULT_MAX_FILE_BYTES`，`src/foreign/session-read.ts:31`）、一次走盘 ≤5000 文件（`DEFAULT_MAX_WALK_FILES`，`:37`）、读不到**绝不抛**、结果排序 |
| ② 解析 | `<id>.ts` | 纯函数：源格式 → `TranscriptRecord[]`，不碰 fs、不拼 DSH 行 |
| ③ 归一与合成 | `session-source.ts` | 24 个会话类来源**必须**经这里；同一 DSH 会话 id 只允许出现一次，且必须连 `workspaces` 一起产出 |
| ④ IR | `session-ir.ts` | 纯函数、零 I/O，**不得** import 任何 `read-*`；工具块与文本块刻意不合并；时间戳只放行安全整数 |
| ⑤ 装配与落包 | `kernel.ts` → `registry.ts` → `bundle.ts` | `kernel.ts` 是零 fs 的共享内核：名字安全、`SKILL.md` frontmatter 校验、MCP 映射 + 凭据剥离、会话归集 |

来源清单的**单一事实源**是 `src/foreign/source-modules.ts`（`FOREIGN_SOURCE_MODULE_SHAPES`：6 配置类 + 24 会话类，
顺序 = 真值表顺序 = `ForeignSourceId` 顺序）；注册表 `src/foreign/registry.ts` 的 `builtinForeignSources()` 与四处硬编码快照
由测试反查这份表，**漏改即红灯**。

## 4. 三条不变量（本层自己守，`src/foreign/types.ts` 文件头）

1. **凭据值绝不进包**：MCP 的 env/headers 与 settings.env 由**导出侧同一个** `defaultSecretScanner` 剥离，只留字段名 + 引用名；
   URL 里的 userinfo 单独剥离（字段名扫描器看不到它）。
2. **不猜**：对不上的字段/格式一律进 `skipped` 并带稳定机器码，绝不静默丢弃。
3. **不产生用户可见字符串**：findings 只给机器码，文案在字典里映射（`src/ui/i18n.ts` 的 `foreign.*`）。

## 5. 合成会话的宿主硬形状（改 `synthesizeDshRows` 前必读）

四条硬形状（`assistant/message` 的 `message.source` 必须是 `{kind:'model', provider, model}` 且都非空；`data.stream` 必须是数组；
assistant 的 `message.content` 必须含 `tool-call` 块；`tool/result` 块是连字符 camelCase 且 `source.callId` 非空、
与块内 `toolCallId` 逐字相同）见 `docs/lessons/sessions-repair-diagnostics.md:24` —— 那里有 2026-10-07 真机事故的完整证据，
此处不重复。护栏：`src/foreign/session-ir.test.ts`（形状）+ `src/foreign/claude-sessions-bytes.test.ts`（字节基线，改形状必须写明理由）。

会话日志格式按**目标机**的版本写，读不到版本就不转；绝不一律写最高版本。

## 6. 上限与体积守卫（`src/foreign/file-budget.test.ts`）

| 守卫 | 口径 |
|---|---|
| 行数闸门 | `read-*.ts` ≤1000 行；其余手维护模块 ≤800 行；豁免表 `FOREIGN_LINE_EXEMPT` 当前为空，加条目 = 公开承认欠拆分 |
| 分层 import 白名单 | `src/foreign/**` 里 import `node:fs` 的模块集合必须**恰好等于**白名单 —— 往翻译层塞 fs 一律红灯 |
| 来源形状枚举 | 每个来源 id 必须恰好有 `read-<id>.ts` + `<id>.ts`，多一个少一个都红 |

## 7. 加一个来源的最小清单

1. `src/foreign/types.ts` 的 `ForeignSourceId` union 追加一个值（additive，既有值一字不改）；
2. `src/foreign/source-modules.ts` 加一条（模块名 + 是否带会话）；
3. 新建 `read-<id>.ts`（读盘，真值表落在这里的路径判定）与 `<id>.ts`（解析/翻译）；
4. `src/foreign/truth-table.ts` 加真值表条目（默认根 / 环境变量覆盖的 `replace`|`append` 语义 / `evidence` 强度）；
5. 跑 `src/foreign/source-registry.test.ts`、`src/foreign/file-budget.test.ts`、`src/foreign/truth-table.test.ts`；
   会话类来源再跑 `session-ir.test.ts` 与字节基线。

其余清单一律由测试反查上面两处，**不要**在 UI 字典、CLI help、测试快照里各手写一遍。

## 8. 失败语义与已知缺口

- **未知来源 id**：抛 `ForeignSourceError`，**绝不**回退到任一默认来源（回退会让用户以为导的是 A、实际导的是 B）。
- **没有可导入内容**：HTTP 400 `nothing-to-import`；CLI 打印稳定错误，不做「导个空包」。
- **位置被环境变量覆盖**（`CLAUDE_CONFIG_DIR`/`HERMES_HOME`/`CODEX_HOME`/`COPILOT_HOME` 等）：**只报键名**
  （`source-location-overridden`），值绝不进包/日志/回传；取值 ≠ 默认位置时按覆盖后的位置读，不猜默认位置。
- **内容缺口**：IR 没有 reasoning 承载块（`docs/maintenance/known-gaps.md` 的 F-01）、没有会话级压缩检查点通道（F-02），
  这类内容只进 `unsupported-session-record` 计数 —— 是已知缺口，不要当成静默丢失去「修」。

## 9. 测试锚点

| 面 | 文件 |
|---|---|
| 注册表契约 / 来源清单一致性 | `src/foreign/registry.test.ts`、`src/foreign/source-registry.test.ts` |
| 真值表与实现逐平台一致 | `src/foreign/truth-table.test.ts` |
| 体积 / 分层 / 形状守卫 | `src/foreign/file-budget.test.ts` |
| IR 与合成形状 | `src/foreign/session-ir.test.ts` |
| 字节基线 | `src/foreign/claude-sessions-bytes.test.ts` |
| 三入口上下文同源 | `src/routes/foreign.test.ts`、`src/cli/import-source.test.ts`、`src/ui/foreign-view.test.ts` |

## 10. 本文不覆盖（避免重复维护）

- **30 个来源的路径真值表数据**：`src/foreign/truth-table.ts` 是唯一事实源（逐平台默认根、环境变量 `replace`/`append`、取证强度），
  由 `truth-table.test.ts` 与实现交叉核对；本文不抄表。
- **冻结契约的历史版本**（单元 id 命名空间、冲突语义、机器码命名规范）：`docs/design/2026-10-04-foreign-import-v1.md` §8 是设计存档
  （可能早于实现，判行为以代码 + 测试为准）。
- **踩坑证据**：`docs/lessons/foreign-import.md`；规则判据在 `AGENTS.md` §📌「外部来源迁移」。
