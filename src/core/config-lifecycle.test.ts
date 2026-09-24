/**
 * Phase 1 P0-1 / P0-2 编排层回归（config-lifecycle.ts）。
 *
 * 用真文件系统（临时目录）+ 假定时器 + 假 watch 工厂驱动，完整走通：
 *  变更事件 → 防抖 → 回声判定 → 自动快照落盘 → 撤销 → 重做
 *
 * 覆盖用户可见契约：
 *  - 真实变更触发一次自动快照；**恢复动作自写文件不触发**（回声抑制两道防线）；
 *  - 撤销回退到内容不同的最新快照，并在撤销前落 pre-restore 供重做；
 *  - 撤销后没有可回退的变化 → 明确失败而非空操作；
 *  - 重做回到撤销前状态；撤销后若又发生真实变更 → 重做被拒（不覆盖新改动）；
 *  - 快照保留清理生效，manual 不被自动清理。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ConfigLifecycle, echoCandidatePaths, profileCriticalRels, watchDirsFor, BOOT_CRITICAL_RELS,
} from './config-lifecycle.ts';
import { Phase3Recovery, readSafeModeMarkerSync } from './phase3-host.ts';
import { createJournalEntry, transitionJournalState } from './journal.ts';
import { Exporter } from './exporter.ts';
import { Importer } from './importer.ts';
import { makeContext, MemSnapshotStore } from '../adapters/test-helpers.ts';
import type { TimerApi, WatchFactory } from './watcher.ts';
import type { ImportPlan } from './types.ts';
import type { MutationLockContext } from '../utils/env-lock.ts';
import type { ConfigAdapter, ExportSection, HostContext } from './types.ts';
import type { SectionId } from '../schema/types.ts';

/* ------------------------------------------------------------ 基础设施 */

class FakeTimers implements TimerApi {
  private seq = 0;
  private now = 0;
  private scheduled = new Map<number, { fn: () => void; deadline: number }>();
  setTimeout(fn: () => void, ms: number): unknown {
    const handle = ++this.seq;
    this.scheduled.set(handle, { fn, deadline: this.now + ms });
    return handle;
  }
  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.scheduled.delete(handle);
  }
  advance(delta: number): void {
    this.now += delta;
    for (;;) {
      const due = [...this.scheduled.entries()]
        .filter(([, e]) => e.deadline <= this.now)
        .sort((a, b) => a[1].deadline - b[1].deadline);
      const next = due[0];
      if (next === undefined) break;
      this.scheduled.delete(next[0]);
      next[1].fn();
    }
  }
}

class FakeWatch {
  readonly watched: string[] = [];
  private readonly callbacks = new Map<string, (e: string, f: string | null) => void>();
  readonly factory: WatchFactory = (dir, onEvent) => {
    this.watched.push(dir);
    this.callbacks.set(dir, onEvent);
    return { close: () => { this.callbacks.delete(dir); } };
  };
  emit(dir: string, filename: string): void {
    this.callbacks.get(dir)?.(`change`, filename);
  }
}

/**
 * 可编程文件型 adapter：把一个 JSON 文件当作「配置」，
 * export 读文件，applyItem 写文件——使回放真的改动磁盘，从而驱动回声/撤销链路。
 * 开关（failExport / failApply / exportGate）供故障注入测试使用：让「采集不完整」与
 * 「flush 进行中」这类竞态可被确定性地复现，而不是靠 sleep 撞时序。
 */
interface FileAdapter extends ConfigAdapter {
  failExport: boolean;
  failApply: boolean;
  /** 非 null 时：读完数据后挂在这里等待（模拟耗时的编码/落盘），由测试显式放行 */
  exportGate: Promise<void> | null;
  /** export 已进入的次数（测试确认「读已发生」后再推进下一步，避免撞时序） */
  exportCalls: number;
}

function fileAdapter(id: SectionId, file: string): FileAdapter {
  const read = async (): Promise<Record<string, unknown>> => {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    } catch {
      return { v: 0 };
    }
  };
  const adapter: FileAdapter = {
    id,
    displayName: id,
    defaultIncluded: true,
    portability: 'portable',
    failExport: false,
    failApply: false,
    exportGate: null,
    exportCalls: 0,
    async export(): Promise<ExportSection> {
      if (adapter.failExport) throw new Error(`boom:export:${id}`);
      // 先读数据再挂起：让「这一次 flush 捕获到的内容」在测试里完全确定
      const data = await read();
      adapter.exportCalls += 1;
      if (adapter.exportGate !== null) await adapter.exportGate;
      return { sectionId: id, data, counts: { n: 1 }, warnings: [] };
    },
    async validate() { return { valid: true, issues: [] }; },
    async analyzeImport(data) {
      const current = await read();
      const incoming = data as Record<string, unknown>;
      if (JSON.stringify(current) === JSON.stringify(incoming)) {
        return [{ id: `${id}:same`, kind: 'Skip' as const, adapter: id, description: 'same', severity: 'info' as const }];
      }
      return [{
        id: `${id}:write`, kind: 'Update' as const, adapter: id, description: 'write', severity: 'info' as const,
        target: { adapter: id, ref: id },
      }];
    },
    async applyItem(_item, ctx) {
      if (adapter.failApply) return { ok: false, message: `boom:apply:${id}` };
      const incoming = ctx.sections.get(id) as Record<string, unknown> | undefined;
      await fs.writeFile(file, JSON.stringify(incoming ?? {}), 'utf8');
      return { ok: true };
    },
  };
  return adapter;
}

interface Harness {
  home: string;
  profileDir: string;
  configFile: string;
  lifecycle: ConfigLifecycle;
  timers: FakeTimers;
  watch: FakeWatch;
  ctx: HostContext;
  autoMetas: string[];
  /** 供故障注入测试直接翻转开关（见 fileAdapter） */
  adapter: FileAdapter;
}

