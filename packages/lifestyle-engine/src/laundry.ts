/**
 * Laundry drying-suitability engine — the fourth "life weather" calculation.
 *
 * {@link assessLaundryDryingSuitability} takes a normalized {@link HourlyForecast} list and an
 * explicit evaluation instant, analyses precipitation, precipitation probability, humidity,
 * temperature, and strong wind over the next {@link LAUNDRY_POLICY}.evaluationWindowHours, and
 * deterministically decides how suitable it is to dry laundry **outdoors** starting now. It is
 * pure TypeScript: it never reads the system clock (no `Date.now()` / no argument-less
 * `new Date()`), never touches the network, never reads environment variables, and never mutates
 * its input. Given the same input it always returns the same result.
 *
 * The question this engine answers is narrow: *"if I hang laundry outdoors now, will the next few
 * hours be suitable for drying it outdoors?"* It does **not** judge whether laundry can be washed,
 * how a specific fabric should be dried, indoor humidity, or dryer/electricity usage.
 *
 * Every threshold and the final status mapping below are Life Weather's **initial product
 * heuristic**, not a clone of an official 기상청 (KMA) 빨래지수 / 생활기상지수 and not a KMA-endorsed
 * behavioural standard. See `docs/lifestyle-laundry-policy.md`. Any change to how a decision is
 * reached must bump {@link LAUNDRY_POLICY}.policyVersion.
 */

import type { HourlyForecast } from '@life-weather/contracts';

const HOUR_IN_MS = 3_600_000;

/**
 * The policy for one laundry drying-suitability assessment. Frozen so a consumer cannot mutate the
 * shared thresholds at runtime; the literal types are preserved via `as const`.
 *
 * - `evaluationWindowHours` — how far ahead of `evaluatedAt` a forecast is considered.
 * - `minimumDryingForecastCount` / `minimumDryingCoverageHours` — the coverage a drying-capable
 *   forecast set must have before a positive (FAIR/GOOD/EXCELLENT) verdict is allowed.
 * - `strongPrecipitationProbabilityPercent` — probability at/above this is a strong precipitation
 *   signal.
 * - `possiblePrecipitationProbabilityPercent` — probability at/above this (but below strong) is a
 *   possible-precipitation signal.
 * - `strongWindMetersPerSecond` — wind at/above this can blow laundry off the line.
 * - `highHumidityPercent` — humidity at/above this makes outdoor drying slow / unreliable.
 * - `excellentMaximumHumidityPercent` / `excellentMinimumTemperatureCelsius` — the EXCELLENT band.
 * - `goodMaximumHumidityPercent` / `goodMinimumTemperatureCelsius` — the GOOD band.
 */
export const LAUNDRY_POLICY = Object.freeze({
  policyVersion: '1.0.0',
  evaluationWindowHours: 8,
  minimumDryingForecastCount: 4,
  minimumDryingCoverageHours: 4,
  strongPrecipitationProbabilityPercent: 60,
  possiblePrecipitationProbabilityPercent: 30,
  strongWindMetersPerSecond: 10,
  highHumidityPercent: 85,
  excellentMaximumHumidityPercent: 55,
  goodMaximumHumidityPercent: 70,
  excellentMinimumTemperatureCelsius: 18,
  goodMinimumTemperatureCelsius: 10,
} as const);

/** Normalized conditions that count as precipitation for laundry purposes. */
const PRECIPITATION_CONDITIONS: ReadonlySet<string> = new Set([
  'RAIN',
  'SNOW',
  'SLEET',
  'SHOWER',
  'THUNDERSTORM',
]);

/** Normalized conditions that are known and non-precipitation (a confirmed "no rain" signal). */
const NON_PRECIPITATION_CONDITIONS: ReadonlySet<string> = new Set([
  'CLEAR',
  'PARTLY_CLOUDY',
  'CLOUDY',
  'FOG',
]);

export type LaundryStatus =
  | 'NOT_RECOMMENDED'
  | 'POOR'
  | 'FAIR'
  | 'GOOD'
  | 'EXCELLENT'
  | 'INSUFFICIENT_DATA';

export type LaundryReasonCode =
  | 'PRECIPITATION_EXPECTED'
  | 'STRONG_WIND'
  | 'PRECIPITATION_POSSIBLE'
  | 'HIGH_HUMIDITY'
  | 'MARGINAL_DRYING_CONDITIONS'
  | 'FAVORABLE_DRYING_CONDITIONS'
  | 'EXCELLENT_DRYING_CONDITIONS'
  | 'INSUFFICIENT_FORECAST';

