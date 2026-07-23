/**
 * The KMA (기상청) **live selected-source metadata resolver**: the production
 * {@link KmaSelectedHourlySourceMetadataResolver} the PR #24 location hourly-overview application
 * service injects. It consumes the actual KMA issuance identity the PR #25 fallback execution trace
 * already preserved and materializes the four provenance facts the PR #23 assembler needs
 * ({@link KmaHourlySourceMetadataInput}: `sourceId`/`issuedAt`/`fetchedAt`/`retrievalMode`).
 *
 * ### What it decides
 *
 * Given a PR #22 **selected** selection arm (narrowed to `selected: true`) plus the caller's `product`:
 *
 * - **PRIMARY selected** → the actual `execution.primaryIssuance` identity is used.
 * - **PREVIOUS selected** → the actual `execution.previousIssuance` identity is used (only present on a
 *   fallback-attempted trace).
 * - `issuedAt` is that issuance's provider-native `baseDate`/`baseTime`, expressed as a KST
 *   (`+09:00`) ISO instant with seconds — never converted through a `Date` and never recomputed from a
 *   clock, request plan, or base-time selector.
 * - `sourceId` is a fixed, per-product, app-internal identifier that encodes **neither** the individual
 *   issuance, the `PRIMARY`/`PREVIOUS` distinction, `fallbackUsed`, nor the location — the logical
 *   source is `sourceId`, the individual issuance is `issuedAt`.
 * - `retrievalMode` is fixed `'LIVE'` — this resolver is the live KMA provider pipeline's resolver and
 *   never returns `'CACHE'`/`'UNKNOWN'`.
 * - `fetchedAt` is the server time at which this resolver **materialized** the selected source's
 *   metadata, read from the injected clock **exactly once** per valid resolver call.
 *
 * ### `fetchedAt` semantics — resolver materialization time, not exact transport time
 *
 * `fetchedAt` here means "the server time at which fallback execution and source selection had already
 * completed and this resolver materialized the selected source's metadata". It is deliberately **not**
 * the HTTP request-dispatch time, the response-header-received time, the body-read-start time, or the
 * exact provider transport-completion timestamp. The PR #25 execution trace carries no per-attempt
 * transport timestamp, so the resolver-call instant is the honest, available approximation. A future
 * cache layer will **not** reuse this live resolver: it must preserve the stored upstream `fetchedAt`
 * and report `retrievalMode: 'CACHE'`, never overwriting the upstream `fetchedAt` with the cache-read
 * instant. No cache is implemented in this PR.
 *
 * ### Product correlation
 *
 * Before reading the clock, the resolver asserts `input.product === selectedIssuance.product`, so a
 * caller `product`, the actual request-plan `product` the trace recorded, and the `sourceId` mapping
 * cannot drift apart. A mismatch is a static {@link RangeError} thrown **before** the clock is read.
 * The `location` is never used to build source metadata (no per-location `sourceId`, no re-validation,
 * no mutation) — PR #24 already validated and forwarded a parsed `WeatherLocation`.
 *
 * ### Defensive identity validation, static errors
 *
 * The public {@link convertKmaForecastIssuanceToIssuedAt} converter and the resolver both defend
 * against a runtime value that bypassed the TypeScript types, guarding each nesting boundary as a
 * non-null object **before** any property is dereferenced. A null/non-object resolver input, a
 * null/non-object/non-selected/unknown-source selection, a null/non-object execution, a `PREVIOUS`
 * source on a no-fallback execution, a null/non-object or structurally-invalid selected issuance
 * (missing/non-object, unsupported product, malformed `baseDate`/`baseTime`), a product mismatch, or an
 * invalid clock value all fail with a **static** {@link RangeError} — never a native property-access
 * `TypeError`, and the original malformed value is never serialized into the message. Validity of a
 * structurally-parseable candidate instant is delegated to the contracts public
 * `isoDateTime` schema (which itself rejects impossible calendar/clock values such as a non-leap
 * `20260229`, month `13`, day `00`, hour `24`, or minute `60`); the resolver never re-validates the
 * official KMA base-time schedule (a structurally valid non-canonical `0615` still converts) — schedule
 * canonicality belongs to the weather-core selector, not this converter.
 *
 * ### Error boundary
 *
 * A direct call to {@link convertKmaForecastIssuanceToIssuedAt} or a resolver produced by
 * {@link createKmaLiveSelectedHourlySourceMetadataResolver} is **synchronous**: every validation
 * failure and a throwing injected clock propagate synchronously as the **same** error reference (no
 * broad `try`/`catch`, wrapping, result union, logging, fallback metadata, or partial metadata). When
 * PR #24 invokes the resolver inside its facade-Promise `.then` handler, that synchronous throw becomes
 * the returned Promise's rejection with the same error reference. Every invalid **input** fails
 * **before** the clock is read (clock read exactly zero times). An invalid **value returned by the
 * clock** is different: it is rejected **after** exactly one clock read, because the value has to be read
 * before it can be judged; a clock that itself throws likewise propagates its error after one read.
 *
 * ### Purity, immutability, freshness
 *
 * Construction reads no clock/environment/network, builds no `Date`, calls no selector, and holds no
 * state or cache — the factory merely closes over the clock. The resolver mutates nothing (input,
 * location, selection, execution, issuance, selected result, clock, and hourly data are all left
 * untouched and work when deeply frozen), and reads the selected issuance without cloning it. It
 * returns a **fresh** metadata object every call — a different wrapper reference even for identical
 * input and clock value — and never embeds the issuance object reference in its output.
 *
 * ### Boundary — what it is not
 *
 * It performs **no** provider call, request/request-plan factory call, base-time selector call, PR #22
 * selection re-computation, PR #23 assembly, composition wiring, HTTP route, or cache. It reads no
 * `process.env`, opens no `fetch`/`AbortController`, and imports no external timezone/date library or
 * new dependency. `provider`/`sections`/`observedAt` remain the PR #23 assembler's to fix. See
 * `docs/kma-selected-hourly-source-metadata.md`.
 */

