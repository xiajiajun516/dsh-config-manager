/**
 * m-git-channel：Git 私有仓库通道测试（TDD：先红后绿）。
 * - mock exec 单元测试：命令序列 / token 不泄漏（argv、commit message、错误消息、credential 文件生命周期）
 * - 真实 git 集成测试：本地 bare repo 模拟远端（无真实网络），端到端 list/upload/download/delete
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

import { GitTransport, GitTransportError } from './git-transport.ts';
import type { GitExecFn, GitExecResult, GitTransportOptions } from './git-transport.ts';
import { encryptSectionsPayload } from '../snapshot-crypto.ts';
import { computeSnapshotMeta, isEncryptedSections } from '../transport.ts';
import type { SyncSnapshot } from '../transport.ts';
import type { FilesSection, SectionData, SectionId } from '../../schema/types.ts';

/* ---------------- helpers ---------------- */

const TEST_TOKEN = 'secret-token-xyz-123';

function sampleSnapshot(overrides: Partial<SyncSnapshot> = {}): SyncSnapshot & { sections: Record<string, unknown> } {
  return {
    id: 'snap-001',
    createdAt: '2026-08-16T12:00:00.000Z',
    manifest: {
      schemaVersion: 1,
      dshVersion: '1.2.3',
      platform: 'win32',
      sectionIds: ['settings', 'providers'],
      containsSecrets: false,
    },
    sections: {
      settings: { version: 1, namespaces: { general: { value: { theme: 'dark' }, revision: 1, secrets: [] } } },
      providers: { version: 1, providers: { deepseek: { route: '/v1' } } },
    },
    ...overrides,
  } as SyncSnapshot & { sections: Record<string, unknown> };
}

/** 记录每次 git 调用的 mock exec：默认全部成功；按需特判 */
interface CallRecord { cmd: string; args: string[]; }
function mockExec(
  calls: CallRecord[],
  rules: {
    /** args.join(' ') 包含该子串时返回 code（用于 rev-parse/diff/ls-remote 特判） */
    codeBy?: Record<string, number>;
    /** 模拟失败：返回 code + stderr（可含 token 变体，验证 sanitize） */
    failOn?: { match: string; code: number; stderr: string };
  } = {},
): GitExecFn {
  return async (_cmd, args): Promise<GitExecResult> => {
    calls.push({ cmd: 'git', args });
    const joined = args.join(' ');
    if (rules.failOn && joined.includes(rules.failOn.match)) {
      return { stdout: '', stderr: rules.failOn.stderr, code: rules.failOn.code };
    }
    for (const [sub, code] of Object.entries(rules.codeBy ?? {})) {
      if (joined.includes(sub)) return { stdout: '', stderr: '', code };
    }
    // 默认：diff --cached --quiet = 有变更（code 1）；其余成功
    if (joined.includes('diff') && joined.includes('--quiet')) return { stdout: '', stderr: '', code: 1 };
    return { stdout: '', stderr: '', code: 0 };
  };
}

async function makeTempDir(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-git-test-'));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  return dir;
}

/** 真实 git：初始化一个非空 git 工作树（.git 存在，使 ensureRepo 走已 clone 分支） */
async function makeGitWorkDir(t: test.TestContext): Promise<string> {
  const dir = await makeTempDir(t);
  await runRealGit(['init'], dir);
  await runRealGit(['config', 'user.name', 'test'], dir);
  await runRealGit(['config', 'user.email', 'test@local'], dir);
  return dir;
}

function runRealGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = err as { code?: number };
        resolve({ stdout: String(stdout), stderr: String(stderr), code: e.code ?? 1 });
      } else {
        resolve({ stdout: String(stdout), stderr: String(stderr), code: 0 });
      }
    });
  });
}

/** 本地 bare 仓库（模拟远端，无认证需求） */
async function makeBareRepo(t: test.TestContext): Promise<string> {
  const dir = await makeTempDir(t);
  const bare = path.join(dir, 'remote.git');
  const r = await runRealGit(['init', '--bare', bare], dir);
  assert.equal(r.code, 0, `git init --bare 失败: ${r.stderr}`);
  return bare;
}

