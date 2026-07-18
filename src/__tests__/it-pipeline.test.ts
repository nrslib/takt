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
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { setMockScenario, resetScenario } from '../infra/mock/index.js';

const { mockWorkflowWarn } = vi.hoisted(() => ({
  mockWorkflowWarn: vi.fn(),
}));

// --- Mocks ---

// Git operations (even with --skip-git, some imports need to be available)
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../infra/github/issue.js', () => ({
  fetchIssue: vi.fn(),
  formatIssueAsTask: vi.fn(),
  checkGhCli: vi.fn(),
}));

vi.mock('../infra/github/pr.js', () => ({
  createPullRequest: vi.fn(),
  buildPrBody: vi.fn().mockReturnValue('PR body'),
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

vi.mock('../shared/utils/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../shared/utils/index.js')>();
  return {
    ...original,
    createLogger: (name: string) => {
      const logger = original.createLogger(name);
      return name === 'workflow' ? { ...logger, warn: mockWorkflowWarn } : logger;
    },
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
  };
});

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
  };
});

vi.mock('../infra/config/project/projectConfig.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../infra/config/project/projectConfig.js')>();
  return {
    ...original,
    loadProjectConfig: vi.fn(original.loadProjectConfig),
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
import { loadGlobalConfig } from '../infra/config/global/globalConfig.js';
import type { UsageEventLogRecord } from '../core/logging/usageEvent.js';

const mockExecFileSync = vi.mocked(execFileSync);

// --- Test helpers ---

/** Create a minimal test workflow YAML + agent files in a temp directory */
function createTestWorkflowDir(): { dir: string; workflowPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'takt-it-pipeline-'));

  // Create .takt/runs structure
  mkdirSync(join(dir, '.takt', 'runs', 'test-report-dir', 'reports'), { recursive: true });

  // Create persona prompt files
  const personasDir = join(dir, '.takt', 'personas');
  mkdirSync(personasDir, { recursive: true });
  writeFileSync(join(personasDir, 'planner.md'), 'You are a planner. Analyze the task.');
  writeFileSync(join(personasDir, 'coder.md'), 'You are a coder. Implement the task.');
  writeFileSync(join(personasDir, 'reviewer.md'), 'You are a reviewer. Review the code.');

  // Create a simple workflow YAML
  const workflowYaml = `
name: it-simple
description: Integration test workflow
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

function writeChildAutoRoutingWorkflow(dir: string, parallel: boolean): string {
  const workflowsDir = join(dir, '.takt', 'workflows');
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(join(workflowsDir, 'child-auto.yaml'), `name: child-auto
subworkflow:
  callable: true
workflow_config:
  provider: mock
auto_routing:
  strategy: balanced
  router:
    provider: mock
    model: mock/router-model
  candidates:
    - name: low
      description: Low-cost candidate
      provider: mock
      model: mock/low-model
      cost_tier: low
    - name: medium
      description: Balanced candidate
      provider: mock
      model: mock/medium-model
      cost_tier: medium
    - name: high
      description: High-performance candidate
      provider: mock
      model: mock/high-model
      cost_tier: high
initial_step: child-step
max_steps: 2
steps:
  - name: child-step
    persona: ./.takt/personas/coder.md
    instruction: Run child work
    rules:
      - condition: done
        next: COMPLETE
`);
  const workflowPath = join(dir, parallel ? 'parallel-parent.yaml' : 'direct-parent.yaml');
  const delegate = parallel
    ? `  - name: delegate
    parallel:
      - name: call-child
        kind: workflow_call
        call: child-auto
        rules:
          - condition: COMPLETE
            next: COMPLETE
    rules:
      - condition: all("COMPLETE")
        next: COMPLETE`
    : `  - name: delegate
    kind: workflow_call
    call: child-auto
    rules:
      - condition: COMPLETE
        next: COMPLETE`;
  writeFileSync(workflowPath, `name: ${parallel ? 'parallel-parent' : 'direct-parent'}
