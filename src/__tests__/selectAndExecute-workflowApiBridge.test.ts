import { describe, expect, it, vi, beforeEach } from 'vitest';

const {
  mockExecuteTaskWorkflow,
  mockLoadWorkflowByIdentifier,
  mockIsWorkflowPath,
} = vi.hoisted(() => ({
  mockExecuteTaskWorkflow: vi.fn(),
  mockLoadWorkflowByIdentifier: vi.fn(),
  mockIsWorkflowPath: vi.fn(() => false),
}));

vi.mock('../shared/prompt/index.js', () => ({
}));

vi.mock('../infra/config/index.js', () => ({
  loadWorkflowByIdentifier: (...args: unknown[]) => mockLoadWorkflowByIdentifier(...args),
  isWorkflowPath: (...args: unknown[]) => mockIsWorkflowPath(...args),
  resolveWorkflowConfigValues: vi.fn(() => ({
    language: 'en',
    personaProviders: {},
    providerRouting: {},
    providerProfiles: {},
  })),
  listWorkflows: vi.fn(() => ['default']),
  listWorkflowEntries: vi.fn(() => []),
}));

vi.mock('../infra/config/resolveConfigValue.js', () => ({
  resolveProviderOptionsWithTrace: vi.fn(() => ({
    value: undefined,
    source: undefined,
    originResolver: undefined,
  })),
}));

vi.mock('../infra/task/index.js', () => ({
  createSharedClone: vi.fn(),
  autoCommitAndPush: vi.fn(),
  summarizeTaskName: vi.fn(),
  resolveBaseBranch: vi.fn(() => ({ branch: 'main' })),
  buildTaskInstruction: vi.fn((_taskDir: string, orderFile: string) => `Primary spec: \`${orderFile}\`.`),
  TaskRunner: vi.fn(() => ({
    addTask: vi.fn(),
  })),
}));

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  success: vi.fn(),
  withProgress: async <T>(
    _startMessage: string,
    _completionMessage: string | ((result: T) => string),
    operation: () => Promise<T>,
  ): Promise<T> => operation(),
}));

vi.mock('../shared/ui/StatusLine.js', () => ({
  statusLine: {
    start: vi.fn(),
    stop: vi.fn(),
  },
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../infra/github/index.js', () => ({
  buildPrBody: vi.fn(),
}));

vi.mock('../features/tasks/execute/taskWorkflowExecution.js', () => ({
  executeTaskWorkflow: (...args: unknown[]) => mockExecuteTaskWorkflow(...args),
}));

vi.mock('../features/workflowSelection/index.js', () => ({
  selectWorkflow: vi.fn(),
}));

import { selectAndExecuteTask } from '../features/tasks/execute/selectAndExecute.js';

describe('selectAndExecuteTask workflow execution API bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadWorkflowByIdentifier.mockReturnValue({ name: 'default', steps: [] });
    mockExecuteTaskWorkflow.mockResolvedValue({ success: true });
  });

  it('routes direct CLI execution through runWorkflowExecution before the workflow executor', async () => {
    await selectAndExecuteTask('/project', 'Bridge CLI path', {
      workflow: 'default',
      skipTaskList: true,
    });

    expect(mockExecuteTaskWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        task: 'Bridge CLI path',
        cwd: '/project',
        projectCwd: '/project',
        workflowIdentifier: 'default',
      }),
      expect.any(Function),
    );
  });
});
