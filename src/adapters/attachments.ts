/**
 * attachments 分区 adapter（P1，默认关）：只带走**被对话真正引用过**的附件。
 *
 * 为什么不整目录搬：本机实测 `$DSH_HOME/attachments` 233 MB / 1374 个对象，其中 68 MB 是
 * 没有任何会话引用的**孤儿**（删除会话后留下的对象）。整库备份会把孤儿一起搬去新机，
 * 用户付出体积与拷贝时间却得不到任何可看的东西。
 *
 * 判据来源：会话日志里的 `"attachmentId":"sha256:<64hex>"`（见 `utils/attachment-refs.ts`）。
 * 只看**日志文本**，不看文件时间、不看最近使用 —— 「用过」是唯一可复现的口径。
 *
 * 收窄范围：默认口径 = 本次导出**选中的会话**（`options.includeItems.sessions`，与
 * sessions adapter 同一份单元 id `<projectKey>/<sessionId>`）。会话分区未选 / 选空 ⇒
 * 本分区一条都不带并告警（附件脱离会话没有意义）。
 * `export.sessions.limit`（最新 N 个）**不重复实现**：那是按 mtime 排序的选择，本分区
 * 不复刻排序规则，而是如实告警「按全部会话收集，未按最新 N 个收窄」——宁可多带。
 *
 * 失败方向：会话日志读不出来 / zstd 解不开 ⇒ **退回整库 + 明确告警**（keep=null）。
 * 宁可多带 233 MB，也不静默交出一个「备份成功但图片全丢」的包。
 */
import { FileCollectionAdapter } from './file-collection.ts';
import { listFilesDetailed } from './link-report.ts';
import { msgOf } from '../core/messages.ts';
import './messages.ts';
import { isSessionLogFileName, normalizeSessionLimit, sessionIdKey } from '../core/session-select.ts';
import { attachmentIdOfRelPath, extractAttachmentIds } from '../utils/attachment-refs.ts';
import { ZSTD_MAGIC, decodeZstdFrame, scanZstdFrames, zstdAvailable } from '../utils/zstd-frame.ts';
import type { ExportOptions, HostContext } from '../core/types.ts';
import { toPosixRel } from './units.ts';

/** 逐批并发读日志的批大小：会话库可能有上千个日志，一次性开满会打爆 libuv 线程池。 */
const READ_BATCH = 8;

/** 前 4 字节是否为 zstd 帧魔数（小端 0x28 0xb5 0x2f 0xfd）。 */
function hasZstdMagic(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  return bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd
    && ZSTD_MAGIC === 0xfd2fb528;
}

/** 日志文件 → 该文件引用的 attachmentId 集合（读不出 / 解不开返回 null，由调用方降级）。 */
async function referencedIdsOfLog(ctx: HostContext, homeRel: string): Promise<Set<string> | null> {
  let bytes: Uint8Array;
  try {
    bytes = await ctx.fs.readFile(homeRel);
  } catch {
    return null;
  }
  const out = new Set<string>();
  let scan: ReturnType<typeof scanZstdFrames>;
  try {
    scan = scanZstdFrames(bytes);
  } catch {
    return null; // 帧头损坏：该文件判为不可读，交由调用方降级（绝不当成「零引用」）
  }
  const frames = scan.frames;
  if (frames.length === 0) {
    // 有 zstd 魔数却一帧都切不出来 = 日志损坏。**不能**当成「零引用」：
    // 那会让一次坏日志静默缩小备份范围（用户看到「成功」而图片没进包）。
    if (hasZstdMagic(bytes)) return null;
    // 非 zstd 会话日志（历史明文层级）：直接按文本抽，不用解压。
    for (const id of extractAttachmentIds(Buffer.from(bytes).toString('utf8'))) out.add(id);
    return out;
  }
  for (const frame of frames) {
    try {
      const text = decodeZstdFrame(bytes.subarray(frame.start, frame.end)).toString('utf8');
      for (const id of extractAttachmentIds(text)) out.add(id);
    } catch {
      // 单帧解不开：该文件整体判为不可读（不拿半份引用当「完整」）
      return null;
    }
  }
  return out;
}

