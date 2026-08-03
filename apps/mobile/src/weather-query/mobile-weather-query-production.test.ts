import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validWeatherRequest } from '../weather-api/fixtures';

const ENV_KEY = 'EXPO_PUBLIC_API_BASE_URL';

/** Let every pending microtask settle, so an already-scheduled `.then` callback has run. */
async function flush(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('mobile-weather-query-production', () => {
  let originalEnvValue: string | undefined;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    originalEnvValue = process.env[ENV_KEY];
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    if (originalEnvValue === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = originalEnvValue;
    }
  });

  it('performs no fetch on import when the env var is unset', async () => {
    delete process.env[ENV_KEY];

    await import('./mobile-weather-query-production');

    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it('does not throw on import with a blank env var', async () => {
    process.env[ENV_KEY] = '';

    await expect(import('./mobile-weather-query-production')).resolves.toBeDefined();
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it('resolves a request to CONFIGURATION with a blank env var, calling fetch 0 times', async () => {
    process.env[ENV_KEY] = '';
    const { mobileWeatherQueryStore } = await import('./mobile-weather-query-production');

    mobileWeatherQueryStore.request('synthetic-location', validWeatherRequest());
    await flush();

    expect(mobileWeatherQueryStore.getSnapshot()).toEqual({
      status: 'ERROR',
      locationId: 'synthetic-location',
      presentation: 'CONFIGURATION',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it('performs no fetch on import with a valid synthetic base URL', async () => {
    process.env[ENV_KEY] = 'https://example.test';

    await import('./mobile-weather-query-production');

    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });
});
