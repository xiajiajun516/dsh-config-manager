/**
 * 导入流水线的跨端共享常量（**零依赖**：两端都可 import）。
 *
 * 为什么单独成文件：client 半的 `lib/client.js` 是单文件 cjs bundle，任何**运行时**
 * import 都会把整条依赖链打进去。`security/container-kind.ts` 读起来人畜无害，但它 import
 * 了同目录的 `encryption.ts`（node:crypto / node:util），于是扫描器会看到
 * `require("node:crypto")` —— DSH 的 client loader 直接报 "missed the module table"，
 * **整个插件不加载**（仓库既有铁律：`src/client/**` 不得运行时跨端 import 到 node 模块）。
 *
 * 因此把「常量」与「判定实现」分开：
 *  - 常量（错误码字面量）放这里，client 只 import 它 → 打包后是内联字符串，零 node 依赖；
 *  - 判定实现（读字节 / 读文件）留在 `security/container-kind.ts`（宿主侧使用）。
 * 同仓先例：`utils/guards.ts`（isRecord / isENOENT）、`profiles/dsh-profile-shared.ts`。
 */

/**
 * 加密容器的判别错误码（HTTP 响应 body.code）。
 *
 * 有码才能让调用方「据此插入解锁流程」，而不是只把一段文案显示给用户 ——
 * 与 mutation gate 的 `code: 'mutation-locked'`、会话格式处置的
 * `code: 'sessionFormatUnsupported'` 同一约定。客户端据它把「这是加密备份」从普通错误里
 * 分出来（旧宿主不回 containerType 时的降级路径，issue #55）。
 */
export const ENCRYPTED_CONTAINER_CODE = 'encrypted-container';

/**
 * 插件自更新（POST /update-apply）的失败码（**唯一声明处**：宿主 core/self-update.ts 与
 * 客户端关于页弹窗共用同一份字面量）。
 *
 * 为什么抽到这里：客户端要据码映射**本地化**文案（绝不直接渲染宿主返回的英文细节）；
 * 若两侧各写一份联合类型，「宿主加了码而界面回落成英文」不会红。全部落在本文件的
 * 常量 + 派生类型上，客户端只 import 类型（零运行时依赖）。
 */
export const SELF_UPDATE_FAILURE_CODES = [
  'invalid-version',
  'profile-unknown',
  'unsupported-profile',
  'non-registry-install',
  'not-newer',
  'install-failed',
] as const;
/** 自更新失败码（联合类型由上面的常量派生） */
export type SelfUpdateFailureCode = (typeof SELF_UPDATE_FAILURE_CODES)[number];

/**
 * 同步通道清单（**零依赖**：宿主与 client 半都可运行时 import）。
 *
 * 为什么放在这里（而不是 `src/sync/sync-config.ts`）：sync-config.ts import 了
 * node:fs / node:path，client 半**运行时** import 它会把 node 模块带进浏览器产物
 * （DSH loader 报 missed the module table，整个插件不加载）。通道清单是「纯常量」，
 * 与 ENCRYPTED_CONTAINER_CODE 同一处置：常量放这里，读写实现留在 sync-config.ts。
 *
 * 宿主侧 sync-config.ts **re-export** 它，仍是全仓唯一事实源（类型 SyncTransportType 由它派生）。
 *
 * 通道与「云端点具体兼容商」的关系：`s3` 是一条通道（配置里带 `provider` 区分
 * s3 / oss / cos / minio / kodo 五家），`gist` 是一条通道（provider 恒 gist）。
 */
export const SYNC_CHANNELS = ['git', 'webdav', 's3', 'gist'] as const;

/**
 * S3 兼容系通道清单（**唯一声明处**，t88；先例 = 上面的 SYNC_CHANNELS）。
 *
 * 为什么也放这里：宿主 `sync/sync-config.ts` 与客户端镜像（`ui/sync-settings-view.ts` 的 `S3_PROVIDERS`、
 * `client/sync/sync-view.ts` 的 provider 文案表）必须同值 —— 两侧各写一份字面量时，「宿主加了兼容商而界面少一个选项」
 * 这类静默漂移**不会红**（客户端只能靠 `satisfies` 穷尽检查拦「新增」，拦不住「改名 / 删除 / 顺序」）。
 * 放到零依赖模块后，两侧都 import 它；`sync-config.ts` 只 re-export（宿主沿用既有 import 路径）。
 *
 * 与通道清单的关系：`s3` 是**一条通道**（配置里用 `provider` 区分这五家），`gist` 是另一条通道（provider 恒 gist）。
 */
