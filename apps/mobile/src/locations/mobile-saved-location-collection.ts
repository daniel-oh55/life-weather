/**
 * Pure, deterministic collection boundary for mobile saved locations.
 *
 * PR #39 modelled **one** saved location ({@link mobileSavedLocation}) and its network mapping.
 * This module adds the boundary that manages **many** of them as a single canonical, validated
 * value: a runtime schema with three invariants (unique ids, at most one current location, and a
 * `sortOrder` that is exactly the array index) plus four pure operations — add, remove, reorder,
 * and set/clear the current location.
 *
 * Every operation validates untrusted input, never throws, never mutates its inputs, returns a
 * fresh canonical collection on success, and collapses any failure to a fixed, non-revealing
 * discriminator. The result is the canonical representation a later persistence adapter can store
 * without ever writing an inconsistent collection to the device.
 *
 * Out of scope for this module (later PRs): AsyncStorage / SecureStore / any storage adapter,
 * serialization or migration, React state, screens, navigation, location permission, GPS, KMA
 * grid computation, and any real network call. This module reuses the single-record schema from
 * {@link ./mobile-saved-location} rather than re-declaring any location field. Importing it or
 * calling any operation reads no environment, touches no storage, and performs no I/O.
 */

import { z } from 'zod';

import { mobileSavedLocation, type MobileSavedLocation } from './mobile-saved-location';

/**
 * A candidate for {@link addSavedLocation}: the saved-location shape **minus `sortOrder`**.
 *
 * The caller never chooses a record's display position — `sortOrder` is derived from the
 * collection on insert and rewritten to the canonical `0..n-1` by every operation. The schema is
 * the single-record schema with `sortOrder` omitted and made strict again, so passing `sortOrder`
 * (or any other unknown key) fails validation rather than being silently stripped. Every other
 * field — the shared `WeatherLocation` fields, `kmaGrid`, and `isCurrent` — keeps the exact PR #39
 * policy, since the shape is reused, not rewritten.
 */
export const mobileSavedLocationCandidate = mobileSavedLocation
  .omit({ sortOrder: true })
  .strict();

export type MobileSavedLocationCandidate = z.infer<typeof mobileSavedLocationCandidate>;

/**
 * A validated collection of saved locations.
 *
 * An array of {@link mobileSavedLocation} — the empty array is allowed — constrained by three
 * invariants so stored data has exactly one canonical form:
 *
 * - **A. Unique ids.** Every `id` is unique within the collection. Duplicate ids fail validation.
 *   `displayName`, coordinates, `adminArea*`, and `kmaGrid` are **not** uniqueness keys: two
 *   distinct opaque ids may share a display name or coordinates.
 * - **B. At most one current location.** `isCurrent: true` appears on zero or one record — never
 *   two or more. There is deliberately no "exactly one" rule: permission-denied, manual-only, and
 *   just-removed-current states must all be representable.
 * - **C. Canonical sort order.** `locations[index].sortOrder === index` for every element, so a
 *   valid collection always reads `0, 1, 2, …`. Duplicate values, gaps, a non-zero start, reverse
 *   or arbitrary order, and any array-index / `sortOrder` mismatch all fail validation.
 *
 * An individual element that is not a valid {@link mobileSavedLocation} fails the element parse
 * before these cross-element checks run.
 */
export const mobileSavedLocationCollection = z
  .array(mobileSavedLocation)
  .superRefine((locations, ctx) => {
    // A. Ids must be unique across the collection.
    const ids = locations.map((location) => location.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', message: 'saved-location ids must be unique' });
    }

    // B. At most one record may be the current location.
    if (locations.filter((location) => location.isCurrent).length > 1) {
      ctx.addIssue({ code: 'custom', message: 'at most one current location is allowed' });
    }

    // C. sortOrder must be the canonical array index for every element.
    if (!locations.every((location, index) => location.sortOrder === index)) {
      ctx.addIssue({ code: 'custom', message: 'sortOrder must equal the array index' });
    }
  });

export type MobileSavedLocationCollection = z.infer<typeof mobileSavedLocationCollection>;

/**
 * The fixed, non-revealing failure discriminators shared by every collection operation.
 *
 * - `INVALID_COLLECTION` — the input collection failed {@link mobileSavedLocationCollection}. This
 *   takes priority over any operation-argument failure.
 * - `INVALID_LOCATION` — the add candidate failed {@link mobileSavedLocationCandidate}.
 * - `DUPLICATE_LOCATION_ID` — the candidate's `id` already exists in the collection.
 * - `CURRENT_LOCATION_CONFLICT` — a current candidate was added while a current location exists.
 * - `INVALID_LOCATION_ID` — the supplied id argument was not a usable non-empty string.
 * - `LOCATION_NOT_FOUND` — the supplied id is not present in the collection.
 * - `INVALID_REORDER` — the ordered-id list is not an exact permutation of the collection's ids.
 */
