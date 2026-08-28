import { describe, expect, it } from 'vitest';

import { dailyForecast, type HourlyForecast } from '@life-weather/contracts';

import { deriveKmaDailyForecastFromHourly } from './kma-daily-from-hourly.js';

/**
 * These tests exercise the pure PR #96 daily derivation against the **public** contracts value it
 * produces: which calendar dates are eligible, and what each eligible day carries. No provider, no
 * clock, no network, no fake timers — the function under test is synchronous and takes only a
 * `HourlyForecast[]`.
 *
 * Every fixture is built fresh per call, so no test shares a mutable entry or array. The KST offset in
 * `forecastAt` mirrors what the PR #6 KMA normalizer actually emits (`+09:00`), and a few tests use the
 * equivalent `Z` form the contracts `isoDateTime` schema also admits, to prove the KST identity is
 * derived from the instant rather than from the literal characters.
 */

/** Two digits, matching the `HH` of a KMA forecast time. */
function padTwo(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

/** A fresh, complete, schema-valid `HourlyForecast` at the given KST `forecastAt`. */
function makeHourly(
  forecastAt: string,
  overrides: Partial<HourlyForecast> = {},
): HourlyForecast {
  return {
    forecastAt,
    condition: 'CLEAR',
    temperatureCelsius: 20,
    feelsLikeCelsius: null,
    precipitationProbabilityPercent: 20,
    precipitationAmountMillimeters: 0,
    snowfallAmountCentimeters: 0,
    humidityPercent: 55,
    windSpeedMetersPerSecond: 3.4,
    windDirectionDegrees: 270,
    ...overrides,
  };
}

/** The KST `forecastAt` for one clock hour of a date, in the `+09:00` form the normalizer emits. */
function kstAt(date: string, hour: number): string {
  return `${date}T${padTwo(hour)}:00:00+09:00`;
}

/**
 * A fresh, complete 24-hour KST day (`00:00`–`23:00`) for `date`. `base` applies to every hour and
 * `perHour` then overrides any single entry by its clock hour, so a test can set the whole day's
 * baseline and still place a distinct temperature/condition/probability at one hour.
 */
function makeCompleteDay(
  date: string,
  perHour: Readonly<Record<number, Partial<HourlyForecast>>> = {},
  base: Partial<HourlyForecast> = {},
): HourlyForecast[] {
  return Array.from({ length: 24 }, (_unused, hour) =>
    makeHourly(kstAt(date, hour), { ...base, ...(perHour[hour] ?? {}) }),
  );
}

/** A deterministic, seeded shuffle — no `Math.random`, so a failure is always reproducible. */
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const shuffled = [...items];
  let state = seed;
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    // A small LCG; only its determinism matters here.
    state = (state * 1103515245 + 12345) % 2147483648;
    const swapIndex = state % (index + 1);
    const held = shuffled[index];
    shuffled[index] = shuffled[swapIndex];
    shuffled[swapIndex] = held;
  }
  return shuffled;
}

/** A structural deep clone used to prove the input was not mutated. */
function snapshot(value: unknown): string {
  return JSON.stringify(value);
}

