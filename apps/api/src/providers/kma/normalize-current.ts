/**
 * Normalize a KMA (기상청) 초단기실황 (current observation, `getUltraSrtNcst`) provider success into
 * the common `@life-weather/contracts` `CurrentWeather`.
 *
 * This is the current-observation counterpart of `normalize-hourly.ts`. It turns a
 * {@link KmaCurrentObservationProviderSuccess} (the provider's grouped `ABSENT`/`NULL`/`VALUE`
 * slot, plus the request identity that produced it) into one validated `CurrentWeather`:
 *
 * 1. build the KST `observedAt` from the observation's own `baseDate`/`baseTime`,
 * 2. resolve the condition via `weather-core`'s current-observation PTY normalizer,
 * 3. parse each scalar / amount value with the matching `weather-core` parser,
 * 4. validate the assembled candidate against the contracts `currentWeather` schema.
 *
 * Responsibility boundaries mirror the hourly normalizer: the raw scalar → number rules live in
 * `@life-weather/weather-core` (pure, no contracts/Zod dependency); this file only decides which
 * category feeds which field, how the three presence states map to a value, and how failures are
 * reported. It performs **no** network I/O, computes no `feelsLikeCelsius`, never guesses
 * `visibilityMeters` (초단기실황 does not provide it), and never mutates the provider result. See
 * `docs/kma-current-observation-provider.md` for the official-source evidence and the full policy.
 *
 * Pure and deterministic: no `fetch`, no system clock, no environment or locale access, no global
 * mutable state.
 */

import {
  currentWeather,
  type CurrentWeather,
} from '@life-weather/contracts';
import {
  normalizeKmaCurrentWeatherCondition,
  parseKmaPercentage,
  parseKmaPrecipitationAmountMillimeters,
  parseKmaTemperatureCelsius,
  parseKmaWindDirectionDegrees,
  parseKmaWindSpeedMetersPerSecond,
} from '@life-weather/weather-core';

import {
  getKmaCurrentObservationField,
  type KmaCurrentObservationFieldLookup,
  type KmaCurrentObservationSlot,
} from './group-current-observation-items.js';
import type { KmaCurrentObservationProviderSuccess } from './provider.js';
import { isCalendarDate, isKmaCurrentObservationBaseTime } from './validation.js';

/**
 * One deterministic normalization problem. `field` says *which* part failed and `reason` *why*:
 *
 * - `observedAt` + `INVALID` — the observation's `baseDate`/`baseTime` is malformed (defensive; the
 *   raw schema normally guarantees a valid `YYYYMMDD`/`HHmm`).
 * - `temperatureCelsius` + `ABSENT`/`NULL`/`INVALID` — the required `T1H` category is missing,
 *   explicitly null, or a value that could not be parsed.
 * - `contract` + `INVALID` — the assembled candidate failed the contracts `currentWeather` schema.
 *   `path` and `message` carry the **sanitized** Zod location and message.
 *
 * No raw slot, `obsrValue`, provider response, URL, service key, or stack trace is ever included.
 */
export interface KmaCurrentNormalizationIssue {
  readonly field: 'observedAt' | 'temperatureCelsius' | 'contract';
  readonly reason: 'ABSENT' | 'NULL' | 'INVALID';
  /** Sanitized Zod path (dotted field location), set only for a `contract` issue. */
  readonly path?: string;
  /** Sanitized Zod message (type-level), set only for a `contract` issue. */
  readonly message?: string;
}

/**
 * The result of normalizing one provider success. Either a valid `CurrentWeather` (`ok: true`), or
 * every blocking issue collected (`ok: false`) — never a partially-populated `CurrentWeather`.
 */
export type NormalizeKmaCurrentObservationResult =
  | { readonly ok: true; readonly current: CurrentWeather }
  | { readonly ok: false; readonly issues: readonly KmaCurrentNormalizationIssue[] };

/** The required temperature category — 초단기실황 provides only `T1H` (no `TMP`). */
const CATEGORY_TEMPERATURE = 'T1H';
const CATEGORY_PTY = 'PTY';
const CATEGORY_HUMIDITY = 'REH';
const CATEGORY_WIND_SPEED = 'WSD';
const CATEGORY_WIND_DIRECTION = 'VEC';
/** 1시간 강수량. Reuses the forecast RN1/PCP parser — see the module docblock and project docs for
 * why that parser already safely handles current observation's strict numeric values: it accepts
 * a bare decimal (`'0'`, `'1.5'`), treats `'0'`/`'0.0'` as a confirmed `0`, and its grammar has no
 * sign character so a negative string never matches and falls through to `null`. */
const CATEGORY_PRECIPITATION_LAST_HOUR = 'RN1';

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
 * Look up `category` in `slot`, treating a `null` slot (the documented defensive empty-page
 * allowance) as every category being `ABSENT`.
 */
function fieldOrAbsent(
  slot: KmaCurrentObservationSlot | null,
  category: string,
): KmaCurrentObservationFieldLookup {
  if (slot === null) {
    return { state: 'ABSENT' };
  }
  return getKmaCurrentObservationField(slot, category);
}

/**
 * Map a field-presence lookup to the PTY code the condition normalizer expects: a present value
 * stays a string, an explicit `NULL` becomes `null`, and `ABSENT` becomes `undefined`. The
 * normalizer already treats `null`/`undefined`/blank as "no usable code".
 */
function toConditionCode(lookup: KmaCurrentObservationFieldLookup): string | null | undefined {
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
  lookup: KmaCurrentObservationFieldLookup,
  parse: (raw: string) => number | null,
): number | null {
  if (lookup.state === 'VALUE') {
    return parse(lookup.value);
  }
  return null;
}

