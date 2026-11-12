/**
 * Trae 2.3.x 的**加密会话库**通道（SQLCipher 4.x 页面布局）—— issue #134。
 *
 * 为什么需要它：Trae 系四个发行版（Trae / Trae CN / TRAE SOLO CN / TRAE SOLO）从 2.3 起把会话从
 * `<User>/globalStorage/state.vscdb` 迁到 `<User>/ModularData/ai-agent/database.db`，**整库
 * SQLCipher 加密**（真机量级约 1.4 GB）。旧通道（read-trae.ts 的 ItemTable）在新版上恒为空 ⇒
 * 用户只看到「nothing to import」，没有任何解释。本模块负责「识别加密库 → 逐页解密出明文库 →
 * 只读读表 → 交出**中性**会话行」；ID/角色/正文的语义映射仍留在 read-trae.ts（口径一处不改）。
 *
 * 页面布局（SQLCipher 4.x，page 4096，每页尾 reserve 80 B = IV(16) + HMAC-SHA512(64)）：
 *   第 1 页  [salt 16][cipher 4000][IV 16][HMAC 64]   ← 前 16 B 是 salt，不是密文
 *   其余页   [cipher 4016][IV 16][HMAC 64]
 * 解密用 `aes-256-cbc` + `setAutoPadding(false)`（CBC 每块独立，页内无需分组边界对齐）；
 * 明文每页可用 4016 B = 4096 − 80，第 1 页明文 `[0,16)` 必须改写成 SQLite 头
 * `SQLite format 3\0`，否则 `node:sqlite` 直接拒开（它只认明文头）。
 *
 * 密钥：raw AES-256（**不是**口令 ⇒ 不做 PBKDF2）。缺省值取参考实现
 * xitula/trae-session-export 公开的常量；环境变量 `DCM_TRAE_DB_KEY`（64 位十六进制）可覆盖。
 * 密钥错/换版必须**可判定**：不校验 HMAC（参考实现同样不校验），而是解密第 1 页后校验明文页头
 * （页大小 / payload 分数 / 保留字节 / 声明页数）—— 错密钥撞过全部判据的概率在 2^-32 量级，
 * 一旦不符即报 `trae-db-key-invalid`，**绝不静默 0 会话**。
 *
 * 三点刻意的取舍（都在 #134 的汇报里写明）：
 *  ① **不额外复制原库**：按页流式解密、直接写出明文库（原库全程只读）。1.4 GB 复制会让磁盘
 *     峰值翻倍，而解密本身已经是逐页 O(1) 内存。
 *  ② 明文只活在本次导入的私有临时目录（`os.tmpdir()/dcm-trae-db-*`），读完即 `rm -rf`；
 *     不落用户可见目录、不进快照、不进日志（本模块**不写日志**，错误只带稳定码与 detail）。
 *  ③ 体积上限**按来源独立**（`TRAE_DB_MAX_BYTES`），**不动** sqlite.ts 的全局
 *     `DEFAULT_MAX_COPY_BYTES`（1 GiB）：那是所有来源共用的兜底，改它会连带放宽别处。
 *
 * 诚实边界：
 *  · 表/列名只有 `chat_session` / `history_v2` / `history_v2.messages.raw_messages[]` 有调研
 *    证据；其余元数据列（会话 id 的关联列、cwd、标题、时间）**没有真机样本** ⇒ 一律按候选列名
 *    逐个自证，命中才用，找不到就交给下游落 `session-missing-cwd`（绝不猜语义）。
 *  · 加密库的 `-wal` 分帧同样是密文且带独立 salt，本版**不合并 WAL**：实时复制可能漏掉最新
 *    尾部，读不到目标表按 `trae-db-schema-mismatch` 可判定失败，绝不假装读到。
 */
import { createDecipheriv } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isAbsoluteFor, joinFor } from './platform-paths.ts';
import type { ForeignPlatform } from './platform-paths.ts';
import { statOrNull } from './session-read.ts';
import { cellBytes, cellText, cellTime, openSqliteReadOnlyEx } from './sqlite.ts';
import type { SqliteHandle, SqliteRow } from './sqlite.ts';
import { isRecord } from '../utils/guards.ts';
import type { ForeignSkip } from './types.ts';