describe('deriveKmaDailyForecastFromHourly — day eligibility', () => {
  it('A. one complete 24-hour day → exactly one DailyForecast for that date', () => {
    const daily = deriveKmaDailyForecastFromHourly(makeCompleteDay('2026-07-22'));

    expect(daily).toHaveLength(1);
    expect(daily[0].date).toBe('2026-07-22');
  });

  it('B. two complete days → two entries ordered by date ascending', () => {
    const daily = deriveKmaDailyForecastFromHourly([
      ...makeCompleteDay('2026-07-23'),
      ...makeCompleteDay('2026-07-22'),
    ]);

    expect(daily.map((day) => day.date)).toEqual(['2026-07-22', '2026-07-23']);
  });

  it('B2. three complete days spanning a month boundary stay chronologically ordered', () => {
    const daily = deriveKmaDailyForecastFromHourly([
      ...makeCompleteDay('2026-08-01'),
      ...makeCompleteDay('2026-07-31'),
      ...makeCompleteDay('2026-09-01'),
    ]);

    expect(daily.map((day) => day.date)).toEqual([
      '2026-07-31',
      '2026-08-01',
      '2026-09-01',
    ]);
  });

  it('C. a partial leading (current) day is omitted; the following complete day is kept', () => {
    // The KMA horizon typically starts mid-day: only hours 14–23 of the first date are present.
    const partialFirstDay = Array.from({ length: 10 }, (_unused, index) =>
      makeHourly(kstAt('2026-07-22', 14 + index)),
    );

    const daily = deriveKmaDailyForecastFromHourly([
      ...partialFirstDay,
      ...makeCompleteDay('2026-07-23'),
    ]);

    expect(daily.map((day) => day.date)).toEqual(['2026-07-23']);
  });

  it('D. a truncated tail day is omitted; the preceding complete day is kept', () => {
    const partialTailDay = Array.from({ length: 6 }, (_unused, hour) =>
      makeHourly(kstAt('2026-07-24', hour)),
    );

    const daily = deriveKmaDailyForecastFromHourly([
      ...makeCompleteDay('2026-07-23'),
      ...partialTailDay,
    ]);

    expect(daily.map((day) => day.date)).toEqual(['2026-07-23']);
  });

  it('E. a day missing exactly one hour is omitted entirely', () => {
    const missingThirteen = makeCompleteDay('2026-07-22').filter(
      (entry) => entry.forecastAt !== kstAt('2026-07-22', 13),
    );
    expect(missingThirteen).toHaveLength(23);

    expect(deriveKmaDailyForecastFromHourly(missingThirteen)).toEqual([]);
  });

  it('E2. a missing hour omits only its own date — other complete dates still derive', () => {
    const missingZero = makeCompleteDay('2026-07-22').filter(
      (entry) => entry.forecastAt !== kstAt('2026-07-22', 0),
    );

    const daily = deriveKmaDailyForecastFromHourly([
      ...missingZero,
      ...makeCompleteDay('2026-07-23'),
    ]);

    expect(daily.map((day) => day.date)).toEqual(['2026-07-23']);
  });

  it('F. a duplicated date/hour omits that date rather than guessing which entry wins', () => {
    const duplicated = [
      ...makeCompleteDay('2026-07-22'),
      makeHourly(kstAt('2026-07-22', 9), { temperatureCelsius: 99 }),
    ];

    expect(deriveKmaDailyForecastFromHourly(duplicated)).toEqual([]);
  });

  it('F2. a duplicate expressed in a different but equivalent instant form is still a duplicate', () => {
    // 2026-07-22T09:00+09:00 is the same instant as 2026-07-22T00:00Z.
    const duplicated = [
      ...makeCompleteDay('2026-07-22'),
      makeHourly('2026-07-22T00:00:00Z'),
    ];

    expect(deriveKmaDailyForecastFromHourly(duplicated)).toEqual([]);
  });

  it('F3. a duplicated date omits only that date — a sibling complete date still derives', () => {
    const daily = deriveKmaDailyForecastFromHourly([
      ...makeCompleteDay('2026-07-22'),
      makeHourly(kstAt('2026-07-22', 15)),
      ...makeCompleteDay('2026-07-23'),
    ]);

    expect(daily.map((day) => day.date)).toEqual(['2026-07-23']);
  });

  it('F4. an off-the-hour entry omits its date, and never fills an hour slot', () => {
    const withHalfHour = [
      ...makeCompleteDay('2026-07-22'),
      makeHourly('2026-07-22T09:30:00+09:00'),
    ];

    expect(deriveKmaDailyForecastFromHourly(withHalfHour)).toEqual([]);
  });

  it('empty input → empty output', () => {
    expect(deriveKmaDailyForecastFromHourly([])).toEqual([]);
  });

  it('a 23-hour horizon spanning two dates yields nothing (neither date is complete)', () => {
    const spanning = [
      ...Array.from({ length: 12 }, (_unused, index) =>
        makeHourly(kstAt('2026-07-22', 12 + index)),
      ),
      ...Array.from({ length: 11 }, (_unused, hour) => makeHourly(kstAt('2026-07-23', hour))),
    ];
    expect(spanning).toHaveLength(23);

    expect(deriveKmaDailyForecastFromHourly(spanning)).toEqual([]);
  });
});

