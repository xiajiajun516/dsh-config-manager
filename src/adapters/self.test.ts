/**
 * self 分区 adapter 测试（插件自身配置备份）：
 * 白名单收集（存在才收、白名单外不收、不递归）、Create/Skip/Conflict 分析、
 * applyItem 写回 $DSH_HOME/dsh-config-manager/<rel>、默认包含 + portable 语义、
 * createAdapters 的 selfDir 挂载行为（缺省挂载 / '' 不挂）。
 *
 * SEC-01（P0）：sync/sync-config.json 与 sync/sync-autosync.json 都含「同步目标地址」，
 * 允许导入写盘 = 备份包可以改本机同步目标，下一次同步把 token 送进包控制的主机。
 * 因此两者退出裸写白名单：既不导出，也不允许导入写盘（包内出现 → 报告级 warning，绝不静默）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdapters } from './index.ts';
import { SelfAdapter, SELF_CONFIG_FILES, SELF_IMPORT_BLOCKED_RELS, SELF_IMPORT_BLOCKED_CODE, isSelfImportBlocked } from './self.ts';
import { hashSection } from '../sync/sync-state.ts';
import { sha256Hex } from '../utils/hashing.ts';
import { makeContext, makeImportContext } from './test-helpers.ts';

test('self: 白名单收集（存在才收，子目录路径保留，白名单外不收集）', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  await src.fs.writeFile('dsh-config-manager/sync/sync-selection.json', Buffer.from('{"schemaVersion":1,"mode":"default"}', 'utf8'));
  await src.fs.writeFile('dsh-config-manager/sync/ui-prefs.json', Buffer.from('{"schemaVersion":1,"lastSyncChannel":"webdav"}', 'utf8'));
  await src.fs.writeFile('dsh-config-manager/market/market-config.json', Buffer.from('{"schemaVersion":1,"sources":[]}', 'utf8'));
  // SEC-01：含同步目标地址的两个文件不再进载荷（否则备份包可借它改本机同步目标）
  await src.fs.writeFile('dsh-config-manager/sync/sync-config.json', Buffer.from('{"transport":"git","git":{"repoUrl":"https://x"}}', 'utf8'));
  await src.fs.writeFile('dsh-config-manager/sync/sync-autosync.json', Buffer.from('{"schemaVersion":2}', 'utf8'));
  // 白名单外：历史/缓存/快照/临时产物不得收集
  await src.fs.writeFile('dsh-config-manager/sync/sync-history.json', Buffer.from('{"schemaVersion":1}', 'utf8'));
  await src.fs.writeFile('dsh-config-manager/market/cache/index.json', Buffer.from('{}', 'utf8'));
  await src.fs.writeFile('dsh-config-manager/snapshots/x/snapshot.json', Buffer.from('{}', 'utf8'));
  await src.fs.writeFile('dsh-config-manager/tmp/tmp.zip', Buffer.from('PK', 'utf8'));

  const adapter = new SelfAdapter();
  const out = await adapter.export(src, { includeSecrets: false });
  const rels = out.data.files.map((f) => f.relativePath).sort();
  assert.deepEqual(rels, [
    'market/market-config.json',
    'sync/sync-selection.json',
    'sync/ui-prefs.json',
  ]);
  assert.equal(out.counts.files, 3);
  assert.equal(out.warnings.length, 0, '存在文件时不告警');
  // 白名单常量：SEC-01 移出两个同步目标文件，其余照旧
  assert.ok(!SELF_CONFIG_FILES.includes('sync/sync-config.json'), 'SEC-01：sync-config.json 不得在裸写白名单里');
  assert.ok(!SELF_CONFIG_FILES.includes('sync/sync-autosync.json'), 'SEC-01：sync-autosync.json 不得在裸写白名单里');
  assert.ok(SELF_CONFIG_FILES.includes('sync/backup-schedule.json'), '调度配置（无同步目标地址）仍在白名单');
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
  await src.fs.writeFile('dsh-config-manager/sync/ui-prefs.json', Buffer.from('{"schemaVersion":1}', 'utf8'));
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
    Buffer.from(await dst.fs.readFile('dsh-config-manager/sync/ui-prefs.json')).toString(),
    '{"schemaVersion":1}',
    '导入写回 $DSH_HOME/dsh-config-manager/<rel>（基准目录 + 相对路径）',
  );

  // 幂等：一致 → Skip
  items = await adapter.analyzeImport(out.data, makeImportContext(dst, sections));
  assert.equal(items[0]?.kind, 'Skip');

  // 内容不同 → Conflict
  await dst.fs.writeFile('dsh-config-manager/sync/ui-prefs.json', Buffer.from('{"schemaVersion":1,"lastSyncChannel":"s3"}', 'utf8'));
  items = await adapter.analyzeImport(out.data, makeImportContext(dst, sections));
  assert.equal(items[0]?.kind, 'Conflict');
});

/* ---------------- SEC-01：导入包不得写同步目标文件 ---------------- */

