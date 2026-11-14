/**
 * 配置表单的 dirty 保护（./config-dirty.ts）。
 *
 * 真机背景（P9-4）：loadStatus 无条件回填会在用户打字时（600ms 防抖未到）把输入抹回宿主旧值。
 * 这里钉住三条不可放宽的口径：
 *  ① dirty 集合由**用户实际改过的键**动态构成（不硬编码字段白名单，新增字段自动受保护）；
 *  ② 回填只跳过 dirty 命中键，非 dirty 键照旧写入；
 *  ③ 纯函数：不修改入参，返回新对象 / 新 Set。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearDirtyFields, formPatchFromStatus, markDirty, pruneDirtyFields, resetDirty,
} from './config-dirty.ts';
import type { StatusFormSource } from './config-dirty.ts';

test('D-1 markDirty 并入用户改过的键，且不改入参', () => {
  const before = new Set(['repoUrl']);
  const next = markDirty(before, ['gitSubdir', 'repoUrl']);
  assert.deepEqual([...next], ['repoUrl', 'gitSubdir']);
  assert.deepEqual([...before], ['repoUrl']);
  assert.notEqual(next, before, 'dirty 集合必须整体替换（ref 赋值依赖新引用）');
});

test('D-2 markDirty 空 keys 返回等价副本（不动原集合）', () => {
  const before = new Set(['webdavUrl']);
  const next = markDirty(before, []);
  assert.deepEqual([...next], ['webdavUrl']);
  assert.notEqual(next, before);
});

test('D-3 pruneDirtyFields 丢掉 dirty 命中键，保留其余键且不改入参', () => {
  const patch = { repoUrl: 'https://example.invalid/r.git', gitSubdir: 'sub', token: 't' };
  const out = pruneDirtyFields(patch, new Set(['repoUrl']));
  assert.deepEqual(out, { gitSubdir: 'sub', token: 't' });
  assert.deepEqual(patch, { repoUrl: 'https://example.invalid/r.git', gitSubdir: 'sub', token: 't' });
  assert.notEqual(out, patch);
});

test('D-4 pruneDirtyFields 空 dirty = 全量保留；dirty 全命中 = 空补丁', () => {
  const patch = { a: 1, b: 'x' };
  assert.deepEqual(pruneDirtyFields(patch, new Set()), { a: 1, b: 'x' });
  assert.deepEqual(pruneDirtyFields(patch, new Set(['a', 'b'])), {});
});

test('D-5 clearDirtyFields 只撤销指定键（其余保持 dirty）', () => {
  const dirty = new Set(['repoUrl', 'gitSubdir', 'webdavUrl']);
  const next = clearDirtyFields(dirty, ['repoUrl', 'gitSubdir']);
  assert.deepEqual([...next], ['webdavUrl']);
  assert.deepEqual([...dirty], ['repoUrl', 'gitSubdir', 'webdavUrl'], '入参不得被修改');
});

test('D-6 resetDirty 返回空集合', () => {
  assert.equal(resetDirty().size, 0);
});

const status: StatusFormSource = {
  repoUrl: 'https://host.invalid/repo.git',
  subdir: 'nested',
  webdav: { url: 'https://dav.invalid/dav', username: 'alice' },
  s3: {
    provider: 'r2', endpoint: 'https://s3.invalid', region: 'auto', bucket: 'b',
    prefix: 'p', accessKeyId: 'AKID', pathStyle: true,
  },
  gist: { gistId: 'g1', apiBaseUrl: 'https://api.invalid', filePrefix: 'dcm-' },
};

test('D-7 formPatchFromStatus：dirty 命中键不被宿主旧值覆盖，其余字段照旧回填', () => {
  const out = formPatchFromStatus(status, new Set(['repoUrl', 'webdavUsername']));
  assert.equal('repoUrl' in out, false, '用户正在输入的键必须缺席（否则会覆盖输入）');
  assert.equal('webdavUsername' in out, false);
  assert.equal(out.gitSubdir, 'nested');
  assert.equal(out.webdavUrl, 'https://dav.invalid/dav');
  assert.equal(out.s3Bucket, 'b');
  assert.equal(out.s3PathStyle, true);
  assert.equal(out.gistFilePrefix, 'dcm-');
});

test('D-8 formPatchFromStatus：dirty 为空 = 全量回填；缺失视图按空值回填，且绝不带密钥字段', () => {
  const full = formPatchFromStatus(status, new Set());
  assert.equal(full.repoUrl, 'https://host.invalid/repo.git');
  const empty = formPatchFromStatus({}, new Set());
  assert.deepEqual(empty, {
    repoUrl: '', gitSubdir: '', webdavUrl: '', webdavUsername: '',
    s3Provider: 's3', s3Endpoint: '', s3Region: '', s3Bucket: '', s3Prefix: '',
    s3AccessKeyId: '', s3PathStyle: false, gistId: '', gistApiBaseUrl: '', gistFilePrefix: '',
  });
  assert.equal('s3Secret' in empty, false);
  assert.equal('gistToken' in empty, false, '密钥字段永不参与回填（宿主也不回传值）');
});