import { isoDateTime, type SourceMetadata } from '@life-weather/contracts';
import { KmaForecastProduct } from '@life-weather/weather-core';

import type { KmaForecastIssuanceIdentity } from './kma-forecast-issuance-identity';
import type { KmaSelectedHourlySourceMetadataResolver } from './kma-location-hourly-overview';

/**
 * The injected clock the resolver reads to stamp `fetchedAt`. Structurally identical to the
 * `KmaForecastRequestClock` the request factories use (`nowEpochMilliseconds()` → integer epoch
 * milliseconds), but kept a distinct type so the seam is named for its resolver-materialization role.
 * It is read **exactly once** per valid resolver call and **zero** times at construction or on any
 * invalid input.
 */
export interface KmaSelectedHourlySourceMetadataClock {
  readonly nowEpochMilliseconds: () => number;
}

/** The fixed app-internal `sourceId` for a KMA 단기예보 (`getVilageFcst`) hourly source. */
const SHORT_FORECAST_SOURCE_ID = 'kma-short-forecast-hourly';

/** The fixed app-internal `sourceId` for a KMA 초단기예보 (`getUltraSrtFcst`) hourly source. */
const ULTRA_SHORT_FORECAST_SOURCE_ID = 'kma-ultra-short-forecast-hourly';

/** Exactly `YYYYMMDD` — eight digits, split into year/month/day groups. */
const BASE_DATE_PATTERN = /^(\d{4})(\d{2})(\d{2})$/;

/** Exactly `HHmm` — four digits, split into hour/minute groups. */
const BASE_TIME_PATTERN = /^(\d{2})(\d{2})$/;

/** Static message for a malformed or unsupported issuance identity (converter). */
const INVALID_ISSUANCE_MESSAGE = 'Invalid KMA forecast issuance identity';

/** Static message for a non-selected / unknown-source selection handed to the resolver. */
const INVALID_SELECTION_MESSAGE = 'Invalid selected KMA hourly source selection';

/** Static message for a `PREVIOUS` selection whose execution never attempted fallback. */
const PREVIOUS_REQUIRES_FALLBACK_MESSAGE =
  'Selected PREVIOUS source requires a fallback execution';

/** Static message for a caller `product` that disagrees with the selected issuance product. */
const PRODUCT_MISMATCH_MESSAGE =
  'Selected KMA issuance product does not match resolver input';

