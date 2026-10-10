import { describe, expect, it, vi } from 'vitest';
import { findReportInScopes } from '../core/workflow/instruction/report-reference-scope.js';

describe('findReportInScopes', () => {
  it.each([
    { current: 'CURRENT', snapshot: 'SNAPSHOT', parents: ['NEAR', 'ROOT'], expected: 'CURRENT' },
    { current: undefined, snapshot: 'SNAPSHOT', parents: ['NEAR', 'ROOT'], expected: 'SNAPSHOT' },
    { current: undefined, snapshot: undefined, parents: ['NEAR', 'ROOT'], expected: 'NEAR' },
    { current: undefined, snapshot: undefined, parents: [undefined, 'ROOT'], expected: 'ROOT' },
    { current: undefined, snapshot: undefined, parents: [undefined], expected: undefined },
  ])('selects the first available scope: $expected', ({ current, snapshot, parents, expected }) => {
    expect(findReportInScopes(() => current, () => snapshot, parents.map((value) => () => value))).toBe(expected);
  });

  it('does not evaluate later scopes after finding a report', () => {
    const later = vi.fn(() => { throw new Error('later scope failed'); });
    expect(findReportInScopes(() => 'CURRENT', later, [later])).toBe('CURRENT');
    expect(later).not.toHaveBeenCalled();
  });

  it('propagates errors instead of continuing to another scope', () => {
    const error = new Error('read failed');
    const ancestor = vi.fn(() => 'ROOT');
    expect(() => findReportInScopes(() => { throw error; }, () => undefined, [ancestor])).toThrow(error);
    expect(ancestor).not.toHaveBeenCalled();
  });
});
