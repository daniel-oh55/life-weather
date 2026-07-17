/**
 * The KMA (기상청) hourly-forecast **application service**: the thin orchestration layer that runs
 * the PR #5 HTTP provider and the PR #6 hourly normalizer in sequence and reports which stage — if
 * any — failed.
 *
 * It exists so a caller does not have to re-implement the "fetch → branch on provider error →
 * normalize → branch on normalization error" dance every time. It adds **no** new KMA data rule:
 * the provider still owns request validation, transport, upstream classification, and slot
 * grouping; the normalizer still owns category selection, KST `forecastAt`, scalar/categorical
 * parsing, and the contracts runtime check. This file only wires the two together and keeps their
 * two error surfaces distinct via a `stage` discriminator.
 *
 * Responsibilities kept deliberately narrow:
 *
 * 1. call the injected {@link KmaForecastProvider} **exactly once**, forwarding the request and the
 *    caller's `AbortSignal` options unchanged,
 * 2. return a provider failure verbatim as a `PROVIDER`-stage error (never re-classified),
 * 3. on provider success, hand the forecast to `normalizeKmaHourlyForecast`,
 * 4. return a normalization failure verbatim as a `NORMALIZATION`-stage error (issues untouched),
 * 5. on success, return only the normalized `HourlyForecast[]`.
 *
 * What it is **not**: it does not create the provider, read the environment, touch the service key,
 * re-validate the request, pick a base date/time, convert lat/long → grid, retry, cache, fall back,
 * merge products, or build a `WeatherOverview` / `SourceMetadata` / API envelope. Those are other
 * layers or later PRs. See `docs/kma-hourly-service.md` for the full policy and boundaries.
 *
 * No side effects and no I/O of its own: `createKmaHourlyForecastService` neither calls the
 * provider nor reads the clock/environment; the network call happens only when
 * `fetchHourlyForecast` runs. The service holds no mutable state, never mutates the request,
 * options, or the provider result, and wraps the collaborators in **no** broad `try/catch` — a
 * correct provider/normalizer returns a result union rather than throwing, and hiding a
 * collaborator's programmer error behind an invented domain error is explicitly out of scope.
 */

import type { HourlyForecast } from '@life-weather/contracts';

import {
  normalizeKmaHourlyForecast,
  type KmaForecastProvider,
  type KmaForecastProviderError,
  type KmaForecastRequest,
  type KmaHourlyNormalizationIssue,
} from '../providers/kma';

/**
 * Per-call options. Structurally the same as the provider's options and forwarded unchanged, so the
 * caller's `signal` reference reaches the provider untouched (no new `AbortController`, no wrapping).
 */
export interface KmaHourlyForecastServiceOptions {
  readonly signal?: AbortSignal;
}

/**
 * The outcome of one `fetchHourlyForecast` call. Success carries only the normalized
 * `HourlyForecast[]` — never the raw provider success, raw slots, raw `fcstValue`, `totalCount`,
 * base issuance, grid, service key, URL, or body. A failure names the `stage` it happened in and
 * carries the collaborator's own error surface **verbatim**: a `PROVIDER` failure carries the
 * provider's {@link KmaForecastProviderError}; a `NORMALIZATION` failure carries the normalizer's
 * issue list. The two error surfaces are never flattened, merged, or re-interpreted.
 */
export type KmaHourlyForecastServiceResult =
  | {
      readonly ok: true;
      readonly hourly: readonly HourlyForecast[];
    }
  | {
      readonly ok: false;
      readonly stage: 'PROVIDER';
      readonly error: KmaForecastProviderError;
    }
  | {
      readonly ok: false;
      readonly stage: 'NORMALIZATION';
      readonly issues: readonly KmaHourlyNormalizationIssue[];
    };

/** The service's single public method. */
export interface KmaHourlyForecastService {
  /**
   * Fetch one already-built {@link KmaForecastRequest} through the provider and normalize the
   * result. The `request` is assumed complete (product, base issuance, grid); this service does not
   * choose or re-validate any of it. `options` — including its `signal` — is forwarded to the
   * provider exactly as given (or `undefined` when omitted).
   */
  fetchHourlyForecast(
    request: KmaForecastRequest,
    options?: KmaHourlyForecastServiceOptions,
  ): Promise<KmaHourlyForecastServiceResult>;
}

/**
 * Create an hourly-forecast service bound to an injected provider. Pure construction: it performs no
 * provider call, no `fetch`, no environment read, no timer, and registers no listener — the returned
 * object just closes over `provider`. The same instance is safe to call many times and holds no
 * mutable state.
 */
export function createKmaHourlyForecastService(
  provider: KmaForecastProvider,
): KmaHourlyForecastService {
  return {
    async fetchHourlyForecast(request, options) {
      // Exactly one provider call; the request and options (signal included) pass through unchanged.
      const fetched = await provider.fetchForecast(request, options);

      if (!fetched.ok) {
        // A transport/upstream failure is already a sanitized provider error — surface it as-is,
        // without re-classifying it, mutating it, or running the normalizer on a non-success.
        return {
          ok: false,
          stage: 'PROVIDER',
          error: fetched.error,
        };
      }

      const normalized = normalizeKmaHourlyForecast(fetched.forecast);

      if (!normalized.ok) {
        // The normalizer is all-or-nothing: report every issue verbatim, never partial hourly data.
        return {
          ok: false,
          stage: 'NORMALIZATION',
          issues: normalized.issues,
        };
      }

      return {
        ok: true,
        hourly: normalized.hourly,
      };
    },
  };
}
