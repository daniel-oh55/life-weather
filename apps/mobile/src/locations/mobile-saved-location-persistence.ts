/**
 * Provider-neutral persistence boundary for the mobile saved-location collection.
 *
 * PR #39 modelled **one** saved location and PR #40 added the canonical **collection** of many.
 * This module adds the boundary that turns that collection into (and back from) a single stored
 * string, without ever touching a real device store. It owns four concerns and nothing else:
 *
 * - a **stable storage key** ({@link SAVED_LOCATION_PERSISTENCE_KEY}) kept deliberately separate
 *   from the payload version, so a future migration can read an older envelope from the same key;
 * - a strict, **versioned V1 envelope** ({@link mobileSavedLocationPersistenceEnvelopeV1}) that
 *   wraps the existing {@link mobileSavedLocationCollection} — the collection invariants are reused,
 *   never re-declared here;
 * - an **encode / decode codec** that fails closed on invalid input, malformed stored data, and
 *   unsupported versions, and never silently repairs, deletes, or downgrades stored data;
 * - a **load / save / clear** adapter over a minimal injected {@link SavedLocationKeyValueStorage}
 *   port, calling the store the exact number of times the operation needs and no more.
 *
 * Every function validates untrusted input, never throws for any input, never mutates its inputs,
 * returns fresh output on success, and collapses any failure to a fixed, non-revealing `{ kind }`
 * discriminator — no Zod issues, JSON-parse text, native error, storage key, or stored coordinate
 * ever leaves this module.
 *
 * Out of scope for this module (later PRs): any concrete native store
 * (`@react-native-async-storage/async-storage`, `expo-secure-store`, `expo-sqlite`, MMKV, …), a
 * production store instance, migration execution, legacy-key discovery, corrupt-data repair or
 * auto-deletion, encryption, backup/restore, a concurrent write queue or compare-and-swap, React
 * state / hooks / screens, location permission, GPS, and any real network call. Importing this
 * module, or creating a persistence via {@link createSavedLocationPersistence}, reads no
 * environment, touches no storage, and performs no I/O.
 */

import { z } from 'zod';

import { type MobileSavedLocation } from './mobile-saved-location';
import { mobileSavedLocationCollection } from './mobile-saved-location-collection';

/**
 * The persistence payload version, stored **inside** the envelope (never in the key).
 *
 * The key stays constant across versions so a later migration can read an older envelope from the
 * same key and decide what to do. This is `1` for the initial format; bumping it is a future,
 * out-of-scope concern.
 */
export const SAVED_LOCATION_PERSISTENCE_VERSION = 1 as const;

/**
 * The stable key under which the saved-location collection is stored.
 *
 * Deliberately a constant, version-independent key: it carries no user id, device id, coordinate,
 * or operational identifier, is not read from the environment, and is never supplied by the caller.
 * Keeping it separate from {@link SAVED_LOCATION_PERSISTENCE_VERSION} is what lets a future
 * migration read a previous envelope from the same location.
 */
export const SAVED_LOCATION_PERSISTENCE_KEY = '@life-weather/mobile/saved-locations' as const;

/**
 * The versioned V1 persistence envelope.
 *
 * A strict object of exactly `{ version, locations }`: `version` is the literal
 * {@link SAVED_LOCATION_PERSISTENCE_VERSION} and `locations` is the existing
 * {@link mobileSavedLocationCollection} reused verbatim — so unique ids, at-most-one-current, and
 * canonical `sortOrder` are enforced by the same schema, not re-implemented here. There is
 * deliberately no timestamp, `updatedAt`, device id, installation id, API URL, or copied contract
 * version. `.strict()` rejects any unknown top-level key rather than stripping it. The empty
 * collection is a valid payload.
 */
export const mobileSavedLocationPersistenceEnvelopeV1 = z
  .object({
    version: z.literal(SAVED_LOCATION_PERSISTENCE_VERSION),
    locations: mobileSavedLocationCollection,
  })
  .strict();

export type MobileSavedLocationPersistenceEnvelopeV1 = z.infer<
  typeof mobileSavedLocationPersistenceEnvelopeV1
>;

/**
 * The minimal key-value storage port this boundary depends on.
 *
 * Three async methods and nothing more — no `clear()`, no batch operation, no key enumeration.
 * This is intentionally structural: it does **not** import or reference AsyncStorage, SecureStore,
 * or any native package type, so a real store, an in-memory fake, or a spy can all satisfy it. A
 * production store is never created as a side effect of importing this module.
 */
