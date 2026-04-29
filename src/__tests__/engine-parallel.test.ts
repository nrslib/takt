/**
 * WorkflowEngine integration tests: parallel step aggregation.
 *
 * Covers:
 * - Aggregated output format (## headers and --- separators)
 * - Individual sub-step output storage
 * - Concurrent execution of sub-steps
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// --- Mock setup (must be before imports that use these modules) ---

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/workflow/evaluation/index.js', () => ({
  detectMatchedRule: vi.fn(),
}));

vi.mock('../core/workflow/phase-runner.js', () => ({
  needsStatusJudgmentPhase: vi.fn().mockReturnValue(false),
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ tag: '', ruleIndex: 0, method: 'auto_select' }),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

// --- Imports (after mocks) ---

import { WorkflowEngine } from '../core/workflow/index.js';
import { runAgent } from '../agents/runner.js';
import { detectMatchedRule } from '../core/workflow/evaluation/index.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import {
  makeResponse,
  buildDefaultWorkflowConfig,
  mockRunAgentSequence,
  mockDetectMatchedRuleSequence,
  createTestTmpDir,
  applyDefaultMocks,
} from './engine-test-helpers.js';

describe('WorkflowEngine Integration: Parallel Step Aggregation', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    tmpDir = createTestTmpDir();
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should aggregate sub-step outputs with ## headers and --- separators', async () => {
    const config = buildDefaultWorkflowConfig();
    const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'Plan done' }),
      makeResponse({ persona: 'implement', content: 'Impl done' }),
      makeResponse({ persona: 'ai_review', content: 'OK' }),
      makeResponse({ persona: 'arch-review', content: 'Architecture review content' }),
      makeResponse({ persona: 'security-review', content: 'Security review content' }),
      makeResponse({ persona: 'supervise', content: 'All passed' }),
    ]);

    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },  // arch-review
      { index: 0, method: 'phase1_tag' },  // security-review
      { index: 0, method: 'aggregate' },   // reviewers
      { index: 0, method: 'phase1_tag' },
    ]);

    const state = await engine.run();

    expect(state.status).toBe('completed');

    const reviewersOutput = state.stepOutputs.get('reviewers');
    expect(reviewersOutput).toBeDefined();
    expect(reviewersOutput!.content).toContain('## arch-review');
    expect(reviewersOutput!.content).toContain('Architecture review content');
    expect(reviewersOutput!.content).toContain('---');
    expect(reviewersOutput!.content).toContain('## security-review');
    expect(reviewersOutput!.content).toContain('Security review content');
    expect(reviewersOutput!.matchedRuleMethod).toBe('aggregate');
  });

  it('should store individual sub-step outputs in stepOutputs', async () => {
    const config = buildDefaultWorkflowConfig();
    const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'Plan' }),
      makeResponse({ persona: 'implement', content: 'Impl' }),
      makeResponse({ persona: 'ai_review', content: 'OK' }),
      makeResponse({ persona: 'arch-review', content: 'Arch content' }),
      makeResponse({ persona: 'security-review', content: 'Sec content' }),
      makeResponse({ persona: 'supervise', content: 'Pass' }),
    ]);

    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'aggregate' },
      { index: 0, method: 'phase1_tag' },
    ]);

    const state = await engine.run();

    expect(state.stepOutputs.has('arch-review')).toBe(true);
    expect(state.stepOutputs.has('security-review')).toBe(true);
    expect(state.stepOutputs.has('reviewers')).toBe(true);
    expect(state.stepOutputs.get('arch-review')!.content).toBe('Arch content');
    expect(state.stepOutputs.get('security-review')!.content).toBe('Sec content');
  });

  it.each([
    { allowGitCommit: undefined, expectsGitRules: true },
    { allowGitCommit: false, expectsGitRules: true },
    { allowGitCommit: true, expectsGitRules: false },
  ])(
    'should reflect parallel parent allowGitCommit=$allowGitCommit in sub-step prompts',
    async ({ allowGitCommit, expectsGitRules }) => {
      const config = normalizeWorkflowConfig({
        name: 'parallel-allow-git-commit',
        max_steps: 5,
        initial_step: 'reviewers',
        steps: [
          {
            name: 'reviewers',
            persona: '../personas/reviewers.md',
            instruction: 'Run parallel reviews',
            ...(allowGitCommit === undefined ? {} : { allow_git_commit: allowGitCommit }),
            parallel: [
              {
                name: 'arch-review',
                persona: '../personas/arch-review.md',
                instruction: 'Review architecture',
                rules: [
                  {
                    condition: 'approved',
                    next: 'COMPLETE',
                  },
                ],
              },
              {
                name: 'security-review',
                persona: '../personas/security-review.md',
                instruction: 'Review security',
                rules: [
                  {
                    condition: 'approved',
                    next: 'COMPLETE',
                  },
                ],
              },
            ],
            rules: [
              {
                condition: 'all("approved")',
                next: 'COMPLETE',
              },
            ],
          },
        ],
      }, tmpDir);
      const prompts: string[] = [];
      const gitCommitRule = 'Do NOT run git commit';
      const gitPushRule = 'Do NOT run git push';
      const gitAddRule = 'Do NOT run git add';

      vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
        prompts.push(instruction);
        options.onPromptResolved?.({
          systemPrompt: typeof persona === 'string' ? persona : '',
          userInstruction: instruction,
        });
        return makeResponse({ persona: String(persona), content: 'approved' });
      });
      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'aggregate' },
      ]);

      const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });
      const state = await engine.run();

      expect(state.status).toBe('completed');
      expect(prompts).toHaveLength(2);
      for (const prompt of prompts) {
        if (expectsGitRules) {
          expect(prompt).toContain(gitCommitRule);
          expect(prompt).toContain(gitPushRule);
          expect(prompt).toContain(gitAddRule);
        } else {
          expect(prompt).not.toContain(gitCommitRule);
          expect(prompt).not.toContain(gitPushRule);
          expect(prompt).not.toContain(gitAddRule);
        }
      }
    },
  );

  it('should persist aggregated previous_response snapshot for parallel parent step', async () => {
    const config = buildDefaultWorkflowConfig();
    const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'Plan' }),
      makeResponse({ persona: 'implement', content: 'Impl' }),
      makeResponse({ persona: 'ai_review', content: 'OK' }),
      makeResponse({ persona: 'arch-review', content: 'Arch content' }),
      makeResponse({ persona: 'security-review', content: 'Sec content' }),
      makeResponse({ persona: 'supervise', content: 'Pass' }),
    ]);

    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'aggregate' },
      { index: 0, method: 'phase1_tag' },
    ]);

    const state = await engine.run();
    const reviewersOutput = state.stepOutputs.get('reviewers')!.content;
    const previousDir = join(tmpDir, '.takt', 'runs', 'test-report-dir', 'context', 'previous_responses');
    const previousFiles = readdirSync(previousDir);

    expect(state.previousResponseSourcePath).toMatch(/^\.takt\/runs\/test-report-dir\/context\/previous_responses\/supervise\.1\.\d{8}T\d{6}Z\.md$/);
    expect(previousFiles).toContain('latest.md');
    expect(previousFiles.some((name) => /^reviewers\.1\.\d{8}T\d{6}Z\.md$/.test(name))).toBe(true);
    expect(readFileSync(join(previousDir, 'latest.md'), 'utf-8')).toBe('Pass');
    expect(
      previousFiles.some((name) => {
        if (!/^reviewers\.1\.\d{8}T\d{6}Z\.md$/.test(name)) return false;
        return readFileSync(join(previousDir, name), 'utf-8') === reviewersOutput;
      })
    ).toBe(true);
  });

  it('should execute sub-steps concurrently (both runAgent calls happen)', async () => {
    const config = buildDefaultWorkflowConfig();
    const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'Plan' }),
      makeResponse({ persona: 'implement', content: 'Impl' }),
      makeResponse({ persona: 'ai_review', content: 'OK' }),
      makeResponse({ persona: 'arch-review', content: 'OK' }),
      makeResponse({ persona: 'security-review', content: 'OK' }),
      makeResponse({ persona: 'supervise', content: 'Pass' }),
    ]);

    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'aggregate' },
      { index: 0, method: 'phase1_tag' },
    ]);

    await engine.run();

    // 6 total: 4 normal + 2 parallel sub-steps
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(6);

    const calledAgents = vi.mocked(runAgent).mock.calls.map(call => call[0]);
    expect(calledAgents).toContain('../personas/arch-review.md');
    expect(calledAgents).toContain('../personas/security-review.md');
  });

  it('should pass resolved providers to rule evaluation for sub-steps and parent step', async () => {
    const config = buildDefaultWorkflowConfig();
    const engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      provider: 'claude',
      personaProviders: {
        'arch-review': { provider: 'cursor' },
        'security-review': { provider: 'copilot' },
      },
    });

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'Plan done' }),
      makeResponse({ persona: 'implement', content: 'Impl done' }),
      makeResponse({ persona: 'ai_review', content: 'OK' }),
      makeResponse({ persona: 'arch-review', content: 'Architecture review content' }),
      makeResponse({ persona: 'security-review', content: 'Security review content' }),
      makeResponse({ persona: 'supervise', content: 'All passed' }),
    ]);

    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'aggregate' },
      { index: 0, method: 'phase1_tag' },
    ]);

    const state = await engine.run();

    expect(state.status).toBe('completed');

    const detectCalls = vi.mocked(detectMatchedRule).mock.calls;
    expect(detectCalls[3]?.[3].provider).toBe('cursor');
    expect(detectCalls[4]?.[3].provider).toBe('copilot');
    expect(detectCalls[5]?.[3].provider).toBe('claude');
  });

  it('should output rich parallel prefix when taskPrefix/taskColorIndex are provided', async () => {
    const config = buildDefaultWorkflowConfig();
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const parentOnStream = vi.fn();

    const responsesByPersona = new Map<string, ReturnType<typeof makeResponse>>([
      ['../personas/plan.md', makeResponse({ persona: 'plan', content: 'Plan done' })],
      ['../personas/implement.md', makeResponse({ persona: 'implement', content: 'Impl done' })],
      ['../personas/ai_review.md', makeResponse({ persona: 'ai_review', content: 'OK' })],
      ['../personas/arch-review.md', makeResponse({ persona: 'arch-review', content: 'Architecture review content' })],
      ['../personas/security-review.md', makeResponse({ persona: 'security-review', content: 'Security review content' })],
      ['../personas/supervise.md', makeResponse({ persona: 'supervise', content: 'All passed' })],
    ]);

    vi.mocked(runAgent).mockImplementation(async (persona, task, options) => {
      const response = responsesByPersona.get(persona ?? '');
      if (!response) {
        throw new Error(`Unexpected persona: ${persona}`);
      }
      options.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: task,
      });

      if (persona === '../personas/arch-review.md') {
        options.onStream?.({ type: 'text', data: { text: 'arch stream line\n' } });
      }
      if (persona === '../personas/security-review.md') {
        options.onStream?.({ type: 'text', data: { text: 'security stream line\n' } });
      }

      return response;
    });

    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'aggregate' },
      { index: 0, method: 'phase1_tag' },
    ]);

    const engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      onStream: parentOnStream,
      taskPrefix: 'override-persona-provider',
      taskColorIndex: 0,
    });

    try {
      const state = await engine.run();
      expect(state.status).toBe('completed');

      const output = stdoutSpy.mock.calls.map((call) => String(call[0])).join('');
      expect(output).toContain('[over]');
      expect(output).toContain('[reviewers][arch-review](4/30)(1) arch stream line');
      expect(output).toContain('[reviewers][security-review](4/30)(1) security stream line');
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('should fail fast when taskPrefix is provided without taskColorIndex', () => {
    const config = buildDefaultWorkflowConfig();
    expect(
      () => new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir, taskPrefix: 'override-persona-provider' })
    ).toThrow('taskPrefix and taskColorIndex must be provided together');
  });

  it('should respect concurrency limit on parallel sub-steps', async () => {
    // Track concurrent execution count
    let currentConcurrency = 0;
    let maxObservedConcurrency = 0;

    const config = buildDefaultWorkflowConfig();
    // Set concurrency to 1 on the reviewers step
    const reviewersStep = config.steps.find(m => m.name === 'reviewers')!;
    reviewersStep.concurrency = 1;

    const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

    vi.mocked(runAgent).mockImplementation(async (persona, task, options) => {
      // Track concurrency for parallel sub-steps only
      const isSubStep = persona === '../personas/arch-review.md' || persona === '../personas/security-review.md';
      if (isSubStep) {
        currentConcurrency++;
        maxObservedConcurrency = Math.max(maxObservedConcurrency, currentConcurrency);
        // Small delay to make concurrency observable
        await new Promise(resolve => setTimeout(resolve, 10));
        currentConcurrency--;
      }

      options.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: task,
      });
      return makeResponse({ persona: persona ?? 'unknown', content: `${persona} done` });
    });

    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },  // plan
      { index: 0, method: 'phase1_tag' },  // implement
      { index: 0, method: 'phase1_tag' },  // ai_review
      { index: 0, method: 'phase1_tag' },  // arch-review
      { index: 0, method: 'phase1_tag' },  // security-review
      { index: 0, method: 'aggregate' },   // reviewers
      { index: 0, method: 'phase1_tag' },  // supervise
    ]);

    const state = await engine.run();

    expect(state.status).toBe('completed');
    // With concurrency=1, max observed should be 1
    expect(maxObservedConcurrency).toBe(1);
  });

  it('should run all sub-steps simultaneously when concurrency is not set', async () => {
    let currentConcurrency = 0;
    let maxObservedConcurrency = 0;

    const config = buildDefaultWorkflowConfig();
    // No concurrency set — default behavior (all simultaneous)

    const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

    vi.mocked(runAgent).mockImplementation(async (persona, task, options) => {
      const isSubStep = persona === '../personas/arch-review.md' || persona === '../personas/security-review.md';
      if (isSubStep) {
        currentConcurrency++;
        maxObservedConcurrency = Math.max(maxObservedConcurrency, currentConcurrency);
        await new Promise(resolve => setTimeout(resolve, 10));
        currentConcurrency--;
      }

      options.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: task,
      });
      return makeResponse({ persona: persona ?? 'unknown', content: `${persona} done` });
    });

    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'aggregate' },
      { index: 0, method: 'phase1_tag' },
    ]);

    const state = await engine.run();

    expect(state.status).toBe('completed');
    // Without concurrency limit, both should run simultaneously
    expect(maxObservedConcurrency).toBe(2);
  });
});
