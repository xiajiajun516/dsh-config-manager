/**
 * m-sync-flow：待审队列持久化（独立文件 sync-review-queue.json）。
 *
 * 与 sync-state.json 分文件存放：sync-state 是机器可读同步元数据，
 * 待审队列是用户可见/可决策的工作队列；混在一起会让同步引擎误读。
 *
 * 设计：
 *  - 只存差异摘要（items 数组），不存全量 payload——避免双写；
 *    UI 需要完整数据时回拉远端或复用运行时 MergePlan。
 *  - 写入用 writeFile + rename 原子提交：半成品文件不会污染读侧。
 *  - 损坏 JSON 严格拒绝（不静默降级到空队列）。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { parseJsonSafe, stringifyJsonSafe } from '../utils/json.ts';
import { atomicWriteFile } from '../utils/atomic-write.ts';

export const REVIEW_QUEUE_FILE = 'sync-review-queue.json';

/** 单条待审项（决策前 description/local/remote/ancestor 必填；decision 可选） */
export interface ReviewQueueItem {
  id: string;
  /** 分区 id（settings / providers / workspaces / plugins / mcp 等） */
  sectionId: string;
  /** 'key' | 'file' | 'section'：冲突粒度（来自 MergeConflict.kind 或整分区冲突） */
  kind: 'key' | 'file' | 'section';
  description: string;
  local?: unknown;
  remote?: unknown;
  ancestor?: unknown;
  /** 用户决策（resolve 后写入） */
  decision?: 'useRemote' | 'keepLocal' | 'skip';
  decidedAt?: string;
  /** 关联的远端快照 id（追溯来源） */
  snapshotId?: string;
}

export interface ReviewQueue {
  items: ReviewQueueItem[];
  updatedAt: string;
}

export const EMPTY_REVIEW_QUEUE: ReviewQueue = { items: [], updatedAt: '' };

/** 读取待审队列；文件不存在 → 返回空队列；损坏 JSON 抛错。 */
export async function readReviewQueue(
  stateDir: string,
  fsx: Pick<typeof fs, 'readFile' | 'writeFile' | 'rename' | 'stat' | 'mkdir'> = fs,
): Promise<ReviewQueue> {
  const file = path.join(stateDir, REVIEW_QUEUE_FILE);
  try {
    const raw = await fsx.readFile(file, 'utf8');
    const parsed = parseJsonSafe(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('sync-review-queue.json 损坏：必须是对象');
    }
    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj['items'])) {
      throw new Error('sync-review-queue.json 损坏：items 必须是数组');
    }
    const items: ReviewQueueItem[] = [];
    for (const it of obj['items']) {
      if (it === null || typeof it !== 'object' || Array.isArray(it)) {
        throw new Error('sync-review-queue.json 损坏：每个 item 必须是对象');
      }
      const i = it as Record<string, unknown>;
      if (typeof i['id'] !== 'string' || typeof i['sectionId'] !== 'string'
        || typeof i['kind'] !== 'string' || typeof i['description'] !== 'string') {
        throw new Error('sync-review-queue.json 损坏：item 必须含字符串 id/sectionId/kind/description');
      }
      items.push(i as unknown as ReviewQueueItem);
    }
    return {
      items,
      updatedAt: typeof obj['updatedAt'] === 'string' ? obj['updatedAt'] : '',
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY_REVIEW_QUEUE };
    throw err;
  }
}

/**
 * 原子写入：先写临时文件 + rename 到目标文件（POSIX/Windows 均支持 rename 原子替换）。
 * 同一 stateDir 下并发调用不会产生半成品文件（写完临时再 rename）。
 */
export async function writeReviewQueue(
  stateDir: string,
  queue: ReviewQueue,
  fsx: Pick<typeof fs, 'readFile' | 'writeFile' | 'rename' | 'stat' | 'mkdir'> = fs,
): Promise<void> {
  await fsx.mkdir(stateDir, { recursive: true });
  const target = path.join(stateDir, REVIEW_QUEUE_FILE);
  const data = stringifyJsonSafe(queue, { space: 2 });
  await atomicWriteFile(target, data, { mode: 0o600 });
}

/** 生成稳定 id（基于内容的 hex；同 description → 同 id，便于去重） */
function hashItemId(sectionId: string, kind: string, description: string, path?: string): string {
  const h = crypto.createHash('sha256');
  h.update(`${sectionId}\u0000${kind}\u0000${path ?? ''}\u0000${description}`);
  return h.digest('hex').slice(0, 16);
}

/** 把多 item 追加到队列（同 id 视为同一项，不重复追加） */
export async function enqueueItems(
  stateDir: string,
  items: Omit<ReviewQueueItem, 'id' | 'decidedAt' | 'decision'>[],
  now: () => Date = () => new Date(),
  fsx: Pick<typeof fs, 'readFile' | 'writeFile' | 'rename' | 'stat' | 'mkdir'> = fs,
): Promise<ReviewQueue> {
  const current = await readReviewQueue(stateDir, fsx);
  const seen = new Set(current.items.map((i) => i.id));
  for (const it of items) {
    const id = hashItemId(it.sectionId, it.kind, it.description);
    if (seen.has(id)) continue;
    current.items.push({ ...it, id });
    seen.add(id);
  }
  current.updatedAt = now().toISOString();
  await writeReviewQueue(stateDir, current, fsx);
  return current;
}

/** 把整组合并后的 autoApply 项（失败回滚后）入队 */
export async function enqueueAutoAppliedOnFailure(
  stateDir: string,
  items: Omit<ReviewQueueItem, 'id' | 'decidedAt' | 'decision'>[],
  fsx: Pick<typeof fs, 'readFile' | 'writeFile' | 'rename' | 'stat' | 'mkdir'> = fs,
): Promise<ReviewQueue> {
  return enqueueItems(stateDir, items, undefined, fsx);
}

/** 用户对某条 item 做了决策（keepLocal / useRemote / skip）；未找到抛错。 */
export async function resolveItem(
  stateDir: string,
  itemId: string,
  decision: 'useRemote' | 'keepLocal' | 'skip',
  now: () => Date = () => new Date(),
  fsx: Pick<typeof fs, 'readFile' | 'writeFile' | 'rename' | 'stat' | 'mkdir'> = fs,
): Promise<ReviewQueue> {
  const current = await readReviewQueue(stateDir, fsx);
  const idx = current.items.findIndex((i) => i.id === itemId);
  if (idx === -1) throw new Error(`resolveItem: 未找到 itemId ${itemId}`);
  current.items[idx] = { ...current.items[idx]!, decision, decidedAt: now().toISOString() };
  current.updatedAt = now().toISOString();
  await writeReviewQueue(stateDir, current, fsx);
  return current;
}

/** 工具：在临时目录构造 stateDir 的便捷工厂（测试用） */
export function tmpStateDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}
