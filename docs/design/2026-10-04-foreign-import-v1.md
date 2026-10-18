# 外部 agent 配置导入 v1（Claude Code → DSH）

> 状态：**v1 转换层已落地并自测通过**（2026-10-04），含**会话转码**（§3.1，产物已用 DSH 自己的 codec 验过）。
> 范围仅 Claude Code；CLI/UI 接线未做（见 §6）。
> 起点：用户诉求「让插件支持从其他 agent 导入数据」，明确指 Claude Code / Cursor / Codex 这类第三方工具。
>
> **2026-10-18 增量**：[Claude Code 迁移能力加固 v1.1](2026-10-18-claude-code-migration-v1.1.md)（项目级 / 插件级来源、如实诊断码、Bundle 溯源）。
> 该文同时**订正本文三处已被代码证伪的声称**：§3 把 `plugins` 归入「不做也不报」（现改为扫描并逐条报码）、
> §3.1.5 声称 isSidechain 子代理会被计报（此前代码里零命中，正文被静默混入）、CLAUDE_CONFIG_DIR 覆盖（此前文档声称支持、代码不读 env）。

## 1. 结论：做转换层，不做新 adapter

本仓库 `src/adapters/*` 的契约前提是「**源机也是 DSH**，只是 homeDir 不同」：
每个 adapter 都按 $DSH_HOME 的分区布局读写、路径可重定基、分区语义由 section-registry 固定。
第三方工具没有 $DSH_HOME、没有分区、路径也不可重定基 —— 硬套会污染 schema / registry / 版本契约。

因此 v1 只加一层**翻译器**：外部格式 → 标准 bundle v1 载荷 → 交给既有管道
（`Importer.analyzeImport` → `createImportPlan` → `executeImportPlan`）。

| 维度 | 转换层（采用） | 新增并列 adapter（否决） |
|---|---|---|
| 侵入面 | 新增 `src/foreign/`，零 schema 改动 | 动 schema / section-registry / 版本契约 |
| 语义 | 外部格式在转换期就地归一 | 把非 DSH 布局塞进「源机是 DSH」的假设 |
| 失败面 | 转换不了就报码，边界干净 | 半懂的分区会静默产出脏数据 |
| 复用 | checksums / 版本协商 / Zip Slip / 冲突判定 / 导入前快照 / dry-run 全白拿 | 需为外部来源另开一条写入通道 |
| 代价 | 每个来源一张映射表要自己维护 | 同样维护，还多背一层格式债 |

## 2. 实测取证（2026-10-04，本机 Windows）

只记录**结构与键名**，不记录任何值：

| 位置 | 实测形态 |
|---|---|
| `~/.claude.json` | 顶层含 `mcpServers`（名字 → 定义）、`projects`（按项目路径）、`numStartups`/`tipsHistory` 等大量机器状态 |
| `~/.claude/settings.json` | `env`（ANTHROPIC_* 等，**含 token**）、`hooks`（PreToolUse/PostToolUse）、`theme`、`includeCoAuthoredBy` |
| `~/.claude/skills/<名>/SKILL.md` | YAML frontmatter（`name` + `description`）+ Markdown 正文，**与 DSH skill 同构** |
| `~/.claude/` 其余 | `commands`（斜杠命令，本机无）、`hooks/`、`plugins/`、`projects/`、 `sessions/`、`history.jsonl`、`cache/` |
| `~/.claude/projects/<项目>/<uuid>.jsonl` | 纯 JSONL 明文，一行一条记录（`type` = user / assistant / attachment / queue-operation / system；记录里带 `cwd` / `sessionId` / `isSidechain`） |

对照的 DSH 目标形态（取自源码）：

- MCP 落在 profile 的 `cordis.patch.yml`，行 `{ id, name: 'dsh-mcp-client', config: { serverName, url|command, args, env, cwd, headers } }`；
  导入侧 `adapters/mcp.ts` 的类型判据是「有非空 url → streamable-http，否则 stdio」。
- skill = `<名>/SKILL.md`（frontmatter 必须能被 YAML 解析，否则 **DSH 静默丢弃**）。
- 全局指令 = `$DSH_HOME/AGENTS.md`（分区 `agentInstructions`，ZIP 内 `custom/agent-instructions/AGENTS.md`）。
- 会话 = `sessions/<projectKey(cwd)>/<id>/session[.vN].jsonl.zstd`：**带校验和的 zstd 帧拼接**（首帧 = header 单行 JSON，
  之后每批事件一帧），事件行形如 `{type, seq, time, data}`（消息类另带 `surfaceOp`）；当前 `SESSION_FORMAT_VERSION = 3`。

## 3. 映射表（v1）

| 外部来源 | DSH 分区 | 处理 |
|---|---|---|
| `~/.claude.json` → `mcpServers` | `mcp` | 逐条映射；type 判定与 `extractMcpServers` 同口径；**不写 sourceLineId**（缺省由 adapter 用 newLineId 兜底，避免撞目标机既有行 id）；sse → streamable-http 并报码 |
| `~/.claude/skills/<名>/**` | `skills` | 整目录搬进 `custom/skills/<名>/**`；frontmatter 先校验，非法即**整体跳过并报码**（否则用户会看到「导入成功但一个 skill 都没出现」） |
| `~/.claude/CLAUDE.md` | `agentInstructions` | 作为 `AGENTS.md` 进包；目标机已有同名文件时由既有冲突判定处理（**不默认覆盖**） |
| `~/.claude/settings.json` → `env` | —（只报告） | 命中的名字进 `credentialRefs`（`settings.env:<名>`），**值一律不读** |
| `~/.claude/settings.json` → `hooks` | —（只报告） | DSH 无对等结构，计入 `unsupported-hooks` |
| `~/.claude/commands/*.md` | —（只报告） | 斜杠命令与 DSH prompts 不是同一语义，计入 `unsupported-commands` |
| `~/.claude/projects/**/*.jsonl` | `sessions` + `workspaces` | **转码**（不是搬运）：见 §3.1 |
| `~/.claude.json` → `projects`（元数据）/`history`、`~/.claude/{cache,backups,history.jsonl}` | — | 机器状态 + 与源机路径强绑定，**不做也不报**（避免噪声） |
| `~/.claude.json` → `projects[<路径>].mcpServers`、`<项目>/.mcp.json` | `mcp` | **v1.1 起迁移**（项目级 MCP 的权威落点；同名先到先得并报 `mcp-server-id-conflict`） |
| `~/.claude/{plugins,plugins/known_marketplaces.json}`、`settings.json.enabledPlugins` | `skills`/`mcp` + 报告 | **v1.1 起**：插件自带的 skills 与 `.mcp.json` 迁移；**插件本体与运行时 API 逐条报码**（绝不复制代码，绝不执行 hook） |
| `<项目>/.claude/{settings.json,settings.local.json}`、`~/.claude/settings.json` 的 `permissions` 与其余顶层键 | —（只报告） | **v1.1 起**：`unsupported-permissions` / `unsupported-settings-keys`（只记键名与条数，**值一律不读**） |
| `<项目>/.claude/agents/*.md`、`~/.claude/agents/*.md` | —（只报告） | **v1.1 起**：`unsupported-agents` —— DSH 的 subagent 是运行时 provider 注册制，**无文件级对等结构** |
| `<项目>/.claude/rules/*.md`（带 frontmatter） | —（只报告） | **v1.1 起**：`unsupported-rules`；无 frontmatter 的纯正文并入全局指令（`instructions-merged`） |

