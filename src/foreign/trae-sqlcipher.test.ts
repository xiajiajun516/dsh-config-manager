/**
 * Trae 2.3.x 加密会话库（SQLCipher 4.x 页面布局）的读盘层测试。
 *
 * 本机**没有安装 Trae**（也就没有真机样本）⇒ 夹具一律用 node:crypto **正向造出**
 * SQLCipher 形态（4096 页、每页尾 80 B = IV16 + HMAC512、第 1 页前 16 B 是 salt），
 * 再用 node:sqlite 建出的**真明文库**作为解密目标 —— 这样「解密 → 打开 → 读表」整条链
 * 都是真跑，而不是断言我们自己写死的常量。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { normalizePlatform } from './platform-paths.ts';
import { sqliteCapability } from './sqlite.ts';
import {
  TRAE_DB_DEFAULT_KEY,
  TRAE_DB_KEY_ENV,
  TRAE_DB_MAX_BYTES,
  TRAE_DB_PAGE_SIZE,
  TRAE_DB_RESERVE_BYTES,
  decryptTraeDatabase,
  messageItemsOf,
  probeTraeEncryptedDatabase,
  readTraeEncryptedDatabase,
  resolveTraeDbKey,
  traeDbPathFor,
  traeDbSkipOf,
  validateTraePageOne,
} from './trae-sqlcipher.ts';

const HOST = normalizePlatform(process.platform);
const CWD = HOST === 'win32' ? 'C:\\work\\trae' : '/work/trae';
const PAGE = TRAE_DB_PAGE_SIZE;
const RESERVE = TRAE_DB_RESERVE_BYTES;

async function tmpRoot(tag: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'dcm-' + tag + '-'));
}

async function supportsSqlite(): Promise<boolean> {
  return (await sqliteCapability()).available;
}

/** 造一个真实明文 SQLite 库（页面大小默认 4096，会话 2 条） */
function makePlainDb(file: string, options: { pageSize?: number; sessionIds?: readonly string[] } = {}): void {
  const ids = options.sessionIds ?? ['s-1', 's-2'];
  const db = new DatabaseSync(file);
  try {
    if (options.pageSize !== undefined) db.exec('PRAGMA page_size = ' + String(options.pageSize));
    db.exec('PRAGMA journal_mode = DELETE');
    db.exec('CREATE TABLE chat_session (id TEXT PRIMARY KEY, session_id TEXT, title TEXT, cwd TEXT, created_at INTEGER)');
    db.exec('CREATE TABLE history_v2 (session_id TEXT, messages TEXT)');
    const insertSession = db.prepare('INSERT INTO chat_session (id, session_id, title, cwd, created_at) VALUES (?, ?, ?, ?, ?)');
    const insertHistory = db.prepare('INSERT INTO history_v2 (session_id, messages) VALUES (?, ?)');
    for (const id of ids) {
      insertSession.run(id, id, 'title-' + id, CWD, 1750000000000);
      insertHistory.run(id, JSON.stringify({
        raw_messages: [
          { role: 'user', content: 'hello ' + id },
          { role: 'assistant', content: [{ type: 'text', text: 'reply ' + id }] },
        ],
      }));
    }
  } finally {
    db.close();
  }
}

/**
 * 把 node:sqlite 建的普通库机械重排成 **reserve 80 的明文库**（真实 SQLCipher 明文就是这个形状）：
 * 每页只有前 4016 B 可用，页尾 80 B 是保留区（本应是 IV/HMAC 的位置，明文里恒为 0）。
 *
 * 做法：内容区 [contentStart, pageSize) 整体上移 80 B，同步改 b-tree 头的 contentStart 与指针数组，
 * 头里「每页保留字节数」（offset 20）写 80。只对无 freeblock / 无 overflow 的小库做（夹具满足）。
 */
function toReserve80Bytes(input: Buffer, pageSize = PAGE): Buffer {
  const out = Buffer.from(input);
  const pages = Math.floor(out.length / pageSize);
  const usable = pageSize - RESERVE;
  for (let index = 0; index < pages; index += 1) {
    const base = index * pageSize;
    const header = index === 0 ? 100 : 0;
    const cellCount = out.readUInt16BE(base + header + 3);
    const contentStart = out.readUInt16BE(base + header + 5);
    if (contentStart === 0 || contentStart >= pageSize) continue; // 空页（内容区未使用）
    out.copy(out, base + contentStart - RESERVE, base + contentStart, base + pageSize);
    out.fill(0, base + usable, base + pageSize);
    out.writeUInt16BE(contentStart - RESERVE, base + header + 5);
    for (let cell = 0; cell < cellCount; cell += 1) {
      const pointer = base + header + 8 + cell * 2;
      out.writeUInt16BE(out.readUInt16BE(pointer) - RESERVE, pointer);
    }
  }
  out[20] = RESERVE;
  return out;
}