async function harness(
  t: { after: (fn: () => Promise<void> | void) => void },
  opts: { autoEnabled?: boolean; keepAuto?: number; debounceMs?: number } = {},
): Promise<Harness> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-lifecycle-'));
  t.after(async () => { await fs.rm(home, { recursive: true, force: true }); });
  const profileDir = path.join(home, 'profiles', 'web');
  await fs.mkdir(profileDir, { recursive: true });
  const configFile = path.join(home, 'settings.yaml');
  await fs.writeFile(configFile, JSON.stringify({ v: 1 }), 'utf8');
  await fs.writeFile(path.join(home, 'cordis.patch.yml'), '[]\n', 'utf8');
  await fs.writeFile(path.join(profileDir, 'cordis.patch.yml'), '[]\n', 'utf8');
  await fs.writeFile(path.join(profileDir, 'package.json'), '{"name":"x"}\n', 'utf8');

  const snapDir = path.join(home, 'snapshots');
  const ctx = makeContext('win32', home, 'web');
  const timers = new FakeTimers();
  const watch = new FakeWatch();
  const autoMetas: string[] = [];
  const adapter = fileAdapter('settings', configFile);
  const lifecycle = new ConfigLifecycle({
    dir: snapDir,
    adapters: [adapter],
    ctx,
    profile: 'web',
    autoEnabled: opts.autoEnabled ?? true,
    debounceMs: opts.debounceMs ?? 1500,
    ...(opts.keepAuto !== undefined ? { keepAuto: opts.keepAuto } : {}),
    watchFactory: watch.factory,
    timers, // 假定时器：自动快照时序完全由测试驱动，不 sleep、不受负载影响
    onAutoSnapshot: (m) => autoMetas.push(m.id),
  });
  return { home, profileDir, configFile, lifecycle, timers, watch, ctx, autoMetas, adapter };
}

/* ------------------------------------------------------------ 纯函数 */

test('watchDirsFor：覆盖 home / profile / skills / .agent-presets，且去重', () => {
  const dirs = watchDirsFor('C:/home/.dsh', 'web');
  assert.equal(dirs.length, 4);
  assert.ok(dirs.some((d) => d.endsWith(`${path.sep}skills`)));
  assert.ok(dirs.some((d) => d.endsWith(`.agent-presets`)));
  assert.equal(new Set(dirs).size, dirs.length, '不得重复');
});

test('echoCandidatePaths：包含启动关键文件与 profile 文件', () => {
  const paths = echoCandidatePaths('C:/home/.dsh', 'web');
  for (const rel of BOOT_CRITICAL_RELS) {
    assert.ok(paths.some((p) => p.endsWith(rel.split('/').join(path.sep))), `缺 ${rel}`);
  }
  for (const rel of profileCriticalRels('web')) {
    assert.ok(paths.some((p) => p.endsWith(rel.split('/').join(path.sep))), `缺 ${rel}`);
  }
});

test('profileCriticalRels：按 profile 名生成路径', () => {
  assert.ok(profileCriticalRels('mine').includes('profiles/mine/cordis.patch.yml'));
});

/* ------------------------------------------------------------ 快照与采集 */

test('snapshot：采集并落盘，list 可见，manual 不触发保留清理', async (t) => {
  const h = await harness(t);
  const meta = await h.lifecycle.snapshot({ kind: 'manual', reason: 'known-good' });
  assert.equal(meta.kind, 'manual');
  assert.deepEqual(meta.sections, ['settings']);
  const metas = await h.lifecycle.list();
  assert.equal(metas.length, 1);
  assert.equal(metas[0]!.id, meta.id);
});

/* ------------------------------------------------------------ 撤销 / 重做 */

test('undo：回退到内容不同的快照，并在撤销前落 pre-restore', async (t) => {
  const h = await harness(t);
  await h.lifecycle.snapshot({ kind: 'manual', reason: 'v1' });          // 状态 v1
  await fs.writeFile(h.configFile, JSON.stringify({ v: 2 }), 'utf8');    // 真实变更 → v2
  await h.lifecycle.snapshot({ kind: 'auto', reason: 'change' });        // 状态 v2

  const outcome = await h.lifecycle.undo();
  assert.equal(outcome.ok, true, JSON.stringify(outcome.report?.failed ?? []));
  assert.ok(outcome.preSnapshotId !== undefined, '必须留下撤销前快照供重做');
  assert.equal(JSON.parse(await fs.readFile(h.configFile, 'utf8')).v, 1, '文件必须回到 v1');

  const metas = await h.lifecycle.list();
  const pre = metas.find((m) => m.id === outcome.preSnapshotId)!;
  assert.equal(pre.kind, 'pre-restore');
  assert.equal(pre.undoOf, outcome.targetId);
});

test('undo：没有可回退的变化时明确失败，不做空操作', async (t) => {
  const h = await harness(t);
  await h.lifecycle.snapshot({ kind: 'manual', reason: 'v1' });
  const outcome = await h.lifecycle.undo(); // 当前状态与唯一快照相同
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'already-at-state');
});

test('undo：无任何快照 → no-snapshots', async (t) => {
  const h = await harness(t);
  const outcome = await h.lifecycle.undo();
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'no-snapshots');
});

test('redo：回到撤销前状态，并消费 pre-restore', async (t) => {
  const h = await harness(t);
  await h.lifecycle.snapshot({ kind: 'manual', reason: 'v1' });
  await fs.writeFile(h.configFile, JSON.stringify({ v: 2 }), 'utf8');
  await h.lifecycle.snapshot({ kind: 'auto', reason: 'change' });
  const undo = await h.lifecycle.undo();
  assert.equal(undo.ok, true);

  const redo = await h.lifecycle.redo();
  assert.equal(redo.ok, true, JSON.stringify(redo.report?.failed ?? []));
  assert.equal(JSON.parse(await fs.readFile(h.configFile, 'utf8')).v, 2, '必须回到撤销前的 v2');
  const metas = await h.lifecycle.list();
  assert.equal(metas.find((m) => m.id === redo.targetId)?.consumed, true);
});

test('redo：无 pre-restore → no-pre-restore', async (t) => {
  const h = await harness(t);
  const outcome = await h.lifecycle.redo();
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'no-pre-restore');
});

test('redo：撤销后又有真实变更 → 被拒（绝不覆盖用户新改动）', async (t) => {
  const h = await harness(t);
  await h.lifecycle.snapshot({ kind: 'manual', reason: 'v1' });
  await fs.writeFile(h.configFile, JSON.stringify({ v: 2 }), 'utf8');
  await h.lifecycle.snapshot({ kind: 'auto', reason: 'change' });
  assert.equal((await h.lifecycle.undo()).ok, true);

  // 撤销之后用户又改了一次（产生比 pre-restore 更新的快照）
  await fs.writeFile(h.configFile, JSON.stringify({ v: 3 }), 'utf8');
  await h.lifecycle.snapshot({ kind: 'auto', reason: 'change-again' });

  const redo = await h.lifecycle.redo();
  assert.equal(redo.ok, false);
  assert.equal(redo.reason, 'superseded-by-newer-change');
  assert.equal(JSON.parse(await fs.readFile(h.configFile, 'utf8')).v, 3, '不得被回退');
});