/** Static message for an unsupported product reaching the fixed `sourceId` mapping. */
const UNSUPPORTED_PRODUCT_MESSAGE = 'Unsupported KMA forecast product';

/** Static message for a clock value that cannot become a valid ISO `fetchedAt`. */
const INVALID_CLOCK_MESSAGE = 'Invalid KMA source metadata clock value';

/**
 * A non-null, non-array object guard. Accepts an `unknown` so a runtime value that bypassed the
 * TypeScript types can be structurally validated at every nesting boundary **before** any property is
 * dereferenced — a malformed nested value therefore fails with a **static** {@link RangeError}, never a
 * native property-access `TypeError`. It accepts a plain, frozen, or `Object.create(null)` record and
 * rejects `null`/`undefined`, a primitive (`string`/`number`/`boolean`/`bigint`/`symbol`), a
 * `function`, and an array. Module-local; never exported.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A runtime type guard for the two supported {@link KmaForecastProduct} members. Accepts an `unknown`
 * so the public converter can validate a value that bypassed the TypeScript types.
 */
function isSupportedKmaForecastProduct(
  value: unknown,
): value is KmaForecastProduct {
  return (
    value === KmaForecastProduct.SHORT_FORECAST ||
    value === KmaForecastProduct.ULTRA_SHORT_FORECAST
  );
}

/**
 * Convert one {@link KmaForecastIssuanceIdentity} into its `issuedAt` ISO instant.
 *
 * The provider-native `baseDate` (`YYYYMMDD`) and `baseTime` (`HHmm`) are assembled — by explicit
 * string composition, never a `Date` — into a KST (`+09:00`) instant with seconds and no fractional
 * seconds (`YYYY-MM-DDTHH:mm:00+09:00`), preserving the KMA provider-native issuance-time meaning. The
 * candidate is then validated with the contracts public `isoDateTime` schema, which rejects an
 * impossible calendar/clock value (a non-leap `20260229`, month `13`, day `00`, hour `24`, minute `60`,
 * …); on success the parsed string is returned, otherwise a **static** {@link RangeError} is thrown.
 *
 * It defends against a runtime value that bypassed the types: a non-object issuance, an unsupported
 * product, or a structurally-invalid `baseDate`/`baseTime` (wrong length / non-digit) also throws the
 * static {@link RangeError} — the original malformed value is never included in the message. It reads
 * no clock, builds no `Date`, uses no `Date.parse`, depends on no system time zone or locale, calls no
 * schedule selector, and applies no coercion or default: `SHORT_FORECAST` and `ULTRA_SHORT_FORECAST`
 * with the same `baseDate`/`baseTime` produce the same `issuedAt`, and a structurally valid but
 * non-canonical schedule time (e.g. `0615`) still converts — schedule canonicality is the weather-core
 * selector's responsibility, not this converter's.
 */
export function convertKmaForecastIssuanceToIssuedAt(
  issuance: KmaForecastIssuanceIdentity,
): NonNullable<SourceMetadata['issuedAt']> {
  // Defensive: this converter is public and may be handed a value that bypassed the type. Read fields
  // through an `unknown` view so the runtime shape — not the declared type — drives validation.
  const candidate: unknown = issuance;
  if (typeof candidate !== 'object' || candidate === null) {
    throw new RangeError(INVALID_ISSUANCE_MESSAGE);
  }

  const { product, baseDate, baseTime } = candidate as {
    readonly product: unknown;
    readonly baseDate: unknown;
    readonly baseTime: unknown;
  };

  if (!isSupportedKmaForecastProduct(product)) {
    throw new RangeError(INVALID_ISSUANCE_MESSAGE);
  }

  if (typeof baseDate !== 'string' || typeof baseTime !== 'string') {
    throw new RangeError(INVALID_ISSUANCE_MESSAGE);
  }

  const dateMatch = BASE_DATE_PATTERN.exec(baseDate);
  const timeMatch = BASE_TIME_PATTERN.exec(baseTime);
  if (dateMatch === null || timeMatch === null) {
    throw new RangeError(INVALID_ISSUANCE_MESSAGE);
  }

  const [, year, month, day] = dateMatch;
  const [, hour, minute] = timeMatch;

  const isoCandidate = `${year}-${month}-${day}T${hour}:${minute}:00+09:00`;

  const parsed = isoDateTime.safeParse(isoCandidate);
  if (!parsed.success) {
    throw new RangeError(INVALID_ISSUANCE_MESSAGE);
  }

  return parsed.data;
}

