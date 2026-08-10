import { describe, expect, it, vi } from 'vitest';
import {
  sanitizeCompanionSelectorRationale,
  selectActiveCompanions,
} from '../core/workflow/companion/selection.js';

const definitions = new Map([
  ['security-reviewer', { name: 'security-reviewer', description: 'security review' }],
  ['design-reviewer', { name: 'design-reviewer', description: 'design review' }],
  ['frontend-reviewer', { name: 'frontend-reviewer', description: 'frontend review' }],
  ['terraform-reviewer', { name: 'terraform-reviewer', description: 'terraform review' }],
]);

describe('CT-COMP-04 companion pool selection', () => {
  it('should skip the selector when the step has only fixed companions', async () => {
    const runSelector = vi.fn();

    const active = await selectActiveCompanions({
      selection: { fixed: ['security-reviewer'], pool: [] },
      definitions,
      task: 'Implement authentication',
      stepContext: { name: 'implement', instruction: 'implement' },
      runSelector,
    });

    expect(active.map(({ name }) => name)).toEqual(['security-reviewer']);
    expect(runSelector).not.toHaveBeenCalled();
  });

  it('should select the pool once with task, step context, and name-description candidates', async () => {
    const runSelector = vi.fn().mockResolvedValue({
      selectedIds: ['design-reviewer', 'frontend-reviewer'],
      rationale: 'task touches UI boundaries',
    });

    const active = await selectActiveCompanions({
      selection: {
        fixed: ['security-reviewer'],
        pool: ['design-reviewer', 'frontend-reviewer', 'terraform-reviewer'],
      },
      definitions,
      task: 'Implement authentication UI',
      stepContext: { name: 'implement', instruction: 'implement the task' },
      runSelector,
    });

    expect(runSelector).toHaveBeenCalledOnce();
    expect(runSelector).toHaveBeenCalledWith({
      task: 'Implement authentication UI',
      step: { name: 'implement', instruction: 'implement the task' },
      candidates: [
        { name: 'design-reviewer', description: 'design review' },
        { name: 'frontend-reviewer', description: 'frontend review' },
        { name: 'terraform-reviewer', description: 'terraform review' },
      ],
      maxSelected: 2,
    });
    expect(active.map(({ name }) => name)).toEqual([
      'security-reviewer',
      'design-reviewer',
      'frontend-reviewer',
    ]);
  });

  it('should reject more than three fixed companions before selector execution', async () => {
    await expect(selectActiveCompanions({
      selection: {
        fixed: [
          'security-reviewer',
          'design-reviewer',
          'frontend-reviewer',
          'terraform-reviewer',
        ],
        pool: [],
      },
      definitions,
      task: 'Implement everything',
      stepContext: { name: 'implement', instruction: 'implement' },
      runSelector: vi.fn(),
    })).rejects.toThrow(/maximum.*3|3.*maximum/i);
  });

  it('should not collapse distinct fixed and selected companions by description', async () => {
    const sameDescription = new Map(definitions);
    sameDescription.set('design-reviewer', { name: 'design-reviewer', description: 'security review' });

    const active = await selectActiveCompanions({
      selection: { fixed: ['security-reviewer'], pool: ['design-reviewer'] },
      definitions: sameDescription,
      task: 'Implement authentication',
      stepContext: { name: 'implement', instruction: 'implement' },
      runSelector: vi.fn().mockResolvedValue({ selectedIds: ['design-reviewer'], rationale: 'selected' }),
    });

    expect(active.map(({ name }) => name)).toEqual(['security-reviewer', 'design-reviewer']);
  });

  it('should deduplicate fixed and pool names before calculating limits', async () => {
    const runSelector = vi.fn().mockResolvedValue({
      selectedIds: ['design-reviewer'],
      rationale: 'selected',
    });

    const active = await selectActiveCompanions({
      selection: {
        fixed: ['security-reviewer', 'security-reviewer'],
        pool: ['security-reviewer', 'design-reviewer', 'design-reviewer'],
      },
      definitions,
      task: 'Implement authentication',
      stepContext: { name: 'implement', instruction: 'implement' },
      runSelector,
    });

    expect(runSelector).toHaveBeenCalledWith(expect.objectContaining({
      candidates: [{ name: 'design-reviewer', description: 'design review' }],
      maxSelected: 2,
    }));
    expect(active.map(({ name }) => name)).toEqual(['security-reviewer', 'design-reviewer']);
  });

  it('should redact known values and truncate selector rationale at a UTF-8 boundary', () => {
    const secret = 'selector-secret-token';
    const rationale = `${secret}:${'あ'.repeat(600)}`;

    const sanitized = sanitizeCompanionSelectorRationale(rationale, { token: secret });

    expect(sanitized).not.toContain(secret);
    expect(sanitized).toContain('[REDACTED]');
    expect(Buffer.byteLength(sanitized, 'utf8')).toBeLessThanOrEqual(1024);
  });
});
