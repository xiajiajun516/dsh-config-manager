/**
 * ⑥ 设备身份（sync-state.resolveDeviceIdentity + push manifest 携带）+ ② 引擎探针的单测。
 *
 *  - resolveDeviceIdentity：首次调用生成并落盘 deviceId/deviceName（读回一致）；
 *    第二次调用**不再写盘**（写计数 fs 断言）；空主机名 → 字典兜底文案；
 *    已有 id 而无 name 的旧文件 → 纯读（磁盘逐字节不变）；
 *  - engine.push：快照 manifest 带 deviceId/deviceName，且与 sync-state 落盘值一致、第二次 push 稳定；
 *  - engine.probe：通道无 probe → 抛 sync.probeUnsupported（绝不谎报连接正常）；有 probe → 原样透出。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SyncEngine } from './sync-engine.ts';
import { createSnapshotFs } from './fs.ts';
import type { SnapshotFs } from './fs.ts';
import {
  loadSyncState, resolveDeviceIdentity, saveSyncState, SYNC_STATE_FILE, SYNC_STATE_SCHEMA_VERSION,
} from './sync-state.ts';
import { computeSnapshotMeta, SyncTransportError } from './transport.ts';
import type { SyncSnapshot, SyncSnapshotMeta, SyncTransport } from './transport.ts';
import { createAdapters } from '../adapters/index.ts';
import { makeContext, MemSnapshotStore } from '../adapters/test-helpers.ts';
import { Importer } from '../core/importer.ts';
import { zhMsg } from '../core/messages.ts';

/* ---------------- 写计数 fs（断言「第二次不再写盘」） ---------------- */