describe('deriveKmaDailyForecastFromHourly — KST identity', () => {
  it('a complete day expressed entirely in the UTC `Z` form derives the same KST calendar date', () => {
    // KST 2026-07-22 00:00–23:00 is UTC 2026-07-21 15:00 through 2026-07-22 14:00.
    const utcForm = Array.from({ length: 24 }, (_unused, hour) => {
      const utcHour = (hour + 15) % 24;
      const utcDate = hour < 9 ? '2026-07-21' : '2026-07-22';
      return makeHourly(`${utcDate}T${padTwo(utcHour)}:00:00Z`);
    });

    const daily = deriveKmaDailyForecastFromHourly(utcForm);

    expect(daily).toHaveLength(1);
    expect(daily[0].date).toBe('2026-07-22');
  });

  it('a day that crosses a KST month boundary is attributed to the KST date, not the UTC date', () => {
    const daily = deriveKmaDailyForecastFromHourly(makeCompleteDay('2026-08-01'));

    expect(daily.map((day) => day.date)).toEqual(['2026-08-01']);
  });

  it('an unparseable timestamp yields no daily at all rather than an attributed guess', () => {
    const withBadTimestamp = [
      ...makeCompleteDay('2026-07-22'),
      // Structurally impossible calendar date; defensive only — the caller validates `hourly` first.
      makeHourly('2026-02-30T09:00:00+09:00'),
    ];

    expect(deriveKmaDailyForecastFromHourly(withBadTimestamp)).toEqual([]);
  });
});

describe('deriveKmaDailyForecastFromHourly — millisecond precision', () => {
  /**
   * The contracts `isoDateTime` schema admits **either** seconds precision **or** exactly-3-digit
   * milliseconds, so `…:00.123+09:00` is a legal input this derivation must actually read. Only an
   * exact KST clock hour may fill an hour slot, so a non-zero millisecond component is off the hour
   * and disqualifies its own KST date — it must never be truncated into the matching `HH:00` slot.
   */

  it('a contract-valid `.123` entry never fills its hour slot — its KST date is omitted entirely', () => {
    const day = makeCompleteDay('2026-07-22');
    // Replace the otherwise-exact 09:00 entry with the same hour carrying 123 ms.
    day[9] = makeHourly('2026-07-22T09:00:00.123+09:00');

    expect(deriveKmaDailyForecastFromHourly(day)).toEqual([]);
  });

  it('a `.123` entry omits only its own KST date — a sibling complete date still derives', () => {
    // Proves the millisecond entry resolves to a known date it poisons, rather than becoming an
    // unattributable timestamp that would suppress the whole derivation.
    const poisoned = makeCompleteDay('2026-07-22');
    poisoned[15] = makeHourly('2026-07-22T15:00:00.001+09:00');

    const daily = deriveKmaDailyForecastFromHourly([
      ...poisoned,
      ...makeCompleteDay('2026-07-23'),
    ]);

    expect(daily.map((day) => day.date)).toEqual(['2026-07-23']);
  });

  it('contract-valid `.000` entries are exact clock hours, so the day stays eligible', () => {
    const day = makeCompleteDay('2026-07-22');
    day[9] = makeHourly('2026-07-22T09:00:00.000+09:00');
    day[15] = makeHourly('2026-07-22T15:00:00.000+09:00');

    const daily = deriveKmaDailyForecastFromHourly(day);

    expect(daily).toHaveLength(1);
    expect(daily[0].date).toBe('2026-07-22');
  });

  it('a complete day in the millisecond `Z` form maps to the same KST date and stays eligible', () => {
    // KST 2026-07-22 00:00–23:00 is UTC 2026-07-21 15:00 through 2026-07-22 14:00; KST 09:00 is
    // exactly `2026-07-22T00:00:00.000Z`.
    const utcMillisecondForm = Array.from({ length: 24 }, (_unused, hour) => {
      const utcHour = (hour + 15) % 24;
      const utcDate = hour < 9 ? '2026-07-21' : '2026-07-22';
      return makeHourly(`${utcDate}T${padTwo(utcHour)}:00:00.000Z`);
    });

    const daily = deriveKmaDailyForecastFromHourly(utcMillisecondForm);

    expect(daily).toHaveLength(1);
    expect(daily[0].date).toBe('2026-07-22');
  });

  it('a non-zero millisecond `Z` entry resolves to KST 09:00:00.123 and disqualifies that KST date', () => {
    const day = makeCompleteDay('2026-07-22');
    // The UTC spelling of KST 2026-07-22 09:00, carrying 123 ms.
    day[9] = makeHourly('2026-07-22T00:00:00.123Z');

    expect(deriveKmaDailyForecastFromHourly(day)).toEqual([]);
  });
});

