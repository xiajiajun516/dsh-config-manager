/**
 * **本地改动监听器**单测（src/sync/sync-watcher.ts）。
 *
 * 盯四件事：
 *  1. 文件目标监听父目录 + basename 过滤（原子写 rename 后句柄不失）；
 *  2. 一次保存连写多个文件 → 去抖合并成一次 onFlush，且噪声路径被挡掉；
 *  3. suspend/resume 的自写回声屏蔽（否则 push→apply→push 死循环）；
 *  4. 监听失败绝不抛错（兜底是定时器），stop/setTargets 必须关掉旧句柄。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { SyncWatcher } from './sync-watcher.ts';
import { buildWatchTargets, type WatchTarget } from './watch-scope.ts';
import type { Logger } from '../utils/logger.ts';

const HOME = path.join(path.sep, 'home', 'u', '.dsh');

interface FakeListener { absPath: string; recursive: boolean; fn: (event: string, filename: string | null) => void }

function makeLogger(): { log: Logger; warns: string[]; debugs: string[] } {
  const warns: string[] = [];
  const debugs: string[] = [];
  const log = {
    debug: (m: string) => { debugs.push(m); },
    info: () => undefined,
    warn: (m: string) => { warns.push(m); },
    error: () => undefined,
  } as unknown as Logger;
  return { log, warns, debugs };
}

function makeHarness(targets: readonly WatchTarget[], opts: { failOn?: string } = {}) {
  const listeners: FakeListener[] = [];
  const handles: Array<{ absPath: string; closed: boolean }> = [];
  const flushes: string[][] = [];
  const timers: Array<() => void> = [];
  let nowMs = 10_000;
  const { log, warns, debugs } = makeLogger();
  const watcher = new SyncWatcher({
    homeDir: HOME,
    targets,
    log,
    onFlush: (changed) => { flushes.push([...changed]); },
    watchFactory: (absPath, o, fn) => {
      if (opts.failOn !== undefined && absPath === opts.failOn) throw new Error('ENOENT: 不存在');
      const h = { absPath, closed: false };
      handles.push(h);
      listeners.push({ absPath, recursive: o.recursive, fn });
      return { close: () => { h.closed = true; } };
    },
    now: () => nowMs,
    setTimer: (fn) => { timers.push(fn); return timers.length as unknown as ReturnType<typeof setTimeout>; },
    clearTimer: () => undefined,
  });
  /** 触发某目录上的原生事件（按绝对路径找监听句柄）。 */
  const fire = (absPath: string, filename: string | null): void => {
    const hit = listeners.filter((l) => l.absPath === absPath);
    assert.ok(hit.length > 0, '没有监听 ' + absPath);
    for (const l of hit) l.fn('change', filename);
  };
  const runTimers = (): void => {
    const pending = [...timers];
    timers.length = 0;
    for (const t of pending) t();
  };
  return { watcher, listeners, handles, flushes, timers, fire, runTimers, warns, debugs, setNow: (v: number) => { nowMs = v; } };
}

const TARGETS = buildWatchTargets({ homeDir: HOME });
const settingsAbs = path.join(HOME, 'settings.yaml');
const skillsAbs = path.join(HOME, 'skills');

test('start()：每个目标挂一个监听（文件目标监听父目录且非递归），重复调用幂等', () => {
  const h = makeHarness(TARGETS);
  h.watcher.start();
  assert.equal(h.watcher.isStarted(), true);
  assert.equal(h.watcher.attachmentCount(), TARGETS.length);
  const fileListener = h.listeners.find((l) => l.absPath === path.dirname(settingsAbs));
  assert.ok(fileListener !== undefined, 'settings.yaml 必须监听父目录（原子写 rename 后句柄不失）');
  assert.equal(fileListener!.recursive, false, '文件目标不得递归');
  const dirListener = h.listeners.find((l) => l.absPath === skillsAbs);
  assert.equal(dirListener!.recursive, true, '目录目标递归');
  h.watcher.start();
  assert.equal(h.watcher.attachmentCount(), TARGETS.length, 'start() 幂等');
  h.watcher.stop();
  assert.equal(h.watcher.attachmentCount(), 0);
  assert.ok(h.handles.every((x) => x.closed), 'stop() 必须关掉每个句柄');
});

test('文件目标：只认同名 basename；一次保存的连续事件去抖成一次 onFlush', () => {
  const h = makeHarness(TARGETS);
  h.watcher.start();
  const dir = path.dirname(settingsAbs);
  h.fire(dir, 'other.yaml');
  assert.equal(h.timers.length, 0, '父目录里别的文件不得触发（否则整目录噪声）');
  h.fire(dir, 'settings.yaml.tmp-1234-0');
  assert.equal(h.timers.length, 0, '原子写临时文件是噪声');
  h.fire(dir, 'settings.yaml');
  h.fire(dir, 'settings.yaml');
  assert.equal(h.timers.length, 1, '去抖：多次事件只排一个定时器');
  h.runTimers();
  assert.deepEqual(h.flushes, [['settings.yaml']], '去重后只报一次路径');
});

