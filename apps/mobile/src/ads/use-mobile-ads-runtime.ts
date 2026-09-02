/**
 * Read-only React subscription boundary over the production mobile ads runtime store.
 *
 * Mirrors `../weather-query/use-mobile-weather-query`: this hook only subscribes and reads — it
 * owns no startup effect of its own. The startup contract (`.start()`) is triggered exactly once
 * from the root layout mount effect (`../app/_layout`), so any number of screens (Today, Settings)
 * can call this hook without duplicating that ownership or re-triggering UMP/native calls.
 */

import { useSyncExternalStore } from 'react';

import { mobileAdsRuntimeStore } from './mobile-ads-runtime-production';
import type { MobileAdsRuntimeSnapshot } from './mobile-ads-runtime-store';

function subscribeToMobileAdsRuntime(listener: () => void): () => void {
  return mobileAdsRuntimeStore.subscribe(listener);
}

function getMobileAdsRuntimeSnapshot(): MobileAdsRuntimeSnapshot {
  return mobileAdsRuntimeStore.getSnapshot();
}

/** Subscribe to the production mobile ads runtime store's exact cached snapshot reference. */
export function useMobileAdsRuntime(): MobileAdsRuntimeSnapshot {
  return useSyncExternalStore(
    subscribeToMobileAdsRuntime,
    getMobileAdsRuntimeSnapshot,
    getMobileAdsRuntimeSnapshot,
  );
}
