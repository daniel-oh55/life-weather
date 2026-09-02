/**
 * Public surface of the mobile ads boundary.
 *
 * Pure and provider-neutral: only the store factory/types and the release-config validators are
 * exported here. The production composition (`./mobile-ads-runtime-production`, which imports
 * `react-native-google-mobile-ads`), the React hook (`./use-mobile-ads-runtime`), and the banner
 * component (`./today-banner-ad`) are deliberately **not** re-exported, so a pure/Node consumer of
 * this barrel (including `app.config.ts`) never transitively loads React or the native ads SDK.
 */

export {
  createMobileAdsRuntimeStore,
  type MobileAdsConsentClient,
  type MobileAdsConsentInfo,
  type MobileAdsPrivacyOptionsRequirementStatus,
  type MobileAdsRuntimeSnapshot,
  type MobileAdsRuntimeStore,
  type MobileAdsRuntimeStoreDependencies,
  type MobileAdsSdkClient,
} from './mobile-ads-runtime-store';

export {
  GOOGLE_SAMPLE_ADMOB_ANDROID_APP_ID,
  ProductionReleaseConfigError,
  assertProductionAndroidReleaseEnv,
  isProductionAdMobAdUnitId,
  isProductionAdMobAndroidAppId,
  isProductionEasBuild,
  isValidAdMobAdUnitId,
  isValidAdMobAndroidAppId,
  isValidAndroidPackageName,
  isValidHttpsUrl,
  resolveAdMobAndroidAppId,
  resolveAndroidPackage,
  type AndroidReleaseEnv,
  type EasBuildEnv,
} from './android-release-config';