/** 加密库相对 `<User>` 的路径段（4 个发行版共用同一命名） */
export const TRAE_DB_REL_SEGMENTS: readonly string[] = ['ModularData', 'ai-agent', 'database.db'];
/** SQLCipher 4.x 的页大小（该库固定 4096） */
export const TRAE_DB_PAGE_SIZE = 4096;
/** 每页尾保留字节：IV(16) + HMAC-SHA512(64) */
export const TRAE_DB_RESERVE_BYTES = 80;
/** IV 长度（AES 块大小） */
export const TRAE_DB_IV_BYTES = 16;
/** 第 1 页开头的 salt 长度（不是密文，也不参与解密） */
export const TRAE_DB_SALT_BYTES = 16;
/** raw AES-256 密钥长度 */
export const TRAE_DB_KEY_BYTES = 32;
/**
 * 缺省密钥：参考实现 xitula/trae-session-export 公开的 raw key 常量。
 *
 * **为什么可以内置**：它是产品级的固定 key（不是用户口令），参考实现公开分发；本插件只读、
 * 且不写回任何 Trae 数据。换版后 key 变化 ⇒ 页头校验失败 ⇒ `trae-db-key-invalid`（可判定）。
 */
export const TRAE_DB_DEFAULT_KEY = '3605f6691095a993f03d5009c918352ef5be31ae31e8f000212b81ff058da773';
/** 覆盖密钥的环境变量名（只报键名，绝不回显值） */
export const TRAE_DB_KEY_ENV = 'DCM_TRAE_DB_KEY';
/**
 * 加密库的体积上限（**按来源独立**，2 GiB 覆盖 1.4 GB 量级；超限走既有 copy-too-large 语义）。
 * 刻意不碰 sqlite.ts 的 `DEFAULT_MAX_COPY_BYTES`（1 GiB，全局兜底）。
 */
export const TRAE_DB_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** 会话表（调研确证） */
export const TRAE_DB_TABLE_SESSION = 'chat_session';
/** 正文表（调研确证：消息在 `messages` 的 `raw_messages[]`） */
export const TRAE_DB_TABLE_HISTORY = 'history_v2';
/** 表结构**最小**签名：只钉确证过的表与列，其余列按候选自证 */
export const TRAE_DB_REQUIRED_SCHEMA: Readonly<Record<string, readonly string[]>> = {
  [TRAE_DB_TABLE_SESSION]: ['id'],
  [TRAE_DB_TABLE_HISTORY]: ['messages'],
};
/** 会话上限（与 read-trae 的 MAX_SESSIONS 同量级；由调用方再收窄） */
export const TRAE_DB_MAX_SESSIONS = 5000;

/** 真机样本缺失：会话→正文的关联列候选（命中即用） */
const SESSION_JOIN_COLUMNS: readonly string[] = [
  'session_id', 'sessionId', 'chat_session_id', 'chatSessionId', 'conversation_id', 'conversationId',
];
/** cwd 候选（与 read-trae 的 CWD_KEYS 同口径：只认语义明确的键，且必须是绝对路径） */
const SESSION_CWD_COLUMNS: readonly string[] = ['cwd', 'workspace', 'workspace_path', 'workspacePath', 'root_path', 'project_path'];
/** 标题候选 */
const SESSION_TITLE_COLUMNS: readonly string[] = ['title', 'name', 'session_name', 'sessionName'];
/** 时间候选 */
const SESSION_TIME_COLUMNS: readonly string[] = ['created_at', 'createdAt', 'create_time', 'createTime', 'updated_at', 'updatedAt', 'update_time'];
/** 正文容器的候选键（`raw_messages` 是调研确证的第一顺位） */
const MESSAGE_ARRAY_KEYS: readonly string[] = ['raw_messages', 'rawMessages', 'messages'];

/** 明文库头的魔数（16 字节 ASCII，含结尾 NUL） */
const SQLITE_MAGIC = 'SQLite format 3';
/** 页大小字段的「1 表示 65536」约定 */
const PAGE_SIZE_ESCAPE = 1;
/** 明文页里 payload 分数三连（max / min / leaf），SQLite 恒定 64 / 32 / 32 */
const PAYLOAD_FRACTION_MAX = 64;
const PAYLOAD_FRACTION_MIN = 32;
const PAYLOAD_FRACTION_LEAF = 32;

