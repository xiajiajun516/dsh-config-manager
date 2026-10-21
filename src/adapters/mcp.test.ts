/**
 * mcp adapter 测试：组合 patch 提取（单行 + insert 块）、Create/Skip/Conflict、
 * applyItem 写 patch 行（needsRestart）、validate。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { McpAdapter, extractMcpServers, buildMcpPatchLine, mcpServerUnitId, mcpConnectorUnitId } from './mcp.ts';
import { makeContext, makeImportContext } from './test-helpers.ts';
import type { PlanItem } from '../core/types.ts';

test('mcp: extractMcpServers 兼容单行与 insert 块', () => {
  const lines = [
    {
      lineId: 'mcp-fs',
      raw: {
        id: 'mcp-fs',
        name: 'dsh-mcp-client',
        config: { serverName: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'], cwd: 'C:\\Users\\alice\\projects' },
      },
    },
    {
      lineId: 'mcp-http',
      raw: {
        insert: [
          { id: 'mcp-http', name: 'dsh-mcp-client', config: { serverName: 'remote', url: 'https://mcp.example.com/sse', headers: { Authorization: 'Bearer abc' } } },
        ],
      },
    },
    { lineId: 'other', raw: { id: 'other', name: '@deepseek-ai/dsh-web', config: { searchProvider: 'deepseek-official' } } },
  ];
  const servers = extractMcpServers(lines);
  assert.equal(servers.length, 2);
  const fs = servers.find((s) => s.serverName === 'filesystem');
  assert.equal(fs?.type, 'stdio');
  assert.equal(fs?.command, 'npx');
  assert.equal(fs?.cwd, 'C:\\Users\\alice\\projects');
  assert.equal(fs?.sourceLineId, 'mcp-fs');
  const http = servers.find((s) => s.serverName === 'remote');
  assert.equal(http?.type, 'streamable-http');
  assert.equal(http?.url, 'https://mcp.example.com/sse');
  assert.equal(http?.sourceLineId, 'mcp-http');
});

test('mcp: buildMcpPatchLine 构造写回行', () => {
  const line = buildMcpPatchLine('mcp-fs', { serverName: 'filesystem', type: 'stdio', command: 'npx', args: ['-y', 'x'] });
  assert.equal(line.id, 'mcp-fs');
  assert.equal(line.name, 'dsh-mcp-client');
  assert.equal((line.config as Record<string, unknown>)['command'], 'npx');
});

test('mcp: export 提取 + analyzeImport Create/Skip/Conflict + applyItem 写 patch（needsRestart）', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  src.patchFile.lines.set('mcp-fs', {
    lineId: 'mcp-fs',
    raw: { id: 'mcp-fs', name: 'dsh-mcp-client', config: { serverName: 'filesystem', command: 'npx', args: ['-y', 'x'] } },
  });
  const adapter = new McpAdapter();
  const exported = await adapter.export(src, { includeSecrets: false });
  assert.equal(exported.data.servers.length, 1);
  assert.equal(exported.data.servers[0]?.serverName, 'filesystem');
  const sections = new Map([['mcp', exported.data]]);

  const dst = makeContext('linux', '/home/bob');
  let items = await adapter.analyzeImport(exported.data, makeImportContext(dst, sections));
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, 'Create');
  assert.equal(items[0]?.target?.ref, 'mcp-fs');
  let r = await adapter.applyItem(items[0]!, makeImportContext(dst, sections));
  assert.equal(r.ok, true);
  assert.equal(r.needsRestart, true, 'MCP 写 patch 必须重启生效');
  assert.ok(dst.patchFile.lines.has('mcp-fs'));
  assert.equal((dst.patchFile.lines.get('mcp-fs')?.raw as Record<string, unknown>)['name'], 'dsh-mcp-client');

  // 幂等：同 serverName 同内容 → Skip
  items = await adapter.analyzeImport(exported.data, makeImportContext(dst, sections));
  assert.equal(items[0]?.kind, 'Skip');

  // 目标同 serverName 不同内容 → Conflict（target.ref = 目标行 id）
  dst.patchFile.lines.set('mcp-fs', {
    lineId: 'mcp-fs',
    raw: { id: 'mcp-fs', name: 'dsh-mcp-client', config: { serverName: 'filesystem', command: 'npx', args: ['-y', 'other'] } },
  });
  items = await adapter.analyzeImport(exported.data, makeImportContext(dst, sections));
  assert.equal(items[0]?.kind, 'Conflict');
  const useItem: PlanItem = { ...items[0]!, kind: 'Update' };
  r = await adapter.applyItem(useItem, makeImportContext(dst, sections));
  assert.equal(r.ok, true);
  const raw = dst.patchFile.lines.get('mcp-fs')?.raw as Record<string, unknown>;
  assert.deepEqual((raw['config'] as Record<string, unknown>)['args'], ['-y', 'x'], 'Conflict useImported 应更新目标行');
});

test('issue #71: profile 层 MCP 行也要导出，且写回**原层**（不再凭空消失 / 不搬家）', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice', 'tauri');
  // 真机形态：MCP server 由手写/工具写进 profile 层（home 层只有别的行）
  src.patchFile.bucket('profiles/tauri/cordis.patch.yml').set('mcp-codegraph', {
    lineId: 'mcp-codegraph',
    raw: { id: 'mcp-codegraph', name: 'dsh-mcp-client', config: { serverName: 'codegraph', command: 'codegraph', args: ['serve', '--mcp'] } },
  });
  const adapter = new McpAdapter();
  const exported = await adapter.export(src, { includeSecrets: false });
  assert.equal(exported.data.servers.length, 1, 'profile 层的 server 必须在备份里（此前只读 home 层 → 恒为空）');
  const server = exported.data.servers[0];
  assert.equal(server?.serverName, 'codegraph');
  assert.equal(server?.sourceFile, 'profiles/tauri/cordis.patch.yml', '必须记住来源层，写回才能落回原层');
  const sections = new Map([['mcp', exported.data]]);

  // 目标机：同一 profile，patch 两层都空 → Create
  const dst = makeContext('linux', '/home/bob', 'tauri');
  const items = await adapter.analyzeImport(exported.data, makeImportContext(dst, sections));
  assert.equal(items[0]?.kind, 'Create');
  const r = await adapter.applyItem(items[0]!, makeImportContext(dst, sections));
  assert.equal(r.ok, true);
  assert.equal(r.needsRestart, true);
  assert.equal(dst.patchFile.bucket('profiles/tauri/cordis.patch.yml').has('mcp-codegraph'), true, '新行必须落 profile 层（来源层）');
  assert.equal(dst.patchFile.lines.size, 0, '不得把 profile 层的 server 搬到 home 层（同一 lineId 两层各一份会让合并语义不可预期）');
});

test('issue #71: 同名行两层都有 → 只导出优先级更高的一层（home 覆盖 profile）', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice', 'tauri');
  const profileRel = 'profiles/tauri/cordis.patch.yml';
  src.patchFile.lines.set('mcp-fs', {
    lineId: 'mcp-fs',
    raw: { id: 'mcp-fs', name: 'dsh-mcp-client', config: { serverName: 'filesystem', command: 'npx', args: ['-y', 'home'] } },
  });
  src.patchFile.bucket(profileRel).set('mcp-fs', {
    lineId: 'mcp-fs',
    raw: { id: 'mcp-fs', name: 'dsh-mcp-client', config: { serverName: 'filesystem', command: 'npx', args: ['-y', 'profile'] } },
  });
  const exported = await new McpAdapter().export(src, { includeSecrets: false });
  assert.equal(exported.data.servers.length, 1);
  assert.deepEqual(exported.data.servers[0]?.args, ['-y', 'home'], '生效值是 home 层（DSH 合并序里 home 层在后）');
  assert.equal(exported.data.servers[0]?.sourceFile, 'cordis.patch.yml');
});

test('mcp: validate 拒绝无 serverName 的条目', async () => {
  const adapter = new McpAdapter();
  const bad = await adapter.validate({ version: 1, servers: [{ serverName: '' } as never] });
  assert.equal(bad.valid, false);
});

/* ------------------------------------------------------------ 连接器来源（方案 C） */

