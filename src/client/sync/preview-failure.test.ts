/**
 * issue #116：宿主 ok:false + reason='remote-empty' 必须渲染成**引导**（info），不是红色「同步失败」。
 *
 * 真机背景：新建私有仓库、填好 PAT 点「一键同步」，插件只弹一句「一键同步失败：远端无快照」——
 * 用户看到的是故障（以为凭据/通道坏了），实际是「首次同步还没推送」。
 * 规则拆成两态，两态都必须取自字典（中英各断言一次，英文界面零中文）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { TranslateNS } from '../client-types.ts';
import { en as syncEn, zh as syncZh } from './sync-locales.ts';
import { describePreviewFailure } from './preview-failure.ts';

/** 字典对象 → TranslateNS（与 history-model.test.ts 同口径；缺键回退键本身）。 */
function mkSyncT(dict: Record<string, string>): TranslateNS<'config-manager-sync'> {
  return ((key: string, params?: Record<string, unknown>): string => {
    const raw = dict[key] ?? key;
    return params === undefined
      ? raw
      : raw.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
  }) as unknown as TranslateNS<'config-manager-sync'>;
}

const zhT = mkSyncT(syncZh);
const enT = mkSyncT(syncEn);

test('remote-empty → info 引导（不是故障），文案取自字典且不含「失败」', () => {
  const view = describePreviewFailure({ reason: 'remote-empty', message: '远端无快照' }, zhT);
  assert.equal(view.level, 'info');
  assert.equal(view.text, syncZh['syncflow.remoteEmptyGuide']);
  assert.equal(view.text.includes('失败'), false, '引导文案不得出现「失败」');
  assert.ok(view.text.includes('推送'), '必须告诉用户下一步动作是推送');
});

test('remote-empty：英文界面零中文', () => {
  const view = describePreviewFailure({ reason: 'remote-empty' }, enT);
  assert.equal(view.text, syncEn['syncflow.remoteEmptyGuide']);
  assert.equal(/[\u4e00-\u9fa5]/.test(view.text), false);
});

test('其它失败 → error，保留宿主文案与既有前缀', () => {
  const view = describePreviewFailure({ message: '远端不可达' }, zhT);
  assert.equal(view.level, 'error');
  assert.equal(view.text, syncZh['toast.syncStartFailed'] + syncZh['common.labelSeparator'] + '远端不可达');
});

test('宿主没给 message → 回退 syncflow.syncFailed', () => {
  const view = describePreviewFailure({}, zhT);
  assert.equal(view.level, 'error');
  assert.equal(view.text, syncZh['toast.syncStartFailed'] + syncZh['common.labelSeparator'] + syncZh['syncflow.syncFailed']);
});

test('失败文案里的凭据仍被脱敏（token 绝不进通知）', () => {
  const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const view = describePreviewFailure({ message: 'remote rejected token ' + token }, zhT);
  assert.equal(view.text.includes(token), false);
});