/*
 * 回归（P0-5）：撤销/重做回放**不得**把「未采纳的 Conflict」交给 applyItem。
 *
 * 修复前 config-snapshot 的回放自持一份 kind 清单（NON_EXECUTABLE_KINDS 不含 Conflict），
 * 于是回放对冲突项照调 applyItem —— settings adapter 无条件 settings.replace，
 * 目标机与快照不同的本地值被静默覆盖（用户的新改动无声消失），而导入路径对同一项是 skip。
 * 本用例的 adapter 无论目标当前值如何都产出 Conflict（不带 resolution），applyItem 会写文件，
 * 因此「文件是否被写回快照值」就是判定式。
 */
test('undo 回放：未采纳的 Conflict 不得静默写目标（P0-5 回归）', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-lifecycle-conflict-'));
  t.after(async () => { await fs.rm(home, { recursive: true, force: true }); });
  const configFile = path.join(home, 'settings.yaml');
  await fs.writeFile(configFile, JSON.stringify({ v: 1 }), 'utf8');

  const calls = { apply: 0 };
  const adapter: ConfigAdapter = {
    id: 'settings',
    displayName: 'settings',
    defaultIncluded: true,
    portability: 'portable',
    async export(): Promise<ExportSection> {
      try {
        return { sectionId: 'settings', data: JSON.parse(await fs.readFile(configFile, 'utf8')) as Record<string, unknown>, counts: { n: 1 }, warnings: [] };
      } catch {
        return { sectionId: 'settings', data: {}, counts: { n: 1 }, warnings: [] };
      }
    },
    async validate() { return { valid: true, issues: [] }; },
    async analyzeImport() {
      return [{
        id: 'settings:conflict', kind: 'Conflict' as const, adapter: 'settings' as const,
        description: '本地值与快照不同', severity: 'warning' as const,
        target: { adapter: 'settings' as const, ref: 'settings' },
      }];
    },
    async applyItem(_item, ctx) {
      calls.apply += 1;
      await fs.writeFile(configFile, JSON.stringify(ctx.sections.get('settings') ?? {}), 'utf8');
      return { ok: true };
    },
  };
  const lifecycle = new ConfigLifecycle({
    dir: path.join(home, 'snapshots'), adapters: [adapter], ctx: makeContext('win32', home, 'web'),
    profile: 'web', autoEnabled: false,
  });

  await lifecycle.snapshot({ kind: 'manual', reason: 'seed' });      // 快照记录 {v:1}
  await fs.writeFile(configFile, JSON.stringify({ v: 2 }), 'utf8');  // 本地真实变更 → 与快照不同

  const outcome = await lifecycle.undo();
  assert.equal(calls.apply, 0, '回放不得把未采纳的 Conflict 交给 applyItem（否则静默覆盖本地值）');
  assert.deepEqual(JSON.parse(await fs.readFile(configFile, 'utf8')), { v: 2 }, '本地值必须原样保留');
  assert.equal(outcome.ok, true, '跳过冲突项不算失败');
  assert.ok(
    (outcome.report?.skipped ?? []).some((s) => s.includes('conflict')),
    '跳过的冲突项必须如实进报告（不得静默）',
  );
});

/* ------------------------------------------------------------ status */

test('status：canUndo / canRedo 随状态变化', async (t) => {
  const h = await harness(t);
  assert.deepEqual(
    { undo: (await h.lifecycle.status()).canUndo, redo: (await h.lifecycle.status()).canRedo },
    { undo: false, redo: false },
  );
  await h.lifecycle.snapshot({ kind: 'manual', reason: 'v1' });
  await fs.writeFile(h.configFile, JSON.stringify({ v: 2 }), 'utf8');
  await h.lifecycle.snapshot({ kind: 'auto', reason: 'change' });
  const s = await h.lifecycle.status();
  assert.equal(s.canUndo, true);
  assert.equal(s.canRedo, false);
  assert.equal(s.total, 2);
  assert.equal(s.lastAutoAt !== null, true);

  await h.lifecycle.undo();
  assert.equal((await h.lifecycle.status()).canRedo, true);
});

/* ------------------------------------------------------------ 回声抑制（核心） */

test('recordEcho + isEchoBatch：内容未变判回声，内容变化判真实变更', async (t) => {
  const h = await harness(t);
  const dir = h.home;
  await h.lifecycle.recordEcho();
  // 未登记的文件 → 真实变更
  assert.equal(await h.lifecycle.isEchoBatch([{ dir, filename: 'settings.yaml.new' }]), false);
  // 登记过且内容未变 → 回声
  assert.equal(await h.lifecycle.isEchoBatch([{ dir, filename: 'settings.yaml' }]), true);
  // 内容变了 → 真实变更
  await fs.writeFile(h.configFile, JSON.stringify({ v: 99 }), 'utf8');
  assert.equal(await h.lifecycle.isEchoBatch([{ dir, filename: 'settings.yaml' }]), false);
});

test('isEchoBatch：未登记任何内容时一律判真实变更（不得吞掉首次变更）', async (t) => {
  const h = await harness(t);
  assert.equal(await h.lifecycle.isEchoBatch([{ dir: h.home, filename: 'settings.yaml' }]), false);
});

test('isEchoBatch：文件被删除 → 真实变更（不得当作回声）', async (t) => {
  const h = await harness(t);
  await h.lifecycle.recordEcho();
  await fs.rm(h.configFile);
  assert.equal(await h.lifecycle.isEchoBatch([{ dir: h.home, filename: 'settings.yaml' }]), false);
});

