/**
 * 随加密快照迁移的凭据计划补录（从 SyncEngine 拆出以遵守体量棘轮，行为逐字不变）。
 */
import path from 'node:path';

import type { MsgFunc } from '../core/messages.ts';
import type { HostContext, ImportPlan, PlanItem } from '../core/types.ts';
import { credentialsMapFromYaml } from './snapshot-crypto.ts';

async function readLocalCredentials(ctx: Pick<HostContext, 'homeDir' | 'fs'>): Promise<Map<string, string> | undefined> {
  try {
    const file = path.join(ctx.homeDir, '.credentials.yaml');
    const raw = Buffer.from(await ctx.fs.readFile(file)).toString('utf8');
    return credentialsMapFromYaml(raw);
  } catch {
    return undefined;
  }
}

export async function appendCredentialPlanItems(input: {
  ctx: Pick<HostContext, 'homeDir' | 'fs'>;
  msg: MsgFunc;
  plan: ImportPlan;
  credentials: Map<string, string> | undefined;
}): Promise<void> {
  const { ctx, msg, plan, credentials } = input;
  if (credentials === undefined || credentials.size === 0) return;
  const local = await readLocalCredentials(ctx);
  const byId = new Map(plan.items.map((i) => [i.id, i] as const));
  for (const [ref, value] of credentials) {
    const id = `secret:${ref}`;
    const prev = byId.get(id);
    if (local?.get(ref) === value) {
      const description = msg('sync.credentialsItemSame', { ref });
      if (prev === undefined) {
        const same: PlanItem = {
          id, kind: 'Skip', adapter: 'credentialsStatus', description,
          severity: 'info', target: { adapter: 'credentialsStatus', ref },
        };
        plan.items.push(same);
        byId.set(id, same);
      } else if (prev.kind === 'Skip' || prev.kind === 'MissingSecret') {
        prev.kind = 'Skip';
        prev.severity = 'info';
        prev.description = description;
      }
      continue;
    }
    if (prev !== undefined) {
      if (prev.kind !== 'Skip') continue;
      prev.kind = 'MissingSecret';
      prev.severity = 'warning';
      prev.description = msg('sync.credentialsItemDesc', { ref });
      continue;
    }
    const item: PlanItem = {
      id,
      kind: 'MissingSecret',
      adapter: 'credentialsStatus',
      description: msg('sync.credentialsItemDesc', { ref }),
      severity: 'warning',
      target: { adapter: 'credentialsStatus', ref },
    };
    plan.items.push(item);
    byId.set(id, item);
  }
  plan.missingSecrets = plan.items
    .filter((i) => i.kind === 'MissingSecret')
    .map((i) => ({ ref: i.id.replace(/^secret:/, ''), required: true }));
}