initial_step: delegate
max_steps: 3
steps:
${delegate}
`);
  return workflowPath;
}

function readUsageEvents(dir: string): UsageEventLogRecord[] {
  const logsDir = join(dir, '.takt', 'runs', 'test-report-dir', 'logs');
  const file = readdirSync(logsDir).find((name) => name.endsWith('-usage-events.jsonl'));
  if (!file) {
    throw new Error('usage event log was not created');
  }
  return readFileSync(join(logsDir, file), 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as UsageEventLogRecord);
}

describe('Pipeline Integration Tests', () => {
  let testDir: string;
  let workflowPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadGlobalConfig).mockReturnValue({
      language: 'en',
      provider: 'mock',
      enableBuiltinWorkflows: true,
      disabledBuiltins: [],
    });
    mockExecFileSync.mockImplementation((_cmd, args) => {
      if (Array.isArray(args) && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
        return 'test/current\n' as never;
      }
      if (Array.isArray(args) && args[0] === 'symbolic-ref' && args[1] === 'refs/remotes/origin/HEAD') {
        return 'refs/remotes/origin/main\n' as never;
      }
      return '' as never;
    });
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
    // persona field must match extractPersonaName(step.persona), i.e., the .md filename without extension
    setMockScenario([
      { persona: 'planner', status: 'done', content: '[PLAN:1]\n\nPlan completed. Requirements are clear.' },
      { persona: 'coder', status: 'done', content: '[IMPLEMENT:1]\n\nImplementation complete.' },
      { persona: 'reviewer', status: 'done', content: '[REVIEW:1]\n\nAll checks passed.' },
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
    // Use builtin 'default' workflow
    // persona field: extractPersonaName result (from .md filename)
    // Flow: plan → write_tests → draft → peer-review reviewers(arch + ai-antipattern + coding) → final-gate → COMPLETE
    setMockScenario([
      { persona: 'planner', status: 'done', content: '[PLAN:1]\n\nRequirements are clear and implementable' },
      { persona: 'coder', status: 'done', content: '[WRITE_TESTS:1]\n\nTests written successfully' },
      { persona: 'coder', status: 'done', content: '[IMPLEMENT:1]\n\nImplementation complete' },
      { persona: 'ai-antipattern-reviewer', status: 'done', content: '[AI-ANTIPATTERN-REVIEW-1ST:1]\n\nNo AI-specific issues' },
      { persona: 'architecture-reviewer', status: 'done', content: '[ARCH-REVIEW:1]\n\napproved' },
      { persona: 'ai-antipattern-reviewer', status: 'done', content: '[AI-ANTIPATTERN-REVIEW-2ND:1]\n\nNo AI-specific issues' },
      { persona: 'coding-reviewer', status: 'done', content: '[CODING-REVIEW:1]\n\napproved' },
      { persona: 'merge-readiness-reviewer', status: 'done', content: '[MERGE-READINESS-REVIEW:1]\n\napproved' },
      { persona: 'supervisor', status: 'done', content: '[SUPERVISE:1]\n\napproved' },
    ]);

    const exitCode = await executePipeline({
      task: 'Add a hello world function',
      workflow: 'default',
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
      { persona: 'planner', status: 'done', content: '[PLAN:2]\n\nRequirements unclear, insufficient info.' },
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
      { persona: 'planner', status: 'done', content: '[PLAN:1]\n\nRequirements are clear.' },
      { persona: 'coder', status: 'done', content: '[IMPLEMENT:1]\n\nDone.' },
      { persona: 'reviewer', status: 'done', content: '[REVIEW:2]\n\nIssues found.' },
      // Fix loop
      { persona: 'coder', status: 'done', content: '[IMPLEMENT:1]\n\nFixed.' },
      { persona: 'reviewer', status: 'done', content: '[REVIEW:1]\n\nAll checks passed.' },
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

  it.each([
    { name: 'direct workflow_call', parallel: false },
    { name: 'parallel workflow_call', parallel: true },
  ])('should apply child-only auto routing strategy through the real $name entrypoint', async ({ parallel }) => {
    workflowPath = writeChildAutoRoutingWorkflow(testDir, parallel);
    vi.mocked(loadGlobalConfig).mockReturnValue({
      language: 'en',
      provider: 'mock',
      enableBuiltinWorkflows: true,
      disabledBuiltins: [],
      logging: { usageEvents: true },
    });
    setMockScenario([
      { persona: 'auto-router', status: 'error', content: 'router unavailable' },
      { persona: 'coder', status: 'done', content: '[CHILD-STEP:1]\n\nDone.' },
    ]);

    const exitCode = await executePipeline({
      task: 'Run child-only automatic routing',
      workflow: workflowPath,
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      autoStrategy: 'performance',
    });

    expect(exitCode).toBe(0);
    expect(readUsageEvents(testDir)).toContainEqual(expect.objectContaining({
      step: 'child-step',
      provider: 'mock',
      provider_model: 'mock/high-model',
    }));
    expect(mockWorkflowWarn).not.toHaveBeenCalledWith(
      expect.stringMatching(/auto-strategy.*ignored/i),
    );
  });

  it.each([
    { name: 'root workflow', child: false },
    { name: 'workflow_call child', child: true },
  ])('should reject an invalid auto strategy tier without reporting it as unused for $name', async ({ child }) => {
    const invalidAutoRouting = `workflow_config:
  provider: mock
