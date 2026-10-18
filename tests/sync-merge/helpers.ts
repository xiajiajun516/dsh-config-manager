/**
 * tests/sync-merge：独立对抗性测试夹具（真实引擎 + 内存传输，零依赖）。
 *
 * 设计原则（本目录是**独立验证者**，不接受「队友说做完了」作为证据）：
 *  - 用**真实** SyncEngine / merge() / Importer / adapter，不用被测方自己写的 mock 顶替；
 *  - 传输层用内存 fake（可注入失败），断言**实际文件内容 / sync-state.json 原文 / 恢复结果**；
 *  - 每个夹具用独立临时目录，互不污染；测试结束清理。
 *
 * 本文件不是 *.test.ts，"node --test tests/sync-merge/" 不会把它当用例执行。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { SyncEngine } from '../../src/sync/sync-engine.ts';
import type { SyncEngineOptions } from '../../src/sync/sync-engine.ts';
import { computeSnapshotMeta, SyncTransportError } from '../../src/sync/transport.ts';
import type { SyncSnapshot, SyncSnapshotMeta, SyncTransport } from '../../src/sync/transport.ts';
import type { SectionData, SectionId } from '../../src/schema/types.ts';
import type { ConfigAdapter } from '../../src/core/types.ts';
import { createAdapters } from '../../src/adapters/index.ts';
import type { LocalPluginPackHook } from '../../src/adapters/index.ts';
import { makeContext, MemSnapshotStore } from '../../src/adapters/test-helpers.ts';
import type { MockHostContext } from '../../src/adapters/test-helpers.ts';
import { Importer } from '../../src/core/importer.ts';

/** 测试用的 settings 命名空间（与既有同步测试同一组）。 */
export const NS: readonly string[] = ['general', 'theme'];

/** 内存传输：记录调用顺序、可注入失败；upload 会真正保存快照（供 download/断言）。 */
export class FakeTransport implements SyncTransport {
  readonly type: string;
  snapshots = new Map<string, SyncSnapshot>();
  metas: SyncSnapshotMeta[] = [];
  calls: string[] = [];
  /** 按方法排队的失败（一次调用消耗一个）——用于模拟超时/鉴权/写失败/中途失败。 */
  private failures = new Map<string, SyncTransportError[]>();

  constructor(type = 'memory') {
    this.type = type;
  }

  /** 让下一次 method 调用抛 err（可排队多次，按调用顺序消耗）。 */
  failNext(method: 'list' | 'upload' | 'download' | 'delete', err: SyncTransportError): void {
    const q = this.failures.get(method) ?? [];
    q.push(err);
    this.failures.set(method, q);
  }

  private take(method: string): void {
    const q = this.failures.get(method);
    if (q !== undefined && q.length > 0) throw q.shift()!;
  }

  count(method: string): number {
    return this.calls.filter((c) => c === method).length;
  }

