import { describe, expect, it } from 'vitest';
import {
  ERR_NO_TEMPLATE,
  EXIT_NO_TEMPLATE,
  ReportError,
  ensureTemplates,
  resolveExitCode,
} from './cli-exit.js';

describe('ensureTemplates', () => {
  it('throws a ReportError carrying the machine-readable code when no templates exist', () => {
    let caught: unknown;
    try {
      ensureTemplates([]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReportError);
    expect((caught as ReportError).code).toBe(ERR_NO_TEMPLATE);
  });

  it('accepts a non-empty template list', () => {
    expect(() => ensureTemplates(['base'])).not.toThrow();
  });
});

describe('resolveExitCode', () => {
  it('returns the documented exit code 3 when no templates exist', () => {
    expect(resolveExitCode([])).toBe(EXIT_NO_TEMPLATE);
    expect(EXIT_NO_TEMPLATE).toBe(3);
  });

  it('returns 0 when templates exist', () => {
    expect(resolveExitCode(['base'])).toBe(0);
  });
});
