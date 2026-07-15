import { describe, expect, it } from 'vitest';

import app from './index';

describe('GET /health', () => {
  it('returns a deterministic 200 JSON health payload', async () => {
    const res = await app.request('/health');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = (await res.json()) as { status: string; service: string };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('life-weather-api');
  });
});
