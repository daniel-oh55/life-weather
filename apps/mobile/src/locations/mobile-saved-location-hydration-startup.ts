/**
 * App-start, one-shot boundary over the saved-location hydration production store.
 *
 * This module owns exactly one concern: making sure the real
 * {@link mobileSavedLocationHydrationStore.hydrate} call happens **at most once** per module
 * lifetime, no matter how many times {@link startMobileSavedLocationHydrationOnce} is invoked —
 * concurrently, repeatedly while pending, or repeatedly after the first attempt has settled
 * (`EMPTY` / `READY` / `ERROR` alike). It does not retry, does not copy or reinterpret store/manager
 * state, and does not redefine any error kind, storage key, or retry policy — those all remain owned
 * by the production composition, the hydration manager, and the observable store it wires together.
 *
 * This module calls the **store**, not the manager, directly — so any subscriber observing the
 * store (via `subscribe`/`getSnapshot`) sees the same `LOADING`/terminal transitions this startup
 * call drives, rather than a manager-level call the store would never learn about.
 *
 * Out of scope here (later PRs): explicit user-triggered retry (a separate caller of
 * {@link mobileSavedLocationHydrationStore.hydrate} directly), React state/hooks/context, screens,
 * navigation, logging/telemetry, and any environment/clock/random/network access.
 */

import { mobileSavedLocationHydrationStore } from './mobile-saved-location-hydration-production';

let startupHydrationPromise: Promise<void> | null = null;

/**
 * Start saved-location hydration exactly once per module lifetime.
 *
 * The first call starts the real {@link mobileSavedLocationHydrationStore.hydrate} attempt and
 * stores its promise. Every call after that — concurrent, while still pending, or after the first
 * attempt has settled to `EMPTY` / `READY` / `ERROR` — returns that exact same promise reference
 * without starting a new hydration. The store forwards the manager's own guarantee that `hydrate()`
 * never rejects, so this function performs no additional error handling of its own.
 *
 * An explicit retry after a first `ERROR` is intentionally **not** implemented here — this function
 * only ever starts the first attempt. A future explicit retry should call
 * {@link mobileSavedLocationHydrationStore.hydrate} directly (not the underlying manager), so
 * subscription consistency is preserved.
 */
export function startMobileSavedLocationHydrationOnce(): Promise<void> {
  if (startupHydrationPromise !== null) {
    return startupHydrationPromise;
  }

  startupHydrationPromise = mobileSavedLocationHydrationStore.hydrate();
  return startupHydrationPromise;
}
