/**
 * git 通道的连通性探针（cloud-sync 借鉴项 ②，补齐四条通道）。
 *
 * 真机背景：git 通道此前没有 probe()，同步页点「测试连接」会得到红色「当前同步通道不支持连通性自检」——
 * 用户看到的是「操作失败」，而实际只是那条通道没实现自检。本文件钉住修复后的行为：
 *  - 只读：仅发 ls-remote（不 clone / 不 fetch / 不碰工作副本）；
 *  - 匿名成功 = 公开仓库可达；匿名失败 + 带凭据成功 = 私有仓库且凭据可用；
 *  - 两者都失败 → 抛可操作错误，token 绝不出现在消息里；
 *  - 刻意不报 snapshotCount（统计快照要先 fetch 工作副本 = 写本地状态）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { GitTransport, GitTransportError } from './git-transport.ts';
import type { GitExecFn, GitExecResult, GitTransportOptions } from './git-transport.ts';
import { zhMsg } from '../../core/messages.ts';
import { engineMsg } from '../messages.ts';

const TOKEN = 'secret-token-probe-001';
const REPO = 'https://github.com/example/private-config.git';

function execStub(responder: (call: number, args: string[]) => GitExecResult): { fn: GitExecFn; calls: string[][] } {
  const calls: string[][] = [];
  let n = 0;
  const fn: GitExecFn = async (_cmd, args) => {
    n += 1;
    calls.push(args);
    return responder(n, args);
  };
  return { fn, calls };
}

function options(exec: GitExecFn, overrides: Partial<GitTransportOptions> = {}): GitTransportOptions {
  return {
    repoUrl: REPO,
    workDir: 'UNUSED-BY-PROBE',
    credentials: { getToken: async () => TOKEN },
    exec,
    ...overrides,
  };
}

test('git probe：匿名 ls-remote 成功 → 连接正常，且**只**发这一条命令（只读）', async () => {
  const { fn, calls } = execStub(() => ({ stdout: '', stderr: '', code: 0 }));
  const transport = new GitTransport(options(fn));
  const result = await transport.probe();
  assert.equal(result.message, engineMsg('sync.git.probeOk'));
  assert.equal(result.snapshotCount, undefined, '不得报快照数（统计它需要 fetch 工作副本）');
  assert.deepEqual(result.createdCollections ?? [], [], 'git 通道不在远端建目录');
  assert.equal(calls.length, 1, '探针只准发一条 ls-remote');
  assert.deepEqual(calls[0], ['ls-remote', REPO]);
});

test('git probe：匿名被拒、带凭据成功 → 连接正常（私有仓库 + 凭据可用）', async () => {
  const { fn, calls } = execStub((n) => (n === 1
    ? { stdout: '', stderr: 'fatal: could not read Username', code: 128 }
    : { stdout: '', stderr: '', code: 0 }));
  const transport = new GitTransport(options(fn));
  const result = await transport.probe();
  assert.equal(result.message, engineMsg('sync.git.probeOk'));
  assert.equal(calls.length, 2, '匿名 + 带凭据各一次 ls-remote');
  assert.ok(calls.every((args) => args.includes('ls-remote')));
});

test('git probe：两者都失败 → 抛可操作错误，且 **token 不出现**在消息里', async () => {
  const { fn } = execStub(() => ({ stdout: '', stderr: `fatal: Authentication failed for '${TOKEN}'`, code: 128 }));
  const transport = new GitTransport(options(fn));
  await assert.rejects(
    async () => { await transport.probe(); },
    (err: unknown) => {
      assert.ok(err instanceof GitTransportError, '必须是通道错误（供上层分类）');
      const message = (err as Error).message;
      // 文案 = 既有字典键（URL 经通道自带的 mask 处理，不出现原始地址）
      assert.equal(message, zhMsg('sync.git.repoUnreachable', { url: '[REPO_URL]' }));
      assert.ok(!message.includes(TOKEN), 'token 绝不进错误消息');
      assert.ok(!message.includes(REPO), '远端地址按通道口径脱敏');
      return true;
    },
  );
});
