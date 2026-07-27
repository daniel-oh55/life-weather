/**
 * Umbrella decision engine — the first "life weather" calculation.
 *
 * {@link assessUmbrellaNeed} takes a normalized {@link HourlyForecast} list and an explicit
 * evaluation instant and deterministically decides whether the user needs an umbrella. It is
 * pure TypeScript: it never reads the system clock (no `Date.now()` / no argument-less
 * `new Date()`), never touches the network, never reads environment variables, and never
 * mutates its input. Given the same input it always returns the same result.
 *
 * The thresholds below are Life Weather's **initial product heuristic**, not an official
 * 기상청 (KMA) 생활지수. See `docs/lifestyle-umbrella-policy.md`. Any change to how a decision
 * is reached must bump {@link UMBRELLA_POLICY}.policyVersion.
 */

import type { HourlyForecast } from '@life-weather/contracts';

const HOUR_IN_MS = 3_600_000;

/**
 * The policy for one umbrella assessment. Frozen so a consumer cannot mutate the shared
 * thresholds at runtime; the literal types are preserved via `as const`.
 *
 * - `assessmentWindowHours` — how far ahead of `evaluatedAt` a forecast is considered.
 * - `immediateWindowHours` — a strong signal within this lead time means "carry it now".
 * - `highProbabilityThresholdPercent` — probability at/above this is a strong signal.
 * - `moderateProbabilityThresholdPercent` — probability at/above this (but below high) is a
 *   moderate signal.
 * - `minimumDryForecastCount` / `minimumDryCoverageHours` — the coverage a *dry* forecast set
 *   must have before a confident "not needed" is allowed.
 */
export const UMBRELLA_POLICY = Object.freeze({
  policyVersion: '1.0.0',
  assessmentWindowHours: 12,
  immediateWindowHours: 1,
  highProbabilityThresholdPercent: 60,
  moderateProbabilityThresholdPercent: 30,
  minimumDryForecastCount: 6,
  minimumDryCoverageHours: 5,
} as const);

/** Normalized conditions that count as precipitation for umbrella purposes. */
const PRECIPITATION_CONDITIONS: ReadonlySet<string> = new Set([
  'RAIN',
  'SNOW',
  'SLEET',
  'SHOWER',
  'THUNDERSTORM',
]);

export type UmbrellaStatus =
  | 'REQUIRED_NOW'
  | 'REQUIRED_LATER'
  | 'RECOMMENDED'
  | 'NOT_NEEDED'
  | 'INSUFFICIENT_DATA';

export type UmbrellaReasonCode =
  | 'PRECIPITATION_IMMINENT'
  | 'PRECIPITATION_LATER'
  | 'PRECIPITATION_POSSIBLE'
  | 'LOW_PRECIPITATION_RISK'
  | 'INSUFFICIENT_FORECAST';

export type UmbrellaDataQuality = 'SUFFICIENT' | 'LIMITED' | 'INSUFFICIENT';

/**
 * The forecast-derived facts a decision rests on. Timestamps are canonical UTC ISO 8601
 * (millisecond precision), derived only from the input — the mobile presenter formats
 * `firstRiskAt` for display. No raw provider payload is exposed here.
 *
 * `consideredForecastCount` and `usableForecastCount` are both counted over **distinct
 * `forecastAt` instants** inside the window: duplicates of the same instant collapse to one.
 * An instant is *usable* if at least one forecast at that instant is usable (see
 * `isUsableForecast`).
 */
export interface UmbrellaEvidence {
  windowStartAt: string;
  windowEndAt: string;
  firstRiskAt: string | null;
  peakPrecipitationProbabilityPercent: number | null;
  peakPrecipitationAmountMillimeters: number | null;
  peakSnowfallAmountCentimeters: number | null;
  consideredForecastCount: number;
  usableForecastCount: number;
}

export interface UmbrellaDecision {
  policyVersion: string;
  status: UmbrellaStatus;
  reasonCode: UmbrellaReasonCode;
  reason: string;
  recommendation: string;
  dataQuality: UmbrellaDataQuality;
  evidence: UmbrellaEvidence;
}

