/**
 * mcp 分区 adapter（设计 §3.3/§1.2/§15）：
 * 数据源 = 组合 patch 中 dsh-mcp-client 行的 config（研究报告 §2.2：MCP 无 settings 面/无管理 API）。
 * 导入 = 写 profile cordis.patch.yml 插行（needsRestart 生效）；依赖检测（npx 等）由 analyzer 的
 * dependencyChecker 执行（§15：缺失不阻塞，标记 Requires Attention）。
 *
 * patch 行 raw 支持两种形态：单行 { id, name, config } 与块 { insert: [{ id, name, config }] }。
 *
 * issue #71（真机报告「备份不到外壳 mcp」）：数据源是**两层** patch —— home 层
 * （$DSH_HOME/cordis.patch.yml）与 profile 层（$DSH_HOME/profiles/<p>/cordis.patch.yml）。
 * 此前只读 home 层，而 DSH 自己的 MCP 配置工具把 server 写进 profile 层，于是备份里
 * servers 恒为空数组。现在两层都读，每行记住自己来自哪个文件，写回时落回原层。
 */
import { isDeepStrictEqual } from 'node:util';
import { msgOf, zhMsg } from '../core/messages.ts';
import type { MsgFunc } from '../core/messages.ts';
import type { McpServerEntry } from '../schema/types.ts';
import { sectionMeta } from '../schema/section-registry.ts';
import { validateJsonSection } from './json-section.ts';
import type {
  ApplyResult, ConfigAdapter, ExportOptions, ExportSection, ExportUnit, HostContext,
  ImportContext, PlanItem, ValidationResult,
} from '../core/types.ts';
import { locatePatchLineLayer, readEffectivePatchLines, resolveWriteLayer } from '../core/patch-layers.ts';
import {
  MCP_CONNECTOR_STORE_REL, buildConnectorRecord, comparableConnector, exportConnectorBlock,
  findConnectorRecord, mergeConnectorIntoStoreText, pickConnectorKey, readConnectorStore,
  refillFieldsOf,
} from '../core/mcp-connector-store.ts';
import type { ConnectorExportEntry, McpConnectorExport } from '../core/mcp-connector-store.ts';

/** 导出记录：McpServerEntry 之外附加来源 patch 行 id 与所在层（导入写回定位用） */
export interface McpExportEntry extends McpServerEntry {
  sourceLineId: string;
  /**
   * 来源 patch 层（相对 homeDir 的 POSIX 路径；见 core/patch-layers.ts）。
   * 缺省 = 用户层（旧备份包没有该字段 → 按旧行为写回 home 层）。
   */
  sourceFile?: string;
}

export interface McpExportSection {
  version: 1;
  servers: McpExportEntry[];
  /**
   * MCP 连接器（\`dsh-mcp-connector\` 插件）的连接，第二个数据源。
   *
   * 为什么并列而不是新增分区：两条路径在 DSH 里都是「MCP 服务器」，用户心智里是一件事；
   * 而备份格式是追加字段 ⇒ 旧备份没有它 = 空，读旧包的代码不受影响。
   */
  connectors?: McpConnectorExport;
}

/**
 * 从 patch 行数组中提取 MCP server 条目（以 config.serverName 存在为判定）。
 *
 * 行对象可带 `file`（层身份）：带上时逐条目记录 `sourceFile`，导入写回落回原层。
 */
export function extractMcpServers(lines: { lineId: string; raw: unknown; file?: string }[]): McpExportEntry[] {
  const servers: McpExportEntry[] = [];
  for (const line of lines) {
    for (const entry of entriesOf(line.raw)) {
      const config = entry.config;
      if (config === null || typeof config !== 'object') continue;
      const c = config as Record<string, unknown>;
      const serverName = c['serverName'];
      if (typeof serverName !== 'string' || serverName === '') continue;
      const type = typeof c['url'] === 'string' && c['url'] !== '' ? 'streamable-http' : 'stdio';
      servers.push({
        serverName,
        type,
        command: typeof c['command'] === 'string' ? c['command'] : undefined,
        args: Array.isArray(c['args']) ? (c['args'] as string[]) : undefined,
        env: c['env'] !== null && typeof c['env'] === 'object' ? (c['env'] as Record<string, string>) : undefined,
        cwd: typeof c['cwd'] === 'string' ? c['cwd'] : undefined,
        url: typeof c['url'] === 'string' ? c['url'] : undefined,
        headers: c['headers'] !== null && typeof c['headers'] === 'object' ? (c['headers'] as Record<string, string>) : undefined,
        sourceLineId: line.lineId,
        ...(line.file !== undefined ? { sourceFile: line.file } : {}),
      });
    }
  }
  return servers;
}