const enc = (s: string) => new TextEncoder().encode(s);

/** 造一份连接器存储文件（与真机同形态：{unit,global,tables:{connections,...}}） */
function seedStore(ctx: ReturnType<typeof makeContext>, connections: Record<string, unknown>): void {
  void ctx.fs.writeFile('storages/mcp_connector.json', enc(JSON.stringify({
    unit: { name: 'mcp_connector', version: 1 },
    global: null,
    tables: { connections, grants: { g1: { key: 'g1' } }, catalog: {}, snapshots: {} },
  })));
}

const GH_TOKEN = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

function githubConn(): Record<string, unknown> {
  return {
    key: 'github-github', connectorId: 'github', kind: 'manual', name: 'GitHub', serverKey: 'github', serverName: 'github',
    transport: 'streamable-http', url: 'https://api.githubcopilot.com/mcp/',
    headers: { Accept: 'application/json', Authorization: 'Bearer ' + GH_TOKEN },
    auth: { mode: 'bearer', bearerToken: GH_TOKEN },
    enabled: true, createdAt: 1, updatedAt: 2,
  };
}

test('mcp 连接器：export 带上连接器并按规则脱敏（真机 4 条 MCP 的由来）', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  seedStore(src, { 'github-github': githubConn() });
  const exported = await new McpAdapter().export(src, { includeSecrets: false });
  assert.equal(exported.data.servers.length, 0, 'patch 层没有 server（真机形态）');
  assert.equal(exported.data.connectors?.connections.length, 1, '连接器必须进备份，否则 MCP 分区恒为 0');
  assert.equal(exported.counts['connectors'], 1);
  const entry = exported.data.connectors?.connections[0];
  assert.equal(entry?.serverName, 'github');
  assert.equal(entry?.headers?.['Accept'], 'application/json');
  assert.equal(entry?.headers?.['Authorization'], '<REDACTED:REENTER>');
  assert.equal(JSON.stringify(exported.data).includes(GH_TOKEN), false, '备份里绝不能出现真实 token');
});

