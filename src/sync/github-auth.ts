/**
 * m-github-oauth：GitHub OAuth device flow（设备码流程）认证模块。
 *
 * 插件场景选择 device flow 而非授权码+回调：无需注册回调 URL，天然适合本地 GUI
 * 插件 —— 用户点「使用 GitHub 登录」→ 宿主向 GitHub 请求设备码 → UI 展示一次性
 * 用户码 + 授权页 URL → 用户在浏览器确认 → 宿主轮询换取 access token → 存入
 * DSH credentials（SYNC_CREDENTIAL_REF，与手动 token 同一凭据槽位）→ git 通道
 * 的 getToken provider 从那里读取，token 永不进 argv / repoUrl / 日志 / 浏览器。
 *
 * 安全不变量：
 * - 本模块不接触任何秘密的持久化：startDeviceFlow 产出设备码（宿主侧内存登记），
 *   pollForToken 只返回 access token（由宿主立即写入 credentials，绝不回传 UI）；
 * - 错误消息只携带 GitHub 返回的 error/error_description，绝不内嵌 token 值；
 * - fetcher / now 可注入：测试全程 mock，不碰真实网络。
 *
 * 流程（GitHub 官方 device flow）：
 *   1. POST https://github.com/login/device/code  { client_id, scope }
 *      → { device_code, user_code, verification_uri, expires_in, interval }
 *   2. 用户访问 verification_uri 输入 user_code 授权
 *   3. POST https://github.com/login/oauth/access_token
 *      { client_id, device_code, grant_type=urn:ietf:params:oauth:grant-type:device_code
 *        [, client_secret] } → { access_token } 或 { error, error_description }
 *      error ∈ authorization_pending | slow_down | expired_token | access_denied | ...
 */
import { randomUUID } from 'node:crypto';

/** GitHub device flow 第一步：请求设备码 */
export const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
/** GitHub device flow 第三步：轮询换取 access token */
export const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
/** 缺省 scope：repo（读写私有仓库，同步通道需要） */
export const GITHUB_DEVICE_FLOW_SCOPE = 'repo';
/** GitHub 缺省轮询间隔（秒） */
export const GITHUB_DEFAULT_INTERVAL = 5;
/** slow_down 时按 RFC 8628 额外增加的等待秒数 */
export const SLOW_DOWN_EXTRA_SECONDS = 5;
/** 设备码过期秒数上限兜底（GitHub 默认 900s） */
const DEVICE_CODE_MAX_EXPIRES_IN = 3600;

export interface GitHubAuthOptions {
  /** 可注入 fetcher（测试 mock 用）；缺省 = global fetch */
  fetcher?: typeof fetch;
  /** 可注入时钟（epoch ms；测试过期清理用）；缺省 = Date.now */
  now?: () => number;
}

/** startDeviceFlow 产出：UI 展示用户码 + 授权页，宿主侧登记设备码 */
export interface DeviceFlowStartResult {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** 设备码过期秒数（GitHub 默认 900） */
  expiresIn: number;
  /** GitHub 建议的轮询间隔秒数（缺省 5） */
  interval: number;
}

/** 轮询结果状态：success 携带 token（宿主立即入库）；pending 继续等；其余为终止态 */
export type DeviceFlowPollStatus = 'pending' | 'success' | 'denied' | 'expired' | 'error';

export interface DeviceFlowPollResult {
  status: DeviceFlowPollStatus;
  /** status=success 时：access token（调用方负责立即写入 credentials，绝不落日志/回传 UI） */
  accessToken?: string;
  /** status=pending 时：下次轮询应等待的毫秒数（按 GitHub interval；slow_down 额外 +5s） */
  pollDelayMs?: number;
  /** status=error 时：GitHub 返回的 error code */
  errorCode?: string;
  /** 可展示的错误描述（来自 GitHub error_description，不含 token） */
  message?: string;
}

/** GitHub OAuth 可预期错误：code = GitHub error / 固定内部码，status = HTTP 状态（网络层无） */
export class GitHubAuthError extends Error {
  readonly code: string;
  readonly status: number | undefined;

  constructor(message: string, code: string, status?: number) {
    super(message);
    this.name = 'GitHubAuthError';
    this.code = code;
    this.status = status;
  }
}