test('SEC-01：包内含 sync-config.json / sync-autosync.json → 报告级 warning + 绝不写盘', async () => {
  const adapter = new SelfAdapter();
  const evil = '{"schemaVersion":3,"transport":"git","git":{"repoUrl":"https://attacker.example/collect.git"}}';
  const section = {
    version: 1 as const,
    files: SELF_IMPORT_BLOCKED_RELS.map((relativePath) => ({
      relativePath,
      data: Buffer.from(evil, 'utf8'),
      contentHash: sha256Hex(Buffer.from(evil, 'utf8')),
    })),
  };
  const dst = makeContext('linux', '/home/bob');
  const localConfig = '{"schemaVersion":3,"transport":"git","git":{"repoUrl":"https://github.com/u/r.git"},"webdav":{}}';
  await dst.fs.writeFile('dsh-config-manager/sync/sync-config.json', Buffer.from(localConfig, 'utf8'));
  const ctx = makeImportContext(dst, new Map([['self', section]]));

  const items = await adapter.analyzeImport(section, ctx);
  assert.equal(items.length, SELF_IMPORT_BLOCKED_RELS.length);
  for (const item of items) {
    assert.equal(item.kind, 'Warning', '不写盘项必须是 Warning（引擎跳过：不进快照范围、不调 applyItem）');
    assert.equal(item.severity, 'warning');
    assert.ok((item.description ?? '').length > 0, '必须带可展示文案，不得静默');
    assert.ok(String(item.detail ?? '').startsWith(SELF_IMPORT_BLOCKED_CODE), '必须带稳定机器码: ' + String(item.detail));
    assert.ok(String(item.detail ?? '').includes(item.id.slice('self:'.length)), '机器码里带上具体 rel');
  }

  // 纵深防御：即使绕过引擎直接 apply，也一字节都不写
  for (const item of items) {
    const r = await adapter.applyItem(item, makeImportContext(dst, new Map([['self', section]])));
    assert.equal(r.ok, false, '被挡下的项不得报告成功写入');
  }
  assert.equal(
    Buffer.from(await dst.fs.readFile('dsh-config-manager/sync/sync-config.json')).toString(),
    localConfig,
    '本机既有的同步目标不得被包内地址覆盖',
  );
  assert.equal(await dst.fs.exists('dsh-config-manager/sync/sync-autosync.json'), false, '不得凭空创建同步调度配置');
});

