import { describe, expect, it, vi } from 'vitest';

import {
  createMobileAdsRuntimeStore,
  type MobileAdsConsentClient,
  type MobileAdsConsentInfo,
  type MobileAdsSdkClient,
} from './mobile-ads-runtime-store';

function consentInfo(overrides: Partial<MobileAdsConsentInfo> = {}): MobileAdsConsentInfo {
  return {
    canRequestAds: false,
    privacyOptionsRequirementStatus: 'NOT_REQUIRED',
    ...overrides,
  };
}

function fakeConsentClient(overrides: Partial<MobileAdsConsentClient> = {}): MobileAdsConsentClient {
  return {
    gatherConsent: vi.fn(async () => consentInfo()),
    getConsentInfo: vi.fn(async () => consentInfo()),
    showPrivacyOptionsForm: vi.fn(async () => consentInfo()),
    ...overrides,
  };
}

function fakeMobileAdsClient(overrides: Partial<MobileAdsSdkClient> = {}): MobileAdsSdkClient {
  return {
    initialize: vi.fn(async () => ({})),
    ...overrides,
  };
}

describe('initial snapshot', () => {
  it('starts with ads blocked and not initialized, with no side effect from construction', () => {
    const consentClient = fakeConsentClient();
    const mobileAdsClient = fakeMobileAdsClient();
    const store = createMobileAdsRuntimeStore({ consentClient, mobileAdsClient });

    expect(store.getSnapshot()).toEqual({
      canRequestAds: false,
      adsInitialized: false,
      privacyOptionsRequired: false,
    });
    expect(consentClient.gatherConsent).toHaveBeenCalledTimes(0);
    expect(mobileAdsClient.initialize).toHaveBeenCalledTimes(0);
  });
});

describe('start() — gather/update runs once', () => {
  it('calls gatherConsent exactly once even under repeated/concurrent start() calls', async () => {
    const consentClient = fakeConsentClient({
      gatherConsent: vi.fn(async () => consentInfo({ canRequestAds: true })),
    });
    const mobileAdsClient = fakeMobileAdsClient();
    const store = createMobileAdsRuntimeStore({ consentClient, mobileAdsClient });

    const first = store.start();
    const second = store.start();
    await Promise.all([first, second]);
    await store.start();

    expect(consentClient.gatherConsent).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });
});

describe('canRequestAds=false → Mobile Ads initialize 0 times', () => {
  it('never calls initialize when consent disallows ads', async () => {
    const consentClient = fakeConsentClient({
      gatherConsent: vi.fn(async () => consentInfo({ canRequestAds: false })),
    });
    const mobileAdsClient = fakeMobileAdsClient();
    const store = createMobileAdsRuntimeStore({ consentClient, mobileAdsClient });

    await store.start();

    expect(mobileAdsClient.initialize).toHaveBeenCalledTimes(0);
    expect(store.getSnapshot()).toEqual({
      canRequestAds: false,
      adsInitialized: false,
      privacyOptionsRequired: false,
    });
  });
});

describe('canRequestAds=true → initialize exactly once', () => {
  it('initializes ads and publishes adsInitialized: true', async () => {
    const consentClient = fakeConsentClient({
      gatherConsent: vi.fn(async () => consentInfo({ canRequestAds: true })),
    });
    const mobileAdsClient = fakeMobileAdsClient();
    const store = createMobileAdsRuntimeStore({ consentClient, mobileAdsClient });

    await store.start();

    expect(mobileAdsClient.initialize).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toEqual({
      canRequestAds: true,
      adsInitialized: true,
      privacyOptionsRequired: false,
    });
  });
});

