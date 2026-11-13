/**
 * 外部 agent 导入的**共享内核**（纯函数，零 fs、零 I/O）。
 *
 * 为什么要有这一层：Claude Code 与 Hermes（以及后续 Cursor / Codex / Copilot / Antigravity）的
 * 外部格式各不相同，但有四件事**必须逐字同一套口径**——各写一份必然分叉，而分叉的后果都是
 * 「导入全绿但东西不出现」或「凭据进了包」：
 *  ① 路径/名字安全（Zip Slip 同向但更保守的判据；非法一律进 skipped，绝不静默丢弃）
 *  ② SKILL.md frontmatter 校验（DSH 对非法 frontmatter 是**静默丢弃**该 skill，必须在这里报）
 *  ③ MCP 条目映射 + 凭据剥离（URL userinfo + 与导出侧**同一个** defaultSecretScanner）
 *  ④ 会话转码结果的归集（sessions + workspaces 两个分区、同 id 冲突拦截）
 *
 * 本模块**不做任何 fs 访问**：读盘在各来源自己的 read-*.ts 里（node:fs），
 * 翻译层只消费已经读好的纯数据，因此全部可在单测里构造。
 */
import * as yaml from 'js-yaml';

import { defaultSecretScanner } from '../core/exporter.ts';
import { matchSecretValuePattern, REDACTED_PLACEHOLDER } from '../security/secret-scanner.ts';
import { isRecord } from '../utils/guards.ts';
import type { McpSection, McpServerEntry, WorkspaceRecord, WorkspacesSection } from '../schema/types.ts';
import type { ForeignSectionOut, ForeignSkip, ForeignSkipCode } from './types.ts';

const TEXT = new TextEncoder();
const DECODER = new TextDecoder();
/** 反斜杠字符（用 fromCharCode 而非字面量：本文件刻意不出现任何正则与转义字面量） */
const BACKSLASH = String.fromCharCode(92);

/** UTF-8 编码（各来源产出文件类分区时共用，避免各自 new TextEncoder） */
export function utf8(s: string): Uint8Array {
  return TEXT.encode(s);
}

/** UTF-8 解码（frontmatter 校验要读 SKILL.md 文本） */
export function textOf(data: Uint8Array): string {
  return DECODER.decode(data);
}

/* ---------------- ① 路径与名字安全 ---------------- */

/** 单元名：非空、无首尾空白、不含分隔符/盘符冒号、不是 . 或 .. */
export function isSafeUnitName(name: string): boolean {
  if (name === '' || name === '.' || name === '..') return false;
  if (name.trim() !== name) return false;
  if (name.indexOf('/') >= 0) return false;
  if (name.indexOf(BACKSLASH) >= 0) return false;
  if (name.indexOf(':') >= 0) return false;
  return true;
}

/** 包内相对路径：只允许普通段（拒绝空段 / . / .. / 绝对路径 / 尾随斜杠） */
export function isSafeRelPath(rel: string): boolean {
  if (rel === '') return false;
  if (rel.charAt(0) === '/') return false;
  if (rel.charAt(0) === BACKSLASH) return false;
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

/* ---------------- ② SKILL.md frontmatter 校验 ---------------- */

export interface FrontmatterSplit { raw: string; body: string }

/** 逐行切 frontmatter（刻意不用正则：正则源里的转义很容易在跨层写入时被解释掉） */
export function splitFrontmatter(text: string): FrontmatterSplit | null {
  const lines = text.split('\n');
  const first = lines[0];
  if (first === undefined || first.trim() !== '---') return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? '').trim() === '---') { end = i; break; }
  }
  if (end < 0) return null;
  return { raw: lines.slice(1, end).join('\n'), body: lines.slice(end + 1).join('\n') };
}

/**
 * null = 可被 DSH 正常加载；否则返回机器可读原因。
 *
 * 为什么必须在这里判：DSH 的 skill 发现对**非法 YAML 的 frontmatter 是静默丢弃**的
 * （本仓库实测过：description 这类 plain scalar 里出现 ": " 会让 yaml.parse 抛错，
 * 整个 skill 从 catalog 消失、没有任何 UI 提示）。不在这里报出来，
 * 用户看到的就是「我从外部工具导入了 N 个 skill，导入成功，但一个都没出现」。
 */
