/**
 * ui-prefs 测试：ui-prefs.json 读写往返、缺省值、损坏 JSON 回退缺省、非法通道值忽略、
 * Star 引导弹窗状态字段往返与非法值忽略、updateUiPrefs 局部原子更新不互相覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  defaultUiPrefs, readUiPrefs, writeUiPrefs, updateUiPrefs, readRollbackEnabledSync,
  UI_PREFS_FILE, UI_PREFS_SCHEMA_VERSION,
} from './ui-prefs.ts';

test('writeUiPrefs + readUiPrefs：写入通道 → 读回一致 + 原始文件校验', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ui-prefs-rt-'));
  try {
    await writeUiPrefs(dir, { schemaVersion: 1, lastSyncChannel: 'webdav' });
    const prefs = await readUiPrefs(dir);
    assert.equal(prefs.lastSyncChannel, 'webdav');
    const raw = JSON.parse(await fs.readFile(path.join(dir, UI_PREFS_FILE), 'utf8'));
    assert.equal(raw.schemaVersion, UI_PREFS_SCHEMA_VERSION);
    assert.equal(raw.lastSyncChannel, 'webdav');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('writeUiPrefs：无通道 → 文件不写 lastSyncChannel 字段', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ui-prefs-none-'));
  try {
    await writeUiPrefs(dir, defaultUiPrefs());
    const raw = JSON.parse(await fs.readFile(path.join(dir, UI_PREFS_FILE), 'utf8'));
    assert.equal(raw.schemaVersion, UI_PREFS_SCHEMA_VERSION);
    assert.equal('lastSyncChannel' in raw, false, '未配置通道不落字段');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('ui-prefs：会话格式处置（T1）字段往返 + 非法值忽略（绝不猜）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ui-prefs-sessionfmt-'));
  try {
    // 合法值往返
    await writeUiPrefs(dir, { schemaVersion: 1, sessionFormatDisposition: 'skip' });
    assert.equal((await readUiPrefs(dir)).sessionFormatDisposition, 'skip');
    const raw = JSON.parse(await fs.readFile(path.join(dir, UI_PREFS_FILE), 'utf8'));
    assert.equal(raw.sessionFormatDisposition, 'skip');

    // 未配置 → 不落字段、读回 undefined（由调用方回退缺省 abort）
    await writeUiPrefs(dir, defaultUiPrefs());
    assert.equal((await readUiPrefs(dir)).sessionFormatDisposition, undefined);
    assert.equal('sessionFormatDisposition' in JSON.parse(await fs.readFile(path.join(dir, UI_PREFS_FILE), 'utf8')), false);

    // 手改文件写入非法值 → 忽略（不是「读到就用」）
    await fs.writeFile(
      path.join(dir, UI_PREFS_FILE),
      JSON.stringify({ schemaVersion: 1, sessionFormatDisposition: 'BLOCK' }),
      'utf8',
    );
    assert.equal((await readUiPrefs(dir)).sessionFormatDisposition, undefined);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readUiPrefs：文件不存在 → 缺省（无通道）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ui-prefs-default-'));
  try {
    const prefs = await readUiPrefs(dir);
    assert.equal(prefs.lastSyncChannel, undefined);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readUiPrefs：损坏 JSON → 回退缺省', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ui-prefs-corrupt-'));
  try {
    await fs.writeFile(path.join(dir, UI_PREFS_FILE), '{not-json', 'utf8');
    const prefs = await readUiPrefs(dir);
    assert.equal(prefs.lastSyncChannel, undefined);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readUiPrefs：不支持的 schemaVersion → 回退缺省', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ui-prefs-schema-'));
  try {
    await fs.writeFile(
      path.join(dir, UI_PREFS_FILE),
      JSON.stringify({ schemaVersion: 99, lastSyncChannel: 'git' }),
      'utf8',
    );
    const prefs = await readUiPrefs(dir);
    assert.equal(prefs.lastSyncChannel, undefined);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readUiPrefs：非法通道值 → 忽略（回退缺省）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ui-prefs-bad-'));
  try {
    await fs.writeFile(
      path.join(dir, UI_PREFS_FILE),
      JSON.stringify({ schemaVersion: 1, lastSyncChannel: 'ftp' }),
      'utf8',
    );
    const prefs = await readUiPrefs(dir);
    assert.equal(prefs.lastSyncChannel, undefined, '非 git/webdav 值被忽略');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('Star 引导状态：写入三字段 → 读回一致 + 原始文件校验', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ui-prefs-star-'));
  try {
    await writeUiPrefs(dir, {
      schemaVersion: 1,
      starPromptFirstSeenAt: 1700000000000,
      starPromptDismissed: false,
      starPromptClicked: true,
    });
    const prefs = await readUiPrefs(dir);
    assert.equal(prefs.starPromptFirstSeenAt, 1700000000000);
    assert.equal(prefs.starPromptDismissed, undefined, 'false 不落字段');
    assert.equal(prefs.starPromptClicked, true);
    const raw = JSON.parse(await fs.readFile(path.join(dir, UI_PREFS_FILE), 'utf8'));
    assert.equal(raw.starPromptFirstSeenAt, 1700000000000);
    assert.equal('starPromptDismissed' in raw, false, 'false 不写字段');
    assert.equal(raw.starPromptClicked, true);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readUiPrefs：Star 字段非法值（字符串时间戳 / 非布尔）→ 忽略', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ui-prefs-star-bad-'));
  try {
    await fs.writeFile(
      path.join(dir, UI_PREFS_FILE),
      JSON.stringify({ schemaVersion: 1, starPromptFirstSeenAt: 'yesterday', starPromptDismissed: 'yes' }),
      'utf8',
    );
    const prefs = await readUiPrefs(dir);
    assert.equal(prefs.starPromptFirstSeenAt, undefined);
    assert.equal(prefs.starPromptDismissed, undefined);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('updateUiPrefs：局部补丁合并，不覆盖未涉及的字段（防多端点互覆盖）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ui-prefs-upd-'));
  try {
    await writeUiPrefs(dir, { schemaVersion: 1, lastSyncChannel: 'webdav' });
    // star-prompt 端点更新：只补弹窗字段，lastSyncChannel 必须保留
    const next = await updateUiPrefs(dir, { starPromptFirstSeenAt: 1700000000000, starPromptClicked: true });
    assert.equal(next.lastSyncChannel, 'webdav', '未涉及的 lastSyncChannel 保留');
    assert.equal(next.starPromptFirstSeenAt, 1700000000000);
    assert.equal(next.starPromptClicked, true);
    // sync/ui-prefs 端点更新：只补通道字段，弹窗字段必须保留
    const after = await updateUiPrefs(dir, { lastSyncChannel: 'git' });
    assert.equal(after.lastSyncChannel, 'git');
    assert.equal(after.starPromptFirstSeenAt, 1700000000000, '未涉及的 Star 字段保留');
    assert.equal(after.starPromptClicked, true);
    // 磁盘最终态
    const raw = JSON.parse(await fs.readFile(path.join(dir, UI_PREFS_FILE), 'utf8'));
    assert.equal(raw.lastSyncChannel, 'git');
    assert.equal(raw.starPromptFirstSeenAt, 1700000000000);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('更新内容弹窗状态：写入字段 → 读回一致 + 原始文件校验', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ui-prefs-rn-'));
  try {
    await writeUiPrefs(dir, {
      schemaVersion: 1,
      releaseNotesLastSeenVersion: '0.1.54',
      releaseNotesDismissed: true,
    });
    const prefs = await readUiPrefs(dir);
    assert.equal(prefs.releaseNotesLastSeenVersion, '0.1.54');
    assert.equal(prefs.releaseNotesDismissed, true);
    const raw = JSON.parse(await fs.readFile(path.join(dir, UI_PREFS_FILE), 'utf8'));
    assert.equal(raw.releaseNotesLastSeenVersion, '0.1.54');
    assert.equal(raw.releaseNotesDismissed, true);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

/**
 * issue #88 / #89：回合自动留点开关（`rollbackEnabled`）。
 *
 * 钉住四条判据：① 缺省 = 关闭（fail-closed）；②「开」才落字段、「关」即字段消失；
 * ③ 任何非法输入（非布尔 / 坏 JSON / 不支持 schema）一律回关闭 —— 绝不猜用户想开；
 * ④ 本地与同步两个读法一致（宿主启动期必须能同步读到同一个判据）。
 */
