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
import { computeSnapshotMeta, DEFAULT_SYNC_TIMEOUT_MS, isEncryptedSections, SyncTransportError } from '../transport.ts';
import type { SyncSnapshot } from '../transport.ts';
import type { FilesSection, SectionData, SectionId } from '../../schema/types.ts';
import { sha256Hex } from '../../utils/hashing.ts';

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

test('issue #103：credential.username 必须与 store 文件里的用户名一致（全局 .gitconfig 不得顶掉查找键）', async (t) => {
  // git credential store 以 URL 里的 username 为查找键；只写 store 文件不钉 username 时，
  // 全局 .gitconfig 的 credential.<url>.username（GCM / gh 写入）会把键换成别的用户名 →
  // 查不到口令 → 无 tty 环境直接 fatal。这里把「pin 的值 === store 文件里的用户名」钉成不变量。
  for (const username of [undefined, 'x-access-token']) {
    const dir = await makeTempDir(t);
    const seen: { args: string[]; fileRaw: string }[] = [];
    const exec: GitExecFn = async (_cmd, args) => {
      const helper = args.find((a) => a.startsWith('credential.helper=') && a.includes('store --file='));
      if (helper) {
        const file = helper.slice(helper.indexOf('--file=') + '--file='.length).replace(/^"|"$/g, '');
        seen.push({ args, fileRaw: await fs.readFile(file, 'utf8') });
      }
      return { stdout: '', stderr: '', code: 0 };
    };
    const transport = new GitTransport(makeOptions({
      workDir: dir,
      exec,
      ...(username === undefined ? {} : { credentialUsername: username }),
    }));
    await transport.list();
    assert.ok(seen.length >= 1, '必须发生过带凭据的调用');
    const expected = username ?? 'oauth2';
    for (const call of seen) {
      const pin = call.args.find((a) => a.startsWith('credential.username='));
      assert.equal(pin, `credential.username=${expected}`, '必须把 username 钉进 git 参数（缺省 oauth2，可用 credentialUsername 覆盖）');
      const idx = call.args.indexOf(pin as string);
      assert.equal(call.args[idx - 1], '-c', 'git 只认 `-c key=value` 形态，-c 必须紧邻');
      assert.ok(call.fileRaw.startsWith(`https://${expected}:`), 'store 文件里的用户名必须与 pin 的值同源');
    }
  }
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
  assert.equal(joinedArgs(calls, 'push -u').length, 1, 'upload 应 push');
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
  assert.equal(joinedArgs(calls, 'push -u').length, 0, '无变更不得 push');
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
  assert.equal(joinedArgs(calls, 'push -u').length, 1);
  // 不存在 → 成功且不产生 git 写操作
  calls.length = 0;
  await transport.delete('never-existed');
  assert.equal(joinedArgs(calls, 'commit').length, 0);
  assert.equal(joinedArgs(calls, 'push -u').length, 0);
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

test('推送预检：http(s) 远端 + 空令牌 → 发起 git 之前给出可操作错误（不写空口令凭据）', async (t) => {
  const dir = await makeGitWorkDir(t);
  const calls: CallRecord[] = [];
  const transport = new GitTransport(makeOptions({
    workDir: dir,
    // 真机形态：没配令牌（拉取公开仓库可匿名成功，推送必失败）
    credentials: { getToken: async () => '' },
    exec: mockExec(calls),
  }));
  await assert.rejects(
    transport.upload(sampleSnapshot()),
    (err: unknown) => {
      assert.ok(err instanceof GitTransportError, '必须是 GitTransportError');
      assert.equal(err.kind, 'auth');
      assert.equal(err.retryable, false);
      assert.match(err.message, /访问令牌/, '必须说清「没配令牌」，而不是把 git 的原文丢给用户');
      assert.match(err.message, /通道配置/, '必须给出可操作入口');
      return true;
    },
  );
  assert.equal(joinedArgs(calls, 'push -u').length, 0, '空令牌必须在发起 push 之前拦下');
  // 空令牌不得注入 credential helper —— `https://oauth2:@host` 会被远端回成
  // 「Invalid username or token」（指向令牌错误，而真实原因是「没配令牌」）
  for (const c of calls) {
    assert.ok(!c.args.some((a) => a.includes('credential.helper=')), '空令牌不得注入 credential helper');
  }
});

test('推送鉴权失败（GitHub 文案）→ 分类 auth + 可操作提示，且不泄漏 token', async (t) => {
  const dir = await makeGitWorkDir(t);
  const calls: CallRecord[] = [];
  const transport = new GitTransport(makeOptions({
    workDir: dir,
    exec: mockExec(calls, {
      failOn: {
        match: 'push',
        code: 128,
        stderr: "remote: Invalid username or token. Password authentication is not supported for Git operations.\n"
          + `fatal: Authentication failed for 'https://oauth2:${TEST_TOKEN}@github.com/example/private-config.git/'`,
      },
    }),
  }));
  await assert.rejects(
    transport.upload(sampleSnapshot()),
    (err: unknown) => {
      assert.ok(err instanceof GitTransportError);
      assert.equal(err.kind, 'auth', 'GitHub 的「Invalid username or token」必须归类为鉴权失败');
      assert.equal(err.retryable, false);
      assert.match(err.message, /推送认证失败/);
      assert.match(err.message, /通道配置/);
      assert.ok(!err.message.includes(TEST_TOKEN), `错误消息泄漏 token: ${err.message}`);
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
  assert.equal(joinedArgs(calls, 'push -u').length, 1);
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

test('集成：空文件类分区（skills files:[]）upload 后，全新 clone 的 B 机 download 应读回空分区（git 不跟踪空目录）', async (t) => {
  const bare = await makeBareRepo(t);
  // 机器 A：上传含空 skills 分区（~/.dsh/skills 不存在 → files: []）的快照
  const workDirA = await makeTempDir(t);
  const transportA = new GitTransport({ repoUrl: bare, workDir: workDirA, credentials: { getToken: async () => TEST_TOKEN } });
  const snap = sampleSnapshot();
  snap.sections.skills = { version: 1, files: [] } as unknown as FilesSection;
  snap.manifest = { ...snap.manifest, sectionIds: ['settings', 'providers', 'skills'] };
  await transportA.upload(snap);

  // 机器 B：全新 workDir（重新 clone 远端），模拟另一台机器的首次拉取
  const workDirB = await makeTempDir(t);
  const transportB = new GitTransport({ repoUrl: bare, workDir: workDirB, credentials: { getToken: async () => TEST_TOKEN } });

  // 复现前提：git 不跟踪空目录 → B 端工作副本里不存在 custom/skills/ 目录
  const skillsAbsB = path.join(workDirB, 'snapshots', 'snap-001', 'custom', 'skills');
  const skillsStat = await fs.stat(skillsAbsB).catch(() => null);
  assert.equal(skillsStat, null, 'git 应不跟踪空目录：B 端工作副本不应存在 custom/skills/');

  // 修复后：download 应降级读回空分区，而不是抛「快照缺少文件分区目录」
  const roundtrip = await transportB.download('snap-001');
  const skills = (roundtrip.sections as Partial<Record<SectionId, SectionData>>)['skills'];
  assert.deepEqual(skills, { version: 1, files: [] });
  assert.deepEqual(roundtrip.manifest, snap.manifest);
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
/* ---------------- t24：统一错误面 / 超时口径 / 幂等读重试 ---------------- */

test('t24：超时口径统一——默认取共用 DEFAULT_SYNC_TIMEOUT_MS（不少于原 60000），可注入覆盖', async (t) => {
  const dir = await makeGitWorkDir(t);
  const seen: number[] = [];
  const def = new GitTransport(makeOptions({
    workDir: dir,
    exec: async (_cmd, _args, opts) => { seen.push(opts.timeoutMs ?? -1); return { stdout: '', stderr: '', code: 0 }; },
  }));
  await def.list();
  assert.ok(seen.length > 0, 'git 命令应带超时');
  assert.equal(seen[0], DEFAULT_SYNC_TIMEOUT_MS, 'git 通道默认超时 = 两条通道共用常量');
  assert.ok(DEFAULT_SYNC_TIMEOUT_MS >= 60_000, '统一不得收紧（原 git 60s / webdav 120s）');
  const custom: number[] = [];
  const customTransport = new GitTransport(makeOptions({
    workDir: dir,
    timeoutMs: 5000,
    exec: async (_cmd, _args, opts) => { custom.push(opts.timeoutMs ?? -1); return { stdout: '', stderr: '', code: 0 }; },
  }));
  await customTransport.list();
  assert.equal(custom[0], 5000, '宿主注入的 timeoutMs 必须生效');
});

/** 构造「rev-parse 恒成功（会走 pull）+ pull 按脚本返回」的 exec */
function pullScriptedExec(calls: CallRecord[], pullResults: GitExecResult[]): GitExecFn {
  let i = 0;
  return async (_cmd, args) => {
    calls.push({ cmd: 'git', args });
    const joined = args.join(' ');
    if (joined.includes('rev-parse')) return { stdout: 'sha', stderr: '', code: 0 };
    if (joined.includes('pull')) {
      const r = pullResults[Math.min(i, pullResults.length - 1)]!;
      i += 1;
      return r;
    }
    return { stdout: '', stderr: '', code: 0 };
  };
}

test('t24：幂等读（list）遇瞬时网络故障 → 指数退避重试后成功', async (t) => {
  const dir = await makeGitWorkDir(t);
  const calls: CallRecord[] = [];
  const exec = pullScriptedExec(calls, [
    { stdout: '', stderr: 'fatal: unable to access ...: Connection reset by peer', code: 128 },
    { stdout: '', stderr: '', code: 0 },
  ]);
  const transport = new GitTransport(makeOptions({
    workDir: dir, exec, retry: { attempts: 3, baseDelayMs: 1, sleep: async () => {} },
  }));
  assert.deepEqual(await transport.list(), [], '重试后应成功（空远端）');
  assert.equal(joinedArgs(calls, 'pull').length, 2, '第一次瞬时失败 → 重试一次即成功');
});

test('t24：重试耗尽后上抛带分类的错误（network / retryable=true），尝试次数 = attempts', async (t) => {
  const dir = await makeGitWorkDir(t);
  const calls: CallRecord[] = [];
  const exec = pullScriptedExec(calls, [{ stdout: '', stderr: 'fatal: Could not resolve host: github.com', code: 128 }]);
  const transport = new GitTransport(makeOptions({
    workDir: dir, exec, retry: { attempts: 3, baseDelayMs: 1, sleep: async () => {} },
  }));
  await assert.rejects(transport.list(), (err: unknown) => {
    assert.ok(err instanceof GitTransportError, '仍必须是 GitTransportError');
    assert.ok(err instanceof SyncTransportError, 'GitTransportError 必须继承统一基类（上层拿得到分类）');
    assert.equal(err.kind, 'network');
    assert.equal(err.retryable, true);
    return true;
  });
  assert.equal(joinedArgs(calls, 'pull').length, 3, 'attempts=3 → 恰好 3 次尝试');
});

test('t24：不可重试错误（仓库不存在 / 鉴权失败）→ 只尝试一次且分类正确', async (t) => {
  const dir = await makeGitWorkDir(t);
  const cases: Array<[string, string]> = [
    ['fatal: repository https://github.com/a/b.git not found', 'notfound'],
    ['fatal: Authentication failed for https://github.com/a/b.git', 'auth'],
  ];
  for (const [stderr, kind] of cases) {
    const calls: CallRecord[] = [];
    const exec = pullScriptedExec(calls, [{ stdout: '', stderr, code: 128 }]);
    const transport = new GitTransport(makeOptions({
      workDir: dir, exec, retry: { attempts: 5, baseDelayMs: 1, sleep: async () => {} },
    }));
    await assert.rejects(transport.list(), (err: unknown) => {
      assert.ok(err instanceof SyncTransportError);
      assert.equal(err.kind, kind, '分类: ' + stderr);
      assert.equal(err.retryable, false, '不可重试: ' + stderr);
      return true;
    });
    assert.equal(joinedArgs(calls, 'pull').length, 1, '不可重试错误不得重试: ' + stderr);
  }
});

test('t24：首次使用（空目录）clone 遇瞬时超时 → 重试后成功', async (t) => {
  const dir = await makeTempDir(t); // 空目录 → 走 clone
  let cloneCalls = 0;
  const exec: GitExecFn = async (_cmd, args) => {
    const joined = args.join(' ');
    if (joined.includes('clone')) {
      cloneCalls += 1;
      return cloneCalls === 1
        ? { stdout: '', stderr: 'fatal: unable to access ...: Connection timed out after 30000 ms', code: 128 }
        : { stdout: '', stderr: '', code: 0 };
    }
    if (joined.includes('rev-parse')) return { stdout: 'sha', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  };
  const transport = new GitTransport(makeOptions({
    workDir: dir, exec, retry: { attempts: 3, baseDelayMs: 1, sleep: async () => {} },
  }));
  assert.deepEqual(await transport.list(), []);
  assert.equal(cloneCalls, 2, 'clone 超时应重试一次');
});

test('t24：写操作（upload）绝不重试——push 失败即使分类可重试也只尝试一次', async (t) => {
  const dir = await makeGitWorkDir(t);
  const calls: CallRecord[] = [];
  const exec: GitExecFn = async (_cmd, args) => {
    calls.push({ cmd: 'git', args });
    const joined = args.join(' ');
    if (joined.includes('rev-parse')) return { stdout: 'sha', stderr: '', code: 0 };
    if (joined.includes('diff') && joined.includes('--quiet')) return { stdout: '', stderr: '', code: 1 };
    if (joined.includes('push -u')) return { stdout: '', stderr: 'remote: HTTP 503 Service Unavailable', code: 1 };
    return { stdout: '', stderr: '', code: 0 };
  };
  const transport = new GitTransport(makeOptions({
    workDir: dir, exec, retry: { attempts: 5, baseDelayMs: 1, sleep: async () => {} },
  }));
  await assert.rejects(transport.upload(sampleSnapshot()), (err: unknown) => {
    assert.ok(err instanceof SyncTransportError);
    assert.equal(err.kind, 'server', '503 → 分类为可重试的 server（分类对上层可见）');
    assert.equal(err.retryable, true);
    return true;
  });
  assert.equal(joinedArgs(calls, 'push -u').length, 1, 'push 有远端副作用 → 即使 attempts=5 也只尝试一次');
});
test('t24：退避为指数递增并受 maxDelayMs 上限（baseDelayMs=100、max=150 → 100、150）', async (t) => {
  const dir = await makeGitWorkDir(t);
  const calls: CallRecord[] = [];
  const exec = pullScriptedExec(calls, [{ stdout: '', stderr: 'fatal: Connection reset by peer', code: 128 }]);
  const delays: number[] = [];
  const transport = new GitTransport(makeOptions({
    workDir: dir,
    exec,
    retry: {
      attempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 150,
      sleep: async () => {},
      onRetry: (info) => { delays.push(info.delayMs); },
    },
  }));
  await assert.rejects(transport.list());
  assert.deepEqual(delays, [100, 150], '退避指数递增且被 maxDelayMs 截断');
});

/* ---------------- P1-4：内容寻址外置（sessions → blobs/） ---------------- */

test('P1-4 集成：sessions 外置到 blobs/（引用文件替代目录）+ 同内容零重写 + 读回无损 + GC 保护窗', async (t) => {
  const bare = await makeBareRepo(t);
  const workDir = await makeTempDir(t);
  const transport = new GitTransport({ repoUrl: bare, workDir, credentials: { getToken: async () => TEST_TOKEN } });

  const bytes = Buffer.from('SESSION-BYTES-' + 'y'.repeat(32), 'utf8');
  const hash = sha256Hex(bytes);
  const mk = (id: string): SyncSnapshot => sampleSnapshot({
    id,
    createdAt: '2026-08-16T12:00:00.000Z',
    manifest: { schemaVersion: 1, dshVersion: '1.2.3', platform: 'win32', sectionIds: ['sessions'], containsSecrets: false },
    sections: {
      sessions: {
        version: 1,
        files: [{ relativePath: '--p--/a/session.jsonl.zstd', data: new Uint8Array(bytes), contentHash: hash }],
      },
    },
  } as Partial<SyncSnapshot>);

  await transport.upload(mk('snap-blob-a'));
  const blobAbs = path.join(workDir, 'blobs', hash);
  assert.ok((await fs.stat(blobAbs)).isFile(), 'blob 落在跨快照共享的 blobs/');
  const snapDir = path.join(workDir, 'snapshots', 'snap-blob-a');
  assert.ok((await fs.stat(path.join(snapDir, 'sessions.blobs.json'))).isFile(), '快照内写引用文件');
  await assert.rejects(() => fs.stat(path.join(snapDir, 'sessions')), '外置分区不得再写 <prefix>/ 目录');

  // 同内容第二份快照 → put 幂等跳过，blob 文件一个字节都不重写
  const before = (await fs.stat(blobAbs)).mtimeMs;
  await new Promise((resolve) => { setTimeout(resolve, 25); });
  await transport.upload(mk('snap-blob-b'));
  assert.equal((await fs.stat(blobAbs)).mtimeMs, before, '内容未变 → 零重写（P1-4 核心收益）');

  // 读回：从 blob 仓回填字节（含 contentHash）
  const back = await transport.download('snap-blob-a');
  const files = (back.sections as Record<string, FilesSection>)['sessions']!.files;
  assert.equal(Buffer.from(files[0]!.data).toString('utf8'), bytes.toString('utf8'));
  assert.equal(files[0]!.contentHash, hash);

  // GC：两份快照都删掉后，blob 仍在（10 分钟保护窗 —— 防与并发 push 竞态）
  await transport.delete('snap-blob-a');
  await transport.delete('snap-blob-b');
  assert.ok((await fs.stat(blobAbs)).isFile(), '保护窗内的 blob 不删（并发安全阀）');
});


/* ---------------- issue #79：工作副本 origin 跟随 / 主机密钥 / 重建工作副本 ---------------- */

/** 只读探针型 exec：remote get-url 返回指定值（其余命令默认成功） */
function probeExec(calls: CallRecord[], origin: string | null, pushUrl?: string): GitExecFn {
  return async (_cmd, args): Promise<GitExecResult> => {
    calls.push({ cmd: 'git', args });
    const isPushProbe = args.includes('--push') && args.includes('get-url');
    if (args.includes('get-url')) {
      if (origin === null) return { stdout: '', stderr: 'error: No such remote', code: 2 };
      return { stdout: isPushProbe ? (pushUrl ?? origin) : origin, stderr: '', code: 0 };
    }
    if (args.includes('diff') && args.includes('--quiet')) return { stdout: '', stderr: '', code: 1 };
    return { stdout: '', stderr: '', code: 0 };
  };
}

test('issue #79：已有工作副本且 origin 与 repoUrl 不一致 → set-url（fetch + push 一并跟随）', async (t) => {
  const dir = await makeGitWorkDir(t);
  const calls: CallRecord[] = [];
  const target = 'ssh://git@new.example:2222/owner/repo.git';
  const transport = new GitTransport(makeOptions({
    repoUrl: target,
    workDir: dir,
    exec: probeExec(calls, 'ssh://git@old.example:2222/owner/repo.git'),
  }));
  await transport.list();
  assert.deepEqual(joinedArgs(calls, 'remote set-url'), [
    `remote set-url origin ${target}`,
    `remote set-url --push origin ${target}`,
  ], 'fetch 与 push 地址都必须跟随（否则推送仍走旧地址）');
});

test('issue #79：origin 已一致 → 一条写命令都不发（幂等，只有只读探针）', async (t) => {
  const dir = await makeGitWorkDir(t);
  const calls: CallRecord[] = [];
  const target = 'ssh://git@same.example:2222/owner/repo.git';
  const transport = new GitTransport(makeOptions({ repoUrl: target, workDir: dir, exec: probeExec(calls, target) }));
  await transport.list();
  assert.equal(joinedArgs(calls, 'remote set-url').length, 0, '地址一致不得改写');
  assert.equal(joinedArgs(calls, 'remote add').length, 0, '有 origin 不得重复 add');
});

test('issue #79：无 origin（读不出来）→ remote add origin，否则 push -u 永远失败', async (t) => {
  const dir = await makeGitWorkDir(t);
  const calls: CallRecord[] = [];
  const target = 'ssh://git@fresh.example:2222/owner/repo.git';
  const transport = new GitTransport(makeOptions({ repoUrl: target, workDir: dir, exec: probeExec(calls, null) }));
  await transport.list();
  assert.deepEqual(joinedArgs(calls, 'remote add origin'), [`remote add origin ${target}`]);
});

test('issue #79：origin 读得出但为空串 → 视为读不到，不改写（不拿不确定的读取覆盖配置）', async (t) => {
  const dir = await makeGitWorkDir(t);
  const calls: CallRecord[] = [];
  const transport = new GitTransport(makeOptions({
    repoUrl: 'ssh://git@x.example:2222/o/r.git',
    workDir: dir,
    exec: probeExec(calls, '', ''),
  }));
  await transport.list();
  assert.equal(joinedArgs(calls, 'remote set-url').length, 0);
});

test('issue #79：Host key verification failed → 可操作指纹指引（含 host，不自动信任）', async (t) => {
  const dir = await makeGitWorkDir(t);
  const calls: CallRecord[] = [];
  const repoUrl = 'ssh://git@nas.local:2222/owner/repo.git';
  const exec: GitExecFn = async (_cmd, args): Promise<GitExecResult> => {
    calls.push({ cmd: 'git', args });
    const joined = args.join(' ');
    if (joined.includes('remote get-url')) return { stdout: repoUrl, stderr: '', code: 0 };
    if (joined.includes('pull')) {
      return { stdout: '', stderr: 'Host key verification failed.\nfatal: Could not read from remote repository.', code: 128 };
    }
    return { stdout: 'sha', stderr: '', code: 0 };
  };
  const transport = new GitTransport(makeOptions({ repoUrl, workDir: dir, exec }));
  await assert.rejects(transport.list(), (err: unknown) => {
    assert.ok(err instanceof SyncTransportError, '必须是传输层错误');
    assert.match(err.message, /known_hosts/, '必须给可操作指引');
    assert.match(err.message, /nas\.local:2222/, '必须带上出问题的主机');
    assert.ok(!/Host key verification failed/.test(err.message), '不再原样透出 git 原文');
    assert.equal(err.retryable, false, '重试不会自愈');
    return true;
  });
});

test('issue #79 集成：改 repoUrl 后同一工作副本走新远端（历史相同、地址不同的同一仓库）', async (t) => {
  const bareA = await makeBareRepo(t);
  const workDir = await makeTempDir(t);
  const creds = { getToken: async () => TEST_TOKEN };
  const t1 = new GitTransport({ repoUrl: bareA, workDir, credentials: creds });
  await t1.upload(sampleSnapshot()); // A 收到 snap-001

  // 同一仓库的另一个可达地址（bare clone：历史相同、物理解耦，便于断言「真的写到了新地址」）
  const bareB = path.join(await makeTempDir(t), 'remote2.git');
  const cloned = await runRealGit(['clone', '--bare', bareA, bareB], workDir);
  assert.equal(cloned.code, 0, `clone --bare 失败: ${cloned.stderr}`);

  const t2 = new GitTransport({ repoUrl: bareB, workDir, credentials: creds });
  await t2.upload(sampleSnapshot({ id: 'snap-002' }));

  const logB = await runRealGit(['log', '--oneline', '--all'], bareB);
  assert.match(logB.stdout, /snap-002/, '新地址必须收到快照');
  const logA = await runRealGit(['log', '--oneline', '--all'], bareA);
  assert.ok(!logA.stdout.includes('snap-002'), '旧地址不得再收到（否则仍在用旧 origin）');
});

test('issue #79 集成：换成另一条历史的仓库 → 明确文案 + 指向重建工作副本（不是原始 stderr）', async (t) => {
  const bareA = await makeBareRepo(t);
  const workA = await makeTempDir(t);
  const creds = { getToken: async () => TEST_TOKEN };
  await new GitTransport({ repoUrl: bareA, workDir: workA, credentials: creds }).upload(sampleSnapshot());

  const bareC = await makeBareRepo(t);
  const workC = await makeTempDir(t);
  await new GitTransport({ repoUrl: bareC, workDir: workC, credentials: creds }).upload(sampleSnapshot({ id: 'other-001' }));

  const t2 = new GitTransport({ repoUrl: bareC, workDir: workA, credentials: creds });
  await assert.rejects(t2.list(), (err: unknown) => {
    assert.ok(err instanceof SyncTransportError);
    assert.match(err.message, /不是同一条历史/, '必须说清「换了仓库/历史被重写」');
    assert.match(err.message, /重建工作副本/, '必须给出出口');
    return true;
  });
});

test('issue #79 集成：inspectWorkDir + rebuildWorkDir（relink 非破坏 / reclone 重建 / 非仓库拒绝）', async (t) => {
  const bare = await makeBareRepo(t);
  const workDir = await makeTempDir(t);
  const creds = { getToken: async () => TEST_TOKEN };
  await new GitTransport({ repoUrl: bare, workDir, credentials: creds }).upload(sampleSnapshot());

  // 人为把 origin 改成旧地址（等价于「改 repoUrl 之前」的工作副本状态）
  const stray = await runRealGit(['remote', 'set-url', 'origin', 'ssh://git@old.example:2222/owner/repo.git'], workDir);
  assert.equal(stray.code, 0, `set-url 失败: ${stray.stderr}`);

  const transport = new GitTransport({ repoUrl: bare, workDir, credentials: creds });
  const before = await transport.inspectWorkDir();
  assert.equal(before.exists, true, '.git 存在');
  assert.equal(before.match, false, '地址不一致必须被自检发现');
  assert.equal(before.origin, 'ssh://git@old.example:2222/owner/repo.git');

  await transport.rebuildWorkDir('relink');
  const after = await transport.inspectWorkDir({ detail: true });
  assert.equal(after.match, true, 'relink 后 fetch/push 地址都跟随 repoUrl');
  assert.equal(after.origin, bare);
  assert.equal(after.ahead, 0, 'relink 不丢弃/不产生本地提交');
  assert.equal(after.dirty, false, 'relink 不动工作树');
  // issue #104 建议 3：detail 自检必须同时数出远端分支上的快照（预警依据）
  assert.equal(after.remoteSnapshots, 1, 'detail 自检数出远端分支上的 1 个快照');

  await transport.rebuildWorkDir('reclone');
  assert.ok((await fs.stat(path.join(workDir, '.git'))).isDirectory(), 'reclone 后重新 clone 出 .git');
  assert.ok(await fs.stat(path.join(workDir, 'snapshots', 'snap-001')), 'reclone 后远端快照回到工作副本');

  // 非空且无 .git → 拒绝删除（绝不删来路不明的目录）
  const strayDir = await makeTempDir(t);
  await fs.writeFile(path.join(strayDir, 'stray.txt'), 'x');
  const t3 = new GitTransport({ repoUrl: bare, workDir: strayDir, credentials: creds });
  await assert.rejects(t3.rebuildWorkDir('reclone'), /不是 git 仓库/);
  assert.ok(await fs.stat(path.join(strayDir, 'stray.txt')), '拒绝时文件必须原样保留');
});
/* ---------------------------------------------------------------- issue #104 采纳远端历史（adopt） */

/**
 * 造一个「另一条历史」的同步仓库：同一个插件布局，但初始提交与现有工作副本不相交。
 * adopt 的判据是「远端顶层只有快照布局」+「合并原始历史」，所以夹具必须是**假远端**（bare 仓）。
 */
async function makeSyncRemote(t: test.TestContext, snapshot: SyncSnapshot & { sections: Record<string, unknown> }): Promise<string> {
  const bare = await makeBareRepo(t);
  const workDir = await makeTempDir(t);
  await new GitTransport({ repoUrl: bare, workDir, credentials: { getToken: async () => TEST_TOKEN } }).upload(snapshot);
  return bare;
}

test('issue #104 集成：改成另一条历史的同步仓库 → adopt 合并两条历史（本地提交原样保留、之后能继续 push）', async (t) => {
  const creds = { getToken: async () => TEST_TOKEN };
  const bareA = await makeBareRepo(t);
  const workDir = await makeTempDir(t);
  await new GitTransport({ repoUrl: bareA, workDir, credentials: creds }).upload(sampleSnapshot({ id: 'snap-001' }));

  const bareC = await makeSyncRemote(t, sampleSnapshot({ id: 'snap-other' }));
  const localHead = (await runRealGit(['rev-parse', 'HEAD'], workDir)).stdout.trim();
  const transport = new GitTransport({ repoUrl: bareC, workDir, credentials: creds });

  // 先确认这就是 issue #104 的现场：改地址后 pull --ff-only 因两条历史不相交而失败
  await assert.rejects(transport.list(), (err: unknown) => {
    assert.ok(err instanceof SyncTransportError);
    assert.match(err.message, /不是同一条历史/);
    return true;
  });

  await transport.rebuildWorkDir('adopt');

  const facts = await transport.inspectWorkDir({ detail: true });
  assert.equal(facts.match, true, 'adopt 后 origin 跟随当前配置地址');
  assert.equal(facts.dirty, false, 'adopt 不留下工作树脏改动');
  // 2 = 本地原提交（此前只推到过旧地址）+ 这次合并提交：两条都还不在当前地址上，merge 之后需要一次 push。
  // 断言精确值而不是「>0」：若哪天实现偷偷 rebase 或 force-push，这里会先红。
  assert.equal(facts.ahead, 2, '本地原提交与合并提交都尚未推到当前地址');

  assert.ok(await fs.stat(path.join(workDir, 'snapshots', 'snap-001')), '本地已有快照保留（不是 reclone）');
  assert.ok(await fs.stat(path.join(workDir, 'snapshots', 'snap-other')), '远端快照被合并进来');

  const merged = await runRealGit(['log', '--merges', '--oneline'], workDir);
  assert.match(merged.stdout, /Merge/, '走 merge 而不是 rebase ⇒ 历史里能看到合并提交');
  const kept = await runRealGit(['merge-base', '--is-ancestor', localHead, 'HEAD'], workDir);
  assert.equal(kept.code, 0, '本地原提交必须原样保留（rebase 会改写 sha，此断言会红）');

  // adopt 之后普通 push 可用：新快照写进当前地址，旧地址收不到
  await transport.upload(sampleSnapshot({ id: 'snap-003' }));
  // issue #104 建议 3 的两个数字必须跟着推送一起收敛：领先 0、远端快照 2
  const pushed = await transport.inspectWorkDir({ detail: true });
  assert.equal(pushed.ahead, 0, '推送成功后不再领先远端');
  // 3 = snap-001（本地历史随合并一起推上去）+ snap-other + snap-003：远端快照数是「远端分支上真实有的」
  assert.equal(pushed.remoteSnapshots, 3, '远端快照数跟着推送更新（snap-001 + snap-other + snap-003）');
  const logC = await runRealGit(['log', '--oneline', '--all'], bareC);
  assert.match(logC.stdout, /snap-003/, '合并后下游能继续 push');
  const logA = await runRealGit(['log', '--oneline', '--all'], bareA);
  assert.ok(!logA.stdout.includes('snap-003'), '旧地址不得再收到（否则仍在用旧 origin）');
});

test('issue #104 集成：远端顶层不是同步布局 → 拒绝合并，且一个字节历史都不动', async (t) => {
  const creds = { getToken: async () => TEST_TOKEN };
  const bareA = await makeBareRepo(t);
  const workDir = await makeTempDir(t);
  await new GitTransport({ repoUrl: bareA, workDir, credentials: creds }).upload(sampleSnapshot({ id: 'snap-001' }));
  const localHead = (await runRealGit(['rev-parse', 'HEAD'], workDir)).stdout.trim();
  const branch = (await runRealGit(['rev-parse', '--abbrev-ref', 'HEAD'], workDir)).stdout.trim();

  // 一个普通代码仓库（顶层是 README.md）：把它的历史合进来 = 把别人的仓库搬进工作副本
  const bareOther = await makeBareRepo(t);
  const seed = await makeTempDir(t);
  await runRealGit(['init'], seed);
  await runRealGit(['config', 'user.name', 'test'], seed);
  await runRealGit(['config', 'user.email', 'test@local'], seed);
  await runRealGit(['checkout', '-B', branch], seed);
  await fs.writeFile(path.join(seed, 'README.md'), '# notes\n');
  await runRealGit(['add', '.'], seed);
  await runRealGit(['commit', '-m', 'unrelated'], seed);
  await runRealGit(['remote', 'add', 'origin', bareOther], seed);
  const pushed = await runRealGit(['push', '-u', 'origin', branch], seed);
  assert.equal(pushed.code, 0, `push 失败: ${pushed.stderr}`);

  const transport = new GitTransport({ repoUrl: bareOther, workDir, credentials: creds });
  await assert.rejects(transport.rebuildWorkDir('adopt'), (err: unknown) => {
    assert.ok(err instanceof SyncTransportError);
    assert.match(err.message, /README\.md/, '必须点出到底撞见了什么（可操作）');
    assert.match(err.message, /不是本插件的同步仓库/);
    assert.equal(err.retryable, false, '重试不会自愈');
    return true;
  });

  const head = (await runRealGit(['rev-parse', 'HEAD'], workDir)).stdout.trim();
  assert.equal(head, localHead, '拒绝时历史一步都不许动');
  await assert.rejects(fs.stat(path.join(workDir, '.git', 'MERGE_HEAD')), '不得留下半截合并');
  const status = await runRealGit(['status', '--porcelain'], workDir);
  assert.equal(status.stdout.trim(), '', '拒绝后工作树保持干净');
});

test('issue #104 集成：工作副本有未提交改动 → 拒绝 adopt（不替用户丢改动）', async (t) => {
  const creds = { getToken: async () => TEST_TOKEN };
  const bareA = await makeBareRepo(t);
  const workDir = await makeTempDir(t);
  await new GitTransport({ repoUrl: bareA, workDir, credentials: creds }).upload(sampleSnapshot({ id: 'snap-001' }));
  const localHead = (await runRealGit(['rev-parse', 'HEAD'], workDir)).stdout.trim();

  const bareC = await makeSyncRemote(t, sampleSnapshot({ id: 'snap-other' }));
  await fs.writeFile(path.join(workDir, 'notes.txt'), 'wip\n');

  const transport = new GitTransport({ repoUrl: bareC, workDir, credentials: creds });
  await assert.rejects(transport.rebuildWorkDir('adopt'), (err: unknown) => {
    assert.ok(err instanceof SyncTransportError);
    assert.match(err.message, /未提交的改动/, '说清为什么拒绝');
    return true;
  });

  assert.ok(await fs.stat(path.join(workDir, 'notes.txt')), '用户的文件必须原样保留');
  const head = (await runRealGit(['rev-parse', 'HEAD'], workDir)).stdout.trim();
  assert.equal(head, localHead, '被拒绝时不得 merge 任何东西');
});

test('issue #104 集成：两侧同名快照内容不同 → 合并冲突自动撤销，工作副本回到操作前', async (t) => {
  const creds = { getToken: async () => TEST_TOKEN };
  const bareA = await makeBareRepo(t);
  const workDir = await makeTempDir(t);
  const manifestA = { schemaVersion: 1, dshVersion: '1.0.0', platform: 'win32' as const, sectionIds: ['settings' as SectionId], containsSecrets: false };
  await new GitTransport({ repoUrl: bareA, workDir, credentials: creds })
    .upload(sampleSnapshot({ id: 'snap-c', manifest: manifestA }));

  // 同一个快照 id、不同 manifest.json 内容 ⇒ 合并时 add/add 冲突
  const bareC = await makeSyncRemote(t, sampleSnapshot({
    id: 'snap-c',
    manifest: { ...manifestA, dshVersion: '9.9.9' },
  }));
  const localHead = (await runRealGit(['rev-parse', 'HEAD'], workDir)).stdout.trim();

  const transport = new GitTransport({ repoUrl: bareC, workDir, credentials: creds });
  await assert.rejects(transport.rebuildWorkDir('adopt'), (err: unknown) => {
    assert.ok(err instanceof SyncTransportError);
    assert.match(err.message, /合并远端 .* 时发生冲突/);
    assert.match(err.message, /已撤销这次合并/);
    return true;
  });

  await assert.rejects(fs.stat(path.join(workDir, '.git', 'MERGE_HEAD')), 'merge --abort 后不得残留 MERGE_HEAD');
  const status = await runRealGit(['status', '--porcelain'], workDir);
  assert.equal(status.stdout.trim(), '', '撤销后工作树必须干净（冲突标记不得留在文件里）');
  const head = (await runRealGit(['rev-parse', 'HEAD'], workDir)).stdout.trim();
  assert.equal(head, localHead, '撤销后 HEAD 必须回到操作前的提交');
});