export function frontmatterProblem(text: string): string | null {
  const fm = splitFrontmatter(text);
  if (fm === null) return 'no-frontmatter';
  let parsed: unknown;
  try {
    parsed = yaml.load(fm.raw);
  } catch {
    return 'yaml-error';
  }
  if (!isRecord(parsed)) return 'not-mapping';
  const name = parsed['name'];
  const description = parsed['description'];
  if (typeof name !== 'string' || name.trim() === '') return 'no-name';
  if (typeof description !== 'string' || description.trim() === '') return 'no-description';
  return null;
}

/* ---------------- ③ 通用取值小工具（不用正则） ---------------- */

export function stringMapOf(v: unknown): Record<string, string> {
  if (!isRecord(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'string') out[k] = val;
  }
  return out;
}

export function stringArrayOf(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

/** 剥离 URL 里的 userinfo（https://user:pass@host → https://host）；纯字符判定，不用正则 */
export function stripUserInfo(url: string): { url: string; stripped: boolean } {
  const scheme = url.indexOf('://');
  if (scheme < 0) return { url, stripped: false };
  const rest = url.slice(scheme + 3);
  const at = rest.indexOf('@');
  if (at < 0) return { url, stripped: false };
  /**
   * userinfo 只可能出现在 authority 段里：@ 若落在第一个 '/'、'?' 或 '#' 之后，
   * 它就是 path/query/fragment 里的普通字符（无路径 URL 的 `?k=a@b` 曾把整条 URL 截成 `https://b`）。
   * 纯字符判定，不用正则。
   */
  const boundary = [rest.indexOf('/'), rest.indexOf('?'), rest.indexOf('#')]
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)[0];
  if (boundary !== undefined && at > boundary) return { url, stripped: false };
  return { url: url.slice(0, scheme + 3) + rest.slice(at + 1), stripped: true };
}

/* ---------------- ③ MCP 映射 + 凭据剥离 ---------------- */

/**
 * 单个 server 定义 → McpServerEntry。
 * type 判定与 adapters/mcp.ts 的 extractMcpServers **同口径**：有非空 url 即 streamable-http，否则 stdio。
 * 刻意**不写 sourceLineId**：缺省时 adapter 会用 newLineId(serverName) 生成，
 * 而自己编一个 id 有撞上目标机既有 patch 行 id 的风险。
 */
export function mcpEntryOf(name: string, raw: unknown, skipped: ForeignSkip[]): McpServerEntry | null {
  if (!isRecord(raw)) {
    skipped.push({ code: 'mcp-server-empty', origin: name });
    return null;
  }
  const rawUrl = typeof raw['url'] === 'string' && raw['url'] !== '' ? raw['url'] : undefined;
  const command = typeof raw['command'] === 'string' && raw['command'] !== '' ? raw['command'] : undefined;
  if (rawUrl === undefined && command === undefined) {
    skipped.push({ code: 'mcp-server-empty', origin: name });
    return null;
  }
  const declared = typeof raw['type'] === 'string' ? raw['type'].toLowerCase() : '';
  if (declared === 'sse') skipped.push({ code: 'mcp-type-sse-coerced', origin: name });

  const entry: McpServerEntry = {
    serverName: name,
    type: rawUrl !== undefined ? 'streamable-http' : 'stdio',
  };
  if (rawUrl !== undefined) entry.url = rawUrl;
  if (command !== undefined) entry.command = command;
  const args = stringArrayOf(raw['args']);
  if (args.length > 0) entry.args = args;
  const env = stringMapOf(raw['env']);
  if (Object.keys(env).length > 0) entry.env = env;
  const headers = stringMapOf(raw['headers']);
  if (Object.keys(headers).length > 0) entry.headers = headers;
  if (typeof raw['cwd'] === 'string' && raw['cwd'] !== '') entry.cwd = raw['cwd'];
  return entry;
}

