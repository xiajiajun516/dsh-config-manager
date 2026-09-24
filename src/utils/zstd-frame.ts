/**
 * 多帧 Zstandard 容器的最小纯字节工具（issue #45 P3：改写会话日志首帧 header 的 cwd）。
 *
 * 为什么需要：DSH 的会话日志（session*.jsonl.zstd）是**拼接的多帧 zstd 容器** ——
 * 第 1 帧 = header 行、后续帧 = 事件批（DSH 的 encodeMaterialization 刻意不合并帧边界）。
 * 改写 cwd 必须只重写第 1 帧，其余帧**逐字节**保留；而 Node 的 zstdDecompressSync 虽然
 * 只解第一帧（正好用来读 header），却不提供「第 1 帧到哪结束」的信息，所以这里按 RFC 8878
 * 自己扫帧边界（与 DSH 内部 scanZstdFrames 同算法：帧头 + 块头，不解压块内容）。
 *
 * 分层纪律：本模块是纯函数（零 IO、零 DSH 依赖），**只允许宿主适配器使用** —— core 必须
 * 保持与 DSH 存储格式解耦（AGENTS.md「架构心智」）。上游若给出官方 relocate API，本模块可整体删除。
 */
import { Buffer } from 'node:buffer';
import * as zlib from 'node:zlib';

/** 标准 zstd 帧魔数（小端字节序 28 B5 2F FD）。 */
export const ZSTD_MAGIC = 0xfd2fb528;

/** 帧字节区间（半开区间 [start, end)）。 */
export interface ZstdFrameRange {
  start: number;
  end: number;
}

export interface ZstdScanResult {
  /** 已完整解析的帧（按出现顺序） */
  frames: ZstdFrameRange[];
  /** 容器末尾不完整帧的起始偏移（撕裂日志的修复点）；全部完整时缺省 */
  tornStart?: number;
}

interface ZstdApi {
  zstdCompressSync?: (data: Uint8Array, options?: unknown) => Buffer;
  zstdDecompressSync?: (data: Uint8Array, options?: unknown) => Buffer;
  constants?: { ZSTD_c_checksumFlag?: number };
}

const nodeZstd = zlib as unknown as ZstdApi;

/** 运行时的 Node 是否提供 zstd 编解码（Node 22.15+/24；DSH 自身也依赖它）。 */
export function zstdAvailable(): boolean {
  return typeof nodeZstd.zstdCompressSync === 'function' && typeof nodeZstd.zstdDecompressSync === 'function';
}

/** 把任意字节视图统一成 Buffer（不复制底层数据）。 */
function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * 扫描拼接的 zstd 帧，**不解压块内容**（只走帧头 + 块头）。
 *
 * 语义与 DSH 内部实现一致：魔数不对 / 保留位 / 保留块类型 → 抛错（视为损坏，绝不猜测）；
 * 末尾帧不完整（撕裂日志）→ 返回其起始偏移，不抛错（由调用方决定是否修复）。
 */
export function scanZstdFrames(buffer: Uint8Array, maxFrames: number = Number.POSITIVE_INFINITY): ZstdScanResult {
  const view = toBuffer(buffer);
  const frames: ZstdFrameRange[] = [];
  let offset = 0;
  while (offset < view.length) {
    const start = offset;
    if (view.length - offset < 4) return { frames, tornStart: start };
    if (view.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error('corrupt Zstandard stream: invalid frame magic at byte ' + String(offset));
    }
    offset += 4;
    if (offset === view.length) return { frames, tornStart: start };
    const descriptor = view.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) {
      throw new Error('corrupt Zstandard stream: reserved frame-header bit at byte ' + String(offset - 1));
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (view.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (view.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = view.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) {
        throw new Error('corrupt Zstandard stream: reserved block type at byte ' + String(offset - 3));
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (view.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (view.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

/** 解压**单个**完整帧（内容校验和由 zstd 解码器本身验证）。 */
export function decodeZstdFrame(frame: Uint8Array): Buffer {
  const decode = nodeZstd.zstdDecompressSync;
  if (decode === undefined) throw new Error('zstd decompression is unavailable on this Node runtime');
  return decode(toBuffer(frame));
}

/**
 * 压缩出**单个**带内容校验和的帧（与 DSH 的 CHECKSUM_OPTIONS 同款：写回的内容必须能被
 * DSH 自己的解码路径接受）。
 */
export function encodeZstdFrame(data: Uint8Array): Buffer {
  const encode = nodeZstd.zstdCompressSync;
  if (encode === undefined) throw new Error('zstd compression is unavailable on this Node runtime');
  const checksumFlag = nodeZstd.constants?.ZSTD_c_checksumFlag;
  const options = checksumFlag === undefined ? undefined : { params: { [checksumFlag]: 1 } };
  return encode(toBuffer(data), options);
}

/** 第 1 个完整帧的结束偏移（无完整第 1 帧 → null；损坏 → 抛错）。 */
export function firstFrameEnd(buffer: Uint8Array): number | null {
  const scan = scanZstdFrames(buffer, 1);
  const first = scan.frames[0];
  return first === undefined ? null : first.end;
}