describe('repeated state/update callbacks cannot initialize twice', () => {
  it('dedupes concurrent initialize attempts triggered by start() and openPrivacyOptions()', async () => {
    let resolveInitialize: () => void = () => {};
    const consentClient = fakeConsentClient({
      gatherConsent: vi.fn(async () => consentInfo({ canRequestAds: true })),
      showPrivacyOptionsForm: vi.fn(async () => consentInfo({ canRequestAds: true })),
    });
    const mobileAdsClient = fakeMobileAdsClient({
      initialize: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveInitialize = () => resolve({});
          }),
      ),
    });
    const store = createMobileAdsRuntimeStore({ consentClient, mobileAdsClient });

    const starting = store.start();
    // A privacy-options completion racing the in-flight startup initialize attempt.
    const openingPrivacyOptions = store.openPrivacyOptions();

    await vi.waitFor(() => {
      expect(mobileAdsClient.initialize).toHaveBeenCalledTimes(1);
    });
    resolveInitialize();
    await Promise.all([starting, openingPrivacyOptions]);
    await store.openPrivacyOptions();

    expect(mobileAdsClient.initialize).toHaveBeenCalledTimes(1);
  });

  it('never re-initializes on a later start()-like trigger once already initialized', async () => {
    const consentClient = fakeConsentClient({
      gatherConsent: vi.fn(async () => consentInfo({ canRequestAds: true })),
      showPrivacyOptionsForm: vi.fn(async () => consentInfo({ canRequestAds: true })),
    });
    const mobileAdsClient = fakeMobileAdsClient();
    const store = createMobileAdsRuntimeStore({ consentClient, mobileAdsClient });

    await store.start();
    await store.openPrivacyOptions();
    await store.openPrivacyOptions();

    expect(mobileAdsClient.initialize).toHaveBeenCalledTimes(1);
  });
});

describe('gather failure + previous-session consent', () => {
  it('canRequestAds=true from getConsentInfo permits initialization', async () => {
    const consentClient = fakeConsentClient({
      gatherConsent: vi.fn(async () => {
        throw new Error('synthetic native gather failure');
      }),
      getConsentInfo: vi.fn(async () => consentInfo({ canRequestAds: true })),
    });
    const mobileAdsClient = fakeMobileAdsClient();
    const store = createMobileAdsRuntimeStore({ consentClient, mobileAdsClient });

    await expect(store.start()).resolves.toBeUndefined();

    expect(consentClient.getConsentInfo).toHaveBeenCalledTimes(1);
    expect(mobileAdsClient.initialize).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().canRequestAds).toBe(true);
    expect(store.getSnapshot().adsInitialized).toBe(true);
  });

  it('canRequestAds=false from getConsentInfo keeps ads blocked', async () => {
    const consentClient = fakeConsentClient({
      gatherConsent: vi.fn(async () => {
        throw new Error('synthetic native gather failure');
      }),
      getConsentInfo: vi.fn(async () => consentInfo({ canRequestAds: false })),
    });
    const mobileAdsClient = fakeMobileAdsClient();
    const store = createMobileAdsRuntimeStore({ consentClient, mobileAdsClient });

    await store.start();

    expect(mobileAdsClient.initialize).toHaveBeenCalledTimes(0);
    expect(store.getSnapshot().canRequestAds).toBe(false);
    expect(store.getSnapshot().adsInitialized).toBe(false);
  });

  it('never throws even when both gatherConsent and getConsentInfo fail', async () => {
    const consentClient = fakeConsentClient({
      gatherConsent: vi.fn(async () => {
        throw new Error('synthetic gather failure');
      }),
      getConsentInfo: vi.fn(async () => {
        throw new Error('synthetic getConsentInfo failure');
      }),
    });
    const mobileAdsClient = fakeMobileAdsClient();
    const store = createMobileAdsRuntimeStore({ consentClient, mobileAdsClient });

    await expect(store.start()).resolves.toBeUndefined();
    expect(store.getSnapshot()).toEqual({
      canRequestAds: false,
      adsInitialized: false,
      privacyOptionsRequired: false,
    });
    expect(mobileAdsClient.initialize).toHaveBeenCalledTimes(0);
  });
});

