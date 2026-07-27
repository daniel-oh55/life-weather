/**
 * Outfit recommendation engine — the second "life weather" calculation.
 *
 * {@link assessOutfitRecommendation} takes a normalized {@link HourlyForecast} list and an
 * explicit evaluation instant, analyses the felt (effective) temperature over the next
 * {@link OUTFIT_POLICY}.assessmentWindowHours, and deterministically returns an outfit
 * recommendation. It is pure TypeScript: it never reads the system clock (no `Date.now()` /
 * no argument-less `new Date()`), never touches the network, never reads environment
 * variables, and never mutates its input. Given the same input it always returns the same
 * result.
 *
 * The thresholds below are Life Weather's **initial product heuristic**, not an official
 * 기상청 (KMA) 생활지수. See `docs/lifestyle-outfit-policy.md`. Any change to how a decision is
 * reached must bump {@link OUTFIT_POLICY}.policyVersion.
 *
 * This PR does not compute a new "feels like" formula: it prefers the upstream
 * `feelsLikeCelsius` and falls back to the actual air temperature when it is absent. Humidity,
 * wind, precipitation, UV, and personalization are not inputs of this policy.
 */

import type { HourlyForecast } from '@life-weather/contracts';

const HOUR_IN_MS = 3_600_000;

/**
 * The policy for one outfit assessment. Frozen so a consumer cannot mutate the shared
 * thresholds at runtime; the literal types are preserved via `as const`.
 *
 * - `assessmentWindowHours` — how far ahead of `evaluatedAt` a forecast is considered.
 * - `minimumForecastCount` — distinct usable instants needed for `SUFFICIENT` data quality.
 * - `minimumCoverageHours` — the last usable instant must be at least this far out for
 *   `SUFFICIENT`.
 * - `layeringTemperatureRangeThresholdCelsius` — a spread at/above this recommends layering.
 * - `*MaximumCelsius` — the inclusive upper bound of each temperature band; a reference
 *   temperature above `hotMaximumCelsius` is `VERY_HOT`.
 */
export const OUTFIT_POLICY = Object.freeze({
  policyVersion: '1.0.0',
  assessmentWindowHours: 6,
  minimumForecastCount: 3,
  minimumCoverageHours: 2,
  layeringTemperatureRangeThresholdCelsius: 8,
  extremeColdMaximumCelsius: -10,
  veryColdMaximumCelsius: 0,
  coldMaximumCelsius: 8,
  coolMaximumCelsius: 14,
  mildMaximumCelsius: 20,
  warmMaximumCelsius: 24,
  hotMaximumCelsius: 28,
} as const);

export type OutfitStatus =
  | 'EXTREME_COLD'
  | 'VERY_COLD'
  | 'COLD'
  | 'COOL'
  | 'MILD'
  | 'WARM'
  | 'HOT'
  | 'VERY_HOT'
  | 'INSUFFICIENT_DATA';

export type OutfitReasonCode =
  | 'EXTREME_COLD_CONDITIONS'
  | 'VERY_COLD_CONDITIONS'
  | 'COLD_CONDITIONS'
  | 'COOL_CONDITIONS'
  | 'MILD_CONDITIONS'
  | 'WARM_CONDITIONS'
  | 'HOT_CONDITIONS'
  | 'VERY_HOT_CONDITIONS'
  | 'INSUFFICIENT_FORECAST';

export type OutfitDataQuality = 'SUFFICIENT' | 'LIMITED' | 'INSUFFICIENT';

/** Which upstream value produced an effective temperature. */
export type OutfitTemperatureSource = 'FEELS_LIKE' | 'AIR_TEMPERATURE';

/**
 * The forecast-derived facts a decision rests on. Timestamps are canonical UTC ISO 8601
 * (millisecond precision), derived only from the input — the mobile presenter formats them for
 * display. No raw provider payload is exposed here.
 *
 * `consideredForecastCount` and `usableForecastCount` are both counted over **distinct
 * `forecastAt` instants** inside the window: duplicates of the same instant collapse to one. An
 * instant is *usable* if at least one forecast at that instant has a finite effective
 * temperature. Numbers keep the input's precision — nothing is rounded.
 */
export interface OutfitEvidence {
  windowStartAt: string;
  windowEndAt: string;
  referenceAt: string | null;
  referenceTemperatureCelsius: number | null;
  referenceTemperatureSource: OutfitTemperatureSource | null;
  minimumEffectiveTemperatureCelsius: number | null;
  maximumEffectiveTemperatureCelsius: number | null;
  temperatureRangeCelsius: number | null;
  consideredForecastCount: number;
  usableForecastCount: number;
}