/** 从 hits 路径（servers[3].env.KEY）反查 server 名，用于生成可读的凭据引用名 */
function serverNameOfHit(path: string, section: McpSection): string | null {
  const prefix = 'servers[';
  if (!path.startsWith(prefix)) return null;
  const close = path.indexOf(']');
  if (close < 0) return null;
  const idx = Number(path.slice(prefix.length, close));
  if (!Number.isInteger(idx) || idx < 0) return null;
  return section.servers[idx]?.serverName ?? null;
}

/** 整值剥离：非空且命中**真值形状**（含示例形态降噪）→ 置空（与 args 同一条判据）。
 *
 * 口径澄清（t72 / t58-F3）：降噪判定作用在**命中片段**上，而 `sk-…` 这类命中片段**本身不含尖括号**
 * ⇒ `env:{K:'<sk-abcdefgh1234>'}` 的整值仍会被剥空。**这是有意保留的口径**：值形状通道只认「形状」，
 * 尖括号占位符也按真实形状处理（多剥是安全方向；漏剥才是缺陷）。 */
function redactValueShapeWhole(value: string | undefined): { value: string | undefined; redacted: number } {
  if (value === undefined || value === '') return { value, redacted: 0 };
  if (matchSecretValuePattern(value) === null) return { value, redacted: 0 };
  return { value: REDACTED_PLACEHOLDER, redacted: 1 };
}

/** 字符串映射（env / headers）逐值剥离：返回原对象（未命中）或新对象 */
function redactValueShapeMap(
  map: Record<string, string> | undefined,
): { map: Record<string, string> | undefined; redacted: number } {
  if (map === undefined) return { map, redacted: 0 };
  let redacted = 0;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    if (v !== '' && matchSecretValuePattern(v) !== null) {
      out[k] = REDACTED_PLACEHOLDER;
      redacted += 1;
    } else {
      out[k] = v;
    }
  }
  return redacted === 0 ? { map, redacted: 0 } : { map: out, redacted };
}

/**
 * 非字符串载体归一化（t72 / t58-F2）：env / headers 只留字符串值、args 只留字符串元素，被滤空的
 * 字段直接删掉 —— 与上游 `mcpEntryOf`（`stringMapOf` / `stringArrayOf`）**同口径**。
 *
 * 为什么要在本函数里再做一次：这条保证此前只活在上游调用方（`mcpSectionFromEntries` / `mcpEntryOf`），
 * 而 `redactMcpSection` 是 **exported** 的（`antigravity.ts` 直连它）—— 将来任何直连调用方省掉过滤，
 * 都会把 `env:{A:{nested:'sk-…'}}` 这类**非字符串载体**连同明文一起原样写进包（值形状判定对它们无意义）。
 * 语义选择：**丢弃**（不是置空）—— 非字符串载体是契约外形态，留着就等于把不可信结构带进包。
 */
function withStringCarriersOnly(s: McpServerEntry): McpServerEntry {
  const out: McpServerEntry = { ...s };
  if (out.env !== undefined) {
    const env = stringMapOf(out.env);
    if (Object.keys(env).length > 0) out.env = env;
    else delete out.env;
  }
  if (out.headers !== undefined) {
    const headers = stringMapOf(out.headers);
    if (Object.keys(headers).length > 0) out.headers = headers;
    else delete out.headers;
  }
  if (out.args !== undefined) {
    const args = stringArrayOf(out.args);
    if (args.length > 0) out.args = args;
    else delete out.args;
  }
  return out;
}

/**
 * URL 里的值形状片段：**逐段**判定（path 的每个段 / query 的 `k=v` 的 v / 无 = 的整段）。
 * userinfo 由 stripUserInfo 负责，这里不重复。逐段判定刻意不需要「命中片段」文本
 * （公开 API 只给模式名）→ 命中即把该段置空，URL 其余部分保持可用；若剥离后整串仍是真值形状
 * （secret 落在 authority 这类没被逐段覆盖的位置）→ 整串置空兜底。
 */