/** 解密/读表失败的**稳定码**（与 types.ts 的 ForeignSkipCode 一一对应） */
export type TraeDbProblemCode =
  | 'trae-db-key-invalid'
  | 'trae-db-too-large'
  | 'trae-db-decrypt-failed'
  | 'trae-db-schema-mismatch';

/** 失败原因（`detail` 只放可枚举的短标签，绝不放密钥/明文片段） */
export interface TraeDbProblem {
  readonly code: TraeDbProblemCode;
  readonly detail: string;
  readonly count?: number | undefined;
}

/** 读表交出的**中性**会话行（ID 校验与角色映射在 read-trae 里做，口径一处不改） */
export interface TraeDbSession {
  readonly id: string;
  readonly cwd?: string | undefined;
  readonly title?: string | undefined;
  readonly createdAt?: number | undefined;
  readonly items: readonly unknown[];
}

/** 一次加密库读取的结果 */
export interface TraeDbReadOutcome {
  readonly sessions: readonly TraeDbSession[];
  readonly problem?: TraeDbProblem | undefined;
  /** 解密出的页数（明文直读时为 undefined） */
  readonly pages?: number | undefined;
  /** `decrypted` = 走解密；`plaintext` = 库本身已是明文（旧版/已被解密的形态） */
  readonly mode?: 'decrypted' | 'plaintext' | undefined;
  /** 消息单元格解析不出的行数（如实计入，绝不伪造正文） */
  readonly dropped?: number | undefined;
  /** 缺 id 而无法建会话的行数 */
  readonly skipped?: number | undefined;
  /** 会话数触顶（调用方的 maxSessions） */
  readonly truncated?: boolean | undefined;
}

/** 读表选项 */
export interface TraeDbReadOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: ForeignPlatform;
  /** 体积上限（缺省 `TRAE_DB_MAX_BYTES`；单测用它造超限，不必造 2 GiB 文件） */
  readonly maxBytes?: number | undefined;
  /** 会话数上限（缺省 `TRAE_DB_MAX_SESSIONS`） */
  readonly maxSessions?: number | undefined;
}

/** 密钥解析结果：要么给出 32 字节 raw key，要么给出可判定失败 */
export type TraeDbKeyResolution =
  | { readonly key: Buffer; readonly source: 'default' | 'env' }
  | { readonly problem: TraeDbProblem };

/** 一个 `<User>` 根下的加密库位置（**绝不硬编码分隔符**） */
export function traeDbPathFor(userDir: string, platform: ForeignPlatform): string {
  return joinFor(platform, userDir, ...TRAE_DB_REL_SEGMENTS);
}

/**
 * 解析密钥：环境变量优先，缺省内置常量。
 *
 * 环境变量**设了但不合法**时直接报 `trae-db-key-invalid`（detail=key-format），
 * 绝不悄悄回落到内置 key —— 那会让「我换了密钥但没生效」变成静默 0 会话。
 */
export function resolveTraeDbKey(env: Readonly<Record<string, string | undefined>>): TraeDbKeyResolution {
  const raw = env[TRAE_DB_KEY_ENV];
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed === '') return { key: Buffer.from(TRAE_DB_DEFAULT_KEY, 'hex'), source: 'default' };
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return { problem: { code: 'trae-db-key-invalid', detail: 'key-format' } };
  }
  return { key: Buffer.from(trimmed, 'hex'), source: 'env' };
}

/** 一个页的密文区间（第 1 页跳过 salt；其余页从头开始） */
function cipherRange(index: number): { start: number; end: number } {
  return { start: index === 0 ? TRAE_DB_SALT_BYTES : 0, end: TRAE_DB_PAGE_SIZE - TRAE_DB_RESERVE_BYTES };
}

/** 页尾 IV 的区间（两种页都一样：倒数 80 B 的前 16 B） */
function ivRange(): { start: number; end: number } {
  const start = TRAE_DB_PAGE_SIZE - TRAE_DB_RESERVE_BYTES;
  return { start, end: start + TRAE_DB_IV_BYTES };
}

/** 一页的 CBC 解密（关闭填充；异常一律 null —— 调用方转成稳定码，绝不抛出） */
function decryptBlock(key: Buffer, iv: Buffer, block: Buffer): Buffer | null {
  if (block.length === 0 || block.length % TRAE_DB_IV_BYTES !== 0) return null;
  try {
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    decipher.setAutoPadding(false);
    return Buffer.concat([decipher.update(block), decipher.final()]);
  } catch {
    return null;
  }
}

