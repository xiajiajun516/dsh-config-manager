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

/** 当前 sync-config.json schema 版本号（v2：命名空间 + WebDAV 通道）。 */
export const SYNC_CONFIG_SCHEMA_VERSION = 2;
/** 历史可读取版本：v1 与 v2。 */
export const SYNC_CONFIG_SUPPORTED_VERSIONS: readonly number[] = [1, 2];

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

  // v2：顶层 transport 选择
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
 * 保存同步通道配置（自动创建目录；覆盖旧值；恒写 schemaVersion=2 + transport + 对应命名空间）。
 */
export async function writeSyncConfig(dir: string, cfg: SyncConfig): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const payload: Record<string, unknown> = {
    schemaVersion: SYNC_CONFIG_SCHEMA_VERSION,
    transport: cfg.transport,
    ...(isGitConfig(cfg) ? { git: cfg.git } : { webdav: cfg.webdav }),
  };
  await fs.writeFile(path.join(dir, SYNC_CONFIG_FILE), stringifyJsonSafe(payload, { space: 2 }), 'utf8');
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
