/**
 * Unit tests for instruction-context
 *
 * Tests buildEditRule function for localized edit permission messages.
 */

import { describe, it, expect } from 'vitest';
import { buildEditRule } from '../core/piece/instruction/instruction-context.js';

describe('buildEditRule', () => {
  describe('edit = true', () => {
    it('should return English editing-enabled message', () => {
      const result = buildEditRule(true, 'en');
      expect(result).toContain('Editing is ENABLED');
      expect(result).toContain('create, modify, and delete files');
    });

    it('should return Japanese editing-enabled message', () => {
      const result = buildEditRule(true, 'ja');
      expect(result).toContain('編集が許可されています');
      expect(result).toContain('ファイルの作成・変更・削除');
    });
  });

  describe('edit = false', () => {
    it('should return English editing-disabled message', () => {
      const result = buildEditRule(false, 'en');
      expect(result).toContain('Editing is DISABLED');
      expect(result).toContain('Do NOT create, modify, or delete');
    });

    it('should return Japanese editing-disabled message', () => {
      const result = buildEditRule(false, 'ja');
      expect(result).toContain('編集が禁止されています');
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
