/**
 * Profiles 模块公共出口（m8，Phase 6）。
 */
export {
  ProfileManager, APPLY_ORDER, isValidProfileName, encodeSections, decodeSections,
  type ProfileManagerOptions, type ProfileMeta, type StoredProfile,
  type SwitchPreview, type ProfileSwitchResult,
} from './profile-manager.ts';
