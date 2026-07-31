/**
 * Provider-neutral substring search over the static {@link kmaKoreanLocationCatalog}, with support
 * for the colloquial abbreviated hierarchy people actually type (`서울강남` → `서울특별시 강남구`).
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

/**
 * Official administrative-area suffixes, longest first. Used **only** to derive a search alias —
 * never to build a display name, and never applied to the catalog data itself.
 */
const ADMINISTRATIVE_SUFFIXES: readonly string[] = [
  '특별자치시',
  '특별자치도',
  '특별시',
  '광역시',
  '자치시',
  '자치도',
  '시',
  '군',
  '구',
  '읍',
  '면',
  '동',
  '리',
  '도',
];

/**
 * The colloquial short form of one official administrative-area name: its {@link comparisonKey}
 * with at most one trailing official suffix removed (`서울특별시` → `서울`, `강남구` → `강남`,
 * `제주특별자치도` → `제주`). A name that is nothing but a suffix keeps its full key.
 *
 * This is a mechanical suffix rule, not a synonym dictionary — no 초성, romanization, or
 * hand-curated nickname is involved.
 */
function administrativeAliasKey(value: string): string {
  const key = comparisonKey(value);
  for (const suffix of ADMINISTRATIVE_SUFFIXES) {
    if (key.length > suffix.length && key.endsWith(suffix)) {
      return key.slice(0, key.length - suffix.length);
    }
  }
  return key;
}

interface SearchableEntry {
  readonly entry: KmaKoreanLocationCatalogEntry;
  readonly displayNameKey: string;
  readonly fullNameKey: string;
  readonly adminAreaKeys: readonly string[];
  /**
   * Per admin component, in official order, the distinct keys that component may be written as:
   * its official key and — when different — its {@link administrativeAliasKey} short form.
   */
  readonly hierarchyVariants: readonly (readonly string[])[];
}

function buildSearchIndex(): readonly SearchableEntry[] {
  return kmaKoreanLocationCatalog.map((entry) => {
    const adminAreas = [entry.adminArea1, entry.adminArea2, entry.adminArea3].filter(
      (area): area is string => area !== null,
    );
    return {
      entry,
      displayNameKey: comparisonKey(entry.displayName),
      fullNameKey: comparisonKey(entry.fullName),
      adminAreaKeys: adminAreas.map(comparisonKey),
      hierarchyVariants: adminAreas.map((area) => {
        const officialKey = comparisonKey(area);
        const aliasKey = administrativeAliasKey(area);
        return aliasKey === officialKey ? [officialKey] : [officialKey, aliasKey];
      }),
    };
  });
}

const SEARCH_INDEX: readonly SearchableEntry[] = Object.freeze(buildSearchIndex());

/**
 * Match `key` against the entry's admin hierarchy where **each component independently** may be
 * written officially or in its short alias form — the way people actually type a combined query
 * (`서울강남` for `서울특별시 강남구`, `부산중구` for `부산광역시 중구`).
 *
 * Returns tier 5 when some spelling of the whole hierarchy equals `key` exactly, tier 6 when some
 * spelling merely starts with `key` (so `서울강남` reaches 강남구's dong-level children too, but
 * always behind 강남구 itself), and `null` otherwise. Components are consumed strictly left to
 * right from `adminArea1`, so a query must start at the province level to match here at all.
 *
 * `remainders` holds the still-unconsumed tail of `key` for each spelling explored so far; it is
 * bounded by the number of variants (at most 2 per component, at most 3 components), so this stays
 * a handful of string comparisons per catalog entry.
 */
function hierarchyAliasTier(
  variants: readonly (readonly string[])[],
  key: string,
): number | null {
  let remainders = new Set<string>([key]);
  let hasPrefixMatch = false;

  for (const componentVariants of variants) {
    const next = new Set<string>();
    for (const remainder of remainders) {
      if (remainder === '') {
        // `key` ran out before the hierarchy did: the full name strictly extends it.
        hasPrefixMatch = true;
        continue;
      }
      for (const variant of componentVariants) {
        if (remainder.startsWith(variant)) {
          next.add(remainder.slice(variant.length));
        } else if (variant.startsWith(remainder)) {
          // `key` ends part-way into this component, e.g. "서울강" against 서울 + 강남.
          hasPrefixMatch = true;
        }
      }
    }
    remainders = next;
  }

  if (remainders.has('')) {
    return 5;
  }
  return hasPrefixMatch ? 6 : null;
}

/**
 * Deterministic match tier — lower is a stronger match. `null` means "no match".
 *
 * 1. `displayName` exact       2. an admin component exact  3. `displayName` prefix
 * 4. `fullName` prefix         5. hierarchy alias exact     6. hierarchy alias prefix
 * 7. substring anywhere among the indexed fields
 *
 * The alias tiers sit below every exact/prefix tier on the official names, so abbreviated matching
 * never outranks a match on a real administrative name.
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
  const aliasTier = hierarchyAliasTier(candidate.hierarchyVariants, key);
  if (aliasTier !== null) {
    return aliasTier;
  }
  const isSubstringMatch =
    candidate.displayNameKey.includes(key) ||
    candidate.fullNameKey.includes(key) ||
    candidate.adminAreaKeys.some((areaKey) => areaKey.includes(key));
  return isSubstringMatch ? 7 : null;
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
