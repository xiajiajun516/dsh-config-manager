# Claude Code 迁移能力加固 v1.1（2026-10-18）

> 状态：**已落地**（读盘层 / 翻译层 / Bundle 溯源 / 会话保真 / 文案）。
> 上游契约：[外部 agent 配置导入 v1](2026-10-04-foreign-import-v1.md)（本文只写**增量与订正**，不重复其内容）。
> 本文同时是三路审计的**结论固化点**：本仓代码审计 → 三个参考项目真实源码 → 本机真实 DSH 运行时。

## 0. 一句话结论

v1 的主链（MCP / skills / CLAUDE.md / 会话转码 + workspaces）是**实现完整且有护栏**的；
本次**不重写**它，只补三块真实缺口：**（a）项目级与插件级来源**、**（b）「未迁移」的如实诊断**、
**（c）Bundle 的溯源与「同内容 → Skip」的幂等性**。

## 1. 审计方法（证据强度逐项标注）

| 路 | 做法 | 取证强度 |
|---|---|---|
| A 本仓代码 | 只读逐文件核对，结论一律带 `file:line` | 源码级确证（未跑测试时的行为为代码推断） |
| B 参考项目 | `git clone` 三个仓库真实源码 + LICENSE/提交时间/peer 版本 | 源码级确证（浅克隆，早期历史未验证） |
| C DSH 运行时 | 本机 app.asar（0.2.1-rc.2）解容器读 lib/README 真值 | 源码级确证；**未安装的桥接包只能确证「被登记 + 有依赖声明 + 格式预留」** |
| D 本机 Claude Code | 实读 `~/.claude`、`~/.claude.json`、`~/.claude/plugins` 的**目录结构与键名** | 实测取证（**只记录路径与键名，不记录任何值**） |

> 审计脚本与原始产出：`.tmp/audit/{repo-current,dsh-native,refs}.md`（`.tmp/` 已被 gitignore，不进包）。

## 2. 参考项目事实（2026-10-18 快照）

