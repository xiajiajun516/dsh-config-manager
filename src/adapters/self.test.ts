/**
 * self 分区 adapter 测试（插件自身配置备份）：
 * 白名单收集（存在才收、白名单外不收、不递归）、Create/Skip/Conflict 分析、
 * applyItem 写回 $DSH_HOME/dsh-config-manager/<rel>、默认包含 + portable 语义、
 * createAdapters 的 selfDir 挂载行为（缺省挂载 / '' 不挂）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdapters } from './index.ts';
import { SelfAdapter, SELF_CONFIG_FILES } from './self.ts';
import { hashSection } from '../sync/sync-state.ts';
import { makeContext, makeImportContext } from './test-helpers.ts';

test('self: 白名单收集（存在才收，子目录路径保留，白名单外不收集）', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  await src.fs.writeFile('dsh-config-manager/sync/sync-config.json', Buffer.from('{"transport":"git","git":{"repoUrl":"https://x"},"webdav":{}}', 'utf8'));
  await src.fs.writeFile('dsh-config-manager/sync/sync-selection.json', Buffer.from('{"schemaVersion":1,"mode":"default"}', 'utf8'));
  await src.fs.writeFile('dsh-config-manager/sync/ui-prefs.json', Buffer.from('{"schemaVersion":1,"lastSyncChannel":"webdav"}', 'utf8'));
  // 白名单外：历史/缓存/快照/临时产物不得收集
  await src.fs.writeFile('dsh-config-manager/sync/sync-history.json', Buffer.from('{"schemaVersion":1}', 'utf8'));
  await src.fs.writeFile('dsh-config-manager/market/cache/index.json', Buffer.from('{}', 'utf8'));
  await src.fs.writeFile('dsh-config-manager/snapshots/x/snapshot.json', Buffer.from('{}', 'utf8'));
  await src.fs.writeFile('dsh-config-manager/tmp/tmp.zip', Buffer.from('PK', 'utf8'));

  const adapter = new SelfAdapter();
  const out = await adapter.export(src, { includeSecrets: false });
  const rels = out.data.files.map((f) => f.relativePath).sort();
  assert.deepEqual(rels, [
    'sync/sync-config.json',
    'sync/sync-selection.json',
    'sync/ui-prefs.json',
  ]);
  assert.equal(out.counts.files, 3);
  assert.equal(out.warnings.length, 0, '存在文件时不告警');
  // 白名单常量齐全（sync-autosync / market-config 未创建时自然跳过）
  assert.ok(SELF_CONFIG_FILES.includes('sync/sync-autosync.json'));
  assert.ok(SELF_CONFIG_FILES.includes('market/market-config.json'));
});

test('self: 默认包含 + portable（Quick Export 推荐项）', () => {
  const adapter = new SelfAdapter();
  assert.equal(adapter.defaultIncluded, true, '插件自身配置默认导出');
  assert.equal(adapter.portability, 'portable');
});

test('self: 全部缺失 → 空分区 + dirEmpty 警告', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  const adapter = new SelfAdapter();
  const out = await adapter.export(src, { includeSecrets: false });
  assert.equal(out.data.files.length, 0);
  assert.ok(out.warnings.length > 0, '缺失时给出提示');
});

test('self: 导入往返（Create → 写回 $DSH_HOME/dsh-config-manager/<rel>；幂等 Skip；不同 Conflict）', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  await src.fs.writeFile('dsh-config-manager/sync/sync-config.json', Buffer.from('{"transport":"git"}', 'utf8'));
  const adapter = new SelfAdapter();
  const out = await adapter.export(src, { includeSecrets: false });

  const sections = new Map([['self', out.data]]);
  const dst = makeContext('linux', '/home/bob');
  let items = await adapter.analyzeImport(out.data, makeImportContext(dst, sections));
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, 'Create');
  const r = await adapter.applyItem(items[0]!, makeImportContext(dst, sections));
  assert.equal(r.ok, true);
  assert.equal(
    Buffer.from(await dst.fs.readFile('dsh-config-manager/sync/sync-config.json')).toString(),
    '{"transport":"git"}',
    '导入写回 $DSH_HOME/dsh-config-manager/sync/sync-config.json（基准目录 + 相对路径）',
  );

  // 幂等：一致 → Skip
  items = await adapter.analyzeImport(out.data, makeImportContext(dst, sections));
  assert.equal(items[0]?.kind, 'Skip');

  // 内容不同 → Conflict
  await dst.fs.writeFile('dsh-config-manager/sync/sync-config.json', Buffer.from('{"transport":"webdav"}', 'utf8'));
  items = await adapter.analyzeImport(out.data, makeImportContext(dst, sections));
  assert.equal(items[0]?.kind, 'Conflict');
});

test('createAdapters: selfDir 缺省挂载 dsh-config-manager；空串不挂载', () => {
  const withSelf = createAdapters({ selfDir: undefined });
  assert.ok(withSelf.some((a) => a.id === 'self'), '缺省挂载 self adapter');

  const withoutSelf = createAdapters({ selfDir: '' });
  assert.ok(!withoutSelf.some((a) => a.id === 'self'), '空串 = 不挂载（自定义 dataDir 在 homeDir 外）');

  const custom = createAdapters({ selfDir: 'my-config-data' });
  const self = custom.find((a) => a.id === 'self') as SelfAdapter | undefined;
  assert.ok(self !== undefined);
  assert.equal(self.baseDir, 'my-config-data', '自定义相对目录透传');
});

/* ---------------- 只读预览：与导出同口径（2026-10 真机「插件自身配置 11.5 MB」修复） ---------------- */

