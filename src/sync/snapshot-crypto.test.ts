/**
 * snapshot-crypto 测试：同步快照 sections 载荷加密/解密往返、
 * 密码错误拒绝、密文不泄露明文、加密参数非秘密。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { decryptSectionsPayload, encryptSectionsPayload, encryptionInfoOf } from './snapshot-crypto.ts';
import { isEncryptedSections } from './transport.ts';
import type { SectionId, SectionData } from '../schema/types.ts';

const SAMPLE: Partial<Record<SectionId, SectionData>> = {
  settings: {
    version: 1,
    namespaces: {
      general: { value: { theme: 'dark', apiKey: 'sk-real-value' }, revision: 3, secrets: [] },
    },
  },
};

test('encryptSectionsPayload + decryptSectionsPayload：往返一致（凭据值可恢复）', async () => {
  const payload = await encryptSectionsPayload(SAMPLE, 'correct horse battery');
  assert.equal(isEncryptedSections(payload), true, '加密载荷可被 isEncryptedSections 识别');
  const decrypted = await decryptSectionsPayload(payload.encrypted, 'correct horse battery');
  assert.deepEqual(decrypted, SAMPLE, '解密后明文与原始一致');
});

test('加密载荷不含明文内容（密文落盘不可读）；加密参数为非秘密信息', async () => {
  const payload = await encryptSectionsPayload(SAMPLE, 'pw-12345678');
  const serialized = JSON.stringify(payload);
  assert.ok(!serialized.includes('sk-real-value'), '凭据值不得出现在密文载荷的 JSON 里');
  assert.ok(!serialized.includes('correct horse'), '明文内容不得出现');
  assert.ok(!serialized.includes('pw-12345678'), '密码不得出现在载荷里');
  const info = encryptionInfoOf(payload.encrypted);
  assert.equal(info.algorithm, 'aes-256-gcm');
  assert.equal(info.kdf, 'scrypt');
  assert.ok(info.salt !== '' && info.iv !== '' && info.authTag !== '', 'salt/iv/authTag 非空');
});

test('decryptSectionsPayload：密码错误 → 拒绝（GCM 认证失败）', async () => {
  const payload = await encryptSectionsPayload(SAMPLE, 'right-password-1');
  await assert.rejects(
    () => decryptSectionsPayload(payload.encrypted, 'wrong-password'),
    /密码|认证|BAD_PASSWORD/,
  );
});

test('decryptSectionsPayload：空密码 → 拒绝', async () => {
  const payload = await encryptSectionsPayload(SAMPLE, 'right-password-1');
  await assert.rejects(() => decryptSectionsPayload(payload.encrypted, ''), /密码/);
});

test('每次加密 salt/iv 随机：同内容两次加密载荷不同', async () => {
  const a = await encryptSectionsPayload(SAMPLE, 'same-password-1');
  const b = await encryptSectionsPayload(SAMPLE, 'same-password-1');
  assert.notEqual(a.encrypted.data, b.encrypted.data, '密文随机化（salt/iv 每次随机）');
});
