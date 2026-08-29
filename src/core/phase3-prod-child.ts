/**
 * 生产路径 child crash harness：用真实 Phase3Recovery.runJournaled（生产接线所用的助手）
 * 执行一个 operation；在 fn（真实 side effect 写磁盘）后、COMMITTED 前 SIGKILL。
 * 用于 phase3-production-integration.test.ts 验证「真实操作 crash → 残留非终态 journal → 可 reconcile」。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { Phase3Recovery } from './phase3-host.ts';

const txDir = process.argv[2]!;
const dataDir = path.dirname(txDir);
const sideEffect = path.join(dataDir, 'side-effect.txt');
const FP = 'fp-prod';

async function main(): Promise<void> {
  const recovery = new Phase3Recovery({ dataDir, packageVersion: '0.1.54', environmentFingerprint: FP });
  await recovery.store.ensureDirs();
  const lockCtx = { token: { tokenId: 't', managerId: 'm', instanceId: 'child-prod', acquiredAt: Date.now() } };
  try {
    await recovery.runJournaled({
      operationType: 'import-apply',
      lockCtx,
      fn: async () => {
        // 真实 side effect：写磁盘文件
        await fs.writeFile(sideEffect, 'side-effect-content');
        // side effect 已完成、step done 尚未落 journal 前 crash
        process.kill(process.pid, 'SIGKILL');
      },
    });
  } catch {
    // 被杀不会到这；若执行完则正常退出（测试用 before-step 场景）
  }
  process.exit(0);
}

main().catch((err) => { process.stderr.write(String(err)); process.exit(2); });
