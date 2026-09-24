/**
 * CLI 离线会话修复（issue #45 Fix 3）：dsh-config-manager sessions repair。
 *
 * 为什么必须有这条通道：会话日志位置与 header cwd 不一致时，DSH **直接拒绝启动**
 * （实测 corrupt session log … / duplicate JSONL session id …），此时插件也加载不了，
 * 在线路径（导入期护栏、「会话归位」卡片）全部不可用。本命令不依赖任何 DSH 运行时：
 * 只读会话日志首帧 → 用与在线 planner 同一个 projectKeyOf 判定 → （--fix 时）改写首帧 + 搬目录。
 *
 * 安全姿态（与在线路径同强度）：
 *   - 默认 **dry-run**：只打印计划，零写入；--fix 才落盘；
 *   - 目标目录已存在 → 冲突，拒绝覆盖；
 *   - 目录内有 session.lock → 不动（可能正被使用）；
 *   - 缺 cwd / 多 generation cwd 不一致 → 只报告（不猜）；
 *   - 重复 id 只在 --keep 点名保留谁时才把其它副本移进隔离目录（**绝不删除**）；
 *   - 改写后搬不动 → 回滚改写，绝不留「header 与位置不一致」的半套状态。
 */
import fs from 'node:fs/promises';
import { join } from 'node:path';

import { planSessionRepair, sessionRepairNeedsAttention } from '../core/session-repair.ts';
import type { RepairSessionInput, SessionRepairAction } from '../core/session-repair.ts';
import type { PathMappingRule } from '../core/path-mapping.ts';
import { PROJECT_KEY_RE, readLogFileCwd, rewriteSessionLogDir } from '../utils/session-log.ts';

/** CLI 输出通道（可注入供测试）。 */
export interface SessionsRepairIo {
  log: (line: string) => void;
  error: (line: string) => void;
}

export interface SessionsRepairOptions {
  /** DSH home（--home；缺省由调用方解析 $DSH_HOME） */
  home: string;
  /** --fix：真的落盘（缺省 dry-run 只报告） */
  fix: boolean;
  /** --keep <dir>：重复 id 时保留哪一份 */
  keep?: string;
  /** --map old=new（可重复） */
  maps: readonly string[];
  /** --json：机器可读输出 */
  json: boolean;
}

type ScannedSession = RepairSessionInput;

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** 解析 --map old=new（必须在第一个 = 处切分，Windows 路径里也有盘符冒号但不会有 =）。 */
export function parseRepairMaps(maps: readonly string[]): { mappings: PathMappingRule[]; errors: string[] } {
  const mappings: PathMappingRule[] = [];
  const errors: string[] = [];
  for (const raw of maps) {
    const at = raw.indexOf('=');
    if (at <= 0 || at === raw.length - 1) {
      errors.push('--map 需要 old=new 形式 / --map needs old=new: ' + raw);
      continue;
    }
    mappings.push({ oldPrefix: raw.slice(0, at), newPrefix: raw.slice(at + 1) });
  }
  return { mappings, errors };
}

/** 扫描 <home>/sessions：projectKey 段 → 会话目录 → 首帧 cwd。任何读不出的都如实记为「无法判定」。 */
async function scanSessions(sessionsRoot: string, io: SessionsRepairIo): Promise<ScannedSession[]> {
  const out: ScannedSession[] = [];
  const projectDirs = await fs.readdir(sessionsRoot, { withFileTypes: true });
  for (const entry of projectDirs) {
    if (!entry.isDirectory()) continue;
    const projectKey = entry.name;
    if (!PROJECT_KEY_RE.test(projectKey)) {
      // 不是 DSH 的 projectKey 形状：原样说明并跳过（隔离目录也走这里）
      io.log('跳过非 projectKey 目录 / skip non-projectKey dir: ' + projectKey);
      continue;
    }
    const projectDir = join(sessionsRoot, projectKey);
    const sessionDirs = await fs.readdir(projectDir, { withFileTypes: true });
    for (const sessionEntry of sessionDirs) {
      if (!sessionEntry.isDirectory()) continue;
      const dir = join(projectDir, sessionEntry.name);
      const names = (await fs.readdir(dir)).filter((n) => /^session(\.[A-Za-z0-9]+)*\.jsonl(\.zstd)?$/.test(n)).sort();
      if (names.length === 0) continue;
      const cwds: string[] = [];
      for (const name of names) {
        const cwd = await readLogFileCwd(join(dir, name));
        if (cwd !== undefined && !cwds.includes(cwd)) cwds.push(cwd);
      }
      const locked = await exists(join(dir, 'session.lock'));
      out.push({
        sessionId: sessionEntry.name,
        fromProjectKey: projectKey,
        dir,
        ...(cwds.length > 0 ? { cwd: cwds[0] } : {}),
        consistent: cwds.length <= 1,
        ...(locked ? { locked: true } : {}),
      });
    }
  }
  return out;
}

/** 隔离目录：同一轮修复一个时间戳目录；**只搬不删**（用户可自行处理）。 */
async function quarantineDirFor(sessionsRoot: string, stamp: string, action: SessionRepairAction): Promise<string> {
  const target = join(sessionsRoot, '.cm-repair-quarantine-' + stamp, action.fromProjectKey, action.sessionId);
  await fs.mkdir(join(target, '..'), { recursive: true });
  return target;
}