export interface UmbrellaAssessmentInput {
  /** The instant the assessment is anchored to; an ISO 8601 datetime with a timezone. */
  evaluatedAt: string;
  /** Normalized hourly forecasts. Order is not trusted; the array is not mutated. */
  hourlyForecasts: readonly HourlyForecast[];
}

interface DecisionCopy {
  reasonCode: UmbrellaReasonCode;
  reason: string;
  recommendation: string;
}

/**
 * The stable Korean user-facing copy and machine reason code for each status. This is the
 * single source of truth ensuring `reason` / `recommendation` / `reasonCode` always match the
 * status. Copy deliberately contains no formatted local time — see `firstRiskAt`.
 */
const DECISION_COPY: Readonly<Record<UmbrellaStatus, DecisionCopy>> = Object.freeze({
  REQUIRED_NOW: {
    reasonCode: 'PRECIPITATION_IMMINENT',
    reason: '현재부터 1시간 이내에 비나 눈이 예상됩니다.',
    recommendation: '외출할 때 우산을 꼭 챙기세요.',
  },
  REQUIRED_LATER: {
    reasonCode: 'PRECIPITATION_LATER',
    reason: '앞으로 12시간 안에 비나 눈 가능성이 높습니다.',
    recommendation: '지금 비가 오지 않아도 우산을 준비하세요.',
  },
  RECOMMENDED: {
    reasonCode: 'PRECIPITATION_POSSIBLE',
    reason: '앞으로 12시간 동안 비나 눈 가능성이 있습니다.',
    recommendation: '접이식 우산을 챙기면 좋습니다.',
  },
  NOT_NEEDED: {
    reasonCode: 'LOW_PRECIPITATION_RISK',
    reason: '확인 가능한 예보에서 비나 눈 가능성이 낮습니다.',
    recommendation: '우산 없이 외출해도 무리가 적겠습니다.',
  },
  INSUFFICIENT_DATA: {
    reasonCode: 'INSUFFICIENT_FORECAST',
    reason: '우산 필요 여부를 판단할 예보가 부족합니다.',
    recommendation: '최신 예보를 다시 확인하세요.',
  },
});

// ---------------------------------------------------------------------------
// ISO datetime parsing
//
// Mirrors `isoDateTime` in @life-weather/contracts: a required timezone designator and either
// seconds precision or exactly-3-digit millisecond precision. Kept local so the engine has no
// runtime dependency on Zod or the contracts package.
// ---------------------------------------------------------------------------

const ABSOLUTE_ISO_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{3})?(?:Z|([+-])(\d{2}):(\d{2}))$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  const daysPerMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month === 2 && isLeapYear(year)) {
    return 29;
  }
  return daysPerMonth[month - 1] ?? 0;
}

/**
 * Parse an absolute ISO datetime to epoch milliseconds, or return `null` for anything that is
 * not a timezone-qualified ISO datetime denoting a real calendar instant. Accepts `unknown` so
 * a runtime-invalid `forecastAt` (non-string, malformed, impossible date) is handled without
 * throwing. Independent of the host timezone because the offset is explicit.
 */
function parseAbsoluteInstantMs(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }

  const match = ABSOLUTE_ISO_DATETIME.exec(value);
  if (match === null) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);

  if (month < 1 || month > 12) {
    return null;
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return null;
  }

  // Offset components are absent for the `Z` form (match[7] is the sign, or undefined).
  if (match[7] !== undefined) {
    const offsetHour = Number(match[8]);
    const offsetMinute = Number(match[9]);
    if (offsetHour > 23 || offsetMinute > 59) {
      return null;
    }
  }

  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** A finite number, or `null` for anything else (`null`, `undefined`, `NaN`, non-number). */
function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

type SignalStrength = 'STRONG' | 'MODERATE' | 'NONE';

/**
 * Classify one forecast's precipitation signal.
 *
 * Strong: a precipitation condition, any positive precipitation amount, any positive snowfall,
 * or probability at/above the high threshold. Moderate: not strong, but probability at/above
 * the moderate threshold. Boundaries are inclusive (60 → strong, 30 → moderate, 29 → none); a
 * precipitation or snowfall amount of exactly 0 is not a signal.
 */
