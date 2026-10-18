/**
 * 外部 agent 配置 → DSH bundle 的转换层（v1，2026-10-04）。
 *
 * 为什么单独一层，而不是再写一批 ConfigAdapter：
 * `src/adapters/*` 的契约前提是「源机也是 DSH，只是 homeDir 不同」（读写都按 $DSH_HOME 布局、
 * 路径可重定基）。第三方工具没有 $DSH_HOME、没有分区语义，硬套会污染 schema / section-registry /
 * 版本契约 —— 所以本层的职责只有一件事：把外部格式**翻译成标准 bundle v1 的载荷**，
 * 之后完全复用既有管道（Importer.analyzeImport → createImportPlan → executeImportPlan）：
 * 冲突不默认覆盖、导入前强制快照、dry-run、逐条计划可见性全部自动生效。
 *
 * 本层必须自己守住的三条不变量：
 *  ① **凭据值绝不进包**：外部配置里的 token/key（MCP 的 env/headers、settings.env）由
 *     **导出侧同一个** defaultSecretScanner 剥离（命中字段值置空串），只保留字段名 + 一个引用名；
 *     URL 里的 userinfo（https://user:pass@host）额外单独剥离（字段名扫描器看不到它）。
 *  ② **不猜**：对不上的字段/格式一律进 skipped（带稳定机器码），绝不静默丢弃。
 *  ③ **不产生用户可见字符串**：findings 只给机器码，文案由 UI 字典映射（i18n 铁律）。
 */
import type { SectionId } from '../schema/types.ts';
import type { ParsedTranscript } from './session-source.ts';

/**
 * 外部来源 id（**契约冻结**，§8.1/§8.2，2026-10-04；档 B 全量补齐 2026-10-05）。
 *
 * 每个来源一个转换器 + 一个读盘层；id 是稳定机器标识（进 PlanItem 说明、CLI `--from`、宿主路由），
 * **不随文案变化**。新增来源 = 向本 union 追加一个值（additive），既有值一字不改。
 *
 * 档 B（t6）一次补齐 dsh-chat-import 的 `FORMATS` 清单（`lib/discovery.mjs:33-39`，29 项）：
 * 我方的 copilot 不在该清单内（额外来源），其余 29 项**逐项**对应到下面的 id
 * （claude → claude-code、dsh/dsh4 → 同源两代次）。
 *
 * **取证强度逐来源如实标注**（见 registry.ts 的 ForeignSource.evidence 与
 * docs/design/2026-10-04-foreign-import-v1.md §8.2 的真值表）：
 *  - measured ：本机实测（目录/库确实存在过，且读盘层据此实现）
 *  - fixture  ：真机未验证，但有**可复现取证方式**（夹具 + 单测端到端跑同一份布局）
 *  - documented：只有四份调研报告的落点（尚未有可复现夹具时**必须**是这个值）
 *  任何来源都**不得**在未取证的情况下被标成 measured —— 该字段由
 *  `truth-table.test.ts` 与各来源单测共同钉住。
 */
export type ForeignSourceId =
  /* ---- 配置类（v1 既有六个） ---- */
  | 'claude-code'
  | 'hermes'
  | 'cursor'
  | 'codex'
  | 'copilot'
  | 'antigravity'
  /* ---- 会话类（档 B 一次补齐 dsh-chat-import FORMATS 的其余 24 项；顺序 = FORMATS 清单顺序） ---- */
  | 'gemini'
  | 'reasonix'
  | 'opencode'
  | 'mimocode'
  | 'zcode'
  | 'grokbuild'
  | 'openclaw'
  | 'pi'
  | 'kimi'
  | 'kilocode'
  | 'qoder'
  | 'chatgpt'
  | 'workbuddy'
  | 'qwen'
  | 'continue'
  | 'cline'
  | 'goose'
  | 'dsh4'
  | 'zed'
  | 'crush'
  | 'teleagent'
  | 'trae'
  | 'vibe'
  | 'dsh';