test('SEC-01：分档案作用域 sync-profiles/<p>/ 的同步目标同样拦截（按模式，不按清单）', async () => {
  // 判据：档案名是运行时集合，列举不出来 —— 所以按目录模式判，两种形态必须一致
  for (const rel of [
    'sync-profiles/Test1/sync-config.json',
    'sync-profiles/Test1/sync-autosync.json',
    'sync-profiles/open-design/sync-config.json',
    'sync/sync-config.json',
    'sync/sync-autosync.json',
  ]) {
    assert.equal(isSelfImportBlocked(rel), true, '必须拦下: ' + rel);
  }
  // 不误伤：同目录里的选择/偏好/运行态不是「同步目标」，白名单外也不该被本判据报成安全事件
  for (const rel of [
    'sync-profiles/Test1/sync-selection.json',
    'sync-profiles/Test1/ui-prefs.json',
    'sync-profiles/Test1/sync-state.json',
    'sync-profiles/nested/deep/sync-config.json',
    'sync/sync-selection.json',
  ]) {
    assert.equal(isSelfImportBlocked(rel), false, '不该拦: ' + rel);
  }

  // 计划阶段：包内带分档案同步目标 → 改判 Warning（去掉 target ⇒ 引擎不写盘、不进快照范围）
  const adapter = new SelfAdapter();
  const evil = '{"schemaVersion":3,"transport":"git","git":{"repoUrl":"https://attacker.example/collect.git"}}';
  const relativePath = 'sync-profiles/Test1/sync-config.json';
  const section = {
    version: 1 as const,
    files: [{ relativePath, data: Buffer.from(evil, 'utf8'), contentHash: sha256Hex(Buffer.from(evil, 'utf8')) }],
  };
  const dst = makeContext('linux', '/home/bob');
  const items = await adapter.analyzeImport(section, makeImportContext(dst, new Map([['self', section]])));
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, 'Warning');
  assert.ok(String(items[0]?.detail ?? '').startsWith(SELF_IMPORT_BLOCKED_CODE));
  assert.equal(await dst.fs.exists('dsh-config-manager/' + relativePath), false, '包内地址不得落地');
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
  const uiPrefs = Buffer.from('{"schemaVersion":1}', 'utf8');
  const marketConfig = Buffer.from('{"schemaVersion":1,"sources":[]}', 'utf8');
  await src.fs.writeFile('dsh-config-manager/sync/ui-prefs.json', uiPrefs);
  await src.fs.writeFile('dsh-config-manager/market/market-config.json', marketConfig);
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
    ['self:sync/ui-prefs.json', 'self:market/market-config.json'],
    '预览只列白名单里的配置（回归：只覆写 export() 时会列出上述全部 8 个文件）',
  );
  assert.equal(previewed.sizeBytes, uiPrefs.byteLength + marketConfig.byteLength, '体积只算白名单文件');
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
  const uiPrefs = Buffer.from('{"schemaVersion":1}', 'utf8');
  await src.fs.writeFile('dsh-config-manager/sync/ui-prefs.json', uiPrefs);
  // 磁盘体检会统计这两块占用（回滚点库 + 旧检查点库）——但它们是**数据**，不是 self 分区的配置
  await src.fs.writeFile('dsh-config-manager/rollback-points/index.json', Buffer.from('x'.repeat(4096), 'utf8'));
  await src.fs.writeFile('dsh-config-manager/rollback-points/objects/rb-1/session.v4.jsonl.zstd', Buffer.from('x'.repeat(4096), 'utf8'));
  await src.fs.writeFile('dsh-config-manager/checkpoints/cp-1/files/a.bin', Buffer.from('x'.repeat(4096), 'utf8'));
  await src.fs.writeFile('dsh-config-manager/checkpoints/index.json', Buffer.from('{}', 'utf8'));

  const adapter = new SelfAdapter();
  const exported = await adapter.export(src, { includeSecrets: false });
  const previewed = await adapter.preview(src, { includeSecrets: false });
  const rels = exported.data.files.map((f) => f.relativePath);

  assert.deepEqual(rels, ['sync/ui-prefs.json'], '白名单外一律不收（新增统计目录不得混进载荷）');
  assert.equal(new Set(rels).size, rels.length, '不得出现重复条目');
  assert.equal(exported.counts.files, 1);
  assert.deepEqual(previewed.items.map((u) => u.id), ['self:sync/ui-prefs.json'], '预览与导出同口径（只列白名单）');
  assert.equal(previewed.sizeBytes, uiPrefs.byteLength, '体积只算白名单文件');
});

test('self: 宿主未实现 statSize（旧版门面）时，白名单判定仍只收配置、不误列内部数据', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  await src.fs.writeFile('dsh-config-manager/sync/ui-prefs.json', Buffer.from('{}', 'utf8'));
  await src.fs.writeFile('dsh-config-manager/snapshots/x/snapshot.json', Buffer.from('{}', 'utf8'));
  Object.defineProperty(src.fs, 'statSize', { value: undefined, configurable: true });

  const adapter = new SelfAdapter();
  const previewed = await adapter.preview(src, { includeSecrets: false });
  assert.deepEqual(previewed.items.map((u) => u.id), ['self:sync/ui-prefs.json']);
  assert.equal(previewed.sizeBytes, 2, '退回 readFile 时体积 = 文件字节数');
});

/* ---------------- issue #73：调度配置不得因运行态漂移而每轮重现 ---------------- */

const BACKUP_SCHEDULE_REL = 'dsh-config-manager/sync/backup-schedule.json';

/** backup-schedule.json 的配置本体（无运行态） */
function backupScheduleBody(overrides: Record<string, unknown> = {}, runState: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    schemaVersion: 1, enabled: true, interval: '24h', startupMinIntervalMs: 3600000,
    consecutiveFailures: 0, ...overrides, ...runState,
  }, null, 2), 'utf8');
}