test('mcp 连接器：存储存在但解析不了 → 出 warning 且不当作空表（不静默）', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  void src.fs.writeFile('storages/mcp_connector.json', enc('{ broken'));
  const exported = await new McpAdapter().export(src, { includeSecrets: false });
  assert.equal(exported.data.connectors, undefined);
  assert.equal(exported.warnings?.length, 1);
  assert.match(String(exported.warnings?.[0]), /连接器存储/);
});

test('mcp 连接器：本机没有该文件 → 静默（没装连接器是正常形态）', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  const exported = await new McpAdapter().export(src, { includeSecrets: false });
  assert.equal(exported.data.connectors, undefined);
  assert.equal(exported.warnings?.length ?? 0, 0);
});

test('mcp 连接器：导入 Create → 写回 → 再分析 Skip（幂等），其它表原样保留', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  seedStore(src, { 'github-github': githubConn() });
  const adapter = new McpAdapter();
  const exported = await adapter.export(src, { includeSecrets: false });
  const sections = new Map([['mcp', exported.data]]);

  // 目标机已有存储（含 grants 与另一条无关连接）→ 写回时这些必须逐字保留
  const dst = makeContext('linux', '/home/bob');
  void dst.fs.writeFile('storages/mcp_connector.json', enc(JSON.stringify({
    unit: { name: 'mcp_connector', version: 1 },
    global: null,
    tables: { connections: { 'keep-me': { key: 'keep-me', connectorId: 'other', serverName: 'other' } }, grants: { g1: { key: 'g1' } }, catalog: { c: 1 } },
  })));
  const items = await adapter.analyzeImport(exported.data, makeImportContext(dst, sections));
  const create = items.find((i) => i.id === 'mcp-connector:github-github');
  assert.equal(create?.kind, 'Warning', '备份里是占位符（token 被脱敏）→ 不写，要求重填');
  assert.equal(create?.target, undefined);

  // 用户重填后（模拟：把占位符换成真值）再导入 → Create 写回
  const refilled = JSON.parse(JSON.stringify(exported.data)) as typeof exported.data;
  const conn = refilled.connectors?.connections[0];
  if (conn !== undefined) {
    conn.bearerToken = 'ghp_' + 'Z'.repeat(36);
    conn.headers = { Accept: 'application/json', Authorization: 'Bearer ghp_' + 'Z'.repeat(36) };
    delete conn.redactedFields;
  }
  const items2 = await adapter.analyzeImport(refilled, makeImportContext(dst, new Map([['mcp', refilled]])));
  const create2 = items2.find((i) => i.id === 'mcp-connector:github-github');
  assert.equal(create2?.kind, 'Create');
  assert.equal(create2?.target?.ref, 'storages/mcp_connector.json', '快照/回滚目标是整文件');
  const r = await adapter.applyItem(create2!, makeImportContext(dst, new Map([['mcp', refilled]])));
  assert.equal(r.ok, true);
  assert.equal(r.needsRestart, true, '改 storage 文件必须重启 DSH 才生效');
  const written = JSON.parse(new TextDecoder().decode(await dst.fs.readFile('storages/mcp_connector.json'))) as Record<string, any>;
  assert.equal(written['tables']['connections']['github-github']['serverName'], 'github');
  assert.deepEqual(written['tables']['grants'], { g1: { key: 'g1' } }, 'grants 等其它表必须原样保留');
  assert.deepEqual(written['tables']['catalog'], { c: 1 }, 'catalog 等其它表必须原样保留');
  assert.equal(written['tables']['connections']['keep-me']['connectorId'], 'other', '目标机既有连接一条都不能丢');

  const items3 = await adapter.analyzeImport(refilled, makeImportContext(dst, new Map([['mcp', refilled]])));
  assert.equal(items3.find((i) => i.id === 'mcp-connector:github-github')?.kind, 'Skip', '同内容再来一次 → Skip（幂等）');
});