/**
 * 校验解密出的第 1 页明文（`plain` = 明文页的 `[16, 4016)`，即文件 offset 16 起的 4000 B）。
 *
 * 返回 null = 通过；返回字符串 = 可判定的失败 detail（一律映射成 `trae-db-key-invalid`）。
 */
export function validateTraePageOne(plain: Buffer, pages: number | null): string | null {
  if (plain.length < 16) return 'short-first-page';
  const rawPageSize = plain.readUInt16BE(0);
  const pageSize = rawPageSize === PAGE_SIZE_ESCAPE ? 65536 : rawPageSize;
  if (pageSize !== TRAE_DB_PAGE_SIZE) return 'page-size-mismatch';
  // 保留字节写在 SQLite 头的 offset 20（明文里的 [4]）：SQLCipher 4 为 80；0 也接受（个别库不写）
  const reserve = plain[4] ?? 0;
  if (reserve !== 0 && reserve !== TRAE_DB_RESERVE_BYTES) return 'reserve-mismatch';
  if (plain[5] !== PAYLOAD_FRACTION_MAX || plain[6] !== PAYLOAD_FRACTION_MIN || plain[7] !== PAYLOAD_FRACTION_LEAF) {
    return 'payload-fraction-mismatch';
  }
  if (pages !== null) {
    const declared = plain.readUInt32BE(12);
    if (declared !== 0 && declared !== pages) return 'page-count-mismatch';
  }
  return null;
}

/** 读满一页（short read 一律 null，调用方按截断处理） */
async function readExact(handle: Awaited<ReturnType<typeof fs.open>>, buf: Buffer, position: number): Promise<boolean> {
  let offset = 0;
  while (offset < buf.length) {
    const { bytesRead } = await handle.read(buf, offset, buf.length - offset, position + offset);
    if (bytesRead <= 0) return false;
    offset += bytesRead;
  }
  return true;
}

/** 读文件开头（用于明文魔数探测与单页探测） */
async function readHead(file: string, length: number): Promise<Buffer | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(file, 'r');
    const buf = Buffer.alloc(length);
    const ok = await readExact(handle, buf, 0);
    return ok ? buf : null;
  } catch {
    return null;
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
  }
}

/** 库本身是否已经是明文 SQLite（旧版 / 已被第三方解密的形态） */
async function isPlaintextSqlite(file: string): Promise<boolean> {
  const head = await readHead(file, 16);
  return head !== null && head.length === 16 && head.toString('latin1').startsWith(SQLITE_MAGIC);
}

/**
 * 把一个加密库逐页解密成明文库（**覆盖写 `destPath`**，目标不存在才写）。
 *
 * 只读源库；内存占用恒为一页；失败时返回稳定码，**不留半截明文**（由调用方的临时目录统一清理）。
 */