/**
 * Resolve the {@link KmaForecastIssuanceIdentity} the selection points at, defending both the structural
 * shape of a runtime value that bypassed the TypeScript types and the correlation between the selected
 * `source` and the execution arm — it never re-runs the PR #22 selection policy, re-checks hourly-data
 * usability, inspects `resultCode`/error kind, or re-checks fallback eligibility.
 *
 * The input is read as `unknown` and each nesting boundary is guarded with {@link isRecord} **before**
 * any property is dereferenced, so a malformed nested value throws a **static** {@link RangeError}
 * instead of a native property-access `TypeError`: a non-record selection, a non-`true` `selected`, a
 * `source` that is neither `'PRIMARY'` nor `'PREVIOUS'`, and a non-record `execution` each throw the
 * static malformed-selection message; a `'PREVIOUS'` source whose execution did not attempt fallback
 * throws the static no-fallback message; and a missing or non-record selected issuance throws the static
 * malformed-issuance message. On `'PRIMARY'` it returns the exact `execution.primaryIssuance` reference;
 * on a fallback-attempted `'PREVIOUS'` it returns the exact `execution.previousIssuance` reference —
 * never a clone, and the object is not mutated. Module-local; never exported.
 */
function getSelectedKmaForecastIssuance(
  selection: unknown,
): KmaForecastIssuanceIdentity {
  // 1. The selection must be a non-null, non-array object before any discriminant is read.
  if (!isRecord(selection)) {
    throw new RangeError(INVALID_SELECTION_MESSAGE);
  }

  // 2. Only a selected arm carries a usable source.
  if (selection.selected !== true) {
    throw new RangeError(INVALID_SELECTION_MESSAGE);
  }

  // 3. The source discriminant must be one of the two known arms.
  const { source, execution } = selection;
  if (source !== 'PRIMARY' && source !== 'PREVIOUS') {
    throw new RangeError(INVALID_SELECTION_MESSAGE);
  }

  // 4. The execution trace must be a non-null, non-array object before its issuance is read.
  if (!isRecord(execution)) {
    throw new RangeError(INVALID_SELECTION_MESSAGE);
  }

  if (source === 'PRIMARY') {
    // 5–7. PRIMARY reads the primary issuance; a missing/non-record value is a malformed issuance.
    const { primaryIssuance } = execution;
    if (!isRecord(primaryIssuance)) {
      throw new RangeError(INVALID_ISSUANCE_MESSAGE);
    }
    return primaryIssuance as unknown as KmaForecastIssuanceIdentity;
  }

  // PREVIOUS additionally requires a fallback-attempted execution before its previous issuance exists.
  if (execution.fallbackAttempted !== true) {
    throw new RangeError(PREVIOUS_REQUIRES_FALLBACK_MESSAGE);
  }
  const { previousIssuance } = execution;
  if (!isRecord(previousIssuance)) {
    throw new RangeError(INVALID_ISSUANCE_MESSAGE);
  }
  return previousIssuance as unknown as KmaForecastIssuanceIdentity;
}

/**
 * Map a supported {@link KmaForecastProduct} to its fixed app-internal hourly `sourceId`. An
 * unsupported product (a runtime value that bypassed the types) throws a **static** {@link RangeError}.
 * It uses a fixed `switch` — never an object spread or dynamic string assembly — and never encodes the
 * individual issuance, the `PRIMARY`/`PREVIOUS` distinction, `fallbackUsed`, or the location. Module-
 * local; never exported.
 */
function getKmaHourlySourceId(product: KmaForecastProduct): string {
  switch (product) {
    case KmaForecastProduct.SHORT_FORECAST:
      return SHORT_FORECAST_SOURCE_ID;
    case KmaForecastProduct.ULTRA_SHORT_FORECAST:
      return ULTRA_SHORT_FORECAST_SOURCE_ID;
    default:
      throw new RangeError(UNSUPPORTED_PRODUCT_MESSAGE);
  }
}