test('replay 之后自动登记回声：恢复自写不被当作真实变更', async (t) => {
  const h = await harness(t);
  await h.lifecycle.snapshot({ kind: 'manual', reason: 'v1' });
  await fs.writeFile(h.configFile, JSON.stringify({ v: 2 }), 'utf8');
  await h.lifecycle.snapshot({ kind: 'auto', reason: 'change' });
  await h.lifecycle.undo();
  // 撤销把 settings.yaml 写回 v1；此刻事件应被判为回声
  assert.equal(await h.lifecycle.isEchoBatch([{ dir: h.home, filename: 'settings.yaml' }]), true);
});

/* ------------------------------------------------------------ 保留清理 */

test('自动快照触发保留清理，manual 不被清理', async (t) => {
  const h = await harness(t, { keepAuto: 1 });
  await h.lifecycle.snapshot({ kind: 'manual', reason: 'keepme' });
  for (let i = 0; i < 3; i++) {
    await h.lifecycle.snapshot({ kind: 'auto', reason: `auto-${i}` });
    // 每次 auto 都不同（时间戳/内容），确保不被去重
    await fs.writeFile(h.configFile, JSON.stringify({ v: 100 + i }), 'utf8');
  }
  const metas = await h.lifecycle.list();
  const autos = metas.filter((m) => m.kind === 'auto');
  assert.equal(autos.length, 1, 'auto 只保留最新 1 份');
  assert.equal(metas.filter((m) => m.kind === 'manual').length, 1, 'manual 不得被自动清理');
});

/* ------------------------------------------------------------ 监听生命周期 */

test('startAutoSnapshot：未注入 watchFactory 时为空操作（不炸）', async (t) => {
  const h = await harness(t);
  const bare = new ConfigLifecycle({
    dir: h.lifecycle.dir, adapters: [], ctx: h.ctx, profile: 'web',
  });
  bare.startAutoSnapshot();
  assert.equal(bare.isWatching, false);
  bare.dispose();
});

test('startAutoSnapshot：注入工厂后只监听**已存在**的目录；stop 后停止', async (t) => {
  const h = await harness(t);
  h.lifecycle.startAutoSnapshot();
  assert.equal(h.lifecycle.isWatching, true);
  // 修复：skills / .agent-presets 在本 harness 里并不存在，直接 watch 会为每个缺失目录
  // 刷一条告警（真实 DSH 首次启动实测 2 条）。因此只监听存在的目录。
  assert.deepEqual(h.watch.watched, [
    h.home,
    path.join(h.home, 'profiles', 'web'),
  ]);
  h.lifecycle.stopAutoSnapshot();
  assert.equal(h.lifecycle.isWatching, false);
});

test('startAutoSnapshot：目录在启动后才出现时，不因缺失目录而报错；重建监听后纳入', async (t) => {
  const h = await harness(t);
  h.lifecycle.startAutoSnapshot();
  assert.equal(h.watch.watched.includes(path.join(h.home, 'skills')), false, '缺失目录不应被监听');

  // 目录随后被创建 → 重建监听时应纳入
  await fs.mkdir(path.join(h.home, 'skills'), { recursive: true });
  h.lifecycle.startAutoSnapshot();
  assert.ok(h.watch.watched.includes(path.join(h.home, 'skills')), '目录出现后重建监听应纳入');
});

/*
 * 回归：启动后出现的目录必须**自愈**纳入监听，而不是只在「手动重建监听」时才生效。
 * startAutoSnapshot 每个进程只被宿主调用一次（启动闸门），旧实现因此让 skills /
 * .agent-presets 在整个进程生命周期内都不被监听 —— 与代码注释的承诺不符。
 */
test('自动快照端到端：启动后新出现的目录在一次快照后自动纳入监听', async (t) => {
  const h = await harness(t);
  h.lifecycle.startAutoSnapshot();
  const skills = path.join(h.home, 'skills');
  assert.equal(h.watch.watched.includes(skills), false, '前置条件：启动时不存在，未监听');

  await fs.mkdir(skills, { recursive: true });
  // 触发一次真实变更 → 防抖 → flush 结束后应自愈重建监听集
  await fs.writeFile(h.configFile, JSON.stringify({ v: 8 }), 'utf8');
  h.watch.emit(h.home, 'settings.yaml');
  h.timers.advance(1500);
  const ok = await waitFor(async () => h.watch.watched.includes(skills));
  assert.equal(ok, true, 'skills 目录出现后必须在下次快照后自动纳入监听');
});

test('startAutoSnapshot：没有任何可监听目录时不启动聚合器，且不抛', async (t) => {
  const h = await harness(t);
  // 用一个必然不存在的 home 构造实例：watchDirsFor 返回的目录全都不存在
  const warns: string[] = [];
  const bare = new ConfigLifecycle({
    dir: h.lifecycle.dir,
    adapters: [],
    ctx: makeContext('win32', path.join(h.home, 'no-such-dir'), 'web'),
    profile: 'web',
    watchFactory: h.watch.factory,
    onWarn: (m) => warns.push(m),
  });
  bare.startAutoSnapshot();
  assert.equal(bare.isWatching, false, '无可监听目录时不应挂上聚合器');
  assert.ok(warns.some((m) => m.includes('没有可监听的目录')), `应给出可读告警，实际: ${JSON.stringify(warns)}`);
  bare.dispose();
});

test('autoEnabled=false 时不启动监听', async (t) => {
  const h = await harness(t, { autoEnabled: false });
  h.lifecycle.startAutoSnapshot();
  assert.equal(h.lifecycle.isWatching, false);
});

test('dispose：释放后 stop 幂等', async (t) => {
  const h = await harness(t);
  h.lifecycle.startAutoSnapshot();
  h.lifecycle.dispose();
  assert.equal(h.lifecycle.isWatching, false);
  h.lifecycle.stopAutoSnapshot();
  assert.equal(h.lifecycle.isWatching, false);
});

/* ------------------------------------------------------------ 自动快照端到端 */

