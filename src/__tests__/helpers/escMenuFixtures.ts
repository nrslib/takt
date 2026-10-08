import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { TaskListItem } from '../../infra/task/index.js';
import type { Provider } from '../../infra/providers/index.js';
import type { FormalSpecMode } from '../../core/models/config-types.js';
import type { FirstStepInfo } from '../../infra/config/index.js';
import type { TellableRunningTask } from '../../features/tasks/liveIntervention.js';
import type { SessionIndexEntry } from '../../infra/claude/session-reader.js';
import { attachWorkflowOpaqueRef } from '../../infra/config/loaders/workflowSourceMetadata.js';
import { createScenarioProvider, type CallScenario } from './stdinSimulator.js';

const menuMocks = vi.hoisted(() => ({
  formalSpec: false as FormalSpecMode,
  firstStep: undefined as FirstStepInfo | undefined,
  provider: undefined as Provider | undefined,
  listAllTaskItems: vi.fn<() => TaskListItem[]>(),
  requeueExceededTask: vi.fn(),
  requeueTask: vi.fn(),
  startReExecution: vi.fn(),
  completePublishedTask: vi.fn(),
  persistFailedTaskRetry: vi.fn(),
  stageAndCommit: vi.fn(),
  publishTaskBranch: vi.fn(),
  findExistingPr: vi.fn(),
  createPullRequestSafely: vi.fn(),
  loadWorkflow: vi.fn(),
  loadWorkflows: vi.fn(),
  loadRunSessionContext: vi.fn(),
  listRecentRuns: vi.fn(),
  updatePersonaSession: vi.fn(),
  inspectTellableRunningTasks: vi.fn(),
  issueTellableRunningTask: vi.fn(),
}));

export { menuMocks };

vi.mock('../../infra/config/global/globalConfig.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../infra/config/global/globalConfig.js')>()),
  loadGlobalConfig: () => ({ provider: 'mock', language: 'en' }),
}));

vi.mock('../../infra/config/project/projectConfig.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../infra/config/project/projectConfig.js')>()),
  loadProjectConfig: () => ({
    provider: 'mock', language: 'en', assistant: { formalSpec: menuMocks.formalSpec },
  }),
}));

vi.mock('../../infra/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../infra/config/index.js')>()),
  resolveConfigValues: () => ({ language: 'en', interactivePreviewSteps: 1 }),
  resolveWorkflowConfigValues: () => ({ language: 'en', interactivePreviewSteps: 1 }),
  resolveNonWorkflowProviderOptions: () => undefined,
  loadAllStandaloneWorkflowsWithSources: (...args: unknown[]) => menuMocks.loadWorkflows(...args),
  loadWorkflowByIdentifier: (...args: unknown[]) => menuMocks.loadWorkflow(...args),
  getWorkflowDescription: (): ReturnType<typeof import('../../infra/config/index.js').getWorkflowDescription> => ({
    name: 'menu-workflow', description: 'Menu workflow', workflowStructure: 'implement', stepPreviews: [], companionReviewMode: 'completion',
    firstStep: menuMocks.firstStep,
  }),
  takeSessionState: () => null,
  loadPersonaSessions: () => ({ 'interactive:mock': 'original-session' }),
  updatePersonaSession: (...args: unknown[]) => menuMocks.updatePersonaSession(...args),
}));

vi.mock('../../infra/providers/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../infra/providers/index.js')>()),
  getProvider: () => {
    if (menuMocks.provider === undefined) throw new Error('Provider fixture is missing');
    return menuMocks.provider;
  },
}));

vi.mock('../../infra/task/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../infra/task/index.js')>()),
  TaskRunner: class {
    listAllTaskItems() { return menuMocks.listAllTaskItems(); }
    requeueExceededTask(...args: unknown[]) { return menuMocks.requeueExceededTask(...args); }
    requeueTask(...args: unknown[]) { return menuMocks.requeueTask(...args); }
    startReExecution(...args: unknown[]) { return menuMocks.startReExecution(...args); }
    completePublishedTask(...args: unknown[]) { return menuMocks.completePublishedTask(...args); }
  },
  resolveCloneBaseDir: (cwd: string) => join(cwd, '.takt', 'worktrees'),
  localBranchExists: () => true,
  detectDefaultBranch: () => 'main',
  getCurrentBranch: () => 'takt/menu-task',
  stageAndCommit: (...args: unknown[]) => menuMocks.stageAndCommit(...args),
  publishTaskBranch: (...args: unknown[]) => menuMocks.publishTaskBranch(...args),
  resolveAutoCommitOptions: () => ({}),
}));

vi.mock('../../features/tasks/taskRetryPersistence.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../features/tasks/taskRetryPersistence.js')>()),
  persistFailedTaskRetry: (...args: unknown[]) => menuMocks.persistFailedTaskRetry(...args),
}));

vi.mock('../../infra/git/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../infra/git/index.js')>()),
  getGitProvider: () => ({ findExistingPr: menuMocks.findExistingPr }),
  createPullRequestSafely: (...args: unknown[]) => menuMocks.createPullRequestSafely(...args),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: vi.fn(() => ''),
}));

