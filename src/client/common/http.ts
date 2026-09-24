/**
 * 客户端 HTTP 请求封装 —— **唯一实现**（W4「客户端请求封装统一」收敛点）。
 *
 * 背景（代码审计 client-state#F-06，已复核）：本仓库曾有 **7 份 `readJson` + 5 份 `postJson`**
 * 复制粘贴且已分叉（只有 lifecycle 版认 `{message}`），只有 `api.ts` 的 `export()` 带
 * AbortController —— 宿主卡死时 `/progress` 轮询链永不收敛（`run-store.pollRun` 只能靠
 * promise 拒绝才走 `applyGone`）。
 *
 * 本模块是**唯一**实现（7 个 api 文件全部改为引用，不再各自定义）：
 *  - `readJson`：非 2xx 统一错误映射（`{message}` → `{error}` → 404「未挂载」→ `HTTP <status>`）。
 *    采用 lifecycle 的兼容口径作为唯一口径（严格超集：旧口径只认 `{error}`，新口径多认一个
 *    `{message}`，对既有宿主/既有断言行为不变）。错误类型仍是 `ConfigManagerApiError`，
 *    最终由 `src/ui/errors.ts` 的 `toActionableError` 统一转成可操作错误（Reason / 建议动作）。
 *  - `getJson` / `postJson` / `requestJson`：**每个请求都有超时（AbortController）与取消能力**
 *    （调用方可用 `opts.signal` 取消）。超时统一映射为 `ConfigManagerApiError`：请求族有专属文案的
 *    用 `timeoutKey` 指定（export / sync / recovery / lifecycle，按 {minutes} 插值）；**其余一律走默认键
 *    `DEFAULT_TIMEOUT_KEY = error.requestTimeout`**（`src/ui/i18n.ts`，语境中立、按 {seconds} 插值：
 *    「请求超时（N 秒）：未在时限内收到宿主响应，请重试」）。
 *
 *    为什么默认键必须是**语境中立**的：请求族文案全是语境专属措辞（「同步请求超时…请检查网络与仓库
 *    可达性」/「恢复请求超时…恢复过程未完成」），套到普通本机读写会给出**错误诊断**（把「宿主卡死」说成
 *    网络或恢复问题）；而 `error.fallback`（「操作失败」）不说是超时、也没有可操作信息。两者都不适合做
 *    默认：前者误导诊断，后者丢掉「这是一次超时」这一事实。t12 补的 `error.requestTimeout` 正好补上这个
 *    缺口——**可用于任何请求**（不暗示导出/同步/恢复语境），并点明「超时 + 未收到响应 + 请重试」。
 *    `error.fallback` 仍是合法键（`src/ui/errors.ts` 的错误标题另有去路），只是不再是本模块的默认。
 *  - `openStream`：下载 / 附件类**流式**响应的句柄：headers 阶段有超时，正文阶段为**空闲超时**
 *    （`keepAlive()` 每收到一块数据重置），用户交互阶段可 `pause()` / `resume()`；
 *    正文阶段的中止用 `mapTimeout(err)` 映射为统一超时错误。
 *
 * 超时档位（与宿主 `src/index.ts` 的 ROUTE_TIMEOUT_MS = 5 分钟对齐）：
 *  - `REQUEST_TIMEOUT_MS`（30s）：纯元数据读写（status / 列表 / 偏好 / profile 记录）。
 *  - `LONG_REQUEST_TIMEOUT_MS`（5min）：可能跑分钟级的操作（导出/导入/恢复/同步/市场/备份）。
 *  - `progress` 用 30s：宁可晚收敛也不误判 —— `pollRun` 的拒绝分支会走 `applyGone`
 *    （把 run 判为「已结束/不可恢复」并停止轮询），误报代价高于晚 30 秒收敛。
 *
 * 边界：本文件**禁止 import 任何 node 模块**（client bundle 自包含护栏，见
 * `src/client/bundle-selfcontained.test.ts`），只依赖 `src/ui/i18n.ts` 的类型。
 */
import type { UiT } from '../../ui/i18n.ts';