describe('deriveKmaDailyForecastFromHourly — temperatures', () => {
  it('G. min/max come from all 24 hourly temperatures, including hours outside 09/15', () => {
    const daily = deriveKmaDailyForecastFromHourly(
      makeCompleteDay('2026-07-22', {
        3: { temperatureCelsius: 17.2 },
        9: { temperatureCelsius: 24 },
        15: { temperatureCelsius: 28 },
        21: { temperatureCelsius: 31.6 },
      }),
    );

    expect(daily[0].minimumTemperatureCelsius).toBe(17.2);
    expect(daily[0].maximumTemperatureCelsius).toBe(31.6);
  });

  it('L. negative temperatures produce a correct min and max', () => {
    const daily = deriveKmaDailyForecastFromHourly(
      makeCompleteDay(
        '2026-01-15',
        {
          0: { temperatureCelsius: -12.5 },
          6: { temperatureCelsius: -18 },
          14: { temperatureCelsius: -3.1 },
          23: { temperatureCelsius: -9 },
        },
        { temperatureCelsius: -7.4 },
      ),
    );

    expect(daily[0].minimumTemperatureCelsius).toBe(-18);
    expect(daily[0].maximumTemperatureCelsius).toBe(-3.1);
  });

  it('a flat day has min equal to max, and both equal the single temperature', () => {
    const daily = deriveKmaDailyForecastFromHourly(makeCompleteDay('2026-07-22'));

    expect(daily[0].minimumTemperatureCelsius).toBe(20);
    expect(daily[0].maximumTemperatureCelsius).toBe(20);
  });

  it('a 0 °C hour is used as a real value, not treated as absent', () => {
    const daily = deriveKmaDailyForecastFromHourly(
      makeCompleteDay(
        '2026-01-15',
        { 0: { temperatureCelsius: 0 }, 12: { temperatureCelsius: 5 } },
        { temperatureCelsius: 2 },
      ),
    );

    expect(daily[0].minimumTemperatureCelsius).toBe(0);
    expect(daily[0].maximumTemperatureCelsius).toBe(5);
  });
});

describe('deriveKmaDailyForecastFromHourly — morning / afternoon periods', () => {
  it('H. morning copies the 09:00 condition and precipitation probability exactly', () => {
    const daily = deriveKmaDailyForecastFromHourly(
      makeCompleteDay('2026-07-22', {
        9: { condition: 'RAIN', precipitationProbabilityPercent: 80 },
        10: { condition: 'SNOW', precipitationProbabilityPercent: 90 },
      }),
    );

    expect(daily[0].morning).toEqual({
      condition: 'RAIN',
      precipitationProbabilityPercent: 80,
    });
  });

  it('I. afternoon copies the 15:00 condition and precipitation probability exactly', () => {
    const daily = deriveKmaDailyForecastFromHourly(
      makeCompleteDay('2026-07-22', {
        14: { condition: 'FOG', precipitationProbabilityPercent: 10 },
        15: { condition: 'THUNDERSTORM', precipitationProbabilityPercent: 70 },
        16: { condition: 'SNOW', precipitationProbabilityPercent: 95 },
      }),
    );

    expect(daily[0].afternoon).toEqual({
      condition: 'THUNDERSTORM',
      precipitationProbabilityPercent: 70,
    });
  });

  it('the two periods are independent — a distinct 09:00 and 15:00 are both preserved', () => {
    const daily = deriveKmaDailyForecastFromHourly(
      makeCompleteDay('2026-07-22', {
        9: { condition: 'CLOUDY', precipitationProbabilityPercent: 30 },
        15: { condition: 'CLEAR', precipitationProbabilityPercent: 0 },
      }),
    );

    expect(daily[0].morning).toEqual({
      condition: 'CLOUDY',
      precipitationProbabilityPercent: 30,
    });
    expect(daily[0].afternoon).toEqual({
      condition: 'CLEAR',
      precipitationProbabilityPercent: 0,
    });
  });

  it('J. a null precipitation probability is preserved as null, never converted to 0', () => {
    const daily = deriveKmaDailyForecastFromHourly(
      makeCompleteDay('2026-07-22', {
        9: { precipitationProbabilityPercent: null },
        15: { precipitationProbabilityPercent: null },
      }),
    );

    expect(daily[0].morning?.precipitationProbabilityPercent).toBeNull();
    expect(daily[0].afternoon?.precipitationProbabilityPercent).toBeNull();
  });

  it('K. a confirmed 0 precipitation probability is preserved as 0, never as null', () => {
    const daily = deriveKmaDailyForecastFromHourly(
      makeCompleteDay('2026-07-22', {
        9: { precipitationProbabilityPercent: 0 },
        15: { precipitationProbabilityPercent: 0 },
      }),
    );

    expect(daily[0].morning?.precipitationProbabilityPercent).toBe(0);
    expect(daily[0].afternoon?.precipitationProbabilityPercent).toBe(0);
  });

  it('a period carries only condition and precipitation probability — no other hourly field', () => {
    const daily = deriveKmaDailyForecastFromHourly(makeCompleteDay('2026-07-22'));

    expect(Object.keys(daily[0].morning ?? {}).sort()).toEqual([
      'condition',
      'precipitationProbabilityPercent',
    ]);
    expect(Object.keys(daily[0].afternoon ?? {}).sort()).toEqual([
      'condition',
      'precipitationProbabilityPercent',
    ]);
  });

  it('O. overall, sunriseAt and sunsetAt are always null — nothing is invented', () => {
    const daily = deriveKmaDailyForecastFromHourly([
      ...makeCompleteDay('2026-07-22'),
      ...makeCompleteDay('2026-07-23'),
    ]);

    for (const day of daily) {
      expect(day.overall).toBeNull();
      expect(day.sunriseAt).toBeNull();
      expect(day.sunsetAt).toBeNull();
    }
  });

  it('every derived day satisfies the contracts dailyForecast schema and its exact key set', () => {
    const daily = deriveKmaDailyForecastFromHourly(makeCompleteDay('2026-07-22'));

    expect(dailyForecast.safeParse(daily[0]).success).toBe(true);
    expect(Object.keys(daily[0]).sort()).toEqual([
      'afternoon',
      'date',
      'maximumTemperatureCelsius',
      'minimumTemperatureCelsius',
      'morning',
      'overall',
      'sunriseAt',
      'sunsetAt',
    ]);
  });
});