/** patch 行 → 可枚举的 entry 列表（兼容单行与 insert 块） */
function entriesOf(raw: unknown): { id?: unknown; name?: unknown; config?: unknown }[] {
  if (raw === null || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj['insert'])) {
    return obj['insert']
      .filter((e): e is Record<string, unknown> => e !== null && typeof e === 'object')
      .map((e) => e as { id?: unknown; name?: unknown; config?: unknown });
  }
  if (obj['id'] !== undefined || obj['name'] !== undefined) {
    return [obj as { id?: unknown; name?: unknown; config?: unknown }];
  }
  return [];
}

/** 由导出条目构造写回 patch 行 raw（单行形态，与 dsh-mcp-client 组合 config 语义一致） */
export function buildMcpPatchLine(lineId: string, server: McpServerEntry): Record<string, unknown> {
  const config: Record<string, unknown> = { serverName: server.serverName };
  if (server.type === 'streamable-http') {
    config['url'] = server.url;
    if (server.headers !== undefined) config['headers'] = server.headers;
  } else {
    config['command'] = server.command;
    if (server.args !== undefined) config['args'] = server.args;
    if (server.env !== undefined) config['env'] = server.env;
    if (server.cwd !== undefined) config['cwd'] = server.cwd;
  }
  return { id: lineId, name: 'dsh-mcp-client', config };
}

/** 连接器计划项的 id 前缀（导入时按前缀分派到 applyConnectorItem） */
const MCP_CONNECTOR_ITEM_PREFIX = 'mcp-connector:';

/** 计划项 detail：stdio 给命令 + 参数，http 给 URL（不打印任何 header/env 值，防凭据入日志） */
function describeConnector(entry: ConnectorExportEntry): string {
  const head = entry.transport === 'stdio'
    ? [entry.command ?? '', ...(entry.args ?? [])].filter((s) => s !== '').join(' ')
    : (entry.url ?? '');
  return `${entry.transport} ${head}`.trim().slice(0, 200);
}

function newLineId(serverName: string): string {
  const slug = serverName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `mcp-${slug || 'server'}`;
}

/**
 * 单元 id：两条数据源各自独立前缀。
 *
 * 为什么必须分开：patch 行的 `serverName` 与连接器的 `serverName` 完全可能同名（同一台服务器的两条
 * 历史配置路径），共用 id 会让「勾了其中一个」变成「两个一起勾」，与选择器「逐项可勾」的前提冲突。
 * 命名空间仍以 `mcp:` 开头 —— 与 ExportUnit 的「<section>:<单元>」约定一致。
 */
export function mcpServerUnitId(serverName: string): string {
  return 'mcp:patch:' + serverName
}

export function mcpConnectorUnitId(key: string): string {
  return 'mcp:connector:' + key
}

/** 单元体积 = 该条目在包里的 UTF-8 字节数（与 /export-preview 对 JSON 分区的口径一致） */
function unitBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? '').byteLength
}

/** 只读的 stdio 描述（命令 + 参数），不打印任何 env / header 值 */
function stdioDetail(entry: { command?: string; args?: string[] }): string {
  return [entry.command ?? '', ...(entry.args ?? [])].filter((s) => s !== '').join(' ').slice(0, 200)
}

/**
 * 连接器整块的条目级过滤。
 *
 * allow === undefined = 全量（旧调用方零改动）；过滤后一条不剩 → 返回 undefined，
 * 让 `connectors` 字段整个消失（而不是留一个空块冒充「连接器已备份」）。
 */
