import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { KMA_KOREAN_LOCATION_CATALOG_RAW_ROWS } from './kma-korean-location-catalog.generated';
import { kmaKoreanLocationCatalog, kmaKoreanLocationCatalogEntry } from './kma-korean-location-catalog';
import { kmaKoreanLocationSourceManifest } from './kma-korean-location-source-manifest';

const SOURCE_TSV_PATH = new URL('./kma-korean-location-source.tsv', import.meta.url);

function readSourceTsvLines(): string[] {
  const content = readFileSync(SOURCE_TSV_PATH, 'utf-8');
  // Trailing newline produces one empty trailing element after split; drop it.
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

describe('source manifest integrity', () => {
  it('matches the committed source TSV row count exactly', () => {
    const lines = readSourceTsvLines();
    // -1 for the header row.
    expect(lines.length - 1).toBe(kmaKoreanLocationSourceManifest.sourceRowCount);
  });

  it('matches the committed source TSV content SHA-256 exactly', () => {
    const content = readFileSync(SOURCE_TSV_PATH, 'utf-8');
    const digest = createHash('sha256').update(content, 'utf-8').digest('hex');
    expect(digest).toBe(kmaKoreanLocationSourceManifest.sourceSha256);
  });

  it('matches the generated catalog row count exactly', () => {
    expect(kmaKoreanLocationCatalog.length).toBe(kmaKoreanLocationSourceManifest.generatedRowCount);
    expect(KMA_KOREAN_LOCATION_CATALOG_RAW_ROWS.length).toBe(
      kmaKoreanLocationSourceManifest.generatedRowCount,
    );
  });

  it('excludes exactly the two known zero-coordinate source rows (이어도)', () => {
    const lines = readSourceTsvLines();
    const dataLines = lines.slice(1);
    const zeroCoordinateLines = dataLines.filter((line) => {
      const [, , , , latitude, longitude] = line.split('\t');
      return latitude === '0.0' && longitude === '0.0';
    });
    expect(zeroCoordinateLines).toHaveLength(2);
    expect(dataLines.length - zeroCoordinateLines.length).toBe(kmaKoreanLocationCatalog.length);
  });
});

describe('catalog schema validity', () => {
  it('every entry parses against the strict public schema', () => {
    for (const entry of kmaKoreanLocationCatalog) {
      expect(kmaKoreanLocationCatalogEntry.safeParse(entry).success).toBe(true);
    }
  });

  it('has no fields beyond the public schema (officialAdministrativeCode, fullName-only concerns excluded correctly)', () => {
    const entry = kmaKoreanLocationCatalog[0] as unknown as Record<string, unknown>;
    expect(entry).not.toHaveProperty('officialAdministrativeCode');
  });

  it('every latitude/longitude is finite and within reasonable Korea bounds', () => {
    for (const entry of kmaKoreanLocationCatalog) {
      expect(Number.isFinite(entry.latitude)).toBe(true);
      expect(Number.isFinite(entry.longitude)).toBe(true);
      expect(entry.latitude).toBeGreaterThanOrEqual(32);
      expect(entry.latitude).toBeLessThanOrEqual(39.5);
      expect(entry.longitude).toBeGreaterThanOrEqual(124);
      expect(entry.longitude).toBeLessThanOrEqual(132);
    }
  });

  it('every kmaGrid nx/ny is a finite non-negative integer', () => {
    for (const entry of kmaKoreanLocationCatalog) {
      expect(Number.isInteger(entry.kmaGrid.nx)).toBe(true);
      expect(Number.isInteger(entry.kmaGrid.ny)).toBe(true);
      expect(entry.kmaGrid.nx).toBeGreaterThanOrEqual(0);
      expect(entry.kmaGrid.ny).toBeGreaterThanOrEqual(0);
    }
  });

  it('every entry is KR / Asia/Seoul', () => {
    for (const entry of kmaKoreanLocationCatalog) {
      expect(entry.countryCode).toBe('KR');
      expect(entry.timezone).toBe('Asia/Seoul');
    }
  });

  it('adminArea2/adminArea3 are never empty strings — only a non-empty string or null', () => {
    for (const entry of kmaKoreanLocationCatalog) {
      expect(entry.adminArea2).not.toBe('');
      expect(entry.adminArea3).not.toBe('');
      if (entry.adminArea2 !== null) {
        expect(entry.adminArea2.length).toBeGreaterThan(0);
      }
      if (entry.adminArea3 !== null) {
        expect(entry.adminArea3.length).toBeGreaterThan(0);
      }
    }
  });

  it('has at least one entry at each admin depth (province-only, city/county, and dong/myeon/eup)', () => {
    const provinceOnly = kmaKoreanLocationCatalog.filter(
      (entry) => entry.adminArea2 === null && entry.adminArea3 === null,
    );
    const cityCountyOnly = kmaKoreanLocationCatalog.filter(
      (entry) => entry.adminArea2 !== null && entry.adminArea3 === null,
    );
    const dongLevel = kmaKoreanLocationCatalog.filter((entry) => entry.adminArea3 !== null);

    expect(provinceOnly.length).toBeGreaterThan(0);
    expect(cityCountyOnly.length).toBeGreaterThan(0);
    expect(dongLevel.length).toBeGreaterThan(0);
  });
});

describe('id policy', () => {
  it('every id is unique', () => {
    const ids = kmaKoreanLocationCatalog.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every id matches the fixed opaque format and never contains its raw source code', () => {
    for (const row of KMA_KOREAN_LOCATION_CATALOG_RAW_ROWS) {
      const [officialAdministrativeCode, id] = row;
      expect(id).toMatch(/^kr_[0-9a-f]{24}$/);
      expect(id.includes(officialAdministrativeCode)).toBe(false);
    }
  });

  it('the same source row always yields the same id (deterministic, re-derivable)', async () => {
    const { createHash: nodeCreateHash } = await import('node:crypto');
    for (const row of KMA_KOREAN_LOCATION_CATALOG_RAW_ROWS.slice(0, 25)) {
      const [officialAdministrativeCode, id] = row;
      const digest = nodeCreateHash('sha256')
        .update(`life-weather:kma-location-v1:${officialAdministrativeCode}`, 'utf-8')
        .digest('hex');
      expect(id).toBe(`kr_${digest.slice(0, 24)}`);
    }
  });

  it('no raw source administrative code is duplicated', () => {
    const codes = KMA_KOREAN_LOCATION_CATALOG_RAW_ROWS.map((row) => row[0]);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('officialOrder', () => {
  it('is dense, ascending, and matches array position exactly', () => {
    kmaKoreanLocationCatalog.forEach((entry, index) => {
      expect(entry.officialOrder).toBe(index + 1);
    });
  });
});

describe('display/full name policy', () => {
  it('displayName is adminArea3, falling back to adminArea2, falling back to adminArea1', () => {
    for (const entry of kmaKoreanLocationCatalog) {
      const expected = entry.adminArea3 ?? entry.adminArea2 ?? entry.adminArea1;
      expect(entry.displayName).toBe(expected);
    }
  });

  it('fullName joins the non-null admin areas with a single space', () => {
    for (const entry of kmaKoreanLocationCatalog) {
      const expected = [entry.adminArea1, entry.adminArea2, entry.adminArea3]
        .filter((part): part is string => part !== null)
        .join(' ');
      expect(entry.fullName).toBe(expected);
    }
  });
});

describe('representative regions are present in the real production catalog', () => {
  it('covers Seoul (서울권)', () => {
    expect(kmaKoreanLocationCatalog.some((entry) => entry.adminArea1 === '서울특별시')).toBe(true);
  });

  it('covers a metropolitan city (광역시) other than Seoul', () => {
    const metros = ['부산광역시', '대구광역시', '인천광역시', '대전광역시', '울산광역시'];
    expect(kmaKoreanLocationCatalog.some((entry) => metros.includes(entry.adminArea1))).toBe(true);
  });

  it('covers a province-level city/county (도/시군)', () => {
    expect(
      kmaKoreanLocationCatalog.some(
        (entry) => entry.adminArea1 === '경기도' && entry.adminArea2 !== null && entry.adminArea3 === null,
      ),
    ).toBe(true);
  });

  it('covers dong/myeon/eup-level entries (읍면동)', () => {
    expect(kmaKoreanLocationCatalog.some((entry) => entry.adminArea3 !== null)).toBe(true);
  });

  it('covers Jeju (제주)', () => {
    expect(kmaKoreanLocationCatalog.some((entry) => entry.adminArea1 === '제주특별자치도')).toBe(
      true,
    );
  });

  it('contains no synthetic/fixture marker text', () => {
    const markers = ['synthetic', 'SYNTHETIC', 'fixture', 'FIXTURE', 'test-', 'TEST_'];
    for (const entry of kmaKoreanLocationCatalog) {
      for (const marker of markers) {
        expect(entry.displayName.includes(marker)).toBe(false);
        expect(entry.fullName.includes(marker)).toBe(false);
      }
    }
  });
});

describe('immutability', () => {
  it('the catalog array and every entry (and its kmaGrid) are frozen', () => {
    expect(Object.isFrozen(kmaKoreanLocationCatalog)).toBe(true);
    const sample = kmaKoreanLocationCatalog[0];
    expect(sample).toBeDefined();
    if (sample === undefined) {
      return;
    }
    expect(Object.isFrozen(sample)).toBe(true);
    expect(Object.isFrozen(sample.kmaGrid)).toBe(true);
  });
});
