/**
 * Tests for prompt loader utility (src/shared/prompts/index.ts)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { getPrompt, getPromptObject, _resetCache } from '../shared/prompts/index.js';

beforeEach(() => {
  _resetCache();
});

describe('getPrompt', () => {
  it('returns a language-independent prompt by key (defaults to en)', () => {
    const result = getPrompt('summarize.slugGenerator');
    expect(result).toContain('You are a slug generator');
  });

  it('returns an English prompt when lang is "en"', () => {
    const result = getPrompt('interactive.systemPrompt', 'en');
    expect(result).toContain('You are a task planning assistant');
  });

  it('returns a Japanese prompt when lang is "ja"', () => {
    const result = getPrompt('interactive.systemPrompt', 'ja');
    expect(result).toContain('あなたはTAKT');
  });

  it('throws for a non-existent key', () => {
    expect(() => getPrompt('nonexistent.key')).toThrow('Prompt key not found: nonexistent.key');
  });

  it('throws for a non-existent key with language', () => {
    expect(() => getPrompt('nonexistent.key', 'en')).toThrow('Prompt key not found: nonexistent.key (lang: en)');
  });

  it('returns prompt from en file when lang is explicitly "en"', () => {
    const result = getPrompt('summarize.slugGenerator', 'en');
    expect(result).toContain('You are a slug generator');
  });

  describe('template variable substitution', () => {
    it('replaces {variableName} placeholders with provided values', () => {
      const result = getPrompt('claude.agentDefault', undefined, { agentName: 'test-agent' });
      expect(result).toContain('You are the test-agent agent');
      expect(result).toContain('Follow the standard test-agent workflow');
    });

    it('leaves unmatched placeholders as-is', () => {
      const result = getPrompt('claude.agentDefault', undefined, {});
      expect(result).toContain('{agentName}');
    });

    it('replaces multiple different variables', () => {
      const result = getPrompt('workflow.iterationLimit.maxReached', undefined, {
        currentIteration: '5',
        maxIterations: '10',
      });
      expect(result).toContain('(5/10)');
    });
  });
});

describe('getPromptObject', () => {
  it('returns an object for a given key and language', () => {
    const result = getPromptObject<{ heading: string }>('instruction.metadata', 'en');
    expect(result.heading).toBe('## Execution Context');
  });

  it('returns a Japanese object when lang is "ja"', () => {
    const result = getPromptObject<{ heading: string }>('instruction.metadata', 'ja');
    expect(result.heading).toBe('## 実行コンテキスト');
  });

  it('returns interactive UI text object', () => {
    const result = getPromptObject<{ intro: string }>('interactive.ui', 'en');
    expect(result.intro).toContain('Interactive mode');
  });

  it('throws for a non-existent key', () => {
    expect(() => getPromptObject('nonexistent.key')).toThrow('Prompt key not found: nonexistent.key');
  });
});

describe('caching', () => {
  it('returns the same data on repeated calls', () => {
    const first = getPrompt('summarize.slugGenerator');
    const second = getPrompt('summarize.slugGenerator');
    expect(first).toBe(second);
  });

  it('reloads after cache reset', () => {
    const first = getPrompt('summarize.slugGenerator');
    _resetCache();
    const second = getPrompt('summarize.slugGenerator');
    expect(first).toBe(second);
  });
});

describe('YAML content integrity', () => {
  it('contains all expected top-level keys in en', () => {
    expect(() => getPrompt('interactive.systemPrompt', 'en')).not.toThrow();
    expect(() => getPrompt('interactive.summaryPrompt', 'en')).not.toThrow();
    expect(() => getPrompt('interactive.workflowInfo', 'en')).not.toThrow();
    expect(() => getPrompt('interactive.conversationLabel', 'en')).not.toThrow();
    expect(() => getPrompt('interactive.noTranscript', 'en')).not.toThrow();
    expect(() => getPromptObject('interactive.ui', 'en')).not.toThrow();
    expect(() => getPrompt('summarize.slugGenerator')).not.toThrow();
    expect(() => getPrompt('summarize.conversationSummarizer')).not.toThrow();
    expect(() => getPrompt('claude.agentDefault')).not.toThrow();
    expect(() => getPrompt('claude.judgePrompt')).not.toThrow();
    expect(() => getPromptObject('instruction.metadata', 'en')).not.toThrow();
    expect(() => getPromptObject('instruction.sections', 'en')).not.toThrow();
    expect(() => getPromptObject('instruction.reportOutput', 'en')).not.toThrow();
    expect(() => getPromptObject('instruction.reportPhase', 'en')).not.toThrow();
    expect(() => getPromptObject('instruction.reportSections', 'en')).not.toThrow();
    expect(() => getPrompt('instruction.statusJudgment.header', 'en')).not.toThrow();
    expect(() => getPromptObject('instruction.statusRules', 'en')).not.toThrow();
    expect(() => getPrompt('workflow.iterationLimit.maxReached')).not.toThrow();
  });

  it('contains all expected top-level keys in ja', () => {
    expect(() => getPrompt('interactive.systemPrompt', 'ja')).not.toThrow();
    expect(() => getPrompt('interactive.summaryPrompt', 'ja')).not.toThrow();
    expect(() => getPrompt('interactive.workflowInfo', 'ja')).not.toThrow();
    expect(() => getPrompt('interactive.conversationLabel', 'ja')).not.toThrow();
    expect(() => getPrompt('interactive.noTranscript', 'ja')).not.toThrow();
    expect(() => getPromptObject('interactive.ui', 'ja')).not.toThrow();
    expect(() => getPrompt('summarize.slugGenerator', 'ja')).not.toThrow();
    expect(() => getPrompt('summarize.conversationSummarizer', 'ja')).not.toThrow();
    expect(() => getPrompt('claude.agentDefault', 'ja')).not.toThrow();
    expect(() => getPrompt('claude.judgePrompt', 'ja')).not.toThrow();
    expect(() => getPromptObject('instruction.metadata', 'ja')).not.toThrow();
    expect(() => getPromptObject('instruction.sections', 'ja')).not.toThrow();
    expect(() => getPromptObject('instruction.reportOutput', 'ja')).not.toThrow();
    expect(() => getPromptObject('instruction.reportPhase', 'ja')).not.toThrow();
    expect(() => getPromptObject('instruction.reportSections', 'ja')).not.toThrow();
    expect(() => getPrompt('instruction.statusJudgment.header', 'ja')).not.toThrow();
    expect(() => getPromptObject('instruction.statusRules', 'ja')).not.toThrow();
    expect(() => getPrompt('workflow.iterationLimit.maxReached', 'ja')).not.toThrow();
  });

  it('instruction.metadata has all required fields', () => {
    const en = getPromptObject<Record<string, string>>('instruction.metadata', 'en');
    expect(en).toHaveProperty('heading');
    expect(en).toHaveProperty('workingDirectory');
    expect(en).toHaveProperty('rulesHeading');
    expect(en).toHaveProperty('noCommit');
    expect(en).toHaveProperty('noCd');
    expect(en).toHaveProperty('editEnabled');
    expect(en).toHaveProperty('editDisabled');
    expect(en).toHaveProperty('note');
  });

  it('instruction.sections has all required fields', () => {
    const en = getPromptObject<Record<string, string>>('instruction.sections', 'en');
    expect(en).toHaveProperty('workflowContext');
    expect(en).toHaveProperty('iteration');
    expect(en).toHaveProperty('step');
    expect(en).toHaveProperty('userRequest');
    expect(en).toHaveProperty('instructions');
  });

  it('instruction.statusRules has appendixInstruction with {tag} placeholder', () => {
    const en = getPromptObject<{ appendixInstruction: string }>('instruction.statusRules', 'en');
    expect(en.appendixInstruction).toContain('{tag}');
  });

  it('en and ja files have the same key structure', () => {
    // Verify a sampling of keys exist in both languages
    const stringKeys = [
      'interactive.systemPrompt',
      'summarize.slugGenerator',
      'claude.agentDefault',
      'workflow.iterationLimit.maxReached',
    ];
    for (const key of stringKeys) {
      expect(() => getPrompt(key, 'en')).not.toThrow();
      expect(() => getPrompt(key, 'ja')).not.toThrow();
    }
    const objectKeys = [
      'interactive.ui',
      'instruction.metadata',
      'instruction.sections',
    ];
    for (const key of objectKeys) {
      expect(() => getPromptObject(key, 'en')).not.toThrow();
      expect(() => getPromptObject(key, 'ja')).not.toThrow();
    }
  });
});
