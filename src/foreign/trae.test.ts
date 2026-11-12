/**
 * Trae 来源回归（4 发行版 × 三分支路径真值 × 真实 SQLite 库解析 × 端到端）。
 *
 * 取证：本机无 Trae 安装（fixture 级）；夹具是**真实 state.vscdb**（node:sqlite 造），
 * 不是 JSON 假库 —— 打开方式/表结构/ItemTable 读取都按真机形态走。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createCipheriv, randomBytes } from 'node:crypto';

import { FOREIGN_TRUTH_TABLES, TRUTH_PROBE_ENV, TRUTH_PROBES } from './truth-table.ts';
import { normalizePlatform, roamingAppDataDir, vscodeUserDataDir, xdgDataHome } from './platform-paths.ts';
import type { ForeignPlatform } from './platform-paths.ts';
import type { RootProbeOptions } from './session-source.ts';
import type { ForeignSourceContext } from './registry.ts';

const BS = String.fromCharCode(92);
const PLATFORMS: readonly ForeignPlatform[] = ['win32', 'darwin', 'linux'];
/** 读真实临时目录的用例用**运行平台**（绝对路径判定要对得上真机） */
const HOST: ForeignPlatform = normalizePlatform(process.platform);

async function tmpRoot(tag: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-' + tag + '-'));
}

function truthProbePaths(id: string, opts: RootProbeOptions): string[] {
  const entry = FOREIGN_TRUTH_TABLES.find((e) => e.id === id);
  assert.ok(entry !== undefined, '真值表缺少 ' + id);
  const platform = normalizePlatform(opts.platform);
  const appdata = roamingAppDataDir(platform, opts.homeDir, opts.env);
  const xdgdata = xdgDataHome(platform, opts.homeDir, opts.env);
  return entry.defaults[platform].map((template) => template
    .split('<home>').join(opts.homeDir)
    .split('<appdata>').join(appdata)
    .split('<xdgdata>').join(xdgdata));
}

function normalize(p: string): string {
  return p.split(BS).join('/');
}

function assertTruthPaths(id: string, probePaths: (opts: RootProbeOptions) => readonly string[]): void {
  for (const platform of PLATFORMS) {
    const probe = TRUTH_PROBES[platform];
    const opts: RootProbeOptions = { homeDir: probe.homeDir, env: TRUTH_PROBE_ENV, platform };
    assert.deepEqual(
      probePaths(opts).map(normalize),
      truthProbePaths(id, opts).map(normalize),
      id + ' × ' + platform + ' 的 probePaths 与真值表不一致',
    );
  }
}

function ctxOf(homeDir: string, platform: ForeignPlatform, env: Record<string, string | undefined> = {}, version = 3, projectDir?: string): ForeignSourceContext {
  return {
    homeDir,
    env,
    platform,
    targetSessionFormatVersion: version,
    ...(projectDir !== undefined ? { projectDir } : {}),
  };
}

import { traeSource } from './trae.ts';
import {
  isTraeChatStorageKey,
  readTrae,
  TRAE_FALLBACK_KEYS,
  TRAE_STORAGE_KEY,
  traeSessionsOfValue,
  traeTimeValue,
  traeUserDataDirs,
  traeVscdbPaths,
} from './read-trae.ts';
import { sqliteCapability } from './sqlite.ts';
import {
  TRAE_DB_DEFAULT_KEY,
  TRAE_DB_KEY_ENV,
  TRAE_DB_PAGE_SIZE,
  TRAE_DB_RESERVE_BYTES,
  traeDbPathFor,
} from './trae-sqlcipher.ts';

interface SqliteModule {
  DatabaseSync?: new (p: string) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...args: unknown[]): unknown };
    close(): void;
  };
}

