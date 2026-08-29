/**
 * m-market：市场列表持久化（market-config.json）。
 *
 * $DSH_HOME/dsh-config-manager/market/market-config.json（schemaVersion=1，仿 sync-config.json）：
 *   { "schemaVersion": 1, "markets": [ { "url": "...", "addedAt": "..." } ] }
 *
 * 安全纪律（docs/design/marketplace.md §5.1）：
 *  - 只存 url（拒绝 userinfo，复用 validateRepoUrl）+ addedAt；无任何凭据；
 *  - url 去重（同 url 再 add 视为幂等，不重复登记）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseJsonSafe, stringifyJsonSafe } from '../utils/json.ts';
import { atomicWriteFile } from '../utils/atomic-write.ts';
import { validateRepoUrl } from '../sync/sync-config.ts';

export const MARKET_CONFIG_FILE = 'market-config.json';
export const MARKET_CONFIG_SCHEMA_VERSION = 1;

/** 已添加市场条目（持久化；只含 url + addedAt） */
export interface MarketConfigEntry {
  url: string;
  addedAt: string; // ISO-8601
}

/** market-config.json 顶层形状 */
export interface MarketConfig {
  schemaVersion: number;
  markets: MarketConfigEntry[];
}

/** 构造空配置（schemaVersion=1，markets=[]） */
export function emptyMarketConfig(): MarketConfig {
  return { schemaVersion: MARKET_CONFIG_SCHEMA_VERSION, markets: [] };
}

/**
 * 读取市场配置；文件不存在/损坏/不支持 schema → 返回空配置（不抛错，UI 显示空列表）。
 */
export async function readMarketConfig(dir: string): Promise<MarketConfig> {
  const file = path.join(dir, MARKET_CONFIG_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return emptyMarketConfig();
  }
  let parsed: unknown;
  try {
    parsed = parseJsonSafe(raw);
  } catch {
    return emptyMarketConfig();
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyMarketConfig();
  const obj = parsed as Record<string, unknown>;
  if (obj['schemaVersion'] !== MARKET_CONFIG_SCHEMA_VERSION) return emptyMarketConfig();
  const markets = obj['markets'];
  if (!Array.isArray(markets)) return emptyMarketConfig();
  const entries: MarketConfigEntry[] = [];
  for (const m of markets) {
    if (m === null || typeof m !== 'object' || Array.isArray(m)) continue;
    const mo = m as Record<string, unknown>;
    if (typeof mo['url'] !== 'string' || mo['url'] === '') continue;
    if (typeof mo['addedAt'] !== 'string') continue;
    // 只保留合法仓库地址（拒绝 userinfo 等），损坏条目静默跳过（不拖垮整个列表）
    if (validateRepoUrl(mo['url']) !== null) continue;
    entries.push({ url: mo['url'], addedAt: mo['addedAt'] });
  }
  return { schemaVersion: MARKET_CONFIG_SCHEMA_VERSION, markets: entries };
}

/**
 * 保存市场配置（自动创建目录；覆盖旧值；恒写 schemaVersion=1）。
 */
export async function writeMarketConfig(dir: string, cfg: MarketConfig): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const payload: Record<string, unknown> = {
    schemaVersion: MARKET_CONFIG_SCHEMA_VERSION,
    markets: cfg.markets,
  };
  await atomicWriteFile(path.join(dir, MARKET_CONFIG_FILE), stringifyJsonSafe(payload, { space: 2 }), { mode: 0o600 });
}

/**
 * 添加市场（幂等：同 url 已存在则不变更，返回新增与否）。url 非法（含 userinfo）抛错。
 */
export async function addMarket(dir: string, url: string): Promise<{ cfg: MarketConfig; added: boolean }> {
  const err = validateRepoUrl(url);
  if (err !== null) throw new Error(err);
  const cfg = await readMarketConfig(dir);
  if (cfg.markets.some((m) => m.url === url)) return { cfg, added: false };
  cfg.markets.push({ url, addedAt: new Date().toISOString() });
  await writeMarketConfig(dir, cfg);
  return { cfg, added: true };
}

/**
 * 移除市场（不存在视为成功；返回移除后配置）。
 */
export async function removeMarket(dir: string, url: string): Promise<MarketConfig> {
  const cfg = await readMarketConfig(dir);
  const next = cfg.markets.filter((m) => m.url !== url);
  if (next.length !== cfg.markets.length) {
    const updated: MarketConfig = { schemaVersion: MARKET_CONFIG_SCHEMA_VERSION, markets: next };
    await writeMarketConfig(dir, updated);
    return updated;
  }
  return cfg;
}