| 项目 | HEAD / 最近提交 | 许可证 | 与 DSH 的关系 | 关键事实 |
|---|---|---|---|---|
| [yhlooo/dsh-bridges](https://github.com/yhlooo/dsh-bridges) | `977a1fc` / 2026-09-14（v0.3.0） | Apache-2.0 | 7 个 skill provider 桥 7 个 agent | **配置面只读**（全 src 无写盘）⇒ 无双向同步；运行时真实 spawn 上游 hooks；**无 Claude Code 插件/marketplace 能力**（grep 零命中）；不 provide 自有服务 |
| [biedongbin/dsh-claude-compat](https://github.com/biedongbin/dsh-claude-compat) | `367d5d5` / 2026-10-18 | MIT | Claude Code 运行时兼容插件 | 支持 plugins/manifest、marketplace、skills、commands（**仅扁平**）、agents（映射为 skill）、MCP、rules、hooks（5 事件）；**不支持** permissions 整块、CLAUDE.md 注入、嵌套 commands、`settings.local.json`、多个 hook 事件、**Windows hooks（硬编码 /bin/sh）**。风险：仓库内 `settings.json` 的 hook 经 `/bin/sh -c` 执行，**打开不可信仓库即任意命令**；会写回 `~/.claude/settings.json` 与 `installed_plugins.json` |
| [Nwflower/dsh-chat-import](https://github.com/Nwflower/dsh-chat-import) | `c9ccfdd` / 2026-10-17（v0.26.1） | MIT | 会话导入 | 29 种来源；`convert/*.mjs → ir → events → runDecision`；发现层只读头 256KiB/尾 64KiB；损坏行跳过计数封顶 200；源未变即跳过、源增长且 DSH 侧已续聊则另铸副本；cwd 走 `~/.claude.json` 的 `projects` **权威映射**。风险：密钥只报位置**不脱敏不阻断** |

**结论（写进本仓决策）**：三者都不是「可直接复用的迁移层」——
bridges 是**运行时**桥（不写配置、无插件能力），claude-compat 是**运行时**兼容（且会执行/写回上游配置，不由本插件代跑），chat-import 是**外部导入工具**（与我们的标准 bundle 通道不同源）。
因此本插件的定位不变：**把外部格式翻译成标准 bundle v1 载荷，写盘一律走既有导入管道**。

## 3. 本机 DSH 原生能力事实（0.2.1-rc.2）

| 能力 | 事实 | 对本插件的含义 |
|---|---|---|
| `CLAUDE.md` | `@deepseek-ai/dsh-agent-instructions` 的候选清单含 `AGENTS.md` + `CLAUDE.md` | 全局 CLAUDE.md → AGENTS.md 是**原生可复用**映射（v1 已做） |
| `.claude/rules/`、`@path` 导入 | 同包明确**不解释** | 规则文件**没有**原生对等结构 ⇒ 只能如实报告或谨慎合并 |
| Claude skills / marketplace / 插件目录 | 全无（skills 根里没有 `.claude/skills`） | 插件只是**外部概念**；`.claude-plugin/plugin.json` 不是 DSH 插件清单 |
| commands | **只有代码注册** `ctx.commands.register()`，无文件形态、无 frontmatter | Claude 斜杠命令**没有**文件级对等结构（claude-compat 把它们映射成 skill 属其自身取舍） |
| hooks | 有：`ctx.on('<event>')`，约 90 个事件（`tools/pre-execute` / `tools/post-execute` …） | DSH 有事件面，但**没有**「读 Claude hooks.json 并执行」的原生机制；官方桥接包 `dsh-hooks-claude-code` 本机**未安装** |
| agent presets / subagents | preset = **plugin row**（不是文件）；subagent = 运行时 provider 注册制 | `.claude/agents/*.md` **没有**文件级对等结构 |
| sessions | 有 `ctx.sessionPersistence` seam；**无官方导入 API**（grep 零命中） | 会话必须由我们**转码**（v1 已做），移植面保持现状 |
| 插件兼容性检查 | `evaluatePluginCompatibility`（`engines.dsh` 或 `@deepseek-ai/dsh*` peer）**会拦截** | 「把目录拷进插件目录」不等于能加载；因此**本次绝不复制 Claude 插件代码** |

## 4. 改进前的能力矩阵（审计结论）

### 4.1 已实现且正常

- MCP（`~/.claude.json` 顶层 `mcpServers`，stdin/url 双形态 + SSE 归一 + 凭据剥离）；
- skills（`.claude/skills/<名>/SKILL.md`，frontmatter 校验、非法整体跳过并报码）；
- `~/.claude/CLAUDE.md` → 全局指令；
- 会话转码（JSONL → DSH v3/v4 带校验和 zstd 帧）+ workspaces 连带；
- 安全面：dry-run 零写入、导入前强制快照、冲突不默认覆盖、失败回滚、路由只写临时目录。

### 4.2 已实现但有缺陷

| # | 缺陷 | 证据 | 影响 |
|---|---|---|---|
| 1 | 会话文件数触顶 500 **静默 break** | `read-claude-code.ts:168,178` | >500 条时用户看到「成功」，多出的对话消失 |
| 2 | 技能目录是符号链接时静默 skip | `read-claude-code.ts:141` | 被链接的 skill 无声消失 |
| 3 | `isSidechain` 子代理记录**静默混入父对话正文** | 全仓零命中；文档 §3.1.5 却声称「按 unsupported-session-record 计报」 | 导入后的对话内容被污染 |
| 4 | 产物字节含 `Date.now()` 回落 ⇒ 同一来源两次转码字节必不同 | `claude-sessions.ts:376,401` | 重复导入**恒判 Conflict** 而非 Skip |
| 5 | `settings.json` 的 permissions / 其它顶层键**静默丢弃** | `claude-code.ts:44-59` 只处理 hooks/env | 安全相关设置既不搬也不报 |
| 6 | `CLAUDE_CONFIG_DIR` 完全没读，文档却声称支持 | 代码不读 env；`doc:219/387` | 配了该变量的机器读错位置/判未安装 |
| 7 | Bundle 不携带任何来源元数据 ⇒ 兼容性评分恒 excellent | `bundle.ts:8-12`；`validator.ts:59-101` | 落盘后无法自证来源，用户看到「优秀」但无信息量 |
| 8 | 记录里的 `sessionId` 从未被读 | `claude-sessions.ts:82-83` | 文件名与记录不一致时**静默**以文件名为准 |

### 4.3 未支持且有实际价值

- 项目级配置（`.claude/settings.json` / `CLAUDE.md` / `.claude/rules` / `.claude/skills` / `.claude/agents` / `.mcp.json`）；
- `~/.claude.json` → `projects[<路径>].mcpServers`（项目级 MCP 的权威落点）；
- Claude Code 插件与 marketplace（`known_marketplaces.json`、`.claude-plugin/{marketplace,plugin}.json`、`enabledPlugins`）；
- 增量/续传导入（`ClaudeReadHandle` 是未接线扩展位）。

**明确定为「不做」**（有据可依，不是遗漏）：插件运行时代码、hooks 执行面、permissions 语义、subagents 运行时。

## 5. 本次采用的映射决策

| 外部形态 | 决策 | 兼容性等级 | 理由 |
|---|---|---|---|
| 插件自带 `skills/**` | **迁移**到 `skills` | 无损（格式同构） | SKILL.md 与 DSH skill 同构，frontmatter 判据一致 |
| 插件自带 `.mcp.json` | **迁移**到 `mcp` | 无损（凭据先剥离） | 与全局 mcpServers 同一映射；值绝不过去 |
| 项目级 `.mcp.json` + `projects[].mcpServers` | **迁移**到 `mcp` | 无损（凭据先剥离） | 同上；同名先到先得并报码 |
| 项目级 `CLAUDE.md` / `CLAUDE.local.md` | **合并**进同一份全局指令 | 有损（合并，报 `instructions-merged`） | DSH 只有一份全局指令文件；合并是 v1 既定决策 |
| `.claude/rules/*.md`（**无** frontmatter） | 合并进指令 | 有损（同上） | 纯正文，与 CLAUDE.md 同性质 |
| `.claude/rules/*.md`（**有** frontmatter） | **只报告** | 不可映射 | frontmatter（如 `paths` 作用域）合并后会丢作用域 ⇒ 宁可不搬 |
| `.claude/agents/*.md` | **只报告** | 不可映射 | DSH subagent 是运行时 provider 注册制，**无文件级对等结构**；映射成 skill 会改变激活语义（claude-compat 这么做是其自身取舍，本插件不代其决定） |
| `settings.json` → `permissions` | **只报告**（allow/ask/deny 条数） | 不可映射 | DSH 无权限规则文件；值一律不读 |
| `settings.json` → 其余顶层键 | **只报告**（键名与条数） | 不可映射 | 避免「配置看起来搬过去了」的错觉 |
| `settings.json` → `hooks` | **只报告**（事件名 + 条数） | 依赖外部运行时 | 只有装官方 `dsh-hooks-claude-code` 才谈得上执行；本插件**绝不代跑**，也绝不复制 hook 脚本 |
| `settings.json` → `env` | **只记名字** | 需在目标机补录 | 值绝不进包（v1 已做） |
| 插件本体（JS / 命令执行面 / 插件 API） | **不迁移**，报 `unsupported-plugins` | 依赖外部运行时 | 「目录复制成功 ≠ 插件运行成功」；DSH 的插件兼容性检查还会直接拦 |

## 6. 兼容性与数据损失（逐项，用户可见口径）

- **无损**：插件/项目 skills、各处 MCP 定义（凭据剥离后字段名与结构保留）、项目级指令合并后的正文。
- **有损但可见**：指令合并（多来源合成一份，报 `instructions-merged`）；项目 MCP 与全局 MCP 同名时先到先得（报 `mcp-server-id-conflict`）。
- **不迁移但逐条报码**：permissions、settings 其它键、hooks、rules（带作用域）、agents（子代理定义）、插件本体、子代理会话（`isSidechain`）、无承载位的推理块。
- **凭据**：一律只留**引用名**（`mcp:<server>:<FIELD>` / `settings.env:<NAME>`），值绝不进包、不进响应、不进日志。

## 7. 仍然存在的限制（如实登记）

1. **未在真实 DSH 运行时端到端验证**：本仓测试用真实 Importer / 真实 DSH codec 类型，但没有在 GUI 里跑一次「产包 → 预览 → 写入」的真机链路（限制见 §8）。
2. **插件启用清单的判据是「文档 + 形状自证」**：本机 `~/.claude/plugins/config.json` 与 `installed_plugins.json` 都不存在，插件组件只能按 `enabledPlugins` + 目录存在性判定；形状不认识时报码而不是猜。
3. **同名会话跨 projectKey 的目标机检测仍未做**：包内去重（`session-id-conflict`）与精确路径冲突判定已有，但「同一 id 落在另一个 projectKey」仍不可见；幂等修复让**同一来源重复导入**能判 Skip，跨 cwd 变更的重导仍会冲突。
4. **cwd 不做重定基**（foreign 包不带 `sourceHome`）：跨机导入后工作区路径仍是源机路径。
5. **>32 MiB 的单会话整份不读**（如实报 `source-unreadable`），无流式转码。
6. **Claude hooks.json → DSH 事件的字段级映射无法实证**（官方桥接包未安装），因此 hooks 停在「只报告」。
7. `dsh-bridges` / `dsh-claude-compat` 的实际运行行为**未在本机安装验证**（只做了源码级审计）。
8. **推理块两侧口径不一致（有意保留）**：Claude 原生的 `thinking` / `redacted_thinking` 块**识别并计报**（IR 无承载位，按「不确定就计报」处置）；而**别的导出器归一后的** `{type:'reasoning', text}` 命中既有「对象带 text 即当文本块」的兜底分支，正文被保留为 assistant 文本。改动后者会把既有字节回归语料从 728 改到 722 字节，属**另一类语义变更**，本轮不动，此处显式登记。

## 8. 本次改动清单（文件 → 作用）

| 文件 | 作用 |
|---|---|
| `src/foreign/types.ts` | 冻结 8 个新 skip 码；新增 `ClaudeProjectInput` / `ClaudePluginInput` / `ForeignOrigin`；`ClaudeCodeInput` 扩 6 个字段（configDir / configDirOverridden / sourceVersion / projects / plugins / marketplaces）；`ClaudeSessionInput` 加 `recordSessionId` / `createdAtMs`；`ForeignImportResult.origin` |
| `src/foreign/read-claude-code.ts` | CLAUDE_CONFIG_DIR 覆盖；项目级扫描（上限 / 符号链接 / 触顶均报码）；会话条数触顶报码；技能目录链接报码（**三处静默修复**）；commands 递归计数；会话文件带出 `recordSessionId` 与确定性 `createdAtMs` |
| `src/foreign/read-claude-plugins.ts`（新） | 市场清单（`known_marketplaces.json`，URL 剥 userinfo）、启用清单（`enabledPlugins` 真值 / `config.json` 形状自证）、插件目录定位、组件枚举 —— **只读元数据与技能文本，绝不执行、绝不复制插件代码** |
| `src/foreign/claude-code.ts` | 指令合并（全局 + 项目 + 无 frontmatter 的 rules）；四来源 MCP 装配 + 同名报码；permissions / 其余顶层键 / hooks 明细 / agents / plugins 逐条诊断；`origin` 装配；**findings 并入 skipped**（接线修复） |
| `src/foreign/claude-sessions.ts` | 幂等墙钟（记录时间戳 → `createdAtMs` → 墙钟并记账）；`isSidechain` 跳过并计报（**不再混入父对话**）；sessionId 不一致 findings；thinking 计报 |
| `src/schema/types.ts` / `manifest.ts` | `ManifestForeignOrigin` + `Manifest.foreign?`（可选；缺失合法、畸形仅 warning、**绝不拒绝包**） |
| `src/foreign/bundle.ts` | `ForeignOrigin` → `manifest.foreign`（`source`→`agent`；缺省**不写**该键 ⇒ 旧包逐字不变；checksums 口径不变） |
| `src/routes/foreign.ts` | 响应 additive 回传 `origin`（旧响应逐字不变） |
| `src/foreign/registry.ts` | detect 补插件 / agents / rules 探测 + CLAUDE_CONFIG_DIR 覆盖探测；build 传 `env` |
| `src/foreign/truth-table.ts` | claude-code 条目补路径与 `CLAUDE_CONFIG_DIR` envKey |
| `src/foreign/truth-table.test.ts`（新） | 补齐 design doc 声称存在、**实际缺失**的真值表护栏（V1–V5：同序同集合 / 令牌展开 / probePaths 交叉核对 / evidence 一致 / envKey 登记） |
| `src/foreign/file-budget.test.ts` | 登记新共享模块 `read-claude-plugins.ts` |
| `src/ui/i18n.ts` / `foreign-view.ts` / `foreign-view.test.ts` | 8 个新码的 zh/en 文案与 `FOREIGN_SKIP_KEY` 全量映射补全（缺文案即编译失败） |
| `tests/helpers/i18n-scan.ts` / `i18n-hardcoded-guard.test.ts` | 白名单计数 61→62、总数 132→133（truth-table 取证文本新增 1 处中文，非新增豁免条目） |
| `docs/spec/bundle-format-v1.md` | §2.2 增 `foreign` 字段行 + 「为何不进 schema properties」说明 |
| `CHANGELOG.md` | `[Unreleased]` 新增用户可见条目 |

## 9. 测试与验证（实跑）

| 检查 | 结果 |
|---|---|
| `npx tsc --noEmit` | **exit 0（全仓干净）** |
| `npm test`（全仓） | **4960 tests / 4957 pass / 1 fail / 2 skipped**；唯一失败 = `src/client/sync/SyncSettingsView.test.ts` t42（**他人本轮在途的同步 UI 改动**：主文件 1586 行超出拆分阈值），与本轮无关 |
| `node --test "src/foreign/*.test.ts"` | 全绿（含 12 例会话字节回归逐字未变、真实 DSH codec 解码产物） |
| `src/schema/manifest-schema.test.ts` + `tests/schema-compat.test.ts` | 全绿（F-01..F-04；SC-07 未知顶层字段保留未变红） |
| `tests/i18n-hardcoded-guard.test.ts` + `src/foreign/file-budget.test.ts` | 全绿 |
| 真机 smoke（只打印结构/机器码） | 本机 `~/.claude`：skills=7、sessions=2、projects=2、plugins=0（enabledPlugins 缺失 ⇒ 0 启用，符合预期）、marketplaces=1 |

**未验证**：GUI 全链路（产包 → 预览 → 写入）；`dsh-bridges` / `dsh-claude-compat` 安装后的真实运行行为；Windows 之外平台的 hooks 语义。