function makeOptions(overrides: Partial<GitTransportOptions> = {}): GitTransportOptions {
  return {
    repoUrl: 'https://github.com/example/private-config.git',
    workDir: 'UNSET',
    credentials: { getToken: async () => TEST_TOKEN },
    ...overrides,
  };
}

function joinedArgs(calls: CallRecord[], needle: string): string[] {
  return calls.filter((c) => c.args.join(' ').includes(needle)).map((c) => c.args.join(' '));
}

/** 构造加密快照（sections 为 EncryptedSections 密文载荷；含文件分区以覆盖字节往返）。 */
async function encryptedSnapshot(overrides: Partial<SyncSnapshot> = {}): Promise<SyncSnapshot> {
  const base = sampleSnapshot();
  const plain: Partial<Record<SectionId, SectionData>> = {};
  for (const [id, data] of Object.entries(base.sections)) {
    plain[id as SectionId] = data as SectionData;
  }
  plain.skills = {
    version: 1,
    files: [
      { relativePath: 'coding.md', data: new Uint8Array(Buffer.from('# Coding\n', 'utf8')), contentHash: 'h1' },
    ],
  } as FilesSection;
  const enc = await encryptSectionsPayload(plain, 'pw-12345678');
  return {
    ...base,
    id: 'snap-enc',
    manifest: { ...base.manifest, sectionIds: ['settings', 'providers', 'skills'], encrypted: true, containsSecrets: true },
    sections: enc,
    ...overrides,
  };
}

/* ---------------- 单元测试（mock exec） ---------------- */

test('非 git 仓库：workDir 非空且无 .git → 报错清晰（含 workDir 路径）', async (t) => {
  const dir = await makeTempDir(t);
  await fs.writeFile(path.join(dir, 'stray.txt'), 'not a repo');
  const calls: CallRecord[] = [];
  const transport = new GitTransport(makeOptions({ workDir: dir, exec: mockExec(calls) }));
  await assert.rejects(
    transport.list(),
    (err: unknown) => {
      assert.ok(err instanceof GitTransportError, '必须是 GitTransportError');
      assert.match(err.message, /不是 git 仓库/);
      assert.ok(err.message.includes(dir), '错误消息应含 workDir 路径');
      return true;
    },
  );
});

test('首次使用（空目录无 .git）→ 触发 clone（credential helper 注入，argv 不含 token）', async (t) => {
  const dir = await makeTempDir(t); // 空目录
  const calls: CallRecord[] = [];
  const transport = new GitTransport(makeOptions({ workDir: dir, exec: mockExec(calls) }));
  await transport.list();
  const clones = joinedArgs(calls, 'clone');
  assert.equal(clones.length, 1, '应恰好调用一次 clone');
  const cloneArgs = calls.find((c) => c.args.includes('clone'))!.args;
  // credential helper 注入到 clone 参数
  assert.ok(cloneArgs.some((a) => a.startsWith('credential.helper=') && a.includes('store --file=')), 'clone 应带 store credential helper');
  // argv 不含 token
  for (const arg of cloneArgs) assert.ok(!arg.includes(TEST_TOKEN), `argv 泄漏 token: ${arg}`);
  // clone 的 URL 参数不带 token
  const urlArg = cloneArgs[cloneArgs.indexOf('clone') + 1]!;
  assert.ok(!urlArg.includes(TEST_TOKEN), 'clone URL 不得含 token');
  assert.ok(!urlArg.includes('oauth2:'), 'clone URL 不得含内嵌凭据');
});