/**
 * 取证强度（**如实标注，不可美化**）。
 *
 * 为什么要有这个**类型化**字段：t5 的结论是 cursor / codex 长期处于「文档取证但被列出来」
 * 的状态，而没有任何地方在界面上说明这件事 —— 用户以为「已支持 = 已验证」。
 * 把它变成来源定义的必填字段后，「未验证却列出」在类型层就不可能悄悄发生：
 * 新增来源必须显式回答「我凭什么」，答案落在真值表里并出现在 CLI 摘要里。
 */
export type ForeignEvidenceKind =
  /** 本机实测：真机上确实存在过该布局/库，读盘层据此实现 */
  | 'measured'
  /** 有可复现取证方式：夹具 + 单测端到端跑同一份布局（真机未验证） */
  | 'fixture'
  /** 只有调研报告的落点（真机与夹具都还没有） */
  | 'documented';

/** 未能迁移的外部内容（响亮失败：宁可在计划里报出来，也不静默丢） */
export interface ForeignSkip {
  /** 稳定机器码（UI 用它映射文案；禁止渲染裸枚举） */
  code: ForeignSkipCode;
  /** 外部侧位置（server 名 / skill 名 / 文件名；**不含任何值**） */
  origin?: string;
  /** 机器可读的细分原因（如 no-frontmatter / yaml-error），同样交给 UI 映射 */
  detail?: string;
  /** 同码聚合时的条数 */
  count?: number;
}

