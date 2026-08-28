/**
 * Derive the contracts {@link DailyForecast} list from an **already-normalized** KMA (기상청)
 * hourly forecast — the pure, deterministic domain policy that lets the existing hourly pipeline
 * populate `WeatherOverview.daily` without a second provider request.
 *
 * The public `daily` contract already existed; only its *producer* was missing. This module is that
 * producer, and its only input is the `HourlyForecast[]` the PR #6 normalizer already built from the
 * PR #22-selected KMA forecast issuance. It issues no request, opens no new provider surface, and
 * exposes no provider-native value (`TMN`/`TMX`/일출·일몰 are never read — they are not in the input).
 *
 * ### Completeness policy — a whole KST calendar day, or nothing
 *
 * A partial day would publish a misleading min/max: the remaining hours of the current day, or a
 * truncated tail day, cannot describe the day's real extremes. So a calendar date is **eligible only
 * when the input carries exactly one usable hourly entry for every clock hour `00:00`–`23:00` of that
 * same KST date** — 24 distinct hours, no gaps, no duplicates. An ineligible date is **omitted
 * entirely**; nothing is interpolated, extrapolated, or fabricated. In practice this excludes the
 * partially-remaining current day, the truncated tail of the 단기예보 horizon, and any 초단기예보
 * horizon (which is far too short to contain a full day).
 *
 * Each date is judged independently: an incomplete date never removes an eligible one, and no
 * incomplete date makes this function throw.
 *
 * ### Values — copied from the 24 hours, never invented
 *
 * For an eligible date:
 *
 * - `minimumTemperatureCelsius` / `maximumTemperatureCelsius` — the min / max of all **24**
 *   `temperatureCelsius` values. Never the current observation, never `feelsLikeCelsius`, never an
 *   interpolated value.
 * - `morning` — the **09:00** entry's `condition` + `precipitationProbabilityPercent`, verbatim.
 * - `afternoon` — the **15:00** entry's `condition` + `precipitationProbabilityPercent`, verbatim.
 * - `overall`, `sunriseAt`, `sunsetAt` — always `null`. This PR has no all-day aggregate policy and no
 *   sunrise/sunset source, and inventing either would be a fabricated value.
 *
 * A representative-hour policy is deliberate: no "worst condition" aggregation and no averaged
 * probability, so a `0` probability stays `0` and a `null` probability stays `null` — a confirmed
 * zero and an unsupplied value are never collapsed into each other.
 *
 * ### KST identity — deterministic, host-timezone independent
 *
 * The KMA normalizer emits `forecastAt` as a fixed `+09:00` KST instant, and the contracts
 * `isoDateTime` schema also admits a `Z` (or any other offset) form. Both are handled the same way:
 * the timestamp is parsed by an explicit pattern, converted to an absolute instant with `Date.UTC`,
 * shifted to the fixed KST offset, and read back through `getUTC*` accessors only. `Date.now()`,
 * `new Date()` with no argument, the host time zone, `Intl`, and locale are never touched, so the
 * result is identical on every machine. KST has no DST, so a single fixed `+09:00` offset is exact.
 *
 * A timestamp that resolves to a valid instant but does not land exactly on a KST clock hour
 * (`HH:00:00.000`) cannot be a clean hourly slot, so it **poisons** its own KST date, which is then
 * omitted. A timestamp that cannot be resolved to an instant at all has no attributable date, so it
 * conservatively suppresses the whole derivation rather than letting an unknown entry silently
 * complete some other day. Both are defensive: the caller validates `hourly` against the contracts
 * schema before this function runs.
 *
 * ### Purity
 *
 * Synchronous and pure: no `Promise`, no `fetch`/provider/service call, no clock, no `process.env`,
 * no `AbortSignal`, no logging, no cache/singleton/global state. It mutates neither the input array
 * nor any input item, and allocates a fresh, `dailyForecast`-validated output every call. Given the
 * same entries in **any** order it returns the same list, sorted by `date` ascending.
 */

import {
  dailyForecast,
  type DailyForecast,
  type ForecastPeriod,
  type HourlyForecast,
} from '@life-weather/contracts';

/**
 * The output validator: the contracts public `dailyForecast` element schema composed into an array.
 * Contract constraints (the `isoDate` format, the temperature bounds, the min ≤ max invariant) are
 * never restated here — the schema is the single source of truth, and no `zod` import is added.
 *
 * Module-local and never exported; it parses nothing at import time.
 */