test('token 不泄漏：credential 文件在 git 调用期间存在、用后删除、内容含 token 但 argv 不含', async (t) => {
  const dir = await makeTempDir(t);
  const calls: CallRecord[] = [];
  const credFileContents: string[] = [];
  const exec: GitExecFn = async (_cmd, args) => {
    calls.push({ cmd: 'git', args });
    const helper = args.find((a) => a.startsWith('credential.helper=') && a.includes('store --file='));
    if (helper) {
      const file = helper.slice(helper.indexOf('--file=') + '--file='.length).replace(/^"|"$/g, '');
      credFileContents.push(await fs.readFile(file, 'utf8'));
    }
    return { stdout: '', stderr: '', code: 0 };
  };
  const transport = new GitTransport(makeOptions({ workDir: dir, exec }));
  await transport.list(); // 触发 clone（带 credential）
  // credential 文件在调用期间存在（被读到内容）
  assert.ok(credFileContents.length >= 1, 'credential 文件应被创建并被 git 调用读取');
  assert.ok(credFileContents.some((c) => c.includes(TEST_TOKEN)), 'credential 文件应含 token');
  // 调用后无残留：credential 临时目录已删除（找不到任何含 token 的文件）
  const tmpRoot = path.join(os.tmpdir());
  const leftovers = (await fs.readdir(tmpRoot)).filter((n) => n.startsWith('dsh-git-cred-'));
  for (const n of leftovers) {
    const p = path.join(tmpRoot, n);
    try {
      const stat = await fs.stat(p);
      if (stat.isDirectory()) {
        const files = await fs.readdir(p);
        assert.equal(files.length, 0, `credential 临时目录应有残留: ${n}`);
      }
    } catch { /* 已删除 */ }
  }
  // argv 不含 token
  for (const c of calls) for (const arg of c.args) assert.ok(!arg.includes(TEST_TOKEN), `argv 泄漏 token: ${arg}`);
});

test('upload 契约：写快照目录 + add + commit(add) + push，返回 computeSnapshotMeta', async (t) => {
  const dir = await makeGitWorkDir(t);
  const calls: CallRecord[] = [];
  const transport = new GitTransport(makeOptions({ workDir: dir, exec: mockExec(calls) }));
  const snap = sampleSnapshot();
  const meta = await transport.upload(snap);
  assert.deepEqual(meta, computeSnapshotMeta(snap));
  // 命令序列：add snapshots/<id> → diff --cached --quiet → commit -m add → push
  const adds = joinedArgs(calls, 'add');
  assert.ok(adds.some((a) => a.includes('snapshots/snap-001')), `应 add 快照目录: ${JSON.stringify(adds)}`);
  assert.equal(joinedArgs(calls, 'diff --cached --quiet').length, 1);
  const commits = joinedArgs(calls, 'commit');
  assert.equal(commits.length, 1);
  assert.match(commits[0]!, /-m sync: add snapshot snap-001/);
  assert.equal(joinedArgs(calls, 'push').length, 1, 'upload 应 push');
  // commit message 不含 token
  for (const c of commits) assert.ok(!c.includes(TEST_TOKEN));
});

test('upload 幂等：工作树内容与 HEAD 一致 → 不 commit 不 push，仍返回 meta', async (t) => {
  const dir = await makeGitWorkDir(t);
  const calls: CallRecord[] = [];
  const transport = new GitTransport(makeOptions({
    workDir: dir,
    exec: mockExec(calls, { codeBy: { 'diff --cached --quiet': 0 } }),
  }));
  const meta = await transport.upload(sampleSnapshot());
  assert.equal(meta.id, 'snap-001');
  assert.equal(joinedArgs(calls, 'commit').length, 0, '无变更不得 commit');
  assert.equal(joinedArgs(calls, 'push').length, 0, '无变更不得 push');
});

test('upload 覆盖：同 id 再次上传 → commit message 为 update', async (t) => {
  const dir = await makeGitWorkDir(t);
  const calls: CallRecord[] = [];
  const transport = new GitTransport(makeOptions({ workDir: dir, exec: mockExec(calls) }));
  await transport.upload(sampleSnapshot());
  calls.length = 0; // 清空，模拟第二次 upload（同 id 覆盖）
  await transport.upload(sampleSnapshot({ createdAt: '2026-08-16T13:00:00.000Z' }));
  const commits = joinedArgs(calls, 'commit');
  assert.equal(commits.length, 1);
  assert.match(commits[0]!, /-m sync: update snapshot snap-001/);
});

test('download 契约：不存在的 id → 抛错（消息含 id）', async (t) => {
  const dir = await makeGitWorkDir(t);
  const calls: CallRecord[] = [];
  const transport = new GitTransport(makeOptions({ workDir: dir, exec: mockExec(calls) }));
  await assert.rejects(
    transport.download('missing-001'),
    (err: unknown) => {
      assert.ok(err instanceof GitTransportError);
      assert.match(err.message, /missing-001/);
      assert.match(err.message, /不存在/);
      return true;
    },
  );
});

