/**
 * CycleDetector unit tests
 *
 * Tests cycle detection logic for loop_monitors.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CycleDetector } from '../core/piece/engine/cycle-detector.js';
import type { LoopMonitorConfig } from '../core/models/index.js';

function makeMonitor(
  cycle: string[],
  threshold: number,
  rules = [
    { condition: 'healthy', next: 'ai_review' },
    { condition: 'unproductive', next: 'reviewers' },
  ],
): LoopMonitorConfig {
  return {
    cycle,
    threshold,
    judge: { rules },
  };
}

describe('CycleDetector', () => {
  describe('2-step cycle detection', () => {
    let detector: CycleDetector;
    const monitor = makeMonitor(['ai_review', 'ai_fix'], 3);

    beforeEach(() => {
      detector = new CycleDetector([monitor]);
    });

    it('should not trigger before threshold is reached', () => {
      // 2 complete cycles (4 movements)
      expect(detector.recordAndCheck('ai_review').triggered).toBe(false);
      expect(detector.recordAndCheck('ai_fix').triggered).toBe(false);
      expect(detector.recordAndCheck('ai_review').triggered).toBe(false);
      expect(detector.recordAndCheck('ai_fix').triggered).toBe(false);
    });

    it('should trigger when threshold (3 cycles) is reached', () => {
      // 3 complete cycles (6 movements)
      detector.recordAndCheck('ai_review');
      detector.recordAndCheck('ai_fix');
      detector.recordAndCheck('ai_review');
      detector.recordAndCheck('ai_fix');
      detector.recordAndCheck('ai_review');
      const result = detector.recordAndCheck('ai_fix');

      expect(result.triggered).toBe(true);
      expect(result.cycleCount).toBe(3);
      expect(result.monitor).toBe(monitor);
    });

    it('should not trigger when cycle is interrupted by another movement', () => {
      detector.recordAndCheck('ai_review');
      detector.recordAndCheck('ai_fix');
      detector.recordAndCheck('ai_review');
      detector.recordAndCheck('ai_fix');
      // Interrupt the cycle with a different movement
      detector.recordAndCheck('plan');
      detector.recordAndCheck('ai_review');
      const result = detector.recordAndCheck('ai_fix');

      // Only 1 complete cycle since the interruption
      expect(result.triggered).toBe(false);
    });

    it('should not trigger when only the cycle end matches', () => {
      // History doesn't form a valid cycle pattern
      detector.recordAndCheck('plan');
      detector.recordAndCheck('implement');
      detector.recordAndCheck('ai_fix');

      expect(detector.recordAndCheck('ai_fix').triggered).toBe(false);
    });

    it('should reset correctly and not trigger after reset', () => {
      // Build up 2 cycles
      detector.recordAndCheck('ai_review');
      detector.recordAndCheck('ai_fix');
      detector.recordAndCheck('ai_review');
      detector.recordAndCheck('ai_fix');

      // Reset
      detector.reset();

      // Now only 1 cycle after reset
      detector.recordAndCheck('ai_review');
      const result = detector.recordAndCheck('ai_fix');
      expect(result.triggered).toBe(false);
      expect(result.cycleCount).toBe(0); // Less than threshold
    });

    it('should trigger exactly at threshold, not before', () => {
      // Threshold is 3
      // Cycle 1
      expect(detector.recordAndCheck('ai_review').triggered).toBe(false);
      expect(detector.recordAndCheck('ai_fix').triggered).toBe(false);

      // Cycle 2
      expect(detector.recordAndCheck('ai_review').triggered).toBe(false);
      expect(detector.recordAndCheck('ai_fix').triggered).toBe(false);

      // Cycle 3 (threshold reached)
      expect(detector.recordAndCheck('ai_review').triggered).toBe(false);
      expect(detector.recordAndCheck('ai_fix').triggered).toBe(true);
    });
  });

  describe('3-step cycle detection', () => {
    it('should detect 3-step cycles', () => {
      const monitor = makeMonitor(['A', 'B', 'C'], 2);
      const detector = new CycleDetector([monitor]);

      // Cycle 1
      detector.recordAndCheck('A');
      detector.recordAndCheck('B');
      detector.recordAndCheck('C');

      // Cycle 2
      detector.recordAndCheck('A');
      detector.recordAndCheck('B');
      const result = detector.recordAndCheck('C');

      expect(result.triggered).toBe(true);
      expect(result.cycleCount).toBe(2);
    });
  });

  describe('multiple monitors', () => {
    it('should check all monitors and trigger the first matching one', () => {
      const monitor1 = makeMonitor(['A', 'B'], 3);
      const monitor2 = makeMonitor(['X', 'Y'], 2);
      const detector = new CycleDetector([monitor1, monitor2]);

      // 2 cycles of X → Y (threshold for monitor2 is 2)
      detector.recordAndCheck('X');
      detector.recordAndCheck('Y');
      detector.recordAndCheck('X');
      const result = detector.recordAndCheck('Y');

      expect(result.triggered).toBe(true);
      expect(result.cycleCount).toBe(2);
      expect(result.monitor).toBe(monitor2);
    });
  });

  describe('no monitors', () => {
    it('should never trigger with empty monitors', () => {
      const detector = new CycleDetector([]);
      detector.recordAndCheck('ai_review');
      detector.recordAndCheck('ai_fix');
      detector.recordAndCheck('ai_review');
      const result = detector.recordAndCheck('ai_fix');

      expect(result.triggered).toBe(false);
    });
  });

  describe('getHistory', () => {
    it('should return the full movement history', () => {
      const detector = new CycleDetector([]);
      detector.recordAndCheck('plan');
      detector.recordAndCheck('implement');
      detector.recordAndCheck('ai_review');

      expect(detector.getHistory()).toEqual(['plan', 'implement', 'ai_review']);
    });

    it('should return empty after reset', () => {
      const detector = new CycleDetector([]);
      detector.recordAndCheck('plan');
      detector.reset();

      expect(detector.getHistory()).toEqual([]);
    });
  });

  describe('threshold of 1', () => {
    it('should trigger after first complete cycle', () => {
      const monitor = makeMonitor(['A', 'B'], 1);
      const detector = new CycleDetector([monitor]);

      detector.recordAndCheck('A');
      const result = detector.recordAndCheck('B');

      expect(result.triggered).toBe(true);
      expect(result.cycleCount).toBe(1);
    });
  });

  describe('beyond threshold', () => {
    it('should also trigger at threshold + N (consecutive cycles)', () => {
      const monitor = makeMonitor(['A', 'B'], 2);
      const detector = new CycleDetector([monitor]);

      // 2 cycles → threshold met
      detector.recordAndCheck('A');
      detector.recordAndCheck('B');
      detector.recordAndCheck('A');
      const result1 = detector.recordAndCheck('B');
      expect(result1.triggered).toBe(true);
      expect(result1.cycleCount).toBe(2);

      // After reset + 3 more cycles → triggers at 2 again
      detector.reset();
      detector.recordAndCheck('A');
      detector.recordAndCheck('B');
      detector.recordAndCheck('A');
      const result2 = detector.recordAndCheck('B');
      expect(result2.triggered).toBe(true);
      expect(result2.cycleCount).toBe(2);
    });
  });
});