test('self: 预览只列白名单 —— 快照/同步工作副本等内部数据不得进入选择器（与导出逐项相等）', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  const syncConfig = Buffer.from('{"transport":"git"}', 'utf8');
  const uiPrefs = Buffer.from('{"schemaVersion":1}', 'utf8');
  await src.fs.writeFile('dsh-config-manager/sync/sync-config.json', syncConfig);
  await src.fs.writeFile('dsh-config-manager/sync/ui-prefs.json', uiPrefs);
  // 插件自身的数据：此前基类的目录递归把它们全当成该分区的「可勾选单元」
  await src.fs.writeFile('dsh-config-manager/snapshots/eec/snapshot.json', Buffer.from('x'.repeat(4096), 'utf8'));
  await src.fs.writeFile('dsh-config-manager/config-snapshots/2026/config-snapshot.json', Buffer.from('x'.repeat(4096), 'utf8'));
  await src.fs.writeFile('dsh-config-manager/sync/work/snapshots/s1/self/sync/sync-config.json', Buffer.from('{}', 'utf8'));
  await src.fs.writeFile('dsh-config-manager/transactions/completed/t.json', Buffer.from('{}', 'utf8'));
  await src.fs.writeFile('dsh-config-manager/exports/dsh-config-2026.zip', Buffer.from('PK', 'utf8'));
  await src.fs.writeFile('dsh-config-manager/profiles/work/profile.json', Buffer.from('{}', 'utf8'));

  const adapter = new SelfAdapter();
  const exported = await adapter.export(src, { includeSecrets: false });
  const previewed = await adapter.preview(src, { includeSecrets: false });

  assert.deepEqual(
    previewed.items.map((u) => u.id),
    ['self:sync/sync-config.json', 'self:sync/ui-prefs.json'],
    '预览只列白名单里的配置（回归：只覆写 export() 时会列出上述全部 8 个文件）',
  );
  assert.equal(previewed.sizeBytes, syncConfig.byteLength + uiPrefs.byteLength, '体积只算白名单文件');
  assert.deepEqual(previewed.items, adapter.listUnits(exported), '预览的单元清单必须与导出逐项相同');
  assert.deepEqual(previewed.section.counts, exported.counts);
  assert.deepEqual(previewed.section.warnings, exported.warnings);
  assert.deepEqual(
    previewed.section.data.files.map((x) => x.relativePath),
    exported.data.files.map((x) => x.relativePath),
    '预览的条目与顺序必须与导出相同',
  );
});

