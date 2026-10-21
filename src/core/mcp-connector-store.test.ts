/**
 * MCP 连接器存储模块测试：脱敏口径、解析/合并（保留其它表）、`写入前` 的身份与占位符判定。
 *
 * 为什么这些断言值得写死：这里的每个「放宽」都等于把用户的凭据放进备份 ZIP，
 * 每个「收紧」都等于把备份变成不可用的连接（真机 exa 的 URL 就带查询参数）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MCP_CONNECTOR_STORE_REL, REDACTED_LOCAL_VALUE, REDACTED_VALUE,
  buildConnectorRecord, comparableConnector, exportConnectorBlock, exportConnectorRecord,
  findConnectorRecord, mergeConnectorIntoStoreText, parseConnectorStore, pickConnectorKey,
  redactArgs, redactCommand, redactUrl, refillFieldsOf, unresolvedRedactions,
} from './mcp-connector-store.ts';
import type { ConnectorExportEntry, ConnectorRecord } from './mcp-connector-store.ts';

/** 形如 GitHub PAT 的假 token（命中 secret-scanner 的强形状，不依赖名字启发） */
const FAKE_TOKEN = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

function httpRecord(over: Partial<ConnectorRecord> = {}): ConnectorRecord {
  return {
    key: 'github-github',
    connectorId: 'github',
    kind: 'manual',
    name: 'GitHub',
    serverKey: 'github',
    serverName: 'github',
    transport: 'streamable-http',
    url: 'https://api.githubcopilot.com/mcp/',
    headers: { Accept: 'application/json' },
    enabled: true,
    createdAt: 1,
    updatedAt: 2,
    ...over,
  };
}

function stdioRecord(over: Partial<ConnectorRecord> = {}): ConnectorRecord {
  return {
    key: 'chrome-devtools-chrome-devtools',
    connectorId: 'chrome-devtools',
    kind: 'json',
    name: 'Chrome DevTools',
    serverKey: 'chrome-devtools',
    serverName: 'chrome-devtools',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'chrome-devtools-mcp@latest'],
    env: { NO_COLOR: '1' },
    cwd: '',
    enabled: true,
    createdAt: 1,
    updatedAt: 2,
    ...over,
  };
}

/* ------------------------------------------------------------ 脱敏 */

test('redactUrl：端点保留，userinfo 整条替换，查询参数逐项脱敏', () => {
  const plain = redactUrl('https://mcp.context7.com/mcp');
  assert.equal(plain.url, 'https://mcp.context7.com/mcp');
  assert.equal(plain.redacted, false);

  const userinfo = redactUrl('https://alice:secret@mcp.example.com/mcp');
  assert.equal(userinfo.url, REDACTED_VALUE, '带 userinfo 的 URL 只留占位符（凭据在 URL 里）');
  assert.equal(userinfo.redacted, true);

  const query = redactUrl('https://mcp.exa.ai/mcp?tools=web_search&api_key=abc123');
  assert.equal(query.redacted, true);
  assert.ok(query.url?.startsWith('https://mcp.exa.ai/mcp?'), '端点本体必须保住，否则备份还原不了');
  assert.ok(query.url?.includes('tools=web_search'), '非凭据参数原样保留');
  assert.ok(query.url?.includes('api_key='), '凭据参数**保留键名**，只替换值（用户要知道重填哪个）');
  assert.ok(!query.url?.includes('abc123'), '凭据值绝不能出现在导出里');

  assert.equal(redactUrl('not a url').url, REDACTED_VALUE, '解析不了就整条按凭据处理（宁严勿松）');
  assert.equal(redactUrl(undefined).redacted, false);
});

test('redactCommand：裸命令名保留，绝对路径/带路径的命令换本机值占位符', () => {
  assert.deepEqual(redactCommand('npx'), { command: 'npx', redacted: false });
  assert.deepEqual(redactCommand('uvx'), { command: 'uvx', redacted: false });
  assert.deepEqual(redactCommand('/usr/local/bin/node'), { command: REDACTED_LOCAL_VALUE, redacted: true });
  assert.deepEqual(redactCommand('C:\\Program Files\\node.exe'), { command: REDACTED_LOCAL_VALUE, redacted: true });
});

test('redactArgs：普通参数保留，密钥参数（含 --flag=value 与 flag 后跟值）替换', () => {
  const plain = redactArgs(['-y', 'chrome-devtools-mcp@latest']);
  assert.deepEqual(plain.args, ['-y', 'chrome-devtools-mcp@latest']);
  assert.equal(plain.redacted, false);

  const eq = redactArgs(['--api-key=' + FAKE_TOKEN]);
  assert.deepEqual(eq.args, ['--api-key=' + REDACTED_VALUE]);
  assert.equal(eq.redacted, true);

  const pair = redactArgs(['--token', FAKE_TOKEN, 'serve']);
  assert.deepEqual(pair.args, ['--token', REDACTED_VALUE, 'serve'], 'flag 后的值要跟着脱敏，普通参数不受影响');
  assert.equal(pair.redacted, true);

  const shaped = redactArgs([FAKE_TOKEN]);
  assert.deepEqual(shaped.args, [REDACTED_VALUE], '无 flag 但形状像密钥的参数同样替换');
});