/** exchangeDeviceCode 入参（client_secret 仅 confidential OAuth app 需要，缺省不发送） */
export interface ExchangeDeviceCodeParams {
  clientId: string;
  deviceCode: string;
  clientSecret?: string;
  /** 轮询间隔秒数（pollForToken 计算下次延迟用；缺省 5） */
  interval?: number;
}

/** 单次 token 交换结果：成功 = access token；失败 = GitHub error code + 描述 */
export type ExchangeDeviceCodeResult =
  | { ok: true; accessToken: string }
  | { ok: false; error: string; errorDescription?: string };

/** 解析 GitHub 表单/JSON 混合响应：优先 JSON（Accept: application/json 时 GitHub 返回 JSON） */
async function parseGitHubJson(response: Response, context: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (text.trim() === '') {
    throw new GitHubAuthError(`${context}: GitHub 返回空响应（HTTP ${response.status}）`, 'empty_response', response.status);
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new GitHubAuthError(
      `${context}: GitHub 返回了无法解析的响应（HTTP ${response.status}），请稍后重试`,
      'invalid_json',
      response.status,
    );
  }
}

/**
 * GitHub OAuth device flow 客户端。
 * 无状态（设备码登记由宿主侧的 DeviceFlowStore 负责），fetch 可注入。
 */
export class GitHubAuthClient {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;

