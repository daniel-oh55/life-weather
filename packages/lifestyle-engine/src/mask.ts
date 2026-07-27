/**
 * Mask recommendation engine — the third "life weather" calculation.
 *
 * {@link assessMaskNeed} takes a normalized {@link CurrentAirQuality} observation and an explicit
 * evaluation instant, analyses the current PM10 / PM2.5 particulate levels and the freshness of
 * the measurement, and deterministically decides whether a health mask is needed. It is pure
 * TypeScript: it never reads the system clock (no `Date.now()` / no argument-less `new Date()`),
 * never touches the network, never reads environment variables, and never mutates its input.
 * Given the same input it always returns the same result.
 *
 * The **concentration → grade** bands below are the current 공식 AirKorea 실시간 등급 구간 used as
 * reference data. The final **grade → mask status** mapping (VERY_BAD → REQUIRED, BAD →
 * RECOMMENDED, GOOD/MODERATE → NOT_NEEDED) is Life Weather's **initial product heuristic**, not an
 * official 기상청 / AirKorea 행동요령. This engine only covers 보건용 마스크 guidance for
 * particulate matter; it provides **no medical diagnosis and no personalised health instruction**.
 * See `docs/lifestyle-mask-policy.md`. Any change to how a decision is reached must bump
 * {@link MASK_POLICY}.policyVersion.
 *
 * Only `measuredAt`, `pm10MicrogramsPerCubicMeter`, `pm25MicrogramsPerCubicMeter`, `pm10Grade`,
 * and `pm25Grade` are consulted. Ozone, the composite index (CAI), and `overallGrade` are
 * deliberately ignored — `overallGrade` can be driven worse by ozone, so it must not decide a
 * particulate-mask recommendation.
 */

import type { AirQualityGrade, CurrentAirQuality } from '@life-weather/contracts';

const MINUTE_IN_MS = 60_000;

/**
 * The policy for one mask assessment. Frozen so a consumer cannot mutate the shared thresholds at
 * runtime; the literal types are preserved via `as const`.
 *
 * - `maximumObservationAgeMinutes` — an observation at most this old (inclusive) is still current.
 * - `pm10*MaximumMicrogramsPerCubicMeter` / `pm25*MaximumMicrogramsPerCubicMeter` — the inclusive
 *   upper bound of each AirKorea concentration band; a value above the `Bad` bound is `VERY_BAD`.
 */
export const MASK_POLICY = Object.freeze({
  policyVersion: '1.0.0',
  maximumObservationAgeMinutes: 180,
  pm10GoodMaximumMicrogramsPerCubicMeter: 30,
  pm10ModerateMaximumMicrogramsPerCubicMeter: 80,
  pm10BadMaximumMicrogramsPerCubicMeter: 150,
  pm25GoodMaximumMicrogramsPerCubicMeter: 15,
  pm25ModerateMaximumMicrogramsPerCubicMeter: 35,
  pm25BadMaximumMicrogramsPerCubicMeter: 75,
} as const);

export type MaskStatus =
  | 'REQUIRED'
  | 'RECOMMENDED'
  | 'NOT_NEEDED'
  | 'INSUFFICIENT_DATA';

export type MaskReasonCode =
  | 'PARTICULATE_VERY_BAD'
  | 'PARTICULATE_BAD'
  | 'PARTICULATE_ACCEPTABLE'
  | 'STALE_AIR_QUALITY'
  | 'INVALID_MEASUREMENT_TIME'
  | 'INSUFFICIENT_PARTICULATE_DATA';

export type MaskDataQuality = 'SUFFICIENT' | 'LIMITED' | 'INSUFFICIENT';

export type MaskFreshness = 'FRESH' | 'STALE' | 'INVALID' | 'MISSING';

export type MaskPollutant = 'PM10' | 'PM25' | 'BOTH';

