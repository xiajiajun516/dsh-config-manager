/**
 * issue #91 回归：**推送预览（previewPush）不得为本地源插件执行 `npm pack`**。
 *
 * 缺陷：`previewPush` 走的是 `adapter.export()`，而 `plugins` 适配器只有 `preview()`（PR #68）
 * 才跳过打包 —— 于是「推送前只读预览」会真的对每个 `link:`/`file:` 插件 spawn 一次 `npm pack`
 * （真机 2 GB 本地源插件 = 297 s），这段时间该请求占着全局写锁，界面所有写操作静默 423。
 *
 * 本文件钉死三件事：
 *  ① 预览不打包（真推送仍然打包 —— 本地源插件换机可用不能被牺牲）；
 *  ② 预览与基线口径不同时**绝不断言「无变化」**（保守报「有变化」+ 如实说明）；
 *  ③ 文件类分区仍走 `export()`：其 `preview()` 产物是「无内容」形态，拿它比对 hash 会误报
 *     「每个文件分区都变了」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SyncEngine } from './sync-engine.ts';
import type { SyncSnapshot, SyncSnapshotMeta, SyncTransport } from './transport.ts';
import { computeSnapshotMeta } from './transport.ts';
import { createAdapters } from '../adapters/index.ts';
import type { LocalPluginPackHook } from '../adapters/index.ts';
import { makeContext, MemSnapshotStore } from '../adapters/test-helpers.ts';
import { Importer } from '../core/importer.ts';

const NS = ['general', 'theme'];

/** 内存传输（与 sync-engine.test.ts 同款最小实现；本仓库各同步测试各自持有一份）。 */
class MemSyncTransport implements SyncTransport {
  readonly type = 'memory';
  snapshots = new Map<string, SyncSnapshot>();
  metas: SyncSnapshotMeta[] = [];
  async list(): Promise<SyncSnapshotMeta[]> {
    return [...this.metas].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }
  async upload(snapshot: SyncSnapshot): Promise<SyncSnapshotMeta> {
    this.snapshots.set(snapshot.id, snapshot);
    this.metas.push(computeSnapshotMeta(snapshot));
    return computeSnapshotMeta(snapshot);
  }
  async download(id: string): Promise<SyncSnapshot> {
    const s = this.snapshots.get(id);
    if (!s) throw new Error('快照不存在: ' + id);
    return s;
  }
  async delete(id: string): Promise<void> {
    this.snapshots.delete(id);
    this.metas = this.metas.filter((m) => m.id !== id);
  }
}

/** 假打包钩子：记录被调用次数，并按需产出「本地源插件已打包」的结果。 */
function makePackSpy(withLocal: boolean): { hook: LocalPluginPackHook; calls: () => number } {
  let calls = 0;
  const isLocal = (spec: string | undefined): boolean =>
    typeof spec === 'string' && (spec.startsWith('file:') || spec.startsWith('link:'));
  const hook: LocalPluginPackHook = async (plugins) => {
    calls += 1;
    if (!withLocal) return { packed: [], rewritten: {}, warnings: [] };
    const locals = plugins.filter((p) => isLocal(p.spec));
    return {
      packed: locals.map((p) => ({
        packageName: p.name,
        version: p.version,
        relativePath: 'local-plugins/' + p.name + '-1.0.0.tgz',
        rewrittenSpec: 'file:local-plugins/' + p.name + '-1.0.0.tgz',
        data: new Uint8Array([1, 2, 3, 4]),
      })),
      rewritten: Object.fromEntries(locals.map((p) => [p.name, 'file:local-plugins/' + p.name + '-1.0.0.tgz'])),
      warnings: [],
    };
  };
  return { hook, calls: () => calls };
}

function makeEngine(ctx: ReturnType<typeof makeContext>, transport: SyncTransport, stateDir: string, adapters: ReturnType<typeof createAdapters>) {
  return new SyncEngine({
    ctx,
    transport,
    stateDir,
    adapters,
    importer: new Importer({ ctx, adapters, snapshotStore: new MemSnapshotStore() }),
    now: () => new Date('2026-08-16T12:00:00.000Z'),
  } as ConstructorParameters<typeof SyncEngine>[0]);
}

test('issue #91：推送预览不走 npm pack（真推送仍然打包）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-preview-local-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    ctx.plugins.installed.set('local-thing', { name: 'local-thing', version: '1.0.0', enabled: true, spec: 'file:C:/tmp/local-thing' });
    const spy = makePackSpy(true);
    const adapters = createAdapters({ namespaces: NS, localPluginPack: spy.hook });
    const transport = new MemSyncTransport();
    const engine = makeEngine(ctx, transport, tmp, adapters);

    // 真推送：必须打包（本地源插件否则换机即丢），同时建立「按 export() 产物」的基线
    const pushed = await engine.push({ snapshotId: 'sync-local-1', sections: ['plugins'] });
    assert.equal(pushed.ok, true);
    assert.equal(spy.calls(), 1, '真推送必须打包本地源插件');

    // 只读预览：修复前会再打一次包（真机 297 s，占满全局写锁）
    const preview = await engine.previewPush({ sections: ['plugins'] });
    assert.equal(spy.calls(), 1, '只读预览绝不能再执行 npm pack');
    assert.equal(preview.ok, true);
    const row = preview.sections.find((s) => s.section === 'plugins');
    assert.ok(row !== undefined, 'plugins 出现在预览分区清单里');
    assert.equal(row.changed, true, '预览产物与基线不同口径 ⇒ 保守报「有变化」，绝不断言「无变化」');
    assert.ok((preview.message ?? '').length > 0, '并如实说明该分区为何不做基线比对');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('issue #91：无本地源插件时预览与 export() 同口径 —— 仍能精确报「无变化」', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-preview-plain-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    ctx.plugins.installed.set('@deepseek-ai/dsh-ssh', { name: '@deepseek-ai/dsh-ssh', version: '1.0.0', enabled: true });
    const spy = makePackSpy(true);
    const adapters = createAdapters({ namespaces: NS, localPluginPack: spy.hook });
    const transport = new MemSyncTransport();
    const engine = makeEngine(ctx, transport, tmp, adapters);

    await engine.push({ snapshotId: 'sync-plain-1', sections: ['plugins'] });
    assert.equal(spy.calls(), 1);

    const preview = await engine.previewPush({ sections: ['plugins'] });
    assert.equal(spy.calls(), 1, '预览不打包');
    const row = preview.sections.find((s) => s.section === 'plugins');
    assert.ok(row !== undefined);
    assert.equal(row.changed, false, '没有本地源 ⇒ 预览产物与基线逐字节可比，必须精确报「无变化」');
    assert.equal(preview.message, undefined, '无可比性问题时不产生告警');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('issue #91：文件类分区仍走 export()（内容形态），不因预览形态误报「有变化」', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-preview-files-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    await ctx.fs.writeFile('skills/coding.md', Buffer.from('# Coding\n', 'utf8'));
    const adapters = createAdapters({ namespaces: NS });
    const transport = new MemSyncTransport();
    const engine = makeEngine(ctx, transport, tmp, adapters);

    await engine.push({ snapshotId: 'sync-skills-1', sections: ['skills'] });
    const preview = await engine.previewPush({ sections: ['skills'] });
    const row = preview.sections.find((s) => s.section === 'skills');
    assert.ok(row !== undefined);
    assert.equal(row.changed, false, 'skills 的预览必须与基线同口径（内容形态），否则永远误报有变化');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