const dailyForecasts = dailyForecast.array();

/** Fixed KST offset in minutes. KST has no DST, so this is exact for every instant. */
const KST_OFFSET_MINUTES = 9 * 60;

const MILLISECONDS_PER_MINUTE = 60_000;

/** Every clock hour a complete KST day must carry, `00`–`23`. */
const HOURS_PER_DAY = 24;

/** The representative KST hour published as `morning`. */
const MORNING_HOUR = 9;

/** The representative KST hour published as `afternoon`. */
const AFTERNOON_HOUR = 15;

/**
 * The contracts `isoDateTime` shape: seconds precision, optional exactly-3-digit milliseconds, and a
 * required `Z` or `±HH:MM` designator. Matching explicitly (rather than handing the string to `Date`)
 * keeps parsing independent of engine-specific lenient date parsing and of the host locale.
 */
const ISO_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{3})?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/** An entry that lands exactly on a KST clock hour — the only kind that can fill an hour slot. */
interface KstClockHour {
  readonly kind: 'CLOCK_HOUR';
  /** The KST calendar date, `YYYY-MM-DD`. */
  readonly date: string;
  /** The KST clock hour, `0`–`23`. */
  readonly hour: number;
}

/**
 * An entry that resolves to a real instant on a known KST date but not to an exact clock hour. Its
 * date is known, so it poisons exactly that date and nothing else.
 */
interface KstOffHour {
  readonly kind: 'OFF_HOUR';
  readonly date: string;
}

/** `null` means the timestamp could not be resolved to an instant at all — no attributable date. */
type KstResolution = KstClockHour | KstOffHour | null;

