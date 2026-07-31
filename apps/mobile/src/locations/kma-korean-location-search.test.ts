import { describe, expect, it } from 'vitest';

import { kmaKoreanLocationCatalog } from './catalog/kma-korean-location-catalog';
import { searchKmaKoreanLocations } from './kma-korean-location-search';

describe('invalid input handling', () => {
  it.each([null, undefined, 42, true, {}, []])(
    'returns INVALID_QUERY for non-string query %p',
    (value) => {
      const result = searchKmaKoreanLocations(value);
      expect(result).toEqual({ ok: false, error: { kind: 'INVALID_QUERY' } });
    },
  );

  it('returns a successful empty result for an empty string query', () => {
    expect(searchKmaKoreanLocations('')).toEqual({ ok: true, locations: [] });
  });

  it('returns a successful empty result for a whitespace-only query', () => {
    expect(searchKmaKoreanLocations('   ')).toEqual({ ok: true, locations: [] });
  });

  it('returns a successful empty result for a single-character query', () => {
    expect(searchKmaKoreanLocations('강')).toEqual({ ok: true, locations: [] });
  });

  it.each([0, -1, 1.5, '30', null, NaN, 51])('returns INVALID_LIMIT for limit %p', (limit) => {
    const result = searchKmaKoreanLocations('강남구', { limit: limit as never });
    expect(result).toEqual({ ok: false, error: { kind: 'INVALID_LIMIT' } });
  });

  it('accepts a valid limit at the boundaries (1 and 50)', () => {
    expect(searchKmaKoreanLocations('강남구', { limit: 1 }).ok).toBe(true);
    expect(searchKmaKoreanLocations('강남구', { limit: 50 }).ok).toBe(true);
  });

  it('does not mutate the query input', () => {
    const query = '  강남 구  ';
    const original = query;
    searchKmaKoreanLocations(query);
    expect(query).toBe(original);
  });
});

describe('normalization', () => {
  it('treats internal whitespace as insignificant: "서울 강남" and "서울강남" yield identical results', () => {
    const spaced = searchKmaKoreanLocations('서울 강남');
    const unspaced = searchKmaKoreanLocations('서울강남');
    expect(spaced.ok).toBe(true);
    expect(unspaced.ok).toBe(true);
    if (!spaced.ok || !unspaced.ok) {
      return;
    }
    expect(spaced.locations.map((entry) => entry.id)).toEqual(
      unspaced.locations.map((entry) => entry.id),
    );
  });

  it('treats a full-width (U+3000) internal space the same as a regular space, with real matches', () => {
    const withFullWidthSpace = searchKmaKoreanLocations('강남　구');
    const withRegularSpace = searchKmaKoreanLocations('강남 구');
    expect(withFullWidthSpace).toEqual(withRegularSpace);
    expect(withFullWidthSpace.ok && withFullWidthSpace.locations.length).toBeGreaterThan(0);
  });

});

describe('ranking', () => {
  it('ranks the exact displayName match "강남구" first, ahead of its dong-level children', () => {
    const result = searchKmaKoreanLocations('강남구');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.locations.length).toBeGreaterThan(1);
    expect(result.locations[0]?.displayName).toBe('강남구');
    expect(result.locations[0]?.fullName).toBe('서울특별시 강남구');
    // Every other result is a real Gangnam-gu neighborhood, not an unrelated substring match.
    for (const entry of result.locations.slice(1)) {
      expect(entry.adminArea2).toBe('강남구');
    }
  });

  it('breaks same-tier ties by officialOrder ascending', () => {
    const result = searchKmaKoreanLocations('강남구');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // locations[0] is the tier-1 exact displayName match; every remaining result is a tier-2 admin
    // exact match on the same tier, so within that group officialOrder must already be ascending.
    const tier2Orders = result.locations.slice(1).map((entry) => entry.officialOrder);
    expect(tier2Orders).toEqual([...tier2Orders].sort((a, b) => a - b));
  });

  it('distinguishes same-name locations in different regions by fullName (중앙동)', () => {
    const result = searchKmaKoreanLocations('중앙동', { limit: 50 });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const fullNames = result.locations.map((entry) => entry.fullName);
    expect(fullNames).toContain('서울특별시 관악구 중앙동');
    expect(fullNames).toContain('부산광역시 중구 중앙동');
    expect(fullNames).toContain('제주특별자치도 서귀포시 중앙동');
    expect(new Set(fullNames).size).toBe(fullNames.length);
  });

  it('respects the default limit of 30 (there are more than 30 real 중앙-matching entries)', () => {
    const result = searchKmaKoreanLocations('중앙');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.locations.length).toBe(30);
  });

  it('respects an explicit smaller limit deterministically', () => {
    const first = searchKmaKoreanLocations('중앙', { limit: 5 });
    const second = searchKmaKoreanLocations('중앙', { limit: 5 });
    expect(first).toEqual(second);
    expect(first.ok && first.locations.length).toBe(5);
  });
});

describe('purity and boundaries', () => {
  it('returns entries that are the catalog\'s own frozen references', () => {
    const result = searchKmaKoreanLocations('강남구');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    for (const entry of result.locations) {
      expect(kmaKoreanLocationCatalog.includes(entry)).toBe(true);
      expect(Object.isFrozen(entry)).toBe(true);
    }
  });

  it('returns a fresh array each call', () => {
    const first = searchKmaKoreanLocations('강남구');
    const second = searchKmaKoreanLocations('강남구');
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }
    expect(first.locations).not.toBe(second.locations);
    expect(first.locations).toEqual(second.locations);
  });

  it('never throws for hostile input', () => {
    const hostiles: unknown[] = [
      Symbol('x'),
      () => {},
      new Proxy({}, {}),
      { toString: () => 'x' },
      '﷽'.repeat(1000),
    ];
    for (const hostile of hostiles) {
      expect(() => searchKmaKoreanLocations(hostile)).not.toThrow();
    }
  });
});
