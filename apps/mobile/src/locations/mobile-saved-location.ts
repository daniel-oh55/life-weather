/**
 * Mobile-local saved-location model and its request boundary.
 *
 * A saved location is what the app persists on the device for one place a user tracks. It is the
 * shared {@link weatherLocation} **extended additively** with three device-local concerns —
 * `kmaGrid`, `isCurrent`, and `sortOrder` — that must never travel to the API. The shared schema
 * is reused (never re-declared) so the `WeatherLocation` field rules stay the single source of
 * truth; only the local-only fields are added here.
 *
 * The one network mapping, {@link createWeatherRequestFromSavedLocation}, validates untrusted
 * input and maps exactly the shared `WeatherLocation` fields into a `WeatherRequestV1`, dropping
 * every local-only / provider-native field. It never throws and never leaks the input.
 *
 * Out of scope for this module (later PRs): storage adapters, a multi-location collection,
 * add/delete/reorder, current-location uniqueness, location permission, GPS/geocoding, screen
 * wiring, and any real network call. Constructing or importing this module reads no environment,
 * touches no storage, and performs no I/O.
 */

import { z } from 'zod';

import { weatherLocation, weatherRequestV1, type WeatherRequestV1 } from '@life-weather/contracts';

/**
 * A non-negative integer: a finite whole number `>= 0`. `z.number()` already rejects `NaN`,
 * `Infinity`, and `-Infinity`; `.int()` rejects fractional values and `.min(0)` rejects negatives.
 * Used for the KMA grid coordinates and the sort order below — it carries no provider policy value
 * (no KMA grid maximum is encoded here), only the local shape constraint.
 */
const nonNegativeInteger = z.number().int().min(0);

/**
 * Device-local KMA grid metadata for a saved location.
 *
 * These `{ nx, ny }` grid coordinates are an **app-local lookup hint** — they are deliberately not
 * part of the shared contract and are never sent to the API (the server selects the KMA product
 * and grid itself; see `docs/contracts.md`). The object is strict, so any unknown key is rejected
 * rather than stripped. The exact KMA grid bounds and any weather-core grid policy are intentionally
 * **not** copied here; this is only the storage shape.
 */
export const mobileKmaGrid = z
  .object({
    nx: nonNegativeInteger,
    ny: nonNegativeInteger,
  })
  .strict();

export type MobileKmaGrid = z.infer<typeof mobileKmaGrid>;

/**
 * One saved location as persisted on the device.
 *
 * The shared {@link weatherLocation} extended with three **local-only** fields. Extending reuses
 * every shared field rule unchanged — the `adminArea1`/`2`/`3` fields stay required-and-nullable,
 * `id` is the app-issued opaque identifier (never a provider-native id), and so on. The result is
 * strict, so an unknown top-level key (including a leaked provider-native key such as `nx` / `ny`)
 * is rejected, not stripped.
 *
 * Local-only fields, all required (never optional):
 * - `kmaGrid` — required and nullable KMA grid hint; `null` when not yet resolved for this place.
 * - `isCurrent` — whether this record represents the device's current location.
 * - `sortOrder` — the record's non-negative display position.
 */
export const mobileSavedLocation = weatherLocation
  .extend({
    /** Device-local KMA grid hint, or `null` when not resolved. Required and nullable. */
    kmaGrid: mobileKmaGrid.nullable(),
    /** Whether this saved record is the device's current location. */
    isCurrent: z.boolean(),
    /** Non-negative display order within the saved-location list. */
    sortOrder: nonNegativeInteger,
  })
  .strict();

export type MobileSavedLocation = z.infer<typeof mobileSavedLocation>;

/**
 * The outcome of {@link createWeatherRequestFromSavedLocation}.
 *
 * A discriminated result rather than a thrown error: any invalid input collapses to a single
 * fixed `INVALID_SAVED_LOCATION` shape that carries no Zod issues, field paths, original object,
 * coordinates, display name, or any other input-derived value.
 */
export type SavedLocationWeatherRequestResult =
  | { readonly ok: true; readonly request: WeatherRequestV1 }
  | { readonly ok: false; readonly error: { readonly kind: 'INVALID_SAVED_LOCATION' } };

/** A fresh, fixed invalid result. Built per call so no caller can observe or mutate a shared one. */
function invalidResult(): SavedLocationWeatherRequestResult {
  return { ok: false, error: { kind: 'INVALID_SAVED_LOCATION' } };
}

/**
 * Build a `WeatherRequestV1` from an untrusted saved-location value.
 *
 * Steps, in order:
 * 1. validate the input with `mobileSavedLocation.safeParse`;
 * 2. on failure, return the fixed `INVALID_SAVED_LOCATION` result;
 * 3. on success, map **only** the nine shared `WeatherLocation` fields into a fresh object —
 *    every local-only (`kmaGrid` / `isCurrent` / `sortOrder`) and provider-native (`nx` / `ny`)
 *    field is left out by construction, never spread;
 * 4. defensively re-validate `{ location }` with `weatherRequestV1.safeParse`;
 * 5. return the parsed `WeatherRequestV1`, or the same fixed invalid result if that parse fails.
 *
 * The input is never mutated, nothing is thrown for any input, and no environment, storage, or
 * network is touched.
 */
export function createWeatherRequestFromSavedLocation(
  input: unknown,
): SavedLocationWeatherRequestResult {
  const parsed = mobileSavedLocation.safeParse(input);
  if (!parsed.success) {
    return invalidResult();
  }

  const saved = parsed.data;

  // Map exactly the shared WeatherLocation fields, one by one. Never `{ ...saved }` — a spread
  // would carry the local-only / provider-native fields into the network request.
  const location = {
    id: saved.id,
    displayName: saved.displayName,
    countryCode: saved.countryCode,
    adminArea1: saved.adminArea1,
    adminArea2: saved.adminArea2,
    adminArea3: saved.adminArea3,
    latitude: saved.latitude,
    longitude: saved.longitude,
    timezone: saved.timezone,
  };

  const request = weatherRequestV1.safeParse({ location });
  if (!request.success) {
    return invalidResult();
  }

  return { ok: true, request: request.data };
}