export type LaundryDataQuality = 'SUFFICIENT' | 'LIMITED' | 'INSUFFICIENT';

export type LaundryDriver = 'PRECIPITATION' | 'WIND' | 'HUMIDITY' | 'TEMPERATURE_HUMIDITY';

/**
 * The forecast-derived facts a decision rests on. Timestamps are canonical UTC ISO 8601
 * (millisecond precision), derived only from the input — the mobile presenter formats them for
 * display. Numbers keep the input's precision — nothing is rounded. No raw provider payload, wind
 * direction, source metadata, or unknown-condition string is exposed here.
 *
 * The peak / maximum / minimum figures are computed over **distinct `forecastAt` instants**: the
 * conservative per-instant representative (see the module docs) is folded first, then reduced.
 */
export interface LaundryEvidence {
  windowStartAt: string;
  windowEndAt: string;
  firstAdverseAt: string | null;
  peakPrecipitationProbabilityPercent: number | null;
  peakPrecipitationAmountMillimeters: number | null;
  peakSnowfallAmountCentimeters: number | null;
  maximumHumidityPercent: number | null;
  minimumTemperatureCelsius: number | null;
  maximumWindSpeedMetersPerSecond: number | null;
  consideredForecastCount: number;
  dryingForecastCount: number;
  lastDryingForecastAt: string | null;
  dryingCoverageMet: boolean;
}

export interface LaundryDecision {
  policyVersion: string;
  status: LaundryStatus;
  reasonCode: LaundryReasonCode;
  reason: string;
  recommendation: string;
  driver: LaundryDriver | null;
  dataQuality: LaundryDataQuality;
  evidence: LaundryEvidence;
}

export interface LaundryAssessmentInput {
  /** The instant the assessment is anchored to; an ISO 8601 datetime with a timezone. */
  evaluatedAt: string;
  /** Normalized hourly forecasts. Order is not trusted; the array is not mutated. */
  hourlyForecasts: readonly HourlyForecast[];
}

interface DecisionCopy {
  reason: string;
  recommendation: string;
}

/**
 * The stable Korean user-facing copy for each reason code. This is the single source of truth
 * ensuring `reasonCode` / `reason` / `recommendation` never drift. The copy deliberately contains
 * no formatted local time — see `firstAdverseAt` — and makes no guarantee about garment safety,
 * a drying-completion time, or general safety.
 */
const DECISION_COPY: Readonly<Record<LaundryReasonCode, DecisionCopy>> = Object.freeze({
  PRECIPITATION_EXPECTED: {
    reason: '평가 시간대에 비나 눈이 예상됩니다.',
    recommendation: '실외 건조는 미루고 실내 건조를 준비하세요.',
  },
  STRONG_WIND: {
    reason: '평가 시간대에 바람이 강해 빨래가 날리거나 떨어질 수 있습니다.',
    recommendation: '실외 건조는 피하고 실내에서 건조하세요.',
  },
  PRECIPITATION_POSSIBLE: {
    reason: '평가 시간대에 비나 눈이 올 가능성이 있습니다.',
    recommendation: '실외 건조는 권하지 않으며 최신 강수예보를 다시 확인하세요.',
  },
  HIGH_HUMIDITY: {
    reason: '평가 시간대의 습도가 높아 빨래가 잘 마르기 어렵습니다.',
    recommendation: '환기가 가능한 실내 건조나 건조기 사용을 고려하세요.',
  },
  MARGINAL_DRYING_CONDITIONS: {
    reason: '빨래를 말릴 수 있지만 건조 속도가 빠르지는 않겠습니다.',
    recommendation: '통풍이 잘되는 곳에 널고 충분한 건조 시간을 확보하세요.',
  },
  FAVORABLE_DRYING_CONDITIONS: {
    reason: '기온과 습도가 실외 건조에 무난한 편입니다.',
    recommendation: '지금부터 실외에 널어 건조해도 좋습니다.',
  },
  EXCELLENT_DRYING_CONDITIONS: {
    reason: '기온이 충분하고 습도가 낮아 빨래가 잘 마르겠습니다.',
    recommendation: '실외 건조에 좋은 시간대입니다.',
  },
  INSUFFICIENT_FORECAST: {
    reason: '빨래 건조 가능 여부를 판단할 시간별 예보가 부족합니다.',
    recommendation: '최신 시간별 날씨를 다시 확인하세요.',
  },
});