test('issue #88：rollbackEnabled 往返 + 缺省与非法值一律关闭（fail-closed）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ui-prefs-rollback-'));
  const file = path.join(dir, UI_PREFS_FILE);
  try {
    // ① 文件不存在 → 关闭
    assert.equal(readRollbackEnabledSync(dir), false, '文件不存在 = 关闭');
    assert.equal((await readUiPrefs(dir)).rollbackEnabled, undefined);

    // ② 开 → 落字段 true；两个读法都认
    await writeUiPrefs(dir, { schemaVersion: 1, rollbackEnabled: true });
    assert.equal((await readUiPrefs(dir)).rollbackEnabled, true);
    assert.equal(readRollbackEnabledSync(dir), true);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).rollbackEnabled, true);

    // ③ 关 → 字段消失（缺省即关），同步读法回 false
    await writeUiPrefs(dir, { schemaVersion: 1, rollbackEnabled: false });
    assert.equal('rollbackEnabled' in JSON.parse(await fs.readFile(file, 'utf8')), false, '关闭 = 字段消失');
    assert.equal(readRollbackEnabledSync(dir), false);

    // ④ 非法输入一律回关闭
    for (const raw of ['{"schemaVersion":1,"rollbackEnabled":"yes"}', '{not-json', '{"schemaVersion":99,"rollbackEnabled":true}']) {
      await fs.writeFile(file, raw, 'utf8');
      assert.equal(readRollbackEnabledSync(dir), false, '非法输入必须回关闭：' + raw);
      assert.equal((await readUiPrefs(dir)).rollbackEnabled, undefined, '非法输入必须回关闭：' + raw);
    }

    // ⑤ updateUiPrefs 局部合并：改开关不得冲掉其它字段（多端点共写同一文件）
    await writeUiPrefs(dir, { schemaVersion: 1, lastSyncChannel: 'git' });
    await updateUiPrefs(dir, { rollbackEnabled: true });
    const merged = await readUiPrefs(dir);
    assert.equal(merged.lastSyncChannel, 'git', '局部更新不得冲掉其它字段');
    assert.equal(merged.rollbackEnabled, true);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});


