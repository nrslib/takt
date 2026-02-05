/**
 * Test for JudgmentDetector
 */

import { describe, it, expect } from 'vitest';
import { JudgmentDetector } from '../core/piece/judgment/JudgmentDetector.js';

describe('JudgmentDetector', () => {
  describe('detect', () => {
    it('should detect tag in simple response', () => {
      const result = JudgmentDetector.detect('[ARCH-REVIEW:1]');
      expect(result.success).toBe(true);
      expect(result.tag).toBe('[ARCH-REVIEW:1]');
    });

    it('should detect tag with surrounding text', () => {
      const result = JudgmentDetector.detect('Based on the review, I choose [MOVEMENT:2] because...');
      expect(result.success).toBe(true);
      expect(result.tag).toBe('[MOVEMENT:2]');
    });

    it('should detect tag with hyphenated movement name', () => {
      const result = JudgmentDetector.detect('[AI-ANTIPATTERN-REVIEW:1]');
      expect(result.success).toBe(true);
      expect(result.tag).toBe('[AI-ANTIPATTERN-REVIEW:1]');
    });

    it('should detect tag with underscored movement name', () => {
      const result = JudgmentDetector.detect('[AI_REVIEW:1]');
      expect(result.success).toBe(true);
      expect(result.tag).toBe('[AI_REVIEW:1]');
    });

    it('should detect "判断できない" (Japanese)', () => {
      const result = JudgmentDetector.detect('判断できない：情報が不足しています');
      expect(result.success).toBe(false);
      expect(result.reason).toBe('Conductor explicitly stated it cannot judge');
    });

    it('should detect "Cannot determine" (English)', () => {
      const result = JudgmentDetector.detect('Cannot determine: Insufficient information');
      expect(result.success).toBe(false);
      expect(result.reason).toBe('Conductor explicitly stated it cannot judge');
    });

    it('should detect "unable to judge"', () => {
      const result = JudgmentDetector.detect('I am unable to judge based on the provided information.');
      expect(result.success).toBe(false);
      expect(result.reason).toBe('Conductor explicitly stated it cannot judge');
    });

    it('should fail when no tag and no explicit "cannot judge"', () => {
      const result = JudgmentDetector.detect('This is a response without a tag or explicit statement.');
      expect(result.success).toBe(false);
      expect(result.reason).toBe('No tag found and no explicit "cannot judge" statement');
    });

    it('should fail on empty response', () => {
      const result = JudgmentDetector.detect('');
      expect(result.success).toBe(false);
      expect(result.reason).toBe('No tag found and no explicit "cannot judge" statement');
    });

    it('should detect first tag when multiple tags exist', () => {
      const result = JudgmentDetector.detect('[MOVEMENT:1] or [MOVEMENT:2]');
      expect(result.success).toBe(true);
      expect(result.tag).toBe('[MOVEMENT:1]');
    });
  });
});
