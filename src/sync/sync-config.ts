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

export const SYNC_CONFIG_FILE = 'sync-config.json';

/**
 * 同步通道枚举（**唯一声明处**，t32）：所有「有哪些通道 / 通道列表 / 通道判定」的唯一事实源。
 *
 * 为什么要单一来源：此前 SyncTransportType 在 sync-config / ui-prefs / client sync-api /
 * client sync-view 各自声明一遍，通道数组也在 autosync-scheduler 里写了两遍 ——「改一处漏一处」
 * 的表现是某个通道**静默**不再排期 / 不再落盘，而不是报错。新增通道只改这里：typecheck 会在
 * 所有 Record<SyncTransportType, X> 的构造处与穷尽检查处报错。
 */
export const SYNC_CHANNELS = ['git', 'webdav'] as const;

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
}

/** 持久化的同步通道配置：可辨识联合（schemaVersion 恒 2） */
export type SyncConfig =
  | { schemaVersion: 2; transport: 'git'; git: GitConfig }
  | { schemaVersion: 2; transport: 'webdav'; webdav: WebDavConfig };

/** git 通道守卫 */
export function isGitConfig(cfg: SyncConfig): cfg is Extract<SyncConfig, { transport: 'git' }> {
  return cfg.transport === 'git';
}

/** webdav 通道守卫 */
export function isWebDavConfig(cfg: SyncConfig): cfg is Extract<SyncConfig, { transport: 'webdav' }> {
  return cfg.transport === 'webdav';
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
 * 读取同步通道配置；文件不存在/损坏/不支持 schema → null（视为未配置，UI 显示空表单）。
 * 兼容旧文件：缺 schemaVersion 字段视为 v1（git 通道）。
 * 恒返回 schemaVersion=2 的规范形态（v1 读取时归一为 git）。
 */
export async function readSyncConfig(dir: string): Promise<SyncConfig | null> {
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
    return { schemaVersion: 2, transport: 'git', git };
  }

  // v2 / v3：顶层 transport 选择（v3 双命名空间并存，按 transport 返回对应通道）
  const transport = obj['transport'];
  // 通道合法性只认唯一枚举（SYNC_CHANNELS）：新增通道无需在此补字面量
  if (!isSyncTransportType(transport)) return null;
  if (transport === 'git') {
    const git = parseV2GitNamespace(obj['git']);
    if (git === null) return null;
    return { schemaVersion: 2, transport: 'git', git };
  }
  const webdav = parseV2WebDavNamespace(obj['webdav']);
  if (webdav === null) return null;
  return { schemaVersion: 2, transport: 'webdav', webdav };
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
export async function readFullSyncConfig(dir: string): Promise<FullSyncConfig | null> {
  const file = path.join(dir, SYNC_CONFIG_FILE)
  const both = await readBothNamespaces(file)
  if (both.git === undefined && both.webdav === undefined) return null
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
  return { transport, git: both.git, webdav: both.webdav }
}

/**
 * 读取指定通道的同步通道配置（供自动同步调度器按通道运行）。
 * 从完整双命名空间配置取对应通道构造可辨识联合 SyncConfig；该通道未配置 → null。
 */
export async function readSyncConfigFor(dir: string, channel: SyncTransportType): Promise<SyncConfig | null> {
  const full = await readFullSyncConfig(dir);
  if (full === null) return null;
  if (channel === 'webdav') {
    if (full.webdav === undefined) return null;
    return { schemaVersion: 2, transport: 'webdav', webdav: full.webdav };
  }
  if (full.git === undefined) return null;
  return { schemaVersion: 2, transport: 'git', git: full.git };
}

/**
 * 保存同步通道配置（自动创建目录；恒写 schemaVersion=3 双命名空间）。
 * - 写入当前通道的命名空间（git/webdav）；
 * - 另一通道之前配置过 → 一并保留（切换通道不丢失另一通道的 repoUrl/url）；
 * - 覆盖旧值；未配置过的字段不写入。
 */
export async function writeSyncConfig(dir: string, cfg: SyncConfig): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, SYNC_CONFIG_FILE)
  const existing = await readBothNamespaces(file)
  const payload: Record<string, unknown> = {
    schemaVersion: SYNC_CONFIG_SCHEMA_VERSION,
    transport: cfg.transport,
  }
  if (isGitConfig(cfg)) {
    payload.git = cfg.git
    // 保留另一通道的 webdav 配置（存在时）
    if (existing.webdav !== undefined) payload.webdav = existing.webdav
  } else {
    payload.webdav = cfg.webdav
    // 保留另一通道的 git 配置（存在时）
    if (existing.git !== undefined) payload.git = existing.git
  }
  await atomicWriteFile(file, stringifyJsonSafe(payload, { space: 2 }), { mode: 0o600 });
}

/**
 * 仓库地址合法性校验（返回错误消息；null = 合法）。
 * 安全约束：token 永不拼入 repoUrl —— http(s) 地址带 userinfo（username[:password]@）直接拒绝，
 * 引导用户把 token 放凭据字段（DSH credentials），避免 token 经 URL 泄漏进 git 历史/日志。
 */
export function validateRepoUrl(repoUrl: string, msg: MsgFunc = zhMsg): string | null {
  if (typeof repoUrl !== 'string' || repoUrl.trim() === '') {
    return 'repoUrl is required';
  }
  const url = repoUrl.trim();
  if (/\s/.test(url)) {
    return msg('sync.configWhitespace');
  }
  if (/^https?:\/\//i.test(url)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return msg('sync.configUnparseable', { url });
    }
    if (parsed.username !== '' || parsed.password !== '') {
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
