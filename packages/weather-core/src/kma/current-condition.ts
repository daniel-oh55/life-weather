/**
 * Normalize a KMA (Korea Meteorological Administration) 초단기실황 (`getUltraSrtNcst`,
 * ultra-short-term *current observation*) precipitation-type (PTY) code into the common
 * `WeatherCondition` state.
 *
 * This is a **separate** normalizer from {@link normalizeKmaWeatherCondition} in `./condition.ts`:
 * the current-observation PTY code set is not identical to the forecast PTY code sets, and current
 * observation has no `SKY` field at all — there is no "current sky state" item in `getUltraSrtNcst`,
 * so this normalizer never guesses `CLEAR` / `PARTLY_CLOUDY` / `CLOUDY` from precipitation code `0`.
 * See `docs/kma-current-observation-provider.md` for the official-source evidence.
 *
 * This module is pure and deterministic: no network, no environment access, no system clock, no
 * global mutable state. It never mutates its input, and given the same input it always returns the
 * same result. The lookup table is module-private, built once, and never reassigned.
 */

/**
 * The subset of the common `WeatherCondition` that a current-observation PTY code can produce.
 * There is deliberately no `CLEAR` / `PARTLY_CLOUDY` / `CLOUDY` / `SHOWER` / `THUNDERSTORM` / `FOG`
 * here: 초단기실황 carries no sky-state item, and PTY `4`(소나기) is not part of the official
 * 초단기실황 PTY code set (it is a forecast-only code), so this normalizer never produces `SHOWER`.
 * Every literal below is a member of `WeatherCondition` in `@life-weather/contracts`; that
 * assignability is verified at compile time by a type-level test
 * (`kma-current-condition.test.ts`) rather than by importing the contract type into this runtime
 * module, so `weather-core` keeps no dependency — runtime or type — on `contracts` or Zod.
 */
export type KmaCurrentWeatherCondition = 'RAIN' | 'SLEET' | 'SNOW' | 'UNKNOWN';

/** The official current-observation "no precipitation" (없음) PTY code. */
const NO_PRECIPITATION_CODE = '0';

/**
 * Current-observation PTY (강수형태) → precipitation condition: 비(1)/빗방울(5) → `RAIN`,
 * 비/눈(2)/빗방울눈날림(6) → `SLEET`, 눈(3)/눈날림(7) → `SNOW`. `0`(없음) is handled separately as the
 * no-precipitation sentinel and is not listed here.
 */
const CURRENT_PRECIPITATION_CONDITION = new Map<string, KmaCurrentWeatherCondition>([
  ['1', 'RAIN'], // 비
  ['5', 'RAIN'], // 빗방울
  ['2', 'SLEET'], // 비/눈
  ['6', 'SLEET'], // 빗방울눈날림
  ['3', 'SNOW'], // 눈
  ['7', 'SNOW'], // 눈날림
]);

/**
 * Trim a raw code and reduce every "no usable code" case to `null`: a non-string
 * (`null`/`undefined` or anything that slips past the type at runtime), the empty string, or a
 * whitespace-only string. Surrounding whitespace is removed, but the code is otherwise left exactly
 * as given — `'01'` is not folded to `'1'`, and a number is never coerced from a numeric string, so
 * only an exact official code string can match the lookup table.
 */
function normalizeCode(code: string | null | undefined): string | null {
  if (typeof code !== 'string') {
    return null;
  }
  const trimmed = code.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Normalize a KMA 초단기실황 (current observation) `PTY` code into a common
 * {@link KmaCurrentWeatherCondition} (a subset of `WeatherCondition` in `@life-weather/contracts`).
 *
 * Policy (see `docs/kma-current-observation-provider.md`):
 *
 * 1. `1`/`5` → `RAIN`, `2`/`6` → `SLEET`, `3`/`7` → `SNOW`.
 * 2. `0` (명시적 "강수 없음") → `UNKNOWN`. Current observation carries no `SKY` item, so — unlike the
 *    forecast normalizer — there is nothing to consult for a sky state, and `CLEAR` /
 *    `PARTLY_CLOUDY` / `CLOUDY` are never guessed.
 * 3. Missing (`null`/`undefined`), blank/whitespace-only, or a code not defined for current
 *    observation → `UNKNOWN`.
 *
 * Pure and deterministic; does not mutate `precipitationTypeCode`.
 */
export function normalizeKmaCurrentWeatherCondition(
  precipitationTypeCode: string | null | undefined,
): KmaCurrentWeatherCondition {
  const code = normalizeCode(precipitationTypeCode);
  if (code === null || code === NO_PRECIPITATION_CODE) {
    return 'UNKNOWN';
  }
  return CURRENT_PRECIPITATION_CONDITION.get(code) ?? 'UNKNOWN';
}
