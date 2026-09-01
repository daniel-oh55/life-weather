/**
 * Provider-neutral mobile ads runtime store.
 *
 * Owns the smallest cohesive state Today's banner and Settings' privacy-options control both need:
 * UMP `canRequestAds`, whether the Google Mobile Ads SDK has finished initializing, and whether UMP
 * currently reports the privacy-options control as `REQUIRED`. It never persists consent itself —
 * the injected {@link MobileAdsConsentClient} (the native UMP SDK in production) owns that — and it
 * never touches on-device storage, React, or `process.env`.
 *
 * Startup contract (driven once by {@link MobileAdsRuntimeStore.start}, called from the root layout
 * mount effect): gather current UMP consent; on failure, fall back to the SDK's own
 * current/previous-session consent info instead of assuming consent either way; initialize the
 * Google Mobile Ads SDK at most once, and only once `canRequestAds` is true. A gather/update failure
 * never throws out of this store and never auto-allows ads — `canRequestAds` is exactly whatever the
 * (possibly previous-session) consent info says.
 */

/** UMP's own `privacyOptionsRequirementStatus`, verbatim — never interpreted further here. */
export type MobileAdsPrivacyOptionsRequirementStatus = 'REQUIRED' | 'NOT_REQUIRED' | 'UNKNOWN';

/** The subset of a UMP `AdsConsentInfo` this store reads. Never retained beyond this shape. */
export interface MobileAdsConsentInfo {
  readonly canRequestAds: boolean;
  readonly privacyOptionsRequirementStatus: MobileAdsPrivacyOptionsRequirementStatus;
}

/** The UMP surface this store depends on. Production wiring lives in `./mobile-ads-runtime-production`. */
export interface MobileAdsConsentClient {
  /** Combines requesting consent info and showing a consent form if required, in one call. */
  gatherConsent(): Promise<MobileAdsConsentInfo>;
  /** Reads current/previous-session consent info without triggering a new gather. */
  getConsentInfo(): Promise<MobileAdsConsentInfo>;
  /** Presents the privacy-options form. Resolves with the refreshed consent info. */
  showPrivacyOptionsForm(): Promise<MobileAdsConsentInfo>;
}

/** The Google Mobile Ads SDK surface this store depends on. */
export interface MobileAdsSdkClient {
  initialize(): Promise<unknown>;
}

/** Published snapshot. Ads are renderable only when both booleans are true. */
export interface MobileAdsRuntimeSnapshot {
  readonly canRequestAds: boolean;
  readonly adsInitialized: boolean;
  readonly privacyOptionsRequired: boolean;
}

export interface MobileAdsRuntimeStoreDependencies {
  readonly consentClient: MobileAdsConsentClient;
  readonly mobileAdsClient: MobileAdsSdkClient;
}

export interface MobileAdsRuntimeStore {
  /** The cached snapshot. Returns the exact same object reference until a semantic transition. */
  getSnapshot(): MobileAdsRuntimeSnapshot;
  /** Register a listener called only on a semantic transition. Returns an idempotent unsubscribe. */
  subscribe(listener: () => void): () => void;
  /**
   * Run the startup consent/initialize contract at most once for this store instance — every call
   * (including concurrent/repeated ones) returns the exact same `Promise`.
   */
  start(): Promise<void>;
  /**
   * Present the UMP privacy-options form. Refreshes `canRequestAds`/`privacyOptionsRequired` from
   * its result and initializes ads if newly allowed and not already initialized. Never throws — a
   * native failure leaves the snapshot unchanged.
   */
  openPrivacyOptions(): Promise<void>;
}

const INITIAL_SNAPSHOT: MobileAdsRuntimeSnapshot = Object.freeze({
  canRequestAds: false,
  adsInitialized: false,
  privacyOptionsRequired: false,
});

function snapshotsEqual(a: MobileAdsRuntimeSnapshot, b: MobileAdsRuntimeSnapshot): boolean {
  return (
    a.canRequestAds === b.canRequestAds &&
    a.adsInitialized === b.adsInitialized &&
    a.privacyOptionsRequired === b.privacyOptionsRequired
  );
}

/** Build a {@link MobileAdsRuntimeStore}. Construction has no side effects — no native call. */
export function createMobileAdsRuntimeStore(
  deps: MobileAdsRuntimeStoreDependencies,
): MobileAdsRuntimeStore {
  const { consentClient, mobileAdsClient } = deps;

  let cachedSnapshot: MobileAdsRuntimeSnapshot = INITIAL_SNAPSHOT;
  const listeners = new Set<() => void>();
  let startPromise: Promise<void> | null = null;
  let initializingPromise: Promise<void> | null = null;

  function notifyListeners(): void {
    for (const listener of Array.from(listeners)) {
      try {
        listener();
      } catch {
        // Isolated intentionally: one listener's throw must not affect the others.
      }
    }
  }

  function publish(next: MobileAdsRuntimeSnapshot): void {
    if (snapshotsEqual(cachedSnapshot, next)) {
      return;
    }
    cachedSnapshot = Object.freeze(next);
    notifyListeners();
  }

  function applyConsentInfo(info: MobileAdsConsentInfo): void {
    publish({
      canRequestAds: info.canRequestAds,
      adsInitialized: cachedSnapshot.adsInitialized,
      privacyOptionsRequired: info.privacyOptionsRequirementStatus === 'REQUIRED',
    });
  }

  /**
   * Initializes the Google Mobile Ads SDK at most once, only while `canRequestAds` is true.
   * Concurrent/repeated calls while an attempt is in flight join that same attempt; calls after
   * `adsInitialized` is already true are a no-op. A failed attempt leaves `adsInitialized` false and
   * is never retried automatically — only a later distinct trigger (a fresh `start()`/
   * `openPrivacyOptions()` call) may attempt again.
   */
  function maybeInitializeAds(): Promise<void> {
    if (cachedSnapshot.adsInitialized) {
      return Promise.resolve();
    }
    if (!cachedSnapshot.canRequestAds) {
      return Promise.resolve();
    }
    if (initializingPromise !== null) {
      return initializingPromise;
    }
    initializingPromise = (async () => {
      try {
        await mobileAdsClient.initialize();
        publish({ ...cachedSnapshot, adsInitialized: true });
      } catch {
        // Swallowed intentionally: no raw native error is ever surfaced, and no retry loop.
      } finally {
        initializingPromise = null;
      }
    })();
    return initializingPromise;
  }

  async function gatherStartupConsentInfo(): Promise<MobileAdsConsentInfo> {
    try {
      return await consentClient.gatherConsent();
    } catch {
      // Follows UMP's previous-session consent model: a failed gather/update never auto-allows
      // ads — fall back to whatever current/previous-session info the SDK itself reports.
      try {
        return await consentClient.getConsentInfo();
      } catch {
        return { canRequestAds: false, privacyOptionsRequirementStatus: 'UNKNOWN' };
      }
    }
  }

  return {
    getSnapshot(): MobileAdsRuntimeSnapshot {
      return cachedSnapshot;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    start(): Promise<void> {
      if (startPromise !== null) {
        return startPromise;
      }
      startPromise = (async () => {
        const info = await gatherStartupConsentInfo();
        applyConsentInfo(info);
        await maybeInitializeAds();
      })();
      return startPromise;
    },

    async openPrivacyOptions(): Promise<void> {
      let info: MobileAdsConsentInfo;
      try {
        info = await consentClient.showPrivacyOptionsForm();
      } catch {
        // Never throws through to the caller, and never exposes the raw native error.
        return;
      }
      applyConsentInfo(info);
      await maybeInitializeAds();
    },
  };
}
