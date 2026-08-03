/**
 * Provider-neutral **weather query store**.
 *
 * Wraps an injected {@link WeatherApiClient} with the small `IDLE` / `LOADING` / `SUCCESS` / `ERROR`
 * state machine a screen needs to show the weather for one selected saved location: a stable,
 * deep-frozen cached snapshot, a subscribe/notify contract a React `useSyncExternalStore` consumer
 * can read, and a single active request at a time.
 *
 * This module owns no saved-location, persistence, environment, or React concern — it only ever
 * sees a `locationId` and an already-built `WeatherRequestV1`. It never imports React, Expo,
 * `process.env`, the production client singleton, the saved-location store, AsyncStorage, or
 * logging/telemetry.
 *
 * Race safety is generation-based: every {@link MobileWeatherQueryStore.request} or
 * {@link MobileWeatherQueryStore.retry} call bumps an internal generation counter *before* aborting
 * the previous in-flight request, so a stale completion (a late success, a late `apiError`/
 * `clientError`, or an out-of-contract rejection) is detected by generation mismatch and dropped —
 * it can never overwrite a newer terminal state. `WeatherRequestV1` is retained internally only for
 * {@link MobileWeatherQueryStore.retry} and is never exposed on the snapshot or in an error.
 */

import type {
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
   * Start a query for `locationId` using the already-built `request`. A no-op when the current
   * snapshot is `LOADING`/`SUCCESS`/`ERROR` for the *same* `locationId`; supersedes (aborts) an
   * in-flight request for a *different* `locationId`.
   */
  request(locationId: string, request: WeatherRequestV1): void;

  /**
   * Retry the request that produced the current `ERROR`, using the internally retained
   * `locationId`/`WeatherRequestV1`. A no-op outside `ERROR`. No timer, backoff, or automatic retry.
   */
  retry(): void;

  /**
   * Invalidate and abort any in-flight request, discard the retained retry context, and publish
   * `IDLE`. A semantic no-op when already `IDLE` with no active request.
   */
  reset(): void;
}

const IDLE_SNAPSHOT: MobileWeatherQuerySnapshot = Object.freeze({ status: 'IDLE' });

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
  let lastLocationId: string | null = null;
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
    lastLocationId = null;
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
   */
  function beginRequest(locationId: string, weatherRequest: WeatherRequestV1): void {
    generation += 1;
    const myGeneration = generation;
    const previousController = activeController;

    const controller = new AbortController();
    activeController = controller;
    lastLocationId = locationId;
    lastRequest = weatherRequest;

    publish({ status: 'LOADING', locationId });
    previousController?.abort();

    void client.fetchWeather(weatherRequest, { signal: controller.signal }).then(
      (result) => {
        if (myGeneration !== generation) {
          return; // stale: superseded or reset since this request began
        }
        activeController = null;
        switch (result.kind) {
          case 'success':
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

    request(locationId: string, weatherRequest: WeatherRequestV1): void {
      const current = cachedSnapshot;
      if (current.status !== 'IDLE' && current.locationId === locationId) {
        return;
      }
      beginRequest(locationId, weatherRequest);
    },

    retry(): void {
      if (cachedSnapshot.status !== 'ERROR') {
        return;
      }
      if (lastLocationId === null || lastRequest === null) {
        return;
      }
      beginRequest(lastLocationId, lastRequest);
    },

    reset(): void {
      generation += 1;
      const controller = activeController;
      activeController = null;
      lastLocationId = null;
      lastRequest = null;
      controller?.abort();
      publish(IDLE_SNAPSHOT);
    },
  };
}
