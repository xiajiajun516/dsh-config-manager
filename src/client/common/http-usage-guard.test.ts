/**
 * W4 请求封装收敛守卫（**源码级**）。
 *
 * 为什么是源码级：本仓库浏览器侧没有组件测试框架，「每个请求都经过统一封装」只能靠源码断言
 * 锁死（沿用 `src/client/common/plan-text-redaction.test.ts` 的模式）。这三条断言直接给出
 * 验收所需的证据「无超时点 -> 0」：
 *
 *  1. 7 个 api 文件里**不得**再出现裸 `fetch(` / `new AbortController(` / 本地
 *     `readJson`|`postJson`|`getJson` 定义 —— 裸 fetch 正是「无超时点」的形态；
 *  2. 每个 api 文件必须 import `common/http.ts`（否则第 1 条可以靠「什么都不请求」骗过）；
 *  3. 路由前缀字面量 `'/api/dsh-config-manager…` 只允许出现在 `common/routes.ts`
 *     （路由常量单点化）。
 *
 * 扫描器只剥注释、**保留字符串**内容，且以「真实调用形态」为锚（不是 indexOf 任意文本）：
 * 注释里的同名串会被剥掉，而 `await fetch(` 这类调用形态一旦回来就会点名。
 * 守卫自身的有效性由最后一条用例（合成样本 → 必须被点名）保证：改回去即红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根（本文件位于 src/client/common/） */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** W4 收敛范围内的 api 文件（与 common/http.ts 一一对应）。 */
const API_FILES = [
  'src/client/api.ts',
  'src/client/history/history-api.ts',
  'src/client/lifecycle/lifecycle-api.ts',
  'src/client/market/market-api.ts',
  'src/client/market/my-configs-api.ts',
  'src/client/recovery/recovery-api.ts',
  'src/client/sync/sync-api.ts',
] as const;

/**
 * 去掉注释、保留字符串内容（`\/` 与 `/* *\/`；字符串/模板里的转义不误判）。
 * 说明：保留字符串是有意为之——若把 `fetch(` 写进字符串也应被看见（宁严不松）。
 */
function codeOnly(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') {
          out += src[i]! + (src[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 裸请求/超时/本地封装形态（源码级锚点）。 */
function violations(code: string): string[] {
  const found: string[] = [];
  if (/await fetch\(/.test(code)) found.push('await fetch(');
  if (/\bnew AbortController\(/.test(code)) found.push('new AbortController(');
  for (const name of ['readJson', 'postJson', 'getJson']) {
    if (new RegExp(`(async\\s+)?function\\s+${name}\\b`).test(code)) found.push(`function ${name}`);
  }
  return found;
}

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** 递归收集客户端非测试源码（src/client/**，只含 .ts/.tsx）。 */
function clientSources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) clientSources(full, out);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.test.tsx')) out.push(full);
  }
  return out;
}

test('guard-00 扫描器有效：注释被剥掉、调用形态被点名（回退即红）', () => {
  const sample = [
    "// 注释里的 await fetch('/api/commented') 不算（必须被剥掉）",
    '/* async function readJson() {} 同理 */',
    "const r = await fetch('/api/x');",
    'const c = new AbortController();',
    'async function readJson() {}',
  ].join('\n');
  assert.equal(codeOnly(sample).includes('commented'), false, '注释必须被剥掉（含注释里的字符串）');
  assert.deepEqual(violations(codeOnly(sample)), ['await fetch(', 'new AbortController(', 'function readJson']);
});

test('guard-01 7 个 api 文件：无裸 fetch / AbortController / 本地 readJson|postJson|getJson', () => {
  for (const file of API_FILES) {
    const code = codeOnly(read(file));
    assert.deepEqual(violations(code), [], `${file} 不得再出现裸请求或本地封装（W4 收敛：唯一实现在 common/http.ts）`);
  }
});

test('guard-02 7 个 api 文件：都 import 了统一封装 common/http.ts', () => {
  for (const file of API_FILES) {
    const code = codeOnly(read(file));
    assert.match(
      code,
      /from '\.\.?(\/\.\.)?\/common\/http\.ts'/,
      `${file} 必须从 common/http.ts 取请求封装（否则 guard-01 会因「完全不请求」而假绿）`,
    );
  }
});

test('guard-03 唯一实现只存在于 common/http.ts（readJson/postJson/getJson 各一份）', () => {
  const code = codeOnly(read('src/client/common/http.ts'));
  assert.match(code, /export async function readJson<T>/, 'common/http.ts 必须是 readJson 的唯一实现');
  assert.match(code, /export function getJson<T>/, 'common/http.ts 必须是 getJson 的唯一实现');
  assert.match(code, /export function postJson<T>/, 'common/http.ts 必须是 postJson 的唯一实现');
  // 全客户端只应有一处定义（其余文件已由 guard-01 排除）
  const definitions: string[] = [];
  for (const file of clientSources(path.join(ROOT, 'src/client'))) {
    const src = codeOnly(fs.readFileSync(file, 'utf8'));
    if (/(async\s+)?function\s+(readJson|postJson|getJson)\b/.test(src)) {
      definitions.push(path.relative(ROOT, file).split(path.sep).join('/'));
    }
  }
  assert.deepEqual(definitions, ['src/client/common/http.ts'], 'readJson/postJson/getJson 的定义点必须只剩一处');
});

test('guard-04 路由前缀字面量只在 common/routes.ts（客户端单点化）', () => {
  const carriers: string[] = [];
  for (const file of clientSources(path.join(ROOT, 'src/client'))) {
    const src = codeOnly(fs.readFileSync(file, 'utf8'));
    if (/['"]\/api\/dsh-config-manager/.test(src)) {
      carriers.push(path.relative(ROOT, file).split(path.sep).join('/'));
    }
  }
  assert.deepEqual(carriers, ['src/client/common/routes.ts'], '客户端只允许 routes.ts 持有路由字面量（其余一律引用常量）');
});
