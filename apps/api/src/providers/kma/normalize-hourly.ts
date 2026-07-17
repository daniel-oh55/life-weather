/**
 * Normalize a KMA (기상청) forecast provider success into the common
 * `@life-weather/contracts` `HourlyForecast[]`.
 *
 * This is the pure domain-normalization adapter that PR #5 deliberately left out: PR #5's
 * `KmaForecastProvider.fetchForecast()` returns a {@link KmaForecastProviderSuccess} carrying
 * per-time {@link KmaForecastSlot}s with the raw KMA categories and their explicit
 * `ABSENT` / `NULL` / `VALUE` presence. This module turns each slot into one validated
 * `HourlyForecast`:
 *
 * 1. select the per-product categories (단기예보 `TMP`/`PCP`/`SNO` vs. 초단기예보 `T1H`/`RN1`/none),
 * 2. build the KST `forecastAt` from the slot's forecast date/time,
 * 3. resolve the condition via `weather-core`'s SKY/PTY normalizer,
 * 4. parse each scalar / categorical value with the matching `weather-core` parser,
 * 5. validate the assembled candidate against the contracts `hourlyForecast` schema.
 *
 * Responsibility boundaries are kept crisp: the raw scalar → number rules live in
 * `@life-weather/weather-core` (pure, no contracts/Zod dependency); this file only decides which
 * category feeds which field, how the three presence states map to a value, and how failures are
 * reported. It performs **no** network I/O, adds no `WeatherOverview` / `SourceMetadata`, computes
 * no `feelsLikeCelsius`, and never mutates the provider result. See
 * `docs/kma-hourly-normalization.md` for the official-source evidence and the full policy.
 *
 * Pure and deterministic: no `fetch`, no system clock, no environment or locale access, no global
 * mutable state. Given the same slot set in any input order it returns the same result — the output
 * is sorted by `forecastAt` (then slot identity), and the issue list by `(slotKey, field, reason)`.
 */

import {
  hourlyForecast,
  type HourlyForecast,
} from '@life-weather/contracts';
import {
  KmaForecastProduct,
  normalizeKmaWeatherCondition,
  parseKmaPercentage,
  parseKmaPrecipitationAmountMillimeters,
  parseKmaSnowfallAmountCentimeters,
  parseKmaTemperatureCelsius,
  parseKmaWindDirectionDegrees,
  parseKmaWindSpeedMetersPerSecond,
} from '@life-weather/weather-core';

import {
  getKmaForecastField,
  type KmaForecastFieldLookup,
  type KmaForecastSlot,
} from './group-forecast-items';
import type { KmaForecastProviderSuccess } from './provider';
import { isCalendarDate, isClockTime } from './validation';

/**
 * One deterministic normalization problem. `field` says *which* part failed and `reason` *why*:
 *
 * - `forecastAt` + `INVALID` — the slot's forecast date/time is malformed (defensive; the PR #4
 *   raw schema normally guarantees a valid `YYYYMMDD`/`HHmm`).
 * - `temperatureCelsius` + `ABSENT`/`NULL`/`INVALID` — the product's required temperature category
 *   (`TMP` / `T1H`) is missing, explicitly null, or a value that could not be parsed.
 * - `contract` + `INVALID` — the assembled candidate failed the contracts `hourlyForecast` schema.
 *   For a contract issue only, `path` and `message` carry the **sanitized** Zod location and
 *   message (a field name and a type-level message — never the raw KMA `fcstValue`).
 *
 * No raw slot, `fcstValue`, provider response, URL, service key, or stack trace is ever included.
 * `slotKey` is the same collision-free slot identity used by the grouping layer.
 */
export interface KmaHourlyNormalizationIssue {
  readonly slotKey: string;
  readonly field: 'forecastAt' | 'temperatureCelsius' | 'contract';
  readonly reason: 'ABSENT' | 'NULL' | 'INVALID';
  /** Sanitized Zod path (dotted field location), set only for a `contract` issue. */
  readonly path?: string;
  /** Sanitized Zod message (type-level), set only for a `contract` issue. */
  readonly message?: string;
}

/**
 * The result of normalizing one provider success. Either every slot produced a valid
 * `HourlyForecast` (`ok: true`), or at least one slot failed and **all** failures are collected
 * (`ok: false`). It is intentionally all-or-nothing: a partially-normalized page is never returned,
 * so a caller cannot mistake a hole for real data.
 */
export type NormalizeKmaHourlyForecastResult =
  | { readonly ok: true; readonly hourly: readonly HourlyForecast[] }
  | { readonly ok: false; readonly issues: readonly KmaHourlyNormalizationIssue[] };

/** The categories that feed the product-specific fields. Common categories are handled inline. */
interface ProductCategories {
  /** Required temperature category — `TMP` (단기) or `T1H` (초단기). */
  readonly temperature: string;
  /** 1시간 강수량 category (mm) — `PCP` (단기) or `RN1` (초단기); both share the same grammar. */
  readonly precipitationAmount: string;
  /** 1시간 신적설 category (cm) — `SNO` (단기) or `null` (초단기예보 does not carry 신적설). */
  readonly snowfall: string | null;
}