test('delete 契约：存在 → 删除目录 + add -A + commit(delete) + push；不存在 → 静默成功', async (t) => {
  const dir = await makeGitWorkDir(t);
  const calls: CallRecord[] = [];
  const transport = new GitTransport(makeOptions({ workDir: dir, exec: mockExec(calls) }));
  // 准备一个已存在快照目录
  await fs.mkdir(path.join(dir, 'snapshots', 'snap-001'), { recursive: true });
  await fs.writeFile(path.join(dir, 'snapshots', 'snap-001', 'manifest.json'), '{}');
  await transport.delete('snap-001');
  const adds = joinedArgs(calls, 'add -A');
  assert.ok(adds.some((a) => a.includes('snapshots/snap-001')), 'delete 应 stage 删除');
  assert.equal(joinedArgs(calls, 'commit').length, 1);
  assert.match(joinedArgs(calls, 'commit')[0]!, /-m sync: delete snapshot snap-001/);
  assert.equal(joinedArgs(calls, 'push').length, 1);
  // 不存在 → 成功且不产生 git 写操作
  calls.length = 0;
  await transport.delete('never-existed');
  assert.equal(joinedArgs(calls, 'commit').length, 0);
  assert.equal(joinedArgs(calls, 'push').length, 0);
});

test('错误消息 sanitize：git 失败 stderr 含 token → 抛出消息被替换为 [REDACTED]', async (t) => {
  const dir = await makeGitWorkDir(t);
  const calls: CallRecord[] = [];
  const transport = new GitTransport(makeOptions({
    workDir: dir,
    exec: mockExec(calls, {
      failOn: { match: 'push', code: 128, stderr: `fatal: unable to access 'https://oauth2:${TEST_TOKEN}@github.com/example/private-config.git/': authentication failed` },
    }),
  }));
  await assert.rejects(
    transport.upload(sampleSnapshot()),
    (err: unknown) => {
      assert.ok(err instanceof GitTransportError);
      assert.ok(!err.message.includes(TEST_TOKEN), `错误消息泄漏 token: ${err.message}`);
      assert.match(err.message, /\[REDACTED\]/);
      return true;
    },
  );
});

test('checkIsPrivate：匿名可达 → false；匿名失败+认证可达 → true；都失败 → 抛错', async (t) => {
  // 匿名成功
  const c1: CallRecord[] = [];
  const t1 = new GitTransport(makeOptions({ workDir: await makeTempDir(t), exec: mockExec(c1) }));
  assert.equal(await t1.checkIsPrivate(), false);
  assert.equal(t1.isPrivateHint, false);

  // 匿名失败（404），带 credential 成功
  const c2: CallRecord[] = [];
  const exec2: GitExecFn = async (_cmd, args) => {
    c2.push({ cmd: 'git', args });
    if (args.join(' ').includes('ls-remote')) {
      const authed = args.some((a) => a.includes('credential.helper='));
      return authed
        ? { stdout: '', stderr: '', code: 0 }
        : { stdout: '', stderr: 'fatal: could not read Username', code: 128 };
    }
    return { stdout: '', stderr: '', code: 0 };
  };
  const t2 = new GitTransport(makeOptions({ workDir: await makeTempDir(t), exec: exec2 }));
  assert.equal(await t2.checkIsPrivate(), true);
  assert.equal(t2.isPrivateHint, true);
  // 第二次调用走缓存，不重复探测
  const lsBefore = joinedArgs(c2, 'ls-remote').length;
  await t2.checkIsPrivate();
  assert.equal(joinedArgs(c2, 'ls-remote').length, lsBefore);

  // 匿名与认证都失败
  const c3: CallRecord[] = [];
  const t3 = new GitTransport(makeOptions({
    workDir: await makeTempDir(t),
    exec: mockExec(c3, { codeBy: { 'ls-remote': 128 }, failOn: { match: 'credential.helper=', code: 128, stderr: 'fatal: could not read Username' } }),
  }));
  await assert.rejects(t3.checkIsPrivate(), /不可达|认证失败/);
});