/** A particulate grade the engine can act on. Unlike {@link AirQualityGrade} it has no `UNKNOWN`. */
export type MaskParticulateGrade = 'GOOD' | 'MODERATE' | 'BAD' | 'VERY_BAD';

/** Which usable inputs produced a pollutant's effective grade. */
export type MaskGradeSource = 'PROVIDER_GRADE' | 'CONCENTRATION' | 'BOTH';

/**
 * The per-pollutant facts a decision rests on. All fields are derived only from the input and
 * carry the input's numeric precision — nothing is rounded.
 *
 * - `providerGrade` — the normalized provider grade: a known {@link AirQualityGrade}, `UNKNOWN`
 *   for any other string, or `null` for a non-string / absent value. A raw unknown string is
 *   never echoed here.
 * - `derivedGrade` — the grade implied by the sanitized concentration (AirKorea bands), or `null`.
 * - `effectiveGrade` — the grade the status uses: the *worse* of the two when both are usable,
 *   otherwise whichever is usable (`UNKNOWN` never counts). `null` when neither is usable.
 * - `gradeSource` — which usable inputs produced `effectiveGrade`.
 * - `gradeDisagreement` — `true` only when a usable provider grade and a derived grade both exist
 *   and differ (a conservative signal that provider and concentration conflict).
 */
export interface MaskPollutantEvidence {
  concentrationMicrogramsPerCubicMeter: number | null;
  providerGrade: AirQualityGrade | null;
  derivedGrade: MaskParticulateGrade | null;
  effectiveGrade: MaskParticulateGrade | null;
  gradeSource: MaskGradeSource | null;
  gradeDisagreement: boolean;
}

/**
 * The observation-derived facts a decision rests on. `measuredAt` is canonical UTC ISO 8601
 * (millisecond precision) when the input time is parseable, else `null`. No raw provider payload,
 * ozone value, composite index, or `overallGrade` is exposed here.
 *
 * `availablePollutantCount` is the number of pollutants (0–2) with an `effectiveGrade`; it is
 * reported independently of freshness, so a stale-but-populated observation still shows the PM
 * evidence it carried.
 */
export interface MaskEvidence {
  measuredAt: string | null;
  observationAgeMinutes: number | null;
  freshness: MaskFreshness;
  driver: MaskPollutant | null;
  availablePollutantCount: number;
  pm10: MaskPollutantEvidence;
  pm25: MaskPollutantEvidence;
}

export interface MaskDecision {
  policyVersion: string;
  status: MaskStatus;
  reasonCode: MaskReasonCode;
  reason: string;
  recommendation: string;
  dataQuality: MaskDataQuality;
  evidence: MaskEvidence;
}

export interface MaskAssessmentInput {
  /** The instant the assessment is anchored to; an ISO 8601 datetime with a timezone. */
  evaluatedAt: string;
  /** The normalized current air-quality observation, or `null` when none is available. */
  airQuality: CurrentAirQuality | null;
}

/** Severity ordering of the particulate grades: `GOOD < MODERATE < BAD < VERY_BAD`. */
const GRADE_SEVERITY: Readonly<Record<MaskParticulateGrade, number>> = Object.freeze({
  GOOD: 0,
  MODERATE: 1,
  BAD: 2,
  VERY_BAD: 3,
});

/** The provider grades the engine can act on. `UNKNOWN` is intentionally excluded. */
const ACTIONABLE_PROVIDER_GRADES: ReadonlySet<string> = new Set<MaskParticulateGrade>([
  'GOOD',
  'MODERATE',
  'BAD',
  'VERY_BAD',
]);

interface MaskCopy {
  reason: string;
  recommendation: string;
}

/** The `reason` for `REQUIRED`, keyed by the pollutant that drove it. */
const REQUIRED_REASON: Readonly<Record<MaskPollutant, string>> = Object.freeze({
  PM25: '현재 초미세먼지가 매우 나쁨 수준입니다.',
  PM10: '현재 미세먼지가 매우 나쁨 수준입니다.',
  BOTH: '현재 초미세먼지와 미세먼지가 매우 나쁨 수준입니다.',
});