export async function decryptTraeDatabase(
  sourcePath: string,
  destPath: string,
  key: Buffer,
): Promise<{ ok: true; pages: number } | { ok: false; problem: TraeDbProblem }> {
  const stat = await statOrNull(sourcePath);
  if (stat === null || !stat.isFile()) {
    return { ok: false, problem: { code: 'trae-db-decrypt-failed', detail: 'unreadable' } };
  }
  if (stat.size === 0) return { ok: false, problem: { code: 'trae-db-decrypt-failed', detail: 'empty-file' } };
  // 对齐检查优先于解密：截断的库按「可判定失败」处理，不拿补 0 的明文去骗 node:sqlite
  if (stat.size % TRAE_DB_PAGE_SIZE !== 0) {
    return { ok: false, problem: { code: 'trae-db-decrypt-failed', detail: 'truncated-database', count: stat.size } };
  }
  const pages = stat.size / TRAE_DB_PAGE_SIZE;
  const reserve = Buffer.alloc(TRAE_DB_RESERVE_BYTES); // 明文页尾不再承载 IV/HMAC ⇒ 全 0
  const page = Buffer.alloc(TRAE_DB_PAGE_SIZE);
  let source: Awaited<ReturnType<typeof fs.open>> | null = null;
  let dest: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    source = await fs.open(sourcePath, 'r');
    dest = await fs.open(destPath, 'wx');
    let firstPlain: Buffer | null = null;
    for (let index = 0; index < pages; index += 1) {
      if (!await readExact(source, page, index * TRAE_DB_PAGE_SIZE)) {
        return { ok: false, problem: { code: 'trae-db-decrypt-failed', detail: 'short-read', count: index } };
      }
      const iv = ivRange();
      const range = cipherRange(index);
      const plain = decryptBlock(key, page.subarray(iv.start, iv.end), page.subarray(range.start, range.end));
      if (plain === null) {
        return { ok: false, problem: { code: 'trae-db-decrypt-failed', detail: 'cipher-rejected', count: index } };
      }
      if (index === 0) {
        firstPlain = plain;
        // 明文页 [0,16) 必须是 SQLite 头（salt 已被丢弃），否则 node:sqlite 拒开
        const first = Buffer.concat([Buffer.from(SQLITE_MAGIC + '\0', 'latin1'), plain]);
        // 我们每页恒留 80 B 保留区 ⇒ 头里的「每页保留字节数」必须声明 80（真实 SQLCipher 明文本就是 80；
        // 个别库不写这个字段，若不归一化，node:sqlite 会把页尾 80 B 当成有效内容而判库损坏）
        first[20] = TRAE_DB_RESERVE_BYTES;
        await dest.write(first);
      } else {
        await dest.write(plain);
      }
      await dest.write(reserve);
    }
    const mismatch = firstPlain === null ? 'missing-first-page' : validateTraePageOne(firstPlain, pages);
    if (mismatch !== null) {
      return { ok: false, problem: { code: 'trae-db-key-invalid', detail: mismatch } };
    }
    return { ok: true, pages };
  } catch (err) {
    return {
      ok: false,
      problem: { code: 'trae-db-decrypt-failed', detail: err instanceof Error ? 'io-error' : 'io-error' },
    };
  } finally {
    if (dest !== null) await dest.close().catch(() => undefined);
    if (source !== null) await source.close().catch(() => undefined);
  }
}

/**
 * 探测期的**单页**校验（detect 用）：只解密第 1 页、只读 4 KB，用来抢在 build 之前把
 * 「密钥错 / 截断 / 超限」这三类可判定失败摆到界面上（#134 的第二半）。
 *
 * 返回 null = 没发现问题（或库不存在 / 已是明文）。
 */
export async function probeTraeEncryptedDatabase(
  sourcePath: string,
  options: Pick<TraeDbReadOptions, 'env' | 'maxBytes'>,
): Promise<TraeDbProblem | null> {
  const stat = await statOrNull(sourcePath);
  if (stat === null || !stat.isFile()) return null;
  const maxBytes = options.maxBytes ?? TRAE_DB_MAX_BYTES;
  if (stat.size > maxBytes) {
    return { code: 'trae-db-too-large', detail: 'copy-too-large', count: stat.size };
  }
  const resolution = resolveTraeDbKey(options.env);
  if ('problem' in resolution) return resolution.problem;
  if (await isPlaintextSqlite(sourcePath)) return null;
  if (stat.size === 0) return { code: 'trae-db-decrypt-failed', detail: 'empty-file' };
  if (stat.size % TRAE_DB_PAGE_SIZE !== 0) {
    return { code: 'trae-db-decrypt-failed', detail: 'truncated-database', count: stat.size };
  }
  const head = await readHead(sourcePath, TRAE_DB_PAGE_SIZE);
  if (head === null) return { code: 'trae-db-decrypt-failed', detail: 'unreadable' };
  const iv = ivRange();
  const range = cipherRange(0);
  const plain = decryptBlock(resolution.key, head.subarray(iv.start, iv.end), head.subarray(range.start, range.end));
  if (plain === null) return { code: 'trae-db-decrypt-failed', detail: 'cipher-rejected' };
  const mismatch = validateTraePageOne(plain, stat.size / TRAE_DB_PAGE_SIZE);
  return mismatch === null ? null : { code: 'trae-db-key-invalid', detail: mismatch };
}

/** 标识符引用（表/列名来自本模块的常量与库自报的列清单，仍按 SQLite 规则转义） */
function quoteIdent(name: string): string {
  return '"' + name.split('"').join('""') + '"';
}

