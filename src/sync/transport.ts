/**
 * m-sync-transport：SyncTransport 抽象层。
 * 纯类型 + 纯 helper，零副作用、零 fs —— 传输通道实现（git 等）由后续波次提供。
 * 与核心引擎同原则：只依赖 src/schema/types.ts 的纯类型，不 import 任何 DSH 运行时包。
 */
import type { EncryptionInfo, Manifest, SectionData, SectionId } from '../schema/types.ts';
import { hashSection } from './sync-state.ts';

/** manifest 摘要：快照列表展示 / 变更判断所需的轻量来源信息 */
export interface ManifestSummary {
  schemaVersion: number;
  dshVersion: string;
  platform: string;
  /** 快照包含的分区（按 manifest.sections 中为 true 的键） */
  sectionIds: SectionId[];
  containsSecrets: boolean;
  /** 快照是否加密（sections 为 EncryptedSections 密文载荷）；缺省 false（旧快照兼容） */
  encrypted?: boolean;
}

/** 快照元信息：list() 条目 / upload() 返回值 */
export interface SyncSnapshotMeta {
  id: string;
  createdAt: string; // ISO-8601 UTC
  /** 各分区内容 hash（sectionId → hashSection 结果），用于变更检测。
   *  加密快照的 sections 为密文载荷，不参与明文 hash 比较 → 空对象。 */
  sections: Partial<Record<SectionId, string>>;
  manifest: ManifestSummary;
}

/** 加密快照的 sections 载荷：整个明文 sections 对象序列化后整体加密（AES-256-GCM）。 */
export interface EncryptedSections {
  encrypted: {
    /** 加密参数（salt/iv/authTag base64；与 security/encryption.ts 的 EncryptionInfo 对齐） */
    info: EncryptionInfo;
    /** base64：带 DSC1 头的密文（明文 = 序列化的 sections Record） */
    data: string;
  };
}

/** 快照载荷：upload() 入参 / download() 返回 */
export interface SyncSnapshot {
  id: string;
  createdAt: string; // ISO-8601 UTC
  manifest: ManifestSummary;
  /** JSON 分区数据 + 文件类分区（FilesSection）；加密快照为 EncryptedSections 密文载荷 */
  sections: Partial<Record<SectionId, SectionData>> | EncryptedSections;
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

/** 由快照计算元信息：sections hash 记录 + manifest 摘要透传。
 *  加密快照（sections 为密文载荷）→ sections hash 记录为空（密文无法与本地明文比较）。 */
export function computeSnapshotMeta(snapshot: SyncSnapshot): SyncSnapshotMeta {
  const sections: SyncSnapshotMeta['sections'] = {};
  if (!isEncryptedSections(snapshot.sections)) {
    for (const [id, data] of Object.entries(snapshot.sections)) {
      sections[id as SectionId] = hashSection(data as SectionData);
    }
  }
  return { id: snapshot.id, createdAt: snapshot.createdAt, sections, manifest: snapshot.manifest };
}

/** 判定 sections 是否为加密密文载荷（duck-typing：含 encrypted.info + encrypted.data 字符串）。 */
export function isEncryptedSections(sections: unknown): sections is EncryptedSections {
  if (sections === null || typeof sections !== 'object') return false;
  const enc = (sections as { encrypted?: unknown }).encrypted;
  if (enc === null || typeof enc !== 'object') return false;
  const e = enc as { info?: unknown; data?: unknown };
  return typeof e.data === 'string' && e.data !== '' && e.info !== null && typeof e.info === 'object';
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
