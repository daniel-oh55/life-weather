/**
 * Provider-neutral **weather query store**.
 *
 * Wraps an injected {@link WeatherApiClient} with the small `IDLE` / `LOADING` / `SUCCESS` / `ERROR`
 * state machine a screen needs to show the weather for one selected saved location: a stable,
 * top-level-frozen cached snapshot, a subscribe/notify contract a React `useSyncExternalStore`
 * consumer can read, and a single active request at a time.
 *
 * This module owns no saved-location, persistence, environment, or React concern — it only ever
 * sees an already-built `WeatherRequestV1`. `WeatherRequestV1.location.id` is the *sole* location
 * identity the store knows about: there is no separate `locationId` parameter, so a caller cannot
 * pass a `locationId` that disagrees with the request it is paired with. It never imports React,
 * Expo, `process.env`, the production client singleton, the saved-location store, AsyncStorage, or
 * logging/telemetry.
 *
 * Race safety is generation-based: every {@link MobileWeatherQueryStore.request} or
 * {@link MobileWeatherQueryStore.retry} call bumps an internal generation counter *before* aborting
 * the previous in-flight request, so a stale completion (a late success, a late `apiError`/
 * `clientError`, or an out-of-contract rejection) is detected by generation mismatch and dropped —
 * it can never overwrite a newer terminal state. The generation is also rechecked *after* the
 * `LOADING` publish (which can run a listener synchronously) and before the client is ever called,
 * so a listener that reentrantly resets or starts a different request during that notification never
 * causes a stale `fetchWeather` call. `WeatherRequestV1` is retained internally only for
 * {@link MobileWeatherQueryStore.retry} and is never exposed on the snapshot or in an error.
 *
 * A `SUCCESS` result is published only once the response's `data.location` exactly matches the
 * requested `WeatherRequestV1.location` on every shared field (see {@link locationsCorrelate}); a
 * mismatch — a stale/misrouted response — is mapped to `ERROR`/`INVALID_RESPONSE` without a retry
 * and without exposing either location's raw value.
 */

import type {
  WeatherLocation,
  WeatherRequestV1,
  WeatherSuccessResponseV1,
} from '@life-weather/contracts';

import type {
  WeatherApiClient,
  WeatherApiClientErrorKind,
} from '../weather-api';

/** A stable, machine-readable, non-revealing classification of a failed weather query. */
export type MobileWeatherQueryErrorPresentation =
  | 'CONFIGURATION'
  | 'NETWORK'
  | 'API'
  | 'INVALID_RESPONSE';

/**
 * The published query snapshot. Carries no raw error, URL, API message, `requestId`, coordinates,
 * or grid — `ERROR` carries only the fixed {@link MobileWeatherQueryErrorPresentation}.
 */
export type MobileWeatherQuerySnapshot =
  | { readonly status: 'IDLE' }
  | { readonly status: 'LOADING'; readonly locationId: string }
  | {
      readonly status: 'SUCCESS';
      readonly locationId: string;
      readonly data: WeatherSuccessResponseV1;
    }
  | {
      readonly status: 'ERROR';
      readonly locationId: string;
      readonly presentation: MobileWeatherQueryErrorPresentation;
    };

/** Collaborators injected into {@link createMobileWeatherQueryStore}. */
export interface MobileWeatherQueryStoreDependencies {
  readonly client: WeatherApiClient;
}

/** The store's public surface. */
export interface MobileWeatherQueryStore {
  /** The cached snapshot. Returns the exact same object reference until a semantic transition. */
  getSnapshot(): MobileWeatherQuerySnapshot;

  /**
   * Register a listener called only on a semantic transition (never on registration). Returns an
   * idempotent unsubscribe function.
   */
  subscribe(listener: () => void): () => void;

  /**
   * Start a query for the already-built `request`, whose `request.location.id` is the query's
   * identity. A no-op when the current snapshot is `LOADING`/`SUCCESS`/`ERROR` for the *same*
   * `request.location.id`; supersedes (aborts) an in-flight request for a *different* one.
   */
  request(request: WeatherRequestV1): void;