/** 选中列清单（显式列名 ⇒ 缺列不会被动变成 `*`） */
function selectList(columns: readonly string[]): string {
  return columns.map(quoteIdent).join(', ');
}

/** 候选列里第一个真实存在的列 */
function firstPresent(actual: readonly string[], candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    if (actual.includes(candidate)) return candidate;
  }
  return null;
}

/** 单元格 → JSON（TEXT 与 BLOB 都试；解析不出 → undefined，绝不伪造） */
function jsonCell(row: SqliteRow, key: string): unknown {
  const text = cellText(row, key);
  if (text !== undefined && text !== '') {
    try {
      return JSON.parse(text);
    } catch {
      // 落到 BLOB 分支再试一次
    }
  }
  const bytes = cellBytes(row, key);
  if (bytes === undefined) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

/** 正文容器 → 消息数组（`raw_messages` 第一顺位；数组本身也接受） */
export function messageItemsOf(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return null;
  for (const key of MESSAGE_ARRAY_KEYS) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
  }
  return null;
}

/** 在一行上取「第一个有内容且是绝对路径」的候选列 */
function absoluteCellOf(row: SqliteRow, column: string | null, platform: ForeignPlatform): string | undefined {
  if (column === null) return undefined;
  const value = (cellText(row, column) ?? '').trim();
  if (value === '' || !isAbsoluteFor(platform, value)) return undefined;
  return value;
}

/** 在一行上取第一个有内容的候选列（标题/时间用） */
function firstCellOf(row: SqliteRow, column: string | null): string | undefined {
  if (column === null) return undefined;
  const value = (cellText(row, column) ?? '').trim();
  return value === '' ? undefined : value;
}