export type ForeignSkipCode =
  /** settings.json 的 hooks：DSH 无对等结构 */
  | 'unsupported-hooks'
  /** commands/*.md（斜杠命令）：与 DSH prompts 不是同一语义，本期不搬 */
  | 'unsupported-commands'
  /** settings.json 的 env 里出现凭据名：只计数与记名，**值不读** */
  | 'credentials-not-migrated'
  /** SKILL.md 缺失 */
  | 'skill-missing-file'
  /** frontmatter 不是合法 YAML / 缺 name|description（DSH 会**静默丢弃**该 skill，这里必须报） */
  | 'skill-invalid-frontmatter'
  /** 目录名/文件相对路径非法（含分隔符、.. 等），无法作为 skill 单元 */
  | 'skill-invalid-name'
  /** MCP 条目既无 command 也无 url */
  | 'mcp-server-empty'
  /** MCP type=sse（DSH 只支持 stdio / streamable-http）→ 按带 url 的 http 处理 */
  | 'mcp-type-sse-coerced'
  /** MCP 值里发现凭据字段（值已丢弃，只留字段名与引用名） */
  | 'mcp-credential-redacted'
  /** 外部文件读不到 / 超限 / 解析失败 */
  | 'source-unreadable'
  /** 会话：目标机未提供 DSH 会话格式版本（不猜版本，宁可整批不转） */
  | 'session-format-version-unknown'
  /** 会话：目标机格式版本不是本模块已实现的行式 */
  | 'session-format-unsupported'
  /** 会话：记录里没有 cwd（DSH 要求「日志位置 == projectKey(cwd)/id」，没有 cwd 无法归位） */
  | 'session-missing-cwd'
  /** 会话：文件名不能自证是安全路径段 */
  | 'session-unsafe-id'
  /** 会话：没有任何可迁移的事件 */
  | 'session-empty'
  /** 会话：存在解析不出来的行 */
  | 'session-unparsable'
  /** 会话：某类 Claude 记录本期不迁移（sidechain / attachment / queue-operation / system …） */
  | 'unsupported-session-record'
  /* ---- 六来源契约冻结码（§8.4/§8.5，2026-10-04）：语义以文档为准，实现只允许 additive 扩展 ---- */
  /** 同 id 会话（包内重复 / 目标机已存在，含「另一 projectKey 下同 id」）：**不覆盖、跳过并报码**（用户决策，§8.4） */
  | 'session-id-conflict'
  /** 外部技能重名（压平分类后同名，或两次来源同名）：先到先得，其余跳过并报码（§8.4） */
  | 'skill-id-conflict'
  /** 该来源的对话存储形态本版不迁移（如 Hermes 的 SQLite state.db）：只报告，绝不产出 sessions 分区 */
  | 'sessions-not-migrated'
  /** 记忆文件只报告不导入（如 Hermes memories/MEMORY.md、USER.md）：用户决策，正文绝不进包 */
  | 'memory-report-only'
  /** 外部技能带分类层级（如 Hermes skills/<分类>/<技能>）：压平为 DSH 单层 <技能>/SKILL.md 并报码 */
  | 'skill-category-flattened'
  /** 旧式规则文件（如 .cursorrules）：DSH 无对等结构，只报告 */
  | 'legacy-rules-file'
  /** 多份指令源被合并为单个 AGENTS.md（DSH 只读一个全局指令文件）：如实报告合并来源数 */
  | 'instructions-merged'
  /** 命中更高优先级的指令文件（如 Codex 的 AGENTS.override.md 优先于 AGENTS.md）：报告被选中的那一个 */
  | 'instructions-override-selected'
  /** 配置文件存在但为 0 字节（如实测的 Antigravity mcp_config.json）：报码，绝不产出空分区 */
  | 'source-empty-file'
  /** 配置目录位置被环境变量/命令行覆盖（CLAUDE_CONFIG_DIR / HERMES_HOME / CODEX_HOME / COPILOT_HOME） */
  | 'source-location-overridden'
  /* ---- 档 B（t6）新增两条：把「推导」与「缺路径」也变成可见事实，绝不静默 ---- */
  /**
   * 会话 cwd 由**源侧路径/编码目录名推导**（记录里没有 cwd 字段），且推导结果在本机**真实存在**
   * —— 才允许落盘（存在性检查把「猜」变成「有证据的推断」）；不存在的推导一律按
   * `session-missing-cwd` 跳过，绝不产出一条指向不存在目录的会话。
   */
  | 'session-cwd-derived'
  /**
   * 该来源**没有自动根**（竞品 `defaultRoots.chatgpt = null`）—— 必须由用户显式给出导出文件
   * 路径；本机自动探测永远不会命中，如实报码而不是假装「未安装」。
   */
  | 'source-needs-explicit-path'
  /* ---- 2026-10-18：Claude Code 插件 / 项目级配置 / 权限 / 设置键的如实诊断（纯 additive） ---- */
  /** settings.json 的 permissions（allow/ask/deny）：DSH 无权限规则文件对等结构，只报告条数 */
  | 'unsupported-permissions'
  /** settings.json 里其余未迁移的顶层键（只记键名与条数，**值一律不读**） */
  | 'unsupported-settings-keys'
  /** .claude/agents/*.md 子代理定义：DSH 的 subagent 是运行时 provider 注册制，无文件级对等结构 */
  | 'unsupported-agents'
  /** .claude/rules/*.md 带 frontmatter 作用域：合并进全局指令会丢作用域，故只报告 */
  | 'unsupported-rules'
  /** Claude Code 插件本体（插件 API / hooks / commands 的执行面）：DSH 无法加载，**绝不复制其代码** */
  | 'unsupported-plugins'
  /** 会话记录里的 sessionId 与文件名 stem 不一致（DSH 以目录/文件名定位会话，故以文件名为准并如实报码） */
  | 'session-id-mismatch'
  /** 同名 MCP server 在多处出现（全局 / 项目级 / 插件）：先到先得，其余只报告 */
  | 'mcp-server-id-conflict'
  /** 项目级扫描触顶（maxProjects）：**不静默**，如实报码 */
  | 'project-scan-truncated';

