/**
 * 附件引用抽取（P1 附件分区）：会话日志文本 → 被对话真正引用过的 attachmentId 集合。
 *
 * 为什么单独一层纯函数：
 *  · 附件库里 233 MB 有 68 MB 是**孤儿**（没有任何会话引用）；「只带对话用到的」这条需求
 *    的判定完全由本模块决定，必须能用固定输入复现，而不是藏在 adapter 的 IO 里；
 *  · 抽取规则要防误命中：日志里粘的源码会包含 `x-oss-content-sha256`、`sha256: ''` 之类
 *    片段，只按 /sha256:[a-f0-9]{64}/ 扫会把它们当附件 id。因此**只认 JSON 字段形态**
 *    `"attachmentId":"sha256:<64hex>"`。
 *
 * 形状依据（宿主）：`@deepseek-ai/dsh-attachment-local` 的 FILE_ID_PATTERN =
 * /^sha256:([a-f0-9]{64})$/ —— 图片与文件附件共用同一个 id 形状，故一个正则覆盖两类。
 */

/**
 * 附件引用的锚定形态：JSON 字段 attachmentId 的值，后面**可选**紧跟 mediaType / bytes。
 *
 * 为什么把后两个字段并进同一个正则：子行要显示「这是什么」，而 64 位 sha 对用户没有信息量。
 * 日志里的形状是 `"attachment":{"attachmentId":"sha256:…","mediaType":"image/jpeg","bytes":123}`，
 * 两个后续字段都按「紧邻」匹配 —— 字段顺序不同或缺失时只是取不到，绝不猜。
 */
const ATTACHMENT_REF_FIELD = new RegExp(
  '"attachmentId"\\s*:\\s*"(sha256:[a-f0-9]{64})"'
  + '(?:\\s*,\\s*"mediaType"\\s*:\\s*"([A-Za-z0-9.+\\/-]{1,64})")?'
  + '(?:\\s*,\\s*"bytes"\\s*:\\s*(\\d{1,15}))?',
  'g',
);

/** 单段 64 位十六进制（附件在库里的物理目录名/文件名）。 */
const HEX_SEGMENT = /^[a-f0-9]{64}$/;

/** 严格 id 形状（宿主 FILE_ID_PATTERN 同款）。 */
const ID_SHAPE = /^sha256:[a-f0-9]{64}$/;

/** 日志里声明的附件元信息（取不到就是取不到，不猜默认值）。 */
export interface AttachmentRefMeta {
  /** 媒体类型（`image/jpeg` 这类；只在字段紧邻时取到） */
  mediaType?: string
  /** 字节数（同上） */
  bytes?: number
}

/**
 * 从一段会话日志文本里抽取全部被引用的附件，附带日志声明的类型/字节数。
 *
 * 同一 id 在同一份日志里出现多次时取**第一条**带 mediaType 的记录（同一条消息的重试会把
 * 同一附件写多遍，先到的那条就是用户真正发出去的那次）。
 */
export function extractAttachmentRefs(text: string): Map<string, AttachmentRefMeta> {
  const out = new Map<string, AttachmentRefMeta>();
  if (text === '') return out;
  // 正则带 g 且有 lastIndex 状态：每次新建实例，避免跨调用串状态。
  const re = new RegExp(ATTACHMENT_REF_FIELD.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const id = match[1]!;
    if (!ID_SHAPE.test(id)) continue;
    const mediaType = match[2];
    const rawBytes = match[3];
    const prev = out.get(id);
    const bytes = rawBytes === undefined ? undefined : Number(rawBytes);
    out.set(id, {
      ...(mediaType !== undefined ? { mediaType } : (prev?.mediaType !== undefined ? { mediaType: prev.mediaType } : {})),
      ...(bytes !== undefined && Number.isFinite(bytes) ? { bytes } : (prev?.bytes !== undefined ? { bytes: prev.bytes } : {})),
    });
  }
  return out;
}

/** 从一段会话日志文本里抽取全部被引用的 attachmentId（去重；只要 id 的调用方用这个）。 */
export function extractAttachmentIds(text: string): Set<string> {
  return new Set(extractAttachmentRefs(text).keys());
}

/** 合法 attachmentId → 64 位十六进制（不合法返回 null，绝不猜）。 */
export function hexOfAttachmentId(id: string): string | null {
  return ID_SHAPE.test(id) ? id.slice('sha256:'.length) : null;
}

/** 64 位十六进制 → 规范 attachmentId（不合法返回 null）。 */
export function attachmentIdOfHex(hex: string): string | null {
  return HEX_SEGMENT.test(hex) ? `sha256:${hex}` : null;
}

/**
 * 附件库里的相对路径 → attachmentId。
 *
 * 库布局（宿主 `dsh-attachment-local`）：图片 `v1/objects/<2>/<sha>`、
 * 文件对象 `v1/file-objects/<2>/<sha>`、文件本体 `v1/files/<2>/<sha>/<name>`。
 * 三者的共同点是**路径里必有一段完整的 64 位十六进制**（分片目录只有 2 位，不会误命中），
 * 因此按「首个 64 位 hex 段」判定，不硬编码深度 —— 宿主换布局也不会静默失配。
 */
export function attachmentIdOfRelPath(relativePath: string): string | null {
  const parts = relativePath.replace(/\\/g, '/').split('/');
  for (const part of parts) {
    if (HEX_SEGMENT.test(part)) return `sha256:${part}`;
  }
  return null;
}
