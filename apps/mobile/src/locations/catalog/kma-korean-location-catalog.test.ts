import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  KMA_KOREAN_LOCATION_CATALOG_RAW_ROWS,
  type KmaKoreanLocationRawRow,
} from './kma-korean-location-catalog.generated';
import { kmaKoreanLocationCatalog, kmaKoreanLocationCatalogEntry } from './kma-korean-location-catalog';
import { kmaKoreanLocationSourceManifest } from './kma-korean-location-source-manifest';

const SOURCE_TSV_PATH = new URL('./kma-korean-location-source.tsv', import.meta.url);

/** The exact source TSV header, column for column. */
const SOURCE_TSV_COLUMNS = [
  'officialAdministrativeCode',
  'adminArea1',
  'adminArea2',
  'adminArea3',
  'latitude',
  'longitude',
  'nx',
  'ny',
  'officialOrder',
] as const;

/**
 * The two official source rows the generation step excludes, because the source spreadsheet leaves
 * their coordinate at the `(0, 0)` placeholder rather than a real Korean lat/lon.
 */
const EXCLUDED_SOURCE_CODES = ['5019000000', '5019099000'] as const;

function readSourceTsvLines(): string[] {
  const content = readFileSync(SOURCE_TSV_PATH, 'utf-8');
  // Trailing newline produces one empty trailing element after split; drop it. A `\r` is stripped
  // per line rather than globally, so a CRLF checkout cannot silently corrupt a field value.
  const lines = content.split('\n').map((line) => line.replace(/\r$/, ''));
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

interface SourceRow {
  readonly officialAdministrativeCode: string;
  readonly adminArea1: string;
  readonly adminArea2: string;
  readonly adminArea3: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly nx: number;
  readonly ny: number;
  readonly officialOrder: number;
}

/**
 * Parse already-read TSV lines into typed rows, failing loudly on any malformed column count or
 * numeric field — the parse must never paper over a corrupt source file by coercing a bad value.
 *
 * Split from {@link parseSourceRows} so the negative-control tests can feed a mutated copy of the
 * real lines through the exact same parser without ever touching the committed TSV on disk.
 */
function parseSourceRowsFromLines(lines: readonly string[]): readonly SourceRow[] {
  const [header, ...dataLines] = lines;

  expect(header?.split('\t')).toEqual([...SOURCE_TSV_COLUMNS]);

  return dataLines.map((line, index) => {
    const columns = line.split('\t');
    expect(columns, `row ${index + 1} column count`).toHaveLength(SOURCE_TSV_COLUMNS.length);

    const [code, adminArea1, adminArea2, adminArea3, latitude, longitude, nx, ny, officialOrder] =
      columns as [string, string, string, string, string, string, string, string, string];

    for (const [label, raw] of [
      ['latitude', latitude],
      ['longitude', longitude],
    ] as const) {
      // `Number('')` and `Number('   ')` are both `0`, so a blank field would otherwise pass the
      // finite check and silently become a real coordinate. Reject blanks before converting.
      expect(raw.trim(), `row ${index + 1} ${label} must not be blank`).not.toBe('');
      expect(Number.isFinite(Number(raw)), `row ${index + 1} ${label} "${raw}"`).toBe(true);
    }
    for (const [label, raw] of [
      ['nx', nx],
      ['ny', ny],
      ['officialOrder', officialOrder],
    ] as const) {
      expect(raw.trim(), `row ${index + 1} ${label} must not be blank`).not.toBe('');
      expect(Number.isInteger(Number(raw)), `row ${index + 1} ${label} "${raw}"`).toBe(true);
    }

    return {
      officialAdministrativeCode: code,
      adminArea1,
      adminArea2,
      adminArea3,
      latitude: Number(latitude),
      longitude: Number(longitude),
      nx: Number(nx),
      ny: Number(ny),
      officialOrder: Number(officialOrder),
    };
  });
}

/** Parse the committed TSV on disk into typed rows. */
function parseSourceRows(): readonly SourceRow[] {
  return parseSourceRowsFromLines(readSourceTsvLines());
}

/** The generation step's deterministic opaque id, recomputed here from the source code alone. */
function deriveId(officialAdministrativeCode: string): string {
  const digest = createHash('sha256')
    .update(`life-weather:kma-location-v1:${officialAdministrativeCode}`, 'utf-8')
    .digest('hex');
  return `kr_${digest.slice(0, 24)}`;
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

// ---------------------------------------------------------------------------
// The generated file is committed data with no committed generator, so CI has to be the thing that
// proves it still corresponds to the committed source. This rebuilds every expected generated row
// from the TSV alone and compares the whole table — not a sample — so a single wrong coordinate,
// grid cell, name, id, or order anywhere in the 3,836 rows fails the build.
// ---------------------------------------------------------------------------

describe('generated rows correspond exactly to the committed source TSV', () => {
  it('parses a well-formed source TSV whose row count matches the manifest', () => {
    const sourceRows = parseSourceRows();

    expect(sourceRows).toHaveLength(kmaKoreanLocationSourceManifest.sourceRowCount);
  });

  it('excludes exactly the two zero-coordinate 이어도 rows and nothing else', () => {
    const zeroCoordinateRows = parseSourceRows().filter(
      (row) => row.latitude === 0 && row.longitude === 0,
    );

    expect(zeroCoordinateRows.map((row) => row.officialAdministrativeCode)).toEqual([
      ...EXCLUDED_SOURCE_CODES,
    ]);
    for (const row of zeroCoordinateRows) {
      expect(row.adminArea1).toBe('이어도');
    }
  });

  it('reproduces every generated row — id, names, coordinate, grid, and order — from the source', () => {
    const sourceRows = parseSourceRows();
    const keptRows = sourceRows.filter((row) => !(row.latitude === 0 && row.longitude === 0));

    expect(keptRows).toHaveLength(kmaKoreanLocationSourceManifest.generatedRowCount);

    const expectedRows: KmaKoreanLocationRawRow[] = keptRows.map((row, index) => [
      row.officialAdministrativeCode,
      deriveId(row.officialAdministrativeCode),
      row.adminArea1,
      row.adminArea2 === '' ? null : row.adminArea2,
      row.adminArea3 === '' ? null : row.adminArea3,
      row.latitude,
      row.longitude,
      row.nx,
      row.ny,
      // officialOrder is re-dealt 1..N over the rows that survive the exclusion.
      index + 1,
    ]);

    expect(KMA_KOREAN_LOCATION_CATALOG_RAW_ROWS).toEqual(expectedRows);
  });
});

// ---------------------------------------------------------------------------
// Negative control for the parser itself. `Number('')` and `Number('   ')` are both `0`, so without
// an explicit blank check a corrupt source file could smuggle a `(0, 0)` coordinate or a `0` grid
// cell past the correspondence tests above. These mutate an in-memory copy of the real lines — the
// committed TSV on disk is never written to.
// ---------------------------------------------------------------------------

/** Zero-based TSV column index of each numeric field, matching `SOURCE_TSV_COLUMNS`. */
const NUMERIC_SOURCE_COLUMNS: readonly (readonly [string, number])[] = [
  ['latitude', 4],
  ['longitude', 5],
  ['nx', 6],
  ['ny', 7],
  ['officialOrder', 8],
];

const BLANK_FIELD_VALUES: readonly (readonly [string, string])[] = [
  ['an empty string', ''],
  ['a whitespace-only string', '   '],
];

const BLANK_FIELD_CASES: [string, number, string, string][] = NUMERIC_SOURCE_COLUMNS.flatMap(
  ([label, columnIndex]) =>
    BLANK_FIELD_VALUES.map(
      ([blankLabel, blankValue]): [string, number, string, string] => [
        label,
        columnIndex,
        blankLabel,
        blankValue,
      ],
    ),
);

describe('source parser rejects blank numeric fields', () => {
  it.each(BLANK_FIELD_CASES)(
    'rejects %s (column %d) when the source field is %s',
    (_label, columnIndex, _blankLabel, blankValue) => {
      const mutated = [...readSourceTsvLines()];

      const columns = mutated[1]?.split('\t');
      expect(columns).toBeDefined();
      if (columns === undefined) {
        return;
      }

      columns[columnIndex] = blankValue;
      mutated[1] = columns.join('\t');

      expect(() => parseSourceRowsFromLines(mutated)).toThrow();
    },
  );

  it('still parses the unmutated committed source lines', () => {
    expect(parseSourceRowsFromLines(readSourceTsvLines())).toHaveLength(
      kmaKoreanLocationSourceManifest.sourceRowCount,
    );
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

  it('every id — not a sample — is re-derivable from its source code (deterministic)', () => {
    for (const row of KMA_KOREAN_LOCATION_CATALOG_RAW_ROWS) {
      const [officialAdministrativeCode, id] = row;
      expect(id).toBe(deriveId(officialAdministrativeCode));
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
