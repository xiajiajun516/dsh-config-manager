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
 * 附件引用的**锚点**：JSON 字段形态的 attachmentId（防误命中的唯一判据，见文件头）。
 *
 * 只做定位，不在这里抓字段 —— 宿主写出的附件对象里字段顺序是
 * `attachmentId → mediaType → bytes → width/height → name`，name 排在最后，
 * 用「紧邻字段」正则根本抓不到（实测 129 条引用全部带 name，旧正则一条都取不到）。
 * 因此锚点之后按**有界 JSON 对象窗口**再抓字段，字段顺序无关。
 */
const ATTACHMENT_ID_ANCHOR = /"attachmentId"\s*:\s*"(sha256:[a-f0-9]{64})"/g;

/** 锚点向前回退找对象起始的最大距离（宿主字段都在同一对象内，实测 ≤ 200 B）。 */
const ANCHOR_LOOKBACK = 512;

/**
 * 对象窗口上限（含对象本身）：宿主附件对象实测 ≤ 400 B（带 width/height/originalDimensions），
 * 2048 只是防御性上限 —— 超出就取不到字段，绝不为了找 name 扫整份日志。
 */
const OBJECT_WINDOW_MAX = 2048;

/** 媒体类型：只认 MIME 形状（带空格/引号的东西不是它，宁可不显示）。 */
const MEDIA_TYPE_FIELD = /"mediaType"\s*:\s*"([A-Za-z0-9.+/-]{1,64})"/;
/** 字节数：只认非负整数。 */
const BYTES_FIELD = /"bytes"\s*:\s*(\d{1,15})/;
/**
 * 附件真名（宿主 ImageAttachmentRef.name / FileAttachmentRef.name）。
 *
 * 形状限制的理由：这个名字会直接渲染成行标题，所以拒绝控制字符，也拒绝路径分隔符
 * （宿主声明 name 已剥掉本地路径信息；带分隔符的只能是坏数据或伪造，宁可退回 MIME/短哈希）。
 */
const NAME_FIELD = /"name"\s*:\s*"([^"\\/\u0000-\u001f]{1,200})"/;

/** 单段 64 位十六进制（附件在库里的物理目录名/文件名）。 */
const HEX_SEGMENT = /^[a-f0-9]{64}$/;

/** 严格 id 形状（宿主 FILE_ID_PATTERN 同款）。 */
const ID_SHAPE = /^sha256:[a-f0-9]{64}$/;

/** 日志里声明的附件元信息（取不到就是取不到，不猜默认值）。 */
export interface AttachmentRefMeta {
  /** 媒体类型（`image/jpeg` 这类） */
  mediaType?: string
  /** 字节数 */
  bytes?: number
  /**
   * 附件真名（用户发出去时的文件名，如 `P-01-after.png`）。
   *
   * 这是选择器里附件的**首选展示名**：64 位哈希没有信息量，`image/png` 又让人分不清
   * 同名类型的两张图。老日志/没有 name 的附件就是取不到 —— 退回 MIME 或短哈希，不编造。
   */
  name?: string
}

/**
 * 锚点所在的**那个** JSON 对象的边界（半开区间）；判定不了一律 null。
 *
 * 为什么要真做括号匹配而不是取「锚点前后固定窗口」：同一行里可能有多个对象
 * （消息 → 内容数组 → 多个附件），固定窗口会把**上一个对象的 name** 抓给下一个 id ——
 * 显示成别人的文件名比显示 MIME 更糟。所以先向前找到最近的 `{`（中途遇见 `}` 就说明
 * 锚点不在对象里），再向后做字符串感知的括号匹配，窗口超限就放弃。
 */
function jsonObjectAround(text: string, anchor: number): { start: number; end: number } | null {
  let start = -1;
  const from = Math.max(0, anchor - ANCHOR_LOOKBACK);
  for (let i = anchor - 1; i >= from; i -= 1) {
    const ch = text.charAt(i);
    if (ch === '}') return null;
    if (ch === '{') { start = i; break; }
  }
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  const limit = Math.min(text.length, start + OBJECT_WINDOW_MAX);
  for (let i = start; i < limit; i += 1) {
    const ch = text.charAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  return null;
}

/** 从一个附件对象的原文里抓字段（字段顺序无关；形状不符 = 取不到）。 */
function metaOfObject(body: string): AttachmentRefMeta {
  const out: AttachmentRefMeta = {};
  const mediaType = MEDIA_TYPE_FIELD.exec(body)?.[1];
  if (mediaType !== undefined) out.mediaType = mediaType;
  const rawBytes = BYTES_FIELD.exec(body)?.[1];
  if (rawBytes !== undefined) {
    const bytes = Number(rawBytes);
    if (Number.isSafeInteger(bytes) && bytes >= 0) out.bytes = bytes;
  }
  const name = NAME_FIELD.exec(body)?.[1];
  if (name !== undefined) out.name = name;
  return out;
}

/**
 * 从一段会话日志文本里抽取全部被引用的附件，附带日志声明的类型/字节数/真名。
 *
 * 同一 id 在同一份日志里出现多次时逐字段取**第一条**非空声明（同一条消息的重试会把
 * 同一附件写多遍，先到的那条就是用户真正发出去的那次）。
 */
export function extractAttachmentRefs(text: string): Map<string, AttachmentRefMeta> {
  const out = new Map<string, AttachmentRefMeta>();
  if (text === '') return out;
  // 正则带 g 且有 lastIndex 状态：每次新建实例，避免跨调用串状态。
  const re = new RegExp(ATTACHMENT_ID_ANCHOR.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const id = match[1]!;
    if (!ID_SHAPE.test(id)) continue;
    const window = jsonObjectAround(text, match.index);
    const meta = window === null ? {} : metaOfObject(text.slice(window.start, window.end));
    const prev = out.get(id);
    out.set(id, {
      ...(meta.mediaType !== undefined ? { mediaType: meta.mediaType } : (prev?.mediaType !== undefined ? { mediaType: prev.mediaType } : {})),
      ...(meta.bytes !== undefined ? { bytes: meta.bytes } : (prev?.bytes !== undefined ? { bytes: prev.bytes } : {})),
      ...(meta.name !== undefined ? { name: meta.name } : (prev?.name !== undefined ? { name: prev.name } : {})),
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