describe('privacy-options requirement status', () => {
  it('publishes privacyOptionsRequired: true when UMP reports REQUIRED', async () => {
    const consentClient = fakeConsentClient({
      gatherConsent: vi.fn(async () =>
        consentInfo({ canRequestAds: true, privacyOptionsRequirementStatus: 'REQUIRED' }),
      ),
    });
    const store = createMobileAdsRuntimeStore({ consentClient, mobileAdsClient: fakeMobileAdsClient() });

    await store.start();

    expect(store.getSnapshot().privacyOptionsRequired).toBe(true);
  });

  it('publishes privacyOptionsRequired: false for NOT_REQUIRED and UNKNOWN alike', async () => {
    const notRequiredClient = fakeConsentClient({
      gatherConsent: vi.fn(async () =>
        consentInfo({ privacyOptionsRequirementStatus: 'NOT_REQUIRED' }),
      ),
    });
    const unknownClient = fakeConsentClient({
      gatherConsent: vi.fn(async () => consentInfo({ privacyOptionsRequirementStatus: 'UNKNOWN' })),
    });

    const storeA = createMobileAdsRuntimeStore({
      consentClient: notRequiredClient,
      mobileAdsClient: fakeMobileAdsClient(),
    });
    const storeB = createMobileAdsRuntimeStore({
      consentClient: unknownClient,
      mobileAdsClient: fakeMobileAdsClient(),
    });

    await storeA.start();
    await storeB.start();

    expect(storeA.getSnapshot().privacyOptionsRequired).toBe(false);
    expect(storeB.getSnapshot().privacyOptionsRequired).toBe(false);
  });
});

describe('showPrivacyOptionsForm is called only by explicit user action', () => {
  it('start() never calls showPrivacyOptionsForm', async () => {
    const consentClient = fakeConsentClient();
    const store = createMobileAdsRuntimeStore({ consentClient, mobileAdsClient: fakeMobileAdsClient() });

    await store.start();

    expect(consentClient.showPrivacyOptionsForm).toHaveBeenCalledTimes(0);
  });

  it('only an explicit openPrivacyOptions() call invokes showPrivacyOptionsForm, exactly once per call', async () => {
    const consentClient = fakeConsentClient();
    const store = createMobileAdsRuntimeStore({ consentClient, mobileAdsClient: fakeMobileAdsClient() });

    await store.start();
    await store.openPrivacyOptions();

    expect(consentClient.showPrivacyOptionsForm).toHaveBeenCalledTimes(1);
  });
});

describe('privacy-options result updates ad eligibility', () => {
  it('newly allows and initializes ads when the form result flips canRequestAds to true', async () => {
    const consentClient = fakeConsentClient({
      gatherConsent: vi.fn(async () => consentInfo({ canRequestAds: false })),
      showPrivacyOptionsForm: vi.fn(async () => consentInfo({ canRequestAds: true })),
    });
    const mobileAdsClient = fakeMobileAdsClient();
    const store = createMobileAdsRuntimeStore({ consentClient, mobileAdsClient });

    await store.start();
    expect(store.getSnapshot().adsInitialized).toBe(false);

    await store.openPrivacyOptions();

    expect(mobileAdsClient.initialize).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().canRequestAds).toBe(true);
    expect(store.getSnapshot().adsInitialized).toBe(true);
  });

  it('makes the banner ineligible again when the form result flips canRequestAds to false', async () => {
    const consentClient = fakeConsentClient({
      gatherConsent: vi.fn(async () => consentInfo({ canRequestAds: true })),
      showPrivacyOptionsForm: vi.fn(async () => consentInfo({ canRequestAds: false })),
    });
    const mobileAdsClient = fakeMobileAdsClient();
    const store = createMobileAdsRuntimeStore({ consentClient, mobileAdsClient });

    await store.start();
    expect(store.getSnapshot().adsInitialized).toBe(true);

    await store.openPrivacyOptions();

    // adsInitialized stays true (the SDK is not "un-initialized"), but canRequestAds — and
    // therefore the banner's own `canRequestAds && adsInitialized` eligibility check — is false.
    expect(store.getSnapshot().canRequestAds).toBe(false);
  });

  it('never throws and leaves the snapshot unchanged when showPrivacyOptionsForm rejects', async () => {
    const consentClient = fakeConsentClient({
      gatherConsent: vi.fn(async () => consentInfo({ canRequestAds: true })),
      showPrivacyOptionsForm: vi.fn(async () => {
        throw new Error('synthetic native form failure');
      }),
    });
    const mobileAdsClient = fakeMobileAdsClient();
    const store = createMobileAdsRuntimeStore({ consentClient, mobileAdsClient });

    await store.start();
    const before = store.getSnapshot();

    await expect(store.openPrivacyOptions()).resolves.toBeUndefined();

    expect(store.getSnapshot()).toBe(before);
  });
});

