/**
 * Tests for workflow transitions module (step-based)
 */

import { describe, it, expect } from 'vitest';
import { determineRuleTransition, extractBlockedPrompt } from '../core/workflow/engine/transitions.js';
import { determineNextStepByRules } from '../core/workflow/index.js';
import type { WorkflowStep } from '../core/models/index.js';

function createStepWithRules(
  rules: Array<{ condition: string; next?: string; returnValue?: string; requiresUserInput?: boolean }>,
): WorkflowStep {
  return {
    name: 'test-step',
    persona: 'test-agent',
    personaDisplayName: 'Test Agent',
    instruction: '{task}',
    passPreviousResponse: false,
    rules: rules.map((r) => ({
      condition: r.condition,
      ...(r.next !== undefined ? { next: r.next } : {}),
      ...(r.returnValue !== undefined ? { returnValue: r.returnValue } : {}),
      ...(r.requiresUserInput === true ? { requiresUserInput: true } : {}),
    })),
  };
}

describe('determineNextStepByRules', () => {
  it('should return next step for a valid rule index', () => {
    const step = createStepWithRules([
      { condition: 'Clear', next: 'implement' },
      { condition: 'Blocked', next: 'ABORT' },
    ]);

    expect(determineNextStepByRules(step, 0)).toBe('implement');
    expect(determineNextStepByRules(step, 1)).toBe('ABORT');
  });

  it('should return null for out-of-bounds index', () => {
    const step = createStepWithRules([
      { condition: 'Clear', next: 'implement' },
    ]);

    expect(determineNextStepByRules(step, 1)).toBeNull();
    expect(determineNextStepByRules(step, -1)).toBeNull();
    expect(determineNextStepByRules(step, 100)).toBeNull();
  });

  it('should return null when step has no rules', () => {
    const step: WorkflowStep = {
      name: 'test-step',
      persona: 'test-agent',
      personaDisplayName: 'Test Agent',
      instruction: '{task}',
      passPreviousResponse: false,
    };

    expect(determineNextStepByRules(step, 0)).toBeNull();
  });

  it('should handle COMPLETE as the next step', () => {
    const step = createStepWithRules([
      { condition: 'All passed', next: 'COMPLETE' },
    ]);

    expect(determineNextStepByRules(step, 0)).toBe('COMPLETE');
  });

  it('should return null when rule exists but next is undefined', () => {
    // Parallel sub-step rules may omit `next` (optional field)
    const step: WorkflowStep = {
      name: 'sub-step',
      persona: 'test-agent',
      personaDisplayName: 'Test Agent',
      instruction: '{task}',
      passPreviousResponse: false,
      rules: [
        { condition: 'approved' },
        { condition: 'needs_fix' },
      ],
    };

    expect(determineNextStepByRules(step, 0)).toBeNull();
    expect(determineNextStepByRules(step, 1)).toBeNull();
  });

  it('should return logical result for return rules', () => {
    const step: WorkflowStep = {
      name: 'return-step',
      persona: 'test-agent',
      personaDisplayName: 'Test Agent',
      instruction: '{task}',
      passPreviousResponse: false,
      rules: [
        { condition: 'retry', returnValue: 'retry_plan' },
      ],
    };

    expect(determineRuleTransition(step, 0)).toEqual({ returnValue: 'retry_plan' });
    expect(determineNextStepByRules(step, 0)).toBeNull();
  });

  it('should include user input requirement in resolved transition', () => {
    const step = createStepWithRules([
      { condition: 'ask_user', requiresUserInput: true },
    ]);

    expect(determineRuleTransition(step, 0)).toEqual({ requiresUserInput: true });
    expect(determineNextStepByRules(step, 0)).toBeNull();
  });
});

describe('extractBlockedPrompt', () => {
  it('should extract prompt after "必要な情報:" pattern', () => {
    const content = '処理がブロックされました。\n必要な情報: デプロイ先の環境を教えてください';
    expect(extractBlockedPrompt(content)).toBe('デプロイ先の環境を教えてください');
  });

  it('should extract prompt after "質問:" pattern', () => {
    const content = '質問: どのブランチにマージしますか？';
    expect(extractBlockedPrompt(content)).toBe('どのブランチにマージしますか？');
  });

  it('should extract prompt after "理由:" pattern', () => {
    const content = '理由: 権限が不足しています';
    expect(extractBlockedPrompt(content)).toBe('権限が不足しています');
  });

  it('should extract prompt after "確認:" pattern', () => {
    const content = '確認: この変更を続けてもよいですか？';
    expect(extractBlockedPrompt(content)).toBe('この変更を続けてもよいですか？');
  });

  it('should support full-width colon', () => {
    const content = '必要な情報：ファイルパスを指定してください';
    expect(extractBlockedPrompt(content)).toBe('ファイルパスを指定してください');
  });

  it('should return full content when no pattern matches', () => {
    const content = 'Something went wrong and I need help';
    expect(extractBlockedPrompt(content)).toBe('Something went wrong and I need help');
  });

  it('should return first matching pattern when multiple exist', () => {
    const content = '質問: 最初の質問\n確認: 二番目の質問';
    expect(extractBlockedPrompt(content)).toBe('最初の質問');
  });
});