/**
 * 冲突语义（**契约冻结**，§8.4）：同 id 会话恒「不覆盖、跳过并报码」。
 *
 * 该 union 只有一个取值是刻意的 —— 语义上**不存在覆盖分支**：外部来源导入不得打开
 * `resolution: 'useImported'` / 全局 `replace` 策略这两条会写目标机既有会话的通道。
 * 目标机已存在同 id 时，既有管道判为 `Conflict`（未决策 → 执行期不写），并在计划里可见。
 */
export type ForeignConflictPolicy = 'skip-no-overwrite';

/** 一个分区的翻译结果：JSON 类给 data，文件类给 files */
export interface ForeignSectionOut {
  sectionId: SectionId;
  data?: unknown;
  files?: { relativePath: string; data: Uint8Array }[];
}

/* ---------------- 来源侧的输入形态（读盘层产出、翻译层消费） ---------------- */

/** 一个外部 skill 单元：目录名 + 目录内文件（相对该目录） */
export interface ClaudeSkillInput {
  name: string;
  files: { relativePath: string; data: Uint8Array }[];
}

/** Claude Code 用户目录的已读形态（纯数据；翻译层不做任何 fs 访问） */
export interface ClaudeCodeInput {
  /** ~/.claude.json（已解析；缺失或解析失败 = undefined） */
  claudeJson?: unknown;
  /** ~/.claude/settings.json（已解析） */
  settings?: unknown;
  /** ~/.claude/skills/* 的单元（frontmatter 校验在翻译层做） */
  skills?: ClaudeSkillInput[];
  /** ~/.claude/CLAUDE.md 原文（全局指令） */
  memory?: string;
  /** ~/.claude/commands/** 的普通文件数（**递归**；只报不搬） */
  commandCount?: number;
  /** ~/.claude/projects/<项目>/<uuid>.jsonl 的原文（转码在翻译层做） */
  sessions?: ClaudeSessionInput[];
  /**
   * 目标机 DSH 的 SESSION_FORMAT_VERSION（**必须由宿主解析后传入**，见 utils/session-format.ts）。
   * 缺省 = 不转码任何会话并逐条报 session-format-version-unknown，绝不猜版本。
   */
  targetSessionFormatVersion?: number;
  /**
   * 实际使用的 Claude 配置目录绝对路径（CLAUDE_CONFIG_DIR 覆盖时为该值，否则 <home>/.claude）。
   * **只进溯源元数据**，不进任何分区载荷。
   */
  configDir?: string;
  /** 位置被 CLAUDE_CONFIG_DIR 覆盖（命中即报 source-location-overridden） */
  configDirOverridden?: boolean;
  /** 来源侧版本标记（~/.claude.json 的 lastVersionBase 等；拿不到即省略） */
  sourceVersion?: string;
  /** 项目级配置的已读形态（项目根来自 ~/.claude.json 的 projects 键；**不猜路径**） */
  projects?: ClaudeProjectInput[];
  /** 用户级 Claude Code 插件的已读形态（只读元数据与组件，**绝不执行插件代码**） */
  plugins?: ClaudePluginInput[];
  /** 已登记的市场（name + 来源仓库；URL 的 userinfo 已剥离） */
  marketplaces?: { name: string; repo?: string }[];
}

/**
 * 一个 Claude Code **项目级**配置目录的已读形态（纯数据；翻译层不做任何 fs 访问）。
 *
 * 位置口径（实测取证 2026-10-18，本机 ~/.claude.json 的 projects 键）：项目根来自
 * `~/.claude.json` 的 `projects` 键（绝对路径，Claude Code 自己写的权威清单）——
 * **不按目录名猜项目路径**（猜 = 把会话归到不存在的目录）。
 */