/**
 * Build the KST ISO `observedAt` (`YYYY-MM-DDTHH:mm:00+09:00`) from the observation's own
 * `baseDate`/`baseTime`, or `null` if either is malformed. KST has no DST, so the offset is the
 * fixed `+09:00` and seconds are always `00`. Pure string composition guarded by the same
 * calendar predicate the raw boundary and request layer use, plus the current-observation-only
 * `isKmaCurrentObservationBaseTime` (not the general `isClockTime`) — this defensive re-check
 * matches the stricter on-the-hour policy the raw schema and request validator already enforce, so
 * a non-hour `baseTime` that somehow reaches this normalizer directly still fails `observedAt`
 * rather than composing a KST string the request layer would never have accepted. No `Date`, no
 * system clock, no host timezone. The output passes the contracts `isoDateTime` schema.
 */
function buildObservedAtKst(baseDate: string, baseTime: string): string | null {
  if (!isCalendarDate(baseDate) || !isKmaCurrentObservationBaseTime(baseTime)) {
    return null;
  }
  const year = baseDate.slice(0, 4);
  const month = baseDate.slice(4, 6);
  const day = baseDate.slice(6, 8);
  const hour = baseTime.slice(0, 2);
  const minute = baseTime.slice(2, 4);
  return `${year}-${month}-${day}T${hour}:${minute}:00+09:00`;
}

/** Total order over issues: `field`, then `reason`, then `path`, then `message`. */
function compareIssues(
  a: KmaCurrentNormalizationIssue,
  b: KmaCurrentNormalizationIssue,
): number {
  return (
    compareStrings(a.field, b.field) ||
    compareStrings(a.reason, b.reason) ||
    compareStrings(a.path ?? '', b.path ?? '') ||
    compareStrings(a.message ?? '', b.message ?? '')
  );
}

/**
 * Normalize a KMA current-observation provider success into a contracts `CurrentWeather`.
 *
 * Required: `observedAt` (from `baseDate`/`baseTime`) and `temperatureCelsius` (from `T1H`) — a
 * problem with either fails the whole normalization. Optional categories (`REH`/`WSD`/`VEC`/`RN1`)
 * fall back to `null` on absence, explicit null, or a parse failure — they never block
 * normalization. `condition` uses the current-observation PTY normalizer (PTY `0`/absent/unknown →
 * `UNKNOWN`, never a guessed sky state). `feelsLikeCelsius` and `visibilityMeters` are always
 * `null` (not computed / not provided by this endpoint). The candidate is validated against the
 * shared `currentWeather` schema before being returned. The input `observation` and its slot/fields
 * are never mutated; issues are returned in a deterministic `(field, reason, path, message)` order.
 */
export function normalizeKmaCurrentObservation(
  observation: KmaCurrentObservationProviderSuccess,
): NormalizeKmaCurrentObservationResult {
  const issues: KmaCurrentNormalizationIssue[] = [];

  const observedAt = buildObservedAtKst(observation.baseDate, observation.baseTime);
  if (observedAt === null) {
    issues.push({ field: 'observedAt', reason: 'INVALID' });
  }

  let temperatureCelsius: number | null = null;
  const temperatureLookup = fieldOrAbsent(observation.slot, CATEGORY_TEMPERATURE);
  if (temperatureLookup.state === 'ABSENT') {
    issues.push({ field: 'temperatureCelsius', reason: 'ABSENT' });
  } else if (temperatureLookup.state === 'NULL') {
    issues.push({ field: 'temperatureCelsius', reason: 'NULL' });
  } else {
    const parsed = parseKmaTemperatureCelsius(temperatureLookup.value);
    if (parsed === null) {
      issues.push({ field: 'temperatureCelsius', reason: 'INVALID' });
    } else {
      temperatureCelsius = parsed;
    }
  }

  // A missing observedAt or temperature means we cannot build a candidate at all.
  if (observedAt === null || temperatureCelsius === null) {
    return { ok: false, issues: [...issues].sort(compareIssues) };
  }

  const condition = normalizeKmaCurrentWeatherCondition(
    toConditionCode(fieldOrAbsent(observation.slot, CATEGORY_PTY)),
  );

  const candidate = {
    observedAt,
    condition,
    temperatureCelsius,
    // feelsLikeCelsius is a derived value; deferred to a later PR with a validated formula.
    feelsLikeCelsius: null,
    humidityPercent: parseNullableField(
      fieldOrAbsent(observation.slot, CATEGORY_HUMIDITY),
      parseKmaPercentage,
    ),
    windSpeedMetersPerSecond: parseNullableField(
      fieldOrAbsent(observation.slot, CATEGORY_WIND_SPEED),
      parseKmaWindSpeedMetersPerSecond,
    ),
    windDirectionDegrees: parseNullableField(
      fieldOrAbsent(observation.slot, CATEGORY_WIND_DIRECTION),
      parseKmaWindDirectionDegrees,
    ),
    precipitationLastHourMillimeters: parseNullableField(
      fieldOrAbsent(observation.slot, CATEGORY_PRECIPITATION_LAST_HOUR),
      parseKmaPrecipitationAmountMillimeters,
    ),
    // 초단기실황 does not provide visibility.
    visibilityMeters: null,
  };

  const parsed = currentWeather.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({
        field: 'contract',
        reason: 'INVALID',
        path: issue.path.join('.'),
        message: issue.message,
      });
    }
    return { ok: false, issues: [...issues].sort(compareIssues) };
  }

  return { ok: true, current: parsed.data };
}