/** Which reason code each status carries, and the driver behind it. */
interface StatusResolution {
  status: LaundryStatus;
  reasonCode: LaundryReasonCode;
  driver: LaundryDriver | null;
}

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
 * Parse an absolute ISO datetime to epoch milliseconds, or return `null` for anything that is not
 * a timezone-qualified ISO datetime denoting a real calendar instant. Accepts `unknown` so a
 * runtime-invalid `forecastAt` (non-string, malformed, impossible date) is handled without
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

// ---------------------------------------------------------------------------
// Value normalization
// ---------------------------------------------------------------------------

/** A finite number (negatives allowed), or `null` for anything else. Never rounded. */
function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A finite, non-negative number, or `null` for anything else. Never rounded. */
function finiteNonNegativeOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** A finite number in `[0, 100]` (a percent), or `null` for anything else. Never rounded. */
function percentOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
}

function maxOrKeep(current: number | null, candidate: number): number {
  return current === null ? candidate : Math.max(current, candidate);
}

function minOrKeep(current: number | null, candidate: number): number {
  return current === null ? candidate : Math.min(current, candidate);
}

// ---------------------------------------------------------------------------
// Per-instant aggregation
//
// Input order is not trusted and the same absolute instant may appear more than once (even under
// different timezone spellings). Duplicates at one instant collapse to a single conservative
// representative so the engine never over-optimistically favours outdoor drying: wetness and every
// adverse maximum win, and the temperature uses the minimum. The fold is order-independent.
// ---------------------------------------------------------------------------

interface InstantAggregate {
  wetCondition: boolean;
  precipitationAssessable: boolean;
  precipitationProbabilityPercent: number | null;
  precipitationAmountMillimeters: number | null;
  snowfallAmountCentimeters: number | null;
  humidityPercent: number | null;
  temperatureCelsius: number | null;
  windSpeedMetersPerSecond: number | null;
}

function emptyAggregate(): InstantAggregate {
  return {
    wetCondition: false,
    precipitationAssessable: false,
    precipitationProbabilityPercent: null,
    precipitationAmountMillimeters: null,
    snowfallAmountCentimeters: null,
    humidityPercent: null,
    temperatureCelsius: null,
    windSpeedMetersPerSecond: null,
  };
}

/** Fold one raw forecast at an instant into that instant's running representative. */
function foldForecast(aggregate: InstantAggregate, forecast: HourlyForecast): void {
  const condition = typeof forecast.condition === 'string' ? forecast.condition : null;
  const knownPrecipitation = condition !== null && PRECIPITATION_CONDITIONS.has(condition);
  const knownNonPrecipitation = condition !== null && NON_PRECIPITATION_CONDITIONS.has(condition);

  const probability = percentOrNull(forecast.precipitationProbabilityPercent);
  const precipitationAmount = finiteNonNegativeOrNull(forecast.precipitationAmountMillimeters);
  const snowfall = finiteNonNegativeOrNull(forecast.snowfallAmountCentimeters);
  const humidity = percentOrNull(forecast.humidityPercent);
  const temperature = finiteNumberOrNull(forecast.temperatureCelsius);
  const wind = finiteNonNegativeOrNull(forecast.windSpeedMetersPerSecond);

  if (knownPrecipitation) {
    aggregate.wetCondition = true;
  }
  // Precipitation is "assessable" when any precipitation-relevant fact exists — a known condition
  // (wet or dry) or a usable probability / amount / snowfall value.
  if (
    knownPrecipitation ||
    knownNonPrecipitation ||
    probability !== null ||
    precipitationAmount !== null ||
    snowfall !== null
  ) {
    aggregate.precipitationAssessable = true;
  }

  if (probability !== null) {
    aggregate.precipitationProbabilityPercent = maxOrKeep(
      aggregate.precipitationProbabilityPercent,
      probability,
    );
  }
  if (precipitationAmount !== null) {
    aggregate.precipitationAmountMillimeters = maxOrKeep(
      aggregate.precipitationAmountMillimeters,
      precipitationAmount,
    );
  }
  if (snowfall !== null) {
    aggregate.snowfallAmountCentimeters = maxOrKeep(aggregate.snowfallAmountCentimeters, snowfall);
  }
  if (humidity !== null) {
    aggregate.humidityPercent = maxOrKeep(aggregate.humidityPercent, humidity);
  }
  if (temperature !== null) {
    aggregate.temperatureCelsius = minOrKeep(aggregate.temperatureCelsius, temperature);
  }
  if (wind !== null) {
    aggregate.windSpeedMetersPerSecond = maxOrKeep(aggregate.windSpeedMetersPerSecond, wind);
  }
}

