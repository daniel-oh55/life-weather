import { afterEach, describe, expect, it, vi } from 'vitest';

import { hourlyForecast, type HourlyForecast } from '@life-weather/contracts';
import { KmaForecastProduct } from '@life-weather/weather-core';

import type {
  KmaForecastProviderError,
  KmaForecastRequest,
  KmaHourlyNormalizationIssue,
} from '../providers/kma';
import type { KmaFallbackRequestPlan } from './kma-fallback-request-plan';
import {
  createKmaHourlyFallbackService,
  type KmaHourlyFallbackEligibilityClassifier,
  type KmaHourlyFallbackServiceInput,
  type KmaHourlyFallbackServiceOptions,
  type KmaHourlyFallbackServiceResult,
} from './kma-hourly-fallback';
import {
  classifyKmaHourlyFallbackEligibility,
  type KmaHourlyFallbackEligibility,
  type KmaHourlyFallbackReason,
} from './kma-hourly-fallback-eligibility';
import type { KmaHourlyForecastServiceResult } from './kma-hourly-forecast';

const SHORT = KmaForecastProduct.SHORT_FORECAST;

/** The exact own keys of the two result branches, sorted for stable comparison. */
const NO_FALLBACK_KEYS = ['fallbackAttempted', 'primary'] as const;
const FALLBACK_KEYS = [
  'fallbackAttempted',
  'fallbackReason',
  'previous',
  'primary',
] as const;

/**
 * Keys that must never appear on either result branch — this service returns an execution trace, not
 * a final API selection, so no transport/selection/plan metadata may leak onto the wrapper.
 */
const FORBIDDEN_KEYS = [
  'fallbackUsed',
  'fallbackSucceeded',
  'selected',
  'final',
  'result',
  'source',
  'stale',
  'plan',
  'primaryRequest',
  'previousRequest',
  'eligibility',
  'classifierResult',
  'attemptCount',
  'maxAttempts',
  'retryable',
  'delayMilliseconds',
] as const;

/**
 * Two complete, schema-valid `HourlyForecast` fixtures written as full literals (never a spread of
 * `Partial`, so `satisfies` keeps every field's exact type). Module-scope immutable; only ever read.
 */
const HOURLY_A = {
  forecastAt: '2026-07-22T14:00:00+09:00',
  condition: 'CLEAR',
  temperatureCelsius: 25.5,
  feelsLikeCelsius: null,
  precipitationProbabilityPercent: 20,
  precipitationAmountMillimeters: 1,
  snowfallAmountCentimeters: 0,
  humidityPercent: 55,
  windSpeedMetersPerSecond: 3.4,
  windDirectionDegrees: 270,
} satisfies HourlyForecast;

const HOURLY_B = {
  forecastAt: '2026-07-22T15:00:00+09:00',
  condition: 'RAIN',
  temperatureCelsius: 22,
  feelsLikeCelsius: null,
  precipitationProbabilityPercent: 80,
  precipitationAmountMillimeters: 3,
  snowfallAmountCentimeters: null,
  humidityPercent: 90,
  windSpeedMetersPerSecond: 5,
  windDirectionDegrees: 180,
} satisfies HourlyForecast;

/** Guard the fixtures themselves against the real contracts schema (no `as any` anywhere). */
it('uses HourlyForecast fixtures that satisfy the real contracts schema', () => {
  expect(hourlyForecast.safeParse(HOURLY_A).success).toBe(true);
  expect(hourlyForecast.safeParse(HOURLY_B).success).toBe(true);
});

// ---------------------------------------------------------------------------
// Result fixtures — each fresh per call, so no test shares a mutable result.
// ---------------------------------------------------------------------------

function emptySuccess(): KmaHourlyForecastServiceResult {
  return { ok: true, hourly: [] };
}

function nonEmptySuccess(
  hourly: readonly HourlyForecast[] = [HOURLY_A],
): KmaHourlyForecastServiceResult {
  return { ok: true, hourly };
}

function providerFailure(
  error: KmaForecastProviderError,
): KmaHourlyForecastServiceResult {
  return { ok: false, stage: 'PROVIDER', error };
}

function normalizationFailure(
  issues: readonly KmaHourlyNormalizationIssue[],
): KmaHourlyForecastServiceResult {
  return { ok: false, stage: 'NORMALIZATION', issues };
}

/** A `PROVIDER`-stage upstream-error result for the given `resultCode`. */
function upstream(resultCode: string): KmaHourlyForecastServiceResult {
  return providerFailure({ kind: 'KMA_UPSTREAM_ERROR', resultCode });
}

const NORMALIZATION_ISSUES: readonly KmaHourlyNormalizationIssue[] = [
  { slotKey: 'SHORT_FORECAST|20260722|0500|20260722|1400|60|127', field: 'temperatureCelsius', reason: 'ABSENT' },
];

// ---------------------------------------------------------------------------
// Request-plan fixture — distinct primary/previous request objects.
// ---------------------------------------------------------------------------

/** A fresh `{ primary, previous }` plan with two distinct, complete request objects. */
function makeRequestPlan(): KmaFallbackRequestPlan {
  return {
    primary: { product: SHORT, baseDate: '20260722', baseTime: '0500', nx: 60, ny: 127 },
    previous: { product: SHORT, baseDate: '20260722', baseTime: '0200', nx: 60, ny: 127 },
  };
}

/** A fresh caller input. */
function makeInput(): KmaHourlyFallbackServiceInput {
  return { product: SHORT, nx: 60, ny: 127 };
}

// ---------------------------------------------------------------------------
// Typed collaborator fakes — every call log/queue is created per helper call
// (never module- or describe-scope mutable state), so tests are order-independent.
// ---------------------------------------------------------------------------

interface FakePlanFactory {
  readonly createFallbackRequestPlan: (
    input: KmaHourlyFallbackServiceInput,
  ) => KmaFallbackRequestPlan;
  readonly calls: KmaHourlyFallbackServiceInput[];
}