test('self: 调度配置仅运行态不同 → Skip（键序不同亦然）；配置本体不同 → Conflict', async () => {
  const adapter = new SelfAdapter();
  const src = makeContext('win32', 'C:\\Users\\alice');
  await src.fs.writeFile(BACKUP_SCHEDULE_REL, backupScheduleBody({}, {
    lastRunAt: '2026-10-01T00:00:00.000Z', lastRunStatus: 'success',
  }));
  const out = await adapter.export(src, { includeSecrets: false });
  const sections = new Map([['self', out.data]]);

  // 本机：配置本体一致，但运行态已被本机调度器改写（每轮同步收尾都会发生），且键序不同
  const dst = makeContext('linux', '/home/bob');
  await dst.fs.writeFile(BACKUP_SCHEDULE_REL, Buffer.from(JSON.stringify({
    lastRunStatus: 'failed', lastRunMessage: '网络不可达', lastRunHistoryId: 'h-1', consecutiveFailures: 3,
    startupMinIntervalMs: 3600000, interval: '24h', enabled: true, schemaVersion: 1,
    lastRunAt: '2026-10-06T09:00:00.000Z',
  }, null, 2), 'utf8'));
  let items = await adapter.analyzeImport(out.data, makeImportContext(dst, sections));
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, 'Skip', '仅运行态字段不同（且键序不同）→ Skip，否则每轮同步都重现同一条 Conflict');

  // 配置本体（enabled）不同 → 仍是 Conflict（剔除运行态不得把配置差异一起吞掉）
  await dst.fs.writeFile(BACKUP_SCHEDULE_REL, backupScheduleBody({ enabled: false }));
  items = await adapter.analyzeImport(out.data, makeImportContext(dst, sections));
  assert.equal(items[0]?.kind, 'Conflict');
});

test('self: backup-schedule.json 同口径 + 坏 JSON 回落整文件哈希', async () => {
  const adapter = new SelfAdapter();
  const src = makeContext('win32', 'C:\\Users\\alice');
  await src.fs.writeFile(BACKUP_SCHEDULE_REL, backupScheduleBody({}, {
    lastRunAt: '2026-10-01T00:00:00.000Z', lastRunStatus: 'success',
  }));
  const out = await adapter.export(src, { includeSecrets: false });
  const sections = new Map([['self', out.data]]);
  const dst = makeContext('linux', '/home/bob');

  await dst.fs.writeFile(BACKUP_SCHEDULE_REL, backupScheduleBody({}, {
    consecutiveFailures: 2, lastRunAt: '2026-10-06T09:00:00.000Z', lastRunStatus: 'failed',
  }));
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
  await src.fs.writeFile('dsh-config-manager/sync/ui-prefs.json', Buffer.from('{"schemaVersion":1,"lastSyncChannel":"webdav"}', 'utf8'));
  const out = await adapter.export(src, { includeSecrets: false });
  const sections = new Map([['self', out.data]]);
  const dst = makeContext('linux', '/home/bob');
  await dst.fs.writeFile('dsh-config-manager/sync/ui-prefs.json', Buffer.from('{ "lastSyncChannel": "webdav", "schemaVersion": 1 }', 'utf8'));
  const items = await adapter.analyzeImport(out.data, makeImportContext(dst, sections));
  assert.equal(items[0]?.kind, 'Conflict', '键序不同但语义相同 —— 非调度配置仍按字节判');
});

/**
 * issue #127 回归：运行态漂移不得改变导出的分区 hash。
 *
 * 现场：调度器每轮收尾改写调度配置的运行态字段 → self 分区 hashSection 每轮都变
 * → SyncEngine.hasLocalChanges() 永远为真 → 自动同步的每次远端轮询（缺省 60s）都真推一个
 * 只差 lastRunAt 的新快照（真机 2026-10-25 一天 41 次 push，远端累积 325 个垃圾快照）。
 *
 * 载体说明：SEC-01 之后 sync-autosync.json 不再进载荷，同一套运行态剔除语义由仍在白名单的
 * backup-schedule.json 承载（两个调度配置共用同一份剔除表，见 self.ts 的 VOLATILE_RUN_STATE_KEY_LIST）。
 */