/** 普通请求超时（ms）：纯元数据读写。 */
export const REQUEST_TIMEOUT_MS = 30_000;

/** 长操作请求超时（ms）：与宿主 ROUTE_TIMEOUT_MS（5 分钟）对齐。 */
export const LONG_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

/** 流式正文的空闲超时（ms）：连续无数据超过该时长即中止（下载/附件导出）。 */
export const STREAM_IDLE_TIMEOUT_MS = 60_000;

/** 超时文案键（全部已存在于 ui/i18n.ts；本模块只做选键，不新增文案口径）。 */
export type TimeoutMessageKey =
  | 'error.requestTimeout'
  | 'error.fallback'
  | 'error.exportTimeout'
  | 'error.syncTimeout'
  | 'error.recoveryTimeout'
  | 'error.lifecycleTimeout';

/** 默认超时文案键：**语境中立**的通用超时（可用于任何请求，不暗示导出/同步/恢复语境）。 */
export const DEFAULT_TIMEOUT_KEY = 'error.requestTimeout' satisfies TimeoutMessageKey;


/** 请求选项：超时档位、超时文案键、调用方取消信号。 */
export interface RequestOptions {
  /** 覆盖默认超时（缺省 REQUEST_TIMEOUT_MS）。 */
  timeoutMs?: number;
  /** 超时文案键（缺省 `DEFAULT_TIMEOUT_KEY` = error.requestTimeout：语境中立的通用超时）。 */
  timeoutKey?: TimeoutMessageKey;
  /** 调用方取消信号（与内部超时合并；取消时原样抛出 AbortError）。 */
  signal?: AbortSignal;
}

/**
 * 超时文案（统一注入 {minutes}/{seconds} 两个参数；各键的模板只取自己需要的那个 ——
 * 四个请求族键用 {minutes}，默认的 `error.requestTimeout` 用 {seconds}（30s 档位读作「30 秒」更准），
 * `error.fallback` 不带占位符）。
 */
export function timeoutMessage(t: UiT, timeoutMs: number, key: TimeoutMessageKey = DEFAULT_TIMEOUT_KEY): string {
  return t(key, {
    minutes: String(Math.max(1, Math.round(timeoutMs / 60_000))),
    seconds: String(Math.max(1, Math.round(timeoutMs / 1_000))),
  });
}

/** 携带路由 JSON error 消息的错误类型（客户端所有请求错误的唯一类型）。 */
export class ConfigManagerApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigManagerApiError';
  }
}

/**
 * 解析 JSON 响应；非 2xx 时抛出带路由 error 消息的 ConfigManagerApiError。
 *
 * 错误口径（唯一实现，7 个 api 文件共用）：
 *  1. 响应体不是 JSON：404 → 「插件未挂载」；其余 → `error.httpInvalidJson`；
 *  2. 非 2xx：`{message}` → `{error}` → 404「未挂载」→ `HTTP <status>`。
 */
export async function readJson<T>(response: Response, t: UiT): Promise<T> {
  const notMountedMessage = t('error.notMounted');
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (response.status === 404) throw new ConfigManagerApiError(notMountedMessage);
    throw new ConfigManagerApiError(t('error.httpInvalidJson', { status: String(response.status) }));
  }
  if (!response.ok) {
    const record = typeof body === 'object' && body !== null ? (body as { message?: unknown; error?: unknown }) : null;
    const message =
      typeof record?.message === 'string'
        ? record.message
        : typeof record?.error === 'string'
          ? record.error
          : response.status === 404
            ? notMountedMessage
            : `HTTP ${response.status}`;
    throw new ConfigManagerApiError(message);
  }
  return body as T;
}

/** 把调用方信号绑到内部 controller（返回解绑函数）。 */
function bindSignal(outer: AbortSignal | undefined, controller: AbortController): () => void {
  if (outer === undefined) return () => {};
  if (outer.aborted) {
    controller.abort();
    return () => {};
  }
  const onAbort = (): void => { controller.abort(); };
  outer.addEventListener('abort', onAbort, { once: true });
  return () => { outer.removeEventListener('abort', onAbort); };
}

