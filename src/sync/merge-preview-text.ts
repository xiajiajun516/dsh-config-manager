import { redact } from '../security/redaction.ts';

/** 单侧预览文本上限（2 KiB **字符**预算）：超出截断并追加省略号。 */
export const MERGE_PREVIEW_TEXT_LIMIT = 2048;

/** 严格 UTF-8 解码器：非法字节序列直接抛错（用于区分文本与二进制文件冲突）。 */
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * 预览文本统一出口：先 redact（敏感值绝不回传浏览器），再截断到 2 KiB。
 *
 * 顺序恒为「先 redact 再截断」：反过来会把跨边界的敏感值切成半个形状，让脱敏匹配不到它
 * （等于把秘密截一半发出去）。redact 之后的剩余文本已不含秘密形状，截断才安全。
 */
export function finalizePreviewText(text: string): string {
  const masked = redact(text);
  return masked.length > MERGE_PREVIEW_TEXT_LIMIT ? `${masked.slice(0, MERGE_PREVIEW_TEXT_LIMIT)}…` : masked;
}

/** 把任意冲突侧值转成**可读字符串**；二进制只回传形状与字节数，绝不回传原始值对象。 */
export function previewTextOf(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return finalizePreviewText(value);
  if (value instanceof Uint8Array) {
    try {
      return finalizePreviewText(STRICT_UTF8.decode(value));
    } catch {
      // 二进制内容解码只会得到乱码（同样误导用户）→ 只回传形状；JSON 是数据形态，不是文案
      return JSON.stringify({ binary: true, bytes: value.length });
    }
  }
  try {
    return finalizePreviewText(JSON.stringify(value) ?? '');
  } catch {
    return finalizePreviewText(String(value));
  }
}