test('self: 磁盘体检新统计的目录（rollback-points / 遗留 checkpoints）不进本分区载荷', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  const syncConfig = Buffer.from('{"transport":"git"}', 'utf8');
  await src.fs.writeFile('dsh-config-manager/sync/sync-config.json', syncConfig);
  // 磁盘体检会统计这两块占用（回滚点库 + 旧检查点库）——但它们是**数据**，不是 self 分区的配置
  await src.fs.writeFile('dsh-config-manager/rollback-points/index.json', Buffer.from('x'.repeat(4096), 'utf8'));
  await src.fs.writeFile('dsh-config-manager/rollback-points/objects/rb-1/session.v4.jsonl.zstd', Buffer.from('x'.repeat(4096), 'utf8'));
  await src.fs.writeFile('dsh-config-manager/checkpoints/cp-1/files/a.bin', Buffer.from('x'.repeat(4096), 'utf8'));
  await src.fs.writeFile('dsh-config-manager/checkpoints/index.json', Buffer.from('{}', 'utf8'));

  const adapter = new SelfAdapter();
  const exported = await adapter.export(src, { includeSecrets: false });
  const previewed = await adapter.preview(src, { includeSecrets: false });
  const rels = exported.data.files.map((f) => f.relativePath);

  assert.deepEqual(rels, ['sync/sync-config.json'], '白名单外一律不收（新增统计目录不得混进载荷）');
  assert.equal(new Set(rels).size, rels.length, '不得出现重复条目');
  assert.equal(exported.counts.files, 1);
  assert.deepEqual(
    previewed.items.map((u) => u.id),
    ['self:sync/sync-config.json'],
    '预览与导出同口径（只列白名单）',
  );
  assert.equal(previewed.sizeBytes, syncConfig.byteLength, '体积只算白名单文件');
});

test('self: 宿主未实现 statSize（旧版门面）时，白名单判定仍只收配置、不误列内部数据', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  await src.fs.writeFile('dsh-config-manager/sync/sync-config.json', Buffer.from('{}', 'utf8'));
  await src.fs.writeFile('dsh-config-manager/snapshots/x/snapshot.json', Buffer.from('{}', 'utf8'));
  Object.defineProperty(src.fs, 'statSize', { value: undefined, configurable: true });

  const adapter = new SelfAdapter();
  const previewed = await adapter.preview(src, { includeSecrets: false });
  assert.deepEqual(previewed.items.map((u) => u.id), ['self:sync/sync-config.json']);
  assert.equal(previewed.sizeBytes, 2, '退回 readFile 时体积 = 文件字节数');
});

/* ---------------- issue #73：调度配置不得因运行态漂移而每轮重现 ---------------- */

const AUTOSYNC_REL = 'dsh-config-manager/sync/sync-autosync.json';
const BACKUP_SCHEDULE_REL = 'dsh-config-manager/sync/backup-schedule.json';

