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
      { type: 'workflow', name: 'default', source: 'builtin' },
      { type: 'category', name: 'frontend', workflows: ['frontend/api', 'frontend/ui'] },
    ]);
    expect(buildTopLevelSelectOptions(items)).toEqual([
      { label: 'default', value: 'default' },
      { label: '📁 frontend/', value: '__category__:frontend' },
    ]);
  });

  it('preserves repertoire source labels for top-level workflow items', () => {
    const items = buildWorkflowSelectionItems([
      { name: '@owner/repo/build', path: '/tmp/build.yaml', source: 'repertoire' },
    ]);

    expect(buildTopLevelSelectOptions(items)).toEqual([
      { label: '🎼 @owner/repo/build (repertoire)', value: '@owner/repo/build' },
    ]);
  });
});