function padTwo(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

function padFour(value: number): string {
  return `${value}`.padStart(4, '0');
}

/**
 * Resolve one `forecastAt` to its KST calendar/hour identity.
 *
 * The literal date/time fields are converted to an absolute instant with `Date.UTC` (a static,
 * host-timezone-independent computation), the string's own offset is removed, and the fixed KST
 * offset is applied. The instant is then read back with `getUTC*` accessors only — never `getHours`,
 * `getDate`, or any other host-local accessor — so the derived date/hour is the KST wall clock on
 * every machine.
 *
 * A literal calendar date that `Date.UTC` silently rolls over (`2026-02-30`, `…T24:00:00`) fails the
 * round-trip check and resolves to `null`.
 */
function resolveKstClockHour(forecastAt: string): KstResolution {
  const match = ISO_DATE_TIME_PATTERN.exec(forecastAt);
  if (match === null) {
    return null;
  }

  const [
    ,
    yearPart,
    monthPart,
    dayPart,
    hourPart,
    minutePart,
    secondPart,
    offsetSign,
    offsetHourPart,
    offsetMinutePart,
  ] = match;

  const year = Number(yearPart);
  const month = Number(monthPart);
  const day = Number(dayPart);

  const literalUtcMilliseconds = Date.UTC(
    year,
    month - 1,
    day,
    Number(hourPart),
    Number(minutePart),
    Number(secondPart),
  );

  // Reject a literal the calendar does not actually contain: `Date.UTC` rolls `2026-02-30` over to
  // March and `24:00:00` over to the next day, so compare the round-trip date back to the literal.
  const literal = new Date(literalUtcMilliseconds);
  if (
    literal.getUTCFullYear() !== year ||
    literal.getUTCMonth() !== month - 1 ||
    literal.getUTCDate() !== day
  ) {
    return null;
  }

  const offsetMinutes =
    offsetSign === undefined
      ? 0
      : (offsetSign === '-' ? -1 : 1) *
        (Number(offsetHourPart) * 60 + Number(offsetMinutePart));

  const kst = new Date(
    literalUtcMilliseconds +
      (KST_OFFSET_MINUTES - offsetMinutes) * MILLISECONDS_PER_MINUTE,
  );

  const date = `${padFour(kst.getUTCFullYear())}-${padTwo(
    kst.getUTCMonth() + 1,
  )}-${padTwo(kst.getUTCDate())}`;

  if (
    kst.getUTCMinutes() !== 0 ||
    kst.getUTCSeconds() !== 0 ||
    kst.getUTCMilliseconds() !== 0
  ) {
    return { kind: 'OFF_HOUR', date };
  }

  return { kind: 'CLOCK_HOUR', date, hour: kst.getUTCHours() };
}

/** Copy one hourly entry's condition + precipitation probability into a {@link ForecastPeriod}. */
function toForecastPeriod(hour: HourlyForecast): ForecastPeriod {
  return {
    condition: hour.condition,
    // A confirmed 0 and an unsupplied null are both preserved exactly as the normalizer produced them.
    precipitationProbabilityPercent: hour.precipitationProbabilityPercent,
  };
}

/**
 * Build one eligible day from its complete 24-hour slot map. The caller has already established that
 * `hours` holds every clock hour `0`–`23` exactly once, so `MORNING_HOUR` and `AFTERNOON_HOUR` are
 * always present.
 */
function buildDay(date: string, hours: ReadonlyMap<number, HourlyForecast>): DailyForecast {
  let minimumTemperatureCelsius = Number.POSITIVE_INFINITY;
  let maximumTemperatureCelsius = Number.NEGATIVE_INFINITY;

  for (const hour of hours.values()) {
    if (hour.temperatureCelsius < minimumTemperatureCelsius) {
      minimumTemperatureCelsius = hour.temperatureCelsius;
    }
    if (hour.temperatureCelsius > maximumTemperatureCelsius) {
      maximumTemperatureCelsius = hour.temperatureCelsius;
    }
  }

  const morning = hours.get(MORNING_HOUR);
  const afternoon = hours.get(AFTERNOON_HOUR);

  return {
    date,
    minimumTemperatureCelsius,
    maximumTemperatureCelsius,
    // No all-day aggregate policy and no sunrise/sunset source in this pipeline — never invented.
    overall: null,
    morning: morning === undefined ? null : toForecastPeriod(morning),
    afternoon: afternoon === undefined ? null : toForecastPeriod(afternoon),
    sunriseAt: null,
    sunsetAt: null,
  };
}

/**
 * Derive `DailyForecast[]` from an already-normalized KMA hourly forecast.
 *
 * Returns one entry per KST calendar date the input covers **completely** (all 24 clock hours, each
 * exactly once), sorted by `date` ascending; every incomplete, duplicated, or off-hour date is
 * omitted. Each entry is validated with the contracts `dailyForecast` schema, so a value that could
 * not satisfy the public contract surfaces as a synchronous Zod error instead of a wrong payload.
 *
 * Pure, synchronous, clock-free and order-independent; the input array and its items are never
 * mutated. An empty input, or one with no complete day, returns an empty array.
 */
export function deriveKmaDailyForecastFromHourly(
  hourly: readonly HourlyForecast[],
): readonly DailyForecast[] {
  const hoursByDate = new Map<string, Map<number, HourlyForecast>>();
  /** Dates disqualified by a duplicate hour or an entry that is not on an exact clock hour. */
  const disqualifiedDates = new Set<string>();

  for (const entry of hourly) {
    const resolved = resolveKstClockHour(entry.forecastAt);

    if (resolved === null) {
      // The entry belongs to no determinable KST date, so no single date can absorb the doubt.
      // Publish nothing rather than let an unattributable entry leave another day looking complete.
      return [];
    }

    if (resolved.kind === 'OFF_HOUR') {
      disqualifiedDates.add(resolved.date);
      continue;
    }

    let hours = hoursByDate.get(resolved.date);
    if (hours === undefined) {
      hours = new Map<number, HourlyForecast>();
      hoursByDate.set(resolved.date, hours);
    }

    if (hours.has(resolved.hour)) {
      // The same date/hour occurred twice; the day is ambiguous, so it is not complete.
      disqualifiedDates.add(resolved.date);
      continue;
    }

    hours.set(resolved.hour, entry);
  }

  const days: DailyForecast[] = [];

  for (const [date, hours] of hoursByDate) {
    // Only clock hours 0–23 are ever inserted and duplicates disqualify the date, so a size of 24 is
    // exactly "every clock hour present once".
    if (hours.size !== HOURS_PER_DAY || disqualifiedDates.has(date)) {
      continue;
    }
    days.push(buildDay(date, hours));
  }

  // `YYYY-MM-DD` sorts chronologically under plain code-unit comparison — no locale collation.
  days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return dailyForecasts.parse(days);
}
