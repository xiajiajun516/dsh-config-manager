/**
 * **来源路径真值表**（档 B 全量补齐的单一事实源 + 机械护栏的输入）。
 *
 * 为什么要有这个文件（不是文档搬家）：验收要求「每个来源有路径真值表依据（四份报告交叉核对）」，
 * 而「真值表」此前**只活在注释里** —— 没有任何机制保证注释里的平台分支与 read-<id>.ts 的实现一致。
 * 本文件把真值表变成**数据**，truth-table.test.ts 再拿它与运行期的 ForeignSource.probePaths()
 * 逐平台交叉核对：注释、数据、实现三者不一致即红灯。
 *
 * 四份报告的交叉核对结论（**有出入以 read-chat-import.md §3 为准，并在此记录差异**）：
 *  ① hermes 的 win32 落点：chat-import 的 defaultRoots 只给 ~/.hermes（discovery.mjs:135），
 *     而 read-claude-move §8.1 与**本仓本机实测**都是 %LOCALAPPDATA%/Hermes。
 *     ⇒ 取并集语义：win32 用 %LOCALAPPDATA%/Hermes（本机实测过），且 HERMES_HOME 覆盖优先
 *     （v1 既有行为不变，本次**不动**该来源的路径表）。
 *  ② codex 是**双根**（sessions + archived_sessions，discovery.mjs:108-110），read-claude-move
 *     只建模了 sessions/**。⇒ 取 chat-import（双根）。
 *  ③ opencode 的 win32 落点：read-claude-move 用 %APPDATA%/opencode，chat-import 与 read-vault
 *     都是 ~/.local/share/opencode（**Windows 同样**）。⇒ 取 chat-import。
 *  ④ $VIBE_HOME 是**追加**（sources/vibe.mjs:40-49 同时 push env 根与 ~/.vibe 根），
 *     而 $CONTINUE_GLOBAL_DIR 是**替换**（discovery.mjs:145-147）；两种语义并存，逐源确认。
 */
import type { ForeignEvidenceKind, ForeignSourceId } from './types.ts';
import type { ForeignPlatform } from './platform-paths.ts';
import { joinFor } from './platform-paths.ts';

/** 一个环境变量覆盖的真值（mode 决定它是替换默认根还是与之并列，逐源不同） */
export interface TruthEnvKey {
  readonly key: string;
  /** replace = 覆盖默认根；append = 与默认根并列（两种语义**并存**，不得一律按替换处理） */
  readonly mode: 'replace' | 'append';
  /** 只在某些平台生效（缺省 = 全部）；护栏只在这些平台上断言覆盖生效 */
  readonly platforms?: readonly ForeignPlatform[];
  /** 只有**绝对路径**才生效（GOOSE_PATH_ROOT / CRUSH_GLOBAL_DATA / XDG_*） */
  readonly absoluteOnly?: boolean;
  readonly note?: string;
}

/** 一个来源的真值表条目 */
export interface ForeignTruthTableEntry {
  readonly id: ForeignSourceId;
  /** 目标平台 → 默认探测位置（令牌模板；home / appdata / xdgdata 三个令牌） */
  readonly defaults: Readonly<Record<ForeignPlatform, readonly string[]>>;
  /** 环境变量覆盖 */
  readonly envKeys?: readonly TruthEnvKey[];
  /** 是否**没有**自动根（只能显式给路径） */
  readonly autoRoots: boolean;
  /** 证据强度（**如实标注**，不得美化） */
  readonly evidence: ForeignEvidenceKind;
  /** 依据（四份报告的落点；交叉核对后的结论写在这里） */
  readonly refs: string;
  /** 该来源还要在运行时**动态枚举**什么（探测面只到静态父目录，文档与评审核对用） */
  readonly dynamic?: string;
}

/* ---------------- 令牌模板 ---------------- */