test('快照 id 安全：非法 id（路径穿越/特殊字符）→ upload/download/delete 均拒绝', async (t) => {
  const dir = await makeGitWorkDir(t);
  const calls: CallRecord[] = [];
  const transport = new GitTransport(makeOptions({ workDir: dir, exec: mockExec(calls) }));
  for (const bad of ['../evil', 'a/b', 'a\\b', '.', '..', 'snap\ninject']) {
    await assert.rejects(transport.upload(sampleSnapshot({ id: bad })), /非法快照 id/);
    await assert.rejects(transport.download(bad), /非法快照 id/);
    await assert.rejects(transport.delete(bad), /非法快照 id/);
  }
});

test('upload 加密快照：写 snapshots-encrypted/<id>.json 密文单文件（不落散文件目录），add/commit/push', async (t) => {
  const dir = await makeGitWorkDir(t);
  const calls: CallRecord[] = [];
  const transport = new GitTransport(makeOptions({ workDir: dir, exec: mockExec(calls) }));
  const snap = await encryptedSnapshot();
  assert.ok(isEncryptedSections(snap.sections), '前置：加密载荷');
  const meta = await transport.upload(snap);
  assert.deepEqual(meta, computeSnapshotMeta(snap));
  // 密文单文件已写入工作副本
  const encFile = path.join(dir, 'snapshots-encrypted', 'snap-enc.json');
  const raw = JSON.parse(await fs.readFile(encFile, 'utf8'));
  assert.equal(raw.id, 'snap-enc');
  assert.ok(isEncryptedSections(raw.sections), '远端文件保持加密载荷（不含明文）');
  assert.ok(!JSON.stringify(raw).includes('# Coding'), '序列化不得泄漏明文文件内容');
  // 散文件目录不产生
  assert.equal(await fs.stat(path.join(dir, 'snapshots', 'snap-enc')).catch(() => null), null, '加密快照不写散文件目录');
  // git 命令：add snapshots-encrypted/<id>.json
  const adds = joinedArgs(calls, 'add');
  assert.ok(adds.some((a) => a.includes('snapshots-encrypted/snap-enc.json')), `应 add 密文文件: ${JSON.stringify(adds)}`);
  const commits = joinedArgs(calls, 'commit');
  assert.equal(commits.length, 1);
  assert.match(commits[0]!, /-m sync: add snapshot snap-enc/);
  assert.equal(joinedArgs(calls, 'push').length, 1);
});

test('upload 加密快照覆盖：同 id 明文→加密 切换时清掉旧散文件目录（双形态互斥）', async (t) => {
  const dir = await makeGitWorkDir(t);
  const calls: CallRecord[] = [];
  const transport = new GitTransport(makeOptions({ workDir: dir, exec: mockExec(calls) }));
  // 先传明文（snap-enc 走散文件目录）
  await transport.upload(sampleSnapshot({ id: 'snap-enc' }));
  assert.ok(await fs.stat(path.join(dir, 'snapshots', 'snap-enc')));
  calls.length = 0;
  // 同 id 再传加密 → 旧散文件目录被清除，只留密文单文件
  await transport.upload(await encryptedSnapshot());
  assert.equal(await fs.stat(path.join(dir, 'snapshots', 'snap-enc')).catch(() => null), null, '旧明文散文件目录已删');
  assert.ok(await fs.stat(path.join(dir, 'snapshots-encrypted', 'snap-enc.json')));
  const commits = joinedArgs(calls, 'commit');
  assert.match(commits[0]!, /-m sync: update snapshot snap-enc/, '形态切换视为 update');
});

test('download 加密快照：读回密文单文件并还原（sections 保持密文载荷）', async (t) => {
  const dir = await makeGitWorkDir(t);
  const calls: CallRecord[] = [];
  const transport = new GitTransport(makeOptions({ workDir: dir, exec: mockExec(calls) }));
  const snap = await encryptedSnapshot();
  await transport.upload(snap);
  const roundtrip = await transport.download('snap-enc');
  assert.equal(roundtrip.id, 'snap-enc');
  assert.deepEqual(roundtrip.manifest, snap.manifest);
  assert.deepEqual(roundtrip.sections, snap.sections, '加密载荷逐字节一致（解密后文件字节应无损）');
});

