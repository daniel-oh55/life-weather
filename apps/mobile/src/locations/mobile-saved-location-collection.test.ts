import { describe, expect, it } from 'vitest';

import {
  addSavedLocation,
  mobileSavedLocationCandidate,
  mobileSavedLocationCollection,
  removeSavedLocation,
  reorderSavedLocations,
  setCurrentSavedLocation,
  type MobileSavedLocation,
  type SavedLocationCollectionResult,
} from './index';

// ---------------------------------------------------------------------------
// Synthetic fixtures. Everything here is fabricated — synthetic ids, display names, and
// coordinates, and a non-sensitive standard timezone — so no real user location, stored place,
// or device identifier is ever used. Each builder returns a *fresh* object so a test can freeze
// or mutate it without leaking into another test.
// ---------------------------------------------------------------------------

/** A marker asserted absent from any failure result — proves nothing input-derived leaks out. */
const SECRET_MARKER = 'SYNTHETIC_COLLECTION_SECRET_MUST_NOT_LEAK';

/** Distinctive coordinates asserted absent from any failure result. */
const SECRET_LATITUDE = 12.34;
const SECRET_LONGITUDE = 56.78;

/** The nine shared `WeatherLocation` fields for a synthetic id. */
function sharedFields(id: string) {
  return {
    id,
    displayName: `Synthetic ${id}`,
    countryCode: 'KR',
    adminArea1: 'Synthetic Province',
    adminArea2: 'Synthetic District',
    adminArea3: null,
    latitude: 37.5,
    longitude: 127.0,
    timezone: 'Asia/Seoul',
  };
}

/** A fresh, valid saved-location record (sortOrder 0 unless overridden). */
function record(id: string, overrides: Partial<MobileSavedLocation> = {}): MobileSavedLocation {
  return {
    ...sharedFields(id),
    kmaGrid: { nx: 60, ny: 127 },
    isCurrent: false,
    sortOrder: 0,
    ...overrides,
  };
}

/** A fresh, canonical collection: sortOrder is assigned from array position. */
function collectionOf(
  ...specs: (Partial<MobileSavedLocation> & { id: string })[]
): MobileSavedLocation[] {
  return specs.map((spec, index) => record(spec.id, { ...spec, sortOrder: index }));
}

/** A fresh add candidate (no sortOrder). */
function candidate(id: string, overrides: Record<string, unknown> = {}) {
  return {
    ...sharedFields(id),
    kmaGrid: { nx: 60, ny: 127 } as unknown,
    isCurrent: false,
    ...overrides,
  };
}

/** Recursively freeze a value so any attempted mutation throws in strict mode. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** Assert every output record is a fresh object, with a fresh nested kmaGrid, vs every input. */
function expectFreshRecords(input: MobileSavedLocation[], output: MobileSavedLocation[]) {
  expect(output as unknown).not.toBe(input);
  for (const out of output) {
    for (const inp of input) {
      expect(out).not.toBe(inp);
      if (out.kmaGrid !== null && inp.kmaGrid !== null) {
        expect(out.kmaGrid).not.toBe(inp.kmaGrid);
      }
    }
  }
}

/** Assert a successful result and narrow to its locations. */
function expectOk(result: SavedLocationCollectionResult): MobileSavedLocation[] {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('expected ok result');
  return result.locations;
}

// ---------------------------------------------------------------------------
// 15.1 — collection schema success
// ---------------------------------------------------------------------------

