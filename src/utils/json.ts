/**
 * JSON 深度保护：解析/序列化/克隆带嵌套深度上限（防 JSON 深度攻击，规范 §19.5）。
 * 解析分两段：JSON.parse 可能因引擎栈限制抛 RangeError（捕获并归一），
 * 再对结果做显式栈 walk 检查深度（避免 walk 自身递归爆栈）。
 */

export const DEFAULT_MAX_JSON_DEPTH = 64;
export const DEFAULT_MAX_JSON_BYTES = 64 * 1024 * 1024;

export class JsonDepthError extends Error {
  constructor(message = `JSON 嵌套深度超过上限 ${DEFAULT_MAX_JSON_DEPTH}`) {
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
    throw new JsonDepthError(`JSON 体积超过上限 ${maxBytes} 字节`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // 引擎栈限制导致的深层嵌套也会以 RangeError 出现 → 归一为 JsonDepthError
    if (err instanceof RangeError) throw new JsonDepthError(`JSON 解析失败（可能是嵌套过深）: ${String(err.message)}`);
    throw err;
  }
  const depth = measureDepth(parsed);
  if (depth > maxDepth) {
    throw new JsonDepthError(`JSON 嵌套深度 ${depth} 超过上限 ${maxDepth}`);
  }
  return parsed;
}

/** 深度保护序列化：先测深度再 stringify（默认不缩进） */
export function stringifyJsonSafe(value: unknown, opts: { maxDepth?: number; space?: number } = {}): string {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_JSON_DEPTH;
  const depth = measureDepth(value);
  if (depth > maxDepth) throw new JsonDepthError(`JSON 嵌套深度 ${depth} 超过上限 ${maxDepth}`);
  return JSON.stringify(value, null, opts.space);
}

/** 深度保护深拷贝（迭代式，安全） */
export function deepClone<T>(value: T, maxDepth: number = DEFAULT_MAX_JSON_DEPTH): T {
  const depth = measureDepth(value);
  if (depth > maxDepth) throw new JsonDepthError();
  return JSON.parse(JSON.stringify(value)) as T;
}
