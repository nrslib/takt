/**
 * Tests for workflow selection helpers
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowDirEntry } from '../infra/config/loaders/workflowLoader.js';
import type { CategorizedWorkflows } from '../infra/config/loaders/workflowCategories.js';
import type { WorkflowWithSource } from '../infra/config/loaders/workflowResolver.js';

const selectOptionMock = vi.fn();
const bookmarkState = vi.hoisted(() => ({
  bookmarks: [] as string[],
}));
const uiMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../shared/prompt/index.js', () => ({
  selectOption: selectOptionMock,
}));

vi.mock('../shared/ui/index.js', () => uiMock);

vi.mock('../infra/config/global/index.js', () => ({
  getBookmarkedWorkflows: () => bookmarkState.bookmarks,
  addBookmark: vi.fn(),
  removeBookmark: vi.fn(),
  toggleBookmark: vi.fn(),
}));

vi.mock('../infra/config/index.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return actual;
});

const configMock = vi.hoisted(() => ({
  loadAllStandaloneWorkflowsWithSources: vi.fn(),
  listStandaloneWorkflowEntries: vi.fn(),
  getWorkflowCategories: vi.fn(),
  resolveIgnoredWorkflows: vi.fn(),
  buildCategorizedWorkflows: vi.fn(),
}));

vi.mock('../infra/config/index.js', () => configMock);

const { selectWorkflowFromEntries, selectWorkflowFromCategorizedWorkflows, selectWorkflow } = await import('../features/workflowSelection/index.js');

describe('selectWorkflowFromEntries', () => {
  beforeEach(() => {
    selectOptionMock.mockReset();
    bookmarkState.bookmarks = [];
  });

  it('should select from custom workflows when source is chosen', async () => {
    const entries: WorkflowDirEntry[] = [
      { name: 'custom-flow', path: '/tmp/custom.yaml', source: 'user' },
      { name: 'builtin-flow', path: '/tmp/builtin.yaml', source: 'builtin' },
    ];

    selectOptionMock
      .mockResolvedValueOnce('custom')
      .mockResolvedValueOnce('custom-flow');

    const selected = await selectWorkflowFromEntries(entries);
    expect(selected).toBe('custom-flow');
    expect(selectOptionMock).toHaveBeenCalledTimes(2);
  });

  it('should skip source selection when only builtin workflows exist', async () => {
    const entries: WorkflowDirEntry[] = [
      { name: 'builtin-flow', path: '/tmp/builtin.yaml', source: 'builtin' },
    ];

    selectOptionMock.mockResolvedValueOnce('builtin-flow');

    const selected = await selectWorkflowFromEntries(entries);
    expect(selected).toBe('builtin-flow');
    expect(selectOptionMock).toHaveBeenCalledTimes(1);
  });

  it('should return builtin workflow identity instead of its file path', async () => {
    const entries: WorkflowDirEntry[] = [
      {
        name: 'auto-improvement-loop',
        path: '/repo/builtins/en/workflows/auto-improvement-loop.yaml',
        source: 'builtin',
      },
    ];

    selectOptionMock.mockResolvedValueOnce('auto-improvement-loop');

    const selected = await selectWorkflowFromEntries(entries);

    expect(selected).toBe('auto-improvement-loop');
    expect(selected).not.toBe(entries[0]!.path);
  });
});

function createWorkflowMap(entries: { name: string; source: 'user' | 'builtin' }[]): Map<string, WorkflowWithSource> {
  const map = new Map<string, WorkflowWithSource>();
  for (const e of entries) {
    map.set(e.name, {
      source: e.source,
      config: {
        name: e.name,
      },
    });
  }
  return map;
}

describe('selectWorkflowFromCategorizedWorkflows', () => {
  beforeEach(() => {
    selectOptionMock.mockReset();
    bookmarkState.bookmarks = [];
  });

  it('should show categories at top level', async () => {
    const categorized: CategorizedWorkflows = {
      categories: [
        { name: 'My Workflows', workflows: ['my-workflow'], children: [] },
        { name: 'Quick Start', workflows: ['default'], children: [] },
      ],
      allWorkflows: createWorkflowMap([
        { name: 'my-workflow', source: 'user' },
        { name: 'default', source: 'builtin' },
      ]),
      missingWorkflows: [],
    };

    selectOptionMock
      .mockResolvedValueOnce('__custom_category__:My Workflows')
      .mockResolvedValueOnce('my-workflow');

    await selectWorkflowFromCategorizedWorkflows(categorized);

    const firstCallOptions = selectOptionMock.mock.calls[0]![1] as { label: string; value: string }[];
    const labels = firstCallOptions.map((o) => o.label);
    const values = firstCallOptions.map((o) => o.value);

    expect(labels.some((l) => l.includes('My Workflows'))).toBe(true);
    expect(labels.some((l) => l.includes('My Workflows'))).toBe(true);
    expect(labels.some((l) => l.includes('Quick Start'))).toBe(true);
    expect(labels.some((l) => l.includes('(current)'))).toBe(false);
    expect(values).not.toContain('__current__');
  });

  it('should show bookmarked workflows', async () => {
    bookmarkState.bookmarks = ['research'];

    const categorized: CategorizedWorkflows = {
      categories: [
        { name: 'Quick Start', workflows: ['default'], children: [] },
      ],
      allWorkflows: createWorkflowMap([
        { name: 'default', source: 'builtin' },
        { name: 'research', source: 'builtin' },
      ]),
      missingWorkflows: [],
    };

    selectOptionMock.mockResolvedValueOnce('research');

    const selected = await selectWorkflowFromCategorizedWorkflows(categorized);
    expect(selected).toBe('research');

    const firstCallOptions = selectOptionMock.mock.calls[0]![1] as { label: string; value: string }[];
    const labels = firstCallOptions.map((o) => o.label);

    expect(labels.some((l) => l.includes('research [*]'))).toBe(true);
  });

  it('should ignore stale bookmarked workflows at top level', async () => {
    bookmarkState.bookmarks = ['stale-workflow', 'research'];

    const categorized: CategorizedWorkflows = {
      categories: [
        { name: 'Quick Start', workflows: ['default'], children: [] },
      ],
      allWorkflows: createWorkflowMap([
        { name: 'default', source: 'builtin' },
        { name: 'research', source: 'builtin' },
      ]),
      missingWorkflows: [],
    };

    selectOptionMock.mockResolvedValueOnce('research');

    const selected = await selectWorkflowFromCategorizedWorkflows(categorized);
    expect(selected).toBe('research');

    const firstCallOptions = selectOptionMock.mock.calls[0]![1] as { label: string; value: string }[];
    expect(firstCallOptions.map((option) => option.value)).toEqual([
      'research',
      '__custom_category__:Quick Start',
    ]);
  });

  it('should navigate into a category and select a workflow', async () => {
    const categorized: CategorizedWorkflows = {
      categories: [
        { name: 'Dev', workflows: ['my-workflow'], children: [] },
      ],
      allWorkflows: createWorkflowMap([
        { name: 'my-workflow', source: 'user' },
      ]),
      missingWorkflows: [],
    };

    // Select category, then select workflow inside it
    selectOptionMock
      .mockResolvedValueOnce('__custom_category__:Dev')
      .mockResolvedValueOnce('my-workflow');

    const selected = await selectWorkflowFromCategorizedWorkflows(categorized);
    expect(selected).toBe('my-workflow');
  });

  it('should navigate into subcategories recursively', async () => {
    const categorized: CategorizedWorkflows = {
      categories: [
        {
          name: 'Hybrid',
          workflows: [],
          children: [
            { name: 'Quick Start', workflows: ['hybrid-default'], children: [] },
            { name: 'Full Stack', workflows: ['hybrid-expert'], children: [] },
          ],
        },
      ],
      allWorkflows: createWorkflowMap([
        { name: 'hybrid-default', source: 'builtin' },
        { name: 'hybrid-expert', source: 'builtin' },
      ]),
      missingWorkflows: [],
    };

    // Select Hybrid category → Quick Start subcategory → workflow
    selectOptionMock
      .mockResolvedValueOnce('__custom_category__:Hybrid')
      .mockResolvedValueOnce('__category__:Quick Start')
      .mockResolvedValueOnce('hybrid-default');

    const selected = await selectWorkflowFromCategorizedWorkflows(categorized);
    expect(selected).toBe('hybrid-default');
    expect(selectOptionMock).toHaveBeenCalledTimes(3);
  });

  it('should show subcategories and workflows at the same level within a category', async () => {
    const categorized: CategorizedWorkflows = {
      categories: [
        {
          name: 'Dev',
          workflows: ['base-workflow'],
          children: [
            { name: 'Advanced', workflows: ['adv-workflow'], children: [] },
          ],
        },
      ],
      allWorkflows: createWorkflowMap([
        { name: 'base-workflow', source: 'user' },
        { name: 'adv-workflow', source: 'user' },
      ]),
      missingWorkflows: [],
    };

    // Select Dev category, then directly select the root-level workflow
    selectOptionMock
      .mockResolvedValueOnce('__custom_category__:Dev')
      .mockResolvedValueOnce('base-workflow');

    const selected = await selectWorkflowFromCategorizedWorkflows(categorized);
    expect(selected).toBe('base-workflow');

    // Second call should show Advanced subcategory AND base-workflow at same level
    const secondCallOptions = selectOptionMock.mock.calls[1]![1] as { label: string; value: string }[];
    const labels = secondCallOptions.map((o) => o.label);

    // Should contain the subcategory folder
    expect(labels.some((l) => l.includes('Advanced'))).toBe(true);
    // Should contain the workflow
    expect(labels.some((l) => l.includes('base-workflow'))).toBe(true);
    // Should NOT contain the parent category again
    expect(labels.some((l) => l.includes('Dev'))).toBe(false);
  });

  it('should navigate into builtin wrapper category and select a workflow', async () => {
    const categorized: CategorizedWorkflows = {
      categories: [
        { name: 'My Team', workflows: ['custom'], children: [] },
        {
          name: 'builtin',
          workflows: [],
          children: [
            { name: 'Quick Start', workflows: ['default'], children: [] },
          ],
        },
      ],
      allWorkflows: createWorkflowMap([
        { name: 'custom', source: 'user' },
        { name: 'default', source: 'builtin' },
      ]),
      missingWorkflows: [],
    };

    // Select builtin category → Quick Start subcategory → workflow
    selectOptionMock
      .mockResolvedValueOnce('__custom_category__:builtin')
      .mockResolvedValueOnce('__category__:Quick Start')
      .mockResolvedValueOnce('default');

    const selected = await selectWorkflowFromCategorizedWorkflows(categorized);
    expect(selected).toBe('default');
    expect(selectOptionMock).toHaveBeenCalledTimes(3);
  });

  it('should show builtin wrapper as a folder in top-level options', async () => {
    const categorized: CategorizedWorkflows = {
      categories: [
        { name: 'My Team', workflows: ['custom'], children: [] },
        {
          name: 'builtin',
          workflows: [],
          children: [
            { name: 'Quick Start', workflows: ['default'], children: [] },
          ],
        },
      ],
      allWorkflows: createWorkflowMap([
        { name: 'custom', source: 'user' },
        { name: 'default', source: 'builtin' },
      ]),
      missingWorkflows: [],
    };

    selectOptionMock.mockResolvedValueOnce(null);

    await selectWorkflowFromCategorizedWorkflows(categorized);

    const firstCallOptions = selectOptionMock.mock.calls[0]![1] as { label: string; value: string }[];
    const labels = firstCallOptions.map((o) => o.label);
    expect(labels.some((l) => l.includes('My Team'))).toBe(true);
    expect(labels.some((l) => l.includes('builtin'))).toBe(true);
  });

  it('should sanitize category labels and bookmarked workflow labels in categorized selection', async () => {
    bookmarkState.bookmarks = ['bookmarked\nworkflow'];

    const categorized: CategorizedWorkflows = {
      categories: [
        { name: 'Unsafe\nCategory', workflows: [], children: [] },
      ],
      allWorkflows: createWorkflowMap([
        { name: 'bookmarked\nworkflow', source: 'builtin' },
      ]),
      missingWorkflows: [],
    };

    selectOptionMock.mockResolvedValueOnce(null);

    await selectWorkflowFromCategorizedWorkflows(categorized);

    const firstCallOptions = selectOptionMock.mock.calls[0]![1] as { label: string; value: string }[];
    expect(firstCallOptions).toEqual(
      expect.arrayContaining([
        { label: '🎼 bookmarked\\nworkflow [*]', value: 'bookmarked\nworkflow' },
        { label: '📁 Unsafe\\nCategory/', value: '__custom_category__:Unsafe\nCategory' },
      ]),
    );
  });

  it('should sanitize category prompt labels when navigating nested categories', async () => {
    const categorized: CategorizedWorkflows = {
      categories: [
        {
          name: 'Root',
          workflows: [],
          children: [
            {
              name: 'Unsafe\nInner',
              workflows: [],
              children: [
                { name: 'Final\tCategory', workflows: ['safe-workflow'], children: [] },
              ],
            },
          ],
        },
      ],
      allWorkflows: createWorkflowMap([
        { name: 'safe-workflow', source: 'builtin' },
      ]),
      missingWorkflows: [],
    };

    selectOptionMock
      .mockResolvedValueOnce('__custom_category__:Root')
      .mockResolvedValueOnce('__category__:Unsafe\nInner')
      .mockResolvedValueOnce('__category__:Final\tCategory')
      .mockResolvedValueOnce('safe-workflow');

    const selected = await selectWorkflowFromCategorizedWorkflows(categorized);

    expect(selected).toBe('safe-workflow');
    expect(selectOptionMock).toHaveBeenNthCalledWith(
      3,
      'Select workflow in Unsafe\\nInner:',
      expect.any(Array),
      expect.any(Object),
    );
    expect(selectOptionMock).toHaveBeenNthCalledWith(
      4,
      'Select workflow in Unsafe\\nInner / Final\\tCategory:',
      expect.any(Array),
      expect.any(Object),
    );
  });

  it('should show workflow category empty-state message when selected category has no workflows', async () => {
    const categorized: CategorizedWorkflows = {
      categories: [
        { name: 'Empty', workflows: [], children: [] },
      ],
      allWorkflows: createWorkflowMap([]),
      missingWorkflows: [],
    };

    selectOptionMock.mockResolvedValueOnce('__custom_category__:Empty');

    const result = await selectWorkflowFromCategorizedWorkflows(categorized);

    expect(result).toBeNull();
    expect(uiMock.info).toHaveBeenCalledWith('No workflows available for configured categories.');
  });
});

describe('selectWorkflow', () => {
  beforeEach(() => {
    selectOptionMock.mockReset();
    bookmarkState.bookmarks = [];
    configMock.loadAllStandaloneWorkflowsWithSources.mockReset();
    configMock.listStandaloneWorkflowEntries.mockReset();
    configMock.getWorkflowCategories.mockReset();
    configMock.resolveIgnoredWorkflows.mockReset();
    configMock.buildCategorizedWorkflows.mockReset();
    uiMock.info.mockReset();
    uiMock.warn.mockReset();
  });

  it('should return default workflow when no workflows found and fallbackToDefault is true', async () => {
    configMock.getWorkflowCategories.mockReturnValue(null);
    configMock.listStandaloneWorkflowEntries.mockReturnValue([]);

    const result = await selectWorkflow('/cwd');

    expect(result).toBe('default');
  });

  it('should return null when no workflows found and fallbackToDefault is false', async () => {
    configMock.getWorkflowCategories.mockReturnValue(null);
    configMock.listStandaloneWorkflowEntries.mockReturnValue([]);

    const result = await selectWorkflow('/cwd', { fallbackToDefault: false });

    expect(result).toBeNull();
  });

  it('should prompt selection even when only one workflow exists', async () => {
    configMock.getWorkflowCategories.mockReturnValue(null);
    configMock.listStandaloneWorkflowEntries.mockReturnValue([
      { name: 'only-workflow', path: '/tmp/only-workflow.yaml', source: 'user' },
    ]);
    selectOptionMock.mockResolvedValueOnce('only-workflow');

    const result = await selectWorkflow('/cwd');

    expect(result).toBe('only-workflow');
    expect(selectOptionMock).toHaveBeenCalled();
  });

  it('should use category-based selection when category config exists', async () => {
    const workflowMap = createWorkflowMap([{ name: 'my-workflow', source: 'user' }]);
    const categorized: CategorizedWorkflows = {
      categories: [{ name: 'Dev', workflows: ['my-workflow'], children: [] }],
      allWorkflows: workflowMap,
      missingWorkflows: [],
    };

    configMock.getWorkflowCategories.mockReturnValue({ categories: ['Dev'] });
    configMock.loadAllStandaloneWorkflowsWithSources.mockReturnValue(workflowMap);
    configMock.buildCategorizedWorkflows.mockReturnValue(categorized);

    selectOptionMock
      .mockResolvedValueOnce('__custom_category__:Dev')
      .mockResolvedValueOnce('my-workflow');

    const result = await selectWorkflow('/cwd');

    expect(result).toBe('my-workflow');
    expect(configMock.buildCategorizedWorkflows).toHaveBeenCalled();
    expect(configMock.loadAllStandaloneWorkflowsWithSources).toHaveBeenCalledWith('/cwd', {
      onWarning: uiMock.warn,
    });
  });

  it('should forward invalid workflow warnings to UI in category-based selection path', async () => {
    const workflowMap = createWorkflowMap([{ name: 'my-workflow', source: 'user' }]);
    const categorized: CategorizedWorkflows = {
      categories: [{ name: 'Dev', workflows: ['my-workflow'], children: [] }],
      allWorkflows: workflowMap,
      missingWorkflows: [],
    };

    configMock.getWorkflowCategories.mockReturnValue({ categories: ['Dev'] });
    configMock.loadAllStandaloneWorkflowsWithSources.mockImplementation(
      (_cwd: string, options?: { onWarning?: (message: string) => void }) => {
        options?.onWarning?.('Workflow "broken" failed to load: steps.0.allowed_tools: Invalid input');
        return workflowMap;
      },
    );
    configMock.buildCategorizedWorkflows.mockReturnValue(categorized);

    selectOptionMock
      .mockResolvedValueOnce('__custom_category__:Dev')
      .mockResolvedValueOnce('my-workflow');

    const result = await selectWorkflow('/cwd');

    expect(result).toBe('my-workflow');
    expect(uiMock.warn).toHaveBeenCalledWith(
      'Workflow "broken" failed to load: steps.0.allowed_tools: Invalid input',
    );
  });

  it('should use directory-based selection when no category config', async () => {
    configMock.getWorkflowCategories.mockReturnValue(null);
    configMock.listStandaloneWorkflowEntries.mockReturnValue([
      { name: 'custom-flow', path: '/tmp/custom-flow.yaml', source: 'user' },
      { name: 'builtin-flow', path: '/tmp/builtin-flow.yaml', source: 'builtin' },
    ]);

    selectOptionMock
      .mockResolvedValueOnce('custom')
      .mockResolvedValueOnce('custom-flow');

    const result = await selectWorkflow('/cwd');

    expect(result).toBe('custom-flow');
    expect(configMock.listStandaloneWorkflowEntries).toHaveBeenCalledWith('/cwd', {
      onWarning: uiMock.warn,
    });
  });

  it('should exclude invalid workflows from normal selection path and forward warnings to UI', async () => {
    configMock.getWorkflowCategories.mockReturnValue(null);
    configMock.listStandaloneWorkflowEntries.mockImplementation(
      (_cwd: string, options?: { onWarning?: (message: string) => void }) => {
        options?.onWarning?.('Workflow "broken" failed to load: steps.0: Invalid input');
        return [
          { name: 'builtin-flow', path: '/tmp/builtin-flow.yaml', source: 'builtin' },
          { name: 'valid-flow', path: '/tmp/valid-flow.yaml', source: 'user' },
        ];
      },
    );

    selectOptionMock
      .mockResolvedValueOnce('custom')
      .mockResolvedValueOnce('valid-flow');

    const result = await selectWorkflow('/cwd');

    expect(result).toBe('valid-flow');
    expect(uiMock.warn).toHaveBeenCalledWith('Workflow "broken" failed to load: steps.0: Invalid input');
    expect(selectOptionMock).toHaveBeenNthCalledWith(
      2,
      'Select workflow:',
      [{ label: '🎼 valid-flow', value: 'valid-flow' }],
      expect.any(Object),
    );
  });

  it('should use workflow terminology in directory-based selection prompts', async () => {
    configMock.getWorkflowCategories.mockReturnValue(null);
    configMock.listStandaloneWorkflowEntries.mockReturnValue([
      { name: 'custom-flow', path: '/tmp/custom-flow.yaml', source: 'user' },
      { name: 'builtin-flow', path: '/tmp/builtin-flow.yaml', source: 'builtin' },
    ]);

    selectOptionMock
      .mockResolvedValueOnce('custom')
      .mockResolvedValueOnce('custom-flow');

    await selectWorkflow('/cwd');

    expect(selectOptionMock).toHaveBeenNthCalledWith(
      1,
      'Select workflow source:',
      expect.any(Array),
    );
    expect(selectOptionMock).toHaveBeenNthCalledWith(
      2,
      'Select workflow:',
      expect.any(Array),
      expect.any(Object),
    );
  });

  it('should label workflow sources and categories with workflow terminology', async () => {
    configMock.getWorkflowCategories.mockReturnValue(null);
    configMock.listStandaloneWorkflowEntries.mockReturnValue([
      { name: 'custom-flow', path: '/tmp/custom-flow.yaml', source: 'user' },
      { name: 'builtin-flow', path: '/tmp/builtin-flow.yaml', source: 'builtin' },
    ]);

    selectOptionMock
      .mockResolvedValueOnce('custom')
      .mockResolvedValueOnce('custom-flow');

    await selectWorkflow('/cwd');

    expect(selectOptionMock).toHaveBeenNthCalledWith(
      1,
      'Select workflow source:',
      [
        { label: 'Custom workflows (1)', value: 'custom' },
        { label: 'Builtin workflows (1)', value: 'builtin' },
      ],
    );
  });

  it('should preserve repertoire package-qualified names in normal selection path', async () => {
    configMock.getWorkflowCategories.mockReturnValue(null);
    configMock.listStandaloneWorkflowEntries.mockReturnValue([
      { name: '@owner/repo-a/build', path: '/tmp/repo-a.yaml', source: 'repertoire' },
      { name: '@owner/repo-b/build', path: '/tmp/repo-b.yaml', source: 'repertoire' },
    ]);
    selectOptionMock.mockResolvedValueOnce('@owner/repo-a/build');

    const result = await selectWorkflow('/cwd');

    expect(result).toBe('@owner/repo-a/build');
    expect(selectOptionMock).toHaveBeenCalledWith(
      'Select workflow:',
      [
        { label: '🎼 @owner/repo-a/build', value: '@owner/repo-a/build' },
        { label: '🎼 @owner/repo-b/build', value: '@owner/repo-b/build' },
      ],
      expect.any(Object),
    );
  });

  it('should sanitize terminal control characters in normal selection labels and warnings', async () => {
    configMock.getWorkflowCategories.mockReturnValue(null);
    configMock.listStandaloneWorkflowEntries.mockImplementation(
      (_cwd: string, options?: { onWarning?: (message: string) => void }) => {
        options?.onWarning?.('Workflow "bad\\nname" failed to load: invalid\\tfield');
        return [
          { name: 'safe\nworkflow', path: '/tmp/safe-workflow.yaml', source: 'user' },
        ];
      },
    );
    selectOptionMock.mockResolvedValueOnce('safe\nworkflow');

    const result = await selectWorkflow('/cwd');

    expect(result).toBe('safe\nworkflow');
    expect(uiMock.warn).toHaveBeenCalledWith('Workflow "bad\\nname" failed to load: invalid\\tfield');
    expect(selectOptionMock).toHaveBeenCalledWith(
      'Select workflow:',
      [{ label: '🎼 safe\\nworkflow', value: 'safe\nworkflow' }],
      expect.any(Object),
    );
  });

  it('should show workflow empty-state messages when no workflows are available', async () => {
    configMock.getWorkflowCategories.mockReturnValue(null);
    configMock.listStandaloneWorkflowEntries.mockReturnValue([]);

    const result = await selectWorkflow('/cwd', { fallbackToDefault: false });

    expect(result).toBeNull();
    expect(uiMock.info).toHaveBeenCalledWith('No workflows found.');
  });

  it('should sanitize missing workflow warnings in category-based selection path', async () => {
    const workflowMap = createWorkflowMap([{ name: 'safe-workflow', source: 'user' }]);
    const categorized: CategorizedWorkflows = {
      categories: [{ name: 'Dev', workflows: ['safe-workflow'], children: [] }],
      allWorkflows: workflowMap,
      missingWorkflows: [
        {
          categoryPath: ['Unsafe\nCategory', 'Inner\tLevel'],
          workflowName: 'missing\rworkflow',
          source: 'user',
        },
      ],
    };

    configMock.getWorkflowCategories.mockReturnValue({ categories: ['Dev'] });
    configMock.loadAllStandaloneWorkflowsWithSources.mockReturnValue(workflowMap);
    configMock.buildCategorizedWorkflows.mockReturnValue(categorized);
    selectOptionMock
      .mockResolvedValueOnce('__custom_category__:Dev')
      .mockResolvedValueOnce('safe-workflow');

    const result = await selectWorkflow('/cwd');

    expect(result).toBe('safe-workflow');
    expect(uiMock.warn).toHaveBeenCalledWith(
      'Workflow "missing\\rworkflow" in category "Unsafe\\nCategory / Inner\\tLevel" not found',
    );
  });
});
