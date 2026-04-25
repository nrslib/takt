import { beforeEach, describe, expect, it, vi } from 'vitest';
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
const configMock = vi.hoisted(() => ({
  loadAllStandaloneWorkflowsWithSources: vi.fn(),
  listStandaloneWorkflowEntries: vi.fn(),
  getWorkflowCategories: vi.fn(),
  resolveIgnoredWorkflows: vi.fn(),
  buildCategorizedWorkflows: vi.fn(),
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

vi.mock('../infra/config/index.js', () => configMock);

const { selectWorkflow } = await import('../features/workflowSelection/index.js');
const { selectWorkflowFromEntries } = await import('../features/workflowSelection/entrySelection.js');
const { selectWorkflowFromCategorizedWorkflows } = await import('../features/workflowSelection/categorizedSelection.js');

function resetSelectionState(): void {
  selectOptionMock.mockReset();
  bookmarkState.bookmarks = [];
  uiMock.info.mockReset();
  uiMock.warn.mockReset();
}

function resetConfigState(): void {
  configMock.loadAllStandaloneWorkflowsWithSources.mockReset();
  configMock.listStandaloneWorkflowEntries.mockReset();
  configMock.getWorkflowCategories.mockReset();
  configMock.resolveIgnoredWorkflows.mockReset();
  configMock.buildCategorizedWorkflows.mockReset();
}

function createWorkflowMap(entries: {
  name: string;
  source: 'user' | 'builtin' | 'project' | 'repertoire';
}[]): Map<string, WorkflowWithSource> {
  const map = new Map<string, WorkflowWithSource>();
  for (const entry of entries) {
    map.set(entry.name, {
      source: entry.source,
      config: {
        name: entry.name,
      },
    });
  }
  return map;
}

function getPromptMessages(): string[] {
  return selectOptionMock.mock.calls.map((call) => call[0] as string);
}

function expectNoSourceSelectionPrompt(): void {
  expect(getPromptMessages()).not.toContain('Select workflow source:');
}

describe('selectWorkflowFromEntries', () => {
  beforeEach(() => {
    resetSelectionState();
  });

  it('should return null without prompting when entries are empty', async () => {
    const selected = await selectWorkflowFromEntries([]);

    expect(selected).toBeNull();
    expect(selectOptionMock).not.toHaveBeenCalled();
  });

  it('should show builtin options first and append user-defined workflows at the bottom of the main menu', async () => {
    const entries: WorkflowDirEntry[] = [
      { name: 'default', path: '/tmp/default.yaml', source: 'builtin' },
      { name: 'frontend/api', path: '/tmp/api.yaml', source: 'builtin', category: 'frontend' },
      { name: 'global-flow', path: '/tmp/global.yaml', source: 'user' },
      { name: 'project-flow', path: '/tmp/project.yaml', source: 'project' },
    ];

    selectOptionMock.mockResolvedValueOnce('project-flow');

    const selected = await selectWorkflowFromEntries(entries);

    expect(selected).toBe('project-flow');
    expect(selectOptionMock).toHaveBeenCalledTimes(1);
    expect(selectOptionMock).toHaveBeenNthCalledWith(
      1,
      'Select workflow:',
      [
        { label: 'default', value: 'default' },
        { label: '📁 frontend/', value: '__category__:frontend' },
        { label: '🎼 global-flow (global)', value: 'global-flow' },
        { label: '🎼 project-flow (project)', value: 'project-flow' },
      ],
      expect.any(Object),
    );
    expectNoSourceSelectionPrompt();
  });

  it('should keep repertoire workflows in the main menu with source labels before user-defined workflows', async () => {
    const entries: WorkflowDirEntry[] = [
      { name: 'default', path: '/tmp/default.yaml', source: 'builtin' },
      { name: '@owner/repo/build', path: '/tmp/build.yaml', source: 'repertoire' },
      { name: 'global-flow', path: '/tmp/global.yaml', source: 'user' },
    ];

    selectOptionMock.mockResolvedValueOnce('@owner/repo/build');

    const selected = await selectWorkflowFromEntries(entries);

    expect(selected).toBe('@owner/repo/build');
    expect(selectOptionMock).toHaveBeenNthCalledWith(
      1,
      'Select workflow:',
      [
        { label: '🎼 @owner/repo/build (repertoire)', value: '@owner/repo/build' },
        { label: 'default', value: 'default' },
        { label: '🎼 global-flow (global)', value: 'global-flow' },
      ],
      expect.any(Object),
    );
  });

  it('should navigate into builtin categories without showing a source split first', async () => {
    const entries: WorkflowDirEntry[] = [
      { name: 'frontend/api', path: '/tmp/api.yaml', source: 'builtin', category: 'frontend' },
      { name: 'frontend/ui', path: '/tmp/ui.yaml', source: 'builtin', category: 'frontend' },
      { name: 'project-flow', path: '/tmp/project.yaml', source: 'project' },
    ];

    selectOptionMock
      .mockResolvedValueOnce('__category__:frontend')
      .mockResolvedValueOnce('frontend/ui');

    const selected = await selectWorkflowFromEntries(entries);

    expect(selected).toBe('frontend/ui');
    expect(selectOptionMock).toHaveBeenCalledTimes(2);
    expect(selectOptionMock).toHaveBeenNthCalledWith(
      2,
      'Select workflow in frontend:',
      [
        { label: 'api', value: 'frontend/api' },
        { label: 'ui', value: 'frontend/ui' },
      ],
      expect.any(Object),
    );
    expectNoSourceSelectionPrompt();
  });
});

describe('selectWorkflowFromCategorizedWorkflows', () => {
  beforeEach(() => {
    resetSelectionState();
  });

  it('should append user-defined workflows after builtin categories and hide Others when it only contains user-defined workflows', async () => {
    const categorized: CategorizedWorkflows = {
      categories: [
        { name: 'Quick Start', workflows: ['default'], children: [] },
        { name: 'Others', workflows: ['global-flow', 'project-flow'], children: [] },
      ],
      allWorkflows: createWorkflowMap([
        { name: 'default', source: 'builtin' },
        { name: 'global-flow', source: 'user' },
        { name: 'project-flow', source: 'project' },
      ]),
      missingWorkflows: [],
    };

    selectOptionMock.mockResolvedValueOnce('project-flow');

    const selected = await selectWorkflowFromCategorizedWorkflows(categorized);

    expect(selected).toBe('project-flow');
    expect(selectOptionMock).toHaveBeenCalledTimes(1);
    expect(selectOptionMock).toHaveBeenNthCalledWith(
      1,
      'Select workflow:',
      [
        { label: '📁 Quick Start/', value: '__custom_category__:Quick Start' },
        { label: '🎼 global-flow (global)', value: 'global-flow' },
        { label: '🎼 project-flow (project)', value: 'project-flow' },
      ],
      expect.any(Object),
    );
    expectNoSourceSelectionPrompt();
  });

  it('should keep repertoire workflows inside builtin categories ahead of user-defined workflows', async () => {
    const categorized: CategorizedWorkflows = {
      categories: [
        { name: 'Quick Start', workflows: ['default'], children: [] },
        { name: 'repertoire', workflows: ['@owner/repo/build'], children: [] },
      ],
      allWorkflows: createWorkflowMap([
        { name: 'default', source: 'builtin' },
        { name: '@owner/repo/build', source: 'repertoire' },
        { name: 'global-flow', source: 'user' },
      ]),
      missingWorkflows: [],
    };

    selectOptionMock
      .mockResolvedValueOnce('__custom_category__:repertoire')
      .mockResolvedValueOnce('@owner/repo/build');

    const selected = await selectWorkflowFromCategorizedWorkflows(categorized);

    expect(selected).toBe('@owner/repo/build');
    expect(selectOptionMock).toHaveBeenNthCalledWith(
      1,
      'Select workflow:',
      [
        { label: '📁 Quick Start/', value: '__custom_category__:Quick Start' },
        { label: '📁 repertoire/', value: '__custom_category__:repertoire' },
        { label: '🎼 global-flow (global)', value: 'global-flow' },
      ],
      expect.any(Object),
    );
    expect(selectOptionMock).toHaveBeenNthCalledWith(
      2,
      'Select workflow category:',
      [{ label: '🎼 @owner/repo/build (repertoire)', value: '@owner/repo/build' }],
      expect.any(Object),
    );
    expectNoSourceSelectionPrompt();
  });

  it('should show bookmark markers for bookmarked user-defined workflows in the categorized top-level menu', async () => {
    const categorized: CategorizedWorkflows = {
      categories: [
        { name: 'Quick Start', workflows: ['default'], children: [] },
      ],
      allWorkflows: createWorkflowMap([
        { name: 'default', source: 'builtin' },
        { name: 'project-flow', source: 'project' },
      ]),
      missingWorkflows: [],
    };
    bookmarkState.bookmarks = ['default', 'project-flow'];

    selectOptionMock.mockResolvedValueOnce(null);

    const selected = await selectWorkflowFromCategorizedWorkflows(categorized);

    expect(selected).toBeNull();
    expect(selectOptionMock).toHaveBeenCalledTimes(1);
    expect(selectOptionMock).toHaveBeenNthCalledWith(
      1,
      'Select workflow:',
      [
        { label: '🎼 default [*]', value: 'default' },
        { label: '📁 Quick Start/', value: '__custom_category__:Quick Start' },
        { label: '🎼 project-flow (project) [*]', value: 'project-flow' },
      ],
      expect.any(Object),
    );
    expectNoSourceSelectionPrompt();
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
        { name: 'base-workflow', source: 'builtin' },
        { name: 'adv-workflow', source: 'builtin' },
      ]),
      missingWorkflows: [],
    };

    selectOptionMock
      .mockResolvedValueOnce('__custom_category__:Dev')
      .mockResolvedValueOnce('base-workflow');

    const selected = await selectWorkflowFromCategorizedWorkflows(categorized);

    expect(selected).toBe('base-workflow');
    expect(selectOptionMock).toHaveBeenNthCalledWith(
      2,
      'Select workflow category:',
      [
        { label: '📁 Advanced/', value: '__category__:Advanced' },
        { label: '🎼 base-workflow', value: 'base-workflow' },
      ],
      expect.any(Object),
    );
  });

  it('should sanitize category labels and bookmarked workflow labels in categorized selection', async () => {
    bookmarkState.bookmarks = ['bookmarked\nworkflow'];
    const categorized: CategorizedWorkflows = {
      categories: [
        { name: 'Unsafe\nCategory', workflows: ['inside-workflow'], children: [] },
      ],
      allWorkflows: createWorkflowMap([
        { name: 'bookmarked\nworkflow', source: 'builtin' },
        { name: 'inside-workflow', source: 'builtin' },
      ]),
      missingWorkflows: [],
    };

    selectOptionMock.mockResolvedValueOnce(null);

    await selectWorkflowFromCategorizedWorkflows(categorized);

    expect(selectOptionMock).toHaveBeenNthCalledWith(
      1,
      'Select workflow:',
      [
        { label: '🎼 bookmarked\\nworkflow [*]', value: 'bookmarked\nworkflow' },
        { label: '📁 Unsafe\\nCategory/', value: '__custom_category__:Unsafe\nCategory' },
      ],
      expect.any(Object),
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

    const selected = await selectWorkflowFromCategorizedWorkflows(categorized);

    expect(selected).toBeNull();
    expect(selectOptionMock).not.toHaveBeenCalled();
    expect(uiMock.info).toHaveBeenCalledWith('No workflows available for configured categories.');
  });
});

describe('selectWorkflow', () => {
  beforeEach(() => {
    resetSelectionState();
    resetConfigState();
    configMock.resolveIgnoredWorkflows.mockReturnValue(new Set());
  });

  it('should return default workflow when no workflows are found and fallbackToDefault is true', async () => {
    configMock.getWorkflowCategories.mockReturnValue(null);
    configMock.listStandaloneWorkflowEntries.mockReturnValue([]);

    const result = await selectWorkflow('/cwd');

    expect(result).toBe('default');
    expect(uiMock.info).toHaveBeenCalledWith('No workflows found. Using default workflow: default');
  });

  it('should return null when no workflows are found and fallbackToDefault is false', async () => {
    configMock.getWorkflowCategories.mockReturnValue(null);
    configMock.listStandaloneWorkflowEntries.mockReturnValue([]);

    const result = await selectWorkflow('/cwd', { fallbackToDefault: false });

    expect(result).toBeNull();
    expect(uiMock.info).toHaveBeenCalledWith('No workflows found.');
  });

  it('should use a single directory-based menu when no category config exists', async () => {
    configMock.getWorkflowCategories.mockReturnValue(null);
    configMock.listStandaloneWorkflowEntries.mockReturnValue([
      { name: 'default', path: '/tmp/default.yaml', source: 'builtin' },
      { name: 'frontend/api', path: '/tmp/api.yaml', source: 'builtin', category: 'frontend' },
      { name: 'custom-flow', path: '/tmp/custom-flow.yaml', source: 'user' },
    ]);

    selectOptionMock.mockResolvedValueOnce('custom-flow');

    const result = await selectWorkflow('/cwd');

    expect(result).toBe('custom-flow');
    expect(configMock.listStandaloneWorkflowEntries).toHaveBeenCalledWith('/cwd', {
      onWarning: uiMock.warn,
    });
    expect(selectOptionMock).toHaveBeenNthCalledWith(
      1,
      'Select workflow:',
      [
        { label: 'default', value: 'default' },
        { label: '📁 frontend/', value: '__category__:frontend' },
        { label: '🎼 custom-flow (global)', value: 'custom-flow' },
      ],
      expect.any(Object),
    );
    expectNoSourceSelectionPrompt();
  });

  it('should use a single categorized menu and append user-defined workflows at the bottom when category config exists', async () => {
    const workflowMap = createWorkflowMap([
      { name: 'default', source: 'builtin' },
      { name: 'project-flow', source: 'project' },
    ]);
    const categoryConfig = { categories: ['Quick Start'] };
    const categorized: CategorizedWorkflows = {
      categories: [
        { name: 'Quick Start', workflows: ['default'], children: [] },
        { name: 'Others', workflows: ['project-flow'], children: [] },
      ],
      allWorkflows: workflowMap,
      missingWorkflows: [],
    };

    configMock.getWorkflowCategories.mockReturnValue(categoryConfig);
    configMock.loadAllStandaloneWorkflowsWithSources.mockReturnValue(workflowMap);
    configMock.buildCategorizedWorkflows.mockReturnValue(categorized);

    selectOptionMock.mockResolvedValueOnce('project-flow');

    const result = await selectWorkflow('/cwd');

    expect(result).toBe('project-flow');
    expect(configMock.loadAllStandaloneWorkflowsWithSources).toHaveBeenCalledWith('/cwd', {
      onWarning: uiMock.warn,
    });
    expect(configMock.buildCategorizedWorkflows).toHaveBeenCalledWith(
      workflowMap,
      categoryConfig,
      new Set(),
    );
    expect(selectOptionMock).toHaveBeenNthCalledWith(
      1,
      'Select workflow:',
      [
        { label: '📁 Quick Start/', value: '__custom_category__:Quick Start' },
        { label: '🎼 project-flow (project)', value: 'project-flow' },
      ],
      expect.any(Object),
    );
    expectNoSourceSelectionPrompt();
  });

  it('should forward invalid workflow warnings to UI in the category-based selection path', async () => {
    const workflowMap = createWorkflowMap([
      { name: 'my-workflow', source: 'user' },
    ]);
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

    selectOptionMock.mockResolvedValueOnce('my-workflow');

    const result = await selectWorkflow('/cwd');

    expect(result).toBe('my-workflow');
    expect(uiMock.warn).toHaveBeenCalledWith(
      'Workflow "broken" failed to load: steps.0.allowed_tools: Invalid input',
    );
    expect(selectOptionMock).toHaveBeenNthCalledWith(
      1,
      'Select workflow:',
      [{ label: '🎼 my-workflow (global)', value: 'my-workflow' }],
      expect.any(Object),
    );
  });

  it('should forward invalid workflow warnings to UI in the directory-based selection path', async () => {
    configMock.getWorkflowCategories.mockReturnValue(null);
    configMock.listStandaloneWorkflowEntries.mockImplementation(
      (_cwd: string, options?: { onWarning?: (message: string) => void }) => {
        options?.onWarning?.('Workflow "broken" failed to load: steps.0: Invalid input');
        return [
          { name: 'valid-flow', path: '/tmp/valid-flow.yaml', source: 'user' },
        ];
      },
    );

    selectOptionMock.mockResolvedValueOnce('valid-flow');

    const result = await selectWorkflow('/cwd');

    expect(result).toBe('valid-flow');
    expect(uiMock.warn).toHaveBeenCalledWith('Workflow "broken" failed to load: steps.0: Invalid input');
    expect(selectOptionMock).toHaveBeenNthCalledWith(
      1,
      'Select workflow:',
      [{ label: '🎼 valid-flow (global)', value: 'valid-flow' }],
      expect.any(Object),
    );
    expectNoSourceSelectionPrompt();
  });
});