  constructor(options: GitHubAuthOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * 第一步：请求设备码。产出一次性 user_code + 授权页 URL + device_code
   * （device_code 由宿主登记，只在本模块与宿主间流转，绝不发给浏览器）。
   */
  async startDeviceFlow(clientId: string, scope: string = GITHUB_DEVICE_FLOW_SCOPE): Promise<DeviceFlowStartResult> {
    if (typeof clientId !== 'string' || clientId === '') {
      throw new GitHubAuthError('client_id 必须是非空字符串', 'invalid_client_id');
    }
    const body = new URLSearchParams();
    body.set('client_id', clientId);
    body.set('scope', scope);

    let response: Response;
    try {
      response = await this.fetcher(GITHUB_DEVICE_CODE_URL, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (err) {
      throw new GitHubAuthError(
        `请求 GitHub 设备码失败：${err instanceof Error ? err.message : String(err)}`,
        'network_error',
      );
    }

    const parsed = await parseGitHubJson(response, '请求设备码');
    const ghError = parsed['error'];
    if (typeof ghError === 'string' && ghError !== '') {
      const desc = parsed['error_description'];
      throw new GitHubAuthError(
        `GitHub 拒绝了设备码请求：${typeof desc === 'string' && desc !== '' ? desc : ghError}`,
        ghError,
        response.status,
      );
    }
    const deviceCode = parsed['device_code'];
    const userCode = parsed['user_code'];
    const verificationUri = parsed['verification_uri'];
    if (typeof deviceCode !== 'string' || deviceCode === ''
      || typeof userCode !== 'string' || userCode === ''
      || typeof verificationUri !== 'string' || verificationUri === '') {
      throw new GitHubAuthError('GitHub 设备码响应缺少必要字段（device_code/user_code/verification_uri）', 'invalid_response', response.status);
    }
    const expiresIn = typeof parsed['expires_in'] === 'number' && Number.isFinite(parsed['expires_in'])
      ? Math.min(Math.max(Math.floor(parsed['expires_in']), 1), DEVICE_CODE_MAX_EXPIRES_IN)
      : 900;
    const interval = typeof parsed['interval'] === 'number' && Number.isFinite(parsed['interval'])
      ? Math.max(Math.floor(parsed['interval']), 1)
      : GITHUB_DEFAULT_INTERVAL;
    return { deviceCode, userCode, verificationUri, expiresIn, interval };
  }

  /**
   * 单次 token 交换（device flow 第三步的原子操作）。
   * 返回类型化结果：成功 = access token；失败 = GitHub error code（pending/slow_down
   * 等由 pollForToken 归并为轮询状态）。
   */
  async exchangeDeviceCode(params: ExchangeDeviceCodeParams): Promise<ExchangeDeviceCodeResult> {
    const body = new URLSearchParams();
    body.set('client_id', params.clientId);
    body.set('device_code', params.deviceCode);
    body.set('grant_type', 'urn:ietf:params:oauth:grant-type:device_code');
    if (params.clientSecret !== undefined && params.clientSecret !== '') {
      body.set('client_secret', params.clientSecret);
    }

    let response: Response;
    try {
      response = await this.fetcher(GITHUB_ACCESS_TOKEN_URL, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (err) {
      throw new GitHubAuthError(
        `交换 GitHub token 失败：${err instanceof Error ? err.message : String(err)}`,
        'network_error',
      );
    }

    const parsed = await parseGitHubJson(response, '交换 token');
    const accessToken = parsed['access_token'];
    if (typeof accessToken === 'string' && accessToken !== '') {
      return { ok: true, accessToken };
    }
    const ghError = parsed['error'];
    const desc = parsed['error_description'];
    return {
      ok: false,
      error: typeof ghError === 'string' && ghError !== '' ? ghError : 'unknown_error',
      errorDescription: typeof desc === 'string' && desc !== '' ? desc : undefined,
    };
  }

  /**
   * 轮询换取 access token，把 GitHub 错误码归并为 UI 可消费的轮询状态：
   * - authorization_pending → pending（按 interval 继续等）
   * - slow_down → pending（interval + 5s，RFC 8628）
   * - expired_token → expired（终止，重新开始）
   * - access_denied → denied（终止）
   * - 其他 error → error（终止，携带 errorCode + 描述）
   */
  async pollForToken(params: ExchangeDeviceCodeParams): Promise<DeviceFlowPollResult> {
    const result = await this.exchangeDeviceCode(params);
    if (result.ok) {
      return { status: 'success', accessToken: result.accessToken };
    }
    const intervalMs = Math.max(params.interval ?? GITHUB_DEFAULT_INTERVAL, 1) * 1000;
    switch (result.error) {
      case 'authorization_pending':
        return { status: 'pending', pollDelayMs: intervalMs };
      case 'slow_down':
        return { status: 'pending', pollDelayMs: intervalMs + SLOW_DOWN_EXTRA_SECONDS * 1000 };
      case 'expired_token':
        return { status: 'expired' };
      case 'access_denied':
        return { status: 'denied' };
      default:
        return { status: 'error', errorCode: result.error, message: result.errorDescription };
    }
  }
}

/* ---------------------------------------------------------------- 宿主侧设备码登记 */

/** DeviceFlowStore 登记的条目（device_code 只存宿主内存，绝不发往浏览器） */
export interface DeviceFlowEntry {
  deviceCode: string;
  clientId: string;
  clientSecret?: string;
  /** 轮询间隔秒数（来自 start 响应，pollForToken 计算下次延迟用） */
  interval: number;
  /** 过期时刻（epoch ms）：now > expiresAt 视为已过期，get 返回 undefined 并清理 */
  expiresAt: number;
}

/**
 * 宿主内存设备码登记表（进程生命周期，跨请求共享 —— 与 RunRegistry 同模式）。
 * device_code 的持有者是宿主：UI 只拿 flowId（随机 id），轮询时宿主凭 flowId 取回
 * device_code 去 GitHub 换 token。过期条目惰性清理，防止无限增长。
 */
export class DeviceFlowStore {
  private readonly flows = new Map<string, DeviceFlowEntry>();
  private readonly now: () => number;

  constructor(now?: () => number) {
    this.now = now ?? (() => Date.now());
  }

  get size(): number {
    return this.flows.size;
  }

  /** 登记一个设备码流；flowId 由调用方生成（随机，不可猜） */
  set(flowId: string, entry: DeviceFlowEntry): void {
    this.flows.set(flowId, entry);
  }

  /** 取回设备码流；过期条目视为不存在并立即清理 */
  get(flowId: string): DeviceFlowEntry | undefined {
    const entry = this.flows.get(flowId);
    if (entry === undefined) return undefined;
    if (this.now() > entry.expiresAt) {
      this.flows.delete(flowId);
      return undefined;
    }
    return entry;
  }

  /** 主动移除（取消/完成后清理） */
  delete(flowId: string): void {
    this.flows.delete(flowId);
  }

  /** 生成不可猜的 flowId（路由层用） */
  static newFlowId(): string {
    return randomUUID();
  }
}