test('self: 调度配置仅运行态不同 → Skip（键序不同亦然）；配置本体不同 → Conflict', async () => {
  const adapter = new SelfAdapter();
  const remote = JSON.stringify({
    schemaVersion: 2,
    channels: {
      git: { enabled: true, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 0, lastRunAt: '2026-10-01T00:00:00.000Z', lastRunStatus: 'success' },
      webdav: { enabled: false, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 0 },
    },
  }, null, 2);
  const src = makeContext('win32', 'C:\\Users\\alice');
  await src.fs.writeFile(AUTOSYNC_REL, Buffer.from(remote, 'utf8'));
  const out = await adapter.export(src, { includeSecrets: false });
  const sections = new Map([['self', out.data]]);

  // 本机：配置本体一致，但运行态已被本机调度器改写（每轮同步收尾都会发生），且键序不同
  const dst = makeContext('linux', '/home/bob');
  await dst.fs.writeFile(AUTOSYNC_REL, Buffer.from(JSON.stringify({
    schemaVersion: 2,
    channels: {
      webdav: { consecutiveFailures: 0, startupMinIntervalMs: 300000, interval: '30m', enabled: false },
      git: { lastRunAt: '2026-10-06T09:00:00.000Z', lastRunStatus: 'failed', lastRunMessage: '网络不可达', lastRunHistoryId: 'h-1', consecutiveFailures: 3, startupMinIntervalMs: 300000, interval: '30m', enabled: true },
    },
  }, null, 2), 'utf8'));
  let items = await adapter.analyzeImport(out.data, makeImportContext(dst, sections));
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, 'Skip', '仅运行态字段不同（且键序不同）→ Skip，否则每轮同步都重现同一条 Conflict');

  // 配置本体（enabled）不同 → 仍是 Conflict（剔除运行态不得把配置差异一起吞掉）
  await dst.fs.writeFile(AUTOSYNC_REL, Buffer.from(JSON.stringify({
    schemaVersion: 2,
    channels: { git: { enabled: false, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 0 } },
  }, null, 2), 'utf8'));
  items = await adapter.analyzeImport(out.data, makeImportContext(dst, sections));
  assert.equal(items[0]?.kind, 'Conflict');
});

test('self: backup-schedule.json 同口径 + 坏 JSON 回落整文件哈希', async () => {
  const adapter = new SelfAdapter();
  const src = makeContext('win32', 'C:\\Users\\alice');
  await src.fs.writeFile(BACKUP_SCHEDULE_REL, Buffer.from(JSON.stringify({
    schemaVersion: 1, enabled: true, interval: '24h', startupMinIntervalMs: 3600000,
    consecutiveFailures: 0, lastRunAt: '2026-10-01T00:00:00.000Z', lastRunStatus: 'success',
  }, null, 2), 'utf8'));
  const out = await adapter.export(src, { includeSecrets: false });
  const sections = new Map([['self', out.data]]);
  const dst = makeContext('linux', '/home/bob');

  await dst.fs.writeFile(BACKUP_SCHEDULE_REL, Buffer.from(JSON.stringify({
    schemaVersion: 1, enabled: true, interval: '24h', startupMinIntervalMs: 3600000,
    consecutiveFailures: 2, lastRunAt: '2026-10-06T09:00:00.000Z', lastRunStatus: 'failed',
  }, null, 2), 'utf8'));
  let items = await adapter.analyzeImport(out.data, makeImportContext(dst, sections));
  assert.equal(items[0]?.kind, 'Skip');

  // 坏 JSON：判不出可比形态 → 回落整文件哈希（「判不出来」绝不等于「相同」）
  await dst.fs.writeFile(BACKUP_SCHEDULE_REL, Buffer.from('{broken', 'utf8'));
  items = await adapter.analyzeImport(out.data, makeImportContext(dst, sections));
  assert.equal(items[0]?.kind, 'Conflict', '包内合法 JSON vs 本机坏 JSON → Conflict（不能因解析失败就放行）');
});

test('self: 其余白名单文件的比对口径不外溢（仍是整文件哈希）', async () => {
  const adapter = new SelfAdapter();
  const src = makeContext('win32', 'C:\\Users\\alice');
  await src.fs.writeFile('dsh-config-manager/sync/sync-config.json', Buffer.from('{"transport":"git","git":{"repoUrl":"https://x"},"webdav":{}}', 'utf8'));
  const out = await adapter.export(src, { includeSecrets: false });
  const sections = new Map([['self', out.data]]);
  const dst = makeContext('linux', '/home/bob');
  await dst.fs.writeFile('dsh-config-manager/sync/sync-config.json', Buffer.from('{ "webdav": {}, "git": { "repoUrl": "https://x" }, "transport": "git" }', 'utf8'));
  const items = await adapter.analyzeImport(out.data, makeImportContext(dst, sections));
  assert.equal(items[0]?.kind, 'Conflict', '键序不同但语义相同 —— sync-config 不是调度配置，仍按字节判');
});

