/**
 * Provider-neutral substring search over the static {@link kmaKoreanLocationCatalog}.
 *
 * `searchKmaKoreanLocations` never touches the network or storage — it only searches the
 * in-memory, deep-frozen catalog built at module load. It never throws: any input, including a
 * hostile or malformed one, collapses to either a successful (possibly empty) result or a fixed,
 * non-revealing `INVALID_QUERY` / `INVALID_LIMIT` error.
 *
 * Out of scope (see `docs/kma-korean-location-catalog.md`): 초성 search, fuzzy/edit-distance
 * matching, romanization, search history, popularity ranking, location-based ordering, and any
 * external autocomplete.
 */

import { kmaKoreanLocationCatalog, type KmaKoreanLocationCatalogEntry } from './catalog/kma-korean-location-catalog';

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;

/** The minimum normalized query length that is actually searched; shorter queries return empty. */
const MIN_SEARCHABLE_LENGTH = 2;

export type KmaKoreanLocationSearchErrorKind = 'INVALID_QUERY' | 'INVALID_LIMIT';

export interface KmaKoreanLocationSearchOptions {
  readonly limit?: number;
}

export type KmaKoreanLocationSearchResult =
  | { readonly ok: true; readonly locations: readonly KmaKoreanLocationCatalogEntry[] }
  | { readonly ok: false; readonly error: { readonly kind: KmaKoreanLocationSearchErrorKind } };

/** NFKC-normalize, then strip all whitespace and lowercase — used only for matching, not display. */
function comparisonKey(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

interface SearchableEntry {
  readonly entry: KmaKoreanLocationCatalogEntry;
  readonly displayNameKey: string;
  readonly fullNameKey: string;
  readonly adminAreaKeys: readonly string[];
}

function buildSearchIndex(): readonly SearchableEntry[] {
  return kmaKoreanLocationCatalog.map((entry) => ({
    entry,
    displayNameKey: comparisonKey(entry.displayName),
    fullNameKey: comparisonKey(entry.fullName),
    adminAreaKeys: [entry.adminArea1, entry.adminArea2, entry.adminArea3]
      .filter((area): area is string => area !== null)
      .map(comparisonKey),
  }));
}

const SEARCH_INDEX: readonly SearchableEntry[] = Object.freeze(buildSearchIndex());

/**
 * Deterministic match tier — lower is a stronger match. `null` means "no match".
 *
 * 1. `displayName` exact  2. an admin component exact  3. `displayName` prefix
 * 4. `fullName` prefix    5. substring anywhere among the indexed fields
 */
function matchTier(candidate: SearchableEntry, key: string): number | null {
  if (candidate.displayNameKey === key) {
    return 1;
  }
  if (candidate.adminAreaKeys.some((areaKey) => areaKey === key)) {
    return 2;
  }
  if (candidate.displayNameKey.startsWith(key)) {
    return 3;
  }
  if (candidate.fullNameKey.startsWith(key)) {
    return 4;
  }
  const isSubstringMatch =
    candidate.displayNameKey.includes(key) ||
    candidate.fullNameKey.includes(key) ||
    candidate.adminAreaKeys.some((areaKey) => areaKey.includes(key));
  return isSubstringMatch ? 5 : null;
}

function normalizeQuery(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function resolveLimit(options: KmaKoreanLocationSearchOptions | undefined): number | 'INVALID' {
  if (options === undefined || options.limit === undefined) {
    return DEFAULT_LIMIT;
  }
  const { limit } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return 'INVALID';
  }
  return limit;
}

/**
 * Search the static KMA Korean location catalog.
 *
 * `queryInput` must be a string or the result is `INVALID_QUERY`. After NFKC normalization,
 * trimming, and whitespace collapsing, a query shorter than {@link MIN_SEARCHABLE_LENGTH}
 * characters (including the empty string) returns a **successful empty result** — it is not an
 * error, since "still typing" is the common case, not user error.
 *
 * `options.limit`, when provided, must be an integer in `[1, 50]` or the result is
 * `INVALID_LIMIT`; the default is 30. Results are ranked by {@link matchTier} and, within a tier,
 * by the catalog's `officialOrder` — a total order, so the result is deterministic for a given
 * query and limit. Returned entries are the catalog's own frozen references; only the containing
 * array is freshly built per call.
 */
export function searchKmaKoreanLocations(
  queryInput: unknown,
  options?: KmaKoreanLocationSearchOptions,
): KmaKoreanLocationSearchResult {
  if (typeof queryInput !== 'string') {
    return { ok: false, error: { kind: 'INVALID_QUERY' } };
  }

  const limit = resolveLimit(options);
  if (limit === 'INVALID') {
    return { ok: false, error: { kind: 'INVALID_LIMIT' } };
  }

  const normalizedQuery = normalizeQuery(queryInput);
  if (normalizedQuery.length < MIN_SEARCHABLE_LENGTH) {
    return { ok: true, locations: [] };
  }

  const key = comparisonKey(normalizedQuery);

  const ranked: { readonly tier: number; readonly candidate: SearchableEntry }[] = [];
  for (const candidate of SEARCH_INDEX) {
    const tier = matchTier(candidate, key);
    if (tier !== null) {
      ranked.push({ tier, candidate });
    }
  }

  ranked.sort((a, b) => {
    if (a.tier !== b.tier) {
      return a.tier - b.tier;
    }
    return a.candidate.entry.officialOrder - b.candidate.entry.officialOrder;
  });

  return {
    ok: true,
    locations: ranked.slice(0, limit).map((result) => result.candidate.entry),
  };
}