function classifyPrecipitationSignal(forecast: HourlyForecast): SignalStrength {
  const condition =
    typeof forecast.condition === 'string' ? forecast.condition : 'UNKNOWN';
  const probability = finiteNumberOrNull(forecast.precipitationProbabilityPercent);
  const precipitationAmount = finiteNumberOrNull(
    forecast.precipitationAmountMillimeters,
  );
  const snowfallAmount = finiteNumberOrNull(forecast.snowfallAmountCentimeters);

  const isStrong =
    PRECIPITATION_CONDITIONS.has(condition) ||
    (precipitationAmount !== null && precipitationAmount > 0) ||
    (snowfallAmount !== null && snowfallAmount > 0) ||
    (probability !== null &&
      probability >= UMBRELLA_POLICY.highProbabilityThresholdPercent);
  if (isStrong) {
    return 'STRONG';
  }

  if (
    probability !== null &&
    probability >= UMBRELLA_POLICY.moderateProbabilityThresholdPercent
  ) {
    return 'MODERATE';
  }

  return 'NONE';
}

/**
 * A forecast is usable if it carries at least one decision-relevant fact: a known condition,
 * or a non-null precipitation probability / precipitation amount / snowfall amount.
 */
function isUsableForecast(forecast: HourlyForecast): boolean {
  const condition =
    typeof forecast.condition === 'string' ? forecast.condition : 'UNKNOWN';
  return (
    condition !== 'UNKNOWN' ||
    finiteNumberOrNull(forecast.precipitationProbabilityPercent) !== null ||
    finiteNumberOrNull(forecast.precipitationAmountMillimeters) !== null ||
    finiteNumberOrNull(forecast.snowfallAmountCentimeters) !== null
  );
}

function maxOrKeep(current: number | null, candidate: number): number {
  return current === null ? candidate : Math.max(current, candidate);
}

/**
 * Decide whether an umbrella is needed over the next {@link UMBRELLA_POLICY}.assessmentWindowHours,
 * anchored at `input.evaluatedAt`.
 *
 * The evaluation window is `[evaluatedAt, evaluatedAt + assessmentWindowHours]` inclusive at
 * both ends; forecasts outside it (past, or beyond the window) are ignored. Priority:
 * 1. a strong signal within `immediateWindowHours` → `REQUIRED_NOW`;
 * 2. else a strong signal later in the window → `REQUIRED_LATER`;
 * 3. else a moderate signal in the window → `RECOMMENDED`;
 * 4. else, only with sufficient dry coverage → `NOT_NEEDED`;
 * 5. otherwise → `INSUFFICIENT_DATA`.
 *
 * The input array and its objects are never mutated; a duplicated `forecastAt` yields the same
 * result regardless of input order (strongest signal and per-instant maxima win).
 *
 * @throws RangeError synchronously if `evaluatedAt` is not a timezone-qualified ISO 8601
 *   datetime. The message is fixed and never echoes the input.
 */
