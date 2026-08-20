/**
 * m-market：GitFileWriterClient / createGitFileWriter 单测。
 * 覆盖：clone + 写文件 + commit + push 全流程；幂等（无变化不 push）；
 * PR 分支（branch + baseRef + upstream fetch + force push）；错误脱敏（token 不进错误消息、
 * 凭据临时文件用后即删）；仓库地址校验；工作副本非空拒绝。
 * 全部通过注入 exec mock + 真实临时目录 fs（不碰真实 git / 网络）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createGitFileWriter, GitFileWriterError } from './git-file-writer.ts';
import type { GitExecFn, GitExecResult } from '../sync/git/git-transport.ts';

const TEST_TOKEN = 'gho_abcdefghijklmnopqrstuvwxyz123456';

interface ExecCall {
  cmd: string;
  args: string[];
  opts: { cwd?: string; timeoutMs?: number };
}

/** 记录 exec 调用并按命令返回脚本化结果的 mock */
function installExec(script: (call: ExecCall) => GitExecResult): { exec: GitExecFn; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec: GitExecFn = async (cmd, args, opts) => {
    const call = { cmd, args, opts };
    calls.push(call);
    return script(call);
  };
  return { exec, calls };
}

/** 默认成功脚本：clone/config/add/commit/push 全 0；diff 有变化（code 1）触发 commit+push */
function okScript(options: { changed?: boolean } = {}): (call: ExecCall) => GitExecResult {
  return (call) => {
    if (gitCommandOf(call) === 'diff') return { stdout: '', stderr: '', code: options.changed === false ? 0 : 1 };
    return { stdout: '', stderr: '', code: 0 };
  };
}

/** 提取真实 git 命令：剥离前置的 `-c <value>` 凭据参数对（可能有 1~2 对） */
function gitCommandOf(call: ExecCall): string {
  const args = call.args;
  let i = 0;
  while (args[i] === '-c') i += 2;
  return args[i] ?? '';
}

/** 从 capture call args 提取 credential store 文件路径（--file=...） */
function credFileOf(calls: ExecCall[]): string | null {
  for (const c of calls) {
    for (const arg of c.args) {
      const m = /^credential\.helper=store --file=(.+)$/.exec(arg);
      if (m?.[1]) return m[1]!.replace(/^"|"$/g, '');
    }
  }
  return null;
}

async function tempWorkDir(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gfw-test-'));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); });
  return dir;
}

test('git-file-writer: clone + 写文件 + commit + push（默认分支），凭据临时文件用后即删', async (t) => {
  const { exec, calls } = installExec(okScript());
  const workDir = await tempWorkDir(t);
  const writer = createGitFileWriter({
    credentials: { getToken: async () => TEST_TOKEN },
    exec,
    timeoutMs: 5000,
  });

  const result = await writer.writeFiles({
    repoUrl: 'https://github.com/xiaojun/dsh-configs',
    workDir,
    entries: [
      { path: 'items/my-config/manifest.json', content: '{"id":"my-config"}' },
      { path: 'items/my-config/config.zip', content: new Uint8Array([1, 2, 3]) },
    ],
    commitMessage: 'publish: add my-config v1.0.0',
  });

  assert.equal(result.pushed, true);
  assert.equal(result.branch, 'default');

  // 命令序：clone → config user.name → config user.email → add → diff → commit → push
  const firsts = calls.map((c) => gitCommandOf(c));
  assert.deepEqual(firsts, ['clone', 'config', 'config', 'add', 'diff', 'commit', 'push']);
  // clone 带凭据（-c credential.helper=store --file=...）
  const cloneCall = calls[0]!;
  assert.ok(cloneCall.args.some((a) => a.startsWith('credential.helper=store --file=')), 'clone 必须注入 credential helper');
  // push 同样带凭据
  const pushCall = calls[calls.length - 1]!;
  assert.deepEqual(pushCall.args.slice(pushCall.args.length - 4), ['push', '-u', 'origin', 'HEAD']);
  assert.ok(pushCall.args.some((a) => a.startsWith('credential.helper=store --file=')), 'push 必须注入 credential helper');
  // commit message 原样传递
  const commitCall = calls.find((c) => gitCommandOf(c) === 'commit')!;
  assert.ok(commitCall.args.includes('publish: add my-config v1.0.0'));

  // 文件真实写入（自动建目录）
  const manifestRaw = await fs.readFile(path.join(workDir, 'items/my-config/manifest.json'), 'utf8');
  assert.equal(manifestRaw, '{"id":"my-config"}');
  const zipRaw = new Uint8Array(await fs.readFile(path.join(workDir, 'items/my-config/config.zip')));
  assert.deepEqual(Array.from(zipRaw), [1, 2, 3]);

  // 凭据临时文件用后即删
  const credFile = credFileOf(calls);
  assert.ok(credFile !== null, '必须创建过 credential store 文件');
  await assert.rejects(fs.stat(credFile!), /ENOENT/);
});

