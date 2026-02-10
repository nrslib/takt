/**
 * PieceEngine integration tests: Report phase (Phase 2) blocked handling.
 *
 * Covers:
 * - Report phase blocked propagates to PieceEngine's handleBlocked flow
 * - User input triggers full movement retry (Phase 1 → 2 → 3)
 * - Null user input aborts the piece
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';

// --- Mock setup (must be before imports that use these modules) ---

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/piece/evaluation/index.js', () => ({
  detectMatchedRule: vi.fn(),
}));

vi.mock('../core/piece/phase-runner.js', () => ({
  needsStatusJudgmentPhase: vi.fn().mockReturnValue(false),
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue(''),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

// --- Imports (after mocks) ---

import { PieceEngine } from '../core/piece/index.js';
import { runReportPhase } from '../core/piece/index.js';
import {
  makeResponse,
  makeMovement,
  buildDefaultPieceConfig,
  mockRunAgentSequence,
  mockDetectMatchedRuleSequence,
  createTestTmpDir,
  applyDefaultMocks,
} from './engine-test-helpers.js';
import type { PieceConfig, OutputContractItem } from '../core/models/index.js';

/**
 * Build a piece config where a movement has outputContracts (triggering report phase).
 * plan → implement (with report) → supervise
 */
function buildConfigWithReport(): PieceConfig {
  const reportContract: OutputContractItem = {
    name: '02-coder-scope.md',
    label: 'Scope',
    description: 'Scope report',
  };

  return buildDefaultPieceConfig({
    movements: [
      makeMovement('plan', {
        rules: [
          { condition: 'Requirements are clear', next: 'implement' },
          { condition: 'Requirements unclear', next: 'ABORT' },
        ],
      }),
      makeMovement('implement', {
        outputContracts: [reportContract],
        rules: [
          { condition: 'Implementation complete', next: 'supervise' },
          { condition: 'Cannot proceed', next: 'plan' },
        ],
      }),
      makeMovement('supervise', {
        rules: [
          { condition: 'All checks passed', next: 'COMPLETE' },
          { condition: 'Requirements unmet', next: 'plan' },
        ],
      }),
    ],
  });
}

describe('PieceEngine Integration: Report Phase Blocked Handling', () => {
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

  it('should abort when report phase is blocked and no onUserInput callback', async () => {
    const config = buildConfigWithReport();
    const engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

    // Phase 1 succeeds for plan, then implement
    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'Plan done' }),
      makeResponse({ persona: 'implement', content: 'Impl done' }),
    ]);

    // plan → implement, then implement's report phase blocks
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
    ]);

    // Report phase returns blocked (only implement has outputContracts, so only one call)
    const blockedResponse = makeResponse({ persona: 'implement', status: 'blocked', content: 'Need clarification for report' });
    vi.mocked(runReportPhase).mockResolvedValueOnce({ blocked: true, response: blockedResponse });

    const blockedFn = vi.fn();
    const abortFn = vi.fn();
    engine.on('movement:blocked', blockedFn);
    engine.on('piece:abort', abortFn);

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(blockedFn).toHaveBeenCalledOnce();
    expect(abortFn).toHaveBeenCalledOnce();
  });

  it('should abort when report phase is blocked and onUserInput returns null', async () => {
    const config = buildConfigWithReport();
    const onUserInput = vi.fn().mockResolvedValue(null);
    const engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir, onUserInput });

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'Plan done' }),
      makeResponse({ persona: 'implement', content: 'Impl done' }),
    ]);

    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
    ]);

    const blockedResponse = makeResponse({ persona: 'implement', status: 'blocked', content: 'Need info for report' });
    vi.mocked(runReportPhase).mockResolvedValueOnce({ blocked: true, response: blockedResponse });

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(onUserInput).toHaveBeenCalledOnce();
  });

  it('should retry full movement when report phase is blocked and user provides input', async () => {
    const config = buildConfigWithReport();
    const onUserInput = vi.fn().mockResolvedValueOnce('User provided report clarification');
    const engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir, onUserInput });

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

    mockDetectMatchedRuleSequence([
      // plan → implement
      { index: 0, method: 'phase1_tag' },
      // implement (blocked, no rule eval happens)
      // implement retry → supervise
      { index: 0, method: 'phase1_tag' },
      // supervise → COMPLETE
      { index: 0, method: 'phase1_tag' },
    ]);

    // Report phase: only implement has outputContracts; blocks first, succeeds on retry
    const blockedResponse = makeResponse({ persona: 'implement', status: 'blocked', content: 'Need report clarification' });
    vi.mocked(runReportPhase).mockResolvedValueOnce({ blocked: true, response: blockedResponse }); // implement (first attempt)
    vi.mocked(runReportPhase).mockResolvedValueOnce(undefined); // implement (retry, succeeds)

    const userInputFn = vi.fn();
    engine.on('movement:user_input', userInputFn);

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(onUserInput).toHaveBeenCalledOnce();
    expect(userInputFn).toHaveBeenCalledOnce();
    expect(state.userInputs).toContain('User provided report clarification');
  });

  it('should propagate blocked content from report phase to engine response', async () => {
    const config = buildConfigWithReport();
    const engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'Plan done' }),
      makeResponse({ persona: 'implement', content: 'Original impl content' }),
    ]);

    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
    ]);

    const blockedContent = 'Blocked: need specific file path for report';
    const blockedResponse = makeResponse({ persona: 'implement', status: 'blocked', content: blockedContent });
    vi.mocked(runReportPhase).mockResolvedValueOnce({ blocked: true, response: blockedResponse });

    const blockedFn = vi.fn();
    engine.on('movement:blocked', blockedFn);

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(blockedFn).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'implement' }),
      expect.objectContaining({ status: 'blocked', content: blockedContent }),
    );
  });
});
