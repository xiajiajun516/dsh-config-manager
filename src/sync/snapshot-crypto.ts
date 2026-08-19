/**
 * m-sync-crypto：同步快照 sections 载荷加密/解密。
 *
 * 复用 security/encryption.ts 的底层原语（scrypt KDF + AES-256-GCM，salt/iv 全随机）：
 * - 加密：把整个明文 sections Record 序列化 → encryptCredentials（带 DSC1 头）→ base64；
 * - 解密：decryptCredentials（GCM authTag 校验，密码错误抛 BAD_PASSWORD）→ 解析回 Record。
 *
 * 安全语义：
 * - 密码绝不落盘/落日志/进 manifest（manifest 只存盐/iv/authTag 等非秘密参数）；
 * - 加密快照的 sections 为密文载荷（EncryptedSections），远端存储看不到任何明文；
 * - includeSecrets 的凭据值只允许存在于加密快照中（由 SyncEngine.push 强制联动）。
 */
import { decryptCredentials, encryptCredentials } from '../security/encryption.ts';
import type { EncryptionInfo, SectionData, SectionId } from '../schema/types.ts';
import { parseJsonSafe, stringifyJsonSafe } from '../utils/json.ts';
import { sectionsFromJsonSafe, sectionsToJsonSafe } from './snapshot-json.ts';
import type { EncryptedSections } from './transport.ts';

/**
 * 加密整个明文 sections Record → 密文载荷（info 进 manifest 非秘密参数；data 为 base64 密文）。
 * 序列化经 snapshot-json：文件类分区字节以 base64 进入载荷，解密后还原 Uint8Array
 * （JSON 无法直传 TypedArray，否则解密回来的文件分区被破坏成普通对象）。
 */
export async function encryptSectionsPayload(
  sections: Partial<Record<SectionId, SectionData>>,
  password: string,
): Promise<EncryptedSections> {
  if (password === '') throw new Error('加密密码不能为空');
  const { blob, info } = await encryptCredentials(stringifyJsonSafe(sectionsToJsonSafe(sections)), password);
  return { encrypted: { info, data: Buffer.from(blob).toString('base64') } };
}

/** 解密密文载荷 → 明文 sections Record（密码错误 / 密文被篡改 → SecurityError）。 */
export async function decryptSectionsPayload(
  payload: EncryptedSections['encrypted'],
  password: string,
): Promise<Partial<Record<SectionId, SectionData>>> {
  if (password === '') throw new Error('解密密码不能为空');
  const plain = await decryptCredentials(Buffer.from(payload.data, 'base64'), payload.info, password);
  const parsed = parseJsonSafe(plain);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('加密快照内容损坏：解密后不是有效的分区对象');
  }
  return sectionsFromJsonSafe(parsed) as Partial<Record<SectionId, SectionData>>;
}

/** 从加密载荷提取非秘密的加密参数（展示/诊断用；不含密码）。 */
export function encryptionInfoOf(payload: EncryptedSections['encrypted']): EncryptionInfo {
  return payload.info;
}
