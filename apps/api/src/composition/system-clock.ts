/**
 * The **production system clock adapter** for the KMA request factories.
 *
 * The PR #9 forecast request factory reads "now" only through an injected
 * {@link KmaForecastRequestClock}; it deliberately provides no default and never reads a wall clock
 * of its own. This adapter is the single production implementation of that injected port: its one
 * method returns the current instant as absolute epoch milliseconds via `Date.now()`.
 *
 * The PR #66 current-observation request factory's injected clock port
 * (`KmaCurrentObservationRequestClock`) is **structurally identical** — the same single
 * `nowEpochMilliseconds(): number` method — so the PR #69 current-observation composition
 * (`docs/kma-current-observation-production-composition.md`) reuses this exact adapter rather than
 * defining a separate current-only clock implementation. This file's implementation and function
 * signature are unchanged by that reuse; only this docblock records the structural compatibility.
 *
 * It is the **only** place in the composition layer that is allowed to read the system time. A
 * composition root itself never reads a clock — it merely selects this adapter (or a caller-injected
 * clock) and hands the reference to the relevant request factory. See
 * `docs/kma-production-composition.md`.
 *
 * Clock contract:
 *
 * - Building the adapter (`createKmaSystemClock()`) reads the system time **zero** times — it only
 *   allocates the object. No timer, no environment read, no I/O, no listener, no global mutation.
 * - Each `nowEpochMilliseconds()` call reads `Date.now()` **exactly once**, with **no** argument,
 *   and returns that value verbatim — no rounding, truncation, coercion, time-zone math, offset, or
 *   caching. A later call reads `Date.now()` again, so the value is always current.
 * - If `Date.now()` throws at runtime, the same error reference propagates unchanged (no wrapping).
 *
 * `Date.now()` is used deliberately: it is the plain UTC epoch-milliseconds source the selector
 * expects — not a monotonic or high-resolution timer, and with no intermediate object allocation.
 */

import type { KmaForecastRequestClock } from '../services/index.js';

/**
 * Create the production system clock. Pure construction: it reads no time, holds no state, and
 * closes over nothing — every instance is interchangeable and each call reads the live system time.
 */
export function createKmaSystemClock(): KmaForecastRequestClock {
  return {
    nowEpochMilliseconds() {
      return Date.now();
    },
  };
}
