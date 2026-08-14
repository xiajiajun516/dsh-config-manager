/**
 * 路径处理唯一出口（node:path 不直接散落业务代码）：
 * 规范化、平台判定、绝对路径识别、前缀批量映射、ZIP 条目名安全校验。
 */
import path from 'node:path';
import type { PathMapping } from '../core/types.ts';

/** 归一化内部表示：统一 `/` 分隔、去尾部斜杠（空串保持） */
export function normalizePath(p: string): string {
  if (p === '') return '';
  const norm = p.replaceAll('\\', '/');
  return norm.length > 1 ? norm.replace(/\/+$/, '') : norm;
}

/** 转当前平台原生路径 */
export function toNativePath(p: string): string {
  const norm = normalizePath(p);
  if (process.platform === 'win32') return norm.replaceAll('/', '\\');
  return norm;
}

/** 跨平台绝对路径识别（POSIX `/x` 与 Windows `C:\x`、UNC `\\server\share`） */
export function isAbsolutePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return true;
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true; // 盘符
  if (p.startsWith('\\\\') || p.startsWith('//')) return true; // UNC
  return false;
}

/** 路径是否为 home 目录（~ 或用户主目录开头） */
export function isHomePath(p: string, homeDir: string): boolean {
  const norm = normalizePath(p);
  const home = normalizePath(homeDir);
  return norm === '~' || norm === home || norm.startsWith(home + '/') || norm.startsWith('~/');
}

/** 目标平台与当前平台是否一致 */
export function isSamePlatform(a: string, b: string): boolean {
  return a === b;
}

/** ZIP 条目名安全检查（Zip Slip / 绝对路径 / 盘符 / NUL，规范 §19.1-2）。
 * 规则与 node:path 解耦：纯分段校验，跨平台无歧义。 */
export function isPathSafe(entryName: string): boolean {
  if (entryName === '') return false;
  if (entryName.includes('\0')) return false;
  if (entryName.startsWith('/') || entryName.startsWith('\\')) return false; // 绝对路径
  if (/^[a-zA-Z]:[\\/]/.test(entryName)) return false; // 盘符
  if (/^\\\\/.test(entryName)) return false; // UNC
  const segments = entryName.split(/[\\/]+/);
  if (segments.some((s) => s === '..')) return false; // 目录穿越
  return true;
}

/** 候选目录是否位于父目录之内（含等于父目录） */
export function isSameOrChild(p: string, parent: string): boolean {
  const rel = path.relative(parent, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 前缀批量映射（规范 §12）：把对象内所有字符串值中匹配 oldPrefix 的路径
 * 替换为 newPrefix（路径感知：必须落在段边界）。返回新对象（不改原对象）。
 */
export function applyPrefixMappings(value: unknown, mappings: PathMapping[]): unknown {
  if (mappings.length === 0) return value;
  return mapStrings(value, (s) => {
    let out = s;
    for (const m of mappings) {
      const oldNorm = normalizePath(m.oldPrefix);
      if (oldNorm === '') continue;
      const candidate = normalizePath(out);
      if (candidate === oldNorm) {
        out = normalizePath(m.newPrefix);
        continue;
      }
      if (candidate.startsWith(oldNorm + '/')) {
        const rest = candidate.slice(oldNorm.length); // 含前导 /
        out = normalizePath(normalizePath(m.newPrefix) + rest);
      }
    }
    return out;
  });
}

/** 对对象内所有字符串叶节点做变换（迭代式，保留非字符串原样；二进制 Uint8Array 视为叶子） */
export function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Uint8Array) return value; // 二进制不按字段展开
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = mapStrings(v, fn);
  }
  return out;
}

/**
 * 收集对象中所有绝对路径叶值（供 analyzer 做跨设备路径检测）。
 * 返回 (value, jsonPath) 对；jsonPath 形如 "workspaces[0].path"。
 */
export function collectAbsolutePaths(value: unknown, prefix = ''): { value: string; path: string }[] {
  const hits: { value: string; path: string }[] = [];
  const visit = (v: unknown, p: string): void => {
    if (typeof v === 'string') {
      if (isAbsolutePath(v)) hits.push({ value: v, path: p });
      return;
    }
    if (v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      v.forEach((item, i) => visit(item, `${p}[${i}]`));
      return;
    }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      visit(val, p === '' ? k : `${p}.${k}`);
    }
  };
  visit(value, prefix);
  return hits;
}