test('delete 加密快照：从 snapshots-encrypted 移除 + commit(delete) + push', async (t) => {
  const dir = await makeGitWorkDir(t);
  const calls: CallRecord[] = [];
  const transport = new GitTransport(makeOptions({ workDir: dir, exec: mockExec(calls) }));
  await transport.upload(await encryptedSnapshot());
  calls.length = 0;
  await transport.delete('snap-enc');
  const adds = joinedArgs(calls, 'add -A');
  assert.ok(adds.some((a) => a.includes('snapshots-encrypted/snap-enc.json')), 'delete 应 stage 密文文件删除');
  assert.equal(joinedArgs(calls, 'commit').length, 1);
  assert.match(joinedArgs(calls, 'commit')[0]!, /-m sync: delete snapshot snap-enc/);
  // 不存在 → 静默成功
  await transport.delete('snap-enc');
  assert.equal(joinedArgs(calls, 'commit').length, 1, '再次删除不产生 commit');
});

/* ---------------- 集成测试（真实 git，本地 bare repo） ---------------- */

test('集成：upload → list → download → delete 端到端（真实 git + 本地 bare repo）', async (t) => {
  const bare = await makeBareRepo(t);
  const workDir = await makeTempDir(t);
  let tokenReads = 0;
  const transport = new GitTransport({
    repoUrl: bare,
    workDir,
    credentials: { getToken: async () => { tokenReads += 1; return TEST_TOKEN; } },
  });

  // upload
  const snap = sampleSnapshot();
  const meta = await transport.upload(snap);
  assert.equal(meta.id, 'snap-001');
  // 快照散文件目录落在工作副本
  const manifestAbs = path.join(workDir, 'snapshots', 'snap-001', 'manifest.json');
  const manifestRaw = JSON.parse(await fs.readFile(manifestAbs, 'utf8'));
  assert.equal(manifestRaw.id, 'snap-001');
  assert.equal(manifestRaw.createdAt, snap.createdAt);
  // 分区文件落盘
  assert.ok(await fs.stat(path.join(workDir, 'snapshots', 'snap-001', 'config', 'settings.json')));

  // 提交已 push 到远端 bare repo
  const log = await runRealGit(['log', '--oneline', '--all'], bare);
  assert.equal(log.code, 0, `git log 失败: ${log.stderr}`);
  assert.match(log.stdout, /sync: add snapshot snap-001/);

  // list：远端 + 工作副本 → 1 条，createdAt 升序
  const listed = await transport.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.id, 'snap-001');
  assert.equal(listed[0]!.createdAt, snap.createdAt);
  assert.deepEqual(listed[0]!.manifest, snap.manifest);

  // download：读回完整载荷，与上传一致
  const roundtrip = await transport.download('snap-001');
  assert.deepEqual(roundtrip, snap);

  // 覆盖：同 id 上传新内容 → update commit，目录唯一
  const snap2 = sampleSnapshot({ createdAt: '2026-08-16T14:00:00.000Z' });
  snap2.sections.settings = { version: 1, namespaces: { general: { value: { theme: 'light' }, revision: 2, secrets: [] } } };
  await transport.upload(snap2);
  const dirs = await fs.readdir(path.join(workDir, 'snapshots'));
  assert.deepEqual(dirs, ['snap-001']);
  const log2 = await runRealGit(['log', '--oneline', '--all'], bare);
  assert.match(log2.stdout, /sync: update snapshot snap-001/);
  const roundtrip2 = await transport.download('snap-001');
  assert.deepEqual(roundtrip2, snap2);

  // delete：存在 → 移除；再 delete 不存在 id → 静默成功
  await transport.delete('snap-001');
  assert.equal((await transport.list()).length, 0);
  const log3 = await runRealGit(['log', '--oneline', '--all'], bare);
  assert.match(log3.stdout, /sync: delete snapshot snap-001/);
  await transport.delete('snap-001'); // 不存在视为成功
  await assert.rejects(transport.download('snap-001'), /不存在/);

  // 本地路径仓库不触发认证读取（token 提供者不被调用）
  assert.equal(tokenReads, 0, '本地仓库无需 token，getToken 不应被调用');
});