describe('deriveKmaDailyForecastFromHourly — determinism and immutability', () => {
  it('M. shuffled input produces the identical result', () => {
    const entries = [
      ...makeCompleteDay('2026-07-22', {
        4: { temperatureCelsius: 18 },
        9: { condition: 'RAIN', precipitationProbabilityPercent: 60 },
        15: { condition: 'CLOUDY', precipitationProbabilityPercent: 40 },
        20: { temperatureCelsius: 30 },
      }),
      ...makeCompleteDay('2026-07-23', { 15: { temperatureCelsius: 33 } }),
      // A partial day that must stay omitted regardless of position in the array.
      makeHourly(kstAt('2026-07-24', 0)),
    ];

    const expected = deriveKmaDailyForecastFromHourly(entries);
    expect(expected.map((day) => day.date)).toEqual(['2026-07-22', '2026-07-23']);

    for (const seed of [1, 7, 4242, 999_983]) {
      expect(deriveKmaDailyForecastFromHourly(shuffle(entries, seed))).toEqual(expected);
    }
  });

  it('repeated calls on the same input return equal values in fresh arrays and objects', () => {
    const entries = makeCompleteDay('2026-07-22');

    const first = deriveKmaDailyForecastFromHourly(entries);
    const second = deriveKmaDailyForecastFromHourly(entries);

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);
  });

  it('N. neither the input array nor any input item is mutated', () => {
    const entries = [
      ...makeCompleteDay('2026-07-22', { 9: { condition: 'RAIN' } }),
      makeHourly(kstAt('2026-07-23', 0)),
    ];
    const before = snapshot(entries);
    const firstItem = entries[0];

    const daily = deriveKmaDailyForecastFromHourly(entries);
    expect(daily).toHaveLength(1);

    expect(snapshot(entries)).toBe(before);
    expect(entries).toHaveLength(25);
    expect(entries[0]).toBe(firstItem);
  });

  it('a derived period is a fresh object, not a reference into the hourly entry', () => {
    const entries = makeCompleteDay('2026-07-22');
    const nineOClock = entries[9];

    const daily = deriveKmaDailyForecastFromHourly(entries);

    expect(daily[0].morning).not.toBe(nineOClock);
    expect(daily[0].morning?.condition).toBe(nineOClock.condition);
  });
});