// ---------------------------------------------------------------------------
// Per-instant signal classification
// ---------------------------------------------------------------------------

/** A strong precipitation signal: wet condition, any positive amount/snowfall, or POP `>= 60`. */
function hasStrongPrecipitationSignal(aggregate: InstantAggregate): boolean {
  return (
    aggregate.wetCondition ||
    (aggregate.precipitationAmountMillimeters !== null &&
      aggregate.precipitationAmountMillimeters > 0) ||
    (aggregate.snowfallAmountCentimeters !== null && aggregate.snowfallAmountCentimeters > 0) ||
    (aggregate.precipitationProbabilityPercent !== null &&
      aggregate.precipitationProbabilityPercent >=
        LAUNDRY_POLICY.strongPrecipitationProbabilityPercent)
  );
}

/** A possible-precipitation signal: not strong, but POP `>= 30`. */
function hasPossiblePrecipitationSignal(aggregate: InstantAggregate): boolean {
  if (hasStrongPrecipitationSignal(aggregate)) {
    return false;
  }
  return (
    aggregate.precipitationProbabilityPercent !== null &&
    aggregate.precipitationProbabilityPercent >=
      LAUNDRY_POLICY.possiblePrecipitationProbabilityPercent
  );
}

/** A strong-wind signal: representative wind `>= 10 m/s`. */
function hasStrongWindSignal(aggregate: InstantAggregate): boolean {
  return (
    aggregate.windSpeedMetersPerSecond !== null &&
    aggregate.windSpeedMetersPerSecond >= LAUNDRY_POLICY.strongWindMetersPerSecond
  );
}

/** A high-humidity signal: representative humidity `>= 85%`. */
function hasHighHumiditySignal(aggregate: InstantAggregate): boolean {
  return (
    aggregate.humidityPercent !== null &&
    aggregate.humidityPercent >= LAUNDRY_POLICY.highHumidityPercent
  );
}

/**
 * An instant is a **drying forecast** — usable for a positive verdict — only when it carries all
 * three: a usable temperature, a usable humidity, and precipitation assessability.
 */
function isDryingForecast(aggregate: InstantAggregate): boolean {
  return (
    aggregate.temperatureCelsius !== null &&
    aggregate.humidityPercent !== null &&
    aggregate.precipitationAssessable
  );
}

/**
 * Assess how suitable outdoor laundry drying is over the next
 * {@link LAUNDRY_POLICY}.evaluationWindowHours, anchored at `input.evaluatedAt`.
 *
 * The evaluation window is `[evaluatedAt, evaluatedAt + evaluationWindowHours]` inclusive at both
 * ends; forecasts outside it (past, or beyond the window) are ignored. Forecasts sharing one
 * absolute instant collapse to a single conservative representative. Status priority:
 * 1. any strong precipitation signal → `NOT_RECOMMENDED` (`PRECIPITATION_EXPECTED`);
 * 2. else any strong-wind signal → `NOT_RECOMMENDED` (`STRONG_WIND`);
 * 3. else any possible-precipitation signal → `POOR` (`PRECIPITATION_POSSIBLE`);
 * 4. else any high-humidity signal → `POOR` (`HIGH_HUMIDITY`);
 * 5. else, with insufficient drying coverage → `INSUFFICIENT_DATA` (`INSUFFICIENT_FORECAST`);
 * 6. else EXCELLENT / GOOD / FAIR by the humidity + temperature bands.
 *
 * A clear adverse signal produces a real status even from sparse data (`dataQuality: 'LIMITED'`);
 * a positive FAIR/GOOD/EXCELLENT verdict is only ever returned with sufficient drying coverage
 * (`dataQuality: 'SUFFICIENT'`). The input array and its objects are never mutated; the result is
 * independent of input order and of differing timezone spellings of the same instant.
 *
 * @throws RangeError synchronously if `evaluatedAt` is not a timezone-qualified ISO 8601 datetime.
 *   The message is fixed and never echoes the input.
 */