### 3.1 会话转码（v1 已实现）

Claude Code 的对话**不能直接搬**，必须转码 —— 两边落盘形态完全不同：

| | Claude Code | DSH |
|---|---|---|
| 落盘 | `~/.claude/projects/<项目>/<uuid>.jsonl`，纯 JSONL 明文 | `sessions/<projectKey(cwd)>/<id>/session[.vN].jsonl.zstd`，**带校验和的 zstd 帧拼接** |
| 校验 | 无 | 启动时校验「日志位置 == projectKey(header.cwd)/id」，不一致直接 `corrupt session log`（G-23）|

实现要点（每条都是实测或读码结论，不是推测）：

1. **格式版本必须来自目标机**：`header.version` 必须等于**目标机** DSH 的 `SESSION_FORMAT_VERSION`。
   非本 build 的版本会被 DSH 拒绝、且列表里**静默跳过** → 调用方必须传 `targetSessionFormatVersion`；
   本模块实现 **3 与 4**（两代的行式是同一套：同一批产物在两代真 codec 上均 `equivalentToReadPath`），
   其余版本报 `session-format-unsupported`，**不猜**；版本读不到时一条都不转（`session-format-version-unknown`）。
   **按目标版本写，不一律写最高版本** —— 反向不可读（v3 主机读不了 v4 日志）。本机对照：桌面端 0.2.0-rc.2 = **v4**、
   磁盘 CLI 档案 0.1.5-rc.x = **v3**（2026-10-08 真机事故：只认 3 时 v4 目标下整批会话被跳过，包里根本没有 sessions 分区）。
2. **行的形态按 DSH 自己的 codec 对齐**：`user/message`、`assistant/message`、`tool/result` 必须带
   `surfaceOp: "append"`；`request/header` 的空可选字段（如 `tools: []`）必须**省略**；header 的
   `isSeeded` / `delegationDepth` 必填。事件序列：`user/message` → `session/title` → `turn/start` →
   `request/header` → `step/start` → `assistant/message` → `tool/call` → `tool/result` → `step/end` → `turn/end`。
   标题行**跟在首条人类消息之后**：DSH 的 `assertTitleSources` 要求 `messageSeqs` 为空 **⟺** `source.kind === 'user'`，
   非空时每个 seq 必须**早于**本条事件、且指向 `source.kind === 'user'` 的 `user/message`（真机日志同形：
   `{"type":"session/title","seq":12,"messageSeqs":[7],"source":{"kind":"fallback"}}`）。
3. **产物用 DSH 自己的 codec 验过**：`releasedV3SessionFormatCodec` 的 `encodeEvent` →
   `assertV3RowAdmission` → `createDecoder/decodeRow/finish` 三条路径全过
   （回归护栏 `claude-sessions.test.ts` 的 `t3`；取证脚本 `outputs/foreign-import-v1/try-dsh-events.mjs`）。
4. **必须连工作区一起产出**：DSH 工作区按「会话 cwd 目录键 == 工作区 path 目录键」显示会话，
   只给会话不给工作区 = 导入全绿但一条都看不见（本仓真机事故）→ 每个 cwd 产出一条 `workspaces` 记录
   （`id` = `claude-code:<projectKey>`；宿主 `writeRecord` 在新 id 时走 `registry.create(path, title)`，
   由 DSH 自己生成真实 id）。
5. **不迁移**：`isSidechain` 的子代理会话（DSH 要求 `origin='subagent'` 且父对话同批存在）、
   `attachment` / `queue-operation` / `system` 记录 —— 一律按 `unsupported-session-record` 逐类计数上报，绝不静默。

## 4. 安全不变量（本层自己守）

1. **凭据值绝不进包**：MCP 的 `env`/`headers` 过**导出侧同一个** `defaultSecretScanner`（命中字段值置空串、字段名保留），
   URL 的 userinfo（`https://user:pass@host`）由 `stripUserInfo` 额外剥离；命中的只有**引用名**进 `credentialRefs`。
   回归护栏直接对**整份 ZIP 字节**断言「不含凭据明文」（`t2`）。
2. **不猜**：对不上的字段/格式一律进 `skipped`（稳定机器码 + origin + detail），绝不静默丢弃。
3. **不产生用户可见字符串**：findings 只给机器码，文案由 UI 字典映射（i18n 铁律）。
4. 读盘层只读 home 下的固定位置、不跟随符号链接、单文件 8 MiB 上限，超限即**不读并如实计入 `unreadable`**（不截断）。
5. manifest 里不写「外来源」标记：schema v1 无此字段，来源由 CLI/UI 文案告知用户；
   `source.dshVersion` 填**导入目标机**的版本（包是为「现在导入」合成的）。

## 5. 代码落位

| 文件 | 职责 |
|---|---|
| `src/foreign/types.ts` | 机器码、分区产出形态、结果结构 |
| `src/foreign/kernel.ts` | **纯**共享内核（零 fs）：路径/名字安全、SKILL.md frontmatter 校验、MCP 映射与凭据剥离、skill 装配、会话归集（六来源共用） |
| `src/foreign/claude-code.ts` | **纯**翻译（无 fs）：只留 Claude 特有部分；v1 的公共导出原样再导出 |
| `src/foreign/hermes.ts` | **纯**翻译：Hermes 的 config.yaml / SOUL.md / skills → 分区（记忆与会话只报告） |
| `src/foreign/read-hermes.ts` | 读盘（node:fs）：位置解析（HERMES_HOME / %LOCALAPPDATA%\Hermes / ~/.hermes）+ 两层技能 + 点 .env 只 stat 不读 |
| `src/foreign/registry.ts` | 来源注册表契约（接口 / 稳定错误 / 单元 id 命名空间 / 冲突常量），自身不注册具体来源 |
| `src/foreign/registry.test.ts` · `src/foreign/hermes.test.ts` | 契约冻结面 + Hermes 三层护栏（真机取样只断言键名与计数） |
| `src/foreign/read-claude-code.ts` | 读盘（node:fs，宿主侧）：只读固定位置 + 上限 + 如实报错 |
| `src/foreign/bundle.ts` | 分区 → 标准 bundle v1 ZIP（buildManifest + checksums + writeZip，与 sync 侧同一套） |
| `src/foreign/claude-sessions.ts` | **纯**会话转码：Claude JSONL → DSH v3 行 → 带校验和的 zstd 帧 |
| `src/foreign/claude-code.test.ts` | 护栏；`t4`/`t6` 用**真实 Importer** 证明产物可被既有管道消费 |
| `src/foreign/claude-sessions.test.ts` | 形态 / 拒绝面 / **用 DSH 自己的 codec 解码产物**（无 codec 时 skip）|