test('git-file-writer: 内容无变化 → pushed:false，不产生 commit/push（幂等）', async (t) => {
  const { exec, calls } = installExec(okScript({ changed: false }));
  const workDir = await tempWorkDir(t);
  const writer = createGitFileWriter({ credentials: { getToken: async () => TEST_TOKEN }, exec });

  const result = await writer.writeFiles({
    repoUrl: 'https://github.com/xiaojun/dsh-configs',
    workDir,
    entries: [{ path: 'index.json', content: '{}' }],
    commitMessage: 'noop',
  });

  assert.equal(result.pushed, false);
  assert.ok(!calls.some((c) => c.args[0] === 'commit'), '无变化不得 commit');
  assert.ok(!calls.some((c) => c.args[0] === 'push'), '无变化不得 push');
});

test('git-file-writer: PR 分支场景（branch + baseRef + upstream fetch + force push）', async (t) => {
  // remote get-url upstream 失败（全新 clone 无 upstream）→ 触发 remote add upstream；diff 有变化
  const { exec, calls } = installExec((call) => {
    if (gitCommandOf(call) === 'remote' && call.args.includes('get-url')) {
      return { stdout: '', stderr: 'error: No such remote', code: 128 };
    }
    if (gitCommandOf(call) === 'diff') return { stdout: '', stderr: '', code: 1 };
    return { stdout: '', stderr: '', code: 0 };
  });
  const workDir = await tempWorkDir(t);
  const writer = createGitFileWriter({ credentials: { getToken: async () => TEST_TOKEN }, exec });

  const result = await writer.writeFiles({
    repoUrl: 'https://github.com/xiaojun/dsh-config-market',
    workDir,
    upstreamUrl: 'https://github.com/xiajiajun516/dsh-config-market',
    branch: 'dsh-market-sync/my-config',
    baseRef: 'upstream/main',
    force: true,
    entries: [{ path: 'index.json', content: '{"items":[]}' }],
    commitMessage: 'market: add my-config',
  });

  assert.equal(result.pushed, true);
  assert.equal(result.branch, 'dsh-market-sync/my-config');

  const argsOf = (cmd: string): string[] => calls.find((c) => gitCommandOf(c) === cmd)?.args ?? [];
  // upstream：remote add upstream + fetch（公开仓库匿名，不带凭据）
  const remoteAdd = calls.find((c) => gitCommandOf(c) === 'remote' && c.args.includes('add') && c.args.includes('upstream'))!;
  assert.ok(remoteAdd.args.includes('https://github.com/xiajiajun516/dsh-config-market'), 'upstream url 必须是官方仓库');
  const fetchCall = calls.find((c) => gitCommandOf(c) === 'fetch')!;
  assert.ok(fetchCall.args.includes('upstream'));
  assert.ok(!fetchCall.args.some((a) => a.startsWith('credential.helper=')), 'fetch 官方公开仓库必须零凭据');
  // checkout -B <branch> upstream/main
  const co = argsOf('checkout');
  assert.deepEqual(co.slice(1), ['-B', 'dsh-market-sync/my-config', 'upstream/main']);
  // push -u origin <branch> --force-with-lease
  const push = argsOf('push');
  assert.deepEqual(push.slice(push.length - 5), ['push', '-u', 'origin', 'dsh-market-sync/my-config', '--force-with-lease']);
});

