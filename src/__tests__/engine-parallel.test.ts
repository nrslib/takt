/**
 * WorkflowEngine integration tests: parallel step aggregation.
 *
 * Covers:
 * - Aggregated output format (## headers and --- separators)
 * - Individual sub-step output storage
 * - Concurrent execution of sub-steps
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
import { runAgent } from '../agents/runner.js';
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
      makeResponse({ agent: 'plan', content: 'Plan done' }),
      makeResponse({ agent: 'implement', content: 'Impl done' }),
      makeResponse({ agent: 'ai_review', content: 'OK' }),
      makeResponse({ agent: 'arch-review', content: 'Architecture review content' }),
      makeResponse({ agent: 'security-review', content: 'Security review content' }),
      makeResponse({ agent: 'supervise', content: 'All passed' }),
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
      makeResponse({ agent: 'plan', content: 'Plan' }),
      makeResponse({ agent: 'implement', content: 'Impl' }),
      makeResponse({ agent: 'ai_review', content: 'OK' }),
      makeResponse({ agent: 'arch-review', content: 'Arch content' }),
      makeResponse({ agent: 'security-review', content: 'Sec content' }),
      makeResponse({ agent: 'supervise', content: 'Pass' }),
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

  it('should execute sub-steps concurrently (both runAgent calls happen)', async () => {
    const config = buildDefaultWorkflowConfig();
    const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

    mockRunAgentSequence([
      makeResponse({ agent: 'plan', content: 'Plan' }),
      makeResponse({ agent: 'implement', content: 'Impl' }),
      makeResponse({ agent: 'ai_review', content: 'OK' }),
      makeResponse({ agent: 'arch-review', content: 'OK' }),
      makeResponse({ agent: 'security-review', content: 'OK' }),
      makeResponse({ agent: 'supervise', content: 'Pass' }),
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
    expect(calledAgents).toContain('../agents/arch-review.md');
    expect(calledAgents).toContain('../agents/security-review.md');
  });
});