test('mcp 连接器：目标存储解析不了 → 只报 warning，零写入', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  seedStore(src, { 'github-github': githubConn() });
  const adapter = new McpAdapter();
  const exported = await adapter.export(src, { includeSecrets: false });
  const refilled = JSON.parse(JSON.stringify(exported.data)) as typeof exported.data;
  const conn = refilled.connectors?.connections[0];
  if (conn !== undefined) delete conn.redactedFields, conn.bearerToken = 'x' + 'y'.repeat(40), conn.headers = { Accept: 'application/json' };
  const dst = makeContext('linux', '/home/bob');
  void dst.fs.writeFile('storages/mcp_connector.json', enc('{ broken'));
  const items = await adapter.analyzeImport(refilled, makeImportContext(dst, new Map([['mcp', refilled]])));
  const storeWarning = items.find((i) => i.id === 'mcp-connector:store');
  assert.equal(storeWarning?.kind, 'Warning');
  assert.equal(items.some((i) => i.kind === 'Create'), false, '目标读不出来时绝不写（整文件改写会毁掉其它表）');
});

test('mcp 连接器：同名 server 同时来自 patch 行与连接器 → 两条都留 + warning（不隐式合并）', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  src.patchFile.lines.set('mcp-github', {
    lineId: 'mcp-github',
    raw: { id: 'mcp-github', name: 'dsh-mcp-client', config: { serverName: 'github', command: 'npx', args: ['-y', 'gh-mcp'] } },
  });
  seedStore(src, { 'github-github': githubConn() });
  const adapter = new McpAdapter();
  const exported = await adapter.export(src, { includeSecrets: false });
  assert.equal(exported.data.servers.length, 1);
  assert.equal(exported.data.connectors?.connections.length, 1);
  const items = await adapter.analyzeImport(exported.data, makeImportContext(makeContext('linux', '/home/bob'), new Map([['mcp', exported.data]])));
  const dupe = items.find((i) => i.id === 'mcp-connector-name:github-github');
  assert.equal(dupe?.kind, 'Warning');
  assert.match(String(dupe?.description), /github/);
});

