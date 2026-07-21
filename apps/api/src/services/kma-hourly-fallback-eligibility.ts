/**
 * The KMA (기상청) hourly-forecast **fallback-eligibility classifier**: a pure, synchronous policy
 * function that inspects **one** {@link KmaHourlyForecastServiceResult} and decides whether a later
 * orchestration step is allowed to try a single fallback to the immediately-previous issuance.
 *
 * This PR only **classifies**. It builds no request plan, wires in no PR #16 candidate selector,
 * issues no second KMA HTTP request, and performs no retry, fallback execution, delay, or
 * `AbortSignal` policy — those are later orchestration PRs. See `docs/kma-fallback-eligibility.md`
 * for the full policy, the official evidence, and the boundaries.
 *
 * There are exactly **two** fallback-eligible signals, both meaning "the newest issuance is not
 * available yet" rather than a transport/gateway/malformed-data failure:
 *
 * 1. `KMA_NO_DATA` — a `PROVIDER`-stage `KMA_UPSTREAM_ERROR` whose `resultCode` is exactly `'03'`
 *    (기상청 공식 의미 `NODATA_ERROR`). The provider already surfaced the code verbatim; this
 *    classifier matches the **exact** two-character string `'03'` — no trim, no `padStart`, no
 *    numeric coercion, no loose equality, no code-range bucketing.
 * 2. `EMPTY_HOURLY` — a service success (`ok: true`) whose `hourly` array is empty. This is the
 *    service-level empty-success signal; the current pipeline can produce it from a `totalCount === 0`
 *    success page (→ empty slots → empty `hourly`), but the classifier never reads `totalCount` — it
 *    only observes the application-level `hourly.length === 0`.
 *
 * Every other result is ineligible: a non-empty success, every other provider error (transport,
 * gateway, timeout, abort, HTTP, network, invalid/mismatched/incomplete response, and any
 * `KMA_UPSTREAM_ERROR` whose code is not exactly `'03'`), and **every** normalization failure
 * regardless of its issues (`ABSENT`/`NULL`/`INVALID` alike — the issues are never re-inspected).
 *
 * Purity and reference safety: deterministic and synchronous; no system clock, environment,
 * network, `Promise`, logging, or `try/catch`; no mutation of the input or its nested
 * error/issues/hourly; no global mutable state, cache, timer, or listener. Every call returns a
 * **fresh** result object, and no reference to the original result, error, issues, or hourly array
 * is ever exposed on the output.
 */

import type { KmaHourlyForecastServiceResult } from './kma-hourly-forecast';

/**
 * The 기상청 upstream result code that means `NODATA_ERROR` — the newest scheduled issuance has no
 * data yet. Module-private and never exported; matched as an **exact** two-character string.
 */
const KMA_NO_DATA_RESULT_CODE = '03';

/** Why a result is fallback-eligible. Exactly one of the two no-data signals. */
export type KmaHourlyFallbackReason = 'KMA_NO_DATA' | 'EMPTY_HOURLY';

/**
 * The classification of one service result. An eligible result names the no-data `reason`; an
 * ineligible result carries **no** `reason` key. It exposes no retry/attempt/delay/candidate field,
 * no original `resultCode`/error/issues/hourly, and no source metadata or stale flag.
 */
export type KmaHourlyFallbackEligibility =
  | {
      readonly eligible: true;
      readonly reason: KmaHourlyFallbackReason;
    }
  | {
      readonly eligible: false;
    };

/**
 * Classify whether one KMA hourly service result may trigger a single previous-issuance fallback.
 *
 * Eligible only for the two no-data signals — a success with an empty `hourly` array
 * (`EMPTY_HOURLY`) or a `PROVIDER`-stage `KMA_UPSTREAM_ERROR` with `resultCode` exactly `'03'`
 * (`KMA_NO_DATA`). Every other outcome (non-empty success, any other provider error, and every
 * normalization failure) is ineligible. Pure, synchronous, and free of side effects; the input is
 * never mutated and a fresh result object is returned on every call.
 */
export function classifyKmaHourlyFallbackEligibility(
  result: KmaHourlyForecastServiceResult,
): KmaHourlyFallbackEligibility {
  if (result.ok) {
    // Empty-success is the only eligible success — observed purely as hourly.length === 0, never
    // by reading totalCount (the service result does not expose it). Element contents are ignored.
    return result.hourly.length === 0
      ? { eligible: true, reason: 'EMPTY_HOURLY' }
      : { eligible: false };
  }

  // The only eligible failure: a provider-stage upstream error whose code is exactly '03'. A
  // NORMALIZATION-stage failure and every other provider error kind/code fall through to ineligible.
  if (
    result.stage === 'PROVIDER' &&
    result.error.kind === 'KMA_UPSTREAM_ERROR' &&
    result.error.resultCode === KMA_NO_DATA_RESULT_CODE
  ) {
    return { eligible: true, reason: 'KMA_NO_DATA' };
  }

  return { eligible: false };
}
