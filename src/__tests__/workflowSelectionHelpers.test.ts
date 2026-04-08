import { describe, expect, it } from 'vitest';
import { buildTopLevelSelectOptions, buildWorkflowSelectionItems } from '../features/workflowSelection/index.js';

describe('workflow selection helpers', () => {
  it('groups category entries before rendering top-level options', () => {
    const items = buildWorkflowSelectionItems([
      { name: 'default', path: '/tmp/default.yaml', source: 'builtin' },
      { name: 'frontend/api', path: '/tmp/api.yaml', source: 'builtin', category: 'frontend' },
      { name: 'frontend/ui', path: '/tmp/ui.yaml', source: 'builtin', category: 'frontend' },
    ]);

    expect(items).toEqual([
      { type: 'workflow', name: 'default' },
      { type: 'category', name: 'frontend', workflows: ['frontend/api', 'frontend/ui'] },
    ]);
    expect(buildTopLevelSelectOptions(items)).toEqual([
      { label: 'default', value: 'default' },
      { label: '📁 frontend/', value: '__category__:frontend' },
    ]);
  });
});
