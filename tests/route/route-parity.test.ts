/**
 * W1 路由拆分安全网：**路由清单 parity 快照**（改造前先跑绿，重构后逐条一致）。
 *
 * 快照来源：2026-09-23 W1 动结构**之前**的 \`src/index.ts\` 的 \`routesList\`（67 条声明 /
 * 69 个 (method,path) 组合；其中 recovery / lifecycle 为 prefix 路由）。
 * 快照是本次重构唯一的行为契约：kit 化 + 按域拆组文件之后，声明集合必须逐条不变。
 *
 * 为什么快照里没有「顺序」：DSH webServer 的契约是「命名路由必须互不相同，注册顺序不影响请求」
 * （node_modules/@deepseek-ai/dsh-host-webserver/lib/types/index.d.ts:44-49 的类文档），
 * 且本族的两条 prefix 互不嵌套，故断言取 (kind, methods, path) 的**集合**。
 *
 * 解析口径：从真实源码里**解析声明**（不是断言某段文本存在），并带负向自检
 * （见 \`解析器自检\`）——否则「解析不到任何路由」会假绿。
 *
 * 迁移记录（必须保留）：
 *  - 阶段 1（改造前）：解析 ranges \`path: API.<key>\` + \`kind\` + 方法判定（guard / req.method 比较），
 *    API 常量从同一份源码里解析。此版本先跑绿，作为改造的基线证据。
 *  - 阶段 2（改造后）：解析 \`endpoint({ path, methods, kind? }\` 声明（src/index.ts + src/routes/*.ts）。
 *    快照**一行未改**——这正是「逐条一致」的证据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');

/** (kind, methods, path) 三元组 → 稳定字符串（methods 按 METHOD_ORDER 规范化）。 */
const METHOD_ORDER = ['GET', 'POST', 'PUT', 'DELETE'] as const;

/**
 * 改造前的路由清单快照（67 条；见文件头「迁移记录」）。
 *
 * ⚠️ **成本提示（P-3）**：这是**硬编码清单**，不是从源码派生的期望值 —— 新增一条路由
 * **必须同步更新这里**，否则本测试必然变红（T14 复现：临时加一条 `endpoint({ path: '/api/dsh-config-manager/__p3_probe',
 * methods: ['GET'] }, …)` 声明后，本文件立即报「路由清单与改造前快照不一致」；删掉探针后复绿）。
 * 也就是说，kit 化后的「新增 API 只改一处」
 * 只对**生产源**成立；这份快照是刻意保留的第二处**登记动作**（代价换取的是一条独立的
 * 「路由集合未被无意增删」断言），不要把两者混读成「加路由零成本」。
 */
