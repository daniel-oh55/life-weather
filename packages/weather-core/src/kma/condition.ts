/**
 * Normalize a KMA (Korea Meteorological Administration) short-term / ultra-short-term
 * forecast sky (SKY) and precipitation-type (PTY) code pair into the common
 * `WeatherCondition` state.
 *
 * The code meanings come from the official KMA guide — see `docs/kma-normalization.md`
 * (`기상청_단기예보 조회서비스`, 공공데이터 ID `15084084`, 활용가이드 `2607`). The same numeric
 * code can mean different things across products, so the forecast product is an explicit,
 * required part of the input; PTY `0`–`4` are shared by 단기예보 and 초단기예보, while PTY
 * `5`/`6`/`7` are 초단기예보-only and are treated as `UNKNOWN` under 단기예보.
 *
 * This module is pure and deterministic: no network, no environment access, no system clock,
 * no global mutable state. It never mutates its input, and given the same input it always
 * returns the same result. The lookup tables are module-private, built once, and never
 * reassigned.
 */

/**
 * Which KMA forecast product a raw code pair came from.
 *
 * - `SHORT_FORECAST` — 단기예보 (`getVilageFcst`).
 * - `ULTRA_SHORT_FORECAST` — 초단기예보 (`getUltraSrtFcst`).
 *
 * 초단기실황 (`getUltraSrtNcst`) is intentionally out of scope for this normalizer.
 */
export const KmaForecastProduct = {
  ULTRA_SHORT_FORECAST: 'ULTRA_SHORT_FORECAST',
  SHORT_FORECAST: 'SHORT_FORECAST',
} as const;

export type KmaForecastProduct =
  (typeof KmaForecastProduct)[keyof typeof KmaForecastProduct];

/**
 * The subset of the common `WeatherCondition` that KMA SKY/PTY codes can produce.
 *
 * `THUNDERSTORM` and `FOG` are deliberately absent: neither is expressible with a SKY or PTY
 * code (KMA carries lightning via `LGT` and fog via other products / 특보, which are out of
 * scope here). Every literal below is a member of `WeatherCondition` in
 * `@life-weather/contracts`; that assignability is verified at compile time by a type-level
 * test (`kma-condition.test.ts`) rather than by importing the contract type into this runtime
 * module, so `weather-core` keeps no dependency — runtime or type — on `contracts` or Zod.
 */
export type KmaWeatherCondition =
  | 'CLEAR'
  | 'PARTLY_CLOUDY'
  | 'CLOUDY'
  | 'RAIN'
  | 'SNOW'
  | 'SLEET'
  | 'SHOWER'
  | 'UNKNOWN';

export interface NormalizeKmaWeatherConditionInput {
  /** Which forecast product the codes came from — the codes are interpreted per product. */
  product: KmaForecastProduct;
  /** Raw KMA `SKY` code (e.g. `'1'`), or `null`/`undefined` when not supplied. */
  skyCode: string | null | undefined;
  /** Raw KMA `PTY` code (e.g. `'1'`), or `null`/`undefined` when not supplied. */
  precipitationTypeCode: string | null | undefined;
}

/** The PTY code that officially means "no precipitation" (없음), shared by both products. */
const NO_PRECIPITATION_CODE = '0';

/**
 * SKY (하늘상태) → condition. Identical for both products: 맑음(1), 구름많음(3), 흐림(4).
 * Code `2` (구름조금) was retired from the current guide and is intentionally absent, so it
 * resolves to `UNKNOWN`.
 */
const SKY_CONDITION = new Map<string, KmaWeatherCondition>([
  ['1', 'CLEAR'], // 맑음
  ['3', 'PARTLY_CLOUDY'], // 구름많음
  ['4', 'CLOUDY'], // 흐림
]);

/**
 * PTY (강수형태) → precipitation condition for 단기예보: 비(1), 비/눈(2), 눈(3), 소나기(4).
 * `0` (없음) is handled separately as the no-precipitation sentinel and is not listed here.
 */
const SHORT_FORECAST_PRECIPITATION = new Map<string, KmaWeatherCondition>([
  ['1', 'RAIN'], // 비
  ['2', 'SLEET'], // 비/눈
  ['3', 'SNOW'], // 눈
  ['4', 'SHOWER'], // 소나기
]);

