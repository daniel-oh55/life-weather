/**
 * The AirKorea (에어코리아) current air-quality **live source metadata resolver**: the production
 * {@link AirKoreaCurrentSourceMetadataResolver} that materializes the three provenance facts
 * `weather-overview-air-quality-overlay.ts`'s {@link AirKoreaCurrentSourceMetadataInput} needs
 * (`sourceId`/`fetchedAt`/`retrievalMode`).
 *
 * This is the AirKorea counterpart of the KMA `kma-current-source-metadata.ts`
 * (`createKmaLiveCurrentSourceMetadataResolver`). It follows the same injected-clock,
 * static-`RangeError`, fresh-object shape, but is a separate, parallel implementation in its own
 * provider namespace — it is not generalized with the KMA resolver into a shared cross-provider
 * abstraction.
 *
 * ### What it decides
 *
 * Like the KMA current resolver, this resolver is a **nullary** function — every fact it produces is
 * either a fixed constant or the injected clock:
 *
 * - `sourceId` is a fixed, app-internal, canonical identifier for AirKorea current air-quality —
 *   `'airkorea-current-air-quality'`. It encodes **no** station name, TM coordinate, administrative
 *   name, or other location trace — the logical source is `sourceId`; the individual measurement
 *   instant is `CurrentAirQuality.measuredAt`, which this resolver never reads.
 * - `retrievalMode` is fixed `'LIVE'` — this resolver is the live AirKorea provider pipeline's
 *   resolver and never returns `'CACHE'`/`'UNKNOWN'`.
 * - `fetchedAt` is the server time at which this resolver **materialized** live source metadata
 *   provenance, read from the injected clock **exactly once** per valid resolver call.
 *
 * `provider`, `sections`, `issuedAt`, and `SourceMetadata.observedAt` are **not** decided here —
 * `weather-overview-air-quality-overlay.ts`'s overlay fixes those from AirKorea current-data
 * semantics (`provider: 'AIR_KOREA'`, `sections: ['AIR_QUALITY_CURRENT']`, `issuedAt: null`,
 * `observedAt: CurrentAirQuality.measuredAt`).
 *
 * ### Error boundary
 *
 * A resolver produced by {@link createAirKoreaLiveCurrentSourceMetadataResolver} is **synchronous**:
 * every clock-value validation failure and a throwing injected clock propagate synchronously as the
 * **same** error reference (no broad `try`/`catch`, wrapping, result union, logging, fallback
 * metadata, or partial metadata). The clock is read **exactly once** per call; an invalid value
 * *returned by* the clock is rejected **after** that single read, with a **static** {@link RangeError}
 * that never includes the raw malformed value in its message.
 *
 * ### Purity, immutability, freshness
 *
 * Construction reads no clock/environment/network, builds no `Date`, and holds no state or cache —
 * the factory merely closes over the clock. Each valid call returns a **fresh** object with exactly
 * the three sorted own keys `fetchedAt`/`retrievalMode`/`sourceId`.
 *
 * ### Boundary — what it is not
 *
 * It performs **no** provider call, station/TM resolution, application-service call, composition
 * wiring, HTTP route, or cache. It reads no `process.env`, opens no `fetch`/`AbortController`, and
 * imports no external timezone/date library or new dependency. It is not a generic cross-provider
 * metadata framework — this file does not import or share implementation with the KMA current
 * resolver, per the project's provider-namespace isolation policy.
 */

import { isoDateTime, type SourceMetadata } from '@life-weather/contracts';

import type { AirKoreaCurrentSourceMetadataInput } from './weather-overview-air-quality-overlay.js';

/**
 * The injected clock the resolver reads to stamp `fetchedAt`. Structurally identical to the KMA
 * `KmaCurrentSourceMetadataClock` (`nowEpochMilliseconds()` → integer epoch milliseconds), but kept a
 * distinct type so the seam is named for this resolver's AirKorea role. It is read **exactly once**
 * per valid resolver call and **zero** times at construction.
 */
export interface AirKoreaCurrentSourceMetadataClock {
  readonly nowEpochMilliseconds: () => number;
}

/**
 * A live AirKorea current source metadata resolver: a nullary function returning a fresh
 * {@link AirKoreaCurrentSourceMetadataInput} every call.
 */
export type AirKoreaCurrentSourceMetadataResolver = () => AirKoreaCurrentSourceMetadataInput;

/** The fixed, canonical app-internal `sourceId` for AirKorea current air-quality. */
const AIR_QUALITY_CURRENT_SOURCE_ID = 'airkorea-current-air-quality';

/** Static message for a clock value that cannot become a valid ISO `fetchedAt`. */
const INVALID_CLOCK_MESSAGE = 'Invalid AirKorea current source metadata clock value';

/**
 * Format an epoch-milliseconds value into the UTC `fetchedAt` ISO instant. The value must be a safe
 * integer that maps to a valid `Date`; `date.toISOString()` yields UTC `Z` with exactly three
 * fractional digits, which is confirmed with the contracts public `isoDateTime` schema. An unusable
 * value (`NaN`/`±Infinity`/fractional/unsafe integer/out-of-`Date`-range/ISO-contract-rejected)
 * throws a **static** {@link RangeError} — the raw value is never included in the message.
 * Module-local; never exported.
 */
function formatAirKoreaCurrentFetchedAt(
  epochMilliseconds: number,
): SourceMetadata['fetchedAt'] {
  if (!Number.isSafeInteger(epochMilliseconds)) {
    throw new RangeError(INVALID_CLOCK_MESSAGE);
  }

  const date = new Date(epochMilliseconds);
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError(INVALID_CLOCK_MESSAGE);
  }

  const parsed = isoDateTime.safeParse(date.toISOString());
  if (!parsed.success) {
    throw new RangeError(INVALID_CLOCK_MESSAGE);
  }

  return parsed.data;
}

/**
 * Create the live AirKorea current source metadata resolver, bound to an injected
 * {@link AirKoreaCurrentSourceMetadataClock}.
 *
 * Construction is side-effect-free: it reads the clock zero times, touches no
 * environment/network, builds no `Date`, and holds no state or cache — it merely closes over the
 * clock.
 *
 * Each call reads the injected clock **exactly once**, formats it into `fetchedAt`, and returns a
 * fresh object with exactly the three sorted own keys `fetchedAt`/`retrievalMode`/`sourceId` —
 * `sourceId` fixed to the canonical AirKorea current-air-quality identifier and `retrievalMode` fixed
 * `'LIVE'`. An invalid clock value or a throwing clock propagates synchronously (same error
 * reference) after that single read.
 */
export function createAirKoreaLiveCurrentSourceMetadataResolver(
  clock: AirKoreaCurrentSourceMetadataClock,
): AirKoreaCurrentSourceMetadataResolver {
  return () => {
    const fetchedAt = formatAirKoreaCurrentFetchedAt(clock.nowEpochMilliseconds());

    return {
      fetchedAt,
      retrievalMode: 'LIVE',
      sourceId: AIR_QUALITY_CURRENT_SOURCE_ID,
    };
  };
}
