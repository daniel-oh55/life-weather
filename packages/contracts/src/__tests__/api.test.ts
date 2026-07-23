import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  apiEnvelopeHeader,
  CONTRACT_VERSION,
  weatherResponseV1,
  type ApiErrorV1,
  type WeatherOverview,
} from '../index';
import { fullOverview } from './fixtures';

const generatedAt = '2026-07-15T01:05:00Z';

function successResponse() {
  return {
    ok: true,
    meta: { contractVersion: 1, generatedAt, requestId: 'req_abc123' },
    data: fullOverview(),
  };
}

function errorResponse() {
  return {
    ok: false,
    meta: { contractVersion: 1, generatedAt, requestId: null },
    error: {
      code: 'DATA_UNAVAILABLE',
      message: '요청한 지역의 데이터를 사용할 수 없습니다.',
      retryable: true,
    },
  };
}

describe('weatherResponseV1', () => {
  it('parses a success response', () => {
    const result = weatherResponseV1.safeParse(successResponse());
    expect(result.success).toBe(true);
  });

  it('parses an error response', () => {
    const result = weatherResponseV1.safeParse(errorResponse());
    expect(result.success).toBe(true);
  });

  it('narrows the discriminated union on `ok`', () => {
    const parsed = weatherResponseV1.parse(successResponse());
    if (parsed.ok) {
      expectTypeOf(parsed.data).toEqualTypeOf<WeatherOverview>();
      expect(parsed.data.location.countryCode).toBe('KR');
    } else {
      expectTypeOf(parsed.error).toEqualTypeOf<ApiErrorV1>();
      throw new Error('expected the success branch');
    }
  });

  it('accepts contractVersion 1', () => {
    expect(CONTRACT_VERSION).toBe(1);
    expect(weatherResponseV1.safeParse(successResponse()).success).toBe(true);
  });

  it('rejects a full V1 response whose contractVersion is 2', () => {
    const response = successResponse();
    response.meta.contractVersion = 2;
    expect(weatherResponseV1.safeParse(response).success).toBe(false);
  });

  it('maps an unknown error code to UNKNOWN (compatible enum)', () => {
    const response = errorResponse();
    response.error.code = 'SOME_FUTURE_CODE';
    const parsed = weatherResponseV1.parse(response);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe('UNKNOWN');
    }
  });

  it('preserves the additive UNSUPPORTED_LOCATION code (not mapped to UNKNOWN)', () => {
    const response = errorResponse();
    response.error.code = 'UNSUPPORTED_LOCATION';
    const parsed = weatherResponseV1.parse(response);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe('UNSUPPORTED_LOCATION');
    }
  });

  it('rejects an invalid `ok` discriminator value', () => {
    const response = { ...successResponse(), ok: 'true' };
    expect(weatherResponseV1.safeParse(response).success).toBe(false);
  });

  it('requires a non-empty error message', () => {
    const response = errorResponse();
    response.error.message = '';
    expect(weatherResponseV1.safeParse(response).success).toBe(false);
  });
});

describe('apiEnvelopeHeader', () => {
  it('reads the version from a v1 response', () => {
    const header = apiEnvelopeHeader.parse(successResponse());
    expect(header.meta.contractVersion).toBe(1);
    expect(header.ok).toBe(true);
  });

  it('can read a v2 response version the full v1 schema would reject', () => {
    const response = successResponse();
    response.meta.contractVersion = 2;

    // The minimal header still parses and surfaces the higher version...
    const header = apiEnvelopeHeader.parse(response);
    expect(header.meta.contractVersion).toBe(2);

    // ...while the full v1 schema rejects it.
    expect(weatherResponseV1.safeParse(response).success).toBe(false);
  });

  it('rejects a non-integer or non-positive contract version', () => {
    expect(
      apiEnvelopeHeader.safeParse({ ok: true, meta: { contractVersion: 0 } })
        .success,
    ).toBe(false);
    expect(
      apiEnvelopeHeader.safeParse({ ok: true, meta: { contractVersion: 1.5 } })
        .success,
    ).toBe(false);
  });
});
