/**
 * Production composition of the mobile ads runtime store.
 *
 * The only module in this app that imports `react-native-google-mobile-ads`' `AdsConsent`/
 * `mobileAds` directly. It adapts the native UMP `AdsConsentInfo` shape to this app's minimal
 * {@link MobileAdsConsentInfo} (via the library's own `AdsConsentPrivacyOptionsRequirementStatus`
 * enum, never a guessed string/number literal) and wires both native surfaces into the
 * provider-neutral {@link createMobileAdsRuntimeStore} factory exactly once.
 *
 * Importing this module performs no native call — `createMobileAdsRuntimeStore` only initializes
 * in-memory state. The startup contract (`.start()`) is kicked off exactly once, from the root
 * layout mount effect (`../app/_layout`).
 */

import mobileAds, {
  AdsConsent,
  AdsConsentPrivacyOptionsRequirementStatus,
  type AdsConsentInfo,
} from 'react-native-google-mobile-ads';

import {
  createMobileAdsRuntimeStore,
  type MobileAdsConsentInfo,
  type MobileAdsPrivacyOptionsRequirementStatus,
  type MobileAdsRuntimeStore,
} from './mobile-ads-runtime-store';

function mapPrivacyOptionsRequirementStatus(
  status: AdsConsentInfo['privacyOptionsRequirementStatus'],
): MobileAdsPrivacyOptionsRequirementStatus {
  switch (status) {
    case AdsConsentPrivacyOptionsRequirementStatus.REQUIRED:
      return 'REQUIRED';
    case AdsConsentPrivacyOptionsRequirementStatus.NOT_REQUIRED:
      return 'NOT_REQUIRED';
    default:
      return 'UNKNOWN';
  }
}

function toMobileAdsConsentInfo(info: AdsConsentInfo): MobileAdsConsentInfo {
  return {
    canRequestAds: info.canRequestAds,
    privacyOptionsRequirementStatus: mapPrivacyOptionsRequirementStatus(
      info.privacyOptionsRequirementStatus,
    ),
  };
}

/** The single production {@link MobileAdsRuntimeStore} for the app runtime. */
export const mobileAdsRuntimeStore: MobileAdsRuntimeStore = createMobileAdsRuntimeStore({
  consentClient: {
    async gatherConsent(): Promise<MobileAdsConsentInfo> {
      return toMobileAdsConsentInfo(await AdsConsent.gatherConsent());
    },
    async getConsentInfo(): Promise<MobileAdsConsentInfo> {
      return toMobileAdsConsentInfo(await AdsConsent.getConsentInfo());
    },
    async showPrivacyOptionsForm(): Promise<MobileAdsConsentInfo> {
      await AdsConsent.showPrivacyOptionsForm();
      return toMobileAdsConsentInfo(await AdsConsent.getConsentInfo());
    },
  },
  mobileAdsClient: {
    async initialize(): Promise<unknown> {
      return mobileAds().initialize();
    },
  },
});
