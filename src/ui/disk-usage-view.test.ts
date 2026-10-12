/**
 * disk-usage-view 测试：报告 → 界面行的纯函数映射（含未统计 / 保留期 / 可回收口径）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanupOutcome, diskUsageViewModel, formatRetention } from './disk-usage-view.ts';
import { makeUiT } from './i18n.ts';
import { formatBytes } from './report.ts';
import type { DiskUsageLegacyEntry, DiskUsageReport, DiskUsageScanArea } from '../core/disk-usage.ts';

const DAY = 24 * 60 * 60 * 1000;
const zh = makeUiT('zh');
const en = makeUiT('en');

/**
 * 构造一份完整报告（每区可覆盖）。
 *
 * `areas` 逐键必填 = `DiskUsageScanArea` 的**全部**子区（含只报告不清理的 `rollback-points`）——
 * 与宿主 `GET /disk-usage` 的运行期形状一致；少一个键就不是「完整报告」了。
 */
function makeReport(
  overrides: Partial<Record<DiskUsageScanArea, Record<string, unknown>>> = {},
  legacy: readonly DiskUsageLegacyEntry[] = [],
): DiskUsageReport {
  const areas = {} as DiskUsageReport['areas'];
  const base: DiskUsageScanArea[] = [
    'exports', 'snapshots', 'sync', 'marketCache', 'marketWork', 'tmp',
    'logs', 'bootState', 'migrationHistory', 'transactions', 'locks', 'vault',
    'rollback-points',
  ];
  for (const id of base) {
    areas[id] = {
      sizeBytes: 0,
      fileCount: 0,
      unreadable: false,
      policy: id === 'exports' ? 'retained' : id === 'tmp' || id === 'marketCache' || id === 'marketWork' ? 'regenerable' : 'protected',
      ...(id === 'exports' ? { retentionMs: 7 * DAY, expiredBytes: 0, expiredCount: 0 } : {}),
      ...(overrides[id] ?? {}),
    } as DiskUsageReport['areas'][DiskUsageScanArea];
  }
  return {
    dataDir: 'C:/home/.dsh/dsh-config-manager',
    totalBytes: 0,
    totalFiles: 0,
    reclaimableBytes: 0,
    expiredBytes: 0,
    areas,
    ...(legacy.length > 0 ? { legacy } : {}),
    backupRetention: { keepLast: 10, latestBackupBytes: 0, latestBackupAt: null },
  };
}

/** 一条遗留数据（缺省 = 真机那条旧检查点库：`checkpoints/`）。 */
function legacyEntry(over: Partial<DiskUsageLegacyEntry> = {}): DiskUsageLegacyEntry {
  return {
    id: 'legacy-checkpoints',
    relPath: 'checkpoints',
    path: 'C:/home/.dsh/dsh-config-manager/checkpoints',
    sizeBytes: 0,
    fileCount: 0,
    unreadable: false,
    policy: 'protected',
    ...over,
  };
}

test('diskUsageViewModel：null 报告 → null（界面走加载态）', () => {
  assert.equal(diskUsageViewModel(null, { t: zh, formatBytes }), null);
});

test('diskUsageViewModel：全部子区都渲染，未统计区不给 0 字节', () => {
  const vm = diskUsageViewModel(makeReport({
    vault: { unreadable: true },
    exports: { sizeBytes: 2048, fileCount: 3 },
  }), { t: zh, formatBytes });
  assert.ok(vm !== null);
  // t6：子区从 12 → 13（新增只报告不清理的 rollback-points，core 的 DISK_USAGE_AREAS 已含它）
  assert.equal(vm.rows.length, 13);
  assert.equal(vm.summary.anyUnreadable, true);
  assert.equal(vm.summary.total, formatBytes(2048), '合计由已统计的子区现算（未统计区为 0，不虚增）');
  const vault = vm.rows.find((r) => r.id === 'vault');
  assert.ok(vault !== undefined);
  assert.equal(vault.unreadable, true);
  assert.equal(vault.size, '', '未统计不显示体积（绝不显示 0）');
  assert.equal(vault.files, '');
  const exportsRow = vm.rows.find((r) => r.id === 'exports');
  assert.ok(exportsRow !== undefined);
  assert.equal(exportsRow.size, formatBytes(2048));
  assert.equal(exportsRow.files, zh('diskUsage.files', { count: '3' }));
  assert.equal(exportsRow.policy, 'retained');
  assert.equal(exportsRow.retention, zh('diskUsage.retention.days', { count: '7' }));
  assert.equal(exportsRow.reclaimable, false);
});

