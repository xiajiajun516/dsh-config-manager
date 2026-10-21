/**
 * MCP 连接器存储（`storages/mcp_connector.json`）的读写与脱敏（mcp 分区的第二个数据源）。
 *
 * 为什么需要它：DSH 的 MCP 有两条完全不同的落地路径 ——
 *  ① 组合 patch 里的 `dsh-mcp-client` 行（官方 `dsh-mcp-client` 配置面，mcp 分区一直只认它）；
 *  ② `dsh-mcp-connector` 插件的连接器（用户实际用的是这条，存在 storage domain
 *     `mcp_connector` 的 `connections` 表里，落盘 = `$DSH_HOME/storages/mcp_connector.json`）。
 * 只认 ① 的结果是：用户配了 4 个 MCP 服务器，导出选择器里 MCP 分区恒为「0 个 / 26 B」。
 *
 * 安全边界（与连接器插件 docs/CONFIG-BACKUP.md 同精神，但按「备份要能还原」调整粒度）：
 *  - **绝不导出** grants / tool_catalog / snapshots 等其它表（含 OAuth Token、动态客户端密钥）；
 *  - Bearer Token / API Key 值、名字像凭据的 Header/env 值、命中强 secret 形状的值 → `<REDACTED:REENTER>`；
 *  - 绝对命令与本地 cwd → `<REDACTED:LOCAL_VALUE>`；
 *  - URL 只脱掉 userinfo 与「名字/值像凭据」的查询参数，端点本身保留（整条替换会让备份无法还原）；
 *  - 非敏感值原样保留（`Accept: application/json`、`-y`、包名这类），否则备份回来的连接全都不能用。
 *
 * 导入纪律：只要还有占位符，就**不写**这条连接（写进去等于给用户一个起不来的 Server），
 * 而是产出「需重填凭据」计划项。
 */
import { matchSecretValuePattern } from '../security/secret-scanner.ts';

/** 连接器存储文件（$DSH_HOME 相对路径；也是快照/回滚的文件类 ref） */
export const MCP_CONNECTOR_STORE_REL = 'storages/mcp_connector.json';

/** 需要用户重填的凭据占位符（与连接器插件同名同形，便于用户/文档互认） */
export const REDACTED_VALUE = '<REDACTED:REENTER>';

/** 本机专属值占位符（绝对命令、cwd、userinfo） */
export const REDACTED_LOCAL_VALUE = '<REDACTED:LOCAL_VALUE>';

/** 本项目导出的连接器块标识（与连接器插件自己的 dsh-mcp-connector.redacted 区分：我们的还带 key/connectorId） */
export const MCP_CONNECTOR_EXPORT_FORMAT = 'dsh-config-manager.mcp-connector';
export const MCP_CONNECTOR_EXPORT_VERSION = 1;

/** storage domain 里的一条连接记录（只保留本模块用到的字段，其余字段原样透传） */
export interface ConnectorRecord {
  key: string;
  connectorId: string;
  kind: 'oauth' | 'manual' | 'json';
  name: string;
  serverKey?: string;
  serverName: string;
  transport: 'streamable-http' | 'sse' | 'stdio';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  allowInsecurePrivateNetwork?: boolean;
  headers?: Record<string, string>;
  auth?: {
    mode: 'oauth' | 'bearer' | 'api-key';
    bearerToken?: string;
    apiKeyHeader?: string;
    apiKeyValue?: string;
    grantKey?: string;
  };
  enabled?: boolean;
  injectionMode?: 'always' | 'session';
  createdAt?: number;
  updatedAt?: number;
  [key: string]: unknown;
}

/** 导出的连接（脱敏后；redactedFields 列出被替换的字段，导入侧据此判「需重填」） */
export interface ConnectorExportEntry {
  key: string;
  connectorId: string;
  kind: 'oauth' | 'manual' | 'json';
  name: string;
  serverKey?: string;
  serverName: string;
  transport: 'streamable-http' | 'sse' | 'stdio';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  allowInsecurePrivateNetwork?: boolean;
  headers?: Record<string, string>;
  authMode?: 'oauth' | 'bearer' | 'api-key' | 'none';
  bearerToken?: string;
  apiKeyHeader?: string;
  apiKeyValue?: string;
  injectionMode?: 'always' | 'session';
  enabled: boolean;
  redactedFields?: string[];
}

/** OAuth 连接只导出「引用」：Token 与动态客户端密钥永不进备份，导入侧提示从市场重新授权 */
export interface ConnectorOauthRef {
  key: string;
  connectorId: string;
  serverKey?: string;
  name: string;
  serverName: string;
  enabled: boolean;
  injectionMode?: 'always' | 'session';
  action: 'reconnect-oauth';
}

