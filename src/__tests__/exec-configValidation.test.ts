import { describe, it, expect } from 'vitest';
import {
  assertExecProviderModel,
  assertExecProviderEffort,
  EXEC_EFFORTS,
  providerSupportsExecEffort,
  getSupportedExecEfforts,
} from '../features/exec/configValidation.js';
import type { ExecEffort } from '../features/exec/types.js';

describe('assertExecProviderEffort and providerSupportsExecEffort consistency', () => {
  const providers = ['claude', 'codex', 'copilot'] as const;
  const effortCases = providers.flatMap((provider) =>
    EXEC_EFFORTS.map((effort) => [provider, effort] as const));
  const supportedEffortCases = providers.flatMap((provider) =>
    getSupportedExecEfforts(provider).map((effort) => [provider, effort] as const));
  const unsupportedEffortCases = providers.flatMap((provider) =>
    EXEC_EFFORTS
      .filter((effort) => !getSupportedExecEfforts(provider).includes(effort))
      .map((effort) => [provider, effort] as const));

  it.each(effortCases)(
    'should match providerSupportsExecEffort for %s/%s',
    (provider, effort) => {
      const supported = providerSupportsExecEffort(provider, effort);
      if (supported) {
        expect(() =>
          assertExecProviderEffort(provider, effort, 'test'),
        ).not.toThrow();
      } else {
        expect(() =>
          assertExecProviderEffort(provider, effort, 'test'),
        ).toThrow(`does not support effort "${effort}"`);
      }
    },
  );

  it.each(supportedEffortCases)(
    'should accept effort returned by getSupportedExecEfforts for %s/%s',
    (provider, effort) => {
      expect(() =>
        assertExecProviderEffort(provider, effort, 'test'),
      ).not.toThrow();
    },
  );

  it.each(unsupportedEffortCases)(
    'should reject effort omitted from getSupportedExecEfforts for %s/%s',
    (provider, effort) => {
      expect(() =>
        assertExecProviderEffort(provider, effort, 'test'),
      ).toThrow(`does not support effort`);
    },
  );
});

describe('assertExecProviderEffort sufficiency for type narrowing', () => {
  it('should pass validation for claude provider with valid effort — no redundant check needed', () => {
    const effort: ExecEffort = 'high';
    expect(() =>
      assertExecProviderEffort('claude', effort, 'test'),
    ).not.toThrow();
  });

  it('should pass validation for codex provider with valid effort — no redundant check needed', () => {
    const effort: ExecEffort = 'high';
    expect(() =>
      assertExecProviderEffort('codex', effort, 'test'),
    ).not.toThrow();
  });

  it('should pass validation for copilot provider with valid effort — no redundant check needed', () => {
    const effort: ExecEffort = 'low';
    expect(() =>
      assertExecProviderEffort('copilot', effort, 'test'),
    ).not.toThrow();
  });

  it('should reject provider with unsupported effort before any downstream code runs', () => {
    expect(() =>
      assertExecProviderEffort('codex', 'max', 'test'),
    ).toThrow('does not support effort "max"');
  });

  it('should allow codex provider when effort is undefined', () => {
    expect(() =>
      assertExecProviderEffort('codex', undefined, 'test'),
    ).not.toThrow();
  });

  it('should allow copilot provider when effort is undefined', () => {
    expect(() =>
      assertExecProviderEffort('copilot', undefined, 'test'),
    ).not.toThrow();
  });

  it('should allow xhigh for Claude tool providers without model-specific checks', () => {
    expect(() =>
      assertExecProviderEffort('claude', 'xhigh', 'test'),
    ).not.toThrow();
    expect(() =>
      assertExecProviderEffort('claude-sdk', 'xhigh', 'test'),
    ).not.toThrow();
    expect(() =>
      assertExecProviderEffort('claude-terminal', 'xhigh', 'test'),
    ).not.toThrow();
  });
});

describe('assertExecProviderModel', () => {
  it('should allow arbitrary codex model names and leave support to the provider', () => {
    expect(() => assertExecProviderModel('codex', 'sonnet', 'exec.session.model'))
      .not.toThrow();
    expect(() => assertExecProviderModel('codex', 'opus', 'exec.session.model'))
      .not.toThrow();
  });

  it('should reject bare opencode models before workflow execution', () => {
    expect(() => assertExecProviderModel('opencode', 'big-pickle', 'exec.session.model'))
      .toThrow(/provider\/model/);
  });

  it.each(['', '   '] as const)(
    'should reject blank exec models before workflow execution',
    (model) => {
      expect(() => assertExecProviderModel('cursor', model, 'exec.session.model'))
        .toThrow(/expected non-empty string/);
    },
  );

  it('should accept structurally valid exec models', () => {
    expect(() => assertExecProviderModel('codex', 'gpt-5', 'exec.session.model')).not.toThrow();
    expect(() => assertExecProviderModel('opencode', 'opencode/big-pickle', 'exec.session.model')).not.toThrow();
  });

  it.each(['claude', 'codex', 'mock', 'cursor', 'copilot', 'kiro'] as const)(
    'should allow omitted model for %s',
    (provider) => {
      expect(() => assertExecProviderModel(provider, undefined, 'exec.session.model')).not.toThrow();
    },
  );

  it.each(['opencode'] as const)(
    'should reject omitted model for %s',
    (provider) => {
      expect(() => assertExecProviderModel(provider, undefined, 'exec.session.model'))
        .toThrow(/requires model/);
    },
  );
});
