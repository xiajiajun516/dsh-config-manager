/**
 * 导入期路径映射与「文件集合」分区的关系（issue #45 ④）。
 *
 * 钉住的语义：`relativePath` 是**身份**不是配置 —— 一旦被前缀映射改写，会话文件就会落到
 * `projectKeyOf(首帧 cwd)` 之外的目录，目标机下次启动直接报 `corrupt session log`。
 * 因此文件集合分区（sessions / pluginFiles / skills …）必须整段跳过前缀映射。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMappingsToSections } from './analyzer.ts';
import { SessionsAdapter } from '../adapters/sessions.ts';
import type { SectionId } from '../schema/types.ts';
import type { PathMapping } from './types.ts';

function sessionSection(): { version: number; files: { relativePath: string; data: Uint8Array; contentHash: string }[] } {
  return {
    version: 1,
    files: [{
      relativePath: '--D-Old-proj--/session-a/session.v3.jsonl.zstd',
      data: new Uint8Array([1, 2, 3]),
      contentHash: 'h',
    }],
  };
}

const MAPPING: PathMapping[] = [{ oldPrefix: 'D:/Old', newPrefix: '/srv', appliesTo: [] }];

test('issue #45 ④：文件集合分区的 relativePath 逐字保留（连同「appliesTo 为空」的通配映射）', () => {
  const sections = new Map<SectionId, unknown>([
    ['sessions', sessionSection()],
    ['workspaces', { version: 1, workspaces: [{ id: 'w1', path: 'D:/Old/proj', title: 'p', sessionIds: [] }] }],
  ]);
  applyMappingsToSections(sections, MAPPING, new Set(['sessions']));
  const files = (sections.get('sessions') as { files: { relativePath: string }[] }).files;
  assert.equal(files[0]?.relativePath, '--D-Old-proj--/session-a/session.v3.jsonl.zstd', '会话文件位置绝不被改写');
  const ws = (sections.get('workspaces') as { workspaces: { path: string }[] }).workspaces;
  assert.equal(ws[0]?.path, '/srv/proj', '非文件集合分区照旧参与映射');
});

test('issue #45 ④：不传白名单时确实会被改写（说明白名单是防线，而非装饰）', () => {
  // 真实风险形态：映射的 oldPrefix 命中 relativePath 的**首段（projectKey）** —— 例如用户手输
  // 了 `--D-Old-proj--` 这类前缀。命中后文件会被搬到别的目录，而目录名是身份，改了就与 header 不符。
  const sections = new Map<SectionId, unknown>([['sessions', sessionSection()]]);
  applyMappingsToSections(sections, [{ oldPrefix: '--D-Old-proj--', newPrefix: '--X--', appliesTo: [] }]);
  const files = (sections.get('sessions') as { files: { relativePath: string }[] }).files;
  assert.equal(
    files[0]?.relativePath.startsWith('--X--/'),
    true,
    '旧行为会改写首段 → 文件落到 projectKeyOf(cwd) 之外 → 目标机下次启动 corrupt session log',
  );
});

test('issue #45 ④：文件集合 adapter 自报标记（Analyzer 据此构建白名单）', () => {
  assert.equal(new SessionsAdapter().fileCollection, true);
});