分层：`src/foreign/` 是**实现层**（与 adapters/sync/market 同级），`tests/architecture-boundaries.test.ts` 的
`LAYER_RULES` 已为它加一条 forbid 规则；**`src/core/` 保持扁平**（该规则的白名单按「深一层」写死，
把子目录塞进 core 会被守卫正确拦下 —— 本次就是被它拦下后才把这一层独立出来的）。

## 6. 后续（未做）

1. **CLI 接线**：`dcm import --from claude-code [--dry-run]`，产出临时 ZIP → 走既有 analyze/plan/execute；零 UI 改动即可验证真实需求。
2. **findings 文案**：`ForeignSkipCode` → zh/en 字典（新增键，7 套字典口径见 DEVELOPERS.md）。
3. **第二个来源**：Cursor（`~/.cursor/mcp.json` 或项目级）与 Codex（`~/.codex/config.toml` 的 `[mcp_servers.*]`）——**未验证**，需先实地取证。
4. **cwd 重定基**：MCP 的 `cwd` 与 skill 内引用外部绝对路径暂不重定基（v1 原样带，属已知缺口）。
5. **凭据补录闭环**：`credentialRefs` 目前只回传给调用方，尚未接进导入计划的 `MissingSecret` 通道。
6. **子代理会话（`isSidechain`）未迁移**：映射到 DSH 的 `origin='subagent'` + `parentSession` 是可行的，
   但要求父对话同批存在（DSH 工作区只显示顶层会话）—— 需要先定「父子一起转、还是整批不转」。

## 7. 待定（需要产品决策）

- CLAUDE.md → AGENTS.md 是「整文件写入（靠冲突判定挡）」还是「合并进既有 AGENTS.md」？v1 选了前者：
  合并需要新的文本合并语义与回滚策略，风险远大于收益。
- 是否允许用户**显式选择**导入 `settings.env` 的凭据值（写进 DSH credentials）？v1 一律不导。

## 8. 30 来源导入契约（6 配置类 v1 冻结 + 24 会话类档 B，2026-10-05）

> 这一节是**实现契约**：v1 的六个配置类来源（claude-code / hermes / cursor / codex / copilot /
> antigravity）与档 B 新增的 **24 个会话类来源**（清单与顺序见 §8.2.2）的并行实现、CLI 接线与
> GUI 入口都以此为唯一依据。改这里 = 改契约，必须同步 src/foreign/types.ts、
> src/foreign/source-modules.ts、src/foreign/truth-table.ts 的护栏测试
> （src/foreign/registry.test.ts / source-registry.test.ts / truth-table.test.ts / file-budget.test.ts）。

### 8.1 来源注册表接口（冻结）

唯一形状来源 = src/foreign/registry.ts（**自身不注册任何具体来源**，装配在宿主入口）：

| 导出 | 作用 |
|---|---|
| ForeignSourceId（types.ts） | 来源 id 词表：claude-code / hermes / cursor / codex / copilot / antigravity |
| FOREIGN_SOURCE_IDS | 同一词表的运行期形态（顺序稳定）；isForeignSourceId() 判定 |
| ForeignSourceContext | 只读上下文：homeDir / env / targetSessionFormatVersion? |
| ForeignSourceDetection | 探测结果：found / paths（相对 home 的 POSIX 路径，**不含值**）/ skipped? |
| ForeignSource | 一个来源：id / labelKey（i18n 键）/ detect() / build() |
| ForeignSourceRegistry · createForeignSourceRegistry() | 注册 / get(id) / has / list / ids / size |
| ForeignSourceError | 稳定错误：code ∈ duplicate-source / unknown-source / invalid-source，带 available 清单 |

五条不得放宽的实现纪律：

1. **detect 只读、幂等、绝不抛**：读不到 → found:false；部分读不到 → found:true + skipped。
   未安装是正常状态，不是错误。
2. **build = 读盘 + 纯翻译、不写盘**：产物是标准 bundle v1 分区载荷；凭据值一律先剥离（§8.6）。
3. **未知 id 一律报错**：get('nope') 抛 ForeignSourceError('unknown-source')，消息带可用来源清单 ——
   **绝不回退到默认来源**（回退会让用户以为导的是 A、实际导的是 B）。
4. **重复注册是装配期错误**：先注册的原样保留，后注册的抛 duplicate-source（不得静默覆盖）。
5. **不产出用户可见字符串**：只有 labelKey 与机器码；文案由 7 套字典映射（i18n 铁律）。

### 8.2 30 来源路径真值表（三平台）

**真值表数据源 = `src/foreign/truth-table.ts` 的 `FOREIGN_TRUTH_TABLES`（30 条，顺序与
`source-modules.ts` / `types.ts` 的 `ForeignSourceId` union 同序）**；`truth-table.test.ts` 拿它与各来源的
`probePaths()` 逐平台交叉核对 —— 注释、数据、实现三者不一致即红灯。下表是它的可读投影。

**取证标注**：**实测取证** = 2026-10-04 在本机（Windows）实际观察到该路径/键名（只记录路径与键名，
**不记录任何值**）；**文档取证** = 官方文档（链接见行尾）。本机没有该来源的（cursor / codex /
copilot）只能文档取证，其验收必须显式标注「文档取证、未经真机验证」。

公共约定：~ = Windows 的 %USERPROFILE%，macOS/Linux 的 $HOME。

**本批三处订正（此前文档 / 任务表写错，以下为准）**：

- **trae 是 SQLite 源，不是文件源**：会话在 `&lt;User&gt;/{globalStorage,workspaceStorage/**}/state.vscdb`
  的 **ItemTable**（键 → 值；值可能是 TEXT 也可能是 BLOB）。初版真值表按「文件」归类，错。
  实现复用 `sqlite.ts` 的只读能力探测，因此也继承 known-gaps **G-32** 的零写入处置。
- **vibe 不是 VS Code 根**：位置是 `&lt;home&gt;/.vibe/logs/session` + 每会话目录里的 `messages.jsonl`，
  **没有任何平台分支**；且 `$VIBE_HOME` 是**追加**（env 根与 `~/.vibe` 根**并存**），**不是替换**。
  初版把它写成 VS Code User 根（并怀疑是 SQLite），错。
- **gemini 是单对象 JSON，不是 JSONL**：`&lt;home&gt;/.gemini/history/&lt;slot&gt;/chats/session-*.json`
  顶层是 `{sessionId, projectHash, startTime, directories[], messages[]}` 的**一个对象**；
  按 JSONL 逐行解析会整份失败（单测用格式化多行夹具钉住）。