function redactValueShapeInUrl(url: string): { url: string; redacted: number } {
  const q = url.indexOf('?');
  const beforeQuery = q >= 0 ? url.slice(0, q) : url;
  const query = q >= 0 ? url.slice(q + 1) : null;
  let redacted = 0;
  let head = beforeQuery;
  const schemeIdx = beforeQuery.indexOf('://');
  const authorityStart = schemeIdx >= 0 ? schemeIdx + 3 : 0;
  const slashIdx = beforeQuery.indexOf('/', authorityStart);
  if (slashIdx >= 0) {
    const segments = beforeQuery.slice(slashIdx + 1).split('/').map((seg): string => {
      if (seg !== '' && matchSecretValuePattern(seg) !== null) {
        redacted += 1;
        return REDACTED_PLACEHOLDER;
      }
      return seg;
    });
    head = beforeQuery.slice(0, slashIdx + 1) + segments.join('/');
  }
  let out = head;
  if (query !== null) {
    const parts = query.split('&').map((pair): string => {
      const eq = pair.indexOf('=');
      if (eq < 0) {
        if (pair !== '' && matchSecretValuePattern(pair) !== null) {
          redacted += 1;
          return REDACTED_PLACEHOLDER;
        }
        return pair;
      }
      const value = pair.slice(eq + 1);
      if (value !== '' && matchSecretValuePattern(value) !== null) {
        redacted += 1;
        return pair.slice(0, eq + 1) + REDACTED_PLACEHOLDER;
      }
      return pair;
    });
    out = head + '?' + parts.join('&');
  }
  if (matchSecretValuePattern(out) !== null) {
    return { url: REDACTED_PLACEHOLDER, redacted: redacted + 1 };
  }
  return { url: out, redacted };
}

/** 剥离 MCP 里的凭据：URL userinfo + 字段名扫描（与导出侧同一个扫描器）+ 值形状判定 */
export function redactMcpSection(section: McpSection, refs: string[], skipped: ForeignSkip[]): McpSection {
  const servers = section.servers.map((s): McpServerEntry => {
    if (s.url === undefined) return s;
    const r = stripUserInfo(s.url);
    if (!r.stripped) return s;
    refs.push('mcp:' + s.serverName + ':url');
    skipped.push({ code: 'mcp-credential-redacted', origin: s.serverName + ':url' });
    return { ...s, url: r.url };
  });
  const { sanitized, hits } = defaultSecretScanner().scanAndRedact({ version: 1, servers });
  const clean = sanitized as McpSection;
  for (const h of hits) {
    const name = serverNameOfHit(h.path, clean);
    refs.push(name === null ? 'mcp:' + h.field : 'mcp:' + name + ':' + h.field);
  }
  if (hits.length > 0) skipped.push({ code: 'mcp-credential-redacted', count: hits.length });
  /**
   * 值形状判定（第三类漏口的统一出口，t40）。
   *
   * 上面那个扫描器是**字段名黑名单**：键名不敏感时（`FOO` / `X-Custom`），即使值就是
   * `sk-…` / `ghp_…` 也一律放行 —— env / headers / args（字符串数组）/ command / cwd
   * 都能把明文带进包；url 的 userinfo 另有 stripUserInfo 兜住，但 **query / path 里的值同样漏**
   * （audit t18 新发现 = env/headers；t40 复核出 url-query / url-path / command / cwd 同族）。
   * 这里按**与扫描器同一条**值形状判定（matchSecretValuePattern，含示例形态降噪）逐条剥离：
   * 命中即置空、逐字段报 mcp-credential-redacted（origin=<server>:<field>）、并留一个引用名让用户补录。
   * 只做值形状判定：`--password hunter2xyz` 这类非形状弱口令不在本判定内，
   * 与扫描器对其它字段的保守档口径一致。
   */
  const noteValueShapeHit = (serverName: string, field: string, count: number): void => {
    const ref = 'mcp:' + serverName + ':' + field;
    if (!refs.includes(ref)) refs.push(ref);
    skipped.push({ code: 'mcp-credential-redacted', origin: serverName + ':' + field, count });
  };
  const serversWithSafeValues = clean.servers.map((raw): McpServerEntry => {
    const s = withStringCarriersOnly(raw);
    const url = s.url === undefined ? { url: undefined, redacted: 0 } : redactValueShapeInUrl(s.url);
    const command = redactValueShapeWhole(s.command);
    const cwd = redactValueShapeWhole(s.cwd);
    const env = redactValueShapeMap(s.env);
    const headers = redactValueShapeMap(s.headers);
    let args = s.args;
    let argsRedacted = 0;
    if (s.args !== undefined && s.args.length > 0) {
      const mapped = s.args.map((a): string => {
        if (a !== '' && matchSecretValuePattern(a) !== null) { argsRedacted += 1; return REDACTED_PLACEHOLDER; }
        return a;
      });
      if (argsRedacted > 0) args = mapped;
    }
    if (url.redacted > 0) noteValueShapeHit(s.serverName, 'url', url.redacted);
    if (command.redacted > 0) noteValueShapeHit(s.serverName, 'command', command.redacted);
    if (cwd.redacted > 0) noteValueShapeHit(s.serverName, 'cwd', cwd.redacted);
    if (env.redacted > 0) noteValueShapeHit(s.serverName, 'env', env.redacted);
    if (headers.redacted > 0) noteValueShapeHit(s.serverName, 'headers', headers.redacted);
    if (argsRedacted > 0) noteValueShapeHit(s.serverName, 'args', argsRedacted);
    const changed =
      url.redacted > 0 || command.redacted > 0 || cwd.redacted > 0 || env.redacted > 0 || headers.redacted > 0 || argsRedacted > 0;
    if (!changed) return s;
    return {
      ...s,
      ...(url.url !== undefined ? { url: url.url } : {}),
      ...(command.value !== undefined ? { command: command.value } : {}),
      ...(cwd.value !== undefined ? { cwd: cwd.value } : {}),
      ...(env.map !== undefined ? { env: env.map } : {}),
      ...(headers.map !== undefined ? { headers: headers.map } : {}),
      ...(args !== undefined ? { args } : {}),
    };
  });
  return { ...clean, servers: serversWithSafeValues };
}

