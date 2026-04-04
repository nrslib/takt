/**
 * Unit tests for instruction-context
 *
 * Tests buildEditRule and buildGitCommitRule functions for localized messages.
 */

import { describe, it, expect } from 'vitest';
import { buildEditRule, buildGitCommitRule } from '../core/piece/instruction/instruction-context.js';

describe('buildEditRule', () => {
  describe('edit = true', () => {
    it('should return English editing-enabled message for the current step', () => {
      const result = buildEditRule(true, 'en');
      expect(result).toContain('Editing is ENABLED');
      expect(result).toContain('for this step');
      expect(result).toContain('create, modify, and delete files');
    });

    it('should return Japanese editing-enabled message for the current step', () => {
      const result = buildEditRule(true, 'ja');
      expect(result).toContain('このステップでは編集が許可されています');
      expect(result).toContain('ファイルの作成・変更・削除');
    });
  });

  describe('edit = false', () => {
    it('should return English editing-disabled message for the current step', () => {
      const result = buildEditRule(false, 'en');
      expect(result).toContain('Editing is DISABLED');
      expect(result).toContain('for this step');
      expect(result).toContain('Do NOT create, modify, or delete');
    });

    it('should return Japanese editing-disabled message for the current step', () => {
      const result = buildEditRule(false, 'ja');
      expect(result).toContain('このステップでは編集が禁止されています');
      expect(result).toContain('作成・変更・削除しないで');
    });
  });

  describe('edit = undefined', () => {
    it('should return empty string for English', () => {
      expect(buildEditRule(undefined, 'en')).toBe('');
    });

    it('should return empty string for Japanese', () => {
      expect(buildEditRule(undefined, 'ja')).toBe('');
    });
  });
});

describe('buildGitCommitRule', () => {
  describe('allowGitCommit = false, phase1', () => {
    it('should return English git commit + git add prohibition', () => {
      const result = buildGitCommitRule(false, 'en', 'phase1');
      expect(result).toContain('Do NOT run git commit');
      expect(result).toContain('Do NOT run git add');
    });

    it('should return Japanese git commit + git add prohibition', () => {
      const result = buildGitCommitRule(false, 'ja', 'phase1');
      expect(result).toContain('git commit を実行しないでください');
      expect(result).toContain('git add を実行しないでください');
    });
  });

  describe('allowGitCommit = true, phase1', () => {
    it('should return empty string for English', () => {
      expect(buildGitCommitRule(true, 'en', 'phase1')).toBe('');
    });

    it('should return empty string for Japanese', () => {
      expect(buildGitCommitRule(true, 'ja', 'phase1')).toBe('');
    });
  });

  describe('allowGitCommit = false, phase2', () => {
    it('should return English git commit prohibition only (no git add)', () => {
      const result = buildGitCommitRule(false, 'en', 'phase2');
      expect(result).toContain('Do NOT run git commit');
      expect(result).not.toContain('git add');
    });

    it('should return Japanese git commit prohibition only (no git add)', () => {
      const result = buildGitCommitRule(false, 'ja', 'phase2');
      expect(result).toContain('git commit を実行しないでください');
      expect(result).not.toContain('git add');
    });
  });

  describe('allowGitCommit = true, phase2', () => {
    it('should return empty string for English', () => {
      expect(buildGitCommitRule(true, 'en', 'phase2')).toBe('');
    });

    it('should return empty string for Japanese', () => {
      expect(buildGitCommitRule(true, 'ja', 'phase2')).toBe('');
    });
  });

  describe('phase defaults to phase1', () => {
    it('should include git add prohibition when phase is omitted', () => {
      const result = buildGitCommitRule(false, 'en');
      expect(result).toContain('Do NOT run git commit');
      expect(result).toContain('Do NOT run git add');
    });
  });
});