test('集成：同内容重复 upload → 第二次不产生新 commit（git 天然增量，内容无变化不提交）', async (t) => {
  const bare = await makeBareRepo(t);
  const workDir = await makeTempDir(t);
  const transport = new GitTransport({ repoUrl: bare, workDir, credentials: { getToken: async () => TEST_TOKEN } });

  await transport.upload(sampleSnapshot());
  let log = await runRealGit(['log', '--oneline', '--all'], bare);
  assert.equal(log.code, 0, `git log 失败: ${log.stderr}`);
  assert.equal(log.stdout.trim().split('\n').filter(Boolean).length, 1, '首次上传应恰好 1 个 commit');

  // 同 id 同内容（快照完全一致）重复上传 → diff --cached --quiet 无变更 → 不 commit 不 push
  await transport.upload(sampleSnapshot());
  log = await runRealGit(['log', '--oneline', '--all'], bare);
  assert.equal(log.stdout.trim().split('\n').filter(Boolean).length, 1, '内容无变化 → 不得产生新 commit');
  const listed = await transport.list();
  assert.equal(listed.length, 1, '远端仍只有 1 条快照（同 id 覆盖语义）');
});

test('集成：token 不泄漏到快照文件内容与 commit message（真实 git 全链路）', async (t) => {
  const bare = await makeBareRepo(t);
  const workDir = await makeTempDir(t);
  const transport = new GitTransport({
    repoUrl: bare,
    workDir,
    credentials: { getToken: async () => TEST_TOKEN },
  });
  await transport.upload(sampleSnapshot());
  // 工作副本 snapshots 下所有文件内容不得含 token
  const files: string[] = [];
  const walk = async (p: string): Promise<void> => {
    for (const name of await fs.readdir(p)) {
      const full = path.join(p, name);
      const stat = await fs.stat(full);
      if (stat.isDirectory()) await walk(full);
      else files.push(full);
    }
  };
  await walk(path.join(workDir, 'snapshots'));
  for (const f of files) {
    const content = await fs.readFile(f, 'utf8');
    assert.ok(!content.includes(TEST_TOKEN), `文件内容泄漏 token: ${f}`);
  }
  // commit message 不含 token
  const log = await runRealGit(['log', '--format=%s', '--all'], bare);
  assert.ok(!log.stdout.includes(TEST_TOKEN), `commit message 泄漏 token: ${log.stdout}`);
  // 工作副本根目录无 credential 残留文件
  const rootEntries = await fs.readdir(workDir);
  assert.ok(!rootEntries.some((n) => n.includes('cred') || n.includes('dsh-git-cred')), `credential 残留: ${rootEntries.join(', ')}`);
});

test('集成：非 git 仓库报错清晰（真实 git 验证消息）', async (t) => {
  const workDir = await makeTempDir(t);
  await fs.writeFile(path.join(workDir, 'placeholder.txt'), 'x');
  const transport = new GitTransport({
    repoUrl: 'https://github.com/example/private-config.git',
    workDir,
    credentials: { getToken: async () => TEST_TOKEN },
  });
  await assert.rejects(
    transport.list(),
    (err: unknown) => {
      assert.ok(err instanceof GitTransportError);
      assert.match(err.message, /不是 git 仓库/);
      return true;
    },
  );
});

test('集成：list 按 createdAt 升序（真实 git 多快照）', async (t) => {
  const bare = await makeBareRepo(t);
  const workDir = await makeTempDir(t);
  const transport = new GitTransport({ repoUrl: bare, workDir, credentials: { getToken: async () => TEST_TOKEN } });
  await transport.upload(sampleSnapshot({ id: 'snap-b', createdAt: '2026-08-16T11:00:00.000Z' }));
  await transport.upload(sampleSnapshot({ id: 'snap-a', createdAt: '2026-08-16T09:00:00.000Z' }));
  await transport.upload(sampleSnapshot({ id: 'snap-c', createdAt: '2026-08-16T12:00:00.000Z' }));
  const listed = await transport.list();
  assert.deepEqual(listed.map((m) => m.id), ['snap-a', 'snap-b', 'snap-c']);
});

