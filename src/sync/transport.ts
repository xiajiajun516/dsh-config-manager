/**
 * m-sync-transport：SyncTransport 抽象层。
 * 纯类型 + 纯 helper，零副作用、零 fs —— 传输通道实现（git 等）由后续波次提供。
 * 与核心引擎同原则：只依赖 src/schema/types.ts 的纯类型，不 import 任何 DSH 运行时包。
 */
import type { Manifest, SectionData, SectionId } from '../schema/types.ts';
import { hashSection } from './sync-state.ts';

/** manifest 摘要：快照列表展示 / 变更判断所需的轻量来源信息 */
export interface ManifestSummary {
  schemaVersion: number;
  dshVersion: string;
  platform: string;
  /** 快照包含的分区（按 manifest.sections 中为 true 的键） */
  sectionIds: SectionId[];
  containsSecrets: boolean;
}

/** 快照元信息：list() 条目 / upload() 返回值 */
export interface SyncSnapshotMeta {
  id: string;
  createdAt: string; // ISO-8601 UTC
  /** 各分区内容 hash（sectionId → hashSection 结果），用于变更检测 */
  sections: Partial<Record<SectionId, string>>;
  manifest: ManifestSummary;
}

/** 快照载荷：upload() 入参 / download() 返回 */
export interface SyncSnapshot {
  id: string;
  createdAt: string; // ISO-8601 UTC
  manifest: ManifestSummary;
  /** JSON 分区数据 + 文件类分区（FilesSection） */
  sections: Partial<Record<SectionId, SectionData>>;
}

/**
 * 远端快照传输通道契约。
 * 实现约定：同 id 重复 upload 视为覆盖（幂等友好）；download 对不存在的 id 必须抛错。
 */
export interface SyncTransport {
  readonly type: string;
  /** 列出远端已有快照（按 createdAt 升序） */
  list(): Promise<SyncSnapshotMeta[]>;
  /** 上传快照，返回其元信息（含各分区 hash） */
  upload(snapshot: SyncSnapshot): Promise<SyncSnapshotMeta>;
  /** 下载快照完整载荷 */
  download(id: string): Promise<SyncSnapshot>;
  /** 删除远端快照（不存在视为成功） */
  delete(id: string): Promise<void>;
}

/** 由快照计算元信息：sections hash 记录 + manifest 摘要透传 */
export function computeSnapshotMeta(snapshot: SyncSnapshot): SyncSnapshotMeta {
  const sections: SyncSnapshotMeta['sections'] = {};
  for (const [id, data] of Object.entries(snapshot.sections)) {
    sections[id as SectionId] = hashSection(data as SectionData);
  }
  return { id: snapshot.id, createdAt: snapshot.createdAt, sections, manifest: snapshot.manifest };
}

/** 从导出 Manifest 提取摘要 */
export function manifestSummaryFrom(manifest: Manifest): ManifestSummary {
  return {
    schemaVersion: manifest.schemaVersion,
    dshVersion: manifest.source.dshVersion,
    platform: manifest.source.platform,
    sectionIds: Object.entries(manifest.sections)
      .filter(([, included]) => included)
      .map(([id]) => id) as SectionId[],
    containsSecrets: manifest.security.containsSecrets,
  };
}