**取证边界（「已知不知道」，与实现一起保留，不得美化）**：

- **字段级 schema 未取证**：SQLite 家族的库（opencode / mimocode / kilocode / zcode / teleagent /
  goose / zed / crush）与 **trae 的会话容器**，四份调研报告都只给了**库路径与表名**，没给字段级
  schema。实现因此**一律不写死列名**：`PRAGMA table_info` 自适应列 + 结构自证（表 / 关键列签名），
  认不出来就返回 null 或报码，绝不猜。
- **trae 只有 `memento/icube-ai-agent-storage` 一个 ItemTable 键有确证**；另有「4 个回退键」但
  **四份报告都没给键名** → 用保守键名模式兜底（含 `icube`，或像会话键且明确不是 UI 键）；
  解析不出如实报 `chat-storage-key-not-found`，绝不假装成功。
- **chatgpt 没有 cwd 字段**：导出包里的记录不带 cwd ⇒ 唯一允许的推导是**显式路径所在目录**，
  并如实报 `session-cwd-derived`（进 skipped，绝不静默）；它同时**没有自动根**（`defaults: []`），
  本机自动探测恒 0 命中，恒报 `source-needs-explicit-path`。
- **qwen 的 `&lt;slug&gt;` 编码语义未取证**：qoder 明写 `/`→`-`、workbuddy 明写哈希不可逆，而 qwen
  四份报告只写 `&lt;slug&gt;` ⇒ **不据 slug 推导 cwd**（推导 = 猜）；记录自身没有 cwd 时按
  `session-missing-cwd` 跳过并报码。

#### 8.2.1 六个配置类来源（v1，冻结）

