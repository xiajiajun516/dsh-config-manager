/**
 * restore 崩溃注入 child harness（task-2/A 只读审计用）。
 *
 * 与 src/core/phase4-crash-child.ts 同模式：用**真实** Phase3Recovery.runJournaled 包住**真实**
 * restore 引擎，在 restore 的第 N 个动作**开始前** SIGKILL 自己 —— 模拟「恢复执行到一半宿主被杀」。
 *
 * 用法（argv）：
 *   argv[2] = workDir（<workDir>/data 存 transactions+safe-mode，<workDir>/home 是被恢复的 $DSH_HOME）
 *   argv[3] = mode：'crash' | 'rerun'
 *   argv[4] = crash 模式下第几个动作前 kill（1-based，与 RestoreOptions.onAction.index 同基）
 *
 * 'rerun' 模式：在**同一 dataDir** 上再跑一次「CLI 同款」runJournaled（不 crash），
 * 把 {ok,name,message} 写到 <workDir>/rerun.json，供父进程断言「重启后是否被残留 journal 阻断」。
 *
 * 这是 process.kill(SIGKILL) 真实注入，不是 throw 替代；子进程不做任何清理（崩溃真实无 finally）。
 */
import fssync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Phase3Recovery } from './phase3-host.ts';
import { restore } from './restore.ts';
import type { RestoreOptions } from './restore.ts';
import type { MutationLockContext } from '../utils/env-lock.ts';

const workDir = process.argv[2]!;
const mode = process.argv[3]!;
const crashAt = Number(process.argv[4] ?? '0');
const dataDir = path.join(workDir, 'data');
const homeDir = path.join(workDir, 'home');
const snapshotDir = path.join(dataDir, 'snapshots', 'snap-restore-crash');
/** 与父进程 reconcile 断言用的环境指纹一致（否则会先吃 env-mismatch 分支） */
const FP = 'fp-restore-crash';

function die(): never {
  process.kill(process.pid, 'SIGKILL');
  throw new Error('unreachable');
}

async function main(): Promise<void> {
  fssync.mkdirSync(dataDir, { recursive: true });
  const recovery = new Phase3Recovery({ dataDir, packageVersion: '0.1.79', environmentFingerprint: FP });
  await recovery.store.ensureDirs();
  const lockCtx: MutationLockContext = {
    token: { tokenId: 't-restore', managerId: 'm-restore', instanceId: 'restore-crash-child', acquiredAt: Date.now() },
  };
  const opts: RestoreOptions = {
    snapshotDir,
    homeDir,
    profile: 'web',
    onAction: (info) => {
      if (mode === 'crash' && info.index === crashAt) die();
    },
  };

  if (mode === 'rerun') {
    let result: { ok: boolean; name?: string; message?: string };
    try {
      await recovery.runJournaled({
        operationType: 'cli-restore',
        lockCtx,
        fn: (ctx) => restore(ctx === undefined ? opts : { ...opts, journal: ctx }),
      });
      result = { ok: true };
    } catch (e) {
      result = {
        ok: false,
        name: e instanceof Error ? e.name : typeof e,
        message: e instanceof Error ? e.message : String(e),
      };
    }
    await fs.writeFile(path.join(workDir, 'rerun.json'), JSON.stringify(result), 'utf8');
    return;
  }

  await recovery.runJournaled({
    operationType: 'cli-restore',
    lockCtx,
    fn: (ctx) => restore(ctx === undefined ? opts : { ...opts, journal: ctx }),
  });
}

main().then(
  () => process.exit(0),
  () => process.exit(2),
);