test('exportConnectorRecord：Authorization 与 token 必脱敏，Accept 原样保留', () => {
  const rec = httpRecord({
    headers: { Accept: 'application/json', Authorization: 'Bearer ' + FAKE_TOKEN },
    auth: { mode: 'bearer', bearerToken: FAKE_TOKEN },
  });
  const entry = exportConnectorRecord(rec);
  assert.equal(entry.headers?.['Accept'], 'application/json');
  assert.equal(entry.headers?.['Authorization'], REDACTED_VALUE);
  assert.equal(entry.authMode, 'bearer');
  assert.equal(entry.bearerToken, REDACTED_VALUE);
  assert.ok(entry.redactedFields?.includes('bearerToken'));
  assert.ok(entry.redactedFields?.includes('headers'));
  assert.equal(JSON.stringify(entry).includes(FAKE_TOKEN), false, '导出条目里绝不能残留真实 token');
});

test('exportConnectorRecord：stdio 的 cwd 换本机占位符、env 按值/名判脱敏', () => {
  const entry = exportConnectorRecord(stdioRecord({ cwd: 'C:\\Users\\alice', env: { NO_COLOR: '1', GITHUB_TOKEN: FAKE_TOKEN } }));
  assert.equal(entry.command, 'npx');
  assert.deepEqual(entry.args, ['-y', 'chrome-devtools-mcp@latest']);
  assert.equal(entry.cwd, REDACTED_LOCAL_VALUE);
  assert.equal(entry.env?.['NO_COLOR'], '1');
  assert.equal(entry.env?.['GITHUB_TOKEN'], REDACTED_VALUE);
  assert.ok(entry.redactedFields?.includes('cwd'));
});

test('exportConnectorBlock：OAuth 连接只留引用，connections 按 key 排序且不含 oauth', () => {
  const block = exportConnectorBlock([
    httpRecord(),
    httpRecord({ key: 'linear-linear', connectorId: 'linear', serverKey: 'linear', serverName: 'linear', name: 'Linear', auth: { mode: 'oauth', grantKey: 'g1' } }),
    stdioRecord(),
  ], '2026-01-01T00:00:00.000Z');
  assert.deepEqual(block.connections.map((c) => c.key), ['chrome-devtools-chrome-devtools', 'github-github']);
  assert.equal(block.oauthConnections.length, 1);
  assert.deepEqual(block.oauthConnections[0], {
    key: 'linear-linear', connectorId: 'linear', serverKey: 'linear', name: 'Linear', serverName: 'linear',
    enabled: true, action: 'reconnect-oauth',
  });
  assert.equal(JSON.stringify(block).includes('grantKey'), false, 'grantKey 永不导出');
});

/* ------------------------------------------------------------ 解析 */

function storeText(connections: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    unit: { name: 'mcp_connector', version: 1 },
    global: null,
    tables: { connections, grants: {}, catalog: {}, snapshots: {}, governance: {}, connection_scopes: {}, tool_catalog: {}, ...extra },
  });
}

test('parseConnectorStore：正常解析 + connections 以对象形态取值', () => {
  const parsed = parseConnectorStore(storeText({ 'github-github': httpRecord() }));
  assert.equal(parsed.parsed, true);
  assert.equal(parsed.exists, true);
  assert.equal(parsed.connections.length, 1);
  assert.equal(parsed.connections[0]?.key, 'github-github');
});

test('parseConnectorStore：坏 JSON / 形态不对 → parsed:false（绝不当空表）', () => {
  const bad = parseConnectorStore('{ not json');
  assert.equal(bad.parsed, false);
  assert.equal(bad.exists, true);
  assert.ok((bad.error ?? '').length > 0);

  const noTables = parseConnectorStore(JSON.stringify({ unit: { name: 'mcp_connector', version: 1 } }));
  assert.equal(noTables.parsed, false, '没有 tables 就不是我们认识的存储（覆盖写会毁掉用户的连接）');
});

/* ------------------------------------------------------------ 合并 */

test('mergeConnectorIntoStoreText：只替换目标连接，其它表与其它连接逐字保留', () => {
  const read = parseConnectorStore(storeText({ 'github-github': httpRecord() }, { grants: { g1: { key: 'g1' } } }));
  const record = buildConnectorRecord(
    { key: 'context7-context7', connectorId: 'context7', kind: 'manual', name: 'Context7', serverName: 'context7', transport: 'streamable-http', url: 'https://mcp.context7.com/mcp', enabled: true, authMode: 'none' },
    { key: 'context7-context7', now: 42 },
  );
  const text = mergeConnectorIntoStoreText(read, record);
  const next = JSON.parse(text) as Record<string, any>;
  const tables = next['tables'] as Record<string, any>;
  assert.deepEqual(Object.keys(tables['connections']).sort(), ['context7-context7', 'github-github']);
  assert.deepEqual(tables['grants'], { g1: { key: 'g1' } }, 'grants 等其它表必须原样保留');
  assert.equal(tables['connections']['github-github']['url'], 'https://api.githubcopilot.com/mcp/');
  assert.equal(tables['connections']['context7-context7']['serverName'], 'context7');
});