export class AttachmentsAdapter extends FileCollectionAdapter {
  readonly id = 'attachments' as const;
  readonly displayName = 'Attachments';
  readonly defaultIncluded = false;
  readonly portability = 'deviceSpecific' as const;
  readonly baseDir = 'attachments';

  /** 单元 = 一个附件对象（路径里那段 64 位 hex 反推出的 attachmentId）。 */
  protected override unitIdOf(relativePath: string): string {
    return attachmentIdOfRelPath(toPosixRel(relativePath)) ?? toPosixRel(relativePath);
  }

  protected override async restrictUnits(
    ctx: HostContext,
    rels: readonly string[],
    options: ExportOptions,
  ): Promise<{ keep: Set<string> | null; warnings: string[] } | null> {
    const msg = msgOf(ctx);
    const present = new Set<string>();
    for (const rel of rels) present.add(this.unitIdOf(this.relPathOf(rel)));

    // ① 选中会话：键缺省 = 全量；空数组 = 该分区一条都不带（与基类 allow 语义一致）。
    const sessionAllow = options.includeItems?.['sessions'];
    if (Array.isArray(sessionAllow) && sessionAllow.length === 0) {
      return { keep: new Set<string>(), warnings: [msg('export.attachmentsNoSessions')] };
    }
    const warnings: string[] = [];
    const limit = normalizeSessionLimit(options.sessions?.limit);
    if (limit !== undefined && limit >= 0 && !Array.isArray(sessionAllow)) {
      warnings.push(msg('export.attachmentsLimitIgnored'));
    }
    // includeItems 的单元 id 带分区前缀（sessions:<projectKey>/<sessionId>），先剥前缀再归一
    const unitOf = (raw: string): string => {
      const stripped = raw.startsWith('sessions:') ? raw.slice('sessions:'.length) : raw;
      return sessionIdKey(stripped);
    };
    const allowedUnits = Array.isArray(sessionAllow) ? new Set(sessionAllow.map(unitOf)) : null;

    // ② 枚举会话日志（home 相对 'sessions/…'），按会话单元收窄
    let logs: string[];
    try {
      const listing = await listFilesDetailed(ctx.fs, 'sessions');
      logs = listing.paths.filter((rel) => isSessionLogFileName(toPosixRel(rel).split('/').pop() ?? ''));
      if (allowedUnits !== null) {
        logs = logs.filter((rel) => {
          const parts = toPosixRel(rel).split('/');
          return parts.length >= 3 && allowedUnits.has(sessionIdKey(`${parts[1]}/${parts[2]}`));
        });
      }
    } catch {
      return { keep: null, warnings: [msg('export.attachmentsScanUnreadable')] };
    }

    // ③ 读日志抽引用（不可读 / 不可解压 ⇒ 整批退回全库，绝不静默少带）
    if (!zstdAvailable() && logs.length > 0) {
      return { keep: null, warnings: [msg('export.attachmentsNoZstd')] };
    }
    const referenced = new Set<string>();
    let failed = 0;
    for (let i = 0; i < logs.length; i += READ_BATCH) {
      const batch = logs.slice(i, i + READ_BATCH);
      const results = await Promise.all(batch.map((rel) => referencedIdsOfLog(ctx, toPosixRel(rel))));
      for (const ids of results) {
        if (ids === null) {
          failed += 1;
          continue;
        }
        for (const id of ids) referenced.add(id);
      }
    }
    if (failed > 0) {
      return { keep: null, warnings: [msg('export.attachmentsScanFailed', { count: String(failed) })] };
    }

    // ④ 只留「被引用 且 本机确实存在」的对象
    const keep = new Set<string>();
    let missing = 0;
    for (const id of referenced) {
      if (present.has(id)) keep.add(id);
      else missing += 1;
    }
    warnings.push(msg('export.attachmentsReferenced', {
      count: String(keep.size),
      total: String(present.size),
      missing: String(missing),
    }));
    return { keep, warnings };
  }
}
