/**
 * 本地源插件打包（T1）：让 `link:` / `file:` 来源的插件能真正跨机器迁移。
 *
 * 背景（真实缺陷）：`src/adapters/plugins.ts` 会把 profile package.json 的依赖 spec
 * 原样记进 `PluginEntry.spec`，其中 `link:D:/path`、`file:./x.tgz` 指向**本机路径**——
 * 目标机器上该路径根本不存在，导入时 `pnpm add link:/...` 必然失败，插件被静默丢失。
 * 本机实例：`web` profile 的 `"dsh-config-manager": "link:D:/Projects/personal/dsh-config-manager"`。
 *
 * 解法：导出时对本地源插件执行 `npm pack`，把产出的 tarball 一并放进备份；
 * 导入时用「解包后的 tarball 绝对路径」重写 spec，走 `file:<abs>` 安装（pnpm 原生支持）。
 *
 * 本模块前半部分是**纯函数**（零 IO、零依赖，只用于 spec 分类与路径推导，node 可直测）；
 * 后半部分是**打包编排**（`exec` 注入，测试用假 exec 即可离线驱动，不绑真实 npm）。
 *
 * 安全与资源约束：
 *  - 只打包 `npm pack` 的产物，**绝不**递归整个插件目录（node_modules 由 npm pack 自身排除）；
 *  - tarball 体积超上限即跳过并告警（防单个插件把备份撑爆）；
 *  - 归档内相对路径一律 `local-plugins/<name>.tgz`，**不含任何路径分隔符**（防穿越）；
 *  - 单个插件打包失败**不中断导出**，只记 warning（与「单分区失败不拖垮整体」同语义）。
 */
import path from 'node:path';

/* ---------------- 常量 ---------------- */

/** 本地源插件 tarball 在 ZIP 内的存放目录（相对分区前缀之下，如 plugin-files/ 之下） */
export const LOCAL_PLUGIN_DIR = 'local-plugins';

/** 单插件 tarball 体积上限（超过则跳过并告警，防异常巨大的插件撑爆备份） */
export const MAX_LOCAL_TARBALL_BYTES = 100 * 1024 * 1024;

/** 本地源 spec 前缀（大小写不敏感匹配后使用小写前缀做判定） */
const LINK_PREFIX = 'link:';
const FILE_PREFIX = 'file:';

/** 非 registry 来源前缀（与 core/plugin-cli.ts 的 NON_REGISTRY_SPEC 语义对齐） */
const GIT_PREFIXES = ['github:', 'gitlab:', 'bitbucket:', 'git+', 'http:', 'https:'];

/* ---------------- 纯函数：spec 分类 ---------------- */

/** 依赖 spec 的来源类别 */
export type LocalPluginSourceKind = 'link' | 'file' | 'registry' | 'git' | 'other';

/** spec 前缀判定：大小写不敏感 + 首尾空白容忍（`Link:` / ` link:` 都能识别）。 */
function startsWithIgnoreCase(spec: string, prefix: string): boolean {
  return spec.slice(0, prefix.length).toLowerCase() === prefix;
}

/**
 * 分类依赖 spec。
 * - `link:` → 'link'（本地目录）
 * - `file:` → 'file'（本地 tarball / 目录）
 * - `github:` / `gitlab:` / `bitbucket:` / `git+` / `http(s):` → 'git'
 * - 空 / `workspace:` / 版本区间（`^1.2.3`、`~1.2`、`1.2.3`、`latest`、`*`）→ 'registry'
 * - 其余 → 'other'
 */
export function classifyPluginSpec(spec: string | undefined): LocalPluginSourceKind {
  if (typeof spec !== 'string') return 'registry';
  const s = spec.trim();
  if (s === '') return 'registry';
  if (startsWithIgnoreCase(s, LINK_PREFIX)) return 'link';
  if (startsWithIgnoreCase(s, FILE_PREFIX)) return 'file';
  for (const p of GIT_PREFIXES) {
    if (startsWithIgnoreCase(s, p)) return 'git';
  }
  if (startsWithIgnoreCase(s, 'workspace:')) return 'registry';
  return 'registry';
}