/**
 * issue #127 回归：运行态漂移不得改变导出的分区 hash。
 *
 * 现场：调度器每轮收尾改写 sync-autosync.json 的运行态字段 → self 分区 hashSection 每轮都变
 * → SyncEngine.hasLocalChanges() 永远为真 → 自动同步的每次远端轮询（缺省 60s）都真推一个
 * 只差 lastRunAt 的新快照（真机 2026-10-25 一天 41 次 push，远端累积 325 个垃圾快照）。
 */
test('self: 运行态改写不改变分区 hash（自动同步不再每轮误判「本地有改动」）', async () => {
  const rel = 'dsh-config-manager/sync/sync-autosync.json';
  const src = makeContext('win32', 'C:\\Users\\alice');
  const adapter = new SelfAdapter();
  const config = (runState: Record<string, unknown>, repoUrl: string) => JSON.stringify({
    schemaVersion: 2,
    channels: {
      git: { enabled: true, intervalMinutes: 30, realtime: true, remoteCheckMs: 60000, repoUrl, branch: 'main', ...runState },
      webdav: { enabled: false },
    },
  }, null, 2);

  await src.fs.writeFile(rel, Buffer.from(config({ lastRunAt: '2026-10-25T12:00:00.000Z', lastRunStatus: 'success', lastRunHistoryId: 'h-1', consecutiveFailures: 0 }, 'https://x/repo.git'), 'utf8'));
  const first = await adapter.export(src, { includeSecrets: false });

  // 模拟一次同步收尾：只推进运行态（配置本体不动）
  await src.fs.writeFile(rel, Buffer.from(config({ lastRunAt: '2026-10-25T12:01:00.000Z', lastRunStatus: 'failed', lastRunMessage: 'boom', lastRunHistoryId: 'h-2', consecutiveFailures: 1 }, 'https://x/repo.git'), 'utf8'));
  const second = await adapter.export(src, { includeSecrets: false });

  assert.equal(
    hashSection(second.data),
    hashSection(first.data),
    '仅运行态不同 → 分区 hash 必须不变（否则每轮远端轮询都真推一次）',
  );
  const payload = Buffer.from(second.data.files.find((f) => f.relativePath === 'sync/sync-autosync.json')!.data).toString('utf8');
  assert.ok(!payload.includes('lastRunAt'), '导出载荷不含运行态：远端不该接收本机执行记录');
  assert.ok(!payload.includes('consecutiveFailures'));
  assert.ok(payload.includes('"repoUrl":"https://x/repo.git"'), '配置本体仍在载荷里');

  // 配置本体变化必须被识别（不能把运行态过滤做成「什么都判不变」）
  await src.fs.writeFile(rel, Buffer.from(config({ lastRunAt: '2026-10-25T12:02:00.000Z' }, 'https://y/repo.git'), 'utf8'));
  const third = await adapter.export(src, { includeSecrets: false });
  assert.notEqual(hashSection(third.data), hashSection(second.data), '真实配置变化必须让分区 hash 变化');
});

/**
 * issue #119 回归：跳过码翻转不得改变分区 hash。
 *
 * 现场（0.2.0 / macOS desktop / git 通道 + 自动同步 60s 远端轮询）：配置一字未改，远端仓库
 * 每分钟多 1~2 个 commit，15 分钟 24 个。根因 = 调度器「跳过」轮写
 * lastRunSkipReason='upToDate'（冲突轮写 'conflict' + lastRunSkipCount），而「真推」轮收尾
 * 又把它们清空（toChannelPayload 空值不写）；两个字段不在剔除表里 → self 分区 hash 每轮翻新
 * → hasLocalChanges() 恒真 → 每轮都真推一个新快照。
 */
