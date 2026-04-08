/**
 * Unit tests for rule-utils
 *
 * Tests tag-based rule detection, single-branch auto-selection,
 * and report file extraction from output contracts.
 */

import { describe, it, expect } from 'vitest';
import {
  hasTagBasedRules,
  hasOnlyOneBranch,
  getAutoSelectedTag,
  getReportFiles,
} from '../core/workflow/evaluation/rule-utils.js';
import type { OutputContractEntry } from '../core/models/types.js';
import { makeStep } from './test-helpers.js';

describe('hasTagBasedRules', () => {
  it('should return false when step has no rules', () => {
    const step = makeStep({ rules: undefined });
    expect(hasTagBasedRules(step)).toBe(false);
  });

  it('should return false when rules array is empty', () => {
    const step = makeStep({ rules: [] });
    expect(hasTagBasedRules(step)).toBe(false);
  });

  it('should return true when rules contain tag-based conditions', () => {
    const step = makeStep({
      rules: [
        { condition: 'approved' },
        { condition: 'rejected' },
      ],
    });
    expect(hasTagBasedRules(step)).toBe(true);
  });

  it('should return false when all rules are ai() conditions', () => {
    const step = makeStep({
      rules: [
        { condition: 'approved', isAiCondition: true, aiConditionText: 'is it approved?' },
        { condition: 'rejected', isAiCondition: true, aiConditionText: 'is it rejected?' },
      ],
    });
    expect(hasTagBasedRules(step)).toBe(false);
  });

  it('should return false when all rules are aggregate conditions', () => {
    const step = makeStep({
      rules: [
        { condition: 'all approved', isAggregateCondition: true, aggregateType: 'all', aggregateConditionText: 'approved' },
      ],
    });
    expect(hasTagBasedRules(step)).toBe(false);
  });

  it('should return true when mixed rules include tag-based ones', () => {
    const step = makeStep({
      rules: [
        { condition: 'approved', isAiCondition: true, aiConditionText: 'approved?' },
        { condition: 'manual check' },
      ],
    });
    expect(hasTagBasedRules(step)).toBe(true);
  });
});

describe('hasOnlyOneBranch', () => {
  it('should return false when rules is undefined', () => {
    const step = makeStep({ rules: undefined });
    expect(hasOnlyOneBranch(step)).toBe(false);
  });

  it('should return false when rules array is empty', () => {
    const step = makeStep({ rules: [] });
    expect(hasOnlyOneBranch(step)).toBe(false);
  });

  it('should return true when exactly one rule exists', () => {
    const step = makeStep({
      rules: [{ condition: 'done', next: 'COMPLETE' }],
    });
    expect(hasOnlyOneBranch(step)).toBe(true);
  });

  it('should return false when multiple rules exist', () => {
    const step = makeStep({
      rules: [
        { condition: 'approved', next: 'implement' },
        { condition: 'rejected', next: 'review' },
      ],
    });
    expect(hasOnlyOneBranch(step)).toBe(false);
  });
});

describe('getAutoSelectedTag', () => {
  it('should return uppercase tag for single-branch step', () => {
    const step = makeStep({
      name: 'ai-review',
      rules: [{ condition: 'done', next: 'COMPLETE' }],
    });
    expect(getAutoSelectedTag(step)).toBe('[AI-REVIEW:1]');
  });

  it('should throw when multiple branches exist', () => {
    const step = makeStep({
      rules: [
        { condition: 'approved', next: 'implement' },
        { condition: 'rejected', next: 'review' },
      ],
    });
    expect(() => getAutoSelectedTag(step)).toThrow('Cannot auto-select tag when multiple branches exist');
  });

  it('should throw when no rules exist', () => {
    const step = makeStep({ rules: undefined });
    expect(() => getAutoSelectedTag(step)).toThrow('Cannot auto-select tag when multiple branches exist');
  });
});

describe('getReportFiles', () => {
  it('should return empty array when outputContracts is undefined', () => {
    expect(getReportFiles(undefined)).toEqual([]);
  });

  it('should return empty array when outputContracts is empty', () => {
    expect(getReportFiles([])).toEqual([]);
  });

  it('should extract name from OutputContractItem entries', () => {
    const contracts: OutputContractEntry[] = [
      { name: '00-plan.md', format: '00-plan', useJudge: true },
      { name: '01-review.md', format: '01-review', useJudge: true },
    ];
    expect(getReportFiles(contracts)).toEqual(['00-plan.md', '01-review.md']);
  });

  it('should extract path from OutputContractLabelPath entries', () => {
    const contracts: OutputContractEntry[] = [
      { name: 'scope.md', format: 'scope', useJudge: true },
      { name: 'decisions.md', format: 'decisions', useJudge: true },
    ];
    expect(getReportFiles(contracts)).toEqual(['scope.md', 'decisions.md']);
  });

  it('should handle mixed entry types', () => {
    const contracts: OutputContractEntry[] = [
      { name: '00-plan.md', format: '00-plan', useJudge: true },
      { name: 'review.md', format: 'review', useJudge: true },
    ];
    expect(getReportFiles(contracts)).toEqual(['00-plan.md', 'review.md']);
  });
});
