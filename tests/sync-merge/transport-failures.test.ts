/**
 * 场景 10 / 16：传输层故障分流（kind 保真，不吞错、不假成功）与通道行为一致性。
 *
 * 只断言**引擎可观测的契约**：错误分类、失败时零写入（sync-state 原文 / 远端快照数不变）、
 * git(fake) 与 webdav(fake) 在同一场景下的结果逐字段一致。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { isSyncTransportError, isRetryableTransportError } from '../../src/sync/transport.ts';
import {
  createSharedDevices, makeRoot, readStateJson, readStateText, setNamespace, seedRemote,
  makeSnapshot, settingsSection, transportError,
} from './helpers.ts';
import type { SectionData } from '../../src/schema/types.ts';

/** 断言抛出的错误是带指定 kind 的 SyncTransportError。 */
async function rejectsWithKind(fn: () => Promise<unknown>, kind: string): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    return isSyncTransportError(err) && err.kind === kind;
  }, '错误必须保留 kind=' + kind);
}

test('场景 10a 远端写入失败（timeout）：push 抛错、远端无新快照、本机基线零写入', async () => {
  const root = await makeRoot('upload-fail');
  try {
    const { devices } = await createSharedDevices(root, ['a']);
    const a = devices['a']!;
    setNamespace(a, 'general', { theme: 'dark' }, 3);
    a.transport.failNext('upload', transportError('timeout', 'upload timeout'));

    await rejectsWithKind(() => a.engine.push({ snapshotId: 'sync-x' }), 'timeout');
    assert.equal(a.transport.snapshots.has('sync-x'), false, '上传失败不得留下半份远端数据');
    assert.equal(a.transport.count('upload'), 1);
    // 说明：push 会在上传前落一次设备身份（deviceId/deviceName，非基线数据），
    // 因此这里断言的是**基线字段**未推进，而不是 sync-state 逐字节不变。
    const state = await readStateJson(a);
    if (state !== null) {
      assert.equal(state['lastSnapshotId'], '', '上传失败不得推进远端指针');
      assert.equal(state['ancestorId'], '', '上传失败不得写祖先副本指针');
      assert.equal(state['lastSyncAt'], '', '上传失败不得更新 lastSyncAt');
      assert.deepEqual(state['sections'], {}, '上传失败不得写任何分区 hash');
    }
    assert.equal(a.transport.snapshots.size, 0, '远端保持为空');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('场景 10b 鉴权失败（auth）：list 抛错按不可重试分类原样上抛', async () => {
  const root = await makeRoot('auth-fail');
  try {
    const { devices } = await createSharedDevices(root, ['a']);
    const a = devices['a']!;
    a.transport.failNext('list', transportError('auth', '401 Unauthorized'));
    await assert.rejects(
      () => a.engine.hasNewRemoteSnapshot(),
      (err: unknown) => isSyncTransportError(err) && err.kind === 'auth' && isRetryableTransportError(err) === false,
      'auth 必须按不可重试分类上抛（重试无意义）',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('场景 10c 网络中断（network）：merge 下载失败即上抛，绝不返回「空计划」冒充成功', async () => {
  const root = await makeRoot('download-fail');
  try {
    const { transport, devices } = await createSharedDevices(root, ['a']);
    const a = devices['a']!;
    setNamespace(a, 'general', { theme: 'dark' }, 3);
    await seedRemote(transport, makeSnapshot('remote-1', { settings: settingsSection({ general: { theme: 'dark' } }) }));
    a.transport.failNext('download', transportError('network', 'connection reset'));
    await rejectsWithKind(() => a.engine.merge(), 'network');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('场景 10d 服务端 5xx（server）：可重试分类保真', async () => {
  const root = await makeRoot('server-fail');
  try {
    const { devices } = await createSharedDevices(root, ['a']);
    const a = devices['a']!;
    a.transport.failNext('list', transportError('server', '503'));
    await assert.rejects(
      () => a.engine.listSnapshots(),
      (err: unknown) => isSyncTransportError(err) && err.kind === 'server' && isRetryableTransportError(err) === true,
      'server（5xx/429）必须是可重试分类',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('场景 16 git(fake) 与 webdav(fake) 同场景结果一致（merge 决策 + 基线语义）', async () => {
  const rootGit = await makeRoot('parity-git');
  const rootWebdav = await makeRoot('parity-webdav');
  try {
    const run = async (root: string, type: string) => {
      const { devices } = await createSharedDevices(root, ['a', 'b'], { transportType: type });
      const a = devices['a']!;
      const b = devices['b']!;
      setNamespace(a, 'general', { theme: 'dark', language: 'zh-CN' }, 3);
      setNamespace(b, 'general', { theme: 'dark', language: 'zh-CN' }, 3);
      await a.engine.push({ snapshotId: 'a-1' });
      setNamespace(b, 'general', { theme: 'light', language: 'zh-CN' }, 4);
      await b.engine.push({ snapshotId: 'b-1' });
      const plan = await a.engine.merge();
      const state = JSON.parse((await readStateText(a))!) as Record<string, unknown>;
      delete state['transport']; // 通道名是唯一允许不同的字段
      delete state['deviceId']; // 设备身份是随机 UUID，两端本就不同
      delete state['deviceName']; // 主机名相同，但一并剔除以免环境差异干扰
      return {
        decisions: plan.sections.map((s) => s.id + '=' + s.decision),
        settings: plan.sections.find((s) => s.id === 'settings')?.merged,
        state,
        channelType: a.transport.type,
      };
    };
    const git = await run(rootGit, 'git');
    const webdav = await run(rootWebdav, 'webdav');
    assert.equal(git.channelType, 'git');
    assert.equal(webdav.channelType, 'webdav');
    assert.deepEqual(webdav.decisions, git.decisions, '同场景下两条通道的决策序列必须一致');
    assert.deepEqual(webdav.settings, git.settings, '合并结果必须一致');
    assert.deepEqual(webdav.state, git.state, '基线（除通道名外）必须一致');
  } finally {
    await fs.rm(rootGit, { recursive: true, force: true });
    await fs.rm(rootWebdav, { recursive: true, force: true });
  }
});

test('场景 16b 两条通道对 payload 的形状闸门一致：畸形分区在两端都判 conflict(format)', async () => {
  const run = async (type: string) => {
    const root = await makeRoot('parity-bad-' + type);
    try {
      const { transport, devices } = await createSharedDevices(root, ['a'], { transportType: type });
      const a = devices['a']!;
      setNamespace(a, 'general', { theme: 'dark' }, 3);
      await a.engine.push({ snapshotId: 'a-1' });
      const bad = transport.snapshots.get('a-1')!;
      (bad.sections as Record<string, unknown>)['settings'] = 'garbage' as unknown as SectionData;
      const plan = await a.engine.merge();
      const r = plan.sections.find((s) => s.id === 'settings')!;
      return r.decision + ':' + (r.conflicts[0]?.reason ?? '-');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  };
  assert.equal(await run('git'), 'conflict:format');
  assert.equal(await run('webdav'), 'conflict:format');
});