/** 造一个真库（真实 ItemTable；TEXT 与 BLOB 两种 value 都覆盖） */
async function makeVscdb(file: string, rows: readonly { key: string; value: string | Uint8Array }[]): Promise<boolean> {
  const spec = 'node:sqlite';
  let mod: SqliteModule;
  try {
    mod = await import(spec) as SqliteModule;
  } catch {
    return false;
  }
  const Ctor = mod.DatabaseSync;
  if (Ctor === undefined) return false;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const db = new Ctor(file);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value BLOB)');
    const stmt = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
    for (const row of rows) stmt.run(row.key, row.value);
  } finally {
    db.close();
  }
  return true;
}

test('trae t1 路径真值：4 个发行版 × 三分支与真值表逐项一致；state.vscdb 在读取期枚举', () => {
  assertTruthPaths('trae', traeUserDataDirs);
  const linux = traeUserDataDirs({ homeDir: '/home/u', env: {}, platform: 'linux' });
  assert.equal(linux.length, 4);
  assert.equal(linux[0], ['/home/u', '.config', 'Trae', 'User'].join('/'));
  assert.equal(linux[3], ['/home/u', '.config', 'TRAE SOLO', 'User'].join('/'));
  assert.equal(traeUserDataDirs({ homeDir: 'C:/u', env: {}, platform: 'win32' })[0], ['C:/u', 'AppData', 'Roaming', 'Trae', 'User'].join(BS));
  assert.equal(traeUserDataDirs({ homeDir: '/Users/u', env: {}, platform: 'darwin' })[0], ['/Users/u', 'Library', 'Application Support', 'Trae', 'User'].join('/'));
});

test('trae t2 存储键判定：主键 + 参考的回退键命中；无关 UI 键不命中（绝不把 ItemTable 当会话）', () => {
  assert.equal(isTraeChatStorageKey(TRAE_STORAGE_KEY), true);
  assert.equal(isTraeChatStorageKey('memento/trae-agent-storage'), true);
  // 参考 lib/sources/trae.mjs 的 TRAE_FALLBACK_KEYS：旧版 Trae 把会话放在这两个键下，
  // 只认 icube 模式会**整库漏读**
  for (const key of TRAE_FALLBACK_KEYS) {
    assert.equal(isTraeChatStorageKey(key), true, '回退键必须命中：' + key);
  }
  assert.equal(isTraeChatStorageKey('chat.ChatSessionStore.index'), true);
  assert.equal(isTraeChatStorageKey('ChatStore'), true);
  assert.equal(isTraeChatStorageKey('memento/workbench.panel.output'), false);
  assert.equal(isTraeChatStorageKey('colorThemeData'), false);
});

test('trae t3 结构自证：只有「消息数组 + 角色字段」的容器才算会话', () => {
  const value = {
    ui: { colorTheme: 'dark' },
    sessions: [
      { id: 'ok-1', cwd: '/p/a', messages: [{ role: 'user', content: 'hi' }] },
      { id: 'no-messages', cwd: '/p/b', messages: ['just a string'] },
      { messages: [{ role: 'user', content: 'no id' }] },
    ],
  };
  const found = traeSessionsOfValue(value, 'memento/icube-ai-agent-storage', 'linux');
  assert.equal(found.length, 2, '无消息数组的节点不得当会话');
  assert.ok(found.some((s) => s.id === 'ok-1' && s.cwd === '/p/a'));
  assert.ok(found.some((s) => s.id.startsWith('memento-icube-ai-agent-storage-')), '无 id 的容器铸稳定兜底 id');
});

