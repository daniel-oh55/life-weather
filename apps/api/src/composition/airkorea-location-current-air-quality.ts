/**
 * The **production composition root** for the PR #85 AirKorea *location* current air-quality
 * application pipeline. It is the entry point that assembles the three existing AirKorea
 * provider-from-env factories (PR #82/#83/#84) into a live
 * {@link AirKoreaLocationCurrentAirQualityService}, together with a live AirKorea source metadata
 * resolver:
 *
 * ```text
 * createAirKoreaTmCoordinateProviderFromEnv (PR #84)         → live TM-coordinate provider
 * createAirKoreaNearbyStationProviderFromEnv (PR #83)        → live nearby-station provider
 * createAirKoreaCurrentAirQualityProviderFromEnv (PR #82)    → live current-air-quality provider
 *
 * three providers → createAirKoreaLocationCurrentAirQualityService (PR #85)  → live application service
 * an injected/system clock → createAirKoreaLiveCurrentSourceMetadataResolver → live source metadata resolver
 * ```
 *
 * This is the AirKorea counterpart of the KMA `kma-scheduled-current-observation.ts` production
 * composition — a **separate**, parallel composition in its own provider namespace, not a
 * generalization of it. It does not re-implement any of the three PR #82/#83/#84 providers or the PR
 * #85 service — all four are built by their own existing factories, which this function consumes
 * verbatim. It reuses the existing `createKmaSystemClock` adapter for the source metadata resolver's
 * clock (the two clock ports are structurally identical — `nowEpochMilliseconds(): number` — the same
 * reuse precedent the KMA current-observation composition already established), rather than defining
 * a second, duplicate system-clock implementation.
 *
 * It is a **callable** composition function — never an import-time singleton. Importing this module
 * reads no environment, builds no provider, reads no clock, and starts no I/O; every dependency is
 * created only when {@link createAirKoreaLocationCurrentAirQualityCompositionFromEnv} is *called*, and
 * the first clock read and the first `fetch` happen only when the returned service's/resolver's method
 * runs.
 *
 * ## Provider construction order and config-failure pass-through
 *
 * The three provider factories are built in a fixed order — TM-coordinate, then nearby-station, then
 * current-air-quality — each reading **only** `AIRKOREA_SERVICE_KEY` from the same `env`. The first
 * `CONFIG_ERROR` encountered (by construction order) short-circuits: this composition returns a fresh
 * `{ ok: false, error }` carrying that provider factory's own {@link AirKoreaProviderConfigError} **by
 * reference**, and no further provider, the PR #85 service, the resolver clock, or the resolver itself
 * is built.
 *
 * ## Clock ownership
 *
 * The injected `dependencies.clock` (when supplied) is the source metadata resolver's clock — read
 * **zero** times at composition time. When omitted, this layer builds a **fresh**
 * {@link createKmaSystemClock} adapter dedicated to the resolver.
 *
 * ## No policy reimplementation
 *
 * This composition owns no AirKorea request/response rule, no transport, no TM-candidate or
 * closest-station resolution policy (both stay the PR #85 service's), and no provenance policy beyond
 * selecting the resolver's clock. It registers no HTTP route and does not wire
 * `apps/api/src/index.ts`. It does not modify `apps/api/src/providers/**`.
 */

import {
  createAirKoreaCurrentAirQualityProviderFromEnv,
  createAirKoreaNearbyStationProviderFromEnv,
  createAirKoreaTmCoordinateProviderFromEnv,
  type AirKoreaProviderConfigError,
} from '../providers/airkorea/index.js';
import {
  createAirKoreaLiveCurrentSourceMetadataResolver,
  createAirKoreaLocationCurrentAirQualityService,
  type AirKoreaCurrentSourceMetadataClock,
  type AirKoreaCurrentSourceMetadataResolver,
  type AirKoreaLocationCurrentAirQualityService,
} from '../services/index.js';
import { createKmaSystemClock } from './system-clock.js';

/**
 * The dependencies a caller may override for the composed AirKorea pipeline.
 *
 * - `fetchImpl` — forwarded unchanged to all three provider factories (omitted in production, so each
 *   provider uses `globalThis.fetch`).
 * - `clock` — the source metadata resolver's clock (omitted in production, so a fresh system clock
 *   adapter is used). Structurally identical to the KMA request-plan clock port.
 */
