import { describe, expect, it } from 'vitest';

import { kmaKoreanLocationCatalog, type KmaKoreanLocationCatalogEntry } from './catalog/kma-korean-location-catalog';
import { createSavedLocationCandidateFromKmaCatalogEntry } from './kma-korean-location-candidate';
import { mobileSavedLocationCandidate } from './mobile-saved-location-collection';

const REAL_ENTRY: KmaKoreanLocationCatalogEntry = kmaKoreanLocationCatalog.find(
  (entry) => entry.fullName === '서울특별시 강남구',
) as KmaKoreanLocationCatalogEntry;

describe('successful mapping', () => {
  it('maps every field explicitly and matches the existing candidate schema', () => {
    const result = createSavedLocationCandidateFromKmaCatalogEntry(REAL_ENTRY);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(mobileSavedLocationCandidate.safeParse(result.candidate).success).toBe(true);
    expect(result.candidate).toEqual({
      id: REAL_ENTRY.id,
      displayName: REAL_ENTRY.displayName,
      countryCode: 'KR',
      adminArea1: REAL_ENTRY.adminArea1,
      adminArea2: REAL_ENTRY.adminArea2,
      adminArea3: REAL_ENTRY.adminArea3,
      latitude: REAL_ENTRY.latitude,
      longitude: REAL_ENTRY.longitude,
      timezone: 'Asia/Seoul',
      kmaGrid: { nx: REAL_ENTRY.kmaGrid.nx, ny: REAL_ENTRY.kmaGrid.ny },
      isCurrent: false,
    });
  });

  it('never includes sortOrder', () => {
    const result = createSavedLocationCandidateFromKmaCatalogEntry(REAL_ENTRY);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.candidate).not.toHaveProperty('sortOrder');
  });

  it('never leaks fullName, officialOrder, or any source-only field', () => {
    const result = createSavedLocationCandidateFromKmaCatalogEntry(REAL_ENTRY);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.candidate).not.toHaveProperty('fullName');
    expect(result.candidate).not.toHaveProperty('officialOrder');
    expect(result.candidate).not.toHaveProperty('officialAdministrativeCode');
  });

  it('sets isCurrent to false unconditionally', () => {
    const result = createSavedLocationCandidateFromKmaCatalogEntry(REAL_ENTRY);
    expect(result.ok).toBe(true);
    expect(result.ok && result.candidate.isCurrent).toBe(false);
  });

  it('returns a fresh candidate object and a fresh kmaGrid object on every call', () => {
    const first = createSavedLocationCandidateFromKmaCatalogEntry(REAL_ENTRY);
    const second = createSavedLocationCandidateFromKmaCatalogEntry(REAL_ENTRY);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }
    expect(first.candidate).not.toBe(second.candidate);
    expect(first.candidate.kmaGrid).not.toBe(second.candidate.kmaGrid);
    expect(first.candidate).toEqual(second.candidate);
  });

  it('does not mutate the input catalog entry', () => {
    const before = JSON.stringify(REAL_ENTRY);
    createSavedLocationCandidateFromKmaCatalogEntry(REAL_ENTRY);
    expect(JSON.stringify(REAL_ENTRY)).toBe(before);
  });

  it('maps a real province-only entry (adminArea2/3 null) correctly', () => {
    const provinceEntry = kmaKoreanLocationCatalog.find(
      (entry) => entry.adminArea1 === '제주특별자치도' && entry.adminArea2 === null,
    );
    expect(provinceEntry).toBeDefined();
    if (provinceEntry === undefined) {
      return;
    }
    const result = createSavedLocationCandidateFromKmaCatalogEntry(provinceEntry);
    expect(result.ok).toBe(true);
    expect(result.ok && result.candidate.adminArea2).toBeNull();
    expect(result.ok && result.candidate.adminArea3).toBeNull();
  });
});

describe('invalid input handling', () => {
  it.each([null, undefined, 42, 'not-an-object', [], {}])(
    'returns a fixed INVALID_CATALOG_ENTRY error for %p',
    (value) => {
      const result = createSavedLocationCandidateFromKmaCatalogEntry(value);
      expect(result).toEqual({ ok: false, error: { kind: 'INVALID_CATALOG_ENTRY' } });
    },
  );

  it('rejects an entry with a tampered/missing required field', () => {
    const tampered = { ...REAL_ENTRY, latitude: 'not-a-number' };
    const result = createSavedLocationCandidateFromKmaCatalogEntry(tampered);
    expect(result).toEqual({ ok: false, error: { kind: 'INVALID_CATALOG_ENTRY' } });
  });

  it('rejects an entry with unknown extra fields (strict schema)', () => {
    const withExtra = { ...REAL_ENTRY, unexpectedField: 'x' };
    const result = createSavedLocationCandidateFromKmaCatalogEntry(withExtra);
    expect(result).toEqual({ ok: false, error: { kind: 'INVALID_CATALOG_ENTRY' } });
  });

  it('never throws for hostile input', () => {
    const hostiles: unknown[] = [Symbol('x'), () => {}, new Proxy({}, {})];
    for (const hostile of hostiles) {
      expect(() => createSavedLocationCandidateFromKmaCatalogEntry(hostile)).not.toThrow();
    }
  });
});
