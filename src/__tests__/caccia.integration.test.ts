import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAgent } from '../agents/runner.js';
import type { CacciaDependencies } from '../features/caccia/index.js';
import { runCaccia } from '../features/caccia/index.js';
import { runWorkflowExecution } from '../features/tasks/execute/workflowExecutionApi.js';
import {
  invalidateGlobalConfigCache,
  loadGlobalConfig,
  saveGlobalConfig,
} from '../infra/config/global/globalConfigCore.js';
import { loadWorkflowByIdentifier } from '../infra/config/loaders/workflowLoader.js';
import { generateReportDir } from '../shared/utils/reportDir.js';
import { findAgentWorkflowStep } from './test-helpers.js';

const { mockRunAgent, mockRunStatusJudgmentPhase } = vi.hoisted(() => ({
  mockRunAgent: vi.fn(),
  mockRunStatusJudgmentPhase: vi.fn().mockResolvedValue({
    label: 'All valid findings are fixed and every thread has a complete decision report',
    method: 'phase3_tag',
  }),
}));

vi.mock('../agents/runner.js', () => ({ runAgent: mockRunAgent }));
vi.mock('../core/workflow/phase-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/phase-runner.js')>();
  return { ...actual, runStatusJudgmentPhase: mockRunStatusJudgmentPhase };
});

const temporaryRoots: string[] = [];

