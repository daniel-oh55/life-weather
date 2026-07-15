import { z } from 'zod';

/**
 * Shared primitives for the weather contracts: date/time formats, bounded numeric
 * schemas, and the forward-compatible enum helper used by every enum in this package.
 *
 * These schemas are the single source of truth. All exported TypeScript types are
 * inferred from them with `z.infer` — we never hand-write a parallel interface.
 */

// ---------------------------------------------------------------------------
// Date and time
// ---------------------------------------------------------------------------

/**
 * An absolute instant, ISO 8601 with a required timezone designator.
 *
 * Accepts:
 * - `2026-07-15T01:00:00Z` (UTC — the server's normative output form)
 * - `2026-07-15T10:00:00+09:00` (numeric offset)
 *
 * Rejects a local datetime with no timezone (e.g. `2026-07-15T10:00:00`) and any
 * malformed ISO string. Producers should emit the UTC `Z` form.
 */
export const isoDateTime = z.iso.datetime({ offset: true });

/** A local calendar date, ISO 8601 `YYYY-MM-DD` (e.g. `2026-07-15`). */
export const isoDate = z.iso.date();

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------

/** A non-empty string. Used for opaque identifiers and human-readable labels. */
export const nonEmptyString = z.string().min(1);

/**
 * A valid IANA time zone name (e.g. `Asia/Seoul`).
 *
 * Validity is checked by asking the runtime's `Intl` database to resolve the zone, so this
 * tracks the platform's IANA data without bundling a time-zone library. `Intl` throws a
 * `RangeError` for an unknown zone; constructing the formatter is a pure computation with no
 * external side effect. Rejects non-IANA strings such as `Seoul` and the empty string.
 */
export const ianaTimeZone = z.string().min(1).refine(
  (value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'must be a valid IANA time zone' },
);

// ---------------------------------------------------------------------------
// Numeric ranges
//
// `z.number()` in Zod 4 accepts only finite numbers — it rejects NaN, Infinity and
// -Infinity — so every schema below inherits that guarantee without `.finite()`.
// ---------------------------------------------------------------------------

/** Latitude in decimal degrees, `-90 <= lat <= 90`. */
export const latitude = z.number().min(-90).max(90);

/** Longitude in decimal degrees, `-180 <= lon <= 180`. */
export const longitude = z.number().min(-180).max(180);

/** A percentage, `0 <= p <= 100`. Reused for humidity and precipitation probability. */
export const percent = z.number().min(0).max(100);

/** A compass bearing in degrees, half-open `[0, 360)` — `0` is allowed, `360` is not. */
export const windDirectionDegrees = z.number().min(0).lt(360);

/**
 * A non-negative measurement (`>= 0`). Reused for wind speed, precipitation amount,
 * snowfall, visibility, PM10/PM2.5 mass concentration, ozone and the composite index.
 */
export const nonNegativeNumber = z.number().min(0);

/** A temperature in degrees Celsius. Negative values are allowed. */
export const temperatureCelsius = z.number();

// ---------------------------------------------------------------------------
// Forward-compatible enums
// ---------------------------------------------------------------------------

/**
 * Build a matched pair of schemas for one enum:
 *
 * - `strict` accepts only the known values (for API producers / provider-normalization
 *   tests that must fail loudly on an unmapped value).
 * - `compatible` accepts the known values unchanged and maps any *other string* to
 *   `fallback`, so an older consumer can keep parsing a payload that introduced a new
 *   enum member. Its inferred output type is the defined literal union — never `string`.
 *
 * We deliberately do **not** use `z.enum(values).catch(fallback)`: `.catch()` swallows
 * every validation error — a missing field, `null`, a number — and silently returns the
 * fallback. Here only an *unknown string* becomes the fallback; a missing field, `null`,
 * a number, a boolean or an object still fails validation.
 *
 * The return type is inferred so `z.infer<typeof x.strict>` and
 * `z.infer<typeof x.compatible>` both resolve to the exact literal union.
 */