export const S3_COMPAT_PROVIDERS = ['s3', 'oss', 'cos', 'minio', 'kodo'] as const;
/** S3 兼容系通道类型 */
export type S3CompatProvider = (typeof S3_COMPAT_PROVIDERS)[number];
/** 非 S3 系的云端点通道（GitHub Gist，走 REST） */
export const GIST_PROVIDER = 'gist' as const;
/** Gist 通道类型 */
export type GistProvider = typeof GIST_PROVIDER;
/** 云端点通道枚举（S3 兼容系 ×5 + gist） */
export const CLOUD_SYNC_PROVIDERS = [...S3_COMPAT_PROVIDERS, GIST_PROVIDER] as const;
/** 云端点通道类型 */
export type CloudSyncProvider = (typeof CLOUD_SYNC_PROVIDERS)[number];

/**
 * 云端点密钥槽位引用（**唯一声明处**，t88）：`DSH_CONFIG_MANAGER_SYNC_<PROVIDER>_SECRET_ACCESS_KEY`（gist 为 `..._GIST_TOKEN`）。
 * 与既有 `syncPasswordRef` 同族。宿主 `cloudSecretRef()` 与客户端文案派生 `cloudSecretRefName()` 都读它，
 * 因此「宿主改了槽位名而界面提示的还是旧名」不可能再发生（两侧同源 + 结构守卫）。
 */
export const CLOUD_SECRET_REFS: Readonly<Record<CloudSyncProvider, string>> = {
  s3: 'DSH_CONFIG_MANAGER_SYNC_S3_SECRET_ACCESS_KEY',
  oss: 'DSH_CONFIG_MANAGER_SYNC_OSS_SECRET_ACCESS_KEY',
  cos: 'DSH_CONFIG_MANAGER_SYNC_COS_SECRET_ACCESS_KEY',
  minio: 'DSH_CONFIG_MANAGER_SYNC_MINIO_SECRET_ACCESS_KEY',
  kodo: 'DSH_CONFIG_MANAGER_SYNC_KODO_SECRET_ACCESS_KEY',
  gist: 'DSH_CONFIG_MANAGER_SYNC_GIST_TOKEN',
};

/**
 * 取某云端点通道的密钥槽位引用名（**不涉及任何值**；客户端只需显示这个名字）。
 *
 * 已知通道走表；**未知通道仍按同规则派生**（保持历史客户端行为，不因共享化而收紧 —— 手改过的配置里
 * 出现不在枚举内的 provider 时，界面仍要显示出它对应的槽位名）。
 */
export function cloudSecretRefName(provider: string): string {
  if (provider === GIST_PROVIDER) return CLOUD_SECRET_REFS[GIST_PROVIDER];
  if ((CLOUD_SYNC_PROVIDERS as readonly string[]).includes(provider)) return CLOUD_SECRET_REFS[provider as CloudSyncProvider];
  return 'DSH_CONFIG_MANAGER_SYNC_' + provider.toUpperCase() + '_SECRET_ACCESS_KEY';
}

/**
 * 自动同步策略三件套的跨端共享默认值（**唯一声明处**，E3）：
 * 宿主 `sync/autosync-config.ts` 与客户端 `sync-view.ts` / `AutosyncCard.tsx` 共用此处，
 * 避免两处手写副本悄悄漂移（例如宿主 default='ask' 而前端回落 'local'）。
 */
export type AutosyncAutoApplyTier = 'low' | 'medium';
export type AutosyncConflictPolicy = 'ask' | 'local';
export const DEFAULT_AUTOSYNC_REALTIME = true;
export const DEFAULT_AUTOSYNC_AUTO_APPLY_TIER: AutosyncAutoApplyTier = 'medium';
export const DEFAULT_AUTOSYNC_CONFLICT_POLICY: AutosyncConflictPolicy = 'ask';