/** A plan factory that records each input (by reference) and returns `plan`. */
function recordingPlanFactory(
  plan: KmaFallbackRequestPlan,
  callOrder?: string[],
): FakePlanFactory {
  const calls: KmaHourlyFallbackServiceInput[] = [];
  return {
    calls,
    createFallbackRequestPlan(input) {
      calls.push(input);
      callOrder?.push('PLAN');
      return plan;
    },
  };
}

/** A plan factory whose method throws `error` (exact reference) after recording the input. */
function throwingPlanFactory(error: unknown): FakePlanFactory {
  const calls: KmaHourlyFallbackServiceInput[] = [];
  return {
    calls,
    createFallbackRequestPlan(input) {
      calls.push(input);
      throw error;
    },
  };
}

interface RecordedServiceCall {
  readonly request: KmaForecastRequest;
  readonly options: KmaHourlyFallbackServiceOptions | undefined;
}

/** A single response behaviour for one hourly-service call: it may return, resolve, throw, or reject. */
type HourlyResponder = (
  request: KmaForecastRequest,
  options: KmaHourlyFallbackServiceOptions | undefined,
) => KmaHourlyForecastServiceResult | Promise<KmaHourlyForecastServiceResult>;

interface FakeHourlyService {
  readonly fetchHourlyForecast: (
    request: KmaForecastRequest,
    options?: KmaHourlyFallbackServiceOptions,
  ) => Promise<KmaHourlyForecastServiceResult>;
  readonly calls: RecordedServiceCall[];
}

const SERVICE_LABELS = ['PRIMARY_SERVICE', 'PREVIOUS_SERVICE'] as const;

/**
 * A fake hourly service that consumes `responders` FIFO — one per `fetchHourlyForecast` call — and
 * records each call's request + options by reference. A call beyond the queued responders throws
 * loudly, so any stray third attempt fails the test rather than passing silently.
 */
function queuedHourlyService(
  responders: readonly HourlyResponder[],
  callOrder?: string[],
): FakeHourlyService {
  const calls: RecordedServiceCall[] = [];
  return {
    calls,
    fetchHourlyForecast(request, options) {
      const index = calls.length;
      calls.push({ request, options });
      callOrder?.push(SERVICE_LABELS[index] ?? `UNEXPECTED_SERVICE_${index + 1}`);
      const responder = responders[index];
      if (responder === undefined) {
        // Overflow guard: a third (or later) call means the orchestrator retried beyond the single
        // fallback step. Throw so the test fails instead of quietly succeeding.
        throw new Error(
          `unexpected hourly-service call #${index + 1}: only ${responders.length} responder(s) queued`,
        );
      }
      return Promise.resolve(responder(request, options));
    },
  };
}

/** Sugar: a responder that resolves to `result`. */
function resolves(result: KmaHourlyForecastServiceResult): HourlyResponder {
  return () => result;
}

interface RecordingClassifier {
  readonly classifier: KmaHourlyFallbackEligibilityClassifier;
  readonly calls: KmaHourlyForecastServiceResult[];
}

/** A classifier that records each result (by reference) and returns a fixed `eligibility`. */
function recordingClassifier(
  eligibility: KmaHourlyFallbackEligibility,
  callOrder?: string[],
): RecordingClassifier {
  const calls: KmaHourlyForecastServiceResult[] = [];
  const classifier: KmaHourlyFallbackEligibilityClassifier = (result) => {
    calls.push(result);
    callOrder?.push('CLASSIFY_PRIMARY');
    return eligibility;
  };
  return { classifier, calls };
}

/**
 * A classifier that records each result and delegates to the real PR #17
 * {@link classifyKmaHourlyFallbackEligibility} — the default policy, made countable. Using the real
 * function keeps the fallback policy unchanged; the wrapper only observes the call.
 */
function spyingDefaultClassifier(callOrder?: string[]): RecordingClassifier {
  const calls: KmaHourlyForecastServiceResult[] = [];
  const classifier: KmaHourlyFallbackEligibilityClassifier = (result) => {
    calls.push(result);
    callOrder?.push('CLASSIFY_PRIMARY');
    return classifyKmaHourlyFallbackEligibility(result);
  };
  return { classifier, calls };
}

/** A classifier that records each result and then throws `error` (exact reference). */
function throwingClassifier(error: unknown): RecordingClassifier {
  const calls: KmaHourlyForecastServiceResult[] = [];
  const classifier: KmaHourlyFallbackEligibilityClassifier = (result) => {
    calls.push(result);
    throw error;
  };
  return { classifier, calls };
}

