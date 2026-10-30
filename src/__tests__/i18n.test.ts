/**
 * Tests for UI label loader utility (src/shared/i18n/index.ts)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { getLabel, getLabelObject, _resetLabelCache } from '../shared/i18n/index.js';

beforeEach(() => {
  _resetLabelCache();
});

describe('getLabel', () => {
  it.each(['ja', 'en'] as const)('includes the operation ID in a localized director interruption notice for %s', (lang) => {
    const operationId = '11111111-1111-4111-8111-111111111111';
    const notice = getLabel('manager.conversation.director_interrupted', lang, { operationId });
    expect(notice).toContain(operationId);
    expect(notice).not.toContain('{operationId}');
    expect(notice.length).toBeGreaterThan(operationId.length);
  });

  it.each(['en', 'ja'] as const)('resolves distinct waiting, extended-thinking and responding labels for %s', (lang) => {
    const labels = ['thinking', 'extendedThinking', 'responding'].map((activity) => getLabel(`tui.ui.${activity}`, lang));
    for (const label of labels) {
      expect(label.trim().length).toBeGreaterThan(0);
      expect(label).not.toMatch(/tui\.ui\.|undefined/);
    }
    expect(new Set(labels).size).toBe(3);
  });

  it('uses a distinct Japanese label for extended thinking', () => {
    expect(getLabel('tui.ui.extendedThinking', 'ja')).toBe('推論中...');
  });

  it('returns a label by key (defaults to en)', () => {
    const result = getLabel('interactive.ui.intro');
    expect(result).toBeTypeOf('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns an English label when lang is "en"', () => {
    const result = getLabel('interactive.ui.intro', 'en');
    expect(result).toBeTypeOf('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it.each(['en', 'ja'] as const)('returns the localized /verify command label for %s', (lang) => {
    const result = getLabel('interactive.commands.verify', lang);
    expect(result).toBeTypeOf('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it.each(['en', 'ja'] as const)('returns the localized mode-disabled /verify message for %s', (lang) => {
    const result = getLabel('interactive.ui.verifyUnavailable', lang);
    expect(result).toBeTypeOf('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('throws for a non-existent key', () => {
    const missingKey = 'nonexistent.key';
    expect(() => getLabel(missingKey)).toThrow(missingKey);
  });

  it('throws for a non-existent key with language', () => {
    const missingKey = 'nonexistent.key';
    const language = 'en';
    expect(() => getLabel(missingKey, language)).toThrow(missingKey);
    expect(() => getLabel(missingKey, language)).toThrow(language);
  });

  describe('template variable substitution', () => {
    it('replaces {variableName} placeholders with provided values', () => {
      const result = getLabel('workflow.iterationLimit.maxReached', undefined, {
        currentIteration: '5',
        maxSteps: '10',
      });
      expect(result).toContain('5');
      expect(result).toContain('10');
    });

    it('replaces single variable', () => {
      const result = getLabel('workflow.notifyComplete', undefined, {
        iteration: '3',
      });
      expect(result).toContain('3');
    });
  });
});

describe('getLabelObject', () => {
  it('returns interactive UI text object', () => {
    const result = getLabelObject<{ intro: string }>('interactive.ui', 'en');
    expect(result).toHaveProperty('intro');
  });

  it('returns Japanese interactive UI text object', () => {
    const result = getLabelObject<{ intro: string }>('interactive.ui', 'ja');
    expect(result).toHaveProperty('intro');
  });

  it('throws for a non-existent key', () => {
    const missingKey = 'nonexistent.key';
    expect(() => getLabelObject(missingKey)).toThrow(missingKey);
  });
});
