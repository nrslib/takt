/**
 * WorkflowEngine integration tests: blocked handling scenarios.
 *
 * Covers:
 * - Blocked without onUserInput callback (abort)
 * - Blocked with onUserInput returning null (abort)
 * - Blocked with onUserInput providing input (continue)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// --- Mock setup (must be before imports that use these modules) ---

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/workflow/evaluation/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/evaluation/index.js')>();
  const { MockRuleEvaluator } = await import('./rule-evaluator-test-double.js');
  return {
    ...actual,
    RuleEvaluator: MockRuleEvaluator,
  };
});

vi.mock('../core/workflow/phase-runner.js', () => ({
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ label: '', method: 'auto_select' }),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

// --- Imports (after mocks) ---

import { WorkflowEngine } from '../core/workflow/index.js';
import { runReportPhase } from '../core/workflow/phase-runner.js';
import {
  makeResponse,
  buildDefaultWorkflowConfig,
  mockRunAgentSequence,
  mockRuleEvaluationSequence,
  createTestTmpDir,
  applyDefaultMocks,
  makeStep,
  makeRule,
} from './engine-test-helpers.js';
import type { WorkflowConfig, OutputContractItem } from '../core/models/index.js';

/**
 * Build a workflow config where a step has outputContracts (triggering report phase).
 * plan → implement (with report) → supervise
 */
function buildConfigWithReport(): WorkflowConfig {
  const reportContract: OutputContractItem = {
    name: '02-coder-scope.md',
    label: 'Scope',
    description: 'Scope report',
  };

  return buildDefaultWorkflowConfig({
    steps: [
      makeStep('plan', {
        rules: [
          makeRule('Requirements are clear', 'implement'),
          makeRule('Requirements unclear', 'ABORT'),
        ],
      }),
      makeStep('implement', {
        outputContracts: [reportContract],
        rules: [
          makeRule('Implementation complete', 'supervise'),
          makeRule('Cannot proceed', 'plan'),
        ],
      }),
      makeStep('supervise', {
        rules: [
          makeRule('All checks passed', 'COMPLETE'),
          makeRule('Requirements unmet', 'plan'),
        ],
      }),
    ],
  });
}

