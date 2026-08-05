/**
 * Group a validated flat list of KMA 초단기실황 (current observation) items into a per-observation
 * **slot**, preserving the three-way field-presence distinction the downstream normalizer needs.
 *
 * This is the current-observation counterpart of `group-forecast-items.ts`. KMA returns one `item`
 * per category (T1H, PTY, REH, WSD, VEC, RN1, …) for a single current-observation query, all
 * sharing the same `(baseDate, baseTime, nx, ny)` identity — current observation has no forecast
 * target time to vary by, unlike a forecast slot's `(fcstDate, fcstTime)`. This module folds those
 * rows back into one slot and records, for every category, whether its value is present, explicitly
 * `null`, or absent entirely — the same `ABSENT` / `NULL` / `VALUE` split `group-forecast-items.ts`
 * uses, for the same reason: a pure parser cannot tell "category not in the response" from
 * "category present with a null value" from "category present with a real value".
 *
 * Pure and deterministic: it never fetches, never reads the clock, never mutates its input array or
 * the item objects, and given the same set of items (in any order) it returns the same slots. See
 * `docs/kma-current-observation-provider.md` for the slot-identity, ordering, and duplicate policy.
 */

import type { KmaCurrentObservationItem } from './current-raw-schema.js';

/**
 * The scalar type of a present `obsrValue`. The official JSON always carries `obsrValue` as a
 * string (even numeric categories are string-encoded), so this is `string` — never a number.
 */
export type KmaCurrentObservationScalar = string;

/**
 * One category's value within a slot. `VALUE` carries the raw scalar unchanged; `NULL` records
 * that the item existed but its `obsrValue` was explicitly `null`. "Category not present at all" is
 * intentionally *not* a variant here — it is reported by {@link getKmaCurrentObservationField} as
 * `ABSENT`, so a slot's `fields` never contains a placeholder for a missing category.
 */
export type KmaCurrentObservationField =
  | { readonly category: string; readonly state: 'NULL' }
  | {
      readonly category: string;
      readonly state: 'VALUE';
      readonly value: KmaCurrentObservationScalar;
    };

/**
 * A single current-observation slot — one `(baseDate, baseTime, nx, ny)` identity. `fields` holds
 * one entry per distinct category present in the input for this slot, sorted by category
 * (code-unit ascending).
 */
export interface KmaCurrentObservationSlot {
  readonly baseDate: string;
  readonly baseTime: string;
  readonly nx: number;
  readonly ny: number;
  readonly fields: readonly KmaCurrentObservationField[];
}

/**
 * The result of looking up one category in a slot — the full three-way presence distinction.
 * `ABSENT`: no item for this category. `NULL`: an item existed but its value was null. `VALUE`: an
 * item existed with a real value.
 */
export type KmaCurrentObservationFieldLookup =
  | { readonly state: 'ABSENT' }
  | { readonly state: 'NULL' }
  | { readonly state: 'VALUE'; readonly value: KmaCurrentObservationScalar };

export type GroupKmaCurrentObservationItemsResult =
  | { readonly ok: true; readonly slots: readonly KmaCurrentObservationSlot[] }
  | {
      readonly ok: false;
      readonly error: {
        readonly kind: 'DUPLICATE_CATEGORY';
        readonly category: string;
        readonly slotKey: string;
      };
    };

/**
 * The four parts that identify a current-observation slot: `baseDate`, `baseTime`, `nx`, `ny`.
 * `category` is deliberately excluded — many categories share one slot. None of these parts can
 * contain the `|` delimiter (dates/times are digit strings, nx/ny are numbers), so the joined key
 * is collision-free and is safe to surface in a duplicate-category error.
 */
function slotKeyOf(item: KmaCurrentObservationItem): string {
  return [item.baseDate, item.baseTime, item.nx, item.ny].join('|');
}

/** Deterministic, locale-independent string order (UTF-16 code-unit comparison). */
function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/**
 * Total order over slots: base issuance first, then grid. Distinct slots never compare equal
 * (equal on all four parts would mean the same slot key), so the order is fully determined by the
 * slot set regardless of input order.
 */
