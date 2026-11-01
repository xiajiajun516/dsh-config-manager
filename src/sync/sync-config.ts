/**
 * m-sync-ui：同步通道配置的持久化（sync-config.json，schemaVersion v2）。
 *
 * 与 sync-state.json 的分工：sync-state 记录「同步了哪些分区、何时同步」（t4 拥有），
 * 本文件只记录「上一次使用的同步通道配置」，供 UI 打开设置页时回填表单。
 *
 * schema v2（统一接口契约，captain 冻结）：
 * - 顶层形状：
 *     { "schemaVersion": 2, "transport": "git"|"webdav",
 *       "git":    { "repoUrl": "..." },   // transport=git 时
 *       "webdav": { "url": "...", "username": "..." } }    // transport=webdav 时
 * - 顶层 transport 选择 + git/webdav 命名空间对象（嵌套，非扁平，避免歧义）。
 *   git 命名空间不再含 gitBin（git 可执行文件固定使用系统 PATH 中的 git）。
 * - webdav.url 不含任何凭据、拒绝 userinfo；username 可回显；
 *   password 绝不入文件（走 DSH credentials ref `DSH_CONFIG_MANAGER_SYNC_WEBDAV_PASSWORD`）。
 * - 代码内为可辨识联合 SyncConfig + isGitConfig()/isWebDavConfig() 守卫。
 * - 兼容旧 v1 文件（{schemaVersion:1, repoUrl, gitBin?} 或缺 schemaVersion 视为 v1）
 *   → 读取时归一为 v2 git 形态（旧 gitBin 字段被忽略/下一次保存时丢弃）。
 *
 * 安全不变量：
 * - 配置文件绝不出现密码/token（webdav 仅存 url/可选 username；口令走 DSH credentials）。
 * - url 校验：拒绝空白、非 http(s)、含 userinfo（username:password@）——仿 validateRepoUrl。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { zhMsg } from '../core/messages.ts';
import type { MsgFunc } from '../core/messages.ts';
import { parseJsonSafe, stringifyJsonSafe } from '../utils/json.ts';
import { atomicWriteFile } from '../utils/atomic-write.ts';
import { SYNC_CHANNELS } from '../utils/shared-constants.ts';
// t88：S3 兼容商清单 / 云端点密钥槽位引用也来自同一个零依赖模块（客户端镜像必须与宿主同源）。
// 注意：上面那条**单独一行**的 SYNC_CHANNELS import 是 t32 源码守卫的字面断言
// （`sync-config.test.ts` 的 t32），不要合并进下面这条，否则那条守卫会红。
import {
  S3_COMPAT_PROVIDERS,
  GIST_PROVIDER,
  CLOUD_SYNC_PROVIDERS,
  CLOUD_SECRET_REFS,
} from '../utils/shared-constants.ts';
import type { S3CompatProvider, GistProvider, CloudSyncProvider } from '../utils/shared-constants.ts';
import type { SigV4DialectId } from './s3/sigv4.ts';

export const SYNC_CONFIG_FILE = 'sync-config.json';

/**
 * 同步通道枚举（**唯一事实源**，t32）：所有「有哪些通道 / 通道列表 / 通道判定」的唯一来源。
 *
 * 声明处 = `src/utils/shared-constants.ts`（**零依赖**：client 半可运行时 import 而不带进
 * node 模块）；本文件 re-export，宿主侧沿用既有 import 路径即可。
 *
 * 为什么要单一来源：此前 SyncTransportType 在 sync-config / ui-prefs / client sync-api /
 * client sync-view 各自声明一遍，通道数组也在 autosync-scheduler 里写了两遍 ——「改一处漏一处」
 * 的表现是某个通道**静默**不再排期 / 不再落盘，而不是报错。新增通道只改声明处：typecheck 会在
 * 所有 Record<SyncTransportType, X> 的构造处与穷尽检查处报错。
 */
export { SYNC_CHANNELS };

/** 同步通道类型（由 SYNC_CHANNELS 派生；host 侧与 client 半统一引用）。 */
export type SyncTransportType = (typeof SYNC_CHANNELS)[number];

/** 通道值守卫（用于请求体 / localStorage / 磁盘 JSON 的原始输入校验）。 */
export function isSyncTransportType(value: unknown): value is SyncTransportType {
  return typeof value === 'string' && (SYNC_CHANNELS as readonly string[]).includes(value);
}

/** 严格解析通道值：非法/缺失 → undefined（缺省由调用方决定，**不在此静默兜底成 git**）。 */
export function parseSyncChannel(value: unknown): SyncTransportType | undefined {
  return isSyncTransportType(value) ? value : undefined;
}

/**
 * 配置 → 通道：**唯一判定口径**（替代散落的 `isWebDavConfig(cfg) ? 'webdav' : 'git'`）。
 * SyncConfig 是可辨识联合，transport 字段本身就是通道，无需先过守卫再分支。
 */
export function channelOf(cfg: SyncConfig): SyncTransportType {
  return cfg.transport;
}

/**
 * `Record<SyncTransportType, T>` 的统一构造器：遍历 SYNC_CHANNELS 生成。新增通道时无需
 * 在每处穷举字面量（漏写的表现曾是「该通道的配置永远读不到 / 写不回」，静默且难查）。
 */
export function channelMap<T>(make: (channel: SyncTransportType) => T): Record<SyncTransportType, T> {
  const out = {} as Record<SyncTransportType, T>;
  for (const channel of SYNC_CHANNELS) out[channel] = make(channel);
  return out;
}

/** 当前 sync-config.json schema 版本号（v3：双命名空间共存，切换通道不丢失另一通道配置）。 */
export const SYNC_CONFIG_SCHEMA_VERSION = 3;
/** 历史可读取版本：v1、v2、v3。 */
export const SYNC_CONFIG_SUPPORTED_VERSIONS: readonly number[] = [1, 2, 3];

/** git 通道配置（不含任何凭据；git 可执行文件固定使用系统 PATH 中的 git） */
export interface GitConfig {
  repoUrl: string;
}

/** webdav 通道配置（不含 password；password 走 DSH credentials） */
export interface WebDavConfig {
  /** WebDAV 端点地址（不含凭据；拒绝 userinfo） */
  url: string;
  /** 可选用户名（可回显） */
  username?: string;
}

/**
 * 完整双命名空间配置视图（v3 文件直接读取，供 status 路由回填另一通道的 repoUrl/url）。
 * 与可辨识联合 SyncConfig 不同：git 和 webdav 命名空间同时存在，可能缺失。
 */
export interface FullSyncConfig {
  transport: SyncTransportType;
  git?: GitConfig;
  webdav?: WebDavConfig;
  /** 云端点通道 s3（活动兼容商；只有非密字段 + 密钥标记，绝无密钥值） */
  s3?: S3ChannelConfig;
  /** 云端点通道 gist（只有非密字段 + 密钥标记，绝无 token 值） */
  gist?: GistChannelConfig;
}

/** 持久化的同步通道配置：可辨识联合（schemaVersion 恒 2） */
export type SyncConfig =
  | { schemaVersion: 2; transport: 'git'; git: GitConfig }
  | { schemaVersion: 2; transport: 'webdav'; webdav: WebDavConfig }
  | { schemaVersion: 2; transport: 's3'; s3: S3ChannelConfig }
  | { schemaVersion: 2; transport: 'gist'; gist: GistChannelConfig };

/** git 通道守卫 */
export function isGitConfig(cfg: SyncConfig): cfg is Extract<SyncConfig, { transport: 'git' }> {
  return cfg.transport === 'git';
}

/** webdav 通道守卫 */
export function isWebDavConfig(cfg: SyncConfig): cfg is Extract<SyncConfig, { transport: 'webdav' }> {
  return cfg.transport === 'webdav';
}

/** s3 通道守卫（provider 在 cfg.s3.provider：s3 / oss / cos / minio / kodo） */
export function isS3Config(cfg: SyncConfig): cfg is Extract<SyncConfig, { transport: 's3' }> {
  return cfg.transport === 's3';
}

/** gist 通道守卫 */
export function isGistConfig(cfg: SyncConfig): cfg is Extract<SyncConfig, { transport: 'gist' }> {
  return cfg.transport === 'gist';
}

