/**
 * Tests for exec config validation functions.
 *
 * Regression tests:
 * - copy-paste: assertExecProviderEffort delegates to providerSupportsExecEffort
 *   (single source of truth for provider-effort support)
 * - dead-code: assertExecProviderEffort is sufficient for type narrowing —
 *   no redundant re-validation is needed after it passes
 */

import { describe, it, expect } from 'vitest';
import {
  assertExecProviderEffort,
  EXEC_EFFORTS,
  providerSupportsExecEffort,
  getSupportedExecEfforts,
} from '../features/exec/configValidation.js';
import type { ExecEffort } from '../features/exec/types.js';

describe('assertExecProviderEffort and providerSupportsExecEffort consistency', () => {
  const providers = ['claude', 'codex', 'copilot'] as const;

  it('should reject exactly the same efforts that providerSupportsExecEffort returns false for', () => {
    for (const provider of providers) {
      for (const effort of EXEC_EFFORTS) {
        const supported = providerSupportsExecEffort(provider, effort);
        if (supported) {
          expect(() =>
            assertExecProviderEffort(provider, 'test-model', effort, 'test'),
          ).not.toThrow();
        } else {
          expect(() =>
            assertExecProviderEffort(provider, 'test-model', effort, 'test'),
          ).toThrow(`does not support effort "${effort}"`);
        }
      }
    }
  });

  it('should accept exactly the same efforts that getSupportedExecEfforts returns', () => {
    for (const provider of providers) {
      const supported = getSupportedExecEfforts(provider);
      for (const effort of supported) {
        expect(() =>
          assertExecProviderEffort(provider, 'test-model', effort, 'test'),
        ).not.toThrow();
      }
      const unsupported = EXEC_EFFORTS.filter((e) => !supported.includes(e));
      for (const effort of unsupported) {
        expect(() =>
          assertExecProviderEffort(provider, 'test-model', effort, 'test'),
        ).toThrow(`does not support effort`);
      }
    }
  });
});

describe('assertExecProviderEffort sufficiency for type narrowing', () => {
  it('should pass validation for claude provider with valid effort — no redundant check needed', () => {
    const effort: ExecEffort = 'high';
    // After assertExecProviderEffort passes, the effort is guaranteed valid
    // for the provider. Type assertions (as ClaudeEffort) are safe.
    expect(() =>
      assertExecProviderEffort('claude', 'opus', effort, 'test'),
    ).not.toThrow();
  });

  it('should pass validation for codex provider with valid effort — no redundant check needed', () => {
    const effort: ExecEffort = 'high';
    expect(() =>
      assertExecProviderEffort('codex', 'o3', effort, 'test'),
    ).not.toThrow();
  });

  it('should pass validation for copilot provider with valid effort — no redundant check needed', () => {
    const effort: ExecEffort = 'low';
    expect(() =>
      assertExecProviderEffort('copilot', 'gpt-4', effort, 'test'),
    ).not.toThrow();
  });

  it('should reject provider with unsupported effort before any downstream code runs', () => {
    // codex does not support 'max'
    expect(() =>
      assertExecProviderEffort('codex', 'o3', 'max', 'test'),
    ).toThrow('does not support effort "max"');
  });
});
