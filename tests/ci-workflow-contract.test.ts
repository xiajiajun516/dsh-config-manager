/**
 * CI 校验阶梯的**唯一性**护栏（tech-debt #17 的防复发门禁）。
 *
 * 背景：ci.yml（PR / 主干门禁）与 publish.yml（发版）原本各自维护同一套 10 个 run 步骤，
 * 新增一条检查要改两处，漏一处就出现「PR 有门禁、发版没有」或反向的漂移 —— 而漂移本身
 * **不会有任何报错**：只是某条流水线少跑一道闸，绿色依旧。现在阶梯只存在于
 * `.github/actions/verify/action.yml`，两条流水线各写一行 `uses: ./.github/actions/verify`。
 *
 * 本文件把「只此一份」钉死：
 *  1. 两个 workflow 都必须经这个共享 action 校验，且都在 checkout 之后（本地 action 需要工作区）；
 *  2. 阶梯命令**不得**回流到任一 workflow 的 run 步骤（回流 = #17 复发，失败消息点名命令与位置）；
 *  3. action 必须是 composite，10 条 run 与下面的 `LADDER` **逐字相等**，每步都有 `shell: bash`，
 *     且不夹带 if / env / working-directory（带上就说明调用方语义混进了共享层）；
 *  4. publish.yml 仍保留它的 4 件发版专属事，且顺序仍是「Update npm → 阶梯 → Tag guard →
 *     Release notes guard → Publish」（Update npm 要早于 install，三个 guard 要早于 publish）；
 *  5. ci.yml 仍是三平台矩阵 + `cache: npm`（矩阵与缓存是调用方语义，不进共享 action）。
 *
 * 变异验证（任一改动必须让本文件红灯）：把 `npm run typecheck` 复制回 ci.yml 的 run 步骤；
 * 删掉 action 里的 Package tarball；把 publish.yml 的 Tag guard 挪到 npm publish 之后。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';

const repoRoot = path.resolve(import.meta.dirname, '..');
const WORKFLOWS_DIR = path.join(repoRoot, '.github', 'workflows');
const ACTION_FILE = path.join(repoRoot, '.github', 'actions', 'verify', 'action.yml');
const SHARED_ACTION = './.github/actions/verify';

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  shell?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  'working-directory'?: string;
}

interface WorkflowJob {
  name?: string;
  steps?: WorkflowStep[];
  strategy?: { matrix?: { include?: Array<{ os?: string; experimental?: boolean }> } };
}

interface WorkflowFile {
  jobs?: Record<string, WorkflowJob>;
}

interface ActionMeta {
  runs?: { using?: string; steps?: WorkflowStep[] };
}

/** 阶梯的**唯一事实源**：顺序 = 执行顺序，run 文本 = 逐字比对基准。 */
const LADDER: ReadonlyArray<{ step: string; run: string }> = [
  { step: 'Install dependencies', run: 'npm ci --legacy-peer-deps' },
  { step: 'Typecheck', run: 'npm run typecheck' },
  { step: 'Typecheck (tests)', run: 'npm run typecheck:tests' },
  { step: 'Test', run: 'npm test' },
  { step: 'Build', run: 'npm run build' },
  { step: 'Bundle self-contained guard', run: 'node --test src/client/bundle-selfcontained.test.ts' },
  { step: 'AGENTS.md budget guard', run: 'node scripts/check-agents-budget.mjs' },
  { step: 'Doc path guard', run: 'node scripts/check-doc-paths.mjs' },
  { step: 'Doc version guard', run: 'node scripts/check-doc-versions.mjs' },
  { step: 'Package tarball', run: 'mkdir -p dist && npm pack --pack-destination ./dist' },
];

/**
 * 回流探测用的**片段**（不是整条命令）：整条复制会被完整匹配漏掉，
 * 而 `npm run typecheck -- --watch` 这种改写应该照样算回流。
 */
const LADDER_TOKENS: readonly string[] = [
  'npm ci',
  'npm run typecheck',
  'npm test',
  'npm run build',
  'bundle-selfcontained.test.ts',
  'check-agents-budget',
  'check-doc-paths',
  'check-doc-versions',
  'npm pack',
];

function loadYaml<T>(file: string): T {
  return yaml.load(readFileSync(file, 'utf8')) as T;
}

function workflowPath(file: 'ci.yml' | 'publish.yml'): string {
  return path.join(WORKFLOWS_DIR, file);
}

/** 取出唯一的 job（两个 workflow 都是单 job × 平台矩阵），附带 job 键名用于报错定位。 */
function soloJob(file: 'ci.yml' | 'publish.yml'): { jobKey: string; job: WorkflowJob; steps: WorkflowStep[] } {
  const wf = loadYaml<WorkflowFile>(workflowPath(file));
  const entries = Object.entries(wf.jobs ?? {});
  assert.equal(entries.length, 1, `${file} 应只有一个 job（矩阵在同一 job 内跑），实际 ${entries.length} 个`);
  const only = entries[0];
  assert.ok(only, `${file} 的 jobs 为空`);
  const [jobKey, job] = only;
  const steps = job.steps ?? [];
  assert.ok(steps.length > 0, `${file}#${jobKey} 没有任何 steps`);
  return { jobKey, job, steps };
}

/** 按 name 子串定位步骤；返回 -1 表示不存在。 */
function indexOfStep(steps: WorkflowStep[], namePart: string): number {
  return steps.findIndex((s) => (s.name ?? '').includes(namePart));
}

