import { describe, expect, it } from 'vitest';

import {
  GOOGLE_SAMPLE_ADMOB_ANDROID_APP_ID,
  ProductionReleaseConfigError,
  assertProductionAndroidReleaseEnv,
  isProductionAdMobAdUnitId,
  isProductionAdMobAndroidAppId,
  isProductionEasBuild,
  isValidAndroidPackageName,
  isValidHttpsUrl,
  resolveAdMobAndroidAppId,
  resolveAndroidPackage,
  type AndroidReleaseEnv,
} from './android-release-config';

// Synthetic identifiers only — never a real operator-managed value.
const SYNTHETIC_PACKAGE = 'com.example.synthetic';
const SYNTHETIC_ADMOB_APP_ID = 'ca-app-pub-1234567890123456~1234567890';
const SYNTHETIC_BANNER_UNIT_ID = 'ca-app-pub-1234567890123456/1234567890';
const SYNTHETIC_PRIVACY_URL = 'https://example.test/privacy';
const SYNTHETIC_API_BASE_URL = 'https://api.example.test';

function validEnv(overrides: Partial<AndroidReleaseEnv> = {}): AndroidReleaseEnv {
  return {
    LIFE_WEATHER_ANDROID_PACKAGE: SYNTHETIC_PACKAGE,
    LIFE_WEATHER_ADMOB_ANDROID_APP_ID: SYNTHETIC_ADMOB_APP_ID,
    EXPO_PUBLIC_ADMOB_TODAY_BANNER_UNIT_ID: SYNTHETIC_BANNER_UNIT_ID,
    EXPO_PUBLIC_PRIVACY_POLICY_URL: SYNTHETIC_PRIVACY_URL,
    EXPO_PUBLIC_API_BASE_URL: SYNTHETIC_API_BASE_URL,
    ...overrides,
  };
}

describe('isProductionEasBuild', () => {
  it('is true only for EAS_BUILD=true and EAS_BUILD_PROFILE=production', () => {
    expect(isProductionEasBuild({ EAS_BUILD: 'true', EAS_BUILD_PROFILE: 'production' })).toBe(true);
  });

  it('is false for every other combination (negative controls)', () => {
    expect(isProductionEasBuild({})).toBe(false);
    expect(isProductionEasBuild({ EAS_BUILD: 'true' })).toBe(false);
    expect(isProductionEasBuild({ EAS_BUILD_PROFILE: 'production' })).toBe(false);
    expect(isProductionEasBuild({ EAS_BUILD: 'false', EAS_BUILD_PROFILE: 'production' })).toBe(false);
    expect(isProductionEasBuild({ EAS_BUILD: 'true', EAS_BUILD_PROFILE: 'development' })).toBe(false);
  });
});

describe('isValidAndroidPackageName', () => {
  it('accepts a normal dotted application identifier', () => {
    expect(isValidAndroidPackageName(SYNTHETIC_PACKAGE)).toBe(true);
    expect(isValidAndroidPackageName('com.example.app.debug')).toBe(true);
  });

  it('rejects missing, empty, whitespace, and single-segment values', () => {
    expect(isValidAndroidPackageName(undefined)).toBe(false);
    expect(isValidAndroidPackageName('')).toBe(false);
    expect(isValidAndroidPackageName('   ')).toBe(false);
    expect(isValidAndroidPackageName(' com.example.app')).toBe(false);
    expect(isValidAndroidPackageName('com.example.app ')).toBe(false);
    expect(isValidAndroidPackageName('com')).toBe(false);
    expect(isValidAndroidPackageName('com..example')).toBe(false);
  });
});

describe('AdMob Android App ID validation', () => {
  it('accepts a synthetic valid production-shaped App ID', () => {
    expect(isProductionAdMobAndroidAppId(SYNTHETIC_ADMOB_APP_ID)).toBe(true);
  });

  it('rejects Google sample/test App ID as a production App ID', () => {
    expect(isProductionAdMobAndroidAppId(GOOGLE_SAMPLE_ADMOB_ANDROID_APP_ID)).toBe(false);
  });

  it('rejects missing/malformed values', () => {
    expect(isProductionAdMobAndroidAppId(undefined)).toBe(false);
    expect(isProductionAdMobAndroidAppId('')).toBe(false);
    expect(isProductionAdMobAndroidAppId('not-an-app-id')).toBe(false);
    expect(isProductionAdMobAndroidAppId('ca-app-pub-123~456')).toBe(false);
  });
});

