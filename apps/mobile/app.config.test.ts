import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ConfigContext, ExpoConfig } from 'expo/config';

// Synthetic identifiers only — never a real operator-managed value.
const SYNTHETIC_PACKAGE = 'com.example.synthetic';
const SYNTHETIC_ADMOB_APP_ID = 'ca-app-pub-1234567890123456~1234567890';
const SYNTHETIC_BANNER_UNIT_ID = 'ca-app-pub-1234567890123456/1234567890';
const SYNTHETIC_PRIVACY_URL = 'https://example.test/privacy';
const SYNTHETIC_API_BASE_URL = 'https://api.example.test';
const GOOGLE_SAMPLE_ADMOB_ANDROID_APP_ID = 'ca-app-pub-3940256099942544~3347511713';

const RELEASE_ENV_KEYS = [
  'EAS_BUILD',
  'EAS_BUILD_PROFILE',
  'LIFE_WEATHER_ANDROID_PACKAGE',
  'LIFE_WEATHER_ADMOB_ANDROID_APP_ID',
  'EXPO_PUBLIC_ADMOB_TODAY_BANNER_UNIT_ID',
  'EXPO_PUBLIC_PRIVACY_POLICY_URL',
  'EXPO_PUBLIC_API_BASE_URL',
] as const;

const originalEnv: Record<string, string | undefined> = {};

function baseConfig(): Partial<ExpoConfig> {
  return { name: 'Life Weather', slug: 'life-weather', version: '1.0.0' };
}

function context(overrides: Partial<ExpoConfig> = {}): ConfigContext {
  return {
    projectRoot: __dirname,
    staticConfigPath: null,
    packageJsonPath: null,
    config: { ...baseConfig(), ...overrides },
  };
}

function setValidProductionEnv(): void {
  process.env.EAS_BUILD = 'true';
  process.env.EAS_BUILD_PROFILE = 'production';
  process.env.LIFE_WEATHER_ANDROID_PACKAGE = SYNTHETIC_PACKAGE;
  process.env.LIFE_WEATHER_ADMOB_ANDROID_APP_ID = SYNTHETIC_ADMOB_APP_ID;
  process.env.EXPO_PUBLIC_ADMOB_TODAY_BANNER_UNIT_ID = SYNTHETIC_BANNER_UNIT_ID;
  process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL = SYNTHETIC_PRIVACY_URL;
  process.env.EXPO_PUBLIC_API_BASE_URL = SYNTHETIC_API_BASE_URL;
}