/** 从 v1 扁平形态解析 git 配置；缺 repoUrl → null（gitBin 已废弃：始终使用系统 PATH 中的 git） */
function parseV1Git(obj: Record<string, unknown>): GitConfig | null {
  if (typeof obj['repoUrl'] !== 'string' || obj['repoUrl'] === '') return null;
  return { repoUrl: obj['repoUrl'] };
}

/** 从 v2 git 命名空间解析；缺有效 repoUrl → null */
function parseV2GitNamespace(ns: unknown): GitConfig | null {
  if (ns === null || typeof ns !== 'object' || Array.isArray(ns)) return null;
  return parseV1Git(ns as Record<string, unknown>);
}

/** 从 v2 webdav 命名空间解析；缺有效 url → null */
function parseV2WebDavNamespace(ns: unknown): WebDavConfig | null {
  if (ns === null || typeof ns !== 'object' || Array.isArray(ns)) return null;
  const o = ns as Record<string, unknown>;
  if (typeof o['url'] !== 'string' || o['url'] === '') return null;
  const webdav: WebDavConfig = { url: o['url'] };
  if (typeof o['username'] === 'string' && o['username'] !== '') webdav.username = o['username'];
  return webdav;
}

/**
 * 已落盘 repoUrl 的读取侧校验（SEC-01）：与写入侧同一份 validateRepoUrl。
 * 不合法 → 记一条明确 issue 并让调用方丢弃该配置；绝不把可疑地址继续交给凭据注入与 git 子进程。
 */
function acceptPersistedRepoUrl(repoUrl: string, issues?: SyncConfigIssue[]): boolean {
  const err = validateRepoUrl(repoUrl);
  if (err === null) return true;
  issues?.push({ code: 'repo-url-invalid', channel: 'git', message: err });
  return false;
}

/**
 * 读取同步通道配置；文件不存在/损坏/不支持 schema → null（视为未配置，UI 显示空表单）。
 * 兼容旧文件：缺 schemaVersion 字段视为 v1（git 通道）。
 * 恒返回 schemaVersion=2 的规范形态（v1 读取时归一为 git）。
 *
 * `issues` 可选：传数组时，被丢弃的 git repoUrl（白名单校验不通过）以结构化成因追加进去，
 * 供 UI/日志如实呈现（不静默吞掉）。
 */
export async function readSyncConfig(dir: string, issues?: SyncConfigIssue[]): Promise<SyncConfig | null> {
  const file = path.join(dir, SYNC_CONFIG_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = parseJsonSafe(raw);
  } catch {
    // 损坏 JSON / 体积超限 / 嵌套过深 → 视为未配置（不抛错）
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  // schemaVersion：缺省视为 v1（兼容旧文件）；非缺省但不在支持列表 → 拒绝
  if (obj['schemaVersion'] !== undefined && typeof obj['schemaVersion'] !== 'number') {
    return null;
  }
  const ver = typeof obj['schemaVersion'] === 'number' ? obj['schemaVersion'] : 1;
  if (!SYNC_CONFIG_SUPPORTED_VERSIONS.includes(ver)) return null;

  if (ver === 1) {
    const git = parseV1Git(obj);
    if (git === null) return null;
    if (!acceptPersistedRepoUrl(git.repoUrl, issues)) return null;
    return { schemaVersion: 2, transport: 'git', git };
  }

  // v2 / v3：顶层 transport 选择（v3 双命名空间并存，按 transport 返回对应通道）
  const transport = obj['transport'];
  // 通道合法性只认唯一枚举（SYNC_CHANNELS）：新增通道无需在此补字面量
  if (!isSyncTransportType(transport)) return null;
  if (transport === 'git') {
    const git = parseV2GitNamespace(obj['git']);
    if (git === null) return null;
    if (!acceptPersistedRepoUrl(git.repoUrl, issues)) return null;
    return { schemaVersion: 2, transport: 'git', git };
  }
  if (transport === 'webdav') {
    const webdav = parseV2WebDavNamespace(obj['webdav']);
    if (webdav === null) return null;
    return { schemaVersion: 2, transport: 'webdav', webdav };
  }
  // 云端点通道：非密配置住在 sync-cloud-config.json（活动 provider 由 active 记录）
  if (transport === 's3') {
    const s3 = await readS3ChannelConfig(dir);
    return s3 === null ? null : { schemaVersion: 2, transport: 's3', s3 };
  }
  const gist = await readGistChannelConfig(dir);
  return gist === null ? null : { schemaVersion: 2, transport: 'gist', gist };
}

/**
 * 读取 sync-config.json 原始内容，提取 git/webdav 两个命名空间（不存在/无效 → undefined）。
 * 供 writeSyncConfig 合并保留另一通道配置用：切换通道保存时不得丢弃另一通道的 repoUrl/url。
 */
function readBothNamespaces(file: string): Promise<{ git?: GitConfig; webdav?: WebDavConfig }> {
  return (async () => {
    let raw: string
    try {
      raw = await fs.readFile(file, 'utf8')
    } catch {
      return {} // 文件不存在：无历史配置
    }
    let parsed: unknown
    try {
      parsed = parseJsonSafe(raw)
    } catch {
      return {} // 损坏 JSON：按无历史配置处理（不阻塞保存）
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const o = parsed as Record<string, unknown>
    const out: { git?: GitConfig; webdav?: WebDavConfig } = {}
    const git = parseV2GitNamespace(o['git'])
    if (git !== null) out.git = git
    const webdav = parseV2WebDavNamespace(o['webdav'])
    if (webdav !== null) out.webdav = webdav
    // v1 旧文件（无命名空间）：git 读扁平 repoUrl
    if (out.git === undefined && out.webdav === undefined) {
      const v1 = parseV1Git(o)
      if (v1 !== null) out.git = v1
    }
    return out
  })()
}

/**
 * 读取完整的双命名空间配置（供 status 路由回填另一通道的 repoUrl/url）。
 * 文件不存在/损坏/无任何通道配置 → null（视为未配置）。
 */
export async function readFullSyncConfig(dir: string, issues?: SyncConfigIssue[]): Promise<FullSyncConfig | null> {
  const file = path.join(dir, SYNC_CONFIG_FILE)
  const both = await readBothNamespaces(file)
  // SEC-01/03 读侧：已落盘的 git repoUrl 过同一份白名单校验；不合法就当作没配 git 通道
  // （自动同步/凭据注入都从这里取通道配置，绝不能让可疑地址继续往下走）
  if (both.git !== undefined && !acceptPersistedRepoUrl(both.git.repoUrl, issues)) {
    delete both.git
  }
  // 云端点通道的配置不在 sync-config.json（见 sync-cloud-config.json）；这里一并对齐成完整视图
  const s3 = await readS3ChannelConfig(dir)
  const gist = await readGistChannelConfig(dir)
  if (both.git === undefined && both.webdav === undefined && s3 === null && gist === null) return null
  // 从原始文件读取当前活动 transport 字段
  let transport: SyncTransportType = 'git'
  try {
    const raw = await fs.readFile(file, 'utf8')
    const parsed = parseJsonSafe(raw)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const o = parsed as Record<string, unknown>
      // 与 parseSyncBody 同口径：只接受已知通道值，其它一律保持缺省 git
      const parsedChannel = parseSyncChannel(o['transport'])
      if (parsedChannel !== undefined) transport = parsedChannel
    }
  } catch { /* 默认 git */ }
  return {
    transport,
    git: both.git,
    webdav: both.webdav,
    ...(s3 === null ? {} : { s3 }),
    ...(gist === null ? {} : { gist }),
  }
}

/**
 * 读取指定通道的同步通道配置（供自动同步调度器按通道运行）。
 * 从完整双命名空间配置取对应通道构造可辨识联合 SyncConfig；该通道未配置 → null。
 */
export async function readSyncConfigFor(
  dir: string,
  channel: SyncTransportType,
  issues?: SyncConfigIssue[],
): Promise<SyncConfig | null> {
  const full = await readFullSyncConfig(dir, issues);
  if (full === null) return null;
  switch (channel) {
    case 'git':
      return full.git === undefined ? null : { schemaVersion: 2, transport: 'git', git: full.git };
    case 'webdav':
      return full.webdav === undefined ? null : { schemaVersion: 2, transport: 'webdav', webdav: full.webdav };
    case 's3':
      return full.s3 === undefined ? null : { schemaVersion: 2, transport: 's3', s3: full.s3 };
    case 'gist':
      return full.gist === undefined ? null : { schemaVersion: 2, transport: 'gist', gist: full.gist };
    default:
      return null;
  }
}

/**
 * 保存同步通道配置（自动创建目录；恒写 schemaVersion=3 双命名空间）。
 * - 写入当前通道的命名空间（git/webdav）；
 * - 另一通道之前配置过 → 一并保留（切换通道不丢失另一通道的 repoUrl/url）；
 * - 覆盖旧值；未配置过的字段不写入。
 */
export async function writeSyncConfig(
  dir: string,
  cfg: SyncConfig,
  secrets?: CloudSecretWriter,
): Promise<void> {
  // 云端点通道：非密字段写 sync-cloud-config.json（复用既有只写端口层，密钥值绝不落文件）；
  // sync-config.json 只更新「活动通道」指针，与 git/webdav 命名空间互不干扰。
  if (isS3Config(cfg) || isGistConfig(cfg)) {
    const provider: CloudSyncProvider = isGistConfig(cfg) ? GIST_PROVIDER : cfg.s3.provider;
    const input: CloudChannelWriteInput = isGistConfig(cfg)
      ? {
          gistId: cfg.gist.gistId,
          ...(cfg.gist.apiBaseUrl === undefined ? {} : { apiBaseUrl: cfg.gist.apiBaseUrl }),
          ...(cfg.gist.filePrefix === undefined ? {} : { filePrefix: cfg.gist.filePrefix }),
        }
      : {
          endpoint: cfg.s3.endpoint,
          region: cfg.s3.region,
          bucket: cfg.s3.bucket,
          accessKeyId: cfg.s3.accessKeyId,
          ...(cfg.s3.prefix === undefined ? {} : { prefix: cfg.s3.prefix }),
          ...(cfg.s3.pathStyle === undefined ? {} : { pathStyle: cfg.s3.pathStyle }),
          ...(cfg.s3.dialectId === undefined ? {} : { dialectId: cfg.s3.dialectId }),
        };
    await writeCloudChannelConfig(dir, provider, input, secrets);
    await writeSyncConfigTransport(dir, cfg.transport);
    return;
  }
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, SYNC_CONFIG_FILE)
  const existing = await readBothNamespaces(file)
  const namespaces: { git?: GitConfig; webdav?: WebDavConfig } = { git: existing.git, webdav: existing.webdav }
  if (isGitConfig(cfg)) namespaces.git = cfg.git
  else namespaces.webdav = cfg.webdav
  // 另一通道之前配置过 → 一并保留（切换通道不丢失另一通道的 repoUrl/url）
  await writeSyncConfigFile(dir, namespaces, cfg.transport)
}

