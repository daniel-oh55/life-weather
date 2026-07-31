/**
 * Maps one {@link KmaKoreanLocationCatalogEntry} into a {@link MobileSavedLocationCandidate}.
 *
 * This is the only bridge between the KMA Korean location catalog and the existing saved-location
 * collection boundary (`./mobile-saved-location-collection`, PR #40). It validates the untrusted
 * input against the catalog entry schema, maps **exactly** the candidate's fields one by one (no
 * spread), and defensively re-validates the result against the existing
 * {@link mobileSavedLocationCandidate} schema before returning it. `fullName`, `officialOrder`,
 * and any source administrative code never reach the output — only the nine mapped fields plus
 * `isCurrent: false` do. `sortOrder` is never included; the collection's `addSavedLocation`
 * derives it.
 *
 * The function never throws, never mutates its input, and returns a fresh candidate (with a fresh
 * `kmaGrid` object) on every successful call.
 */

import { kmaKoreanLocationCatalogEntry } from './catalog/kma-korean-location-catalog';
import {
  mobileSavedLocationCandidate,
  type MobileSavedLocationCandidate,
} from './mobile-saved-location-collection';

export type SavedLocationCandidateFromCatalogErrorKind = 'INVALID_CATALOG_ENTRY';

export type SavedLocationCandidateFromCatalogResult =
  | { readonly ok: true; readonly candidate: MobileSavedLocationCandidate }
  | {
      readonly ok: false;
      readonly error: { readonly kind: SavedLocationCandidateFromCatalogErrorKind };
    };

/** A fresh failure result per call, so no caller can observe or mutate a shared one. */
function invalidResult(): SavedLocationCandidateFromCatalogResult {
  return { ok: false, error: { kind: 'INVALID_CATALOG_ENTRY' } };
}

/**
 * Build a {@link MobileSavedLocationCandidate} from an untrusted KMA catalog entry value.
 *
 * Steps, in order:
 * 1. validate `input` with {@link kmaKoreanLocationCatalogEntry}`.safeParse`;
 * 2. on failure, return the fixed `INVALID_CATALOG_ENTRY` result;
 * 3. on success, map the nine shared fields plus `kmaGrid` and `isCurrent: false` into a fresh
 *    object — `fullName`, `officialOrder`, and any source-only field are left out by construction;
 * 4. defensively re-validate the mapped object with `mobileSavedLocationCandidate.safeParse`;
 * 5. return the re-parsed candidate, or the same fixed invalid result if that parse fails.
 */
export function createSavedLocationCandidateFromKmaCatalogEntry(
  input: unknown,
): SavedLocationCandidateFromCatalogResult {
  const parsedEntry = kmaKoreanLocationCatalogEntry.safeParse(input);
  if (!parsedEntry.success) {
    return invalidResult();
  }

  const entry = parsedEntry.data;

  const candidate = {
    id: entry.id,
    displayName: entry.displayName,
    countryCode: entry.countryCode,
    adminArea1: entry.adminArea1,
    adminArea2: entry.adminArea2,
    adminArea3: entry.adminArea3,
    latitude: entry.latitude,
    longitude: entry.longitude,
    timezone: entry.timezone,
    kmaGrid: { nx: entry.kmaGrid.nx, ny: entry.kmaGrid.ny },
    isCurrent: false,
  };

  const revalidated = mobileSavedLocationCandidate.safeParse(candidate);
  if (!revalidated.success) {
    return invalidResult();
  }

  return { ok: true, candidate: revalidated.data };
}
