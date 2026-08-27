import { describe, expect, it } from 'vitest';
import type { WorkflowCategoryNode, WorkflowWithSource } from '../infra/config/index.js';
import { flattenWorkflowCategories } from '../features/web-ui/workflow-catalog.js';

describe('Web UI workflow catalog', () => {
  it('flattens nested categories while preserving qualified workflow ids', () => {
    const categories: WorkflowCategoryNode[] = [{
      name: '開発',
      workflows: ['default'],
      children: [{ name: 'Frontend', workflows: ['frontend'], children: [] }],
    }];
    const workflows = new Map<string, WorkflowWithSource>([
      ['default', { config: { name: 'default', description: '標準' }, source: 'builtin' }],
      ['frontend', { config: { name: 'frontend' }, source: 'project' }],
    ]);

    expect(flattenWorkflowCategories(categories, workflows, { frontend: '画面開発' })).toEqual([
      {
        id: '開発',
        label: '開発',
        workflows: [{ id: 'default', description: '標準', source: 'builtin' }],
      },
      {
        id: '開発/Frontend',
        label: '開発 / Frontend',
        workflows: [{ id: 'frontend', description: '画面開発', source: 'project' }],
      },
    ]);
  });
});