export interface ClaudeProjectInput {
  /** 项目根绝对路径（**仅进溯源元数据与报码，不进任何分区载荷**） */
  root: string;
  /** `<root>/.claude` 是否存在（false = 该项目没有 Claude 配置，读盘层不产出任何 finding） */
  hasClaudeDir?: boolean;
  /** `<root>/.claude/settings.json`（已解析） */
  settings?: unknown;
  /** `<root>/.claude/settings.local.json`（已解析；值一律不读，只做诊断） */
  settingsLocal?: unknown;
  /** `<root>/CLAUDE.md` 原文（项目级指令） */
  memory?: string;
  /** `<root>/CLAUDE.local.md` 原文（本地覆盖指令） */
  memoryLocal?: string;
  /** `<root>/.claude/rules/*.md`：文件名 + 原文（带 frontmatter 的按 unsupported-rules 只报告） */
  rules?: { name: string; text: string }[];
  /** `<root>/.mcp.json`（已解析；Claude Code 的项目级 MCP 载体） */
  mcpJson?: unknown;
  /** `~/.claude.json` → `projects[<root>].mcpServers`（已解析） */
  projectMcp?: unknown;
  /** `<root>/.claude/skills/*` 的单元 */
  skills?: ClaudeSkillInput[];
  /** `<root>/.claude/commands/**` 的普通文件数（**递归**；只报不搬） */
  commandCount?: number;
  /** `<root>/.claude/agents/*.md`：名字 + 文件名（只报告，无文件级对等结构） */
  agents?: { name: string; file: string }[];
  /** 读盘层发现的问题（读不到 / 超限 / 非法）——由翻译层原样带出 */
  readFindings?: ForeignSkip[];
}

/**
 * 一个 Claude Code **插件**的已读形态（纯数据）。
 *
 * 三条结构性保证：
 *  ① **只读元数据与组件，绝不执行插件代码**（Claude 插件的 hooks/commands 是 JS 执行面）；
 *  ② 安装位置/来源只进**溯源元数据**（bundle 的 foreign 块），不由本层写进任何分区；
 *  ③ 能无损复用的组件只有 skills 与 .mcp.json 里的 MCP 定义（凭据先剥离），其余一律报码。
 */
export interface ClaudePluginInput {
  /** 插件名（plugin.json 的 name；缺失时回落目录名） */
  name: string;
  /** 插件版本（plugin.json 的 version；缺失即省略） */
  version?: string;
  /** 来源市场名（known_marketplaces.json / marketplace.json 的键） */
  marketplace?: string;
  /** 来源仓库（owner/repo 或 URL；**已剥离 userinfo，绝不含凭据**） */
  repo?: string;
  /** 来源 ref / sha（若有） */
  ref?: string;
  /** 安装位置（相对 ~/.claude/plugins 的 POSIX 相对路径；进溯源用） */
  installRel?: string;
  /** 实际存在的组件种类（skills / commands / agents / hooks / mcp），供诊断文案用 */
  components: string[];
  /** 插件自带的 skills（name = 压平后的技能名） */
  skills?: ClaudeSkillInput[];
  /** 插件自带 `.mcp.json`（已解析） */
  mcpJson?: unknown;
  /** 插件自带 commands 的文件数（**递归**；只报不搬） */
  commandCount?: number;
  /** 插件自带 agents 的文件名（只报告） */
  agents?: string[];
  /** 插件自带 hooks 的文件数（只报告；绝不只是不执行） */
  hookFiles?: number;
  /** 读盘层发现的问题 */
  readFindings?: ForeignSkip[];
}