/** 读表并把「会话行 + 正文行」拼成中性会话列表（失败一律稳定码，绝不抛出） */
function readSchema(
  db: SqliteHandle,
  options: TraeDbReadOptions,
): Pick<TraeDbReadOutcome, 'sessions' | 'problem' | 'dropped' | 'skipped' | 'truncated'> {
  const tables = db.tables();
  if (tables === null) return { sessions: [], problem: { code: 'trae-db-schema-mismatch', detail: 'table-list-failed' } };
  for (const [table, columns] of Object.entries(TRAE_DB_REQUIRED_SCHEMA)) {
    if (!tables.includes(table)) {
      return { sessions: [], problem: { code: 'trae-db-schema-mismatch', detail: 'missing-table-' + table } };
    }
    const actual = db.columns(table);
    if (actual === null) return { sessions: [], problem: { code: 'trae-db-schema-mismatch', detail: 'column-list-failed-' + table } };
    for (const column of columns) {
      if (!actual.includes(column)) {
        return { sessions: [], problem: { code: 'trae-db-schema-mismatch', detail: 'missing-column-' + table + '.' + column } };
      }
    }
  }
  const sessionCols = db.columns(TRAE_DB_TABLE_SESSION) ?? [];
  const historyCols = db.columns(TRAE_DB_TABLE_HISTORY) ?? [];
  const sessionRows = db.all('SELECT ' + selectList(sessionCols) + ' FROM ' + quoteIdent(TRAE_DB_TABLE_SESSION));
  if (sessionRows === null) return { sessions: [], problem: { code: 'trae-db-schema-mismatch', detail: 'session-read-failed' } };
  const historyRows = db.all('SELECT ' + selectList(historyCols) + ' FROM ' + quoteIdent(TRAE_DB_TABLE_HISTORY));
  if (historyRows === null) return { sessions: [], problem: { code: 'trae-db-schema-mismatch', detail: 'history-read-failed' } };

  const joinColumn = firstPresent(historyCols, SESSION_JOIN_COLUMNS);
  const itemsByKey = new Map<string, unknown[]>();
  const orderedKeys: string[] = [];
  let dropped = 0;
  for (const row of historyRows) {
    const items = messageItemsOf(jsonCell(row, 'messages'));
    if (items === null) { dropped += 1; continue; }
    const key = joinColumn === null ? '' : (cellText(row, joinColumn) ?? '');
    const existing = itemsByKey.get(key);
    if (existing === undefined) {
      itemsByKey.set(key, [...items]);
      orderedKeys.push(key);
    } else {
      existing.push(...items);
    }
  }

  // 没有关联列时**不猜**：只有唯一一个会话行才敢把全部正文归给它（否则=可判定失败）
  let fallbackItems: unknown[] | null = null;
  if (joinColumn === null) {
    if (sessionRows.length > 1) {
      return { sessions: [], problem: { code: 'trae-db-schema-mismatch', detail: 'session-join-column-missing' }, dropped };
    }
    fallbackItems = orderedKeys.flatMap((key) => itemsByKey.get(key) ?? []);
  }

  const cwdColumn = firstPresent(sessionCols, SESSION_CWD_COLUMNS);
  const titleColumn = firstPresent(sessionCols, SESSION_TITLE_COLUMNS);
  const timeColumn = firstPresent(sessionCols, SESSION_TIME_COLUMNS);
  const maxSessions = options.maxSessions ?? TRAE_DB_MAX_SESSIONS;
  const sessions: TraeDbSession[] = [];
  let skipped = 0;
  let truncated = false;
  for (const row of sessionRows) {
    if (sessions.length >= maxSessions) { truncated = true; break; }
    const id = (cellText(row, 'id') ?? '').trim();
    if (id === '') { skipped += 1; continue; }
    const cwd = absoluteCellOf(row, cwdColumn, options.platform);
    const title = firstCellOf(row, titleColumn);
    const createdAt = timeColumn === null ? undefined : cellTime(row, timeColumn);
    const items = fallbackItems ?? itemsByKey.get(id) ?? [];
    sessions.push({
      id,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(title !== undefined ? { title: title.slice(0, 200) } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
      items,
    });
  }
  return { sessions, dropped, skipped, truncated };
}

/**
 * 读一个加密库：体积上限 → 密钥 → 解密（或明文直读）→ 只读读表 → 删临时明文。
 *
 * **绝不抛出**：所有失败都收成 `problem`（稳定码 + detail），调用方据此推 skip。
 */
export async function readTraeEncryptedDatabase(
  sourcePath: string,
  options: TraeDbReadOptions,
): Promise<TraeDbReadOutcome> {
  const stat = await statOrNull(sourcePath);
  if (stat === null || !stat.isFile()) {
    return { sessions: [], problem: { code: 'trae-db-decrypt-failed', detail: 'missing' } };
  }
  const maxBytes = options.maxBytes ?? TRAE_DB_MAX_BYTES;
  if (stat.size > maxBytes) {
    return { sessions: [], problem: { code: 'trae-db-too-large', detail: 'copy-too-large', count: stat.size } };
  }
  const resolution = resolveTraeDbKey(options.env);
  if ('problem' in resolution) return { sessions: [], problem: resolution.problem };

  const plaintextSource = await isPlaintextSqlite(sourcePath);
  const dir = plaintextSource ? null : await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-trae-db-'));
  try {
    let target = sourcePath;
    let pages: number | undefined;
    let mode: 'decrypted' | 'plaintext' = 'plaintext';
    if (dir !== null) {
      target = path.join(dir, 'database.plain.db');
      const decrypted = await decryptTraeDatabase(sourcePath, target, resolution.key);
      if (!decrypted.ok) return { sessions: [], problem: decrypted.problem };
      pages = decrypted.pages;
      mode = 'decrypted';
    }
    // 明文库是我们自己的临时副本（无 -wal/-shm）：上限与加密库同档，避免第二次复制撞全局 1 GiB
    const opened = await openSqliteReadOnlyEx(target, { maxCopyBytes: maxBytes });
    if (opened.db === null) {
      return { sessions: [], problem: { code: 'trae-db-schema-mismatch', detail: 'open-' + String(opened.problem ?? 'failed') } };
    }
    try {
      return { ...readSchema(opened.db, options), pages, mode };
    } finally {
      opened.db.close();
    }
  } catch {
    return { sessions: [], problem: { code: 'trae-db-decrypt-failed', detail: 'io-error' } };
  } finally {
    // 明文只在本次导入内存在：无论成败都删（失败也不留半截）
    if (dir !== null) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** problem → skip（origin 固定 'trae'；count 只在有意义时带上） */
export function traeDbSkipOf(problem: TraeDbProblem): ForeignSkip {
  return {
    code: problem.code,
    origin: 'trae',
    detail: problem.detail,
    ...(problem.count !== undefined ? { count: problem.count } : {}),
  };
}
