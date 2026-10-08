/**
 * issue #37：链接目录的告警构造（备份必须能说明「跟随了什么 / 跳过了什么」）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { linkWarnings, listFilesDetailed } from './link-report.ts';
import { zhMsg } from '../core/messages.ts';
import type { FileSystemFacade } from '../core/types.ts';
import type { RecursiveListing } from '../utils/recursive-walk.ts';

const clean: RecursiveListing = { paths: ['skills/a.md'], skippedLinks: [], skippedDepDirs: [], followedLinks: 0, unreadableDirs: [] };

test('linkWarnings：无链接 → 零告警（不制造噪音）', () => {
  assert.deepEqual(linkWarnings(zhMsg, 'Skills', clean), []);
});

test('linkWarnings：跟随的链接必须提示「结构不会重建」', () => {
  const out = linkWarnings(zhMsg, 'Skills', { ...clean, followedLinks: 3 });
  assert.equal(out.length, 1);
  assert.match(out[0]!, /3/);
  assert.match(out[0]!, /链接目录/);
  assert.match(out[0]!, /链接结构不会重建/);
});

test('linkWarnings：跳过项按原因归并，给出数量、原因与路径', () => {
  const out = linkWarnings(zhMsg, 'Skills', {
    paths: [],
    followedLinks: 1,
    skippedDepDirs: [],
    unreadableDirs: [],
    skippedLinks: [
      { path: 'skills/self', reason: 'loop' },
      { path: 'skills/broken', reason: 'broken' },
      { path: 'skills/outside', reason: 'outside-home' },
      { path: 'skills/fifo', reason: 'unreadable' },
      { path: 'skills/deep', reason: 'too-deep' },
    ],
  });
  assert.equal(out.length, 2, '跟随 + 跳过各一条');
  const skipped = out[1]!;
  assert.match(skipped, /5 个链接被跳过/);
  assert.match(skipped, /自引用\/重复链接/);
  assert.match(skipped, /断链/);
  assert.match(skipped, /目标在 DSH home 之外/);
  assert.match(skipped, /skills\/self/);
  // 未进备份必须说清楚，而不是「已跳过」这类中性的措辞
  assert.match(skipped, /未进备份/);
});

test('linkWarnings：目录读取失败也必须告警（其内容同样未进备份）', () => {
  const out = linkWarnings(zhMsg, 'Skills', {
    paths: [], followedLinks: 0, skippedLinks: [], skippedDepDirs: [], unreadableDirs: ['skills/locked', 'skills/denied'],
  });
  assert.equal(out.length, 1);
  assert.match(out[0]!, /2 个目录读取失败/);
  assert.match(out[0]!, /未进备份/);
  assert.match(out[0]!, /skills\/locked/);
});

test('listFilesDetailed：宿主未实现 detailed 时回退到 listRecursive（旧行为不变）', async () => {
  const fs = { listRecursive: async () => ['skills/x.md'] } as unknown as FileSystemFacade;
  const listing = await listFilesDetailed(fs, 'skills');
  assert.deepEqual(listing.paths, ['skills/x.md']);
  assert.deepEqual(listing.skippedLinks, []);
  assert.deepEqual(listing.skippedDepDirs, []);
  assert.equal(listing.followedLinks, 0);
});

test('issue #76：跳过的 node_modules 依赖目录必须告警（点名路径 + 文件数 + 可重建说明）', () => {
  const out = linkWarnings(zhMsg, 'Skills', {
    ...clean,
    skippedDepDirs: [
      { path: 'skills/md2pdf/node_modules', files: 11625 },
      { path: 'skills/other/node_modules', files: null },
    ],
  });
  assert.equal(out.length, 1, '汇总成一条，不逐目录刷屏');
  const line = out[0]!;
  assert.match(line, /2 个运行时依赖目录/);
  assert.match(line, /未进备份/);
  assert.match(line, /skills\/md2pdf\/node_modules/);
  assert.match(line, /11625 个文件/);
  assert.match(line, /文件数未统计/, '计数预算耗尽时不得猜一个数（更不得写成 0）');
  assert.match(line, /重新安装依赖/);
});