/**
 * Format an epoch-milliseconds value into the UTC `fetchedAt` ISO instant. The value must be a safe
 * integer that maps to a valid `Date`; `date.toISOString()` yields UTC `Z` with exactly three
 * fractional digits, which is confirmed with the contracts public `isoDateTime` schema. An unusable
 * value (`NaN`/`±Infinity`/fractional/unsafe integer/out-of-`Date`-range/ISO-contract-rejected) throws
 * a **static** {@link RangeError} — the raw value is never included in the message. This is the sole
 * place `new Date` is used; the `issuedAt` converter never touches `Date`. Module-local; never
 * exported.
 */
function formatKmaFetchedAt(epochMilliseconds: number): SourceMetadata['fetchedAt'] {
  if (!Number.isSafeInteger(epochMilliseconds)) {
    throw new RangeError(INVALID_CLOCK_MESSAGE);
  }

  const date = new Date(epochMilliseconds);
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError(INVALID_CLOCK_MESSAGE);
  }

  const parsed = isoDateTime.safeParse(date.toISOString());
  if (!parsed.success) {
    throw new RangeError(INVALID_CLOCK_MESSAGE);
  }

  return parsed.data;
}

/**
 * Create the live selected-source metadata resolver, bound to an injected
 * {@link KmaSelectedHourlySourceMetadataClock}.
 *
 * Construction is side-effect-free: it reads the clock zero times, touches no environment/network,
 * builds no `Date`, calls no selector, and holds no state or cache — it merely closes over the clock.
 *
 * Each resolver call runs a fixed sequence: (0) guard that the resolver input and its nested
 * `selection`/`execution`/selected-issuance are non-null objects (a malformed value throws a static
 * {@link RangeError}, never a native property-access `TypeError`), (1) validate the selected selection
 * structure, (2) resolve the selected issuance identity, (3) assert `input.product === issuance.product`,
 * (4) map the fixed `sourceId`, (5) convert the issuance to `issuedAt`, (6) read the injected clock
 * **exactly once**, (7) format `fetchedAt`, and (8) return a fresh metadata object. Because the clock is
 * read only at step 6, every invalid input (steps 0–5) fails **before** the clock is read; an invalid
 * *value returned by* the clock is caught at step 7, after that single read. A throwing clock and every
 * validation failure propagate synchronously as the same error reference. The returned object has
 * exactly the four sorted own keys `fetchedAt`/`issuedAt`/`retrievalMode`/`sourceId`, with
 * `retrievalMode` fixed `'LIVE'`, and embeds no issuance object reference.
 */
export function createKmaLiveSelectedHourlySourceMetadataResolver(
  clock: KmaSelectedHourlySourceMetadataClock,
): KmaSelectedHourlySourceMetadataResolver {
  return (input) => {
    // Step 0: guard the resolver input itself. Read it through an `unknown` view and confirm it is a
    // non-null, non-array object before `input.selection`/`input.product` are dereferenced, so a runtime
    // value that bypassed the type fails with a static RangeError — never a native property-access
    // TypeError — with the clock still read zero times.
    const candidate: unknown = input;
    if (!isRecord(candidate)) {
      throw new RangeError(INVALID_SELECTION_MESSAGE);
    }

    // Steps 1–2: validate the selected input structure and resolve the actual selected issuance.
    const issuance = getSelectedKmaForecastIssuance(candidate.selection);

    // Step 3: product correlation — caller product, request-plan product, and sourceId cannot drift.
    // Checked before the clock is read.
    if (candidate.product !== issuance.product) {
      throw new RangeError(PRODUCT_MISMATCH_MESSAGE);
    }

    // Steps 4–5: fixed per-product sourceId and the KST issuedAt — both before the clock is read.
    const sourceId = getKmaHourlySourceId(issuance.product);
    const issuedAt = convertKmaForecastIssuanceToIssuedAt(issuance);

    // Step 6: read the injected clock exactly once, only after every validation has passed. Step 7:
    // materialize fetchedAt from that single reading.
    const fetchedAt = formatKmaFetchedAt(clock.nowEpochMilliseconds());

    // Step 8: a fresh metadata object with exactly the four sorted own keys; retrievalMode fixed LIVE.
    return {
      fetchedAt,
      issuedAt,
      retrievalMode: 'LIVE',
      sourceId,
    };
  };
}
