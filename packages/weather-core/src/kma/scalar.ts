/**
 * Parse the KMA (기상청) *plain numeric* forecast categories — the ones the guide types as a bare
 * real/integer string, not a categorical bucket — into common numbers:
 *
 * - `TMP` / `T1H` (기온, ℃) → {@link parseKmaTemperatureCelsius}
 * - `POP` / `REH` (강수확률 / 습도, %) → {@link parseKmaPercentage}
 * - `WSD` (풍속, m/s) → {@link parseKmaWindSpeedMetersPerSecond}
 * - `VEC` (풍향, deg) → {@link parseKmaWindDirectionDegrees}
 *
 * The categorical amount categories (`PCP` / `RN1` in mm, `SNO` in cm) have their own grammar and
 * live in `./amount`; this module never touches them. The units, ranges, and the Missing sentinel
 * all come from the official KMA guide — see `docs/kma-hourly-normalization.md`
 * (`기상청_단기예보 조회서비스`, 공공데이터 ID `15084084`, 활용가이드 `2607`; cross-checked against the
 * 기상청 API 허브 `VilageFcstInfoService_2.0` 활용가이드 "코드값 정보"/"특정 요소의 코드값 및 범주").
 *
 * Shared input policy (every function below):
 *
 * - Input is `string | null | undefined`; only a `string` can yield a number.
 * - Surrounding whitespace is trimmed; an empty or whitespace-only string is `null`.
 * - The *whole* trimmed string must match a strict decimal grammar — no loose `parseFloat`, no
 *   trailing unit or prose (`'25℃'`, `'25 C'`, `'70%'`), no exponent (`'2.5e1'`), and no
 *   `NaN`/`Infinity`/`-Infinity` literal. A leading `+`/`-` sign is allowed.
 * - The official Missing sentinel (`+900 이상` / `-900 이하`, i.e. `|value| >= 900`) is `null`.
 * - `NaN`, `Infinity`, `-Infinity` are never returned, and the input is never mutated.
 *
 * This module is pure and deterministic: no network, no environment access, no system clock, no
 * locale, no global mutable state. The compiled pattern is module-private and built once.
 */

/**
 * A finite decimal literal with an optional leading sign and no exponent: `'25'`, `'25.5'`, `'0'`,
 * `'-3.5'`, `'+3'`. Rejects the empty string, an exponent (`'1e3'`), a bare sign (`'+'`), a unit
 * suffix (`'25mm'`), and `NaN`/`Infinity` literals — none of which are an official scalar form.
 */
const SIGNED_DECIMAL = /^[+-]?\d+(?:\.\d+)?$/;

/**
 * The official Missing sentinel magnitude. The guide marks `+900 이상` / `-900 이하` as Missing
 * ("자료 없음"), so any parsed scalar whose magnitude reaches this bound is treated as "no data".
 * The same bound is used by the categorical amount parser (`./amount`) so the two stay consistent.
 */
const KMA_MISSING_ABSOLUTE_BOUND = 900;

/** A half-open compass range: `0 <= deg < 360`, matching the contracts `windDirectionDegrees`. */
const DEGREES_IN_CIRCLE = 360;

/**
 * Parse a raw scalar to a finite number, or `null`. Trims, requires the whole string to match the
 * strict decimal grammar, and guarantees a finite result (the grammar already excludes
 * `NaN`/`Infinity`, and a matched literal is always finite). This is the shared front-half of
 * every public parser; each one then applies its own range and Missing rules.
 */
function parseFiniteDecimal(rawValue: string | null | undefined): number | null {
  if (typeof rawValue !== 'string') {
    return null;
  }
  const value = rawValue.trim();
  if (value === '' || !SIGNED_DECIMAL.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Whether `value` is within the official non-Missing band `(-900, 900)` (`|value| < 900`). */
function isWithinMissingBound(value: number): boolean {
  return Math.abs(value) < KMA_MISSING_ABSOLUTE_BOUND;
}

/**
 * Normalize a KMA `TMP` (1시간 기온, 단기예보) or `T1H` (기온, 초단기예보) value to **degrees
 * Celsius**. Both are documented as string-encoded reals (e.g. `'-2'`, `'6.2'`, `'25.5'`).
 *
 * Negative temperatures are valid, so **no** arbitrary "realistic" range is imposed — the only
 * upper/lower guard is the official Missing sentinel: a value with `|value| >= 900` (`+900 이상` /
 * `-900 이하`) is Missing → `null`. A unit-carrying string (`'25℃'`, `'25 C'`), an exponent, an
 * empty/whitespace/`null`/`undefined` input, or any non-decimal string → `null`.
 */
export function parseKmaTemperatureCelsius(
  rawValue: string | null | undefined,
): number | null {
  const value = parseFiniteDecimal(rawValue);
  if (value === null || !isWithinMissingBound(value)) {
    return null;
  }
  return value;
}

/**
 * Normalize a KMA percentage category — `POP` (강수확률, 단기예보) or `REH` (습도) — to a number in
 * `[0, 100]`. A value outside that inclusive range (including a negative value and the Missing
 * sentinel `>= 900`) → `null`. A `'%'`-suffixed string has no official basis and → `null`.
 */
export function parseKmaPercentage(
  rawValue: string | null | undefined,
): number | null {
  const value = parseFiniteDecimal(rawValue);
  if (value === null || value < 0 || value > 100) {
    return null;
  }
  return value;
}

/**
 * Normalize a KMA `WSD` (풍속) value to **meters per second**. Valid values are finite and
 * non-negative; a negative value, a unit-carrying string, or the Missing sentinel (`>= 900`) →
 * `null`. The band is therefore `[0, 900)`.
 */
export function parseKmaWindSpeedMetersPerSecond(
  rawValue: string | null | undefined,
): number | null {
  const value = parseFiniteDecimal(rawValue);
  if (value === null || value < 0 || !isWithinMissingBound(value)) {
    return null;
  }
  return value;
}

/**
 * Normalize a KMA `VEC` (풍향) value to **degrees** on the half-open compass range `[0, 360)` that
 * the contracts `windDirectionDegrees` schema requires.
 *
 * The official guide's 풍향 구간 table runs to `360` (the last bucket is `315 – 360 → NW-N`) and its
 * 16-방위 conversion formula maps both `0` and `360` to `N` (북). So `360` is the same bearing as
 * `0` (due north) and is normalized to `0`. Any other value outside `[0, 360)` — a negative value,
 * a value `> 360`, or the Missing sentinel (`>= 900`) — is `null`.
 */
export function parseKmaWindDirectionDegrees(
  rawValue: string | null | undefined,
): number | null {
  const value = parseFiniteDecimal(rawValue);
  if (value === null) {
    return null;
  }
  // 360 == 0 (due north) per the official 풍향 conversion; fold it before the range check.
  if (value === DEGREES_IN_CIRCLE) {
    return 0;
  }
  if (value < 0 || value >= DEGREES_IN_CIRCLE) {
    return null;
  }
  return value;
}
