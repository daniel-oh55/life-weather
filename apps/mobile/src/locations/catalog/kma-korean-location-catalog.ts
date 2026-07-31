/**
 * Runtime-validated KMA Korean administrative-area / forecast-grid catalog.
 *
 * {@link ./kma-korean-location-catalog.generated} is mechanically generated data — this module is
 * the boundary that turns it into a trustworthy runtime value. It never trusts the generated file
 * as-is: every row is schema-validated, cross-row invariants (unique id, unique source
 * administrative code, dense `officialOrder`) are checked, `officialAdministrativeCode` is
 * stripped from the public shape (it is a generation-time-only concern — see
 * `docs/kma-korean-location-catalog.md`), and the result is deep-frozen before export.
 *
 * A malformed generated file **fails closed**: this module throws synchronously at import time
 * rather than silently dropping bad rows, so a broken regeneration is caught immediately by the
 * build or test suite instead of shipping a partial catalog. This is a generation-integrity
 * concern only — the public {@link searchKmaKoreanLocations} boundary (a separate module) never
 * throws on untrusted *user* input.
 *
 * Importing this module performs no storage, network, or environment I/O.
 */

import { z } from 'zod';

import {
  KMA_KOREAN_LOCATION_CATALOG_RAW_ROWS,
  type KmaKoreanLocationRawRow,
} from './kma-korean-location-catalog.generated';
import { kmaKoreanLocationSourceManifest } from './kma-korean-location-source-manifest';

const nonNegativeInteger = z.number().int().min(0);
const positiveInteger = z.number().int().min(1);

/** Reasonable bounds for a Republic of Korea land/forecast-grid location (with margin). */
const KOREA_LATITUDE = z.number().min(32).max(39.5);
const KOREA_LONGITUDE = z.number().min(124).max(132);

/** Non-empty administrative-area label, or `null` when the level does not apply. */
const adminAreaLevel = z.string().min(1).nullable();

export const kmaKoreanLocationKmaGrid = z
  .object({
    nx: nonNegativeInteger,
    ny: nonNegativeInteger,
  })
  .strict();

/**
 * One entry in the KMA Korean location catalog, as consumed by search and candidate mapping.
 *
 * `officialAdministrativeCode` is deliberately **not** a field here — it is used only to derive
 * `id` and to check source-row uniqueness at generation time, and must never reach a screen or a
 * {@link MobileSavedLocationCandidate}.
 */
export const kmaKoreanLocationCatalogEntry = z
  .object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    fullName: z.string().min(1),
    countryCode: z.literal('KR'),
    adminArea1: z.string().min(1),
    adminArea2: adminAreaLevel,
    adminArea3: adminAreaLevel,
    latitude: KOREA_LATITUDE,
    longitude: KOREA_LONGITUDE,
    timezone: z.literal('Asia/Seoul'),
    kmaGrid: kmaKoreanLocationKmaGrid,
    officialOrder: positiveInteger,
  })
  .strict();

export type KmaKoreanLocationCatalogEntry = z.infer<typeof kmaKoreanLocationCatalogEntry>;

/** Every id must match the generation-time opaque-id format and never contain raw digits only. */
const OPAQUE_ID_PATTERN = /^kr_[0-9a-f]{24}$/;

function fail(message: string): never {
  throw new Error(`kma-korean-location-catalog: ${message}`);
}

function adminArea(value: string | null): string | null {
  return value === '' || value === null ? null : value;
}

function buildDisplayName(a1: string, a2: string | null, a3: string | null): string {
  return a3 ?? a2 ?? a1;
}

function buildFullName(a1: string, a2: string | null, a3: string | null): string {
  return [a1, a2, a3].filter((part): part is string => part !== null).join(' ');
}

function mapRawRow(row: KmaKoreanLocationRawRow): unknown {
  const [officialAdministrativeCode, id, rawA1, rawA2, rawA3, latitude, longitude, nx, ny, officialOrder] =
    row;

  if (!OPAQUE_ID_PATTERN.test(id)) {
    fail(`id "${id}" does not match the expected opaque-id format`);
  }
  if (id.includes(officialAdministrativeCode)) {
    fail(`id for administrative code ${officialAdministrativeCode} leaks the raw code`);
  }

  const adminArea1 = rawA1;
  const adminArea2 = adminArea(rawA2);
  const adminArea3 = adminArea(rawA3);

  return {
    id,
    displayName: buildDisplayName(adminArea1, adminArea2, adminArea3),
    fullName: buildFullName(adminArea1, adminArea2, adminArea3),
    countryCode: 'KR',
    adminArea1,
    adminArea2,
    adminArea3,
    latitude,
    longitude,
    timezone: 'Asia/Seoul',
    kmaGrid: { nx, ny },
    officialOrder,
  };
}

function validateRawInvariants(rows: readonly KmaKoreanLocationRawRow[]): void {
  if (rows.length !== kmaKoreanLocationSourceManifest.generatedRowCount) {
    fail(
      `expected ${kmaKoreanLocationSourceManifest.generatedRowCount} generated rows, found ${rows.length}`,
    );
  }

  const codes = new Set<string>();
  rows.forEach((row, index) => {
    const [code, , , , , , , , , officialOrder] = row;
    if (codes.has(code)) {
      fail(`duplicate source administrative code ${code}`);
    }
    codes.add(code);

    if (officialOrder !== index + 1) {
      fail(`officialOrder is not dense/ascending at index ${index} (got ${officialOrder})`);
    }
  });
}

function deepFreezeEntry(entry: KmaKoreanLocationCatalogEntry): KmaKoreanLocationCatalogEntry {
  Object.freeze(entry.kmaGrid);
  return Object.freeze(entry);
}

function buildCatalog(): readonly KmaKoreanLocationCatalogEntry[] {
  validateRawInvariants(KMA_KOREAN_LOCATION_CATALOG_RAW_ROWS);

  const mapped = KMA_KOREAN_LOCATION_CATALOG_RAW_ROWS.map(mapRawRow);

  const parsed = z.array(kmaKoreanLocationCatalogEntry).safeParse(mapped);
  if (!parsed.success) {
    fail(`generated catalog failed schema validation: ${parsed.error.issues.length} issue(s)`);
  }

  const ids = new Set<string>();
  for (const entry of parsed.data) {
    if (ids.has(entry.id)) {
      fail(`duplicate catalog id ${entry.id}`);
    }
    ids.add(entry.id);
  }

  return Object.freeze(parsed.data.map(deepFreezeEntry));
}

/**
 * The validated, deep-frozen KMA Korean location catalog. Built once at module load.
 */
export const kmaKoreanLocationCatalog: readonly KmaKoreanLocationCatalogEntry[] = buildCatalog();
