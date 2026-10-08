/**
 * CLI 会话**只读检查**（T6）：dsh-config-manager sessions list | doctor。
 *
 * 为什么单独一个文件而不是塞进 sessions-repair.ts：那是「位置归位 + --fix」的写路径，
 * 本文件是**纯只读**的体检/清点路径 —— 两者共用的是 core 的判定，不是执行序列。
 * 独立成文件也让「doctor 不会写任何字节」在代码形状上一眼可见（本文件不 import 任何写 API）。
 *
 * 输出对齐设计稿 §10.2 的分类：按严重级分组，每行给会话 id / 问题码 / 版本 / 体积 / 归属。
 * --json 给机器可读结果（CI / 定时任务断言用）。
 */
import { scanSessionHealth } from '../utils/session-health-scan.ts';
import type { SessionHealthRow, SessionHealthSeverity } from '../core/session-health.ts';
import { SESSION_HEALTH_SEVERITIES } from '../core/session-health.ts';

/** 输出通道（可注入供测试）。 */
export interface SessionsInspectIo {
  log: (line: string) => void;
  error: (line: string) => void;
}

export interface SessionsInspectOptions {
  /** DSH home（会话根 = <home>/sessions） */
  home: string;
  /** 'list' = 只列会话；'doctor' = 体检并按严重级分组 */
  action: 'list' | 'doctor';
  json: boolean;
}

/** 严重级 → 终端前缀（纯文本，无 ANSI —— 兼容重定向到文件）。 */
const SEVERITY_TAG: Record<SessionHealthSeverity, string> = {
  blocksStartup: '[!!]',
  unloadable: '[X ]',
  nextRequestFails: '[! ]',
  invisible: '[? ]',
  ok: '[ok]',
};

/** 人类可读体积（与 UI 同阈值；CLI 不引 UI 模块，保持 core/utils 依赖面）。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return String(bytes) + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KiB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MiB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GiB';
}

function describeRow(row: SessionHealthRow): string {
  const parts = [SEVERITY_TAG[row.severity], row.unitId];
  if (row.version !== undefined) parts.push('v' + String(row.version));
  if (row.sizeBytes !== undefined) parts.push(formatBytes(row.sizeBytes));
  if (row.issues.length > 0) {
    parts.push('| ' + row.issues.map((i) => i.code + (i.detail !== undefined ? '(' + i.detail + ')' : '')).join(' '));
  }
  return parts.join('  ');
}

/**
 * 执行只读检查。**退出码**：0 = 无阻断级问题；1 = 存在 blocksStartup / unloadable
 * （DSH 可能起不来，或这些会话根本读不出来）；2 = 会话根不存在。
 */
export async function runSessionsInspect(options: SessionsInspectOptions, io: SessionsInspectIo): Promise<number> {
  const result = await scanSessionHealth({ homeDir: options.home });
  if (!result.sessionsDirExists) {
    io.error('找不到会话根目录 / sessions root not found: ' + result.sessionsDir);
    io.error('用 --home <DSH_HOME> 指定正确的 DSH home；缺省取 $DSH_HOME（~/.dsh）。');
    return 2;
  }
  const blocking = result.summary.bySeverity.blocksStartup + result.summary.bySeverity.unloadable;
  if (options.json) {
    io.log(JSON.stringify({
      // ok 与退出码**同源**（0 ⟺ 无阻断级问题）：此前恒 true，存在不可加载会话时
      // CI 会看到 ok:true 而退出码 1 —— 两个字段互相矛盾，机器消费者只会信错一个。
      ok: blocking === 0,
      readOnly: true,
      sessionsDir: result.sessionsDir,
      summary: { ...result.summary, untested: result.untested, unreadableEntries: result.unreadableEntries },
      rows: result.rows,
    }, null, 2));
    return blocking > 0 ? 1 : 0;
  }
  io.log('会话根 / sessions root: ' + result.sessionsDir);
  io.log(
    '共 ' + String(result.summary.total) + ' 条会话：'
    + '阻断启动 ' + String(result.summary.bySeverity.blocksStartup)
    + '，不可加载 ' + String(result.summary.bySeverity.unloadable)
    + '，下次请求会失败 ' + String(result.summary.bySeverity.nextRequestFails)
    + '，不可见 ' + String(result.summary.bySeverity.invisible)
    + '，正常 ' + String(result.summary.bySeverity.ok),
  );
  // 「没检查」必须一直可见（设计稿 §10.4：把没检查说成没问题是最严重的谎报）
  io.log(
    '  已做深度校验 ' + String(result.summary.deepVerified)
    + ' 条，未做深度校验 ' + String(result.summary.deepUnverified) + ' 条'
    + (result.untested > 0 ? '，另有 ' + String(result.untested) + ' 条超出扫描上限未体检' : '')
    + (result.unreadableEntries > 0 ? '，读取失败 ' + String(result.unreadableEntries) + ' 项' : ''),
  );
  if (options.action === 'doctor') {
    for (const severity of SESSION_HEALTH_SEVERITIES) {
      if (severity === 'ok') continue;
      const rows = result.rows.filter((row) => row.severity === severity);
      if (rows.length === 0) continue;
      io.log('');
      io.log('== ' + severity + '（' + String(rows.length) + '）==');
      for (const row of rows) io.log('  ' + describeRow(row));
    }
    const ok = result.rows.filter((row) => row.severity === 'ok');
    if (ok.length > 0) io.log('');
    if (ok.length > 0) io.log('== ok（' + String(ok.length) + '）：无需处理 ==');
  } else {
    for (const row of result.rows) io.log('  ' + describeRow(row));
  }
  if (blocking > 0) {
    io.log('');
    io.log('建议：先关掉 DSH，再跑 sessions repair（默认只预览，加 --apply 才落盘）。');
  }
  return blocking > 0 ? 1 : 0;
}
