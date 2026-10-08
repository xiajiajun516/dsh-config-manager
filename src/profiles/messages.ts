/**
 * profiles 层的领域消息目录（zh 源 / en 镜像）—— 经 engineMsg 取「调用期」语言文案。
 *
 * 为什么是本域独立目录：src/profiles/** 的写作用域不含 src/core/messages.ts（既有键有冻结指纹），
 * 所以本域的键用 registerMessageCatalog 在**模块加载时**注册进引擎目录，查找顺序见
 * src/core/engine-locale.ts（基础目录 → 注册目录 → 键名）。
 *
 * 纪律（与 src/core/messages.ts 同口径）：
 *  - zh 值 = 迁移前的既有中文文案**逐字不变**（既有测试断言依赖）；
 *  - en 类型为 Record<keyof typeof zh, string> —— 缺键/多键即编译错误；
 *  - {param} 插值与缺参保留由 engineMsg 负责；
 *  - 只追加键，不改既有键。
 */
import { engineMsg, registerMessageCatalog } from '../core/engine-locale.ts'
import type { MsgParams } from '../core/msg-types.ts'

export const zh = {
  // ---------- 档案实例停止（dsh-profile-launcher.ts / dsh-profile-runtime.ts） ----------
  'profiles.stopFailed': 'stopFailed: pid {pid} 仍在运行',
} as const;

export const en: Record<keyof typeof zh, string> = {
  'profiles.stopFailed': 'stopFailed: pid {pid} is still running',
};

registerMessageCatalog({ id: 'profiles', zh, en })

/** 本域翻译器：key 受目录约束（拼错键 = 编译错误），语言按 engineMsg 的活语言解析。 */
export function profilesMsg(key: keyof typeof zh, params?: MsgParams): string {
  return engineMsg(key, params)
}
