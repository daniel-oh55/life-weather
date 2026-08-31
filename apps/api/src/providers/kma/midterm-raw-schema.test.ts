import { describe, expect, it } from 'vitest';

import {
  kmaMidtermLandBodySchema,
  kmaMidtermLandItemSchema,
  kmaMidtermLandSuccessResponseSchema,
  kmaMidtermTemperatureBodySchema,
  kmaMidtermTemperatureItemSchema,
  kmaMidtermTemperatureSuccessResponseSchema,
} from './midterm-raw-schema.js';

const REG_ID = '11B10101';
const LAND_REG_ID = '11B00000';

/** A complete, D+4-through-D+10 중기기온조회 item. */
function temperatureItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    regId: REG_ID,
    taMin4: 21,
    taMax4: 29,
    taMin5: 22,
    taMax5: 30,
    taMin6: 20,
    taMax6: 28,
    taMin7: 19,
    taMax7: 27,
    taMin8: 18,
    taMax8: 26,
    taMin9: 17,
    taMax9: 25,
    taMin10: 16,
    taMax10: 24,
    ...overrides,
  };
}

/** A complete 중기육상예보조회 item: AM/PM through D+7, all-day for D+8~D+10. */
function landItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    regId: LAND_REG_ID,
    rnSt4Am: 30,
    rnSt4Pm: 60,
    rnSt5Am: 20,
    rnSt5Pm: 20,
    rnSt6Am: 10,
    rnSt6Pm: 30,
    rnSt7Am: 40,
    rnSt7Pm: 50,
    rnSt8: 30,
    rnSt9: 20,
    rnSt10: 10,
    wf4Am: '구름많음',
    wf4Pm: '흐리고 비',
    wf5Am: '맑음',
    wf5Pm: '구름많음',
    wf6Am: '흐림',
    wf6Pm: '흐리고 비',
    wf7Am: '맑음',
    wf7Pm: '맑음',
    wf8: '구름많음',
    wf9: '맑음',
    wf10: '흐림',
    ...overrides,
  };
}

function body(item: Record<string, unknown>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dataType: 'JSON',
    pageNo: 1,
    numOfRows: 10,
    totalCount: 1,
    items: { item: [item] },
    ...overrides,
  };
}

function envelope(bodyValue: unknown, resultCode = '00'): unknown {
  return {
    response: {
      header: { resultCode, resultMsg: 'NORMAL_SERVICE' },
      body: bodyValue,
    },
  };
}

// ---------------------------------------------------------------------------
// TEMPERATURE item — getMidTa
// ---------------------------------------------------------------------------

