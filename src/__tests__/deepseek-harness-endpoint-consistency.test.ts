import { describe, expect, it } from 'vitest';
import {
  assertDeepSeekEndpointConsistency,
  resolveEffectiveDeepSeekEndpoint,
} from '../infra/deepseek-harness/endpoint-consistency.js';

const PUBLIC_BASE_URL = 'https://api.deepseek.com';

function captureEndpointError(
  options: Parameters<typeof assertDeepSeekEndpointConsistency>[0],
): string {
  try {
    assertDeepSeekEndpointConsistency(options);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('DeepSeek endpoint pair was accepted unexpectedly');
}

describe('DeepSeek Harness effective endpoint resolution', () => {
  it('keeps the existing provider option, environment, and public default order', () => {
    expect(resolveEffectiveDeepSeekEndpoint({
      providerOptions: { baseUrl: 'https://provider-option.example/v1' },
      childProcessEnv: { DEEPSEEK_BASE_URL: 'https://child-env.example/v1' },
      ambientEnv: { DEEPSEEK_BASE_URL: 'https://ambient-env.example/v1' },
    })).toBe('https://provider-option.example/v1');

    expect(resolveEffectiveDeepSeekEndpoint({
      providerOptions: undefined,
      childProcessEnv: { DEEPSEEK_BASE_URL: 'https://child-env.example/v1' },
      ambientEnv: { DEEPSEEK_BASE_URL: 'https://ambient-env.example/v1' },
    })).toBe('https://child-env.example/v1');

    expect(resolveEffectiveDeepSeekEndpoint({
      providerOptions: undefined,
      childProcessEnv: undefined,
      ambientEnv: { DEEPSEEK_BASE_URL: 'https://ambient-env.example/v1' },
    })).toBe('https://ambient-env.example/v1');

    expect(resolveEffectiveDeepSeekEndpoint({
      providerOptions: undefined,
      childProcessEnv: undefined,
      ambientEnv: {},
    })).toBe(PUBLIC_BASE_URL);
  });
});

describe('DeepSeek Harness endpoint consistency check', () => {
  it('accepts identical endpoints and a trailing base-URL slash difference', () => {
    expect(() => assertDeepSeekEndpointConsistency({
      storedBaseUrl: 'https://api.deepseek.com',
      effectiveBaseUrl: 'https://api.deepseek.com',
    })).not.toThrow();
    expect(() => assertDeepSeekEndpointConsistency({
      storedBaseUrl: 'https://api.deepseek.com/',
      effectiveBaseUrl: 'https://api.deepseek.com',
    })).not.toThrow();
    expect(() => assertDeepSeekEndpointConsistency({
      storedBaseUrl: 'https://api.deepseek.com/v1',
      effectiveBaseUrl: 'https://api.deepseek.com/v1',
    })).not.toThrow();
  });

  it('treats the default port as equivalent to an omitted port', () => {
    expect(() => assertDeepSeekEndpointConsistency({
      storedBaseUrl: 'https://api.deepseek.com:443/v1',
      effectiveBaseUrl: 'https://api.deepseek.com/v1',
    })).not.toThrow();
    expect(() => assertDeepSeekEndpointConsistency({
      storedBaseUrl: 'http://api.deepseek.com:80/v1',
      effectiveBaseUrl: 'http://api.deepseek.com/v1',
    })).not.toThrow();
  });

  it('accepts a valid effective endpoint when the settings document stores no baseURL', () => {
    expect(() => assertDeepSeekEndpointConsistency({
      storedBaseUrl: undefined,
      effectiveBaseUrl: 'https://api.deepseek.com',
    })).not.toThrow();
  });

  it.each([
    'https://user:password@api.deepseek.com',
    'ftp://api.deepseek.com',
    'invalid-endpoint',
  ])('rejects an invalid effective endpoint even without stored settings: %s', (effectiveBaseUrl) => {
    const message = captureEndpointError({ effectiveBaseUrl });
    expect(message).not.toContain(effectiveBaseUrl);
    expect(message).not.toContain('password');
  });

  it('does not discard effective URL userinfo when comparing an otherwise matching endpoint', () => {
    expect(() => assertDeepSeekEndpointConsistency({
      storedBaseUrl: 'https://api.deepseek.com',
      effectiveBaseUrl: 'https://user:password@api.deepseek.com',
    })).toThrow(/endpoint/iu);
  });

  it.each([
    ['scheme', 'http://api.deepseek.com/v1', 'https://api.deepseek.com/v1'],
    ['host', 'https://other.example/v1', 'https://api.deepseek.com/v1'],
    ['non-default port', 'https://api.deepseek.com:8443/v1', 'https://api.deepseek.com/v1'],
    ['path', 'https://api.deepseek.com/v2', 'https://api.deepseek.com/v1'],
    ['query', 'https://api.deepseek.com/v1?region=other', 'https://api.deepseek.com/v1'],
  ] as const)('rejects a %s difference between the stored and effective endpoint', (
    _label,
    storedBaseUrl,
    effectiveBaseUrl,
  ) => {
    const message = captureEndpointError({ storedBaseUrl, effectiveBaseUrl });

    expect(message).toMatch(/endpoint|baseURL/iu);
  });

  it.each([
    ['userinfo', 'https://deepseek-user:deepseek-password@api.deepseek.com/v1'],
    ['non-http scheme', 'ftp://api.deepseek.com/v1'],
    ['malformed URL', 'not a URL'],
  ] as const)('rejects a stored endpoint with %s instead of comparing it loosely', (_label, storedBaseUrl) => {
    const message = captureEndpointError({
      storedBaseUrl,
      effectiveBaseUrl: 'https://api.deepseek.com/v1',
    });

    expect(message).not.toContain('deepseek-password');
    expect(message).not.toContain(storedBaseUrl);
  });

  it('rejects a stored endpoint with userinfo even when it matches the effective endpoint', () => {
    const storedBaseUrl = 'https://deepseek-user:deepseek-password@api.deepseek.com/v1';
    const message = captureEndpointError({
      storedBaseUrl,
      effectiveBaseUrl: storedBaseUrl,
    });

    expect(message).not.toContain('deepseek-password');
    expect(message).not.toContain(storedBaseUrl);
  });

  it('does not echo either full endpoint when they differ', () => {
    const storedBaseUrl = 'https://stored-endpoint.example/v1';
    const effectiveBaseUrl = 'https://effective-endpoint.example/v1';
    const message = captureEndpointError({ storedBaseUrl, effectiveBaseUrl });

    expect(message).not.toContain(storedBaseUrl);
    expect(message).not.toContain(effectiveBaseUrl);
  });
});