describe('Caccia report lifecycle', () => {
  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.clearAllMocks();
    invalidateGlobalConfigCache();
  });

  it.each(['en', 'ja'] as const)('loads the Caccia workflow and report contract (%s)', (language) => {
    const projectCwd = mkdtempSync(join(tmpdir(), 'takt-caccia-workflow-'));
    temporaryRoots.push(projectCwd);
    mkdirSync(join(projectCwd, '.takt'), { recursive: true });
    writeFileSync(join(projectCwd, '.takt', 'config.yaml'), `language: ${language}\n`, 'utf8');

    const workflow = loadWorkflowByIdentifier('caccia', projectCwd);
    if (!workflow) {
      throw new Error(`Expected the builtin Caccia workflow for ${language}`);
    }
    const step = findAgentWorkflowStep(workflow, 'address');
    const reportFormat = readFileSync(
      join(process.cwd(), 'builtins', language, 'facets', 'output-contracts', 'caccia-decisions.md'),
      'utf8',
    );

    expect(workflow.maxSteps).toBe(1);
    expect(step.policyContents?.some((item) => item.refName === 'caccia-review')).toBe(true);
    expect(step.instruction).toContain('caccia-decisions.json');
    expect(step.outputContracts).toEqual([expect.objectContaining({
      name: 'caccia-decisions.json',
      format: reportFormat,
      formatRef: 'caccia-decisions',
    })]);
  });

  it('reads and writes Caccia settings through an isolated global config file', () => {
    const globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-caccia-global-config-'));
    temporaryRoots.push(globalConfigDir);
    vi.stubEnv('TAKT_CONFIG_DIR', globalConfigDir);
    invalidateGlobalConfigCache();
    const settings = {
      enabled: true,
      waitTimeoutMs: 900_000,
      maxIterations: 6,
      workflow: 'global-caccia',
    };

    saveGlobalConfig({ ...loadGlobalConfig(), caccia: settings });
    invalidateGlobalConfigCache();

    expect(loadGlobalConfig().caccia).toEqual(settings);
    const configText = readFileSync(join(globalConfigDir, 'config.yaml'), 'utf8');
    expect(configText).toContain('wait_timeout_ms: 900000');
    expect(configText).not.toContain('waitTimeoutMs');
  });

  it('keeps the workflow report after deleting its temporary clone', async () => {
    const projectCwd = mkdtempSync(join(tmpdir(), 'takt-caccia-project-'));
    const cloneCwd = mkdtempSync(join(tmpdir(), 'takt-caccia-clone-'));
    temporaryRoots.push(projectCwd, cloneCwd);
    const reportPath = join(projectCwd, '.takt', 'runs', 'caccia-run', 'report.md');
    const threads = [{ id: 'finding-1', author: 'coderabbitai', body: 'Fix the changed call site.', replies: [] }];
    const waitForCodeRabbitReview = vi.fn(async () => ({ headSha: 'reviewed-head' }));
    const fetchCodeRabbitReviewThreads = vi.fn()
      .mockResolvedValueOnce(threads)
      .mockResolvedValueOnce([]);
    const executeWorkflow = vi.fn(async () => {
      mkdirSync(join(projectCwd, '.takt', 'runs', 'caccia-run'), { recursive: true });
      writeFileSync(reportPath, 'The finding was valid and the call site was fixed.', 'utf8');
      return { reportPath, decisions: [{ threadId: 'finding-1', valid: true, reason: 'The call site was incorrect.' }] };
    });
    const removeTemporaryClone = vi.fn(async (cwd: string) => {
      rmSync(cwd, { recursive: true, force: true });
    });
    const dependencies: CacciaDependencies = {
      detectVcsProvider: vi.fn(() => 'github'),
      waitForCodeRabbitReview,
      fetchCodeRabbitReviewThreads,
      createTemporaryClone: vi.fn(async () => ({ cwd: cloneCwd })),
      executeWorkflow,
      commitAndPush: vi.fn(async () => ({ headSha: 'pushed-head' })),
      fetchCurrentPullRequestHeadSha: vi.fn(async () => 'pushed-head'),
      resolveReviewThread: vi.fn(async () => undefined),
      removeTemporaryClone,
      logResult: vi.fn(),
      notifyResult: vi.fn(async () => undefined),
    };

    await runCaccia({
      entry: 'standalone',
      prNumber: 42,
      projectCwd,
      settings: {
        enabled: false,
        waitTimeoutMs: 100,
        maxIterations: 1,
        workflow: 'caccia',
      },
    }, dependencies);

    expect(existsSync(cloneCwd)).toBe(false);
    expect(existsSync(reportPath)).toBe(true);
    expect(readFileSync(reportPath, 'utf8')).toContain('finding was valid');
    expect(executeWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      cwd: cloneCwd,
      projectCwd,
      task: expect.stringContaining('"thread_id": "finding-1"'),
    }));
    expect(removeTemporaryClone).toHaveBeenCalledWith(cloneCwd);
  });

  it('runs the built-in workflow, preserves a same-named run, and keeps valid and invalid decisions after clone cleanup', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-26T00:00:00.000Z'));
    const projectCwd = mkdtempSync(join(tmpdir(), 'takt-caccia-real-workflow-'));
    const cloneCwd = mkdtempSync(join(tmpdir(), 'takt-caccia-real-clone-'));
    temporaryRoots.push(projectCwd, cloneCwd);
    mkdirSync(join(projectCwd, '.takt'), { recursive: true });
    writeFileSync(join(projectCwd, '.takt', 'config.yaml'), 'language: en\n', 'utf8');

    const task = [
      'Review CodeRabbit threads for pull request #42.',
      JSON.stringify([
        { thread_id: 'valid-thread', body: 'The implementation misses the requested null check.' },
        { thread_id: 'invalid-thread', body: 'Change an unrelated component outside this diff.' },
      ]),
    ].join('\n\n');
    const runsDirectory = join(projectCwd, '.takt', 'runs');
    const existingRunDirectory = join(runsDirectory, generateReportDir(task));
    const existingReportPath = join(existingRunDirectory, 'reports', 'caccia-decisions.json');
    mkdirSync(join(existingRunDirectory, 'reports'), { recursive: true });
    writeFileSync(existingReportPath, 'previous decision', 'utf8');

    const decisions = [
      { thread_id: 'valid-thread', valid: true, reason: 'The implementation is missing the requested null check.' },
      { thread_id: 'invalid-thread', valid: false, reason: 'The requested change is outside the reported diff.' },
    ];
    let agentCallCount = 0;
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      agentCallCount += 1;
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: instruction,
      });
      return {
        persona: 'coder',
        status: 'done',
        content: agentCallCount === 1
          ? 'Reviewed both supplied CodeRabbit threads.'
          : JSON.stringify(decisions, null, 2),
        timestamp: new Date(),
        sessionId: `caccia-session-${agentCallCount}`,
      };
    });

    const result = await runWorkflowExecution({
      task,
      cwd: cloneCwd,
      projectCwd,
      workflowIdentifier: 'caccia',
      runPathsDirectory: runsDirectory,
      agentOverrides: { provider: 'mock', model: 'caccia-integration' },
      outputMode: 'silent',
    });

    expect(result.success).toBe(true);
    expect(result.reportDirectory).toBeDefined();
    expect(result.reportDirectory).not.toBe(join(existingRunDirectory, 'reports'));
    const generatedReportPath = join(result.reportDirectory!, 'caccia-decisions.json');
    expect(JSON.parse(readFileSync(generatedReportPath, 'utf8'))).toEqual(decisions);
    expect(mockRunStatusJudgmentPhase).toHaveBeenCalledOnce();
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(2);

    rmSync(cloneCwd, { recursive: true, force: false });
    expect(existsSync(cloneCwd)).toBe(false);
    expect(readFileSync(generatedReportPath, 'utf8')).toContain('valid-thread');
    expect(readFileSync(existingReportPath, 'utf8')).toBe('previous decision');
  });
});
