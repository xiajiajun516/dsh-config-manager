/**
 * 双语消息目录测试（core/messages.ts + ui/i18n.ts）：
 *  - en 镜像必须覆盖 zh 全部键（编译期已有 Record 类型约束，此处做运行期断言）；
 *  - {param} 插值行为（命中/缺参保留）；
 *  - 未知键回退 zh → 键名（绝不抛错）；
 *  - makeUiT 同款行为（客户端展示层目录）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { en, makeMsg, zh, zhMsg } from '../core/messages.ts';
import { uiEn, uiZh, makeUiT, zhUiT } from '../ui/i18n.ts';

test('messages: en 镜像覆盖 zh 全部键（无缺键/多键）', () => {
  const zhKeys = Object.keys(zh);
  const enKeys = Object.keys(en);
  assert.deepEqual(
    [...enKeys].sort(),
    [...zhKeys].sort(),
    'en 键集合必须与 zh 完全一致（编译期 Record<keyof typeof zh> 已强制，运行期再验一道）',
  );
});

test('messages: 插值替换 {param}，缺参原样保留', () => {
  const zhMsg1 = makeMsg('zh');
  assert.equal(zhMsg1('export.sectionFailed', { adapter: 'settings', reason: 'boom' }), '分区 settings 导出失败: boom');
  assert.equal(zhMsg1('export.sectionFailed', { adapter: 'settings' }), '分区 settings 导出失败: {reason}', '缺参保留占位符');
  const enMsg1 = makeMsg('en');
  assert.equal(enMsg1('export.sectionFailed', { adapter: 'settings', reason: 'boom' }), 'Section settings export failed: boom');
});

test('messages: zhMsg 缺省行为与改造前一致（中文）', () => {
  assert.equal(zhMsg('import.secretNotProvided'), '凭据未提供，需补录');
  assert.equal(zhMsg('rollback.cred.noReadback'), 'DSH 不回读凭据值，无法自动恢复');
  assert.equal(makeMsg(undefined)('restore.pluginRemoveFailed'), '卸载失败', '未指定语言 → zh');
});

test('messages: 未知键回退 zh → 键名，绝不抛错', () => {
  assert.equal(zhMsg('no.such.key'), 'no.such.key');
  assert.equal(makeMsg('en')('no.such.key'), 'no.such.key');
});

test('i18n(ui): en 镜像覆盖 zh 全部键', () => {
  assert.deepEqual([...Object.keys(uiEn)].sort(), [...Object.keys(uiZh)].sort());
});

test('i18n(ui): zhUiT 缺省 + makeUiT 双语插值', () => {
  assert.equal(zhUiT('error.notMounted'), 'config-manager 服务未挂载（插件未加载）：请确认 profile 中已安装 dsh-config-manager 并重启 DSH');
  const enT = makeUiT('en');
  assert.equal(enT('error.notMounted'), 'config-manager service is not mounted (plugin not loaded): make sure dsh-config-manager is installed in the profile and restart DSH');
  assert.equal(enT('report.credentialsNeedEntry', { count: '3' }), '3 credential(s) need to be entered');
  // 未知键回退 zh → 键名（类型层不允许字面量，这里用宽松断言验证运行期回退）
  const loose = makeUiT('en') as (key: string) => string;
  assert.equal(loose('no.such.key'), 'no.such.key');
});
