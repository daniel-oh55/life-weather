/**
 * The KMA (기상청) **location hourly overview response presenter**: the pure, synchronous mapping from
 * the PR #24 internal application result ({@link KmaLocationHourlyOverviewResult}) to the mobile-facing
 * {@link WeatherResponseV1} body.
 *
 * ### Why a presenter, and where the boundary is
 *
 * The PR #24 application service returns an **internal** success shape — `{ ok, selection, overview }` —
 * whose `selection` carries server-side orchestration detail (the PR #22 fallback selection, the PR #19
 * execution trace, primary/previous attempts, the preserved PR #25 issuance identity, and the reason a
 * fallback ran). JSON-serializing that result directly would leak all of it to the mobile client. This
 * presenter is the boundary that stops that: it reads **only** `result.overview`, copies it into a fresh
 * {@link WeatherSuccessResponseV1}, and never touches `result.selection`. It is the single place where an
 * internal result becomes a public response body.
 *
 * ### Success mapping
 *
 * A `{ ok: true, selection, overview }` result becomes:
 *
 * ```text
 * { ok: true, meta: { contractVersion, generatedAt, requestId }, data: overview }
 * ```
 *
 * `result.overview` is the **only** data source; `result.selection` is neither read nor used to decide
 * anything. A **no-selection** success (`selection.selected === false`, `overview.hourly === []`,
 * `overview.sources === []`, `HOURLY` in `overview.missingSections`) is still a success — "no usable
 * hourly data" is a valid public overview, not an API error. It is never promoted to an error response.
 *
 * ### LOCATION failure mapping
 *
 * The internal `{ ok: false, stage: 'LOCATION', error: { kind: 'UNSUPPORTED_LOCATION' } }` failure — a
 * physically valid coordinate the KMA forecast grid does not cover — becomes a stable
 * {@link WeatherErrorResponseV1} with the additive public code `UNSUPPORTED_LOCATION` and a fixed public
 * message. The internal `stage`/`kind`, coordinates, grid, provider, and any other internal detail are
 * **not** copied — the error body is built field-by-field from constants, never spread from the failure.
 *
 * ### `contractVersion` ownership and caller-provided `meta`
 *
 * The presenter owns `contractVersion`: it always writes {@link CONTRACT_VERSION}, never a value the
 * caller supplied. The caller provides only `generatedAt` and `requestId`
 * ({@link WeatherResponsePresenterMetaV1}); the presenter reads exactly those two fields explicitly and
 * ignores any extra runtime key on the `meta` object (it never spreads `meta`).
 *
 * ### Producer-side validation and purity
 *
 * The assembled body is validated with the existing contracts response schema
 * ({@link weatherSuccessResponseV1} / {@link weatherErrorResponseV1}) before it is returned — this fixes
 * `contractVersion`, validates `generatedAt` / `requestId`, re-checks the {@link WeatherOverview}
 * invariants, and strips any stray key. A validation failure surfaces as a **synchronous** `ZodError`;
 * the presenter never catches or wraps it. It is a pure, synchronous function: it returns a value (never
 * a `Promise`), reads no clock/`Date`/environment/network/random, generates no `requestId`, logs nothing,
 * mutates neither input, and allocates a fresh wrapper on every call.
 *
 * ### What it is not
 *
 * It decides **no** HTTP status, `Content-Type`, header, or body-size limit; registers **no** route; does
 * **no** startup wiring; and generates neither the clock (`generatedAt`) nor the `requestId` — those are
 * a later route PR's concern. A future `/weather` route will call this presenter with a caller-supplied
 * `generatedAt`/`requestId` and map the returned body to an HTTP status. See
 * `docs/weather-response-presenter.md`.
 */

import {
  CONTRACT_VERSION,
  weatherErrorResponseV1,
  weatherSuccessResponseV1,
  type ApiMetaV1,
  type WeatherResponseV1,
} from '@life-weather/contracts';

import type { KmaLocationHourlyOverviewResult } from '../services';

