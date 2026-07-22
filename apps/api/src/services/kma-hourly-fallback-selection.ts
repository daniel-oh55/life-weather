/**
 * The KMA (기상청) hourly-fallback **result-selection policy**: the pure, deterministic function that
 * reads a PR #19 {@link KmaHourlyFallbackServiceResult} execution trace and decides which hourly
 * forecast result — if any — a later `WeatherOverview`/`SourceMetadata` assembler may actually use as
 * its data source.
 *
 * The PR #19 fallback service returns an **execution trace**: it records *what ran* (primary only, or
 * primary then a single previous attempt) and *why* (the eligibility `fallbackReason`), but it deliberately
 * picks no winner. It never answers three questions that a downstream assembler must:
 *
 * 1. Which of `primary`/`previous` is a **usable** hourly data source?
 * 2. Was the previous (fallback) result the one actually **used** as the final source?
 * 3. Is there **no** usable result at all (both attempts unusable)?
 *
 * This selector answers exactly those three questions and nothing more. It is the sole owner of the
 * `fallbackAttempted` vs `fallbackUsed` distinction:
 *
 * - **`fallbackAttempted`** (owned by the PR #19 trace) — the previous hourly service was *invoked*. It
 *   is true regardless of whether that invocation produced data, an empty page, or an error.
 * - **`fallbackUsed`** (computed here) — the previous result's usable hourly data was actually *selected*
 *   as the final source. A previous request merely running is not enough: a previous HTTP 503 or an
 *   empty success is `fallbackAttempted: true` but `fallbackUsed: false`; only a previous non-empty
 *   success that is actually chosen is `fallbackUsed: true`.
 *
 * ### Usable result definition
 *
 * A {@link KmaHourlyForecastServiceResult} is **usable** only when *both* hold:
 *
 * 1. `result.ok === true`, and
 * 2. `result.hourly.length > 0`.
 *
 * Everything else is **unusable**: a success with an empty `hourly` array, and every error result
 * (a `PROVIDER`-stage error — `ABORTED`/`TIMEOUT`/`NETWORK_ERROR`/`HTTP_ERROR`/`KMA_UPSTREAM_ERROR`
 * with any `resultCode` including `'03'`/etc. — or a `NORMALIZATION`-stage error). The selector does
 * **not** rank error kinds against each other, read `resultCode`, inspect provider-error kinds, or
 * re-inspect normalization issues: it looks only at `ok`, `hourly.length`, and `fallbackAttempted`.
 *
 * ### Selection priority (deterministic)
 *
 * 1. `primary` usable → select `primary` (`source: 'PRIMARY'`, `fallbackUsed: false`).
 * 2. else if the trace attempted fallback and `previous` is usable → select `previous`
 *    (`source: 'PREVIOUS'`, `fallbackUsed: true`).
 * 3. else → no selection (`selected: false`, `source: null`, `result: null`).
 *
 * **Primary precedence is absolute.** Even if a (custom classifier / test collaborator / hand-built
 * valid) trace carries a usable `previous` alongside a usable `primary`, the primary wins and
 * `fallbackUsed` stays `false`. The production classifier never runs the previous request on a usable
 * primary, but the selector must stay stable on any structurally-valid trace, so precedence is fixed
 * here rather than assumed from production wiring.
 *
 * ### Boundary — selection is not eligibility
 *
 * This is *not* the PR #17 eligibility classifier. Eligibility asks, **before** the previous request,
 * "given this one primary result, should we try a previous request?"; selection asks, **after** every
 * attempt has completed, "which non-empty success result do we actually use as the data source?".
 * The selector never calls the PR #17 classifier and never re-implements its rules — it only reads
 * `ok`, `hourly.length`, and `fallbackAttempted`.
 *
 * ### Boundary — not the location branch
 *
 * The input is exactly a {@link KmaHourlyFallbackServiceResult} (a primary/previous hourly trace); it
 * is **not** a `KmaLocationHourlyFallbackResult`. The location facade owns the `LOCATION` /
 * `UNSUPPORTED_LOCATION` branch and coordinate-support decision; a downstream assembler narrows away
 * that branch first, then hands the successful hourly trace to this selector.
 *
 * ### Purity and boundaries
 *
 * Synchronous and pure: it returns no `Promise` and is not `async`; it performs no network, Provider,
 * service, fallback execution, or classifier call; it reads no clock, environment, or `AbortSignal`;
 * it logs nothing, holds no state/cache/singleton, uses no broad `try/catch`, and mutates nothing. It
 * only *reads* the caller's trace and returns a fresh selection wrapper that preserves the caller's
 * exact `execution` reference and the exact selected `primary`/`previous` result reference — no clone,
 * spread, or nested mutation. It builds **no** `WeatherOverview`/`SourceMetadata`, wires into **no**
 * production composition, and touches **no** route/cache — those are later PRs.
 *
 * See `docs/kma-hourly-fallback-selection.md`.
 */

import type { KmaHourlyForecastServiceResult } from './kma-hourly-forecast';
import type { KmaHourlyFallbackServiceResult } from './kma-hourly-fallback';