test('mergeConnectorIntoStoreText：同一条合并两次文本完全一致（幂等）', () => {
  const entry: ConnectorExportEntry = exportConnectorRecord(stdioRecord());
  const read0 = parseConnectorStore(storeText({}));
  const first = mergeConnectorIntoStoreText(read0, buildConnectorRecord(entry, { key: entry.key, now: 1000 }));
  const read1 = parseConnectorStore(first);
  const second = mergeConnectorIntoStoreText(read1, buildConnectorRecord(entry, { key: entry.key, existing: read1.connections[0], now: 1000 }));
  assert.equal(second, first);
});

test('mergeConnectorIntoStoreText：空文件 → 补齐 unit/global/tables 骨架', () => {
  const text = mergeConnectorIntoStoreText(
    { parsed: false, exists: false, connections: [] },
    buildConnectorRecord(exportConnectorRecord(stdioRecord()), { key: 'k', now: 1 }),
  );
  const next = JSON.parse(text) as Record<string, any>;
  assert.deepEqual(next['unit'], { name: 'mcp_connector', version: 1 });
  assert.equal(next['global'], null);
  assert.ok(next['tables']['connections']['k']);
});

/* ------------------------------------------------------------ 身份 / 键 */

test('findConnectorRecord：按 (connectorId, serverName) 认身份，key 变了一样认得出', () => {
  const records = [httpRecord()];
  const byKey: ConnectorExportEntry = exportConnectorRecord(httpRecord());
  assert.equal(findConnectorRecord(records, byKey)?.key, 'github-github');
  const renamedKey = { ...byKey, key: 'github-github-2' };
  assert.equal(findConnectorRecord(records, renamedKey)?.key, 'github-github', 'key 变了但身份相同 → 仍认得出是同一条');
  const otherIdentity = { ...byKey, key: 'github-github', connectorId: 'other', serverName: 'other' };
  assert.equal(findConnectorRecord(records, otherIdentity), undefined, '同 key 不同身份绝不算同一条（否则会覆盖无关连接）');
});

test('pickConnectorKey：同身份复用既有 key；key 被占用则加后缀', () => {
  const records = [httpRecord()];
  assert.equal(pickConnectorKey(records, { ...exportConnectorRecord(httpRecord()), key: 'other' }), 'github-github');
  const occupied = [stdioRecord({ key: 'new-key' }), httpRecord()];
  const entry: ConnectorExportEntry = { ...exportConnectorRecord(httpRecord()), key: 'new-key', connectorId: 'x', serverName: 'x' };
  assert.equal(pickConnectorKey(occupied, entry), 'new-key-2');
});

test('comparableConnector：忽略 key 与时间戳（否则每次导入都是 Conflict）', () => {
  const a = comparableConnector(httpRecord({ updatedAt: 10 }));
  const b = comparableConnector(httpRecord({ key: 'github-github-2', updatedAt: 999 }));
  assert.deepEqual(a, b);
});

test('buildConnectorRecord：保留 createdAt、刷新 updatedAt、不残留上一种 transport 的字段', () => {
  const existing = httpRecord({ createdAt: 5, updatedAt: 6, url: 'https://old/mcp' });
  const record = buildConnectorRecord(exportConnectorRecord(stdioRecord()), { existing, key: 'github-github', now: 77 });
  assert.equal(record.createdAt, 5);
  assert.equal(record.updatedAt, 77);
  assert.equal(record.command, 'npx');
  assert.equal('url' in record, false, 'transport 变成 stdio 后必须剔除 url/headers，否则 DSH 会按两套解析');
  assert.equal('headers' in record, false);
});

/* ------------------------------------------------------------ 占位符 */

test('unresolvedRedactions：找出全部占位符路径', () => {
  const paths = unresolvedRedactions({ a: REDACTED_VALUE, b: { c: REDACTED_LOCAL_VALUE }, d: ['ok', REDACTED_VALUE] });
  assert.deepEqual(paths, ['$.a', '$.b.c', '$.d[1]']);
  assert.deepEqual(unresolvedRedactions({ ok: 'value' }), []);
});

test('refillFieldsOf：redactedFields 与占位符路径合并去重', () => {
  const entry: ConnectorExportEntry = {
    key: 'k', connectorId: 'c', kind: 'manual', name: 'n', serverName: 's', transport: 'streamable-http',
    enabled: true, authMode: 'bearer', bearerToken: REDACTED_VALUE,
    headers: { Authorization: REDACTED_VALUE }, redactedFields: ['bearerToken'],
  };
  const fields = refillFieldsOf(entry);
  assert.deepEqual(fields, ['bearerToken', 'headers.Authorization']);
});

test('MCP_CONNECTOR_STORE_REL 指向 storage domain 文件（快照/回滚共用同一 ref）', () => {
  assert.equal(MCP_CONNECTOR_STORE_REL, 'storages/mcp_connector.json');
});
