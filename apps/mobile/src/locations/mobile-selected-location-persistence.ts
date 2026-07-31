/**
 * Provider-neutral persistence boundary for the mobile **selected** location preference.
 *
 * `isCurrent` (see {@link ./mobile-saved-location}) marks whichever saved record represents the
 * device's real GPS-derived current location. This module persists a completely different concept:
 * `selectedLocationId`, the id of the saved location the user is currently viewing in the app. The
 * two are never combined here or by any consumer of this module.
 *
 * This boundary owns four concerns and nothing else, mirroring
 * {@link ./mobile-saved-location-persistence} but under its **own** key, version, and envelope:
 *
 * - a **stable storage key** ({@link SELECTED_LOCATION_PERSISTENCE_KEY}), distinct from the
 *   saved-location key, kept separate from the payload version;
 * - a strict, **versioned V1 envelope** ({@link mobileSelectedLocationPersistenceEnvelopeV1}) that
 *   wraps a nullable id — no timestamp, device id, coordinate, grid, or copied contract version;
 * - an **encode / decode codec** that fails closed on invalid input, malformed stored data, and
 *   unsupported versions, and never silently repairs, deletes, or migrates stored data;
 * - a **load / save** adapter over a minimal injected {@link SelectedLocationKeyValueStorage} port.
 *   There is deliberately no `clear()` / `removeItem()` — clearing the selection is expressed by
 *   saving `null` as an explicit V1 envelope, the same versioned write path as any other value.
 *
 * The id schema is **reused**, not re-declared: {@link selectedLocationId} is exactly
 * `mobileSavedLocation.shape.id`, so this module carries no independent opinion on id shape.
 *
 * Every function validates untrusted input, never throws for any input, never mutates its inputs,
 * returns fresh output on success, and collapses any failure to a fixed, non-revealing `{ kind }`
 * discriminator — no Zod issue, JSON-parse text, native error, storage key, or stored id ever leaves
 * this module.
 *
 * Out of scope for this module (later PRs): any concrete native store, a production store instance,
 * migration execution, auto-repair, React state / hooks / screens, and any real network call.
 * Importing this module, or creating a persistence via {@link createSelectedLocationPersistence},
 * reads no environment, touches no storage, and performs no I/O.
 */

import { z } from 'zod';

import { mobileSavedLocation } from './mobile-saved-location';

/**
 * The persistence payload version, stored **inside** the envelope (never in the key).
 *
 * Kept separate from {@link SELECTED_LOCATION_PERSISTENCE_KEY} for the same reason as the
 * saved-location envelope: a later migration can read an older envelope from the same key.
 */
export const SELECTED_LOCATION_PERSISTENCE_VERSION = 1 as const;

/**
 * The stable key under which the selected-location preference is stored.
 *
 * Deliberately distinct from {@link SAVED_LOCATION_PERSISTENCE_KEY} (see
 * `./mobile-saved-location-persistence`) — the two preferences are stored, loaded, and can fail
 * independently. Not read from the environment and never supplied by a caller.
 */
export const SELECTED_LOCATION_PERSISTENCE_KEY =
  '@life-weather/mobile/selected-location' as const;

/**
 * The saved-location id schema, reused verbatim (never re-declared) and made nullable: a selected
 * preference is either a specific saved location's id, or `null` when nothing is selected.
 */
const selectedLocationIdSchema = mobileSavedLocation.shape.id.nullable();

/**
 * The versioned V1 persistence envelope.
 *
 * A strict object of exactly `{ version, selectedLocationId }`. There is deliberately no timestamp,
 * device id, coordinate, grid, or copied contract version. `.strict()` rejects any unknown top-level
 * key rather than stripping it.
 */
export const mobileSelectedLocationPersistenceEnvelopeV1 = z
  .object({
    version: z.literal(SELECTED_LOCATION_PERSISTENCE_VERSION),
    selectedLocationId: selectedLocationIdSchema,
  })
  .strict();

export type MobileSelectedLocationPersistenceEnvelopeV1 = z.infer<
  typeof mobileSelectedLocationPersistenceEnvelopeV1
>;

/**
 * The minimal key-value storage port this boundary depends on.
 *
 * Two async methods and nothing more — no `removeItem()`, no `clear()`, no batch operation, no key
 * enumeration. Purely structural: it does not import or reference AsyncStorage or any native package
 * type, so a real store, an in-memory fake, or a spy can all satisfy it.
 */
