/**
 * foreign 域（src/foreign/**）的追加消息目录（zh 源 / en 镜像），归 t6 作用域。
 *
 * 为什么不在 \`src/core/messages.ts\` 追加：该文件不在本作用域的 inScope 内，且既有 372 键有冻结指纹。
 * 本模块经 \`registerMessageCatalog\` 注册**追加目录**：engineMsg / makeMsg 的查找顺序是
 * 「既有目录 → en 下回退既有 zh → 注册目录 → 键名」，所以本域新键只在既有目录未命中时生效。
 *
 * 纪律：zh 值 = 改动前的既有中文文案**逐字原样**；en 为 \`Record<keyof typeof zh, string>\`（缺键即编译错）。
 * **导入本模块即完成注册**：本域消费面是 engineMsg（装配期抛错的文案），导入本模块即完成目录注册。
 * 注：\`src/foreign/truth-table.ts\` 的取证文本是数据（守卫 §3.5 白名单 61 命中），不在本目录范围。
 */
import { engineMsg as engineMsgOf, registerMessageCatalog } from '../core/engine-locale.ts';
import type { MsgFunc } from '../core/msg-types.ts';

export const zh = {
  // ---------- 外部来源注册表 ----------
  'foreign.truthTableMissingSource': '真值表缺少来源定义: {id}',
  'foreign.truthTableMissingSourceDetailed': '真值表缺少来源定义: {id}（truth-table.ts 是 evidence/probePaths 的单一事实源）',
  'foreign.availableSourcesEmpty': '(空)',
  'foreign.duplicateSourceId': '外部来源 id 重复注册: {id}；可用: {available}',
  'foreign.unknownSourceId': '未知外部来源 id: {id}；可用: {available}',
  'foreign.invalidSourceDefinition': '外部来源定义非法: {id}；可用: {available}',
  'foreign.sourceIdMissing': '(无 id)',
  // ---------- bundle 装配 ----------
  'foreign.bundleFileSectionPrefixMissing': '外部导入：文件类分区缺少 ZIP 前缀 {section}',
  'foreign.bundleJsonSectionPathMissing': '外部导入：JSON 类分区缺少 ZIP 路径 {section}',
} as const;

export const en: Record<keyof typeof zh, string> = {
  'foreign.truthTableMissingSource': 'The truth table has no definition for source {id}',
  'foreign.truthTableMissingSourceDetailed': 'The truth table has no definition for source {id} (truth-table.ts is the single source of truth for evidence/probePaths)',
  'foreign.availableSourcesEmpty': '(none)',
  'foreign.duplicateSourceId': 'Duplicate external source id: {id}; available: {available}',
  'foreign.unknownSourceId': 'Unknown external source id: {id}; available: {available}',
  'foreign.invalidSourceDefinition': 'Invalid external source definition: {id}; available: {available}',
  'foreign.sourceIdMissing': '(no id)',
  'foreign.bundleFileSectionPrefixMissing': 'External import: file section is missing its ZIP prefix {section}',
  'foreign.bundleJsonSectionPathMissing': 'External import: JSON section is missing its ZIP path {section}',
};

registerMessageCatalog({ id: 'foreign-domain', zh, en });

/** 本域活翻译器（与 core 的 engineMsg 同一实现；导入本模块即完成目录注册）。 */
export const engineMsg: MsgFunc = engineMsgOf;