vi.mock('../../core/workflow/run/run-meta.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/workflow/run/run-meta.js')>()),
  readRunMetaBySlug: () => null,
}));

vi.mock('../../features/interactive/runSessionReader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../features/interactive/runSessionReader.js')>()),
  findRunForTask: () => null,
  listRecentRuns: (...args: unknown[]) => menuMocks.listRecentRuns(...args),
  loadRunSessionContext: (...args: unknown[]) => menuMocks.loadRunSessionContext(...args),
}));

vi.mock('../../infra/claude/session-reader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../infra/claude/session-reader.js')>()),
  loadSessionIndex: (): SessionIndexEntry[] => [{
    sessionId: 'selected-session', firstPrompt: 'Previous conversation',
    modified: '2026-10-08T00:00:00Z', messageCount: 2, gitBranch: 'takt/menu-task', isSidechain: false, fullPath: '/fixture/session.jsonl',
  }],
  extractLastAssistantResponse: () => null,
}));

vi.mock('../../features/tasks/liveIntervention.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../features/tasks/liveIntervention.js')>()),
  inspectTellableRunningTasks: (...args: unknown[]) => menuMocks.inspectTellableRunningTasks(...args),
  issueTellableRunningTask: (...args: unknown[]) => menuMocks.issueTellableRunningTask(...args),
}));

export function createEscMenuFixture() {
  vi.clearAllMocks();
  menuMocks.formalSpec = false;
  menuMocks.firstStep = undefined;
  const cwd = mkdtempSync(join(process.cwd(), '.takt', 'esc-menu-'));
  const worktreePath = join(cwd, '.takt', 'worktrees', 'menu-task');
  mkdirSync(worktreePath, { recursive: true });
  const workflow = attachWorkflowOpaqueRef({
    name: 'menu-workflow', initialStep: 'implement', maxSteps: 2,
    steps: [{ name: 'implement', personaDisplayName: 'Implement', instruction: 'Implement' }],
  }, 'project:menu-workflow');
  menuMocks.loadWorkflow.mockReturnValue(workflow);
  const workflows: ReturnType<typeof import('../../infra/config/index.js').loadAllStandaloneWorkflowsWithSources> =
    new Map([['menu-workflow', { config: workflow, source: 'project' }]]);
  menuMocks.loadWorkflows.mockReturnValue(workflows);
  menuMocks.listRecentRuns.mockReturnValue([{
    slug: 'previous-run', task: 'Keep scope', workflow: 'menu-workflow', status: 'completed', startTime: '2026-10-08T00:00:00Z',
  }]);
  menuMocks.loadRunSessionContext.mockReturnValue({
    task: 'Keep scope', workflow: 'menu-workflow', status: 'completed', stepLogs: [], reports: [],
  });
  menuMocks.stageAndCommit.mockResolvedValue(undefined);
  menuMocks.findExistingPr.mockReturnValue(undefined);
  menuMocks.createPullRequestSafely.mockReturnValue({ success: true, url: 'https://example.com/pr/1' });

  const task = (kind: TaskListItem['kind']): TaskListItem => ({
    kind, name: 'menu-task', content: 'Keep scope', summary: 'Keep scope',
    createdAt: '2026-10-08T00:00:00Z', filePath: join(cwd, '.takt', 'tasks.yaml'),
    worktreePath, branch: 'takt/menu-task',
    data: { task: 'Keep scope', workflow: 'menu-workflow', start_step: 'implement' },
    ...(kind === 'failed' ? { failure: { step: 'implement', error: 'Build failed' } } : {}),
  });
  const runningTarget: TellableRunningTask = {
    task: {
      kind: 'running', status: 'running', name: 'running-task', summary: 'Keep scope',
      createdAt: '2026-10-08T00:00:00Z', filePath: join(cwd, '.takt', 'tasks.yaml'),
      worktreePath, worktree: true, workflow: 'menu-workflow', runSlug: 'running-run',
    },
    runSlug: 'running-run', worktreePath,
    meta: {
      task: 'Keep scope', workflow: 'menu-workflow', runSlug: 'running-run', status: 'running',
      currentStep: 'implement', startTime: '2026-10-08T00:00:00Z',
      runRoot: worktreePath, reportDirectory: 'reports', contextDirectory: 'context', logsDirectory: 'logs',
    },
  };
  menuMocks.inspectTellableRunningTasks.mockReturnValue({ tasks: [runningTarget], excluded: [] });
  menuMocks.issueTellableRunningTask.mockResolvedValue({ instructionId: 1, target: runningTarget });

  return {
    cwd, worktreePath, workflow, task,
    provider(scenarios: CallScenario[]) {
      const { provider, capture } = createScenarioProvider(scenarios);
      menuMocks.provider = provider;
      return capture;
    },
    cleanup() {
      menuMocks.provider = undefined;
      menuMocks.firstStep = undefined;
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}