export interface SavedLocationKeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/**
 * The fixed, non-revealing failure discriminators used across this boundary.
 *
 * - `INVALID_COLLECTION` — the value being encoded/saved failed {@link mobileSavedLocationCollection}.
 * - `INVALID_STORED_LOCATIONS` — the stored value was not a decodable V1 envelope (non-string,
 *   empty, malformed JSON, wrong shape, or a collection that violates its invariants).
 * - `UNSUPPORTED_STORED_VERSION` — the stored value is a plain object whose integer `version` is not
 *   `1` (e.g. a future `2` or a legacy `0`), so it must not be read as V1.
 * - `STORAGE_READ_FAILED` / `STORAGE_WRITE_FAILED` / `STORAGE_CLEAR_FAILED` — the injected store
 *   threw synchronously or rejected during the corresponding operation.
 */
export type SavedLocationPersistenceErrorKind =
  | 'INVALID_COLLECTION'
  | 'INVALID_STORED_LOCATIONS'
  | 'UNSUPPORTED_STORED_VERSION'
  | 'STORAGE_READ_FAILED'
  | 'STORAGE_WRITE_FAILED'
  | 'STORAGE_CLEAR_FAILED';

/** The outcome of {@link encodeSavedLocationCollection}. */
export type SavedLocationPersistenceEncodeResult =
  | { readonly ok: true; readonly serialized: string }
  | { readonly ok: false; readonly error: { readonly kind: 'INVALID_COLLECTION' } };

/** The outcome of {@link decodeSavedLocationCollection}. */
export type SavedLocationPersistenceDecodeResult =
  | { readonly ok: true; readonly locations: MobileSavedLocation[] }
  | {
      readonly ok: false;
      readonly error: {
        readonly kind: 'INVALID_STORED_LOCATIONS' | 'UNSUPPORTED_STORED_VERSION';
      };
    };

/** The outcome of {@link SavedLocationPersistence.load}. */
export type SavedLocationPersistenceLoadResult =
  | { readonly ok: true; readonly locations: MobileSavedLocation[] }
  | {
      readonly ok: false;
      readonly error: {
        readonly kind:
          | 'STORAGE_READ_FAILED'
          | 'INVALID_STORED_LOCATIONS'
          | 'UNSUPPORTED_STORED_VERSION';
      };
    };

/** The outcome of {@link SavedLocationPersistence.save}. */
export type SavedLocationPersistenceSaveResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly error: { readonly kind: 'INVALID_COLLECTION' | 'STORAGE_WRITE_FAILED' };
    };

/** The outcome of {@link SavedLocationPersistence.clear}. */
export type SavedLocationPersistenceClearResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: { readonly kind: 'STORAGE_CLEAR_FAILED' } };

/**
 * A fresh failure result for one error `kind`. Built per call — every result and its nested error
 * object is a new object, so no caller can observe or mutate a shared failure.
 */
function failure<K extends SavedLocationPersistenceErrorKind>(
  kind: K,
): { readonly ok: false; readonly error: { readonly kind: K } } {
  return { ok: false, error: { kind } };
}

/** True only for a non-null, non-array object — the shape a JSON envelope must have. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Encode an untrusted collection value into the serialized V1 envelope string.
 *
 * Steps, in order:
 * 1. validate the input with {@link mobileSavedLocationCollection} — any failure (or an exception
 *    thrown while validating a hostile value) is `INVALID_COLLECTION`;
 * 2. build the V1 envelope from the **schema-returned canonical collection**, never the raw input;
 * 3. defensively re-validate the envelope with {@link mobileSavedLocationPersistenceEnvelopeV1};
 * 4. `JSON.stringify` the canonical envelope into a single-line string.
 *
 * The whole body is guarded so nothing throws for any input: a symbol, function, or otherwise
 * unserializable value collapses to `INVALID_COLLECTION`. The input is never mutated, no `sortOrder`
 * is repaired, no timestamp or other nondeterministic value is added, and no storage is touched — so
 * the same canonical input always yields the same serialized string.
 */
export function encodeSavedLocationCollection(
  input: unknown,
): SavedLocationPersistenceEncodeResult {
  try {
    const parsed = mobileSavedLocationCollection.safeParse(input);
    if (!parsed.success) {
      return failure('INVALID_COLLECTION');
    }

    const envelope = {
      version: SAVED_LOCATION_PERSISTENCE_VERSION,
      locations: parsed.data,
    };

    const revalidated = mobileSavedLocationPersistenceEnvelopeV1.safeParse(envelope);
    if (!revalidated.success) {
      return failure('INVALID_COLLECTION');
    }

    const serialized = JSON.stringify(revalidated.data);
    if (typeof serialized !== 'string') {
      return failure('INVALID_COLLECTION');
    }

    return { ok: true, serialized };
  } catch {
    return failure('INVALID_COLLECTION');
  }
}

