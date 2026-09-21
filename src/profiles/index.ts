/**
 * Profiles 模块公共出口：**DSH 自带 profile**（`$DSH_HOME/profiles/<name>`）管理。
 *
 * 历史说明：本模块此前是插件自有的「配置档案」（配置快照集 + 切换导入），
 * 已整体替换为 DSH profile 管理（用户决策 2026-09）。
 * 分层：`dsh-profile-shared.ts`（零依赖类型/常量/纯函数，双端可用）→
 * `dsh-profile-manager.ts`（node fs 引擎）→ `src/ui/dsh-profiles-view.ts`（视图模型）。
 */
export {
  DshProfileManager, DshProfileError,
  PROFILES_DIR, PROFILE_PATCH_FILENAME, NEXT_PROFILE_FILENAME,
  type DshProfileManagerOptions,
} from './dsh-profile-manager.ts';

export {
  DSH_PROFILE_TEMPLATES, RESERVED_PROFILE_NAMES,
  classifyShape, checkProfileName,
  type DshProfileMeta, type DshProfileDetail, type DshProfileSelection,
  type DshProfileTemplate, type DshProfileShape, type DshProfilePatchReload,
  type DshProfileIssue, type DshProfileErrorCode, type DshProfilesSnapshot,
} from './dsh-profile-shared.ts';