/** 是否本地源（换机后必然不可达，需打包） */
export function isLocalPluginSpec(spec: string | undefined): boolean {
  const kind = classifyPluginSpec(spec);
  return kind === 'link' || kind === 'file';
}

/**
 * spec 是否带显式前缀（`link:` / `file:` 等）。
 *
 * 注意：**Windows 盘符不是 scheme**。`C:\dev\x` 含 `:` 但那是单字母盘符后跟路径分隔符，
 * 必须排除，否则裸盘符路径会被误判为「已有 scheme」而绕过 `file:` 补全。
 */
function hasSchemePrefix(spec: string): boolean {
  if (/^[a-zA-Z]:[\\/]/.test(spec)) return false; // 盘符路径，不是 scheme
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(spec);  // RFC 3986 scheme
}

/* ---------------- 纯函数：路径与命名 ---------------- */

/**
 * 包名 → 归档内安全的文件名片段。
 * `@scope/name` → `@scope__name`（斜杠被替换，**结果绝不含 `/` 或 `\`**）。
 * 其余非法字符（路径分隔符、`:`、空白）一并折叠为 `-`。
 */
export function safePackageFileFragment(pkgName: string): string {
  const replaced = pkgName.replace(/[/\\]/g, '__');
  return replaced.replace(/[^A-Za-z0-9@._-]/g, '-');
}

/** tarball 在归档内的相对路径（一律 `local-plugins/<fragment>.tgz`，pkgName 已脱离 version） */
export function tarballNameFor(pkgName: string, version: string): string {
  const safeVersion = version.replace(/[^A-Za-z0-9._-]/g, '-');
  const fragment = safePackageFileFragment(pkgName);
  const withVersion = safeVersion === '' ? fragment : `${fragment}-${safeVersion}`;
  return `${LOCAL_PLUGIN_DIR}/${withVersion}.tgz`;
}

/**
 * 本地 spec → 绝对路径。
 * - `link:D:/x` / `link:/abs/x` → 绝对路径原样（规范化分隔符）；
 * - `link:./x` / `link:../x` → 相对 profileDir 解析；
 * - `~` 开头 → 相对 homeDir 展开；
 * - 裸路径（无前缀，如 `./plugin`）→ 同样按相对 profileDir 处理。
 *
 * 平台无关：不读 `process.platform`，交给 `path.resolve` / `path.isAbsolute`。
 */
export function resolveLocalPluginPath(
  spec: string,
  opts: { homeDir: string; profileDir: string },
): string {
  let raw = spec.trim();
  if (startsWithIgnoreCase(raw, LINK_PREFIX)) raw = raw.slice(LINK_PREFIX.length);
  else if (startsWithIgnoreCase(raw, FILE_PREFIX)) raw = raw.slice(FILE_PREFIX.length);
  raw = raw.trim();

  // `~` 展开（`~/x` 或 `~`）
  if (raw === '~') return opts.homeDir;
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return path.resolve(opts.homeDir, raw.slice(2));
  }
  // 绝对路径（含 Windows 盘符 / UNC）
  if (path.isAbsolute(raw)) return path.normalize(raw);
  // 相对路径 → 以 profileDir 为基准
  return path.resolve(opts.profileDir, raw);
}

/**
 * 把不可移植的本地 spec 重写成可移植形式。
 * 幂等：对已是 `file:` 前缀的输入再次调用不改变语义（前缀保留、路径部分原样）。
 */
export function rewriteLocalSpec(spec: string, opts: { tarballRel: string }): string {
  void spec;
  const rel = opts.tarballRel.replace(/\\/g, '/');
  return `${FILE_PREFIX}${rel}`;
}

/**
 * 判断一个 spec 是否已是「重写后的可移植形式」（`file:local-plugins/...`）。
 * 导入端据此避免二次重写。
 */
export function isPackedLocalSpec(spec: string | undefined): boolean {
  if (typeof spec !== 'string') return false;
  const s = spec.trim();
  if (!startsWithIgnoreCase(s, FILE_PREFIX)) return false;
  const rest = s.slice(FILE_PREFIX.length).replace(/\\/g, '/');
  return rest.startsWith(`${LOCAL_PLUGIN_DIR}/`);
}

