import { describe, expect, it } from 'vitest';

import { KmaForecastProduct } from '@life-weather/weather-core';

import { getKmaForecastField, groupKmaForecastItems } from './group-forecast-items';
import type { KmaForecastItem } from './raw-schema';

const SHORT = KmaForecastProduct.SHORT_FORECAST;
const ULTRA = KmaForecastProduct.ULTRA_SHORT_FORECAST;

/** Build a valid forecast item, overriding any field. Fresh object per call. */
function makeItem(overrides: Partial<KmaForecastItem> = {}): KmaForecastItem {
  return {
    baseDate: '20240127',
    baseTime: '0500',
    category: 'TMP',
    fcstDate: '20240127',
    fcstTime: '0600',
    fcstValue: '-2',
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

describe('groupKmaForecastItems — slot grouping', () => {
  it('groups multiple categories at the same forecast time into one slot', () => {
    const items = [
      makeItem({ category: 'TMP', fcstValue: '-2' }),
      makeItem({ category: 'SKY', fcstValue: '1' }),
      makeItem({ category: 'PTY', fcstValue: '0' }),
    ];
    const result = groupKmaForecastItems(SHORT, items);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.slots).toHaveLength(1);
      expect(result.slots[0].fields).toHaveLength(3);
    }
  });

  it('separates different forecast times into different slots', () => {
    const items = [makeItem({ fcstTime: '0600' }), makeItem({ fcstTime: '0700' })];
    const result = groupKmaForecastItems(SHORT, items);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.slots).toHaveLength(2);
    }
  });

  it('separates different grid points into different slots', () => {
    const items = [makeItem({ nx: 61, ny: 126 }), makeItem({ nx: 62, ny: 126 })];
    const result = groupKmaForecastItems(SHORT, items);
    expect(result.ok && result.slots).toHaveLength(2);
  });

  it('separates different base issuances into different slots', () => {
    const items = [makeItem({ baseTime: '0500' }), makeItem({ baseTime: '0800' })];
    const result = groupKmaForecastItems(SHORT, items);
    expect(result.ok && result.slots).toHaveLength(2);
  });

  it('reflects the product in slot identity', () => {
    const item = makeItem();
    const shortResult = groupKmaForecastItems(SHORT, [item]);
    const ultraResult = groupKmaForecastItems(ULTRA, [makeItem()]);
    if (shortResult.ok && ultraResult.ok) {
      expect(shortResult.slots[0].product).toBe(SHORT);
      expect(ultraResult.slots[0].product).toBe(ULTRA);
    } else {
      expect.fail('expected both groupings to succeed');
    }
  });
});

describe('groupKmaForecastItems — determinism & ordering', () => {
  it('produces the same output regardless of input order', () => {
    const a = [
      makeItem({ category: 'TMP', fcstTime: '0700' }),
      makeItem({ category: 'SKY', fcstTime: '0600' }),
      makeItem({ category: 'PTY', fcstTime: '0600' }),
    ];
    const b = [a[2], a[0], a[1]];
    expect(groupKmaForecastItems(SHORT, a)).toEqual(groupKmaForecastItems(SHORT, b));
  });

  it('sorts fields within a slot by category (code-unit ascending)', () => {
    const items = [
      makeItem({ category: 'TMP' }),
      makeItem({ category: 'PTY' }),
      makeItem({ category: 'SKY' }),
    ];
    const result = groupKmaForecastItems(SHORT, items);
    if (result.ok) {
      expect(result.slots[0].fields.map((field) => field.category)).toEqual(['PTY', 'SKY', 'TMP']);
    } else {
      expect.fail('expected ok');
    }
  });

  it('sorts slots deterministically by forecast target', () => {
    const items = [
      makeItem({ fcstDate: '20240128', fcstTime: '0600' }),
      makeItem({ fcstDate: '20240127', fcstTime: '0700' }),
      makeItem({ fcstDate: '20240127', fcstTime: '0600' }),
    ];
    const result = groupKmaForecastItems(SHORT, items);
    if (result.ok) {
      expect(
        result.slots.map((slot) => `${slot.forecastDate}${slot.forecastTime}`),
      ).toEqual(['202401270600', '202401270700', '202401280600']);
    } else {
      expect.fail('expected ok');
    }
  });
});