test('trae t4 真实 state.vscdb：读取 + 端到端（sessions + workspaces）', async (t) => {
  const capability = await sqliteCapability();
  if (!capability.available) {
    t.skip('本宿主无 node:sqlite（' + String(capability.reason) + '）');
    return;
  }
  const root = await tmpRoot('trae');
  try {
    const userDir = vscodeUserDataDir(HOST, root, {}, 'Trae');
    const cwd = path.join(root, 'proj');
    const payload = JSON.stringify({
      sessions: [{ id: 'trae-1', workspace: cwd, title: 'trae 会话', messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'yo' },
      ] }],
    });
    const ok = await makeVscdb(path.join(userDir, 'globalStorage', 'state.vscdb'), [
      { key: 'memento/workbench.panel.output', value: '{"irrelevant":true}' },
      { key: 'memento/icube-ai-agent-storage', value: payload },
    ]);
    assert.equal(ok, true, '造库必须成功（sqlite 能力已探测可用）');
    const wsDb = path.join(userDir, 'workspaceStorage', 'hash1', 'state.vscdb');
    assert.equal(await makeVscdb(wsDb, [{ key: 'memento/icube-ai-agent-storage', value: new TextEncoder().encode(payload) }]), true);

    const paths = await traeVscdbPaths(userDir, HOST);
    assert.equal(paths.length, 2, 'globalStorage 一个 + workspaceStorage/<hash> 一个');

    const read = await readTrae({ homeDir: root, env: {}, platform: HOST });
    assert.equal(read.files.length, 1, '同 id 只保留一条');
    assert.equal(read.files[0]?.id, 'trae-1');
    assert.equal(read.files[0]?.cwd, cwd);
    assert.equal(read.files[0]?.title, 'trae 会话');
    assert.equal(read.files[0]?.records.length, 2);

    const result = await traeSource.build(ctxOf(root, HOST));
    assert.equal(result.counts['sessions.files'], 1);
    assert.equal(result.counts['workspaces.records'], 1);
    assert.equal(result.counts['trae.vscdb'], 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('trae t5 无候选键：如实报 sessions-not-migrated（绝不假装成功）', async (t) => {
  const capability = await sqliteCapability();
  if (!capability.available) {
    t.skip('本宿主无 node:sqlite');
    return;
  }
  const root = await tmpRoot('trae-nokey');
  try {
    const userDir = vscodeUserDataDir(HOST, root, {}, 'Trae');
    assert.equal(await makeVscdb(path.join(userDir, 'globalStorage', 'state.vscdb'), [
      { key: 'memento/workbench.panel.output', value: '{}' },
    ]), true);
    const read = await readTrae({ homeDir: root, env: {}, platform: HOST });
    assert.deepEqual(read.files, []);
    assert.equal(read.extraSkips?.some((s) => s.code === 'sessions-not-migrated' && s.detail === 'chat-storage-key-not-found'), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('trae t6 时间：秒 / 毫秒 / 数字字符串三种形态都归一到毫秒（参考 timeValue）', () => {
  assert.equal(traeTimeValue(1700000000), 1700000000000, '秒 → 毫秒（否则落到 1970）');
  assert.equal(traeTimeValue('1700000000'), 1700000000000, '数字字符串不能被 Date.parse 变成 NaN');
  assert.equal(traeTimeValue(1700000000000), 1700000000000, '毫秒原样');
  assert.equal(traeTimeValue('2026-10-05T00:00:00Z'), Date.parse('2026-10-05T00:00:00Z'));
  assert.equal(traeTimeValue('nope'), undefined);
  // 口径取自 read-opencode.ts 的 msTime（先取整再换算，秒的小数部分丢弃）——与参考
  // 「先乘再取整」差 1 秒以内的毫秒位；宿主不消费这个精度，且复用单一时间口径优先。
  assert.equal(traeTimeValue(1700000000.5), 1700000000000);
});

test('trae t7 容器与正文：对象映射消息 + body/prompt/response/output + planItems + role=agent', () => {
  const value = {
    entries: {
      e1: {
        id: 'e-1',
        workspace: '/p/e',
        chatMessages: {
          m1: { role: 'agent', body: '来自 body 的正文' },
          m2: { role: 'assistant', prompt: '来自 prompt 的正文' },
          m3: { role: 'user', response: '来自 response 的正文', sender: 'user' },
          m4: { role: 'assistant', output: '来自 output 的正文' },
        },
      },
    },
  };
  const found = traeSessionsOfValue(value, 'chat.ChatSessionStore.index', 'linux');
  assert.equal(found.length, 1, '对象映射容器也必须被认出（参考 valuesOf 同时认数组与对象）');
  const session = found[0];
  assert.ok(session !== undefined);
  assert.equal(session.id, 'e-1');
  assert.equal(session.cwd, '/p/e');
  assert.deepEqual(session.records.map((r) => r.role), ['assistant', 'assistant', 'user', 'assistant'], 'role=agent → assistant');
  const texts = session.records.map((r) => r.blocks.map((b) => (b.type === 'text' ? b.text : '')).join(''));
  assert.deepEqual(texts, ['来自 body 的正文', '来自 prompt 的正文', '来自 response 的正文', '来自 output 的正文']);

  // Agent 模式：正文在 agentTaskContent.guideline.planItems 里（content/text 为空）
  const plan = traeSessionsOfValue({
    sessions: [{
      id: 'p-1',
      messages: [{
        role: 'agent',
        agentTaskContent: {
          guideline: {
            planItems: [
              { thought: '先想想', toolName: 'read_file', params: { path: 'a.ts' }, result: 'ok' },
              '一条纯字符串计划项',
            ],
          },
        },
      }],
    }],
  }, TRAE_STORAGE_KEY, 'linux');
  assert.equal(plan.length, 1);
  const planText = plan[0]?.records[0]?.blocks[0];
  assert.equal(planText?.type, 'text');
  if (planText?.type === 'text') {
    assert.ok(planText.text.includes('[thought] 先想想'));
    assert.ok(planText.text.includes('[tool] read_file'));
    assert.ok(planText.text.includes('[arguments] {"path":"a.ts"}'));
    assert.ok(planText.text.includes('[result] ok'));
    assert.ok(planText.text.includes('一条纯字符串计划项'));
  }
});

test('trae t8 cwd 只认语义唯一的键：path/rootPath 这类过宽键不得被当会话 cwd', () => {
  const found = traeSessionsOfValue({
    sessions: [{
      id: 'c-1',
      path: '/definitely/not/cwd',
      rootPath: '/also/not/cwd',
      messages: [{ role: 'user', content: 'hi' }],
    }],
  }, TRAE_STORAGE_KEY, 'linux');
  assert.equal(found.length, 1);
  assert.equal(found[0]?.cwd, undefined, 'path/rootPath 在存储值里到处都是 → 绝不能当 cwd');
});

test('trae t9 旧版回退键的库：整库可读（不再漏读）', async (t) => {
  const capability = await sqliteCapability();
  if (!capability.available) {
    t.skip('本宿主无 node:sqlite');
    return;
  }
  const root = await tmpRoot('trae-fallback');
  try {
    const userDir = vscodeUserDataDir(HOST, root, {}, 'Trae');
    const cwd = path.join(root, 'proj');
    const payload = JSON.stringify({
      sessions: [{ id: 'old-1', workspace: cwd, title: '旧版会话', entries: [
        { role: 'user', content: 'hi' },
      ] }],
    });
    assert.equal(await makeVscdb(path.join(userDir, 'globalStorage', 'state.vscdb'), [
      { key: 'chat.ChatSessionStore.index', value: payload },
    ]), true);
    const read = await readTrae({ homeDir: root, env: {}, platform: HOST });
    assert.equal(read.files.length, 1, '回退键下的会话必须被读到');
    assert.equal(read.files[0]?.id, 'old-1');
    assert.equal(read.files[0]?.cwd, cwd);
    assert.equal(read.extraCounts?.['trae.chatStorageKeys'], 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
/* ------------------------------------------- 2.3.x 加密库夹具（SQLCipher 形态） */

const DB_PAGE = TRAE_DB_PAGE_SIZE;
const DB_RESERVE = TRAE_DB_RESERVE_BYTES;
/** 会话 cwd 必须是**运行平台可判定为绝对**的路径（否则转码层按 session-missing-cwd 丢弃） */
const DB_CWD = HOST === 'win32' ? 'C:\\work\\trae' : '/work/trae';

/** 把 node:sqlite 建的普通库重排成 reserve 80 的明文库（真实 SQLCipher 明文的形状） */
function reserve80(input: Buffer): Buffer {
  const out = Buffer.from(input);
  const pages = Math.floor(out.length / DB_PAGE);
  const usable = DB_PAGE - DB_RESERVE;
  for (let index = 0; index < pages; index += 1) {
    const base = index * DB_PAGE;
    const header = index === 0 ? 100 : 0;
    const cellCount = out.readUInt16BE(base + header + 3);
    const contentStart = out.readUInt16BE(base + header + 5);
    if (contentStart === 0 || contentStart >= DB_PAGE) continue;
    out.copy(out, base + contentStart - DB_RESERVE, base + contentStart, base + DB_PAGE);
    out.fill(0, base + usable, base + DB_PAGE);
    out.writeUInt16BE(contentStart - DB_RESERVE, base + header + 5);
    for (let cell = 0; cell < cellCount; cell += 1) {
      const pointer = base + header + 8 + cell * 2;
      out.writeUInt16BE(out.readUInt16BE(pointer) - DB_RESERVE, pointer);
    }
  }
  out[20] = DB_RESERVE;
  return out;
}

/** 按 SQLCipher 4.x 页面布局正向加密（page0 = salt + AES，每页尾 IV16 + HMAC64 占位） */
function sqlcipherPages(plain: Buffer, keyHex: string): Buffer {
  const key = Buffer.from(keyHex, 'hex');
  const pages = Math.ceil(plain.length / DB_PAGE);
  const out: Buffer[] = [];
  for (let index = 0; index < pages; index += 1) {
    const start = index * DB_PAGE;
    const page = Buffer.alloc(DB_PAGE);
    plain.copy(page, 0, start, Math.min(start + DB_PAGE, plain.length));
    const usable = DB_PAGE - DB_RESERVE;
    const payload = index === 0 ? page.subarray(16, usable) : page.subarray(0, usable);
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-cbc', key, iv);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
    out.push(index === 0 ? randomBytes(16) : Buffer.alloc(0), encrypted, iv, randomBytes(64));
  }
  return Buffer.concat(out);
}

/** 在 <User>/ModularData/ai-agent/database.db 造一个 SQLCipher 形态的库（表真造，不是假数据） */
async function makeEncryptedDb(file: string, ids: readonly string[], keyHex = TRAE_DB_DEFAULT_KEY): Promise<boolean> {
  const spec = 'node:sqlite';
  let mod: SqliteModule;
  try {
    mod = await import(spec) as SqliteModule;
  } catch {
    return false;
  }
  const Ctor = mod.DatabaseSync;
  if (Ctor === undefined) return false;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const plainFile = file + '.plain';
  const db = new Ctor(plainFile);
  try {
    db.exec('CREATE TABLE chat_session (id TEXT PRIMARY KEY, session_id TEXT, title TEXT, cwd TEXT, created_at INTEGER)');
    db.exec('CREATE TABLE history_v2 (session_id TEXT, messages TEXT)');
    const insertSession = db.prepare('INSERT INTO chat_session (id, session_id, title, cwd, created_at) VALUES (?, ?, ?, ?, ?)');
    const insertHistory = db.prepare('INSERT INTO history_v2 (session_id, messages) VALUES (?, ?)');
    for (const id of ids) {
      insertSession.run(id, id, 'enc-' + id, DB_CWD, 1750000000000);
      insertHistory.run(id, JSON.stringify({
        raw_messages: [
          { role: 'user', content: 'hi ' + id },
          { role: 'assistant', content: 'yo ' + id },
        ],
      }));
    }
  } finally {
    db.close();
  }
  const plain = reserve80(await fs.readFile(plainFile));
  await fs.writeFile(file, sqlcipherPages(plain, keyHex));
  await fs.rm(plainFile, { force: true });
  return true;
}

test('trae t10 双通道并存：加密库优先且同 id 只计一份，旧 state.vscdb 的其余会话仍保留', async (t) => {
  const capability = await sqliteCapability();
  if (!capability.available) {
    t.skip('本宿主无 node:sqlite');
    return;
  }
  const root = await tmpRoot('trae-dual');
  try {
    const userDir = vscodeUserDataDir(HOST, root, {}, 'Trae CN');
    assert.equal(await makeEncryptedDb(traeDbPathFor(userDir, HOST), ['d-1', 'd-2']), true, '加密库夹具必须造成功');
    // 旧通道：d-1 与加密库同 id（迁移残留），old-9 只在旧库
    assert.equal(await makeVscdb(path.join(userDir, 'globalStorage', 'state.vscdb'), [
      { key: 'memento/icube-ai-agent-storage', value: JSON.stringify({
        sessions: [
          { id: 'd-1', workspace: DB_CWD, messages: [{ role: 'user', content: '旧残留' }] },
          { id: 'old-9', workspace: DB_CWD, messages: [{ role: 'user', content: '只有旧库' }] },
        ],
      }) },
    ]), true);

    const read = await readTrae({ homeDir: root, env: {}, platform: HOST });
    assert.deepEqual(read.files.map((f) => f.id), ['d-1', 'd-2', 'old-9'], '同 id 只出现一次，加密库先占位');
    const dup = read.files.find((f) => f.id === 'd-1');
    assert.equal(dup?.records[0]?.blocks[0]?.type, 'text', '同 id 用的是加密库那份正文');
    assert.equal(read.extraCounts?.['trae.encryptedDb'], 1);
    assert.equal(read.extraCounts?.['trae.encryptedSessions'], 2, '加密库贡献 2 条，旧库补 1 条');
    assert.equal(read.extraSkips?.some((s) => s.code === 'sessions-not-migrated'), false, '加密库在场时不得再说「没迁移」');

    const result = await traeSource.build(ctxOf(root, HOST));
    assert.equal(result.counts['sessions.files'], 3);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('trae t11 detect 期就带出 sessions-not-migrated（不再等 build 的 400 才闪一下）', async (t) => {
  const capability = await sqliteCapability();
  if (!capability.available) {
    t.skip('本宿主无 node:sqlite');
    return;
  }
  const root = await tmpRoot('trae-detect');
  try {
    const userDir = vscodeUserDataDir(HOST, root, {}, 'Trae');
    assert.equal(await makeVscdb(path.join(userDir, 'globalStorage', 'state.vscdb'), [
      { key: 'memento/workbench.panel.output', value: '{}' },
    ]), true);
    const detect = await traeSource.detect(ctxOf(root, HOST));
    assert.equal(detect.found, true);
    assert.equal(
      detect.skipped?.some((s) => s.code === 'sessions-not-migrated' && s.detail === 'chat-storage-key-not-found'),
      true,
      'detect 必须预告 build 会产生的同一 skip',
    );
    // 完全没有库时不预告（空目录 ≠ 没迁移）
    const empty = await tmpRoot('trae-detect-empty');
    try {
      const skipped = await traeSource.detect(ctxOf(empty, HOST));
      assert.deepEqual(skipped.skipped ?? [], []);
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('trae t12 密钥不对：detect 与 build 都给 trae-db-key-invalid（绝不静默 0 会话）', async (t) => {
  const capability = await sqliteCapability();
  if (!capability.available) {
    t.skip('本宿主无 node:sqlite');
    return;
  }
  const root = await tmpRoot('trae-badkey');
  try {
    const userDir = vscodeUserDataDir(HOST, root, {}, 'TRAE SOLO CN');
    assert.equal(await makeEncryptedDb(traeDbPathFor(userDir, HOST), ['k-1']), true);
    const env = { [TRAE_DB_KEY_ENV]: '00'.repeat(32) };
    const detect = await traeSource.detect(ctxOf(root, HOST, env));
    assert.equal(detect.skipped?.some((s) => s.code === 'trae-db-key-invalid'), true, 'detect 必须先报密钥问题');

    const read = await readTrae({ homeDir: root, env, platform: HOST });
    assert.deepEqual(read.files, []);
    assert.equal(read.extraSkips?.some((s) => s.code === 'trae-db-key-invalid'), true);
    // 换回内置缺省密钥，同一台机器又能读到（密钥不是写死不可换）
    const ok = await readTrae({ homeDir: root, env: {}, platform: HOST });
    assert.deepEqual(ok.files.map((f) => f.id), ['k-1']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