export interface OutfitDecision {
  policyVersion: string;
  status: OutfitStatus;
  reasonCode: OutfitReasonCode;
  reason: string;
  recommendation: string;
  additionalRecommendation: string | null;
  layeringRecommended: boolean;
  dataQuality: OutfitDataQuality;
  evidence: OutfitEvidence;
}

export interface OutfitAssessmentInput {
  /** The instant the assessment is anchored to; an ISO 8601 datetime with a timezone. */
  evaluatedAt: string;
  /** Normalized hourly forecasts. Order is not trusted; the array is not mutated. */
  hourlyForecasts: readonly HourlyForecast[];
}

interface DecisionCopy {
  reasonCode: OutfitReasonCode;
  reason: string;
  recommendation: string;
}

/**
 * The stable Korean user-facing copy and machine reason code for each status. This is the
 * single source of truth ensuring `reason` / `recommendation` / `reasonCode` always match the
 * status. The copy avoids any medical or illness-risk phrasing.
 */
const DECISION_COPY: Readonly<Record<OutfitStatus, DecisionCopy>> = Object.freeze({
  EXTREME_COLD: {
    reasonCode: 'EXTREME_COLD_CONDITIONS',
    reason: '앞으로 6시간 동안 매우 추운 날씨가 예상됩니다.',
    recommendation: '두꺼운 패딩과 보온 내의를 착용하세요.',
  },
  VERY_COLD: {
    reasonCode: 'VERY_COLD_CONDITIONS',
    reason: '앞으로 6시간 동안 영하권 또는 매우 낮은 기온이 예상됩니다.',
    recommendation: '패딩이나 두꺼운 코트와 보온용품을 준비하세요.',
  },
  COLD: {
    reasonCode: 'COLD_CONDITIONS',
    reason: '앞으로 6시간 동안 쌀쌀한 날씨가 예상됩니다.',
    recommendation: '코트나 두꺼운 재킷을 입으세요.',
  },
  COOL: {
    reasonCode: 'COOL_CONDITIONS',
    reason: '앞으로 6시간 동안 서늘한 날씨가 예상됩니다.',
    recommendation: '재킷이나 가벼운 코트를 걸치세요.',
  },
  MILD: {
    reasonCode: 'MILD_CONDITIONS',
    reason: '앞으로 6시간 동안 비교적 온화한 날씨가 예상됩니다.',
    recommendation: '긴소매 옷이나 얇은 겉옷이 적절합니다.',
  },
  WARM: {
    reasonCode: 'WARM_CONDITIONS',
    reason: '앞으로 6시간 동안 따뜻한 날씨가 예상됩니다.',
    recommendation: '얇은 긴소매나 반소매 옷이 적절합니다.',
  },
  HOT: {
    reasonCode: 'HOT_CONDITIONS',
    reason: '앞으로 6시간 동안 더운 날씨가 예상됩니다.',
    recommendation: '가볍고 통풍이 잘되는 옷을 입으세요.',
  },
  VERY_HOT: {
    reasonCode: 'VERY_HOT_CONDITIONS',
    reason: '앞으로 6시간 동안 매우 더운 날씨가 예상됩니다.',
    recommendation: '매우 가볍고 통풍이 잘되는 옷을 입고 더위에 대비하세요.',
  },
  INSUFFICIENT_DATA: {
    reasonCode: 'INSUFFICIENT_FORECAST',
    reason: '옷차림을 판단할 온도 예보가 부족합니다.',
    recommendation: '최신 기온과 체감온도를 다시 확인하세요.',
  },
});

/** Additional guidance shown only when the felt-temperature spread recommends layering. */
const LAYERING_RECOMMENDATION =
  '시간대별 온도 차가 커서 벗고 입기 쉬운 겉옷을 준비하세요.';

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

interface EffectiveTemperature {
  temperatureCelsius: number;
  source: OutfitTemperatureSource;
}

/**
 * The effective (felt) temperature of one forecast, using the fixed priority:
 * 1. `feelsLikeCelsius` when it is a finite number → `FEELS_LIKE`;
 * 2. otherwise `temperatureCelsius` when it is a finite number → `AIR_TEMPERATURE`;
 * 3. otherwise `null` — this forecast is unusable for temperature.
 *
 * No new feels-like value is computed here; the upstream value is preferred and the air
 * temperature is only a fallback. `NaN`, `Infinity`, and non-number runtime values never win.
 */
