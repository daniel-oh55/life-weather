/**
 * The KMA (기상청) **scheduled hourly-forecast facade**: a deliberately thin application-level
 * component that connects two existing collaborators in order — the PR #9 request factory and the
 * PR #7 hourly service — so a caller can go straight from `product`/`nx`/`ny` to an
 * {@link KmaHourlyForecastServiceResult} without wiring the two by hand every time.
 *
 * Pipeline it connects:
 *
 * ```text
 * caller input (product / nx / ny)
 *   → requestFactory.createScheduledRequest(input)   // PR #9
 *   → completed KmaForecastRequest
 *   → hourlyService.fetchHourlyForecast(request, options)   // PR #7
 *   → KmaHourlyForecastServiceResult (returned verbatim)
 * ```
 *
 * Both collaborators are **injected**. This facade introduces **no** new data rule and **no** new
 * error policy: the request factory still owns clock reads, the PR #8 issue-time selector, and
 * request assembly; the hourly service still owns the provider call, the provider/normalization
 * error split, and the result union. This file only sequences the two and passes every reference
 * through unchanged.
 *
 * Reference pass-through: the caller's `input` reaches the request factory as the **same** object
 * reference (never cloned, spread, destructured, defaulted, or re-validated); the request the
 * factory returns reaches the hourly service as the **same** reference (never cloned, mutated, or
 * re-checked); and the caller's `options` — including its `AbortSignal` — reaches the hourly service
 * as the **same** reference (omitted `options` is forwarded as exactly `undefined`, never `{}`).
 *
 * Promise identity: `fetchScheduledHourlyForecast` returns the **exact** Promise the hourly service
 * returns — the method is intentionally written without an `async` marker and adds no extra Promise
 * layer, so a
 * success, a provider-stage failure, a normalization-stage failure, a synchronous throw, and a
 * rejection all propagate exactly as the collaborators produced them. It never intercepts, wraps, or
 * re-messages a rejection or a thrown error.
 *
 * Error boundary: no new result union and no new facade error type. If the request factory throws
 * (an invalid-clock `RangeError`, an unsupported-product `RangeError`, or an error from the injected
 * clock), the **same** error reference propagates and the hourly service is **not** called. If the
 * hourly service throws synchronously or returns a rejected Promise, that same reference propagates
 * unchanged.
 *
 * Construction is side-effect-free: `createKmaScheduledHourlyForecastFacade` does not call either
 * collaborator, read a clock, read the environment, touch the network, register a listener, or start
 * a timer — the returned object merely closes over the two references and holds no other state, so
 * the same instance is safe to call repeatedly with each call independent of any previous one.
 *
 * What it is **not**: it does not build a provider, read a system/wall clock, provide a default
 * clock, read a service key, convert lat/long → grid, apply an API-availability delay, retry, fall
 * back, or assemble a `WeatherOverview`. Those belong to a later composition root / other PRs. See
 * `docs/kma-scheduled-hourly-facade.md`.
 */

import type {
  KmaForecastRequestFactory,
  KmaForecastRequestFactoryInput,
} from './kma-forecast-request';
import type {
  KmaHourlyForecastService,
  KmaHourlyForecastServiceOptions,
  KmaHourlyForecastServiceResult,
} from './kma-hourly-forecast';

/**
 * The caller-supplied input. Reused verbatim from the PR #9 request factory — the facade never
 * redefines `product`/`nx`/`ny`, so its input shape can never drift from the factory's.
 */
export type KmaScheduledHourlyForecastInput = KmaForecastRequestFactoryInput;

/**
 * Per-call options. Reused verbatim from the PR #7 hourly service (its `signal` included) — the
 * facade forwards this reference to the service untouched.
 */
export type KmaScheduledHourlyForecastOptions =
  KmaHourlyForecastServiceOptions;

/**
 * The outcome of one call. Reused verbatim from the PR #7 hourly service — the facade returns the
 * service's own success / `PROVIDER` / `NORMALIZATION` result unchanged and defines no result of its
 * own.
 */
export type KmaScheduledHourlyForecastResult =
  KmaHourlyForecastServiceResult;

/** The facade's single public method. */
export interface KmaScheduledHourlyForecastFacade {
  /**
   * Build a scheduled {@link KmaForecastRequest} from `input` via the request factory, then fetch it
   * through the hourly service. Calls the factory **exactly once** and, on factory success, the
   * hourly service **exactly once**; forwards `input`, the resulting request, and `options` by
   * reference; and returns the hourly service's Promise as-is.
   */
  fetchScheduledHourlyForecast(
    input: KmaScheduledHourlyForecastInput,
    options?: KmaScheduledHourlyForecastOptions,
  ): Promise<KmaScheduledHourlyForecastResult>;
}

/**
 * Create a scheduled hourly-forecast facade bound to an injected request factory and hourly service.
 * Pure construction: it calls neither collaborator and performs no I/O — the returned object just
 * closes over the two references. The same instance is safe to call many times; it holds no mutable
 * state and each call is independent of any previous one.
 */
export function createKmaScheduledHourlyForecastFacade(
  requestFactory: KmaForecastRequestFactory,
  hourlyService: KmaHourlyForecastService,
): KmaScheduledHourlyForecastFacade {
  return {
    fetchScheduledHourlyForecast(input, options) {
      // Step 1: the factory assembles the request (reads its injected clock, calls the PR #8
      // selector). It runs exactly once; a factory throw propagates verbatim and step 2 never runs.
      const request = requestFactory.createScheduledRequest(input);

      // Step 2: hand the request and the caller's options straight to the hourly service and return
      // its Promise unchanged — no extra Promise layer, so the result/rejection contract is intact.
      return hourlyService.fetchHourlyForecast(request, options);
    },
  };
}
