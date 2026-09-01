import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Dynamic Expo config layered on top of `app.json` (the static base). This is the one place
 * `process.env` is read for release-specific external values — Android package, AdMob Android App
 * ID, and (via the fail-fast check below) the remaining production-required variables.
 *
 * For a real production EAS build (`EAS_BUILD === 'true' && EAS_BUILD_PROFILE === 'production'`),
 * every required release value is validated *before* any native generation: a missing/invalid value
 * throws here, naming only the variable — never its value. Outside that exact case (ordinary local
 * or CI evaluation, or any non-production EAS profile), `expo.android.package` is simply omitted
 * when `LIFE_WEATHER_ANDROID_PACKAGE` is absent/invalid, and the Google Mobile Ads Expo config
 * plugin falls back to Google's documented sample Android App ID rather than a fabricated one.
 *
 * The config-time validators below intentionally mirror the runtime validators in
 * `./src/ads/android-release-config.ts`; Expo config evaluation does not import that TypeScript
 * module. Expo's `app.config.ts` loader only transpiles this one entry file, so a relative
 * TypeScript import from it fails to resolve at config-evaluation time (there is no project-wide
 * TS loader registered for this process). The two small validator sets below are deliberately
 * minimal, duplicated copies — not a shared import — and must be kept semantically identical to
 * `./src/ads/android-release-config.ts`.
 */

const GOOGLE_SAMPLE_ADMOB_ANDROID_APP_ID = 'ca-app-pub-3940256099942544~3347511713';
const GOOGLE_SAMPLE_ADMOB_PUBLISHER_ID = '3940256099942544';

function isNonEmptyTrimmed(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function isValidAndroidPackageName(value: string | undefined): value is string {
  return isNonEmptyTrimmed(value) && /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(value);
}

function isProductionAdMobAndroidAppId(value: string | undefined): value is string {
  return (
    isNonEmptyTrimmed(value) &&
    /^ca-app-pub-\d{16}~\d{10}$/.test(value) &&
    !value.includes(GOOGLE_SAMPLE_ADMOB_PUBLISHER_ID)
  );
}

function isProductionAdMobAdUnitId(value: string | undefined): value is string {
  return (
    isNonEmptyTrimmed(value) &&
    /^ca-app-pub-\d{16}\/\d{10}$/.test(value) &&
    !value.includes(GOOGLE_SAMPLE_ADMOB_PUBLISHER_ID)
  );
}

function isValidHttpsUrl(value: string | undefined): value is string {
  if (!isNonEmptyTrimmed(value)) {
    return false;
  }
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isProductionEasBuild(env: NodeJS.ProcessEnv): boolean {
  return env.EAS_BUILD === 'true' && env.EAS_BUILD_PROFILE === 'production';
}

/** Thrown for a real production EAS build. Names only the missing/invalid variable, never its value. */
class ProductionReleaseConfigError extends Error {
  constructor(variableName: string) {
    super(`Missing or invalid required production release configuration: ${variableName}`);
    this.name = 'ProductionReleaseConfigError';
  }
}

function assertProductionAndroidReleaseEnv(env: NodeJS.ProcessEnv): void {
  if (!isValidAndroidPackageName(env.LIFE_WEATHER_ANDROID_PACKAGE)) {
    throw new ProductionReleaseConfigError('LIFE_WEATHER_ANDROID_PACKAGE');
  }
  if (!isProductionAdMobAndroidAppId(env.LIFE_WEATHER_ADMOB_ANDROID_APP_ID)) {
    throw new ProductionReleaseConfigError('LIFE_WEATHER_ADMOB_ANDROID_APP_ID');
  }
  if (!isProductionAdMobAdUnitId(env.EXPO_PUBLIC_ADMOB_TODAY_BANNER_UNIT_ID)) {
    throw new ProductionReleaseConfigError('EXPO_PUBLIC_ADMOB_TODAY_BANNER_UNIT_ID');
  }
  if (!isValidHttpsUrl(env.EXPO_PUBLIC_PRIVACY_POLICY_URL)) {
    throw new ProductionReleaseConfigError('EXPO_PUBLIC_PRIVACY_POLICY_URL');
  }
  if (!isValidHttpsUrl(env.EXPO_PUBLIC_API_BASE_URL)) {
    throw new ProductionReleaseConfigError('EXPO_PUBLIC_API_BASE_URL');
  }
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const env = process.env;

  if (isProductionEasBuild(env)) {
    assertProductionAndroidReleaseEnv(env);
  }

  const androidPackage = isValidAndroidPackageName(env.LIFE_WEATHER_ANDROID_PACKAGE)
    ? env.LIFE_WEATHER_ANDROID_PACKAGE
    : undefined;
  const admobAndroidAppId = isProductionAdMobAndroidAppId(env.LIFE_WEATHER_ADMOB_ANDROID_APP_ID)
    ? env.LIFE_WEATHER_ADMOB_ANDROID_APP_ID
    : GOOGLE_SAMPLE_ADMOB_ANDROID_APP_ID;

  // `config` (from `ConfigContext`) is typed `Partial<ExpoConfig>`, but at runtime it is always the
  // fully-populated app.json — this cast never fabricates a value, it only reflects that fact to
  // the type checker.
  return {
    ...config,
    android: {
      ...config.android,
      ...(androidPackage !== undefined ? { package: androidPackage } : {}),
    },
    plugins: [
      ...(config.plugins ?? []),
      [
        'react-native-google-mobile-ads',
        {
          androidAppId: admobAndroidAppId,
        },
      ],
    ],
  } as ExpoConfig;
};