test('目录目标：递归事件的相对路径按 home 归一化；filename=null 忽略', () => {
  const h = makeHarness(TARGETS);
  h.watcher.start();
  h.fire(skillsAbs, null);
  assert.equal(h.timers.length, 0, '拿不到文件名的事件不能猜路径');
  h.fire(skillsAbs, path.join('nodejs-testing', 'SKILL.md'));
  h.runTimers();
  assert.deepEqual(h.flushes, [['skills/nodejs-testing/SKILL.md']]);
});

test('suspend() 丢弃在途事件；resume() 后静默窗口内的事件被推迟到窗口结束（自写回声不触发、用户改动不丢）', () => {
  const h = makeHarness(TARGETS);
  h.watcher.start();
  const dir = path.dirname(settingsAbs);
  h.fire(dir, 'settings.yaml');
  assert.equal(h.timers.length, 1);
  h.watcher.suspend();
  // suspend 清掉在途去抖：即便那枚已被 clearTimer 的定时器仍被触发，也不得回调
  h.runTimers();
  assert.deepEqual(h.flushes, [], 'suspend 必须丢弃在途变更（同步自家 apply/push 的写入不算用户改动）');
  h.fire(dir, 'settings.yaml');
  assert.equal(h.timers.length, 0, 'suspend 期间的事件一律屏蔽');
  h.runTimers();
  assert.deepEqual(h.flushes, [], '挂起期间不得回调');
  h.watcher.resume();
  h.setNow(10_000 + 1_999);
  h.fire(dir, 'settings.yaml');
  assert.deepEqual(h.flushes, [], '静默窗口内（<2000ms）不得立刻回调');
  assert.equal(h.timers.length, 1, '但必须排一枚窗口结束后的补跑定时器（真机实测：直接丢弃会让用户改动等一整轮兜底间隔）');
  // 平台抖动 / clearTimer 未生效导致定时器提前到期：仍不得在窗口内回调，而是继续推迟
  h.runTimers();
  assert.deepEqual(h.flushes, [], '窗口内即便定时器到期也不得回调');
  assert.equal(h.timers.length, 1, '必须重新排期，绝不把这次改动丢掉');
  h.setNow(10_000 + 2_001);
  h.runTimers();
  assert.deepEqual(h.flushes, [['settings.yaml']], '窗口结束后补跑一次：用户改动照常上行，自家回声由引擎 hash 比对判无变化');
});

test('stop() 后不再触发；onFlush 抛错只告警（监听不能拖垮宿主）', () => {
  const { log } = makeLogger();
  const warns: string[] = [];
  const throwing = { ...log, warn: (m: string) => { warns.push(m); } } as unknown as Logger;
  const h = makeHarness(TARGETS);
  h.watcher.start();
  const dir = path.dirname(settingsAbs);
  const stale = h.listeners.filter((l) => l.absPath === dir);
  assert.ok(stale.length > 0);
  h.watcher.stop();
  for (const l of stale) l.fn('change', 'settings.yaml');
  assert.equal(h.timers.length, 0, 'stop 后事件不得再排期（挂起的句柄回声也要挡）');
  // 单独构造一个回调抛错的实例
  const timers: Array<() => void> = [];
  const w2 = new SyncWatcher({
    homeDir: HOME,
    targets: TARGETS,
    log: throwing,
    onFlush: () => { throw new Error('上层炸了'); },
    watchFactory: (absPath, _o, fn) => { fn('change', 'settings.yaml'); return { close: () => undefined }; },
    setTimer: (fn) => { timers.push(fn); return timers.length as unknown as ReturnType<typeof setTimeout>; },
    clearTimer: () => undefined,
  });
  w2.start();
  for (const t of [...timers]) t();
  assert.ok(warns.some((m) => m.includes('自动同步监听回调失败')), '回调抛错必须落 warn，不得冒泡');
});

test('监听挂载失败（路径不存在）不抛错、不计入附件数，只留 debug', () => {
  // 用 skills/ 目录目标做失败点：它独占一个监听路径（settings.yaml 等三个文件目标共用 HOME，会一起失败）
  const h = makeHarness(TARGETS, { failOn: skillsAbs });
  h.watcher.start();
  assert.equal(h.watcher.attachmentCount(), TARGETS.length - 1, '失败目标不挂载');
  assert.ok(h.debugs.some((m) => m.includes('自动同步监听未挂载')), '失败原因写进 debug 日志');
});

test('setTargets()：原子重启，旧句柄关闭、新目标挂上', () => {
  const h = makeHarness(TARGETS);
  h.watcher.start();
  const before = h.handles.length;
  const narrowed = TARGETS.filter((t) => t.relPath === 'settings.yaml');
  h.watcher.setTargets(narrowed);
  assert.ok(h.handles.slice(0, before).every((x) => x.closed), '换目标必须关掉旧句柄');
  assert.equal(h.watcher.attachmentCount(), 1);
  h.watcher.stop();
});

test('未 start 时 setTargets 只记目标、不挂监听', () => {
  const h = makeHarness(TARGETS);
  h.watcher.setTargets(TARGETS);
  assert.equal(h.watcher.attachmentCount(), 0);
  assert.equal(h.watcher.isStarted(), false);
});