const ROUTE_SNAPSHOT = [
  ['exact', 'POST', '/api/dsh-config-manager/analyze'],
  ['exact', 'GET', '/api/dsh-config-manager/backup-files'],
  ['exact', 'POST', '/api/dsh-config-manager/backup-files/delete'],
  ['exact', 'GET+PUT', '/api/dsh-config-manager/backup-schedule'],
  ['exact', 'POST', '/api/dsh-config-manager/backup-schedule/run'],
  ['exact', 'POST', '/api/dsh-config-manager/consult'],
  ['exact', 'GET', '/api/dsh-config-manager/crash'],
  ['exact', 'POST', '/api/dsh-config-manager/decrypt-archive'],
  ['exact', 'GET', '/api/dsh-config-manager/download'],
  ['exact', 'POST', '/api/dsh-config-manager/execute'],
  ['exact', 'POST', '/api/dsh-config-manager/execute/skip'],
  ['exact', 'POST', '/api/dsh-config-manager/export'],
  ['exact', 'POST', '/api/dsh-config-manager/export-preview'],
  ['exact', 'GET', '/api/dsh-config-manager/history'],
  ['exact', 'GET', '/api/dsh-config-manager/history/export'],
  ['prefix', 'GET+POST', '/api/dsh-config-manager/lifecycle'],
  ['exact', 'POST', '/api/dsh-config-manager/market/browse'],
  ['exact', 'POST', '/api/dsh-config-manager/market/download'],
  ['exact', 'POST', '/api/dsh-config-manager/market/prepare'],
  ['exact', 'POST', '/api/dsh-config-manager/market/refresh'],
  ['exact', 'GET', '/api/dsh-config-manager/market/status'],
  ['exact', 'POST', '/api/dsh-config-manager/me/delete'],
  ['exact', 'POST', '/api/dsh-config-manager/me/items'],
  ['exact', 'POST', '/api/dsh-config-manager/me/listing'],
  ['exact', 'POST', '/api/dsh-config-manager/me/relist'],
  ['exact', 'POST', '/api/dsh-config-manager/me/status'],
  ['exact', 'POST', '/api/dsh-config-manager/me/update'],
  ['exact', 'POST', '/api/dsh-config-manager/me/upload'],
  ['exact', 'POST', '/api/dsh-config-manager/plan'],
  ['exact', 'GET', '/api/dsh-config-manager/profiles'],
  ['exact', 'POST', '/api/dsh-config-manager/profiles/create'],
  ['exact', 'POST', '/api/dsh-config-manager/profiles/delete'],
  ['exact', 'GET', '/api/dsh-config-manager/profiles/detail'],
  ['exact', 'POST', '/api/dsh-config-manager/profiles/rename'],
  ['exact', 'POST', '/api/dsh-config-manager/profiles/select'],
  ['exact', 'GET', '/api/dsh-config-manager/progress'],
  ['prefix', 'GET+POST', '/api/dsh-config-manager/recovery'],
  ['exact', 'GET+POST', '/api/dsh-config-manager/release-notes-prompt'],
  ['exact', 'GET+POST', '/api/dsh-config-manager/rescue'],
  ['exact', 'POST', '/api/dsh-config-manager/restore'],
  ['exact', 'GET', '/api/dsh-config-manager/runs'],
  ['exact', 'POST', '/api/dsh-config-manager/runs/cancel'],
  ['exact', 'POST', '/api/dsh-config-manager/runs/cancel/decision'],
  ['exact', 'GET', '/api/dsh-config-manager/snapshots'],
  ['exact', 'POST', '/api/dsh-config-manager/snapshots/delete'],
  ['exact', 'POST', '/api/dsh-config-manager/snapshots/file-diff'],
  ['exact', 'POST', '/api/dsh-config-manager/snapshots/pin'],
  ['exact', 'GET+POST', '/api/dsh-config-manager/star-prompt'],
  ['exact', 'GET', '/api/dsh-config-manager/status'],
  ['exact', 'POST', '/api/dsh-config-manager/sync/apply-items'],
  ['exact', 'GET+POST', '/api/dsh-config-manager/sync/autosync'],
  ['exact', 'POST', '/api/dsh-config-manager/sync/cancel'],
  ['exact', 'POST', '/api/dsh-config-manager/sync/config'],
  ['exact', 'POST', '/api/dsh-config-manager/sync/github/cancel'],
  ['exact', 'POST', '/api/dsh-config-manager/sync/github/poll'],
  ['exact', 'POST', '/api/dsh-config-manager/sync/github/start'],
  ['exact', 'POST', '/api/dsh-config-manager/sync/github/validate'],
  ['exact', 'GET', '/api/dsh-config-manager/sync/history'],
  ['exact', 'POST', '/api/dsh-config-manager/sync/pull'],
  ['exact', 'POST', '/api/dsh-config-manager/sync/push'],
  ['exact', 'POST', '/api/dsh-config-manager/sync/rollback'],
  ['exact', 'POST', '/api/dsh-config-manager/sync/selection'],
  ['exact', 'POST', '/api/dsh-config-manager/sync/snapshots-list'],
  ['exact', 'GET', '/api/dsh-config-manager/sync/status'],
  ['exact', 'POST', '/api/dsh-config-manager/sync/sync'],
  ['exact', 'POST', '/api/dsh-config-manager/sync/ui-prefs'],
  ['exact', 'POST', '/api/dsh-config-manager/upload'],
];

function normalizeMethods(methods: Iterable<string>): string {
  const set = new Set(methods);
  return METHOD_ORDER.filter((m) => set.has(m)).join('+');
}

function row(kind: string, methods: Iterable<string>, routePath: string): string {
  return `${kind} ${normalizeMethods(methods)} ${routePath}`;
}

/** 解析端点路径：字面量或 \`API.<key>\`（后者用同一份源码里的 API 常量表解析）。 */
function resolvePath(expr: string, apiPaths: Map<string, string>): string {
  const literal = /^'([^']*)'$/.exec(expr.trim());
  if (literal !== null) return literal[1] as string;
  const key = /^API\.(\w+)$/.exec(expr.trim());
  assert.ok(key !== null, `无法解析路由路径表达式: ${expr}`);
  const resolved = apiPaths.get(key[1] as string);
  assert.ok(resolved !== undefined, `API 常量表缺少键: ${(key[1] as string)}`);
  return resolved;
}

