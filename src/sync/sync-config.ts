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

export const SYNC_CONFIG_FILE = 'sync-config.json';

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
  transport: 'git' | 'webdav';
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
  if (transport !== 'git' && transport !== 'webdav') return null;
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
  let transport: 'git' | 'webdav' = 'git'
  try {
    const raw = await fs.readFile(file, 'utf8')
    const parsed = parseJsonSafe(raw)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const o = parsed as Record<string, unknown>
      if (o['transport'] === 'webdav') transport = 'webdav'
    }
  } catch { /* 默认 git */ }
  return { transport, git: both.git, webdav: both.webdav }
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
  await fs.writeFile(file, stringifyJsonSafe(payload, { space: 2 }), 'utf8');
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