  async list(): Promise<SyncSnapshotMeta[]> {
    this.calls.push('list');
    this.take('list');
    return [...this.metas].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  async upload(snapshot: SyncSnapshot): Promise<SyncSnapshotMeta> {
    this.calls.push('upload');
    this.take('upload');
    this.snapshots.set(snapshot.id, snapshot);
    const meta = computeSnapshotMeta(snapshot);
    // 同 id 重复 upload = 覆盖（SyncTransport 契约）：元数据替换，不重复入列
    const idx = this.metas.findIndex((m) => m.id === snapshot.id);
    if (idx >= 0) this.metas[idx] = meta;
    else this.metas.push(meta);
    return meta;
  }

  async download(id: string): Promise<SyncSnapshot> {
    this.calls.push('download');
    this.take('download');
    const s = this.snapshots.get(id);
    if (s === undefined) throw new Error('快照不存在: ' + id);
    return s;
  }

  async delete(id: string): Promise<void> {
    this.calls.push('delete');
    this.take('delete');
    this.snapshots.delete(id);
    this.metas = this.metas.filter((m) => m.id !== id);
  }
}

/** 设备（一台机器 = 独立 ctx + 独立 stateDir + 独立祖先副本目录 + 同一远端传输）。 */
export interface Device {
  ctx: MockHostContext;
  transport: FakeTransport;
  stateDir: string;
  localSnapshotsDir: string;
  adapters: ConfigAdapter[];
  importer: Importer;
  engine: SyncEngine;
  /** 供「重新构造引擎」用（例如模拟重启后重试） */
  makeEngine: (extra?: Partial<SyncEngineOptions>) => SyncEngine;
}

export interface DeviceOptions {
  /** 通道类型（git/webdav/memory）——通道一致性测试用 */
  transportType?: string;
  /** 固定时钟（确定性 createdAt） */
  clock?: () => Date;
  /** 快照 id 前缀（多设备共用同一远端时避免撞 id） */
  idPrefix?: string;
  /** 显式限定同步分区范围（缺省 = 全部 portable 推荐分区） */
  sections?: SectionId[];
  optInSections?: readonly SectionId[];
  /** 替换/追加 adapter（例如「snapshot 抛错」的故障注入包装） */
  adapters?: (base: ConfigAdapter[]) => ConfigAdapter[];
  localPluginPack?: LocalPluginPackHook;
  /** 覆盖构造参数（如 importer 替换为 mock） */
  extra?: Partial<SyncEngineOptions>;
}

/**
 * 创建一台「设备」：内存 ctx（同 win32 home）、真实 adapters/importer、独立临时目录。
 * 调用方负责在 finally 里 rm root。
 */
export async function createDevice(root: string, label: string, opts: DeviceOptions = {}): Promise<Device> {
  const clock = opts.clock ?? (() => new Date('2026-09-01T00:00:00.000Z'));
  const ctx = makeContext('win32', 'C:\\Users\\alice');
  let snapSeq = 0;
  const idPrefix = opts.idPrefix ?? label;
  const base = createAdapters({
    namespaces: [...NS],
    ...(opts.localPluginPack !== undefined ? { localPluginPack: opts.localPluginPack } : {}),
  });
  const adapters = opts.adapters !== undefined ? opts.adapters(base) : base;
  const stateDir = path.join(root, 'state-' + label);
  const localSnapshotsDir = path.join(root, 'ancestors-' + label);
  await fs.mkdir(stateDir, { recursive: true });
  const transport = new FakeTransport(opts.transportType ?? 'memory');
  const importer = new Importer({ ctx, adapters, snapshotStore: new MemSnapshotStore() });

  const makeEngine = (extra?: Partial<SyncEngineOptions>): SyncEngine => new SyncEngine({
    ctx,
    transport,
    stateDir,
    localSnapshotsDir,
    adapters,
    importer,
    now: clock,
    snapshotId: () => idPrefix + '-' + String(++snapSeq),
    sections: opts.sections,
    optInSections: opts.optInSections,
    ...opts.extra,
    ...extra,
  } as SyncEngineOptions);

  return { ctx, transport, stateDir, localSnapshotsDir, adapters, importer, engine: makeEngine(), makeEngine };
}

/** 多设备共享同一远端（同一 FakeTransport 实例）。 */
export async function createSharedDevices(
  root: string,
  labels: readonly string[],
  opts: DeviceOptions = {},
): Promise<{ transport: FakeTransport; devices: Record<string, Device> }> {
  const transport = new FakeTransport(opts.transportType ?? 'memory');
  const devices: Record<string, Device> = {};
  for (const label of labels) {
    const d = await createDevice(root, label, opts);
    d.transport = transport;
    d.engine = d.makeEngine({ transport });
    devices[label] = d;
  }
  return { transport, devices };
}

/** 读 sync-state.json 原文（不存在 → null）。用于「基线逐字节未变」断言。 */
export async function readStateText(device: Device): Promise<string | null> {
  try {
    return await fs.readFile(path.join(device.stateDir, 'sync-state.json'), 'utf8');
  } catch {
    return null;
  }
}

/** 读 sync-state.json 解析结果（不存在 → null）。 */
export async function readStateJson(device: Device): Promise<Record<string, unknown> | null> {
  const text = await readStateText(device);
  return text === null ? null : (JSON.parse(text) as Record<string, unknown>);
}

/** 造一份 settings 分区（按给定命名空间值）——与 src/sync/merge.test.ts 同构。 */
export function settingsSection(ns: Record<string, unknown>): SectionData {
  return {
    version: 1,
    namespaces: Object.fromEntries(
      Object.entries(ns).map(([k, v], i) => [k, { value: v, revision: i + 1, secrets: [] }]),
    ),
  } as unknown as SectionData;
}

/** 文件类分区（skills 等）——路径 → UTF-8 内容。 */
export function filesSection(entries: Array<[string, string]>): SectionData {
  return {
    version: 1,
    files: entries.map(([relativePath, text]) => ({
      relativePath,
      data: new TextEncoder().encode(text),
      contentHash: '',
    })),
  } as unknown as SectionData;
}

/** 取 FilesSection 的「路径 → 文本」映射（断言实际内容用）。 */
export function fileTexts(section: SectionData): Map<string, string> {
  const files = (section as unknown as { files: Array<{ relativePath: string; data: Uint8Array }> }).files;
  return new Map(files.map((f) => [f.relativePath, new TextDecoder().decode(f.data)]));
}

/** 读本机 skills 文件（MemFs）。不存在 → null。 */
export async function readSkill(device: Device, rel: string): Promise<string | null> {
  try {
    return Buffer.from(await device.ctx.fs.readFile(path.join('skills', rel))).toString('utf8');
  } catch {
    return null;
  }
}

/** 写本机 skills 文件（MemFs）。 */
export async function writeSkill(device: Device, rel: string, text: string): Promise<void> {
  await device.ctx.fs.writeFile(path.join('skills', rel), Buffer.from(text, 'utf8'));
}

/** 删除本机 skills 文件（MemFs）。 */
export async function removeSkill(device: Device, rel: string): Promise<void> {
  await device.ctx.fs.remove(path.join('skills', rel));
}

/** 设置本机 settings 命名空间值（模拟用户在界面上改了配置）。 */
export function setNamespace(device: Device, ns: string, value: unknown, revision = 2): void {
  device.ctx.settings.ns.set(ns, { value, revision, secrets: [] });
}

/** 取本机 settings 命名空间值。 */
export function getNamespace(device: Device, ns: string): unknown {
  return device.ctx.settings.ns.get(ns)?.value;
}

/** 造一个传输层错误（带 kind）——测试用。 */
export function transportError(
  kind: 'timeout' | 'network' | 'server' | 'auth' | 'conflict' | 'protocol',
  message = 'fake transport failure',
): SyncTransportError {
  return new SyncTransportError(message, { kind });
}

/** 稳定的临时根目录：测试 finally 里 rm(root, {recursive:true,force:true})。 */
export async function makeRoot(tag: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-sync-merge-' + tag + '-'));
}

/** 外部造快照（模拟「另一台设备」/损坏载荷）；id 由调用方指定。 */
export function makeSnapshot(
  id: string,
  sections: Partial<Record<SectionId, SectionData>>,
  createdAt = '2026-09-01T00:00:00.000Z',
): SyncSnapshot {
  return {
    id,
    createdAt,
    manifest: {
      schemaVersion: 1,
      dshVersion: '0.1.0-rc.6',
      platform: 'win32',
      sectionIds: Object.keys(sections) as SectionId[],
      containsSecrets: false,
    },
    sections,
  };
}

/** 把外部快照塞进远端（不经过 push，便于构造损坏/恶意载荷）。 */
export async function seedRemote(transport: FakeTransport, snapshot: SyncSnapshot): Promise<void> {
  await transport.upload(snapshot);
}

/** 断言文本不含某个密码（安全负例用；失败信息不回显密码值本身）。 */
export function assertNoSecret(text: string, secret: string, label: string): void {
  if (text.includes(secret)) throw new Error(label + ' 泄露了测试密码字面量');
}

/** 生成一个可辨认的测试密码（非真实凭据）。 */
export function testPassword(): string {
  return 'test-pass-' + crypto.randomBytes(4).toString('hex');
}