beforeEach(() => {
  for (const key of RELEASE_ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of RELEASE_ENV_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
});

async function loadConfigFn() {
  const mod = await import('./app.config');
  return mod.default;
}

describe('non-production config evaluation', () => {
  it('omits expo.android.package when LIFE_WEATHER_ANDROID_PACKAGE is unset', async () => {
    const configFn = await loadConfigFn();

    const result = configFn(context());

    expect(result.android?.package).toBeUndefined();
  });

  it('uses Google\'s sample AdMob Android App ID when none is configured', async () => {
    const configFn = await loadConfigFn();

    const result = configFn(context());

    const plugin = result.plugins?.find(
      (entry) => Array.isArray(entry) && entry[0] === 'react-native-google-mobile-ads',
    ) as [string, { androidAppId: string }] | undefined;
    expect(plugin?.[1].androidAppId).toBe(GOOGLE_SAMPLE_ADMOB_ANDROID_APP_ID);
  });

  it('never throws outside a real production EAS build, even with no env set at all', async () => {
    const configFn = await loadConfigFn();

    expect(() => configFn(context())).not.toThrow();
  });
});

describe('production EAS fail-fast', () => {
  it('resolves without throwing for valid synthetic production values', async () => {
    setValidProductionEnv();
    const configFn = await loadConfigFn();

    expect(() => configFn(context())).not.toThrow();

    const result = configFn(context());
    expect(result.android?.package).toBe(SYNTHETIC_PACKAGE);
    const plugin = result.plugins?.find(
      (entry) => Array.isArray(entry) && entry[0] === 'react-native-google-mobile-ads',
    ) as [string, { androidAppId: string }] | undefined;
    expect(plugin?.[1].androidAppId).toBe(SYNTHETIC_ADMOB_APP_ID);
  });

  it('fails with missing Android package, naming only the variable', async () => {
    setValidProductionEnv();
    delete process.env.LIFE_WEATHER_ANDROID_PACKAGE;
    const configFn = await loadConfigFn();

    expect(() => configFn(context())).toThrow(/LIFE_WEATHER_ANDROID_PACKAGE/);
  });

  it('fails with missing AdMob Android App ID', async () => {
    setValidProductionEnv();
    delete process.env.LIFE_WEATHER_ADMOB_ANDROID_APP_ID;
    const configFn = await loadConfigFn();

    expect(() => configFn(context())).toThrow(/LIFE_WEATHER_ADMOB_ANDROID_APP_ID/);
  });

  it('fails with Google\'s sample AdMob Android App ID', async () => {
    setValidProductionEnv();
    process.env.LIFE_WEATHER_ADMOB_ANDROID_APP_ID = GOOGLE_SAMPLE_ADMOB_ANDROID_APP_ID;
    const configFn = await loadConfigFn();

    expect(() => configFn(context())).toThrow(/LIFE_WEATHER_ADMOB_ANDROID_APP_ID/);
  });

  it('fails with missing banner unit ID', async () => {
    setValidProductionEnv();
    delete process.env.EXPO_PUBLIC_ADMOB_TODAY_BANNER_UNIT_ID;
    const configFn = await loadConfigFn();

    expect(() => configFn(context())).toThrow(/EXPO_PUBLIC_ADMOB_TODAY_BANNER_UNIT_ID/);
  });

  it('fails with a test/sample banner unit ID', async () => {
    setValidProductionEnv();
    process.env.EXPO_PUBLIC_ADMOB_TODAY_BANNER_UNIT_ID = 'ca-app-pub-3940256099942544/9214589741';
    const configFn = await loadConfigFn();

    expect(() => configFn(context())).toThrow(/EXPO_PUBLIC_ADMOB_TODAY_BANNER_UNIT_ID/);
  });

  it('fails with missing privacy policy URL', async () => {
    setValidProductionEnv();
    delete process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL;
    const configFn = await loadConfigFn();

    expect(() => configFn(context())).toThrow(/EXPO_PUBLIC_PRIVACY_POLICY_URL/);
  });

  it('fails with a non-HTTPS privacy policy URL', async () => {
    setValidProductionEnv();
    process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL = 'http://example.test/privacy';
    const configFn = await loadConfigFn();

    expect(() => configFn(context())).toThrow(/EXPO_PUBLIC_PRIVACY_POLICY_URL/);
  });

  it('fails with missing API base URL', async () => {
    setValidProductionEnv();
    delete process.env.EXPO_PUBLIC_API_BASE_URL;
    const configFn = await loadConfigFn();

    expect(() => configFn(context())).toThrow(/EXPO_PUBLIC_API_BASE_URL/);
  });

  it('never echoes a configured value in the thrown error text', async () => {
    setValidProductionEnv();
    delete process.env.LIFE_WEATHER_ANDROID_PACKAGE;
    const configFn = await loadConfigFn();

    try {
      configFn(context());
      throw new Error('expected configFn to throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain(SYNTHETIC_ADMOB_APP_ID);
      expect(message).not.toContain(SYNTHETIC_BANNER_UNIT_ID);
      expect(message).not.toContain(SYNTHETIC_PRIVACY_URL);
      expect(message).not.toContain(SYNTHETIC_API_BASE_URL);
    }
  });

  it('is not triggered by EAS_BUILD/EAS_BUILD_PROFILE alone in any other combination', async () => {
    const configFn = await loadConfigFn();

    process.env.EAS_BUILD = 'true';
    expect(() => configFn(context())).not.toThrow();

    process.env.EAS_BUILD = 'false';
    process.env.EAS_BUILD_PROFILE = 'production';
    expect(() => configFn(context())).not.toThrow();

    process.env.EAS_BUILD = 'true';
    process.env.EAS_BUILD_PROFILE = 'development';
    expect(() => configFn(context())).not.toThrow();
  });
});