/**
 * PTY (강수형태) → precipitation condition for 초단기예보: 비(1), 비/눈(2), 눈(3), 소나기(4),
 * 빗방울(5), 빗방울눈날림(6), 눈날림(7). 소나기(4) is shared with 단기예보; the light/flurry
 * variants that only 초단기예보 defines fold into the nearest common state: 빗방울 → `RAIN`,
 * 빗방울눈날림 → `SLEET`, 눈날림 → `SNOW`.
 */
const ULTRA_SHORT_FORECAST_PRECIPITATION = new Map<string, KmaWeatherCondition>([
  ['1', 'RAIN'], // 비
  ['2', 'SLEET'], // 비/눈
  ['3', 'SNOW'], // 눈
  ['4', 'SHOWER'], // 소나기
  ['5', 'RAIN'], // 빗방울
  ['6', 'SLEET'], // 빗방울눈날림
  ['7', 'SNOW'], // 눈날림
]);

const PRECIPITATION_BY_PRODUCT = new Map<
  KmaForecastProduct,
  Map<string, KmaWeatherCondition>
>([
  [KmaForecastProduct.SHORT_FORECAST, SHORT_FORECAST_PRECIPITATION],
  [KmaForecastProduct.ULTRA_SHORT_FORECAST, ULTRA_SHORT_FORECAST_PRECIPITATION],
]);

/**
 * Trim a raw code and reduce every "no usable code" case to `null`: a non-string
 * (`null`/`undefined` or anything that slips past the type at runtime), the empty string, or
 * a whitespace-only string. Surrounding whitespace is removed, but the code is otherwise left
 * exactly as given — `'01'` is not folded to `'1'`, and a number is never coerced from a
 * numeric string, so only an exact official code string can match a lookup table.
 */
function normalizeCode(code: string | null | undefined): string | null {
  if (typeof code !== 'string') {
    return null;
  }
  const trimmed = code.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Normalize a KMA forecast SKY/PTY pair into a common {@link KmaWeatherCondition} (a subset of
 * `WeatherCondition` in `@life-weather/contracts`).
 *
 * Precedence and fallback rules (see `docs/kma-normalization.md`):
 *
 * 1. **PTY wins.** A recognized precipitation PTY for this product maps to its condition and
 *    `SKY` is ignored — e.g. PTY 비 with SKY 맑음 is `RAIN`.
 * 2. **SKY only on explicit "no precipitation".** Only when PTY is exactly the official
 *    no-precipitation code (`0`) is SKY consulted.
 * 3. **No fallback on a missing/unknown PTY.** If PTY is `null`, `undefined`, empty,
 *    whitespace-only, or a code not defined for this product (including a code that is only
 *    valid for the *other* product, e.g. `5`/`6`/`7` under 단기예보), the result is `UNKNOWN`
 *    — SKY is never used to guess.
 * 4. **Unknown/missing SKY under no-precipitation is `UNKNOWN`.** With PTY `0` but a
 *    `null`/`undefined`/empty/unknown SKY, the result is `UNKNOWN`.
 *
 * Pure and deterministic; does not mutate `input`.
 */
export function normalizeKmaWeatherCondition(
  input: NormalizeKmaWeatherConditionInput,
): KmaWeatherCondition {
  const precipitationTable = PRECIPITATION_BY_PRODUCT.get(input.product);
  if (precipitationTable === undefined) {
    return 'UNKNOWN';
  }

  const precipitationCode = normalizeCode(input.precipitationTypeCode);
  if (precipitationCode === null) {
    // Missing/blank PTY: do not fall back to SKY.
    return 'UNKNOWN';
  }

  if (precipitationCode === NO_PRECIPITATION_CODE) {
    // Explicit "no precipitation" is the only case where SKY decides the condition.
    const skyCode = normalizeCode(input.skyCode);
    if (skyCode === null) {
      return 'UNKNOWN';
    }
    return SKY_CONDITION.get(skyCode) ?? 'UNKNOWN';
  }

  // A precipitation code that is unknown for this product does not fall back to SKY.
  return precipitationTable.get(precipitationCode) ?? 'UNKNOWN';
}
