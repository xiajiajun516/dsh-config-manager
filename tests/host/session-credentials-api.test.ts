/**
 * issue #39 Feature 1–3 的宿主接线守卫 + 新门面方法的**真实文件系统**验证。
 *
 * 为什么需要源码级断言：这两处接线（路由解析 sessions.limit、analyze 解出 credentials）在纯函数与
 * 适配器单测里都覆盖不到 —— 单测直接调 adapter/exporter，绕过 HTTP 层。本仓库已有同类先例
 * （`tests/host/export-item-selection.test.ts`、`src/core/model-tools.test.ts` 的宿主接线守卫）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DshFileSystemFacade } from '../../src/index.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fsSync.readFileSync(path.join(root, 'src/index.ts'), 'utf8');

/** 取某个路由声明之后的一段源码（路由块很长，取足以覆盖其 handler 的窗口）。 */
function routeBlock(marker: string, span: number): string {
  const start = source.indexOf(marker);
  assert.ok(start > 0, `未找到路由：${marker}`);
  return source.slice(start, start + span);
}

test('issue #39 F1：FileSystemFacade.mtimeMs 在真实文件系统上返回时间，缺失→null，越界→拒绝', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-fs-mtime-'));
  try {
    await fs.mkdir(path.join(home, 'sessions', '--p--', 's1'), { recursive: true });
    await fs.writeFile(path.join(home, 'sessions', '--p--', 's1', 'session.jsonl.zstd'), 'x');
    const facade = new DshFileSystemFacade(home);
    const ms = await facade.mtimeMs('sessions/--p--/s1/session.jsonl.zstd');
    assert.equal(typeof ms, 'number', '存在的文件必须给出毫秒时间戳');
    assert.ok(Math.abs(Date.now() - (ms as number)) < 60_000, 'mtime 应为刚刚写入的时间');
    assert.equal(
      await facade.mtimeMs('sessions/--p--/gone/session.jsonl.zstd'),
      null,
      '文件不存在 → null（绝不能返回 0：那会被排序当成「最旧」而静默丢掉最近的会话）',
    );
    await assert.rejects(() => facade.mtimeMs('../../etc/passwd'), '仍受 home 根约束（不得因新增方法开洞）');
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('导入体验：宿主 /plan 真的给 sessions 计划项补了会话标题（接线不能丢）', () => {
  const block = routeBlock('path: API.plan,', 3000);
  assert.match(block, /applySessionMetaToPlanItems\(plan\.items, await readSessionMeta\(host\)\)/, '计划项必须经会话元数据富化，否则导入页只能显示会话目录名');
  assert.match(block, /catch \{/, '元数据读不到时不得让计划生成失败（退回目录名）');
});
test('issue #39 F1：宿主 /export 真的解析并下发 sessions: { limit }', () => {
  const block = routeBlock('path: API.export,', 20000);
  assert.match(block, /const sessionsBody = body\['sessions'\]/, '路由必须解析 sessions 字段');
  assert.match(block, /sessions !== undefined \? \{ sessions \}/, '解析结果必须真的下发给 Exporter');
});

test('issue #39 F2：宿主 /analyze 支持可选 decryptPassword 并回传 credentials 摘要', () => {
  const block = routeBlock('path: API.analyze,', 6000);
  assert.match(block, /body\?\.\['decryptPassword'\]/, '路由必须接受可选解密密码');
  assert.match(block, /tryDecryptCredentials\(zipPath, analyzePassword\)/, '密码必须经统一解析口径解出 ref');
  assert.match(block, /analyzeImport\(zipPath, \{ decryptedCredentials \}\)/, '解出的凭据必须交给分析器');
});