describe('AdMob ad-unit ID validation', () => {
  it('accepts a synthetic valid production-shaped ad-unit id', () => {
    expect(isProductionAdMobAdUnitId(SYNTHETIC_BANNER_UNIT_ID)).toBe(true);
  });

  it('rejects Google sample/test publisher ad-unit ids', () => {
    expect(isProductionAdMobAdUnitId('ca-app-pub-3940256099942544/6300978111')).toBe(false);
    expect(isProductionAdMobAdUnitId('ca-app-pub-3940256099942544/9214589741')).toBe(false);
  });

  it('rejects missing/malformed values', () => {
    expect(isProductionAdMobAdUnitId(undefined)).toBe(false);
    expect(isProductionAdMobAdUnitId('')).toBe(false);
    expect(isProductionAdMobAdUnitId('ca-app-pub-1234567890123456~1234567890')).toBe(false);
  });
});

describe('isValidHttpsUrl', () => {
  it('accepts an absolute https URL', () => {
    expect(isValidHttpsUrl(SYNTHETIC_PRIVACY_URL)).toBe(true);
  });

  it('rejects non-HTTPS and malformed values', () => {
    expect(isValidHttpsUrl(undefined)).toBe(false);
    expect(isValidHttpsUrl('')).toBe(false);
    expect(isValidHttpsUrl('http://example.test/privacy')).toBe(false);
    expect(isValidHttpsUrl('not a url')).toBe(false);
    expect(isValidHttpsUrl('ftp://example.test')).toBe(false);
  });
});

