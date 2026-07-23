import { afterEach, describe, expect, it, vi } from 'vitest';

import { hourlyForecast, type HourlyForecast } from '@life-weather/contracts';
import { KmaForecastProduct } from '@life-weather/weather-core';

import type {
  KmaForecastProviderError,
  KmaHourlyNormalizationIssue,
} from '../providers/kma';
import type { KmaForecastIssuanceIdentity } from './kma-forecast-issuance-identity';
import type { KmaHourlyFallbackReason } from './kma-hourly-fallback-eligibility';
import {
  selectKmaHourlyFallbackResult,
  type KmaHourlyFallbackSelection,
  type KmaHourlyFallbackSelectionSource,
} from './kma-hourly-fallback-selection';
import type { KmaHourlyFallbackServiceResult } from './kma-hourly-fallback';
import type { KmaHourlyForecastServiceResult } from './kma-hourly-forecast';

// ---------------------------------------------------------------------------
// Key contracts — every selection branch has the identical own key set, and a
// fixed list of fields that must never leak onto the wrapper.
// ---------------------------------------------------------------------------

/** The exact own keys of every selection branch, sorted for a stable comparison. */
const SELECTION_KEYS = [
  'execution',
  'fallbackUsed',
  'result',
  'selected',
  'source',
] as const;

/**
 * Fields that must never appear on any selection branch: trace-internal fields (which live inside
 * `execution`) and every transport/selection alias the design explicitly forbids.
 */
const FORBIDDEN_KEYS = [
  'primary',
  'previous',
  'fallbackAttempted',
  'fallbackReason',
  'final',
  'finalResult',
  'selectedResult',
  'selectedSource',
  'usable',
  'reason',
  'error',
  'stage',
  'status',
  'stale',
  'provider',
  'request',
  'metadata',
  'sourceMetadata',
  'attemptCount',
] as const;

/** The two legal selected-source values, typed so the public source type stays referenced. */
const SOURCE_VALUES: readonly KmaHourlyFallbackSelectionSource[] = [
  'PRIMARY',
  'PREVIOUS',
];

/** The forecast product every fixture trace uses. */
const SHORT = KmaForecastProduct.SHORT_FORECAST;

// ---------------------------------------------------------------------------
// Fixture builders — every mutable fixture is built fresh per call, so no test
// shares a mutable result/execution/hourly object.
// ---------------------------------------------------------------------------

/**
 * A fresh, complete, schema-valid `HourlyForecast` written as a full literal. `forecastAt` is
 * overridable so a test can build distinct entries; every other field is a concrete value.
 */
function makeHourly(
  forecastAt = '2026-07-22T14:00:00+09:00',
): HourlyForecast {
  return {
    forecastAt,
    condition: 'CLEAR',
    temperatureCelsius: 25.5,
    feelsLikeCelsius: null,
    precipitationProbabilityPercent: 20,
    precipitationAmountMillimeters: 1,
    snowfallAmountCentimeters: 0,
    humidityPercent: 55,
    windSpeedMetersPerSecond: 3.4,
    windDirectionDegrees: 270,
  };
}

/** A fresh non-empty success result carrying the given (or a fresh default) hourly array. */
function makeSuccess(
  hourly: readonly HourlyForecast[] = [makeHourly()],
): KmaHourlyForecastServiceResult {
  return { ok: true, hourly };
}

/** A fresh empty (usable-failing) success result. */
function makeEmptySuccess(): KmaHourlyForecastServiceResult {
  return { ok: true, hourly: [] };
}

/** A fresh `PROVIDER`-stage error result wrapping the given provider error. */
function makeProviderError(
  error: KmaForecastProviderError,
): KmaHourlyForecastServiceResult {
  return { ok: false, stage: 'PROVIDER', error };
}

/** A fresh `PROVIDER`-stage `KMA_UPSTREAM_ERROR` result for the given `resultCode`. */
function makeUpstream(resultCode: string): KmaHourlyForecastServiceResult {
  return makeProviderError({ kind: 'KMA_UPSTREAM_ERROR', resultCode });
}

/** A fresh `NORMALIZATION`-stage error result carrying the given (or a fresh default) issues. */
function makeNormalizationError(
  issues: readonly KmaHourlyNormalizationIssue[] = [
    {
      slotKey: 'SHORT_FORECAST|20260722|0500|20260722|1400|60|127',
      field: 'temperatureCelsius',
      reason: 'ABSENT',
    },
  ],
): KmaHourlyForecastServiceResult {
  return { ok: false, stage: 'NORMALIZATION', issues };
}