  /**
   * Retry the request that produced the current `ERROR`, using the internally retained
   * `WeatherRequestV1`. A no-op outside `ERROR`. No timer, backoff, or automatic retry.
   */
  retry(): void;

  /**
   * Invalidate and abort any in-flight request, discard the retained retry context, and publish
   * `IDLE`. A semantic no-op when already `IDLE` with no active request.
   */
  reset(): void;
}

const IDLE_SNAPSHOT: MobileWeatherQuerySnapshot = Object.freeze({ status: 'IDLE' });

/**
 * Exact equality on every shared {@link WeatherLocation} field between the location that was
 * requested and the location a `SUCCESS` response describes. Field-by-field on purpose — never
 * `JSON.stringify` or a spread-based comparison — so key order and incidental extra properties
 * (there are none on this shared, `.strict()`-validated shape) can never mask a real mismatch.
 */
function locationsCorrelate(requested: WeatherLocation, responded: WeatherLocation): boolean {
  return (
    requested.id === responded.id &&
    requested.displayName === responded.displayName &&
    requested.countryCode === responded.countryCode &&
    requested.adminArea1 === responded.adminArea1 &&
    requested.adminArea2 === responded.adminArea2 &&
    requested.adminArea3 === responded.adminArea3 &&
    requested.latitude === responded.latitude &&
    requested.longitude === responded.longitude &&
    requested.timezone === responded.timezone
  );
}

/** Value equality — never a reference comparison, since every non-`IDLE` variant is a fresh object. */
function snapshotsEqual(
  a: MobileWeatherQuerySnapshot,
  b: MobileWeatherQuerySnapshot,
): boolean {
  if (a.status !== b.status) {
    return false;
  }
  switch (a.status) {
    case 'IDLE':
      return true;
    case 'LOADING':
      return b.status === 'LOADING' && a.locationId === b.locationId;
    case 'SUCCESS':
      return b.status === 'SUCCESS' && a.locationId === b.locationId && a.data === b.data;
    case 'ERROR':
      return (
        b.status === 'ERROR' &&
        a.locationId === b.locationId &&
        a.presentation === b.presentation
      );
  }
}

/**
 * Build a {@link MobileWeatherQueryStore} over an injected {@link WeatherApiClient}.
 *
 * Construction has no side effects — no fetch, no timer.
 */