test('self: 跳过码翻转不改变分区 hash（issue #119：自动同步不再每轮真推快照）', async () => {
  const rel = 'dsh-config-manager/sync/sync-autosync.json';
  const src = makeContext('win32', 'C:\\Users\\alice');
  const adapter = new SelfAdapter();
  const config = (runState: Record<string, unknown>, repoUrl = 'https://x/repo.git') => JSON.stringify({
    schemaVersion: 2,
    channels: {
      git: { enabled: true, intervalMinutes: 30, realtime: true, remoteCheckMs: 60000, repoUrl, branch: 'main', ...runState },
      webdav: { enabled: false },
    },
  }, null, 2);

  // 轮次 A：跳过（无本地改动）
  await src.fs.writeFile(rel, Buffer.from(config({ lastRunAt: '2026-10-29T09:00:00.000Z', lastRunStatus: 'success', lastRunSkipReason: 'upToDate', consecutiveFailures: 0 }), 'utf8'));
  const skipRound = await adapter.export(src, { includeSecrets: false });

  // 轮次 B：真推一次 —— 跳过码被清空，其余与 A 相同
  await src.fs.writeFile(rel, Buffer.from(config({ lastRunAt: '2026-10-29T09:01:00.000Z', lastRunStatus: 'success', consecutiveFailures: 0 }), 'utf8'));
  const pushRound = await adapter.export(src, { includeSecrets: false });

  // 轮次 C：跳过（冲突，带待确认分区数）
  await src.fs.writeFile(rel, Buffer.from(config({ lastRunAt: '2026-10-29T09:02:00.000Z', lastRunStatus: 'success', lastRunSkipReason: 'conflict', lastRunSkipCount: 3, consecutiveFailures: 0 }), 'utf8'));
  const conflictRound = await adapter.export(src, { includeSecrets: false });

  const base = hashSection(skipRound.data);
  assert.equal(hashSection(pushRound.data), base, '跳过码被清空不得改变分区 hash（否则每轮都判「本地有改动」）');
  assert.equal(hashSection(conflictRound.data), base, '跳过码换值 / 带分区数不得改变分区 hash');

  const payload = Buffer.from(pushRound.data.files.find((f) => f.relativePath === 'sync/sync-autosync.json')!.data).toString('utf8');
  assert.ok(!payload.includes('lastRunSkip'), '导出载荷不含跳过码：远端不该接收本机执行记录');
  assert.ok(payload.includes('"repoUrl":"https://x/repo.git"'), '配置本体仍在载荷里');

  // 同一份远端载荷回灌本机（本机多出跳过码）→ Skip，不是 Conflict
  const dst = makeContext('linux', '/home/bob');
  await dst.fs.writeFile(rel, Buffer.from(config({ lastRunAt: '2026-10-29T09:05:00.000Z', lastRunStatus: 'success', lastRunSkipReason: 'upToDate' }), 'utf8'));
  const sections = new Map([['self', pushRound.data]]);
  let items = await adapter.analyzeImport(pushRound.data, makeImportContext(dst, sections));
  assert.equal(items[0]?.kind, 'Skip', '仅跳过码不同 → Skip（此前每轮判 Conflict 并重复推送）');

  // 配置本体变化仍必须被识别（不能把剔除做成「什么都判不变」）
  await dst.fs.writeFile(rel, Buffer.from(config({ lastRunSkipReason: 'upToDate' }, 'https://y/repo.git'), 'utf8'));
  items = await adapter.analyzeImport(pushRound.data, makeImportContext(dst, sections));
  assert.equal(items[0]?.kind, 'Conflict', '真实配置变化必须仍判 Conflict');
});