describe('assertProductionAndroidReleaseEnv', () => {
  it('resolves without throwing for valid synthetic production values, and never exposes them in thrown text', () => {
    expect(() => assertProductionAndroidReleaseEnv(validEnv())).not.toThrow();
  });

  it('fails when the Android package is missing', () => {
    try {
      assertProductionAndroidReleaseEnv(validEnv({ LIFE_WEATHER_ANDROID_PACKAGE: undefined }));
      throw new Error('expected assertProductionAndroidReleaseEnv to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ProductionReleaseConfigError);
      expect((error as ProductionReleaseConfigError).variableName).toBe(
        'LIFE_WEATHER_ANDROID_PACKAGE',
      );
      expect((error as Error).message).not.toContain(SYNTHETIC_ADMOB_APP_ID);
      expect((error as Error).message).not.toContain(SYNTHETIC_BANNER_UNIT_ID);
    }
  });

  it('fails when the AdMob Android App ID is missing', () => {
    try {
      assertProductionAndroidReleaseEnv(
        validEnv({ LIFE_WEATHER_ADMOB_ANDROID_APP_ID: undefined }),
      );
      throw new Error('expected assertProductionAndroidReleaseEnv to throw');
    } catch (error) {
      expect((error as ProductionReleaseConfigError).variableName).toBe(
        'LIFE_WEATHER_ADMOB_ANDROID_APP_ID',
      );
    }
  });

  it('fails when the AdMob Android App ID is Google’s sample/test id', () => {
    try {
      assertProductionAndroidReleaseEnv(
        validEnv({ LIFE_WEATHER_ADMOB_ANDROID_APP_ID: GOOGLE_SAMPLE_ADMOB_ANDROID_APP_ID }),
      );
      throw new Error('expected assertProductionAndroidReleaseEnv to throw');
    } catch (error) {
      expect((error as ProductionReleaseConfigError).variableName).toBe(
        'LIFE_WEATHER_ADMOB_ANDROID_APP_ID',
      );
    }
  });

  it('fails when the banner unit ID is missing', () => {
    try {
      assertProductionAndroidReleaseEnv(
        validEnv({ EXPO_PUBLIC_ADMOB_TODAY_BANNER_UNIT_ID: undefined }),
      );
      throw new Error('expected assertProductionAndroidReleaseEnv to throw');
    } catch (error) {
      expect((error as ProductionReleaseConfigError).variableName).toBe(
        'EXPO_PUBLIC_ADMOB_TODAY_BANNER_UNIT_ID',
      );
    }
  });

  it('fails when the banner unit ID is a test/sample id', () => {
    try {
      assertProductionAndroidReleaseEnv(
        validEnv({
          EXPO_PUBLIC_ADMOB_TODAY_BANNER_UNIT_ID: 'ca-app-pub-3940256099942544/9214589741',
        }),
      );
      throw new Error('expected assertProductionAndroidReleaseEnv to throw');
    } catch (error) {
      expect((error as ProductionReleaseConfigError).variableName).toBe(
        'EXPO_PUBLIC_ADMOB_TODAY_BANNER_UNIT_ID',
      );
    }
  });

  it('fails when the privacy policy URL is missing', () => {
    try {
      assertProductionAndroidReleaseEnv(validEnv({ EXPO_PUBLIC_PRIVACY_POLICY_URL: undefined }));
      throw new Error('expected assertProductionAndroidReleaseEnv to throw');
    } catch (error) {
      expect((error as ProductionReleaseConfigError).variableName).toBe(
        'EXPO_PUBLIC_PRIVACY_POLICY_URL',
      );
    }
  });

  it('fails when the privacy policy URL is not HTTPS', () => {
    try {
      assertProductionAndroidReleaseEnv(
        validEnv({ EXPO_PUBLIC_PRIVACY_POLICY_URL: 'http://example.test/privacy' }),
      );
      throw new Error('expected assertProductionAndroidReleaseEnv to throw');
    } catch (error) {
      expect((error as ProductionReleaseConfigError).variableName).toBe(
        'EXPO_PUBLIC_PRIVACY_POLICY_URL',
      );
    }
  });

  it('fails when the API base URL is missing', () => {
    try {
      assertProductionAndroidReleaseEnv(validEnv({ EXPO_PUBLIC_API_BASE_URL: undefined }));
      throw new Error('expected assertProductionAndroidReleaseEnv to throw');
    } catch (error) {
      expect((error as ProductionReleaseConfigError).variableName).toBe(
        'EXPO_PUBLIC_API_BASE_URL',
      );
    }
  });

  it('never includes any configured value in the thrown message (no secret/value leakage)', () => {
    try {
      assertProductionAndroidReleaseEnv(validEnv({ LIFE_WEATHER_ANDROID_PACKAGE: undefined }));
      throw new Error('expected assertProductionAndroidReleaseEnv to throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain(SYNTHETIC_ADMOB_APP_ID);
      expect(message).not.toContain(SYNTHETIC_BANNER_UNIT_ID);
      expect(message).not.toContain(SYNTHETIC_PRIVACY_URL);
      expect(message).not.toContain(SYNTHETIC_API_BASE_URL);
    }
  });
});

describe('resolveAndroidPackage', () => {
  it('returns the configured package when valid', () => {
    expect(resolveAndroidPackage(validEnv())).toBe(SYNTHETIC_PACKAGE);
  });

  it('returns undefined (never a fabricated fallback) when missing or invalid', () => {
    expect(resolveAndroidPackage(validEnv({ LIFE_WEATHER_ANDROID_PACKAGE: undefined }))).toBeUndefined();
    expect(
      resolveAndroidPackage(validEnv({ LIFE_WEATHER_ANDROID_PACKAGE: 'not valid' })),
    ).toBeUndefined();
  });
});

describe('resolveAdMobAndroidAppId', () => {
  it('non-production config may use the Google sample App ID when none is configured', () => {
    expect(
      resolveAdMobAndroidAppId(validEnv({ LIFE_WEATHER_ADMOB_ANDROID_APP_ID: undefined })),
    ).toBe(GOOGLE_SAMPLE_ADMOB_ANDROID_APP_ID);
  });

  it('falls back to the sample App ID for a malformed configured value too', () => {
    expect(
      resolveAdMobAndroidAppId(validEnv({ LIFE_WEATHER_ADMOB_ANDROID_APP_ID: 'not-an-app-id' })),
    ).toBe(GOOGLE_SAMPLE_ADMOB_ANDROID_APP_ID);
  });

  it('uses the real configured App ID when it is a valid, non-sample value', () => {
    expect(resolveAdMobAndroidAppId(validEnv())).toBe(SYNTHETIC_ADMOB_APP_ID);
  });

  it('never fabricates its own ca-app-pub value beyond the documented sample', () => {
    const resolved = resolveAdMobAndroidAppId(validEnv({ LIFE_WEATHER_ADMOB_ANDROID_APP_ID: undefined }));
    expect(resolved === GOOGLE_SAMPLE_ADMOB_ANDROID_APP_ID || resolved === SYNTHETIC_ADMOB_APP_ID).toBe(
      true,
    );
  });
});