/** 断开单条通道配置的结果（供路由层决定凭据/自动同步/UI 偏好怎么收尾）。 */
export interface ClearSyncChannelResult {
  /** 该通道之前是否有配置；false = 本来就没配（幂等成功，不算失败） */
  removed: boolean;
  /** 是否仍有另一条通道的配置（false = 已无任何通道，configured 应回落为 false） */
  hasRemaining: boolean;
  /** 清除后的活动通道（无剩余时为被清除的通道，仅作占位） */
  transport: SyncTransportType;
}

/**
 * 从 sync-config.json 删除指定通道的命名空间（另一通道的配置原样保留）。
 *
 * 为什么必须有（用户实测）：通道一旦配置过就没有出口 —— 一条打不通的 WebDAV 通道会永久占位，
 * 产物库的远端源与自动同步只能一直报读取失败，用户无从自救。
 *
 * 三条语义：
 *  - 该通道本来没配置 → 幂等成功（removed=false），**不写文件**；
 *  - 删完还剩另一条 → 重写文件；活动 transport 若指向被删通道则自动切到剩下的那条
 *    （否则 readSyncConfig 会返回 null，那条**配置过**的通道反而被显示成「未配置」）；
 *  - 删完一条不剩 → **删除整个文件**（configured 如实回落 false），而不是留一份空配置。
 *
 * 凭据（token / WebDAV 口令 / 该通道的加密解密密码）与自动同步开关**不在本函数职责内** ——
 * 它们分别住在 DSH credentials 与 autosync.json，由路由层显式清除（本模块只碰 sync-config.json）。
 */
export async function clearSyncChannel(dir: string, channel: SyncTransportType): Promise<ClearSyncChannelResult> {
  const file = path.join(dir, SYNC_CONFIG_FILE);
  const before = await listConfiguredChannels(dir);
  const removed = before.includes(channel);
  if (!removed) {
    // 幂等：本来没配置 → 不写任何文件（含云端点文件）
    const current = await readTransportPointer(dir);
    const transport = before.includes(current) ? current : (before[0] ?? current);
    return { removed: false, hasRemaining: before.length > 0, transport };
  }

  if (channel === 'git' || channel === 'webdav') {
    const both = await readBothNamespaces(file);
    const namespaces: { git?: GitConfig; webdav?: WebDavConfig } =
      channel === 'git' ? { webdav: both.webdav } : { git: both.git };
    const remaining = before.filter((c) => c !== channel);
    if (remaining.length === 0) {
      // 一条不剩 → 文件不再代表任何配置：删掉它（readFullSyncConfig 回落 null）
      await fs.rm(file, { force: true });
      return { removed: true, hasRemaining: false, transport: channel };
    }
    const current = await readTransportPointer(dir);
    const transport = current === channel || !remaining.includes(current) ? remaining[0]! : current;
    await writeSyncConfigFile(dir, namespaces, transport);
    return { removed: true, hasRemaining: true, transport };
  }

  // 云端点通道：清掉该通道**全部**已保存的 provider（s3 通道可能存了多家作为切换记忆），
  // 密钥槽位由路由层 unset（本模块只碰配置文件）。
  if (channel === 'gist') {
    await clearCloudChannelConfig(dir, GIST_PROVIDER);
  } else {
    const saved = await readCloudSyncConfig(dir);
    for (const provider of S3_COMPAT_PROVIDERS) {
      if (saved?.savedProviders[provider] !== undefined) await clearCloudChannelConfig(dir, provider);
    }
  }
  const remaining = await listConfiguredChannels(dir);
  if (remaining.length === 0) {
    await fs.rm(file, { force: true });
    return { removed: true, hasRemaining: false, transport: channel };
  }
  const current = await readTransportPointer(dir);
  const transport = current === channel || !remaining.includes(current) ? remaining[0]! : current;
  await writeSyncConfigTransport(dir, transport);
  return { removed: true, hasRemaining: true, transport };
}

/** repoUrl 形态：网络地址（http/https/ssh，含 scp 式）或本机路径 */
export type RepoUrlKind = 'http' | 'https' | 'ssh' | 'local';

/**
 * 已落盘 repoUrl 校验失败的**结构化**结果（SEC-01 读侧）。
 * 读取侧不能只是返回 null：调用方要能如实告诉用户「你的配置被丢弃了，原因是地址不合法」。
 */
export interface SyncConfigIssue {
  code: 'repo-url-invalid';
  channel: SyncTransportType;
  message: string;
}

/**
 * repoUrl 形态分类；null = 不认识的形态。
 *
 * 为什么要分类而不是只做正则：git 对同一个「地址」支持 http(s)、ssh、scp 式与本机路径，
 * 而这三类的安全含义完全不同（网络地址要防 SSRF，本机路径要防 argv 注入）。先判形态，
 * 再按形态分别收紧，比一堆互相打架的正则清楚。
 */
