/**
 * Tests for slash and hash prefixed inputs in CLI.
 *
 * Verifies that:
 * - '/' prefixed inputs not matching known commands are treated as task instructions
 * - '#' prefixed inputs not matching issue number pattern are treated as task instructions
 * - isDirectTask() correctly identifies these patterns
 */

import { describe, it, expect } from 'vitest';
import type { Command } from 'commander';
import { isDirectTask, resolveAgentOverrides, resolveRemovedRootCommand, resolveSlashFallbackTask } from '../app/cli/helpers.js';

describe('isDirectTask', () => {
  describe('slash prefixed inputs', () => {
    it('returns false for slash prefixed single words (interactive mode)', () => {
      expect(isDirectTask('/リファクタリングしてくれ')).toBe(false);
    });

    it('returns false for slash prefixed multi-word inputs (interactive mode)', () => {
      expect(isDirectTask('/run tests and build')).toBe(false);
    });

    it('returns false for slash only (interactive mode)', () => {
      expect(isDirectTask('/')).toBe(false);
    });

    it('returns false for slash with trailing spaces (interactive mode)', () => {
      expect(isDirectTask('/  ')).toBe(false);
    });

    it('returns false for known command names with slash (interactive mode)', () => {
      // Note: isDirectTask() treats all '/' prefixed inputs as false (interactive mode).
      // Actual known command filtering happens in index.ts via program.commands.
      expect(isDirectTask('/run')).toBe(false);
      expect(isDirectTask('/watch')).toBe(false);
    });
  });

  describe('hash prefixed inputs', () => {
    it('returns false for hash prefixed non-numeric inputs WITH SPACES (interactive mode)', () => {
      // '#についてのドキュメントを書いて' → not valid issue ref → interactive mode
      expect(isDirectTask('#についての ドキュメントを書いて')).toBe(false);
    });

    it('returns false for hash prefixed non-numeric with spaces (interactive mode)', () => {
      // '#について のドキュメントを書いて' → not valid issue ref → interactive mode
      expect(isDirectTask('#について のドキュメントを書いて')).toBe(false);
    });

    it('returns false for hash with single word (should enter interactive)', () => {
      // '#' alone → not issue ref → interactive mode
      expect(isDirectTask('#')).toBe(false);
    });

    it('returns false for hash with non-numeric single word (should enter interactive)', () => {
      // '#についてのドキュメント' → not issue ref → interactive
      expect(isDirectTask('#についてのドキュメント')).toBe(false);
    });

    it('returns true for valid issue references', () => {
      expect(isDirectTask('#10')).toBe(true);
    });

    it('returns true for multiple issue references', () => {
      // '#10 #20' → valid issue refs → direct execution
      expect(isDirectTask('#10 #20')).toBe(true);
    });

    it('returns false for hash with number prefix followed by text (should enter interactive)', () => {
      // '#32あああ' → not issue ref → interactive mode
      expect(isDirectTask('#32あああ')).toBe(false);
    });
  });

  describe('existing behavior (regression)', () => {
    it('returns false for inputs with spaces (interactive mode)', () => {
      expect(isDirectTask('refactor this code')).toBe(false);
    });

    it('returns false for single word without prefix', () => {
      expect(isDirectTask('refactor')).toBe(false);
    });

    it('returns false for short inputs without prefix', () => {
      expect(isDirectTask('短い')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('returns false for slash with special characters (interactive mode)', () => {
      expect(isDirectTask('/~!@#$%^&*()')).toBe(false);
    });

    it('returns false for hash with special characters (should enter interactive)', () => {
      // '#~!@#$%^&*()' → not issue ref → interactive mode
      expect(isDirectTask('#~!@#$%^&*()')).toBe(false);
    });

    it('handles mixed whitespace', () => {
      expect(isDirectTask('  /task  ')).toBe(false);
      // '  #task  ' → not issue ref → interactive mode
      expect(isDirectTask('  #task  ')).toBe(false);
    });
  });
});

describe('resolveSlashFallbackTask', () => {
  it('returns raw argv as task for unknown slash command', () => {
    const task = resolveSlashFallbackTask(['/foo', '--bar'], ['run', 'add', 'watch']);
    expect(task).toBe('/foo --bar');
  });

  it('returns null for known slash command', () => {
    const task = resolveSlashFallbackTask(['/run', '--help'], ['run', 'add', 'watch']);
    expect(task).toBeNull();
  });

  it('returns null when first argument is not slash-prefixed', () => {
    const task = resolveSlashFallbackTask(['run', '/foo'], ['run', 'add', 'watch']);
    expect(task).toBeNull();
  });
});

describe('resolveRemovedRootCommand', () => {
  it('returns removed command when first argument is switch', () => {
    expect(resolveRemovedRootCommand(['switch'])).toBe('switch');
  });

  it('returns null when first argument is a valid command', () => {
    expect(resolveRemovedRootCommand(['run'])).toBeNull();
  });

  it('returns null when argument only contains removed command in later position', () => {
    expect(resolveRemovedRootCommand(['--help', 'switch'])).toBeNull();
  });
});

describe('resolveAgentOverrides', () => {
  it('returns undefined when provider and model are both missing', () => {
    const program = {
      opts: () => ({}),
    } as unknown as Command;

    expect(resolveAgentOverrides(program)).toBeUndefined();
  });

  it('returns provider/model pair when one or both are provided', () => {
    const program = {
      opts: () => ({ provider: 'codex', model: 'gpt-5' }),
    } as unknown as Command;

    expect(resolveAgentOverrides(program)).toEqual({
      provider: 'codex',
      model: 'gpt-5',
    });
  });
});