test('diskUsageViewModel：可立即清理清单只含可重建区；过期导出单列一个动作', () => {
  const vm = diskUsageViewModel(makeReport({
    tmp: { sizeBytes: 100 },
    marketCache: { sizeBytes: 200 },
    marketWork: { sizeBytes: 300 },
    exports: { sizeBytes: 5000, fileCount: 2, expiredBytes: 900, expiredCount: 1 },
  }), { t: zh, formatBytes });
  assert.ok(vm !== null);
  assert.equal(vm.clean.reclaimable, formatBytes(600));
  assert.equal(vm.clean.expired, formatBytes(900));
  const tmpAction = vm.clean.actions.find((a) => a.id === 'tmp-market');
  const expAction = vm.clean.actions.find((a) => a.id === 'expired-exports');
  assert.ok(tmpAction !== undefined && expAction !== undefined);
  assert.equal(tmpAction.bytes, 600);
  assert.equal(tmpAction.label, zh('diskUsage.clean.tmpMarket'));
  assert.equal(expAction.bytes, 900);
  assert.equal(expAction.label, zh('diskUsage.clean.expiredExports'));
  // 可重建区不显示保留期说明（随时可清，给「N 天后自动回收」会误导）
  const tmpRow = vm.rows.find((r) => r.id === 'tmp');
  assert.ok(tmpRow !== undefined);
  assert.equal(tmpRow.retention, '');
  assert.equal(tmpRow.expired, null);
});

test('diskUsageViewModel：过期提示只在有超期项时出现', () => {
  const noExpired = diskUsageViewModel(makeReport(), { t: zh, formatBytes });
  assert.ok(noExpired !== null);
  assert.equal(noExpired.rows.find((r) => r.id === 'exports')?.expired, null);
  const vm = diskUsageViewModel(makeReport({ exports: { expiredBytes: 10, expiredCount: 1 } }), { t: zh, formatBytes });
  assert.ok(vm !== null);
  assert.equal(vm.rows.find((r) => r.id === 'exports')?.expired, formatBytes(10));
});

test('formatRetention：天 / 小时 / 缺失三档（en 与 zh 都走字典）', () => {
  assert.equal(formatRetention(7 * DAY, zh), '7 天');
  assert.equal(formatRetention(24 * 60 * 60 * 1000, zh), '1 天');
  assert.equal(formatRetention(6 * 60 * 60 * 1000, zh), '6 小时');
  assert.equal(formatRetention(30 * 60 * 1000, zh), '30 分钟');
  assert.equal(formatRetention(0, zh), zh('diskUsage.retention.none'));
  assert.equal(formatRetention(2 * DAY, en), '2 day(s)');
});

test('diskUsageViewModel：英文界面下所有标签来自 en 字典（不回落中文）', () => {
  const vm = diskUsageViewModel(makeReport({ tmp: { sizeBytes: 5 } }), { t: en, formatBytes });
  assert.ok(vm !== null);
  assert.equal(vm.rows.find((r) => r.id === 'tmp')?.label, 'Temporary staging');
  assert.equal(vm.clean.actions.find((a) => a.id === 'tmp-market')?.label, 'Clear temp & marketplace cache');
  assert.equal(vm.summary.files, en('diskUsage.files', { count: '0' }));
});

/* --------------------- t6：新增磁盘体检项（附加子区 + 遗留数据） --------------------- */

test('t6：附加子区 rollback-points 成行、文案走字典、只报告不清理', () => {
  const vm = diskUsageViewModel(makeReport({ 'rollback-points': { sizeBytes: 7_124_295, fileCount: 385 } }), { t: zh, formatBytes });
  assert.ok(vm !== null);
  const row = vm.rows.find((r) => r.id === 'rollback-points');
  assert.ok(row !== undefined, '新增子区必须出现在行里（core 统计了、界面就得展示）');
  assert.equal(row.label, zh('diskUsage.area.rollbackPoints'));
  assert.equal(row.desc, zh('diskUsage.area.rollbackPointsDesc'));
  assert.equal(row.size, formatBytes(7_124_295));
  assert.equal(row.files, zh('diskUsage.files', { count: '385' }));
  assert.equal(row.policy, 'protected', 'policy 由 core 给（protected），界面不自判');
  assert.equal(row.reclaimable, false, '只报告区绝不进「可立即清理」');
  assert.equal(row.retention, '', 'protected 区没有保留期文案');
  assert.equal(row.expired, null);
  assert.equal(vm.clean.reclaimable, formatBytes(0), '回滚点库不得计入可回收合计');
});