function compareSlots(a: KmaCurrentObservationSlot, b: KmaCurrentObservationSlot): number {
  return (
    compareStrings(a.baseDate, b.baseDate) ||
    compareStrings(a.baseTime, b.baseTime) ||
    a.nx - b.nx ||
    a.ny - b.ny
  );
}

/** Mutable per-slot accumulator; frozen into a {@link KmaCurrentObservationSlot} at the end. */
interface SlotAccumulator {
  readonly baseDate: string;
  readonly baseTime: string;
  readonly nx: number;
  readonly ny: number;
  readonly fields: Map<string, KmaCurrentObservationField>;
}

/**
 * Group `items` into current-observation slots.
 *
 * Slot identity is `(baseDate, baseTime, nx, ny)`. Within a slot each category may appear at most
 * once: a repeated category (even with an identical value) is a `DUPLICATE_CATEGORY` error rather
 * than a last-write-wins overwrite, matching `group-forecast-items.ts`'s duplicate policy for the
 * same reason (a duplicate signals a pagination or upstream anomaly; silently dropping one copy
 * would be non-deterministic). When duplicates exist, the reported `(slotKey, category)` is the
 * smallest in `(slotKey, category)` order, so the error is stable regardless of input ordering.
 *
 * On success, slots are sorted by {@link compareSlots} and each slot's `fields` by category
 * (ascending). The input array and its item objects are never mutated.
 */
export function groupKmaCurrentObservationItems(
  items: readonly KmaCurrentObservationItem[],
): GroupKmaCurrentObservationItemsResult {
  const slots = new Map<string, SlotAccumulator>();
  const duplicates: { slotKey: string; category: string }[] = [];

  for (const item of items) {
    const slotKey = slotKeyOf(item);
    let accumulator = slots.get(slotKey);
    if (accumulator === undefined) {
      accumulator = {
        baseDate: item.baseDate,
        baseTime: item.baseTime,
        nx: item.nx,
        ny: item.ny,
        fields: new Map<string, KmaCurrentObservationField>(),
      };
      slots.set(slotKey, accumulator);
    }

    if (accumulator.fields.has(item.category)) {
      duplicates.push({ slotKey, category: item.category });
      continue;
    }

    accumulator.fields.set(
      item.category,
      item.obsrValue === null
        ? { category: item.category, state: 'NULL' }
        : { category: item.category, state: 'VALUE', value: item.obsrValue },
    );
  }

  if (duplicates.length > 0) {
    const [first] = [...duplicates].sort(
      (a, b) =>
        compareStrings(a.slotKey, b.slotKey) || compareStrings(a.category, b.category),
    );
    return {
      ok: false,
      error: {
        kind: 'DUPLICATE_CATEGORY',
        category: first.category,
        slotKey: first.slotKey,
      },
    };
  }

  const sortedSlots: KmaCurrentObservationSlot[] = [...slots.values()]
    .map((accumulator) => ({
      baseDate: accumulator.baseDate,
      baseTime: accumulator.baseTime,
      nx: accumulator.nx,
      ny: accumulator.ny,
      fields: [...accumulator.fields.values()].sort((a, b) =>
        compareStrings(a.category, b.category),
      ),
    }))
    .sort(compareSlots);

  return { ok: true, slots: sortedSlots };
}

/**
 * Look up one category in a slot, returning the full three-way presence state. This is the only
 * supported way to ask "is this category present?" — a caller must never infer absence from a
 * missing array entry or an `undefined`, because `ABSENT` and `NULL` are genuinely different.
 */
export function getKmaCurrentObservationField(
  slot: KmaCurrentObservationSlot,
  category: string,
): KmaCurrentObservationFieldLookup {
  const field = slot.fields.find((candidate) => candidate.category === category);
  if (field === undefined) {
    return { state: 'ABSENT' };
  }
  if (field.state === 'NULL') {
    return { state: 'NULL' };
  }
  return { state: 'VALUE', value: field.value };
}
