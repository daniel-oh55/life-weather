import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// `react-native-google-mobile-ads` is replaced with a minimal marker component plus the real-shaped
// `BannerAdSize`/`TestIds` constants this module reads, matching the other component tests' approach
// of swapping native primitives for plain markers with no renderer involved.
// ---------------------------------------------------------------------------

const MockBannerAd = vi.hoisted(() => function MockBannerAd(): null {
  return null;
});

vi.mock('react-native-google-mobile-ads', () => ({
  BannerAd: MockBannerAd,
  BannerAdSize: { LARGE_ANCHORED_ADAPTIVE_BANNER: 'LARGE_ANCHORED_ADAPTIVE_BANNER' },
  TestIds: { ADAPTIVE_BANNER: 'ca-app-pub-3940256099942544/9214589741' },
}));

// ---------------------------------------------------------------------------
// The shared ads runtime hook is replaced with a call-recording mock, matching how the weather-query
// hook is mocked in the Today screen test — this file owns only the banner's own gating/unit-id
// logic, never the runtime store's own contract (covered by `mobile-ads-runtime-store.test.ts`).
// ---------------------------------------------------------------------------

const useMobileAdsRuntimeMock = vi.hoisted(() => vi.fn());

vi.mock('./use-mobile-ads-runtime', () => ({
  useMobileAdsRuntime: useMobileAdsRuntimeMock,
}));

const ORIGINAL_ENV = process.env.EXPO_PUBLIC_ADMOB_TODAY_BANNER_UNIT_ID;
const ORIGINAL_DEV = (globalThis as { __DEV__?: boolean }).__DEV__;

function setDev(value: boolean): void {
  (globalThis as { __DEV__?: boolean }).__DEV__ = value;
}

async function loadComponent() {
  const mod = await import('./today-banner-ad');
  return mod.TodayBannerAd;
}

beforeEach(() => {
  vi.resetModules();
  useMobileAdsRuntimeMock.mockReset();
  delete process.env.EXPO_PUBLIC_ADMOB_TODAY_BANNER_UNIT_ID;
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.EXPO_PUBLIC_ADMOB_TODAY_BANNER_UNIT_ID;
  } else {
    process.env.EXPO_PUBLIC_ADMOB_TODAY_BANNER_UNIT_ID = ORIGINAL_ENV;
  }
  setDev(ORIGINAL_DEV ?? true);
  vi.restoreAllMocks();
});

describe('ads not ready', () => {
  it('renders no BannerAd when canRequestAds is false', async () => {
    setDev(true);
    useMobileAdsRuntimeMock.mockReturnValue({ canRequestAds: false, adsInitialized: true });
    const TodayBannerAd = await loadComponent();

    expect(TodayBannerAd()).toBeNull();
  });

  it('renders no BannerAd when adsInitialized is false', async () => {
    setDev(true);
    useMobileAdsRuntimeMock.mockReturnValue({ canRequestAds: true, adsInitialized: false });
    const TodayBannerAd = await loadComponent();

    expect(TodayBannerAd()).toBeNull();
  });
});

describe('ready + __DEV__', () => {
  it('uses TestIds.ADAPTIVE_BANNER', async () => {
    setDev(true);
    useMobileAdsRuntimeMock.mockReturnValue({ canRequestAds: true, adsInitialized: true });
    const TodayBannerAd = await loadComponent();

    const element = TodayBannerAd() as { type: unknown; props: Record<string, unknown> };

    expect(element.type).toBe(MockBannerAd);
    expect(element.props.unitId).toBe('ca-app-pub-3940256099942544/9214589741');
  });
});

describe('ready + production', () => {
  it('uses the configured production unit ID when valid', async () => {
    setDev(false);
    process.env.EXPO_PUBLIC_ADMOB_TODAY_BANNER_UNIT_ID = 'ca-app-pub-1234567890123456/1234567890';
    useMobileAdsRuntimeMock.mockReturnValue({ canRequestAds: true, adsInitialized: true });
    const TodayBannerAd = await loadComponent();

    const element = TodayBannerAd() as { type: unknown; props: Record<string, unknown> };

    expect(element.type).toBe(MockBannerAd);
    expect(element.props.unitId).toBe('ca-app-pub-1234567890123456/1234567890');
  });

  it('renders no BannerAd when the non-dev unit ID is missing', async () => {
    setDev(false);
    delete process.env.EXPO_PUBLIC_ADMOB_TODAY_BANNER_UNIT_ID;
    useMobileAdsRuntimeMock.mockReturnValue({ canRequestAds: true, adsInitialized: true });
    const TodayBannerAd = await loadComponent();

    expect(TodayBannerAd()).toBeNull();
  });

  it('never substitutes the test banner ID in a non-dev runtime with a missing unit ID', async () => {
    setDev(false);
    delete process.env.EXPO_PUBLIC_ADMOB_TODAY_BANNER_UNIT_ID;
    useMobileAdsRuntimeMock.mockReturnValue({ canRequestAds: true, adsInitialized: true });
    const TodayBannerAd = await loadComponent();

    expect(TodayBannerAd()).not.toEqual(
      expect.objectContaining({ props: expect.objectContaining({ unitId: expect.stringContaining('3940256099942544') }) }),
    );
  });

  it('renders no BannerAd when the non-dev unit ID is a Google sample/test ID', async () => {
    setDev(false);
    process.env.EXPO_PUBLIC_ADMOB_TODAY_BANNER_UNIT_ID = 'ca-app-pub-3940256099942544/9214589741';
    useMobileAdsRuntimeMock.mockReturnValue({ canRequestAds: true, adsInitialized: true });
    const TodayBannerAd = await loadComponent();

    expect(TodayBannerAd()).toBeNull();
  });
});

describe('adaptive banner size', () => {
  it('always uses BannerAdSize.LARGE_ANCHORED_ADAPTIVE_BANNER', async () => {
    setDev(true);
    useMobileAdsRuntimeMock.mockReturnValue({ canRequestAds: true, adsInitialized: true });
    const TodayBannerAd = await loadComponent();

    const element = TodayBannerAd() as { props: Record<string, unknown> };

    expect(element.props.size).toBe('LARGE_ANCHORED_ADAPTIVE_BANNER');
  });
});

describe('no location/keyword targeting', () => {
  it('passes no requestOptions to BannerAd', async () => {
    setDev(true);
    useMobileAdsRuntimeMock.mockReturnValue({ canRequestAds: true, adsInitialized: true });
    const TodayBannerAd = await loadComponent();

    const element = TodayBannerAd() as { props: Record<string, unknown> };

    expect(element.props.requestOptions).toBeUndefined();
  });
});