function filterConnectorBlock(block: McpConnectorExport, allow: readonly string[] | undefined): McpConnectorExport | undefined {
  if (allow === undefined) return block
  const connections = block.connections.filter((c) => allow.includes(mcpConnectorUnitId(c.key)))
  const oauthConnections = block.oauthConnections.filter((c) => allow.includes(mcpConnectorUnitId(c.key)))
  if (connections.length === 0 && oauthConnections.length === 0) return undefined
  return { ...block, connections, oauthConnections }
}
export class McpAdapter implements ConfigAdapter<McpExportSection> {
  readonly id = 'mcp' as const;
  // 元数据唯一来源 = 注册表（t31）：不再与 ui/export-flow.ts 的导出目录各写一份
  readonly displayName = sectionMeta('mcp').displayName;
  readonly defaultIncluded = sectionMeta('mcp').defaultIncluded;
  readonly portability = sectionMeta('mcp').portability;

  async export(ctx: HostContext, options: ExportOptions): Promise<ExportSection<McpExportSection>> {
    const warnings: string[] = [];
    // issue #71：两层都读（home 层优先），否则 profile 层里的 server 全部丢失
    const read = await readEffectivePatchLines(ctx.patchFile, ctx.profile);
    for (const f of read.failures) {
      warnings.push(msgOf(ctx)('adapter.patchReadFailedMCP', { reason: `${f.file}: ${f.reason}` }));
    }
    const servers = extractMcpServers(read.lines);
    // 条目级白名单：undefined = 整分区全量（旧调用方零改动）；空数组 = 一条都不带。
    // 选择器把「部分勾选」翻译成 includeItems['mcp']，这里必须如实过滤，否则勾了等于没勾。
    const allow = options.includeItems?.[this.id];
    const pickedServers = allow === undefined
      ? servers
      : servers.filter((s) => allow.includes(mcpServerUnitId(s.serverName)));
    // 第二个数据源：连接器插件的 `storages/mcp_connector.json`（用户实际配置 MCP 的地方）。
    // 读不到 = 本机没装/没用连接器（正常，静默）；读到了解析不了 = 异常，如实报 warning，
    // **绝不**当作空表导出 —— 否则用户以为备份里有，恢复时才发现丢了。
    let connectors: McpConnectorExport | undefined;
    try {
      const store = await readConnectorStore(ctx.fs);
      if (store.exists && !store.parsed) {
        warnings.push(msgOf(ctx)('adapter.mcpConnectorReadFailed', { reason: store.error ?? 'unknown' }));
      } else if (store.exists && store.parsed) {
        // 文件不存在 = 本机没有任何连接器：不写这个字段（旧备份也没有它，形状保持一致）
        connectors = filterConnectorBlock(exportConnectorBlock(store.connections), allow);
      }
    } catch (err) {
      warnings.push(msgOf(ctx)('adapter.mcpConnectorReadFailed', { reason: err instanceof Error ? err.message : String(err) }));
    }
    const data: McpExportSection = { version: 1, servers: pickedServers };
    if (connectors !== undefined) data.connectors = connectors;
    return {
      sectionId: 'mcp',
      data,
      counts: {
        servers: pickedServers.length,
        ...(connectors !== undefined ? { connectors: connectors.connections.length } : {}),
      },
      warnings,
    };
  }