describe('WorkflowEngine Integration: Blocked Handling', () => {
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

  it('should abort when blocked and no onUserInput callback', async () => {
    const config = buildDefaultWorkflowConfig();
    const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir, provider: 'mock' });

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', status: 'blocked', content: 'Need clarification' }),
    ]);

    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
    ]);

    const blockedFn = vi.fn();
    const abortFn = vi.fn();
    engine.on('step:blocked', blockedFn);
    engine.on('workflow:abort', abortFn);

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(blockedFn).toHaveBeenCalledOnce();
    expect(abortFn).toHaveBeenCalledOnce();
  });

  it('should abort when blocked and onUserInput returns null', async () => {
    const config = buildDefaultWorkflowConfig();
    const onUserInput = vi.fn().mockResolvedValue(null);
    const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir, provider: 'mock', onUserInput });

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', status: 'blocked', content: 'Need info' }),
    ]);

    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
    ]);

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(onUserInput).toHaveBeenCalledOnce();
  });

  it('should continue when blocked and onUserInput provides input', async () => {
    const config = buildDefaultWorkflowConfig();
    const onUserInput = vi.fn().mockResolvedValueOnce('User provided clarification');
    const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir, provider: 'mock', onUserInput });

    mockRunAgentSequence([
      // First: plan is blocked
      makeResponse({ persona: 'plan', status: 'blocked', content: 'Need info' }),
      // Second: plan succeeds after user input
      makeResponse({ persona: 'plan', content: 'Plan done with user input' }),
      makeResponse({ persona: 'implement', content: 'Impl done' }),
      makeResponse({ persona: 'ai_review', content: 'OK' }),
      makeResponse({ persona: 'arch-review', content: 'OK' }),
      makeResponse({ persona: 'security-review', content: 'OK' }),
      makeResponse({ persona: 'supervise', content: 'All passed' }),
    ]);

    mockRuleEvaluationSequence([
      // First plan call: blocked, rule matched but blocked handling takes over
      { index: 0, method: 'phase3_tag' },
      // Second plan call: success
      { index: 0, method: 'phase3_tag' },  // plan → implement
      { index: 0, method: 'phase3_tag' },  // implement → ai_review
      { index: 0, method: 'phase3_tag' },  // ai_review → reviewers
      { index: 0, method: 'phase3_tag' },  // arch-review → approved
      { index: 0, method: 'phase3_tag' },  // security-review → approved
      { index: 0, method: 'aggregate' },   // reviewers → supervise
      { index: 0, method: 'phase3_tag' },  // supervise → COMPLETE
    ]);

    const userInputFn = vi.fn();
    engine.on('step:user_input', userInputFn);

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(onUserInput).toHaveBeenCalledOnce();
    expect(userInputFn).toHaveBeenCalledOnce();
    expect(state.userInputs).toContain('User provided clarification');
  });

  it('should refresh previous response snapshot when Phase 1 returns blocked', async () => {
    // implement has outputContracts: verifies the report phase is skipped on a Phase 1 block
    const config = buildConfigWithReport();
    const onUserInput = vi.fn().mockResolvedValueOnce(null);
    const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir, provider: 'mock', onUserInput });

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', status: 'done', content: 'Plan done' }),
      makeResponse({ persona: 'implement', status: 'blocked', content: 'Need clarification' }),
    ]);

    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' }, // plan -> implement
    ]);

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(state.lastOutput?.status).toBe('blocked');
    expect(runReportPhase).not.toHaveBeenCalled();
    expect(state.previousResponseSourcePath).toMatch(
      /^\.takt\/runs\/test-report-dir\/context\/previous_responses\/implement\.1\.\d{8}T\d{6}Z\.md$/,
    );

    const snapshotPath = join(tmpDir, state.previousResponseSourcePath!);
    const latestPath = join(
      tmpDir,
      '.takt',
      'runs',
      'test-report-dir',
      'context',
      'previous_responses',
      'latest.md',
    );

    expect(readFileSync(snapshotPath, 'utf-8')).toBe('Need clarification');
    expect(readFileSync(latestPath, 'utf-8')).toBe('Need clarification');
    expect(onUserInput).toHaveBeenCalledOnce();
  });

  it('should sanitize a step name containing path separators when writing a snapshot', async () => {
    const config = buildDefaultWorkflowConfig({
      initialStep: '../../escape',
      steps: [
        makeStep('../../escape', {
          rules: [makeRule('done', 'ABORT')],
        }),
      ],
    });

    const onUserInput = vi.fn().mockResolvedValueOnce(null);
    const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir, provider: 'mock', onUserInput });

    mockRunAgentSequence([
      makeResponse({ persona: 'escape', status: 'blocked', content: 'Need clarification' }),
    ]);

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(state.lastOutput?.status).toBe('blocked');
    // slugify('../../escape') === 'escape'
    expect(state.previousResponseSourcePath).toMatch(
      /^\.takt\/runs\/test-report-dir\/context\/previous_responses\/escape\.1\.\d{8}T\d{6}Z\.md$/,
    );

    const snapshotPath = join(tmpDir, state.previousResponseSourcePath!);
    const latestPath = join(
      tmpDir,
      '.takt',
      'runs',
      'test-report-dir',
      'context',
      'previous_responses',
      'latest.md',
    );

    expect(readFileSync(snapshotPath, 'utf-8')).toBe('Need clarification');
    expect(readFileSync(latestPath, 'utf-8')).toBe('Need clarification');
    // 上位ディレクトリにパストラバーサルでファイルが書き込まれていないことを確認
    expect(readdirSync(tmpDir).some(name => /^escape\.1\.\d{8}T\d{6}Z\.md$/.test(name))).toBe(false);
    expect(onUserInput).toHaveBeenCalledOnce();
  });

  it('should abort immediately when a step returns error status', async () => {
    // implement has outputContracts: verifies the report phase is skipped on a Phase 1 error
    const config = buildConfigWithReport();
    const onUserInput = vi.fn().mockResolvedValueOnce('should not be called');
    const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir, provider: 'mock', onUserInput });

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'Plan done' }),
      makeResponse({ persona: 'implement', status: 'error', content: 'Transport error', error: 'Transport error' }),
    ]);

    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' }, // plan -> implement
    ]);

    const abortFn = vi.fn();
    engine.on('workflow:abort', abortFn);

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(onUserInput).not.toHaveBeenCalled();
    expect(runReportPhase).not.toHaveBeenCalled();
    expect(abortFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('Transport error'),
      'step_error',
    );
    const reason = abortFn.mock.calls[0]?.[1] as string;
    expect(reason).toContain('Step "implement" failed');
  });

  it('should abort and propagate blocked content when report phase is blocked without onUserInput', async () => {
    const config = buildConfigWithReport();
    const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir, provider: 'mock' });

    // Phase 1 succeeds for plan, then implement
    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'Plan done' }),
      makeResponse({ persona: 'implement', content: 'Impl done' }),
    ]);

    // plan → implement, then implement's report phase blocks
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
    ]);

    // Report phase returns blocked (only implement has outputContracts, so only one call)
    const blockedContent = 'Blocked: need specific file path for report';
    const blockedResponse = makeResponse({ persona: 'implement', status: 'blocked', content: blockedContent });
    vi.mocked(runReportPhase).mockResolvedValueOnce({ blocked: true, response: blockedResponse });

    const blockedFn = vi.fn();
    const abortFn = vi.fn();
    engine.on('step:blocked', blockedFn);
    engine.on('workflow:abort', abortFn);

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(abortFn).toHaveBeenCalledOnce();
    // Blocked content from the report phase propagates to the engine response
    expect(blockedFn).toHaveBeenCalledOnce();
    expect(blockedFn).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'implement' }),
      expect.objectContaining({ status: 'blocked', content: blockedContent }),
    );
  });

  it('should abort when report phase is blocked and onUserInput returns null', async () => {
    const config = buildConfigWithReport();
    const onUserInput = vi.fn().mockResolvedValue(null);
    const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir, provider: 'mock', onUserInput });

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'Plan done' }),
      makeResponse({ persona: 'implement', content: 'Impl done' }),
    ]);

    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
    ]);

    const blockedResponse = makeResponse({ persona: 'implement', status: 'blocked', content: 'Need info for report' });
    vi.mocked(runReportPhase).mockResolvedValueOnce({ blocked: true, response: blockedResponse });

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(onUserInput).toHaveBeenCalledOnce();
  });

  it('should retry the full step when report phase is blocked and user provides input', async () => {
    const config = buildConfigWithReport();
    const onUserInput = vi.fn().mockResolvedValueOnce('User provided report clarification');
    const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir, provider: 'mock', onUserInput });

    mockRunAgentSequence([
      // First: plan succeeds
      makeResponse({ persona: 'plan', content: 'Plan done' }),
      // Second: implement Phase 1 succeeds, but Phase 2 will block
      makeResponse({ persona: 'implement', content: 'Impl done' }),
      // Third: implement retried after user input (Phase 1 re-executes)
      makeResponse({ persona: 'implement', content: 'Impl done with clarification' }),
      // Fourth: supervise
      makeResponse({ persona: 'supervise', content: 'All passed' }),
    ]);

    mockRuleEvaluationSequence([
      // plan → implement
      { index: 0, method: 'phase3_tag' },
      // implement (blocked, no rule eval happens)
      // implement retry → supervise
      { index: 0, method: 'phase3_tag' },
      // supervise → COMPLETE
      { index: 0, method: 'phase3_tag' },
    ]);

    // Report phase: only implement has outputContracts; blocks first, succeeds on retry
    const blockedResponse = makeResponse({ persona: 'implement', status: 'blocked', content: 'Need report clarification' });
    vi.mocked(runReportPhase).mockResolvedValueOnce({ blocked: true, response: blockedResponse }); // implement (first attempt)
    vi.mocked(runReportPhase).mockResolvedValueOnce(undefined); // implement (retry, succeeds)

    const userInputFn = vi.fn();
    engine.on('step:user_input', userInputFn);

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(onUserInput).toHaveBeenCalledOnce();
    expect(userInputFn).toHaveBeenCalledOnce();
    expect(state.userInputs).toContain('User provided report clarification');
  });

});