/**
 * The subset of {@link ApiMetaV1} a caller supplies to the presenter: `generatedAt` and `requestId`
 * only. `contractVersion` is deliberately **absent** — the presenter owns it and always writes
 * {@link CONTRACT_VERSION}, so a caller can neither set nor override the response version.
 */
export type WeatherResponsePresenterMetaV1 = Pick<
  ApiMetaV1,
  'generatedAt' | 'requestId'
>;

/**
 * The stable public message for an unsupported location. Deliberately value-free: it names no
 * coordinate, grid, provider, or internal stage.
 */
const UNSUPPORTED_LOCATION_MESSAGE = 'The requested location is not supported.';

/**
 * The single non-success arm the presenter maps today, pinned on **both** the top-level `stage` and the
 * nested `error.kind`. Extracting on `stage: 'LOCATION'` alone would also admit any future `LOCATION`-stage
 * arm with a *different* `error.kind` (e.g. an `AMBIGUOUS_LOCATION`), which the presenter would then
 * silently publish as `UNSUPPORTED_LOCATION`; fixing `error.kind` too keeps this type to exactly the one
 * supported failure. See the guard below and `docs/weather-response-presenter.md`.
 */
type UnsupportedLocationFailure = Extract<
  KmaLocationHourlyOverviewResult,
  {
    readonly stage: 'LOCATION';
    readonly error: {
      readonly kind: 'UNSUPPORTED_LOCATION';
    };
  }
>;

/**
 * Map the PR #24 internal application result to the mobile-facing {@link WeatherResponseV1} body.
 *
 * A success maps to `{ ok: true, meta, data: result.overview }` (the `overview` only — never the
 * `selection`); the `LOCATION`/`UNSUPPORTED_LOCATION` failure maps to a stable error body with code
 * `UNSUPPORTED_LOCATION`. `meta.contractVersion` is always {@link CONTRACT_VERSION}; `generatedAt` and
 * `requestId` come from `meta`. The result is validated with the contracts response schema, so an invalid
 * `generatedAt` / `requestId` / `overview` throws a synchronous `ZodError`. Pure and synchronous — it
 * reads no clock/environment/network, mutates no input, and returns a fresh object each call.
 */
export function presentKmaLocationHourlyOverviewResponseV1(
  result: KmaLocationHourlyOverviewResult,
  meta: WeatherResponsePresenterMetaV1,
): WeatherResponseV1 {
  // Success: the overview is the ONLY data source. `result.selection` (and its execution trace,
  // issuance identity, and fallback detail) is never read — it stops at this boundary.
  if (result.ok) {
    return weatherSuccessResponseV1.parse({
      ok: true,
      meta: {
        contractVersion: CONTRACT_VERSION,
        generatedAt: meta.generatedAt,
        requestId: meta.requestId,
      },
      data: result.overview,
    });
  }

  // Exhaustiveness guard, fixed on BOTH `stage` and `error.kind`. The only non-success arm today is the
  // LOCATION/UNSUPPORTED_LOCATION failure. The classic `assertNever(result)` pattern cannot compile here
  // because a single remaining arm never narrows to `never`; this `satisfies` check achieves the same
  // protection differently. Pinning only `stage: 'LOCATION'` would let a future same-stage arm with a
  // different `error.kind` slip through and be silently published as UNSUPPORTED_LOCATION; pinning
  // `error.kind` too means such an arm — or any new failure stage or other union arm — no longer satisfies
  // `UnsupportedLocationFailure` and this line stops compiling, forcing the new arm to be mapped
  // explicitly. NO field is read off `result`, so no internal detail can leak into the response.
  result satisfies UnsupportedLocationFailure;

  // A stable public error built from constants — the internal `stage`/`kind`/coordinate/grid is never
  // copied out of `result`.
  return weatherErrorResponseV1.parse({
    ok: false,
    meta: {
      contractVersion: CONTRACT_VERSION,
      generatedAt: meta.generatedAt,
      requestId: meta.requestId,
    },
    error: {
      code: 'UNSUPPORTED_LOCATION',
      message: UNSUPPORTED_LOCATION_MESSAGE,
      retryable: false,
    },
  });
}