/** The `reason` for `RECOMMENDED`, keyed by the pollutant that drove it. */
const RECOMMENDED_REASON: Readonly<Record<MaskPollutant, string>> = Object.freeze({
  PM25: '현재 초미세먼지가 나쁨 수준입니다.',
  PM10: '현재 미세먼지가 나쁨 수준입니다.',
  BOTH: '현재 초미세먼지와 미세먼지가 나쁨 수준입니다.',
});

const REQUIRED_RECOMMENDATION = '외출할 때 식약처 인증 보건용 마스크를 착용하세요.';
const RECOMMENDED_RECOMMENDATION = '외출할 때 보건용 마스크를 준비해 착용하세요.';

/**
 * The stable Korean copy for the reason codes whose text does not depend on the driver. The
 * driver-dependent `REQUIRED` / `RECOMMENDED` copy is resolved in {@link resolveCopy}. Keeping the
 * copy in one place ensures `status` / `reasonCode` / `reason` / `recommendation` never drift.
 * None of the copy uses medical, illness-risk, or KF-grade phrasing.
 */
const STATIC_COPY: Readonly<
  Record<
    | 'PARTICULATE_ACCEPTABLE'
    | 'STALE_AIR_QUALITY'
    | 'INVALID_MEASUREMENT_TIME'
    | 'INSUFFICIENT_PARTICULATE_DATA',
    MaskCopy
  >
> = Object.freeze({
  PARTICULATE_ACCEPTABLE: {
    reason: '현재 확인 가능한 미세먼지 수준은 좋음 또는 보통입니다.',
    recommendation: '일반적인 외출에서는 마스크가 꼭 필요하지 않습니다.',
  },
  STALE_AIR_QUALITY: {
    reason: '대기질 측정값이 오래되어 현재 마스크 필요 여부를 판단하기 어렵습니다.',
    recommendation: '최신 미세먼지 정보를 다시 확인하세요.',
  },
  INVALID_MEASUREMENT_TIME: {
    reason: '대기질 측정 시각을 확인할 수 없어 마스크 필요 여부를 판단하기 어렵습니다.',
    recommendation: '최신 미세먼지 정보를 다시 확인하세요.',
  },
  INSUFFICIENT_PARTICULATE_DATA: {
    reason: '마스크 필요 여부를 판단할 미세먼지 정보가 부족합니다.',
    recommendation: '최신 미세먼지 정보를 다시 확인하세요.',
  },
});