function countingFs(): { fsx: SnapshotFs; stats: { writes: number; mkdirs: number } } {
  const inner = createSnapshotFs();
  const stats = { writes: 0, mkdirs: 0 };
  const fsx: SnapshotFs = {
    async readFile(p) { return inner.readFile(p); },
    async writeFile(p, data) { stats.writes += 1; await inner.writeFile(p, data); },
    async mkdir(p) { stats.mkdirs += 1; await inner.mkdir(p); },
    async readdir(p) { return inner.readdir(p); },
    async isDir(p) { return inner.isDir(p); },
    async exists(p) { return inner.exists(p); },
    async remove(p) { await inner.remove(p); },
  };
  return { fsx, stats };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/* ---------------- ⑥ resolveDeviceIdentity ---------------- */

test('⑥ 设备身份：首次调用生成 UUID + 主机名并落盘；第二次调用零写入', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-device-id-'));
  try {
    const { fsx, stats } = countingFs();

    const first = await resolveDeviceIdentity(tmp, '  workstation-a  ', fsx);
    assert.match(first.id, UUID_RE, 'deviceId 必须是随机 UUID');
    assert.equal(first.name, 'workstation-a', 'deviceName 取主机名（两端空白去掉）');
    assert.ok(stats.writes >= 1, '首次必须落盘');

    // 读回一致（走真实 fs + loadSyncState）
    const onDisk = JSON.parse(await fs.readFile(path.join(tmp, SYNC_STATE_FILE), 'utf8')) as Record<string, unknown>;
    assert.equal(onDisk['deviceId'], first.id);
    assert.equal(onDisk['deviceName'], 'workstation-a');
    const loaded = await loadSyncState(tmp);
    assert.equal(loaded.deviceId, first.id);
    assert.equal(loaded.deviceName, first.name);

    // 第二次：已有 id/name → 纯读
    stats.writes = 0;
    stats.mkdirs = 0;
    const second = await resolveDeviceIdentity(tmp, 'workstation-a', fsx);
    assert.equal(second.id, first.id, '同一台设备必须复用 deviceId');
    assert.equal(second.name, 'workstation-a');
    assert.equal(stats.writes, 0, '第二次调用绝不写盘');
    assert.equal(stats.mkdirs, 0, '第二次调用连目录都不建');

    // 换主机名也不变（deviceId 是稳定标识）
    const renamed = await resolveDeviceIdentity(tmp, 'renamed-host', fsx);
    assert.equal(renamed.id, first.id);
    assert.equal(renamed.name, 'workstation-a', '已记录的 deviceName 不被改写');
    assert.equal(stats.writes, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('⑥ 设备身份：主机名为空串 → deviceName 落到字典兜底文案（绝不写空串）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-device-fallback-'));
  try {
    const { fsx } = countingFs();
    const r = await resolveDeviceIdentity(tmp, '   ', fsx);

    assert.equal(r.name, zhMsg('sync.deviceNameFallback'));
    assert.equal(r.name, '未命名设备', 'zh 字典兜底文案');
    assert.ok(r.name.trim() !== '', 'deviceName 不得为空/纯空白');

    const persisted = await loadSyncState(tmp);
    assert.equal(persisted.deviceId, r.id);
    assert.equal(persisted.deviceName, r.name, '兜底文案必须一并落盘（否则下次仍要重算）');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('⑥ 设备身份：文件里已有 deviceId 但缺 deviceName → 纯读，磁盘逐字节不变', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-device-legacy-'));
  try {
    await saveSyncState(tmp, {
      schemaVersion: SYNC_STATE_SCHEMA_VERSION,
      lastSyncAt: '',
      sections: {},
      lastSnapshotId: '',
      ancestorId: '',
      deviceId: 'existing-device-id-123',
    });
    const before = await fs.readFile(path.join(tmp, SYNC_STATE_FILE), 'utf8');

    const { fsx, stats } = countingFs();
    const r = await resolveDeviceIdentity(tmp, 'host-x', fsx);

    assert.equal(r.id, 'existing-device-id-123', '已有 id 必须原样复用');
    assert.equal(r.name, 'host-x', '缺 name 时按主机名解析');
    assert.equal(stats.writes, 0, '已有 id ⇒ 绝不补写');
    assert.equal(await fs.readFile(path.join(tmp, SYNC_STATE_FILE), 'utf8'), before, '磁盘逐字节不变');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

/* ---------------- 引擎：manifest 设备身份 + probe ---------------- */

class MemTransport implements SyncTransport {
  readonly type = 'memory';
  snapshots = new Map<string, SyncSnapshot>();
  metas: SyncSnapshotMeta[] = [];
  calls: string[] = [];

  async list(): Promise<SyncSnapshotMeta[]> {
    this.calls.push('list');
    return [...this.metas].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  async upload(snapshot: SyncSnapshot): Promise<SyncSnapshotMeta> {
    this.calls.push('upload');
    this.snapshots.set(snapshot.id, snapshot);
    this.metas = this.metas.filter((m) => m.id !== snapshot.id);
    this.metas.push(computeSnapshotMeta(snapshot));
    return computeSnapshotMeta(snapshot);
  }

  async download(id: string): Promise<SyncSnapshot> {
    this.calls.push('download');
    const snap = this.snapshots.get(id);
    if (snap === undefined) throw new Error('missing snapshot: ' + id);
    return snap;
  }

  async delete(id: string): Promise<void> {
    this.calls.push('delete');
    this.snapshots.delete(id);
    this.metas = this.metas.filter((m) => m.id !== id);
  }
}

function seedSettings(ctx: ReturnType<typeof makeContext>): void {
  ctx.settings.ns.set('general', { value: { theme: 'dark', language: 'zh-CN' }, revision: 1, secrets: [] });
}

function makeEngine(opts: {
  ctx: ReturnType<typeof makeContext>;
  transport: SyncTransport;
  stateDir: string;
}): SyncEngine {
  const adapters = createAdapters({ namespaces: ['general', 'theme'] });
  const importer = new Importer({ ctx: opts.ctx, adapters, snapshotStore: new MemSnapshotStore() });
  return new SyncEngine({
    ctx: opts.ctx,
    transport: opts.transport,
    stateDir: opts.stateDir,
    adapters,
    importer,
    now: () => new Date('2026-10-18T12:00:00.000Z'),
  } as ConstructorParameters<typeof SyncEngine>[0]);
}

test('⑥ push：快照 manifest 带 deviceId/deviceName，与 sync-state 落盘值一致且跨 push 稳定', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-engine-device-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSettings(ctx);
    const transport = new MemTransport();
    const engine = makeEngine({ ctx, transport, stateDir: tmp });

    const report = await engine.push({ snapshotId: 'sync-dev-1' });
    assert.equal(report.ok, true, 'push 必须成功：' + JSON.stringify(report.warnings));

    const uploaded = transport.snapshots.get('sync-dev-1');
    assert.ok(uploaded !== undefined, '快照已上传');
    const deviceId = uploaded.manifest.deviceId;
    const deviceName = uploaded.manifest.deviceName;
    assert.ok(typeof deviceId === 'string' && UUID_RE.test(deviceId), 'manifest.deviceId 必须是 UUID，实际=' + String(deviceId));
    assert.ok(typeof deviceName === 'string' && deviceName.trim() !== '', 'manifest.deviceName 必须非空');

    const expectedName = os.hostname().trim() !== '' ? os.hostname().trim() : zhMsg('sync.deviceNameFallback');
    assert.equal(deviceName, expectedName, 'deviceName = 本机主机名（取不到才是兜底文案）');

    const state = await loadSyncState(tmp);
    assert.equal(state.deviceId, deviceId, 'manifest 的 deviceId 必须就是同步身份落盘值');
    assert.equal(state.deviceName, deviceName);

    await engine.push({ snapshotId: 'sync-dev-2' });
    const second = transport.snapshots.get('sync-dev-2');
    assert.ok(second !== undefined);
    assert.equal(second.manifest.deviceId, deviceId, '同一台设备连续 push 的 deviceId 必须稳定');
    assert.equal(second.manifest.deviceName, deviceName);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('② engine.probe()：通道没实现 probe → 抛 sync.probeUnsupported，绝不谎报连接正常', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-engine-probe-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSettings(ctx);
    const transport = new MemTransport();
    assert.equal(typeof (transport as { probe?: unknown }).probe, 'undefined', '本用例前提：该通道没有 probe');
    const engine = makeEngine({ ctx, transport, stateDir: tmp });

    await assert.rejects(
      () => engine.probe(),
      (err: unknown) => {
        assert.ok(err instanceof SyncTransportError);
        assert.equal(err.kind, 'client');
        assert.equal(err.retryable, false);
        assert.equal(err.message, zhMsg('sync.probeUnsupported'));
        assert.equal(err.message, '当前同步通道不支持连通性自检');
        return true;
      },
    );
    assert.deepEqual(transport.calls, [], '不支持 probe 时不得退化成任何通道调用');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('② engine.probe()：通道实现了 probe → 原样透出（this 绑定在通道实例上）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-engine-probe-ok-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    seedSettings(ctx);
    const transport = new (class extends MemTransport {
      probeCalls = 0;
      async probe() {
        this.probeCalls += 1;
        return { message: 'ok:' + this.type, snapshotCount: 7 };
      }
    })();
    const engine = makeEngine({ ctx, transport, stateDir: tmp });

    const result = await engine.probe();
    assert.deepEqual(result, { message: 'ok:memory', snapshotCount: 7 });
    assert.equal(transport.probeCalls, 1);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