describe('mobileSavedLocationCollection — valid input', () => {
  it('accepts an empty collection', () => {
    expect(mobileSavedLocationCollection.safeParse([]).success).toBe(true);
  });

  it('accepts a single normal location', () => {
    expect(mobileSavedLocationCollection.safeParse(collectionOf({ id: 'a' })).success).toBe(true);
  });

  it('accepts a single current location', () => {
    expect(
      mobileSavedLocationCollection.safeParse(collectionOf({ id: 'a', isCurrent: true })).success,
    ).toBe(true);
  });

  it('accepts several locations with no current', () => {
    expect(
      mobileSavedLocationCollection.safeParse(collectionOf({ id: 'a' }, { id: 'b' }, { id: 'c' }))
        .success,
    ).toBe(true);
  });

  it('accepts several locations with exactly one current', () => {
    expect(
      mobileSavedLocationCollection.safeParse(
        collectionOf({ id: 'a' }, { id: 'b', isCurrent: true }, { id: 'c' }),
      ).success,
    ).toBe(true);
  });

  it('accepts canonical sortOrder 0..n-1', () => {
    const parsed = mobileSavedLocationCollection.safeParse(
      collectionOf({ id: 'a' }, { id: 'b' }, { id: 'c' }),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.map((location) => location.sortOrder)).toEqual([0, 1, 2]);
  });

  it('accepts distinct ids that share a display name', () => {
    const value = collectionOf(
      { id: 'a', displayName: 'Same Name' },
      { id: 'b', displayName: 'Same Name' },
    );
    expect(mobileSavedLocationCollection.safeParse(value).success).toBe(true);
  });

  it('accepts distinct ids that share coordinates', () => {
    const value = collectionOf(
      { id: 'a', latitude: 37.5, longitude: 127 },
      { id: 'b', latitude: 37.5, longitude: 127 },
    );
    expect(mobileSavedLocationCollection.safeParse(value).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 15.2 — collection schema failure
// ---------------------------------------------------------------------------

describe('mobileSavedLocationCollection — invalid input', () => {
  it('rejects a duplicate id', () => {
    const value = [record('dup', { sortOrder: 0 }), record('dup', { sortOrder: 1 })];
    expect(mobileSavedLocationCollection.safeParse(value).success).toBe(false);
  });

  it('rejects two or more current locations', () => {
    const value = [
      record('a', { sortOrder: 0, isCurrent: true }),
      record('b', { sortOrder: 1, isCurrent: true }),
    ];
    expect(mobileSavedLocationCollection.safeParse(value).success).toBe(false);
  });

  it('rejects a duplicate sortOrder', () => {
    const value = [record('a', { sortOrder: 0 }), record('b', { sortOrder: 0 })];
    expect(mobileSavedLocationCollection.safeParse(value).success).toBe(false);
  });

  it('rejects a gap in sortOrder', () => {
    const value = [record('a', { sortOrder: 0 }), record('b', { sortOrder: 2 })];
    expect(mobileSavedLocationCollection.safeParse(value).success).toBe(false);
  });

  it('rejects a sortOrder that does not start at 0', () => {
    const value = [record('a', { sortOrder: 1 }), record('b', { sortOrder: 2 })];
    expect(mobileSavedLocationCollection.safeParse(value).success).toBe(false);
  });

  it('rejects an array-index / sortOrder mismatch (reversed order)', () => {
    const value = [record('a', { sortOrder: 1 }), record('b', { sortOrder: 0 })];
    expect(mobileSavedLocationCollection.safeParse(value).success).toBe(false);
  });

  it('rejects an unknown top-level field on a record', () => {
    const value = [{ ...record('a', { sortOrder: 0 }), extra: 'nope' }];
    expect(mobileSavedLocationCollection.safeParse(value).success).toBe(false);
  });

  it('rejects an unknown field nested in kmaGrid', () => {
    const value = [record('a', { sortOrder: 0, kmaGrid: { nx: 60, ny: 127, extra: 1 } as never })];
    expect(mobileSavedLocationCollection.safeParse(value).success).toBe(false);
  });

  it('rejects a single invalid record', () => {
    const value = [{ ...record('a', { sortOrder: 0 }), latitude: 91 }];
    expect(mobileSavedLocationCollection.safeParse(value).success).toBe(false);
  });

  it('rejects a non-array', () => {
    expect(mobileSavedLocationCollection.safeParse({}).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 15.3 — candidate schema
// ---------------------------------------------------------------------------

describe('mobileSavedLocationCandidate', () => {
  it('accepts a valid candidate', () => {
    expect(mobileSavedLocationCandidate.safeParse(candidate('a')).success).toBe(true);
  });

  it('accepts a current candidate', () => {
    expect(mobileSavedLocationCandidate.safeParse(candidate('a', { isCurrent: true })).success).toBe(
      true,
    );
  });

  it('accepts kmaGrid: null', () => {
    expect(mobileSavedLocationCandidate.safeParse(candidate('a', { kmaGrid: null })).success).toBe(
      true,
    );
  });

  it('rejects a candidate that carries sortOrder', () => {
    expect(
      mobileSavedLocationCandidate.safeParse({ ...candidate('a'), sortOrder: 0 }).success,
    ).toBe(false);
  });

  it('rejects a missing required field', () => {
    const { latitude: _omitted, ...withoutLatitude } = candidate('a');
    expect(mobileSavedLocationCandidate.safeParse(withoutLatitude).success).toBe(false);
  });

  it('rejects an invalid kmaGrid', () => {
    expect(
      mobileSavedLocationCandidate.safeParse(candidate('a', { kmaGrid: { nx: -1, ny: 0 } })).success,
    ).toBe(false);
  });

  it('rejects a non-boolean isCurrent', () => {
    expect(
      mobileSavedLocationCandidate.safeParse(candidate('a', { isCurrent: 'yes' })).success,
    ).toBe(false);
  });

  it('rejects an unknown field', () => {
    expect(mobileSavedLocationCandidate.safeParse({ ...candidate('a'), extra: 1 }).success).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// 15.4 — add
// ---------------------------------------------------------------------------

describe('addSavedLocation', () => {
  it('appends to an empty collection', () => {
    const locations = expectOk(addSavedLocation([], candidate('a')));
    expect(locations.map((location) => location.id)).toEqual(['a']);
    expect(locations[0].sortOrder).toBe(0);
  });

  it('appends to the end of an existing collection', () => {
    const start = collectionOf({ id: 'a' }, { id: 'b' });
    const locations = expectOk(addSavedLocation(start, candidate('c')));
    expect(locations.map((location) => location.id)).toEqual(['a', 'b', 'c']);
  });

  it('assigns sortOrder from the collection length, ignoring the caller', () => {
    const start = collectionOf({ id: 'a' }, { id: 'b' });
    const locations = expectOk(addSavedLocation(start, candidate('c')));
    expect(locations.map((location) => location.sortOrder)).toEqual([0, 1, 2]);
  });

  it('preserves an existing current when adding a normal record', () => {
    const start = collectionOf({ id: 'a', isCurrent: true });
    const locations = expectOk(addSavedLocation(start, candidate('b')));
    expect(locations.find((location) => location.id === 'a')?.isCurrent).toBe(true);
    expect(locations.find((location) => location.id === 'b')?.isCurrent).toBe(false);
  });

  it('adds a current candidate when the collection has no current', () => {
    const start = collectionOf({ id: 'a' });
    const locations = expectOk(addSavedLocation(start, candidate('b', { isCurrent: true })));
    expect(locations.find((location) => location.id === 'b')?.isCurrent).toBe(true);
  });

  it('rejects a duplicate id', () => {
    const start = collectionOf({ id: 'a' });
    expect(addSavedLocation(start, candidate('a'))).toEqual({
      ok: false,
      error: { kind: 'DUPLICATE_LOCATION_ID' },
    });
  });

  it('rejects a current candidate when a current location exists', () => {
    const start = collectionOf({ id: 'a', isCurrent: true });
    expect(addSavedLocation(start, candidate('b', { isCurrent: true }))).toEqual({
      ok: false,
      error: { kind: 'CURRENT_LOCATION_CONFLICT' },
    });
  });

  it('rejects an invalid candidate', () => {
    const start = collectionOf({ id: 'a' });
    expect(addSavedLocation(start, { nope: true })).toEqual({
      ok: false,
      error: { kind: 'INVALID_LOCATION' },
    });
  });

  it('prioritizes an invalid collection over an invalid candidate', () => {
    const invalidCollection = [record('a', { sortOrder: 5 })];
    expect(addSavedLocation(invalidCollection, { nope: true })).toEqual({
      ok: false,
      error: { kind: 'INVALID_COLLECTION' },
    });
  });

  it('does not mutate the inputs', () => {
    const start = collectionOf({ id: 'a', isCurrent: true });
    const candidateInput = candidate('b');
    const snapshot = JSON.stringify(start);
    const candidateSnapshot = JSON.stringify(candidateInput);
    deepFreeze(start);
    deepFreeze(candidateInput);
    expect(() => addSavedLocation(start, candidateInput)).not.toThrow();
    expect(JSON.stringify(start)).toBe(snapshot);
    expect(JSON.stringify(candidateInput)).toBe(candidateSnapshot);
  });

  it('returns fresh records and nested grids', () => {
    const start = collectionOf({ id: 'a' });
    const locations = expectOk(addSavedLocation(start, candidate('b')));
    expectFreshRecords(start, locations);
  });
});

// ---------------------------------------------------------------------------
// 15.5 — remove
// ---------------------------------------------------------------------------

describe('removeSavedLocation', () => {
  it('removes the first record', () => {
    const start = collectionOf({ id: 'a' }, { id: 'b' }, { id: 'c' });
    const locations = expectOk(removeSavedLocation(start, 'a'));
    expect(locations.map((location) => location.id)).toEqual(['b', 'c']);
  });

  it('removes a middle record', () => {
    const start = collectionOf({ id: 'a' }, { id: 'b' }, { id: 'c' });
    const locations = expectOk(removeSavedLocation(start, 'b'));
    expect(locations.map((location) => location.id)).toEqual(['a', 'c']);
  });

  it('removes the last record', () => {
    const start = collectionOf({ id: 'a' }, { id: 'b' }, { id: 'c' });
    const locations = expectOk(removeSavedLocation(start, 'c'));
    expect(locations.map((location) => location.id)).toEqual(['a', 'b']);
  });

  it('removes the current record and leaves no current', () => {
    const start = collectionOf({ id: 'a', isCurrent: true }, { id: 'b' });
    const locations = expectOk(removeSavedLocation(start, 'a'));
    expect(locations.some((location) => location.isCurrent)).toBe(false);
  });

  it('yields an empty collection when the last record is removed', () => {
    const start = collectionOf({ id: 'only' });
    const locations = expectOk(removeSavedLocation(start, 'only'));
    expect(locations).toEqual([]);
  });

  it('re-indexes sortOrder after removal', () => {
    const start = collectionOf({ id: 'a' }, { id: 'b' }, { id: 'c' });
    const locations = expectOk(removeSavedLocation(start, 'a'));
    expect(locations.map((location) => location.sortOrder)).toEqual([0, 1]);
  });

  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
  ])('rejects an invalid id (%s)', (_label, id) => {
    const start = collectionOf({ id: 'a' });
    expect(removeSavedLocation(start, id as unknown)).toEqual({
      ok: false,
      error: { kind: 'INVALID_LOCATION_ID' },
    });
  });

  it('reports a missing id', () => {
    const start = collectionOf({ id: 'a' });
    expect(removeSavedLocation(start, 'missing')).toEqual({
      ok: false,
      error: { kind: 'LOCATION_NOT_FOUND' },
    });
  });

  it('prioritizes an invalid collection over an invalid id', () => {
    const invalidCollection = [record('a', { sortOrder: 9 })];
    expect(removeSavedLocation(invalidCollection, '')).toEqual({
      ok: false,
      error: { kind: 'INVALID_COLLECTION' },
    });
  });

  it('does not mutate the input', () => {
    const start = collectionOf({ id: 'a' }, { id: 'b' });
    const snapshot = JSON.stringify(start);
    deepFreeze(start);
    expect(() => removeSavedLocation(start, 'a')).not.toThrow();
    expect(JSON.stringify(start)).toBe(snapshot);
  });

  it('returns fresh records and nested grids', () => {
    const start = collectionOf({ id: 'a' }, { id: 'b' });
    const locations = expectOk(removeSavedLocation(start, 'a'));
    expectFreshRecords(start, locations);
  });
});

// ---------------------------------------------------------------------------
// 15.6 — reorder
// ---------------------------------------------------------------------------

describe('reorderSavedLocations', () => {
  it('reverses the order', () => {
    const start = collectionOf({ id: 'a' }, { id: 'b' }, { id: 'c' });
    const locations = expectOk(reorderSavedLocations(start, ['c', 'b', 'a']));
    expect(locations.map((location) => location.id)).toEqual(['c', 'b', 'a']);
  });

  it('applies an arbitrary order', () => {
    const start = collectionOf({ id: 'a' }, { id: 'b' }, { id: 'c' });
    const locations = expectOk(reorderSavedLocations(start, ['b', 'a', 'c']));
    expect(locations.map((location) => location.id)).toEqual(['b', 'a', 'c']);
  });

  it('accepts a no-op reorder in the same order', () => {
    const start = collectionOf({ id: 'a' }, { id: 'b' });
    const locations = expectOk(reorderSavedLocations(start, ['a', 'b']));
    expect(locations.map((location) => location.id)).toEqual(['a', 'b']);
  });

  it('accepts an empty collection with an empty id list', () => {
    const locations = expectOk(reorderSavedLocations([], []));
    expect(locations).toEqual([]);
  });

  it('rewrites sortOrder to the new positions', () => {
    const start = collectionOf({ id: 'a' }, { id: 'b' }, { id: 'c' });
    const locations = expectOk(reorderSavedLocations(start, ['c', 'a', 'b']));
    expect(locations.map((location) => location.sortOrder)).toEqual([0, 1, 2]);
  });

  it('preserves the current flag', () => {
    const start = collectionOf({ id: 'a' }, { id: 'b', isCurrent: true });
    const locations = expectOk(reorderSavedLocations(start, ['b', 'a']));
    expect(locations.find((location) => location.id === 'b')?.isCurrent).toBe(true);
  });

  it('preserves kmaGrid', () => {
    const start = collectionOf(
      { id: 'a', kmaGrid: { nx: 1, ny: 2 } },
      { id: 'b', kmaGrid: null },
    );
    const locations = expectOk(reorderSavedLocations(start, ['b', 'a']));
    expect(locations.find((location) => location.id === 'a')?.kmaGrid).toEqual({ nx: 1, ny: 2 });
    expect(locations.find((location) => location.id === 'b')?.kmaGrid).toBeNull();
  });

  it('rejects a duplicate ordered id', () => {
    const start = collectionOf({ id: 'a' }, { id: 'b' });
    expect(reorderSavedLocations(start, ['a', 'a'])).toEqual({
      ok: false,
      error: { kind: 'INVALID_REORDER' },
    });
  });

  it('rejects a missing id', () => {
    const start = collectionOf({ id: 'a' }, { id: 'b' });
    expect(reorderSavedLocations(start, ['a'])).toEqual({
      ok: false,
      error: { kind: 'INVALID_REORDER' },
    });
  });

  it('rejects an extra / unknown id', () => {
    const start = collectionOf({ id: 'a' }, { id: 'b' });
    expect(reorderSavedLocations(start, ['a', 'b', 'c'])).toEqual({
      ok: false,
      error: { kind: 'INVALID_REORDER' },
    });
  });

  it('rejects a length mismatch (same set, wrong count)', () => {
    const start = collectionOf({ id: 'a' }, { id: 'b' });
    // Right ids but a duplicate makes the length exceed the collection.
    expect(reorderSavedLocations(start, ['a', 'b', 'a'])).toEqual({
      ok: false,
      error: { kind: 'INVALID_REORDER' },
    });
  });

  it('rejects an unknown id of the right length', () => {
    const start = collectionOf({ id: 'a' }, { id: 'b' });
    expect(reorderSavedLocations(start, ['a', 'x'])).toEqual({
      ok: false,
      error: { kind: 'INVALID_REORDER' },
    });
  });

  it.each([
    ['a non-array', 'a,b'],
    ['a non-string element', ['a', 2]],
    ['an empty-string element', ['a', '']],
  ])('rejects invalid orderedIds (%s)', (_label, orderedIds) => {
    const start = collectionOf({ id: 'a' }, { id: 'b' });
    expect(reorderSavedLocations(start, orderedIds as unknown)).toEqual({
      ok: false,
      error: { kind: 'INVALID_REORDER' },
    });
  });

  it('prioritizes an invalid collection over invalid orderedIds', () => {
    const invalidCollection = [record('a', { sortOrder: 4 })];
    expect(reorderSavedLocations(invalidCollection, 'nope')).toEqual({
      ok: false,
      error: { kind: 'INVALID_COLLECTION' },
    });
  });

  it('does not mutate the input', () => {
    const start = collectionOf({ id: 'a' }, { id: 'b' });
    const snapshot = JSON.stringify(start);
    deepFreeze(start);
    expect(() => reorderSavedLocations(start, ['b', 'a'])).not.toThrow();
    expect(JSON.stringify(start)).toBe(snapshot);
  });

  it('returns fresh records and nested grids, even for a no-op', () => {
    const start = collectionOf({ id: 'a' }, { id: 'b' });
    const locations = expectOk(reorderSavedLocations(start, ['a', 'b']));
    expectFreshRecords(start, locations);
  });
});

// ---------------------------------------------------------------------------
// 15.7 — set current
// ---------------------------------------------------------------------------

describe('setCurrentSavedLocation', () => {
  it('sets a current when none exists', () => {
    const start = collectionOf({ id: 'a' }, { id: 'b' });
    const locations = expectOk(setCurrentSavedLocation(start, 'b'));
    expect(locations.find((location) => location.id === 'b')?.isCurrent).toBe(true);
    expect(locations.find((location) => location.id === 'a')?.isCurrent).toBe(false);
  });

  it('replaces the existing current with another record', () => {
    const start = collectionOf({ id: 'a', isCurrent: true }, { id: 'b' });
    const locations = expectOk(setCurrentSavedLocation(start, 'b'));
    expect(locations.find((location) => location.id === 'a')?.isCurrent).toBe(false);
    expect(locations.find((location) => location.id === 'b')?.isCurrent).toBe(true);
  });

  it('re-sets the same target as a successful no-op', () => {
    const start = collectionOf({ id: 'a', isCurrent: true }, { id: 'b' });
    const locations = expectOk(setCurrentSavedLocation(start, 'a'));
    expect(locations.find((location) => location.id === 'a')?.isCurrent).toBe(true);
    expect(locations.filter((location) => location.isCurrent)).toHaveLength(1);
  });

  it('clears the current with null', () => {
    const start = collectionOf({ id: 'a', isCurrent: true }, { id: 'b' });
    const locations = expectOk(setCurrentSavedLocation(start, null));
    expect(locations.some((location) => location.isCurrent)).toBe(false);
  });

  it('accepts a null clear when there is already no current', () => {
    const start = collectionOf({ id: 'a' }, { id: 'b' });
    const locations = expectOk(setCurrentSavedLocation(start, null));
    expect(locations.some((location) => location.isCurrent)).toBe(false);
  });

  it('marks only the target current and every other record not current', () => {
    const start = collectionOf({ id: 'a' }, { id: 'b' }, { id: 'c' });
    const locations = expectOk(setCurrentSavedLocation(start, 'c'));
    expect(locations.filter((location) => location.isCurrent).map((location) => location.id)).toEqual(
      ['c'],
    );
  });

  it('keeps array order and sortOrder unchanged', () => {
    const start = collectionOf({ id: 'a' }, { id: 'b' }, { id: 'c' });
    const locations = expectOk(setCurrentSavedLocation(start, 'b'));
    expect(locations.map((location) => location.id)).toEqual(['a', 'b', 'c']);
    expect(locations.map((location) => location.sortOrder)).toEqual([0, 1, 2]);
  });

  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
    ['a number', 42],
    ['undefined', undefined],
  ])('rejects an invalid id (%s)', (_label, id) => {
    const start = collectionOf({ id: 'a' });
    expect(setCurrentSavedLocation(start, id as unknown)).toEqual({
      ok: false,
      error: { kind: 'INVALID_LOCATION_ID' },
    });
  });

  it('reports a missing id', () => {
    const start = collectionOf({ id: 'a' });
    expect(setCurrentSavedLocation(start, 'missing')).toEqual({
      ok: false,
      error: { kind: 'LOCATION_NOT_FOUND' },
    });
  });

  it('prioritizes an invalid collection over an invalid id', () => {
    const invalidCollection = [record('a', { sortOrder: 3 })];
    expect(setCurrentSavedLocation(invalidCollection, '')).toEqual({
      ok: false,
      error: { kind: 'INVALID_COLLECTION' },
    });
  });

  it('does not mutate the input', () => {
    const start = collectionOf({ id: 'a', isCurrent: true }, { id: 'b' });
    const snapshot = JSON.stringify(start);
    deepFreeze(start);
    expect(() => setCurrentSavedLocation(start, 'b')).not.toThrow();
    expect(() => setCurrentSavedLocation(start, null)).not.toThrow();
    expect(JSON.stringify(start)).toBe(snapshot);
  });

  it('returns fresh records and nested grids', () => {
    const start = collectionOf({ id: 'a' }, { id: 'b' });
    const locations = expectOk(setCurrentSavedLocation(start, 'a'));
    expectFreshRecords(start, locations);
  });
});

// ---------------------------------------------------------------------------
// 15.8 — error non-exposure
// ---------------------------------------------------------------------------

describe('collection operations — fixed, non-revealing errors', () => {
  /** A collection / candidate carrying the secret marker and secret coordinates. */
  const markedRecord = (id: string, overrides: Partial<MobileSavedLocation> = {}) =>
    record(id, {
      displayName: SECRET_MARKER,
      latitude: SECRET_LATITUDE,
      longitude: SECRET_LONGITUDE,
      kmaGrid: { nx: 321, ny: 654 },
      ...overrides,
    });

  const cases: { kind: string; run: () => SavedLocationCollectionResult }[] = [
    {
      kind: 'INVALID_COLLECTION',
      // Duplicate id → invalid collection; carries the marker and secret coordinates.
      run: () =>
        addSavedLocation(
          [markedRecord('dup', { sortOrder: 0 }), markedRecord('dup', { sortOrder: 1 })],
          candidate('x'),
        ),
    },
    {
      kind: 'INVALID_LOCATION',
      run: () =>
        addSavedLocation(collectionOf({ id: 'a' }), {
          displayName: SECRET_MARKER,
          latitude: SECRET_LATITUDE,
          longitude: SECRET_LONGITUDE,
          nope: true,
        }),
    },
    {
      kind: 'DUPLICATE_LOCATION_ID',
      run: () =>
        addSavedLocation(
          collectionOf({ id: 'a' }),
          candidate('a', {
            displayName: SECRET_MARKER,
            latitude: SECRET_LATITUDE,
            longitude: SECRET_LONGITUDE,
          }),
        ),
    },
    {
      kind: 'CURRENT_LOCATION_CONFLICT',
      run: () =>
        addSavedLocation(
          collectionOf({ id: 'a', isCurrent: true }),
          candidate('b', {
            isCurrent: true,
            displayName: SECRET_MARKER,
            latitude: SECRET_LATITUDE,
            longitude: SECRET_LONGITUDE,
          }),
        ),
    },
    {
      kind: 'INVALID_LOCATION_ID',
      run: () => removeSavedLocation([markedRecord('a', { sortOrder: 0 })], ''),
    },
    {
      kind: 'LOCATION_NOT_FOUND',
      run: () => removeSavedLocation([markedRecord('a', { sortOrder: 0 })], 'missing'),
    },
    {
      kind: 'INVALID_REORDER',
      run: () => reorderSavedLocations([markedRecord('a', { sortOrder: 0 })], ['nope']),
    },
  ];

  it.each(cases)('$kind serializes to only { kind } with nothing input-derived', ({ kind, run }) => {
    const result = run();
    expect(result).toEqual({ ok: false, error: { kind } });

    const serialized = JSON.stringify(result);
    expect(serialized).toBe(`{"ok":false,"error":{"kind":"${kind}"}}`);
    for (const forbidden of [
      SECRET_MARKER,
      String(SECRET_LATITUDE),
      String(SECRET_LONGITUDE),
      '321',
      '654',
      'issues',
      'path',
      'message',
      'stack',
      'cause',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it.each(cases)('$kind returns a fresh error object each call', ({ run }) => {
    const first = run();
    const second = run();
    expect(first).not.toBe(second);
    if (first.ok || second.ok) throw new Error('expected failures');
    expect(first.error).not.toBe(second.error);
  });

  it('never throws for hostile inputs', () => {
    expect(() => addSavedLocation(undefined, undefined)).not.toThrow();
    expect(() => removeSavedLocation(null, {})).not.toThrow();
    expect(() => reorderSavedLocations(42, Symbol('x') as unknown)).not.toThrow();
    expect(() => setCurrentSavedLocation('nope', {})).not.toThrow();
  });
});