/**
 * Per-product category selection. `SHORT_FORECAST` (getVilageFcst) uses `TMP`/`PCP`/`SNO`;
 * `ULTRA_SHORT_FORECAST` (getUltraSrtFcst) uses `T1H`/`RN1` and provides no 신적설. The common
 * categories `SKY`, `PTY`, `POP`, `REH`, `WSD`, `VEC` are the same code in both products.
 */
const CATEGORIES_BY_PRODUCT: Readonly<Record<KmaForecastProduct, ProductCategories>> = {
  [KmaForecastProduct.SHORT_FORECAST]: {
    temperature: 'TMP',
    precipitationAmount: 'PCP',
    snowfall: 'SNO',
  },
  [KmaForecastProduct.ULTRA_SHORT_FORECAST]: {
    temperature: 'T1H',
    precipitationAmount: 'RN1',
    snowfall: null,
  },
};

/** Common categories shared by both products. */
const CATEGORY_SKY = 'SKY';
const CATEGORY_PTY = 'PTY';
const CATEGORY_POP = 'POP';
const CATEGORY_REH = 'REH';
const CATEGORY_WSD = 'WSD';
const CATEGORY_VEC = 'VEC';

/**
 * The collision-free slot identity, matching the grouping layer's slot key
 * (`product|baseDate|baseTime|fcstDate|fcstTime|nx|ny`). None of the parts can contain `|`
 * (product is a fixed enum, dates/times are digit strings, nx/ny are numbers), and it carries no
 * `fcstValue`, so it is safe to surface in an issue.
 */
function slotKeyOf(slot: KmaForecastSlot): string {
  return [
    slot.product,
    slot.baseDate,
    slot.baseTime,
    slot.forecastDate,
    slot.forecastTime,
    slot.nx,
    slot.ny,
  ].join('|');
}

/** Deterministic, locale-independent string order (UTF-16 code-unit comparison). */
function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/**
 * Map a field-presence lookup to the SKY/PTY code the condition normalizer expects: a present
 * value stays a string, an explicit `NULL` becomes `null`, and `ABSENT` becomes `undefined`. The
 * normalizer already treats `null`/`undefined`/blank as "no usable code".
 */
function toConditionCode(lookup: KmaForecastFieldLookup): string | null | undefined {
  if (lookup.state === 'VALUE') {
    return lookup.value;
  }
  if (lookup.state === 'NULL') {
    return null;
  }
  return undefined;
}

/**
 * Resolve a nullable numeric field from a presence lookup. `ABSENT` and `NULL` are `null`; a
 * `VALUE` is handed to `parse`, whose own failure (unparseable / out-of-range / Missing) is also
 * `null`. The raw string is never returned.
 */
function parseNullableField(
  lookup: KmaForecastFieldLookup,
  parse: (raw: string) => number | null,
): number | null {
  if (lookup.state === 'VALUE') {
    return parse(lookup.value);
  }
  return null;
}

/**
 * Build the KST ISO `forecastAt` (`YYYY-MM-DDTHH:mm:00+09:00`) from a slot's forecast date/time, or
 * `null` if either is malformed. KST has no DST, so the offset is the fixed `+09:00` and seconds are
 * always `00`. This never constructs a `Date`, reads the clock, or applies a locale — it is pure
 * string composition guarded by the same calendar/clock predicates the raw boundary uses, so the
 * result is independent of the host time zone. The output passes the contracts `isoDateTime` schema.
 */
function buildForecastAtKst(
  forecastDate: string,
  forecastTime: string,
): string | null {
  if (
    typeof forecastDate !== 'string' ||
    typeof forecastTime !== 'string' ||
    !isCalendarDate(forecastDate) ||
    !isClockTime(forecastTime)
  ) {
    return null;
  }
  const year = forecastDate.slice(0, 4);
  const month = forecastDate.slice(4, 6);
  const day = forecastDate.slice(6, 8);
  const hour = forecastTime.slice(0, 2);
  const minute = forecastTime.slice(2, 4);
  return `${year}-${month}-${day}T${hour}:${minute}:00+09:00`;
}

/** A slot that assembled and validated cleanly, kept with its key for a stable final sort. */
interface NormalizedSlot {
  readonly slotKey: string;
  readonly forecast: HourlyForecast;
}

/**
 * Normalize one slot: returns either its `HourlyForecast` (paired with its key) or the list of
 * issues that blocked it. Never throws and never mutates the slot.
 */
