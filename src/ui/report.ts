/**
 * 报告渲染（规范 §21 导出报告 / §22 导入报告 / §17 回滚报告，m6-ui）。
 *
 * 纯文本渲染：输出用户可读的多行文本（未来 React 客户端可直接替换为组件渲染）。
 * 导入报告按分区统计：从 ExecutedItem.itemId 前缀推断所属分区（与 adapters 的 id 规则一致）。
 */
import type { SectionId } from '../schema/types.ts';
import type {
  ExecutedItem, ExportReport, ImportResult, RollbackReport,
} from '../core/types.ts';
import type { ImportResultAction, ImportSectionStat } from './types.ts';

/* ---------------- §21 导出报告 ---------------- */

export function renderExportReport(report: ExportReport): string {
  const lines: string[] = ['Backup Created', ''];
  lines.push('Included:');
  for (const { section, counts } of report.included) {
    const detail = Object.entries(counts)
      .map(([k, v]) => `${v} ${k}`)
      .join(', ');
    lines.push(`  ✓ ${section}${detail !== '' ? ` (${detail})` : ''}`);
  }
  lines.push('');
  if (report.excluded.length > 0) {
    lines.push('Excluded:');
    for (const s of report.excluded) lines.push(`  ○ ${s}`);
    lines.push('');
  }
  lines.push('Security:');
  lines.push(`  ✓ API Keys excluded: ${report.security.secretsExcluded ? 'yes' : 'no'}`);
  lines.push(`  ✓ Contains secrets: ${report.security.containsSecrets ? 'yes (encrypted)' : 'no'}`);
  lines.push(`  ✓ Encrypted: ${report.security.encrypted ? 'yes' : 'no'}`);
  if (report.security.redactedHits > 0) lines.push(`  ⚠ ${report.security.redactedHits} sensitive field(s) redacted`);
  lines.push('');
  lines.push(`File: ${report.file.name} (${formatBytes(report.file.sizeBytes)})`);
  for (const w of report.warnings) lines.push(`  ⚠ ${w}`);
  return lines.join('\n');
}

/* ---------------- §22 导入报告 ---------------- */

/** 从 itemId 前缀推断所属分区（与 adapters id 规则对齐；未知归 'other'） */
export function sectionFromItemId(itemId: string): SectionId | 'other' {
  if (itemId.startsWith('settings:')) return 'settings';
  if (itemId.startsWith('ui:')) return 'ui';
  if (itemId.startsWith('provider:')) return 'providers';
  if (itemId.startsWith('plugin:') || itemId.startsWith('patch:')) return 'plugins';
  if (itemId.startsWith('mcp:')) return 'mcp';
  if (itemId.startsWith('prompt:')) return 'prompts';
  if (itemId.startsWith('workspace:')) return 'workspaces';
  if (itemId.startsWith('secret:')) return 'credentialsStatus';
  if (itemId.startsWith('skills:')) return 'skills';
  if (itemId.startsWith('agentPresets:')) return 'agentPresets';
  if (itemId.startsWith('pluginFiles:')) return 'pluginFiles';
  if (itemId.startsWith('sessions:')) return 'sessions';
  return 'other';
}

/** 按分区聚合执行结果（统计 + 明细） */
export function importSectionStats(executed: readonly ExecutedItem[]): ImportSectionStat[] {
  const bySection = new Map<string, ImportSectionStat>();
  for (const e of executed) {
    const section = sectionFromItemId(e.itemId);
    let stat = bySection.get(section);
    if (!stat) {
      stat = { section: section as SectionId, ok: 0, skipped: 0, failed: 0, items: [] };
      bySection.set(section, stat);
    }
    if (e.status === 'ok') stat.ok += 1;
    else if (e.status === 'skipped') stat.skipped += 1;
    else stat.failed += 1;
    stat.items.push(e);
  }
  return [...bySection.values()];
}

/** 导入报告渲染（含回滚状态；§22 动作按钮由 suggestedActions 给出） */
export function renderImportReport(result: ImportResult): string {
  const lines: string[] = [result.ok ? 'Import Complete' : 'Import Failed', ''];
  const stats = importSectionStats(result.executed);
  for (const s of stats) {
    const parts: string[] = [];
    if (s.ok > 0) parts.push(`✓ ${s.ok} imported/restored`);
    if (s.skipped > 0) parts.push(`- ${s.skipped} skipped`);
    if (s.failed > 0) parts.push(`✗ ${s.failed} failed`);
    lines.push(`${s.section}: ${parts.join(' ') || 'no changes'}`);
    // 失败项给出可操作原因（§23）
    for (const it of s.items) {
      if (it.status === 'failed') {
        lines.push(`  Reason: ${it.message ?? '未知原因'}`);
      }
    }
  }
  if (result.missingSecrets.length > 0) {
    lines.push(`Secrets: ⚠ ${result.missingSecrets.length} credentials need to be entered`);
  }
  if (result.needsRestart) {
    lines.push('Restart required: 插件/MCP 变更将在重启 DSH 后生效');
  }
  for (const w of result.warnings) lines.push(`⚠ ${w}`);
  if (result.rollback) {
    lines.push('');
    lines.push(renderRollbackReport(result.rollback));
  }
  return lines.join('\n');
}

/** 结果页动作按钮（§22：Fix Issues / View Details / Done） */
export function suggestedActions(result: ImportResult): ImportResultAction[] {
  const actions: ImportResultAction[] = [];
  if (result.executed.some((e) => e.status === 'failed')) actions.push('fixIssues');
  if (result.executed.length > 0 || result.warnings.length > 0) actions.push('viewDetails');
  actions.push('done');
  return actions;
}

/* ---------------- §17 回滚报告 ---------------- */

/** 回滚报告渲染（full / partial + 人工恢复清单） */
export function renderRollbackReport(rr: RollbackReport): string {
  if (rr.full) {
    return 'Rollback: 已完整恢复导入前的配置。';
  }
  const lines = ['Rollback partially completed.'];
  lines.push('These items may require manual recovery:');
  for (const f of rr.failed) {
    lines.push(`  - ${f.item}: ${f.reason}${f.manualHint ? ` (${f.manualHint})` : ''}`);
  }
  if (rr.restored.length > 0) lines.push(`Restored: ${rr.restored.length} item(s)`);
  return lines.join('\n');
}

/* ---------------- 工具 ---------------- */

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
