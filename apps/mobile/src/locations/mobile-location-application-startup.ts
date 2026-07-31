/**
 * App-level, one-shot startup boundary that sequences the two independent app-start reads the
 * location boundary owns: saved-location hydration, then selected-location initialization.
 *
 * This module owns exactly one concern: running that two-step sequence **at most once** per module
 * lifetime, no matter how many times {@link startMobileLocationApplicationOnce} is invoked —
 * concurrently, repeatedly while pending, or repeatedly after the sequence has settled. It does not
 * retry, does not duplicate any policy already owned elsewhere, and calls only the two existing
 * public entry points those boundaries already expose:
 *
 * 1. {@link startMobileSavedLocationHydrationOnce} — the existing one-shot saved-location hydration
 *    boundary (`./mobile-saved-location-hydration-startup`). Its own exact one-shot Promise contract
 *    is untouched: this module calls it, never re-implements it, and never calls the hydration
 *    **store** or **manager** directly.
 * 2. {@link mobileSavedLocationApplicationStore.initializeSelectedLocation} — started only **after**
 *    that saved-location hydration promise settles, and only when it settled successfully. If saved
 *    hydration ends in `ERROR`, selected-location initialization is not started here (a later
 *    explicit `retryInitialization()` call, from the UI, is what tries again).
 *
 * Out of scope here (later PRs): explicit user-triggered retry (`mobileSavedLocationApplicationStore
 * .retryInitialization()` is called directly by the UI, not through this module), React state /
 * hooks / context, screens, navigation, and any logging/telemetry.
 */

import { mobileSavedLocationApplicationStore } from './mobile-saved-location-application-production';
import { startMobileSavedLocationHydrationOnce } from './mobile-saved-location-hydration-startup';

let startupPromise: Promise<void> | null = null;

async function runStartupSequence(): Promise<void> {
  await startMobileSavedLocationHydrationOnce();

  const snapshot = mobileSavedLocationApplicationStore.getSnapshot();
  if (snapshot.status === 'ERROR') {
    return;
  }

  await mobileSavedLocationApplicationStore.initializeSelectedLocation();
}

/**
 * Start the combined saved-location-hydration-then-selected-location-initialization sequence
 * exactly once per module lifetime.
 *
 * The first call starts the sequence and stores its promise. Every call after that — concurrent,
 * while still pending, or after the sequence has settled — returns that exact same promise
 * reference without starting a new sequence. Neither step's own promise ever rejects, so this
 * function performs no additional error handling of its own and never rejects either.
 */
export function startMobileLocationApplicationOnce(): Promise<void> {
  if (startupPromise !== null) {
    return startupPromise;
  }

  startupPromise = runStartupSequence();
  return startupPromise;
}
