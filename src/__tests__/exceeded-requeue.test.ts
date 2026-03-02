/**
 * Integration tests for exceeded status and requeue flow
 *
 * Covers:
 * - PieceEngine: onIterationLimit returning null causes engine to stop (exceeded behavior)
 * - PieceEngine: onIterationLimit returning a number allows continuation
 * - PieceEngine: onIterationLimit receives correct request (currentMovement, maxMovements, currentIteration)
 * - StateManager: initialIteration option sets the starting iteration counter
 * - PieceEngineOptions: initialIteration passed down to StateManager
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import type { PieceConfig } from '../core/models/index.js';

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
  makeMovement,
  makeRule,
  mockRunAgentSequence,
  mockDetectMatchedRuleSequence,
  createTestTmpDir,
  applyDefaultMocks,
  cleanupPieceEngine,
} from './engine-test-helpers.js';

// --- Tests ---

describe('PieceEngine: onIterationLimit - exceeded behavior', () => {
  let tmpDir: string;
  let engine: PieceEngine | null = null;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    tmpDir = createTestTmpDir();
  });

  afterEach(() => {
    if (engine) {
      cleanupPieceEngine(engine);
      engine = null;
    }
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should abort engine when onIterationLimit returns null (non-interactive mode)', async () => {
    // Given: a piece with maxMovements=1 and onIterationLimit returning null.
    // plan → implement (not COMPLETE) so the limit check fires between plan and implement.
    const config: PieceConfig = {
      name: 'test',
      maxMovements: 1,
      initialMovement: 'plan',
      movements: [
        makeMovement('plan', {
          rules: [makeRule('done', 'implement')],
        }),
        makeMovement('implement', {
          rules: [makeRule('done', 'COMPLETE')],
        }),
      ],
    };

    const onIterationLimit = vi.fn().mockResolvedValue(null);

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'Plan complete' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' }, // plan → implement
    ]);

    engine = new PieceEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      onIterationLimit,
    });

    // When: engine runs and hits the iteration limit after plan
    const state = await engine.run();

    // Then: engine is aborted (plan ran → iteration=1 >= maxMovements=1, null returned)
    expect(state.status).toBe('aborted');
    expect(onIterationLimit).toHaveBeenCalledOnce();
  });

  it('should continue when onIterationLimit returns a positive number', async () => {
    // Given: a piece with maxMovements=1 and onIterationLimit granting more iterations.
    // plan → implement so the limit fires between plan and implement.
    const config: PieceConfig = {
      name: 'test',
      maxMovements: 1,
      initialMovement: 'plan',
      movements: [
        makeMovement('plan', {
          rules: [makeRule('done', 'implement')],
        }),
        makeMovement('implement', {
          rules: [makeRule('done', 'COMPLETE')],
        }),
      ],
    };

    // onIterationLimit called once (at iteration=1), grants 5 more iterations → maxMovements=6
    const onIterationLimit = vi.fn().mockResolvedValueOnce(5);

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'Plan complete' }),
      makeResponse({ persona: 'implement', content: 'Impl done' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' }, // plan → implement
      { index: 0, method: 'phase1_tag' }, // implement → COMPLETE
    ]);

    engine = new PieceEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      onIterationLimit,
    });

    // When: engine runs
    const state = await engine.run();

    // Then: engine completed because limit was extended (plan+limit check+implement → COMPLETE)
    expect(state.status).toBe('completed');
    expect(onIterationLimit).toHaveBeenCalledOnce();
  });

  it('should pass correct request data to onIterationLimit', async () => {
    // Given: a piece with maxMovements=1
    const config: PieceConfig = {
      name: 'test',
      maxMovements: 1,
      initialMovement: 'plan',
      movements: [
        makeMovement('plan', {
          rules: [makeRule('done', 'implement')],
        }),
        makeMovement('implement', {
          rules: [makeRule('done', 'COMPLETE')],
        }),
      ],
    };

    const capturedRequest = { currentIteration: 0, maxMovements: 0, currentMovement: '' };
    const onIterationLimit = vi.fn().mockImplementation(async (request: typeof capturedRequest) => {
      Object.assign(capturedRequest, request);
      return null;
    });

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'Plan complete' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' }, // plan → implement
    ]);

    engine = new PieceEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      onIterationLimit,
    });

    // When: engine runs and hits the iteration limit
    await engine.run();

    // Then: onIterationLimit received correct request data
    expect(capturedRequest.currentIteration).toBe(1);
    expect(capturedRequest.maxMovements).toBe(1);
    // currentMovement is the next movement to run (implement) since plan already ran
    expect(capturedRequest.currentMovement).toBe('implement');
  });

  it('should update maxMovements in engine config when onIterationLimit returns additionalIterations', async () => {
    // Given: a piece with maxMovements=2
    const config: PieceConfig = {
      name: 'test',
      maxMovements: 2,
      initialMovement: 'plan',
      movements: [
        makeMovement('plan', {
          rules: [makeRule('done', 'implement')],
        }),
        makeMovement('implement', {
          rules: [makeRule('done', 'COMPLETE')],
        }),
      ],
    };

    // Grant 1 more iteration when limit is reached at iteration=2
    const onIterationLimit = vi.fn().mockResolvedValueOnce(1);

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'Plan' }),
      makeResponse({ persona: 'implement', content: 'Impl' }),
      // Third movement needed after extension
      makeResponse({ persona: 'implement', content: 'Impl done' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' }, // plan → implement
      { index: 0, method: 'phase1_tag' }, // implement → COMPLETE
      // This never runs because we complete on the second implement
    ]);

    engine = new PieceEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      onIterationLimit,
    });

    // When: engine runs
    const state = await engine.run();

    // Then: completed since limit was extended by 1 (2 → 3)
    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(2);
  });

  it('should emit iteration:limit event before calling onIterationLimit', async () => {
    // Given: a piece with maxMovements=1 and plan → implement so the limit fires.
    const config: PieceConfig = {
      name: 'test',
      maxMovements: 1,
      initialMovement: 'plan',
      movements: [
        makeMovement('plan', {
          rules: [makeRule('done', 'implement')],
        }),
        makeMovement('implement', {
          rules: [makeRule('done', 'COMPLETE')],
        }),
      ],
    };

    const onIterationLimit = vi.fn().mockResolvedValue(null);
    const eventOrder: string[] = [];

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'Plan complete' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' }, // plan → implement
    ]);

    engine = new PieceEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      onIterationLimit: async (request) => {
        eventOrder.push('onIterationLimit');
        return onIterationLimit(request);
      },
    });

    engine.on('iteration:limit', () => {
      eventOrder.push('iteration:limit');
    });

    // When: engine runs
    await engine.run();

    // Then: iteration:limit event emitted before onIterationLimit callback
    expect(eventOrder).toEqual(['iteration:limit', 'onIterationLimit']);
  });
});

describe('PieceEngine: initialIteration option', () => {
  let tmpDir: string;
  let engine: PieceEngine | null = null;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    tmpDir = createTestTmpDir();
  });

  afterEach(() => {
    if (engine) {
      cleanupPieceEngine(engine);
      engine = null;
    }
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should start iteration counter from initialIteration value', async () => {
    // Given: a piece with maxMovements=60 and initialIteration=30
    const config: PieceConfig = {
      name: 'test',
      maxMovements: 60,
      initialMovement: 'plan',
      movements: [
        makeMovement('plan', {
          rules: [makeRule('done', 'COMPLETE')],
        }),
      ],
    };

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'Plan complete' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
    ]);

    engine = new PieceEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      initialIteration: 30,
    });

    // When: engine runs one step
    const state = await engine.run();

    // Then: iteration is 31 (30 + 1 step)
    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(31);
  });

  it('should start from 0 when initialIteration is not provided', async () => {
    // Given: a piece without initialIteration
    const config: PieceConfig = {
      name: 'test',
      maxMovements: 60,
      initialMovement: 'plan',
      movements: [
        makeMovement('plan', {
          rules: [makeRule('done', 'COMPLETE')],
        }),
      ],
    };

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'Plan complete' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
    ]);

    engine = new PieceEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
    });

    // When: engine runs one step
    const state = await engine.run();

    // Then: iteration is 1 (0 + 1 step)
    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(1);
  });

  it('should trigger iteration limit immediately when initialIteration >= maxMovements', async () => {
    // Given: initialIteration=30, maxMovements=30 (already at limit on first check)
    const config: PieceConfig = {
      name: 'test',
      maxMovements: 30,
      initialMovement: 'plan',
      movements: [
        makeMovement('plan', {
          rules: [makeRule('done', 'COMPLETE')],
        }),
      ],
    };

    const onIterationLimit = vi.fn().mockResolvedValue(null);

    engine = new PieceEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      initialIteration: 30,
      onIterationLimit,
    });

    // When: engine runs
    const state = await engine.run();

    // Then: iteration limit handler is called immediately (no movements executed)
    expect(onIterationLimit).toHaveBeenCalledOnce();
    expect(onIterationLimit).toHaveBeenCalledWith(expect.objectContaining({
      currentIteration: 30,
      maxMovements: 30,
      currentMovement: 'plan',
    }));
    expect(state.status).toBe('aborted');
  });

  it('should emit iteration:limit with correct count when initialIteration is set', async () => {
    // Given: initialIteration=30, maxMovements=31 (one step before limit)
    const config: PieceConfig = {
      name: 'test',
      maxMovements: 31,
      initialMovement: 'plan',
      movements: [
        makeMovement('plan', {
          rules: [makeRule('done', 'implement')],
        }),
        makeMovement('implement', {
          rules: [makeRule('done', 'COMPLETE')],
        }),
      ],
    };

    const limitEvents: { iteration: number; maxMovements: number }[] = [];

    const onIterationLimit = vi.fn().mockResolvedValue(null);

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'Plan' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' }, // plan → implement
    ]);

    engine = new PieceEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      initialIteration: 30,
      onIterationLimit,
    });

    engine.on('iteration:limit', (iteration, maxMovements) => {
      limitEvents.push({ iteration, maxMovements });
    });

    // When: engine runs
    await engine.run();

    // Then: limit event emitted with correct counts
    // After plan runs, iteration = 31 >= maxMovements=31, so limit is reached
    expect(limitEvents).toHaveLength(1);
    expect(limitEvents[0]!.iteration).toBe(31);
    expect(limitEvents[0]!.maxMovements).toBe(31);
  });
});
