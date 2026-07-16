/**
 * Group a validated flat list of KMA forecast items into per-time forecast **slots**, preserving
 * the three-way field-presence distinction the downstream normalizer needs.
 *
 * KMA returns one `item` per (time, category) pair: a single forecast time carries many rows
 * (TMP, SKY, PTY, PCP, …). This module folds those rows back into one slot per forecast time and
 * grid point, and records, for every category, whether its value is present, explicitly `null`,
 * or absent entirely. That `ABSENT` / `NULL` / `VALUE` split is exactly what PR #3 left open: a
 * pure amount/condition parser cannot tell "category not in the response" from "category present
 * with a null value" from "category present with a real value" — this boundary can, and keeps
 * the three states explicit instead of collapsing any of them to `undefined`.
 *
 * Pure and deterministic: it never fetches, never reads the clock, never mutates its input array
 * or the item objects, and given the same set of items (in any order) it returns the same slots.
 * See `docs/kma-response-boundary.md` for the slot-identity, ordering, and duplicate policy.
 */

import { KmaForecastProduct } from '@life-weather/weather-core';

import type { KmaForecastItem } from './raw-schema';

/**
 * The scalar type of a present `fcstValue`. The official JSON always carries `fcstValue` as a
 * string (even numeric categories are string-encoded), so this is `string` — never a number.
 * Kept as a named alias so a future evidence-backed change stays a single edit.
 */
export type KmaForecastScalar = string;

/**
 * One category's value within a slot. `VALUE` carries the raw scalar unchanged; `NULL` records
 * that the item existed but its `fcstValue` was explicitly `null`. The "category not present at
 * all" case is intentionally *not* a variant here — it is reported by {@link getKmaForecastField}
 * as `ABSENT`, so a slot's `fields` never contains a placeholder for a missing category.
 */
export type KmaForecastField =
  | { readonly category: string; readonly state: 'NULL' }
  | { readonly category: string; readonly state: 'VALUE'; readonly value: KmaForecastScalar };

/**
 * A single forecast time at a single grid point, produced from one specific base issuance of one
 * product. `fields` holds one entry per distinct category present in the input for this slot,
 * sorted by category (code-unit ascending).
 */
export interface KmaForecastSlot {
  readonly product: KmaForecastProduct;
  readonly baseDate: string;
  readonly baseTime: string;
  readonly forecastDate: string;
  readonly forecastTime: string;
  readonly nx: number;
  readonly ny: number;
  readonly fields: readonly KmaForecastField[];
}

/**
 * The result of looking up one category in a slot — the full three-way presence distinction.
 * `ABSENT`: no item for this category. `NULL`: an item existed but its value was null. `VALUE`:
 * an item existed with a real value.
 */
export type KmaForecastFieldLookup =
  | { readonly state: 'ABSENT' }
  | { readonly state: 'NULL' }
  | { readonly state: 'VALUE'; readonly value: KmaForecastScalar };

export type GroupKmaForecastItemsResult =
  | { readonly ok: true; readonly slots: readonly KmaForecastSlot[] }
  | {
      readonly ok: false;
      readonly error: {
        readonly kind: 'DUPLICATE_CATEGORY';
        readonly category: string;
        readonly slotKey: string;
      };
    };

/**
 * The seven parts that identify a slot: product, base issuance (date + time), forecast target
 * (date + time), and grid point (nx, ny). `category` is deliberately excluded — many categories
 * share one slot. None of these parts can contain the `|` delimiter (product is a fixed enum,
 * dates/times are digit strings, nx/ny are numbers), so the joined key is collision-free and is
 * safe to surface in a duplicate-category error.
 */