test('集成：加密快照端到端（真实 git + 本地 bare repo）—— upload → list → download → delete', async (t) => {
  const bare = await makeBareRepo(t);
  const workDir = await makeTempDir(t);
  const transport = new GitTransport({ repoUrl: bare, workDir, credentials: { getToken: async () => TEST_TOKEN } });
  const snap = await encryptedSnapshot();

  // upload：密文单文件提交并推送
  const meta = await transport.upload(snap);
  assert.equal(meta.id, 'snap-enc');
  assert.equal(meta.manifest.encrypted, true);
  assert.deepEqual(meta.sections, {}, '加密快照的 sections hash 记录为空（密文不可与本地明文比较）');
  const log = await runRealGit(['log', '--oneline', '--all'], bare);
  assert.equal(log.code, 0, `git log 失败: ${log.stderr}`);
  assert.match(log.stdout, /sync: add snapshot snap-enc/);

  // list：密文快照可见（工作副本 pull 后重建）
  const listed = await transport.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.id, 'snap-enc');
  assert.equal(listed[0]!.manifest.encrypted, true);
  assert.deepEqual(listed[0]!.manifest, snap.manifest);

  // download：读回密文载荷（明文内容不可见）
  const roundtrip = await transport.download('snap-enc');
  assert.ok(isEncryptedSections(roundtrip.sections), '下载返回加密载荷');
  assert.deepEqual(roundtrip.sections, snap.sections);
  assert.ok(!JSON.stringify(roundtrip).includes('# Coding'), '载荷序列化不得泄漏明文');

  // 明文 + 加密快照共存于 list（按 createdAt 升序）
  await transport.upload(sampleSnapshot({ id: 'snap-plain', createdAt: '2026-08-16T09:00:00.000Z' }));
  const mixed = await transport.list();
  assert.deepEqual(mixed.map((m) => m.id), ['snap-plain', 'snap-enc']);

  // delete 加密快照
  await transport.delete('snap-enc');
  assert.deepEqual((await transport.list()).map((m) => m.id), ['snap-plain']);
  await assert.rejects(transport.download('snap-enc'), /不存在/);
  await transport.delete('snap-enc'); // 不存在视为成功
});

// ─── t5：远端快照裁剪的 git 契约（upload 先 push，再 delete 删旧，各自独立 commit+push） ───

test('集成：裁剪删除旧快照 → 每次 delete 独立 commit+push，add 提交先于 delete 提交', async (t) => {
  const bare = await makeBareRepo(t);
  const workDir = await makeTempDir(t);
  const transport = new GitTransport({ repoUrl: bare, workDir, credentials: { getToken: async () => TEST_TOKEN } });

  // 模拟裁剪场景：先上传多个快照（adds），随后逐个 delete 旧的
  for (let i = 1; i <= 4; i++) {
    await transport.upload(sampleSnapshot({ id: `snap-0${i}`, createdAt: `2026-08-16T0${i}:00:00.000Z` }));
  }
  // delete 3 个旧的，保留最新 1 个
  await transport.delete('snap-01');
  await transport.delete('snap-02');
  await transport.delete('snap-03');

  // list 只反映保留的快照
  const listed = await transport.list();
  assert.deepEqual(listed.map((m) => m.id), ['snap-04'], '裁剪后远端只保留最新快照');

  // git 提交历史：先 add 后 delete（顺序正确，新快照先推再删旧）
  const log = await runRealGit(['log', '--oneline', '--all'], bare);
  assert.equal(log.code, 0, `git log 失败: ${log.stderr}`);
  const addIdx = log.stdout.indexOf('sync: add snapshot snap-04');
  const delIdx = log.stdout.indexOf('sync: delete snapshot snap-01');
  assert.ok(addIdx >= 0, 'add 提交应存在');
  assert.ok(delIdx >= 0, 'delete 提交应存在');
  // git log 默认按最新提交在前；delete 是较新的提交，应出现在 add 之前（add 更旧在列表更靠后）
  assert.ok(delIdx < addIdx, 'delete 提交应晚于（在 log 中靠前于）add 提交 → 先推新再删旧');

  // 每个 delete 独立 commit+push
  const delCount = (log.stdout.match(/sync: delete snapshot snap-0/g) ?? []).length;
  assert.equal(delCount, 3, '每个被删快照对应一次独立 delete 提交');

  // 已删除快照目录从工作副本移除
  const dirs = await fs.readdir(path.join(workDir, 'snapshots'));
  assert.deepEqual(dirs, ['snap-04']);
});
