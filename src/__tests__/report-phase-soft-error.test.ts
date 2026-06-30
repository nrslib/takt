import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReportPhaseGenerationError } from '../core/workflow/report-phase-runner.js';

describe('ReportPhaseGenerationError soft error', () => {
  it('should be an instance of Error', () => {
    const err = new ReportPhaseGenerationError('test');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ReportPhaseGenerationError);
    expect(err.name).toBe('ReportPhaseGenerationError');
  });

  it('should be distinguishable from generic Error', () => {
    const genericError = new Error('generic');
    const reportError = new ReportPhaseGenerationError('report failed');

    expect(genericError instanceof ReportPhaseGenerationError).toBe(false);
    expect(reportError instanceof ReportPhaseGenerationError).toBe(true);
  });

  it('should be catchable with instanceof check', () => {
    let caught = false;
    let continuedToPhase3 = false;

    try {
      throw new ReportPhaseGenerationError('Report phase failed for review.md: tool call');
    } catch (error) {
      if (error instanceof ReportPhaseGenerationError) {
        caught = true;
        continuedToPhase3 = true;
      } else {
        throw error;
      }
    }

    expect(caught).toBe(true);
    expect(continuedToPhase3).toBe(true);
  });

  it('should NOT catch non-ReportPhaseGenerationError', () => {
    let rethrown = false;

    try {
      try {
        throw new Error('Invalid report file name: bad');
      } catch (error) {
        if (error instanceof ReportPhaseGenerationError) {
          // should not reach here
        } else {
          rethrown = true;
          throw error;
        }
      }
    } catch {
      // expected
    }

    expect(rethrown).toBe(true);
  });
});
