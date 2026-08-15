/**
 * Normalize an AirKorea (에어코리아) 측정소별 실시간 측정정보 조회 provider success into the common
 * `@life-weather/contracts` `CurrentAirQuality`.
 *
 * Turns an {@link AirKoreaCurrentAirQualityProviderSuccess} (the provider's selected, validated raw
 * item) into one validated `CurrentAirQuality`:
 *
 * 1. build the KST `measuredAt` from the item's own `dataTime`,
 * 2. resolve each nullable measurement (PM10/PM2.5/O3/CAI) and grade (overall/PM10/PM2.5/O3),
 * 3. validate the assembled candidate against the contracts `currentAirQuality` schema.
 *
 * Field-presence model (official evidence: `docs/airkorea-current-air-quality-provider.md`). Presence
 * and value are different concepts, and the two consumed field groups are handled differently:
 *
 * Required fields (`pm10Value`, `o3Value`, `khaiValue`, `khaiGrade`, `pm10Grade`, `o3Grade` — the raw
 * schema's own required keys):
 *
 * - **ABSENT** (the raw key is missing) → a malformed-response **issue** for that field. The raw
 *   schema already rejects this before a provider success reaches this module; this is a defensive
 *   re-check so a caller that bypasses the type system at runtime cannot silently turn a missing
 *   required field into a `null` contract value.
 * - **SENTINEL** (present but equal to the documented "no data" marker — `"-"` for a measurement,
 *   confirmed by the technical document's `<khaiValue>-</khaiValue>` sample; `""` for a grade,
 *   confirmed by its self-closing `<so2Grade/>` sample) → the contract field is `null`. Not a
 *   normalization issue — the key is present, only its value encodes "no data".
 * - **JSON `null`** (grade fields only — present key, JSON `null` value; 2026-08-14 Owner-observed
 *   live JSON evidence, see `current-raw-schema.ts` and
 *   `docs/airkorea-current-air-quality-provider.md`) → the contract field is `null`. Also not a
 *   normalization issue, and distinct from ABSENT: the raw schema still rejects a missing key for
 *   these three grades, but a *present* `null` is a documented live serialization of "no data".
 * - **VALUE** (present, non-sentinel, non-`null`) → parsed. A value that does not match the
 *   documented shape is an explicit normalization issue (see below).
 *
 * Optional fields (`pm25Value`, `pm25Grade` — the raw schema's own optional keys):
 *
 * - **ABSENT** (documented optional at any `ver`) → the contract field is `null`. Not a
 *   normalization issue.
 * - **SENTINEL** → the contract field is `null`. Not a normalization issue.
 * - **JSON `null`** (`pm25Grade` only) → the contract field is `null`. Not a normalization issue.
 * - **VALUE** (present, non-sentinel, non-`null`) → parsed, same as a required field.
 *
 * For both groups, a present *string* value that does not match the documented shape (a bare
 * non-negative decimal for a measurement; the literal digits `"1"`-`"4"` for a grade) is an explicit
 * normalization **issue** — it is never silently coerced to `null` or to zero, per the project's
 * "malformed data must not become a documented missing value" policy. Measurement fields are not
 * widened to accept JSON `null` by this change — only grade fields are (raw evidence only covers
 * grades; see the module's `docs/airkorea-current-air-quality-provider.md` "Owner-observed live JSON
 * evidence" entry for 2026-08-14).
 *
 * `measuredAt` is required: a malformed `dataTime` blocks normalization entirely (the raw schema
 * already guarantees a well-formed `dataTime`; this is a defensive re-check, matching the KMA
 * current-observation normalizer's pattern).
 *
 * Pure and deterministic: no `fetch`, no system clock, no environment or locale access, no global
 * mutable state. The input observation is never mutated.
 */

import { currentAirQuality, type AirQualityGrade, type CurrentAirQuality } from '@life-weather/contracts';

import { parseAirKoreaDataTime } from './current-raw-schema.js';
import type { AirKoreaCurrentAirQualityProviderSuccess } from './provider.js';

/**
 * One deterministic normalization problem. `field` says *which* part failed; `reason` is always
 * `INVALID` (a malformed/undocumented raw value, or — for `contract` — a contracts-schema
 * violation). No raw provider value, response body, URL, or service key is ever included.
 */
export interface AirKoreaCurrentNormalizationIssue {
  readonly field:
    | 'measuredAt'
    | 'pm10'
    | 'pm25'
    | 'ozone'
    | 'comprehensiveAirQualityIndex'
    | 'overallGrade'
    | 'pm10Grade'
    | 'pm25Grade'
    | 'ozoneGrade'
    | 'contract';
  readonly reason: 'INVALID';
  /** Sanitized Zod path (dotted field location), set only for a `contract` issue. */
  readonly path?: string;
  /** Sanitized Zod message (type-level), set only for a `contract` issue. */
  readonly message?: string;
}

