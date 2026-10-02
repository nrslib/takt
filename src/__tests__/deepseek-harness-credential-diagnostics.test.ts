import { describe, expect, it } from 'vitest';
import {
  buildCredentialDiagnostic,
  buildDeepSeekRuntimeFailureDiagnostic,
  buildDeepSeekSdkFailureDiagnostic,
  classifyDeepSeekRuntimeCredentialFailure,
  classifyDeepSeekRuntimeFailure,
  projectDeepSeekRuntimeMessage,
  DEEPSEEK_CREDENTIAL_DIAGNOSTIC_CLASSIFICATIONS,
  type DeepSeekCredentialDiagnosticContext,
} from '../infra/deepseek-harness/credential-diagnostics.js';

const MISSING_CREDENTIAL_FAILURE = 'MISSING_CREDENTIAL: llm-deepseek: no API key for provider route '
  + '"deepseek-official"; store DEEPSEEK_API_KEY through the credentials service '
  + '(the web Models page writes it), or export DEEPSEEK_API_KEY in the launching environment';
const INVALID_STORE_FAILURE = 'DeepSeek Harness jsonrpc-error: failed to apply loader entry credentials '
  + '(@deepseek-ai/dsh-credentials-local): credentials-local: invalid document at '
  + '/private/tmp/example/.credentials.yaml: BAD_INDENT at line 3, column 1';
const AUTH_REJECTED_FAILURE = 'AUTH: rejected dummy-echoed-credential-value';

function createContext(
  overrides: Partial<DeepSeekCredentialDiagnosticContext> = {},
): DeepSeekCredentialDiagnosticContext {
  return {
    classification: 'missing-credential',
    sourceHomeOrigin: 'environment',
    reference: 'DEEPSEEK_API_KEY',
    ...overrides,
  };
}

