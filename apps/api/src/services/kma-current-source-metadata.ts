/**
 * The KMA (기상청) current-observation (초단기실황) **live current source metadata resolver**: the
 * production {@link KmaCurrentSourceMetadataResolver} that materializes the three provenance facts
 * `kma-current-weather-overview.ts`'s {@link KmaCurrentSourceMetadataInput} needs
 * (`sourceId`/`fetchedAt`/`retrievalMode`).
 *
 * This is the current-observation counterpart of `kma-selected-hourly-source-metadata.ts`
 * (`createKmaLiveSelectedHourlySourceMetadataResolver`). It follows the same injected-clock,
 * static-`RangeError`, fresh-object shape, but is a separate, parallel implementation: current and
 * forecast provenance semantics differ (current has no `issuedAt`, no `PRIMARY`/`PREVIOUS`
 * selection, no issuance identity), so this resolver is not generalized with the hourly resolver
 * into a shared abstraction.
 *
 * ### What it decides
 *
 * Unlike the hourly resolver, this resolver takes **no input** — it is a nullary function. Every
 * fact it can decide is either a fixed constant or the injected clock:
 *
 * - `sourceId` is a fixed, app-internal, canonical identifier for the KMA 초단기실황
 *   (`getUltraSrtNcst`) endpoint — `'kma-ultra-short-current-observation'`. It encodes **no**
 *   location, coordinate, grid cell, base date/time, observation instant, request identity, or
 *   selection state — the logical source is `sourceId`; the individual observation instant is
 *   `CurrentWeather.observedAt`, which this resolver never reads.
 * - `retrievalMode` is fixed `'LIVE'` — this resolver is the live KMA provider pipeline's resolver
 *   and never returns `'CACHE'`/`'UNKNOWN'`.
 * - `fetchedAt` is the server time at which this resolver **materialized** live source metadata
 *   provenance, read from the injected clock **exactly once** per valid resolver call.
 *
 * `provider`, `sections`, `issuedAt`, and `SourceMetadata.observedAt` are **not** decided here —
 * `kma-current-weather-overview.ts`'s assembler fixes those from current-data semantics
 * (`provider: 'KMA'`, `sections: ['CURRENT']`, `issuedAt: null`,
 * `observedAt: CurrentWeather.observedAt`).
 *
 * ### `fetchedAt` semantics — resolver materialization time, not exact transport time
 *
 * `fetchedAt` here means "the server time at which this resolver materialized live source metadata
 * provenance". It is deliberately **not** the HTTP request-dispatch time, the response-header-
 * received time, the body-read-start time, or the exact provider transport-completion timestamp —
 * the current-observation pipeline preserves no such per-request transport timestamp, so the
 * resolver-call instant is the honest, available approximation. A future cache layer will **not**
 * reuse this live resolver: it must preserve the stored upstream `fetchedAt` and report
 * `retrievalMode: 'CACHE'`, never overwriting the upstream `fetchedAt` with the cache-read instant.
 * No cache is implemented in this PR.
 *
 * ### Error boundary
 *
 * A resolver produced by {@link createKmaLiveCurrentSourceMetadataResolver} is **synchronous**:
 * every clock-value validation failure and a throwing injected clock propagate synchronously as the
 * **same** error reference (no broad `try`/`catch`, wrapping, result union, logging, fallback
 * metadata, or partial metadata). The clock is read **exactly once** per call; an invalid value
 * *returned by* the clock is rejected **after** that single read (the value has to be read before it
 * can be judged), with a **static** {@link RangeError} that never includes the raw malformed value in
 * its message. A clock that itself throws propagates its own error reference after that same one
 * read.
 *
 * ### Purity, immutability, freshness
 *
 * Construction reads no clock/environment/network, builds no `Date`, and holds no state or cache —
 * the factory merely closes over the clock. Each valid call returns a **fresh** object with exactly
 * the three sorted own keys `fetchedAt`/`retrievalMode`/`sourceId` — a different wrapper reference
 * even for identical clock values across two calls.
 *
 * ### Boundary — what it is not
 *
 * It performs **no** provider call, request-factory call, base-time selector call, location→grid
 * conversion, current-observation service call, facade/composition wiring, HTTP route, or cache. It
 * reads no `process.env`, opens no `fetch`/`AbortController`, and imports no external timezone/date
 * library or new dependency. It is not wired into any application orchestration, production
 * composition, or `POST /weather` route in this PR — see `docs/kma-current-source-metadata.md`.
 */

import { isoDateTime, type SourceMetadata } from '@life-weather/contracts';

import type { KmaCurrentSourceMetadataInput } from './kma-current-weather-overview.js';

/**
 * The injected clock the resolver reads to stamp `fetchedAt`. Structurally identical to the
 * `KmaSelectedHourlySourceMetadataClock` the hourly resolver uses (`nowEpochMilliseconds()` →
 * integer epoch milliseconds), but kept a distinct type so the seam is named for this resolver's
 * current-observation role. It is read **exactly once** per valid resolver call and **zero** times
 * at construction.
 */
export interface KmaCurrentSourceMetadataClock {
  readonly nowEpochMilliseconds: () => number;
}

/**
 * A live current source metadata resolver: a nullary function returning a fresh
 * {@link KmaCurrentSourceMetadataInput} every call.
 */
export type KmaCurrentSourceMetadataResolver = () => KmaCurrentSourceMetadataInput;

/** The fixed, canonical app-internal `sourceId` for the KMA 초단기실황 (`getUltraSrtNcst`) endpoint. */
const CURRENT_OBSERVATION_SOURCE_ID = 'kma-ultra-short-current-observation';

/** Static message for a clock value that cannot become a valid ISO `fetchedAt`. */
const INVALID_CLOCK_MESSAGE = 'Invalid KMA current source metadata clock value';

/**
 * Format an epoch-milliseconds value into the UTC `fetchedAt` ISO instant. The value must be a safe
 * integer that maps to a valid `Date`; `date.toISOString()` yields UTC `Z` with exactly three
 * fractional digits, which is confirmed with the contracts public `isoDateTime` schema. An unusable
 * value (`NaN`/`±Infinity`/fractional/unsafe integer/out-of-`Date`-range/ISO-contract-rejected)
 * throws a **static** {@link RangeError} — the raw value is never included in the message.
 * Module-local; never exported.
 */
function formatKmaCurrentFetchedAt(
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
 * Create the live current source metadata resolver, bound to an injected
 * {@link KmaCurrentSourceMetadataClock}.
 *
 * Construction is side-effect-free: it reads the clock zero times, touches no
 * environment/network, builds no `Date`, and holds no state or cache — it merely closes over the
 * clock.
 *
 * Each call reads the injected clock **exactly once**, formats it into `fetchedAt`, and returns a
 * fresh object with exactly the three sorted own keys `fetchedAt`/`retrievalMode`/`sourceId` —
 * `sourceId` fixed to the canonical current-observation identifier and `retrievalMode` fixed
 * `'LIVE'`. An invalid clock value or a throwing clock propagates synchronously (same error
 * reference) after that single read.
 */
export function createKmaLiveCurrentSourceMetadataResolver(
  clock: KmaCurrentSourceMetadataClock,
): KmaCurrentSourceMetadataResolver {
  return () => {
    const fetchedAt = formatKmaCurrentFetchedAt(clock.nowEpochMilliseconds());

    return {
      fetchedAt,
      retrievalMode: 'LIVE',
      sourceId: CURRENT_OBSERVATION_SOURCE_ID,
    };
  };
}
