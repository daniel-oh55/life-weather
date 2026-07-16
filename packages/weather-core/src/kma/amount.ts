/**
 * Parse the KMA categorical precipitation (`PCP`, mm) and snowfall (`SNO`, cm) forecast
 * values into plain numbers.
 *
 * The recognized string forms come from the official KMA guide — see
 * `docs/kma-normalization.md` (`기상청_단기예보 조회서비스`, 공공데이터 ID `15084084`,
 * 활용가이드 `2607`). Both `PCP` and `SNO` are categorical: some cells are exact numbers, some
 * are threshold buckets ("… 미만" / "… 이상"). `PCP` additionally uses ranges ("L~U"); the 2607
 * guide shows **no** range form for `SNO`, so a range string is rejected under `SNO`. The two
 * public functions share one internal parser but are separated by unit so a value in the wrong
 * unit (cm in `PCP`, mm in `SNO`) is rejected rather than silently accepted.
 *
 * Normalization rules (identical for both units unless noted):
 *
 * | Raw meaning                         | Result          |
 * | ----------------------------------- | --------------- |
 * | official "no amount" (`강수없음`/`적설없음`/`-`/`0`/`0.0`) | `0` |
 * | an exact number                     | that number     |
 * | `T 미만` (below `T`)                 | `T / 2`         |
 * | `L~U` (a range, `PCP` only)          | lower bound `L` |
 * | `T 이상` (`T` or more)               | lower bound `T` |
 * | missing / masked / unparseable      | `null`          |
 *
 * **Official `-` token.** The guide lists `-` (alongside `0`/`0.0` and `강수없음`/`적설없음`) as a
 * "no amount" category, so a trimmed `-` normalizes to `0`. This is distinct from the JavaScript
 * argument `null`/`undefined` (data not supplied by the caller → `null`) — see
 * `docs/kma-normalization.md`.
 *
 * **Official Missing sentinels.** The guide describes `+900 이상` / `-900 이하` as Missing. This
 * parser therefore treats any numeric component whose magnitude reaches {@link
 * KMA_MISSING_ABSOLUTE_BOUND} (`>= 900`) as Missing and returns `null`; negative inputs stay
 * `null` as before (the grammar admits no sign, and this parser only yields non-negative
 * amounts). The bound is applied to every numeric component: a bare number, a number carrying a
 * unit, a `미만`/`이상` threshold, and a range's lower and upper bounds.
 *
 * The whole (trimmed) string must match an official pattern — there is no loose left-anchored
 * number scan. The result is always either `null` or a finite number `>= 0` and `< 900`;
 * `NaN`, `Infinity` and `-Infinity` are never returned, and the input string is never mutated.
 *
 * This module is pure and deterministic: no network, no environment access, no system clock,
 * no global mutable state. The compiled patterns are module-private and built once.
 */

/** A finite decimal literal: one or more digits, optionally followed by a fractional part. */
const DECIMAL = String.raw`\d+(?:\.\d+)?`;

/** A bare number with no unit (e.g. `'6.2'`, `'30'`, `'0'`) — unit-independent. */
const BARE_NUMBER = new RegExp(`^(${DECIMAL})$`);

/**
 * Official "no amount" hyphen token, shared by both units. The guide lists `-` (with `0`/`0.0`
 * and `강수없음`/`적설없음`) as a no-precipitation / no-snow category, so a trimmed `-` → `0`.
 * Only the exact single hyphen matches — `--`, `-1`, etc. do not.
 */
const NO_AMOUNT_HYPHEN = '-';

/**
 * The official Missing sentinel magnitude. The guide marks `+900 이상` / `-900 이하` as Missing,
 * so any numeric component that reaches this bound is treated as "no data" and yields `null`.
 */
const KMA_MISSING_ABSOLUTE_BOUND = 900;

interface AmountPatterns {
  /** Exact "no amount" tokens for this unit (`'강수없음'`/`'적설없음'` and the shared `'-'`). */
  readonly noAmountTokens: ReadonlySet<string>;
  /** `<number><unit> 미만` — the below-threshold bucket. */
  readonly lessThan: RegExp;
  /** `<number><unit> 이상` — the at-or-above-threshold bucket. */
  readonly atLeast: RegExp;
  /** `<lower>~<upper><unit>` — a range bucket, or `null` when the unit has no official range. */
  readonly range: RegExp | null;
  /** `<number><unit>` — an exact value carrying its unit. */
  readonly withUnit: RegExp;
}

/**
 * Build the pattern set for one unit. Whitespace is tolerated between the number, the unit and
 * the 미만/이상 keyword because the official guide itself prints both spaced (`'1mm 미만'`,
 * `'50.0 mm 이상'`) and unspaced (`'1mm미만'`, `'50.0mm이상'`) forms. `unit` is a fixed literal
 * (`'mm'` / `'cm'`) with no regex-special characters. `range: true` enables the `L~U` bucket
 * (`PCP`); `SNO` passes `range: false` because the 2607 guide defines no `SNO` range form.
 */