function expectSafeDiagnostic(message: string): void {
  expect(message.trim().length).toBeGreaterThan(0);
  expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
  expect(message).not.toMatch(/https?:\/\//iu);
  expect(message).not.toMatch(/\/(?:Users|home|private|tmp|var)\//u);
}

describe('DeepSeek Harness runtime credential failure classification', () => {
  it.each([
    ['a coded missing-credential failure', MISSING_CREDENTIAL_FAILURE, 'missing-credential'],
    [
      'an uncoded missing-credential message',
      'llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY '
      + 'through the credentials service (the web Models page writes it), or export DEEPSEEK_API_KEY '
      + 'in the launching environment',
      'missing-credential',
    ],
    ['an invalid store document failure', INVALID_STORE_FAILURE, 'invalid-store'],
    ['an auth rejection failure', AUTH_REJECTED_FAILURE, 'auth-rejected'],
  ] as const)('classifies %s', (_label, failure, expected) => {
    expect(classifyDeepSeekRuntimeCredentialFailure(failure)).toBe(expected);
  });

  it.each([
    ['an unrelated transport failure', 'DeepSeek Harness bridge transport closed'],
    ['an AUTH-containing model identifier', 'SDK rejected unknown model "AUTH-model"'],
    ['an AUTH-containing hostname', 'connect ECONNREFUSED AUTH.example:443'],
    ['a secret-bearing AUTH-containing hostname', 'connect ECONNREFUSED AUTH.example:443 token=store-only-secret'],
    ['an empty failure', ''],
  ] as const)('keeps %s unclassified', (_label, failure) => {
    expect(classifyDeepSeekRuntimeCredentialFailure(failure)).toBe('unknown');
  });
});

describe('DeepSeek Harness actionable runtime failure classification', () => {
  it('uses only known SDK exception codes and never the exception message for generic diagnostics', () => {
    expect(buildDeepSeekSdkFailureDiagnostic('jsonrpc-error')).toMatch(/JSON-RPC.*withheld/iu);
    expect(buildDeepSeekSdkFailureDiagnostic('transport-closed')).toMatch(/connection closed.*withheld/iu);
    for (const code of ['runtime-error', 'runtime-unavailable', 'unknown', 'AUTH: store-only-secret']) {
      expect(buildDeepSeekSdkFailureDiagnostic(code)).toBeUndefined();
    }
  });

  it.each([
    [
      'a model reference failure',
      { code: 'runtime-error', message: 'SDK rejected unknown model "unknown-model"' },
      'model-reference',
    ],
    [
      'a model reference containing AUTH',
      { code: 'runtime-error', message: 'SDK rejected unknown model "AUTH-model"' },
      'model-reference',
    ],
    [
      'a connection failure',
      { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED deepseek.example:443' },
      'connection-failure',
    ],
    [
      'a connection failure containing AUTH',
      { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED AUTH.example:443' },
      'connection-failure',
    ],
    [
      'a runtime-internal failure',
      { code: 'runtime-error', message: 'DeepSeek Harness runtime internal failure' },
      'runtime-internal-failure',
    ],
    [
      'an unclassified provider request with masked credentials',
      { code: 'runtime-error', message: 'provider request failed: timeout; Authorization: Bearer store-only-secret' },
      'other-provider-transport',
    ],
  ] as const)('classifies %s', (_label, evidence, expected) => {
    expect(classifyDeepSeekRuntimeFailure(evidence)).toBe(expected);
  });

  it.each([
    ['a missing message', { code: 'runtime-error', message: undefined }],
    ['an explicit credential rejection', { code: 'runtime-error', message: AUTH_REJECTED_FAILURE }],
    ['an opaque secret without a field boundary', {
      code: 'runtime-error',
      message: 'provider request failed: timeout store-only-secret',
    }],
    ['a mismatched connection code', {
      code: 'ETIMEDOUT',
      message: 'connect ECONNREFUSED deepseek.example:443',
    }],
  ] as const)('keeps %s unknown', (_label, evidence) => {
    expect(classifyDeepSeekRuntimeFailure(evidence)).toBe('unknown');
  });

  it.each([
    ['model-reference', /model.*reference/iu],
    ['connection-failure', /endpoint|network/iu],
    ['runtime-internal-failure', /runtime.*failure/iu],
    ['other-provider-transport', /provider or transport/iu],
  ] as const)('builds an actionable diagnostic for %s', (classification, expected) => {
    const message = buildDeepSeekRuntimeFailureDiagnostic(classification);

    expect(message).toMatch(expected);
    expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
  });

  it('projects only safe upstream syntax and erases opaque fields', () => {
    expect(projectDeepSeekRuntimeMessage('SDK rejected unknown model "opaque-store-only-secret"'))
      .toBe('SDK rejected unknown model [REDACTED]');
    expect(projectDeepSeekRuntimeMessage('connect ECONNREFUSED opaque-store-only-secret:443'))
      .toBe('connect ECONNREFUSED [REDACTED]');
    expect(projectDeepSeekRuntimeMessage('connect ECONNRESET opaque-store-only-secret:443'))
      .toBe('connect ECONNRESET [REDACTED]');
    expect(projectDeepSeekRuntimeMessage('SDK rejected unknown model "opaque-model" api_key=store-only-secret'))
      .toBe('SDK rejected unknown model [REDACTED]; credential=[REDACTED]');
    expect(projectDeepSeekRuntimeMessage('connect ECONNREFUSED peer.example:443 token=store-only-secret'))
      .toBe('connect ECONNREFUSED [REDACTED]; credential=[REDACTED]');
    expect(projectDeepSeekRuntimeMessage('provider request failed: timeout; Authorization: Bearer store-only-secret; CUSTOM_DSH_KEY=opaque-store-value; sk-1234567890'))
      .toBe('provider request failed: timeout; auth=[REDACTED]; credential=[REDACTED]; token=[REDACTED]');
    expect(projectDeepSeekRuntimeMessage('transport request failed: connection refused; token=opaque-store-secret'))
      .toBe('transport request failed: connection refused; credential=[REDACTED]');
    expect(projectDeepSeekRuntimeMessage('Authorization: Bearer opaque-store-only-secret')).toBeUndefined();
    expect(projectDeepSeekRuntimeMessage('connect ECONNRESET peer.example:443\nsecret=opaque-store-only-secret'))
      .toBeUndefined();
    expect(projectDeepSeekRuntimeMessage('')).toBeUndefined();
    expect(projectDeepSeekRuntimeMessage('provider request failed: timeout; opaque=store-only-secret')).toBeUndefined();
    expect(projectDeepSeekRuntimeMessage('provider request failed: timeout; token=secret; unexpected detail')).toBeUndefined();
  });
});

describe('DeepSeek Harness credential diagnostics', () => {
  it.each(['settings-unreadable', 'settings-too-large', 'invalid-settings', 'invalid-selector', 'invalid-stored-endpoint'] as const)(
    'marks the reference unresolved after %s before selector resolution', (classification) => {
      const message = buildCredentialDiagnostic({ classification, sourceHomeOrigin: 'environment' });
      expect(message).toContain('Reference: unresolved');
      expect(message).not.toContain('DEEPSEEK_API_KEY');
      expectSafeDiagnostic(message);
    },
  );

  it('does not recommend exporting an invented reference when unresolved', () => {
    const message = buildCredentialDiagnostic({ classification: 'missing-credential', sourceHomeOrigin: 'default' });
    expect(message).toContain('Reference: unresolved');
    expect(message).not.toContain('export');
    expect(message).not.toContain('DEEPSEEK_API_KEY');
  });

  it('does not invent a default reference for an invalid selector', () => {
    const message = buildCredentialDiagnostic(createContext({
      classification: 'invalid-selector', reference: 'invalid-secret\nselector',
    }));
    expect(message).toContain('Reference: unresolved');
    expect(message).not.toContain('DEEPSEEK_API_KEY');
    expect(message).not.toContain('invalid-secret');
    expectSafeDiagnostic(message);
  });

  it.each([...DEEPSEEK_CREDENTIAL_DIAGNOSTIC_CLASSIFICATIONS])(
    'builds a safe diagnostic for the %s classification',
    (classification) => {
      const message = buildCredentialDiagnostic(createContext({ classification }));

      expectSafeDiagnostic(message);
      expect(message).toContain('DEEPSEEK_API_KEY');
    },
  );

  it.each(['environment', 'child-process-env'] as const)(
    'names the %s origin as the DSH_HOME environment variable',
    (sourceHomeOrigin) => {
      const message = buildCredentialDiagnostic(createContext({ sourceHomeOrigin }));

      expect(message).toContain('DSH_HOME');
      expect(message).not.toContain('~/.dsh');
    },
  );

  it('names the default origin as the harness default home', () => {
    const message = buildCredentialDiagnostic(createContext({
      sourceHomeOrigin: 'default',
      classification: 'missing-credential',
    }));

    expect(message).toContain('~/.dsh');
  });

  it('tells the user how to repair a missing credential through the store or the environment', () => {
    const message = buildCredentialDiagnostic(createContext({ classification: 'missing-credential' }));

    expect(message).toMatch(/Settings|credentials service/iu);
    expect(message).toMatch(/export/iu);
  });

  it('tells the user which settings selector to repair', () => {
    const message = buildCredentialDiagnostic(createContext({
      classification: 'invalid-selector',
      reference: 'MY_KEY',
    }));

    expect(message).toContain('MY_KEY');
    expect(message).toMatch(/settings\.yaml|apiKeyEnv/iu);
  });

  it('tells the user to align the base URL for an endpoint mismatch', () => {
    const message = buildCredentialDiagnostic(createContext({ classification: 'endpoint-mismatch' }));

    expect(message).toMatch(/base ?url|endpoint/iu);
    expect(message).toMatch(/DEEPSEEK_BASE_URL|deepseek_harness|provider_options/iu);
  });

  it('tells the user to start a new run for a binding change', () => {
    const message = buildCredentialDiagnostic(createContext({ classification: 'binding-changed' }));

    expect(message).toMatch(/binding/iu);
    expect(message).toMatch(/new (run|session)/iu);
  });

  it('keeps an auth rejection diagnostic free of raw provider output', () => {
    const message = buildCredentialDiagnostic(createContext({ classification: 'auth-rejected' }));

    expectSafeDiagnostic(message);
    expect(message).not.toContain('dummy-echoed-credential-value');
    expect(message).not.toContain('rejected');
  });
});