export function classifyRepoUrl(repoUrl: string): { kind: RepoUrlKind; host: string } | null {
  const url = repoUrl.trim();
  if (url === '' || /\s/.test(url)) return null;
  // SEC-12：以 '-' 开头的「地址」会被 git 当成选项（--upload-pack=… / -c core.pager=…）
  if (url.startsWith('-')) return null;
  // 'ext::sh -c …' 一类命令协议（SCM 协议语法里 scheme 与地址之间是 '::'）
  if (url.includes('::')) return null;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url);
  if (scheme !== null) {
    const name = scheme[1]!.toLowerCase();
    if (name !== 'http' && name !== 'https' && name !== 'ssh') return null;
    // 'https:///r.git' 这类空 authority 会被 URL 解析器「跳过斜杠」后当成主机 r.git —— 必须先拦
    const rest = url.slice(scheme[0].length);
    if (rest === '' || rest.startsWith('/') || rest.startsWith('\\')) return null;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.hostname === '') return null;
    return { kind: name, host: parsed.hostname };
  }
  // scp 式（git@github.com:user/repo.git）：只有 user@host:path 才算网络地址
  const scp = /^[^\s/@:]+@([^\s/:]+):(.+)$/.exec(url);
  if (scp !== null) return { kind: 'ssh', host: scp[1]! };
  // 其余按本机路径处理（相对 ../bare、绝对 /home/u/r.git、盘符 D:/repos/bare）
  return { kind: 'local', host: '' };
}

/** 四段点分且每段 0-255 → IPv4 字面量；否则 null（域名里的数字段不算 IP） */
function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    nums.push(n);
  }
  return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
}

/**
 * 环回 / 私网 / 链路本地 / 未指定地址（含云元数据 169.254.169.254）判定。
 * SEC-03：这类地址让「客户端」去访问内网或本机端口，等于给 SSRF 开一扇门。
 *
 * **已知行为变更（有意，非副作用）**：SEC-02/03 之前 `https://192.168.1.10/…`、`http://127.0.0.1:3000/…`、
 * `http://nas.local/…` 这类地址可以被接受。收紧后一律拒绝 —— 代价是「拿家里 NAS / 局域网 git 服务器
 * 当同步目标」这条路走不通，收益是「包里的 repoUrl 无法把家目录配置推给内网监听者或云元数据端点」。
 * 取舍判据：本插件的同步目标是「用户自己的远端仓库」，公网 http(s)/ssh 已覆盖该用途；本机目录仓库
 * 仍走 `local` 分支（不由本函数判定）。真要支持内网目标，应做成显式开关 + 用户逐目标确认，
 * 不能靠「地址字符串看起来像内网就放行」——那正是攻击者可控的判据。
 */
export function isPrivateRepoHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
  if (h === '') return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const v4 = parseIpv4(h);
  if (v4 !== null) {
    const [a, b] = v4;
    return a === 0 || a === 127 || a === 10
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254);
  }
  if (!h.includes(':')) return false;
  if (h === '::1' || h === '::') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // fc00::/7 唯一本地
  if (/^fe[89ab][0-9a-f]?:/.test(h)) return true; // fe80::/10 链路本地
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (mapped !== null) return isPrivateRepoHost(mapped[1]!);
  return false;
}

/**
 * 文案里回显地址用：剥掉 userinfo（token 可能就藏在这一段），host/path 原样保留。
 *
 * 为什么不整串换成 `[REPO_URL]` 占位符：这里拒绝的是**用户自己刚填的**地址，他需要认出
 * 「被拒的是哪一个」才能改；剥掉 `user:pass@` 之后剩下的部分正是修复所需的定位信息。
 * 为什么解析失败也要剥：`https://user:tok@` 这类半截地址 `new URL` 会抛，但前缀照样是凭据。
 */
export function sanitizeRepoUrlForMessage(url: string): string {
  const raw = url.trim();
  try {
    const parsed = new URL(raw);
    if (parsed.username === '' && parsed.password === '') return raw;
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    // 只有「残缺的带 scheme 地址」（`https://user:tok@`，`new URL` 会抛但前缀就是凭据）需要剥。
    // 无 scheme 的 scp 式（`git@host:path`）里 `git` 是 ssh 登录名、不是凭据 → 原样返回，
    // 免得用户看到一条认不出是哪个远端的报错。
    if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) return raw;
    return raw.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@\s]*@/, (_m: string, scheme?: string) => scheme ?? '');
  }
}

/**
 * 仓库地址合法性校验（返回错误消息；null = 合法）。
 *
 * 白名单口径（SEC-02/03/12，写入侧与读取侧共用同一份实现）：
 * - 只认 http(s)/ssh/scp 式网络地址与本机路径；file://、ext::、ftp://、git:// 一律拒绝；
 * - 整串以 '-' 开头拒绝（git argv 位置参数以 '-' 开头会被当选项，可执行任意命令）；
 * - 网络地址拒绝环回/私网/链路本地主机（SSRF）—— 文案单独一条（sync.configPrivateHost），
 *   不能复用「无法解析」：用户看到「解析不了」只会反复改写法，实际原因是地址指向内网；
 * - 带 scheme 的地址一律拒绝 userinfo（username[:password]@）—— token 只许放凭据字段。
 */
export function validateRepoUrl(repoUrl: string, msg: MsgFunc = zhMsg): string | null {
  if (typeof repoUrl !== 'string' || repoUrl.trim() === '') {
    return 'repoUrl is required';
  }
  const url = repoUrl.trim();
  if (/\s/.test(url)) {
    return msg('sync.configWhitespace');
  }
  // 回显一律脱敏：错误文案会进日志、进接口响应、进 issue 截图
  const echo = sanitizeRepoUrlForMessage(url);
  const shape = classifyRepoUrl(url);
  if (shape === null) {
    return msg('sync.configUnparseable', { url: echo });
  }
  if (shape.kind === 'local') return null;
  if (isPrivateRepoHost(shape.host)) {
    return msg('sync.configPrivateHost', { url: echo });
  }
  // userinfo 检查与 scheme 无关（RV1-F7）：原实现只在 http/https 分支内查，于是
  // `ssh://user:tok@host/r.git` 能过白名单，token 照样进 argv 与 sync-config.json。
  // 口径（按「这一段是不是凭据」区分，而不是按 scheme 区分）：
  // - password 位：任何带 scheme 的地址都拒 —— 那是可粘贴的 secret；
  // - http/https 的 username：Basic 认证的用户名与口令等同，一并拒（保持既有行为）；
  // - ssh 的 username：就是 ssh 登录名（`ssh://git@host`、`ssh://deploy@host` 是标准写法），
  //   ssh 认证只认密钥/agent，用户名不具凭据效力，因此放行 —— 拒掉会杀掉合法用法。
  // scp 式（git@host:path）无 scheme、`new URL` 解析不了，本就不进这条判定。
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (parsed !== null) {
    const hasPassword = parsed.password !== '';
    const hasBasicUser = parsed.username !== '' && (shape.kind === 'http' || shape.kind === 'https');
    if (hasPassword || hasBasicUser) {
      return msg('sync.configUserinfo');
    }
  }
  return null;
}

/**
 * WebDAV 端点地址合法性校验（返回错误消息；null = 合法）。
 * 安全约束：口令/密码永不拼入 url —— 仅接受 http(s)，且拒绝带 userinfo
 * （username[:password]@）的地址，引导用户把口令放 DSH credentials，避免凭据经 URL 泄漏进出入口/日志。
 */
export function validateWebDavUrl(url: string, msg: MsgFunc = zhMsg): string | null {
  if (typeof url !== 'string' || url.trim() === '') {
    return 'url is required';
  }
  const cleaned = url.trim();
  if (/\s/.test(cleaned)) {
    return msg('sync.configWhitespace');
  }
  if (!/^https?:\/\//i.test(cleaned)) {
    return msg('sync.configUnparseable', { url: cleaned });
  }
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    return msg('sync.configUnparseable', { url: cleaned });
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return msg('sync.configUserinfo');
  }
  return null;
}

