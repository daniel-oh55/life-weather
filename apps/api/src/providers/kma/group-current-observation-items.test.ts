import { describe, expect, it } from 'vitest';

import {
  getKmaCurrentObservationField,
  groupKmaCurrentObservationItems,
} from './group-current-observation-items.js';
import type { KmaCurrentObservationItem } from './current-raw-schema.js';

/** Build a valid current-observation item, overriding any field. Fresh object per call. */
function makeItem(overrides: Partial<KmaCurrentObservationItem> = {}): KmaCurrentObservationItem {
  return {
    baseDate: '20260716',
    baseTime: '0600',
    category: 'T1H',
    obsrValue: '23.5',
    nx: 61,
    ny: 126,
    ...overrides,
  };
}

/** Recursively freeze so any mutation of the input would throw. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

describe('groupKmaCurrentObservationItems — slot grouping', () => {
  it('groups multiple categories at the same observation into one slot', () => {
    const items = [
      makeItem({ category: 'T1H', obsrValue: '23.5' }),
      makeItem({ category: 'REH', obsrValue: '55' }),
      makeItem({ category: 'PTY', obsrValue: '0' }),
    ];
    const result = groupKmaCurrentObservationItems(items);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.slots).toHaveLength(1);
      expect(result.slots[0]!.fields).toHaveLength(3);
    }
  });

  it('separates different base times into different slots', () => {
    const items = [makeItem({ baseTime: '0600' }), makeItem({ baseTime: '0700' })];
    const result = groupKmaCurrentObservationItems(items);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.slots).toHaveLength(2);
    }
  });

  it('separates different grid points into different slots', () => {
    const items = [makeItem({ nx: 61, ny: 126 }), makeItem({ nx: 62, ny: 126 })];
    const result = groupKmaCurrentObservationItems(items);
    expect(result.ok && result.slots).toHaveLength(2);
  });

  it('separates different base dates into different slots', () => {
    const items = [makeItem({ baseDate: '20260716' }), makeItem({ baseDate: '20260717' })];
    const result = groupKmaCurrentObservationItems(items);
    expect(result.ok && result.slots).toHaveLength(2);
  });

  it('a slot has no category field: the slot identity excludes category', () => {
    const result = groupKmaCurrentObservationItems([makeItem()]);
    if (result.ok) {
      expect('category' in result.slots[0]!).toBe(false);
    } else {
      expect.fail('expected ok');
    }
  });
});

describe('groupKmaCurrentObservationItems — determinism & ordering', () => {
  it('produces the same output regardless of input order', () => {
    const a = [
      makeItem({ category: 'T1H', baseTime: '0700' }),
      makeItem({ category: 'REH', baseTime: '0600' }),
      makeItem({ category: 'PTY', baseTime: '0600' }),
    ];
    const b = [a[2]!, a[0]!, a[1]!];
    expect(groupKmaCurrentObservationItems(a)).toEqual(groupKmaCurrentObservationItems(b));
  });

  it('sorts fields within a slot by category (code-unit ascending)', () => {
    const items = [
      makeItem({ category: 'T1H' }),
      makeItem({ category: 'PTY' }),
      makeItem({ category: 'REH' }),
    ];
    const result = groupKmaCurrentObservationItems(items);
    if (result.ok) {
      expect(result.slots[0]!.fields.map((field) => field.category)).toEqual([
        'PTY',
        'REH',
        'T1H',
      ]);
    } else {
      expect.fail('expected ok');
    }
  });

  it('sorts slots deterministically by base issuance then grid', () => {
    const items = [
      makeItem({ baseDate: '20260717', baseTime: '0600', nx: 61, ny: 126 }),
      makeItem({ baseDate: '20260716', baseTime: '0700', nx: 61, ny: 126 }),
      makeItem({ baseDate: '20260716', baseTime: '0600', nx: 62, ny: 126 }),
      makeItem({ baseDate: '20260716', baseTime: '0600', nx: 61, ny: 126 }),
    ];
    const result = groupKmaCurrentObservationItems(items);
    if (result.ok) {
      expect(
        result.slots.map((slot) => `${slot.baseDate}${slot.baseTime}-${slot.nx},${slot.ny}`),
      ).toEqual([
        '202607160600-61,126',
        '202607160600-62,126',
        '202607160700-61,126',
        '202607170600-61,126',
      ]);
    } else {
      expect.fail('expected ok');
    }
  });
});

describe('groupKmaCurrentObservationItems — field presence (ABSENT / NULL / VALUE)', () => {
  it('records an explicit null obsrValue as NULL and a real value as VALUE', () => {
    const items = [
      makeItem({ category: 'RN1', obsrValue: null }),
      makeItem({ category: 'T1H', obsrValue: '23.5' }),
    ];
    const result = groupKmaCurrentObservationItems(items);
    if (result.ok) {
      const [slot] = result.slots;
      expect(getKmaCurrentObservationField(slot!, 'RN1')).toEqual({ state: 'NULL' });
      expect(getKmaCurrentObservationField(slot!, 'T1H')).toEqual({
        state: 'VALUE',
        value: '23.5',
      });
    } else {
      expect.fail('expected ok');
    }
  });

  it('reports a category that has no item as ABSENT', () => {
    const result = groupKmaCurrentObservationItems([makeItem({ category: 'T1H' })]);
    if (result.ok) {
      expect(getKmaCurrentObservationField(result.slots[0]!, 'VEC')).toEqual({
        state: 'ABSENT',
      });
    } else {
      expect.fail('expected ok');
    }
  });

  it('distinguishes all three states via getKmaCurrentObservationField', () => {
    const items = [
      makeItem({ category: 'T1H', obsrValue: '23.5' }),
      makeItem({ category: 'RN1', obsrValue: null }),
    ];
    const result = groupKmaCurrentObservationItems(items);
    if (result.ok) {
      const [slot] = result.slots;
      expect(getKmaCurrentObservationField(slot!, 'T1H').state).toBe('VALUE');
      expect(getKmaCurrentObservationField(slot!, 'RN1').state).toBe('NULL');
      expect(getKmaCurrentObservationField(slot!, 'VEC').state).toBe('ABSENT');
    } else {
      expect.fail('expected ok');
    }
  });

  it('preserves a raw "0" obsrValue exactly', () => {
    const result = groupKmaCurrentObservationItems([
      makeItem({ category: 'RN1', obsrValue: '0' }),
    ]);
    if (result.ok) {
      expect(getKmaCurrentObservationField(result.slots[0]!, 'RN1')).toEqual({
        state: 'VALUE',
        value: '0',
      });
    } else {
      expect.fail('expected ok');
    }
  });

  it('preserves a negative raw temperature obsrValue exactly', () => {
    const result = groupKmaCurrentObservationItems([
      makeItem({ category: 'T1H', obsrValue: '-5.3' }),
    ]);
    if (result.ok) {
      expect(getKmaCurrentObservationField(result.slots[0]!, 'T1H')).toEqual({
        state: 'VALUE',
        value: '-5.3',
      });
    } else {
      expect.fail('expected ok');
    }
  });

  it('preserves an unknown/future category', () => {
    const result = groupKmaCurrentObservationItems([
      makeItem({ category: 'ZZZ', obsrValue: '7' }),
    ]);
    if (result.ok) {
      expect(getKmaCurrentObservationField(result.slots[0]!, 'ZZZ')).toEqual({
        state: 'VALUE',
        value: '7',
      });
    } else {
      expect.fail('expected ok');
    }
  });
});

describe('groupKmaCurrentObservationItems — duplicate category', () => {
  it('returns DUPLICATE_CATEGORY when a category repeats within a slot', () => {
    const items = [
      makeItem({ category: 'T1H', obsrValue: '23.5' }),
      makeItem({ category: 'T1H', obsrValue: '24.0' }),
    ];
    const result = groupKmaCurrentObservationItems(items);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('DUPLICATE_CATEGORY');
      expect(result.error.category).toBe('T1H');
      expect(result.error.slotKey).toContain('20260716');
    }
  });

  it('treats an identical repeated value as a duplicate error too (no last-write-wins)', () => {
    const items = [
      makeItem({ category: 'T1H', obsrValue: '23.5' }),
      makeItem({ category: 'T1H', obsrValue: '23.5' }),
    ];
    const result = groupKmaCurrentObservationItems(items);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('DUPLICATE_CATEGORY');
    }
  });

  it('reports the same duplicate regardless of input order', () => {
    const items = [
      makeItem({ category: 'PTY', obsrValue: '0' }),
      makeItem({ category: 'T1H', obsrValue: '23.5' }),
      makeItem({ category: 'PTY', obsrValue: '1' }),
    ];
    const forward = groupKmaCurrentObservationItems(items);
    const reversed = groupKmaCurrentObservationItems([...items].reverse());
    expect(forward).toEqual(reversed);
  });

  it('does not treat the same category in different slots as a duplicate', () => {
    const items = [
      makeItem({ category: 'T1H', baseTime: '0600' }),
      makeItem({ category: 'T1H', baseTime: '0700' }),
    ];
    const result = groupKmaCurrentObservationItems(items);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.slots).toHaveLength(2);
    }
  });
});

describe('groupKmaCurrentObservationItems — purity', () => {
  it('does not mutate the input array or item objects', () => {
    const items = [makeItem({ category: 'T1H' }), makeItem({ category: 'REH' })];
    const snapshot = structuredClone(items);
    deepFreeze(items);
    expect(() => groupKmaCurrentObservationItems(items)).not.toThrow();
    expect(items).toEqual(snapshot);
  });

  it('is deterministic', () => {
    const items = [makeItem({ category: 'REH' }), makeItem({ category: 'T1H' })];
    expect(groupKmaCurrentObservationItems(items)).toEqual(
      groupKmaCurrentObservationItems(items),
    );
  });

  it('returns ok:true with no slots for an empty item array', () => {
    const result = groupKmaCurrentObservationItems([]);
    expect(result).toEqual({ ok: true, slots: [] });
  });
});
