/**
 * Parse the KMA categorical precipitation (`PCP`, mm) and snowfall (`SNO`, cm) forecast
 * values into plain numbers.
 *
 * The recognized string forms come from the official KMA guide — see
 * `docs/kma-normalization.md` (`기상청_단기예보 조회서비스`, 공공데이터 ID `15084084`,
 * 활용가이드 `2607`). Both `PCP` and `SNO` are categorical: some cells are exact numbers, some
 * are threshold buckets ("… 미만" / "… 이상") and some are ranges ("L~U"). The two public
 * functions share one internal parser but are separated by unit so a value in the wrong unit
 * (cm in `PCP`, mm in `SNO`) is rejected rather than silently accepted.
 *
 * Normalization rules (identical for both units):
 *
 * | Raw meaning          | Result   |
 * | -------------------- | -------- |
 * | explicit "no amount" | `0`      |
 * | an exact number      | that number |
 * | `T 미만` (below `T`)  | `T / 2`  |
 * | `L~U` (a range)      | lower bound `L` |
 * | `T 이상` (`T` or more)| lower bound `T` |
 * | missing / unparseable| `null`   |
 *
 * The whole (trimmed) string must match an official pattern — there is no loose
 * left-anchored number scan. The result is always either `null` or a finite number `>= 0`;
 * `NaN`, `Infinity` and `-Infinity` are never returned, and the input string is never mutated.
 *
 * This module is pure and deterministic: no network, no environment access, no system clock,
 * no global mutable state. The compiled patterns are module-private and built once.
 */

/** A finite decimal literal: one or more digits, optionally followed by a fractional part. */
const DECIMAL = String.raw`\d+(?:\.\d+)?`;

/** A bare number with no unit (e.g. `'6.2'`, `'30'`, `'0'`) — unit-independent. */
const BARE_NUMBER = new RegExp(`^(${DECIMAL})$`);

interface AmountPatterns {
  /** The exact "no amount" token for this unit (`'강수없음'` / `'적설없음'`). */
  readonly noAmountToken: string;
  /** `<number><unit> 미만` — the below-threshold bucket. */
  readonly lessThan: RegExp;
  /** `<number><unit> 이상` — the at-or-above-threshold bucket. */
  readonly atLeast: RegExp;
  /** `<lower>~<upper><unit>` — a range bucket. */
  readonly range: RegExp;
  /** `<number><unit>` — an exact value carrying its unit. */
  readonly withUnit: RegExp;
}

/**
 * Build the pattern set for one unit. Whitespace is tolerated between the number, the unit and
 * the 미만/이상 keyword because the official guide itself prints both spaced (`'1.0mm 미만'`,
 * `'50.0 mm 이상'`) and unspaced (`'1.0mm미만'`, `'50.0mm이상'`) forms. `unit` is a fixed
 * literal (`'mm'` / `'cm'`) with no regex-special characters.
 */
function buildAmountPatterns(unit: string, noAmountToken: string): AmountPatterns {
  return {
    noAmountToken,
    lessThan: new RegExp(`^(${DECIMAL})\\s*${unit}\\s*미만$`),
    atLeast: new RegExp(`^(${DECIMAL})\\s*${unit}\\s*이상$`),
    range: new RegExp(`^(${DECIMAL})\\s*~\\s*(${DECIMAL})\\s*${unit}$`),
    withUnit: new RegExp(`^(${DECIMAL})\\s*${unit}$`),
  };
}

/** Return `value` only if it is a finite number `>= 0`; otherwise `null`. */
function finiteNonNegativeOrNull(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Parse one categorical amount string against a unit's pattern set. See the module docblock
 * for the rules. Returns `null` for a non-string, empty/whitespace-only, or any string that
 * does not fully match an official pattern (including a value in the wrong unit).
 */
function parseKmaCategoricalAmount(
  rawValue: string | null | undefined,
  patterns: AmountPatterns,
): number | null {
  if (typeof rawValue !== 'string') {
    return null;
  }

  const value = rawValue.trim();
  if (value === '') {
    return null;
  }
  if (value === patterns.noAmountToken) {
    return 0;
  }

  const lessThan = patterns.lessThan.exec(value);
  if (lessThan !== null) {
    return finiteNonNegativeOrNull(Number(lessThan[1]) / 2);
  }

  const atLeast = patterns.atLeast.exec(value);
  if (atLeast !== null) {
    return finiteNonNegativeOrNull(Number(atLeast[1]));
  }

  const range = patterns.range.exec(value);
  if (range !== null) {
    const lower = Number(range[1]);
    const upper = Number(range[2]);
    // A range whose lower bound exceeds its upper bound is malformed.
    if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower > upper) {
      return null;
    }
    return finiteNonNegativeOrNull(lower);
  }

  const exact = patterns.withUnit.exec(value) ?? BARE_NUMBER.exec(value);
  if (exact !== null) {
    return finiteNonNegativeOrNull(Number(exact[1]));
  }

  return null;
}

const PRECIPITATION_PATTERNS = buildAmountPatterns('mm', '강수없음');
const SNOWFALL_PATTERNS = buildAmountPatterns('cm', '적설없음');

/**
 * Normalize a KMA `PCP` (1시간 강수량) forecast value to **millimeters**.
 *
 * `'강수없음'` → `0`; `'1.0mm 미만'` → `0.5`; `'6.2mm'` / `'6.2'` → `6.2`;
 * `'30.0~50.0mm'` → `30.0`; `'50.0mm 이상'` → `50.0`. A cm-unit value, a negative value, an
 * unrecognized string, empty/whitespace, `null` or `undefined` → `null`.
 */
export function parseKmaPrecipitationAmountMillimeters(
  rawValue: string | null | undefined,
): number | null {
  return parseKmaCategoricalAmount(rawValue, PRECIPITATION_PATTERNS);
}

/**
 * Normalize a KMA `SNO` (1시간 신적설) forecast value to **centimeters**.
 *
 * `'적설없음'` → `0`; `'1.0cm 미만'` → `0.5`; `'3.5cm'` / `'3.5'` → `3.5`;
 * `'5.0cm 이상'` → `5.0`. An mm-unit value, a negative value, an unrecognized string,
 * empty/whitespace, `null` or `undefined` → `null`.
 */
export function parseKmaSnowfallAmountCentimeters(
  rawValue: string | null | undefined,
): number | null {
  return parseKmaCategoricalAmount(rawValue, SNOWFALL_PATTERNS);
}