function effectiveTemperatureOf(forecast: HourlyForecast): EffectiveTemperature | null {
  const feelsLike = finiteNumberOrNull(forecast.feelsLikeCelsius);
  if (feelsLike !== null) {
    return { temperatureCelsius: feelsLike, source: 'FEELS_LIKE' };
  }
  const airTemperature = finiteNumberOrNull(forecast.temperatureCelsius);
  if (airTemperature !== null) {
    return { temperatureCelsius: airTemperature, source: 'AIR_TEMPERATURE' };
  }
  return null;
}

/** The representative (per-instant) effective temperature and the source that produced it. */
interface InstantTemperature {
  temperatureCelsius: number;
  source: OutfitTemperatureSource;
}

/**
 * Fold one forecast's effective temperature into the running representative for its instant.
 *
 * The representative temperature of an instant is the **minimum** usable effective temperature
 * seen at that instant — the more conservative (warmer-dressing) choice. When two forecasts tie
 * at that minimum and one is `FEELS_LIKE` while the other is `AIR_TEMPERATURE`, `FEELS_LIKE`
 * wins the source. The fold is order-independent.
 */
function foldInstantTemperature(
  current: InstantTemperature | null,
  candidate: EffectiveTemperature,
): InstantTemperature {
  if (current === null || candidate.temperatureCelsius < current.temperatureCelsius) {
    return { temperatureCelsius: candidate.temperatureCelsius, source: candidate.source };
  }
  if (
    candidate.temperatureCelsius === current.temperatureCelsius &&
    current.source !== 'FEELS_LIKE' &&
    candidate.source === 'FEELS_LIKE'
  ) {
    return { temperatureCelsius: current.temperatureCelsius, source: 'FEELS_LIKE' };
  }
  return current;
}

/** Map a reference effective temperature to an outfit band. Upper bounds are inclusive. */
function classifyStatus(referenceTemperatureCelsius: number): OutfitStatus {
  if (referenceTemperatureCelsius <= OUTFIT_POLICY.extremeColdMaximumCelsius) {
    return 'EXTREME_COLD';
  }
  if (referenceTemperatureCelsius <= OUTFIT_POLICY.veryColdMaximumCelsius) {
    return 'VERY_COLD';
  }
  if (referenceTemperatureCelsius <= OUTFIT_POLICY.coldMaximumCelsius) {
    return 'COLD';
  }
  if (referenceTemperatureCelsius <= OUTFIT_POLICY.coolMaximumCelsius) {
    return 'COOL';
  }
  if (referenceTemperatureCelsius <= OUTFIT_POLICY.mildMaximumCelsius) {
    return 'MILD';
  }
  if (referenceTemperatureCelsius <= OUTFIT_POLICY.warmMaximumCelsius) {
    return 'WARM';
  }
  if (referenceTemperatureCelsius <= OUTFIT_POLICY.hotMaximumCelsius) {
    return 'HOT';
  }
  return 'VERY_HOT';
}

/**
 * Recommend an outfit for the next {@link OUTFIT_POLICY}.assessmentWindowHours, anchored at
 * `input.evaluatedAt`.
 *
 * The evaluation window is `[evaluatedAt, evaluatedAt + assessmentWindowHours]` inclusive at
 * both ends; forecasts outside it (past, or beyond the window) are ignored. Each forecast's
 * effective temperature prefers `feelsLikeCelsius` and falls back to `temperatureCelsius`.
 * Forecasts sharing one absolute instant collapse to a single representative temperature (the
 * minimum effective temperature at that instant). The reference temperature is the lowest
 * representative temperature across the window — a conservative choice that avoids
 * under-dressing — and it decides the outfit band.
 *
 * The input array and its objects are never mutated; the result is independent of input order
 * and of differing timezone spellings of the same instant.
 *
 * @throws RangeError synchronously if `evaluatedAt` is not a timezone-qualified ISO 8601
 *   datetime. The message is fixed and never echoes the input.
 */