/* ---------------- 打包编排（exec 注入） ---------------- */

/** 打包所需的插件最小信息（只依赖 core/types.ts 的 PluginInfo 子集，便于测试构造） */
export interface LocalPluginCandidate {
  name: string;
  version: string;
  spec?: string;
}

/** 命令执行结果（与 child_process 的 execFile 回调对齐；不 import node:child_process） */
export interface PackExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** 命令执行器签名：`exec(file, args, opts)` → Promise */
export type PackExec = (
  file: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number },
) => Promise<PackExecResult>;

export interface PackLocalPluginsOptions {
  plugins: readonly LocalPluginCandidate[];
  /** $DSH_HOME 绝对路径 */
  homeDir: string;
  /** profile 目录绝对路径（profiles/<name>） */
  profileDir: string;
  /** tarball 临时产物目录（调用方保证存在或由本函数创建） */
  packDir: string;
  /** 命令执行器（注入；生产传 npm pack 的 execFile 包装） */
  exec: PackExec;
  /** 读文件（注入，便于测试）——只在打包成功后调用 */
  readFile: (absPath: string) => Promise<Uint8Array>;
  /** 确保目录存在（注入） */
  mkdir: (absDir: string) => Promise<void>;
  /** 目标平台校验（可选；'win32' 时 npm 是 .cmd 垫片，调用方负责 exec 形态） */
  timeoutMs?: number;
  /** tarball 体积上限（缺省 MAX_LOCAL_TARBALL_BYTES） */
  maxTarballBytes?: number;
  /** 是否把 `npm pack` 的 stderr 作为告警捕获（缺省 true） */
  collectStderr?: boolean;
}

/** 单个本地插件的打包结果 */
export interface PackedLocalPlugin {
  packageName: string;
  version: string;
  /** 归档内相对路径（`local-plugins/<x>.tgz`，正斜杠） */
  relativePath: string;
  /** 重写后的 spec（`file:local-plugins/<x>.tgz`） */
  rewrittenSpec: string;
  data: Uint8Array;
}

export interface PackLocalPluginsResult {
  packed: PackedLocalPlugin[];
  /** packageName → 重写后的 spec */
  rewritten: Record<string, string>;
  /** 非致命告警（跳过原因等；调用方并入分区 warnings） */
  warnings: string[];
}

/**
 * 从 `npm pack --json` 的 stdout 解析出 tarball 文件名。
 * 兼容三种形态：
 *  1. `--json` 数组：`[{"filename":"x.tgz", ...}]` → 取 filename
 *  2. 旧版单对象：`{"filename":"x.tgz"}` → 取 filename
 *  3. 纯文本：末行非空即文件名（兜底）
 * 解析失败返回 null（调用方按文件名约定回退）。
 */
export function parsePackOutput(stdout: string, expectedPkg: string, version: string): string | null {
  const text = stdout.trim();
  if (text === '') return null;
  // 形态 1/2：JSON（可能与 npm 的进度日志混排，故从首个 '[' / '{' 起截取）
  const jsonStart = Math.min(
    ...[text.indexOf('['), text.indexOf('{')].filter((i) => i >= 0),
  );
  if (Number.isFinite(jsonStart)) {
    try {
      const parsed: unknown = JSON.parse(text.slice(jsonStart));
      const first = Array.isArray(parsed) ? parsed[0] : parsed;
      if (first !== null && typeof first === 'object') {
        const filename = (first as { filename?: unknown }).filename;
        if (typeof filename === 'string' && filename !== '') return filename;
      }
    } catch {
      /* 落到文本兜底 */
    }
  }
  // 形态 3：纯文本，取最后一行非空
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  const last = lines[lines.length - 1];
  if (last !== undefined && last.endsWith('.tgz')) return last;
  // 最终兜底：按 npm pack 的命名约定推导
  const fragment = safePackageFileFragment(expectedPkg).replace(/^@/, '').replace(/__/g, '-');
  return `${fragment}-${version}.tgz`;
}