function slotKeyOf(
  product: KmaForecastProduct,
  item: KmaForecastItem,
): string {
  return [
    product,
    item.baseDate,
    item.baseTime,
    item.fcstDate,
    item.fcstTime,
    item.nx,
    item.ny,
  ].join('|');
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
 * Total order over slots: forecast target first, then base issuance, then grid, then product.
 * Distinct slots never compare equal (equal on all seven parts would mean the same slot key), so
 * the order is fully determined by the slot set regardless of input order.
 */
function compareSlots(a: KmaForecastSlot, b: KmaForecastSlot): number {
  return (
    compareStrings(a.forecastDate, b.forecastDate) ||
    compareStrings(a.forecastTime, b.forecastTime) ||
    compareStrings(a.baseDate, b.baseDate) ||
    compareStrings(a.baseTime, b.baseTime) ||
    a.nx - b.nx ||
    a.ny - b.ny ||
    compareStrings(a.product, b.product)
  );
}

/** Mutable per-slot accumulator; frozen into a {@link KmaForecastSlot} at the end. */
interface SlotAccumulator {
  readonly product: KmaForecastProduct;
  readonly baseDate: string;
  readonly baseTime: string;
  readonly forecastDate: string;
  readonly forecastTime: string;
  readonly nx: number;
  readonly ny: number;
  readonly fields: Map<string, KmaForecastField>;
}

/**
 * Group `items` into forecast slots for `product`.
 *
 * Slot identity is (product, baseDate, baseTime, fcstDate, fcstTime, nx, ny). Within a slot each
 * category may appear at most once: a repeated category (even with an identical value) is a
 * `DUPLICATE_CATEGORY` error rather than a last-write-wins overwrite, since a duplicate signals a
 * pagination or upstream anomaly and silently dropping one copy would be non-deterministic. When
 * duplicates exist, the reported `(slotKey, category)` is the smallest in `(slotKey, category)`
 * order, so the error is stable regardless of input ordering.
 *
 * On success, slots are sorted by {@link compareSlots} and each slot's `fields` by category
 * (ascending). The input array and its item objects are never mutated.
 */
export function groupKmaForecastItems(
  product: KmaForecastProduct,
  items: readonly KmaForecastItem[],
): GroupKmaForecastItemsResult {
  const slots = new Map<string, SlotAccumulator>();
  const duplicates: { slotKey: string; category: string }[] = [];

  for (const item of items) {
    const slotKey = slotKeyOf(product, item);
    let accumulator = slots.get(slotKey);
    if (accumulator === undefined) {
      accumulator = {
        product,
        baseDate: item.baseDate,
        baseTime: item.baseTime,
        forecastDate: item.fcstDate,
        forecastTime: item.fcstTime,
        nx: item.nx,
        ny: item.ny,
        fields: new Map<string, KmaForecastField>(),
      };
      slots.set(slotKey, accumulator);
    }

    if (accumulator.fields.has(item.category)) {
      duplicates.push({ slotKey, category: item.category });
      continue;
    }

    accumulator.fields.set(
      item.category,
      item.fcstValue === null
        ? { category: item.category, state: 'NULL' }
        : { category: item.category, state: 'VALUE', value: item.fcstValue },
    );
  }

  if (duplicates.length > 0) {
    const [first] = [...duplicates].sort(
      (a, b) =>
        compareStrings(a.slotKey, b.slotKey) ||
        compareStrings(a.category, b.category),
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

  const sortedSlots: KmaForecastSlot[] = [...slots.values()]
    .map((accumulator) => ({
      product: accumulator.product,
      baseDate: accumulator.baseDate,
      baseTime: accumulator.baseTime,
      forecastDate: accumulator.forecastDate,
      forecastTime: accumulator.forecastTime,
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
export function getKmaForecastField(
  slot: KmaForecastSlot,
  category: string,
): KmaForecastFieldLookup {
  const field = slot.fields.find((candidate) => candidate.category === category);
  if (field === undefined) {
    return { state: 'ABSENT' };
  }
  if (field.state === 'NULL') {
    return { state: 'NULL' };
  }
  return { state: 'VALUE', value: field.value };
}