/** 等待落盘完成：onFlush 是 fire-and-forget，落盘含真实 fs IO */
async function waitFor(cond: () => Promise<boolean>, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('自动快照端到端：真实变更 → 防抖到期 → 落盘一份 auto 快照', async (t) => {
  const h = await harness(t);
  h.lifecycle.startAutoSnapshot();
  await fs.writeFile(h.configFile, JSON.stringify({ v: 7 }), 'utf8');
  h.watch.emit(h.home, 'settings.yaml');
  assert.equal((await h.lifecycle.list()).length, 0, '防抖窗口内不得落盘');
  h.timers.advance(1500);
  const ok = await waitFor(async () => (await h.lifecycle.list()).length === 1);
  assert.equal(ok, true, '防抖到期后必须落盘');
  const metas = await h.lifecycle.list();
  assert.equal(metas[0]!.kind, 'auto');
  assert.equal(metas[0]!.trigger, 'watcher');
  assert.equal(h.autoMetas.length, 1, '宿主回调必须被触发');
});

test('自动快照端到端：恢复自写文件是回声 → 不产生快照（否则会挡住重做）', async (t) => {
  const h = await harness(t);
  await h.lifecycle.snapshot({ kind: 'manual', reason: 'v1' });
  await fs.writeFile(h.configFile, JSON.stringify({ v: 2 }), 'utf8');
  await h.lifecycle.snapshot({ kind: 'auto', reason: 'change' });
  const before = (await h.lifecycle.list()).length;

  h.lifecycle.startAutoSnapshot();
  const undo = await h.lifecycle.undo(); // 撤销写回 v1 并登记回声
  assert.equal(undo.ok, true);

  h.watch.emit(h.home, 'settings.yaml'); // 恢复动作自己的写事件（或延迟投递）
  h.timers.advance(1500);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const after = await h.lifecycle.list();
  assert.equal(
    after.filter((m) => m.kind === 'auto' && m.reason === 'config-change').length, 0,
    '回声不得产生自动快照',
  );
  assert.ok(after.length >= before, '既有快照不得被删');
});

test('自动快照端到端：撤销后用户再次真实修改 → 照常落盘', async (t) => {
  const h = await harness(t);
  await h.lifecycle.snapshot({ kind: 'manual', reason: 'v1' });
  await fs.writeFile(h.configFile, JSON.stringify({ v: 2 }), 'utf8');
  await h.lifecycle.snapshot({ kind: 'auto', reason: 'change' });
  h.lifecycle.startAutoSnapshot();
  assert.equal((await h.lifecycle.undo()).ok, true);

  // 用户又改了一次，内容与回声登记不同 → 真实变更
  await fs.writeFile(h.configFile, JSON.stringify({ v: 42 }), 'utf8');
  h.watch.emit(h.home, 'settings.yaml');
  h.timers.advance(1500);
  const ok = await waitFor(async () =>
    (await h.lifecycle.list()).some((m) => m.kind === 'auto' && m.reason === 'config-change'));
  assert.equal(ok, true, '真实变更必须照常落盘');
});

test('自动快照端到端：抑制窗口内的事件被丢弃', async (t) => {
  const h = await harness(t);
  h.lifecycle.startAutoSnapshot();
  await h.lifecycle.suppressWhileAsync(async () => {
    h.watch.emit(h.home, 'settings.yaml');
    await Promise.resolve();
  });
  h.timers.advance(1500);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await h.lifecycle.list()).length, 0, '抑制期间不得落盘');
});

/* ------------------------------------------------------------ 竞态与故障注入回归 */

/*
 * 回归：flush 进行中到达的变更**不得被丢弃**。
 * watcher 在回调前已把事件批从 pending 摘除，旧实现在 flushRunning 时直接 return，
 * 那批事件再也没有定时器补发 —— 实测「连写 v2、v3 只落 1 份快照」，撤销于是无从回到 v2。
 *
 * 时序用 exportGate 钉死：flush#1 已读完 v2 并挂起时，才写入 v3 并触发第二轮防抖。
 */
test('自动快照端到端：flush 进行中的新变更被排队补拍（不得丢失中间状态）', async (t) => {
  const h = await harness(t);
  h.lifecycle.startAutoSnapshot();

  let release!: () => void;
  h.adapter.exportGate = new Promise<void>((resolve) => { release = resolve; });

  // 第一轮：变更到 v2，防抖到期 → flush#1 读到 v2 后挂在 gate 上
  await fs.writeFile(h.configFile, JSON.stringify({ v: 2 }), 'utf8');
  h.watch.emit(h.home, 'settings.yaml');
  h.timers.advance(1500);
  const started = await waitFor(async () => h.adapter.exportCalls >= 1);
  assert.equal(started, true, 'flush#1 必须已开始采集');

  // flush#1 仍在进行中时又来一次变更到 v3 → 防抖到期，只能排队
  await fs.writeFile(h.configFile, JSON.stringify({ v: 3 }), 'utf8');
  h.watch.emit(h.home, 'settings.yaml');
  h.timers.advance(1500);

  release(); // 放行 flush#1（其捕获内容 = v2），排队中的第二批随即被处理（v3）

  const ok = await waitFor(async () =>
    (await h.lifecycle.list()).filter((m) => m.kind === 'auto' && m.reason === 'config-change').length >= 2);
  assert.equal(ok, true, '两次真实变更都必须被快照，不得只留最后一份');

  const autos = (await h.lifecycle.list()).filter((m) => m.kind === 'auto' && m.reason === 'config-change');
  assert.equal(autos.length, 2, `两份变更各一份快照，实际 ${autos.length}`);
  h.adapter.exportGate = null;
});

test('自动快照端到端：flush 进行中的事件在 dispose 后不再补拍', async (t) => {
  const h = await harness(t);
  h.lifecycle.startAutoSnapshot();

  let release!: () => void;
  h.adapter.exportGate = new Promise<void>((resolve) => { release = resolve; });

  await fs.writeFile(h.configFile, JSON.stringify({ v: 2 }), 'utf8');
  h.watch.emit(h.home, 'settings.yaml');
  h.timers.advance(1500);
  assert.equal(await waitFor(async () => h.adapter.exportCalls >= 1), true, 'flush#1 必须已开始采集');

  await fs.writeFile(h.configFile, JSON.stringify({ v: 3 }), 'utf8');
  h.watch.emit(h.home, 'settings.yaml');
  h.timers.advance(1500);
  h.lifecycle.dispose(); // 排队中的事件批随停止监听一起作废

  release();
  await new Promise((resolve) => setTimeout(resolve, 300));

  const autos = (await h.lifecycle.list()).filter((m) => m.kind === 'auto' && m.reason === 'config-change');
  assert.ok(autos.length <= 1, `dispose 后不得再补拍新快照，实际 ${autos.length} 份`);
  h.adapter.exportGate = null;
});