/** The no-fallback branch of the trace union (primary only). */
type NoFallbackExecution = Extract<
  KmaHourlyFallbackServiceResult,
  { readonly fallbackAttempted: false }
>;

/** The fallback-attempted branch of the trace union (primary + previous). */
type FallbackExecution = Extract<
  KmaHourlyFallbackServiceResult,
  { readonly fallbackAttempted: true }
>;

/** The sanitized primary issuance identity every fresh trace carries (product/baseDate/baseTime only). */
function makePrimaryIssuance(): KmaForecastIssuanceIdentity {
  return { product: SHORT, baseDate: '20260722', baseTime: '0500' };
}

/** The sanitized previous issuance identity a fallback-attempted trace carries. */
function makePreviousIssuance(): KmaForecastIssuanceIdentity {
  return { product: SHORT, baseDate: '20260722', baseTime: '0200' };
}

/** A fresh no-fallback execution trace (primary only, previous never invoked). */
function makeNoFallbackExecution(
  primary: KmaHourlyForecastServiceResult,
): NoFallbackExecution {
  return { fallbackAttempted: false, primaryIssuance: makePrimaryIssuance(), primary };
}

/** A fresh fallback-attempted execution trace (primary then a single previous invocation). */
function makeFallbackExecution(
  primary: KmaHourlyForecastServiceResult,
  previous: KmaHourlyForecastServiceResult,
  fallbackReason: KmaHourlyFallbackReason = 'EMPTY_HOURLY',
): FallbackExecution {
  return {
    fallbackAttempted: true,
    fallbackReason,
    primaryIssuance: makePrimaryIssuance(),
    primary,
    previousIssuance: makePreviousIssuance(),
    previous,
  };
}

// ---------------------------------------------------------------------------
// Assertion helpers.
// ---------------------------------------------------------------------------

/** Assert the wrapper has exactly the five selection keys and none of the forbidden ones. */
function expectExactSelectionKeys(selection: KmaHourlyFallbackSelection): void {
  expect(Object.keys(selection).sort()).toEqual([...SELECTION_KEYS]);
  for (const key of FORBIDDEN_KEYS) {
    expect(Object.prototype.hasOwnProperty.call(selection, key)).toBe(false);
  }
}

/** Assert the cross-field invariants that must hold on every selection, whatever the branch. */
function expectSelectionInvariants(
  selection: KmaHourlyFallbackSelection,
): void {
  if (selection.fallbackUsed) {
    expect(selection.selected).toBe(true);
    expect(selection.source).toBe('PREVIOUS');
  }
  if (selection.source === 'PREVIOUS') {
    expect(selection.fallbackUsed).toBe(true);
  }
  if (selection.source === 'PRIMARY') {
    expect(selection.fallbackUsed).toBe(false);
  }
  if (!selection.selected) {
    expect(selection.fallbackUsed).toBe(false);
    expect(selection.source).toBeNull();
    expect(selection.result).toBeNull();
  }
  expect(SOURCE_VALUES.includes(selection.source as KmaHourlyFallbackSelectionSource)).toBe(
    selection.source !== null,
  );
}

/** Spy on the three console methods used in a run; each returns a no-op mock. */
function spyOnConsole(): {
  log: ReturnType<typeof vi.spyOn>;
  warn: ReturnType<typeof vi.spyOn>;
  error: ReturnType<typeof vi.spyOn>;
} {
  return {
    log: vi.spyOn(console, 'log').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
  };
}