test('mcp 连接器：OAuth 连接只提示重新授权，不进 connections', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  seedStore(src, {
    'github-github': githubConn(),
    'linear-linear': { key: 'linear-linear', connectorId: 'linear', kind: 'oauth', name: 'Linear', serverKey: 'linear', serverName: 'linear', transport: 'streamable-http', url: 'https://mcp.linear.app/sse', enabled: true, auth: { mode: 'oauth', grantKey: 'g-lin' }, createdAt: 1, updatedAt: 2 },
  });
  const adapter = new McpAdapter();
  const exported = await adapter.export(src, { includeSecrets: false });
  assert.equal(exported.data.connectors?.connections.length, 1, 'oauth 不进 connections（token 不在备份里，导进去也起不来）');
  assert.equal(exported.data.connectors?.oauthConnections.length, 1);
  assert.equal(JSON.stringify(exported.data).includes('g-lin'), false, 'grantKey 永不导出');
  const items = await adapter.analyzeImport(exported.data, makeImportContext(makeContext('linux', '/home/bob'), new Map([['mcp', exported.data]])));
  const oauth = items.find((i) => i.id === 'mcp-connector:linear-linear');
  assert.equal(oauth?.kind, 'Warning');
  assert.match(String(oauth?.description), /重新授权/);
});

test('mcp: validate 接受可选 connectors，形态不对才报错', async () => {
  const adapter = new McpAdapter();
  const ok = await adapter.validate({ version: 1, servers: [], connectors: { format: 'x', version: 1, connections: [{ key: 'k', connectorId: 'c', kind: 'manual', name: 'n', serverName: 's', transport: 'stdio', enabled: true }] } as never });
  assert.equal(ok.valid, true);
  const bad = await adapter.validate({ version: 1, servers: [], connectors: { connections: [{ key: '', serverName: '' }] } as never });
  assert.equal(bad.valid, false);
});

/* ---------------------------------------------------- 条目级选择（展开 / 收起 / 逐项勾选） */

/** 同时有 patch 行 server 与连接器（含 OAuth 引用）的来源上下文 */
function seedBothSources(): ReturnType<typeof makeContext> {
  const src = makeContext('win32', 'C:\\Users\\alice');
  src.patchFile.lines.set('mcp-fs', {
    lineId: 'mcp-fs',
    raw: { id: 'mcp-fs', name: 'dsh-mcp-client', config: { serverName: 'filesystem', command: 'npx', args: ['-y', 'server-fs'] } },
  });
  seedStore(src, {
    'github-github': githubConn(),
    'linear-linear': { key: 'linear-linear', connectorId: 'linear', kind: 'oauth', name: 'Linear', serverKey: 'linear', serverName: 'linear', transport: 'streamable-http', url: 'https://mcp.linear.app/sse', enabled: true, auth: { mode: 'oauth', grantKey: 'g-lin' }, createdAt: 1, updatedAt: 2 },
  });
  return src;
}

