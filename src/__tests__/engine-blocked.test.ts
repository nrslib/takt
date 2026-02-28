/**
 * PieceEngine integration tests: blocked handling scenarios.
 *
 * Covers:
 * - Blocked without onUserInput callback (abort)
 * - Blocked with onUserInput returning null (abort)
 * - Blocked with onUserInput providing input (continue)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

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
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ tag: '', ruleIndex: 0, method: 'auto_select' }),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

// --- Imports (after mocks) ---

import { PieceEngine } from '../core/piece/index.js';
import {
  makeResponse,
  buildDefaultPieceConfig,
  mockRunAgentSequence,
  mockDetectMatchedRuleSequence,
  createTestTmpDir,
  applyDefaultMocks,
} from './engine-test-helpers.js';

describe('PieceEngine Integration: Blocked Handling', () => {
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
    const config = buildDefaultPieceConfig();
    const engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', status: 'blocked', content: 'Need clarification' }),
    ]);

    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
    ]);

    const blockedFn = vi.fn();
    const abortFn = vi.fn();
    engine.on('movement:blocked', blockedFn);
    engine.on('piece:abort', abortFn);

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(blockedFn).toHaveBeenCalledOnce();
    expect(abortFn).toHaveBeenCalledOnce();
  });

  it('should abort when blocked and onUserInput returns null', async () => {
    const config = buildDefaultPieceConfig();
    const onUserInput = vi.fn().mockResolvedValue(null);
    const engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir, onUserInput });

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', status: 'blocked', content: 'Need info' }),
    ]);

    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
    ]);

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(onUserInput).toHaveBeenCalledOnce();
  });

  it('should continue when blocked and onUserInput provides input', async () => {
    const config = buildDefaultPieceConfig();
    const onUserInput = vi.fn().mockResolvedValueOnce('User provided clarification');
    const engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir, onUserInput });

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
    engine.on('movement:user_input', userInputFn);

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(onUserInput).toHaveBeenCalledOnce();
    expect(userInputFn).toHaveBeenCalledOnce();
    expect(state.userInputs).toContain('User provided clarification');
  });

  it('should refresh previous response snapshot when Phase 1 returns blocked', async () => {
    const config = buildDefaultPieceConfig();
    const onUserInput = vi.fn().mockResolvedValueOnce(null);
    const engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir, onUserInput });

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', status: 'done', content: 'Plan done' }),
      makeResponse({ persona: 'implement', status: 'blocked', content: 'Need clarification' }),
    ]);

    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' }, // plan -> implement
    ]);

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(state.lastOutput?.status).toBe('blocked');
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

  it('should abort immediately when movement returns error status', async () => {
    const config = buildDefaultPieceConfig();
    const onUserInput = vi.fn().mockResolvedValueOnce('should not be called');
    const engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir, onUserInput });

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', status: 'error', content: 'Transport error', error: 'Transport error' }),
    ]);

    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
    ]);

    const abortFn = vi.fn();
    engine.on('piece:abort', abortFn);

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(onUserInput).not.toHaveBeenCalled();
    expect(abortFn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('Transport error'));
  });

});
