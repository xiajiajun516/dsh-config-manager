/**
 * dsh 来源回归（路径真值 × 代次过滤 × **逐字节直通** × 端到端）。
 *
 * 取证：`measured` —— 本机 ~/.dsh/sessions 实测（501 个日志的「文件名 ↔ 首帧 version」逐条对应：
 * session.jsonl.zstd=0 / .v3=3 / .v4=4）。测试用**真实 zstd 多帧容器**做夹具。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FOREIGN_TRUTH_TABLES, TRUTH_PROBE_ENV, TRUTH_PROBES } from './truth-table.ts';
import { normalizePlatform, roamingAppDataDir, xdgDataHome } from './platform-paths.ts';
import type { ForeignPlatform } from './platform-paths.ts';
import type { RootProbeOptions } from './session-source.ts';
import type { ForeignSourceContext } from './registry.ts';

const BS = String.fromCharCode(92);
const NL = String.fromCharCode(10);
const PLATFORMS: readonly ForeignPlatform[] = ['win32', 'darwin', 'linux'];
const HOST: ForeignPlatform = normalizePlatform(process.platform);

async function tmpRoot(tag: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-' + tag + '-'));
}

async function writeAt(root: string, rel: string, text: string): Promise<void> {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, text);
}

function truthProbePaths(id: string, opts: RootProbeOptions): string[] {
  const entry = FOREIGN_TRUTH_TABLES.find((e) => e.id === id);
  assert.ok(entry !== undefined, '真值表缺少 ' + id);
  const platform = normalizePlatform(opts.platform);
  const appdata = roamingAppDataDir(platform, opts.homeDir, opts.env);
  const xdgdata = xdgDataHome(platform, opts.homeDir, opts.env);
  return entry.defaults[platform].map((template) => template
    .split('<home>').join(opts.homeDir)
    .split('<appdata>').join(appdata)
    .split('<xdgdata>').join(xdgdata));
}

function normalize(p: string): string {
  return p.split(BS).join('/');
}

function assertTruthPaths(id: string, probePaths: (opts: RootProbeOptions) => readonly string[]): void {
  for (const platform of PLATFORMS) {
    const probe = TRUTH_PROBES[platform];
    const opts: RootProbeOptions = { homeDir: probe.homeDir, env: TRUTH_PROBE_ENV, platform };
    assert.deepEqual(
      probePaths(opts).map(normalize),
      truthProbePaths(id, opts).map(normalize),
      id + ' × ' + platform + ' 的 probePaths 与真值表不一致',
    );
  }
}

function ctxOf(homeDir: string, platform: ForeignPlatform, env: Record<string, string | undefined> = {}, version = 3, projectDir?: string): ForeignSourceContext {
  return {
    homeDir,
    env,
    platform,
    targetSessionFormatVersion: version,
    ...(projectDir !== undefined ? { projectDir } : {}),
  };
}

import { dshSource, transcodeDshLog } from './dsh.ts';
import {
  dshGenerationOfVersion, dshHeaderOfLogBytes, dshProbePaths, dshSessionsRoot, dshVersionOfLogName, readDshLogs,
} from './read-dsh.ts';
import type { DshSessionLogFile } from './read-dsh.ts';
import { encodeZstdFrame, zstdAvailable } from '../utils/zstd-frame.ts';
import { projectKeyOf } from '../core/session-select.ts';

function logBytes(header: Record<string, unknown>, rows: readonly Record<string, unknown>[]): Uint8Array {
  const frames: Buffer[] = [encodeZstdFrame(Buffer.from(JSON.stringify(header) + NL))];
  for (const row of rows) frames.push(encodeZstdFrame(Buffer.from(JSON.stringify(row) + NL)));
  return Buffer.concat(frames);
}

function headerOf(id: string, cwd: string, version: number): Record<string, unknown> {
  return { type: 'session', version, id, createdAt: 1700000000000, cwd, isSeeded: false, delegationDepth: 0 };
}

test('dsh t1 路径真值：单根 <DSH_HOME|~/.dsh>/sessions；DSH_HOME 是替换语义', () => {
  assertTruthPaths('dsh', dshProbePaths);
  assert.deepEqual(dshProbePaths({ homeDir: '/home/u', env: {}, platform: 'linux' }), ['/home/u/.dsh/sessions']);
  assert.deepEqual(dshProbePaths({ homeDir: '/home/u', env: { DSH_HOME: '/opt/dsh' }, platform: 'linux' }), ['/opt/dsh/sessions']);
  assert.equal(dshSessionsRoot({ homeDir: 'C:/u', env: {}, platform: 'win32' }), ['C:/u', '.dsh', 'sessions'].join(BS));
});

test('dsh t2 文件名/版本/代次判据：v0 无后缀、v1-3 → v3 族、v4 → v4、decoded 不匹配', () => {
  assert.equal(dshVersionOfLogName('session.jsonl.zstd'), 0);
  assert.equal(dshVersionOfLogName('session.v3.jsonl.zstd'), 3);
  assert.equal(dshVersionOfLogName('session.v4.jsonl'), 4);
  assert.equal(dshVersionOfLogName('session.jsonl.decoded.jsonl'), undefined, '解码产物不是会话日志');
  assert.equal(dshVersionOfLogName('other.v3.jsonl.zstd'), undefined);
  assert.equal(dshGenerationOfVersion(0), 'v3');
  assert.equal(dshGenerationOfVersion(3), 'v3');
  assert.equal(dshGenerationOfVersion(4), 'v4');
  assert.equal(dshGenerationOfVersion(5), undefined, '未知代次绝不猜');
  assert.equal(dshGenerationOfVersion(undefined), undefined);
});

test('dsh t3 首帧 header：zstd 多帧容器里解出 id/cwd/version', (t) => {
  if (!zstdAvailable()) {
    t.skip('本宿主 Node 无 zstd');
    return;
  }
  const bytes = logBytes(headerOf('sess-a', '/home/u/proj', 3), [{ seq: 0, type: 'turn/start' }]);
  const header = dshHeaderOfLogBytes(bytes);
  assert.equal(header?.id, 'sess-a');
  assert.equal(header?.cwd, '/home/u/proj');
  assert.equal(header?.version, 3);
});

test('dsh t4 扫描：按首帧版本过滤代次（v4 只计数、不进 skip）；decoded 文件被忽略', async (t) => {
  if (!zstdAvailable()) {
    t.skip('本宿主 Node 无 zstd');
    return;
  }
  const root = await tmpRoot('dsh');
  try {
    const base = path.join('.dsh', 'sessions', '--home-u-proj--', 'sess-a');
    await fs.mkdir(path.join(root, base), { recursive: true });
    await fs.writeFile(path.join(root, base, 'session.v3.jsonl.zstd'), logBytes(headerOf('sess-a', '/home/u/proj', 3), [{ seq: 0 }]));
    const v0 = path.join('.dsh', 'sessions', '--home-u-proj--', 'sess-zero');
    await fs.mkdir(path.join(root, v0), { recursive: true });
    await fs.writeFile(path.join(root, v0, 'session.jsonl.zstd'), logBytes(headerOf('sess-zero', '/home/u/proj', 0), [{ seq: 0 }]));
    const v4 = path.join('.dsh', 'sessions', '--home-u-proj--', 'sess-b');
    await fs.mkdir(path.join(root, v4), { recursive: true });
    await fs.writeFile(path.join(root, v4, 'session.v4.jsonl.zstd'), logBytes(headerOf('sess-b', '/home/u/proj', 4), [{ seq: 0 }]));
    await writeAt(root, path.join(base, 'session.jsonl.decoded.jsonl'), '{"type":"session"}' + NL);

    const read = await readDshLogs({ homeDir: root, env: {}, platform: HOST, generation: 'v3' });
    assert.deepEqual(read.files.map((f) => f.id), ['sess-a', 'sess-zero']);
    assert.equal(read.extraCounts?.['dsh.logs.otherGeneration'], 1, 'v4 属于另一来源的域：只计数不报错');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('dsh t4b 同一 id 出现在两个会话目录：保留第一个但必须报 session-id-conflict', async (t) => {
  if (!zstdAvailable()) {
    t.skip('本宿主 Node 无 zstd');
    return;
  }
  const root = await tmpRoot('dsh-dup');
  try {
    for (const projectKey of ['--p-a--', '--p-b--']) {
      const dir = path.join('.dsh', 'sessions', projectKey, 'dup-id');
      await fs.mkdir(path.join(root, dir), { recursive: true });
      await fs.writeFile(path.join(root, dir, 'session.v3.jsonl.zstd'), logBytes(headerOf('dup-id', '/p/' + projectKey, 3), [{ seq: 0 }]));
    }
    const read = await readDshLogs({ homeDir: root, env: {}, platform: HOST, generation: 'v3' });
    assert.equal(read.files.length, 1, '同 id 只保留第一个（绝不后写覆盖先写）');
    const conflict = (read.readFindings ?? []).find((s) => s.code === 'session-id-conflict');
    assert.ok(conflict !== undefined, '丢弃必须留码：' + JSON.stringify(read.readFindings));
    assert.equal(conflict.origin, 'dup-id');
    assert.equal(read.extraCounts?.['dsh.logs.scanned'], 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('dsh t5 直通判定顺序：版本未知 → id 非法 → 版本不等 → cwd 缺失 → 通过', () => {
  const good: DshSessionLogFile = { id: 'sess-a', cwd: '/home/u/proj', version: 3, name: 'session.v3.jsonl.zstd', data: new Uint8Array([1]) };
  assert.equal(transcodeDshLog(good, undefined).skip?.code, 'session-format-version-unknown');
  assert.equal(transcodeDshLog({ ...good, id: 'bad id' }, 3).skip?.code, 'session-unsafe-id');
  assert.equal(transcodeDshLog(good, 4).skip?.code, 'session-format-unsupported', '目标机版本不同必须如实跳过');
  assert.equal(transcodeDshLog({ ...good, cwd: '' }, 3).skip?.code, 'session-missing-cwd');
  const ok = transcodeDshLog(good, 3);
  assert.equal(ok.session?.relativePath, projectKeyOf('/home/u/proj') + '/sess-a/session.v3.jsonl.zstd');
  assert.equal(ok.session?.cwd, '/home/u/proj');
});

test('dsh t6 端到端：字节直通（逐字节相同）+ workspaces 连带 + 目标版本不同则整批跳过', async (t) => {
  if (!zstdAvailable()) {
    t.skip('本宿主 Node 无 zstd');
    return;
  }
  const root = await tmpRoot('dsh-build');
  try {
    const dir = path.join('.dsh', 'sessions', 'anything', 'sess-a');
    const bytes = logBytes(headerOf('sess-a', '/home/u/proj', 3), [{ seq: 0, type: 'turn/start' }]);
    await fs.mkdir(path.join(root, dir), { recursive: true });
    await fs.writeFile(path.join(root, dir, 'session.v3.jsonl.zstd'), bytes);

    const result = await dshSource.build(ctxOf(root, HOST, {}, 3));
    assert.equal(dshSource.evidence, 'measured', '真值表把 dsh 标为 measured（本机实测过根与代次对应）');
    assert.equal(result.counts['sessions.files'], 1);
    assert.equal(result.counts['workspaces.records'], 1);
    const sessions = result.sections.find((s) => s.sectionId === 'sessions');
    const file = sessions?.files?.[0];
    assert.ok(file !== undefined && file.data !== undefined);
    assert.equal(Buffer.compare(Buffer.from(file.data), Buffer.from(bytes)), 0, '逐字节直通：一个字节都不许变');
    assert.equal(file.relativePath, projectKeyOf('/home/u/proj') + '/sess-a/session.v3.jsonl.zstd');

    const mismatched = await dshSource.build(ctxOf(root, HOST, {}, 4));
    assert.deepEqual(mismatched.sections, [], '日志版本 != 目标机版本 → 不产出会话（DSH 会拒收）');
    assert.equal(mismatched.skipped.some((s) => s.code === 'session-format-unsupported'), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('dsh t7 detect：单根探测 + DSH_HOME 覆盖可见', async () => {
  const root = await tmpRoot('dsh-detect');
  try {
    assert.equal((await dshSource.detect(ctxOf(root, HOST))).found, false);
    const over = await dshSource.detect(ctxOf(root, HOST, { DSH_HOME: '/opt/dsh' }));
    assert.equal(over.skipped?.some((s) => s.code === 'source-location-overridden' && s.origin === 'DSH_HOME'), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