| 来源 | 位置（相对 home） | Windows | macOS | Linux | 取证 |
|---|---|---|---|---|---|
| claude-code | ~/.claude/（实测含 skills/ projects/ settings.json hooks/ plugins/ sessions/ history.jsonl） | %USERPROFILE%\.claude | ~/.claude | ~/.claude | **实测取证** + 文档取证 |
| claude-code | ~/.claude.json（顶层含 mcpServers / projects / numStartups …） | %USERPROFILE%\.claude.json | ~/.claude.json | ~/.claude.json | **实测取证** |
| claude-code | ~/.claude/skills/&lt;名&gt;/SKILL.md、~/.claude/CLAUDE.md、~/.claude/settings.json、~/.claude/projects/&lt;项目&gt;/&lt;uuid&gt;.jsonl | 同左 | 同左 | 同左 | **实测取证** |
| claude-code | 位置可被 CLAUDE_CONFIG_DIR 整体替换 | %CLAUDE_CONFIG_DIR% | $CLAUDE_CONFIG_DIR | $CLAUDE_CONFIG_DIR | 文档取证（code.claude.com/docs/en/settings） |
| hermes | ~/.hermes/；Windows 为 %LOCALAPPDATA%\Hermes | **%LOCALAPPDATA%\Hermes** | ~/.hermes | ~/.hermes | **实测取证**（Windows；本机 HERMES_HOME 亦指向 …\AppData\Local\hermes）+ 文档取证 |
| hermes | config.yaml（顶层键实测含 mcp_servers / model / providers / skills / plugins / platforms / _config_version …） | %LOCALAPPDATA%\Hermes\config.yaml | ~/.hermes/config.yaml | ~/.hermes/config.yaml | **实测取证**（仅键名） |
| hermes | SOUL.md（主身份 → agentInstructions） | …\Hermes\SOUL.md | ~/.hermes/SOUL.md | ~/.hermes/SOUL.md | **实测取证** |
| hermes | memories/MEMORY.md、memories/USER.md（**只报告不导入**） | …\Hermes\memories\ | ~/.hermes/memories/ | ~/.hermes/memories/ | **实测取证** |
| hermes | skills/&lt;分类&gt;/&lt;技能&gt;/SKILL.md（**两层分类**） | …\Hermes\skills\ | ~/.hermes/skills/ | ~/.hermes/skills/ | **实测取证**（如 software-development/dogfood/；也有 se-team-design/SKILL.md 直接躺在分类目录下） |
| hermes | .env、auth.json（**凭据，永不进包**） | …\Hermes\.env | ~/.hermes/.env | ~/.hermes/.env | **实测取证** |
| hermes | 对话存储：state.db（SQLite，实测 84 MB / 88 会话 / 12324 条消息）；回退 sessions/\*.jsonl | …\Hermes\state.db | ~/.hermes/state.db | ~/.hermes/state.db | **实测取证** → **2026-10-06 起迁移**：只读 SQLite 读 sessions+messages 两表（列名变体自适应）→ sessions + workspaces 分区；库打不开/宿主缺 node:sqlite 才报 sessions-not-migrated。sessions/ 里真机只有 request_dump_*.json（请求转储）→ 回退**只认 .jsonl** |
| hermes | plugins/ cron/ hooks/ kanban.db projects.db | 同左 | 同左 | 同左 | **实测取证**（本期不搬） |
| cursor | ~/.cursor/mcp.json（全局）、&lt;项目&gt;/.cursor/mcp.json（项目级；同名 server 项目级优先） | %USERPROFILE%\.cursor\mcp.json | ~/.cursor/mcp.json | ~/.cursor/mcp.json | 文档取证（cursor.com/help/customization/mcp.md）；**本机无 ~/.cursor** |
| cursor | &lt;项目&gt;/.cursor/rules/*.mdc（四种激活：Always / Intelligently / Specific Files / Manually） | 同左 | 同左 | 同左 | 文档取证（cursor.com/help/customization/rules.md） |
| cursor | ~/.cursor/rules/*.mdc（用户规则） | %USERPROFILE%\.cursor\rules\*.mdc | ~/.cursor/rules/*.mdc | ~/.cursor/rules/*.mdc | **文档未列出**（官方称用户规则随账号同步）；本机不可复核 → 存在即读、不存在即跳过，**不得据此产出空分区** |
| cursor | ~/.cursor/skills/**/SKILL.md | %USERPROFILE%\.cursor\skills\ | ~/.cursor/skills/ | ~/.cursor/skills/ | **文档未取证**（同上处理） |
| cursor | .cursorrules（旧式，项目根） | 同左 | 同左 | 同左 | 文档取证 → 报 legacy-rules-file |
| cursor | 会话：~/.cursor/projects/&lt;slug&gt;/agent-transcripts/&lt;composer-uuid&gt;/&lt;composer-uuid&gt;.jsonl | %USERPROFILE%\.cursor\projects\ | 同左 | 同左 | **fixture 取证**（本机无 ~/.cursor，未经真机验证）→ **2026-10-06 起迁移**：逐行 {role, message:{content:[…]}}；首问剥 <user_query>/<timestamp>、[REDACTED] 过滤、tool_use 缺 id 铸兜底；**转录不含 tool_result** → 只发 tool/call；cwd 由 slug 的**存在性贪心解码**还原（解不出即 session-missing-cwd，posix slug 未取证故不解码） |
| codex | ~/.codex/config.toml（用户级）、&lt;项目&gt;/.codex/config.toml（项目级，仅 trust 项目加载） | %USERPROFILE%\.codex\config.toml | ~/.codex/config.toml | ~/.codex/config.toml | 文档取证（developers.openai.com/codex/config-basic）；**本机无 ~/.codex** |
| codex | [mcp_servers.&lt;id&gt;] 的 command / args / env | 同左 | 同左 | 同左 | 文档取证（config-reference） |
| codex | AGENTS.override.md **优先于** AGENTS.md（全局层只取第一个非空文件） | ~/.codex/AGENTS(.override).md | 同左 | 同左 | 文档取证（learn.chatgpt.com/docs/agent-configuration/agents-md） |
| codex | 位置可被 CODEX_HOME 整体替换 | %CODEX_HOME% | $CODEX_HOME | $CODEX_HOME | 文档取证 |
| codex | ~/.agents/skills/**/SKILL.md | %USERPROFILE%\.agents\skills | ~/.agents/skills | ~/.agents/skills | **实测取证**（目录存在、本机为空）+ 文档取证待补（t20 补链接，否则标注「文档未取证」） |
| codex | 会话：&lt;CODEX_HOME&gt;/sessions/YYYY/MM/DD/rollout-*.jsonl 与 &lt;CODEX_HOME&gt;/archived_sessions/** | %USERPROFILE%\.codex\sessions\ | 同左 | 同左 | **fixture 取证**（本机无 ~/.codex，未经真机验证）→ **2026-10-06 起迁移**：逐行 {timestamp,type,payload}；session_meta 取 id/cwd、response_item.message 归一、function_call(_output) 按 call_id 配对；**子代理 rollout（thread_source=subagent / source.subagent）跳过**、fork 保留；reasoning/compacted 只计数（IR 无承载位）；分页 rollout 不归并 |
| copilot | ~/.copilot/（config.json / mcp-config.json / permissions-config.json / agents/ / skills/ / hooks/ / logs/ / session-state/ / session-store.db / installed-plugins/ / ide/） | %USERPROFILE%\.copilot | ~/.copilot | ~/.copilot | 文档取证（docs.github.com「GitHub Copilot CLI configuration directory」）；**本机无 ~/.copilot** |
| copilot | mcp-config.json（用户级 MCP）、skills/&lt;名&gt;/SKILL.md（个人技能，一层） | 同上 | 同上 | 同上 | 文档取证 |
| copilot | 位置可被 COPILOT_HOME 替换；命令行 --config-dir 优先级更高 | %COPILOT_HOME% | $COPILOT_HOME | $COPILOT_HOME | 文档取证 → 命中报 source-location-overridden |
| copilot | copilot-instructions.md / instructions/*.instructions.md | — | — | — | **文档未列出**（CLI 配置目录表里没有；那是 VS Code / 项目级约定）→ 存在即读、不存在不报错，**不得凭空造分区** |
| copilot | 会话（**未实现**）：配置目录表列有 session-state/ 与 session-store.db | — | — | — | **只有位置、没有格式取证**：官方文档未给出会话文件/表结构，参考实现 dsh-chat-import 的 FORMATS 清单里也没有 copilot → 本版**不实现会话导入**（登记为已知缺口，见 known-gaps）。有 2 个以上真实样本（或官方格式说明）后再实现，**绝不按猜的 schema 读库** |
| antigravity | ~/.gemini/config/mcp_config.json（**全局** MCP） | %USERPROFILE%\.gemini\config\mcp_config.json | ~/.gemini/config/mcp_config.json | ~/.gemini/config/mcp_config.json | **实测取证**（存在；本机 **0 字节**）+ 文档取证（antigravity.google/docs/mcp） |
| antigravity | ~/.gemini/antigravity/mcp_config.json（IDE 侧同形位置） | %USERPROFILE%\.gemini\antigravity\mcp_config.json | 同左 | 同左 | **实测取证**（存在；0 字节）；文档未列出 → 兼容位置，两者都探测，空文件报 source-empty-file |
| antigravity | &lt;项目&gt;/.agents/mcp_config.json（workspace 级；remote 用 **serverUrl**，url/httpUrl 已不支持） | 同左 | 同左 | 同左 | 文档取证 |
| antigravity | ~/.gemini/antigravity-cli/plugins/&lt;插件&gt;/{plugin.json,mcp_config.json,hooks.json,skills/,agents/,rules/} + import_manifest.json | %USERPROFILE%\.gemini\antigravity-cli\ | 同左 | 同左 | **实测取证**（antigravity-cli/ 存在：settings.json、conversations/、knowledge/、brain/ …）+ 文档取证（antigravity.google/docs/cli/features） |
| antigravity | ~/.gemini/antigravity/mcp_oauth_tokens.json（**凭据，永不进包**） | 同上 | 同上 | 同上 | 文档取证 |
| antigravity | 会话：三根并列 brain/&lt;convId&gt;/.system_generated/logs/{transcript.jsonl,overview.txt} | %USERPROFILE%\.gemini\{antigravity,antigravity-cli,antigravity-ide}\ | 同左 | 同左 | **实测取证**（本机 antigravity-cli 25 个 + antigravity 2 个会话目录）→ **2026-10-06 起迁移**：逐行 JSON 转录按 USER_INPUT / PLANNER_RESPONSE / GENERIC(DONE) / ERROR_MESSAGE 归一，工具结果按「最早未决调用」配对；标题取 annotations/&lt;id&gt;.pbtxt，cwd 取 tool_calls 的 Cwd 众数；conversations/*.pb\|.db 是 protobuf **不读** |
| antigravity | ~/.antigravity/{argv.json,extensions/} | **实测取证**（非配置导入目标） | — | — | **实测取证** |

**表格的两个直接实现结论**：

- Hermes 的 skills/ 是**两层分类目录**（&lt;分类&gt;/&lt;技能&gt;，也有 &lt;分类&gt;/SKILL.md），
  而 DSH 技能是**单层** &lt;技能名&gt;/SKILL.md（skills 适配器 unitIdOf = 首段）→ 转换期必须压平为
  叶子目录名，并报 skill-category-flattened（**压平是信息损失，必须可见**）；同名冲突先到先得并报
  skill-id-conflict（同 §8.4 语义）。不压平的后果是 DSH 把分类目录当成技能名、子目录里的 SKILL.md
  永不被发现 —— 又一次「导入全绿但一个技能都没出现」。
- Antigravity 的两个 mcp_config.json **本机都是 0 字节** → 0 字节必须报 source-empty-file，
  **绝不产出空 mcp 分区**、绝不抛异常。

#### 8.2.2 24 个会话类来源（档 B，2026-10-05）

令牌：`&lt;home&gt;` = 用户 home；`&lt;appdata&gt;` = Windows `%APPDATA%` / macOS `~/Library/Application Support` / Linux `$XDG_CONFIG_HOME|~/.config`；`&lt;xdgdata&gt;` = Windows `%LOCALAPPDATA%` / macOS `~/Library/Application Support` / Linux `$XDG_DATA_HOME|~/.local/share`。
证据强度直接取自真值表、**不得美化**：全表 30 条 = measured 5（claude-code / hermes / antigravity / dsh / dsh4）+ fixture 23 + documented 2（copilot / chatgpt）。

| 来源 | 默认位置（模板） | 平台差异 / 动态面 | 环境变量（replace / append） | 证据 |
|---|---|---|---|---|
| gemini | `&lt;home&gt;/.gemini/history` | **单对象 JSON**：`&lt;slot&gt;/chats/session-*.json`（顶层 `{sessionId, projectHash, startTime, directories[], messages[]}`；见「订正」） | — | fixture |
| reasonix | `&lt;home&gt;/.reasonix/sessions`（win32 另加 `&lt;appdata&gt;/reasonix`） | 第二根只在 win32 且 `$APPDATA` 存在时加入；`&lt;stem&gt;.jsonl` + 伴生 `&lt;stem&gt;.meta.json` | APPDATA（**append**，仅 win32） | fixture |
| opencode | `&lt;home&gt;/.local/share/opencode/opencode.db` | 三平台同（**win32 也是 ~/.local/share**，不是 %APPDATA%）；V1 表 session/message/part，V2 表按 PRAGMA 自适应 | — | fixture |
| mimocode | `&lt;home&gt;/.local/share/mimocode/mimocode.db` | opencode fork，三表同构 | — | fixture |
| zcode | `&lt;home&gt;/.zcode/cli/db/db.sqlite` | session / message / part 三表 | — | fixture |
| grokbuild | `&lt;home&gt;/.grok/sessions` + `&lt;home&gt;/.grok/archived_sessions`（**双根**） | `&lt;encodeURIComponent(cwd)&gt;/&lt;sessionId&gt;/{summary.json, chat_history.jsonl}` | GROK_HOME（replace） | fixture |
| openclaw | `&lt;home&gt;/.openclaw/agents` | `agents/&lt;agent&gt;/sessions/*.jsonl` + 同目录 `sessions.json` 索引（**只贡献显示名**） | — | fixture |
| pi | `&lt;home&gt;/.pi/agent/sessions` | 列表首行是会话头（不变成消息）；目录名携带 cwd：`--&lt;cwd&gt;--/&lt;timestamp&gt;_&lt;uuid&gt;.jsonl` | — | fixture |
| kimi | `&lt;home&gt;/.kimi/sessions` + `&lt;home&gt;/.kimi-code/sessions`（**双根两代布局**） | 旧目录名 = md5(workdir)，靠 `kimi.json` 反解；新布局 `&lt;workspaceId&gt;/&lt;sid&gt;/agents/main/wire.jsonl` | — | fixture |
| kilocode | `&lt;home&gt;/.local/share/kilo/kilo.db` | opencode 家族三表 | — | fixture |
| qoder | `&lt;home&gt;/.qoder/projects` | `&lt;encoded-project&gt;/&lt;sessionId&gt;.jsonl`；子代理在 `subagents/*.jsonl`，本版**只计数不迁移**（`unsupported-session-record`） | — | fixture |
| chatgpt | **无自动根**（`defaults: []`） | 只能显式给路径；本机自动探测恒 0 命中，恒报 `source-needs-explicit-path` | — | documented |
| workbuddy | `&lt;home&gt;/.workbuddy/projects` | `&lt;project-hash&gt;/&lt;session-uuid&gt;.jsonl`（目录名 = cwd 哈希，**不可逆**）；cwd 只取记录字段，没有就跳过 | — | fixture |
| qwen | `&lt;home&gt;/.qwenworkcn/projects` | `&lt;slug&gt;/&lt;session-uuid&gt;.jsonl`；slug 编码语义未取证（见「取证边界」），不据它推导 cwd | — | fixture |
| continue | `&lt;home&gt;/.continue/sessions` | `&lt;sessionId&gt;.json`（单对象）+ 同目录 `sessions.json` 索引 | CONTINUE_GLOBAL_DIR（**replace** → `&lt;dir&gt;/sessions`；VS Code / JetBrains / CLI 共用一份） | fixture |
| cline | `&lt;home&gt;/.cline/data/sessions` + `&lt;appdata&gt;/Code/User/globalStorage/saoudrizwan.claude-dev` + `Code - Insiders` + `VSCodium` 三个 legacy 根 | 现代 `&lt;sessionId&gt;/{&lt;id&gt;.json,&lt;id&gt;.messages.json,&lt;id&gt;.compaction.json}`；legacy `tasks/&lt;id&gt;/{api_conversation_history,ui_messages}.json` | CLINE_SESSION_DATA_DIR / CLINE_DATA_DIR / CLINE_DIR / CLINE_LEGACY_GLOBAL_STORAGE_DIR / CLINE_VSCODE_GLOBAL_STORAGE_DIR（全 **replace**；两个 legacy override 命中即**只返回该一根**） | fixture |
| goose | win32 `&lt;appdata&gt;/Block/goose/data/sessions/sessions.db`；darwin `~/Library/Application Support/Block/goose/sessions/sessions.db`；linux `&lt;home&gt;/.local/share/goose/sessions/sessions.db` | 三平台分支不同；`sessions{working_dir}` + `messages{content_json}`（旧 `sessions/*.jsonl` **刻意不读**） | GOOSE_PATH_ROOT（replace，**仅绝对路径** → `&lt;root&gt;/data`） | fixture |
| dsh4 | `&lt;home&gt;/.dsh/sessions` | V4 代次；`&lt;projectKey&gt;/&lt;session&gt;/session.v4.jsonl.zstd`，**逐字节直通**（不重编码） | DSH_HOME（replace → `&lt;home&gt;/sessions`） | measured |
| zed | win32 `&lt;xdgdata&gt;/Zed/threads/threads.db`（目录名**大写 Zed**）；darwin `~/Library/Application Support/Zed/threads/threads.db`；linux `&lt;xdgdata&gt;/zed/threads/threads.db` | 单表 `threads(id,summary,updated_at,data_type,data,parent_id,folder_paths,created_at)`；`data` BLOB 恒 zstd | XDG_DATA_HOME（replace，**仅 linux**，仅绝对路径） | fixture |
| crush | `&lt;xdgdata&gt;/crush/projects.json`（用户级只放注册表） | **库在项目里**：`&lt;项目&gt;/.crush/crush.db`，每项目一个库，靠注册表 + 显式 projectDir 探测；缺库报 `crush-db-missing` | CRUSH_GLOBAL_DATA（replace，仅绝对）/ XDG_DATA_HOME（replace，仅 linux，仅绝对） | fixture |
| teleagent | `&lt;home&gt;/.local/share/TeleAgent/users` | **每账户一个库**：`users/&lt;account&gt;/teleagent.db`（opencode 三表同构） | TELEAGENT_HOME（replace → `&lt;home&gt;/users/&lt;account&gt;/teleagent.db`） | fixture |
| trae | `&lt;appdata&gt;/Trae/User`、`&lt;appdata&gt;/Trae CN/User`、`&lt;appdata&gt;/TRAE SOLO CN/User`、`&lt;appdata&gt;/TRAE SOLO/User`（**4 发行版**） | **SQLite**：`&lt;User&gt;/{workspaceStorage,globalStorage/**}/state.vscdb` 的 ItemTable（见「订正」与「取证边界」）；`$APPDATA` 缺失即跳过 | XDG_CONFIG_HOME（replace，仅 linux，仅绝对） | fixture |
| vibe | `&lt;home&gt;/.vibe/logs/session` | **无平台分支**；`session_&lt;ts&gt;_&lt;shortId&gt;/{meta.json, messages.jsonl}` | VIBE_HOME（**append**：env 根与 `~/.vibe` 根**并存**） | fixture |
| dsh | `&lt;home&gt;/.dsh/sessions` | V3 族（v0–v3，按首帧 `header.version` 判定）；`&lt;projectKey&gt;/&lt;session&gt;/session.jsonl.zstd`，**逐字节直通** | DSH_HOME（replace → `&lt;home&gt;/sessions`） | measured |

两条实现结论：① **dsh / dsh4 是同一扫描器与同一装配器的两代次视图**（`read-dsh.ts` + `dsh.ts` 的 `createDshLikeSource`），目标机 `SESSION_FORMAT_VERSION` 不匹配时**刻意一条都不产出**（DSH 会静默跳过非本 build 版本 → 会话列表消失）；② **JSONL / 单对象 JSON 的形态差异必须按源分别处理**（gemini / continue 是单对象，其余多数是 JSONL），按 JSONL 统一解析会把整份读失败。

### 8.3 单元 id 格式（冻结）

**既有 DSH 单元 id（一字不改）**：

| 形态 | 出处 | 例 |
|---|---|---|
| &lt;SectionId&gt;:&lt;单元&gt; | src/adapters/units.ts | skills:bundle-one、mcp:gitnexus、settings:general |
| sessions:&lt;projectKey&gt;/&lt;目录名&gt; | src/adapters/sessions.ts 的 unitIdOf | sessions:--D--proj--x/session-&lt;uuid&gt; |
| plugin:&lt;包名&gt; / patch:&lt;行 id&gt; / workspace:&lt;记录 id&gt; / plugins:patch:&lt;rel&gt; | units.ts 注释 + 插件/工作区适配器 | plugin:left-pad |
| PlanItem 的逐文件 id | src/adapters/file-collection.ts | skills:&lt;名&gt;/SKILL.md |

**外部来源单元 id（新增，来源限定）**：

    foreign:<sourceId>:<sectionId>:<unit>

- 例：foreign:hermes:sessions:--D--proj--x/session-&lt;uuid&gt;、foreign:cursor:skills:my-skill。
- 用途**只有**选择 / 诊断 / 报告（GUI 与 CLI 说清「这条来自哪个来源」）。
- **绝不进入 bundle 相对路径**，**绝不替换** DSH 单元 id：目标机适配器仍按 &lt;section&gt;:&lt;unit&gt; 计算，
  产物与不带来源标记的普通 bundle 完全一致（复用既有管道，不新增写入通道）。
- 外部来源产出的**工作区记录 id** 沿用既有约定 &lt;sourceId&gt;:&lt;projectKey&gt;（v1 已落地
  claude-code:&lt;projectKey&gt;，**30 个来源同一规则**）。

**不重叠是构造性的**（不是靠约定）：foreign 不在 15 个 SectionId 里，也不等于 plugin / patch /
workspace。registry.test.ts 用真实样本**双向**断言：DSH id 恒非外来源形态，外来源 id 恒不落进任何
DSH 命名空间（dshUnitIdNamespaceOf 对两者分别给命名空间与 null）。

**向后兼容方案（additive-only）**：v1 已发布 claude-code 一个值；扩展 = 向 ForeignSourceId union
**追加**值 + 向 FOREIGN_SOURCE_IDS 追加（既有值一字不改）。解析器对未知 source / 未知 section 一律
返回 null（不认识就说不认识，**绝不宽松猜**）——旧版插件遇到新来源 id 会明确报「未知来源」，
而不是把新来源误当旧来源导入。

### 8.4 冲突语义与机器码（冻结）

**用户决策**：同 id 冲突 → **不覆盖、跳过并报码**。

| 场景 | 行为（冻结） | 报告 |
|---|---|---|
| 目标机已存在同 id 会话、内容不同 | 既有管道判 Conflict；**执行期不写**（未决策的 Conflict 不产生写入），计划里可见 | 计划项 kind=Conflict + 既有文案 import.conflictKeepCurrent（skipExisting 策略时 import.conflictSkipExisting） |
| 目标机已存在同 id 会话、内容逐字节相同 | 判 Skip（既有 file-collection 的 contentHash 判据） | 既有 adapter.fileSame |
| 目标机在**另一个 projectKey 下**已有同 id 会话 | **绝不写入**（DSH 启动会报 duplicate JSONL session id … in multiple project directories，见 AGENTS.md 的会话日志硬约束）；跳过并报码 | **session-id-conflict**（实现落点：外部导入预检（宿主已有 homeDir，可查 $DSH_HOME/sessions/*/&lt;id&gt;）或 sessions 侧跨单元检查；不论落点，必须**在计划里可见**） |
| 同一份产物内两条会话解析出同一个 DSH 会话 id | **第一条胜出**，其余逐条跳过；绝不后写覆盖先写 | **session-id-conflict**（origin = 外部会话 id，detail 不含任何内容） |
| 外部技能压平后同名 / 两次来源同名 | 同「先到先得 + 报码」 | **skill-id-conflict** |