export function assessOutfitRecommendation(
  input: OutfitAssessmentInput,
): OutfitDecision {
  const startMs = parseAbsoluteInstantMs(input.evaluatedAt);
  if (startMs === null) {
    throw new RangeError(
      'evaluatedAt must be an ISO 8601 datetime with a timezone designator',
    );
  }

  const windowEndMs = startMs + OUTFIT_POLICY.assessmentWindowHours * HOUR_IN_MS;
  const coverageMinimumMs = startMs + OUTFIT_POLICY.minimumCoverageHours * HOUR_IN_MS;

  const rawForecasts: readonly unknown[] = Array.isArray(input.hourlyForecasts)
    ? input.hourlyForecasts
    : [];

  // Aggregate by absolute instant. `representative` is null while an instant has no usable
  // effective temperature yet. The original array and objects are only read, never written.
  const consideredInstants = new Set<number>();
  const representativeByInstant = new Map<number, InstantTemperature | null>();

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

    consideredInstants.add(instantMs);
    if (!representativeByInstant.has(instantMs)) {
      representativeByInstant.set(instantMs, null);
    }
    const effective = effectiveTemperatureOf(forecast);
    if (effective !== null) {
      representativeByInstant.set(
        instantMs,
        foldInstantTemperature(representativeByInstant.get(instantMs) ?? null, effective),
      );
    }
  }

  // Reduce the usable instants to the reference (lowest, earliest) and the min/max spread.
  let referenceAtMs: number | null = null;
  let referenceTemperature: number | null = null;
  let referenceSource: OutfitTemperatureSource | null = null;
  let minimumTemperature: number | null = null;
  let maximumTemperature: number | null = null;
  let usableForecastCount = 0;
  let lastUsableMs: number | null = null;

  // Sort instants ascending so the earliest instant naturally wins ties for the reference.
  const sortedInstants = [...representativeByInstant.keys()].sort((a, b) => a - b);
  for (const instantMs of sortedInstants) {
    const representative = representativeByInstant.get(instantMs) ?? null;
    if (representative === null) {
      continue;
    }
    usableForecastCount += 1;
    lastUsableMs = lastUsableMs === null ? instantMs : Math.max(lastUsableMs, instantMs);

    const temperature = representative.temperatureCelsius;
    if (minimumTemperature === null || temperature < minimumTemperature) {
      minimumTemperature = temperature;
    }
    if (maximumTemperature === null || temperature > maximumTemperature) {
      maximumTemperature = temperature;
    }
    // Strictly-less keeps the earliest instant when representative temperatures tie.
    if (referenceTemperature === null || temperature < referenceTemperature) {
      referenceTemperature = temperature;
      referenceAtMs = instantMs;
      referenceSource = representative.source;
    }
  }

  const temperatureRange =
    minimumTemperature === null || maximumTemperature === null
      ? null
      : maximumTemperature - minimumTemperature;
  const layeringRecommended =
    temperatureRange !== null &&
    temperatureRange >= OUTFIT_POLICY.layeringTemperatureRangeThresholdCelsius;

  let status: OutfitStatus;
  let dataQuality: OutfitDataQuality;
  if (referenceTemperature === null) {
    status = 'INSUFFICIENT_DATA';
    dataQuality = 'INSUFFICIENT';
  } else {
    status = classifyStatus(referenceTemperature);
    const hasSufficientCoverage =
      usableForecastCount >= OUTFIT_POLICY.minimumForecastCount &&
      lastUsableMs !== null &&
      lastUsableMs >= coverageMinimumMs;
    dataQuality = hasSufficientCoverage ? 'SUFFICIENT' : 'LIMITED';
  }

  const copy = DECISION_COPY[status];

  return {
    policyVersion: OUTFIT_POLICY.policyVersion,
    status,
    reasonCode: copy.reasonCode,
    reason: copy.reason,
    recommendation: copy.recommendation,
    additionalRecommendation: layeringRecommended ? LAYERING_RECOMMENDATION : null,
    layeringRecommended,
    dataQuality,
    evidence: {
      windowStartAt: new Date(startMs).toISOString(),
      windowEndAt: new Date(windowEndMs).toISOString(),
      referenceAt: referenceAtMs === null ? null : new Date(referenceAtMs).toISOString(),
      referenceTemperatureCelsius: referenceTemperature,
      referenceTemperatureSource: referenceSource,
      minimumEffectiveTemperatureCelsius: minimumTemperature,
      maximumEffectiveTemperatureCelsius: maximumTemperature,
      temperatureRangeCelsius: temperatureRange,
      consideredForecastCount: consideredInstants.size,
      usableForecastCount,
    },
  };
}
