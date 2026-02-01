/**
 * Pipeline integration tests.
 *
 * Uses mock provider + scenario queue for end-to-end testing
 * of the pipeline execution flow. Git operations are skipped via --skip-git.
 *
 * Mocked: git operations (child_process), GitHub API, UI output, notifications, session
 * Not mocked: executeTask, executeWorkflow, WorkflowEngine, runAgent, rule evaluation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setMockScenario, resetScenario } from '../mock/scenario.js';

// --- Mocks ---

// Safety net: prevent callAiJudge from calling real Claude CLI.
vi.mock('../claude/client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../claude/client.js')>();
  return {
    ...original,
    callAiJudge: vi.fn().mockResolvedValue(-1),
  };
});

// Git operations (even with --skip-git, some imports need to be available)
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../github/issue.js', () => ({
  fetchIssue: vi.fn(),
  formatIssueAsTask: vi.fn(),
  checkGhCli: vi.fn(),
}));

vi.mock('../github/pr.js', () => ({
  createPullRequest: vi.fn(),
  pushBranch: vi.fn(),
  buildPrBody: vi.fn().mockReturnValue('PR body'),
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

// --- Test helpers ---

/** Create a minimal test workflow YAML + agent files in a temp directory */
function createTestWorkflowDir(): { dir: string; workflowPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'takt-it-pipeline-'));

  // Create .takt/reports structure
  mkdirSync(join(dir, '.takt', 'reports', 'test-report-dir'), { recursive: true });

  // Create agent prompt files
  const agentsDir = join(dir, 'agents');
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, 'planner.md'), 'You are a planner. Analyze the task.');
  writeFileSync(join(agentsDir, 'coder.md'), 'You are a coder. Implement the task.');
  writeFileSync(join(agentsDir, 'reviewer.md'), 'You are a reviewer. Review the code.');

  // Create a simple workflow YAML
  const workflowYaml = `
name: it-simple
description: Integration test workflow
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

describe('Pipeline Integration Tests', () => {
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

  it('should complete pipeline with workflow path + skip-git + mock scenario', async () => {
    // Scenario: plan -> implement -> review -> COMPLETE
    // agent field must match extractAgentName(step.agent), i.e., the .md filename without extension
    setMockScenario([
      { agent: 'planner', status: 'done', content: '[PLAN:1]\n\nPlan completed. Requirements are clear.' },
      { agent: 'coder', status: 'done', content: '[IMPLEMENT:1]\n\nImplementation complete.' },
      { agent: 'reviewer', status: 'done', content: '[REVIEW:1]\n\nAll checks passed.' },
    ]);

    const exitCode = await executePipeline({
      task: 'Add a hello world function',
      workflow: workflowPath,
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      provider: 'mock',
    });

    expect(exitCode).toBe(0);
  });

  it('should complete pipeline with workflow name + skip-git + mock scenario', async () => {
    // Use builtin 'simple' workflow
    // agent field: extractAgentName result (from .md filename)
    // tag in content: [STEP_NAME:N] where STEP_NAME is the step name uppercased
    setMockScenario([
      { agent: 'planner', status: 'done', content: '[PLAN:1]\n\nRequirements are clear and implementable.' },
      { agent: 'coder', status: 'done', content: '[IMPLEMENT:1]\n\nImplementation complete.' },
      { agent: 'ai-antipattern-reviewer', status: 'done', content: '[AI_REVIEW:1]\n\nNo AI-specific issues.' },
      { agent: 'architecture-reviewer', status: 'done', content: '[REVIEW:1]\n\nNo issues found.' },
      { agent: 'supervisor', status: 'done', content: '[SUPERVISE:1]\n\nAll checks passed.' },
    ]);

    const exitCode = await executePipeline({
      task: 'Add a hello world function',
      workflow: 'simple',
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      provider: 'mock',
    });

    expect(exitCode).toBe(0);
  });

  it('should return EXIT_WORKFLOW_FAILED for non-existent workflow', async () => {
    const exitCode = await executePipeline({
      task: 'Test task',
      workflow: 'non-existent-workflow-xyz',
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      provider: 'mock',
    });

    // executeTask returns false when workflow not found → executePipeline returns EXIT_WORKFLOW_FAILED (3)
    expect(exitCode).toBe(3);
  });

  it('should handle ABORT transition from workflow', async () => {
    // Scenario: plan returns second rule -> ABORT
    setMockScenario([
      { agent: 'planner', status: 'done', content: '[PLAN:2]\n\nRequirements unclear, insufficient info.' },
    ]);

    const exitCode = await executePipeline({
      task: 'Vague task with no details',
      workflow: workflowPath,
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      provider: 'mock',
    });

    // ABORT means workflow failed -> EXIT_WORKFLOW_FAILED (3)
    expect(exitCode).toBe(3);
  });

  it('should handle review reject → implement → review loop', async () => {
    setMockScenario([
      // First pass
      { agent: 'planner', status: 'done', content: '[PLAN:1]\n\nRequirements are clear.' },
      { agent: 'coder', status: 'done', content: '[IMPLEMENT:1]\n\nDone.' },
      { agent: 'reviewer', status: 'done', content: '[REVIEW:2]\n\nIssues found.' },
      // Fix loop
      { agent: 'coder', status: 'done', content: '[IMPLEMENT:1]\n\nFixed.' },
      { agent: 'reviewer', status: 'done', content: '[REVIEW:1]\n\nAll checks passed.' },
    ]);

    const exitCode = await executePipeline({
      task: 'Task needing a fix',
      workflow: workflowPath,
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      provider: 'mock',
    });

    expect(exitCode).toBe(0);
  });
});