export interface SelectedLocationKeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/**
 * The fixed, non-revealing failure discriminators used across this boundary.
 *
 * - `INVALID_SELECTED_LOCATION_ID` — the value being encoded/saved failed
 *   {@link selectedLocationIdSchema}.
 * - `INVALID_STORED_SELECTION` — the stored value was not a decodable V1 envelope (non-string, empty,
 *   malformed JSON, wrong shape, or an id that fails its schema).
 * - `UNSUPPORTED_STORED_VERSION` — the stored value is a plain object whose integer `version` is not
 *   `1`, so it must not be read as V1.
 * - `STORAGE_READ_FAILED` / `STORAGE_WRITE_FAILED` — the injected store threw synchronously or
 *   rejected during the corresponding operation.
 */
export type SelectedLocationPersistenceErrorKind =
  | 'INVALID_SELECTED_LOCATION_ID'
  | 'INVALID_STORED_SELECTION'
  | 'UNSUPPORTED_STORED_VERSION'
  | 'STORAGE_READ_FAILED'
  | 'STORAGE_WRITE_FAILED';

/** The outcome of {@link encodeSelectedLocationId}. */
export type SelectedLocationPersistenceEncodeResult =
  | { readonly ok: true; readonly serialized: string }
  | { readonly ok: false; readonly error: { readonly kind: 'INVALID_SELECTED_LOCATION_ID' } };

/** The outcome of {@link decodeSelectedLocationId}. */
export type SelectedLocationPersistenceDecodeResult =
  | { readonly ok: true; readonly selectedLocationId: string | null }
  | {
      readonly ok: false;
      readonly error: {
        readonly kind: 'INVALID_STORED_SELECTION' | 'UNSUPPORTED_STORED_VERSION';
      };
    };

/** The outcome of {@link SelectedLocationPersistence.load}. */
export type SelectedLocationPersistenceLoadResult =
  | { readonly ok: true; readonly selectedLocationId: string | null }
  | {
      readonly ok: false;
      readonly error: {
        readonly kind:
          | 'STORAGE_READ_FAILED'
          | 'INVALID_STORED_SELECTION'
          | 'UNSUPPORTED_STORED_VERSION';
      };
    };

/** The outcome of {@link SelectedLocationPersistence.save}. */
export type SelectedLocationPersistenceSaveResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly error: { readonly kind: 'INVALID_SELECTED_LOCATION_ID' | 'STORAGE_WRITE_FAILED' };
    };

/**
 * A fresh failure result for one error `kind`. Built per call — every result and its nested error
 * object is a new object, so no caller can observe or mutate a shared failure.
 */
function failure<K extends SelectedLocationPersistenceErrorKind>(
  kind: K,
): { readonly ok: false; readonly error: { readonly kind: K } } {
  return { ok: false, error: { kind } };
}

/** True only for a non-null, non-array object — the shape a JSON envelope must have. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Encode an untrusted selected-location id value into the serialized V1 envelope string.
 *
 * Steps, in order:
 * 1. validate the input with {@link selectedLocationIdSchema} — any failure (or an exception thrown
 *    while validating a hostile value) is `INVALID_SELECTED_LOCATION_ID`;
 * 2. build the V1 envelope from the **schema-returned canonical value**, never the raw input;
 * 3. defensively re-validate the envelope with {@link mobileSelectedLocationPersistenceEnvelopeV1};
 * 4. `JSON.stringify` the canonical envelope into a single-line string.
 *
 * The whole body is guarded so nothing throws for any input. The same canonical input always yields
 * the same serialized string, and no storage is touched.
 */
export function encodeSelectedLocationId(input: unknown): SelectedLocationPersistenceEncodeResult {
  try {
    const parsed = selectedLocationIdSchema.safeParse(input);
    if (!parsed.success) {
      return failure('INVALID_SELECTED_LOCATION_ID');
    }

    const envelope = {
      version: SELECTED_LOCATION_PERSISTENCE_VERSION,
      selectedLocationId: parsed.data,
    };

    const revalidated = mobileSelectedLocationPersistenceEnvelopeV1.safeParse(envelope);
    if (!revalidated.success) {
      return failure('INVALID_SELECTED_LOCATION_ID');
    }

    const serialized = JSON.stringify(revalidated.data);
    if (typeof serialized !== 'string') {
      return failure('INVALID_SELECTED_LOCATION_ID');
    }

    return { ok: true, serialized };
  } catch {
    return failure('INVALID_SELECTED_LOCATION_ID');
  }
}