/**
 * A usable hourly-forecast result: the success branch of {@link KmaHourlyForecastServiceResult}. Used
 * as the narrowed `result` type on a selected branch so a consumer gets `ok: true` + `hourly` without
 * a re-check. (Usability additionally requires a non-empty `hourly`, which the runtime guard enforces.)
 */
type KmaHourlyForecastSuccessResult = Extract<
  KmaHourlyForecastServiceResult,
  { readonly ok: true }
>;

/**
 * The source of a selected hourly result: the availability-aware `PRIMARY` issuance or the
 * single-step-back `PREVIOUS` (fallback) issuance. `null` on a no-selection outcome (see
 * {@link KmaHourlyFallbackSelection}).
 */
export type KmaHourlyFallbackSelectionSource = 'PRIMARY' | 'PREVIOUS';

/**
 * The outcome of {@link selectKmaHourlyFallbackResult}. Exactly one of three branches, each with the
 * identical set of own keys (`execution`, `fallbackUsed`, `result`, `selected`, `source`) so no branch
 * leaks a `primary`/`previous`/`fallbackAttempted`/`fallbackReason` field (those live inside
 * `execution`) or any transport/selection alias:
 *
 * - **primary selected** — the primary result is usable. `fallbackUsed` is always `false`; `result` is
 *   the exact `execution.primary` reference (narrowed to its success branch).
 * - **previous selected** — the primary was unusable, fallback was attempted, and the previous result
 *   is usable. `fallbackUsed` is always `true`; `result` is the exact `execution.previous` reference.
 * - **no selection** — neither is usable. `selected: false`, `source: null`, `fallbackUsed: false`,
 *   `result: null`.
 *
 * Every branch carries the caller's `execution` trace by the **same reference** (no clone/spread), so a
 * consumer still has the full "what ran and why" trace alongside the selection.
 */
export type KmaHourlyFallbackSelection =
  | {
      readonly selected: true;
      readonly source: 'PRIMARY';
      readonly fallbackUsed: false;
      readonly result: KmaHourlyForecastSuccessResult;
      readonly execution: KmaHourlyFallbackServiceResult;
    }
  | {
      readonly selected: true;
      readonly source: 'PREVIOUS';
      readonly fallbackUsed: true;
      readonly result: KmaHourlyForecastSuccessResult;
      readonly execution: KmaHourlyFallbackServiceResult;
    }
  | {
      readonly selected: false;
      readonly source: null;
      readonly fallbackUsed: false;
      readonly result: null;
      readonly execution: KmaHourlyFallbackServiceResult;
    };

/**
 * A result is usable only when it is a success (`ok: true`) *and* carries at least one `HourlyForecast`.
 * A success with an empty `hourly` array and every error result are unusable. The narrowing predicate
 * lets a caller treat a usable result as the success branch. No error kind, `resultCode`, provider-error
 * kind, or normalization issue is inspected — only `ok` and `hourly.length`.
 */
function isUsableKmaHourlyForecastResult(
  result: KmaHourlyForecastServiceResult,
): result is KmaHourlyForecastSuccessResult {
  return result.ok && result.hourly.length > 0;
}

/**
 * Select the usable hourly forecast result from one PR #19 fallback execution trace.
 *
 * Deterministic precedence: a usable `primary` wins outright (`source: 'PRIMARY'`,
 * `fallbackUsed: false`); otherwise, only when the trace attempted fallback and its `previous` result
 * is usable, the previous result is selected (`source: 'PREVIOUS'`, `fallbackUsed: true`); otherwise no
 * result is selected (`selected: false`, `source: null`, `result: null`, `fallbackUsed: false`).
 *
 * Pure and synchronous — it reads only `execution.primary`, `execution.fallbackAttempted`, and (when
 * relevant) `execution.previous`, and returns a fresh wrapper that preserves the caller's exact
 * `execution` reference and the exact selected result reference. It never mutates the trace, executes a
 * request, calls the eligibility classifier, or reads a clock/environment/network.
 */
export function selectKmaHourlyFallbackResult(
  execution: KmaHourlyFallbackServiceResult,
): KmaHourlyFallbackSelection {
  // 1. A usable primary always wins — even when a structurally-valid trace also carries a usable
  //    previous. The primary is the availability-aware issuance; the fallback is not "used".
  if (isUsableKmaHourlyForecastResult(execution.primary)) {
    return {
      selected: true,
      source: 'PRIMARY',
      fallbackUsed: false,
      result: execution.primary,
      execution,
    };
  }

  // 2. Primary unusable: only a trace that actually attempted fallback can carry a `previous` result;
  //    the discriminant narrows to that branch. If that previous result is usable, the fallback data
  //    is the selected source.
  if (
    execution.fallbackAttempted &&
    isUsableKmaHourlyForecastResult(execution.previous)
  ) {
    return {
      selected: true,
      source: 'PREVIOUS',
      fallbackUsed: true,
      result: execution.previous,
      execution,
    };
  }

  // 3. Neither attempt produced usable data (no fallback and unusable primary, or fallback attempted
  //    but the previous result is empty/error). There is no data source to use.
  return {
    selected: false,
    source: null,
    fallbackUsed: false,
    result: null,
    execution,
  };
}