/** Recursively freeze so any attempted mutation of the input would throw in strict mode. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixture sanity — the HourlyForecast fixtures satisfy the real contract.
// ---------------------------------------------------------------------------

describe('fixture sanity', () => {
  it('builds HourlyForecast fixtures that satisfy the real contracts schema', () => {
    expect(hourlyForecast.safeParse(makeHourly()).success).toBe(true);
    expect(
      hourlyForecast.safeParse(makeHourly('2026-07-22T15:00:00+09:00')).success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §16 — no-fallback primary selection.
// ---------------------------------------------------------------------------

describe('no-fallback primary selection', () => {
  it('selects PRIMARY for a non-empty success primary and never uses fallback', () => {
    const hourly = [makeHourly()];
    const primary = makeSuccess(hourly);
    const execution = makeNoFallbackExecution(primary);

    const selection = selectKmaHourlyFallbackResult(execution);

    expect(selection.selected).toBe(true);
    expect(selection.source).toBe('PRIMARY');
    expect(selection.fallbackUsed).toBe(false);
    expect(selection.result).toBe(primary);
    expect(selection.execution).toBe(execution);
    expectExactSelectionKeys(selection);
    expectSelectionInvariants(selection);
  });

  it('preserves the exact result, execution, and hourly-array references', () => {
    const hourly = [makeHourly()];
    const primary = makeSuccess(hourly);
    const execution = makeNoFallbackExecution(primary);

    const selection = selectKmaHourlyFallbackResult(execution);

    expect(selection.result).toBe(execution.primary);
    expect(selection.execution).toBe(execution);
    if (selection.selected) {
      expect(selection.result.hourly).toBe(hourly);
    }
  });

  it('does not mutate the execution trace when selecting PRIMARY', () => {
    const execution = makeNoFallbackExecution(makeSuccess());
    const snapshot = JSON.stringify(execution);

    selectKmaHourlyFallbackResult(execution);

    expect(JSON.stringify(execution)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// §17 — no-fallback, no selection. Every unusable primary yields the same shape.
// ---------------------------------------------------------------------------

describe('no-fallback, unusable primary → no selection', () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly primary: () => KmaHourlyForecastServiceResult;
  }> = [
    { name: 'success + empty hourly', primary: makeEmptySuccess },
    { name: 'PROVIDER ABORTED', primary: () => makeProviderError({ kind: 'ABORTED' }) },
    { name: 'PROVIDER TIMEOUT', primary: () => makeProviderError({ kind: 'TIMEOUT' }) },
    {
      name: 'PROVIDER NETWORK_ERROR',
      primary: () => makeProviderError({ kind: 'NETWORK_ERROR' }),
    },
    {
      name: 'PROVIDER HTTP_ERROR',
      primary: () => makeProviderError({ kind: 'HTTP_ERROR', status: 503 }),
    },
    { name: 'PROVIDER KMA_UPSTREAM_ERROR 03', primary: () => makeUpstream('03') },
    { name: 'PROVIDER KMA_UPSTREAM_ERROR non-03', primary: () => makeUpstream('99') },
    { name: 'NORMALIZATION error', primary: () => makeNormalizationError() },
  ];

  for (const { name, primary } of cases) {
    it(`returns no selection for an unusable primary: ${name}`, () => {
      const primaryResult = primary();
      const execution = makeNoFallbackExecution(primaryResult);

      const selection = selectKmaHourlyFallbackResult(execution);

      expect(selection.selected).toBe(false);
      expect(selection.source).toBeNull();
      expect(selection.fallbackUsed).toBe(false);
      expect(selection.result).toBeNull();
      expect(selection.execution).toBe(execution);
      expectExactSelectionKeys(selection);
      expectSelectionInvariants(selection);
    });
  }
});

// ---------------------------------------------------------------------------
// §18 — previous selection (primary unusable, previous usable).
// ---------------------------------------------------------------------------

describe('previous selection', () => {
  it('selects PREVIOUS when primary is empty and previous is non-empty', () => {
    const previousHourly = [makeHourly('2026-07-22T13:00:00+09:00')];
    const previous = makeSuccess(previousHourly);
    const execution = makeFallbackExecution(
      makeEmptySuccess(),
      previous,
      'EMPTY_HOURLY',
    );

    const selection = selectKmaHourlyFallbackResult(execution);

    expect(selection.selected).toBe(true);
    expect(selection.source).toBe('PREVIOUS');
    expect(selection.fallbackUsed).toBe(true);
    expect(selection.result).toBe(previous);
    expect(selection.execution).toBe(execution);
    if (selection.selected) {
      expect(selection.result.hourly).toBe(previousHourly);
    }
    expectExactSelectionKeys(selection);
    expectSelectionInvariants(selection);
  });

  it('selects PREVIOUS when primary is KMA upstream 03 and previous is non-empty', () => {
    const previous = makeSuccess();
    const execution = makeFallbackExecution(
      makeUpstream('03'),
      previous,
      'KMA_NO_DATA',
    );

    const selection = selectKmaHourlyFallbackResult(execution);

    expect(selection.source).toBe('PREVIOUS');
    expect(selection.fallbackUsed).toBe(true);
    expect(selection.result).toBe(execution.previous);
    expectExactSelectionKeys(selection);
    expectSelectionInvariants(selection);
  });

  it('selects PREVIOUS for a structurally valid custom trace whose primary is any other error', () => {
    // A hand-built trace: primary is an HTTP error (not a production fallback trigger), but the
    // selector must still select a usable previous — it does not re-check eligibility reasons.
    const previous = makeSuccess();
    const execution = makeFallbackExecution(
      makeProviderError({ kind: 'HTTP_ERROR', status: 500 }),
      previous,
      'KMA_NO_DATA',
    );

    const selection = selectKmaHourlyFallbackResult(execution);

    expect(selection.source).toBe('PREVIOUS');
    expect(selection.fallbackUsed).toBe(true);
    expect(selection.result).toBe(execution.previous);
    expectSelectionInvariants(selection);
  });
});

// ---------------------------------------------------------------------------
// §19 — previous unusable (fallbackAttempted true, fallbackUsed false).
// ---------------------------------------------------------------------------

describe('fallback attempted but previous unusable → no selection', () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly previous: () => KmaHourlyForecastServiceResult;
  }> = [
    { name: 'empty success', previous: makeEmptySuccess },
    { name: 'KMA upstream 03', previous: () => makeUpstream('03') },
    {
      name: 'HTTP 503',
      previous: () => makeProviderError({ kind: 'HTTP_ERROR', status: 503 }),
    },
    { name: 'ABORTED', previous: () => makeProviderError({ kind: 'ABORTED' }) },
    {
      name: 'NETWORK_ERROR',
      previous: () => makeProviderError({ kind: 'NETWORK_ERROR' }),
    },
    { name: 'NORMALIZATION error', previous: () => makeNormalizationError() },
  ];

  for (const { name, previous } of cases) {
    it(`returns no selection when primary empty and previous is: ${name}`, () => {
      const execution = makeFallbackExecution(
        makeEmptySuccess(),
        previous(),
        'EMPTY_HOURLY',
      );

      const selection = selectKmaHourlyFallbackResult(execution);

      expect(selection.selected).toBe(false);
      expect(selection.source).toBeNull();
      expect(selection.fallbackUsed).toBe(false);
      expect(selection.result).toBeNull();
      expect(selection.execution).toBe(execution);
      // fallbackAttempted is true on the trace, but fallbackUsed is false on the selection.
      expect(selection.execution.fallbackAttempted).toBe(true);
      expectExactSelectionKeys(selection);
      expectSelectionInvariants(selection);
    });
  }
});

// ---------------------------------------------------------------------------
// §20 — primary precedence over any previous.
// ---------------------------------------------------------------------------

describe('primary precedence', () => {
  it('selects PRIMARY when both primary and previous are non-empty successes', () => {
    const primary = makeSuccess([makeHourly('2026-07-22T14:00:00+09:00')]);
    const previous = makeSuccess([makeHourly('2026-07-22T11:00:00+09:00')]);
    const execution = makeFallbackExecution(primary, previous, 'EMPTY_HOURLY');

    const selection = selectKmaHourlyFallbackResult(execution);

    expect(selection.source).toBe('PRIMARY');
    expect(selection.fallbackUsed).toBe(false);
    expect(selection.result).toBe(primary);
    expect(selection.result).not.toBe(previous);
    // Previous is ignored for selection but preserved untouched inside the execution trace.
    expect(selection.execution).toBe(execution);
    const trace = selection.execution;
    expect(trace.fallbackAttempted).toBe(true);
    if (trace.fallbackAttempted) {
      expect(trace.previous).toBe(previous);
    }
    expectExactSelectionKeys(selection);
    expectSelectionInvariants(selection);
  });

  it('selects PRIMARY when primary is non-empty and previous is an error', () => {
    const primary = makeSuccess();
    const execution = makeFallbackExecution(
      primary,
      makeProviderError({ kind: 'HTTP_ERROR', status: 503 }),
      'KMA_NO_DATA',
    );

    const selection = selectKmaHourlyFallbackResult(execution);

    expect(selection.source).toBe('PRIMARY');
    expect(selection.fallbackUsed).toBe(false);
    expect(selection.result).toBe(primary);
    expectSelectionInvariants(selection);
  });

  it('selects PRIMARY when primary is non-empty and previous is empty', () => {
    const primary = makeSuccess();
    const execution = makeFallbackExecution(
      primary,
      makeEmptySuccess(),
      'EMPTY_HOURLY',
    );

    const selection = selectKmaHourlyFallbackResult(execution);

    expect(selection.source).toBe('PRIMARY');
    expect(selection.fallbackUsed).toBe(false);
    expect(selection.result).toBe(primary);
    expectSelectionInvariants(selection);
  });
});

// ---------------------------------------------------------------------------
// §21 — exact branch keys across all three branches.
// ---------------------------------------------------------------------------

describe('exact branch keys', () => {
  it('the primary branch has exactly the five selection keys', () => {
    const selection = selectKmaHourlyFallbackResult(
      makeNoFallbackExecution(makeSuccess()),
    );
    expect(Object.keys(selection).sort()).toEqual([...SELECTION_KEYS]);
    expectExactSelectionKeys(selection);
  });

  it('the previous branch has exactly the five selection keys', () => {
    const selection = selectKmaHourlyFallbackResult(
      makeFallbackExecution(makeEmptySuccess(), makeSuccess(), 'EMPTY_HOURLY'),
    );
    expect(Object.keys(selection).sort()).toEqual([...SELECTION_KEYS]);
    expectExactSelectionKeys(selection);
  });

  it('the none branch has exactly the five selection keys', () => {
    const selection = selectKmaHourlyFallbackResult(
      makeFallbackExecution(makeEmptySuccess(), makeEmptySuccess(), 'EMPTY_HOURLY'),
    );
    expect(Object.keys(selection).sort()).toEqual([...SELECTION_KEYS]);
    expectExactSelectionKeys(selection);
  });
});

// ---------------------------------------------------------------------------
// §22 — freshness and immutability.
// ---------------------------------------------------------------------------

describe('freshness and immutability', () => {
  it('accepts a deeply frozen execution/result/hourly and does not throw', () => {
    const execution = deepFreeze(
      makeFallbackExecution(makeEmptySuccess(), makeSuccess(), 'EMPTY_HOURLY'),
    );

    expect(() => selectKmaHourlyFallbackResult(execution)).not.toThrow();

    const selection = selectKmaHourlyFallbackResult(execution);
    expect(selection.source).toBe('PREVIOUS');
    expect(selection.result).toBe(execution.previous);
    expect(selection.execution).toBe(execution);
  });

  it('never mutates a frozen error/normalization trace', () => {
    const execution = deepFreeze(
      makeFallbackExecution(
        makeUpstream('03'),
        makeNormalizationError(),
        'KMA_NO_DATA',
      ),
    );

    expect(() => selectKmaHourlyFallbackResult(execution)).not.toThrow();
    const selection = selectKmaHourlyFallbackResult(execution);
    expect(selection.selected).toBe(false);
    expect(selection.execution).toBe(execution);
  });

  it('returns a fresh wrapper on each call but preserves execution/result references', () => {
    const execution = makeNoFallbackExecution(makeSuccess());

    const first = selectKmaHourlyFallbackResult(execution);
    const second = selectKmaHourlyFallbackResult(execution);

    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    expect(first.execution).toBe(second.execution);
    expect(first.execution).toBe(execution);
    expect(first.result).toBe(second.result);
    expect(first.result).toBe(execution.primary);
  });

  it('is unaffected by a caller mutating an earlier returned wrapper copy (no shared state)', () => {
    const execution = makeNoFallbackExecution(makeSuccess());

    const first = selectKmaHourlyFallbackResult(execution);
    // A mutable structural copy — mutating it cannot touch `first` or any selector-internal state.
    const mutableCopy: Record<string, unknown> = { ...first };
    mutableCopy.selected = false;
    mutableCopy.source = null;
    mutableCopy.result = null;

    const second = selectKmaHourlyFallbackResult(execution);

    expect(second.selected).toBe(true);
    expect(second.source).toBe('PRIMARY');
    expect(second.result).toBe(execution.primary);
    // The original wrapper is also untouched by the copy mutation.
    expect(first.selected).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §23 — synchronous, side-effect-free contract.
// ---------------------------------------------------------------------------

describe('synchronous contract', () => {
  it('returns a plain value, not a Promise or thenable', () => {
    const selection = selectKmaHourlyFallbackResult(
      makeNoFallbackExecution(makeSuccess()),
    );

    expect(selection instanceof Promise).toBe(false);
    expect('then' in selection).toBe(false);
  });

  it('does not throw for any valid typed input', () => {
    expect(() =>
      selectKmaHourlyFallbackResult(makeNoFallbackExecution(makeSuccess())),
    ).not.toThrow();
    expect(() =>
      selectKmaHourlyFallbackResult(
        makeFallbackExecution(makeUpstream('03'), makeSuccess(), 'KMA_NO_DATA'),
      ),
    ).not.toThrow();
    expect(() =>
      selectKmaHourlyFallbackResult(
        makeFallbackExecution(makeEmptySuccess(), makeEmptySuccess(), 'EMPTY_HOURLY'),
      ),
    ).not.toThrow();
  });

  it('never calls console.log / console.warn / console.error', () => {
    const spies = spyOnConsole();

    selectKmaHourlyFallbackResult(makeNoFallbackExecution(makeSuccess()));
    selectKmaHourlyFallbackResult(
      makeFallbackExecution(makeEmptySuccess(), makeSuccess(), 'EMPTY_HOURLY'),
    );
    selectKmaHourlyFallbackResult(
      makeFallbackExecution(makeEmptySuccess(), makeUpstream('03'), 'EMPTY_HOURLY'),
    );

    expect(spies.log).not.toHaveBeenCalled();
    expect(spies.warn).not.toHaveBeenCalled();
    expect(spies.error).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §24 — PR #25 issuance identity stays inside the execution reference only.
// ---------------------------------------------------------------------------

describe('issuance identity is preserved via the execution reference, never copied', () => {
  it('exposes primaryIssuance through selection.execution on a PRIMARY selection', () => {
    const execution = makeNoFallbackExecution(makeSuccess());

    const selection = selectKmaHourlyFallbackResult(execution);

    expect(selection.source).toBe('PRIMARY');
    // The identity is reachable only through the preserved execution reference — same object, not a copy.
    expect(selection.execution).toBe(execution);
    expect(selection.execution.primaryIssuance).toBe(execution.primaryIssuance);
    expect(selection.execution.primaryIssuance).toEqual({
      product: SHORT,
      baseDate: '20260722',
      baseTime: '0500',
    });
    // The selector never lifts issuance onto the selection wrapper.
    expectExactSelectionKeys(selection);
    expect(selection).not.toHaveProperty('primaryIssuance');
    expect(selection).not.toHaveProperty('previousIssuance');
    expect(selection).not.toHaveProperty('issuance');
  });

  it('exposes previousIssuance through selection.execution on a PREVIOUS selection', () => {
    const execution = makeFallbackExecution(
      makeEmptySuccess(),
      makeSuccess(),
      'EMPTY_HOURLY',
    );

    const selection = selectKmaHourlyFallbackResult(execution);

    expect(selection.source).toBe('PREVIOUS');
    expect(selection.execution).toBe(execution);
    expect(selection.execution.fallbackAttempted).toBe(true);
    if (selection.execution.fallbackAttempted) {
      expect(selection.execution.previousIssuance).toBe(
        execution.previousIssuance,
      );
      expect(selection.execution.primaryIssuance).toBe(execution.primaryIssuance);
      expect(selection.execution.previousIssuance).toEqual({
        product: SHORT,
        baseDate: '20260722',
        baseTime: '0200',
      });
    }
    expectExactSelectionKeys(selection);
    expect(selection).not.toHaveProperty('previousIssuance');
    expect(selection).not.toHaveProperty('issuance');
  });

  it('does not clone or spread issuance even when fallback was attempted but no source is usable', () => {
    const execution = makeFallbackExecution(
      makeEmptySuccess(),
      makeEmptySuccess(),
      'EMPTY_HOURLY',
    );

    const selection = selectKmaHourlyFallbackResult(execution);

    expect(selection.selected).toBe(false);
    // Even with no selection, the whole trace (issuance siblings included) is preserved by reference.
    expect(selection.execution).toBe(execution);
    if (selection.execution.fallbackAttempted) {
      expect(selection.execution.primaryIssuance).toBe(execution.primaryIssuance);
      expect(selection.execution.previousIssuance).toBe(
        execution.previousIssuance,
      );
    }
    expectExactSelectionKeys(selection);
  });
});