describe('groupKmaForecastItems — field presence (ABSENT / NULL / VALUE)', () => {
  it('records an explicit null fcstValue as NULL and a real value as VALUE', () => {
    const items = [
      makeItem({ category: 'PCP', fcstValue: null }),
      makeItem({ category: 'TMP', fcstValue: '-2' }),
    ];
    const result = groupKmaForecastItems(SHORT, items);
    if (result.ok) {
      const [slot] = result.slots;
      expect(getKmaForecastField(slot, 'PCP')).toEqual({ state: 'NULL' });
      expect(getKmaForecastField(slot, 'TMP')).toEqual({ state: 'VALUE', value: '-2' });
    } else {
      expect.fail('expected ok');
    }
  });

  it('reports a category that has no item as ABSENT', () => {
    const result = groupKmaForecastItems(SHORT, [makeItem({ category: 'TMP' })]);
    if (result.ok) {
      expect(getKmaForecastField(result.slots[0], 'SNO')).toEqual({ state: 'ABSENT' });
    } else {
      expect.fail('expected ok');
    }
  });

  it('distinguishes all three states via getKmaForecastField', () => {
    const items = [makeItem({ category: 'TMP', fcstValue: '-2' }), makeItem({ category: 'PCP', fcstValue: null })];
    const result = groupKmaForecastItems(SHORT, items);
    if (result.ok) {
      const [slot] = result.slots;
      expect(getKmaForecastField(slot, 'TMP').state).toBe('VALUE');
      expect(getKmaForecastField(slot, 'PCP').state).toBe('NULL');
      expect(getKmaForecastField(slot, 'SKY').state).toBe('ABSENT');
    } else {
      expect.fail('expected ok');
    }
  });

  it('preserves an unknown/future category', () => {
    const result = groupKmaForecastItems(SHORT, [makeItem({ category: 'ZZZ', fcstValue: '7' })]);
    if (result.ok) {
      expect(getKmaForecastField(result.slots[0], 'ZZZ')).toEqual({ state: 'VALUE', value: '7' });
    } else {
      expect.fail('expected ok');
    }
  });
});

describe('groupKmaForecastItems — duplicate category', () => {
  it('returns DUPLICATE_CATEGORY when a category repeats within a slot', () => {
    const items = [
      makeItem({ category: 'TMP', fcstValue: '-2' }),
      makeItem({ category: 'TMP', fcstValue: '-1' }),
    ];
    const result = groupKmaForecastItems(SHORT, items);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('DUPLICATE_CATEGORY');
      expect(result.error.category).toBe('TMP');
      expect(result.error.slotKey).toContain('SHORT_FORECAST');
    }
  });

  it('treats an identical repeated value as a duplicate error too (no last-write-wins)', () => {
    const items = [
      makeItem({ category: 'TMP', fcstValue: '-2' }),
      makeItem({ category: 'TMP', fcstValue: '-2' }),
    ];
    const result = groupKmaForecastItems(SHORT, items);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('DUPLICATE_CATEGORY');
    }
  });

  it('reports the same duplicate regardless of input order', () => {
    const items = [
      makeItem({ category: 'PTY', fcstValue: '0' }),
      makeItem({ category: 'TMP', fcstValue: '-2' }),
      makeItem({ category: 'PTY', fcstValue: '1' }),
    ];
    const forward = groupKmaForecastItems(SHORT, items);
    const reversed = groupKmaForecastItems(SHORT, [...items].reverse());
    expect(forward).toEqual(reversed);
  });

  it('does not treat the same category in different slots as a duplicate', () => {
    const items = [
      makeItem({ category: 'TMP', fcstTime: '0600' }),
      makeItem({ category: 'TMP', fcstTime: '0700' }),
    ];
    const result = groupKmaForecastItems(SHORT, items);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.slots).toHaveLength(2);
    }
  });
});

describe('groupKmaForecastItems — purity', () => {
  it('does not mutate the input array or item objects', () => {
    const items = [makeItem({ category: 'TMP' }), makeItem({ category: 'SKY' })];
    const snapshot = structuredClone(items);
    deepFreeze(items);
    expect(() => groupKmaForecastItems(SHORT, items)).not.toThrow();
    expect(items).toEqual(snapshot);
  });

  it('is deterministic', () => {
    const items = [makeItem({ category: 'SKY' }), makeItem({ category: 'TMP' })];
    expect(groupKmaForecastItems(SHORT, items)).toEqual(groupKmaForecastItems(SHORT, items));
  });
});

describe('getKmaForecastField', () => {
  it('returns ABSENT for a category on a slot with no such field', () => {
    const result = groupKmaForecastItems(SHORT, [makeItem({ category: 'TMP' })]);
    if (result.ok) {
      expect(getKmaForecastField(result.slots[0], 'DOES_NOT_EXIST')).toEqual({ state: 'ABSENT' });
    } else {
      expect.fail('expected ok');
    }
  });
});
