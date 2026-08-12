/**
 * The **AirKorea current air-quality `WeatherOverview` overlay assembler**: a pure, synchronous
 * function that overlays an optional, already-computed PR #85 `CurrentAirQuality` (plus its source
 * provenance) onto an already-assembled baseline {@link WeatherOverview} — the existing KMA
 * current+hourly overview produced by `kma-current-hourly-weather-overview.ts`.
 *
 * This is the air-quality counterpart of `kma-current-hourly-weather-overview.ts`
 * (`assembleKmaCurrentHourlyWeatherOverview`): it follows the same baseline+overlay shape, but is a
 * separate, parallel implementation — it does not call or reimplement that assembler, and it never
 * touches `hourly`, `daily`, `current`, or `alerts`.
 *
 * ### Baseline and overlay
 *
 * `input.baseline` is the full baseline overview (every non-air-quality-current section, plus
 * `airQuality.daily`) verbatim. `input.airQuality === null` means the caller already decided no
 * AirKorea current contributes to this overview — the baseline is returned unchanged (as a fresh,
 * schema-validated value); this overlay never inspects or infers *why* (LOCATION/provider-stage/
 * NORMALIZATION failure) — that policy belongs to the caller (the cross-provider application
 * service). When `input.airQuality` is present, its `current` overlays the baseline:
 * `airQuality.current` becomes present, `AIR_QUALITY_CURRENT` is removed from the baseline's
 * `missingSections` (nothing else changes), `airQuality.daily` is preserved verbatim, and one
 * `AIR_KOREA` {@link SourceMetadata} entry is appended to `sources`.
 *
 * ### `AIR_KOREA` `SourceMetadata` — explicit-field construction, fixed policy
 *
 * The caller supplies exactly the three provenance facts a live AirKorea source metadata resolver
 * (`airkorea-current-source-metadata.ts`) can materialize on its own —
 * {@link AirKoreaCurrentSourceMetadataInput} (`sourceId`/`fetchedAt`/`retrievalMode`) — and this
 * overlay fixes the remaining four `SourceMetadata` fields from AirKorea current-data semantics:
 * `provider: 'AIR_KOREA'`, `sections: ['AIR_QUALITY_CURRENT']`, `issuedAt: null` (AirKorea current
 * measurements carry no forecast issuance), and `observedAt: CurrentAirQuality.measuredAt` verbatim.
 * The `SourceMetadata` object is built with **explicit, named fields** — never `{ ...input.airQuality
 * .source }` — so no extra runtime property on the caller's source object can override or leak into
 * the fixed policy fields. No station name, TM coordinate, or other location trace is ever placed in
 * `sourceId`.
 *
 * ### Fail-closed precondition
 *
 * This overlay assumes the baseline it receives never already carries an `airQuality.current` (the
 * existing KMA pipeline never populates it). If that assumption is violated at runtime — a defensive
 * case, not an expected one — this overlay throws a synchronous, static, value-free `RangeError`
 * before building any output, rather than silently overwriting or duplicating air-quality data.
 *
 * ### Purity and validation
 *
 * Synchronous and pure: no `Promise`, no network/provider/service call, no clock/environment read, no
 * logging, no cache/singleton/mutable state, no broad `try`/`catch`. It mutates neither input,
 * allocates a fresh output every call, and validates the assembled payload with `weatherOverview.parse`
 * — the sole runtime invariant guard — before returning it.
 *
 * This assembler does not decide AirKorea-failure degradation policy (that is the cross-provider
 * application service's job), does not implement retry/cache, and is not wired into any route,
 * composition root, or presenter by itself. See `docs/weather-production-wiring.md`.
 */

import {
  weatherOverview,
  type CurrentAirQuality,
  type SourceMetadata,
  type WeatherOverview,
} from '@life-weather/contracts';

/**
 * The provenance a caller must supply for the AirKorea source: exactly the three
 * {@link SourceMetadata} fields a live AirKorea source metadata resolver
 * (`airkorea-current-source-metadata.ts`) can materialize on its own — the app-internal `sourceId`,
 * the `fetchedAt` retrieval instant, and the `retrievalMode`. This overlay fixes the remaining
 * `SourceMetadata` fields itself (`provider: 'AIR_KOREA'`, `sections: ['AIR_QUALITY_CURRENT']`,
 * `issuedAt: null`, `observedAt: CurrentAirQuality.measuredAt`), so they are deliberately absent here.
 */
export type AirKoreaCurrentSourceMetadataInput = Pick<
  SourceMetadata,
  'sourceId' | 'fetchedAt' | 'retrievalMode'
>;

/**
 * The overlay's input: an already-assembled baseline {@link WeatherOverview} (the existing KMA
 * current+hourly overview) plus an optional AirKorea current air-quality contribution. `airQuality:
 * null` means the caller already decided AirKorea contributes nothing to this overview.
 */
export interface AirQualityCurrentOverlayInput {
  readonly baseline: WeatherOverview;
  readonly airQuality: {
    readonly current: CurrentAirQuality;
    readonly source: AirKoreaCurrentSourceMetadataInput;
  } | null;
}

/** Static message for a baseline that already violates this overlay's required precondition. */
const BASELINE_ALREADY_HAS_AIR_QUALITY_CURRENT_MESSAGE =
  'overlayAirKoreaCurrentAirQualityOnWeatherOverview: baseline already carries airQuality.current';

/**
 * Overlay an optional, already-computed AirKorea current air-quality contribution onto a baseline
 * {@link WeatherOverview}.
 *
 * When `input.airQuality` is `null`, returns a fresh, schema-validated copy of the baseline,
 * unchanged. When present, `airQuality.current` becomes the overlay's `airQuality.current`,
 * `AIR_QUALITY_CURRENT` is removed from the baseline's `missingSections`, `airQuality.daily` is
 * preserved verbatim, and exactly one `AIR_KOREA` {@link SourceMetadata} entry (built from explicit,
 * named fields) is appended to `sources`. Throws a static, value-free `RangeError` if the baseline
 * already carries a non-null `airQuality.current` — this overlay's required precondition.
 *
 * Pure and synchronous: reads only `input.baseline` and (when present) `input.airQuality`, mutates
 * nothing, and returns a fresh `weatherOverview.parse`-validated value every call.
 */
export function overlayAirKoreaCurrentAirQualityOnWeatherOverview(
  input: AirQualityCurrentOverlayInput,
): WeatherOverview {
  const baseline = input.baseline;

  if (baseline.airQuality.current !== null) {
    throw new RangeError(BASELINE_ALREADY_HAS_AIR_QUALITY_CURRENT_MESSAGE);
  }

  if (input.airQuality === null) {
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

  const airKoreaSource: SourceMetadata = {
    sourceId: input.airQuality.source.sourceId,
    provider: 'AIR_KOREA',
    sections: ['AIR_QUALITY_CURRENT'],
    issuedAt: null,
    observedAt: input.airQuality.current.measuredAt,
    fetchedAt: input.airQuality.source.fetchedAt,
    retrievalMode: input.airQuality.source.retrievalMode,
  };

  const overview = {
    location: baseline.location,
    current: baseline.current,
    hourly: baseline.hourly,
    daily: baseline.daily,
    airQuality: {
      current: input.airQuality.current,
      daily: baseline.airQuality.daily,
    },
    alerts: baseline.alerts,
    missingSections: baseline.missingSections.filter(
      (section) => section !== 'AIR_QUALITY_CURRENT',
    ),
    sources: [...baseline.sources, airKoreaSource],
  } satisfies WeatherOverview;

  return weatherOverview.parse(overview);
}
