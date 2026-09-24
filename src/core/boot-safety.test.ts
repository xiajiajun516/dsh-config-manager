/**
 * 启动自洽审计单测（core / 零 IO：读写与 bundle 解析全部注入）。
 *
 * 断言的是「安全承诺」而不是实现细节：
 *  - 唯一自动修正项是**剔除解析不到的 bundle**，且必须写回；写不回去必须报 unsafe；
 *  - 未注入的能力记入 unchecked（**绝不**当作通过）；
 *  - 审计自身不抛错（extraChecks 炸了也只是一条 issue + unchecked）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { auditBootSafety } from '../../src/core/boot-safety.ts';
import type { BootSafetyIssue, BootSafetyReport } from '../../src/core/boot-safety.ts';

const PROFILE = 'web';
const PKG_REL = 'profiles/web/package.json';

function pkgText(bundles: unknown[]): string {
  return JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles } } }, null, 2);
}

/** 内存读写面 + 可控的 bundle 解析与写失败。 */
function harness(init: Record<string, string>, resolvable: string[] = []) {
  const files = new Map<string, string>(Object.entries(init));
  const written: { rel: string; text: string }[] = [];
  let failWrite = false;
  return {
    files,
    written,
    failWrite: (v: boolean) => { failWrite = v; },
    deps: {
      profile: PROFILE,
      readText: async (rel: string): Promise<string | null> => files.get(rel) ?? null,
      writeText: async (rel: string, text: string): Promise<void> => {
        if (failWrite) throw new Error('磁盘只读');
        files.set(rel, text);
        written.push({ rel, text });
      },
      resolveBundle: async (name: string): Promise<boolean> => resolvable.includes(name),
    },
  };
}

function ids(report: BootSafetyReport): string[] { return report.issues.map((i: BootSafetyIssue) => i.id); }

test('S-01 解析不到的 bundle：剔除 + 写回 + verdict=repaired', async () => {
  const h = harness({ [PKG_REL]: pkgText(['@deepseek-ai/dsh-base', 'ghost-plugin']) }, ['@deepseek-ai/dsh-base']);
  const report = await auditBootSafety(h.deps);
  assert.equal(report.verdict, 'repaired');
  assert.deepEqual(report.prunedBundles, [{ name: 'ghost-plugin', reason: 'unresolved' }]);
  assert.ok(report.issues.some((i) => i.id === 'bundlesUnresolved' && i.fixed === true));
  assert.equal(h.written.length, 1);
  const saved = JSON.parse(h.written[0]?.text ?? '{}') as { dsh: { profile: { bundles: string[] } } };
  assert.deepEqual(saved.dsh.profile.bundles, ['@deepseek-ai/dsh-base'], '写回的必须是剔除后的清单');
});

test('S-02 全部可解析：不写文件、verdict=safe', async () => {
  const h = harness({ [PKG_REL]: pkgText(['@deepseek-ai/dsh-base']) }, ['@deepseek-ai/dsh-base']);
  const report = await auditBootSafety(h.deps);
  assert.equal(report.verdict, 'safe');
  assert.deepEqual(report.issues, []);
  assert.equal(h.written.length, 0, 'safe 分支不得改盘');
});

test('S-03 剔除写不回：must 报 unsafe（绝不假装已修好）', async () => {
  const h = harness({ [PKG_REL]: pkgText(['ghost-plugin']) }, []);
  h.failWrite(true);
  const report = await auditBootSafety(h.deps);
  assert.equal(report.verdict, 'unsafe');
  assert.ok(ids(report).includes('bundlesUnresolvedUnfixed'));
  assert.ok(report.issues.every((i) => i.fixed === false));
});

test('S-04 profile package.json 不可解析：error 级 issue + unsafe', async () => {
  const h = harness({ [PKG_REL]: '{ not json' }, []);
  const report = await auditBootSafety(h.deps);
  assert.equal(report.verdict, 'unsafe');
  assert.ok(ids(report).includes('criticalFileUnparsable'));
});

test('S-05 patchedDependencies 指向缺失 patch：error 级 issue（pnpm 会拒绝一切 add）', async () => {
  const h = harness({
    [PKG_REL]: pkgText([]),
    'profiles/web/pnpm-workspace.yaml': 'patchedDependencies:\n  foo@1.0.0: patches/foo.patch\n',
  }, []);
  const report = await auditBootSafety({
    ...h.deps,
    parseYaml: () => ({ patchedDependencies: { 'foo@1.0.0': 'patches/foo.patch' } }),
  });
  assert.equal(report.verdict, 'unsafe');
  assert.ok(ids(report).includes('patchFileMissing'));
});

test('S-06 未注入 YAML 解析器：记 unchecked，绝不当作通过', async () => {
  const h = harness({ [PKG_REL]: pkgText([]), 'settings.yaml': 'locale: zh\n' }, []);
  const report = await auditBootSafety(h.deps);
  assert.deepEqual(report.unchecked, ['yaml', 'extra']);
  assert.equal(report.verdict, 'safe', 'verdict 只描述已执行的检查');
});

test('S-07 关键文件缺失不算问题（多数机器没有 settings.json / .env）', async () => {
  const h = harness({ [PKG_REL]: pkgText([]) }, []);
  const report = await auditBootSafety(h.deps);
  assert.deepEqual(report.issues, []);
});

test('S-08 附加检查抛错：不冒泡，记 unchecked + warn issue', async () => {
  const h = harness({ [PKG_REL]: pkgText([]) }, []);
  const report = await auditBootSafety({
    ...h.deps,
    extraChecks: async () => { throw new Error('会话探测器不可用'); },
  });
  assert.deepEqual(report.unchecked, ['extra']);
  assert.ok(report.issues.some((i) => i.id === 'extraCheckFailed' && i.severity === 'warn'));
  assert.equal(report.verdict, 'safe', 'warn 不应把结论升级成 unsafe');
});

test('S-09 附加检查的 issue 会被并入报告（宿主专项检查的唯一接入口）', async () => {
  const h = harness({ [PKG_REL]: pkgText([]) }, []);
  const report = await auditBootSafety({
    ...h.deps,
    extraChecks: async () => [{ id: 'extraCheckFailed', severity: 'error', detail: '会话位置不对', fixed: false }],
    parseYaml: () => ({}),
  });
  assert.equal(report.verdict, 'unsafe');
  assert.ok(report.issues.some((i) => i.detail === '会话位置不对'));
});

test('S-10 DSH 核心 bundle 探测失败：只告警、绝不剪（剪掉等于我们让 DSH 起不来）', async () => {
  const h = harness({
    [PKG_REL]: pkgText(['@deepseek-ai/dsh-base', 'ghost-plugin']),
  }, []);
  const report = await auditBootSafety(h.deps);
  assert.deepEqual(report.prunedBundles, [{ name: 'ghost-plugin', reason: 'unresolved' }], '只剪非核心项');
  assert.ok(!report.issues.some((i) => i.detail.includes('@deepseek-ai/dsh-base')), '核心项静默保留：既不剪也不刷告警（DSH 从自己的安装位置解析）');
  const saved = JSON.parse(h.written[0]?.text ?? '{}') as { dsh: { profile: { bundles: string[] } } };
  assert.deepEqual(saved.dsh.profile.bundles, ['@deepseek-ai/dsh-base'], '核心 bundle 必须原样留在清单里');
});
