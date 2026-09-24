/**
 * DSH 会话日志（session*.jsonl.zstd，拼接的多帧 zstd 容器）的**字节级**工具（宿主专用）。
 *
 * 分层纪律（AGENTS.md「会话归位的字节改写只允许在宿主适配器」）：core **禁止** import 本模块 ——
 * 会话日志的容器格式属 DSH 存储细节。只有宿主侧可以碰字节：src/index.ts 的 DshSessionStoreFacade
 * （在线归位）与 src/cli/ 的离线修复（DSH 已经起不来时唯一的补救通道）。
 *
 * 纯字节的帧扫描/编解码在 utils/zstd-frame.ts；本模块只加「会话 header 语义」：
 * 取首帧 cwd、把首帧 cwd 改成新值（其余帧逐字节流式保留）、发布前自检、多 generation 一起改 + 失败回滚。
 */
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { SESSION_LOG_NAME_RE } from '../core/session-select.ts';
import type { SessionRewriteReason } from '../core/types.ts';
import { decodeZstdFrame, encodeZstdFrame, firstFrameEnd, scanZstdFrames, zstdAvailable } from './zstd-frame.ts';

/** 项目目录段的合法形状（与 DSH projectKey 同名）；只接受 --…-- ，绝不拼出会话根之外的路径。 */
export const PROJECT_KEY_RE = /^--[A-Za-z0-9._~-]*--$/;

/** 首帧（header 行）的正常大小上限：窗口按需放大，超过上限一律不猜（frame-too-large）。 */
const FIRST_FRAME_WINDOW_BYTES = 64 * 1024;
const MAX_FIRST_FRAME_WINDOW_BYTES = 4 * 1024 * 1024;
/** 发布前自检的尾部抽查字节数（首尾各一段）。 */
const SPOT_CHECK_BYTES = 4 * 1024;

/** 单文件改写结果（ok=false 时 reason 为机器可读原因）。 */
export type SessionLogRewrite =
  | { ok: true; previousCwd: string }
  | { ok: false; reason: SessionRewriteReason };

/** 一个会话目录的改写结果（多 generation 一起改）。 */
export type SessionLogDirRewrite =
  | { ok: true; rewritten: string[] }
  | { ok: false; reason: SessionRewriteReason };

/** 是否是会话日志文件名（判据不写死：session.jsonl / session.v3.jsonl.zstd 都算）。 */
export function isSessionLogName(name: string): boolean {
  return SESSION_LOG_NAME_RE.test(name);
}

/** 目录里按名字排序的会话日志文件（同一会话可能有多个 generation，必须一起处理）。 */
export function sessionLogNames(names: readonly string[]): string[] {
  return names.filter((name) => SESSION_LOG_NAME_RE.test(name)).sort();
}

/**
 * 只读：从会话日志**字节**里取出首帧 header 的 cwd。
 * 解不出来（缺 zstd 能力 / 非 zstd / 首帧不完整 / 非单行 JSON / 无 cwd）→ undefined：
 * 调用方按「无法判定」处理，绝不猜（猜错会让 DSH 下次启动直接报 corrupt session log）。
 */
export function readLogCwdFromBytes(bytes: Uint8Array): string | undefined {
  return readLogHeaderFromBytes(bytes)?.cwd;
}

/** 首帧 header 里我们关心的字段（全部可选；读不到就是 undefined，绝不猜）。 */
export interface SessionLogHeader {
  /** 会话 id（DSH 只认它；'session-<uuid>' 与裸 '<uuid>' 两种形态并存） */
  id?: string;
  /** 会话的工作目录 */
  cwd?: string;
  /** 会话来源；'subagent' = 子代理会话（DSH 工作区列表**不**单独显示它，只作为父对话的下一级） */
  origin?: string;
  /** 子代理会话所属的**父对话** id（origin === 'subagent' 时存在） */
  parentSessionId?: string;
}

/**
 * 只读：解出会话日志**首帧 header 的字段**。
 *
 * 解不出来（缺 zstd 能力 / 非 zstd / 首帧不完整 / 非单行 JSON）→ undefined：调用方按
 * 「无法判定」处理。为什么要 origin/parentSessionId（真机事故）：DSH 工作区只显示
 * origin !== 'subagent' 的会话，子代理会话挂在父对话之下；导出时只带子会话、不带父对话，
 * 导入后在工作区里就一条都看不见 —— 见 adapters/sessions.ts 的父链连带导出。
 */
export function readLogHeaderFromBytes(bytes: Uint8Array): SessionLogHeader | undefined {
  if (!zstdAvailable()) return undefined;
  try {
    const scan = scanZstdFrames(bytes, 1);
    const first = scan.frames[0];
    if (first === undefined) return undefined;
    const text = decodeZstdFrame(bytes.subarray(first.start, first.end)).toString('utf8');
    const line = text.endsWith('\n') ? text.slice(0, -1) : text;
    if (line === '' || line.includes('\n')) return undefined;
    const parsed: unknown = JSON.parse(line);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const rec = parsed as Record<string, unknown>;
    const out: SessionLogHeader = {};
    for (const key of ['id', 'cwd', 'origin'] as const) {
      const value = rec[key];
      if (typeof value === 'string' && value !== '') out[key] = value;
    }
    // 父对话 id 在**磁盘 header** 里叫 parentSession；DSH 的 RPC 投影才改名为 parentSessionId
    // （真机实测：只认后者一个都认不出来 → 父链连带会静默失效）。两种写法都认。
    for (const key of ['parentSession', 'parentSessionId'] as const) {
      const value = rec[key];
      if (typeof value === 'string' && value !== '') { out.parentSessionId = value; break; }
    }
    return out;
  } catch {
    return undefined;
  }
}

