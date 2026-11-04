/**
 * tech-debt #7 守卫：恢复面板的**短写盘**动作必须挂在 runStore 的内存瞬态切片上。
 *
 * 背景：会话修复 apply / 批量修复 / 布局归位 / SAFE MODE 解除 / 锁回收 / 救援开关都没有宿主 run
 * （`src/core/run-registry.ts` 的 RunKind 是固定联合，加 kind 要同时改宿主路由，而 tech-debt 的诉求
 * 只是「切页丢进行中视图」）。此前这些「进行中」只活在组件 useState 里 —— 切一下 tab 就没了，
 * 回来还能再点一次同一个写盘动作。
 *
 * 判据分两层：
 *  ① 语义层：`runStore.recovery.write` 切页（重新挂载读同一份快照）仍 alive；**不落盘**；
 *     刷新（新实例复用同 storage）一律回 null；
 *  ② 源码层：四个面板组件都经 `useRecoveryWriteKey()` 读、经 `withRecoveryWrite()` 写，
 *     不再各自持有 `*Busy` 布尔 —— 否则加一个新按钮就会悄悄退回「切页即丢」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { RunStore, type StoreStorage } from '../run-store.ts';

/** 与 run-store.test.ts 同口径的内存 store（sessionStorage 替身）。 */
function makeStorage(): { storage: StoreStorage; raw: () => string | null } {
  let value: string | null = null;
  return {
    storage: {
      getItem: () => value,
      setItem: (_key: string, next: string) => { value = next },
      removeItem: () => { value = null },
    },
    raw: () => value,
  };
}

test('#7：写盘中切页（重挂读同一份快照）仍 alive —— 进行中态不再是组件 useState', () => {
  const { storage } = makeStorage();
  const store = new RunStore({ storage });
  store.beginRecoveryWrite('session-layout:apply');

  const write = store.getSnapshot().recovery.write;
  assert.ok(write !== null, '登记后应能读到进行中动作');
  assert.equal(write?.key, 'session-layout:apply');
  assert.equal(typeof write?.startedAt, 'number', 'startedAt 供「已等待多久」用');

  // 切页 = 组件树卸载后重新挂载：读的是同一份 store 快照（模块级单例）
  assert.equal(store.getSnapshot().recovery.write?.key, 'session-layout:apply', '切页回来必须仍显示进行中');
});

test('#7：进行中态不落盘 —— 刷新后回 null，不把「正在写」带进新会话', () => {
  const { storage, raw } = makeStorage();
  const store = new RunStore({ storage });
  store.beginRecoveryWrite('session-repair-all');

  const text = raw();
  assert.ok(text !== null, 'patch 后已同步持久化');
  const persisted = JSON.parse(text) as Record<string, unknown>;
  const recovery = persisted['recovery'] as Record<string, unknown>;
  assert.equal('write' in recovery, false, 'recovery.write 是内存瞬态，不得进 sessionStorage 白名单');

  // 新实例复用同 storage = 刷新：上一会话的进行中态绝不复活
  const reloaded = new RunStore({ storage });
  assert.equal(reloaded.getSnapshot().recovery.write, null, '刷新后进行中态复位为 null');
});

test('#7：endRecoveryWrite 只清自己的 key —— 晚到的 finally 不抹掉后一个动作', () => {
  const { storage } = makeStorage();
  const store = new RunStore({ storage });
  store.beginRecoveryWrite('session-repair:u1');
  // 用户没等响应就点了另一个动作：单槽登记第二个
  store.beginRecoveryWrite('session-repair:u2');
  // 前一个请求的 finally 现在才到
  store.endRecoveryWrite('session-repair:u1');
  assert.equal(
    store.getSnapshot().recovery.write?.key,
    'session-repair:u2',
    '晚到的清除不得抹掉后一个动作（否则界面假装写完了）',
  );
  store.endRecoveryWrite('session-repair:u2');
  assert.equal(store.getSnapshot().recovery.write, null);
});

test('#7 源码守卫：发起写盘的面板组件经 use-recovery-write 读写，不再自持 Busy 布尔', () => {
  // 只有真正发起写盘的三个文件登记进行中态；SessionHealthCard 只托管入口卡与弹窗（自身无写盘动作）
  for (const file of ['RecoveryPanel.tsx', 'SessionHealthDialog.tsx', 'SessionLayoutSection.tsx']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.ok(src.includes('useRecoveryWriteKey'), file + ' 必须从 use-recovery-write 读进行中态');
    assert.ok(src.includes('withRecoveryWrite'), file + ' 的写盘动作必须包在 withRecoveryWrite 里');
    assert.equal(/useState<boolean>(false)[^\n]*[Bb]usy/.test(src), false, file + ' 不得再自持 Busy 布尔');
    assert.equal(/const \[(lockBusy|safeModeBusy|rescueBusy|busy|batchBusy), set/.test(src), false, file + ' 不得再声明 *Busy 状态');
  }
});