  /**
   * 条目级单元清单（选择器靠它决定「能不能展开」）。
   *
   * 契约（core/types.ts:1211）：纯函数、零 I/O，且必须与 export(includeItems) 自洽 ——
   * 单元 id 就是 export 白名单里认的 id，两边共用 mcpServerUnitId / mcpConnectorUnitId。
   *
   * 单元 label 与 detail 只放「能帮用户认出是哪条」的信息：连接器的 detail 复用
   * describeConnector（stdio 给命令 + 参数、http 给 URL），**绝不**带出 env / header 值。
   */
  listUnits(section: ExportSection<McpExportSection>): ExportUnit[] {
    const units: ExportUnit[] = [];
    const seen = new Set<string>();
    for (const server of section.data.servers ?? []) {
      const id = mcpServerUnitId(server.serverName);
      if (seen.has(id)) continue;
      seen.add(id);
      units.push({
        id,
        label: server.serverName,
        detail: server.type === 'stdio' ? stdioDetail(server) : (server.url ?? ''),
        sizeBytes: unitBytes(server),
      });
    }
    const connectors = section.data.connectors;
    for (const connection of connectors?.connections ?? []) {
      const id = mcpConnectorUnitId(connection.key);
      if (seen.has(id)) continue;
      seen.add(id);
      units.push({
        id,
        label: connection.name,
        detail: describeConnector(connection),
        sizeBytes: unitBytes(connection),
      });
    }
    for (const oauth of connectors?.oauthConnections ?? []) {
      const id = mcpConnectorUnitId(oauth.key);
      if (seen.has(id)) continue;
      seen.add(id);
      units.push({
        id,
        label: oauth.name,
        // OAuth 连接只带引用（Token 永不进备份），detail 说明它靠重新授权才能用
        detail: 'oauth ' + oauth.serverName,
        sizeBytes: unitBytes(oauth),
      });
    }
    return units;
  }

  async analyzeImport(data: McpExportSection, ctx: ImportContext): Promise<PlanItem[]> {
    const msg = ctx.msg;
    const items: PlanItem[] = [];
    // issue #71：目标行跨两层；同一 lineId 只保留优先级最高的一层（与 DSH 合并序一致）
    const targetLines = (await readEffectivePatchLines(ctx.target.patchFile, ctx.target.profile)).lines;
    const targetServers = extractMcpServers(targetLines);
    for (const server of data.servers) {
      const id = `mcp:${server.serverName}`;
      const existing = targetServers.find((s) => s.serverName === server.serverName);
      const comparable = { ...server } as Record<string, unknown>;
      delete comparable.sourceLineId;
      delete comparable.sourceFile;
      if (!existing) {
        const lineId = server.sourceLineId && targetLines.some((l) => l.lineId === server.sourceLineId)
          ? `${server.sourceLineId}-imported`
          : (server.sourceLineId ?? newLineId(server.serverName));
        items.push({
          id, kind: 'Create', adapter: 'mcp',
          description: msg('adapter.mcpCreate', { serverName: server.serverName }),
          detail: `${server.type === 'stdio' ? `${server.command} ${(server.args ?? []).join(' ')}` : server.url}`,
          severity: 'info',
          // 目标层随计划项一起走：导入前快照要按**这一层**记原行，回滚才能写回原文件
          target: { adapter: 'mcp', ref: lineId, file: resolveWriteLayer(server.sourceFile, ctx.target.profile) },
        });
      } else {
        const existingComparable = { ...existing } as Record<string, unknown>;
        delete existingComparable.sourceLineId;
        delete existingComparable.sourceFile;
        if (isDeepStrictEqual(existingComparable, comparable)) {
          items.push({ id, kind: 'Skip', adapter: 'mcp', description: msg('adapter.mcpSame', { serverName: server.serverName }), severity: 'info' });
        } else {
          items.push({
            id, kind: 'Conflict', adapter: 'mcp',
            description: msg('adapter.mcpDiff', { serverName: server.serverName }),
            detail: `current=${JSON.stringify(existingComparable)} imported=${JSON.stringify(comparable)}`.slice(0, 200),
            severity: 'warning',
            target: { adapter: 'mcp', ref: existing.sourceLineId, file: existing.sourceFile },
          });
        }
      }
    }
    items.push(...await this.analyzeConnectors(data, ctx));
    return items;
  }