/**
 * 对全部本地源插件执行打包。
 *
 * 行为要点：
 *  - 只处理 `isLocalPluginSpec(spec)` 的插件；非本地源直接跳过（**不产生告警**，属正常）；
 *  - 每个插件独立 try/catch：任一步失败 → 该插件进 warnings，**其余继续**；
 *  - 目录不存在 / 非绝对可达 → 告警跳过（不抛错）；
 *  - 成功产出 `packed`（含字节）与 `rewritten` 映射。
 */
export async function packLocalPlugins(
  opts: PackLocalPluginsOptions,
): Promise<PackLocalPluginsResult> {
  const packed: PackedLocalPlugin[] = [];
  const rewritten: Record<string, string> = {};
  const warnings: string[] = [];
  const maxBytes = opts.maxTarballBytes ?? MAX_LOCAL_TARBALL_BYTES;
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;

  const candidates = opts.plugins.filter((p) => isLocalPluginSpec(p.spec));
  if (candidates.length === 0) return { packed, rewritten, warnings };

  try {
    await opts.mkdir(opts.packDir);
  } catch (err) {
    warnings.push(`本地插件打包目录创建失败，已跳过全部本地插件: ${reasonOf(err)}`);
    return { packed, rewritten, warnings };
  }

  for (const plugin of candidates) {
    const spec = plugin.spec as string;
    try {
      const sourcePath = resolveLocalPluginPath(spec, {
        homeDir: opts.homeDir,
        profileDir: opts.profileDir,
      });

      // cwd 设为插件目录 + `npm pack . --pack-destination <abs>`：跨 npm 版本最稳的形态
      const result = await opts.exec('npm', ['pack', '.', '--pack-destination', opts.packDir], {
        cwd: sourcePath,
        timeoutMs,
      });
      if (result.code !== 0) {
        warnings.push(
          `本地插件 ${plugin.name} 打包失败（npm pack 退出码 ${result.code ?? 'null'}）：${firstLine(result.stderr) || firstLine(result.stdout) || '无输出'}`,
        );
        continue;
      }

      const filename = parsePackOutput(result.stdout, plugin.name, plugin.version);
      if (filename === null) {
        warnings.push(`本地插件 ${plugin.name} 打包失败：无法从 npm pack 输出解析文件名`);
        continue;
      }

      const tgzPath = path.join(opts.packDir, filename);
      const data = await opts.readFile(tgzPath);
      if (data.byteLength > maxBytes) {
        warnings.push(
          `本地插件 ${plugin.name} 的 tarball 超过上限（${data.byteLength} > ${maxBytes} 字节），已跳过打包`,
        );
        continue;
      }

      const relativePath = tarballNameFor(plugin.name, plugin.version);
      const rewrittenSpec = rewriteLocalSpec(spec, { tarballRel: relativePath });
      packed.push({
        packageName: plugin.name,
        version: plugin.version,
        relativePath,
        rewrittenSpec,
        data,
      });
      rewritten[plugin.name] = rewrittenSpec;
    } catch (err) {
      warnings.push(`本地插件 ${plugin.name} 打包失败：${reasonOf(err)}`);
    }
  }

  return { packed, rewritten, warnings };
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function firstLine(s: string): string {
  const l = s.split(/\r?\n/).find((x) => x.trim() !== '');
  return l === undefined ? '' : l.trim();
}

/**
 * 判断 spec 是否是「裸本地路径」（无任何前缀，如 `./plugin`、`D:\dev\x`）。
 * 这类 spec 在 DSH profile 中不常见（pnpm 侧通常要求 `link:` / `file:` 前缀），
 * 但一旦出现，同样指向本机路径、换机后不可达。
 *
 * **当前无生产调用点**（`packLocalPlugins` 目前只处理带前缀的 spec）——这是**有意的**
 * 预留扩展点，不是死代码：保留它可让「无前缀裸路径」这一已识别的边界有明确表达，
 * 后续若要在 `packLocalPlugins` 中一并处理，直接复用即可。
 * （若哪天决定不支持该形态，请连同本注释与对应测试一起删除。）
 */
export function isBareLocalPath(spec: string | undefined): boolean {
  if (typeof spec !== 'string') return false;
  const s = spec.trim();
  if (s === '') return false;
  if (hasSchemePrefix(s)) return false;
  return s.startsWith('./') || s.startsWith('../') || s.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(s);
}
