/**
 * 客户端渲染层语言运行时（「英文界面零中文」主根因）的跨层单测。
 *
 * 契约：docs/design/2026-10-08-i18n-en-hardcoding.md §4.2 / §4.4（冻结路径归 t3 / impl-ui）。
 * 根因：`src/client/index.ts` 的 uiT 曾是 `makeUiT(ctx.locale.getLocale().active === 'en' ? 'en' : 'zh')`
 * —— **加载期快照**，用户切到 English 后本插件文案恒为中文。修复 = 活翻译器 `makeLiveUiT(read)`。
 *
 * 说明：文档 §4.4 的 T4/T5 断言的是**宿主半**（`createLiveMsg` + `LANGUAGE_TTL_MS`），
 * 属引擎作用域（src/core/**，不在本任务写作用域内），故本文件只钉客户端半；
 * 其中「同一实例切换语言立即生效」这条不变量由 T1/T5 在客户端半同样钉死。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import {
  liveUiT,
  makeLiveUiT,
  makeUiT,
  setUiLanguageSource,
  uiEn,
  uiZh,
  zhUiT,
  type UiTextKey,
} from '../src/ui/i18n.ts';

/** 一组覆盖不同分组的键（值 zh/en 都不同，能区分两种语言）。 */
const SAMPLE_KEYS: readonly UiTextKey[] = [
  'commonClose',
  'error.fallback',
  'export.included',
  'report.backupCreated',
  'sync.pushFailed',
];

/** 还原模块级语言来源（`liveUiT` 是进程内单例，避免污染同文件其它用例）。 */
function restoreSource(): void {
  setUiLanguageSource(() => 'zh');
}

test('T1 同一实例跟随语言：zh → en → zh（非 zh 一律回落 en）', () => {
  let active = 'zh';
  const t = makeLiveUiT(() => active);
  // 同一个函数引用，三次调用读三次 read()
  assert.equal(t('commonClose'), uiZh['commonClose'], 'zh 时输出中文');
  assert.notEqual(uiZh['commonClose'], uiEn['commonClose'], '样本键的 zh/en 必须不同，否则本用例无意义');
  active = 'en';
  assert.equal(t('commonClose'), uiEn['commonClose'], '同一个 t 引用在切到 en 后必须输出英文（根因钉死）');
  active = 'zh';
  assert.equal(t('commonClose'), uiZh['commonClose'], '再切回 zh 立即回到中文');
  active = 'ja';
  assert.equal(t('commonClose'), uiEn['commonClose'], "非 'zh' 的语言一律回落 en（英文界面不得回落中文）");
});

test('T2 zh 缺省逐字不变：makeLiveUiT(() => "zh") 与 zhUiT 输出完全一致', () => {
  const live = makeLiveUiT(() => 'zh');
  for (const key of SAMPLE_KEYS) {
    assert.equal(live(key), zhUiT(key), 'key=' + key + ' 必须与 zhUiT 逐字相等');
  }
  // 插值路径同样逐字相等
  assert.equal(
    live('error.requestTimeout', { seconds: '30' }),
    zhUiT('error.requestTimeout', { seconds: '30' }),
  );
});

test('T3 回落链与 makeUiT 一致：en 缺键 → zh → 键名；缺参原样保留', () => {
  const en = makeLiveUiT(() => 'en');
  assert.equal(en('commonClose'), uiEn['commonClose']);
  // 不存在的键 → 键名原样（makeUiT('en') 的既有语义）
  assert.equal(en('definitely.not.a.key' as UiTextKey), 'definitely.not.a.key');
  // 缺参原样保留（与 makeUiT 的 interpolate 同口径）
  assert.equal(en('error.requestTimeout', {}), uiEn['error.requestTimeout'].replace('{seconds}', '{seconds}'));
  assert.match(en('error.requestTimeout', {}), /\{seconds\}/);
  assert.match(zhUiT('error.requestTimeout', {}), /\{seconds\}/);
  assert.equal(
    en('error.exportTimeout', { minutes: '1' }),
    uiEn['error.exportTimeout'].replace('{minutes}', '1'),
  );
});

test('T5 模块级活翻译器：setUiLanguageSource 接线后 liveUiT 立即跟随（无快照/无缓存）', () => {
  try {
    let active = 'zh';
    setUiLanguageSource(() => active);
    assert.equal(liveUiT('commonClose'), uiZh['commonClose'], '未切语言时 = zh（与改造前行为一致）');
    active = 'en';
    assert.equal(liveUiT('commonClose'), uiEn['commonClose'], '换源后**同一个 liveUiT 引用**立即输出英文');
    active = 'zh';
    assert.equal(liveUiT('commonClose'), uiZh['commonClose'], '切回中文立即生效');
  } finally {
    restoreSource();
  }
});

test('T6 根因静态钉死：src/client/index.ts 不得再用 makeUiT(（必须 makeLiveUiT）', async () => {
  const url = new URL('../src/client/index.ts', import.meta.url);
  // 仓库根 .gitattributes 钉 eol=lf，但工作区可能是 CRLF 检出 —— 按既有先例折 LF 后再断言
  const src = fs.readFileSync(url, 'utf8').replace(/\r\n/g, '\n');
  assert.ok(
    !src.includes('makeUiT('),
    'src/client/index.ts 出现 makeUiT( —— 加载期语言快照会让「切到英文」后本插件文案恒为中文',
  );
  assert.ok(src.includes('makeLiveUiT('), 'src/client/index.ts 必须用 makeLiveUiT 构造 uiT');
  assert.ok(src.includes('setUiLanguageSource('), '模块级单例的语言来源也必须接线');
});

test('T6b 未接线时 liveUiT 等价 zhUiT（离线/测试路径行为不变）', () => {
  restoreSource();
  for (const key of SAMPLE_KEYS) assert.equal(liveUiT(key), zhUiT(key));
  // makeUiT 仍是合法的「固定语言」构造器（测试与离线路径在用）
  assert.equal(makeUiT('en')('commonClose'), uiEn['commonClose']);
});
