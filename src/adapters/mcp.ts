/**
 * mcp 分区 adapter（设计 §3.3/§1.2/§15）：
 * 数据源 = 组合 patch 中 dsh-mcp-client 行的 config（研究报告 §2.2：MCP 无 settings 面/无管理 API）。
 * 导入 = 写 profile cordis.patch.yml 插行（needsRestart 生效）；依赖检测（npx 等）由 analyzer 的
 * dependencyChecker 执行（§15：缺失不阻塞，标记 Requires Attention）。
 *
 * patch 行 raw 支持两种形态：单行 { id, name, config } 与块 { insert: [{ id, name, config }] }。
 */
import { isDeepStrictEqual } from 'node:util';
import { msgOf, zhMsg } from '../core/messages.ts';
import type { MsgFunc } from '../core/messages.ts';
import type { McpServerEntry, McpSection } from '../schema/types.ts';
import type {
  ApplyResult, ConfigAdapter, ExportOptions, ExportSection, HostContext,
  ImportContext, PlanItem, ValidationResult,
} from '../core/types.ts';
import { USER_PATCH_FILE } from './plugins.ts';

/** 导出记录：McpServerEntry 之外附加来源 patch 行 id（导入写回定位用） */
export interface McpExportEntry extends McpServerEntry {
  sourceLineId: string;
}

export interface McpExportSection { version: 1; servers: McpExportEntry[]; }

/** 从 patch 行数组中提取 MCP server 条目（以 config.serverName 存在为判定） */
export function extractMcpServers(lines: { lineId: string; raw: unknown }[]): McpExportEntry[] {
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

function newLineId(serverName: string): string {
  const slug = serverName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `mcp-${slug || 'server'}`;
}

export class McpAdapter implements ConfigAdapter<McpExportSection> {
  readonly id = 'mcp' as const;
  readonly displayName = 'MCP Servers';
  readonly defaultIncluded = true;
  readonly portability = 'platformSpecific' as const;

  async export(ctx: HostContext, _options: ExportOptions): Promise<ExportSection<McpExportSection>> {
    const warnings: string[] = [];
    let lines: { lineId: string; raw: unknown }[] = [];
    try {
      lines = await ctx.patchFile.readPatchLines(USER_PATCH_FILE);
    } catch (err) {
      warnings.push(msgOf(ctx)('adapter.patchReadFailedMCP', { reason: err instanceof Error ? err.message : String(err) }));
    }
    const servers = extractMcpServers(lines);
    return {
      sectionId: 'mcp',
      data: { version: 1, servers },
      counts: { servers: servers.length },
      warnings,
    };
  }

  async analyzeImport(data: McpExportSection, ctx: ImportContext): Promise<PlanItem[]> {
    const msg = ctx.msg;
    const items: PlanItem[] = [];
    const targetLines = await ctx.target.patchFile.readPatchLines(USER_PATCH_FILE);
    const targetServers = extractMcpServers(targetLines);
    for (const server of data.servers) {
      const id = `mcp:${server.serverName}`;
      const existing = targetServers.find((s) => s.serverName === server.serverName);
      const comparable = { ...server } as Record<string, unknown>;
      delete comparable.sourceLineId;
      if (!existing) {
        const lineId = server.sourceLineId && targetLines.some((l) => l.lineId === server.sourceLineId)
          ? `${server.sourceLineId}-imported`
          : (server.sourceLineId ?? newLineId(server.serverName));
        items.push({
          id, kind: 'Create', adapter: 'mcp',
          description: msg('adapter.mcpCreate', { serverName: server.serverName }),
          detail: `${server.type === 'stdio' ? `${server.command} ${(server.args ?? []).join(' ')}` : server.url}`,
          severity: 'info',
          target: { adapter: 'mcp', ref: lineId },
        });
      } else {
        const existingComparable = { ...existing } as Record<string, unknown>;
        delete existingComparable.sourceLineId;
        if (isDeepStrictEqual(existingComparable, comparable)) {
          items.push({ id, kind: 'Skip', adapter: 'mcp', description: msg('adapter.mcpSame', { serverName: server.serverName }), severity: 'info' });
        } else {
          items.push({
            id, kind: 'Conflict', adapter: 'mcp',
            description: msg('adapter.mcpDiff', { serverName: server.serverName }),
            detail: `current=${JSON.stringify(existingComparable)} imported=${JSON.stringify(comparable)}`.slice(0, 200),
            severity: 'warning',
            target: { adapter: 'mcp', ref: existing.sourceLineId },
          });
        }
      }
    }
    return items;
  }

  async applyItem(item: PlanItem, ctx: ImportContext): Promise<ApplyResult> {
    const msg = ctx.msg;
    const serverName = item.id.replace(/^mcp:/, '');
    const data = ctx.sections.get('mcp') as McpExportSection | undefined;
    const server = data?.servers.find((s) => s.serverName === serverName);
    if (!server) return { ok: false, message: msg('adapter.mcpMissing', { serverName }) };
    const ref = item.target?.ref;
    if (!ref) return { ok: false, message: msg('adapter.missingTargetRef') };
    const raw = buildMcpPatchLine(ref, server);
    await ctx.target.patchFile.applyPatchChanges(USER_PATCH_FILE, [
      { lineId: ref, raw, action: item.kind === 'Create' ? 'insert' : 'update' },
    ]);
    return { ok: true, needsRestart: true, message: msg('adapter.mcpWritten', { serverName }) };
  }

  async validate(data: McpExportSection, msg: MsgFunc = zhMsg): Promise<ValidationResult> {
    const issues: ValidationResult['issues'] = [];
    if (data === null || typeof data !== 'object') {
      return { valid: false, issues: [{ path: '$', message: msg('adapter.validate.object', { subject: 'mcp' }), severity: 'error' }] };
    }
    if (data.version !== 1) {
      issues.push({ path: 'version', message: msg('adapter.validate.version', { value: String(data.version) }), severity: 'error' });
    }
    if (!Array.isArray(data.servers)) {
      issues.push({ path: 'servers', message: msg('adapter.validate.array', { subject: 'servers' }), severity: 'error' });
    } else {
      for (const s of data.servers) {
        if (s === null || typeof s !== 'object' || typeof s.serverName !== 'string' || s.serverName === '') {
          issues.push({ path: 'servers[]', message: msg('adapter.validate.serverName'), severity: 'error' });
        }
      }
    }
    return { valid: issues.filter((i) => i.severity === 'error').length === 0, issues };
  }
}