export function createForwardCompatibleEnum<
  const Values extends readonly [string, ...string[]],
  const Fallback extends Values[number],
>(values: Values, fallback: Fallback) {
  const strict = z.enum(values);

  const compatible = z.union([
    strict,
    z.string().transform((): Values[number] => fallback),
  ]);

  return { strict, compatible } as const;
}

// ---------------------------------------------------------------------------
// Enum definitions
//
// Every enum exposes `.strict` and `.compatible`. Network response object schemas use
// `.compatible`; `.strict` is exported for future producer / provider-normalization use.
// Types are inferred from `.strict` so they resolve to the literal union.
// ---------------------------------------------------------------------------

/** Logical sections a weather payload can carry. */
export const weatherDataSection = createForwardCompatibleEnum(
  [
    'CURRENT',
    'HOURLY',
    'DAILY',
    'AIR_QUALITY_CURRENT',
    'AIR_QUALITY_FORECAST',
    'ALERTS',
    'UNKNOWN',
  ],
  'UNKNOWN',
);
export type WeatherDataSection = z.infer<typeof weatherDataSection.strict>;

/** Upstream data source a normalized record was derived from. */
export const sourceProvider = createForwardCompatibleEnum(
  ['KMA', 'AIR_KOREA', 'DERIVED', 'OTHER'],
  'OTHER',
);
export type SourceProvider = z.infer<typeof sourceProvider.strict>;

/** How the data was retrieved for this response. */
export const retrievalMode = createForwardCompatibleEnum(
  ['LIVE', 'CACHE', 'UNKNOWN'],
  'UNKNOWN',
);
export type RetrievalMode = z.infer<typeof retrievalMode.strict>;

/** Normalized sky / precipitation condition. */
export const weatherCondition = createForwardCompatibleEnum(
  [
    'CLEAR',
    'PARTLY_CLOUDY',
    'CLOUDY',
    'RAIN',
    'SNOW',
    'SLEET',
    'SHOWER',
    'THUNDERSTORM',
    'FOG',
    'UNKNOWN',
  ],
  'UNKNOWN',
);
export type WeatherCondition = z.infer<typeof weatherCondition.strict>;

/** Normalized air-quality grade. */
export const airQualityGrade = createForwardCompatibleEnum(
  ['GOOD', 'MODERATE', 'BAD', 'VERY_BAD', 'UNKNOWN'],
  'UNKNOWN',
);
export type AirQualityGrade = z.infer<typeof airQualityGrade.strict>;

/** Normalized weather-alert category. */
export const weatherAlertType = createForwardCompatibleEnum(
  [
    'HEAVY_RAIN',
    'HEAVY_SNOW',
    'HIGH_WIND',
    'HIGH_SEAS',
    'TYPHOON',
    'HEAT_WAVE',
    'COLD_WAVE',
    'DRY',
    'STORM_SURGE',
    'YELLOW_DUST',
    'FOG',
    'THUNDERSTORM',
    'OTHER',
  ],
  'OTHER',
);
export type WeatherAlertType = z.infer<typeof weatherAlertType.strict>;

/** Normalized weather-alert severity. */
export const weatherAlertSeverity = createForwardCompatibleEnum(
  ['INFO', 'ADVISORY', 'WARNING', 'EMERGENCY', 'UNKNOWN'],
  'UNKNOWN',
);
export type WeatherAlertSeverity = z.infer<typeof weatherAlertSeverity.strict>;

/** Machine-readable error code for an API error response. */
export const apiErrorCode = createForwardCompatibleEnum(
  [
    'INVALID_REQUEST',
    'LOCATION_NOT_FOUND',
    'DATA_UNAVAILABLE',
    'PROVIDER_UNAVAILABLE',
    'UPSTREAM_TIMEOUT',
    'RATE_LIMITED',
    'UNSUPPORTED_CONTRACT_VERSION',
    'INTERNAL_ERROR',
    'UNKNOWN',
  ],
  'UNKNOWN',
);
export type ApiErrorCode = z.infer<typeof apiErrorCode.strict>;
