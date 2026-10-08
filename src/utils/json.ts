/**
 * JSON 深度保护：解析/序列化/克隆带嵌套深度上限（防 JSON 深度攻击，规范 §19.5）。
 * 解析分两段：JSON.parse 可能因引擎栈限制抛 RangeError（捕获并归一），
 * 再对结果做显式栈 walk 检查深度（避免 walk 自身递归爆栈）。
 */

import { utilsMsg } from './messages-utils.ts';

export const DEFAULT_MAX_JSON_DEPTH = 64;
export const DEFAULT_MAX_JSON_BYTES = 64 * 1024 * 1024;

/**
 * **本插件自产载荷**的体积上限（加密同步快照单文件，issue #59）。
 *
 * 为什么必须与不可信输入的上限分开：`DEFAULT_MAX_JSON_BYTES`（64 MiB）是防「外部喂进来的
 * 巨型 JSON」的闸门，而加密同步快照是**我们自己写出去的**——加密单文件布局把明文
 * sections 序列化 → base64 → 整体加密 → 再 base64，膨胀约 1.78 倍，勾选 sessions 分区
 * 后单文件轻松越过 64 MiB（真机 4 个快照均 ≈66 MiB）。
 *
 * 越界的后果不是报错而是**静默**：`list()` 里解析失败被吞掉 → 远端列表恒为空；
 * `download()` 报「快照损坏」→ 拉取彻底不可用；`hasNewRemoteSnapshot()` 恒 false →
 * 自动同步永远 `upToDate`。故读取侧必须显式抬到与写出能力相称的上限。
 */
export const MAX_OWN_PAYLOAD_JSON_BYTES = 512 * 1024 * 1024;

export class JsonDepthError extends Error {
  constructor(message = utilsMsg('utils.json.depthDefault', { max: DEFAULT_MAX_JSON_DEPTH })) {
    super(message);
    this.name = 'JsonDepthError';
  }
}

/** 测量对象/数组的嵌套深度（迭代式显式栈，不会递归爆栈；二进制视为叶子） */
export function measureDepth(value: unknown): number {
  let max = 0;
  // 栈元素：[value, depth]
  const stack: [unknown, number][] = [[value, 1]];
  while (stack.length > 0) {
    const [current, depth] = stack.pop()!;
    if (depth > max) max = depth;
    if (current !== null && typeof current === 'object' && !(current instanceof Uint8Array)) {
      const next = depth + 1;
      if (Array.isArray(current)) {
        for (const item of current) stack.push([item, next]);
      } else {
        for (const key of Object.keys(current as Record<string, unknown>)) {
          stack.push([(current as Record<string, unknown>)[key], next]);
        }
      }
    }
  }
  return max;
}

/** 深度保护解析：超限抛 JsonDepthError，非法 JSON 抛 SyntaxError */
export function parseJsonSafe(
  text: string,
  opts: { maxDepth?: number; maxBytes?: number } = {},
): unknown {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_JSON_DEPTH;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  if (text.length > maxBytes) {
    throw new JsonDepthError(utilsMsg('utils.json.bytesExceeded', { max: maxBytes }));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // 引擎栈限制导致的深层嵌套也会以 RangeError 出现 → 归一为 JsonDepthError
    if (err instanceof RangeError) throw new JsonDepthError(utilsMsg('utils.json.parseFailedDeep', { reason: String(err.message) }));
    throw err;
  }
  const depth = measureDepth(parsed);
  if (depth > maxDepth) {
    throw new JsonDepthError(utilsMsg('utils.json.depthExceeded', { depth, max: maxDepth }));
  }
  return parsed;
}

/** 深度保护序列化：先测深度再 stringify（默认不缩进） */
export function stringifyJsonSafe(value: unknown, opts: { maxDepth?: number; space?: number } = {}): string {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_JSON_DEPTH;
  const depth = measureDepth(value);
  if (depth > maxDepth) throw new JsonDepthError(utilsMsg('utils.json.depthExceeded', { depth, max: maxDepth }));
  return JSON.stringify(value, null, opts.space);
}

/** 深度保护深拷贝（迭代式，安全） */
export function deepClone<T>(value: T, maxDepth: number = DEFAULT_MAX_JSON_DEPTH): T {
  const depth = measureDepth(value);
  if (depth > maxDepth) throw new JsonDepthError();
  return JSON.parse(JSON.stringify(value)) as T;
}