/* ------------------------------------------------------------------------------------------------
 * 批次3 Q2：云端点通道配置（s3 兼容系五家 + gist）
 *
 * 为什么单独一份文件（而不是塞进 sync-config.json 的 git/webdav 命名空间）：git/webdav 的通道枚举
 * \`SYNC_CHANNELS\` 是**全仓唯一的通道事实源**，被 \`Record<SyncTransportType, T>\` 的构造处、自动同步
 * 调度器、客户端镜像与 4 处源码级守卫消费；批次3 的写作用域不含那些文件，因此新增通道**不得**
 * 扩 \`SYNC_CHANNELS\`（否则 typecheck 会在他人 in-flight 文件上炸）。云端点通道自带枚举与文件，
 * 与 git/webdav 完全解耦，将来并入 \`SYNC_CHANNELS\` 时只需删掉这里的枚举并补 Record 分支。
 *
 * 照竞品 \`@dickpy/dsh-cloud-sync\` 的 \`savedProviders\` 模式：**按通道分别保存**
 * endpoint/region/bucket/前缀/gistId 等非密字段，切换回某个通道时能自动回填。
 *
 * 密钥纪律（硬约束，不得放宽）：
 *  - 文件里**只有非密字段** + \`secretStored: true\` 标记；AccessKey Secret / Gist Token 的**值**
 *    永远只在 DSH credentials 槽位（\`cloudSecretRef()\`），由宿主经 \`CloudSecretWriter\` 写入；
 *  - 回传 UI 的是 \`CloudChannelView\`（**只带标记、不带值**），读侧即使遇到手写进文件的
 *    secret/token 字段也一律**丢弃**（绝不回读、绝不回传）。
 * ---------------------------------------------------------------------------------------------- */

/** 云端点通道配置文件名（与 sync-config.json 并列，互不影响）。 */
export const CLOUD_SYNC_CONFIG_FILE = 'sync-cloud-config.json';
/** 云端点配置 schema 版本。 */
export const CLOUD_SYNC_CONFIG_SCHEMA_VERSION = 1;
/**
 * S3 兼容系通道枚举（**唯一声明处已迁到零依赖的 `utils/shared-constants.ts` 的 S3_COMPAT_PROVIDERS**，t88）：
 * 五家共用同一份 SigV4 实现，差异只有 endpoint / region / 寻址风格 / 签名方言
 * （见 src/sync/s3/s3-providers.ts 的变体表）。
 */
export { S3_COMPAT_PROVIDERS, GIST_PROVIDER, CLOUD_SYNC_PROVIDERS };
export type { S3CompatProvider, GistProvider, CloudSyncProvider };

/** 通道值守卫（请求体 / 磁盘 JSON 的原始输入校验）。 */
export function isCloudSyncProvider(value: unknown): value is CloudSyncProvider {
  return typeof value === 'string' && (CLOUD_SYNC_PROVIDERS as readonly string[]).includes(value);
}

/** 是否 S3 兼容系通道。 */
export function isS3CompatProvider(value: unknown): value is S3CompatProvider {
  return typeof value === 'string' && (S3_COMPAT_PROVIDERS as readonly string[]).includes(value);
}

/** 是否 Gist 通道。 */
export function isGistProvider(value: unknown): value is GistProvider {
  return value === GIST_PROVIDER;
}

/**
/**
 * 取某云端点通道的密钥槽位引用（不涉及任何值）。
 *
 * 表本身在零依赖的 utils/shared-constants.ts（**唯一声明处**，t88）：客户端要显示同一个名字
 * （cloudSecretRefName()），两侧各写一份时「宿主改名、界面还提示旧名」不会红。
 * 命名与既有 syncPasswordRef 同族：DSH_CONFIG_MANAGER_SYNC_<CHANNEL>_<KIND>。
 */
export function cloudSecretRef(provider: CloudSyncProvider): string {
  return CLOUD_SECRET_REFS[provider];
}

/**
 * 密钥**只写**端口：故意不提供 get()——宿主只能写、只能问「有没有」，
 * 通道实现与 UI 都不可能把值回读出来（这是「只写不回读」的结构性保证，不靠纪律）。
 */
export interface CloudSecretWriter {
  /** 写入密钥值（仅内存传递；不落盘、不进日志、不回传） */
  set(ref: string, value: string): Promise<void>;
  /** 只问「该槽位有没有值」（绝不返回值本身） */
  has(ref: string): Promise<boolean>;
}

/** S3 兼容系通道的非密配置（值里绝不含 AccessKey Secret）。 */
export interface CloudS3ChannelConfig {
  /** 对象存储端点（http(s)，不含凭据、不含桶名；如 https://s3.us-east-1.amazonaws.com） */
  endpoint: string;
  /** V4 签名作用域里的 region（如 us-east-1 / cn-hangzhou / ap-guangzhou） */
  region: string;
  /** 桶名 */
  bucket: string;
  /** 对象键前缀（缺省 dsh-config-manager） */
  prefix?: string;
  /** AccessKey ID（标识符，可回显；**不是**密钥） */
  accessKeyId: string;
  /** path-style 寻址开关（缺省取变体默认：MinIO true，其余 false） */
  pathStyle?: boolean;
  /**
   * 显式覆盖变体默认签名方言（缺省 = provider 变体默认；'aws4' = AWS SigV4，'oss4' = 阿里云 OSS4）。
   * 非法的值在解析期被忽略（回落变体默认）—— 该字段是高级覆盖，不是配置错误来源。
   */
  dialectId?: SigV4DialectId;
  /** 密钥是否已在 DSH credentials 里（**只回标记，不回值**） */
  secretStored?: boolean;
}

/** Gist 通道的非密配置（值里绝不含 token）。 */
export interface CloudGistChannelConfig {
  /** 目标 gist id（十六进制串） */
  gistId: string;
  /** GitHub API 根（缺省 https://api.github.com；GitHub Enterprise 可改） */
  apiBaseUrl?: string;
  /** gist 内文件名前缀（缺省 dsh-sync） */
  filePrefix?: string;
  /** token 是否已在 DSH credentials 里（**只回标记，不回值**） */
  secretStored?: boolean;
}

/**
 * s3 通道（SYNC_CHANNELS 的 's3'）的配置 = 具体兼容商的非密配置 + provider 身份。
 * 密钥值绝不在此（只在 DSH credentials 的 cloudSecretRef(provider) 槽位）。
 */
export interface S3ChannelConfig extends CloudS3ChannelConfig {
  /** 具体 S3 兼容商（s3 / oss / cos / minio / kodo） */
  provider: S3CompatProvider;
}

/** gist 通道（SYNC_CHANNELS 的 'gist'）的配置：非密字段；token 只在 DSH credentials。 */
export type GistChannelConfig = CloudGistChannelConfig;

/**
 * 每个云端点**通道**当前选用的 provider（保存即选定；断开即移除）。
 * s3 通道 → 五家兼容商之一；gist 通道 → 恒 'gist'。
 * 与 savedProviders 的分工：savedProviders 是「切换 provider 时能自动回填」的记忆，
 * 本字段回答「这条通道现在用哪一个」。
 */
export interface CloudActiveProviders {
  s3?: S3CompatProvider;
  gist?: GistProvider;
}

/** 按通道分别保存的非密配置（照 cloud-sync 的 savedProviders 模式）。 */
export interface CloudSavedProviders {
  s3?: CloudS3ChannelConfig;
  oss?: CloudS3ChannelConfig;
  cos?: CloudS3ChannelConfig;
  minio?: CloudS3ChannelConfig;
  kodo?: CloudS3ChannelConfig;
  gist?: CloudGistChannelConfig;
}

/** 磁盘上的云端点配置（读侧恒归一为该形态；损坏/不支持的版本 → null）。 */
export interface CloudSyncConfig {
  schemaVersion: number;
  savedProviders: CloudSavedProviders;
  /** 每条云端点通道当前选用的 provider（缺省 = 旧文件，读侧按「唯一已保存者」推断） */
  active?: CloudActiveProviders;
}

/** 某通道读出来的配置（按 provider 收窄的联合）。 */
export type CloudChannelConfig =
  | { provider: S3CompatProvider; config: CloudS3ChannelConfig }
  | { provider: GistProvider; config: CloudGistChannelConfig };

/** S3 兼容系通道的回传视图：**只带 secretStored 标记，绝不带密钥值**。 */
export interface CloudS3ChannelView {
  provider: S3CompatProvider;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  pathStyle: boolean;
  /** 密钥已在 credentials 里（只回布尔） */
  secretStored: boolean;
}