export function createMobileWeatherQueryStore(
  deps: MobileWeatherQueryStoreDependencies,
): MobileWeatherQueryStore {
  const { client } = deps;

  let cachedSnapshot: MobileWeatherQuerySnapshot = IDLE_SNAPSHOT;
  // Bumped before every new request/retry/reset. A completion whose captured generation no longer
  // matches this counter is stale and is dropped without touching any store state.
  let generation = 0;
  let activeController: AbortController | null = null;
  // Retained only so `retry()` can restart the exact same query; never exposed on the snapshot.
  // `request.location.id` (derived, never stored separately) is the query's sole identity.
  let lastRequest: WeatherRequestV1 | null = null;
  const listeners = new Set<() => void>();

  function notifyListeners(): void {
    // Iterate a snapshot copy: a listener may unsubscribe or start a reentrant request/retry/reset
    // during notification, and neither may disturb this iteration or the live `listeners` Set.
    for (const listener of Array.from(listeners)) {
      try {
        listener();
      } catch {
        // Isolated intentionally: one listener's throw must not affect the others or the query
        // lifecycle, and is never stored, exposed, or logged.
      }
    }
  }

  function publish(next: MobileWeatherQuerySnapshot): void {
    if (snapshotsEqual(cachedSnapshot, next)) {
      return;
    }
    cachedSnapshot = Object.freeze(next);
    notifyListeners();
  }

  /**
   * An `aborted` clientError for the *current* generation is not a user-facing failure — it means
   * this request was cancelled outside the normal supersede/reset paths (both of which already bump
   * the generation, so a supersede/reset's own abort surfaces here as a *stale* generation instead).
   * Publish `IDLE` rather than leaving the snapshot stuck at `LOADING` or surfacing a spurious error.
   */
  function settleAborted(): void {
    lastRequest = null;
    publish(IDLE_SNAPSHOT);
  }

  function settleClientError(locationId: string, kind: WeatherApiClientErrorKind): void {
    switch (kind) {
      case 'invalidClientConfiguration':
        publish({ status: 'ERROR', locationId, presentation: 'CONFIGURATION' });
        return;
      case 'networkError':
        publish({ status: 'ERROR', locationId, presentation: 'NETWORK' });
        return;
      case 'aborted':
        settleAborted();
        return;
      case 'invalidRequest':
      case 'nonJsonResponse':
      case 'malformedJson':
      case 'invalidEnvelope':
      case 'unsupportedContractVersion':
      case 'invalidResponse':
        publish({ status: 'ERROR', locationId, presentation: 'INVALID_RESPONSE' });
    }
  }

  /**
   * Start (or restart) a query. Supersede ordering: bump the generation *before* touching the
   * previous controller, install the new controller/context, publish `LOADING`, *then* abort the
   * previous controller — so an immediate synchronous settlement from that abort can never land
   * before the new `LOADING` is visible, and is dropped anyway by the generation guard below.
   *
   * The `LOADING` publish can run a subscribed listener synchronously, and that listener may
   * reentrantly call `reset()`/`request()`/`retry()` — each of which bumps the generation again. The
   * generation is rechecked immediately after the publish (and after aborting the now-previous
   * controller), *before* `client.fetchWeather` is ever called, so a reentrant reset/supersede during
   * that notification produces zero stale client calls for this generation instead of one whose
   * result is merely discarded on completion.
   */
  function beginRequest(weatherRequest: WeatherRequestV1): void {
    const locationId = weatherRequest.location.id;
    generation += 1;
    const myGeneration = generation;
    const previousController = activeController;

    const controller = new AbortController();
    activeController = controller;
    lastRequest = weatherRequest;

    publish({ status: 'LOADING', locationId });
    previousController?.abort();

    if (myGeneration !== generation) {
      return; // superseded or reset by a reentrant listener during the LOADING publish above
    }

    void client.fetchWeather(weatherRequest, { signal: controller.signal }).then(
      (result) => {
        if (myGeneration !== generation) {
          return; // stale: superseded or reset since this request began
        }
        activeController = null;
        switch (result.kind) {
          case 'success':
            if (!locationsCorrelate(weatherRequest.location, result.data.data.location)) {
              publish({ status: 'ERROR', locationId, presentation: 'INVALID_RESPONSE' });
              return;
            }
            publish({ status: 'SUCCESS', locationId, data: result.data });
            return;
          case 'apiError':
            publish({ status: 'ERROR', locationId, presentation: 'API' });
            return;
          case 'clientError':
            settleClientError(locationId, result.error.kind);
        }
      },
      () => {
        // The client contract never rejects, but an out-of-contract rejection is classified safely
        // as NETWORK — its raw error is never read or retained — rather than left unhandled.
        if (myGeneration !== generation) {
          return;
        }
        activeController = null;
        publish({ status: 'ERROR', locationId, presentation: 'NETWORK' });
      },
    );
  }

  return {
    getSnapshot(): MobileWeatherQuerySnapshot {
      return cachedSnapshot;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    request(weatherRequest: WeatherRequestV1): void {
      const locationId = weatherRequest.location.id;
      const current = cachedSnapshot;
      if (current.status !== 'IDLE' && current.locationId === locationId) {
        return;
      }
      beginRequest(weatherRequest);
    },

    retry(): void {
      if (cachedSnapshot.status !== 'ERROR') {
        return;
      }
      if (lastRequest === null) {
        return;
      }
      beginRequest(lastRequest);
    },

    reset(): void {
      generation += 1;
      const controller = activeController;
      activeController = null;
      lastRequest = null;
      controller?.abort();
      publish(IDLE_SNAPSHOT);
    },
  };
}
