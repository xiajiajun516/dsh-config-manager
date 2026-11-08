/**
 * 「保存通道配置成功」的 state 演进（./config-save-state.ts）。
 *
 * 真机背景：四通道都有输入防抖自动保存，成功后此前完全静默；
 * 而凭据清空与徽章合并原本内联在 SyncPanel，既挤占行数棘轮又不能单测。
 * 这里钉住两条不可放宽的口径：
 *  ① 只清「本次确实写出去」的凭据（保存期间用户改过输入 → 保留新值）；
 *  ② 响应只含布尔/非密视图，绝不把 secret 值写回 state。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { savedConfigState } from './config-save-state.ts';
import type { SavedConfigState } from './config-save-state.ts';
import type { SyncConfigSaveResponse, SyncStatusResponse } from './sync-api.ts';

const status = {
  ok: true,
  configured: false,
  credentialConfigured: false,
  credentialWritable: true,
  sectionCount: 0,
} as SyncStatusResponse;

const base: SavedConfigState = {
  savingConfig: true,
  webdavPassword: '',
  token: '',
  s3Secret: '',
  gistToken: '',
  statusInfo: null,
};

function state(over: Partial<SavedConfigState> = {}): SavedConfigState {
  return { ...base, ...over };
}

test('savingConfig 复位：无论成功与否，落库的 state 都不再处于保存中', () => {
  const next = savedConfigState(state(), { ok: true, configured: true, transport: 'git', credentialConfigured: true }, {});
  assert.equal(next.savingConfig, false);
});

test('git：token 等于本次发出的值 → 清空（已写入 credentials）', () => {
  const next = savedConfigState(state({ token: 'ghp_sent' }), { ok: true, configured: true, transport: 'git', credentialConfigured: true }, { token: 'ghp_sent' });
  assert.equal(next.token, '');
});

test('git：保存期间用户改了输入（token ≠ 发出的值）→ 保留用户新输入', () => {
  const next = savedConfigState(state({ token: 'ghp_new' }), { ok: true, configured: true, transport: 'git', credentialConfigured: true }, { token: 'ghp_sent' });
  assert.equal(next.token, 'ghp_new');
});

test('webdav：password 走同一口径；未发出的空值不会被当成「清空依据」', () => {
  const cleared = savedConfigState(state({ webdavPassword: 'pw' }), { ok: true, configured: true, transport: 'webdav', credentialConfigured: false }, { password: 'pw' });
  assert.equal(cleared.webdavPassword, '');
  const kept = savedConfigState(state({ webdavPassword: 'pw-other' }), { ok: true, configured: true, transport: 'webdav', credentialConfigured: false }, { password: 'pw' });
  assert.equal(kept.webdavPassword, 'pw-other');
});

test('s3 / gist：secret 槽位共用 → 各自按同一口径清空，互不影响别的通道', () => {
  const next = savedConfigState(state({ s3Secret: 'sk', gistToken: 'gh' }), { ok: true, configured: true, transport: 's3', credentialConfigured: false }, { secret: 'sk' });
  assert.equal(next.s3Secret, '', 's3 密钥已写入 → 清空');
  assert.equal(next.gistToken, 'gh', 'gist token 不等于本次 secret → 保留');
});

test('statusInfo 为 null（还没拉到 /sync/status）→ 不做徽章合并，留待 loadStatus', () => {
  const next = savedConfigState(state(), { ok: true, configured: true, transport: 'git', credentialConfigured: true }, {});
  assert.equal(next.statusInfo, null);
});

test('徽章合并：configured / credentialConfigured 取响应；webdav 保留本机 url 与 username', () => {
  const withWebdav = { ...status, webdav: { url: 'https://dav.example.com', username: 'me', usernameConfigured: true, passwordConfigured: false } } as SyncStatusResponse;
  const saved: SyncConfigSaveResponse = {
    ok: true,
    configured: true,
    transport: 'webdav',
    credentialConfigured: false,
    webdav: { usernameConfigured: true, passwordConfigured: true },
  };
  const next = savedConfigState(state({ statusInfo: withWebdav }), saved, {});
  assert.equal(next.statusInfo?.configured, true);
  assert.deepEqual(next.statusInfo?.webdav, {
    url: 'https://dav.example.com',
    username: 'me',
    usernameConfigured: true,
    passwordConfigured: true,
  });
});

test('徽章合并：s3 / gist 非密视图原样并入（响应里没有就不动旧值）', () => {
  const cloudS3 = { secretStored: true } as unknown as NonNullable<SyncStatusResponse['s3']>;
  const next = savedConfigState(
    state({ statusInfo: status }),
    { ok: true, configured: true, transport: 's3', credentialConfigured: false, s3: cloudS3 },
    {},
  );
  assert.equal(next.statusInfo?.s3, cloudS3);
  assert.equal(next.statusInfo?.gist, undefined, '响应没带 gist 视图 → 不得凭空造出');
});
