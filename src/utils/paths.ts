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
export function toNativePath(p: string, platform: string = process.platform): string {
  const norm = normalizePath(p);
  if (platform === 'win32') return norm.replaceAll('/', '\\');
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

/** 越界判定选项。 */
export interface PathInsideOptions {
  /**
   * 比较前折叠大小写（Windows 文件系统大小写不敏感）。缺省按当前平台。
   * 显式传 false 的场景：拿另一台机器的路径做形状判定（跨平台导入）。
   */
  foldCase?: boolean;
}

/** 候选路径是否位于父目录之内（含等于父目录）。
 *
 * 全仓**唯一**的越界判定（restore / verify-recovery / zip / recursive-walk / 路由都走这里）：
 * 早期四处各写一份，其中三份用 `rel.startsWith('..')` 判越界 —— 名字真的叫 `..foo` 的
 * 兄弟目录会被误判为逃逸（`path.relative('/a/b','/a/b/..foo') === '..foo'`）。
 * 越界只有两种形态：相对结果是 `..` 段本身，或以 `..` + 分隔符开头；绝对结果（跨盘符）同样越界。
 *
 * 纯字符串语义（**不碰文件系统**）：两侧各自 `path.resolve` 后比较。调用方若混用
 * realpath 结果与原路径（Windows 8.3 短名、macOS `/var`→`/private/var`）仍会误判为越界 ——
 * `path.resolve` 不折叠短名，真实路径那一层必须两侧都先 realpath 再调用。
 */
export function isPathInside(child: string, parent: string, options: PathInsideOptions = {}): boolean {
  const foldCase = options.foldCase ?? process.platform === 'win32';
  const fold = (v: string): string => (foldCase ? v.toLowerCase() : v);
  const rel = path.relative(fold(path.resolve(parent)), fold(path.resolve(child)));
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false; // 跨盘符（win32 relative 直接回绝对路径）
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

/** 候选目录是否位于父目录之内（含等于父目录）—— `isPathInside` 的读法友好别名。 */
export function isSameOrChild(p: string, parent: string): boolean {
  return isPathInside(p, parent);
}

/**
 * 内部 control-plane namespace（F23 修复）：不可信 import（pluginFiles/self/file adapters）
 * 不得把普通 config/file item 映射到这些 recovery storage 目录。
 * 相对 homeDir 的路径（正斜杠归一）命中任一前缀 → 拒绝。
 */
const RESERVED_INTERNAL_PREFIXES: readonly string[] = [
  'dsh-config-manager/snapshots/',
  'dsh-config-manager/transactions/',
  'dsh-config-manager/locks/',
  'dsh-config-manager/safe-mode',
  'dsh-config-manager/recovery-history/',
  'dsh-config-manager/environment-fingerprint.token',
  // Phase 6：迁移历史审计目录（统一历史引擎；防 F23 投毒链——不可信导入不得映射到该目录）。
  'dsh-config-manager/migration-history/',
  // 注意：不得整段保留 dsh-config-manager/sync/ —— self 分区合法持有 sync/*.json 白名单配置
  //（sync-config / sync-selection / ui-prefs / backup-schedule），会误伤。
  'dsh-config-manager/sync/snapshots/',
  'dsh-config-manager/sync/work/',
];

/**
 * 归一化并折叠 `.` / `..` 路径段（Reviewer B P0 修复）。
 * 宿主 fs 经 `resolve(join(homeDir, rel))` 会折叠 `..`，因此「看似不在保留命名空间、实际经 `..` 落到保留区」
 * 的路径（如 `dsh-config-manager/../dsh-config-manager/snapshots/...`）必须在此折叠后再判，否则 F23 被绕过。
 * 纯字符串、跨平台（只用 `/`）语义与 node:path normalize 一致；`..` 超根时按根截断（不越到 home 外）。
 */
export function normalizePathCollapsed(p: string): string {
  const norm = normalizePath(p);
  if (norm === '') return '';
  if (norm === '.') return '';
  const out: string[] = [];
  for (const seg of norm.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0) out.pop();
      continue; // 超根 `..` 直接丢弃（home 相对路径不可能越出 homeDir）
    }
    out.push(seg);
  }
  return out.join('/');
}

/** 判断相对 homeDir 的路径是否落在内部 control-plane namespace（F23 投毒防护）。
 *  大小写不敏感（Windows 文件系统大小写不敏感，防 `DSh-Config-Manager/...` 绕过）；
 *  先折叠 `..`/`.` 段（宿主 fs 会折叠，此处必须同样折叠以免被路径穿越绕过）。 */
export function isReservedInternalRel(relPath: string): boolean {
  const norm = normalizePathCollapsed(relPath).toLowerCase();
  if (norm === '') return false;
  for (const prefix of RESERVED_INTERNAL_PREFIXES) {
    if (norm === prefix || norm.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Windows 语义路径（盘符 "C:/"、"C:\\"；UNC 以两个斜杠或两个反斜杠开头）。
 *
 * 判据是**路径形状**而不是 process.platform：映射的来源可能是另一台机器导出的 Windows 路径
 * （跨平台导入时在 Linux/macOS 上处理），形状决定它在自己的文件系统上大小写不敏感。
 */
const WINDOWS_STYLE_PATH_RE = /^[a-zA-Z]:[\\/]|^[\\/]{2}/;

/**
 * 前缀批量映射（规范 §12）：把对象内所有字符串值中匹配 oldPrefix 的路径
 * 替换为 newPrefix（路径感知：必须落在段边界）。返回新对象（不改原对象）。
 *
 * **Windows 形状路径先折叠大小写再比较**（core-F4）：Windows 文件系统大小写不敏感，
 * 用户手输 / 两台机器用户名大小写不同都会让 oldPrefix 与真实值只差大小写 —— 只做逐字比较
 * 会让整条映射**静默失效**（目标机保留源机绝对路径，workspace.path 与会话 cwd 对不上）。
 * POSIX 路径仍逐字比较（/home/Alice 与 /home/alice 是不同目录，不得误匹配）。
 */
export function applyPrefixMappings(value: unknown, mappings: PathMapping[]): unknown {
  if (mappings.length === 0) return value;
  return mapStrings(value, (s) => {
    let out = s;
    for (const m of mappings) {
      const oldNorm = normalizePath(m.oldPrefix);
      if (oldNorm === '') continue;
      const candidate = normalizePath(out);
      // 只有两侧都是同一种大小写语义时才折叠：Windows 形状折叠，POSIX 保持逐字
      const fold = WINDOWS_STYLE_PATH_RE.test(oldNorm) || WINDOWS_STYLE_PATH_RE.test(candidate);
      const cmp = (v: string): string => (fold ? v.toLowerCase() : v);
      if (cmp(candidate) === cmp(oldNorm)) {
        out = normalizePath(m.newPrefix);
        continue;
      }
      // 段边界：先按**原串**切出等长头部再比较（折叠可能改变长度，避免切错位置）
      const head = candidate.slice(0, oldNorm.length);
      if (candidate.length > oldNorm.length && candidate[oldNorm.length] === '/' && cmp(head) === cmp(oldNorm)) {
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