/**
 * The result of normalizing one provider success. Either a valid `CurrentAirQuality` (`ok: true`),
 * or every blocking issue collected (`ok: false`) — never a partially-populated `CurrentAirQuality`.
 */
export type NormalizeAirKoreaCurrentAirQualityResult =
  | { readonly ok: true; readonly current: CurrentAirQuality }
  | { readonly ok: false; readonly issues: readonly AirKoreaCurrentNormalizationIssue[] };

/** The documented "no data" sentinel for a measurement/index field. */
const MEASUREMENT_SENTINEL = '-';

/** The documented "no data" sentinel for a grade field (an empty string; self-closing in XML). */
const GRADE_SENTINEL = '';

/** A bare non-negative decimal string — no sign, no exponent, no thousands separators. */
const NUMERIC_VALUE_PATTERN = /^\d+(\.\d+)?$/;

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
 * Parse a documented measurement/index string. Returns `{ ok: true, value }` for the sentinel
 * (`value: null`) or a well-formed non-negative decimal (`value` parsed); returns `{ ok: false }`
 * for anything else (malformed numeric text, a negative-looking string, `NaN`/`Infinity`-shaped
 * text, or any other undocumented substitution) — the caller turns that into an issue rather than
 * silently defaulting to `null` or `0`.
 */
function parseAirKoreaMeasurement(raw: string): { readonly ok: true; readonly value: number | null } | { readonly ok: false } {
  if (raw === MEASUREMENT_SENTINEL) {
    return { ok: true, value: null };
  }
  if (!NUMERIC_VALUE_PATTERN.test(raw)) {
    return { ok: false };
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return { ok: false };
  }
  return { ok: true, value };
}

const GRADE_BY_CODE: Readonly<Record<string, AirQualityGrade>> = {
  '1': 'GOOD',
  '2': 'MODERATE',
  '3': 'BAD',
  '4': 'VERY_BAD',
};

/**
 * Parse a documented grade string. Returns `{ ok: true, grade }` for the sentinel (`grade: null`)
 * or one of the four documented digit codes (`grade` mapped); returns `{ ok: false }` for any other
 * (undocumented) code — never silently accepted as a known grade.
 */
function parseAirKoreaGrade(raw: string): { readonly ok: true; readonly grade: AirQualityGrade | null } | { readonly ok: false } {
  if (raw === GRADE_SENTINEL) {
    return { ok: true, grade: null };
  }
  const grade = GRADE_BY_CODE[raw];
  if (grade === undefined) {
    return { ok: false };
  }
  return { ok: true, grade };
}

/**
 * Resolve a *required* measurement field (`pm10Value`/`o3Value`/`khaiValue`). `undefined` (ABSENT) is
 * a malformed-response issue — never silently treated as the sentinel — so a caller that bypasses the
 * type system at runtime and hands this function a raw object missing the key cannot silently turn
 * that absence into a `null` contract value. A *present* sentinel or valid value is unaffected by
 * this check.
 */
function resolveRequiredMeasurement(
  field: AirKoreaCurrentNormalizationIssue['field'],
  raw: string | undefined,
  issues: AirKoreaCurrentNormalizationIssue[],
): number | null {
  if (raw === undefined) {
    issues.push({ field, reason: 'INVALID' });
    return null;
  }
  const parsed = parseAirKoreaMeasurement(raw);
  if (!parsed.ok) {
    issues.push({ field, reason: 'INVALID' });
    return null;
  }
  return parsed.value;
}

/**
 * Resolve the *optional* PM2.5 measurement field (`pm25Value`). `undefined` (ABSENT) is a documented
 * optional-field outcome and is treated exactly like the sentinel — never an issue.
 */
function resolveOptionalMeasurement(
  field: AirKoreaCurrentNormalizationIssue['field'],
  raw: string | undefined,
  issues: AirKoreaCurrentNormalizationIssue[],
): number | null {
  if (raw === undefined) {
    return null;
  }
  const parsed = parseAirKoreaMeasurement(raw);
  if (!parsed.ok) {
    issues.push({ field, reason: 'INVALID' });
    return null;
  }
  return parsed.value;
}

/**
 * Resolve a *required* grade field (`khaiGrade`/`pm10Grade`/`o3Grade`). `undefined` (ABSENT) is a
 * malformed-response issue — see {@link resolveRequiredMeasurement} for the same runtime-bypass
 * rationale. `null` (present key, JSON `null` value — 2026-08-14 Owner-observed live JSON evidence)
 * is a documented missing-grade outcome, not an issue: it is distinct from ABSENT and resolves to a
 * `null` contract grade, exactly like the `""` string sentinel. `parseAirKoreaGrade` keeps its
 * string-only signature; the `null` case is handled here, before it is called.
 */