export type AirKoreaLocationCurrentAirQualityCompositionDependencies = {
  readonly fetchImpl?: typeof fetch;
  readonly clock?: AirKoreaCurrentSourceMetadataClock;
};

/**
 * The outcome of composing the AirKorea location current air-quality pipeline. On success it exposes
 * **only** the live application service and the live source metadata resolver — never the three
 * providers, the environment, `fetchImpl`, service key, or resolver clock, so the internal graph stays
 * encapsulated. On a provider-configuration failure it carries that provider factory's own
 * {@link AirKoreaProviderConfigError} **by reference**, unchanged.
 */
export type CreateAirKoreaLocationCurrentAirQualityCompositionResult =
  | {
      readonly ok: true;
      readonly service: AirKoreaLocationCurrentAirQualityService;
      readonly sourceMetadataResolver: AirKoreaCurrentSourceMetadataResolver;
    }
  | {
      readonly ok: false;
      readonly error: AirKoreaProviderConfigError;
    };

/**
 * Compose a live AirKorea location current air-quality application service (plus its live source
 * metadata resolver) from the environment and optional dependencies.
 *
 * Sequence:
 *
 * 1. Build the PR #84 TM-coordinate provider via {@link createAirKoreaTmCoordinateProviderFromEnv}. On
 *    a `CONFIG_ERROR`, return `{ ok: false, error }` immediately — the **same** error reference, with
 *    nothing else built.
 * 2. Build the PR #83 nearby-station provider via {@link createAirKoreaNearbyStationProviderFromEnv},
 *    same failure handling.
 * 3. Build the PR #82 current-air-quality provider via
 *    {@link createAirKoreaCurrentAirQualityProviderFromEnv}, same failure handling.
 * 4. Wire the three exact live provider references through the PR #85
 *    {@link createAirKoreaLocationCurrentAirQualityService}.
 * 5. Select the resolver's clock — the injected `dependencies.clock` reference when supplied, else a
 *    fresh {@link createKmaSystemClock} adapter — and build the live source metadata resolver. Neither
 *    the clock nor the resolver is invoked here.
 * 6. Return `{ ok: true, service, sourceMetadataResolver }`.
 *
 * Construction is side-effect-free beyond reading provider configuration: it reads no clock, issues no
 * network request, registers no listener, starts no timer, and logs nothing. Every call builds a fresh
 * dependency graph — there is no module-level singleton or shared cache.
 */
export function createAirKoreaLocationCurrentAirQualityCompositionFromEnv(
  env?: NodeJS.ProcessEnv,
  dependencies?: AirKoreaLocationCurrentAirQualityCompositionDependencies,
): CreateAirKoreaLocationCurrentAirQualityCompositionResult {
  // Step 1: PR #84 TM-coordinate provider.
  const tmCoordinateProviderResult = createAirKoreaTmCoordinateProviderFromEnv(env, {
    fetchImpl: dependencies?.fetchImpl,
  });
  if (!tmCoordinateProviderResult.ok) {
    return { ok: false, error: tmCoordinateProviderResult.error };
  }

  // Step 2: PR #83 nearby-station provider.
  const nearbyStationProviderResult = createAirKoreaNearbyStationProviderFromEnv(env, {
    fetchImpl: dependencies?.fetchImpl,
  });
  if (!nearbyStationProviderResult.ok) {
    return { ok: false, error: nearbyStationProviderResult.error };
  }

  // Step 3: PR #82 current-air-quality provider.
  const currentAirQualityProviderResult = createAirKoreaCurrentAirQualityProviderFromEnv(env, {
    fetchImpl: dependencies?.fetchImpl,
  });
  if (!currentAirQualityProviderResult.ok) {
    return { ok: false, error: currentAirQualityProviderResult.error };
  }

  // Step 4: wire the three exact live provider references through the PR #85 service factory.
  const service = createAirKoreaLocationCurrentAirQualityService(
    tmCoordinateProviderResult.provider,
    nearbyStationProviderResult.provider,
    currentAirQualityProviderResult.provider,
  );

  // Step 5: select the resolver clock (never read here) and build the live resolver.
  const sourceMetadataClock = dependencies?.clock ?? createKmaSystemClock();
  const sourceMetadataResolver = createAirKoreaLiveCurrentSourceMetadataResolver(
    sourceMetadataClock,
  );

  // Step 6: expose only the live service and resolver — the internal graph stays encapsulated.
  return {
    ok: true,
    service,
    sourceMetadataResolver,
  };
}