/**
 * 外部「名字 → server 定义」映射（Claude 的 ~/.claude.json mcpServers、Hermes 的 config.yaml
 * mcp_servers 都是这一形态）→ 一个可进包的 McpSection。
 * 一个条目都映射不出来时返回 null（**不产出空分区**）。
 */
export function mcpSectionFromEntries(
  entries: readonly (readonly [string, unknown])[],
  refs: string[],
  skipped: ForeignSkip[],
): McpSection | null {
  const servers: McpServerEntry[] = [];
  for (const [name, raw] of entries) {
    const entry = mcpEntryOf(name, raw, skipped);
    if (entry !== null) servers.push(entry);
  }
  if (servers.length === 0) return null;
  return redactMcpSection({ version: 1, servers }, refs, skipped);
}

/** 「名字 → 定义」映射取值（非映射 / 缺字段 → 空清单） */
export function serverEntriesOf(container: unknown, key: string): [string, unknown][] {
  if (!isRecord(container)) return [];
  const raw = container[key];
  if (!isRecord(raw)) return [];
  return Object.entries(raw);
}

/* ---------------- ② skill 单元装配（含同名冲突） ---------------- */

/** 一个外部 skill 单元：目录名 + 目录内文件（相对该目录）；category 仅用于报告压平 */
export interface SkillUnit {
  name: string;
  files: readonly { relativePath: string; data: Uint8Array }[];
  /** 外部侧的分类目录名（如 Hermes 的 skills/<分类>/<技能>）——有值即报压平 */
  category?: string;
}

/**
 * 把外部 skill 单元装配进 skills 分区的文件清单。
 *
 * 顺序与判据**逐字保留** v1 的 Claude 行为：名字安全 → SKILL.md 存在 → frontmatter 可被 DSH 加载
 * → 逐文件相对路径安全。新增的只有两条（契约 §8.4 冻结）：
 *  - 分类压平（category 非空）逐条报 skill-category-flattened；
 *  - **同名先到先得**：第二个同名技能整体跳过并报 skill-id-conflict（绝不产生重复包内路径）。
 */
