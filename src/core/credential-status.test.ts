/**
 * isCredentialConfigured：导入/同步计划生成判定「目标机是否已有该凭据」的唯一入口。
 * 关键不变量：读不到（服务不可用 / ref 不合法）一律判为**未配置**（保守 —— 宁可多提示一次，
 * 也不能把该补录的凭据静默当成已就绪）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { isCredentialConfigured } from './credential-status.ts';
import type { HostContext } from './types.ts';

type Cred = { configured: boolean };

function ctx(behavior: { configured: boolean } | 'throw'): Pick<HostContext, 'credentials'> {
  return {
    credentials: {
      describe: async (_ref: string): Promise<Cred> => {
        if (behavior === 'throw') throw new Error('credentials service unavailable');
        return { configured: behavior.configured };
      },
      // 本模块只用 describe；set/unset 仅为满足 CredentialsFacade 形状（测试替身语义）
      set: async (): Promise<void> => {},
      unset: async (): Promise<void> => {},
    },
  };
}

test('isCredentialConfigured：已配置 → true；未配置 → false', async () => {
  assert.equal(await isCredentialConfigured(ctx({ configured: true }), 'DEEPSEEK_API_KEY'), true);
  assert.equal(await isCredentialConfigured(ctx({ configured: false }), 'DEEPSEEK_API_KEY'), false);
});

test('isCredentialConfigured：describe 抛错 → false（保守：仍按需要补录处理）', async () => {
  assert.equal(await isCredentialConfigured(ctx('throw'), 'DEEPSEEK_API_KEY'), false);
});