**两条禁止（外部来源导入不得打开覆盖通道）**：

1. 不得把冲突项自动解析为 resolution: 'useImported'（那是「用导入覆盖本机」的唯一通道）。
2. 不得对外部来源导入使用全局 replace 策略；宿主/GUI 只允许 merge（默认，冲突留待用户逐条决策）
   或显式 skipExisting。

冻结常量：FOREIGN_SESSION_CONFLICT_CODE = 'session-id-conflict'、
FOREIGN_CONFLICT_POLICY = 'skip-no-overwrite'（ForeignConflictPolicy 是**单值 union** ——
语义上**不存在覆盖分支**，放宽它必须是显式的契约变更）。

### 8.5 机器码命名规范（新增码的流程）

- 形态：&lt;area&gt;-&lt;detail&gt;，全小写 kebab-case；area ∈ source / mcp / skill / session /
  instructions / memory / rule / credential / unsupported。
- 码只描述**事实**，**绝不含值**（凭据名只允许出现在 credentialRefs 的引用名里）。
- 新增码 = ① types.ts 的 ForeignSkipCode 追加；② 本节清单追加；③ zh/en 等 7 套字典补文案
  （**绝不渲染裸枚举**）。
- 本版冻结清单：unsupported-hooks、unsupported-commands、credentials-not-migrated、
  skill-missing-file、skill-invalid-frontmatter、skill-invalid-name、mcp-server-empty、
  mcp-type-sse-coerced、mcp-credential-redacted、source-unreadable、
  session-format-version-unknown、session-format-unsupported、session-missing-cwd、
  session-unsafe-id、session-empty、session-unparsable、unsupported-session-record（以上 v1 既有）+
  session-id-conflict、skill-id-conflict、sessions-not-migrated、memory-report-only、
  skill-category-flattened、legacy-rules-file、instructions-merged、
  instructions-override-selected、source-empty-file、source-location-overridden、
  **session-cwd-derived、source-needs-explicit-path**（本次新增：后两码由档 B 会话类来源使用 ——
  cwd 只能从源侧目录名**推导**（推导结果必须在本机真实存在，推不出来按「缺少 cwd」跳过）/ 该来源
  **没有可自动探测的根**，必须由用户显式给出导出文件路径，自动探测永不命中；两码已在
  `src/foreign/types.ts:162,167` 的 ForeignSkipCode 里，且 zh/en 字典有 `foreign.skip.<码>` 文案）。