/** Gist 通道的回传视图：**只带 secretStored 标记，绝不带 token 值**。 */
export interface CloudGistChannelView {
  provider: GistProvider;
  gistId: string;
  apiBaseUrl: string;
  filePrefix: string;
  secretStored: boolean;
}

/** 回传 UI 的通道视图（按 provider 收窄的联合） */
export type CloudChannelView = CloudS3ChannelView | CloudGistChannelView;

/** 写入入参（表单原样；字段按 provider 各自校验）。 */
export interface CloudChannelWriteInput {
  endpoint?: string;
  region?: string;
  bucket?: string;
  prefix?: string;
  accessKeyId?: string;
  pathStyle?: boolean;
  /** 显式覆盖签名方言（可缺省；仅 'aws4' | 'oss4' 被接受） */
  dialectId?: SigV4DialectId;
  gistId?: string;
  apiBaseUrl?: string;
  filePrefix?: string;
  /** 明文密钥：**只写**（提供即写入 credentials）；缺省 = 只更新非密字段，已有密钥不动 */
  secret?: string;
}

/**
 * 云端点配置的**稳定错误码**（不是用户文案）。
 * 与 \`validateRepoUrl\` 返回 \`'repoUrl is required'\` 同口径：码由路由/UI 层映射进字典，
 * 因此本模块不产生任何用户可见字符串。
 */
export type CloudConfigIssueCode =
  | 'cloud.providerUnknown'
  | 'cloud.endpointRequired'
  | 'cloud.endpointInvalid'
  | 'cloud.endpointUserinfo'
  | 'cloud.regionRequired'
  | 'cloud.bucketRequired'
  | 'cloud.bucketInvalid'
  | 'cloud.prefixInvalid'
  | 'cloud.accessKeyIdRequired'
  | 'cloud.gistIdRequired'
  | 'cloud.gistIdInvalid'
  | 'cloud.apiBaseUrlInvalid'
  | 'cloud.secretWriterRequired';

/** 配置校验失败：携带稳定错误码（无用户文案），由上层映射成字典键。 */
export class CloudConfigError extends Error {
  readonly code: CloudConfigIssueCode;
  constructor(code: CloudConfigIssueCode, detail?: string) {
    super(detail === undefined ? code : code + ': ' + detail);
    this.name = 'CloudConfigError';
    this.code = code;
  }
}

/** 桶名：3-63 位小写字母/数字/点/连字符，首尾为字母或数字（与 S3 命名规则同口径）。 */
const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
/** gist id：GitHub 的十六进制串 */
const GIST_ID_RE = /^[0-9a-f]{5,64}$/i;
/** 签名方言 id 守卫（与 src/sync/s3/sigv4.ts 的 SigV4DialectId 同集合；非法值忽略）。 */
function isSigV4DialectId(value: unknown): value is SigV4DialectId {
  return value === 'aws4' || value === 'oss4';
}

/** 端点校验（http(s)、无 userinfo、无 query/hash）；返回错误码或 null。 */
export function validateCloudEndpoint(endpoint: string): CloudConfigIssueCode | null {
  if (typeof endpoint !== 'string' || endpoint.trim() === '') return 'cloud.endpointRequired';
  const raw = endpoint.trim();
  if (/\s/.test(raw)) return 'cloud.endpointInvalid';
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return 'cloud.endpointInvalid';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'cloud.endpointInvalid';
  if (parsed.username !== '' || parsed.password !== '') return 'cloud.endpointUserinfo';
  if (parsed.search !== '' || parsed.hash !== '') return 'cloud.endpointInvalid';
  return null;
}

/** region 校验：非空、无空白。 */
export function validateCloudRegion(region: string): CloudConfigIssueCode | null {
  if (typeof region !== 'string' || region.trim() === '' || /\s/.test(region.trim())) return 'cloud.regionRequired';
  return null;
}

/** 桶名校验。 */
export function validateCloudBucket(bucket: string): CloudConfigIssueCode | null {
  if (typeof bucket !== 'string' || bucket.trim() === '') return 'cloud.bucketRequired';
  const b = bucket.trim();
  if (!BUCKET_NAME_RE.test(b) || b.includes('..')) return 'cloud.bucketInvalid';
  return null;
}

/** 对象键前缀校验（可缺省 = 根前缀；不得以 / 开头、不得含 .. / 反斜杠 / 空段）。 */
export function validateCloudPrefix(prefix: string): CloudConfigIssueCode | null {
  if (typeof prefix !== 'string') return 'cloud.prefixInvalid';
  // 首尾斜杠先归一（与 `normalizeObjectPrefix` 同口径）：用户从控制台复制粘贴的
  // 前缀常带 /，那是书写噪声而不是错误 —— 归一后才判定真正的非法形态。
  const p = prefix.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (p === '') return null;
  if (p.includes('\\') || p.includes('//') || p.includes('..')) return 'cloud.prefixInvalid';
  if (/[\u0000-\u001f\u007f]/.test(p)) return 'cloud.prefixInvalid';
  return null;
}

/** gist id 校验。 */
export function validateGistId(gistId: string): CloudConfigIssueCode | null {
  if (typeof gistId !== 'string' || gistId.trim() === '') return 'cloud.gistIdRequired';
  if (!GIST_ID_RE.test(gistId.trim())) return 'cloud.gistIdInvalid';
  return null;
}

/** GitHub API 根校验（http(s)、无 userinfo）。 */
export function validateCloudApiBaseUrl(url: string): CloudConfigIssueCode | null {
  if (typeof url !== 'string' || url.trim() === '') return 'cloud.apiBaseUrlInvalid';
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return 'cloud.apiBaseUrlInvalid';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'cloud.apiBaseUrlInvalid';
  if (parsed.username !== '' || parsed.password !== '') return 'cloud.apiBaseUrlInvalid';
  return null;
}

/** 按通道校验写入入参；返回首个错误码或 null。 */
export function validateCloudChannelInput(
  provider: CloudSyncProvider,
  input: CloudChannelWriteInput,
): CloudConfigIssueCode | null {
  if (!isCloudSyncProvider(provider)) return 'cloud.providerUnknown';
  if (isGistProvider(provider)) {
    const bad = validateGistId(input.gistId ?? '');
    if (bad !== null) return bad;
    if (input.apiBaseUrl !== undefined && input.apiBaseUrl.trim() !== '') {
      const apiBad = validateCloudApiBaseUrl(input.apiBaseUrl);
      if (apiBad !== null) return apiBad;
    }
    if (input.filePrefix !== undefined && validateCloudPrefix(input.filePrefix) !== null) return 'cloud.prefixInvalid';
    return null;
  }
  const checks: Array<CloudConfigIssueCode | null> = [
    validateCloudEndpoint(input.endpoint ?? ''),
    validateCloudRegion(input.region ?? ''),
    validateCloudBucket(input.bucket ?? ''),
    typeof input.accessKeyId === 'string' && input.accessKeyId.trim() !== '' ? null : 'cloud.accessKeyIdRequired',
  ];
  for (const c of checks) if (c !== null) return c;
  if (input.prefix !== undefined && validateCloudPrefix(input.prefix) !== null) return 'cloud.prefixInvalid';
  return null;
}

/** 解析 S3 通道的非密字段；必填字段缺失/非法 → null（视为未配置）。 */
function parseS3Channel(raw: unknown): CloudS3ChannelConfig | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const endpoint = typeof o['endpoint'] === 'string' ? o['endpoint'] : '';
  const region = typeof o['region'] === 'string' ? o['region'] : '';
  const bucket = typeof o['bucket'] === 'string' ? o['bucket'] : '';
  const accessKeyId = typeof o['accessKeyId'] === 'string' ? o['accessKeyId'] : '';
  if (validateCloudEndpoint(endpoint) !== null || region === '' || bucket === '' || accessKeyId === '') return null;
  const cfg: CloudS3ChannelConfig = { endpoint: endpoint.trim(), region: region.trim(), bucket: bucket.trim(), accessKeyId: accessKeyId.trim() };
  if (typeof o['prefix'] === 'string' && o['prefix'].trim() !== '') cfg.prefix = o['prefix'].trim();
  if (typeof o['pathStyle'] === 'boolean') cfg.pathStyle = o['pathStyle'];
  if (isSigV4DialectId(o['dialectId'])) cfg.dialectId = o['dialectId'];
  if (o['secretStored'] === true) cfg.secretStored = true;
  // 注意：raw 里若混进 secretAccessKey/token 之类的键，这里**整体忽略**（读侧绝不回读密钥）
  return cfg;
}