export type SavedLocationCollectionErrorKind =
  | 'INVALID_COLLECTION'
  | 'INVALID_LOCATION'
  | 'DUPLICATE_LOCATION_ID'
  | 'CURRENT_LOCATION_CONFLICT'
  | 'INVALID_LOCATION_ID'
  | 'LOCATION_NOT_FOUND'
  | 'INVALID_REORDER';

/**
 * The outcome of a collection operation.
 *
 * A discriminated result rather than a thrown error: success carries a fresh canonical collection;
 * failure carries only a fixed `kind`, never Zod issues, field paths, the original collection, or
 * any input-derived id / display name / coordinate / grid value.
 */
export type SavedLocationCollectionResult =
  | { readonly ok: true; readonly locations: MobileSavedLocation[] }
  | { readonly ok: false; readonly error: { readonly kind: SavedLocationCollectionErrorKind } };

/** A fresh failure result. Built per call so no caller can observe or mutate a shared one. */
function failure(kind: SavedLocationCollectionErrorKind): SavedLocationCollectionResult {
  return { ok: false, error: { kind } };
}

/**
 * Return a fresh copy of one saved location, optionally overriding `sortOrder` / `isCurrent`.
 *
 * The top-level object is always new. `kmaGrid` is preserved as `null` when null, or shallow-cloned
 * to a fresh `{ ...kmaGrid }` when present, so no nested object reference is shared with the input.
 * Every other field is a primitive (or `null`) and is safe to copy by value. No serialization-based
 * clone (`JSON.parse(JSON.stringify(...))`) is used, and the input is never frozen or mutated.
 */
function cloneSavedLocation(
  location: MobileSavedLocation,
  overrides: Partial<Pick<MobileSavedLocation, 'sortOrder' | 'isCurrent'>> = {},
): MobileSavedLocation {
  return {
    ...location,
    kmaGrid: location.kmaGrid === null ? null : { ...location.kmaGrid },
    ...overrides,
  };
}

/**
 * Turn an ordered list of records into a canonical success result.
 *
 * Each record is cloned fresh and assigned `sortOrder` equal to its position, then the whole array
 * is re-validated against {@link mobileSavedLocationCollection}. A defensive failure of that
 * re-validation collapses to `INVALID_COLLECTION` rather than throwing. On success the freshly
 * cloned array is returned (not the re-parsed copy), so every top-level object and nested
 * `kmaGrid` in the output is guaranteed independent of the caller's input.
 */
function finalizeCollection(ordered: MobileSavedLocation[]): SavedLocationCollectionResult {
  const canonical = ordered.map((location, index) =>
    cloneSavedLocation(location, { sortOrder: index }),
  );

  const revalidated = mobileSavedLocationCollection.safeParse(canonical);
  if (!revalidated.success) {
    return failure('INVALID_COLLECTION');
  }

  return { ok: true, locations: canonical };
}

/**
 * Append a candidate location to the collection.
 *
 * Order of checks: (1) the collection must be valid, (2) the candidate must be a valid
 * {@link mobileSavedLocationCandidate}, (3) its `id` must not already exist, (4) if it is a current
 * candidate, the collection must not already hold a current location. The candidate is appended at
 * the end and its `sortOrder` is derived from the collection length — never taken from the caller.
 *
 * An existing current record is left untouched (switching the current location is
 * {@link setCurrentSavedLocation}'s job). A non-current candidate is always allowed even when a
 * current location already exists, and either kind may be added to an empty collection.
 */
export function addSavedLocation(
  collectionInput: unknown,
  candidateInput: unknown,
): SavedLocationCollectionResult {
  const parsedCollection = mobileSavedLocationCollection.safeParse(collectionInput);
  if (!parsedCollection.success) {
    return failure('INVALID_COLLECTION');
  }

  const parsedCandidate = mobileSavedLocationCandidate.safeParse(candidateInput);
  if (!parsedCandidate.success) {
    return failure('INVALID_LOCATION');
  }

  const current = parsedCollection.data;
  const candidate = parsedCandidate.data;

  if (current.some((location) => location.id === candidate.id)) {
    return failure('DUPLICATE_LOCATION_ID');
  }

  if (candidate.isCurrent && current.some((location) => location.isCurrent)) {
    return failure('CURRENT_LOCATION_CONFLICT');
  }

  const appended: MobileSavedLocation = { ...candidate, sortOrder: current.length };
  return finalizeCollection([...current, appended]);
}

