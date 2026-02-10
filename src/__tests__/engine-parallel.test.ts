/**
 * PieceEngine integration tests: parallel movement aggregation.
 *
 * Covers:
 * - Aggregated output format (## headers and --- separators)
 * - Individual sub-movement output storage
 * - Concurrent execution of sub-movements
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, readdirSync, readFileSync } from 'node:fs';
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
  runStatusJudgmentPhase: vi.fn().mockResolvedValue(''),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

// --- Imports (after mocks) ---

import { PieceEngine } from '../core/piece/index.js';
import { runAgent } from '../agents/runner.js';
import {
  makeResponse,
  buildDefaultPieceConfig,
  mockRunAgentSequence,
  mockDetectMatchedRuleSequence,
  createTestTmpDir,
  applyDefaultMocks,
} from './engine-test-helpers.js';

describe('PieceEngine Integration: Parallel Movement Aggregation', () => {
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

  it('should aggregate sub-movement outputs with ## headers and --- separators', async () => {
    const config = buildDefaultPieceConfig();
    const engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

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

    const reviewersOutput = state.movementOutputs.get('reviewers');
    expect(reviewersOutput).toBeDefined();
    expect(reviewersOutput!.content).toContain('## arch-review');
    expect(reviewersOutput!.content).toContain('Architecture review content');
    expect(reviewersOutput!.content).toContain('---');
    expect(reviewersOutput!.content).toContain('## security-review');
    expect(reviewersOutput!.content).toContain('Security review content');
    expect(reviewersOutput!.matchedRuleMethod).toBe('aggregate');
  });

  it('should store individual sub-movement outputs in movementOutputs', async () => {
    const config = buildDefaultPieceConfig();
    const engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

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

    expect(state.movementOutputs.has('arch-review')).toBe(true);
    expect(state.movementOutputs.has('security-review')).toBe(true);
    expect(state.movementOutputs.has('reviewers')).toBe(true);
    expect(state.movementOutputs.get('arch-review')!.content).toBe('Arch content');
    expect(state.movementOutputs.get('security-review')!.content).toBe('Sec content');
  });

  it('should persist aggregated previous_response snapshot for parallel parent movement', async () => {
    const config = buildDefaultPieceConfig();
    const engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

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
    const reviewersOutput = state.movementOutputs.get('reviewers')!.content;
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

  it('should execute sub-movements concurrently (both runAgent calls happen)', async () => {
    const config = buildDefaultPieceConfig();
    const engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

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

    // 6 total: 4 normal + 2 parallel sub-movements
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(6);

    const calledAgents = vi.mocked(runAgent).mock.calls.map(call => call[0]);
    expect(calledAgents).toContain('../personas/arch-review.md');
    expect(calledAgents).toContain('../personas/security-review.md');
  });

  it('should output rich parallel prefix when taskPrefix/taskColorIndex are provided', async () => {
    const config = buildDefaultPieceConfig();
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

    vi.mocked(runAgent).mockImplementation(async (persona, _task, options) => {
      const response = responsesByPersona.get(persona ?? '');
      if (!response) {
        throw new Error(`Unexpected persona: ${persona}`);
      }

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

    const engine = new PieceEngine(config, tmpDir, 'test task', {
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
    const config = buildDefaultPieceConfig();
    expect(
      () => new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir, taskPrefix: 'override-persona-provider' })
    ).toThrow('taskPrefix and taskColorIndex must be provided together');
  });
});