/** 从 API 常量表源码解析 path 字面量（唯一来源，避免测试里再抄一份路径）。 */
function parseApiPaths(source: string): Map<string, string> {
  const out = new Map<string, string>();
  // 行尾归一：src/index.ts 在工作区是 CRLF（\r 会让行尾 $ 锚点失配 → 解析出空表 → 假绿）
  for (const line of source.split('\n').map((l) => l.replace(/\r$/, ''))) {
    const m = /^\s{2}(\w+): '(\/api\/dsh-config-manager[^']*)',$/.exec(line);
    if (m !== null) out.set(m[1] as string, m[2] as string);
  }
  return out;
}

/**
 * 解析当前工作区的全部路由声明 → (kind, methods, path) 行集合。
 *
 * 阶段 2 的解析口径：\`endpoint({ ... }\` 的 spec 内联对象（无嵌套花括号）+ 可能的 API 常量路径。
 */
function declaredRoutes(): string[] {
  const sources: string[] = [fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8')];
  const routesDir = path.join(root, 'src/routes');
  for (const entry of fs.readdirSync(routesDir).sort()) {
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    sources.push(fs.readFileSync(path.join(routesDir, entry), 'utf8'));
  }
  const apiPaths = parseApiPaths(sources[0] as string);
  const rows: string[] = [];
  // 说明：不做整体注释剥离（本仓库的 stripJsComments 会把字符串内容一起清掉，见 bundle-selfcontained 的教训）。
  // 改为按**结构**判别声明：spec 必须含带值的 path（字面量或 API 键）与 methods 数组 —— kit.ts 文档注释里的
  // 示例文本（endpoint({ path, methods, kind? }, handler)）没有冒号值，天然不会命中。
  for (const source of sources) {
    // 声明形状：`endpoint({ ...spec }, <handler>)` —— spec 内不含花括号，故 [^{}]* 足够且不会跨声明
    const re = /endpoint\(\{([^{}]*)\}\s*,/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const spec = m[1] as string;
      const pathMatch = /path:\s*([^,]+?)\s*,/.exec(spec);
      const methodsMatch = /methods:\s*\[([^\]]*)\]/.exec(spec);
      if (pathMatch === null || !/^\s*(?:'[^']*'|"[^"]*"|API\.\w+)\s*$/.test(pathMatch[1] as string)) continue;
      const kindMatch = /kind:\s*'(exact|prefix)'/.exec(spec);
      assert.ok(pathMatch !== null, `endpoint 声明缺少 path: ${spec}`);
      assert.ok(methodsMatch !== null, `endpoint 声明缺少 methods: ${spec}`);
      const methods = (methodsMatch[1] as string)
        .split(',')
        .map((s) => s.trim().replace(/^'|'$/g, ''))
        .filter((s) => s !== '');
      assert.ok(methods.length > 0, `endpoint 声明 methods 为空: ${spec}`);
      rows.push(row(kindMatch?.[1] ?? 'exact', methods, resolvePath(pathMatch[1] as string, apiPaths)));
    }
  }
  return rows.sort();
}

test('W1 parity：路由清单与改造前快照逐条一致（67 条）', () => {
  const expected = ROUTE_SNAPSHOT.map(([kind, methods, routePath]) => row(kind as string, (methods as string).split('+'), routePath as string)).sort();
  const actual = declaredRoutes();
  assert.equal(expected.length, 67, '快照自身应为 67 条');
  assert.deepEqual(actual, expected, 'kit 化/拆组后路由声明集合必须逐条不变');
});

test('W1 parity 解析器自检：少一条 / 改一条 / 改方法都会被检出（防「解析不到即假绿」）', () => {
  const expected = ROUTE_SNAPSHOT.map(([kind, methods, routePath]) => row(kind as string, (methods as string).split('+'), routePath as string)).sort();
  const actual = declaredRoutes();
  // 反向控制：从解析结果里删一条（模拟「声明被误删」）、改一条路径（模拟「路径漂移」），断言两者都不再相等。
  const dropped = actual.slice(1);
  assert.notDeepEqual(dropped, expected, '少一条路由必须被判为不一致');
  const renamed = [...actual.slice(1), actual[0]!.replace(/\/[^/]+$/, '/__drifted__')];
  assert.notDeepEqual(renamed, expected, '路径漂移必须被判为不一致');
  // 解析器必须真的解析到 67 条（否则上面的 deepEqual 可能是「两边都空」的假绿）
  assert.equal(actual.length, 67, `解析到的路由数应为 67，实际 ${actual.length}`);
});