/**
 * Remove the location with the given id from the collection.
 *
 * The id argument must be a non-empty string (a whitespace-only string is rejected, but the id is
 * matched by its original value — it is never trimmed into a different id). Removing a record — the
 * current one included — succeeds; the remaining records are re-indexed to a canonical `0..n-1`,
 * and removing the last record yields the allowed empty collection.
 */
export function removeSavedLocation(
  collectionInput: unknown,
  locationIdInput: unknown,
): SavedLocationCollectionResult {
  const parsedCollection = mobileSavedLocationCollection.safeParse(collectionInput);
  if (!parsedCollection.success) {
    return failure('INVALID_COLLECTION');
  }

  if (typeof locationIdInput !== 'string' || locationIdInput.trim() === '') {
    return failure('INVALID_LOCATION_ID');
  }

  const current = parsedCollection.data;
  if (!current.some((location) => location.id === locationIdInput)) {
    return failure('LOCATION_NOT_FOUND');
  }

  const remaining = current.filter((location) => location.id !== locationIdInput);
  return finalizeCollection(remaining);
}

/**
 * Reorder the collection to match an explicit list of ids.
 *
 * `orderedIdsInput` must be an array of non-empty strings, with no duplicates, whose length equals
 * the collection's and whose members are exactly the collection's ids — no missing id and no extra
 * id. Any deviation collapses to `INVALID_REORDER`. Records are placed in the requested order,
 * `sortOrder` is rewritten to the new index, and `isCurrent` / `kmaGrid` / every other field is
 * preserved. An empty collection with an empty id list, and a no-op reorder that repeats the
 * current order, both succeed and return a fresh collection.
 */
export function reorderSavedLocations(
  collectionInput: unknown,
  orderedIdsInput: unknown,
): SavedLocationCollectionResult {
  const parsedCollection = mobileSavedLocationCollection.safeParse(collectionInput);
  if (!parsedCollection.success) {
    return failure('INVALID_COLLECTION');
  }

  if (!Array.isArray(orderedIdsInput)) {
    return failure('INVALID_REORDER');
  }

  const rawIds: unknown[] = orderedIdsInput;
  if (!rawIds.every((id) => typeof id === 'string' && id.length > 0)) {
    return failure('INVALID_REORDER');
  }
  const orderedIds = rawIds as string[];

  if (new Set(orderedIds).size !== orderedIds.length) {
    return failure('INVALID_REORDER');
  }

  const current = parsedCollection.data;
  if (orderedIds.length !== current.length) {
    return failure('INVALID_REORDER');
  }

  const byId = new Map(current.map((location) => [location.id, location]));
  // Length equal + no duplicates + every requested id present ⇒ exact set equality.
  if (!orderedIds.every((id) => byId.has(id))) {
    return failure('INVALID_REORDER');
  }

  const reordered = orderedIds.map((id) => byId.get(id) as MobileSavedLocation);
  return finalizeCollection(reordered);
}

/**
 * Set — or, with `null`, clear — the collection's current location.
 *
 * With a non-empty string id, exactly that record becomes `isCurrent: true` and every other record
 * becomes `false`. With `null`, every record's `isCurrent` is cleared to `false`. A non-null,
 * non-string, or empty id is `INVALID_LOCATION_ID`; a string id not present in the collection is
 * `LOCATION_NOT_FOUND`. Re-setting the record that is already the sole current location, and
 * clearing when there is already no current location, are both successful no-ops that still return
 * a fresh collection. Array order and `sortOrder` are never changed — only the `isCurrent` flags.
 *
 * This never adds a record or reads GPS; it only flips existing flags deterministically.
 */
export function setCurrentSavedLocation(
  collectionInput: unknown,
  locationIdInput: unknown,
): SavedLocationCollectionResult {
  const parsedCollection = mobileSavedLocationCollection.safeParse(collectionInput);
  if (!parsedCollection.success) {
    return failure('INVALID_COLLECTION');
  }

  const current = parsedCollection.data;

  if (locationIdInput === null) {
    const cleared = current.map((location) => ({ ...location, isCurrent: false }));
    return finalizeCollection(cleared);
  }

  if (typeof locationIdInput !== 'string' || locationIdInput.trim() === '') {
    return failure('INVALID_LOCATION_ID');
  }

  if (!current.some((location) => location.id === locationIdInput)) {
    return failure('LOCATION_NOT_FOUND');
  }

  const updated = current.map((location) => ({
    ...location,
    isCurrent: location.id === locationIdInput,
  }));
  return finalizeCollection(updated);
}