test('C-1 两个 workflow 都经共享 action 校验，且都在 checkout 之后', () => {
  for (const file of ['ci.yml', 'publish.yml'] as const) {
    const { jobKey, steps } = soloJob(file);
    const checkoutAt = indexOfStep(steps, 'Checkout');
    const verifyAt = steps.findIndex((s) => s.uses === SHARED_ACTION);
    assert.ok(verifyAt >= 0, `${file}#${jobKey} 必须有一个步骤 uses: ${SHARED_ACTION}`);
    assert.ok(checkoutAt >= 0, `${file}#${jobKey} 缺少 Checkout 步骤`);
    assert.ok(
      checkoutAt < verifyAt,
      `${file}#${jobKey} 的共享 action 必须在 Checkout 之后（本地 action 与工作区都靠 checkout 落到盘上）`,
    );
  }
});

test('C-2 阶梯命令不得回流到任一 workflow（#17 复发探测）', () => {
  const leaks: string[] = [];
  for (const file of ['ci.yml', 'publish.yml'] as const) {
    const { jobKey, steps } = soloJob(file);
    for (const step of steps) {
      if (typeof step.run !== 'string') continue;
      for (const token of LADDER_TOKENS) {
        if (step.run.includes(token)) {
          leaks.push(`「${token}」回流到 ${file}#${jobKey}/${step.name ?? '(未命名 step)'}`);
        }
      }
    }
  }
  assert.deepEqual(
    leaks,
    [],
    `阶梯命令只允许出现在 .github/actions/verify/action.yml；发现回流：\n  ${leaks.join('\n  ')}`,
  );
});

test('C-3 共享 action 是 composite，10 条命令逐字相等且每步 shell: bash', () => {
  const meta = loadYaml<ActionMeta>(ACTION_FILE);
  const steps = meta.runs?.steps ?? [];
  assert.equal(meta.runs?.using, 'composite', 'action.yml 的 runs.using 必须是 composite');
  assert.deepEqual(
    steps.map((s) => s.run),
    LADDER.map((l) => l.run),
    'action.yml 的 run 步骤必须与 LADDER 逐字相等（顺序也一致）——LADDER 是唯一事实源，改阶梯先改本文件',
  );
  assert.deepEqual(
    steps.map((s) => s.name),
    LADDER.map((l) => l.step),
    'action.yml 的步骤名必须与 LADDER 对应（报错与 CI 日志靠名字对齐）',
  );
  for (const [i, step] of steps.entries()) {
    assert.equal(
      step.shell,
      'bash',
      `action.yml 第 ${i + 1} 步「${step.name}」缺少 shell: bash（composite 的 run 步骤必须显式声明 shell）`,
    );
    for (const key of ['if', 'env', 'working-directory'] as const) {
      assert.equal(
        step[key],
        undefined,
        `action.yml 第 ${i + 1} 步「${step.name}」带了 ${key}：调用方语义不许混进共享阶梯`,
      );
    }
  }
});

test('C-4 publish.yml 仍保留 4 件发版专属事，且顺序不变', () => {
  const { jobKey, steps } = soloJob('publish.yml');
  const at = {
    updateNpm: indexOfStep(steps, 'Update npm to latest'),
    verify: steps.findIndex((s) => s.uses === SHARED_ACTION),
    tagGuard: indexOfStep(steps, 'Tag guard'),
    notesGuard: indexOfStep(steps, 'Release notes guard'),
    publish: indexOfStep(steps, 'Publish to npm'),
  };
  for (const [key, index] of Object.entries(at)) {
    assert.ok(index >= 0, `publish.yml#${jobKey} 缺少「${key}」步骤（发版专属步骤不许被搬进共享 action）`);
  }
  // npm trusted publishing 需要 npm >= 11.5.1，必须先升级再 install。
  assert.ok(at.updateNpm < at.verify, 'publish.yml 的 Update npm 必须在共享 action（含 npm ci）之前');
  // 两道 guard 与 publish 的相对顺序：npm 同版本不可重发，任何前置门禁掉了都会留下半成品。
  assert.ok(at.verify < at.tagGuard, 'publish.yml 的 Tag guard 必须在共享 action 之后');
  assert.ok(at.tagGuard < at.notesGuard, 'publish.yml 的 Release notes guard 必须在 Tag guard 之后');
  assert.ok(at.notesGuard < at.publish, 'publish.yml 的 Publish to npm 必须在两道 guard 之后');
});

test('C-5 ci.yml 仍是三平台矩阵 + cache: npm', () => {
  const { jobKey, job, steps } = soloJob('ci.yml');
  const include = job.strategy?.matrix?.include ?? [];
  const osList = include.map((row) => row.os);
  assert.deepEqual(
    osList,
    ['ubuntu-latest', 'windows-latest', 'macos-latest'],
    `ci.yml#${jobKey} 的平台矩阵变了（32 处 process.platform 分支只有三平台都跑才覆盖得住）`,
  );
  const macos = include.find((row) => row.os === 'macos-latest');
  assert.equal(macos?.experimental, true, 'macOS 观察期条目仍应标记 experimental: true（转硬门禁请同改本断言）');

  const setupAt = indexOfStep(steps, 'Setup Node.js');
  assert.ok(setupAt >= 0, `ci.yml#${jobKey} 缺少 Setup Node.js`);
  const setupStep = steps[setupAt];
  assert.ok(setupStep, `ci.yml#${jobKey} 的 Setup Node.js 步骤取不到`);
  assert.equal(setupStep.with?.cache, 'npm', 'ci.yml 的 setup-node 必须保留 cache: npm（调用方语义，不进 action）');
});
