/**
 * patch 层身份（issue #71）：层路径判定、两层读取的覆盖序、写回落点定位。
 *
 * 这些是「备份不到外壳 mcp」的根因所在：此前 MCP / prompts 只读 home 层，而真实行在
 * profile 层。本文件把「读两层 + 谁覆盖谁 + 写回哪一层」这三条规则单独钉住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isPatchLayerRel, isProfilePatchRel, locatePatchLineLayer, patchLayerRels,
  profilePatchRel, readEffectivePatchLines, resolveWriteLayer, USER_PATCH_FILE,
} from './patch-layers.ts';
import { MemPatch } from '../adapters/test-helpers.ts';
import type { PatchFileFacade } from './types.ts';

const PROFILE_REL = 'profiles/tauri/cordis.patch.yml';

test('patch 层路径：用户层与 profile 层判定（拒绝越界与非法 profile 名）', () => {
  assert.equal(USER_PATCH_FILE, 'cordis.patch.yml');
  assert.equal(profilePatchRel('tauri'), PROFILE_REL);
  assert.equal(profilePatchRel(undefined), 'profiles/web/cordis.patch.yml', '缺省 profile 回落 web（与 backup 同口径）');
  assert.equal(profilePatchRel(''), 'profiles/web/cordis.patch.yml');

  assert.equal(isProfilePatchRel(PROFILE_REL), true);
  assert.equal(isProfilePatchRel('profiles/tauri/other.yml'), false);
  assert.equal(isProfilePatchRel('profiles//cordis.patch.yml'), false, '空 profile 名不是合法层');
  assert.equal(isProfilePatchRel('profiles/../cordis.patch.yml'), false, '「..」不是合法 profile 名');
  assert.equal(isProfilePatchRel('profiles/tauri/cordis.patch.yml/../x'), false);

  assert.equal(isPatchLayerRel(USER_PATCH_FILE), true);
  assert.equal(isPatchLayerRel(PROFILE_REL), true);
  assert.equal(isPatchLayerRel('profiles\\tauri\\cordis.patch.yml'), true, 'Windows 反斜杠写法同样识别（快照 JSON 可能来自另一平台）');
  assert.equal(isPatchLayerRel('settings.yaml'), false);
  assert.equal(isPatchLayerRel('cordis.patch.yaml'), false);
});

test('patch 层优先级：home 层在前（DSH 的 readProfilePatches 是 home 覆盖 profile）', () => {
  assert.deepEqual(patchLayerRels('tauri'), [USER_PATCH_FILE, PROFILE_REL]);
});

test('readEffectivePatchLines：两层都读；同名行取优先级最高的一层，且每行带层身份', async () => {
  const patchFile = new MemPatch();
  patchFile.lines.set('mcp-fs', { lineId: 'mcp-fs', raw: { id: 'mcp-fs', name: 'dsh-mcp-client' } });
  // profile 层：一行与 home 层同名（应被覆盖）、一行只在 profile 层（真机形态）
  patchFile.bucket(PROFILE_REL).set('mcp-fs', { lineId: 'mcp-fs', raw: { id: 'mcp-fs', name: 'profile-shadowed' } });
  patchFile.bucket(PROFILE_REL).set('mcp-codegraph', { lineId: 'mcp-codegraph', raw: { id: 'mcp-codegraph', name: 'dsh-mcp-client' } });

  const read = await readEffectivePatchLines(patchFile, 'tauri');
  assert.deepEqual(read.failures, []);
  assert.deepEqual(
    read.lines.map((l) => [l.lineId, l.file]),
    [['mcp-fs', USER_PATCH_FILE], ['mcp-codegraph', PROFILE_REL]],
    'home 层的同名行覆盖 profile 层；profile 层独有的行必须被读到',
  );
  assert.equal((read.lines[0]?.raw as Record<string, unknown>)['name'], 'dsh-mcp-client', '导出的必须是生效值（home 层）');
});

test('readEffectivePatchLines：单层读失败不阻塞另一层，失败如实登记', async () => {
  const patchFile: PatchFileFacade = {
    async readPatchLines(file: string) {
      if (file === USER_PATCH_FILE) return [{ lineId: 'a', raw: { id: 'a' } }];
      throw new Error('读取失败示例');
    },
    async applyPatchChanges() { return { downgraded: [] } },
  };
  const read = await readEffectivePatchLines(patchFile, 'tauri');
  assert.equal(read.lines.length, 1, '坏的那层不能拖垮好的一层');
  assert.equal(read.failures.length, 1);
  assert.equal(read.failures[0]?.file, PROFILE_REL);
  assert.equal(read.failures[0]?.reason, '读取失败示例');
});

test('resolveWriteLayer：来源层 → 目标机同语义层（跨机器不照抄 profile 名）', () => {
  assert.equal(resolveWriteLayer(undefined, 'tauri'), USER_PATCH_FILE, '旧备份包无来源层 → 用户层（改造前行为）');
  assert.equal(resolveWriteLayer(USER_PATCH_FILE, 'tauri'), USER_PATCH_FILE);
  assert.equal(
    resolveWriteLayer(PROFILE_REL, 'web'),
    'profiles/web/cordis.patch.yml',
    '来源是 tauri 的 profile 层 → 落到目标机当前 profile（web），绝不照抄 tauri（会被宿主门面拒绝）',
  );
  assert.equal(resolveWriteLayer('profiles\\tauri\\cordis.patch.yml', 'web'), 'profiles/web/cordis.patch.yml', '反斜杠写法同样识别');
  assert.equal(resolveWriteLayer('settings.yaml', 'web'), USER_PATCH_FILE, '不认识的来源 → 用户层（不猜）');
});

test('locatePatchLineLayer：写回落回原行所在层；两层都没有 → 用户层（新行旧行为）', async () => {
  const patchFile = new MemPatch();
  patchFile.bucket(PROFILE_REL).set('mcp-codegraph', { lineId: 'mcp-codegraph', raw: { id: 'mcp-codegraph' } });
  patchFile.lines.set('mcp-fs', { lineId: 'mcp-fs', raw: { id: 'mcp-fs' } });

  assert.equal(await locatePatchLineLayer(patchFile, 'tauri', 'mcp-codegraph'), PROFILE_REL);
  assert.equal(await locatePatchLineLayer(patchFile, 'tauri', 'mcp-fs'), USER_PATCH_FILE);
  assert.equal(await locatePatchLineLayer(patchFile, 'tauri', 'brand-new'), USER_PATCH_FILE, '新行落用户层');
});
