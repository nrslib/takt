/**
 * WorkflowEngine integration tests: blocked handling scenarios.
 *
 * Covers:
 * - Blocked without onUserInput callback (abort)
 * - Blocked with onUserInput returning null (abort)
 * - Blocked with onUserInput providing input (continue)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';

// --- Mock setup (must be before imports that use these modules) ---

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../workflow/rule-evaluator.js', () => ({
  detectMatchedRule: vi.fn(),
}));

vi.mock('../workflow/phase-runner.js', () => ({
  needsStatusJudgmentPhase: vi.fn().mockReturnValue(false),
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue(''),
}));

vi.mock('../utils/session.js', () => ({
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

// --- Imports (after mocks) ---

import { WorkflowEngine } from '../workflow/engine.js';
import {
  makeResponse,
  buildDefaultWorkflowConfig,
  mockRunAgentSequence,
  mockDetectMatchedRuleSequence,
  createTestTmpDir,
  applyDefaultMocks,
} from './engine-test-helpers.js';

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
    const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

    mockRunAgentSequence([
      makeResponse({ agent: 'plan', status: 'blocked', content: 'Need clarification' }),
    ]);

    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
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
    const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir, onUserInput });

    mockRunAgentSequence([
      makeResponse({ agent: 'plan', status: 'blocked', content: 'Need info' }),
    ]);

    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
    ]);

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(onUserInput).toHaveBeenCalledOnce();
  });

  it('should continue when blocked and onUserInput provides input', async () => {
    const config = buildDefaultWorkflowConfig();
    const onUserInput = vi.fn().mockResolvedValueOnce('User provided clarification');
    const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir, onUserInput });

    mockRunAgentSequence([
      // First: plan is blocked
      makeResponse({ agent: 'plan', status: 'blocked', content: 'Need info' }),
      // Second: plan succeeds after user input
      makeResponse({ agent: 'plan', content: 'Plan done with user input' }),
      makeResponse({ agent: 'implement', content: 'Impl done' }),
      makeResponse({ agent: 'ai_review', content: 'OK' }),
      makeResponse({ agent: 'arch-review', content: 'OK' }),
      makeResponse({ agent: 'security-review', content: 'OK' }),
      makeResponse({ agent: 'supervise', content: 'All passed' }),
    ]);

    mockDetectMatchedRuleSequence([
      // First plan call: blocked, rule matched but blocked handling takes over
      { index: 0, method: 'phase1_tag' },
      // Second plan call: success
      { index: 0, method: 'phase1_tag' },  // plan → implement
      { index: 0, method: 'phase1_tag' },  // implement → ai_review
      { index: 0, method: 'phase1_tag' },  // ai_review → reviewers
      { index: 0, method: 'phase1_tag' },  // arch-review → approved
      { index: 0, method: 'phase1_tag' },  // security-review → approved
      { index: 0, method: 'aggregate' },   // reviewers → supervise
      { index: 0, method: 'phase1_tag' },  // supervise → COMPLETE
    ]);

    const userInputFn = vi.fn();
    engine.on('step:user_input', userInputFn);

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(onUserInput).toHaveBeenCalledOnce();
    expect(userInputFn).toHaveBeenCalledOnce();
    expect(state.userInputs).toContain('User provided clarification');
  });
});