/** Recursively freeze an object graph so any write to it (or a nested object) throws in strict mode. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

// Safety net: restore any console (or other) spy even if an assertion throws before an explicit
// restore. Applies to every describe block below, so a spy never leaks into the next test.
afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// §18 — construction is side-effect-free
// ---------------------------------------------------------------------------

describe('createKmaHourlyFallbackService — construction is side-effect-free', () => {
  it('calls neither the plan factory, the service, nor the classifier on construction', () => {
    const factory = recordingPlanFactory(makeRequestPlan());
    const service = queuedHourlyService([resolves(nonEmptySuccess())]);
    const { classifier, calls: classifierCalls } = recordingClassifier({ eligible: false });

    createKmaHourlyFallbackService(factory, service, classifier);

    expect(factory.calls).toHaveLength(0);
    expect(service.calls).toHaveLength(0);
    expect(classifierCalls).toHaveLength(0);
  });

  it('exposes exactly one public method named fetchHourlyForecastWithFallback', () => {
    const factory = recordingPlanFactory(makeRequestPlan());
    const service = queuedHourlyService([resolves(nonEmptySuccess())]);
    const fallback = createKmaHourlyFallbackService(factory, service);

    expect(Object.keys(fallback)).toEqual(['fetchHourlyForecastWithFallback']);
    expect(typeof fallback.fetchHourlyForecastWithFallback).toBe('function');
  });

  it('creates independent instances on repeated construction (no shared state)', () => {
    const factory = recordingPlanFactory(makeRequestPlan());
    const service = queuedHourlyService([resolves(nonEmptySuccess())]);

    const a = createKmaHourlyFallbackService(factory, service);
    const b = createKmaHourlyFallbackService(factory, service);

    expect(a).not.toBe(b);
    expect(a.fetchHourlyForecastWithFallback).not.toBe(b.fetchHourlyForecastWithFallback);
  });

  it('constructs from frozen collaborators without calling any of them', () => {
    const factory = Object.freeze(recordingPlanFactory(makeRequestPlan()));
    const service = Object.freeze(queuedHourlyService([resolves(nonEmptySuccess())]));
    const { classifier } = recordingClassifier({ eligible: false });
    const frozenClassifier = Object.freeze(classifier);

    expect(() =>
      createKmaHourlyFallbackService(factory, service, frozenClassifier),
    ).not.toThrow();
    expect(factory.calls).toHaveLength(0);
    expect(service.calls).toHaveLength(0);
  });

  it('logs nothing on construction', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    createKmaHourlyFallbackService(
      recordingPlanFactory(makeRequestPlan()),
      queuedHourlyService([resolves(nonEmptySuccess())]),
    );

    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Default classifier is the real PR #17 policy (true two-argument construction)
// ---------------------------------------------------------------------------

describe('createKmaHourlyFallbackService — default classifier is the PR #17 policy', () => {
  // Constructed with only two arguments (no injected classifier) so the default binding is exercised.
  async function runWithDefault(primary: KmaHourlyForecastServiceResult) {
    const plan = makeRequestPlan();
    const service = queuedHourlyService([resolves(primary), resolves(nonEmptySuccess([HOURLY_B]))]);
    const fallback = createKmaHourlyFallbackService(recordingPlanFactory(plan), service);
    const result = await fallback.fetchHourlyForecastWithFallback(makeInput());
    return { result, service };
  }

  it('does not fall back on a non-empty success (ineligible)', async () => {
    const { result, service } = await runWithDefault(nonEmptySuccess());
    expect(result.fallbackAttempted).toBe(false);
    expect(service.calls).toHaveLength(1);
  });

  it('falls back with EMPTY_HOURLY on an empty success', async () => {
    const { result, service } = await runWithDefault(emptySuccess());
    expect(result.fallbackAttempted).toBe(true);
    if (result.fallbackAttempted) {
      expect(result.fallbackReason).toBe('EMPTY_HOURLY');
    }
    expect(service.calls).toHaveLength(2);
  });

  it('falls back with KMA_NO_DATA on upstream resultCode 03', async () => {
    const { result, service } = await runWithDefault(upstream('03'));
    expect(result.fallbackAttempted).toBe(true);
    if (result.fallbackAttempted) {
      expect(result.fallbackReason).toBe('KMA_NO_DATA');
    }
    expect(service.calls).toHaveLength(2);
  });

  it('does not fall back on an HTTP 503 error (ineligible)', async () => {
    const { result, service } = await runWithDefault(
      providerFailure({ kind: 'HTTP_ERROR', status: 503 }),
    );
    expect(result.fallbackAttempted).toBe(false);
    expect(service.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// §19 — non-empty primary success → no fallback
// ---------------------------------------------------------------------------

describe('createKmaHourlyFallbackService — non-empty primary success (no fallback)', () => {
  it('returns { fallbackAttempted: false, primary } and never runs the previous request', async () => {
    const plan = makeRequestPlan();
    const primaryResult = nonEmptySuccess([HOURLY_A, HOURLY_B]);
    const factory = recordingPlanFactory(plan);
    const service = queuedHourlyService([resolves(primaryResult)]);
    const { classifier, calls: classifierCalls } = spyingDefaultClassifier();
    const fallback = createKmaHourlyFallbackService(factory, service, classifier);

    const result = await fallback.fetchHourlyForecastWithFallback(makeInput());

    expect(factory.calls).toHaveLength(1);
    expect(service.calls).toHaveLength(1);
    expect(classifierCalls).toHaveLength(1);
    expect(result).toEqual({ fallbackAttempted: false, primary: primaryResult });
    if (!result.fallbackAttempted) {
      expect(result.primary).toBe(primaryResult);
    }
    expect(Object.keys(result).sort()).toEqual([...NO_FALLBACK_KEYS].sort());
    expect(result).not.toHaveProperty('previous');
    expect(result).not.toHaveProperty('fallbackReason');
  });
});

// ---------------------------------------------------------------------------
// §20 — primary EMPTY_HOURLY → fallback
// ---------------------------------------------------------------------------

describe('createKmaHourlyFallbackService — primary EMPTY_HOURLY (fallback)', () => {
  it('runs the previous request once and reports EMPTY_HOURLY with both results by reference', async () => {
    const plan = makeRequestPlan();
    const primaryResult = emptySuccess();
    const previousResult = nonEmptySuccess([HOURLY_A]);
    const factory = recordingPlanFactory(plan);
    const service = queuedHourlyService([resolves(primaryResult), resolves(previousResult)]);
    const { classifier, calls: classifierCalls } = spyingDefaultClassifier();
    const fallback = createKmaHourlyFallbackService(factory, service, classifier);

    const result = await fallback.fetchHourlyForecastWithFallback(makeInput());

    expect(factory.calls).toHaveLength(1);
    expect(service.calls).toHaveLength(2);
    // First request is the plan's primary; second is the plan's previous — both by reference.
    expect(service.calls[0].request).toBe(plan.primary);
    expect(service.calls[1].request).toBe(plan.previous);
    // Classifier ran exactly once, on the primary result only.
    expect(classifierCalls).toHaveLength(1);
    expect(classifierCalls[0]).toBe(primaryResult);
    expect(result.fallbackAttempted).toBe(true);
    if (result.fallbackAttempted) {
      expect(result.fallbackReason).toBe('EMPTY_HOURLY');
      expect(result.primary).toBe(primaryResult);
      expect(result.previous).toBe(previousResult);
    }
    expect(Object.keys(result).sort()).toEqual([...FALLBACK_KEYS].sort());
  });
});

// ---------------------------------------------------------------------------
// §21 — primary KMA_NO_DATA → fallback
// ---------------------------------------------------------------------------

describe('createKmaHourlyFallbackService — primary KMA_NO_DATA (fallback)', () => {
  it('runs the previous request once and reports KMA_NO_DATA with both results by reference', async () => {
    const plan = makeRequestPlan();
    const primaryResult = providerFailure({ kind: 'KMA_UPSTREAM_ERROR', resultCode: '03' });
    const previousResult = nonEmptySuccess([HOURLY_B]);
    const factory = recordingPlanFactory(plan);
    const service = queuedHourlyService([resolves(primaryResult), resolves(previousResult)]);
    const { classifier, calls: classifierCalls } = spyingDefaultClassifier();
    const fallback = createKmaHourlyFallbackService(factory, service, classifier);

    const result = await fallback.fetchHourlyForecastWithFallback(makeInput());

    expect(service.calls).toHaveLength(2);
    expect(classifierCalls).toHaveLength(1);
    expect(classifierCalls[0]).toBe(primaryResult);
    expect(result.fallbackAttempted).toBe(true);
    if (result.fallbackAttempted) {
      expect(result.fallbackReason).toBe('KMA_NO_DATA');
      expect(result.primary).toBe(primaryResult);
      expect(result.previous).toBe(previousResult);
    }
    expect(service.calls[0].request).toBe(plan.primary);
    expect(service.calls[1].request).toBe(plan.previous);
  });
});

// ---------------------------------------------------------------------------
// §22 — ineligible primary error families (default classifier integration)
// ---------------------------------------------------------------------------

describe('createKmaHourlyFallbackService — ineligible primary results (no fallback)', () => {
  const cases: readonly { label: string; primary: () => KmaHourlyForecastServiceResult }[] = [
    { label: 'PROVIDER / ABORTED', primary: () => providerFailure({ kind: 'ABORTED' }) },
    { label: 'PROVIDER / TIMEOUT', primary: () => providerFailure({ kind: 'TIMEOUT' }) },
    { label: 'PROVIDER / NETWORK_ERROR', primary: () => providerFailure({ kind: 'NETWORK_ERROR' }) },
    { label: 'PROVIDER / HTTP_ERROR 503', primary: () => providerFailure({ kind: 'HTTP_ERROR', status: 503 }) },
    { label: 'PROVIDER / GATEWAY_ERROR', primary: () => providerFailure({ kind: 'GATEWAY_ERROR', reasonCode: '30' }) },
    { label: 'PROVIDER / KMA_UPSTREAM_ERROR non-03', primary: () => upstream('10') },
    {
      label: 'PROVIDER / KMA_INVALID_RESPONSE',
      primary: () =>
        providerFailure({
          kind: 'KMA_INVALID_RESPONSE',
          issues: [{ path: ['response', 'body'], message: 'expected object' }],
        }),
    },
    {
      label: 'PROVIDER / INCOMPLETE_PAGE',
      primary: () => providerFailure({ kind: 'INCOMPLETE_PAGE', totalCount: 100, receivedCount: 50 }),
    },
    { label: 'NORMALIZATION failure', primary: () => normalizationFailure(NORMALIZATION_ISSUES) },
    { label: 'non-empty success', primary: () => nonEmptySuccess([HOURLY_A]) },
  ];

  it.each(cases)('does not fall back for $label (default classifier)', async ({ primary }) => {
    const plan = makeRequestPlan();
    const primaryResult = primary();
    // Only ONE responder is queued — a stray previous attempt would trip the overflow guard.
    const service = queuedHourlyService([resolves(primaryResult)]);
    const fallback = createKmaHourlyFallbackService(recordingPlanFactory(plan), service);

    const result = await fallback.fetchHourlyForecastWithFallback(makeInput());

    expect(service.calls).toHaveLength(1);
    expect(result.fallbackAttempted).toBe(false);
    if (!result.fallbackAttempted) {
      expect(result.primary).toBe(primaryResult);
    }
    expect(result).not.toHaveProperty('previous');
  });
});

// ---------------------------------------------------------------------------
// §23 — the previous result is never re-classified
// ---------------------------------------------------------------------------

describe('createKmaHourlyFallbackService — previous result is never re-classified', () => {
  const previousCases: readonly { label: string; previous: () => KmaHourlyForecastServiceResult }[] = [
    { label: 'empty success', previous: () => emptySuccess() },
    { label: 'KMA upstream 03', previous: () => upstream('03') },
    { label: 'HTTP error', previous: () => providerFailure({ kind: 'HTTP_ERROR', status: 500 }) },
    { label: 'ABORTED', previous: () => providerFailure({ kind: 'ABORTED' }) },
    { label: 'normalization failure', previous: () => normalizationFailure(NORMALIZATION_ISSUES) },
  ];

  it.each(previousCases)(
    'keeps the primary reason and never classifies a $label previous result',
    async ({ previous }) => {
      const plan = makeRequestPlan();
      const primaryResult = emptySuccess(); // eligible → EMPTY_HOURLY
      const previousResult = previous();
      const service = queuedHourlyService([resolves(primaryResult), resolves(previousResult)]);
      // Force eligible with a fixed reason; assert the classifier only ever sees the primary result.
      const { classifier, calls: classifierCalls } = recordingClassifier({
        eligible: true,
        reason: 'EMPTY_HOURLY',
      });
      const fallback = createKmaHourlyFallbackService(recordingPlanFactory(plan), service, classifier);

      const result = await fallback.fetchHourlyForecastWithFallback(makeInput());

      expect(service.calls).toHaveLength(2);
      // Classifier ran exactly once, and its only input was the primary result (never the previous).
      expect(classifierCalls).toHaveLength(1);
      expect(classifierCalls[0]).toBe(primaryResult);
      expect(classifierCalls).not.toContain(previousResult);
      expect(result.fallbackAttempted).toBe(true);
      if (result.fallbackAttempted) {
        // Reason is fixed by the primary's eligibility, never re-derived from the previous result.
        expect(result.fallbackReason).toBe('EMPTY_HOURLY');
        expect(result.previous).toBe(previousResult);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// §24 — custom classifier injection
// ---------------------------------------------------------------------------

describe('createKmaHourlyFallbackService — custom classifier injection', () => {
  it('forces ineligible even on an empty success (orchestrator adds no policy of its own)', async () => {
    const plan = makeRequestPlan();
    const primaryResult = emptySuccess(); // the default would call this EMPTY_HOURLY-eligible
    const service = queuedHourlyService([resolves(primaryResult)]);
    const { classifier, calls: classifierCalls } = recordingClassifier({ eligible: false });
    const fallback = createKmaHourlyFallbackService(recordingPlanFactory(plan), service, classifier);

    const result = await fallback.fetchHourlyForecastWithFallback(makeInput());

    // No previous attempt: the orchestrator obeyed the custom classifier, not hourly.length.
    expect(service.calls).toHaveLength(1);
    expect(classifierCalls).toHaveLength(1);
    expect(classifierCalls[0]).toBe(primaryResult);
    expect(result).toEqual({ fallbackAttempted: false, primary: primaryResult });
  });

  it('forces eligible even on a non-empty success, using the custom reason', async () => {
    const plan = makeRequestPlan();
    const primaryResult = nonEmptySuccess([HOURLY_A, HOURLY_B]); // the default would call this ineligible
    const previousResult = nonEmptySuccess([HOURLY_A]);
    const service = queuedHourlyService([resolves(primaryResult), resolves(previousResult)]);
    const { classifier, calls: classifierCalls } = recordingClassifier({
      eligible: true,
      reason: 'KMA_NO_DATA',
    });
    const fallback = createKmaHourlyFallbackService(recordingPlanFactory(plan), service, classifier);

    const result = await fallback.fetchHourlyForecastWithFallback(makeInput());

    // Previous ran because the custom classifier said eligible — no self-imposed eligibility policy.
    expect(service.calls).toHaveLength(2);
    // The classifier saw only the primary result, exactly once.
    expect(classifierCalls).toHaveLength(1);
    expect(classifierCalls[0]).toBe(primaryResult);
    expect(classifierCalls).not.toContain(previousResult);
    expect(result.fallbackAttempted).toBe(true);
    if (result.fallbackAttempted) {
      expect(result.fallbackReason).toBe('KMA_NO_DATA');
    }
  });
});

// ---------------------------------------------------------------------------
// §25 — call order (single test-local callOrder array)
// ---------------------------------------------------------------------------

describe('createKmaHourlyFallbackService — call order', () => {
  it('runs PLAN → PRIMARY_SERVICE → CLASSIFY_PRIMARY → PREVIOUS_SERVICE when eligible', async () => {
    const callOrder: string[] = [];
    const plan = makeRequestPlan();
    const service = queuedHourlyService(
      [resolves(emptySuccess()), resolves(nonEmptySuccess())],
      callOrder,
    );
    const { classifier } = recordingClassifier({ eligible: true, reason: 'EMPTY_HOURLY' }, callOrder);
    const fallback = createKmaHourlyFallbackService(
      recordingPlanFactory(plan, callOrder),
      service,
      classifier,
    );

    await fallback.fetchHourlyForecastWithFallback(makeInput());

    expect(callOrder).toEqual(['PLAN', 'PRIMARY_SERVICE', 'CLASSIFY_PRIMARY', 'PREVIOUS_SERVICE']);
  });

  it('runs PLAN → PRIMARY_SERVICE → CLASSIFY_PRIMARY and stops when ineligible', async () => {
    const callOrder: string[] = [];
    const plan = makeRequestPlan();
    const service = queuedHourlyService([resolves(nonEmptySuccess())], callOrder);
    const { classifier } = recordingClassifier({ eligible: false }, callOrder);
    const fallback = createKmaHourlyFallbackService(
      recordingPlanFactory(plan, callOrder),
      service,
      classifier,
    );

    await fallback.fetchHourlyForecastWithFallback(makeInput());

    expect(callOrder).toEqual(['PLAN', 'PRIMARY_SERVICE', 'CLASSIFY_PRIMARY']);
  });
});

// ---------------------------------------------------------------------------
// §26 — reference pass-through
// ---------------------------------------------------------------------------

describe('createKmaHourlyFallbackService — reference pass-through', () => {
  it('threads input, plan requests, options, and results through by exact reference (eligible)', async () => {
    const plan = makeRequestPlan();
    const input = makeInput();
    const options: KmaHourlyFallbackServiceOptions = { signal: new AbortController().signal };
    const primaryResult = emptySuccess();
    const previousResult = nonEmptySuccess([HOURLY_A]);
    const factory = recordingPlanFactory(plan);
    const service = queuedHourlyService([resolves(primaryResult), resolves(previousResult)]);
    const { classifier, calls: classifierCalls } = recordingClassifier({
      eligible: true,
      reason: 'EMPTY_HOURLY',
    });
    const fallback = createKmaHourlyFallbackService(factory, service, classifier);

    const result = await fallback.fetchHourlyForecastWithFallback(input, options);

    // Caller input reaches the plan factory unchanged.
    expect(factory.calls[0]).toBe(input);
    // Plan requests reach the service unchanged, in order.
    expect(service.calls[0].request).toBe(plan.primary);
    expect(service.calls[1].request).toBe(plan.previous);
    // The same options reference reaches both service calls.
    expect(service.calls[0].options).toBe(options);
    expect(service.calls[1].options).toBe(options);
    // Primary result reaches the classifier and the output; previous reaches the output.
    expect(classifierCalls[0]).toBe(primaryResult);
    expect(result.primary).toBe(primaryResult);
    if (result.fallbackAttempted) {
      expect(result.previous).toBe(previousResult);
    }
  });

  it('forwards undefined options to both service calls when options are omitted', async () => {
    const plan = makeRequestPlan();
    const service = queuedHourlyService([resolves(emptySuccess()), resolves(nonEmptySuccess())]);
    const { classifier } = recordingClassifier({ eligible: true, reason: 'EMPTY_HOURLY' });
    const fallback = createKmaHourlyFallbackService(recordingPlanFactory(plan), service, classifier);

    await fallback.fetchHourlyForecastWithFallback(makeInput());

    expect(service.calls[0].options).toBeUndefined();
    expect(service.calls[1].options).toBeUndefined();
  });

  it('does not clone the input, requests, options, primary, or previous result', async () => {
    const plan = makeRequestPlan();
    const input = makeInput();
    const options: KmaHourlyFallbackServiceOptions = {};
    const primaryResult = emptySuccess();
    const previousResult = nonEmptySuccess();
    const factory = recordingPlanFactory(plan);
    const service = queuedHourlyService([resolves(primaryResult), resolves(previousResult)]);
    const { classifier, calls: classifierCalls } = recordingClassifier({
      eligible: true,
      reason: 'EMPTY_HOURLY',
    });
    const fallback = createKmaHourlyFallbackService(factory, service, classifier);

    const result = await fallback.fetchHourlyForecastWithFallback(input, options);

    // Every reference is the original — nothing was re-assembled into a look-alike object.
    expect(factory.calls[0]).toBe(input);
    expect(service.calls[0].options).toBe(options);
    expect(service.calls[1].options).toBe(options);
    expect(classifierCalls[0]).toBe(primaryResult);
    expect(result.primary).toBe(primaryResult);
    if (result.fallbackAttempted) {
      expect(result.previous).toBe(previousResult);
    }
  });
});

// ---------------------------------------------------------------------------
// §27 — exact output keys
// ---------------------------------------------------------------------------

describe('createKmaHourlyFallbackService — exact output keys', () => {
  it('exposes exactly { fallbackAttempted, primary } with no forbidden keys (no fallback)', async () => {
    const plan = makeRequestPlan();
    const service = queuedHourlyService([resolves(nonEmptySuccess())]);
    const { classifier } = recordingClassifier({ eligible: false });
    const fallback = createKmaHourlyFallbackService(recordingPlanFactory(plan), service, classifier);

    const result = await fallback.fetchHourlyForecastWithFallback(makeInput());

    expect(Object.keys(result).sort()).toEqual([...NO_FALLBACK_KEYS].sort());
    for (const forbidden of FORBIDDEN_KEYS) {
      expect(result).not.toHaveProperty(forbidden);
    }
    expect(result).not.toHaveProperty('previous');
    expect(result).not.toHaveProperty('fallbackReason');
  });

  it('exposes exactly { fallbackAttempted, fallbackReason, primary, previous } with no forbidden keys', async () => {
    const plan = makeRequestPlan();
    const service = queuedHourlyService([resolves(emptySuccess()), resolves(nonEmptySuccess())]);
    const { classifier } = recordingClassifier({ eligible: true, reason: 'EMPTY_HOURLY' });
    const fallback = createKmaHourlyFallbackService(recordingPlanFactory(plan), service, classifier);

    const result = await fallback.fetchHourlyForecastWithFallback(makeInput());

    expect(Object.keys(result).sort()).toEqual([...FALLBACK_KEYS].sort());
    for (const forbidden of FORBIDDEN_KEYS) {
      expect(result).not.toHaveProperty(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// §28 — maximum attempts (no loop / recursion / third request)
// ---------------------------------------------------------------------------

describe('createKmaHourlyFallbackService — maximum attempts', () => {
  it('makes exactly one service call for an ineligible primary', async () => {
    const service = queuedHourlyService([resolves(nonEmptySuccess())]);
    const { classifier } = recordingClassifier({ eligible: false });
    const fallback = createKmaHourlyFallbackService(
      recordingPlanFactory(makeRequestPlan()),
      service,
      classifier,
    );

    await fallback.fetchHourlyForecastWithFallback(makeInput());

    expect(service.calls).toHaveLength(1);
  });

  it('makes exactly two service calls for an eligible primary and never a third', async () => {
    // Only two responders queued: a third attempt trips the overflow guard and fails the test.
    const service = queuedHourlyService([resolves(emptySuccess()), resolves(upstream('03'))]);
    const { classifier } = recordingClassifier({ eligible: true, reason: 'EMPTY_HOURLY' });
    const fallback = createKmaHourlyFallbackService(
      recordingPlanFactory(makeRequestPlan()),
      service,
      classifier,
    );

    const result = await fallback.fetchHourlyForecastWithFallback(makeInput());

    expect(service.calls).toHaveLength(2);
    expect(result.fallbackAttempted).toBe(true);
  });

  it('calls the plan factory exactly once per method call', async () => {
    const factory = recordingPlanFactory(makeRequestPlan());
    const service = queuedHourlyService([resolves(emptySuccess()), resolves(nonEmptySuccess())]);
    const { classifier } = recordingClassifier({ eligible: true, reason: 'EMPTY_HOURLY' });
    const fallback = createKmaHourlyFallbackService(factory, service, classifier);

    await fallback.fetchHourlyForecastWithFallback(makeInput());

    expect(factory.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// §29 — AbortSignal pass-through
// ---------------------------------------------------------------------------

describe('createKmaHourlyFallbackService — AbortSignal pass-through', () => {
  it('forwards an already-aborted signal to the primary call and never runs the previous', async () => {
    const controller = new AbortController();
    controller.abort();
    const options = Object.freeze<KmaHourlyFallbackServiceOptions>({ signal: controller.signal });
    // The fake mirrors the production provider: an aborted signal short-circuits to ABORTED.
    const service = queuedHourlyService([
      (_request, opts) =>
        opts?.signal?.aborted ? providerFailure({ kind: 'ABORTED' }) : nonEmptySuccess(),
    ]);
    // Default classifier: ABORTED is ineligible.
    const fallback = createKmaHourlyFallbackService(recordingPlanFactory(makeRequestPlan()), service);

    const result = await fallback.fetchHourlyForecastWithFallback(makeInput(), options);

    expect(service.calls).toHaveLength(1);
    expect(service.calls[0].options).toBe(options);
    expect(result.fallbackAttempted).toBe(false);
  });

  it('forwards the same signal (now aborted) to the previous call when abort happens between attempts', async () => {
    const controller = new AbortController();
    const options: KmaHourlyFallbackServiceOptions = { signal: controller.signal };
    const abortedResult = providerFailure({ kind: 'ABORTED' });
    const service = queuedHourlyService([
      // Primary aborts the caller's controller, then returns an eligible empty success.
      (_request, opts) => {
        expect(opts).toBe(options);
        controller.abort();
        return emptySuccess();
      },
      // Previous receives the same, now-aborted, signal reference and returns ABORTED.
      (_request, opts) => {
        expect(opts).toBe(options);
        expect(opts?.signal?.aborted).toBe(true);
        return abortedResult;
      },
    ]);
    // Default classifier: empty success → EMPTY_HOURLY-eligible.
    const fallback = createKmaHourlyFallbackService(recordingPlanFactory(makeRequestPlan()), service);

    const result = await fallback.fetchHourlyForecastWithFallback(makeInput(), options);

    expect(service.calls).toHaveLength(2);
    expect(service.calls[0].options).toBe(options);
    expect(service.calls[1].options).toBe(options);
    expect(result.fallbackAttempted).toBe(true);
    if (result.fallbackAttempted) {
      expect(result.previous).toBe(abortedResult);
    }
  });
});

// ---------------------------------------------------------------------------
// §30 — plan factory error
// ---------------------------------------------------------------------------

describe('createKmaHourlyFallbackService — plan factory error', () => {
  it('rejects with the exact plan-factory error and calls neither the service nor the classifier', async () => {
    const sentinel = new Error('PLAN_FACTORY_SENTINEL');
    const factory = throwingPlanFactory(sentinel);
    const service = queuedHourlyService([resolves(nonEmptySuccess())]);
    const { classifier, calls: classifierCalls } = recordingClassifier({ eligible: false });
    const fallback = createKmaHourlyFallbackService(factory, service, classifier);

    await expect(fallback.fetchHourlyForecastWithFallback(makeInput())).rejects.toBe(sentinel);
    expect(service.calls).toHaveLength(0);
    expect(classifierCalls).toHaveLength(0);
  });

  it('logs nothing and leaves a separate healthy service unaffected', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sentinel = new Error('PLAN_FACTORY_SILENT');
    const broken = createKmaHourlyFallbackService(
      throwingPlanFactory(sentinel),
      queuedHourlyService([resolves(nonEmptySuccess())]),
    );

    await expect(broken.fetchHourlyForecastWithFallback(makeInput())).rejects.toBe(sentinel);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    // A fresh healthy service still works — no cross-call state.
    const healthy = createKmaHourlyFallbackService(
      recordingPlanFactory(makeRequestPlan()),
      queuedHourlyService([resolves(nonEmptySuccess())]),
    );
    const result = await healthy.fetchHourlyForecastWithFallback(makeInput());
    expect(result.fallbackAttempted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §31 — primary service error / rejection
// ---------------------------------------------------------------------------

describe('createKmaHourlyFallbackService — primary service error / rejection', () => {
  it('propagates a synchronous throw from the primary service, skipping the classifier and previous', async () => {
    const sentinel = new Error('PRIMARY_SYNC_THROW');
    const factory = recordingPlanFactory(makeRequestPlan());
    const service = queuedHourlyService([
      () => {
        throw sentinel;
      },
    ]);
    const { classifier, calls: classifierCalls } = recordingClassifier({ eligible: true, reason: 'EMPTY_HOURLY' });
    const fallback = createKmaHourlyFallbackService(factory, service, classifier);

    await expect(fallback.fetchHourlyForecastWithFallback(makeInput())).rejects.toBe(sentinel);
    expect(factory.calls).toHaveLength(1);
    expect(service.calls).toHaveLength(1);
    expect(classifierCalls).toHaveLength(0);
  });

  it('propagates a rejected primary promise by the same reason, skipping the classifier and previous', async () => {
    const sentinel = new Error('PRIMARY_REJECTION');
    const service = queuedHourlyService([() => Promise.reject(sentinel)]);
    const { classifier, calls: classifierCalls } = recordingClassifier({ eligible: true, reason: 'EMPTY_HOURLY' });
    const fallback = createKmaHourlyFallbackService(
      recordingPlanFactory(makeRequestPlan()),
      service,
      classifier,
    );

    await expect(fallback.fetchHourlyForecastWithFallback(makeInput())).rejects.toBe(sentinel);
    expect(service.calls).toHaveLength(1);
    expect(classifierCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §32 — classifier error
// ---------------------------------------------------------------------------

describe('createKmaHourlyFallbackService — classifier error', () => {
  it('propagates the exact classifier error after one service call and never runs the previous', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sentinel = new Error('CLASSIFIER_SENTINEL');
    const service = queuedHourlyService([resolves(emptySuccess())]);
    const { classifier, calls: classifierCalls } = throwingClassifier(sentinel);
    const fallback = createKmaHourlyFallbackService(
      recordingPlanFactory(makeRequestPlan()),
      service,
      classifier,
    );

    await expect(fallback.fetchHourlyForecastWithFallback(makeInput())).rejects.toBe(sentinel);
    expect(service.calls).toHaveLength(1);
    expect(classifierCalls).toHaveLength(1);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §33 — previous service error / rejection
// ---------------------------------------------------------------------------

describe('createKmaHourlyFallbackService — previous service error / rejection', () => {
  it('propagates a synchronous throw from the previous service (no third request, no partial result)', async () => {
    const sentinel = new Error('PREVIOUS_SYNC_THROW');
    const factory = recordingPlanFactory(makeRequestPlan());
    const service = queuedHourlyService([
      resolves(emptySuccess()),
      () => {
        throw sentinel;
      },
    ]);
    const { classifier, calls: classifierCalls } = recordingClassifier({ eligible: true, reason: 'EMPTY_HOURLY' });
    const fallback = createKmaHourlyFallbackService(factory, service, classifier);

    await expect(fallback.fetchHourlyForecastWithFallback(makeInput())).rejects.toBe(sentinel);
    expect(factory.calls).toHaveLength(1);
    expect(service.calls).toHaveLength(2);
    expect(classifierCalls).toHaveLength(1);
  });

  it('propagates a rejected previous promise by the same reason (no third request)', async () => {
    const sentinel = new Error('PREVIOUS_REJECTION');
    const service = queuedHourlyService([resolves(emptySuccess()), () => Promise.reject(sentinel)]);
    const { classifier, calls: classifierCalls } = recordingClassifier({ eligible: true, reason: 'EMPTY_HOURLY' });
    const fallback = createKmaHourlyFallbackService(
      recordingPlanFactory(makeRequestPlan()),
      service,
      classifier,
    );

    await expect(fallback.fetchHourlyForecastWithFallback(makeInput())).rejects.toBe(sentinel);
    expect(service.calls).toHaveLength(2);
    expect(classifierCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// §34 — frozen inputs and results
// ---------------------------------------------------------------------------

describe('createKmaHourlyFallbackService — frozen inputs and results', () => {
  it('operates over deep-frozen collaborators and inputs without mutating any of them', async () => {
    const plan = deepFreeze(makeRequestPlan());
    const input = deepFreeze(makeInput());
    const options = deepFreeze<KmaHourlyFallbackServiceOptions>({});
    const primaryResult = deepFreeze(upstream('03'));
    const previousResult = deepFreeze(nonEmptySuccess([{ ...HOURLY_A }]));
    const eligibility = deepFreeze<KmaHourlyFallbackEligibility>({
      eligible: true,
      reason: 'KMA_NO_DATA',
    });

    const inputSnapshot = JSON.stringify(input);
    const planSnapshot = JSON.stringify(plan);
    const primarySnapshot = JSON.stringify(primaryResult);
    const previousSnapshot = JSON.stringify(previousResult);

    const factory = recordingPlanFactory(plan);
    const service = queuedHourlyService([resolves(primaryResult), resolves(previousResult)]);
    const { classifier } = recordingClassifier(eligibility);
    const fallback = createKmaHourlyFallbackService(factory, service, classifier);

    const result = await fallback.fetchHourlyForecastWithFallback(input, options);

    expect(result.fallbackAttempted).toBe(true);
    if (result.fallbackAttempted) {
      expect(result.fallbackReason).toBe('KMA_NO_DATA');
      expect(result.primary).toBe(primaryResult);
      expect(result.previous).toBe(previousResult);
    }
    // No mutation and no added property on any frozen input/result.
    expect(JSON.stringify(input)).toBe(inputSnapshot);
    expect(JSON.stringify(plan)).toBe(planSnapshot);
    expect(JSON.stringify(primaryResult)).toBe(primarySnapshot);
    expect(JSON.stringify(previousResult)).toBe(previousSnapshot);
  });
});

// ---------------------------------------------------------------------------
// §35 — result freshness
// ---------------------------------------------------------------------------

describe('createKmaHourlyFallbackService — result freshness', () => {
  it('returns a fresh, deep-equal wrapper with a distinct reference on repeated calls', async () => {
    const plan = makeRequestPlan();
    const primaryResult = emptySuccess();
    const previousResult = nonEmptySuccess();
    // Four responders: two full eligible runs.
    const service = queuedHourlyService([
      resolves(primaryResult),
      resolves(previousResult),
      resolves(primaryResult),
      resolves(previousResult),
    ]);
    const { classifier } = recordingClassifier({ eligible: true, reason: 'EMPTY_HOURLY' });
    const fallback = createKmaHourlyFallbackService(recordingPlanFactory(plan), service, classifier);

    const first = await fallback.fetchHourlyForecastWithFallback(makeInput());
    const second = await fallback.fetchHourlyForecastWithFallback(makeInput());

    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    // Nested results may share a reference (exact pass-through of the same fixture) — that is allowed.
    if (first.fallbackAttempted && second.fallbackAttempted) {
      expect(first.primary).toBe(second.primary);
      expect(first.previous).toBe(second.previous);
    }
  });

  it('is unaffected by a runtime mutation of a previously returned wrapper', async () => {
    const plan = makeRequestPlan();
    const primaryResult = emptySuccess();
    const previousResult = nonEmptySuccess();
    const service = queuedHourlyService([
      resolves(primaryResult),
      resolves(previousResult),
      resolves(primaryResult),
      resolves(previousResult),
    ]);
    const { classifier } = recordingClassifier({ eligible: true, reason: 'EMPTY_HOURLY' });
    const fallback = createKmaHourlyFallbackService(recordingPlanFactory(plan), service, classifier);

    const first = await fallback.fetchHourlyForecastWithFallback(makeInput());
    // Mutate the earlier wrapper via a runtime cast (readonly is compile-time only).
    (first as { fallbackAttempted: boolean }).fallbackAttempted = false;
    (first as { fallbackReason?: string }).fallbackReason = 'MUTATED';

    const second = await fallback.fetchHourlyForecastWithFallback(makeInput());
    expect(second.fallbackAttempted).toBe(true);
    if (second.fallbackAttempted) {
      expect(second.fallbackReason).toBe('EMPTY_HOURLY');
    }
  });
});

// ---------------------------------------------------------------------------
// §36 — logging cleanup
// ---------------------------------------------------------------------------

describe('createKmaHourlyFallbackService — no logging', () => {
  it('never calls console.log / console.warn / console.error across every path', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Construction.
    const factory = recordingPlanFactory(makeRequestPlan());

    // Successful no-fallback.
    const noFallback = createKmaHourlyFallbackService(
      factory,
      queuedHourlyService([resolves(nonEmptySuccess())]),
      recordingClassifier({ eligible: false }).classifier,
    );
    await noFallback.fetchHourlyForecastWithFallback(makeInput());

    // Successful fallback.
    const withFallback = createKmaHourlyFallbackService(
      recordingPlanFactory(makeRequestPlan()),
      queuedHourlyService([resolves(emptySuccess()), resolves(nonEmptySuccess())]),
      recordingClassifier({ eligible: true, reason: 'EMPTY_HOURLY' }).classifier,
    );
    await withFallback.fetchHourlyForecastWithFallback(makeInput());

    // Collaborator rejection.
    const rejecting = createKmaHourlyFallbackService(
      recordingPlanFactory(makeRequestPlan()),
      queuedHourlyService([() => Promise.reject(new Error('REJECT'))]),
    );
    await expect(rejecting.fetchHourlyForecastWithFallback(makeInput())).rejects.toThrow('REJECT');

    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