export function assessUmbrellaNeed(
  input: UmbrellaAssessmentInput,
): UmbrellaDecision {
  const startMs = parseAbsoluteInstantMs(input.evaluatedAt);
  if (startMs === null) {
    throw new RangeError(
      'evaluatedAt must be an ISO 8601 datetime with a timezone designator',
    );
  }

  const windowEndMs =
    startMs + UMBRELLA_POLICY.assessmentWindowHours * HOUR_IN_MS;
  const immediateEndMs =
    startMs + UMBRELLA_POLICY.immediateWindowHours * HOUR_IN_MS;
  const dryCoverageMinimumMs =
    startMs + UMBRELLA_POLICY.minimumDryCoverageHours * HOUR_IN_MS;

  const rawForecasts: readonly unknown[] = Array.isArray(input.hourlyForecasts)
    ? input.hourlyForecasts
    : [];

  // Build an internal copy of the valid, in-window forecasts, sorted by instant. The original
  // array and objects are only read, never written.
  const entries: { instantMs: number; forecast: HourlyForecast }[] = [];
  for (const rawForecast of rawForecasts) {
    if (rawForecast === null || typeof rawForecast !== 'object') {
      continue;
    }
    const forecast = rawForecast as HourlyForecast;
    const instantMs = parseAbsoluteInstantMs(forecast.forecastAt);
    if (instantMs === null) {
      // A runtime-invalid forecastAt is excluded from evidence; the function still runs.
      continue;
    }
    if (instantMs < startMs || instantMs > windowEndMs) {
      // Past forecasts and anything beyond the window are ignored.
      continue;
    }
    entries.push({ instantMs, forecast });
  }
  entries.sort((a, b) => a.instantMs - b.instantMs);

  // Distinct-instant usability: an instant is usable if any duplicate at that instant is.
  const usableByInstant = new Map<number, boolean>();
  let hasStrongImmediate = false;
  let hasStrongLater = false;
  let hasModerate = false;
  let firstRiskMs: number | null = null;
  let peakProbability: number | null = null;
  let peakPrecipitationAmount: number | null = null;
  let peakSnowfall: number | null = null;

  for (const { instantMs, forecast } of entries) {
    const previouslyUsable = usableByInstant.get(instantMs) ?? false;
    usableByInstant.set(instantMs, previouslyUsable || isUsableForecast(forecast));

    const probability = finiteNumberOrNull(
      forecast.precipitationProbabilityPercent,
    );
    const precipitationAmount = finiteNumberOrNull(
      forecast.precipitationAmountMillimeters,
    );
    const snowfallAmount = finiteNumberOrNull(forecast.snowfallAmountCentimeters);
    if (probability !== null) {
      peakProbability = maxOrKeep(peakProbability, probability);
    }
    if (precipitationAmount !== null) {
      peakPrecipitationAmount = maxOrKeep(peakPrecipitationAmount, precipitationAmount);
    }
    if (snowfallAmount !== null) {
      peakSnowfall = maxOrKeep(peakSnowfall, snowfallAmount);
    }

    const signal = classifyPrecipitationSignal(forecast);
    if (signal !== 'NONE' && firstRiskMs === null) {
      // entries are sorted ascending, so the first signal seen is the earliest risk instant.
      firstRiskMs = instantMs;
    }
    if (signal === 'STRONG') {
      if (instantMs <= immediateEndMs) {
        hasStrongImmediate = true;
      } else {
        hasStrongLater = true;
      }
    } else if (signal === 'MODERATE') {
      hasModerate = true;
    }
  }

  const consideredForecastCount = usableByInstant.size;
  let usableForecastCount = 0;
  let lastUsableMs: number | null = null;
  for (const [instantMs, usable] of usableByInstant) {
    if (usable) {
      usableForecastCount += 1;
      lastUsableMs = lastUsableMs === null ? instantMs : Math.max(lastUsableMs, instantMs);
    }
  }

  const hasSufficientDryCoverage =
    usableForecastCount >= UMBRELLA_POLICY.minimumDryForecastCount &&
    lastUsableMs !== null &&
    lastUsableMs >= dryCoverageMinimumMs;

  let status: UmbrellaStatus;
  if (hasStrongImmediate) {
    status = 'REQUIRED_NOW';
  } else if (hasStrongLater) {
    status = 'REQUIRED_LATER';
  } else if (hasModerate) {
    status = 'RECOMMENDED';
  } else if (hasSufficientDryCoverage) {
    status = 'NOT_NEEDED';
  } else {
    status = 'INSUFFICIENT_DATA';
  }

  let dataQuality: UmbrellaDataQuality;
  if (status === 'INSUFFICIENT_DATA') {
    dataQuality = 'INSUFFICIENT';
  } else if (hasSufficientDryCoverage) {
    dataQuality = 'SUFFICIENT';
  } else {
    dataQuality = 'LIMITED';
  }

  const copy = DECISION_COPY[status];

  return {
    policyVersion: UMBRELLA_POLICY.policyVersion,
    status,
    reasonCode: copy.reasonCode,
    reason: copy.reason,
    recommendation: copy.recommendation,
    dataQuality,
    evidence: {
      windowStartAt: new Date(startMs).toISOString(),
      windowEndAt: new Date(windowEndMs).toISOString(),
      firstRiskAt: firstRiskMs === null ? null : new Date(firstRiskMs).toISOString(),
      peakPrecipitationProbabilityPercent: peakProbability,
      peakPrecipitationAmountMillimeters: peakPrecipitationAmount,
      peakSnowfallAmountCentimeters: peakSnowfall,
      consideredForecastCount,
      usableForecastCount,
    },
  };
}