### 8.6 六来源共同的安全不变量（与 §4 同源，逐来源点名）

> 本节写于 v1（六个配置类来源）。第 **1 / 5 / 6** 条（凭据值绝不进包 / 只读 home 固定位置与字节上限 / 位置覆盖如实报告）对档 B 的 **24 个会话类来源同样适用**；第 2 / 3 / 4 条是 Hermes / Codex 的逐来源点名，不因新增来源而改变。

1. **凭据值绝不进包**：.env、auth.json、mcp_oauth_tokens.json、MCP 的 env/headers、URL 的
   userinfo —— 过**导出侧同一个** defaultSecretScanner，只留字段名 + 引用名。
2. **Hermes 的用户决策**：SOUL.md → agentInstructions（进包）；memories/MEMORY.md 与
   memories/USER.md **只报告不导入**（memory-report-only，正文绝不进包，对整份 ZIP 字节断言）。
3. **Hermes / Antigravity 对话已迁移**（2026-10-06 用户要求，撤销 v1 的"只报告"决策）：
   两来源都会产出 sessions + workspaces；只有**读不出来**时才报 sessions-not-migrated
   （Hermes：state.db 打不开 / 宿主缺 node:sqlite；Antigravity：三根都没有可读转录）。
   逐条失败的会话按 session-missing-cwd / session-empty / unsupported-session-record 如实可见。