/** 护栏用**合成**探测值（与平台约定一致；绝不读真机 home —— 那是机器身份） */
export interface TruthProbe {
  readonly homeDir: string;
  readonly appdata: string;
  readonly xdgdata: string;
}

export const TRUTH_PROBES: Readonly<Record<ForeignPlatform, TruthProbe>> = {
  win32: {
    homeDir: joinFor('win32', 'C:', 'probe'),
    appdata: joinFor('win32', 'C:', 'probe', 'AppData', 'Roaming'),
    xdgdata: joinFor('win32', 'C:', 'probe', 'AppData', 'Local'),
  },
  darwin: {
    homeDir: '/Users/probe',
    appdata: '/Users/probe/Library/Application Support',
    xdgdata: '/Users/probe/Library/Application Support',
  },
  linux: {
    homeDir: '/home/probe',
    appdata: '/home/probe/.config',
    xdgdata: '/home/probe/.local/share',
  },
};

/** **空环境**（平台默认根的真值；环境变量覆盖由 envKeys 单独断言） */
export const TRUTH_PROBE_ENV: Readonly<Record<string, string | undefined>> = {};

/** 展开一个令牌模板（未识别的令牌原样保留 —— 那样护栏会立刻红，不会静默给出错路径） */
export function expandTruthTemplate(platform: ForeignPlatform, template: string): string {
  const probe = TRUTH_PROBES[platform];
  let out = template;
  out = out.split('<home>').join(probe.homeDir);
  out = out.split('<appdata>').join(probe.appdata);
  out = out.split('<xdgdata>').join(probe.xdgdata);
  return out;
}

export function expandTruthList(platform: ForeignPlatform, templates: readonly string[]): string[] {
  return templates.map((t) => expandTruthTemplate(platform, t));
}

/* ---------------- 构造小工具（保持条目紧凑、可读） ---------------- */

/** 三平台同形 */
function all3(...paths: readonly string[]): Readonly<Record<ForeignPlatform, readonly string[]>> {
  return { win32: paths, darwin: paths, linux: paths };
}

function perPlatform(
  win32: readonly string[],
  darwin: readonly string[],
  linux: readonly string[],
): Readonly<Record<ForeignPlatform, readonly string[]>> {
  return { win32, darwin, linux };
}

/* ---------------- 真值表本体（**顺序 = FORMATS 清单顺序 + 既有六来源在前**） ---------------- */