function resolveRequiredGrade(
  field: AirKoreaCurrentNormalizationIssue['field'],
  raw: string | null | undefined,
  issues: AirKoreaCurrentNormalizationIssue[],
): AirQualityGrade | null {
  if (raw === undefined) {
    issues.push({ field, reason: 'INVALID' });
    return null;
  }
  if (raw === null) {
    return null;
  }
  const parsed = parseAirKoreaGrade(raw);
  if (!parsed.ok) {
    issues.push({ field, reason: 'INVALID' });
    return null;
  }
  return parsed.grade;
}

/**
 * Resolve the *optional* PM2.5 grade field (`pm25Grade`). `undefined` (ABSENT) is a documented
 * optional-field outcome and `null` (present key, JSON `null` value) is a documented missing-grade
 * outcome — both are treated exactly like the `""` string sentinel, never an issue.
 */
function resolveOptionalGrade(
  field: AirKoreaCurrentNormalizationIssue['field'],
  raw: string | null | undefined,
  issues: AirKoreaCurrentNormalizationIssue[],
): AirQualityGrade | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const parsed = parseAirKoreaGrade(raw);
  if (!parsed.ok) {
    issues.push({ field, reason: 'INVALID' });
    return null;
  }
  return parsed.grade;
}

/**
 * Build the KST ISO `measuredAt` (`YYYY-MM-DDTHH:mm:00+09:00`) from the item's own `dataTime`, or
 * `null` if malformed. KST has no DST, so the offset is the fixed `+09:00` and seconds are always
 * `00`. No `Date`, no system clock, no host timezone. The output passes the contracts `isoDateTime`
 * schema.
 */
function buildMeasuredAtKst(dataTime: string): string | null {
  const parts = parseAirKoreaDataTime(dataTime);
  if (parts === null) {
    return null;
  }
  const year = String(parts.year).padStart(4, '0');
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  const hour = String(parts.hour).padStart(2, '0');
  const minute = String(parts.minute).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}:00+09:00`;
}

/** Total order over issues: `field`, then `reason`, then `path`, then `message`. */
function compareIssues(
  a: AirKoreaCurrentNormalizationIssue,
  b: AirKoreaCurrentNormalizationIssue,
): number {
  return (
    compareStrings(a.field, b.field) ||
    compareStrings(a.reason, b.reason) ||
    compareStrings(a.path ?? '', b.path ?? '') ||
    compareStrings(a.message ?? '', b.message ?? '')
  );
}

/**
 * Normalize an AirKorea current-air-quality provider success into a contracts `CurrentAirQuality`.
 *
 * `measuredAt` is required — a malformed `dataTime` fails normalization immediately (no other field
 * is evaluated). Every other field is independently resolved per the required/optional split
 * described above (required: ABSENT → issue, SENTINEL → `null`, malformed → issue; optional:
 * ABSENT/SENTINEL → `null`, malformed → issue), and every issue across every field is collected
 * before the result is decided, so a caller sees every problem in one deterministic `(field, reason,
 * path, message)`-ordered pass. The candidate is validated against the shared `currentAirQuality`
 * schema before being returned. The input `observation` is never mutated.
 */
export function normalizeAirKoreaCurrentAirQuality(
  observation: AirKoreaCurrentAirQualityProviderSuccess,
): NormalizeAirKoreaCurrentAirQualityResult {
  const measuredAt = buildMeasuredAtKst(observation.dataTime);
  if (measuredAt === null) {
    return { ok: false, issues: [{ field: 'measuredAt', reason: 'INVALID' }] };
  }

  const issues: AirKoreaCurrentNormalizationIssue[] = [];

  const pm10MicrogramsPerCubicMeter = resolveRequiredMeasurement('pm10', observation.pm10Value, issues);
  const pm25MicrogramsPerCubicMeter = resolveOptionalMeasurement('pm25', observation.pm25Value, issues);
  const ozonePartsPerMillion = resolveRequiredMeasurement('ozone', observation.o3Value, issues);
  const comprehensiveAirQualityIndex = resolveRequiredMeasurement(
    'comprehensiveAirQualityIndex',
    observation.khaiValue,
    issues,
  );
  const overallGrade = resolveRequiredGrade('overallGrade', observation.khaiGrade, issues);
  const pm10Grade = resolveRequiredGrade('pm10Grade', observation.pm10Grade, issues);
  const pm25Grade = resolveOptionalGrade('pm25Grade', observation.pm25Grade, issues);
  const ozoneGrade = resolveRequiredGrade('ozoneGrade', observation.o3Grade, issues);

  if (issues.length > 0) {
    return { ok: false, issues: [...issues].sort(compareIssues) };
  }

  const candidate = {
    measuredAt,
    pm10MicrogramsPerCubicMeter,
    pm25MicrogramsPerCubicMeter,
    ozonePartsPerMillion,
    comprehensiveAirQualityIndex,
    overallGrade,
    pm10Grade,
    pm25Grade,
    ozoneGrade,
  };

  const parsed = currentAirQuality.safeParse(candidate);
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