test('t6：附加子区计入合计；遗留数据**不计入**合计（core 两处口径分列）', () => {
  const vm = diskUsageViewModel(
    makeReport({ 'rollback-points': { sizeBytes: 100, fileCount: 2 } }, [legacyEntry({ sizeBytes: 999, fileCount: 7 })]),
    { t: zh, formatBytes },
  );
  assert.ok(vm !== null);
  assert.equal(vm.summary.total, formatBytes(100), '合计 = 子区（含附加子区）、不含遗留数据');
  assert.equal(vm.summary.files, zh('diskUsage.files', { count: '2' }));
});

test('t6：遗留数据单列一行 —— 标签走字典、policy protected、未统计不报 0', () => {
  const vm = diskUsageViewModel(makeReport({}, [legacyEntry({ sizeBytes: 59_705_801, fileCount: 1757 })]), { t: zh, formatBytes });
  assert.ok(vm !== null);
  assert.equal(vm.legacy.length, 1);
  const row = vm.legacy[0];
  assert.ok(row !== undefined);
  assert.equal(row.id, 'legacy-checkpoints', 'id 只作 key，不是文案');
  assert.equal(row.relPath, 'checkpoints');
  assert.equal(row.label, zh('diskUsage.legacy.label'));
  assert.equal(row.size, formatBytes(59_705_801));
  assert.equal(row.files, zh('diskUsage.files', { count: '1757' }));
  assert.equal(row.policy, 'protected');

  const unreadable = diskUsageViewModel(makeReport({}, [legacyEntry({ unreadable: true })]), { t: zh, formatBytes });
  assert.ok(unreadable !== null);
  const hidden = unreadable.legacy[0];
  assert.ok(hidden !== undefined);
  assert.equal(hidden.unreadable, true);
  assert.equal(hidden.size, '', '未统计不显示 0 字节');
  assert.equal(hidden.files, '');
  assert.equal(unreadable.summary.anyUnreadable, true, '遗留目录读不到也要触发「部分未统计」提示');
});

test('t6：遗留数据行只渲染标签与路径 —— id 与路径都不当文案', () => {
  const vm = diskUsageViewModel(
    makeReport({}, [legacyEntry({ id: 'legacy-future', relPath: 'future-dir' })]),
    { t: zh, formatBytes },
  );
  assert.ok(vm !== null);
  const row = vm.legacy[0];
  assert.ok(row !== undefined);
  assert.equal(row.label, zh('diskUsage.legacy.label'));
  assert.notEqual(row.label, 'legacy-future', '不得把 id 当标签渲染');
  assert.equal(row.relPath, 'future-dir', '路径照常展示（那是「在哪儿」，不是机器码文案）');
});

test('t6：英文界面下新 area 与遗留数据同样来自 en 字典（不回落中文）', () => {
  const vm = diskUsageViewModel(makeReport({ 'rollback-points': { sizeBytes: 1 } }, [legacyEntry()]), { t: en, formatBytes });
  assert.ok(vm !== null);
  assert.equal(vm.rows.find((r) => r.id === 'rollback-points')?.label, 'Rollback points');
  const row = vm.legacy[0];
  assert.ok(row !== undefined);
  assert.equal(row.label, 'Legacy data');
  assert.equal(/[\u4E00-\u9FFF]/.test(row.label), false, 'en 标签不得含中文');
});

test('源码级：DiskUsageCard.tsx 不 import node:*（client 半禁止 node 内置）', () => {
  const src = readFileSync(join(process.cwd(), 'src/client/environment/maintenance/DiskUsageCard.tsx'), 'utf8');
  const specs = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] ?? '');
  assert.ok(specs.length > 0, '解析不到 import 说明断言自身失效（假绿）');
  assert.deepEqual(specs.filter((s) => s.startsWith('node:')), [], '客户端组件不得 import node 模块');
});
test('ui-F4：expired-exports 动作只算 exports 的过期体积（可重建区的过期字节不得混入按钮）', () => {
  const vm = diskUsageViewModel(makeReport({
    exports: { sizeBytes: 5000, fileCount: 2, expiredBytes: 900, expiredCount: 1 },
    tmp: { sizeBytes: 100, expiredBytes: 700, expiredCount: 2 },
    marketCache: { sizeBytes: 200, expiredBytes: 600, expiredCount: 3 },
  }), { t: zh, formatBytes });
  assert.ok(vm !== null);
  const expAction = vm.clean.actions.find((a) => a.id === 'expired-exports');
  assert.ok(expAction !== undefined);
  // base：900 + 700 + 600 = 2200（虚高，宿主该动作只删 exports）
  assert.equal(expAction.bytes, 900, '宿主 expired-exports 只删 exports；tmp/market 走 tmp-market 动作');
  assert.equal(vm.clean.expired, formatBytes(900));
});

