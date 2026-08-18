/**
 * SyncSessionStore：一键同步差异确认会话的内存登记。
 *
 * 会话把「拉取预览」与「逐项执行导入」解耦：一次 /sync/sync 在内存持有一份
 * 临时 ZIP 路径 + ImportPlan + ImportAnalysis，配一个 syncSessionId；
 * /sync/apply-items 凭 id 复用这些数据，避免重复拉取/重复 build ZIP。
 *
 * 生命周期：
 *  - 进程内存（不落盘），默认 TTL 30 分钟，过期条目惰性清理（get 时检查）；
 *  - 同 id 覆盖（set 后旧 session 被新 session 替换，旧 ZIP 由上层负责清理）；
 *  - delete 显式移除（/sync/cancel 与 apply-items 消费后调用）。
 */
import crypto from 'node:crypto';
import type { ImportAnalysis, ImportPlan } from '../core/types.ts';
import type { SyncConfig } from './sync-config.ts';

/** 默认会话 TTL（30 分钟） */
export const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;

/** 一次差异确认会话的完整数据 */
export interface SyncSession {
  id: string;
  /** 临时标准 ZIP（apply-items 执行 executeImportPlan 需要） */
  zipPath: string;
  plan: ImportPlan;
  analysis: ImportAnalysis;
  /** 被拉取的远端快照 id */
  snapshotId: string;
  /** 该次同步使用的通道配置（git/webdav 通用；apply-items 据此重建引擎） */
  config: SyncConfig;
  /** 创建时间（epoch ms） */
  createdAt: number;
  /** 过期时间（epoch ms；过期条目惰性清理） */
  expiresAt: number;
}

/** 内存会话存储；同 id 覆盖；过期条目视为不存在。 */
export class SyncSessionStore {
  private readonly sessions = new Map<string, SyncSession>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /** 登记（或覆盖）会话；id 缺省时自动生成。createdAt/expiresAt 缺省自动填充。返回会话 id。 */
  set(session: Omit<SyncSession, 'id' | 'createdAt' | 'expiresAt'> & { id?: string; createdAt?: number; expiresAt?: number }): string {
    const id = session.id ?? `sync-session-${crypto.randomUUID()}`;
    const createdAt = session.createdAt ?? this.now();
    const expiresAt = session.expiresAt ?? createdAt + this.ttlMs;
    this.sessions.set(id, {
      ...session,
      id,
      createdAt,
      expiresAt,
    });
    return id;
  }

  /** 读取会话；过期条目返回 undefined（惰性清理）。 */
  get(id: string): SyncSession | undefined {
    const s = this.sessions.get(id);
    if (s === undefined) return undefined;
    if (this.now() >= s.expiresAt) {
      this.sessions.delete(id);
      return undefined;
    }
    return { ...s };
  }

  /** 删除会话（cancel / apply-items 消费后调用）。 */
  delete(id: string): void {
    this.sessions.delete(id);
  }
}