describe('no consent persistence', () => {
  it('never imports AsyncStorage or any storage API', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./mobile-ads-runtime-store.ts', import.meta.url), 'utf-8'),
    );

    expect(source).not.toContain('AsyncStorage');
    expect(source).not.toContain('async-storage');
  });
});

describe('raw native errors are not rendered', () => {
  it('start() resolves (never rejects) even when every native call fails', async () => {
    const consentClient = fakeConsentClient({
      gatherConsent: vi.fn(async () => {
        throw new Error('synthetic native failure with sensitive detail');
      }),
      getConsentInfo: vi.fn(async () => {
        throw new Error('synthetic native failure with sensitive detail');
      }),
    });
    const mobileAdsClient = fakeMobileAdsClient();
    const store = createMobileAdsRuntimeStore({ consentClient, mobileAdsClient });

    await expect(store.start()).resolves.toBeUndefined();
  });

  it('a failed initialize() never surfaces through the snapshot or a thrown error', async () => {
    const consentClient = fakeConsentClient({
      gatherConsent: vi.fn(async () => consentInfo({ canRequestAds: true })),
    });
    const mobileAdsClient = fakeMobileAdsClient({
      initialize: vi.fn(async () => {
        throw new Error('synthetic native initialize failure');
      }),
    });
    const store = createMobileAdsRuntimeStore({ consentClient, mobileAdsClient });

    await expect(store.start()).resolves.toBeUndefined();
    expect(store.getSnapshot().adsInitialized).toBe(false);
  });
});

describe('subscribe/getSnapshot', () => {
  it('notifies listeners only on a semantic transition, and getSnapshot returns a stable reference', async () => {
    const consentClient = fakeConsentClient({
      gatherConsent: vi.fn(async () => consentInfo({ canRequestAds: true })),
    });
    const store = createMobileAdsRuntimeStore({ consentClient, mobileAdsClient: fakeMobileAdsClient() });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    const before = store.getSnapshot();
    expect(store.getSnapshot()).toBe(before);

    await store.start();

    expect(listener.mock.calls.length).toBeGreaterThan(0);
    expect(store.getSnapshot()).not.toBe(before);

    unsubscribe();
  });

  it('isolates one throwing listener from the others', async () => {
    const consentClient = fakeConsentClient({
      gatherConsent: vi.fn(async () => consentInfo({ canRequestAds: true })),
    });
    const store = createMobileAdsRuntimeStore({ consentClient, mobileAdsClient: fakeMobileAdsClient() });
    const throwingListener = vi.fn(() => {
      throw new Error('synthetic listener failure');
    });
    const healthyListener = vi.fn();
    store.subscribe(throwingListener);
    store.subscribe(healthyListener);

    await expect(store.start()).resolves.toBeUndefined();

    expect(healthyListener).toHaveBeenCalled();
  });
});
