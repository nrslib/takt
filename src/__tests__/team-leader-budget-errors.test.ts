import { describe, expect, it } from 'vitest';
import { isPlanningBudgetError } from '../core/workflow/engine/team-leader-budget-errors.js';

describe('isPlanningBudgetError', () => {
  it('既知の parts 予算超過エラーだけを planning budget error として扱う', () => {
    expect(isPlanningBudgetError(new Error('Initial team leader parts exceed max_total_parts: 3 > 2'))).toBe(true);
    expect(isPlanningBudgetError(new Error('Team leader planned parts exceed max_total_parts: 4 > 3'))).toBe(true);
    expect(isPlanningBudgetError(new Error('Team leader produced too many total parts: 2 > max_total_parts 1'))).toBe(true);
    expect(isPlanningBudgetError(new Error('Structured output produced too many total parts: 6 > max_total_parts 5'))).toBe(true);
    expect(isPlanningBudgetError(new Error('Structured output produced too many parts: 2 > 1'))).toBe(true);
  });

  it('max_total_parts を含むだけの無関係なエラーは planning budget error にしない', () => {
    expect(isPlanningBudgetError(new Error('Failed to load max_total_parts from workflow config'))).toBe(false);
    expect(isPlanningBudgetError(new Error('max_total_parts must be less than or equal to 20: 21'))).toBe(false);
    expect(isPlanningBudgetError('Team leader planned parts exceed max_total_parts: 4 > 3')).toBe(false);
  });
});