/** mcp 分区里连接器来源的整块载荷 */
export interface McpConnectorExport {
  format: typeof MCP_CONNECTOR_EXPORT_FORMAT;
  version: typeof MCP_CONNECTOR_EXPORT_VERSION;
  exportedAt: string;
  connections: ConnectorExportEntry[];
  oauthConnections: ConnectorOauthRef[];
}

/** 名字像凭据的键（Header / env / 查询参数 / CLI flag）——命中即脱敏，不看值形状 */
const SECRETISH_NAME = /(authorization|auth-token|token|api[-_]?key|apikey|secret|password|passwd|pwd|cookie|credential|private[-_]?key|access[-_]?key|session[-_]?key|bearer|signature|sig)/i;

function isSecretishName(name: string): boolean {
  return SECRETISH_NAME.test(name);
}

function isPlaceholder(value: string): boolean {
  return value === REDACTED_VALUE || value === REDACTED_LOCAL_VALUE;
}

/** 单个值是否需要脱敏（名字启发 + 强形状命中） */
function needsRedaction(value: string, name?: string): boolean {
  if (value === '') return false;
  if (name !== undefined && isSecretishName(name)) return true;
  return matchSecretValuePattern(value) !== null;
}

/** Header / env 一类的键值表：保留键名（用户重填时要知道填哪个），逐个决定值 */
function redactValueMap(input: Record<string, string> | undefined): { map?: Record<string, string>; redacted: boolean } {
  if (input === undefined) return { redacted: false };
  const keys = Object.keys(input).sort();
  if (keys.length === 0) return { map: {}, redacted: false };
  let redacted = false;
  const map: Record<string, string> = {};
  for (const key of keys) {
    const raw = input[key];
    const value = typeof raw === 'string' ? raw : String(raw ?? '');
    if (needsRedaction(value, key)) {
      map[key] = REDACTED_VALUE;
      redacted = true;
    } else {
      map[key] = value;
    }
  }
  return { map, redacted };
}

/** stdio 参数：只脱掉看起来是密钥的参数（含 `--token=xxx` 与「flag 后紧跟值」两种形态），其余保留 */
export function redactArgs(args: readonly string[] | undefined): { args?: string[]; redacted: boolean } {
  if (args === undefined) return { redacted: false };
  let redacted = false;
  const out: string[] = [];
  let prevSecretFlag = false;
  for (const raw of args) {
    const arg = typeof raw === 'string' ? raw : String(raw ?? '');
    const eq = arg.indexOf('=');
    if (arg.startsWith('-') && eq > 0) {
      const flag = arg.slice(0, eq);
      const value = arg.slice(eq + 1);
      if (isSecretishName(flag) || needsRedaction(value)) {
        out.push(`${flag}=${REDACTED_VALUE}`);
        redacted = true;
        prevSecretFlag = false;
        continue;
      }
      prevSecretFlag = isSecretishName(flag);
      out.push(arg);
      continue;
    }
    if (prevSecretFlag || needsRedaction(arg)) {
      out.push(REDACTED_VALUE);
      redacted = true;
      prevSecretFlag = false;
      continue;
    }
    prevSecretFlag = arg.startsWith('-') && isSecretishName(arg);
    out.push(arg);
  }
  return { args: out, redacted };
}

/** 命令：裸命令名（npx / uvx / node）保留；带路径的（绝对路径、盘符、相对目录）替换为本机值占位符 */
export function redactCommand(command: string | undefined): { command?: string; redacted: boolean } {
  if (command === undefined || command === '') return { redacted: false };
  if (/^[A-Za-z0-9_.@+-]+$/.test(command)) return { command, redacted: false };
  return { command: REDACTED_LOCAL_VALUE, redacted: true };
}