/** Resolve the user-facing copy for a decision. The driver is only consulted for the two grades. */
function resolveCopy(reasonCode: MaskReasonCode, driver: MaskPollutant | null): MaskCopy {
  switch (reasonCode) {
    case 'PARTICULATE_VERY_BAD':
      return {
        reason: REQUIRED_REASON[driver ?? 'BOTH'],
        recommendation: REQUIRED_RECOMMENDATION,
      };
    case 'PARTICULATE_BAD':
      return {
        reason: RECOMMENDED_REASON[driver ?? 'BOTH'],
        recommendation: RECOMMENDED_RECOMMENDATION,
      };
    default:
      return STATIC_COPY[reasonCode];
  }
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
 * runtime-invalid `measuredAt` (non-string, malformed, impossible date) is handled without
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
// Pollutant normalization
// ---------------------------------------------------------------------------

/**
 * A usable mass concentration (`typeof === 'number'`, finite, `>= 0`), or `null` for anything else
 * (`null`, `undefined`, `NaN`, `±Infinity`, a negative value, or a non-number runtime value). The
 * value is never rounded.
 */
function usableConcentrationOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Normalize a provider grade for evidence: a known {@link AirQualityGrade} is kept, any other
 * string collapses to `UNKNOWN` (never echoed verbatim), and a non-string / absent value is
 * `null`. This keeps evidence consistent with the contracts' forward-compatible enum behaviour.
 */
function normalizeProviderGrade(value: unknown): AirQualityGrade | null {
  if (typeof value !== 'string') {
    return null;
  }
  if (
    value === 'GOOD' ||
    value === 'MODERATE' ||
    value === 'BAD' ||
    value === 'VERY_BAD' ||
    value === 'UNKNOWN'
  ) {
    return value;
  }
  return 'UNKNOWN';
}

/** The provider grade the engine can act on, or `null` when it is absent or `UNKNOWN`. */
function actionableProviderGrade(grade: AirQualityGrade | null): MaskParticulateGrade | null {
  return grade !== null && ACTIONABLE_PROVIDER_GRADES.has(grade)
    ? (grade as MaskParticulateGrade)
    : null;
}

/** Map a sanitized concentration to a grade using inclusive AirKorea band upper bounds. */
function deriveGradeFromConcentration(
  concentration: number,
  goodMaximum: number,
  moderateMaximum: number,
  badMaximum: number,
): MaskParticulateGrade {
  if (concentration <= goodMaximum) {
    return 'GOOD';
  }
  if (concentration <= moderateMaximum) {
    return 'MODERATE';
  }
  if (concentration <= badMaximum) {
    return 'BAD';
  }
  return 'VERY_BAD';
}

/** The worse (higher-severity) of two grades. */
function worseGrade(a: MaskParticulateGrade, b: MaskParticulateGrade): MaskParticulateGrade {
  return GRADE_SEVERITY[a] >= GRADE_SEVERITY[b] ? a : b;
}

/** The worse of two optional effective grades, or `null` when neither is present. */
function worstEffectiveGrade(
  a: MaskParticulateGrade | null,
  b: MaskParticulateGrade | null,
): MaskParticulateGrade | null {
  if (a === null) {
    return b;
  }
  if (b === null) {
    return a;
  }
  return worseGrade(a, b);
}

interface PollutantThresholds {
  goodMaximum: number;
  moderateMaximum: number;
  badMaximum: number;
}

/**
 * Build the evidence for one pollutant from its raw concentration and grade.
 *
 * The effective grade combines the two usable inputs conservatively: when both a usable provider
 * grade and a concentration-derived grade exist, the *worse* wins (so a provider/concentration
 * conflict never under-warns); otherwise whichever single input is usable is used. `UNKNOWN`
 * provider grades never contribute to the effective grade.
 */
function evaluatePollutant(
  rawConcentration: unknown,
  rawGrade: unknown,
  thresholds: PollutantThresholds,
): MaskPollutantEvidence {
  const concentration = usableConcentrationOrNull(rawConcentration);
  const providerGrade = normalizeProviderGrade(rawGrade);
  const usableProvider = actionableProviderGrade(providerGrade);
  const derivedGrade =
    concentration === null
      ? null
      : deriveGradeFromConcentration(
          concentration,
          thresholds.goodMaximum,
          thresholds.moderateMaximum,
          thresholds.badMaximum,
        );

  let effectiveGrade: MaskParticulateGrade | null;
  let gradeSource: MaskGradeSource | null;
  if (usableProvider !== null && derivedGrade !== null) {
    effectiveGrade = worseGrade(usableProvider, derivedGrade);
    gradeSource = 'BOTH';
  } else if (usableProvider !== null) {
    effectiveGrade = usableProvider;
    gradeSource = 'PROVIDER_GRADE';
  } else if (derivedGrade !== null) {
    effectiveGrade = derivedGrade;
    gradeSource = 'CONCENTRATION';
  } else {
    effectiveGrade = null;
    gradeSource = null;
  }

  const gradeDisagreement =
    usableProvider !== null && derivedGrade !== null && usableProvider !== derivedGrade;

  return {
    concentrationMicrogramsPerCubicMeter: concentration,
    providerGrade,
    derivedGrade,
    effectiveGrade,
    gradeSource,
    gradeDisagreement,
  };
}

/** The all-`null` pollutant evidence used when there is no observation to read. */
function emptyPollutantEvidence(): MaskPollutantEvidence {
  return {
    concentrationMicrogramsPerCubicMeter: null,
    providerGrade: null,
    derivedGrade: null,
    effectiveGrade: null,
    gradeSource: null,
    gradeDisagreement: false,
  };
}

/**
 * The pollutant with the higher-severity effective grade, `BOTH` on a tie, or `null` when no
 * effective grade is available. Only called for a fresh observation.
 */
function computeDriver(
  pm10Grade: MaskParticulateGrade | null,
  pm25Grade: MaskParticulateGrade | null,
): MaskPollutant | null {
  if (pm10Grade === null && pm25Grade === null) {
    return null;
  }
  if (pm10Grade === null) {
    return 'PM25';
  }
  if (pm25Grade === null) {
    return 'PM10';
  }
  const pm10Severity = GRADE_SEVERITY[pm10Grade];
  const pm25Severity = GRADE_SEVERITY[pm25Grade];
  if (pm10Severity === pm25Severity) {
    return 'BOTH';
  }
  return pm10Severity > pm25Severity ? 'PM10' : 'PM25';
}

/**
 * Decide whether a health mask is needed for the current particulate levels, anchored at
 * `input.evaluatedAt`.
 *
 * Order of reasoning:
 * 1. validate `evaluatedAt`, then the observation's presence and measurement time / freshness;
 * 2. derive each pollutant's effective grade (worse of a usable provider grade and the
 *    concentration-derived grade);
 * 3. take the worse of the two effective grades as the overall grade;
 * 4. map the overall grade to a status (`VERY_BAD` → `REQUIRED`, `BAD` → `RECOMMENDED`,
 *    `GOOD`/`MODERATE` → `NOT_NEEDED`) and compute the driver.
 *
 * A missing observation, an invalid or future measurement time, or a stale observation all yield
 * `INSUFFICIENT_DATA` with `INSUFFICIENT` data quality — even when PM values are present — because
 * the reading cannot be trusted as *current*. The input is never mutated.
 *
 * @throws RangeError synchronously if `evaluatedAt` is not a timezone-qualified ISO 8601 datetime.
 *   The message is fixed and never echoes the input.
 */
export function assessMaskNeed(input: MaskAssessmentInput): MaskDecision {
  const evaluatedAtMs = parseAbsoluteInstantMs(input.evaluatedAt);
  if (evaluatedAtMs === null) {
    throw new RangeError(
      'evaluatedAt must be an ISO 8601 datetime with a timezone designator',
    );
  }

  const observation = input.airQuality;

  // A missing or non-object observation (including an array) carries no PM evidence at all.
  if (
    observation === null ||
    typeof observation !== 'object' ||
    Array.isArray(observation)
  ) {
    const copy = resolveCopy('INSUFFICIENT_PARTICULATE_DATA', null);
    return {
      policyVersion: MASK_POLICY.policyVersion,
      status: 'INSUFFICIENT_DATA',
      reasonCode: 'INSUFFICIENT_PARTICULATE_DATA',
      reason: copy.reason,
      recommendation: copy.recommendation,
      dataQuality: 'INSUFFICIENT',
      evidence: {
        measuredAt: null,
        observationAgeMinutes: null,
        freshness: 'MISSING',
        driver: null,
        availablePollutantCount: 0,
        pm10: emptyPollutantEvidence(),
        pm25: emptyPollutantEvidence(),
      },
    };
  }

  // Read only the five decision-relevant fields; every value is validated defensively so a
  // runtime-malformed field degrades to `null`/`UNKNOWN` rather than crashing the function.
  const pm10 = evaluatePollutant(observation.pm10MicrogramsPerCubicMeter, observation.pm10Grade, {
    goodMaximum: MASK_POLICY.pm10GoodMaximumMicrogramsPerCubicMeter,
    moderateMaximum: MASK_POLICY.pm10ModerateMaximumMicrogramsPerCubicMeter,
    badMaximum: MASK_POLICY.pm10BadMaximumMicrogramsPerCubicMeter,
  });
  const pm25 = evaluatePollutant(observation.pm25MicrogramsPerCubicMeter, observation.pm25Grade, {
    goodMaximum: MASK_POLICY.pm25GoodMaximumMicrogramsPerCubicMeter,
    moderateMaximum: MASK_POLICY.pm25ModerateMaximumMicrogramsPerCubicMeter,
    badMaximum: MASK_POLICY.pm25BadMaximumMicrogramsPerCubicMeter,
  });
  const availablePollutantCount =
    (pm10.effectiveGrade !== null ? 1 : 0) + (pm25.effectiveGrade !== null ? 1 : 0);

  // Measurement time and freshness. A future observation is not a trustworthy "current" reading.
  const measuredAtMs = parseAbsoluteInstantMs(observation.measuredAt);
  const measuredAt = measuredAtMs === null ? null : new Date(measuredAtMs).toISOString();

  let freshness: MaskFreshness;
  let observationAgeMinutes: number | null;
  if (measuredAtMs === null || measuredAtMs > evaluatedAtMs) {
    freshness = 'INVALID';
    observationAgeMinutes = null;
  } else {
    observationAgeMinutes = (evaluatedAtMs - measuredAtMs) / MINUTE_IN_MS;
    freshness =
      observationAgeMinutes <= MASK_POLICY.maximumObservationAgeMinutes ? 'FRESH' : 'STALE';
  }

  let status: MaskStatus;
  let reasonCode: MaskReasonCode;
  let driver: MaskPollutant | null;
  if (freshness === 'INVALID') {
    status = 'INSUFFICIENT_DATA';
    reasonCode = 'INVALID_MEASUREMENT_TIME';
    driver = null;
  } else if (freshness === 'STALE') {
    status = 'INSUFFICIENT_DATA';
    reasonCode = 'STALE_AIR_QUALITY';
    driver = null;
  } else {
    const overallGrade = worstEffectiveGrade(pm10.effectiveGrade, pm25.effectiveGrade);
    if (overallGrade === null) {
      status = 'INSUFFICIENT_DATA';
      reasonCode = 'INSUFFICIENT_PARTICULATE_DATA';
      driver = null;
    } else {
      driver = computeDriver(pm10.effectiveGrade, pm25.effectiveGrade);
      if (overallGrade === 'VERY_BAD') {
        status = 'REQUIRED';
        reasonCode = 'PARTICULATE_VERY_BAD';
      } else if (overallGrade === 'BAD') {
        status = 'RECOMMENDED';
        reasonCode = 'PARTICULATE_BAD';
      } else {
        status = 'NOT_NEEDED';
        reasonCode = 'PARTICULATE_ACCEPTABLE';
      }
    }
  }

  let dataQuality: MaskDataQuality;
  if (freshness !== 'FRESH') {
    dataQuality = 'INSUFFICIENT';
  } else if (availablePollutantCount === 2) {
    dataQuality = 'SUFFICIENT';
  } else if (availablePollutantCount === 1) {
    dataQuality = 'LIMITED';
  } else {
    dataQuality = 'INSUFFICIENT';
  }

  const copy = resolveCopy(reasonCode, driver);

  return {
    policyVersion: MASK_POLICY.policyVersion,
    status,
    reasonCode,
    reason: copy.reason,
    recommendation: copy.recommendation,
    dataQuality,
    evidence: {
      measuredAt,
      observationAgeMinutes,
      freshness,
      driver,
      availablePollutantCount,
      pm10,
      pm25,
    },
  };
}