test('git-file-writer: 已存在工作副本 → pull --ff-only 而非重新 clone', async (t) => {
  const workDir = await tempWorkDir(t);
  await fs.mkdir(path.join(workDir, '.git'), { recursive: true }); // 假装已 clone
  const { exec, calls } = installExec(okScript({ changed: false }));
  const writer = createGitFileWriter({ credentials: { getToken: async () => TEST_TOKEN }, exec });

  await writer.writeFiles({
    repoUrl: 'https://github.com/xiaojun/dsh-configs',
    workDir,
    entries: [{ path: 'a.txt', content: '1' }],
    commitMessage: 'noop',
  });

  assert.ok(!calls.some((c) => gitCommandOf(c) === 'clone'), '已存在副本不得重新 clone');
  assert.ok(calls.some((c) => gitCommandOf(c) === 'pull' && c.args.includes('--ff-only')), '必须 pull --ff-only');
});

test('git-file-writer: push 失败 → 错误消息脱敏（token 与 repoUrl 均被掩码）', async (t) => {
  const { exec, calls } = installExec((call) => {
    if (gitCommandOf(call) === 'diff') return { stdout: '', stderr: '', code: 1 }; // 有变化 → 走 commit + push
    if (gitCommandOf(call) === 'push') {
      return { stdout: '', stderr: `fatal: couldn't find remote ref ${TEST_TOKEN} @ ${'https://github.com/xiaojun/dsh-configs'}`, code: 128 };
    }
    return { stdout: '', stderr: '', code: 0 };
  });
  const workDir = await tempWorkDir(t);
  const writer = createGitFileWriter({ credentials: { getToken: async () => TEST_TOKEN }, exec });

  await assert.rejects(
    writer.writeFiles({
      repoUrl: 'https://github.com/xiaojun/dsh-configs',
      workDir,
      entries: [{ path: 'a.txt', content: '1' }],
      commitMessage: 'x',
    }),
    (err: unknown) => {
      assert.ok(err instanceof GitFileWriterError);
      assert.ok(!err.message.includes(TEST_TOKEN), '错误消息不得回显 token');
      assert.ok(err.message.includes('[REDACTED]') || err.message.includes('[REPO_URL]'), 'token/repoUrl 必须被掩码');
      return true;
    },
  );
});

test('git-file-writer: 仓库地址校验（userinfo / 空白拒绝）→ 零命令执行', async () => {
  const { exec, calls } = installExec(okScript());
  const writer = createGitFileWriter({ credentials: { getToken: async () => TEST_TOKEN }, exec });
  await assert.rejects(
    writer.writeFiles({
      repoUrl: 'https://user:token@github.com/x/y',
      workDir: os.tmpdir(),
      entries: [{ path: 'a', content: '1' }],
      commitMessage: 'x',
    }),
    GitFileWriterError,
  );
  assert.equal(calls.length, 0, '地址非法必须零 git 命令执行');
});

test('git-file-writer: 工作副本非空且非 git 仓库 → 拒绝', async (t) => {
  const workDir = await tempWorkDir(t);
  await fs.writeFile(path.join(workDir, 'junk.txt'), 'x');
  const { exec, calls } = installExec(okScript());
  const writer = createGitFileWriter({ credentials: { getToken: async () => TEST_TOKEN }, exec });
  await assert.rejects(
    writer.writeFiles({
      repoUrl: 'https://github.com/x/y',
      workDir,
      entries: [{ path: 'a', content: '1' }],
      commitMessage: 'x',
    }),
    GitFileWriterError,
  );
  assert.ok(!calls.some((c) => c.args[0] === 'clone'), '非空非仓库目录不得 clone');
});