function normalizeSlot(
  slot: KmaForecastSlot,
  slotKey: string,
): { readonly forecast: HourlyForecast } | { readonly issues: KmaHourlyNormalizationIssue[] } {
  const issues: KmaHourlyNormalizationIssue[] = [];
  const categories = CATEGORIES_BY_PRODUCT[slot.product];

  // forecastAt — required; malformed date/time is a defensive INVALID issue.
  const forecastAt = buildForecastAtKst(slot.forecastDate, slot.forecastTime);
  if (forecastAt === null) {
    issues.push({ slotKey, field: 'forecastAt', reason: 'INVALID' });
  }

  // temperatureCelsius — required by the contract; presence and parse failures are hard errors.
  let temperatureCelsius: number | null = null;
  const temperatureLookup = getKmaForecastField(slot, categories.temperature);
  if (temperatureLookup.state === 'ABSENT') {
    issues.push({ slotKey, field: 'temperatureCelsius', reason: 'ABSENT' });
  } else if (temperatureLookup.state === 'NULL') {
    issues.push({ slotKey, field: 'temperatureCelsius', reason: 'NULL' });
  } else {
    const parsed = parseKmaTemperatureCelsius(temperatureLookup.value);
    if (parsed === null) {
      issues.push({ slotKey, field: 'temperatureCelsius', reason: 'INVALID' });
    } else {
      temperatureCelsius = parsed;
    }
  }

  // A missing forecastAt or temperature means we cannot build a candidate at all.
  if (forecastAt === null || temperatureCelsius === null) {
    return { issues };
  }

  const condition = normalizeKmaWeatherCondition({
    product: slot.product,
    skyCode: toConditionCode(getKmaForecastField(slot, CATEGORY_SKY)),
    precipitationTypeCode: toConditionCode(getKmaForecastField(slot, CATEGORY_PTY)),
  });

  const candidate = {
    forecastAt,
    condition,
    temperatureCelsius,
    // feelsLikeCelsius is a derived value; deferred to a later PR with a validated formula.
    feelsLikeCelsius: null,
    precipitationProbabilityPercent: parseNullableField(
      getKmaForecastField(slot, CATEGORY_POP),
      parseKmaPercentage,
    ),
    precipitationAmountMillimeters: parseNullableField(
      getKmaForecastField(slot, categories.precipitationAmount),
      parseKmaPrecipitationAmountMillimeters,
    ),
    snowfallAmountCentimeters:
      categories.snowfall === null
        ? null
        : parseNullableField(
            getKmaForecastField(slot, categories.snowfall),
            parseKmaSnowfallAmountCentimeters,
          ),
    humidityPercent: parseNullableField(
      getKmaForecastField(slot, CATEGORY_REH),
      parseKmaPercentage,
    ),
    windSpeedMetersPerSecond: parseNullableField(
      getKmaForecastField(slot, CATEGORY_WSD),
      parseKmaWindSpeedMetersPerSecond,
    ),
    windDirectionDegrees: parseNullableField(
      getKmaForecastField(slot, CATEGORY_VEC),
      parseKmaWindDirectionDegrees,
    ),
  };

  const parsed = hourlyForecast.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({
        slotKey,
        field: 'contract',
        reason: 'INVALID',
        path: issue.path.join('.'),
        message: issue.message,
      });
    }
    return { issues };
  }

  return { forecast: parsed.data };
}

/** Total order over issues: `slotKey`, then `field`, then `reason`, then `path`, then `message`. */
function compareIssues(
  a: KmaHourlyNormalizationIssue,
  b: KmaHourlyNormalizationIssue,
): number {
  return (
    compareStrings(a.slotKey, b.slotKey) ||
    compareStrings(a.field, b.field) ||
    compareStrings(a.reason, b.reason) ||
    compareStrings(a.path ?? '', b.path ?? '') ||
    compareStrings(a.message ?? '', b.message ?? '')
  );
}

/**
 * Normalize a KMA forecast provider success into contracts `HourlyForecast[]`.
 *
 * On success, `hourly` is sorted by `forecastAt` ascending (ties broken by slot identity) and every
 * element is a schema-validated `HourlyForecast` with `feelsLikeCelsius: null`, no raw KMA value,
 * and no current-time field. On failure, `issues` collects **all** slots' problems in a
 * deterministic `(slotKey, field, reason, path, message)` order. An empty `slots` array yields
 * `{ ok: true, hourly: [] }`. The input `forecast` and its slots/fields are never mutated.
 */
export function normalizeKmaHourlyForecast(
  forecast: KmaForecastProviderSuccess,
): NormalizeKmaHourlyForecastResult {
  const issues: KmaHourlyNormalizationIssue[] = [];
  const normalized: NormalizedSlot[] = [];

  for (const slot of forecast.slots) {
    const slotKey = slotKeyOf(slot);
    const result = normalizeSlot(slot, slotKey);
    if ('issues' in result) {
      issues.push(...result.issues);
    } else {
      normalized.push({ slotKey, forecast: result.forecast });
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues: [...issues].sort(compareIssues) };
  }

  const hourly = [...normalized]
    .sort(
      (a, b) =>
        compareStrings(a.forecast.forecastAt, b.forecast.forecastAt) ||
        compareStrings(a.slotKey, b.slotKey),
    )
    .map((entry) => entry.forecast);

  return { ok: true, hourly };
}
