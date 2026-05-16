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

  it('returns quiet and passthrough intro labels without slash command guidance', () => {
    const quietIntro = getLabel('interactive.ui.introQuiet', 'ja');
    const passthroughIntro = getLabel('interactive.ui.introPassthrough', 'ja');

    expect(quietIntro).toBe('クワイエットモード - タスク内容を入力してください。追加質問なしで指示書を生成します。');
    expect(passthroughIntro).toBe('パススルーモード - タスク内容を入力してください。入力内容をそのまま実行します。');
    expect(quietIntro).not.toContain('/cancel');
    expect(passthroughIntro).not.toContain('/cancel');
  });

  it('returns English quiet and passthrough intro labels without slash command guidance', () => {
    const quietIntro = getLabel('interactive.ui.introQuiet', 'en');
    const passthroughIntro = getLabel('interactive.ui.introPassthrough', 'en');

    expect(quietIntro).toBe('Quiet mode - describe your task. Instructions will be generated without further questions.');
    expect(passthroughIntro).toBe('Passthrough mode - describe your task. Your input will be passed directly as the task.');
    expect(quietIntro).not.toContain('/cancel');
    expect(passthroughIntro).not.toContain('/cancel');
  });

  it('throws for a non-existent key', () => {
    expect(() => getLabel('nonexistent.key')).toThrow('Label key not found: nonexistent.key');
  });

  it('throws for a non-existent key with language', () => {
    expect(() => getLabel('nonexistent.key', 'en')).toThrow('Label key not found: nonexistent.key (lang: en)');
  });

  describe('template variable substitution', () => {
    it('replaces {variableName} placeholders with provided values', () => {
      const result = getLabel('workflow.iterationLimit.maxReached', undefined, {
        currentIteration: '5',
        maxSteps: '10',
      });
      expect(result).toContain('(5/10)');
    });

    it('replaces single variable', () => {
      const result = getLabel('workflow.notifyComplete', undefined, {
        iteration: '3',
      });
      expect(result).toContain('3 iterations');
    });

    it('leaves unmatched placeholders as-is', () => {
      const result = getLabel('workflow.notifyAbort', undefined, {});
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
    expect(ui).toHaveProperty('introQuiet');
    expect(ui).toHaveProperty('introPassthrough');
    expect(ui).toHaveProperty('resume');
    expect(ui).toHaveProperty('noConversation');
    expect(ui).toHaveProperty('summarizeFailed');
    expect(ui).toHaveProperty('continuePrompt');
    expect(ui).toHaveProperty('proposed');
    expect(ui).toHaveProperty('actionPrompt');
    expect(ui).toHaveProperty('actions');
    expect(ui).toHaveProperty('cancelled');
    expect(ui).toHaveProperty('acceptNoAssistant');
  });

  it('contains all expected workflow keys in en', () => {
    expect(() => getLabel('workflow.iterationLimit.maxReached')).not.toThrow();
    expect(() => getLabel('workflow.iterationLimit.currentStep')).not.toThrow();
    expect(() => getLabel('workflow.iterationLimit.continueQuestion')).not.toThrow();
    expect(() => getLabel('workflow.iterationLimit.continueLabel')).not.toThrow();
    expect(() => getLabel('workflow.iterationLimit.continueDescription')).not.toThrow();
    expect(() => getLabel('workflow.iterationLimit.stopLabel')).not.toThrow();
    expect(() => getLabel('workflow.iterationLimit.inputPrompt')).not.toThrow();
    expect(() => getLabel('workflow.iterationLimit.invalidInput')).not.toThrow();
    expect(() => getLabel('workflow.iterationLimit.userInputPrompt')).not.toThrow();
    expect(() => getLabel('workflow.notifyComplete')).not.toThrow();
    expect(() => getLabel('workflow.notifyAbort')).not.toThrow();
    expect(() => getLabel('workflow.sigintGraceful')).not.toThrow();
    expect(() => getLabel('workflow.sigintTimeout')).not.toThrow();
    expect(() => getLabel('workflow.sigintForce')).not.toThrow();
  });

  it('en and ja have the same key structure', () => {
    const stringKeys = [
      'interactive.ui.intro',
      'interactive.ui.introQuiet',
      'interactive.ui.introPassthrough',
      'interactive.ui.cancelled',
      'interactive.ui.acceptNoAssistant',
      'interactive.commands.accept',
      'workflow.iterationLimit.maxReached',
      'workflow.notifyComplete',
      'workflow.sigintGraceful',
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

  it('keeps slash command guidance in the shared assistant and persona intro label', () => {
    const intro = getLabel('interactive.ui.intro', 'en');

    expect(intro).toContain('/go');
    expect(intro).toContain('/play');
    expect(intro).toContain('/accept');
    expect(intro).toContain('/resume');
    expect(intro).toContain('/cancel');
  });

  it('keeps only confirm-based retry workflow reuse labels', () => {
    expect(() => getLabel('retry.usePreviousWorkflowConfirm', 'en', { workflow: 'default' })).not.toThrow();
    expect(() => getLabel('retry.usePreviousWorkflowConfirm', 'ja', { workflow: 'default' })).not.toThrow();
    expect(() => getLabel('retry.workflowPrompt', 'en')).toThrow('Label key not found');
    expect(() => getLabel('retry.changeWorkflow', 'en')).toThrow('Label key not found');
    expect(() => getLabel('retry.workflowPrompt', 'ja')).toThrow('Label key not found');
    expect(() => getLabel('retry.changeWorkflow', 'ja')).toThrow('Label key not found');
  });

  it('uses workflow/step terminology in migrated labels', () => {
    expect(getLabel('interactive.previousTask.workflow', 'en', { workflowName: 'default' })).toBe('Workflow: default');
    expect(getLabel('interactive.previousTask.workflow', 'ja', { workflowName: 'default' })).toBe('使用ワークフロー: default');
    expect(getLabel('workflow.iterationLimit.currentStep', 'en', { currentStep: 'implement' })).toBe('Current step: implement');
    expect(getLabel('workflow.iterationLimit.currentStep', 'ja', { currentStep: 'implement' })).toBe('現在のステップ: implement');
    expect(getLabel('workflow.notifyComplete', 'en', { iteration: '3' })).toBe('Workflow complete (3 iterations)');
    expect(getLabel('workflow.notifyComplete', 'ja', { iteration: '3' })).toBe('ワークフロー完了 (3 iterations)');
    expect(getLabel('retry.usePreviousWorkflowConfirm', 'en', { workflow: 'default' })).toBe('Use previous workflow "default"?');
    expect(getLabel('retry.usePreviousWorkflowConfirm', 'ja', { workflow: 'default' })).toBe('前回のワークフロー "default" を使用しますか？');
  });
});