/** URL：userinfo 整条替换；查询参数逐项脱敏（端点本体必须保住，否则备份无法还原） */
export function redactUrl(url: string | undefined): { url?: string; redacted: boolean } {
  if (url === undefined || url === '') return { redacted: false };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url: REDACTED_VALUE, redacted: true };
  }
  if (parsed.username !== '' || parsed.password !== '') return { url: REDACTED_VALUE, redacted: true };
  let redacted = false;
  if (parsed.search !== '') {
    const params = [...parsed.searchParams.entries()];
    parsed.search = '';
    for (const [name, value] of params) {
      if (needsRedaction(value, name)) {
        parsed.searchParams.append(name, REDACTED_VALUE);
        redacted = true;
      } else {
        parsed.searchParams.append(name, value);
      }
    }
  }
  if (parsed.hash !== '' && needsRedaction(parsed.hash.replace(/^#/, ''))) {
    parsed.hash = '';
    return { url: parsed.toString(), redacted: true };
  }
  return { url: redacted ? parsed.toString() : url, redacted };
}

/** 一条连接记录 → 可携带的脱敏条目（永不返回 Token / 密钥明文） */
export function exportConnectorRecord(record: ConnectorRecord): ConnectorExportEntry {
  const redactedFields: string[] = [];
  const entry: ConnectorExportEntry = {
    key: record.key,
    connectorId: record.connectorId,
    kind: record.kind,
    name: record.name,
    serverName: record.serverName,
    transport: record.transport,
    enabled: record.enabled !== false,
  };
  if (record.serverKey !== undefined) entry.serverKey = record.serverKey;
  if (record.injectionMode !== undefined) entry.injectionMode = record.injectionMode;

  if (record.transport === 'stdio') {
    const command = redactCommand(record.command);
    if (command.command !== undefined) entry.command = command.command;
    if (command.redacted) redactedFields.push('command');
    const args = redactArgs(record.args);
    if (args.args !== undefined) entry.args = args.args;
    if (args.redacted) redactedFields.push('args');
    const env = redactValueMap(record.env);
    if (env.map !== undefined) entry.env = env.map;
    if (env.redacted) redactedFields.push('env');
    if (record.cwd !== undefined && record.cwd !== '') {
      entry.cwd = REDACTED_LOCAL_VALUE;
      redactedFields.push('cwd');
    }
  } else {
    const url = redactUrl(record.url);
    if (url.url !== undefined) entry.url = url.url;
    if (url.redacted) redactedFields.push('url');
    if (record.allowInsecurePrivateNetwork === true) entry.allowInsecurePrivateNetwork = true;
    const headers = redactValueMap(record.headers);
    if (headers.map !== undefined) entry.headers = headers.map;
    if (headers.redacted) redactedFields.push('headers');
  }

  const mode = record.auth?.mode;
  if (mode === 'bearer') {
    entry.authMode = 'bearer';
    entry.bearerToken = REDACTED_VALUE;
    redactedFields.push('bearerToken');
  } else if (mode === 'api-key') {
    entry.authMode = 'api-key';
    entry.apiKeyHeader = record.auth?.apiKeyHeader ?? 'X-Api-Key';
    entry.apiKeyValue = REDACTED_VALUE;
    redactedFields.push('apiKeyValue');
  } else if (mode === 'oauth') {
    entry.authMode = 'oauth';
  } else {
    entry.authMode = 'none';
  }

  if (redactedFields.length > 0) entry.redactedFields = redactedFields;
  return entry;
}

/** 全部连接 → 导出块（OAuth 只留引用；按 key 排序，便于 diff 与稳定哈希） */
export function exportConnectorBlock(records: readonly ConnectorRecord[], exportedAt = new Date().toISOString()): McpConnectorExport {
  const sorted = [...records].sort((a, b) => a.key.localeCompare(b.key));
  return {
    format: MCP_CONNECTOR_EXPORT_FORMAT,
    version: MCP_CONNECTOR_EXPORT_VERSION,
    exportedAt,
    connections: sorted.filter((r) => r.auth?.mode !== 'oauth').map((r) => exportConnectorRecord(r)),
    oauthConnections: sorted
      .filter((r) => r.auth?.mode === 'oauth')
      .map((r) => ({
        key: r.key,
        connectorId: r.connectorId,
        ...(r.serverKey !== undefined ? { serverKey: r.serverKey } : {}),
        name: r.name,
        serverName: r.serverName,
        enabled: r.enabled !== false,
        ...(r.injectionMode !== undefined ? { injectionMode: r.injectionMode } : {}),
        action: 'reconnect-oauth' as const,
      })),
  };
}

/** 列出「还有占位符」的字段路径（导入前判「需重填凭据」） */
export function unresolvedRedactions(value: unknown, path = '$', output: string[] = []): string[] {
  if (typeof value === 'string') {
    if (isPlaceholder(value)) output.push(path);
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => unresolvedRedactions(item, `${path}[${index}]`, output));
    return output;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      unresolvedRedactions(item, `${path}.${key}`, output);
    }
  }
  return output;
}