  /**
   * 连接器来源的计划项。
   *
   * 三条纪律：
   *  ① 目标存储「存在但解析不了」→ 只报 warning、**零写入**（整文件改写会把 grants 等表一起抹掉）；
   *  ② 条目里还有占位符 → 不写，产出「需重填凭据」的 warning（写进去 = 给用户一个起不来的 Server）；
   *  ③ 同名 server 同时来自 patch 行与连接器 → 两条都保留，另加一条 warning（不隐式合并，
   *     两者在 DSH 里是两份独立配置，合并会悄悄改变用户的生效结果）。
   */
  private async analyzeConnectors(data: McpExportSection, ctx: ImportContext): Promise<PlanItem[]> {
    const msg = ctx.msg;
    const block = data.connectors;
    if (block === undefined) return [];
    const items: PlanItem[] = [];
    const target = await readConnectorStore(ctx.target.fs);
    if (target.exists && !target.parsed) {
      items.push({
        id: 'mcp-connector:store',
        kind: 'Warning',
        adapter: 'mcp',
        description: msg('adapter.mcpConnectorTargetUnreadable', { reason: target.error ?? 'unknown' }),
        severity: 'warning',
      });
    }
    const writable = target.parsed;
    for (const entry of block.connections ?? []) {
      const id = `mcp-connector:${entry.key}`;
      // 双来源同名：告诉用户「这条连接和 patch 行里的同名 server 是两份」，不替用户做决定。
      // 放在「需重填」判断**之前**——两条事实都要讲，不能因为一条要重填就吞掉另一条。
      if (data.servers.some((s) => s.serverName === entry.serverName)) {
        items.push({
          id: `mcp-connector-name:${entry.key}`,
          kind: 'Warning', adapter: 'mcp',
          description: msg('adapter.mcpConnectorDuplicateName', { serverName: entry.serverName }),
          severity: 'warning',
        });
      }
      const refill = refillFieldsOf(entry);
      if (refill.length > 0) {
        items.push({
          id, kind: 'Warning', adapter: 'mcp',
          description: msg('adapter.mcpConnectorNeedsRefill', { name: entry.name }),
          detail: refill.join(', '),
          severity: 'warning',
        });
        continue;
      }
      if (!writable) continue;
      const existing = findConnectorRecord(target.connections, entry);
      const detail = describeConnector(entry);
      if (existing === undefined) {
        items.push({
          id, kind: 'Create', adapter: 'mcp',
          description: msg('adapter.mcpConnectorCreate', { name: entry.name }),
          detail,
          severity: 'info',
          target: { adapter: 'mcp', ref: MCP_CONNECTOR_STORE_REL },
        });
      } else if (isDeepStrictEqual(comparableConnector(existing), comparableConnector(entry))) {
        items.push({ id, kind: 'Skip', adapter: 'mcp', description: msg('adapter.mcpConnectorSame', { name: entry.name }), severity: 'info' });
      } else {
        items.push({
          id, kind: 'Conflict', adapter: 'mcp',
          description: msg('adapter.mcpConnectorDiff', { name: entry.name }),
          detail: `current=${JSON.stringify(comparableConnector(existing))} imported=${JSON.stringify(comparableConnector(entry))}`.slice(0, 200),
          severity: 'warning',
          target: { adapter: 'mcp', ref: MCP_CONNECTOR_STORE_REL },
        });
      }
    }
    for (const oauth of block.oauthConnections ?? []) {
      items.push({
        id: `mcp-connector:${oauth.key}`, kind: 'Warning', adapter: 'mcp',
        description: msg('adapter.mcpConnectorOauth', { name: oauth.name }),
        severity: 'warning',
      });
    }
    return items;
  }

  async applyItem(item: PlanItem, ctx: ImportContext): Promise<ApplyResult> {
    if (item.id.startsWith(MCP_CONNECTOR_ITEM_PREFIX)) return this.applyConnectorItem(item, ctx);
    const msg = ctx.msg;
    const serverName = item.id.replace(/^mcp:/, '');
    const data = ctx.sections.get('mcp') as McpExportSection | undefined;
    const server = data?.servers.find((s) => s.serverName === serverName);
    if (!server) return { ok: false, message: msg('adapter.mcpMissing', { serverName }) };
    const ref = item.target?.ref;
    if (!ref) return { ok: false, message: msg('adapter.missingTargetRef') };
    const raw = buildMcpPatchLine(ref, server);
    // issue #71：Create 落「来源层的同语义层」（来源是 profile 层 → 目标机当前 profile 层），
    // Update 落「该行当前所在层」—— 两种情况都不把行搬到另一层去（否则同一 lineId 两层各一份）
    const file = item.kind === 'Create'
      ? resolveWriteLayer(server.sourceFile, ctx.target.profile)
      : await locatePatchLineLayer(ctx.target.patchFile, ctx.target.profile, ref);
    await ctx.target.patchFile.applyPatchChanges(file, [
      { lineId: ref, raw, action: item.kind === 'Create' ? 'insert' : 'update' },
    ]);
    return { ok: true, needsRestart: true, message: msg('adapter.mcpWritten', { serverName }) };
  }