4. **Agent 指令至多一个文件**：agentInstructions 每次导入至多产出 AGENTS.md 一个文件
   （DSH 只读一个全局指令文件）；多来源指令需合并时在转换期合并并报 instructions-merged；
   命中更高优先级文件（Codex 的 AGENTS.override.md）报 instructions-override-selected。
5. **读盘口径沿用 v1**：只读 home 下固定位置、不跟随符号链接、单文件字节上限、超限**不读并如实
   计入 unreadable**（绝不截断）。
6. **位置覆盖如实报告**：CLAUDE_CONFIG_DIR / HERMES_HOME / CODEX_HOME / COPILOT_HOME 命中时报
   source-location-overridden，绝不静默改路径、绝不猜测。

### 8.7 与后续任务的对应关系

| 任务 | 消费本节哪几块 |
|---|---|
| t15（共享内核 + Claude/Hermes） | §8.1 接口、§8.2 Hermes 行、§8.6 的 2/3/4 |
| t16（GUI 字典） | §8.5 码表（每个码一个 zh/en 文案） |
| t17（GUI 入口） | §8.1（来源清单 + detect）、§8.3（来源限定的展示 id） |
| t18 / t19 / t20 / t21（四来源实现） | §8.2 对应行 + §8.5 命名规范 + §8.6 不变量 |
| t22（注册表收口 + CLI + 宿主路由） | §8.1（createForeignSourceRegistry 装配）、§8.3、§8.4 的禁止项 |
| t13 / t14（E2E / 复核） | §8.2 取证标注（四个来源必须写「文档取证、未经真机验证」）、§8.4、§8.6 |

### 8.8 共享内核与 Hermes 落地（t15，2026-10-04）

src/foreign/kernel.ts = 六个来源共用的**纯**内核（零 fs），抽出的是「必须逐字同一套口径」的四件事：
路径/名字安全、SKILL.md frontmatter 校验、MCP 映射与凭据剥离、会话转码结果归集。
claude-code.ts 只保留 Claude 特有部分（~/.claude.json 的 mcpServers 取值、settings.json 的
hooks/env 只读发现、CLAUDE.md → AGENTS.md、commands 计数），并把 v1 的公共导出**原样再导出**
（既有 import 路径与名字不变）；claude-code.test.ts / claude-sessions.test.ts 的断言一行未改。

会话冲突（§8.4 的 session-id-conflict）在**内核**里落地：同一个 DSH 会话 id 只允许出现一次，
第二条起跳过并报码 —— 这一条对六个来源一并生效（同一个 id 落到两个 projectKey 目录下会让
DSH 启动直接报 duplicate JSONL session id）。

Hermes 真实结构决定的三条映射（均由本机实测得出）：

| 事实 | 处理 |
|---|---|
| skills/&lt;分类&gt;/&lt;技能&gt;/SKILL.md 两层；也有 &lt;分类&gt;/SKILL.md（分类自己就是技能） | 技能名取**叶子目录名**（压平），逐条报 skill-category-flattened；分类目录自带 SKILL.md 时其子目录只作为它的资产，不再单独成技能 |
| mcp_servers.&lt;名&gt;.enabled 在 DSH **没有对等字段** | 一律**原样导入**（用户在导入计划里逐条可见、可取消勾选）；不因 enabled:false 静默丢条目 |
| config.yaml 的 mcp_servers 不是「名字 → 定义」映射 | 报 mcp-server-empty（detail=not-a-mapping），绝不静默少一片 |

三条读盘纪律（read-hermes.ts）：.env **只 stat 不读**（值连内存都不进）、memories/*.md
**只列名不读内容**（正文根本没有承载字段）、SOUL.md 进 agentInstructions（空文件不产出分区）。
HERMES_HOME 命中时报 source-location-overridden；config.yaml 为 0 字节时报 source-empty-file。


