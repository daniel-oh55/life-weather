/**
 * The **production system clock adapter** for the KMA request factory.
 *
 * The PR #9 request factory reads "now" only through an injected
 * {@link KmaForecastRequestClock}; it deliberately provides no default and never reads a wall clock
 * of its own. This adapter is the single production implementation of that injected port: its one
 * method returns the current instant as absolute epoch milliseconds via `Date.now()`.
 *
 * It is the **only** place in the composition layer that is allowed to read the system time. The
 * composition root itself never reads a clock — it merely selects this adapter (or a caller-injected
 * clock) and hands the reference to the request factory. See `docs/kma-production-composition.md`.
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

import type { KmaForecastRequestClock } from '../services';

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