  /**
   * 写入一条连接：读全文件 → 只替换 `tables.connections[<key>]` → 整文件原子写。
   *
   * 为什么整文件写而不是走宿主 storage 服务：本机没装 `@deepseek-ai/dsh-storage-domain`，
   * 我们拿不到 `mcp_connector` 域的表句柄；而直接改文件又会被运行中的宿主内存态覆盖 ⇒
   * 计划项与本结果都显式要求重启（needsRestart），写之前先把原文件整体快照（引擎侧按
   * `storages/` 前缀走文件类快照）。
   */
  private async applyConnectorItem(item: PlanItem, ctx: ImportContext): Promise<ApplyResult> {
    const msg = ctx.msg;
    const key = item.id.slice(MCP_CONNECTOR_ITEM_PREFIX.length);
    const data = ctx.sections.get('mcp') as McpExportSection | undefined;
    const entry = data?.connectors?.connections.find((c) => c.key === key);
    if (entry === undefined) return { ok: false, message: msg('adapter.mcpConnectorMissing', { name: key }) };
    const refill = refillFieldsOf(entry);
    if (refill.length > 0) {
      return { ok: false, message: msg('adapter.mcpConnectorNeedsRefill', { name: entry.name }) };
    }
    const store = await readConnectorStore(ctx.target.fs);
    if (store.exists && !store.parsed) {
      return { ok: false, message: msg('adapter.mcpConnectorTargetUnreadable', { reason: store.error ?? 'unknown' }) };
    }
    const existing = findConnectorRecord(store.connections, entry);
    const record = buildConnectorRecord(entry, {
      existing,
      key: pickConnectorKey(store.connections, entry),
      now: Date.now(),
    });
    const text = mergeConnectorIntoStoreText(store, record);
    await ctx.target.fs.writeFile(MCP_CONNECTOR_STORE_REL, new TextEncoder().encode(text));
    return { ok: true, needsRestart: true, message: msg('adapter.mcpConnectorWritten', { name: entry.name }) };
  }

  async validate(data: McpExportSection, msg: MsgFunc = zhMsg): Promise<ValidationResult> {
    return validateJsonSection<McpExportSection>('mcp', data, msg, (section, issues) => {
      if (!Array.isArray(section.servers)) {
        issues.push({ path: 'servers', message: msg('adapter.validate.array', { subject: 'servers' }), severity: 'error' });
      } else {
        for (const s of section.servers) {
          if (s === null || typeof s !== 'object' || typeof s.serverName !== 'string' || s.serverName === '') {
            issues.push({ path: 'servers[]', message: msg('adapter.validate.serverName'), severity: 'error' });
          }
        }
      }
      // connectors 是**可选追加字段**：旧备份没有它 = 合法；有它但形态不对才算错
      const connectors = section.connectors;
      if (connectors !== undefined) {
        if (connectors === null || typeof connectors !== 'object' || !Array.isArray((connectors as { connections?: unknown }).connections)) {
          issues.push({ path: 'connectors.connections', message: msg('adapter.validate.array', { subject: 'connectors.connections' }), severity: 'error' });
        } else {
          for (const c of (connectors as { connections: unknown[] }).connections) {
            if (c === null || typeof c !== 'object'
              || typeof (c as { key?: unknown }).key !== 'string' || (c as { key: string }).key === ''
              || typeof (c as { serverName?: unknown }).serverName !== 'string' || (c as { serverName: string }).serverName === '') {
              issues.push({ path: 'connectors.connections[]', message: msg('adapter.mcpConnectorInvalid'), severity: 'error' });
            }
          }
        }
      }
    });
  }
}