/** 导出条目里「需要用户重填」的字段（占位符路径 + redactedFields 并集，供计划项 detail 用） */
export function refillFieldsOf(entry: ConnectorExportEntry): string[] {
  const fields = new Set<string>(entry.redactedFields ?? []);
  for (const p of unresolvedRedactions(entry)) {
    const trimmed = p.startsWith('$.') ? p.slice(2) : p;
    if (trimmed !== '') fields.add(trimmed);
  }
  return [...fields].sort();
}

/** 连接器存储文件的解析结果 */
export interface ConnectorStoreRead {
  /** 文件存在且解析成功 */
  parsed: boolean;
  /** 文件是否存在（ENOENT → false；其余错误 → true + 解析失败） */
  exists: boolean;
  connections: ConnectorRecord[];
  /** 解析失败原因（读到了但形态不对 → 绝不当作空表覆盖） */
  error?: string;
  /** 原始 JSON（保留其它表，写回时只替换 connections） */
  raw?: Record<string, unknown>;
}

function asRecordArray(value: unknown): ConnectorRecord[] {
  if (value === null || typeof value !== 'object') return [];
  const out: ConnectorRecord[] = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === null || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const serverName = typeof rec['serverName'] === 'string' ? rec['serverName'] : '';
    if (serverName === '') continue;
    out.push({
      ...(rec as ConnectorRecord),
      key: typeof rec['key'] === 'string' && rec['key'] !== '' ? rec['key'] : key,
      serverName,
    });
  }
  return out;
}

/** 解析连接器存储文本（绝不对「读到了但解析不了」当空表） */
export function parseConnectorStore(text: string): ConnectorStoreRead {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { parsed: false, exists: true, connections: [], error: err instanceof Error ? err.message : String(err) };
  }
  if (raw === null || typeof raw !== 'object') {
    return { parsed: false, exists: true, connections: [], error: 'root is not an object' };
  }
  const root = raw as Record<string, unknown>;
  const tables = root['tables'];
  if (tables === null || typeof tables !== 'object') {
    return { parsed: false, exists: true, connections: [], error: 'tables is not an object' };
  }
  const connections = asRecordArray((tables as Record<string, unknown>)['connections']);
  return { parsed: true, exists: true, connections, raw: root };
}

/** 读连接器存储（ENOENT → 空表 + exists:false；其余错误原样上报） */
export async function readConnectorStore(
  fs: { readFile(rel: string): Promise<Uint8Array>; exists(rel: string): Promise<boolean> },
): Promise<ConnectorStoreRead> {
  if (!(await fs.exists(MCP_CONNECTOR_STORE_REL))) {
    // 没装连接器是正常形态：空表但**可写**（导入时要在目标机新建这个文件）
    return { parsed: true, exists: false, connections: [] };
  }
  const bytes = await fs.readFile(MCP_CONNECTOR_STORE_REL);
  const text = new TextDecoder().decode(bytes);
  return parseConnectorStore(text);
}

/** 连接身份：优先 key，其次 (connectorId, serverName) */
export function connectorIdentity(entry: { key?: string; connectorId?: string; serverName: string }): string {
  if (typeof entry.key === 'string' && entry.key !== '') return `key:${entry.key}`;
  return `name:${entry.connectorId ?? ''}/${entry.serverName}`;
}

/**
 * 在目标连接里找同一身份的记录：**只认 (connectorId, serverName)**。
 *
 * 为什么不先按 key 认：key 是存储主键，但「同 key 不同连接」在手工改过/旧版本里是可能的；
 * 按 key 命中就当成同一条会**覆盖掉一条无关连接**。身份相同 → 复用既有 key（幂等）；
 * 身份不同 → 交给 pickConnectorKey 挑一个不冲突的新 key。
 */
export function findConnectorRecord(records: readonly ConnectorRecord[], entry: ConnectorExportEntry): ConnectorRecord | undefined {
  return records.find((r) => r.connectorId === entry.connectorId && r.serverName === entry.serverName);
}

/**
 * 比较用形态：**两侧都过一遍脱敏**再去掉易变字段。
 *
 * 为什么导出条目也要重新脱敏：条目里可能已被用户重填成真值（明文），而目标机记录里的
 * 同名字段也是明文——但如果只脱一侧，明文与占位符一比就永远 Conflict（导入一次就再也 Skip 不了）。
 * 两侧统一过 exportConnectorRecord ⇒ 明文都被换成同一个占位符，同一条连接天然相等。
 */