/** 带超时 + 可取消的 JSON 请求（本模块唯一底层实现）。 */
async function runJson<T>(path: string, init: RequestInit, t: UiT, opts?: RequestOptions): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const key = opts?.timeoutKey ?? DEFAULT_TIMEOUT_KEY;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const detach = bindSignal(opts?.signal, controller);
  try {
    const response = await fetch(path, { ...init, signal: controller.signal });
    return await readJson<T>(response, t);
  } catch (err) {
    if (timedOut) throw new ConfigManagerApiError(timeoutMessage(t, timeoutMs, key));
    throw err;
  } finally {
    clearTimeout(timer);
    detach();
  }
}

/**
 * 任意 JSON 请求（自定义 init）：`init` 不设 method 时保持既有 GET 语义
 * （fetch 默认 GET；客户端既有断言要求 GET 不显式设 method）。
 */
export function requestJson<T>(path: string, init: RequestInit, t: UiT, opts?: RequestOptions): Promise<T> {
  return runJson<T>(path, init, t, opts);
}

/** GET（不设 method）+ JSON 解析。 */
export function getJson<T>(path: string, t: UiT, opts?: RequestOptions): Promise<T> {
  return runJson<T>(path, {}, t, opts);
}

/** POST JSON 请求体 + JSON 解析。 */
export function postJson<T>(path: string, body: unknown, t: UiT, opts?: RequestOptions): Promise<T> {
  return runJson<T>(
    path,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    t,
    opts,
  );
}

/** 流式响应句柄（下载 / 附件导出；headers 阶段超时 + 正文阶段空闲超时）。 */
export interface StreamHandle {
  /** 原始响应（调用方自行读取正文）。 */
  readonly response: Response;
  /** 是否因超时被中止（正文阶段的中止用它配合 mapTimeout 映射为统一超时错误）。 */
  readonly timedOut: boolean;
  /** 收到一块数据后调用：重置空闲超时。 */
  keepAlive(): void;
  /** 暂停计时（用户交互阶段，如系统保存对话框）。 */
  pause(): void;
  /** 恢复计时（交互结束后）。 */
  resume(): void;
  /** 把超时中止映射为统一超时错误；其它错误原样返回（调用方 `throw stream.mapTimeout(err)`）。 */
  mapTimeout(err: unknown): unknown;
  /** 结束：清计时器并解绑调用方信号（恒在 finally 调用）。 */
  close(): void;
}

/**
 * 打开流式响应（GET）：
 *  - headers 阶段：`timeoutMs`（缺省 REQUEST_TIMEOUT_MS）内未拿到响应即中止并抛统一超时错误；
 *  - 正文阶段：空闲超时（`idleTimeoutMs`，缺省 STREAM_IDLE_TIMEOUT_MS），由 `keepAlive()` 重置。
 */
export async function openStream(path: string, t: UiT, opts?: RequestOptions & { idleTimeoutMs?: number }): Promise<StreamHandle> {
  const timeoutMs = opts?.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const idleMs = opts?.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;
  const key = opts?.timeoutKey ?? DEFAULT_TIMEOUT_KEY;
  const controller = new AbortController();
  const detach = bindSignal(opts?.signal, controller);
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const arm = (ms: number): void => {
    clear();
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, ms);
  };
  arm(timeoutMs);
  try {
    const response = await fetch(path, { signal: controller.signal });
    return {
      response,
      get timedOut(): boolean { return timedOut; },
      keepAlive(): void { arm(idleMs); },
      pause(): void { clear(); },
      resume(): void { arm(idleMs); },
      mapTimeout(err: unknown): unknown {
        return timedOut ? new ConfigManagerApiError(timeoutMessage(t, idleMs, key)) : err;
      },
      close(): void { clear(); detach(); },
    };
  } catch (err) {
    clear();
    detach();
    if (timedOut) throw new ConfigManagerApiError(timeoutMessage(t, timeoutMs, key));
    throw err;
  }
}