/**
 * 执行修复（dry-run 时零写入）。返回进程退出码：dry-run 恒 0（只报告）；
 * --fix 时只要有失败/冲突/回滚就返回 1。
 */
export async function runSessionsRepair(options: SessionsRepairOptions, io: SessionsRepairIo): Promise<number> {
  const sessionsRoot = join(options.home, 'sessions');
  if (!(await exists(sessionsRoot))) {
    io.error('找不到会话根目录 / sessions root not found: ' + sessionsRoot);
    io.error('用 --home <DSH_HOME> 指定正确的 DSH home；缺省取 $DSH_HOME（~/.dsh）。');
    return 1;
  }
  const parsed = parseRepairMaps(options.maps);
  for (const error of parsed.errors) io.error(error);
  if (parsed.errors.length > 0) return 1;

  const scanned = await scanSessions(sessionsRoot, io);
  const plan = planSessionRepair(scanned, {
    mappings: parsed.mappings,
    ...(options.keep !== undefined ? { keep: options.keep } : {}),
  });
  const pending = sessionRepairNeedsAttention(plan);

  if (options.json && !options.fix) {
    io.log(JSON.stringify({ ok: true, dryRun: true, home: options.home, summary: plan.summary, actions: plan.actions }, null, 2));
    return 0;
  }

  io.log('会话根 / sessions root: ' + sessionsRoot);
  io.log(
    '扫描 ' + String(plan.summary.scanned) + ' 条会话：位置正确 ' + String(plan.summary.ok)
    + '，待搬家 ' + String(plan.summary.move)
    + '，待改写+搬家 ' + String(plan.summary.rewriteMove)
    + '，跳过 ' + String(plan.summary.skip)
    + '，重复 id ' + String(plan.summary.duplicates),
  );
  for (const action of plan.actions) {
    if (action.kind === 'ok') continue;
    const move = action.toProjectKey === undefined ? '' : ' → ' + action.toProjectKey;
    const rewrite = action.rewrite === undefined ? '' : '（改写首帧 cwd: ' + action.rewrite.from + ' → ' + action.rewrite.to + '）';
    io.log('  [' + action.kind + '] ' + action.sessionId + '  ' + action.fromProjectKey + move + rewrite + '  reason=' + action.reason);
  }
  if (!options.fix) {
    if (pending) io.log('以上为计划（零写入）。加 --fix 执行；重复 id 需用 --keep <目录> 指定保留哪一份。');
    else io.log('无需修复。/ nothing to repair.');
    return 0;
  }

  let failures = 0;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const action of plan.actions) {
    if (!action.applies) {
      if (action.reason === 'duplicate-id' && action.kind === 'keep') continue;
      continue;
    }
    try {
      if (action.kind === 'quarantine') {
        const target = await quarantineDirFor(sessionsRoot, stamp, action);
        if (await exists(target)) {
          io.error('隔离目标已存在，跳过 / quarantine target exists: ' + target);
          failures += 1;
          continue;
        }
        await fs.rename(action.dir, target);
        io.log('已隔离重复副本 / quarantined duplicate: ' + action.dir + ' → ' + target);
        continue;
      }
      // move / rewrite-move
      let rewritten = false;
      if (action.rewrite !== undefined) {
        const result = await rewriteSessionLogDir(action.dir, action.rewrite.to);
        if (!result.ok) {
          io.error('改写首帧失败（未搬目录）/ rewrite failed: ' + action.sessionId + ' reason=' + String(result.reason));
          failures += 1;
          continue;
        }
        rewritten = true;
      }
      const targetDir = action.toProjectKey === undefined
        ? undefined
        : join(sessionsRoot, action.toProjectKey, action.sessionId);
      if (targetDir === undefined) {
        io.error('缺少目标 projectKey，跳过 / missing target projectKey: ' + action.sessionId);
        failures += 1;
        continue;
      }
      if (await exists(targetDir)) {
        io.error('目标目录已存在，拒绝覆盖 / target exists: ' + targetDir);
        if (rewritten && action.rewrite !== undefined) {
          const back = await rewriteSessionLogDir(action.dir, action.rewrite.from);
          io.error(back.ok ? '已回滚首帧改写 / rewrite rolled back' : '回滚失败（请人工检查）/ rollback FAILED');
        }
        failures += 1;
        continue;
      }
      await fs.mkdir(join(targetDir, '..'), { recursive: true });
      await fs.rename(action.dir, targetDir);
      if (!(await exists(targetDir)) || await exists(action.dir)) {
        io.error('搬迁自检失败 / post-move check failed: ' + action.dir);
        failures += 1;
        continue;
      }
      io.log('已归位 / moved: ' + action.sessionId + '  ' + action.fromProjectKey + ' → ' + action.toProjectKey);
      io.log('  会话目录 / dir: ' + targetDir);
      if (rewritten) {
        io.log('  已改写首帧 cwd（其余帧逐字节保留）；DSH 侧工作区登记请启动 DSH 后在「会话归位」卡片执行。');
      }
    } catch (error) {
      io.error('修复失败 / repair failed: ' + action.sessionId + ' ' + (error instanceof Error ? error.message : String(error)));
      failures += 1;
    }
  }
  io.log(failures === 0 ? '完成（无失败）/ done' : '完成但有 ' + String(failures) + ' 项失败 / done with failures');
  return failures === 0 ? 0 : 1;
}

