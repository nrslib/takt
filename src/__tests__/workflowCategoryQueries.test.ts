import { describe, expect, it } from 'vitest';
import { findWorkflowCategories } from '../infra/config/loaders/workflowCategories.js';

describe('findWorkflowCategories', () => {
  it('returns nested category paths for a workflow', () => {
    expect(findWorkflowCategories('deploy', [
      {
        name: 'delivery',
        workflows: [],
        children: [
          {
            name: 'release',
            workflows: ['deploy'],
            children: [],
          },
        ],
      },
    ])).toEqual(['delivery / release']);
  });
});