export function comparableConnector(record: ConnectorRecord | ConnectorExportEntry): Record<string, unknown> {
  const isEntry = (record as ConnectorExportEntry).authMode !== undefined;
  const asRecord = isEntry
    ? buildConnectorRecord(record as ConnectorExportEntry, { key: (record as ConnectorExportEntry).key, now: 0 })
    : (record as ConnectorRecord);
  const { key: _key, redactedFields: _rf, ...rest } = exportConnectorRecord(asRecord);
  return rest as Record<string, unknown>;
}

/** 把脱敏条目还原成可写入 storage domain 的记录（占位符必须为空才不会破坏目标机） */
export function buildConnectorRecord(
  entry: ConnectorExportEntry,
  options: { existing?: ConnectorRecord; key: string; now: number },
): ConnectorRecord {
  const { existing, key, now } = options;
  const record: ConnectorRecord = {
    ...(existing ?? {}),
    key,
    connectorId: entry.connectorId,
    kind: entry.kind,
    name: entry.name,
    serverName: entry.serverName,
    transport: entry.transport,
    enabled: entry.enabled !== false,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  if (entry.serverKey !== undefined) record.serverKey = entry.serverKey;
  if (entry.injectionMode !== undefined) record.injectionMode = entry.injectionMode;

  if (entry.transport === 'stdio') {
    if (entry.command !== undefined) record.command = entry.command;
    if (entry.args !== undefined) record.args = [...entry.args];
    if (entry.env !== undefined) record.env = { ...entry.env };
    if (entry.cwd !== undefined) record.cwd = entry.cwd;
    delete record.url;
    delete record.headers;
  } else {
    if (entry.url !== undefined) record.url = entry.url;
    if (entry.headers !== undefined) record.headers = { ...entry.headers };
    if (entry.allowInsecurePrivateNetwork === true) record.allowInsecurePrivateNetwork = true;
    else delete record.allowInsecurePrivateNetwork;
    delete record.command;
    delete record.args;
    delete record.env;
    delete record.cwd;
  }

  if (entry.authMode === 'bearer') {
    record.auth = { mode: 'bearer', ...(entry.bearerToken !== undefined ? { bearerToken: entry.bearerToken } : {}) };
  } else if (entry.authMode === 'api-key') {
    record.auth = {
      mode: 'api-key',
      apiKeyHeader: entry.apiKeyHeader ?? 'X-Api-Key',
      ...(entry.apiKeyValue !== undefined ? { apiKeyValue: entry.apiKeyValue } : {}),
    };
  } else if (entry.authMode === 'oauth') {
    record.auth = { ...(existing?.auth ?? { mode: 'oauth' }) };
  } else if (existing?.auth !== undefined) {
    record.auth = { ...existing.auth };
  }
  return record;
}

/** 目标机里生成一个不与既有记录冲突的 key（同身份 → 复用既有 key） */
export function pickConnectorKey(records: readonly ConnectorRecord[], entry: ConnectorExportEntry): string {
  const existing = findConnectorRecord(records, entry);
  if (existing !== undefined) return existing.key;
  // key 被一条**无关**连接占着 → 加后缀，绝不覆盖别人的连接
  if (!records.some((r) => r.key === entry.key)) return entry.key;
  let suffix = 2;
  while (records.some((r) => r.key === `${entry.key}-${suffix}`)) suffix += 1;
  return `${entry.key}-${suffix}`;
}

/**
 * 把一条（已脱敏、无占位符的）连接合并进存储 JSON 文本，返回新文本。
 *
 * 只替换 `tables.connections[`key`]`，其它表与未知字段逐字保留（grants/tool_catalog 等绝不重写）。
 */
export function mergeConnectorIntoStoreText(
  read: ConnectorStoreRead,
  record: ConnectorRecord,
): string {
  const root: Record<string, unknown> = read.raw !== undefined ? { ...read.raw } : {};
  if (root['unit'] === undefined || root['unit'] === null || typeof root['unit'] !== 'object') {
    root['unit'] = { name: 'mcp_connector', version: 1 };
  }
  if (!('global' in root)) root['global'] = null;
  const tables: Record<string, unknown> = root['tables'] !== undefined && root['tables'] !== null && typeof root['tables'] === 'object'
    ? { ...(root['tables'] as Record<string, unknown>) }
    : {};
  const connections: Record<string, unknown> = tables['connections'] !== undefined && tables['connections'] !== null && typeof tables['connections'] === 'object'
    ? { ...(tables['connections'] as Record<string, unknown>) }
    : {};
  connections[record.key] = record;
  tables['connections'] = connections;
  root['tables'] = tables;
  return `${JSON.stringify(root, null, 2)}\n`;
}