/** 一个待转码的 Claude Code 会话文件 */
export interface ClaudeSessionInput {
  /** 文件名（不含 .jsonl）；同时作为 DSH 侧会话 id */
  id: string;
  text: string;
  /**
   * 记录里首个出现的 sessionId。与 id（文件名 stem）不一致时由翻译层报 session-id-mismatch：
   * DSH 以「目录名/文件名」定位会话，故仍以文件名为准，但**不静默**。
   */
  recordSessionId?: string;
  /**
   * 确定性 createdAt 回落值（毫秒）：读盘层给「最早可解析记录时间」，没有时间戳时给文件 mtime。
   *
   * 为什么必须由读盘层给：DSH 侧「同内容 → Skip」的判定是**逐字节**的，而会话产物里带着
   * createdAt/updatedAt；若回落用 Date.now()，同一来源转码两次字节必然不同 ⇒ 重复导入恒判
   * Conflict 而不是 Skip（实测缺陷）。由文件自身 mtime 回落即可让转码**幂等**。
   */
  createdAtMs?: number;
}

/* ---------------- Hermes（~/.hermes，Windows 为 %LOCALAPPDATA%\Hermes） ---------------- */

/** 一个 Hermes skill 单元：**已压平**的叶子技能名 + 目录内文件（category 只用于报告，不参与命名） */
export interface HermesSkillInput {
  name: string;
  files: { relativePath: string; data: Uint8Array }[];
  /** 外部侧分类目录名（skills/<分类>/<技能>）——有值即报 skill-category-flattened */
  category?: string;
}

/**
 * 一个已读成**归一记录**的 Hermes 会话（读盘层产出；翻译层只负责装配）。
 *
 * 与 Claude 的 `ClaudeSessionInput`（原文进、翻译层再解析）刻意不同：Hermes 的会话在
 * SQLite（state.db）里，解析**必须**发生在宿主侧的读盘层 —— 那是 `node:sqlite` 动态 import
 * 的唯一边界（见 read-opencode.ts 文件头纪律 ①）。因此在读盘层就已经归一成型，
 * 翻译层保持纯函数、零 fs、零 sqlite。
 */
export interface HermesSessionInput {
  /** 会话 id（state.db 的 sessions.id；同时作为 DSH 侧会话 id） */
  id: string;
  /** 归一记录（读盘层已解析；parsed.raw = 消息行原始条数） */
  parsed: ParsedTranscript;
}

/**
 * Hermes 用户目录的已读形态（纯数据；翻译层不做任何 fs 访问）。
 *
 * 三条**结构性**保证（不是靠翻译层自觉）：
 *  - memories/MEMORY.md、USER.md 的**正文根本不在本结构里**（只有文件名）→ 无从进包；
 *  - .env 只有「存在与否」一个布尔 → 值无从进包；
 *  - 会话只以**已归一记录**进本结构（原始 SQLite 行与库文件都留在宿主侧）。
 */
export interface HermesInput {
  /** config.yaml（已解析；缺失 / 解析失败 / 0 字节 = undefined） */
  config?: unknown;
  /** skills/** 的单元（frontmatter 校验在翻译层做） */
  skills?: HermesSkillInput[];
  /** SOUL.md 原文（主身份 → agentInstructions） */
  soul?: string;
  /** memories/ 下的记忆文件名（**只报告不导入**） */
  memoryFiles?: string[];
  /** .env 是否存在（**只报告**；值绝不读） */
  dotEnvPresent?: boolean;
  /** 会话存储痕迹（state.db / sessions/）：**读不出来**时在这里如实报，绝不静默 */
  sessionStore?: { present: boolean; detail?: string };
  /** state.db（SQLite）里读出的会话（已归一记录；库读不到时回退 sessions/*.jsonl） */
  sessions?: HermesSessionInput[];
  /**
   * 目标机 DSH 的 SESSION_FORMAT_VERSION（**必须由宿主解析后传入**，见 utils/session-format.ts）。
   * 缺省 = 不转码任何会话并逐条报 session-format-version-unknown，绝不猜版本。
   */
  targetSessionFormatVersion?: number;
  /** 读盘层发现的问题（0 字节 / 位置被覆盖 / 读不到）——由翻译层原样带出，调用方无需二次合并 */
  readFindings?: ForeignSkip[];
}

