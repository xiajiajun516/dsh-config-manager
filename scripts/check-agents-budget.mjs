#!/usr/bin/env node
// AGENTS.md 预算与结构守卫（零依赖、本地 + CI 同源）。
// 设计前提：AGENTS.md 只放规则；真机证据/量化数据/复现脚本放 docs/lessons/<域>.md。
// 越界即 exit 1（CI 红），并在输出里点名行号与建议落点。
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIMITS = { hardCapBytes: 28 * 1024, warnBytes: 26 * 1024, maxLineBytes: 400 };

/** 纯函数：只吃文本与「路径是否存在」判定，便于单测注入 */
export function evaluateAgentsText(text, pathExists = () => true) {
  const errors = [];
  const warnings = [];
  const norm = String(text).replace(/\r\n/g, '\n');
  const bytes = Buffer.byteLength(norm, 'utf8');
  if (bytes > LIMITS.hardCapBytes) {
    errors.push(`AGENTS.md ${bytes} B 超过硬上限 ${LIMITS.hardCapBytes} B：把证据/叙事搬到 docs/lessons/<域>.md`);
  } else if (bytes > LIMITS.warnBytes) {
    warnings.push(`AGENTS.md ${bytes} B 已过警戒线 ${LIMITS.warnBytes} B（离硬上限很近）`);
  }
  norm.split('\n').forEach((line, i) => {
    const b = Buffer.byteLength(line, 'utf8');
    if (b > LIMITS.maxLineBytes) {
      errors.push(`AGENTS.md:${i + 1} 单行 ${b} B > ${LIMITS.maxLineBytes} B（超过这条通常意味着「把证据写回来了」）`);
    }
  });
  const refs = new Set([...norm.matchAll(/`(docs\/[A-Za-z0-9._\-/]+\.md)`/g)].map((m) => m[1]));
  for (const r of refs) if (!pathExists(r)) errors.push(`AGENTS.md 指针指向不存在的文件：${r}`);
  return { bytes, errors, warnings, refs: [...refs] };
}

export function checkAgentsDoc(root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const text = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  const res = evaluateAgentsText(text, (rel) => existsSync(join(root, rel)));
  const errors = [...res.errors];
  const lessonsDir = join(root, 'docs/lessons');
  const indexFile = join(lessonsDir, 'README.md');
  if (!existsSync(indexFile)) {
    errors.push('缺少 docs/lessons/README.md（域索引）');
  } else {
    const index = readFileSync(indexFile, 'utf8');
    for (const f of readdirSync(lessonsDir).filter((f) => f.endsWith('.md') && f !== 'README.md')) {
      if (!index.includes(f)) errors.push(`docs/lessons/${f} 未登记进 docs/lessons/README.md 索引`);
    }
  }
  return { ...res, errors, lessonsDir };
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const r = checkAgentsDoc();
  for (const w of r.warnings) console.warn('warn  ' + w);
  for (const e of r.errors) console.error('error ' + e);
  console.log(
    `AGENTS.md ${r.bytes} B / 硬上限 ${LIMITS.hardCapBytes} B；指针 ${r.refs.length} 条；` +
      (r.errors.length ? `${r.errors.length} error` : 'OK'),
  );
  process.exit(r.errors.length ? 1 : 0);
}
