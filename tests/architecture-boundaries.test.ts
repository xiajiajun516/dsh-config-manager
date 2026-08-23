/**
 * F7 架构边界测试（分层依赖守护）。
 *
 * 借鉴 uagent-sync 的 architecture-boundaries.test.ts：脚本解析 TypeScript 源码的
 * import 语句，守护依赖方向（Entry → Application → Domain/Ports ← Adapters），
 * 防止架构腐化。本仓库分层见 AGENTS.md：src/{core,schema,security,adapters,ui,client,
 * sync,market,migrations,profiles,utils}。
 *
 * 规则数据表（from 层 → 允许/禁止 import 的目标）：
 *  - core     ：只允许 node 内置 + core 内部 + ../schema + ../utils + ../security + js-yaml
 *                （与 DSH 运行时解耦：ConfigAdapter/HostContext 接口，见 core/types.ts）；
 *  - ui       ：框架无关纯函数层，禁止 react/react-dom 与 ../client；
 *  - client   ：浏览器半，禁止 node: 内置与 node 专属裸包（fs/path/os/crypto 等）；
 *               刻意豁免模式参照 PathMappingForm.tsx —— 不 import node:path，改用轻量
 *               等价实现，因此 client 不应出现任何 node 依赖；
 *  - adapters / sync / market：实现层，只依赖 core/schema/security/utils，禁止
 *                react/react-dom 与 ../client、../ui；
 *  - @deepseek-ai/* 只允许出现在 src/index.ts（host 入口）与 src/client/（浏览器半注入点）；
 *  - src/index.ts、src/cli/** 为入口层，豁免层规则（cli 仍受 @deepseek-ai 全局规则约束）。
 *
 * 扫描 src 目录下全部 .ts / .tsx 源文件（跳过 .test.ts / .test.tsx / .d.ts），正则提取
 * from '...' / import('...') / export ... from / 副作用 import，覆盖相对路径与包名。
 * 以真实代码为准：AGENTS.md 是依据，代码演进后测试如实报告违规，由 captain 决定是否修复。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/** src 根目录（相对测试文件：tests/ → 仓库根 → src） */
const SRC_ROOT = path.resolve(import.meta.dirname, '..', 'src');

/* ---------------------------------------------------------------- 规则数据表 */

/** 各层规则：core 用 allow 白名单（前缀匹配），其余用 forbid 黑名单 */
interface LayerRule {
  mode: 'allow' | 'forbid';
  /** allow：import 必须以其中任一前缀开头；forbid：不得以其中任一前缀开头 */
  targets: string[];
}

const LAYER_RULES: Record<string, LayerRule> = {
  core: {
    mode: 'allow',
    targets: ['node:', './', '../schema/', '../utils/', '../security/', 'js-yaml'],
  },
  ui: {
    mode: 'forbid',
    targets: ['react', 'react-dom', '../client/'],
  },
  client: {
    mode: 'forbid',
    targets: ['node:'],
  },
  adapters: {
    mode: 'forbid',
    targets: ['react', 'react-dom', '../client/', '../ui/'],
  },
  sync: {
    mode: 'forbid',
    targets: ['react', 'react-dom', '../client/', '../ui/'],
  },
  market: {
    mode: 'forbid',
    targets: ['react', 'react-dom', '../client/', '../ui/'],
  },
};

/** node 专属裸包名（client 禁止 import；node: 前缀另行处理） */
const NODE_ONLY_PACKAGES = new Set([
  'fs', 'path', 'os', 'crypto', 'zlib', 'child_process', 'http', 'https', 'stream',
  'util', 'url', 'readline', 'events', 'buffer', 'assert', 'constants', 'dns', 'net',
  'tls', 'vm', 'worker_threads', 'timers', 'string_decoder', 'querystring', 'punycode',
  'process', 'module', 'perf_hooks', 'async_hooks',
]);

/** @deepseek-ai/* 允许出现的位置（host 入口 + 浏览器半） */
function isDshPackageAllowed(rel: string): boolean {
  return rel === 'index.ts' || rel.startsWith('client/');
}

/* ---------------------------------------------------------------- 已知例外 */

/**
 * 已知违规例外表（captain 2026-08-23 决策，格式 `${rel} → ${spec}`）：
 *  - core/model-tools.ts 为并行线活跃文件（host 侧 DSH 模型工具桥接，注册模型工具），
 *    架构上属 host 桥层（与 src/index.ts 同类），其 @deepseek-ai/* 与 sync 依赖为
 *    既有形态，待该并行线稳定后由持有者移出 core 或正式放行；
 *  - market/view.ts → ../ui/i18n.ts：仅取 i18n 文案字典（运行时取字典键，非业务耦合），
 *    列为已知例外；将来字典层独立后可消除。
 * 测试只对「例外之外的新增违规」失败——守护未来不腐化，不阻塞既有初始态。
 */