test('mcp 条目级：listUnits 同时列出 patch 行、连接器与 OAuth 引用，id 前缀分明', async () => {
  const src = seedBothSources();
  const adapter = new McpAdapter();
  const exported = await adapter.export(src, { includeSecrets: false });
  const units = adapter.listUnits(exported);
  assert.deepEqual(units.map((u) => u.id).sort(), [
    'mcp:connector:github-github',
    'mcp:connector:linear-linear',
    'mcp:patch:filesystem',
  ]);
  const fsUnit = units.find((u) => u.id === 'mcp:patch:filesystem');
  assert.equal(fsUnit?.label, 'filesystem');
  assert.equal(fsUnit?.detail, 'npx -y server-fs', 'stdio 单元给出命令 + 参数');
  const gh = units.find((u) => u.id === 'mcp:connector:github-github');
  assert.equal(gh?.label, 'GitHub');
  assert.match(String(gh?.detail), /streamable-http https:\/\/api\.githubcopilot\.com/);
  const lin = units.find((u) => u.id === 'mcp:connector:linear-linear');
  assert.equal(lin?.detail, 'oauth linear', 'OAuth 连接只带引用，detail 标明它要靠重新授权');
  assert.ok(units.every((u) => u.sizeBytes > 0), '每个单元都要有体积，选择器才能显示大小');
  assert.equal(JSON.stringify(units).includes(GH_TOKEN), false, '单元清单不得带出凭据');
});

test('mcp 条目级：export 只带被勾选的单元（patch 行与连接器互不影响）', async () => {
  const src = seedBothSources();
  const adapter = new McpAdapter();
  const onlyConnector = await adapter.export(src, { includeSecrets: false, includeItems: { mcp: ['mcp:connector:github-github'] } });
  assert.equal(onlyConnector.data.servers.length, 0, '没勾 patch 行就不带 patch 行');
  assert.deepEqual(onlyConnector.data.connectors?.connections.map((c) => c.key), ['github-github']);
  assert.equal(onlyConnector.data.connectors?.oauthConnections.length, 0);
  assert.equal(onlyConnector.counts['connectors'], 1);
  assert.equal(onlyConnector.counts['servers'], 0);

  const onlyPatch = await adapter.export(src, { includeSecrets: false, includeItems: { mcp: ['mcp:patch:filesystem'] } });
  assert.deepEqual(onlyPatch.data.servers.map((s) => s.serverName), ['filesystem']);
  assert.equal(onlyPatch.data.connectors, undefined, '一条连接器都没勾 → connectors 字段整个消失（不留空块冒充已备份）');
  assert.equal(onlyPatch.counts['connectors'], undefined);
});

test('mcp 条目级：空白名单 = 一条都不带（不静默产出空分区）', async () => {
  const src = seedBothSources();
  const adapter = new McpAdapter();
  const none = await adapter.export(src, { includeSecrets: false, includeItems: { mcp: [] } });
  assert.deepEqual(none.data.servers, []);
  assert.equal(none.data.connectors, undefined);
  assert.equal(none.counts['servers'], 0);
});

test('mcp 条目级：单元 id 与 export 自洽（勾哪个就带出哪个）', async () => {
  const src = seedBothSources();
  const adapter = new McpAdapter();
  const exported = await adapter.export(src, { includeSecrets: false });
  for (const unit of adapter.listUnits(exported)) {
    const picked = await adapter.export(src, { includeSecrets: false, includeItems: { mcp: [unit.id] } });
    const inServers = picked.data.servers.some((s) => mcpServerUnitId(s.serverName) === unit.id);
    const inConnections = (picked.data.connectors?.connections ?? []).some((c) => mcpConnectorUnitId(c.key) === unit.id);
    const inOauth = (picked.data.connectors?.oauthConnections ?? []).some((c) => mcpConnectorUnitId(c.key) === unit.id);
    assert.equal(inServers || inConnections || inOauth, true, '单元 ' + unit.id + ' 被列出，勾选后却不在导出里');
  }
});

