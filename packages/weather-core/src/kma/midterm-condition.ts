/**
 * Normalize a KMA (Korea Meteorological Administration) 중기육상예보 (`getMidLandFcst`, mid-term
 * land forecast) Korean human-readable weather phrase (`WF`) into the common `WeatherCondition`
 * state.
 *
 * Unlike short-term / ultra-short-term forecasts, mid-term land forecast does not expose a
 * numeric SKY/PTY code pair — it exposes `WF` as Korean text (official example: `구름많고 비`,
 * with modifier variants such as `흐리고 한때 비` also appearing in real KMA data). This module
 * conservatively interprets only the official mid-term sky/precipitation semantic tokens
 * (`맑음`/`구름조금`/`구름많음`/`흐림`, `비`/`소나기`/`눈`/`비-눈` mixtures) inside that text — it is
 * not a general Korean-weather NLP/fuzzy parser, and it does not enumerate every possible
 * complete `WF` sentence. See `docs/kma-midterm-condition.md` for the official-source evidence
 * and full policy.
 *
 * This is a **separate, sibling** policy from {@link normalizeKmaWeatherCondition} in
 * `./condition.ts`: that function maps numeric short/ultra-short SKY/PTY codes and treats SKY `2`
 * (구름조금) as retired/`UNKNOWN`, while the current official mid-term product still explicitly
 * lists `WB02 = 구름조금`, so this module must — and does — support it.
 *
 * This module is pure and deterministic: no network, no environment access, no system clock, no
 * global mutable state. It never mutates its input, and given the same input it always returns
 * the same result. The lookup table is module-private, built once, and never reassigned.
 */

/**
 * The subset of the common `WeatherCondition` that a mid-term `WF` phrase can produce. Every
 * literal below is a member of `WeatherCondition` in `@life-weather/contracts`; that
 * assignability is verified at compile time by a type-level test
 * (`kma-midterm-condition.test.ts`) rather than by importing the contract type into this runtime
 * module, so `weather-core` keeps no dependency — runtime or type — on `contracts` or Zod.
 */
export type KmaMidtermWeatherCondition =
  | 'CLEAR'
  | 'PARTLY_CLOUDY'
  | 'CLOUDY'
  | 'RAIN'
  | 'SNOW'
  | 'SLEET'
  | 'SHOWER'
  | 'UNKNOWN';

/** Official precipitation semantic tokens (see `docs/kma-midterm-condition.md`). */
const RAIN_TOKEN = '비';
const SNOW_TOKEN = '눈';
const SHOWER_TOKEN = '소나기';

/**
 * Official mid-term sky (WF_SKY_CD) semantic tokens, consulted only once no precipitation token
 * matched. `구름조금` is an official mid-term value (`WB02`) even though the separate short-term
 * SKY normalizer treats numeric code `2` as retired — the two policies are deliberately not
 * merged.
 */
const SKY_CONDITION = new Map<string, KmaMidtermWeatherCondition>([
  ['맑음', 'CLEAR'],
  ['구름조금', 'PARTLY_CLOUDY'],
  ['구름많음', 'PARTLY_CLOUDY'],
  ['흐림', 'CLOUDY'],
]);

/**
 * Normalize a KMA 중기육상예보 (`getMidLandFcst`) Korean `WF` phrase into a common
 * {@link KmaMidtermWeatherCondition} (a subset of `WeatherCondition` in
 * `@life-weather/contracts`).
 *
 * Policy (see `docs/kma-midterm-condition.md`):
 *
 * 1. A non-string, `null`, `undefined`, empty, or whitespace-only phrase is `UNKNOWN`.
 * 2. Presentation whitespace is stripped for matching only (`weatherPhrase` itself is never
 *    mutated); it carries no weather semantics.
 * 3. **Precipitation wins over sky.** A phrase mentioning both `비` and `눈` is `SLEET` (mixed
 *    rain/snow, checked first); otherwise `소나기` is `SHOWER`; otherwise `비` is `RAIN`;
 *    otherwise `눈` is `SNOW`. This intentionally tolerates connector/modifier wording around the
 *    token (`흐리고 비`, `흐리고 한때 비`, `흐리고 가끔 비`, even the contradictory `맑고 비`) without
 *    maintaining an exhaustive phrase list.
 * 4. Only when no precipitation token matched is the sky token consulted: `맑음` → `CLEAR`,
 *    `구름조금` / `구름많음` → `PARTLY_CLOUDY`, `흐림` → `CLOUDY`.
 * 5. Anything else (e.g. `안개`, `천둥번개`, unrecognized/malformed text) is `UNKNOWN`. This never
 *    throws and never invents a `WeatherCondition` value the mid-term product does not provide.
 *
 * Pure and deterministic; does not mutate `weatherPhrase`.
 */
export function normalizeKmaMidtermWeatherCondition(
  weatherPhrase: string | null | undefined,
): KmaMidtermWeatherCondition {
  if (typeof weatherPhrase !== 'string') {
    return 'UNKNOWN';
  }

  const normalized = weatherPhrase.replace(/\s+/gu, '');
  if (normalized === '') {
    return 'UNKNOWN';
  }

  const hasRain = normalized.includes(RAIN_TOKEN);
  const hasSnow = normalized.includes(SNOW_TOKEN);

  if (hasRain && hasSnow) {
    return 'SLEET';
  }
  if (normalized.includes(SHOWER_TOKEN)) {
    return 'SHOWER';
  }
  if (hasRain) {
    return 'RAIN';
  }
  if (hasSnow) {
    return 'SNOW';
  }

  for (const [skyToken, condition] of SKY_CONDITION) {
    if (normalized.includes(skyToken)) {
      return condition;
    }
  }

  return 'UNKNOWN';
}
