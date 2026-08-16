/**
 * 可操作错误模型（规范 §23，m6-ui）。
 *
 * 绝不只有 "Something went wrong."：
 *  - 解析错误 → Reason + Suggested action（可操作）；
 *  - 输出前强制脱敏（redact），Secret 永不进入 UI/日志。
 */
import { redact } from '../security/redaction.ts';

/** 可操作错误（UI 渲染为 Reason / Suggested action 两段） */
export interface ActionableError {
  title: string;
  reason: string;
  suggestedAction?: string;
  /** 相关项（如 MCP 服务器名 / 插件包名）；可空 */
  item?: string;
  /** 是否可重试（true 显示重试按钮） */
  retryable: boolean;
}

/** 常见错误 → 建议动作 的规则表（按错误消息子串匹配） */
interface ErrorRule {
  match: (msg: string) => boolean;
  title: string;
  suggestedAction: string;
  retryable: boolean;
}

const ERROR_RULES: readonly ErrorRule[] = [
  {
    match: (m) => /SETTINGS_CONFLICT|revision.*conflict/i.test(m),
    title: '配置已被并发修改',
    suggestedAction: '目标 DSH 的该配置在导入期间被其他进程修改，为避免覆盖请重新导出或手动核对后再试。',
    retryable: true,
  },
  {
    match: (m) => /ImportNotConfirmed|未确认/i.test(m),
    title: '导入未确认',
    suggestedAction: '请在预览页确认导入内容后重试。',
    retryable: true,
  },
  {
    match: (m) => /backup integrity|完整性校验失败|checksum/i.test(m),
    title: '备份完整性校验失败',
    suggestedAction: '备份文件可能已损坏或被篡改，请重新导出备份后再试。',
    retryable: false,
  },
  {
    match: (m) => /schema.*(不支持|超出)|无法导入|Unsupported/i.test(m),
    title: '备份格式版本不受支持',
    suggestedAction: '请升级 DSH Config Manager 或使用相同版本的备份文件。',
    retryable: false,
  },
  {
    match: (m) => /ENOENT|not found|无法读取|不存在/i.test(m),
    title: '文件或路径不存在',
    suggestedAction: '请检查文件路径是否正确、文件是否已被移动或删除。',
    retryable: true,
  },
  {
    match: (m) => /EACCES|permission|权限/i.test(m),
    title: '权限不足',
    suggestedAction: '请检查目标目录的读写权限后重试。',
    retryable: true,
  },
  {
    match: (m) => /install.*(plugin|插件)|needsRestart|重启/i.test(m),
    title: '插件安装需要重启生效',
    suggestedAction: '导入已完成，插件将在重启 DSH 后生效；请在 DSH Desktop 中重启服务。',
    retryable: false,
  },
];

/** 将任意错误转换为可操作错误（消息已脱敏，不泄漏 Secret） */
export function toActionableError(err: unknown, opts?: { item?: string; fallbackTitle?: string }): ActionableError {
  const raw = err instanceof Error ? err.message : String(err ?? '未知错误');
  const message = redact(raw);
  const rule = ERROR_RULES.find((r) => r.match(message));
  return {
    title: rule?.title ?? opts?.fallbackTitle ?? '操作失败',
    reason: message,
    suggestedAction: rule?.suggestedAction,
    item: opts?.item !== undefined ? redact(opts.item) : undefined,
    retryable: rule?.retryable ?? true,
  };
}

/** 格式化为用户可读的多行文本（Reason / Suggested action） */
export function formatActionableError(e: ActionableError): string {
  const lines = [e.title];
  lines.push(`Reason: ${e.reason}`);
  if (e.suggestedAction) lines.push(`Suggested action: ${e.suggestedAction}`);
  if (e.item) lines.push(`Item: ${e.item}`);
  return lines.join('\n');
}