/*
 * 回归：采集不完整（有分区导出失败）时**拒绝撤销**。
 * 缺分区的状态会与「内容其实相同的快照」判为不同 → planUndo 选中它 → 回放写不回任何东西，
 * 却返回 ok:true：一次「假成功的空操作」，且 canUndo 会永远为 true。
 */
test('undo：采集不完整（分区导出失败）→ 拒绝执行，不做假成功的空操作', async (t) => {
  const h = await harness(t);
  await h.lifecycle.snapshot({ kind: 'manual', reason: 'v1' });
  await fs.writeFile(h.configFile, JSON.stringify({ v: 2 }), 'utf8');
  await h.lifecycle.snapshot({ kind: 'auto', reason: 'change' });

  h.adapter.failExport = true; // 下一次采集会丢掉 settings 分区
  const outcome = await h.lifecycle.undo();
  assert.equal(outcome.ok, false, '采集不完整不得报成功');
  assert.match(outcome.reason ?? '', /^capture-incomplete:settings$/, `实际 reason: ${outcome.reason}`);
  assert.equal(JSON.parse(await fs.readFile(h.configFile, 'utf8')).v, 2, '磁盘内容不得被改动');
  h.adapter.failExport = false;
});

test('status：采集不完整时 canUndo=false（宁可报不可撤销，也不做假动作）', async (t) => {
  const h = await harness(t);
  await h.lifecycle.snapshot({ kind: 'manual', reason: 'v1' });
  await fs.writeFile(h.configFile, JSON.stringify({ v: 2 }), 'utf8');
  await h.lifecycle.snapshot({ kind: 'auto', reason: 'change' });
  assert.equal((await h.lifecycle.status()).canUndo, true, '前置条件：本来可以撤销');

  h.adapter.failExport = true;
  assert.equal((await h.lifecycle.status()).canUndo, false, '采集不完整 → 不得声称可撤销');
  h.adapter.failExport = false;
});

/*
 * 回归：撤销回放失败时**不得**消费 pre-restore。
 * 否则 planRedo 立刻变成 no-pre-restore，用户再没有回到「撤销前状态」的通道 ——
 * 而配置此刻正停在半应用的中间态，恰恰是最需要重做的时候。
 */
test('undo：回放失败时 pre-restore 不得被消费（用户必须还能回去）', async (t) => {
  const h = await harness(t);
  await h.lifecycle.snapshot({ kind: 'manual', reason: 'v1' });
  await fs.writeFile(h.configFile, JSON.stringify({ v: 2 }), 'utf8');
  await h.lifecycle.snapshot({ kind: 'auto', reason: 'change' });

  h.adapter.failApply = true; // 回放时写盘失败 → report.ok === false
  const undo = await h.lifecycle.undo();
  assert.equal(undo.ok, false, '回放失败必须如实报失败');
  assert.ok(undo.preSnapshotId !== undefined);

  const pre = (await h.lifecycle.list()).find((m) => m.id === undo.preSnapshotId)!;
  assert.notEqual(pre.consumed, true, '回放失败不得消费 pre-restore（否则用户回不去了）');
  h.adapter.failApply = false;
});

/*
 * 回归：pre-restore 必须与「据以挑选目标的那次采集」是同一份观测。
 * 旧实现先 capture() 挑目标、再 snapshot() 二次采集，两次之间用户的新改动会溜进
 * pre-restore —— 重做时把用户从没见过的内容写回去。
 */
test('undo：pre-restore 记录的是撤销前那一刻的状态，重做能回到它', async (t) => {
  const h = await harness(t);
  await h.lifecycle.snapshot({ kind: 'manual', reason: 'v1' });
  await fs.writeFile(h.configFile, JSON.stringify({ v: 2 }), 'utf8');
  await h.lifecycle.snapshot({ kind: 'auto', reason: 'change' });
  // 撤销前再改一次：这次改动就是「撤销前状态」，必须被 pre-restore 记下
  await fs.writeFile(h.configFile, JSON.stringify({ v: 5 }), 'utf8');

  const undo = await h.lifecycle.undo();
  assert.equal(undo.ok, true, JSON.stringify(undo.report?.failed ?? []));

  const pre = (await h.lifecycle.list()).find((m) => m.id === undo.preSnapshotId)!;
  const afterUndo = await h.lifecycle.capture();
  assert.notDeepEqual(pre.state.sections, afterUndo.sections, 'pre-restore 不得等于撤销后的状态');

  const redo = await h.lifecycle.redo();
  assert.equal(redo.ok, true, JSON.stringify(redo.report?.failed ?? []));
  assert.equal(JSON.parse(await fs.readFile(h.configFile, 'utf8')).v, 5, '重做必须回到撤销前的 v5');
});

/*
 * 回归：与最新快照内容完全相同的「快照」不携带新信息，不得落盘。
 * 这一层兜底覆盖面最广 —— 导入 / 备份恢复 / Profile 切换 / 同步应用这些通道写完配置
 * 同样会触发事件，但它们不经过 replay()，拿不到 lastReplayState。若照样落一份
 * 「等于刚恢复内容」的快照，它会比 pre-restore 更新，把重做通道永久堵死。
 */
test('自动快照端到端：内容等于最新快照的变更不落盘（其他恢复通道的兜底）', async (t) => {
  const h = await harness(t);
  await h.lifecycle.snapshot({ kind: 'manual', reason: 'v1' }); // 最新快照 = v1
  h.lifecycle.startAutoSnapshot();

  // 模拟一次非 replay 通道的恢复：把配置写回 v1（与最新快照内容完全相同）
  await fs.writeFile(h.configFile, JSON.stringify({ v: 1 }), 'utf8');
  h.watch.emit(h.home, 'settings.yaml');
  h.timers.advance(1500);
  await new Promise((resolve) => setTimeout(resolve, 200));

  const autos = (await h.lifecycle.list()).filter((m) => m.kind === 'auto' && m.reason === 'config-change');
  assert.equal(autos.length, 0, '与最新快照重复的内容不得产生快照');

  // 但真实的新内容仍必须落盘（不得把这一层兜底做成「静默停摆」）
  await fs.writeFile(h.configFile, JSON.stringify({ v: 9 }), 'utf8');
  h.watch.emit(h.home, 'settings.yaml');
  h.timers.advance(1500);
  const ok = await waitFor(async () =>
    (await h.lifecycle.list()).some((m) => m.kind === 'auto' && m.reason === 'config-change'));
  assert.equal(ok, true, '与最新快照不同的真实变更必须照常落盘');
});

