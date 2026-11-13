/**
 * DSH 自身会话日志的读盘层（dsh / dsh4 **共用同一扫描器**，按日志代次过滤）。
 *
 * 真值（chat-import discovery.mjs:165-169 + sources/dsh.mjs:8-25；read-vault §10.2 dsh 行；
 * read-sessions-manager 第 23 行）：
 *   <DSH_HOME>/sessions/<projectKey>/<sessionId>/session[.vN].jsonl[.zstd]
 *   <DSH_HOME> = $DSH_HOME（非空即替换）|| <home>/.dsh
 *   代次：dsh = V3 族（v0 无后缀 … v3），dsh4 = V4 —— **同一份目录的两个代次**，用 format 过滤。
 *
 * **本机实测（measured 的依据，2026-10-05）**：`~/.dsh/sessions` 下 501 个会话日志的
 * 文件名/首帧版本逐一对应 —— session.jsonl.zstd=version 0、session.v3.jsonl.zstd=version 3、
 * session.v4.jsonl.zstd=version 4，且三条都带 id 与 cwd。⇒ 代次由**首帧 header 的 version**
 * 判定（文件名只作扫描过滤），v0..v3 → dsh、v4 → dsh4。
 * `session.jsonl.decoded.jsonl` 是本仓自己的解码产物（不是会话日志），**刻意不匹配**。
 *
 * 为什么是**逐字节直通**（不重新编码成 IR 再合成）：这份字节就是 DSH 自己的存储格式，
 * 目标机读它比读我们重编的更保真（竞品 sources/dsh.mjs 同款语义；truth-table 的 dynamic 明写
 * 「逐字节直通，不重新编码」）。翻译层（dsh.ts）只做三件事：id/cwd 自证、代次必须等于目标机
 * 的 SESSION_FORMAT_VERSION、relativePath 按 `projectKey(cwd)/id/<原名>` 归位。
 *
 * 内存纪律：单文件 32 MiB、单批 256 MiB、最多 2000 条；触顶**如实报码**（source-unreadable 的
 * detail = too-large / max-logs-reached / session-byte-budget），绝不静默截断。
 */
import { envValue, joinFor, normalizePlatform } from './platform-paths.ts';
import { listDirNames, listFileNames, readBytesSafe, statOrNull } from './session-read.ts';
import { readLogHeaderFromBytes } from '../utils/session-log.ts';
import type { SessionLogHeader } from '../utils/session-log.ts';
import type { RootProbeOptions, SessionReadOutcome } from './session-source.ts';
import type { ForeignSkip } from './types.ts';

export const DSH_HOME_ENV = 'DSH_HOME';
export const DSH_DEFAULT_DIR = '.dsh';
export const DSH_SESSIONS_SUBDIR = 'sessions';

/** 代次族：v3 = V3 族（v0–v3），v4 = V4 */
export type DshGeneration = 'v3' | 'v4';

const DEFAULT_MAX_LOGS = 2000;
const DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const HEADER_WINDOW_BYTES = 64 * 1024;

export interface DshResolvedHome { readonly home: string; readonly overridden: boolean }

/** DSH_HOME（非空即替换；只报键名）→ 默认 ~/.dsh */
export function resolveDshHome(opts: RootProbeOptions): DshResolvedHome {
  const platform = normalizePlatform(opts.platform);
  const explicit = envValue(opts.env, DSH_HOME_ENV);
  if (explicit !== undefined) return { home: explicit, overridden: true };
  return { home: joinFor(platform, opts.homeDir, DSH_DEFAULT_DIR), overridden: false };
}

/** 单根：<DSH_HOME>/sessions（桌面端 %APPDATA%/dsh-desktop/harness 是**另一个域**，不在自动根里） */
export function dshSessionsRoot(opts: RootProbeOptions): string {
  const platform = normalizePlatform(opts.platform);
  return joinFor(platform, resolveDshHome(opts).home, DSH_SESSIONS_SUBDIR);
}

export function dshProbePaths(opts: RootProbeOptions): string[] {
  return [dshSessionsRoot(opts)];
}

/** 会话日志文件名判据（**不接受** *.decoded.jsonl：那是本仓的解码产物，不是会话日志） */
const DSH_LOG_NAME_RE = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/;

/** 文件名里的版本（无后缀 = v0）；不是会话日志 → undefined */
export function dshVersionOfLogName(name: string): number | undefined {
  const m = DSH_LOG_NAME_RE.exec(name);
  if (m === null) return undefined;
  const raw = m[1];
  if (raw === undefined) return 0;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** 版本 → 代次族（0..3 → v3；4 → v4；其余/未知 → undefined，**绝不猜**） */
export function dshGenerationOfVersion(version: number | undefined): DshGeneration | undefined {
  if (version === undefined || !Number.isSafeInteger(version) || version < 0) return undefined;
  if (version <= 3) return 'v3';
  if (version === 4) return 'v4';
  return undefined;
}

/** 一条待直通的会话日志（**原始字节 + 首帧 header 自证的 id/cwd/version**） */
export interface DshSessionLogFile {
  readonly id: string;
  readonly cwd: string;
  readonly version: number;
  /** 源文件名（relativePath 的末段原样保留：代次后缀必须与版本一致） */
  readonly name: string;
  readonly data: Uint8Array;
}

/** 首帧 header：zstd 容器走 session-log 的解码器；明文 JSONL（无 .zstd）取首行 */
export function dshHeaderOfLogBytes(bytes: Uint8Array): SessionLogHeader | undefined {
  const decoded = readLogHeaderFromBytes(bytes);
  if (decoded !== undefined) return decoded;
  const window = bytes.subarray(0, Math.min(bytes.length, HEADER_WINDOW_BYTES));
  const text = new TextDecoder().decode(window);
  const nl = text.indexOf(String.fromCharCode(10));
  const line = (nl < 0 ? text : text.slice(0, nl)).trim();
  if (line === '' || line.startsWith('{') === false) return undefined;
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const rec = parsed as Record<string, unknown>;
    const out: SessionLogHeader = {};
    for (const key of ['id', 'cwd'] as const) {
      const value = rec[key];
      if (typeof value === 'string' && value !== '') out[key] = value;
    }
    const version = rec['version'];
    if (typeof version === 'number' && Number.isSafeInteger(version) && version >= 0) out.version = version;
    return out.id === undefined && out.cwd === undefined && out.version === undefined ? undefined : out;
  } catch {
    return undefined;
  }
}