export function collectSkills(
  units: readonly SkillUnit[],
  out: { relativePath: string; data: Uint8Array }[],
  skipped: ForeignSkip[],
): void {
  const seen = new Set<string>();
  for (const skill of units) {
    if (!isSafeUnitName(skill.name)) {
      skipped.push({ code: 'skill-invalid-name', origin: skill.name });
      continue;
    }
    if (seen.has(skill.name)) {
      skipped.push({ code: 'skill-id-conflict', origin: skill.name });
      continue;
    }
    const md = skill.files.find((f) => f.relativePath === 'SKILL.md');
    if (md === undefined) {
      skipped.push({ code: 'skill-missing-file', origin: skill.name });
      continue;
    }
    const problem = frontmatterProblem(textOf(md.data));
    if (problem !== null) {
      skipped.push({ code: 'skill-invalid-frontmatter', origin: skill.name, detail: problem });
      continue;
    }
    if (skill.category !== undefined && skill.category !== '') {
      skipped.push({ code: 'skill-category-flattened', origin: skill.category + '/' + skill.name });
    }
    seen.add(skill.name);
    for (const f of skill.files) {
      if (!isSafeRelPath(f.relativePath)) {
        skipped.push({ code: 'skill-invalid-name', origin: skill.name + '/' + f.relativePath });
        continue;
      }
      out.push({ relativePath: skill.name + '/' + f.relativePath, data: f.data });
    }
  }
}

/* ---------------- ④ 会话转码结果的归集 ---------------- */

/**
 * 工作区标题 = cwd 的最后一段（**两种分隔符都认**）。
 *
 * 为什么不能只 split('/')：Windows 记录里的 cwd 是反斜杠形态，按 '/' 切会得到整条绝对路径当标题
 * （audit-foreign F3 —— 同一份产物里两条同类记录标题还不一致）。先去掉尾部同一族分隔符，
 * 再取最后一段；空路径退回原串。
 */
export function workspaceTitleOf(cwd: string): string {
  const isSep = (ch: string): boolean => ch === '/' || ch === BACKSLASH;
  let end = cwd.length;
  while (end > 0 && isSep(cwd.charAt(end - 1))) end -= 1;
  const trimmed = cwd.slice(0, end);
  let cut = -1;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    if (isSep(trimmed.charAt(i))) { cut = i; break; }
  }
  const tail = cut < 0 ? trimmed : trimmed.slice(cut + 1);
  return tail === '' ? cwd : tail;
}

/** 转码产物（结构上兼容 claude-sessions.ts 的 TranscodedSession） */
export interface KernelTranscodedSession {
  id: string;
  cwd: string;
  relativePath: string;
  data: Uint8Array;
  info: { ignored: Record<string, number> };
}

/** 转码结果（结构上兼容 claude-sessions.ts 的 TranscodeResult） */
export interface KernelTranscodeResult {
  session?: KernelTranscodedSession;
  skip?: { code: ForeignSkipCode; detail?: string };
}

export interface SessionSectionsOptions<TFile extends { id: string }> {
  /** 待转码的会话文件（已读盘） */
  files: readonly TFile[];
  /** 目标机 DSH 的 SESSION_FORMAT_VERSION；缺省 = 一条都不转，整批报 session-format-version-unknown */
  targetFormatVersion: number | undefined;
  /** 纯转码函数（各来源自己的 JSONL → DSH 行） */
  transcode: (file: TFile) => KernelTranscodeResult;
  /** workspaces 记录 id 的来源前缀（契约 §8.3：<sourceId>:<projectKey>） */
  workspaceIdPrefix: string;
  sections: ForeignSectionOut[];
  skipped: ForeignSkip[];
  counts: Record<string, number>;
}