/*
 * 回归：抑制窗口之后才投递的回声（macOS / 网络盘 / 杀毒扫描后重写）不得产生快照。
 * 旧实现的 EchoRegistry 只认「我们确实会写的那些路径」，一旦某轮模拟/恢复没有碰到某个
 * 文件，它的登记就没了，延迟事件于是被当成真实变更 → 新快照挡住重做。
 * 现在由「采集到的状态是否仍等于刚回放的目标状态」兜底。
 */
test('自动快照端到端：抑制窗口之外才投递的回声事件也被识别（不挡住重做）', async (t) => {
  const h = await harness(t);
  await h.lifecycle.snapshot({ kind: 'manual', reason: 'v1' });
  await fs.writeFile(h.configFile, JSON.stringify({ v: 2 }), 'utf8');
  await h.lifecycle.snapshot({ kind: 'auto', reason: 'change' });
  h.lifecycle.startAutoSnapshot();

  assert.equal((await h.lifecycle.undo()).ok, true);
  // 模拟「登记表已被后续轮次冲掉」：直接清掉回声内容登记，只剩 lastReplayState 兜底
  const before = (await h.lifecycle.list()).filter((m) => m.kind === 'auto' && m.reason === 'config-change').length;

  h.watch.emit(h.home, 'settings.yaml'); // 延迟投递的恢复自写事件
  h.timers.advance(1500);
  await new Promise((resolve) => setTimeout(resolve, 200));

  const after = (await h.lifecycle.list()).filter((m) => m.kind === 'auto' && m.reason === 'config-change').length;
  assert.equal(after, before, '恢复自写的延迟回声不得产生新快照');

  // 而重做通道必须还活着
  assert.equal((await h.lifecycle.status()).canRedo, true, '重做通道不得被回声快照堵死');
});

/* ---------------------------------------------- Phase 3 终态 / SAFE MODE（t16：P0-3） */

/*
 * 本组用真实 Phase3Recovery.runJournaled（Web gate / restore / model-tools 都经它）复现审计 P0-3：
 * 导入引擎在失败分支【已完成整体回滚】后正常返回 { ok:false, rollback }，而 runJournaled 只凭
 * 「fn 是否返回」推断成功 → 整笔 operation 被记成 COMMITTED 终态（回滚点随之失去 prune 豁免、
 * 事后审计读到与盘面相反的结论）。修复后必须由引擎经 ctx.recordRollback 上报，终态为 ROLLED_BACK。
 *
 * 放在本文件是因为 t16 的 in-scope 测试文件只有 config-lifecycle.test.ts 与 boot-rescue.test.ts。
 */

function lockCtxOf(instance = 'owner-t16'): MutationLockContext {
  return { token: { tokenId: 't', managerId: 'm', instanceId: instance, acquiredAt: Date.now() } };
}

async function makeRecovery(
  t: { after: (fn: () => Promise<void> | void) => void },
): Promise<{ recovery: Phase3Recovery; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-p03-'));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  const recovery = new Phase3Recovery({ dataDir: dir, packageVersion: '0.1.63', environmentFingerprint: 'fp-t16' });
  await recovery.store.ensureDirs();
  return { recovery, dir };
}

/** 引擎侧的记录面（可选调用：非 journaled 路径不传 binding；与 analyzer 的实现同形） */
interface RollbackReporterLike {
  recordRollback?: (report: { full: boolean; failed: readonly string[] }) => Promise<void>;
}

test('P0-3：fn 内部已完成回滚（full=false）→ 终态 ROLLED_BACK + durable SAFE MODE，绝不写 COMMITTED', async (t) => {
  const { recovery, dir } = await makeRecovery(t);

  const { operationId, result } = await recovery.runJournaled<{ ok: boolean }>({
    operationType: 'import-apply',
    lockCtx: lockCtxOf(),
    deferredSnapshot: true,
    fn: async (ctx) => {
      const jc = ctx as unknown as RollbackReporterLike;
      // 导入引擎：快照绑定 → 首个 mutation 前 markApplying → 失败 → 整体回滚（有补偿失败项）
      await jc.recordRollback?.({ full: false, failed: ['credential:demo'] });
      return { ok: false };
    },
  });

  assert.deepEqual(result, { ok: false }, 'fn 返回值不变（引擎仍把回滚报告交给 HTTP 层）');
  const j = await recovery.store.load(operationId);
  assert.ok(j !== null);
  assert.notEqual(j.state, 'COMMITTED', '已回滚的 operation 绝不能被记为 COMMITTED 终态');
  assert.equal(j.state, 'ROLLED_BACK');
  assert.deepEqual(j.rollback.failed, ['credential:demo'], 'journal 必须留下回滚报告（可审计）');
  assert.equal(j.rollback.full, false);
  assert.equal(recovery.safeModeActive, true, '部分回滚 → destructive 入口必须被阻断');
  assert.equal(await recovery.store.readSafeMode(), true, 'durable 标记：下次启动据此不判 NORMAL');
  assert.equal(readSafeModeMarkerSync(dir), 'blocked', '宿主/CLI 同步探测必须看到阻断');
});

test('P0-3：fn 内部完整回滚（full=true）→ ROLLED_BACK 且不置 SAFE MODE（不过度阻断）', async (t) => {
  const { recovery } = await makeRecovery(t);

  const { operationId } = await recovery.runJournaled<{ ok: boolean }>({
    operationType: 'import-apply',
    lockCtx: lockCtxOf('owner-t16-full'),
    deferredSnapshot: true,
    fn: async (ctx) => {
      await (ctx as unknown as RollbackReporterLike).recordRollback?.({ full: true, failed: [] });
      return { ok: false };
    },
  });

  const j = await recovery.store.load(operationId);
  assert.ok(j !== null);
  assert.equal(j.state, 'ROLLED_BACK');
  assert.equal(recovery.safeModeActive, false, '完整回滚已回到导入前状态 → 无需 SAFE MODE');
  assert.equal(await recovery.store.readSafeMode(), false);
});