const KNOWN_VIOLATIONS = new Set([
  'core/model-tools.ts → @deepseek-ai/cordis',
  'core/model-tools.ts → @deepseek-ai/dsh-tools',
  'core/model-tools.ts → @deepseek-ai/dsh-session',
  'core/model-tools.ts → ../sync/sync-engine.ts',
  'core/model-tools.ts → ../sync/sync-config.ts',
  'market/view.ts → ../ui/i18n.ts',
]);

/* ---------------------------------------------------------------- 扫描工具 */

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTsFiles(p, out);
    } else if (
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))
      && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.test.tsx')
      && !entry.name.endsWith('.d.ts')
    ) {
      out.push(p);
    }
  }
  return out;
}

/** 去掉块注释与行注释（避免注释里的 import 字样误报；http:// 中的 // 不剥离） */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** 提取全部 import 说明符：from '...' / import('...') / 副作用 import */
function parseImports(src: string): string[] {
  const cleaned = stripComments(src);
  const specs: string[] = [];
  const re = /(?:import|export)\s+(?:type\s+)?[\s\S]*?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec !== undefined) specs.push(spec);
  }
  return specs;
}

/** 相对 import 是否指向 src 内其他层（../schema/ 等）；返回可读目标层描述 */
function relativeTargetLayer(fromRel: string, spec: string): string | null {
  const fromAbs = path.resolve(SRC_ROOT, fromRel);
  const abs = path.resolve(path.dirname(fromAbs), spec);
  const rel = path.relative(SRC_ROOT, abs).split(path.sep).join('/');
  if (rel.startsWith('..')) return null; // 越出 src 的路径（不应出现）
  return rel.split('/')[0];
}

/* ---------------------------------------------------------------- 断言 */

test('F7 架构边界：各层 import 依赖方向守护（违规即失败并列出清单）', () => {
  const files = walkTsFiles(SRC_ROOT);
  const violations: string[] = [];

  for (const file of files) {
    const rel = path.relative(SRC_ROOT, file).split(path.sep).join('/');
    // 入口层豁免：src/index.ts（host 入口）、src/cli/**（CLI 入口，仍受 @deepseek-ai 全局约束）
    const isEntry = rel === 'index.ts' || rel.startsWith('cli/');
    const layer = rel.split('/')[0];
    const rule = LAYER_RULES[layer];
    const fileViolations = new Set<string>(); // 同文件同 spec 的 type/value 双 import 去重

    const src = fs.readFileSync(file, 'utf8');
    for (const spec of parseImports(src)) {
      // 全局规则：@deepseek-ai/* 只允许 index.ts 与 client
      if (spec.startsWith('@deepseek-ai/') && !isDshPackageAllowed(rel)) {
        fileViolations.add(`${rel} → ${spec}（@deepseek-ai/* 只允许出现在 src/index.ts 与 src/client/）`);
        continue;
      }

      if (isEntry || rule === undefined) continue;

      if (rule.mode === 'allow') {
        // core：白名单前缀
        if (!rule.targets.some((p) => spec === p || spec.startsWith(p))) {
          fileViolations.add(`${rel} → ${spec}（core 只允许 node 内置 / core 内部 / schema / utils / security / js-yaml）`);
        }
      } else {
        for (const bad of rule.targets) {
          if (spec === bad || spec.startsWith(bad)) {
            fileViolations.add(`${rel} → ${spec}（${layer} 禁止 import ${bad}）`);
            break;
          }
        }
        // client 专项：node 专属裸包
        if (layer === 'client' && NODE_ONLY_PACKAGES.has(spec)) {
          fileViolations.add(`${rel} → ${spec}（client 禁止 import node 专属裸包）`);
        }
      }
    }
    for (const v of fileViolations) violations.push(v);
  }

  // 报告层面：层间相对依赖统计（仅信息，不参与断言）
  const crossLayer: string[] = [];
  for (const file of files) {
    const rel = path.relative(SRC_ROOT, file).split(path.sep).join('/');
    const layer = rel.split('/')[0];
    const src = fs.readFileSync(file, 'utf8');
    for (const spec of parseImports(src)) {
      if (!spec.startsWith('.')) continue;
      const target = relativeTargetLayer(rel, spec);
      if (target !== null && target !== layer) crossLayer.push(`${layer} → ${target}（${rel} → ${spec}）`);
    }
  }
  const uniqueCross = [...new Set(crossLayer)].sort();

  // 已知例外（见 KNOWN_VIOLATIONS）不算违规：只守护新增违规。
  // 违规消息带括号说明后缀，故用「rel → spec」前缀匹配例外表。
  const known = [...KNOWN_VIOLATIONS];
  const fresh = violations.filter((v) => !known.some((k) => v.startsWith(k)));

  assert.deepEqual(
    fresh,
    [],
    `架构边界违规（${fresh.length} 处新增；另有 ${violations.length - fresh.length} 处已知例外）:\n${fresh.join('\n')}\n\n`
    + `层间相对依赖一览（信息）：\n${uniqueCross.join('\n')}`,
  );
});