/** 解析 Gist 通道的非密字段；非法 → null。 */
function parseGistChannel(raw: unknown): CloudGistChannelConfig | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const gistId = typeof o['gistId'] === 'string' ? o['gistId'] : '';
  if (validateGistId(gistId) !== null) return null;
  const cfg: CloudGistChannelConfig = { gistId: gistId.trim() };
  if (typeof o['apiBaseUrl'] === 'string' && o['apiBaseUrl'].trim() !== '') cfg.apiBaseUrl = o['apiBaseUrl'].trim();
  if (typeof o['filePrefix'] === 'string' && o['filePrefix'].trim() !== '') cfg.filePrefix = o['filePrefix'].trim();
  if (o['secretStored'] === true) cfg.secretStored = true;
  return cfg;
}

/** 从原始 JSON 对象解析 savedProviders（只取白名单字段；任何密钥字段一律丢弃）。 */
function parseCloudSavedProviders(raw: unknown): CloudSavedProviders {
  const out: CloudSavedProviders = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const o = raw as Record<string, unknown>;
  for (const provider of S3_COMPAT_PROVIDERS) {
    const cfg = parseS3Channel(o[provider]);
    if (cfg !== null) out[provider] = cfg;
  }
  const gist = parseGistChannel(o[GIST_PROVIDER]);
  if (gist !== null) out.gist = gist;
  return out;
}

/**
 * 读取云端点配置；文件不存在/损坏/schema 不支持 → null（视为未配置）。
 * **绝不回读密钥值**：只认非密白名单字段 + \`secretStored\` 标记。
 */