/**
 * 可选上限覆盖（t36）：宿主路由 / CLI **将来**放开上限时的**唯一通道**。
 *
 * 语义：缺省（不传）= 各来源读盘层的默认值**逐字不变**；只有显式给了某个键才覆盖它。
 * 字段 = 各读盘层**已经存在**的可选上限（不新造语义）；装配层把上下文的 limits 原样透传进读器。
 */
export interface ForeignLimitOverrides {
  /** 单文件读取上限（字节；超过即不读并报 source-unreadable/too-large） */
  readonly maxFileBytes?: number;
  /** 单个技能目录的文件数上限（超过即报 source-unreadable/max-skill-files-reached） */
  readonly maxSkillFiles?: number;
  /** 技能数上限（超过即报 source-unreadable/max-skills-reached） */
  readonly maxSkills?: number;
  /** instructions/*.instructions.md 的文件数上限（Copilot 专用） */
  readonly maxInstructionFiles?: number;
  /** 会话条数上限（超过即报 max-sessions-reached） */
  readonly maxSessionFiles?: number;
  /** 目录走盘的文件数上限（reasonix / trae 的会话遍历） */
  readonly maxFiles?: number;
  /** 单会话节点数上限（chatgpt / trae；超过即逐类计数） */
  readonly maxNodes?: number;
}

export interface ForeignImportResult {
  source: ForeignSourceId;
  sections: ForeignSectionOut[];
  skipped: ForeignSkip[];
  /**
   * 发现但**未搬运**的凭据引用名（形如 mcp:gitnexus:GITHUB_TOKEN / settings.env:ANTHROPIC_AUTH_TOKEN）。
   * **只有名字，没有任何值** —— 导入后由用户在 DSH 里补录。
   */
  credentialRefs: string[];
  counts: Record<string, number>;
  /**
   * 溯源块（进 bundle 的 manifest.foreign；缺省 = 不写 —— 旧行为逐字不变）。
   * 由**翻译层**装配（只有它同时看得到位置、项目根与插件清单）。
   */
  origin?: ForeignOrigin;
}

/**
 * 外部来源的**溯源块**（进 bundle 的 manifest.foreign，见 src/schema/types.ts）。
 *
 * 为什么必须有：标准 bundle v1 的 manifest 原本没有任何「这包从哪来」的字段，落盘后
 * 包与 DSH 自产备份**逐字同构**（实测缺陷）—— 事后无法复核来源、兼容性评分也因
 * source.dshVersion 被填成目标机版本而被构造性拉满。
 *
 * 三条纪律：
 *  ① **只放标识与计数，绝不放值**（凭据引用只有名字；错误只有机器码）；
 *  ② 绝对路径只允许出现在 projects[] 与 installPath 这类「用户自己机器的来源位置」上，
 *     且**不得**写进任何分区载荷；
 *  ③ 缺字段即「不知道」，绝不填默认值假装知道。
 */
export interface ForeignOrigin {
  /** 来源 agent id（ForeignSourceId 的运行期字面量） */
  source: string;
  /** 实际读取的位置（相对 home 的 POSIX 路径；不含任何值） */
  locations: string[];
  /** 来源侧版本标记（如 Claude Code `~/.claude.json` 的 lastVersionBase；读不到即省略） */
  sourceVersion?: string;
  /** 被扫描的项目根绝对路径（仅溯源，供用户核对） */
  projects?: string[];
  /** 插件清单（名称 / 版本 / 市场 / 来源仓库 / ref / 组件种类；**不含凭据**） */
  plugins?: {
    name: string;
    version?: string;
    marketplace?: string;
    repo?: string;
    ref?: string;
    components?: string[];
  }[];
  /** 跳过与诊断汇总（机器码 + 条数，**不含任何值**） */
  skipped?: { code: string; count: number }[];
  /** 需要用户在目标机补录的凭据引用名（只有名字） */
  credentialRefs?: string[];
}