describe('kmaMidtermTemperatureItemSchema', () => {
  it('accepts a complete D+4 through D+10 item and retains every field', () => {
    const parsed = kmaMidtermTemperatureItemSchema.parse(temperatureItem());
    expect(parsed).toEqual(temperatureItem());
    for (const day of [4, 5, 6, 7, 8, 9, 10]) {
      expect(parsed).toHaveProperty(`taMin${day}`);
      expect(parsed).toHaveProperty(`taMax${day}`);
    }
  });

  it.each([4, 5, 6, 7, 8, 9, 10])('requires both taMin%i and taMax%i', (day) => {
    for (const field of [`taMin${day}`, `taMax${day}`]) {
      const item = temperatureItem();
      delete item[field];
      expect(kmaMidtermTemperatureItemSchema.safeParse(item).success).toBe(false);
    }
  });

  it('accepts negative and fractional temperatures, and zero', () => {
    expect(
      kmaMidtermTemperatureItemSchema.safeParse(
        temperatureItem({ taMin4: -12, taMax4: 0, taMin5: 21.5 }),
      ).success,
    ).toBe(true);
  });

  it('rejects a numeric string temperature (no coercion)', () => {
    expect(kmaMidtermTemperatureItemSchema.safeParse(temperatureItem({ taMin4: '21' })).success).toBe(
      false,
    );
  });

  it('rejects a null temperature (no nullable allowance without evidence)', () => {
    expect(kmaMidtermTemperatureItemSchema.safeParse(temperatureItem({ taMax7: null })).success).toBe(
      false,
    );
  });

  it('rejects a non-finite temperature', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(kmaMidtermTemperatureItemSchema.safeParse(temperatureItem({ taMin4: value })).success).toBe(
        false,
      );
    }
  });

  it('requires a structurally valid regId and rejects a malformed one', () => {
    expect(kmaMidtermTemperatureItemSchema.safeParse(temperatureItem({ regId: '11b10101' })).success).toBe(
      false,
    );
    expect(kmaMidtermTemperatureItemSchema.safeParse(temperatureItem({ regId: '' })).success).toBe(false);
    const missing = temperatureItem();
    delete missing.regId;
    expect(kmaMidtermTemperatureItemSchema.safeParse(missing).success).toBe(false);
  });

  it('strips the unconfirmed low/high range fields rather than rejecting them', () => {
    // Documented open evidence item: their names/JSON types were not confirmed against an official
    // 출력결과 table, so they are neither required nor type-asserted — only accepted and dropped.
    const parsed = kmaMidtermTemperatureItemSchema.parse(
      temperatureItem({ taMin4Low: 20, taMin4High: 22, taMax4Low: 28, taMax4High: 30 }),
    );
    expect(parsed).toEqual(temperatureItem());
    expect(parsed).not.toHaveProperty('taMin4Low');
  });

  it('rejects a getMidLandFcst item — the two shapes are strictly separate', () => {
    expect(kmaMidtermTemperatureItemSchema.safeParse(landItem()).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LAND item — getMidLandFcst
// ---------------------------------------------------------------------------

describe('kmaMidtermLandItemSchema', () => {
  it('accepts a complete item and retains the D+4~D+7 AM/PM and D+8~D+10 all-day fields', () => {
    const parsed = kmaMidtermLandItemSchema.parse(landItem());
    expect(parsed).toEqual(landItem());
    for (const day of [4, 5, 6, 7]) {
      expect(parsed).toHaveProperty(`wf${day}Am`);
      expect(parsed).toHaveProperty(`wf${day}Pm`);
      expect(parsed).toHaveProperty(`rnSt${day}Am`);
      expect(parsed).toHaveProperty(`rnSt${day}Pm`);
    }
    for (const day of [8, 9, 10]) {
      expect(parsed).toHaveProperty(`wf${day}`);
      expect(parsed).toHaveProperty(`rnSt${day}`);
    }
  });

  it.each([4, 5, 6, 7])('requires all four AM/PM fields for D+%i', (day) => {
    for (const field of [`wf${day}Am`, `wf${day}Pm`, `rnSt${day}Am`, `rnSt${day}Pm`]) {
      const item = landItem();
      delete item[field];
      expect(kmaMidtermLandItemSchema.safeParse(item).success).toBe(false);
    }
  });

  it.each([8, 9, 10])('requires both all-day fields for D+%i', (day) => {
    for (const field of [`wf${day}`, `rnSt${day}`]) {
      const item = landItem();
      delete item[field];
      expect(kmaMidtermLandItemSchema.safeParse(item).success).toBe(false);
    }
  });

  it('does not accept an AM/PM split for D+8~D+10, nor an all-day value for D+4~D+7', () => {
    // The asymmetry is the official product semantics: supplying only `wf8Am` leaves `wf8` missing.
    const amPmForAllDay = landItem();
    delete amPmForAllDay.wf8;
    amPmForAllDay.wf8Am = '맑음';
    expect(kmaMidtermLandItemSchema.safeParse(amPmForAllDay).success).toBe(false);

    const allDayForAmPm = landItem();
    delete allDayForAmPm.wf4Am;
    allDayForAmPm.wf4 = '맑음';
    expect(kmaMidtermLandItemSchema.safeParse(allDayForAmPm).success).toBe(false);
  });

  it('keeps Korean weather phrases verbatim — no normalization, no enum', () => {
    const parsed = kmaMidtermLandItemSchema.parse(
      landItem({ wf4Am: '흐리고 눈/비', wf10: '아직 정의되지 않은 미래 문구' }),
    );
    expect(parsed.wf4Am).toBe('흐리고 눈/비');
    expect(parsed.wf10).toBe('아직 정의되지 않은 미래 문구');
  });

  it('rejects an empty or non-string weather phrase', () => {
    expect(kmaMidtermLandItemSchema.safeParse(landItem({ wf4Am: '' })).success).toBe(false);
    expect(kmaMidtermLandItemSchema.safeParse(landItem({ wf4Am: null })).success).toBe(false);
    expect(kmaMidtermLandItemSchema.safeParse(landItem({ wf9: 3 })).success).toBe(false);
  });

  it('rejects a numeric-string precipitation probability (no coercion) and accepts 0', () => {
    expect(kmaMidtermLandItemSchema.safeParse(landItem({ rnSt4Am: '30' })).success).toBe(false);
    expect(kmaMidtermLandItemSchema.safeParse(landItem({ rnSt4Am: 0 })).success).toBe(true);
  });

  it('rejects a null precipitation probability', () => {
    expect(kmaMidtermLandItemSchema.safeParse(landItem({ rnSt8: null })).success).toBe(false);
  });

  it('rejects a getMidTa item — the two shapes are strictly separate', () => {
    expect(kmaMidtermLandItemSchema.safeParse(temperatureItem()).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Body envelope — shared rules, applied per operation
// ---------------------------------------------------------------------------

describe('mid-term body schemas — envelope and pagination', () => {
  it('accepts a well-formed body for each operation', () => {
    expect(kmaMidtermTemperatureBodySchema.safeParse(body(temperatureItem())).success).toBe(true);
    expect(kmaMidtermLandBodySchema.safeParse(body(landItem())).success).toBe(true);
  });

  it('requires dataType to be the literal JSON', () => {
    for (const dataType of ['XML', 'json', '', 1, null]) {
      expect(kmaMidtermTemperatureBodySchema.safeParse(body(temperatureItem(), { dataType })).success).toBe(
        false,
      );
    }
  });

  it('requires numeric pagination fields', () => {
    expect(kmaMidtermTemperatureBodySchema.safeParse(body(temperatureItem(), { pageNo: '1' })).success).toBe(
      false,
    );
    expect(kmaMidtermTemperatureBodySchema.safeParse(body(temperatureItem(), { pageNo: 0 })).success).toBe(
      false,
    );
    expect(kmaMidtermTemperatureBodySchema.safeParse(body(temperatureItem(), { numOfRows: 0 })).success).toBe(
      false,
    );
    expect(kmaMidtermTemperatureBodySchema.safeParse(body(temperatureItem(), { totalCount: -1 })).success).toBe(
      false,
    );
  });

  it('requires items.item to be an array — a single bare object is rejected', () => {
    expect(
      kmaMidtermTemperatureBodySchema.safeParse(
        body(temperatureItem(), { items: { item: temperatureItem() } }),
      ).success,
    ).toBe(false);
    expect(
      kmaMidtermLandBodySchema.safeParse(body(landItem(), { items: { item: '' } })).success,
    ).toBe(false);
  });

  it('accepts an empty page with totalCount 0', () => {
    const parsed = kmaMidtermTemperatureBodySchema.parse(
      body(temperatureItem(), { totalCount: 0, items: { item: [] } }),
    );
    expect(parsed.items.item).toEqual([]);
    expect(parsed.totalCount).toBe(0);
  });

  it('rejects a page that contradicts itself', () => {
    // items present while totalCount is zero
    expect(
      kmaMidtermTemperatureBodySchema.safeParse(body(temperatureItem(), { totalCount: 0 })).success,
    ).toBe(false);
    // more items than numOfRows
    expect(
      kmaMidtermLandBodySchema.safeParse(
        body(landItem(), { numOfRows: 1, totalCount: 2, items: { item: [landItem(), landItem()] } }),
      ).success,
    ).toBe(false);
    // more items than totalCount
    expect(
      kmaMidtermLandBodySchema.safeParse(
        body(landItem(), { totalCount: 1, items: { item: [landItem(), landItem()] } }),
      ).success,
    ).toBe(false);
  });

  it('leaves a short page permissive (the provider reports it as INCOMPLETE_PAGE instead)', () => {
    expect(
      kmaMidtermTemperatureBodySchema.safeParse(body(temperatureItem(), { totalCount: 5 })).success,
    ).toBe(true);
  });

  it('rejects the other operation body under each success envelope', () => {
    expect(
      kmaMidtermTemperatureSuccessResponseSchema.safeParse(envelope(body(landItem()))).success,
    ).toBe(false);
    expect(
      kmaMidtermLandSuccessResponseSchema.safeParse(envelope(body(temperatureItem()))).success,
    ).toBe(false);
  });

  it('accepts each success envelope with a valid header and body', () => {
    expect(
      kmaMidtermTemperatureSuccessResponseSchema.safeParse(envelope(body(temperatureItem()))).success,
    ).toBe(true);
    expect(kmaMidtermLandSuccessResponseSchema.safeParse(envelope(body(landItem()))).success).toBe(
      true,
    );
  });

  it('rejects a success envelope with a malformed header', () => {
    expect(
      kmaMidtermTemperatureSuccessResponseSchema.safeParse(
        envelope(body(temperatureItem()), '000'),
      ).success,
    ).toBe(false);
  });
});