/** 从磁盘上读某个会话日志文件的首帧 cwd（只读前 64 KB，绝不把整棵树读进内存）。 */
export async function readLogFileCwd(absPath: string): Promise<string | undefined> {
  if (!zstdAvailable()) return undefined;
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(absPath, 'r');
  } catch {
    return undefined;
  }
  try {
    const buf = Buffer.alloc(FIRST_FRAME_WINDOW_BYTES);
    const read = await handle.read(buf, 0, buf.length, 0);
    return readLogCwdFromBytes(buf.subarray(0, read.bytesRead));
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => {});
  }
}

/** 处理部分写入（EINTR / 短写）：一次 write 不保证写完整个 Buffer。 */
async function writeAllBytes(handle: Awaited<ReturnType<typeof fs.open>>, data: Buffer): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const written = await handle.write(data, offset, data.length - offset);
    if (written.bytesWritten <= 0) throw new Error('short write');
    offset += written.bytesWritten;
  }
}

/**
 * 改写**单个**会话日志文件的首帧 header cwd；成功时回传原 cwd（供调用方回滚）。
 *
 * 安全序列（任一环节不过就不发布）：
 *  1. 定位第 1 帧（窗口按需扩大；异常大窗口 → frame-too-large，不猜）；
 *  2. 解出 header 行：必须是单行 JSON 对象且有 cwd（否则 invalid-header / cwd-mismatch）；
 *  3. 重新序列化后把 cwd 改回原值必须与原对象**深度相等**（防止序列化悄悄改动其它字段）；
 *  4. 用与 DSH 同款的带校验和帧重压缩 → 写同目录临时文件（.tmp 不匹配会话日志判据）→
 *     原文件尾部**流式**拷贝（不整文件进内存）；
 *  5. 发布前自检：总长度 + 首帧 cwd + 尾部首尾抽查一致；通过才 rename 覆盖。
 */