export function assessLaundryDryingSuitability(input: LaundryAssessmentInput): LaundryDecision {
  const startMs = parseAbsoluteInstantMs(input.evaluatedAt);
  if (startMs === null) {
    throw new RangeError('evaluatedAt must be an ISO 8601 datetime with a timezone designator');
  }

  const windowEndMs = startMs + LAUNDRY_POLICY.evaluationWindowHours * HOUR_IN_MS;
  const coverageMinimumMs = startMs + LAUNDRY_POLICY.minimumDryingCoverageHours * HOUR_IN_MS;

  const rawForecasts: readonly unknown[] = Array.isArray(input.hourlyForecasts)
    ? input.hourlyForecasts
    : [];

  // Aggregate by absolute instant. The original array and objects are only read, never written.
  const aggregatesByInstant = new Map<number, InstantAggregate>();
  for (const rawForecast of rawForecasts) {
    // Exclude null, arrays, and non-objects (number / string / boolean) outright.
    if (rawForecast === null || typeof rawForecast !== 'object' || Array.isArray(rawForecast)) {
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
    let aggregate = aggregatesByInstant.get(instantMs);
    if (aggregate === undefined) {
      aggregate = emptyAggregate();
      aggregatesByInstant.set(instantMs, aggregate);
    }
    foldForecast(aggregate, forecast);
  }

  // Reduce the representatives (sorted ascending so the first match is the earliest instant).
  const sortedInstants = [...aggregatesByInstant.keys()].sort((a, b) => a - b);

  let firstStrongPrecipitationMs: number | null = null;
  let firstStrongWindMs: number | null = null;
  let firstPossiblePrecipitationMs: number | null = null;
  let firstHighHumidityMs: number | null = null;

  let peakProbability: number | null = null;
  let peakPrecipitationAmount: number | null = null;
  let peakSnowfall: number | null = null;
  let maximumHumidity: number | null = null;
  let minimumTemperature: number | null = null;
  let maximumWind: number | null = null;

  let dryingForecastCount = 0;
  let lastDryingForecastMs: number | null = null;

  for (const instantMs of sortedInstants) {
    const aggregate = aggregatesByInstant.get(instantMs) as InstantAggregate;

    if (aggregate.precipitationProbabilityPercent !== null) {
      peakProbability = maxOrKeep(peakProbability, aggregate.precipitationProbabilityPercent);
    }
    if (aggregate.precipitationAmountMillimeters !== null) {
      peakPrecipitationAmount = maxOrKeep(
        peakPrecipitationAmount,
        aggregate.precipitationAmountMillimeters,
      );
    }
    if (aggregate.snowfallAmountCentimeters !== null) {
      peakSnowfall = maxOrKeep(peakSnowfall, aggregate.snowfallAmountCentimeters);
    }
    if (aggregate.humidityPercent !== null) {
      maximumHumidity = maxOrKeep(maximumHumidity, aggregate.humidityPercent);
    }
    if (aggregate.temperatureCelsius !== null) {
      minimumTemperature = minOrKeep(minimumTemperature, aggregate.temperatureCelsius);
    }
    if (aggregate.windSpeedMetersPerSecond !== null) {
      maximumWind = maxOrKeep(maximumWind, aggregate.windSpeedMetersPerSecond);
    }

    if (firstStrongPrecipitationMs === null && hasStrongPrecipitationSignal(aggregate)) {
      firstStrongPrecipitationMs = instantMs;
    }
    if (firstStrongWindMs === null && hasStrongWindSignal(aggregate)) {
      firstStrongWindMs = instantMs;
    }
    if (firstPossiblePrecipitationMs === null && hasPossiblePrecipitationSignal(aggregate)) {
      firstPossiblePrecipitationMs = instantMs;
    }
    if (firstHighHumidityMs === null && hasHighHumiditySignal(aggregate)) {
      firstHighHumidityMs = instantMs;
    }

    if (isDryingForecast(aggregate)) {
      dryingForecastCount += 1;
      lastDryingForecastMs =
        lastDryingForecastMs === null ? instantMs : Math.max(lastDryingForecastMs, instantMs);
    }
  }

  const dryingCoverageMet =
    dryingForecastCount >= LAUNDRY_POLICY.minimumDryingForecastCount &&
    lastDryingForecastMs !== null &&
    lastDryingForecastMs >= coverageMinimumMs;

  // Status priority. A clear adverse signal wins regardless of coverage; a positive verdict needs
  // coverage.
  let resolution: StatusResolution;
  let firstAdverseMs: number | null;
  if (firstStrongPrecipitationMs !== null) {
    resolution = {
      status: 'NOT_RECOMMENDED',
      reasonCode: 'PRECIPITATION_EXPECTED',
      driver: 'PRECIPITATION',
    };
    firstAdverseMs = firstStrongPrecipitationMs;
  } else if (firstStrongWindMs !== null) {
    resolution = { status: 'NOT_RECOMMENDED', reasonCode: 'STRONG_WIND', driver: 'WIND' };
    firstAdverseMs = firstStrongWindMs;
  } else if (firstPossiblePrecipitationMs !== null) {
    resolution = {
      status: 'POOR',
      reasonCode: 'PRECIPITATION_POSSIBLE',
      driver: 'PRECIPITATION',
    };
    firstAdverseMs = firstPossiblePrecipitationMs;
  } else if (firstHighHumidityMs !== null) {
    resolution = { status: 'POOR', reasonCode: 'HIGH_HUMIDITY', driver: 'HUMIDITY' };
    firstAdverseMs = firstHighHumidityMs;
  } else if (!dryingCoverageMet) {
    resolution = {
      status: 'INSUFFICIENT_DATA',
      reasonCode: 'INSUFFICIENT_FORECAST',
      driver: null,
    };
    firstAdverseMs = null;
  } else if (
    maximumHumidity !== null &&
    maximumHumidity <= LAUNDRY_POLICY.excellentMaximumHumidityPercent &&
    minimumTemperature !== null &&
    minimumTemperature >= LAUNDRY_POLICY.excellentMinimumTemperatureCelsius
  ) {
    resolution = {
      status: 'EXCELLENT',
      reasonCode: 'EXCELLENT_DRYING_CONDITIONS',
      driver: 'TEMPERATURE_HUMIDITY',
    };
    firstAdverseMs = null;
  } else if (
    maximumHumidity !== null &&
    maximumHumidity <= LAUNDRY_POLICY.goodMaximumHumidityPercent &&
    minimumTemperature !== null &&
    minimumTemperature >= LAUNDRY_POLICY.goodMinimumTemperatureCelsius
  ) {
    resolution = {
      status: 'GOOD',
      reasonCode: 'FAVORABLE_DRYING_CONDITIONS',
      driver: 'TEMPERATURE_HUMIDITY',
    };
    firstAdverseMs = null;
  } else {
    resolution = {
      status: 'FAIR',
      reasonCode: 'MARGINAL_DRYING_CONDITIONS',
      driver: 'TEMPERATURE_HUMIDITY',
    };
    firstAdverseMs = null;
  }

  let dataQuality: LaundryDataQuality;
  if (resolution.status === 'INSUFFICIENT_DATA') {
    dataQuality = 'INSUFFICIENT';
  } else if (dryingCoverageMet) {
    dataQuality = 'SUFFICIENT';
  } else {
    dataQuality = 'LIMITED';
  }

  const copy = DECISION_COPY[resolution.reasonCode];

  return {
    policyVersion: LAUNDRY_POLICY.policyVersion,
    status: resolution.status,
    reasonCode: resolution.reasonCode,
    reason: copy.reason,
    recommendation: copy.recommendation,
    driver: resolution.driver,
    dataQuality,
    evidence: {
      windowStartAt: new Date(startMs).toISOString(),
      windowEndAt: new Date(windowEndMs).toISOString(),
      firstAdverseAt: firstAdverseMs === null ? null : new Date(firstAdverseMs).toISOString(),
      peakPrecipitationProbabilityPercent: peakProbability,
      peakPrecipitationAmountMillimeters: peakPrecipitationAmount,
      peakSnowfallAmountCentimeters: peakSnowfall,
      maximumHumidityPercent: maximumHumidity,
      minimumTemperatureCelsius: minimumTemperature,
      maximumWindSpeedMetersPerSecond: maximumWind,
      consideredForecastCount: aggregatesByInstant.size,
      dryingForecastCount,
      lastDryingForecastAt:
        lastDryingForecastMs === null ? null : new Date(lastDryingForecastMs).toISOString(),
      dryingCoverageMet,
    },
  };
}
