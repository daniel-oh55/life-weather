/**
 * Pure Android release-configuration validators and resolvers shared by `app.config.ts` (dynamic
 * Expo config evaluation) and the runtime ads boundary (`./today-banner-ad`).
 *
 * This module never imports React, React Native, or Expo — it only reads whatever `env`-shaped
 * object is handed to it, so both a plain Node config-evaluation context and the mobile app runtime
 * can share the exact same validation semantics. It never logs or throws a value-carrying error: the
 * only exported error type ({@link ProductionReleaseConfigError}) carries just the missing/invalid
 * variable *name*, never its value.
 */

/**
 * The subset of environment values a production Android release must provide. The index signature
 * lets `process.env` (whose declared type carries its own, unrelated named properties) be passed
 * directly — without it, TypeScript's "weak type" check would reject `process.env` for sharing no
 * *named* property with a type made entirely of optional properties.
 */
export interface AndroidReleaseEnv {
  readonly [key: string]: string | undefined;
  readonly LIFE_WEATHER_ANDROID_PACKAGE?: string;
  readonly LIFE_WEATHER_ADMOB_ANDROID_APP_ID?: string;
  readonly EXPO_PUBLIC_ADMOB_TODAY_BANNER_UNIT_ID?: string;
  readonly EXPO_PUBLIC_PRIVACY_POLICY_URL?: string;
  readonly EXPO_PUBLIC_API_BASE_URL?: string;
}

/** The subset of environment values that identify a real production EAS build. See {@link AndroidReleaseEnv} for why the index signature is needed. */
export interface EasBuildEnv {
  readonly [key: string]: string | undefined;
  readonly EAS_BUILD?: string;
  readonly EAS_BUILD_PROFILE?: string;
}

/**
 * Google's own publicly documented sample/test AdMob Android App ID (see AdMob's Android quick
 * start guide). Never Life Weather's production ID — it exists only so the native Google Mobile Ads
 * SDK has *some* valid-shaped App ID to initialize with in a non-production runtime.
 */
export const GOOGLE_SAMPLE_ADMOB_ANDROID_APP_ID = 'ca-app-pub-3940256099942544~3347511713';

/** The publisher id segment of every Google sample AdMob App ID / ad unit ID. */
const GOOGLE_SAMPLE_ADMOB_PUBLISHER_ID = '3940256099942544';

function isNonEmptyTrimmed(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

/** A normal Android dotted application identifier — at least two dotted segments, no whitespace. */
export function isValidAndroidPackageName(value: string | undefined): value is string {
  if (!isNonEmptyTrimmed(value)) {
    return false;
  }
  return /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(value);
}

/** A `ca-app-pub-<16 digits>~<digits>` AdMob Android application-id, valid or sample alike. */
export function isValidAdMobAndroidAppId(value: string | undefined): value is string {
  if (!isNonEmptyTrimmed(value)) {
    return false;
  }
  return /^ca-app-pub-\d{16}~\d+$/.test(value);
}

/** A valid-shaped AdMob Android App ID that is *not* Google's sample/test publisher id. */
export function isProductionAdMobAndroidAppId(value: string | undefined): value is string {
  return isValidAdMobAndroidAppId(value) && !value.includes(GOOGLE_SAMPLE_ADMOB_PUBLISHER_ID);
}

/** A `ca-app-pub-<16 digits>/<digits>` AdMob ad-unit id, valid or sample alike. */
export function isValidAdMobAdUnitId(value: string | undefined): value is string {
  if (!isNonEmptyTrimmed(value)) {
    return false;
  }
  return /^ca-app-pub-\d{16}\/\d+$/.test(value);
}

/** A valid-shaped AdMob ad-unit id that is *not* Google's sample/test publisher id. */
export function isProductionAdMobAdUnitId(value: string | undefined): value is string {
  return isValidAdMobAdUnitId(value) && !value.includes(GOOGLE_SAMPLE_ADMOB_PUBLISHER_ID);
}

/** An absolute HTTPS URL. Never checks reachability — that is Owner release QA. */
export function isValidHttpsUrl(value: string | undefined): value is string {
  if (!isNonEmptyTrimmed(value)) {
    return false;
  }
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** `EAS_BUILD === 'true' && EAS_BUILD_PROFILE === 'production'` — a real production EAS build. */
export function isProductionEasBuild(env: EasBuildEnv): boolean {
  return env.EAS_BUILD === 'true' && env.EAS_BUILD_PROFILE === 'production';
}

/**
 * Thrown by {@link assertProductionAndroidReleaseEnv}. `message`/`variableName` name only the
 * missing/invalid variable — never its value, and never any operator identifier.
 */
export class ProductionReleaseConfigError extends Error {
  public readonly variableName: string;

  constructor(variableName: string) {
    super(`Missing or invalid required production release configuration: ${variableName}`);
    this.name = 'ProductionReleaseConfigError';
    this.variableName = variableName;
  }
}

/**
 * Fail-fast validation for a real production EAS build. Throws {@link ProductionReleaseConfigError}
 * naming the first missing/invalid variable, in a fixed check order. Never validates reachability of
 * any URL — that remains Owner release QA.
 */
export function assertProductionAndroidReleaseEnv(env: AndroidReleaseEnv): void {
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

/**
 * The Android package to set on `expo.android.package`, or `undefined` when
 * `LIFE_WEATHER_ANDROID_PACKAGE` is absent/invalid — never a fabricated fallback. In ordinary
 * local/CI config evaluation this is expected to be `undefined`.
 */
export function resolveAndroidPackage(env: AndroidReleaseEnv): string | undefined {
  return isValidAndroidPackageName(env.LIFE_WEATHER_ANDROID_PACKAGE)
    ? env.LIFE_WEATHER_ANDROID_PACKAGE
    : undefined;
}

/**
 * The AdMob Android App ID for the Google Mobile Ads Expo config plugin: the real configured id
 * when it is present and is not Google's sample id, otherwise Google's documented sample/test App
 * ID (never a fabricated `ca-app-pub` value of this repository's own invention).
 */
export function resolveAdMobAndroidAppId(env: AndroidReleaseEnv): string {
  return isProductionAdMobAndroidAppId(env.LIFE_WEATHER_ADMOB_ANDROID_APP_ID)
    ? env.LIFE_WEATHER_ADMOB_ANDROID_APP_ID
    : GOOGLE_SAMPLE_ADMOB_ANDROID_APP_ID;
}