export async function readCloudSyncConfig(dir: string): Promise<CloudSyncConfig | null> {
  const file = path.join(dir, CLOUD_SYNC_CONFIG_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = parseJsonSafe(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  const version = typeof o['schemaVersion'] === 'number' ? o['schemaVersion'] : CLOUD_SYNC_CONFIG_SCHEMA_VERSION;
  if (version !== CLOUD_SYNC_CONFIG_SCHEMA_VERSION) return null;
  const active = parseCloudActive(o['active']);
  return {
    schemaVersion: version,
    savedProviders: parseCloudSavedProviders(o['savedProviders']),
    ...(active === undefined ? {} : { active }),
  };
}

/** 解析 active 选择（未知/非法值一律丢弃；一个都没有 → undefined，读侧按单一已保存者推断）。 */
function parseCloudActive(raw: unknown): CloudActiveProviders | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const out: CloudActiveProviders = {};
  if (isS3CompatProvider(o['s3'])) out.s3 = o['s3'];
  if (isGistProvider(o['gist'])) out.gist = o['gist'];
  return out.s3 === undefined && out.gist === undefined ? undefined : out;
}

/** 读取单条云端点通道的配置；该通道未配置/非法 → null。 */
export async function readCloudChannelConfig(
  dir: string,
  provider: CloudSyncProvider,
): Promise<CloudChannelConfig | null> {
  const all = await readCloudSyncConfig(dir);
  if (all === null) return null;
  if (isGistProvider(provider)) {
    const gist = all.savedProviders.gist;
    return gist === undefined ? null : { provider: 'gist', config: gist };
  }
  const cfg = all.savedProviders[provider];
  return cfg === undefined ? null : { provider, config: cfg };
}

/** 已配置的云端点通道清单（供 UI 回填 / 断开时判断是否还剩别的通道）。 */
export async function listCloudConfiguredProviders(dir: string): Promise<CloudSyncProvider[]> {
  const all = await readCloudSyncConfig(dir);
  if (all === null) return [];
  const out: CloudSyncProvider[] = [];
  for (const provider of CLOUD_SYNC_PROVIDERS) {
    const has = provider === GIST_PROVIDER
      ? all.savedProviders.gist !== undefined
      : all.savedProviders[provider] !== undefined;
    if (has) out.push(provider);
  }
  return out;
}

/** 组装 S3 兼容系回传视图（**只带标记、不带值**）。 */
export function s3ChannelView(
  provider: S3CompatProvider,
  config: CloudS3ChannelConfig,
  secretStored: boolean,
): CloudS3ChannelView {
  return {
    provider,
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    prefix: config.prefix ?? 'dsh-config-manager',
    accessKeyId: config.accessKeyId,
    pathStyle: config.pathStyle ?? false,
    secretStored,
  };
}

/** 组装 Gist 回传视图（**只带标记、不带值**）。 */
export function gistChannelView(
  config: CloudGistChannelConfig,
  secretStored: boolean,
): CloudGistChannelView {
  return {
    provider: 'gist',
    gistId: config.gistId,
    apiBaseUrl: config.apiBaseUrl ?? 'https://api.github.com',
    filePrefix: config.filePrefix ?? 'dsh-sync',
    secretStored,
  };
}

/** 组装回传视图（按 provider 分派到具名视图构造器）。 */
export function cloudChannelView(
  channel: CloudChannelConfig,
  secretStored: boolean,
): CloudChannelView {
  return channel.provider === 'gist'
    ? gistChannelView(channel.config, secretStored)
    : s3ChannelView(channel.provider, channel.config, secretStored);
}

/** 把某通道配置写进 savedProviders（显式穷举，新增通道时 typecheck 会报缺分支）。 */
function assignProvider(
  saved: CloudSavedProviders,
  provider: CloudSyncProvider,
  cfg: CloudS3ChannelConfig | CloudGistChannelConfig,
): CloudSavedProviders {
  const next: CloudSavedProviders = { ...saved };
  switch (provider) {
    case 's3':
    case 'oss':
    case 'cos':
    case 'minio':
    case 'kodo':
      next[provider] = cfg as CloudS3ChannelConfig;
      return next;
    case 'gist':
      next.gist = cfg as CloudGistChannelConfig;
      return next;
  }
}

/**
 * 保存某云端点通道的配置（自动创建目录；恒写 schemaVersion=1 的 savedProviders）。
 * - 只写当前通道的条目，其它通道原样保留（切换通道不丢失已填的 endpoint/bucket）；
 * - 密钥**只写**：提供 input.secret 时经注入的 \`CloudSecretWriter\` 写进 credentials 槽位，
 *   文件里只留 \`secretStored: true\`（值绝不落文件、绝不回传）；
 * - 未提供 secret 时只更新非密字段（已有密钥不动，标记按 \`has()\` 现算）。
 */
export async function writeCloudChannelConfig(
  dir: string,
  provider: CloudSyncProvider,
  input: CloudChannelWriteInput,
  secrets?: CloudSecretWriter,
): Promise<CloudChannelView> {
  const issue = validateCloudChannelInput(provider, input);
  if (issue !== null) throw new CloudConfigError(issue);
  const file = path.join(dir, CLOUD_SYNC_CONFIG_FILE);
  const existing = await readCloudSyncConfig(dir);
  const saved: CloudSavedProviders = existing === null ? {} : { ...existing.savedProviders };

  const secretValue = typeof input.secret === 'string' ? input.secret : '';
  const ref = cloudSecretRef(provider);
  let secretStored: boolean;
  if (secretValue !== '') {
    if (secrets === undefined) throw new CloudConfigError('cloud.secretWriterRequired');
    await secrets.set(ref, secretValue);
    secretStored = true;
  } else {
    // 绝不回读值：只能问「有没有」
    secretStored = secrets === undefined ? savedStoredFlag(saved, provider) : await secrets.has(ref);
  }

  let cfg: CloudS3ChannelConfig | CloudGistChannelConfig;
  if (isGistProvider(provider)) {
    cfg = {
      gistId: (input.gistId ?? '').trim(),
      ...(input.apiBaseUrl !== undefined && input.apiBaseUrl.trim() !== '' ? { apiBaseUrl: input.apiBaseUrl.trim() } : {}),
      ...(input.filePrefix !== undefined && input.filePrefix.trim() !== '' ? { filePrefix: normalizePrefix(input.filePrefix) } : {}),
      ...(secretStored ? { secretStored: true } : {}),
    };
  } else {
    cfg = {
      endpoint: (input.endpoint ?? '').trim().replace(/\/+$/, ''),
      region: (input.region ?? '').trim(),
      bucket: (input.bucket ?? '').trim(),
      ...(input.prefix !== undefined && input.prefix.trim() !== '' ? { prefix: normalizePrefix(input.prefix) } : {}),
      accessKeyId: (input.accessKeyId ?? '').trim(),
      ...(typeof input.pathStyle === 'boolean' ? { pathStyle: input.pathStyle } : {}),
      ...(isSigV4DialectId(input.dialectId) ? { dialectId: input.dialectId } : {}),
      ...(secretStored ? { secretStored: true } : {}),
    };
  }
  const nextSaved = assignProvider(saved, provider, cfg);
  // 「保存即选定」：写这条 provider 就把该通道的 active 指向它（切回其他 provider 时 savedProviders 仍留记忆）
  const nextActive: CloudActiveProviders = { ...(existing?.active ?? {}) };
  if (isGistProvider(provider)) nextActive.gist = 'gist';
  else nextActive.s3 = provider;
  await fs.mkdir(dir, { recursive: true });
  await atomicWriteFile(
    file,
    stringifyJsonSafe({ schemaVersion: CLOUD_SYNC_CONFIG_SCHEMA_VERSION, savedProviders: nextSaved, active: nextActive }, { space: 2 }),
    { mode: 0o600 },
  );
  return isGistProvider(provider)
    ? gistChannelView(cfg as CloudGistChannelConfig, secretStored)
    : s3ChannelView(provider, cfg as CloudS3ChannelConfig, secretStored);
}

/** 前缀归一：去首尾斜杠（空 = 根前缀）。 */
function normalizePrefix(prefix: string): string {
  return prefix.trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

/** 既有条目里的 secretStored 标记（无 writer 时的保守答案：只信磁盘上的标记）。 */
function savedStoredFlag(saved: CloudSavedProviders, provider: CloudSyncProvider): boolean {
  const cfg = provider === GIST_PROVIDER ? saved.gist : saved[provider];
  return cfg?.secretStored === true;
}

/**
 * 断开某云端点通道：删掉该通道的配置条目；一条不剩则删除整个文件。
 * 幂等：本来没配置 → removed=false 且**不写文件**。
 * 密钥槽位不在这里清除（凭据归凭据层），与 \`clearSyncChannel\` 同口径。
 */
export async function clearCloudChannelConfig(
  dir: string,
  provider: CloudSyncProvider,
): Promise<{ removed: boolean; hasRemaining: boolean }> {
  const file = path.join(dir, CLOUD_SYNC_CONFIG_FILE);
  const existing = await readCloudSyncConfig(dir);
  if (existing === null) return { removed: false, hasRemaining: false };
  const saved: CloudSavedProviders = { ...existing.savedProviders };
  const present = provider === GIST_PROVIDER ? saved.gist !== undefined : saved[provider] !== undefined;
  if (!present) return { removed: false, hasRemaining: Object.keys(saved).length > 0 };
  if (provider === GIST_PROVIDER) delete saved.gist;
  else delete saved[provider];
  const active: CloudActiveProviders = { ...(existing.active ?? {}) };
  if (isGistProvider(provider)) {
    if (active.gist !== undefined) delete active.gist;
  } else if (active.s3 === provider) {
    delete active.s3;
  }
  const remaining = Object.keys(saved).length > 0;
  if (!remaining) {
    await fs.rm(file, { force: true });
    return { removed: true, hasRemaining: false };
  }
  await atomicWriteFile(
    file,
    stringifyJsonSafe({
      schemaVersion: CLOUD_SYNC_CONFIG_SCHEMA_VERSION,
      savedProviders: saved,
      ...(active.s3 === undefined && active.gist === undefined ? {} : { active }),
    }, { space: 2 }),
    { mode: 0o600 },
  );
  return { removed: true, hasRemaining: true };
}


/* ------------------------------------------------------------------------------------------------
 * 云端点通道 → SyncConfig 投影（S3 兼容系 / gist）
 * ---------------------------------------------------------------------------------------------- */

/**
 * s3 通道当前选用的兼容商：
 *  - 有 active.s3 → 用它（且必须仍有已保存配置）；
 *  - 旧文件（无 active）→ 只有**唯一一家**已保存时据此推断，多家并存时为 null（不猜）。
 */
export async function readActiveS3Provider(dir: string): Promise<S3CompatProvider | null> {
  const all = await readCloudSyncConfig(dir);
  if (all === null) return null;
  const active = all.active?.s3;
  if (active !== undefined) return all.savedProviders[active] === undefined ? null : active;
  const present = S3_COMPAT_PROVIDERS.filter((p) => all.savedProviders[p] !== undefined);
  return present.length === 1 ? present[0]! : null;
}

/** s3 通道的配置投影（未配置 → null）；provider 由 active 决定。 */
async function readS3ChannelConfig(dir: string): Promise<S3ChannelConfig | null> {
  const provider = await readActiveS3Provider(dir);
  if (provider === null) return null;
  const cfg = await readCloudChannelConfig(dir, provider);
  if (cfg === null || cfg.provider === GIST_PROVIDER) return null;
  return { provider, ...cfg.config };
}

/** gist 通道的配置投影（未配置 → null）。 */
async function readGistChannelConfig(dir: string): Promise<GistChannelConfig | null> {
  const cfg = await readCloudChannelConfig(dir, GIST_PROVIDER);
  return cfg === null || cfg.provider !== GIST_PROVIDER ? null : cfg.config;
}

/**
 * 当前仍配置的通道清单（git/webdav 命名空间 ∪ 云端点已保存的 provider），顺序 = SYNC_CHANNELS。
 * 供路由层判断「还有没有其他通道可用」与断开后回落活动通道。
 */
export async function listConfiguredChannels(dir: string): Promise<SyncTransportType[]> {
  const both = await readBothNamespaces(path.join(dir, SYNC_CONFIG_FILE));
  const cloud = await listCloudConfiguredProviders(dir);
  const out: SyncTransportType[] = [];
  if (both.git !== undefined) out.push('git');
  if (both.webdav !== undefined) out.push('webdav');
  if (cloud.some((p) => isS3CompatProvider(p))) out.push('s3');
  if (cloud.includes(GIST_PROVIDER)) out.push('gist');
  return out;
}

/** 读 sync-config.json 的活动通道指针（读不到 → git，与 readFullSyncConfig 同口径）。 */
async function readTransportPointer(dir: string): Promise<SyncTransportType> {
  try {
    const raw = await fs.readFile(path.join(dir, SYNC_CONFIG_FILE), 'utf8');
    const parsed = parseJsonSafe(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parseSyncChannel((parsed as Record<string, unknown>)['transport']) ?? 'git';
    }
  } catch { /* 读不到 → 缺省 git */ }
  return 'git';
}

/** 写 sync-config.json（活动通道 + git/webdav 命名空间；云端点配置不在此文件）。 */
async function writeSyncConfigFile(
  dir: string,
  namespaces: { git?: GitConfig; webdav?: WebDavConfig },
  transport: SyncTransportType,
): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const payload: Record<string, unknown> = { schemaVersion: SYNC_CONFIG_SCHEMA_VERSION, transport };
  if (namespaces.git !== undefined) payload.git = namespaces.git;
  if (namespaces.webdav !== undefined) payload.webdav = namespaces.webdav;
  await atomicWriteFile(path.join(dir, SYNC_CONFIG_FILE), stringifyJsonSafe(payload, { space: 2 }), { mode: 0o600 });
}

/** 只更新 sync-config.json 的活动通道指针，原样保留 git/webdav 命名空间。 */
async function writeSyncConfigTransport(dir: string, transport: SyncTransportType): Promise<void> {
  const file = path.join(dir, SYNC_CONFIG_FILE);
  const existing = await readBothNamespaces(file);
  await writeSyncConfigFile(dir, { git: existing.git, webdav: existing.webdav }, transport);
}

