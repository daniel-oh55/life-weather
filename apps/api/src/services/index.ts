/**
 * Public surface of `apps/api`'s **application services** — the orchestration layer that sequences
 * the KMA provider boundary and the domain normalizers.
 *
 * The only service so far is the PR #7 KMA hourly-forecast orchestration: it calls the PR #5 HTTP
 * provider and the PR #6 hourly normalizer in order and reports a `PROVIDER`- or
 * `NORMALIZATION`-stage failure distinctly. Application services deliberately live **outside**
 * `providers/kma` (they are not part of the provider boundary) and are exported from here, never
 * from `providers/kma/index.ts`. See `docs/kma-hourly-service.md`.
 */

export {
  createKmaHourlyForecastService,
  type KmaHourlyForecastService,
  type KmaHourlyForecastServiceOptions,
  type KmaHourlyForecastServiceResult,
} from './kma-hourly-forecast';