/**
 * Decode a stored value back into a fresh, validated selected-location id.
 *
 * Steps, in order:
 * 1. reject a non-string or empty-string input as `INVALID_STORED_SELECTION`;
 * 2. `JSON.parse`; a parse failure is `INVALID_STORED_SELECTION`;
 * 3. if the parsed value is a plain object whose `version` is an **integer other than 1**, classify
 *    it as `UNSUPPORTED_STORED_VERSION` — it is never guessed to be V1;
 * 4. otherwise validate against {@link mobileSelectedLocationPersistenceEnvelopeV1}; any failure is
 *    `INVALID_STORED_SELECTION`.
 *
 * Malformed data is never turned into a `null` selection, repaired, or logged, and the raw input is
 * never returned.
 */
export function decodeSelectedLocationId(
  rawInput: unknown,
): SelectedLocationPersistenceDecodeResult {
  if (typeof rawInput !== 'string' || rawInput === '') {
    return failure('INVALID_STORED_SELECTION');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawInput);
  } catch {
    return failure('INVALID_STORED_SELECTION');
  }

  // Classify an unsupported version before the V1 schema so a future/legacy integer version is
  // reported as such and never read as V1. Non-integer / non-number versions fall through to the
  // schema, which rejects them as INVALID_STORED_SELECTION.
  if (isPlainObject(parsed)) {
    const version = parsed.version;
    if (
      typeof version === 'number' &&
      Number.isInteger(version) &&
      version !== SELECTED_LOCATION_PERSISTENCE_VERSION
    ) {
      return failure('UNSUPPORTED_STORED_VERSION');
    }
  }

  const envelope = mobileSelectedLocationPersistenceEnvelopeV1.safeParse(parsed);
  if (!envelope.success) {
    return failure('INVALID_STORED_SELECTION');
  }

  return { ok: true, selectedLocationId: envelope.data.selectedLocationId };
}

/**
 * The persistence adapter surface: load and save the selected-location preference.
 *
 * Created by {@link createSelectedLocationPersistence} over an injected
 * {@link SelectedLocationKeyValueStorage}. Each method returns a fixed, discriminated result and
 * never throws.
 */
export interface SelectedLocationPersistence {
  load(): Promise<SelectedLocationPersistenceLoadResult>;
  save(input: unknown): Promise<SelectedLocationPersistenceSaveResult>;
}

/**
 * Build a {@link SelectedLocationPersistence} over an injected key-value store.
 *
 * Neither this factory nor importing the module calls any storage method or performs I/O; the store
 * is only touched when {@link SelectedLocationPersistence.load}/`save` are invoked.
 *
 * - **load** reads the key exactly once. A synchronous throw or rejection is `STORAGE_READ_FAILED`; a
 *   `null` (missing key) is a successful `selectedLocationId: null`; any other value is handed to
 *   {@link decodeSelectedLocationId}, whose result is surfaced as-is (corruption and unsupported
 *   versions fail closed — never repaired, deleted, or migrated, and no write happens during a load).
 * - **save** encodes first; an invalid id is `INVALID_SELECTED_LOCATION_ID` and the store is never
 *   touched. On success it writes the canonical V1 string to the key exactly once (no
 *   read-modify-write, and `null` is written as an explicit envelope — never `removeItem()`); a throw
 *   or rejection is `STORAGE_WRITE_FAILED`.
 */
export function createSelectedLocationPersistence(
  storage: SelectedLocationKeyValueStorage,
): SelectedLocationPersistence {
  return {
    async load(): Promise<SelectedLocationPersistenceLoadResult> {
      let raw: string | null;
      try {
        raw = await storage.getItem(SELECTED_LOCATION_PERSISTENCE_KEY);
      } catch {
        return failure('STORAGE_READ_FAILED');
      }

      if (raw === null) {
        return { ok: true, selectedLocationId: null };
      }

      const decoded = decodeSelectedLocationId(raw);
      if (!decoded.ok) {
        return failure(decoded.error.kind);
      }

      return { ok: true, selectedLocationId: decoded.selectedLocationId };
    },

    async save(input: unknown): Promise<SelectedLocationPersistenceSaveResult> {
      const encoded = encodeSelectedLocationId(input);
      if (!encoded.ok) {
        return failure('INVALID_SELECTED_LOCATION_ID');
      }

      try {
        await storage.setItem(SELECTED_LOCATION_PERSISTENCE_KEY, encoded.serialized);
      } catch {
        return failure('STORAGE_WRITE_FAILED');
      }

      return { ok: true };
    },
  };
}
