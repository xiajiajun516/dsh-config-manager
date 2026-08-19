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
