/**
 * The one adaptive AdMob banner placement for the whole app — Today's screen only, at the bottom of
 * its content. Renders nothing until the shared ads runtime reports both UMP `canRequestAds` and a
 * completed Mobile Ads SDK initialization; no permanent empty ad box is reserved before that.
 *
 * Ad-unit selection: `__DEV__` always uses the library's own `TestIds.ADAPTIVE_BANNER`. A
 * non-development runtime uses only the validated `EXPO_PUBLIC_ADMOB_TODAY_BANNER_UNIT_ID` — a
 * missing/invalid value there renders no ad rather than silently substituting a test banner. No
 * saved-location, coordinate, or weather-condition value is ever passed as a request option: this
 * component passes none.
 */

import { BannerAd, BannerAdSize, TestIds } from 'react-native-google-mobile-ads';

import { isProductionAdMobAdUnitId } from './android-release-config';
import { useMobileAdsRuntime } from './use-mobile-ads-runtime';

function resolveBannerAdUnitId(): string | null {
  if (__DEV__) {
    return TestIds.ADAPTIVE_BANNER;
  }
  const configured = process.env.EXPO_PUBLIC_ADMOB_TODAY_BANNER_UNIT_ID;
  return isProductionAdMobAdUnitId(configured) ? configured : null;
}

/** Renders the single Today banner placement, or nothing when ads are not yet eligible. */
export function TodayBannerAd() {
  const { canRequestAds, adsInitialized } = useMobileAdsRuntime();

  if (!canRequestAds || !adsInitialized) {
    return null;
  }

  const unitId = resolveBannerAdUnitId();
  if (unitId === null) {
    return null;
  }

  return <BannerAd unitId={unitId} size={BannerAdSize.LARGE_ANCHORED_ADAPTIVE_BANNER} />;
}