/**
 * Decode a stored value back into a fresh, validated saved-location collection.
 *
 * Steps, in order:
 * 1. reject a non-string or empty-string input as `INVALID_STORED_LOCATIONS`;
 * 2. `JSON.parse`; a parse failure is `INVALID_STORED_LOCATIONS`;
 * 3. if the parsed value is a plain object whose `version` is an **integer other than 1**, classify
 *    it as `UNSUPPORTED_STORED_VERSION` (e.g. `2` or `0`) — it is never guessed to be V1;
 * 4. otherwise validate against {@link mobileSavedLocationPersistenceEnvelopeV1}; any failure —
 *    missing/`"2"`/`null`/fractional version, wrong shape, extra key, or a collection that violates
 *    its invariants — is `INVALID_STORED_LOCATIONS`.
 *
 * On success the freshly parsed `locations` are returned; they pass the collection schema and every
 * array, record, and non-null `kmaGrid` is a new reference on each call. Malformed data is never
 * turned into an empty collection, repaired, or logged, and the raw input is never returned.
 */
export function decodeSavedLocationCollection(
  rawInput: unknown,
): SavedLocationPersistenceDecodeResult {
  if (typeof rawInput !== 'string' || rawInput === '') {
    return failure('INVALID_STORED_LOCATIONS');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawInput);
  } catch {
    return failure('INVALID_STORED_LOCATIONS');
  }

  // Classify an unsupported version before the V1 schema so a future/legacy integer version is
  // reported as such and never read as V1. Non-integer / non-number versions fall through to the
  // schema, which rejects them as INVALID_STORED_LOCATIONS.
  if (isPlainObject(parsed)) {
    const version = parsed.version;
    if (
      typeof version === 'number' &&
      Number.isInteger(version) &&
      version !== SAVED_LOCATION_PERSISTENCE_VERSION
    ) {
      return failure('UNSUPPORTED_STORED_VERSION');
    }
  }

  const envelope = mobileSavedLocationPersistenceEnvelopeV1.safeParse(parsed);
  if (!envelope.success) {
    return failure('INVALID_STORED_LOCATIONS');
  }

  return { ok: true, locations: envelope.data.locations };
}

/**
 * The persistence adapter surface: load, save, and clear the saved-location collection.
 *
 * Created by {@link createSavedLocationPersistence} over an injected {@link SavedLocationKeyValueStorage}.
 * Each method returns a fixed, discriminated result and never throws.
 */
export interface SavedLocationPersistence {
  load(): Promise<SavedLocationPersistenceLoadResult>;
  save(input: unknown): Promise<SavedLocationPersistenceSaveResult>;
  clear(): Promise<SavedLocationPersistenceClearResult>;
}

/**
 * Build a {@link SavedLocationPersistence} over an injected key-value store.
 *
 * Neither this factory nor importing the module calls any storage method or performs I/O; the store
 * is only touched when {@link SavedLocationPersistence.load}/`save`/`clear` are invoked. There is no
 * module-level cache, singleton result, or shared array/error — every call produces fresh output.
 *
 * - **load** reads the key exactly once. A synchronous throw or rejection is `STORAGE_READ_FAILED`;
 *   a `null` (missing key) is a successful fresh empty collection; any other value is handed to
 *   {@link decodeSavedLocationCollection}, whose result is surfaced as-is (corruption and unsupported
 *   versions fail closed — never emptied, deleted, or migrated, and no write happens during a load).
 * - **save** encodes first; an invalid collection is `INVALID_COLLECTION` and the store is never
 *   touched, so a bad value cannot overwrite good stored data. On success it writes the canonical V1
 *   string to the key exactly once (no read-modify-write); a throw or rejection is `STORAGE_WRITE_FAILED`.
 * - **clear** removes the key exactly once (never a store-wide `clear()`); a throw or rejection is
 *   `STORAGE_CLEAR_FAILED`. A provider that resolves for a missing key is a success.
 */
export function createSavedLocationPersistence(
  storage: SavedLocationKeyValueStorage,
): SavedLocationPersistence {
  return {
    async load(): Promise<SavedLocationPersistenceLoadResult> {
      let raw: string | null;
      try {
        raw = await storage.getItem(SAVED_LOCATION_PERSISTENCE_KEY);
      } catch {
        return failure('STORAGE_READ_FAILED');
      }

      if (raw === null) {
        return { ok: true, locations: [] };
      }

      const decoded = decodeSavedLocationCollection(raw);
      if (!decoded.ok) {
        return failure(decoded.error.kind);
      }

      return { ok: true, locations: decoded.locations };
    },

    async save(input: unknown): Promise<SavedLocationPersistenceSaveResult> {
      const encoded = encodeSavedLocationCollection(input);
      if (!encoded.ok) {
        return failure('INVALID_COLLECTION');
      }

      try {
        await storage.setItem(SAVED_LOCATION_PERSISTENCE_KEY, encoded.serialized);
      } catch {
        return failure('STORAGE_WRITE_FAILED');
      }

      return { ok: true };
    },

    async clear(): Promise<SavedLocationPersistenceClearResult> {
      try {
        await storage.removeItem(SAVED_LOCATION_PERSISTENCE_KEY);
      } catch {
        return failure('STORAGE_CLEAR_FAILED');
      }

      return { ok: true };
    },
  };
}
