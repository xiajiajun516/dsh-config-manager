/**
 * Phase 4 crash-injection child harness：用真实 Phase3Recovery.runJournaled({ deferredSnapshot:true })
 * 执行一个 op-bound snapshot + mutation，随后在指定 crash point SIGKILL 自己。
 *
 * 用法（argv）：
 *   argv[2] = workDir（写入 transactions/ 与 snapshots/ 的根）
 *   argv[3] = crashPoint（C1..C10，见 phase4-crash-injection.test.ts）
 *
 * 每个 crash point 在流程的指定边界 SIGKILL，验证「journal 状态 + snapshot 是否存在」反映该点。
 * 用真实磁盘 FileSnapshotStore（manifest + READY），非 throw 替代。
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { Phase3Recovery } from './phase3-host.ts';
import { createSnapshot, FileSnapshotStore } from './backup.ts';

const workDir = process.argv[2]!;
const crashPoint = process.argv[3]!;
const dataDir = path.join(workDir, 'data');
const snapDir = path.join(dataDir, 'snapshots');
const txDir = path.join(dataDir, 'transactions');
const FP = 'fp-crash';
const sideEffect = path.join(workDir, 'home', 'side-effect.txt');

function die(): never { process.kill(process.pid, 'SIGKILL'); throw new Error('unreachable'); }

async function main(): Promise<void> {
  // 用真实磁盘 FileSnapshotStore（manifest+READY）与真实 plan
  fssync.mkdirSync(dataDir, { recursive: true });
  const recovery = new Phase3Recovery({ dataDir, packageVersion: '0.1.54', environmentFingerprint: FP });
  await recovery.store.ensureDirs();
  const store = new FileSnapshotStore({ dir: snapDir });
  const lockCtx = { token: { tokenId: 't', managerId: 'm', instanceId: 'crash-child', acquiredAt: Date.now() } };

  const plan = {
    items: [{ id: 'settings:general', kind: 'Update' as const, adapter: 'settings' as const, description: 'u', severity: 'info' as const, target: { adapter: 'settings' as const, ref: 'general' } }],
    globalStrategy: 'replace' as const, pathMappings: [], missingSecrets: [], needsRestart: false,
    estimatedActions: {} as Record<string, number>,
  };

  // 构造内存 ctx：engineSnapshotEntry 需要 settings.describe；hostFile 备份需要 settings.yaml
  // 这里不复用 makeContext（子进程需独立构造，无 import 依赖测试 helper）。
  const ctx: any = {
    homeDir: path.join(workDir, 'home'),
    platform: 'win32',
    arch: 'x64',
    dshVersion: '0.1.54',
    profile: 'web',
    fs: {
      readFile: async (p: string) => Buffer.from('settings.yaml-content', 'utf8'),
    },
    settings: {
      describe: async (ref: string) => ({ value: { theme: 'dark' }, revision: 1, secrets: [] }),
    },
    credentials: { describe: async () => ({ configured: false }) },
    plugins: { listInstalled: async () => [] },
    workspace: { listRecords: async () => [] },
    patchFile: { readPatchLines: async () => [] },
    log: { warn: () => {} },
  };

  try {
    await recovery.runJournaled({
      operationType: 'import-apply',
      lockCtx,
      deferredSnapshot: true,
      fn: async (journalCtx) => {
        if (crashPoint === 'C1') die(); // after journal CREATED, before snapshot
        const snap = await createSnapshot({
          ctx, plan, sourceZip: 'crash.zip', store, adapters: [],
          operationId: journalCtx?.operationId, operationType: journalCtx?.operationType,
          environmentFingerprint: journalCtx?.environmentFingerprint, ownerInstanceId: journalCtx?.ownerInstanceId,
        });
        if (crashPoint === 'C2') die(); // during/after snapshot write, before bind
        await journalCtx?.bindSnapshot(snap.id);
        if (crashPoint === 'C3') die(); // after journal binding (SNAPSHOT_CREATED), before APPLYING
        await journalCtx?.markApplying();
        if (crashPoint === 'C4') die(); // after APPLYING, before mutation
        // 真实 local file mutation
        await fs.mkdir(path.dirname(sideEffect), { recursive: true });
        await fs.writeFile(sideEffect, 'mutated');
        if (crashPoint === 'C5') die(); // after first local file mutation
        if (crashPoint === 'C6') die(); // mid-mutation
        if (crashPoint === 'C7') die(); // after mutation, before COMMITTED
        // 业务成功
      },
    });
    if (crashPoint === 'C8' || crashPoint === 'C9' || crashPoint === 'C10') {
      // 已到 COMMITTED（runJournaled 返回），C8=C9=C10 视为「COMMITTED 后不应 rollback」的探针
      process.exit(0);
    }
    // 未指定 crash point → 正常完成不 kill
    process.exit(0);
  } catch {
    // 被杀不会到这
    process.exit(0);
  }
}

main().catch(() => process.exit(2));