/**
 * 造 SQLCipher 形态密文库（**正向加密**，与读盘层的解密互逆）。
 *
 * 明文先重排成 reserve 80 的形态（真实 SQLCipher 库的形状），再按页加密：
 * page0：salt(16) + AES(明文页 [16,4016)) + IV(16) + HMAC(64 随机占位)
 * pageN：AES(明文页 [0,4016)) + IV(16) + HMAC(64)
 */
async function encryptLikeSqlcipher(plainFile: string, outFile: string, keyHex: string, pageSize = PAGE): Promise<void> {
  const key = Buffer.from(keyHex, 'hex');
  const plain = toReserve80Bytes(await fs.readFile(plainFile), pageSize);
  const pages = Math.ceil(plain.length / pageSize);
  const out: Buffer[] = [];
  const salt = randomBytes(16);
  for (let index = 0; index < pages; index += 1) {
    const start = index * pageSize;
    const page = Buffer.alloc(pageSize);
    plain.copy(page, 0, start, Math.min(start + pageSize, plain.length));
    const usable = pageSize - RESERVE;
    const payload = index === 0 ? page.subarray(16, usable) : page.subarray(0, usable);
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-cbc', key, iv);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
    out.push(index === 0 ? salt : Buffer.alloc(0), encrypted, iv, randomBytes(64));
  }
  await fs.writeFile(outFile, Buffer.concat(out));
}

function envOf(extra: Record<string, string> = {}): Record<string, string | undefined> {
  return { ...extra };
}

/* ------------------------------------------------------------------ 用例 */