/* ---------------- e2e-F3：清理回执的呈现判定（「仅缺失目录」≠「真失败」） ---------------- */

test('cleanupOutcome：目标目录不存在/已空 → 不报失败，且与「真失败」同输入不同语义', () => {
  // 现场：全新安装只清缓存，market/cache 等可选目录尚未创建 —— 老宿主把它计成 errors
  const missingOnly = cleanupOutcome(
    { removed: 0, freedBytes: 0, errors: 3, report: makeReport({ tmp: { sizeBytes: 0 }, marketCache: { sizeBytes: 0 }, marketWork: { sizeBytes: 0 } }), requested: ['tmp'] },
    { t: zh, formatBytes },
  );
  assert.equal(missingOnly.kind, 'nothing-absent', '缺失目录不得判成失败');
  assert.equal(missingOnly.warnText, '', '不得弹红色「清理失败 N 项」');
  assert.match(missingOnly.okText, /没有需要清理/);
  // core 侧修好后 ENOENT 不再计入 errors → 同一现场落到 nothing（成功语义）
  const fixedHost = cleanupOutcome({ removed: 0, freedBytes: 0, errors: 0, report: makeReport(), requested: ['tmp'] }, { t: zh, formatBytes });
  assert.equal(fixedHost.kind, 'nothing');
  assert.equal(fixedHost.warnText, '');
  // 真失败：一件都没删成，但目标区**仍有内容**（文件还在）
  const realFailure = cleanupOutcome(
    { removed: 0, freedBytes: 0, errors: 2, report: makeReport({ tmp: { sizeBytes: 4096, fileCount: 3 } }), requested: ['tmp'] },
    { t: zh, formatBytes },
  );
  assert.equal(realFailure.kind, 'failed');
  assert.equal(realFailure.okText, '');
  assert.equal(realFailure.warnKind, 'error');
  assert.match(realFailure.warnText, /2 项/);
  assert.notEqual(realFailure.kind, missingOnly.kind, '两种输入必须得到不同呈现语义');
});

test('cleanupOutcome：部分成功 / 全成 / 无报告时保守', () => {
  const partial = cleanupOutcome({ removed: 3, freedBytes: 1024, errors: 1, requested: ['tmp'] }, { t: zh, formatBytes });
  assert.equal(partial.kind, 'partial');
  assert.notEqual(partial.okText, '');
  assert.notEqual(partial.warnText, '');
  assert.equal(partial.warnKind, 'warn');
  const cleaned = cleanupOutcome({ removed: 3, freedBytes: 1024, errors: 0, requested: ['tmp'] }, { t: zh, formatBytes });
  assert.equal(cleaned.kind, 'cleaned');
  assert.equal(cleaned.warnText, '');
  // 老宿主/测试没带 report：无法证明「本来就没东西」→ 保守按真失败（绝不谎报成功）
  const noReport = cleanupOutcome({ removed: 0, freedBytes: 0, errors: 1, requested: ['tmp'] }, { t: zh, formatBytes });
  assert.equal(noReport.kind, 'failed');
});

test('cleanupOutcome：英文界面文案来自 en 字典（含新增的 nothingAbsent 键）', () => {
  const absent = cleanupOutcome({ removed: 0, freedBytes: 0, errors: 1, report: makeReport(), requested: ['tmp'] }, { t: en, formatBytes });
  assert.equal(absent.okText, en('diskUsage.clean.nothingAbsent'));
  const real = cleanupOutcome({ removed: 0, freedBytes: 0, errors: 2, report: makeReport({ tmp: { sizeBytes: 10 } }), requested: ['tmp'] }, { t: en, formatBytes });
  assert.equal(real.warnText, en('diskUsage.clean.failed', { count: '2' }));
});
