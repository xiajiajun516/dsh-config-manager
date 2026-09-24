/**
 * JSON 分区 adapter 的共享骨架（t31，批次 4）。
 *
 * 为什么存在：改动前 9 个「有 JSON 载荷」的分区的 `validate()` 都以**同一段样板**开头 ——
 * 先是 object 守卫，再是 `data.version !== 1` 守卫，最后才是各分区自己的载荷形状检查；
 * 这段样板在每个文件里逐字抄了一遍（审计 sync#F-08 / infra#C1）。本模块把它收敛为一份，
 * 并让「期望版本」直接取自注册表 `dataVersion`（不再各写 `!== 1` 字面量）。
 *
 * 与注册表的分工：结构校验的**描述符**（zipPath / 载荷形态 / dataVersion）在
 * `src/schema/section-registry.ts`；本模块只提供「按该描述符执行校验」的通用算法，
 * 各 adapter 仍负责自己特有的形状检查（用 `shape` 回调注入）。
 *
 * 分层：只 import schema 与 core 的类型 —— 不 import node 内置模块（client bundle 自包含铁律）。
 */
import { sectionMeta } from '../schema/section-registry.ts';
import type { SectionId } from '../schema/types.ts';
import type { MsgFunc, zh } from '../core/messages.ts';
import type { ValidationResult } from '../core/types.ts';

/** 校验问题列表（各 adapter 的形状检查直接 push 到这里，与历史 `issues` 数组同一形状）。 */
export type SectionIssues = ValidationResult['issues'];

/**
 * JSON 分区通用结构校验骨架。
 *
 * 执行顺序（与改造前逐字一致，保证行为等价）：
 *  1. object 守卫：非对象 → **直接返回**单条 `objectMessageKey` 错误（缺省 `adapter.validate.object`；后续检查不再执行）；
 *  2. version 守卫：`version !== sectionMeta(sectionId).dataVersion` → push 一条 `version` 错误，
 *     **不提前返回**（继续做形状检查，与历史实现一致）；
 *  3. `shape` 回调：分区特有的载荷形状检查（可选）。
 *
 * @param sectionId 分区 id —— 同时是 object 错误的默认 subject 与 dataVersion 的查表键
 * @param data 反序列化后的分区载荷（来自不可信备份 → 必须按 unknown 处理）
 * @param msg 文案翻译器（adapter 的 `validate(data, msg = zhMsg)` 原样传入）
 * @param shape 分区特有的形状检查（在 version 守卫之后调用）
 * @param subject object 错误里的显示名；缺省 = sectionId。历史上 credentials 用的是
 *   `'credentials'`（而非分区 id `credentialsStatus`），此参数为保留该原文案而存在 ——
 *   改文案属独立的行为变更，不在本任务射程内。
 * @param objectMessageKey object 错误的**消息键**（t11 新增，可选）；缺省 `adapter.validate.object`
 *   （`'{subject} 数据必须是对象'`）。为什么需要它：文件类分区历史上用的是专用键
 *   `adapter.validate.fileSection`（`'文件分区数据必须是对象'`，**不含** `{subject}` 占位符），
 *   那是**键**级差异 —— `subject` 参数补不了它（把 subject 拼成"文件分区"后中文模板仍多一个空格），
 *   而硬换键会让 skills / agentPresets / agentInstructions / sessions / self 五个分区的用户可见
 *   报错文案一起变。有了这个可选键，那处也能并入骨架而文案逐字不变。
 *   键必须存在于 `src/core/messages.ts` 目录（`MsgFunc` 形参是 string，编译器只能校验到键名集合）。
 */
export function validateJsonSection<S extends { version?: unknown }>(
  sectionId: SectionId,
  data: unknown,
  msg: MsgFunc,
  shape?: (section: S, issues: SectionIssues) => void,
  subject: string = sectionId,
  objectMessageKey: keyof typeof zh = 'adapter.validate.object',
): ValidationResult {
  if (data === null || typeof data !== 'object') {
    return {
      valid: false,
      issues: [{ path: '$', message: msg(objectMessageKey, { subject }), severity: 'error' }],
    };
  }
  const section = data as S;
  const issues: SectionIssues = [];
  const expectedVersion: unknown = sectionMeta(sectionId).dataVersion;
  if (section.version !== expectedVersion) {
    issues.push({
      path: 'version',
      message: msg('adapter.validate.version', { value: String(section.version) }),
      severity: 'error',
    });
  }
  if (shape !== undefined) shape(section, issues);
  return { valid: issues.filter((i) => i.severity === 'error').length === 0, issues };
}
