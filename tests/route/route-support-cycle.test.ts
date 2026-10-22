/**
 * P4 依赖方向守卫：`src/routes/**` 不得反向 import 组合根 `src/index.ts`。
 *
 * 背景（审计证据）：拆分前有 9 个路由组文件从 `../index.ts` 取值（consult/import/market/me/prefs/
 * profiles/recovery/snapshots/sync），而 `src/index.ts` 又 import `buildRoutes()` → 形成
 * 「入口 → routes → 组文件 → 入口」的运行时 import 环（13 文件 SCC）。共享纯工具现下沉到
 * `src/routes/route-support.ts`，依赖方向变为单向。
 *
 * 本测试用源码级解析（不 import 宿主入口，避免 peer 依赖）守住这条方向：
 *  1. `src/routes/**` 里**值导入** `../index.ts` 一律禁止（`import type` 允许 —— context.ts 的
 *     RoutesEnv 类型仍从组合根推断，编译期边不产生运行时环）；
 *  2. `src/routes/route-support.ts` 自身也不得 import 组合根（否则环立刻回来）；
 *  3. 组合根的对外导出面仍保留这些符号（`src/index.sync.test.ts` 等既有测试依赖它们，
 *     删掉会让既有测试直接 TS 报错，属于隐性 breaking）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const ROUTES = path.join(SRC, 'routes');

interface ImportRef {
  /** 相对 specifier（原样） */
  spec: string;
  /** true = `import type` / `export type`（编译期边，不产生运行时环） */
  typeOnly: boolean;
  /** 1-based 行号 */
  line: number;
}

/** 逐行累积一条 import/export 声明（支持跨行），返回 from 的 specifier。 */
function scanImports(text: string): ImportRef[] {
  const out: ImportRef[] = [];
  const lines = text.split(/\r?\n/);
  let pending: { startLine: number; head: string } | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const trimmed = line.trim();
    if (pending === null) {
      if (/^(import|export)\b/.test(trimmed) && !trimmed.startsWith('import(')) {
        pending = { startLine: i + 1, head: trimmed };
      } else {
        continue;
      }
    } else {
      pending.head += ' ' + trimmed;
    }
    const m = /from\s+['"]([^'"]+)['"]/.exec(pending.head);
    const sideEffect = /^import\s+['"]([^'"]+)['"]/.exec(pending.head);
    if (m || sideEffect) {
      const spec = (m?.[1] ?? sideEffect?.[1]) as string;
      out.push({ spec, typeOnly: /^(import|export)\s+type\b/.test(pending.head), line: pending.startLine });
      pending = null;
      continue;
    }
    // 声明结束（没有 from 的 import 不存在于本仓库；到 }

    if (trimmed.endsWith('}') || trimmed.endsWith(';')) {
      pending = null;
    }
  }
  return out;
}

function listSources(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listSources(full, acc);
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.d.ts')) continue;
    acc.push(full);
  }
  return acc;
}

test('路由层不得值导入组合根 src/index.ts（运行时 import 环已拆）', () => {
  const files = listSources(ROUTES);
  assert.ok(files.length > 10, '路由目录源文件数异常少：' + String(files.length));
  const offenders: string[] = [];
  for (const file of files) {
    const refs = scanImports(fs.readFileSync(file, 'utf8'));
    for (const ref of refs) {
      if (ref.typeOnly) continue;
      if (!ref.spec.endsWith('index.ts')) continue;
      const target = path.resolve(path.dirname(file), ref.spec);
      if (target !== path.join(SRC, 'index.ts')) continue;
      offenders.push(path.relative(ROOT, file) + ':' + String(ref.line) + " → '" + ref.spec + "'");
    }
  }
  assert.deepEqual(offenders, [], '这些路由源文件仍在值导入组合根，环会回来：\n' + offenders.join('\n'));
});

test('route-support 自身不得 import 组合根，也不得 import 组文件', () => {
  const file = path.join(ROUTES, 'route-support.ts');
  const refs = scanImports(fs.readFileSync(file, 'utf8'));
  const coreEntry = path.join(SRC, 'index.ts');
  const groupFile = /^\.\/(backup|consult|foreign|history|import|market|me|messages|prefs|profiles|recovery|session-export|snapshots|sync)\.ts$/;
  const bad = refs.filter((ref) => {
    // 兄弟模块只允许 kit.ts / context.ts 这类无反向依赖的（组文件会形成 route-support ↔ 组文件）
    if (groupFile.test(ref.spec)) return true;
    if (!ref.spec.startsWith('.')) return false;
    return path.resolve(path.dirname(file), ref.spec) === coreEntry;
  });
  assert.deepEqual(bad.map((b) => b.spec + ' @L' + String(b.line)), []);
});

test('组合根仍导出被下沉的符号（导出面不缩水）', () => {
  const text = fs.readFileSync(path.join(SRC, 'index.ts'), 'utf8');
  const required = [
    'REVIEW_KINDS',
    'buildAutosyncStatus',
    'buildAutosyncStatusByChannel',
    'buildFileDiffBody',
    'buildRestoreBody',
    'executeRestorePlan',
    'extractSyncSections',
    'extractSyncSessions',
    'isAutosyncInterval',
    'isToolchainChangeItem',
    'makeRestoreExecutor',
    'planToConfirmItems',
    'sessionHealthNextSteps',
    'SyncRouteError',
    'credentialRef',
    'writeProfileError',
  ];
  const missing = required.filter((name) => !new RegExp('(^|[,{\\s])' + name + '([,}\\s]|$)').test(text));
  assert.deepEqual(missing, [], '组合根丢了这些导出（既有测试/调用方会断）：' + missing.join(', '));
});
