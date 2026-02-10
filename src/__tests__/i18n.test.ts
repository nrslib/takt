/**
 * Tests for UI label loader utility (src/shared/i18n/index.ts)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { getLabel, getLabelObject, _resetLabelCache } from '../shared/i18n/index.js';

beforeEach(() => {
  _resetLabelCache();
});

describe('getLabel', () => {
  it('returns a label by key (defaults to en)', () => {
    const result = getLabel('interactive.ui.intro');
    expect(result).toContain('Interactive mode');
  });

  it('returns an English label when lang is "en"', () => {
    const result = getLabel('interactive.ui.intro', 'en');
    expect(result).toContain('Interactive mode');
  });

  it('returns a Japanese label when lang is "ja"', () => {
    const result = getLabel('interactive.ui.intro', 'ja');
    expect(result).toContain('対話モード');
  });

  it('throws for a non-existent key', () => {
    expect(() => getLabel('nonexistent.key')).toThrow('Label key not found: nonexistent.key');
  });

  it('throws for a non-existent key with language', () => {
    expect(() => getLabel('nonexistent.key', 'en')).toThrow('Label key not found: nonexistent.key (lang: en)');
  });

  describe('template variable substitution', () => {
    it('replaces {variableName} placeholders with provided values', () => {
      const result = getLabel('piece.iterationLimit.maxReached', undefined, {
        currentIteration: '5',
        maxMovements: '10',
      });
      expect(result).toContain('(5/10)');
    });

    it('replaces single variable', () => {
      const result = getLabel('piece.notifyComplete', undefined, {
        iteration: '3',
      });
      expect(result).toContain('3 iterations');
    });

    it('leaves unmatched placeholders as-is', () => {
      const result = getLabel('piece.notifyAbort', undefined, {});
      expect(result).toContain('{reason}');
    });
  });
});

describe('getLabelObject', () => {
  it('returns interactive UI text object', () => {
    const result = getLabelObject<{ intro: string }>('interactive.ui', 'en');
    expect(result.intro).toContain('Interactive mode');
  });

  it('returns Japanese interactive UI text object', () => {
    const result = getLabelObject<{ intro: string }>('interactive.ui', 'ja');
    expect(result.intro).toContain('対話モード');
  });

  it('throws for a non-existent key', () => {
    expect(() => getLabelObject('nonexistent.key')).toThrow('Label key not found: nonexistent.key');
  });
});

describe('caching', () => {
  it('returns the same data on repeated calls', () => {
    const first = getLabel('interactive.ui.intro');
    const second = getLabel('interactive.ui.intro');
    expect(first).toBe(second);
  });

  it('reloads after cache reset', () => {
    const first = getLabel('interactive.ui.intro');
    _resetLabelCache();
    const second = getLabel('interactive.ui.intro');
    expect(first).toBe(second);
  });
});

describe('label integrity', () => {
  it('contains all expected interactive UI keys in en', () => {
    const ui = getLabelObject<Record<string, string>>('interactive.ui', 'en');
    expect(ui).toHaveProperty('intro');
    expect(ui).toHaveProperty('resume');
    expect(ui).toHaveProperty('noConversation');
    expect(ui).toHaveProperty('summarizeFailed');
    expect(ui).toHaveProperty('continuePrompt');
    expect(ui).toHaveProperty('proposed');
    expect(ui).toHaveProperty('actionPrompt');
    expect(ui).toHaveProperty('actions');
    expect(ui).toHaveProperty('cancelled');
  });

  it('contains all expected piece keys in en', () => {
    expect(() => getLabel('piece.iterationLimit.maxReached')).not.toThrow();
    expect(() => getLabel('piece.iterationLimit.currentMovement')).not.toThrow();
    expect(() => getLabel('piece.iterationLimit.continueQuestion')).not.toThrow();
    expect(() => getLabel('piece.iterationLimit.continueLabel')).not.toThrow();
    expect(() => getLabel('piece.iterationLimit.continueDescription')).not.toThrow();
    expect(() => getLabel('piece.iterationLimit.stopLabel')).not.toThrow();
    expect(() => getLabel('piece.iterationLimit.inputPrompt')).not.toThrow();
    expect(() => getLabel('piece.iterationLimit.invalidInput')).not.toThrow();
    expect(() => getLabel('piece.iterationLimit.userInputPrompt')).not.toThrow();
    expect(() => getLabel('piece.notifyComplete')).not.toThrow();
    expect(() => getLabel('piece.notifyAbort')).not.toThrow();
    expect(() => getLabel('piece.sigintGraceful')).not.toThrow();
    expect(() => getLabel('piece.sigintForce')).not.toThrow();
  });

  it('en and ja have the same key structure', () => {
    const stringKeys = [
      'interactive.ui.intro',
      'interactive.ui.cancelled',
      'piece.iterationLimit.maxReached',
      'piece.notifyComplete',
      'piece.sigintGraceful',
    ];
    for (const key of stringKeys) {
      expect(() => getLabel(key, 'en')).not.toThrow();
      expect(() => getLabel(key, 'ja')).not.toThrow();
    }

    const objectKeys = [
      'interactive.ui',
    ];
    for (const key of objectKeys) {
      expect(() => getLabelObject(key, 'en')).not.toThrow();
      expect(() => getLabelObject(key, 'ja')).not.toThrow();
    }
  });
});
