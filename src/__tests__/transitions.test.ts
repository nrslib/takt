/**
 * Tests for piece transitions module (movement-based)
 */

import { describe, it, expect } from 'vitest';
import { determineNextMovementByRules } from '../core/piece/index.js';
import { extractBlockedPrompt } from '../core/piece/engine/transitions.js';
import type { PieceMovement } from '../core/models/index.js';

function createMovementWithRules(rules: { condition: string; next: string }[]): PieceMovement {
  return {
    name: 'test-step',
    persona: 'test-agent',
    personaDisplayName: 'Test Agent',
    instructionTemplate: '{task}',
    passPreviousResponse: false,
    rules: rules.map((r) => ({
      condition: r.condition,
      next: r.next,
    })),
  };
}

describe('determineNextMovementByRules', () => {
  it('should return next movement for valid rule index', () => {
    const step = createMovementWithRules([
      { condition: 'Clear', next: 'implement' },
      { condition: 'Blocked', next: 'ABORT' },
    ]);

    expect(determineNextMovementByRules(step, 0)).toBe('implement');
    expect(determineNextMovementByRules(step, 1)).toBe('ABORT');
  });

  it('should return null for out-of-bounds index', () => {
    const step = createMovementWithRules([
      { condition: 'Clear', next: 'implement' },
    ]);

    expect(determineNextMovementByRules(step, 1)).toBeNull();
    expect(determineNextMovementByRules(step, -1)).toBeNull();
    expect(determineNextMovementByRules(step, 100)).toBeNull();
  });

  it('should return null when movement has no rules', () => {
    const step: PieceMovement = {
      name: 'test-step',
      persona: 'test-agent',
      personaDisplayName: 'Test Agent',
      instructionTemplate: '{task}',
      passPreviousResponse: false,
    };

    expect(determineNextMovementByRules(step, 0)).toBeNull();
  });

  it('should handle COMPLETE as next movement', () => {
    const step = createMovementWithRules([
      { condition: 'All passed', next: 'COMPLETE' },
    ]);

    expect(determineNextMovementByRules(step, 0)).toBe('COMPLETE');
  });

  it('should return null when rule exists but next is undefined', () => {
    // Parallel sub-movement rules may omit `next` (optional field)
    const step: PieceMovement = {
      name: 'sub-step',
      persona: 'test-agent',
      personaDisplayName: 'Test Agent',
      instructionTemplate: '{task}',
      passPreviousResponse: false,
      rules: [
        { condition: 'approved' },
        { condition: 'needs_fix' },
      ],
    };

    expect(determineNextMovementByRules(step, 0)).toBeNull();
    expect(determineNextMovementByRules(step, 1)).toBeNull();
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
