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

/**
 * Official mid-term sky (WF_SKY_CD) semantic tokens, consulted only when the entire normalized
 * phrase is one of these exact values (no substring matching). `구름조금` is an official mid-term
 * value (`WB02`) even though the separate short-term SKY normalizer treats numeric code `2` as
 * retired — the two policies are deliberately not merged.
 */
const SKY_CONDITION = new Map<string, KmaMidtermWeatherCondition>([
  ['맑음', 'CLEAR'],
  ['구름조금', 'PARTLY_CLOUDY'],
  ['구름많음', 'PARTLY_CLOUDY'],
  ['흐림', 'CLOUDY'],
]);

/**
 * Official precipitation semantic tokens (see `docs/kma-midterm-condition.md`), keyed by the
 * exact normalized atom captured by {@link PRECIPITATION_PATTERN}.
 */
const PRECIPITATION_CONDITION = new Map<string, KmaMidtermWeatherCondition>([
  ['비/눈', 'SLEET'],
  ['눈/비', 'SLEET'],
  ['소나기', 'SHOWER'],
  ['비', 'RAIN'],
  ['눈', 'SNOW'],
]);

/**
 * Anchored grammar for the narrow set of precipitation phrasings evidenced by this PR:
 * an optional sky/connective prefix, an optional frequency modifier, then exactly one
 * precipitation atom — nothing else. This intentionally rejects any text that merely contains a
 * precipitation syllable (`비교적 맑음`, `눈부심`) without being one of these supported forms.
 */
const PRECIPITATION_PATTERN =
  /^(?:맑고|구름많고|흐리고)?(?:한때|가끔)?(비\/눈|눈\/비|소나기|비|눈)$/u;

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
 * 3. **Precipitation wins over sky**, but only when the *entire* normalized phrase conforms to a
 *    narrow anchored grammar: an optional sky/connective prefix (`맑고`, `구름많고`, `흐리고`), an
 *    optional frequency modifier (`한때`, `가끔`), then exactly one precipitation atom (`비`, `눈`,
 *    `소나기`, `비/눈`, `눈/비`) — see {@link PRECIPITATION_PATTERN}. `비/눈` and `눈/비` map to
 *    `SLEET`; `소나기` maps to `SHOWER`; `비` maps to `RAIN`; `눈` maps to `SNOW`. This tolerates the
 *    evidenced connector/modifier wording (`흐리고 비`, `흐리고 한때 비`, `흐리고 가끔 비`, even the
 *    contradictory `맑고 비`) while rejecting any text that merely contains a precipitation
 *    syllable without matching the grammar (`비교적 맑음`, `눈부심`).
 * 4. Only when the phrase does not match the precipitation grammar is it checked against the sky
 *    map using **exact whole-string matching** (no substring matching): `맑음` → `CLEAR`,
 *    `구름조금` / `구름많음` → `PARTLY_CLOUDY`, `흐림` → `CLOUDY`.
 * 5. Anything else (e.g. `안개`, `천둥번개`, unrecognized/malformed text, a recognized token
 *    embedded in unsupported surrounding text) is `UNKNOWN`. This never throws and never invents
 *    a `WeatherCondition` value the mid-term product does not provide.
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

  const precipitationMatch = PRECIPITATION_PATTERN.exec(normalized);
  if (precipitationMatch) {
    const condition = PRECIPITATION_CONDITION.get(precipitationMatch[1]!);
    if (condition) {
      return condition;
    }
  }

  return SKY_CONDITION.get(normalized) ?? 'UNKNOWN';
}