export async function rewriteSessionLogFile(absPath: string, newCwd: string): Promise<SessionLogRewrite> {
  if (!zstdAvailable()) return { ok: false, reason: 'unavailable' };
  let handle;
  try {
    handle = await fs.open(absPath, 'r');
  } catch {
    return { ok: false, reason: 'no-log' };
  }
  try {
    const st = await handle.stat();
    const size = st.size;
    let window = Math.min(FIRST_FRAME_WINDOW_BYTES, size);
    let prefix: Buffer | undefined;
    let frameEnd = 0;
    for (;;) {
      const buf = Buffer.alloc(window);
      const read = await handle.read(buf, 0, window, 0);
      const slice = buf.subarray(0, read.bytesRead);
      let scan;
      try {
        scan = scanZstdFrames(slice, 1);
      } catch {
        return { ok: false, reason: 'not-zstd' };
      }
      const first = scan.frames[0];
      if (first !== undefined) {
        prefix = slice;
        frameEnd = first.end;
        break;
      }
      if (window >= size) return { ok: false, reason: 'torn-frame' };
      if (window >= MAX_FIRST_FRAME_WINDOW_BYTES) return { ok: false, reason: 'frame-too-large' };
      window = Math.min(window * 4, size, MAX_FIRST_FRAME_WINDOW_BYTES);
    }
    let headerText: string;
    try {
      headerText = decodeZstdFrame(prefix.subarray(0, frameEnd)).toString('utf8');
    } catch {
      return { ok: false, reason: 'not-zstd' };
    }
    const hadNewline = headerText.endsWith('\n');
    const line = hadNewline ? headerText.slice(0, -1) : headerText;
    if (line === '' || line.includes('\n')) return { ok: false, reason: 'invalid-header' };
    let header: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, reason: 'invalid-header' };
      }
      header = parsed as Record<string, unknown>;
    } catch {
      return { ok: false, reason: 'invalid-header' };
    }
    const current = header['cwd'];
    if (typeof current !== 'string' || current === '') return { ok: false, reason: 'cwd-mismatch' };
    if (current === newCwd) return { ok: true, previousCwd: current };
    const nextLine = JSON.stringify({ ...header, cwd: newCwd }) + (hadNewline ? '\n' : '');
    let roundTrip: Record<string, unknown>;
    try {
      roundTrip = JSON.parse(nextLine) as Record<string, unknown>;
    } catch {
      return { ok: false, reason: 'invalid-header' };
    }
    roundTrip['cwd'] = current;
    if (!isDeepStrictEqual(roundTrip, header)) return { ok: false, reason: 'invalid-header' };
    let newFrame: Buffer;
    try {
      newFrame = encodeZstdFrame(Buffer.from(nextLine, 'utf8'));
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    // 先把读句柄关掉：Windows 上仍被占用的文件无法被 rename 覆盖（实测 EPERM）。
    // 后续尾部拷贝由 createReadStream 自己开句柄。
    await handle.close();
    const temp = join(dirname(absPath), '.cm-rewrite-' + randomBytes(6).toString('hex') + '.tmp');
    const expectedSize = newFrame.length + (size - frameEnd);
    try {
      const out = await fs.open(temp, 'wx', 0o600);
      try {
        await writeAllBytes(out, newFrame);
        if (size > frameEnd) {
          const tail = createReadStream(absPath, { start: frameEnd });
          try {
            for await (const chunk of tail) await writeAllBytes(out, chunk as Buffer);
          } finally {
            tail.destroy();
          }
        }
        await out.sync();
      } finally {
        await out.close();
      }
    } catch {
      await fs.rm(temp, { force: true }).catch(() => {});
      return { ok: false, reason: 'write-failed' };
    }
    const verified = await verifyRewrittenFile(temp, absPath, expectedSize, newFrame.length, frameEnd, newCwd);
    if (!verified) {
      await fs.rm(temp, { force: true }).catch(() => {});
      return { ok: false, reason: 'verify-failed' };
    }
    try {
      await fs.rename(temp, absPath);
    } catch {
      await fs.rm(temp, { force: true }).catch(() => {});
      return { ok: false, reason: 'write-failed' };
    }
    return { ok: true, previousCwd: current };
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * 发布前自检：长度符合预期 + 首帧 cwd 已是新值 + 尾部首尾各抽查一段与原文件逐字节一致。
 * （尾部是流式逐字节拷贝，长度 + 首尾抽查足以抓住截断/错位这类真实失败；不做全量比对以免大文件再读一遍。）
 */
async function verifyRewrittenFile(
  tempPath: string,
  origPath: string,
  expectedSize: number,
  newTailStart: number,
  oldTailStart: number,
  newCwd: string,
): Promise<boolean> {
  try {
    const [st, origSt] = await Promise.all([fs.stat(tempPath), fs.stat(origPath)]);
    if (st.size !== expectedSize) return false;
    // 首帧长度变了 → 临时文件的尾部起点与原文不同，必须成对比较相同长度的对应区间
    const tailLength = st.size - newTailStart;
    if (tailLength !== origSt.size - oldTailStart) return false;
    if (tailLength > 0) {
      const probe = Math.min(SPOT_CHECK_BYTES, tailLength);
      const spots = [
        { mine: newTailStart, theirs: oldTailStart },
        { mine: st.size - probe, theirs: origSt.size - probe },
      ];
      for (const spot of spots) {
        const mine = Buffer.alloc(probe);
        const theirs = Buffer.alloc(probe);
        const [a, b] = await Promise.all([fs.open(tempPath, 'r'), fs.open(origPath, 'r')]);
        try {
          await a.read(mine, 0, probe, spot.mine);
          await b.read(theirs, 0, probe, spot.theirs);
        } finally {
          await a.close();
          await b.close();
        }
        if (!mine.equals(theirs)) return false;
      }
    }
    const headLength = Math.min(FIRST_FRAME_WINDOW_BYTES, st.size);
    const head = Buffer.alloc(headLength);
    const fh = await fs.open(tempPath, 'r');
    try {
      await fh.read(head, 0, headLength, 0);
    } finally {
      await fh.close();
    }
    const end = firstFrameEnd(head.subarray(0, headLength));
    if (end === null) return false;
    const text = decodeZstdFrame(head.subarray(0, end)).toString('utf8');
    const parsed: unknown = JSON.parse(text.trim());
    return parsed !== null && typeof parsed === 'object' && (parsed as { cwd?: unknown }).cwd === newCwd;
  } catch {
    return false;
  }
}

/**
 * 改写一个**会话目录**下全部 generation 的首帧 cwd。
 *
 * 多 generation 中后一个失败 → 把已改写的回滚回各自原 cwd，并报失败原因（绝不留半套：
 * header 与目录位置不一致会让 DSH 下次启动直接报 corrupt session log）。
 */
export async function rewriteSessionLogDir(dir: string, newCwd: string): Promise<SessionLogDirRewrite> {
  if (!zstdAvailable()) return { ok: false, reason: 'unavailable' };
  let names: string[];
  try {
    names = sessionLogNames(await fs.readdir(dir));
  } catch {
    return { ok: false, reason: 'no-log' };
  }
  if (names.length === 0) return { ok: false, reason: 'no-log' };
  const done: { abs: string; previousCwd: string }[] = [];
  for (const name of names) {
    const abs = join(dir, name);
    const one = await rewriteSessionLogFile(abs, newCwd);
    if (!one.ok) {
      for (const entry of done) await rewriteSessionLogFile(entry.abs, entry.previousCwd);
      return { ok: false, reason: one.reason };
    }
    done.push({ abs, previousCwd: one.previousCwd });
  }
  return { ok: true, rewritten: done.map((entry) => entry.abs) };
}
