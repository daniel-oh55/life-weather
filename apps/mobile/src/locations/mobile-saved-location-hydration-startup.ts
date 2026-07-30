/**
 * App-start, one-shot boundary over the saved-location hydration production composition.
 *
 * This module owns exactly one concern: making sure the real
 * {@link mobileSavedLocationHydrationManager.hydrate} call happens **at most once** per module
 * lifetime, no matter how many times {@link startMobileSavedLocationHydrationOnce} is invoked —
 * concurrently, repeatedly while pending, or repeatedly after the first attempt has settled
 * (`EMPTY` / `READY` / `ERROR` alike). It does not retry, does not copy or reinterpret manager
 * state, and does not redefine any error kind, storage key, or retry policy — those all remain
 * owned by the production composition and the hydration manager it wires together.
 *
 * Out of scope here (later PRs): explicit user-triggered retry (a separate caller of
 * {@link mobileSavedLocationHydrationManager.hydrate} directly), React state/hooks/context,
 * screens, navigation, logging/telemetry, and any environment/clock/random/network access.
 */

import { mobileSavedLocationHydrationManager } from './mobile-saved-location-hydration-production';

let startupHydrationPromise: Promise<void> | null = null;

/**
 * Start saved-location hydration exactly once per module lifetime.
 *
 * The first call starts the real {@link mobileSavedLocationHydrationManager.hydrate} attempt and
 * stores its promise. Every call after that — concurrent, while still pending, or after the first
 * attempt has settled to `EMPTY` / `READY` / `ERROR` — returns that exact same promise reference
 * without starting a new hydration. The manager's own contract guarantees `hydrate()` never
 * rejects, so this function performs no additional error handling of its own.
 */
export function startMobileSavedLocationHydrationOnce(): Promise<void> {
  if (startupHydrationPromise !== null) {
    return startupHydrationPromise;
  }

  startupHydrationPromise = mobileSavedLocationHydrationManager.hydrate();
  return startupHydrationPromise;
}
