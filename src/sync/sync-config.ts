/**
 * m-sync-ui：同步仓库配置的持久化（sync-config.json）。
 *
 * 与 sync-state.json 的分工：sync-state 记录「同步了哪些分区、何时同步」（t4 拥有），
 * 本文件只记录「上次使用的仓库配置」（repoUrl / gitBin），供 UI 打开设置页时回填表单。
 * - repoUrl 不含 token（token 只存 DSH credentials，见 src/index.ts SYNC_CREDENTIAL_REF）；
 * - 文件位于同步状态目录（$DSH_HOME/dsh-config-manager/sync/），非敏感（可回显给浏览器）；
 * - 纯逻辑 + 可注入 fs（node:fs/promises 直用；测试走临时目录）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { parseJsonSafe, stringifyJsonSafe } from '../utils/json.ts';

export const SYNC_CONFIG_FILE = 'sync-config.json';

/** 持久化的仓库配置（不含任何凭据） */
export interface SyncConfig {
  repoUrl: string;
  gitBin?: string;
}

/** 读取仓库配置；文件不存在/损坏 → null（视为未配置，UI 显示空表单） */
export async function readSyncConfig(dir: string): Promise<SyncConfig | null> {
  const file = path.join(dir, SYNC_CONFIG_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
  const parsed = parseJsonSafe(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj['repoUrl'] !== 'string' || obj['repoUrl'] === '') return null;
  const cfg: SyncConfig = { repoUrl: obj['repoUrl'] };
  if (typeof obj['gitBin'] === 'string' && obj['gitBin'] !== '') cfg.gitBin = obj['gitBin'];
  return cfg;
}

/** 保存仓库配置（自动创建目录；覆盖旧值） */
export async function writeSyncConfig(dir: string, cfg: SyncConfig): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, SYNC_CONFIG_FILE), stringifyJsonSafe(cfg, { space: 2 }), 'utf8');
}

/**
 * 仓库地址合法性校验（返回错误消息；null = 合法）。
 * 安全约束：token 永不拼入 repoUrl —— http(s) 地址带 userinfo（username[:password]@）直接拒绝，
 * 引导用户把 token 放凭据字段（DSH credentials），避免 token 经 URL 泄漏进 git 历史/日志。
 */
export function validateRepoUrl(repoUrl: string): string | null {
  if (typeof repoUrl !== 'string' || repoUrl.trim() === '') {
    return 'repoUrl is required';
  }
  const url = repoUrl.trim();
  if (/\s/.test(url)) {
    return '仓库地址不能包含空白字符';
  }
  if (/^https?:\/\//i.test(url)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return `无法解析仓库地址: ${url}`;
    }
    if (parsed.username !== '' || parsed.password !== '') {
      return '请勿在仓库地址中包含用户名/密码（认证 token 请使用凭据字段，不会拼入地址）';
    }
  }
  return null;
}
