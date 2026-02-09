/**
 * Unit tests for LoopDetector
 *
 * Tests consecutive same-movement detection and configurable actions.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LoopDetector } from '../core/piece/engine/loop-detector.js';

describe('LoopDetector', () => {
  describe('with default config', () => {
    let detector: LoopDetector;

    beforeEach(() => {
      detector = new LoopDetector();
    });

    it('should not detect loop for different movements', () => {
      const result1 = detector.check('step-a');
      const result2 = detector.check('step-b');
      const result3 = detector.check('step-a');
      expect(result1.isLoop).toBe(false);
      expect(result2.isLoop).toBe(false);
      expect(result3.isLoop).toBe(false);
    });

    it('should not detect loop below threshold (10 consecutive)', () => {
      for (let i = 0; i < 10; i++) {
        const result = detector.check('step-a');
        expect(result.isLoop).toBe(false);
      }
    });

    it('should detect loop at 11th consecutive execution (default threshold 10)', () => {
      for (let i = 0; i < 10; i++) {
        detector.check('step-a');
      }
      const result = detector.check('step-a');
      expect(result.isLoop).toBe(true);
      expect(result.count).toBe(11);
      expect(result.shouldWarn).toBe(true);
      expect(result.shouldAbort).toBe(false);
    });

    it('should reset consecutive count when movement changes', () => {
      for (let i = 0; i < 8; i++) {
        detector.check('step-a');
      }
      detector.check('step-b');
      const result = detector.check('step-a');
      expect(result.isLoop).toBe(false);
      expect(result.count).toBe(1);
    });

    it('should track consecutive count correctly', () => {
      detector.check('step-a');
      expect(detector.getConsecutiveCount()).toBe(1);
      detector.check('step-a');
      expect(detector.getConsecutiveCount()).toBe(2);
      detector.check('step-b');
      expect(detector.getConsecutiveCount()).toBe(1);
    });
  });

  describe('with abort action', () => {
    it('should set shouldAbort when action is abort', () => {
      const detector = new LoopDetector({ maxConsecutiveSameStep: 3, action: 'abort' });

      for (let i = 0; i < 3; i++) {
        detector.check('step-a');
      }
      const result = detector.check('step-a');
      expect(result.isLoop).toBe(true);
      expect(result.shouldAbort).toBe(true);
      expect(result.shouldWarn).toBe(true);
    });
  });

  describe('with ignore action', () => {
    it('should not warn or abort when action is ignore', () => {
      const detector = new LoopDetector({ maxConsecutiveSameStep: 3, action: 'ignore' });

      for (let i = 0; i < 3; i++) {
        detector.check('step-a');
      }
      const result = detector.check('step-a');
      expect(result.isLoop).toBe(true);
      expect(result.shouldAbort).toBe(false);
      expect(result.shouldWarn).toBe(false);
    });
  });

  describe('with custom threshold', () => {
    it('should detect loop at custom threshold + 1', () => {
      const detector = new LoopDetector({ maxConsecutiveSameStep: 2 });

      detector.check('step-a');
      detector.check('step-a');
      const result = detector.check('step-a');
      expect(result.isLoop).toBe(true);
      expect(result.count).toBe(3);
    });
  });

  describe('reset', () => {
    it('should clear all state', () => {
      const detector = new LoopDetector({ maxConsecutiveSameStep: 2 });

      detector.check('step-a');
      detector.check('step-a');
      detector.reset();

      expect(detector.getConsecutiveCount()).toBe(0);

      const result = detector.check('step-a');
      expect(result.isLoop).toBe(false);
      expect(result.count).toBe(1);
    });
  });
});