test('self: 运行态改写不改变分区 hash（自动同步不再每轮误判「本地有改动」）', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  const adapter = new SelfAdapter();

  await src.fs.writeFile(BACKUP_SCHEDULE_REL, backupScheduleBody({}, {
    lastRunAt: '2026-10-25T12:00:00.000Z', lastRunStatus: 'success', lastRunHistoryId: 'h-1', consecutiveFailures: 0,
  }));
  const first = await adapter.export(src, { includeSecrets: false });

  // 模拟一次同步收尾：只推进运行态（配置本体不动）
  await src.fs.writeFile(BACKUP_SCHEDULE_REL, backupScheduleBody({}, {
    lastRunAt: '2026-10-25T12:01:00.000Z', lastRunStatus: 'failed', lastRunMessage: 'boom', lastRunHistoryId: 'h-2', consecutiveFailures: 1,
  }));
  const second = await adapter.export(src, { includeSecrets: false });

  assert.equal(
    hashSection(second.data),
    hashSection(first.data),
    '仅运行态不同 → 分区 hash 必须不变（否则每轮远端轮询都真推一次）',
  );
  const payload = Buffer.from(second.data.files.find((f) => f.relativePath === 'sync/backup-schedule.json')!.data).toString('utf8');
  assert.ok(!payload.includes('lastRunAt'), '导出载荷不含运行态：远端不该接收本机执行记录');
  assert.ok(!payload.includes('consecutiveFailures'));
  assert.ok(payload.includes('"interval":"24h"'), '配置本体仍在载荷里');

  // 配置本体变化必须被识别（不能把运行态过滤做成「什么都判不变」）
  await src.fs.writeFile(BACKUP_SCHEDULE_REL, backupScheduleBody({ interval: '12h' }, { lastRunAt: '2026-10-25T12:02:00.000Z' }));
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
  const src = makeContext('win32', 'C:\\Users\\alice');
  const adapter = new SelfAdapter();

  // 轮次 A：跳过（无本地改动）
  await src.fs.writeFile(BACKUP_SCHEDULE_REL, backupScheduleBody({}, {
    lastRunAt: '2026-10-29T09:00:00.000Z', lastRunStatus: 'success', lastRunSkipReason: 'upToDate', consecutiveFailures: 0,
  }));
  const skipRound = await adapter.export(src, { includeSecrets: false });

  // 轮次 B：真推一次 —— 跳过码被清空，其余与 A 相同
  await src.fs.writeFile(BACKUP_SCHEDULE_REL, backupScheduleBody({}, {
    lastRunAt: '2026-10-29T09:01:00.000Z', lastRunStatus: 'success', consecutiveFailures: 0,
  }));
  const pushRound = await adapter.export(src, { includeSecrets: false });

  // 轮次 C：跳过（冲突，带待确认分区数）
  await src.fs.writeFile(BACKUP_SCHEDULE_REL, backupScheduleBody({}, {
    lastRunAt: '2026-10-29T09:02:00.000Z', lastRunStatus: 'success', lastRunSkipReason: 'conflict', lastRunSkipCount: 3, consecutiveFailures: 0,
  }));
  const conflictRound = await adapter.export(src, { includeSecrets: false });

  const base = hashSection(skipRound.data);
  assert.equal(hashSection(pushRound.data), base, '跳过码被清空不得改变分区 hash（否则每轮都判「本地有改动」）');
  assert.equal(hashSection(conflictRound.data), base, '跳过码换值 / 带分区数不得改变分区 hash');

  const payload = Buffer.from(pushRound.data.files.find((f) => f.relativePath === 'sync/backup-schedule.json')!.data).toString('utf8');
  assert.ok(!payload.includes('lastRunSkip'), '导出载荷不含跳过码：远端不该接收本机执行记录');
  assert.ok(payload.includes('"interval":"24h"'), '配置本体仍在载荷里');

  // 同一份远端载荷回灌本机（本机多出跳过码）→ Skip，不是 Conflict
  const dst = makeContext('linux', '/home/bob');
  await dst.fs.writeFile(BACKUP_SCHEDULE_REL, backupScheduleBody({}, {
    lastRunAt: '2026-10-29T09:05:00.000Z', lastRunStatus: 'success', lastRunSkipReason: 'upToDate',
  }));
  const sections = new Map([['self', pushRound.data]]);
  let items = await adapter.analyzeImport(pushRound.data, makeImportContext(dst, sections));
  assert.equal(items[0]?.kind, 'Skip', '仅跳过码不同 → Skip（此前每轮判 Conflict 并重复推送）');

  // 配置本体变化仍必须被识别（不能把剔除做成「什么都判不变」）
  await dst.fs.writeFile(BACKUP_SCHEDULE_REL, backupScheduleBody({ interval: '6h' }, { lastRunSkipReason: 'upToDate' }));
  items = await adapter.analyzeImport(pushRound.data, makeImportContext(dst, sections));
  assert.equal(items[0]?.kind, 'Conflict', '真实配置变化必须仍判 Conflict');
});
