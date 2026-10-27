/**
 * issue #115：clone 因**权限不足**失败时，必须换成能照做的说明（点名 Contents: Read and write）。
 *
 * 真机背景：细粒度 PAT 只勾了 Administration —— GitHub 在 clone 阶段直接回
 * `remote: Write access to repository not granted. / The requested URL returned error: 403`。
 * 插件此前把这段原文透出，用户只会以为 token 失效，反复重建 PAT 依然 403。
 * 本文件钉住：① 文案走 cloneAuthFailed；② 仍带 git 原文（便于对账）；③ token 绝不出现。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { GitTransport, GitTransportError } from './git-transport.ts';
import type { GitExecFn, GitTransportOptions } from './git-transport.ts';
import { engineMsg } from '../messages.ts';

const TOKEN = 'secret-token-clone-001';
const REPO = 'https://github.com/example/private-config.git';
const CLONE_403 = "remote: Write access to repository not granted.\nfatal: unable to access '" + REPO + "/': The requested URL returned error: 403";

/** clone 恒 403；其余命令一律成功（clone 之前不会有别的命令，保险起见）。 */
const exec403: GitExecFn = async (_cmd, args) => {
  if (args.includes('clone')) return { stdout: '', stderr: CLONE_403, code: 128 };
  return { stdout: '', stderr: '', code: 0 };
};

function options(exec: GitExecFn, workDir: string): GitTransportOptions {
  return {
    repoUrl: REPO,
    workDir,
    credentials: { getToken: async () => TOKEN },
    exec,
    // 鉴权失败不可重试：只允许一次尝试，测试才稳定
    retry: { attempts: 1 },
  };
}

test('issue #115：clone 403 → 点名 Contents: Read and write，且不泄漏 token', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-git-clone-auth-'));
  try {
    const transport = new GitTransport(options(exec403, path.join(tmp, 'work')));
    await assert.rejects(
      async () => { await transport.list(); },
      (err: unknown) => {
        assert.ok(err instanceof GitTransportError, '必须是通道错误（供上层分类）');
        const message = (err as Error).message;
        assert.equal(message, engineMsg('sync.git.cloneAuthFailed', { err: CLONE_403 }));
        assert.ok(message.includes('Contents: Read and write'), '要点名缺的是哪项权限');
        assert.ok(message.includes('Administration'), '要点名常见错误：只勾了 Administration');
        assert.ok(message.includes('403'), '保留 git 原文的关键状态码，便于对账');
        assert.equal(message.includes(TOKEN), false, 'token 绝不进错误消息');
        assert.equal((err as GitTransportError).kind, 'auth');
        return true;
      },
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