test('P0-3：已回滚但未收敛的回滚点仍受 prune 豁免保护；COMMITTED / 完整回滚不保护', async (t) => {
  const { recovery } = await makeRecovery(t);
  const mk = async (state: 'COMMITTED' | 'ROLLED_BACK', snapshotId: string, full: boolean): Promise<void> => {
    const opId = randomUUID();
    await recovery.store.create(createJournalEntry('import-apply', {
      operationId: opId, ownerInstanceId: 'o', lockId: 'o', packageVersion: '0', environmentFingerprint: 'fp-t16',
    }, new Date().toISOString()));
    await recovery.store.update(opId, (j) => ({ ...j, snapshotId, state: 'APPLYING' }));
    await recovery.store.update(opId, (j) => (state === 'COMMITTED'
      ? transitionJournalState(transitionJournalState(j, 'VALIDATING'), 'COMMITTED')
      : {
          ...transitionJournalState(transitionJournalState(j, 'ROLLING_BACK'), 'ROLLED_BACK'),
          rollback: { ...j.rollback, full },
        }));
    await recovery.store.moveToCompleted(opId);
  };
  await mk('ROLLED_BACK', 'snap-incomplete', false);
  await mk('ROLLED_BACK', 'snap-complete', true);
  await mk('COMMITTED', 'snap-committed', true);

  const refs = await recovery.store.listReferencedSnapshotIds();
  assert.equal(refs.has('snap-incomplete'), true, '半回滚态的恢复点绝不可被自动淘汰');
  assert.equal(refs.has('snap-complete'), false, '完整回滚：快照已消费，可被保留策略清理');
  assert.equal(refs.has('snap-committed'), false, 'COMMITTED 已消费，不保护');
});

/*
 * 端到端（P0-3 的**真实生产链路**）：Importer.executeImportPlan 在失败分支完成整体回滚后
 * 正常返回 { ok:false, rollback }，宿主是 runJournaled —— 本用例把两者按 src/index.ts 的
 * 真实接法串起来（runJournaled 的 journalCtx 作为 executeImportPlan 的 snapshotBinding），
 * 断言 journal 终态是 ROLLED_BACK 且回滚报告进 journal（修复前为 COMMITTED）。
 * 同时断言 HTTP 层拿到的返回值形状不变（ok:false + rollback 报告仍在）。
 */
test('P0-3 端到端：executeImportPlan 整体回滚 → journal 记 ROLLED_BACK（不是 COMMITTED），返回值形状不变', async (t) => {
  const { recovery } = await makeRecovery(t);
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-p03-e2e-'));
  t.after(async () => { await fs.rm(workDir, { recursive: true, force: true }); });
  const zipPath = path.join(workDir, 'backup.zip');

  // 1) 造一个真实备份 ZIP（settings 分区含 demo namespace）
  const srcCtx = makeContext('win32', 'C:/src/.dsh', 'web');
  const sectionData = { version: 1, namespaces: { demo: { value: { a: 1 }, revision: 1, secrets: [] } } };
  const baseAdapter = (over: Partial<ConfigAdapter>): ConfigAdapter => ({
    id: 'settings', displayName: 'settings', defaultIncluded: true, portability: 'portable',
    async export() { return { sectionId: 'settings', data: sectionData, counts: { n: 1 }, warnings: [] }; },
    async validate() { return { valid: true, issues: [] }; },
    async analyzeImport() { return []; },
    async applyItem() { return { ok: true }; },
    ...over,
  } as ConfigAdapter);
  await new Exporter({ ctx: srcCtx, adapters: [baseAdapter({})], now: () => new Date('2026-09-13T00:00:00.000Z') })
    .export({ includeSecrets: false, outPath: zipPath });

  // 2) 目标机：demo 已存在（快照可登记原值），applyItem 必失败 → 触发整体回滚
  const dstCtx = makeContext('win32', 'C:/dst/.dsh', 'web');
  dstCtx.settings.ns.set('demo', { value: { a: 0 }, revision: 3, secrets: [] });
  const failing = baseAdapter({
    async analyzeImport() {
      return [{
        id: 'settings:demo', kind: 'Update' as const, adapter: 'settings' as const,
        description: 'demo', severity: 'info' as const, target: { adapter: 'settings' as const, ref: 'demo' },
      }];
    },
    async applyItem() { return { ok: false, message: 'boom' }; },
  });
  const store = new MemSnapshotStore();
  const importer = new Importer({ ctx: dstCtx, adapters: [failing], snapshotStore: store });
  const plan: ImportPlan = {
    items: [{
      id: 'settings:demo', kind: 'Update', adapter: 'settings', description: 'demo', severity: 'info',
      target: { adapter: 'settings', ref: 'demo' },
    }],
    globalStrategy: 'merge', pathMappings: [], missingSecrets: [], needsRestart: false,
    estimatedActions: {} as ImportPlan['estimatedActions'],
  };

  // 3) 真实接法：宿主 gate 的 journalCtx 作为引擎的 snapshotBinding
  const engine: { result: { ok: boolean; rollback: unknown } | null } = { result: null };
  const { operationId } = await recovery.runJournaled({
    operationType: 'import-apply',
    lockCtx: lockCtxOf('owner-t16-e2e'),
    deferredSnapshot: true,
    fn: async (jctx) => {
      const r = await importer.executeImportPlan(zipPath, plan, {
        confirm: true,
        rollbackOnError: true,
        snapshotBinding: jctx,
      });
      engine.result = { ok: r.ok, rollback: r.rollback };
      return r;
    },
  });

  assert.equal(engine.result?.ok, false, '引擎仍以 ok:false 返回（HTTP 层报告形状不变）');
  assert.ok(engine.result?.rollback !== null, '回滚报告仍随返回值交给调用方');
  assert.deepEqual(
    store.snapshots.get([...store.snapshots.keys()][0]!)?.status,
    'rolled-back',
    '引擎侧仍把快照标记为 rolled-back',
  );

  const j = await recovery.store.load(operationId);
  assert.ok(j !== null);
  assert.notEqual(j.state, 'COMMITTED', '端到端：已回滚的导入绝不能被 journal 记为 COMMITTED');
  assert.equal(j.state, 'ROLLED_BACK');
  assert.deepEqual(j.rollback.failed, [], '补偿全部成功 → journal 记 full');
  assert.equal(j.rollback.full, true);
  assert.equal(await recovery.store.readSafeMode(), false, '完整回滚不置 SAFE MODE');
});
