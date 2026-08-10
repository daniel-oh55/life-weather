/**
 * The KMA (기상청) **current + hourly `WeatherOverview` aggregate assembler**: a pure, synchronous
 * function that combines an already-computed PR #24 hourly overview success with an optional
 * already-computed PR #74 current overview success into a single current+hourly partial
 * {@link WeatherOverview}.
 *
 * The hourly application service and the current application service are independent production
 * pipelines — neither calls the other, and this assembler does not call either of them. It only
 * consumes their already-produced `{ ok: true, overview }` results (via the module-local
 * `KmaHourlyOverviewSuccess`/`KmaCurrentOverviewSuccess` narrowings of their public result unions) and
 * composes the two partial overviews it receives.
 *
 * ### Baseline and overlay
 *
 * The hourly success overview (`input.hourly.overview`) is the baseline for every non-current section:
 * `hourly`, `daily`, `airQuality`, `alerts`, and the non-CURRENT `missingSections`/sources are taken from
 * it verbatim, without re-running selection, fallback, provenance resolution, or provider policy. Only
 * `input.hourly.overview` is read — `input.hourly.selection` (the PR #22 execution trace) is never
 * inspected.
 *
 * `input.current === null` means only that the caller already decided no current section will be
 * contributed to this aggregate; this assembler never inspects or infers *why* (LOCATION, PROVIDER, or
 * NORMALIZATION failure, or any other reason) — that policy belongs to a later application
 * orchestration. When `current` is `null` the aggregate is semantically the hourly baseline unchanged
 * (returned as a fresh, schema-validated value, never the caller's object reference). When `current` is
 * present, its `overview.current` and `overview.sources` overlay the baseline: `current` becomes
 * present, `CURRENT` is removed from the baseline's `missingSections` (and nothing else changes), and
 * `sources` becomes the current overview's sources followed by the baseline's sources — deterministic
 * order, no sort/dedupe/merge of individual `SourceMetadata` entries.
 *
 * ### Location consistency
 *
 * When `current` is present, the two overviews must describe the same {@link WeatherLocation} **by
 * value** (every contract field, not object identity — the two source assemblers independently produce
 * fresh parsed objects). A mismatch throws a synchronous, static, value-free `RangeError` before any
 * output is built.
 *
 * ### Purity and validation
 *
 * Synchronous and pure: no `Promise`, no network/Provider/service call, no clock/environment/
 * `AbortSignal` read, no logging, no cache/singleton/mutable state, no broad `try`/`catch`. It mutates
 * neither input, allocates a fresh output every call, and validates the assembled payload with
 * `weatherOverview.parse` — the sole runtime invariant guard — before returning it.
 *
 * This assembler does not decide current-failure degradation policy, does not implement
 * concurrency/ordering/retry/cache, and is not wired into any route, composition root, or presenter.
 * See `docs/kma-current-hourly-weather-overview.md`.
 */

import {
  weatherOverview,
  type WeatherLocation,
  type WeatherOverview,
} from '@life-weather/contracts';

import type { KmaLocationCurrentOverviewResult } from './kma-location-current-overview.js';
import type { KmaLocationHourlyOverviewResult } from './kma-location-hourly-overview.js';

/**
 * The hourly application service's success arm. Only `overview` is ever read by this assembler —
 * `selection` (the PR #22 execution trace) is never consumed.
 */
type KmaHourlyOverviewSuccess = Extract<
  KmaLocationHourlyOverviewResult,
  { readonly ok: true }
>;

/** The current application service's success arm. */
type KmaCurrentOverviewSuccess = Extract<
  KmaLocationCurrentOverviewResult,
  { readonly ok: true }
>;

/**
 * The aggregate assembler input: an already-computed hourly overview success (required), and an
 * already-computed current overview success, or `null` when the caller has already decided that no
 * current section will be contributed to this aggregate. This assembler never inspects why `current` is
 * `null` — that policy belongs to a later application orchestration.
 */
export interface KmaCurrentHourlyWeatherOverviewInput {
  readonly hourly: KmaHourlyOverviewSuccess;
  readonly current: KmaCurrentOverviewSuccess | null;
}

/**
 * Compare two {@link WeatherLocation} values field-by-field — exact, normalized contract-value
 * equality, no coordinate tolerance, no locale-dependent comparison, no `JSON.stringify` shortcut.
 * Module-local; never exported.
 */
function isSameWeatherLocation(a: WeatherLocation, b: WeatherLocation): boolean {
  return (
    a.id === b.id &&
    a.displayName === b.displayName &&
    a.countryCode === b.countryCode &&
    a.adminArea1 === b.adminArea1 &&
    a.adminArea2 === b.adminArea2 &&
    a.adminArea3 === b.adminArea3 &&
    a.latitude === b.latitude &&
    a.longitude === b.longitude &&
    a.timezone === b.timezone
  );
}

/**
 * Assemble a current+hourly partial {@link WeatherOverview} from an already-computed hourly overview
 * success and an optional already-computed current overview success.
 *
 * The hourly overview (`input.hourly.overview`) is the baseline for every section this assembler does
 * not own. When `input.current` is `null` the baseline is returned unchanged (as a fresh,
 * schema-validated value). When `input.current` is present, its location must match the baseline's
 * location by value (a mismatch throws a static, value-free `RangeError` before any output is built),
 * and its `current` and `sources` overlay the baseline: `current` becomes present, `CURRENT` is removed
 * from the baseline's `missingSections` (and nothing else changes), and `sources` becomes the current
 * overview's sources followed by the baseline's sources.
 *
 * Pure and synchronous: reads only `input.hourly.overview` and (when present) `input.current.overview`,
 * never `input.hourly.selection`; mutates nothing; returns a fresh `weatherOverview.parse`-validated
 * value every call.
 */
export function assembleKmaCurrentHourlyWeatherOverview(
  input: KmaCurrentHourlyWeatherOverviewInput,
): WeatherOverview {
  const baseline = input.hourly.overview;

  if (input.current === null) {
    const overview = {
      location: baseline.location,
      current: baseline.current,
      hourly: baseline.hourly,
      daily: baseline.daily,
      airQuality: baseline.airQuality,
      alerts: baseline.alerts,
      missingSections: baseline.missingSections,
      sources: baseline.sources,
    } satisfies WeatherOverview;

    return weatherOverview.parse(overview);
  }

  const currentOverview = input.current.overview;

  if (!isSameWeatherLocation(baseline.location, currentOverview.location)) {
    throw new RangeError(
      'assembleKmaCurrentHourlyWeatherOverview: current and hourly overviews describe different locations',
    );
  }

  const overview = {
    location: baseline.location,
    current: currentOverview.current,
    hourly: baseline.hourly,
    daily: baseline.daily,
    airQuality: baseline.airQuality,
    alerts: baseline.alerts,
    missingSections: baseline.missingSections.filter(
      (section) => section !== 'CURRENT',
    ),
    sources: [...currentOverview.sources, ...baseline.sources],
  } satisfies WeatherOverview;

  return weatherOverview.parse(overview);
}
