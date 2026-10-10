import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = (await import(new URL('../scripts/check-agents-budget.mjs', import.meta.url).href)) as {
  LIMITS: { hardCapBytes: number; warnBytes: number; maxLineBytes: number };
  evaluateAgentsText: (t: string, pathExists?: (p: string) => boolean) => { bytes: number; errors: string[]; warnings: string[]; refs: string[] };
  checkAgentsDoc: () => { bytes: number; errors: string[]; warnings: string[]; refs: string[] };
};

test('AGENTS.md 预算守卫：当前仓库零 error', () => {
  const r = mod.checkAgentsDoc();
  assert.deepEqual(r.errors, [], r.errors.join('\n'));
  assert.ok(r.bytes < mod.LIMITS.hardCapBytes, `AGENTS.md ${r.bytes} B`);
});

test('AGENTS.md 预算守卫：超大文件必红（阈值本身有效）', () => {
  const r = mod.evaluateAgentsText('x'.repeat(mod.LIMITS.hardCapBytes + 1));
  assert.ok(r.errors.some((e) => /超过硬上限/.test(e)), r.errors.join('\\n'));
});

test('AGENTS.md 预算守卫：证据级长行必红（防「把证据写回来」）', () => {
  const r = mod.evaluateAgentsText('- **某条**：' + '证'.repeat(mod.LIMITS.maxLineBytes));
  assert.ok(r.errors.some((e) => /单行/.test(e)), r.errors.join('\n'));
});

test('AGENTS.md 预算守卫：悬空 docs 指针必红', () => {
  const r = mod.evaluateAgentsText('- 见 `docs/does-not-exist.md`', () => false);
  assert.ok(r.errors.some((e) => /不存在的文件/.test(e)), r.errors.join('\n'));
});