test('s1 夹具解出 chat_session / history_v2：会话数与正文条数与明文库一致', async () => {
  if (!await supportsSqlite()) return; // 宿主无 node:sqlite：夹具本身造不出来
  const root = await tmpRoot('trae-db-s1');
  try {
    const plain = path.join(root, 'plain.db');
    makePlainDb(plain);
    const enc = path.join(root, 'database.db');
    await encryptLikeSqlcipher(plain, enc, TRAE_DB_DEFAULT_KEY);
    const outcome = await readTraeEncryptedDatabase(enc, { env: envOf(), platform: HOST });
    assert.equal(outcome.problem, undefined);
    assert.equal(outcome.mode, 'decrypted');
    assert.deepEqual(outcome.sessions.map((s) => s.id), ['s-1', 's-2']);
    const first = outcome.sessions[0];
    assert.ok(first !== undefined);
    assert.equal(first.cwd, CWD);
    assert.equal(first.title, 'title-s-1');
    assert.equal(first.createdAt, 1750000000000);
    // 消息容器 = raw_messages（调研确证的唯一形态）
    const items = first.items;
    assert.equal(items.length, 2);
    assert.deepEqual(messageItemsOf({ raw_messages: items })?.length, 2);
    assert.equal((items[0] as { role?: string }).role, 'user');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('s2 四类坏输入各给稳定码，且不抛未捕获异常、不留半截明文', async () => {
  if (!await supportsSqlite()) return;
  const root = await tmpRoot('trae-db-s2');
  const before = (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith('dcm-trae-db-'));
  try {
    const plain = path.join(root, 'plain.db');
    makePlainDb(plain);
    const good = path.join(root, 'good.db');
    await encryptLikeSqlcipher(plain, good, TRAE_DB_DEFAULT_KEY);

    // ① 错误密钥（换版 / 覆盖错）
    const wrongKey = 'ab'.repeat(32);
    const wrong = await readTraeEncryptedDatabase(good, { env: envOf({ [TRAE_DB_KEY_ENV]: wrongKey }), platform: HOST });
    assert.equal(wrong.sessions.length, 0);
    assert.equal(wrong.problem?.code, 'trae-db-key-invalid');
    assert.equal(wrong.problem?.detail, 'page-size-mismatch');

    // ② 截断（对齐但页数不足 / 不对齐都算可判定失败）
    const truncated = path.join(root, 'truncated.db');
    const bytes = await fs.readFile(good);
    await fs.writeFile(truncated, bytes.subarray(0, PAGE));
    const cut = await readTraeEncryptedDatabase(truncated, { env: envOf(), platform: HOST });
    assert.equal(cut.problem?.code, 'trae-db-key-invalid');
    assert.equal(cut.problem?.detail, 'page-count-mismatch');
    const ragged = path.join(root, 'ragged.db');
    await fs.writeFile(ragged, bytes.subarray(0, PAGE + 100));
    const raggedOut = await readTraeEncryptedDatabase(ragged, { env: envOf(), platform: HOST });
    assert.equal(raggedOut.problem?.code, 'trae-db-decrypt-failed');
    assert.equal(raggedOut.problem?.detail, 'truncated-database');

    // ③ 非加密库（随机字节，页面网格对齐）
    const junk = path.join(root, 'junk.db');
    await fs.writeFile(junk, randomBytes(PAGE * 2));
    const junkOut = await readTraeEncryptedDatabase(junk, { env: envOf(), platform: HOST });
    assert.equal(junkOut.problem?.code, 'trae-db-key-invalid');

    // ④ 页大小不符（真实页面大小 8192，却按 4096 解）
    const bigPlain = path.join(root, 'big.db');
    makePlainDb(bigPlain, { pageSize: 8192, sessionIds: ['s-1'] });
    const bigEnc = path.join(root, 'big-enc.db');
    await encryptLikeSqlcipher(bigPlain, bigEnc, TRAE_DB_DEFAULT_KEY);
    const bigOut = await readTraeEncryptedDatabase(bigEnc, { env: envOf(), platform: HOST });
    assert.equal(bigOut.problem?.code, 'trae-db-key-invalid');
    assert.equal(bigOut.problem?.detail, 'page-size-mismatch');

    // 四次失败都不得留下半截明文：临时目录集合必须回到原样
    const after = (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith('dcm-trae-db-'));
    assert.deepEqual(after.sort(), before.sort());
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('s3 解密产物是 node:sqlite 可只读打开的明文库，且临时目录导入后不存在', async () => {
  if (!await supportsSqlite()) return;
  const root = await tmpRoot('trae-db-s3');
  const before = (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith('dcm-trae-db-'));
  try {
    const plain = path.join(root, 'plain.db');
    makePlainDb(plain);
    const enc = path.join(root, 'database.db');
    await encryptLikeSqlcipher(plain, enc, TRAE_DB_DEFAULT_KEY);
    const dest = path.join(root, 'decrypted.db');
    const result = await decryptTraeDatabase(enc, dest, Buffer.from(TRAE_DB_DEFAULT_KEY, 'hex'));
    assert.equal(result.ok, true);
    const head = (await fs.readFile(dest)).subarray(0, 16).toString('latin1');
    assert.equal(head, 'SQLite format 3\0');
    const db = new DatabaseSync(dest, { readOnly: true });
    try {
      const rows = db.prepare('SELECT id FROM chat_session ORDER BY id').all() as { id: string }[];
      assert.deepEqual(rows.map((r) => r.id), ['s-1', 's-2']);
    } finally {
      db.close();
    }
    // 读盘层自己造的一次性目录必须在结束后消失（明文不留在用户可见位置）
    const outcome = await readTraeEncryptedDatabase(enc, { env: envOf(), platform: HOST });
    assert.equal(outcome.sessions.length, 2);
    const after = (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith('dcm-trae-db-'));
    assert.deepEqual(after.sort(), before.sort());
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('s4 密钥：环境变量覆盖生效；格式非法给 key-invalid/key-format（绝不回落到内置）', async () => {
  if (!await supportsSqlite()) return;
  const root = await tmpRoot('trae-db-s4');
  try {
    const custom = 'cd'.repeat(32);
    const plain = path.join(root, 'plain.db');
    makePlainDb(plain, { sessionIds: ['env-1'] });
    const enc = path.join(root, 'database.db');
    await encryptLikeSqlcipher(plain, enc, custom);

    // 缺省 key 解不开自定义 key 的库
    const viaDefault = await readTraeEncryptedDatabase(enc, { env: envOf(), platform: HOST });
    assert.equal(viaDefault.problem?.code, 'trae-db-key-invalid');
    // 覆盖后解得开
    const viaEnv = await readTraeEncryptedDatabase(enc, { env: envOf({ [TRAE_DB_KEY_ENV]: custom }), platform: HOST });
    assert.equal(viaEnv.problem, undefined);
    assert.deepEqual(viaEnv.sessions.map((s) => s.id), ['env-1']);
    const resolved = resolveTraeDbKey(envOf({ [TRAE_DB_KEY_ENV]: custom }));
    assert.equal('problem' in resolved ? null : resolved.source, 'env');

    // 设了但不合法 ⇒ 可判定失败（不悄悄用内置 key 掩盖配置错误）
    const bogus = resolveTraeDbKey(envOf({ [TRAE_DB_KEY_ENV]: 'not-a-hex-key' }));
    assert.equal('problem' in bogus ? bogus.problem.code : null, 'trae-db-key-invalid');
    assert.equal('problem' in bogus ? bogus.problem.detail : null, 'key-format');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('s5 表结构不符 / 超来源上限：各自稳定码（全局 1 GiB 未参与）', async () => {
  if (!await supportsSqlite()) return;
  const root = await tmpRoot('trae-db-s5');
  try {
    const plain = path.join(root, 'plain.db');
    makePlainDb(plain);
    const enc = path.join(root, 'database.db');
    await encryptLikeSqlcipher(plain, enc, TRAE_DB_DEFAULT_KEY);

    // 超限：把上限压到 1 页（夹具不必造 2 GiB），走 copy-too-large 语义
    const tooLarge = await readTraeEncryptedDatabase(enc, { env: envOf(), platform: HOST, maxBytes: PAGE });
    assert.equal(tooLarge.problem?.code, 'trae-db-too-large');
    assert.equal(tooLarge.problem?.detail, 'copy-too-large');
    assert.equal(TRAE_DB_MAX_BYTES > 1024 * 1024 * 1024, true);

    // 表结构不符：解密成功但没有 history_v2
    const partial = path.join(root, 'partial.db');
    const db = new DatabaseSync(partial);
    db.exec('CREATE TABLE chat_session (id TEXT PRIMARY KEY)');
    db.exec("INSERT INTO chat_session (id) VALUES ('x')");
    db.close();
    const partialEnc = path.join(root, 'partial-enc.db');
    await encryptLikeSqlcipher(partial, partialEnc, TRAE_DB_DEFAULT_KEY);
    const schema = await readTraeEncryptedDatabase(partialEnc, { env: envOf(), platform: HOST });
    assert.equal(schema.problem?.code, 'trae-db-schema-mismatch');
    assert.equal(schema.problem?.detail, 'missing-table-history_v2');

    // skip 形态：码 + origin=trae + detail（界面据此翻字典）
    const skip = traeDbSkipOf({ code: 'trae-db-key-invalid', detail: 'page-size-mismatch', count: 3 });
    assert.deepEqual(skip, { code: 'trae-db-key-invalid', origin: 'trae', detail: 'page-size-mismatch', count: 3 });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('s6 detect 期只解 1 页就能给出预告；库不存在时不报任何码', async () => {
  if (!await supportsSqlite()) return;
  const root = await tmpRoot('trae-db-s6');
  try {
    const plain = path.join(root, 'plain.db');
    makePlainDb(plain);
    const enc = path.join(root, 'database.db');
    await encryptLikeSqlcipher(plain, enc, TRAE_DB_DEFAULT_KEY);

    assert.equal(await probeTraeEncryptedDatabase(enc, { env: envOf() }), null);
    const wrong = await probeTraeEncryptedDatabase(enc, { env: envOf({ [TRAE_DB_KEY_ENV]: 'ef'.repeat(32) }) });
    assert.equal(wrong?.code, 'trae-db-key-invalid');
    const huge = await probeTraeEncryptedDatabase(enc, { env: envOf(), maxBytes: 1 });
    assert.equal(huge?.code, 'trae-db-too-large');
    const missing = await probeTraeEncryptedDatabase(path.join(root, 'nope.db'), { env: envOf() });
    assert.equal(missing, null);

    // 明文库（旧版 / 已被第三方解密）不报码，读盘层走 plaintext 模式
    const plainOut = await readTraeEncryptedDatabase(plain, { env: envOf(), platform: HOST });
    assert.equal(plainOut.problem, undefined);
    assert.equal(plainOut.mode, 'plaintext');
    assert.equal(await probeTraeEncryptedDatabase(plain, { env: envOf() }), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('s7 路径与页头校验的纯函数口径', () => {
  assert.equal(traeDbPathFor('/home/u/Trae CN/User', 'linux'), '/home/u/Trae CN/User/ModularData/ai-agent/database.db');
  assert.equal(
    traeDbPathFor('C:\\Users\\u\\AppData\\Roaming\\Trae\\User', 'win32'),
    'C:\\Users\\u\\AppData\\Roaming\\Trae\\User\\ModularData\\ai-agent\\database.db',
  );
  // 合法页头：页大小 4096、reserve 80、payload 分数 64/32/32、页数一致
  const page = Buffer.alloc(4000);
  page.writeUInt16BE(4096, 0);
  page[4] = 80;
  page[5] = 64;
  page[6] = 32;
  page[7] = 32;
  page.writeUInt32BE(3, 12);
  assert.equal(validateTraePageOne(page, 3), null);
  assert.equal(validateTraePageOne(page, 4), 'page-count-mismatch');
  page[4] = 0;
  assert.equal(validateTraePageOne(page, 3), null); // 个别库不写 reserve：接受
  page[4] = 8;
  assert.equal(validateTraePageOne(page, 3), 'reserve-mismatch');
  const shortPage = Buffer.alloc(8);
  assert.equal(validateTraePageOne(shortPage, 1), 'short-first-page');
});