/**
 * 会话转码 → sessions + workspaces 两个分区。
 *
 * 为什么必须连 workspaces 一起产出：DSH 工作区按「会话 cwd 目录键 == 工作区 path 目录键」显示会话；
 * 只给会话文件、没有工作区记录时，导入会「全部成功但一条对话都看不见」（本仓真机踩过的事故）。
 *
 * 契约 §8.4 的冲突语义在这里落地：**同一个 DSH 会话 id 只允许出现一次**，第二条起跳过并报
 * session-id-conflict（绝不后写覆盖先写，也绝不让同一个 id 落到两个 projectKey 目录下 ——
 * DSH 启动会以 duplicate JSONL session id 直接拒绝）。
 */
export function collectSessionSections<TFile extends { id: string }>(
  opts: SessionSectionsOptions<TFile>,
): void {
  const files = opts.files;
  if (files.length === 0) return;
  const version = opts.targetFormatVersion;
  if (version === undefined) {
    opts.skipped.push({ code: 'session-format-version-unknown', count: files.length });
    return;
  }
  const sessionFiles: { relativePath: string; data: Uint8Array }[] = [];
  const workspaces = new Map<string, WorkspaceRecord>();
  const seenIds = new Set<string>();
  let transcoded = 0;
  for (const file of files) {
    const result = opts.transcode(file);
    if (result.skip !== undefined) {
      opts.skipped.push({ code: result.skip.code, origin: file.id, detail: result.skip.detail });
      continue;
    }
    const session = result.session;
    if (session === undefined) continue;
    if (seenIds.has(session.id)) {
      opts.skipped.push({ code: 'session-id-conflict', origin: file.id });
      continue;
    }
    seenIds.add(session.id);
    sessionFiles.push({ relativePath: session.relativePath, data: session.data });
    transcoded++;
    for (const entry of Object.entries(session.info.ignored)) {
      if (entry[1] > 0) {
        opts.skipped.push({ code: 'unsupported-session-record', origin: file.id, detail: entry[0], count: entry[1] });
      }
    }
    // 记录 id 由 **projectKey(cwd)** 派生（多对一：分隔符 run 会被折叠），所以键必须用**派生 id**、
    // 不能用 cwd 原串 —— 否则「同一目录的两种写法」（Windows 的反斜杠/正斜杠、posix 的 /a//b）
    // 会产出两条**同 id** 记录，而下游 applyItem 按 id find 恒取第一条 → 后一条永远写不进去
    // （audit-foreign F2）。同 id 归并成一条：path/title 取先到者（两种写法指向同一目录），
    // sessionIds 合并。
    const workspaceId = opts.workspaceIdPrefix + ':' + (session.relativePath.split('/')[0] ?? '');
    const existing = workspaces.get(workspaceId);
    if (existing === undefined) {
      workspaces.set(workspaceId, {
        id: workspaceId,
        path: session.cwd,
        title: workspaceTitleOf(session.cwd),
        sessionIds: [session.id],
      });
    } else if (!existing.sessionIds.includes(session.id)) {
      existing.sessionIds.push(session.id);
    }
  }
  if (sessionFiles.length > 0) {
    opts.sections.push({ sectionId: 'sessions', files: sessionFiles });
    opts.counts['sessions.files'] = sessionFiles.length;
  }
  if (workspaces.size > 0) {
    const section: WorkspacesSection = { version: 1, workspaces: [...workspaces.values()] };
    opts.sections.push({ sectionId: 'workspaces', data: section });
    opts.counts['workspaces.records'] = workspaces.size;
  }
  opts.counts['sessions.transcoded'] = transcoded;
}

/* ---------------- 指令文件（agentInstructions） ---------------- */

/**
 * 全局指令 → agentInstructions 分区（包内 AGENTS.md）。
 *
 * DSH 只读一个全局指令文件，所以**每次导入至多一个文件**（契约 §8.6-4）：多来源指令需要合并时
 * 由各来源在转换期先合并，并报 instructions-merged；本函数只负责「非空才产出」。
 */
export function instructionsSection(text: string): ForeignSectionOut | null {
  if (text.trim() === '') return null;
  return {
    sectionId: 'agentInstructions',
    files: [{ relativePath: 'AGENTS.md', data: utf8(text) }],
  };
}
