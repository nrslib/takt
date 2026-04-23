/**
 * Pipeline execution mode integration tests.
 *
 * Tests various --pipeline mode option combinations including:
 * - --task, --issue, --skip-git, --auto-pr, --workflow (name/path), --provider, --model
 * - Exit codes for different failure scenarios
 *
 * Mocked: git (child_process), GitHub API, UI, notifications, session, phase-runner, config
 * Not mocked: executePipeline, executeTask, WorkflowEngine, runAgent, rule evaluation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setMockScenario, resetScenario } from '../infra/mock/index.js';

// --- Mocks ---

const {
  mockFetchIssue,
  mockFormatIssueAsTask,
  mockCheckGhCli,
  mockCreatePullRequest,
  mockBuildTaktManagedPrOptions,
  mockCreatePullRequestSafely,
  mockPushBranch,
  mockStripTaktManagedPrMarker,
} = vi.hoisted(() => ({
  mockFetchIssue: vi.fn(),
  mockFormatIssueAsTask: vi.fn(),
  mockCheckGhCli: vi.fn(),
  mockCreatePullRequest: vi.fn(),
  mockBuildTaktManagedPrOptions: vi.fn((body: string) => ({
    body: `${body}\n\n<!-- takt:managed -->`,
  })),
  mockCreatePullRequestSafely: vi.fn(),
  mockPushBranch: vi.fn(),
  mockStripTaktManagedPrMarker: vi.fn((body: string) => body
    .split('<!-- takt:managed -->')
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()),
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../infra/git/index.js', () => ({
  getGitProvider: () => ({
    checkCliStatus: (...args: unknown[]) => mockCheckGhCli(...args),
    fetchIssue: (...args: unknown[]) => mockFetchIssue(...args),
    createPullRequest: (...args: unknown[]) => mockCreatePullRequest(...args),
  }),
  formatIssueAsTask: (...args: unknown[]) => mockFormatIssueAsTask(...args),
  buildPrBody: vi.fn().mockReturnValue('PR body'),
  buildTaktManagedPrOptions: (...args: unknown[]) => mockBuildTaktManagedPrOptions(...args as [string]),
  stripTaktManagedPrMarker: (...args: unknown[]) => mockStripTaktManagedPrMarker(...args as [string]),
  formatPrReviewAsTask: vi.fn(),
  createPullRequestSafely: (...args: unknown[]) => mockCreatePullRequestSafely(...args),
}));

vi.mock('../infra/task/git.js', () => ({
  stageAndCommit: vi.fn().mockReturnValue('abc1234'),
  getCurrentBranch: vi.fn().mockReturnValue('main'),
  pushBranch: (...args: unknown[]) => mockPushBranch(...args),
}));

vi.mock('../shared/ui/index.js', () => ({
  header: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  status: vi.fn(),
  blankLine: vi.fn(),
  StreamDisplay: vi.fn().mockImplementation(() => ({
    createHandler: () => vi.fn(),
    flush: vi.fn(),
  })),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  generateSessionId: vi.fn().mockReturnValue('test-session-id'),
  createSessionLog: vi.fn().mockReturnValue({
    startTime: new Date().toISOString(),
    iterations: 0,
  }),
  finalizeSessionLog: vi.fn().mockImplementation((log, status) => ({ ...log, status })),
  initNdjsonLog: vi.fn().mockReturnValue('/tmp/test.ndjson'),
  appendNdjsonLine: vi.fn(),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

vi.mock('../infra/config/paths.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../infra/config/paths.js')>();
  return {
    ...original,
    loadPersonaSessions: vi.fn().mockReturnValue({}),
    updatePersonaSession: vi.fn(),
    loadWorktreeSessions: vi.fn().mockReturnValue({}),
    updateWorktreeSession: vi.fn(),
    getProjectConfigDir: vi.fn().mockImplementation((cwd: string) => join(cwd, '.takt')),
  };
});

vi.mock('../infra/config/global/globalConfig.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../infra/config/global/globalConfig.js')>();
  return {
    ...original,
    loadGlobalConfig: vi.fn().mockReturnValue({
      language: 'en',
      provider: 'mock',
      enableBuiltinWorkflows: true,
      disabledBuiltins: [],
    }),
    getLanguage: vi.fn().mockReturnValue('en'),
    getDisabledBuiltins: vi.fn().mockReturnValue([]),
  };
});

vi.mock('../infra/config/project/projectConfig.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../infra/config/project/projectConfig.js')>();
  return {
    ...original,
    loadProjectConfig: vi.fn().mockReturnValue({}),
  };
});

vi.mock('../shared/context.js', () => ({
  isQuietMode: vi.fn().mockReturnValue(true),
}));

vi.mock('../shared/prompt/index.js', () => ({
  selectOption: vi.fn().mockResolvedValue('stop'),
  promptInput: vi.fn().mockResolvedValue(null),
}));

vi.mock('../core/workflow/phase-runner.js', () => ({
  needsStatusJudgmentPhase: vi.fn().mockReturnValue(false),
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ tag: '', ruleIndex: 0, method: 'auto_select' }),
}));

// --- Imports (after mocks) ---

import { executePipeline } from '../features/pipeline/index.js';
import {
  EXIT_ISSUE_FETCH_FAILED,
  EXIT_WORKFLOW_FAILED,
  EXIT_PR_CREATION_FAILED,
} from '../shared/exitCodes.js';

// --- Test helpers ---

function createTestWorkflowDir(): { dir: string; workflowPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'takt-it-pm-'));
  mkdirSync(join(dir, '.takt', 'reports', 'test-report-dir'), { recursive: true });

  const personasDir = join(dir, '.takt', 'personas');
  mkdirSync(personasDir, { recursive: true });
  writeFileSync(join(personasDir, 'planner.md'), 'You are a planner.');
  writeFileSync(join(personasDir, 'coder.md'), 'You are a coder.');
  writeFileSync(join(personasDir, 'reviewer.md'), 'You are a reviewer.');

  const workflowYaml = `
name: it-pipeline
description: Pipeline test workflow
max_steps: 10
initial_step: plan

steps:
  - name: plan
    persona: ./.takt/personas/planner.md
    rules:
      - condition: Requirements are clear
        next: implement
      - condition: Requirements unclear
        next: ABORT
    instruction: "{task}"

  - name: implement
    persona: ./.takt/personas/coder.md
    rules:
      - condition: Implementation complete
        next: review
      - condition: Cannot proceed
        next: plan
    instruction: "{task}"

  - name: review
    persona: ./.takt/personas/reviewer.md
    rules:
      - condition: All checks passed
        next: COMPLETE
      - condition: Issues found
        next: implement
    instruction: "{task}"
`;

  const workflowPath = join(dir, 'workflow.yaml');
  writeFileSync(workflowPath, workflowYaml);

  return { dir, workflowPath };
}

function happyScenario(): void {
  setMockScenario([
    { persona: 'planner', status: 'done', content: '[PLAN:1]\n\nRequirements are clear.' },
    { persona: 'coder', status: 'done', content: '[IMPLEMENT:1]\n\nImplementation complete.' },
    { persona: 'reviewer', status: 'done', content: '[REVIEW:1]\n\nAll checks passed.' },
  ]);
}

describe('Pipeline Modes IT: --task + --workflow path', () => {
  let testDir: string;
  let workflowPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildTaktManagedPrOptions.mockImplementation((body: string) => ({
      body: `${body}\n\n<!-- takt:managed -->`,
    }));
    mockCreatePullRequestSafely.mockImplementation((provider, options, cwd) => {
      try {
        return provider.createPullRequest(options, cwd);
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
    const setup = createTestWorkflowDir();
    testDir = setup.dir;
    workflowPath = setup.workflowPath;
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should return exit code 0 on successful pipeline', async () => {
    happyScenario();

    const exitCode = await executePipeline({
      task: 'Add a feature',
      workflow: workflowPath,
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      provider: 'mock',
    });

    expect(exitCode).toBe(0);
  });

  it('should return EXIT_WORKFLOW_FAILED (3) on ABORT', async () => {
    setMockScenario([
      { persona: 'planner', status: 'done', content: '[PLAN:2]\n\nRequirements unclear.' },
    ]);

    const exitCode = await executePipeline({
      task: 'Vague task',
      workflow: workflowPath,
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      provider: 'mock',
    });

    expect(exitCode).toBe(EXIT_WORKFLOW_FAILED);
  });
});

describe('Pipeline Modes IT: --task + --workflow name (builtin)', () => {
  let testDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    const setup = createTestWorkflowDir();
    testDir = setup.dir;
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should load and execute builtin default workflow by name', async () => {
    // Flow: plan → write_tests → implement → ai_review → reviewers(arch-review + supervise) → COMPLETE
    setMockScenario([
      { persona: 'planner', status: 'done', content: '[PLAN:1]\n\nRequirements are clear and implementable' },
      { persona: 'coder', status: 'done', content: '[WRITE_TESTS:1]\n\nTests written successfully' },
      { persona: 'coder', status: 'done', content: '[IMPLEMENT:1]\n\nImplementation complete' },
      { persona: 'ai-antipattern-reviewer', status: 'done', content: '[AI_REVIEW:1]\n\nNo AI-specific issues' },
      { persona: 'architecture-reviewer', status: 'done', content: '[ARCH-REVIEW:1]\n\napproved' },
      { persona: 'supervisor', status: 'done', content: '[SUPERVISE:1]\n\nAll checks passed' },
    ]);

    const exitCode = await executePipeline({
      task: 'Add a feature',
      workflow: 'default',
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      provider: 'mock',
    });

    expect(exitCode).toBe(0);
  });

  it('should return EXIT_WORKFLOW_FAILED for non-existent workflow name', async () => {
    const exitCode = await executePipeline({
      task: 'Test task',
      workflow: 'non-existent-workflow-xyz',
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      provider: 'mock',
    });

    expect(exitCode).toBe(EXIT_WORKFLOW_FAILED);
  });
});

describe('Pipeline Modes IT: --issue', () => {
  let testDir: string;
  let workflowPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    const setup = createTestWorkflowDir();
    testDir = setup.dir;
    workflowPath = setup.workflowPath;
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should fetch issue and execute workflow', async () => {
    mockCheckGhCli.mockReturnValue({ available: true });
    mockFetchIssue.mockReturnValue({
      number: 42,
      title: 'Fix the bug',
      body: 'Details here',
    });
    mockFormatIssueAsTask.mockReturnValue('Fix the bug\n\nDetails here');
    happyScenario();

    const exitCode = await executePipeline({
      issueNumber: 42,
      workflow: workflowPath,
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      provider: 'mock',
    });

    expect(exitCode).toBe(0);
    expect(mockFetchIssue).toHaveBeenCalledWith(42, testDir);
  });

  it('should return EXIT_ISSUE_FETCH_FAILED when gh CLI unavailable', async () => {
    mockCheckGhCli.mockReturnValue({ available: false, error: 'gh not found' });

    const exitCode = await executePipeline({
      issueNumber: 42,
      workflow: workflowPath,
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      provider: 'mock',
    });

    expect(exitCode).toBe(EXIT_ISSUE_FETCH_FAILED);
  });

  it('should return EXIT_ISSUE_FETCH_FAILED when issue fetch throws', async () => {
    mockCheckGhCli.mockReturnValue({ available: true });
    mockFetchIssue.mockImplementation(() => {
      throw new Error('Issue not found');
    });

    const exitCode = await executePipeline({
      issueNumber: 999,
      workflow: workflowPath,
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      provider: 'mock',
    });

    expect(exitCode).toBe(EXIT_ISSUE_FETCH_FAILED);
  });

  it('should return EXIT_ISSUE_FETCH_FAILED when neither --issue nor --task specified', async () => {
    const exitCode = await executePipeline({
      workflow: workflowPath,
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      provider: 'mock',
    });

    expect(exitCode).toBe(EXIT_ISSUE_FETCH_FAILED);
  });
});

describe('Pipeline Modes IT: --auto-pr', () => {
  let testDir: string;
  let workflowPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    const setup = createTestWorkflowDir();
    testDir = setup.dir;
    workflowPath = setup.workflowPath;
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should create PR on success when --auto-pr is set (without --skip-git)', async () => {
    happyScenario();
    mockCreatePullRequest.mockReturnValue({ success: true, url: 'https://github.com/test/pr/1' });

    const exitCode = await executePipeline({
      task: 'Add a feature',
      workflow: workflowPath,
      autoPr: true,
      skipGit: false,
      cwd: testDir,
      provider: 'mock',
    });

    expect(exitCode).toBe(0);
    expect(mockCreatePullRequest).toHaveBeenCalled();
    expect(mockBuildTaktManagedPrOptions).not.toHaveBeenCalled();
  });

  it('should return EXIT_PR_CREATION_FAILED when PR creation fails', async () => {
    happyScenario();
    mockCreatePullRequest.mockReturnValue({ success: false, error: 'Rate limited' });

    const exitCode = await executePipeline({
      task: 'Add a feature',
      workflow: workflowPath,
      autoPr: true,
      skipGit: false,
      cwd: testDir,
      provider: 'mock',
    });

    expect(exitCode).toBe(EXIT_PR_CREATION_FAILED);
  });

  it('should skip PR creation when --auto-pr and --skip-git are both set', async () => {
    happyScenario();

    const exitCode = await executePipeline({
      task: 'Add a feature',
      workflow: workflowPath,
      autoPr: true,
      skipGit: true,
      cwd: testDir,
      provider: 'mock',
    });

    expect(exitCode).toBe(0);
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
  });
});

describe('Pipeline Modes IT: --provider and --model overrides', () => {
  let testDir: string;
  let workflowPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    const setup = createTestWorkflowDir();
    testDir = setup.dir;
    workflowPath = setup.workflowPath;
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should pass provider override to workflow execution', async () => {
    happyScenario();

    const exitCode = await executePipeline({
      task: 'Test task',
      workflow: workflowPath,
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      provider: 'mock',
    });

    expect(exitCode).toBe(0);
  });

  it('should pass model override to workflow execution', async () => {
    happyScenario();

    const exitCode = await executePipeline({
      task: 'Test task',
      workflow: workflowPath,
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      provider: 'mock',
      model: 'opus',
    });

    expect(exitCode).toBe(0);
  });
});

describe('Pipeline Modes IT: review → fix loop', () => {
  let testDir: string;
  let workflowPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    const setup = createTestWorkflowDir();
    testDir = setup.dir;
    workflowPath = setup.workflowPath;
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should handle review → implement → review loop', async () => {
    setMockScenario([
      { persona: 'planner', status: 'done', content: '[PLAN:1]\n\nClear.' },
      { persona: 'coder', status: 'done', content: '[IMPLEMENT:1]\n\nDone.' },
      // First review: issues found → back to implement
      { persona: 'reviewer', status: 'done', content: '[REVIEW:2]\n\nIssues found.' },
      // Fix
      { persona: 'coder', status: 'done', content: '[IMPLEMENT:1]\n\nFixed.' },
      // Second review: passed
      { persona: 'reviewer', status: 'done', content: '[REVIEW:1]\n\nAll checks passed.' },
    ]);

    const exitCode = await executePipeline({
      task: 'Task with fix loop',
      workflow: workflowPath,
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      provider: 'mock',
    });

    expect(exitCode).toBe(0);
  });
});