export const FOREIGN_TRUTH_TABLES: readonly ForeignTruthTableEntry[] = [
  /* ============ 配置类（v1 既有六个；本次**只补 probePaths/evidence**，路径表不动） ============ */
  {
    id: 'claude-code',
    defaults: all3(
      '<home>/.claude', '<home>/.claude.json', '<home>/.claude/settings.json',
      '<home>/.claude/CLAUDE.md', '<home>/.claude/skills', '<home>/.claude/commands', '<home>/.claude/projects',
      // 2026-10-18 实测补齐：插件注册表（known_marketplaces.json）/ 子代理定义 / 规则目录
      '<home>/.claude/plugins', '<home>/.claude/plugins/known_marketplaces.json',
      '<home>/.claude/agents', '<home>/.claude/rules',
    ),
    envKeys: [{ key: 'CLAUDE_CONFIG_DIR', mode: 'replace', note: '整体替换配置目录（命中即报 source-location-overridden）' }],
    autoRoots: true,
    evidence: 'measured',
    refs: 'chat-import §3.1 claude 行（projects + Claude-3p 第二根）；本仓本机实测（~/.claude、~/.claude.json 存在）；2026-10-18 本机实测 plugins/known_marketplaces.json 与 marketplaces/<市场>/.claude-plugin/{marketplace,plugin}.json 结构',
    dynamic: '会话在 ~/.claude/projects/<slug>/<uuid>.jsonl（v1 已实现会话转码）；项目级配置根来自 ~/.claude.json 的 projects 键（**只取真实存在的目录，绝不猜路径**）；插件启用清单来自 settings.json 的 enabledPlugins（本机缺省为空 = 没有启用的插件，不报码）',
  },
  {
    id: 'hermes',
    defaults: perPlatform(
      [
        '<xdgdata>/Hermes/config.yaml', '<xdgdata>/Hermes/SOUL.md', '<xdgdata>/Hermes/skills',
        '<xdgdata>/Hermes/memories', '<xdgdata>/Hermes/.env', '<xdgdata>/Hermes/state.db',
        '<xdgdata>/Hermes/sessions',
      ],
      [
        '<home>/.hermes/config.yaml', '<home>/.hermes/SOUL.md', '<home>/.hermes/skills',
        '<home>/.hermes/memories', '<home>/.hermes/.env', '<home>/.hermes/state.db',
        '<home>/.hermes/sessions',
      ],
      [
        '<home>/.hermes/config.yaml', '<home>/.hermes/SOUL.md', '<home>/.hermes/skills',
        '<home>/.hermes/memories', '<home>/.hermes/.env', '<home>/.hermes/state.db',
        '<home>/.hermes/sessions',
      ],
    ),
    envKeys: [{ key: 'HERMES_HOME', mode: 'replace', note: '整体替换数据目录' }],
    autoRoots: true,
    evidence: 'measured',
    refs: '本仓本机实测 %LOCALAPPDATA%/Hermes（state.db 84 MiB / 88 会话 / 12324 条消息）；chat-import discovery.mjs:135 只给 ~/.hermes（差异见文件头 ①）',
    dynamic: '会话在 state.db 的 sessions + messages 两表（只读 SQLite，列名变体自适应）；回退 sessions/*.jsonl（**只认 .jsonl**：真机同目录的 request_dump_*.json 是请求转储，不是会话）',
  },
  {
    id: 'cursor',
    defaults: all3(
      '<home>/.cursor/mcp.json', '<home>/.cursor/rules', '<home>/.cursor/skills', '<home>/.cursorrules',
      '<home>/.cursor/projects',
    ),
    envKeys: [],
    autoRoots: true,
    evidence: 'fixture',
    refs: 'chat-import discovery.mjs:111（~/.cursor/projects）；cursor.com/help/customization/{mcp,rules}.md；会话层对照 convert/cursor.mjs + cwd-map.mjs（**真机无 ~/.cursor，未经真机验证**）',
    dynamic: '会话在 ~/.cursor/projects/<slug>/agent-transcripts/<composer-uuid>/<composer-uuid>.jsonl（逐行 {role, message:{content:[…]}}；首问包在 <user_query>/<timestamp> 里）；cwd 由 <slug> 的**存在性贪心解码**还原（解不出即 session-missing-cwd，绝不伪造；posix slug 未取证故不解码）；转录不含 tool_result → 只发 tool/call',
  },
  {
    id: 'codex',
    defaults: all3(
      '<home>/.codex/config.toml', '<home>/.codex/AGENTS.override.md', '<home>/.codex/AGENTS.md', '<home>/.agents/skills',
      '<home>/.codex/sessions', '<home>/.codex/archived_sessions',
    ),
    envKeys: [{ key: 'CODEX_HOME', mode: 'replace' }],
    autoRoots: true,
    evidence: 'fixture',
    refs: 'chat-import discovery.mjs:108-110（双根 sessions + archived_sessions）；夹具 src/foreign/fixtures/codex/',
    dynamic: '会话在 <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl 与 <CODEX_HOME>/archived_sessions/**',
  },
  {
    id: 'copilot',
    defaults: all3(
      '<home>/.copilot/mcp-config.json', '<home>/.copilot/copilot-instructions.md',
      '<home>/.copilot/instructions', '<home>/.copilot/skills',
    ),
    envKeys: [{ key: 'COPILOT_HOME', mode: 'replace' }],
    autoRoots: true,
    evidence: 'documented',
    refs: 'GitHub Copilot CLI 文档（v1 既有；不在 chat-import 的 FORMATS 内 = 我方额外来源）',
  },
  {
    id: 'antigravity',
    defaults: all3(
      '<home>/.gemini/config/mcp_config.json',
      '<home>/.gemini/antigravity/mcp_config.json',
      '<home>/.gemini/antigravity/mcp_oauth_tokens.json',
      '<home>/.gemini/antigravity',
      '<home>/.gemini/antigravity-cli',
      '<home>/.gemini/antigravity-ide',
    ),
    envKeys: [],
    autoRoots: true,
    evidence: 'measured',
    refs: 'chat-import discovery.mjs:113-121（三根并列 antigravity/-cli/-ide）；本仓本机实测 ~/.gemini/**（两个 mcp_config.json 都是 0 字节；会话在三根的 brain/<id>/.system_generated/logs/）',
    dynamic: '会话在三根各自的 brain/<convId>/.system_generated/logs/{transcript.jsonl,overview.txt}（逐行 JSON 转录）；标题取 annotations/<id>.pbtxt；conversations/*.pb|.db 是 protobuf，**不读**',
  },
  /* =================== 会话类：JSONL / 目录源（档 B 补齐） =================== */
  {
    id: 'gemini',
    defaults: all3('<home>/.gemini/history'),
    envKeys: [],
    autoRoots: true,
    evidence: 'fixture',
    refs: 'chat-import discovery.mjs:112 + :940-968；convert/gemini.mjs:21-30（**单对象 JSON，非 JSONL**）',
    dynamic: '<slot>/chats/session-*.json（顶层 {sessionId,projectHash,startTime,directories[],messages[]}）',
  },
  {
    id: 'reasonix',
    defaults: perPlatform(
      ['<home>/.reasonix/sessions', '<appdata>/reasonix'],
      ['<home>/.reasonix/sessions'],
      ['<home>/.reasonix/sessions'],
    ),
    envKeys: [{ key: 'APPDATA', mode: 'append', platforms: ['win32'], note: 'Windows 桌面端第二根' }],
    autoRoots: true,
    evidence: 'fixture',
    refs: 'chat-import discovery.mjs:99,122-124（桌面端根仅在 $APPDATA 存在时加入）',
    dynamic: '<stem>.jsonl + 伴生 sidecar（新版 <stem>.jsonl.meta 的 topic_title/workspace_root/scope；旧版 <stem>.meta.json）与 WAL <stem>.events.jsonl（合并进会话）；桌面布局 projects/<slug>/sessions/** + .titles.json；sidecar 缺席时按 stem 内嵌时间兜底 createdAt；subagent-sub-* 剔除',
  },
  {
    id: 'opencode',
    defaults: all3('<home>/.local/share/opencode/opencode.db'),
    envKeys: [],
    autoRoots: true,
    evidence: 'fixture',
    refs: 'chat-import discovery.mjs:125 + sources/opencode.mjs:33-117（**Windows 同样 ~/.local/share**；read-claude-move 的 %APPDATA% 说法冲突 → 取 chat-import）',
    dynamic: 'V1 表 session/message/part；V2 表 session_v2/session_message（按 PRAGMA 自适应）',
  },
  {
    id: 'mimocode',
    defaults: all3('<home>/.local/share/mimocode/mimocode.db'),
    envKeys: [],
    autoRoots: true,
    evidence: 'fixture',
    refs: 'chat-import discovery.mjs:126 + sources/mimocode.mjs（opencode fork，三表同构）',
  },
  {
    id: 'zcode',
    defaults: all3('<home>/.zcode/cli/db/db.sqlite'),
    envKeys: [],
    autoRoots: true,
    evidence: 'fixture',
    refs: 'chat-import discovery.mjs:131 + sources/zcode.mjs:27-30,37,65（session/message/part）',
  },
  {
    id: 'grokbuild',
    defaults: all3('<home>/.grok/sessions', '<home>/.grok/archived_sessions'),
    envKeys: [{ key: 'GROK_HOME', mode: 'replace', note: '非空即替代 ~/.grok' }],
    autoRoots: true,
    evidence: 'fixture',
    refs: 'chat-import discovery.mjs:101-103,132（**双根** sessions + archived_sessions）',
    dynamic: '以「含 summary.json 的目录」递归识别（不再固定两层）；summary.json 取 info.id/info.cwd 与 generated_title|session_summary；chat_history.jsonl 按 {type,…} 解析并把顶层 tool_calls 与 type:"tool_result" 按 callId 配对；synthetic_reason 注入行不进正文',
  },
  {
    id: 'openclaw',
    defaults: all3('<home>/.openclaw/agents'),
    envKeys: [],
    autoRoots: true,
    evidence: 'fixture',
    refs: 'chat-import discovery.mjs:133 + convert/openclaw.mjs:3-19',
    dynamic: 'agents/<agent>/sessions/*.jsonl + 同目录 sessions.json 索引（displayName）',
  },
  {
    id: 'pi',
    defaults: all3('<home>/.pi/agent/sessions'),
    envKeys: [],
    autoRoots: true,
    evidence: 'fixture',
    refs: 'chat-import discovery.mjs:134 + convert/pi.mjs:14-27（首行 session 头，其余 id/parentId 成树）',
    dynamic: '--<cwd>--/<timestamp>_<uuid>.jsonl（目录名携带 cwd）',
  },
  {
    id: 'kimi',
    defaults: all3(
      '<home>/.kimi/sessions', '<home>/.kimi/kimi.json',
      '<home>/.kimi-code/sessions', '<home>/.kimi-code/workspaces.json',
    ),
    envKeys: [],
    autoRoots: true,
    evidence: 'fixture',
    refs: 'chat-import discovery.mjs:136 + convert/kimi.mjs:3-11（**双根两代布局**；旧目录名 = md5(workdir)，靠 kimi.json 反解）',
    dynamic: '旧：<md5(workdir)>/<sid>/{wire.jsonl,context.jsonl,state.json}；新：<workspaceId>/<sid>/agents/main/wire.jsonl + state.json',
  },
  {
    id: 'kilocode',
    defaults: all3('<home>/.local/share/kilo/kilo.db'),
    envKeys: [],
    autoRoots: true,
    evidence: 'fixture',
    refs: 'chat-import discovery.mjs:130 + sources/kilocode.mjs:24,34,36,63,65',
  },
  {
    id: 'qoder',
    defaults: all3('<home>/.qoder/projects'),
    envKeys: [],
    autoRoots: true,
    evidence: 'fixture',
    refs: 'chat-import discovery.mjs:137 + convert/qoder.mjs:3-16（目录名 = cwd 的 /→- 编码）',
    dynamic: '<encoded-project>/<sessionId>.jsonl（子代理在 <sessionId>/subagents/*.jsonl）',
  },
  {
    id: 'chatgpt',
    defaults: all3(),
    envKeys: [],
    autoRoots: false,
    evidence: 'documented',
    refs: 'chat-import discovery.mjs:164（defaultRoots.chatgpt = null）+ :1861 + convert/chatgpt.mjs:12-15',
    dynamic: '**只能显式给路径**：本机自动探测永远为 0 命中（如实报 source-needs-explicit-path）',
  },
  {
    id: 'workbuddy',
    defaults: all3('<home>/.workbuddy/projects'),
    envKeys: [],
    autoRoots: true,
    evidence: 'fixture',
    refs: 'chat-import discovery.mjs:138 + convert/workbuddy.mjs:3-18（目录名 = cwd 哈希，**不可逆**）',
    dynamic: '<project-hash>/<session-uuid>.jsonl（cwd 只能取记录字段；没有就如实跳过，绝不猜）',
  },
  {
    id: 'qwen',
    defaults: all3('<home>/.qwenworkcn/projects'),
    envKeys: [],
    autoRoots: true,
    evidence: 'fixture',
    refs: 'chat-import discovery.mjs:139 + convert/qwen.mjs:1-21（千问办公）',
    dynamic: '<slug>/<session-uuid>.jsonl',
  },
  {
    id: 'continue',
    defaults: all3('<home>/.continue/sessions'),
    envKeys: [{ key: 'CONTINUE_GLOBAL_DIR', mode: 'replace', note: '**整体替换**默认根（→ <dir>/sessions）' }],
    autoRoots: true,
    evidence: 'fixture',
    refs: 'chat-import discovery.mjs:142-147（VS Code / JetBrains / CLI 共用同一份）',
    dynamic: '<sessionId>.json（单对象）+ 同目录 sessions.json 索引',
  },
  {
    id: 'cline',
    defaults: all3(
      '<home>/.cline/data/sessions',
      '<appdata>/Code/User/globalStorage/saoudrizwan.claude-dev',
      '<appdata>/Code - Insiders/User/globalStorage/saoudrizwan.claude-dev',
      '<appdata>/VSCodium/User/globalStorage/saoudrizwan.claude-dev',
    ),
    envKeys: [
      { key: 'CLINE_SESSION_DATA_DIR', mode: 'replace' },
      { key: 'CLINE_DATA_DIR', mode: 'replace', note: '→ <dir>/sessions' },
      { key: 'CLINE_DIR', mode: 'replace', note: '→ <dir>/data/sessions' },
      { key: 'CLINE_LEGACY_GLOBAL_STORAGE_DIR', mode: 'replace', note: '命中即**只返回该一个** legacy 根' },
      { key: 'CLINE_VSCODE_GLOBAL_STORAGE_DIR', mode: 'replace', note: '同上（低优先级）' },
    ],
    autoRoots: true,
    evidence: 'fixture',
    refs: 'chat-import discovery.mjs:47-78,148-154 + :2094（legacy tasks/<id>/{api_conversation_history,ui_messages}.json）',
    dynamic: '现代 <sessionId>/{<id>.json,<id>.messages.json,<id>.compaction.json}；legacy 三个 VS Code globalStorage',
  },
  {
    id: 'goose',
    defaults: perPlatform(
      ['<appdata>/Block/goose/data/sessions/sessions.db'],
      ['<home>/Library/Application Support/Block/goose/sessions/sessions.db'],
      ['<home>/.local/share/goose/sessions/sessions.db'],
    ),
    envKeys: [{ key: 'GOOSE_PATH_ROOT', mode: 'replace', absoluteOnly: true, note: '**仅绝对路径**生效 → <root>/data' }],
    autoRoots: true,
    evidence: 'fixture',
    refs: 'read-vault §10.1 goose 行 + chat-import convert/goose.mjs:58-75/sources/goose.mjs:92-123（旧 sessions/*.jsonl 刻意不读）',
    dynamic: '表 sessions{id,session_type,working_dir} + messages{session_id,content_json}',
  },
  {
    id: 'dsh4',
    defaults: all3('<home>/.dsh/sessions'),
    envKeys: [{ key: 'DSH_HOME', mode: 'replace', note: '→ <home>/sessions' }],
    autoRoots: true,
    evidence: 'measured',
    refs: 'chat-import discovery.mjs:165-169 + sources/dsh.mjs:8-25（dsh/dsh4 同根，按日志代次过滤：dsh4 = V4）',
    dynamic: '<projectKey>/<session>/session.v4.jsonl.zstd（**逐字节直通**，不重新编码）',
  },
  {
    id: 'zed',
    defaults: perPlatform(
      ['<xdgdata>/Zed/threads/threads.db'],
      ['<home>/Library/Application Support/Zed/threads/threads.db'],
      ['<xdgdata>/zed/threads/threads.db'],
    ),
    envKeys: [{ key: 'XDG_DATA_HOME', mode: 'replace', absoluteOnly: true, platforms: ['linux'], note: '仅 linux 列生效' }],
    autoRoots: true,
    evidence: 'fixture',
    refs: 'read-vault §10.1 zed 行 + chat-import convert/zed.mjs:63-84（win32 目录名**大写 Zed**；data BLOB 恒 zstd）',
    dynamic: '单表 threads(id,summary,updated_at,data_type,data,parent_id,folder_paths,created_at)',
  },
  {
    id: 'crush',
    defaults: all3('<xdgdata>/crush/projects.json'),
    envKeys: [
      { key: 'CRUSH_GLOBAL_DATA', mode: 'replace', absoluteOnly: true },
      { key: 'XDG_DATA_HOME', mode: 'replace', absoluteOnly: true, platforms: ['linux'] },
    ],
    autoRoots: true,
    evidence: 'fixture',
    refs: 'read-vault §10.1 crush 行 + chat-import convert/crush.mjs:54-76/sources/crush.mjs:43-76（**库在项目里**）',
    dynamic: '用户级只放 projects.json；库 = <项目>/.crush/crush.db（每项目一个库，靠注册表 + 显式 projectDir 探测）',
  },
  {
    id: 'teleagent',
    defaults: all3('<home>/.local/share/TeleAgent/users'),
    envKeys: [{ key: 'TELEAGENT_HOME', mode: 'replace', note: '→ <home>/users/<account>/teleagent.db' }],
    autoRoots: true,
    evidence: 'fixture',
    refs: 'chat-import discovery.mjs:127-129,1211-1223 + sources/teleagent.mjs:23-42（**每账户一个库**）',
    dynamic: 'users/<account>/teleagent.db（枚举账户目录；opencode 三表同构）',
  },
  {
    id: 'trae',
    defaults: all3(
      '<appdata>/Trae/User',
      '<appdata>/Trae CN/User',
      '<appdata>/TRAE SOLO CN/User',
      '<appdata>/TRAE SOLO/User',
    ),
    envKeys: [{ key: 'XDG_CONFIG_HOME', mode: 'replace', absoluteOnly: true, platforms: ['linux'] }],
    autoRoots: true,
    evidence: 'fixture',
    refs: 'read-vault §10.1 trae 行 + chat-import discovery.mjs:80-93,140,2386（**4 个发行版** × 三分支；$APPDATA 缺失即跳过）',
    dynamic: '<User>/{workspaceStorage,globalStorage}/**/state.vscdb（SQLite ItemTable；键 memento/icube-ai-agent-storage + 4 回退键）',
  },
  {
    id: 'vibe',
    defaults: all3('<home>/.vibe/logs/session'),
    envKeys: [{ key: 'VIBE_HOME', mode: 'append', note: '**追加**（不是替换）：env 根与 ~/.vibe 根并存' }],
    autoRoots: true,
    evidence: 'fixture',
    refs: 'read-vault §10.1 vibe 行 + chat-import sources/vibe.mjs:37-49（**多根叠加**）',
    dynamic: 'session_<ts>_<shortId>/{meta.json, messages.jsonl}',
  },
  {
    id: 'dsh',
    defaults: all3('<home>/.dsh/sessions'),
    envKeys: [{ key: 'DSH_HOME', mode: 'replace', note: '→ <home>/sessions' }],
    autoRoots: true,
    evidence: 'measured',
    refs: 'chat-import discovery.mjs:165-169 + sources/dsh.mjs:8-25（dsh = V3，含 v0–v3 代次）',
    dynamic: '<projectKey>/<session>/session.jsonl.zstd（v0 无后缀；vN 带 .vN）；**逐字节直通**',
  },
];