export interface DshReadOptions extends RootProbeOptions {
  /** 只要这一代次族（dsh = v3，dsh4 = v4） */
  readonly generation: DshGeneration;
  readonly maxLogs?: number | undefined;
  readonly maxFileBytes?: number | undefined;
  readonly maxTotalBytes?: number | undefined;
}

/**
 * 扫描 <DSH_HOME>/sessions（两层目录 + 一层文件），按**首帧版本**做代次过滤。
 * 别的代次的日志**不是错误**（那是另一个来源的域）：只计数（extraCounts），不进 skipped。
 */
export async function readDshLogs(opts: DshReadOptions): Promise<SessionReadOutcome<DshSessionLogFile>> {
  const platform = normalizePlatform(opts.platform);
  const resolved = resolveDshHome(opts);
  const findings: ForeignSkip[] = [];
  if (resolved.overridden) findings.push({ code: 'source-location-overridden', origin: DSH_HOME_ENV });
  const maxLogs = opts.maxLogs ?? DEFAULT_MAX_LOGS;
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const root = dshSessionsRoot(opts);
  const files: DshSessionLogFile[] = [];
  const seen = new Set<string>();
  let scanned = 0;
  let otherGeneration = 0;
  let bytesRead = 0;
  let truncated: 'max-logs' | 'byte-budget' | 'too-large' | undefined;

  outer: for (const projectKey of await listDirNames(root)) {
    const projectDir = joinFor(platform, root, projectKey);
    for (const sessionDirName of await listDirNames(projectDir)) {
      const sessionDir = joinFor(platform, projectDir, sessionDirName);
      const names = await listFileNames(sessionDir, (name) => dshVersionOfLogName(name) !== undefined);
      for (const name of names) {
        if (scanned >= maxLogs) { truncated = 'max-logs'; break outer; }
        const abs = joinFor(platform, sessionDir, name);
        const st = await statOrNull(abs);
        if (st === null || !st.isFile()) continue;
        scanned += 1;
        if (st.size > maxFileBytes) { truncated = truncated ?? 'too-large'; continue; }
        if (bytesRead + st.size > maxTotalBytes) { truncated = 'byte-budget'; break outer; }
        const data = await readBytesSafe(abs, maxFileBytes);
        if (data === null) {
          findings.push({ code: 'source-unreadable', origin: name, detail: 'log-read-error' });
          continue;
        }
        const header = dshHeaderOfLogBytes(data);
        if (header === undefined) {
          findings.push({ code: 'source-unreadable', origin: name, detail: 'log-header-unreadable' });
          continue;
        }
        const generation = dshGenerationOfVersion(header.version);
        if (generation === undefined) {
          findings.push({ code: 'source-unreadable', origin: name, detail: 'log-version-unknown' });
          continue;
        }
        if (generation !== opts.generation) { otherGeneration += 1; continue; }
        if (header.id === undefined || header.cwd === undefined || header.version === undefined) {
          findings.push({ code: 'source-unreadable', origin: name, detail: 'log-header-incomplete' });
          continue;
        }
        if (seen.has(header.id)) {
          /**
           * 同一 id 出现在两个会话目录（复制/迁移残留）：只保留第一个，但**必须留码** ——
           * 静默丢会让「导入少了一条会话」在计划里无从解释（本文件顶部第 21-22 行的硬约束）。
           */
          findings.push({ code: 'session-id-conflict', origin: header.id, detail: 'duplicate-session-id' });
          continue;
        }
        seen.add(header.id);
        bytesRead += data.length;
        files.push({ id: header.id, cwd: header.cwd, version: header.version, name, data });
      }
    }
  }

  if (truncated === 'too-large') {
    findings.push({
      code: 'source-unreadable',
      origin: 'dsh:' + opts.generation,
      detail: 'log-too-large',
      count: maxFileBytes,
    });
  }
  if (truncated === 'max-logs' || truncated === 'byte-budget') {
    findings.push({
      code: 'source-unreadable',
      origin: 'dsh:' + opts.generation,
      detail: truncated === 'max-logs' ? 'max-logs-reached' : 'session-byte-budget',
      count: truncated === 'max-logs' ? maxLogs : maxTotalBytes,
    });
  }
  files.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    files,
    readFindings: findings,
    extraCounts: {
      'dsh.logs.scanned': scanned,
      'dsh.logs.selected': files.length,
      'dsh.logs.otherGeneration': otherGeneration,
    },
  };
}