auto_routing:
  strategy: balanced
  router:
    provider: mock
    model: mock/router-model
  candidates:
    - name: medium
      description: Balanced candidate
      provider: mock
      model: mock/medium-model
      cost_tier: medium`;

    if (child) {
      const workflowsDir = join(testDir, '.takt', 'workflows');
      mkdirSync(workflowsDir, { recursive: true });
      writeFileSync(join(workflowsDir, 'invalid-auto.yaml'), `name: invalid-auto
subworkflow:
  callable: true
${invalidAutoRouting}
initial_step: child-step
max_steps: 2
steps:
  - name: child-step
    persona: ./.takt/personas/coder.md
    instruction: Run child work
    rules:
      - condition: done
        next: COMPLETE
`);
      workflowPath = join(testDir, 'invalid-auto-parent.yaml');
      writeFileSync(workflowPath, `name: invalid-auto-parent
initial_step: delegate
max_steps: 2
steps:
  - name: delegate
    kind: workflow_call
    call: invalid-auto
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
    } else {
      workflowPath = join(testDir, 'invalid-auto-root.yaml');
      writeFileSync(workflowPath, `name: invalid-auto-root
${invalidAutoRouting}
initial_step: implement
max_steps: 2
steps:
  - name: implement
    persona: ./.takt/personas/coder.md
    instruction: Run root work
    rules:
      - condition: done
        next: COMPLETE
`);
    }

    const execution = executePipeline({
      task: 'Reject invalid automatic routing strategy',
      workflow: workflowPath,
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      autoStrategy: 'performance',
    });
    if (child) {
      await expect(execution).resolves.toBe(3);
    } else {
      await expect(execution).rejects.toThrow(/performance|high|candidate/i);
    }
    expect(mockWorkflowWarn).not.toHaveBeenCalledWith(
      expect.stringMatching(/auto-strategy.*ignored/i),
    );
  });

  it('should warn when a conditional workflow_call child with auto routing is not executed', async () => {
    writeChildAutoRoutingWorkflow(testDir, false);
    workflowPath = join(testDir, 'conditional-parent.yaml');
    writeFileSync(workflowPath, `name: conditional-parent
initial_step: choose
max_steps: 3
steps:
  - name: choose
    persona: ./.takt/personas/coder.md
    instruction: Choose whether to run child work
    rules:
      - condition: skip child
        next: finish
      - condition: run child
        next: delegate
  - name: delegate
    kind: workflow_call
    call: child-auto
    rules:
      - condition: COMPLETE
        next: COMPLETE
  - name: finish
    persona: ./.takt/personas/coder.md
    instruction: Finish without child work
    rules:
      - condition: done
        next: COMPLETE
`);
    setMockScenario([
      { persona: 'coder', status: 'done', content: '[CHOOSE:1]\n\nSkip child.' },
      { persona: 'coder', status: 'done', content: '[FINISH:1]\n\nDone.' },
    ]);

    const exitCode = await executePipeline({
      task: 'Skip conditional child routing',
      workflow: workflowPath,
      autoPr: false,
      skipGit: true,
      cwd: testDir,
      autoStrategy: 'performance',
    });

    expect(exitCode).toBe(0);
    expect(mockWorkflowWarn).toHaveBeenCalledWith(
      '--auto-strategy was ignored because execution did not reach a workflow with effective auto_routing',
    );
  });

  it('should apply workflow_config provider/model before project config at runtime', async () => {
    writeFileSync(join(testDir, '.takt', 'config.yaml'), [
      'provider: opencode',
      'model: opencode/project-model',
    ].join('\n'));
    workflowPath = join(testDir, 'workflow-priority.yaml');
    writeFileSync(workflowPath, `name: workflow-priority
workflow_config:
  provider: mock
  model: mock/workflow-model
initial_step: implement
max_steps: 2
steps:
  - name: implement
    persona: ./.takt/personas/coder.md
    instruction: Run with workflow provider
    rules:
      - condition: done
        next: COMPLETE
`);
    vi.mocked(loadGlobalConfig).mockReturnValue({
      language: 'en',
      provider: 'mock',
      enableBuiltinWorkflows: true,
      disabledBuiltins: [],
      logging: { usageEvents: true },
    });
    setMockScenario([
      { persona: 'coder', status: 'done', content: '[IMPLEMENT:1]\n\nDone.' },
    ]);

    const exitCode = await executePipeline({
      task: 'Verify workflow priority',
      workflow: workflowPath,
      autoPr: false,
      skipGit: true,
      cwd: testDir,
    });

    expect(exitCode).toBe(0);
    expect(readUsageEvents(testDir)).toContainEqual(expect.objectContaining({
      step: 'implement',
      provider: 'mock',
      provider_model: 'mock/workflow-model',
    }));
  });

  it.each([
    {
      label: 'provider only',
      workflowProvider: 'codex',
      workflowModel: 'gpt-5',
      envProvider: 'mock',
      envModel: undefined,
      expectedProvider: 'mock',
      expectedModel: 'gpt-5',
    },
    {
      label: 'model only',
      workflowProvider: 'mock',
      workflowModel: 'gpt-5',
      envProvider: undefined,
      envModel: 'mock/env-model',
      expectedProvider: 'mock',
      expectedModel: 'mock/env-model',
    },
    {
      label: 'provider and model',
      workflowProvider: 'codex',
      workflowModel: 'gpt-5',
      envProvider: 'mock',
      envModel: 'mock/env-model',
      expectedProvider: 'mock',
      expectedModel: 'mock/env-model',
    },
  ])('should preserve environment $label through the terminal provider call', async ({
    workflowProvider,
    workflowModel,
    envProvider,
    envModel,
    expectedProvider,
    expectedModel,
  }) => {
    workflowPath = join(testDir, 'env-priority.yaml');
    writeFileSync(workflowPath, `name: env-priority
initial_step: implement
max_steps: 2
steps:
  - name: implement
    persona: ./.takt/personas/coder.md
    provider: ${workflowProvider}
    model: ${workflowModel}
    instruction: Run with environment provider
    rules:
      - condition: done
        next: COMPLETE
`);
    vi.mocked(loadGlobalConfig).mockReturnValue({
      language: 'en',
      provider: 'mock',
      enableBuiltinWorkflows: true,
      disabledBuiltins: [],
      logging: { usageEvents: true },
    });
    const previousProvider = process.env.TAKT_PROVIDER;
    const previousModel = process.env.TAKT_MODEL;
    if (envProvider === undefined) delete process.env.TAKT_PROVIDER;
    else process.env.TAKT_PROVIDER = envProvider;
    if (envModel === undefined) delete process.env.TAKT_MODEL;
    else process.env.TAKT_MODEL = envModel;
    setMockScenario([
      { persona: 'coder', status: 'done', content: '[IMPLEMENT:1]\n\nDone.' },
    ]);

    try {
      const exitCode = await executePipeline({
        task: 'Verify environment priority',
        workflow: workflowPath,
        autoPr: false,
        skipGit: true,
        cwd: testDir,
      });

      expect(exitCode).toBe(0);
      expect(readUsageEvents(testDir)).toContainEqual(expect.objectContaining({
        step: 'implement',
        provider: expectedProvider,
        provider_model: expectedModel,
      }));
    } finally {
      if (previousProvider === undefined) delete process.env.TAKT_PROVIDER;
      else process.env.TAKT_PROVIDER = previousProvider;
      if (previousModel === undefined) delete process.env.TAKT_MODEL;
      else process.env.TAKT_MODEL = previousModel;
    }
  });
});
