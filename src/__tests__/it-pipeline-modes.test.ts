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
import { setMockScenario, resetScenario } from '../mock/scenario.js';

// --- Mocks ---

const {
  mockFetchIssue,
  mockFormatIssueAsTask,
  mockCheckGhCli,
  mockCreatePullRequest,
  mockPushBranch,
} = vi.hoisted(() => ({
  mockFetchIssue: vi.fn(),
  mockFormatIssueAsTask: vi.fn(),
  mockCheckGhCli: vi.fn(),
  mockCreatePullRequest: vi.fn(),
  mockPushBranch: vi.fn(),
}));

vi.mock('../claude/client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../claude/client.js')>();
  return {
    ...original,
    callAiJudge: vi.fn().mockResolvedValue(-1),
  };
});

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../github/issue.js', () => ({
  fetchIssue: mockFetchIssue,
  formatIssueAsTask: mockFormatIssueAsTask,
  checkGhCli: mockCheckGhCli,
}));

vi.mock('../github/pr.js', () => ({
  createPullRequest: mockCreatePullRequest,
  pushBranch: mockPushBranch,
  buildPrBody: vi.fn().mockReturnValue('PR body'),
}));

vi.mock('../task/git.js', () => ({
  stageAndCommit: vi.fn().mockReturnValue('abc1234'),
}));

vi.mock('../utils/ui.js', () => ({
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

vi.mock('../utils/notification.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
}));

vi.mock('../utils/session.js', () => ({
  generateSessionId: vi.fn().mockReturnValue('test-session-id'),
  createSessionLog: vi.fn().mockReturnValue({
    startTime: new Date().toISOString(),
    iterations: 0,
  }),
  finalizeSessionLog: vi.fn().mockImplementation((log, status) => ({ ...log, status })),
  updateLatestPointer: vi.fn(),
  initNdjsonLog: vi.fn().mockReturnValue('/tmp/test.ndjson'),
  appendNdjsonLine: vi.fn(),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

vi.mock('../config/paths.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../config/paths.js')>();
  return {
    ...original,
    loadAgentSessions: vi.fn().mockReturnValue({}),
    updateAgentSession: vi.fn(),
    loadWorktreeSessions: vi.fn().mockReturnValue({}),
    updateWorktreeSession: vi.fn(),
    getCurrentWorkflow: vi.fn().mockReturnValue('default'),
    getProjectConfigDir: vi.fn().mockImplementation((cwd: string) => join(cwd, '.takt')),
  };
});

vi.mock('../config/globalConfig.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../config/globalConfig.js')>();
  return {
    ...original,
    loadGlobalConfig: vi.fn().mockReturnValue({}),
    getLanguage: vi.fn().mockReturnValue('en'),
    getDisabledBuiltins: vi.fn().mockReturnValue([]),
  };
});

vi.mock('../config/projectConfig.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../config/projectConfig.js')>();
  return {
    ...original,
    loadProjectConfig: vi.fn().mockReturnValue({}),
  };
});

vi.mock('../cli.js', () => ({
  isQuietMode: vi.fn().mockReturnValue(true),
}));

vi.mock('../prompt/index.js', () => ({
  selectOption: vi.fn().mockResolvedValue('stop'),
  promptInput: vi.fn().mockResolvedValue(null),
}));

vi.mock('../workflow/phase-runner.js', () => ({
  needsStatusJudgmentPhase: vi.fn().mockReturnValue(false),
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue(''),
}));

// --- Imports (after mocks) ---

import { executePipeline } from '../commands/pipelineExecution.js';
import {
  EXIT_ISSUE_FETCH_FAILED,
  EXIT_WORKFLOW_FAILED,
  EXIT_PR_CREATION_FAILED,
} from '../exitCodes.js';

// --- Test helpers ---

function createTestWorkflowDir(): { dir: string; workflowPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'takt-it-pm-'));
  mkdirSync(join(dir, '.takt', 'reports', 'test-report-dir'), { recursive: true });

  const agentsDir = join(dir, 'agents');
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, 'planner.md'), 'You are a planner.');
  writeFileSync(join(agentsDir, 'coder.md'), 'You are a coder.');
  writeFileSync(join(agentsDir, 'reviewer.md'), 'You are a reviewer.');

  const workflowYaml = `
name: it-pipeline
description: Pipeline test workflow
max_iterations: 10
initial_step: plan

steps:
  - name: plan
    agent: ./agents/planner.md
    rules:
      - condition: Requirements are clear
        next: implement
      - condition: Requirements unclear
        next: ABORT
    instruction: "{task}"

  - name: implement
    agent: ./agents/coder.md
    rules:
      - condition: Implementation complete
        next: review
      - condition: Cannot proceed
        next: plan
    instruction: "{task}"

  - name: review
    agent: ./agents/reviewer.md
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
    { agent: 'planner', status: 'done', content: '[PLAN:1]\n\nRequirements are clear.' },
    { agent: 'coder', status: 'done', content: '[IMPLEMENT:1]\n\nImplementation complete.' },
    { agent: 'reviewer', status: 'done', content: '[REVIEW:1]\n\nAll checks passed.' },
  ]);
}

describe('Pipeline Modes IT: --task + --workflow path', () => {
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
      { agent: 'planner', status: 'done', content: '[PLAN:2]\n\nRequirements unclear.' },
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

  it('should load and execute builtin simple workflow by name', async () => {
    setMockScenario([
      { agent: 'planner', status: 'done', content: '[PLAN:1]\n\nRequirements are clear.' },
      { agent: 'coder', status: 'done', content: '[IMPLEMENT:1]\n\nImplementation complete.' },
      { agent: 'ai-antipattern-reviewer', status: 'done', content: '[AI_REVIEW:1]\n\nNo issues.' },
      { agent: 'architecture-reviewer', status: 'done', content: '[REVIEW:1]\n\nNo issues found.' },
      { agent: 'supervisor', status: 'done', content: '[SUPERVISE:1]\n\nAll checks passed.' },
    ]);

    const exitCode = await executePipeline({
      task: 'Add a feature',
      workflow: 'simple',
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
    expect(mockFetchIssue).toHaveBeenCalledWith(42);
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
      { agent: 'planner', status: 'done', content: '[PLAN:1]\n\nClear.' },
      { agent: 'coder', status: 'done', content: '[IMPLEMENT:1]\n\nDone.' },
      // First review: issues found → back to implement
      { agent: 'reviewer', status: 'done', content: '[REVIEW:2]\n\nIssues found.' },
      // Fix
      { agent: 'coder', status: 'done', content: '[IMPLEMENT:1]\n\nFixed.' },
      // Second review: passed
      { agent: 'reviewer', status: 'done', content: '[REVIEW:1]\n\nAll checks passed.' },
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