function buildAmountPatterns(
  unit: string,
  noAmountToken: string,
  options: { readonly range: boolean },
): AmountPatterns {
  return {
    noAmountTokens: new Set([noAmountToken, NO_AMOUNT_HYPHEN]),
    lessThan: new RegExp(`^(${DECIMAL})\\s*${unit}\\s*미만$`),
    atLeast: new RegExp(`^(${DECIMAL})\\s*${unit}\\s*이상$`),
    range: options.range
      ? new RegExp(`^(${DECIMAL})\\s*~\\s*(${DECIMAL})\\s*${unit}$`)
      : null,
    withUnit: new RegExp(`^(${DECIMAL})\\s*${unit}$`),
  };
}

/**
 * A parsed numeric component is a valid amount only if it is a finite number in
 * `[0, KMA_MISSING_ABSOLUTE_BOUND)` — i.e. non-negative and below the official Missing bound
 * (`>= 900` is Missing → not a real amount).
 */
function isValidKmaAmountComponent(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value < KMA_MISSING_ABSOLUTE_BOUND;
}

/**
 * Parse one categorical amount string against a unit's pattern set. See the module docblock
 * for the rules. Returns `null` for a non-string, empty/whitespace-only, an official Missing
 * value (`>= 900`), or any string that does not fully match an official pattern (including a
 * value in the wrong unit, and a range under a unit that has no official range form).
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
  if (patterns.noAmountTokens.has(value)) {
    return 0;
  }

  const lessThan = patterns.lessThan.exec(value);
  if (lessThan !== null) {
    const threshold = Number(lessThan[1]);
    return isValidKmaAmountComponent(threshold) ? threshold / 2 : null;
  }

  const atLeast = patterns.atLeast.exec(value);
  if (atLeast !== null) {
    const threshold = Number(atLeast[1]);
    return isValidKmaAmountComponent(threshold) ? threshold : null;
  }

  if (patterns.range !== null) {
    const range = patterns.range.exec(value);
    if (range !== null) {
      const lower = Number(range[1]);
      const upper = Number(range[2]);
      // Reject a Missing bound (>= 900) or a malformed range whose lower exceeds its upper.
      if (
        !isValidKmaAmountComponent(lower) ||
        !isValidKmaAmountComponent(upper) ||
        lower > upper
      ) {
        return null;
      }
      return lower;
    }
  }

  const exact = patterns.withUnit.exec(value) ?? BARE_NUMBER.exec(value);
  if (exact !== null) {
    const amount = Number(exact[1]);
    return isValidKmaAmountComponent(amount) ? amount : null;
  }

  return null;
}

const PRECIPITATION_PATTERNS = buildAmountPatterns('mm', '강수없음', { range: true });
const SNOWFALL_PATTERNS = buildAmountPatterns('cm', '적설없음', { range: false });

/**
 * Normalize a KMA `PCP` (1시간 강수량) forecast value to **millimeters**.
 *
 * `'강수없음'` / `'-'` / `'0'` / `'0.0'` → `0`; the official minimum bucket `'1mm 미만'` → `0.5`
 * (T/2); `'6.2mm'` / `'6.2'` → `6.2`; `'1~29mm'` / `'30~50mm'` (range) → lower bound; `'50mm 이상'`
 * → `50`. A cm-unit value, a negative value, an official Missing value (`>= 900`, e.g. `'900mm'`
 * or `'900mm 이상'`), an unrecognized string, empty/whitespace, `null` or `undefined` → `null`.
 */
export function parseKmaPrecipitationAmountMillimeters(
  rawValue: string | null | undefined,
): number | null {
  return parseKmaCategoricalAmount(rawValue, PRECIPITATION_PATTERNS);
}

/**
 * Normalize a KMA `SNO` (1시간 신적설) forecast value to **centimeters**.
 *
 * `'적설없음'` / `'-'` / `'0'` / `'0.0'` → `0`; the official minimum bucket `'0.5cm 미만'` → `0.25`
 * (T/2); `'3.5cm'` / `'3.5'` → `3.5`; `'5cm 이상'` → `5`. An mm-unit value, a **range string**
 * (the 2607 guide defines no `SNO` range, e.g. `'1.0~4.9cm'`), a negative value, an official
 * Missing value (`>= 900`), an unrecognized string, empty/whitespace, `null` or `undefined` →
 * `null`.
 */
export function parseKmaSnowfallAmountCentimeters(
  rawValue: string | null | undefined,
): number | null {
  return parseKmaCategoricalAmount(rawValue, SNOWFALL_PATTERNS);
}
