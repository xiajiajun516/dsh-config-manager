/**
 * 时间戳格式化的唯一实现（host 与 client 共用，**零 import**）。
 *
 * 为什么单列一个模块：同一串 `YYYYMMDD-HHmmss` 曾在 5 处各写一遍（model-tools / backup-scheduler /
 * cli·actions / cli·import-source / cli·index），`YYYY-MM-DD` 2 处，展示用的
 * `YYYY-MM-DD HH:mm` 5 处（sync 历史、sync 状态、market、profiles、release notes）——
 * 改一处口径（比如补毫秒、改本地时区）就得记住改十处，漏一处就是两套时间显示。
 *
 * 约束：**不得 import node 模块**（`src/client/**` 直接消费本模块）。
 *
 * 分工：本模块只负责**格式**，不负责「非法输入怎么显示」——那是各处的产品口径
 * （历史表显示 `—`、profiles 显示空串、release notes 原样回显），由调用方决定；
 * 这里只提供 `parseDateInput` 这一个统一的「能不能解析」判定。
 */

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 日期戳 `YYYYMMDD-HHmmss`（**本地时区**，用于导出文件名：定宽、仅 ASCII、可排序）。 */
export function formatDateStamp(d: Date = new Date()): string {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`
    + `-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

/** 日期 `YYYY-MM-DD`（**本地时区**，用于导出文件名 / 只显示日期的场景）。 */
export function formatDateOnly(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 展示用本地时间 `YYYY-MM-DD HH:mm`（**本地时区**，精确到分钟）。 */
export function formatMinuteStamp(d: Date): string {
  return `${formatDateOnly(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 解析时间输入（ISO 字符串或毫秒数）→ Date；不可解析给 null。
 *
 * 与 `new Date(x)` 的差别只有三条**判定**，解析规则本身完全继承：
 *  1. `null` / `undefined` / 空串 / 纯空白 → null（否则 `new Date('')` 给 Invalid Date，
 *     更糟的是 `new Date(null)` 会静默变成 1970-01-01）；
 *  2. `number`：`NaN` / `Infinity` / `-Infinity` → null；
 *  3. 解析结果 `getTime()` 非有限 → null。
 * 调用方拿 null 决定回退文案（`—` / 空串 / 原样回显），本模块不替它选。
 */
export function parseDateInput(input: string | number | null | undefined): Date | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    return new Date(input);
  }
  if (input.trim() === '') return null;
  const d = new Date(input);
  return Number.isFinite(d.getTime()) ? d : null;
}
