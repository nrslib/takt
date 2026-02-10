/**
 * PieceEngine integration tests: loop_monitors (cycle detection + judge)
 *
 * Covers:
 * - Loop monitor triggers judge when cycle threshold reached
 * - Judge decision overrides normal next movement
 * - Cycle detector resets after judge intervention
 * - No trigger when threshold not reached
 * - Validation of loop_monitors config
 * - movement:cycle_detected event emission
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import type { PieceConfig, PieceMovement, LoopMonitorConfig } from '../core/models/index.js';

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
  makeMovement,
  makeRule,
  mockRunAgentSequence,
  mockDetectMatchedRuleSequence,
  createTestTmpDir,
  applyDefaultMocks,
  cleanupPieceEngine,
} from './engine-test-helpers.js';

/**
 * Build a piece config with ai_review ↔ ai_fix loop and loop_monitors.
 */
function buildConfigWithLoopMonitor(
  threshold = 3,
  monitorOverrides: Partial<LoopMonitorConfig> = {},
): PieceConfig {
  return {
    name: 'test-loop-monitor',
    description: 'Test piece with loop monitors',
    maxMovements: 30,
    initialMovement: 'implement',
    loopMonitors: [
      {
        cycle: ['ai_review', 'ai_fix'],
        threshold,
        judge: {
          rules: [
            { condition: 'Healthy', next: 'ai_review' },
            { condition: 'Unproductive', next: 'reviewers' },
          ],
        },
        ...monitorOverrides,
      },
    ],
    movements: [
      makeMovement('implement', {
        rules: [makeRule('done', 'ai_review')],
      }),
      makeMovement('ai_review', {
        rules: [
          makeRule('No issues', 'reviewers'),
          makeRule('Issues found', 'ai_fix'),
        ],
      }),
      makeMovement('ai_fix', {
        rules: [
          makeRule('Fixed', 'ai_review'),
          makeRule('No fix needed', 'reviewers'),
        ],
      }),
      makeMovement('reviewers', {
        rules: [makeRule('All approved', 'COMPLETE')],
      }),
    ],
  };
}

describe('PieceEngine Integration: Loop Monitors', () => {
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

  // =====================================================
  // 1. Cycle triggers judge → unproductive → skip to reviewers
  // =====================================================
  describe('Judge triggered on cycle threshold', () => {
    it('should run judge and redirect to reviewers when cycle is unproductive', async () => {
      const config = buildConfigWithLoopMonitor(2);
      engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        // implement
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        // ai_review → issues found
        makeResponse({ persona: 'ai_review', content: 'Issues found: X' }),
        // ai_fix → fixed → ai_review
        makeResponse({ persona: 'ai_fix', content: 'Fixed X' }),
        // ai_review → issues found again
        makeResponse({ persona: 'ai_review', content: 'Issues found: Y' }),
        // ai_fix → fixed → cycle threshold reached (2 cycles complete)
        makeResponse({ persona: 'ai_fix', content: 'Fixed Y' }),
        // Judge runs (synthetic movement)
        makeResponse({ persona: 'supervisor', content: 'Unproductive loop detected' }),
        // reviewers (after judge redirects here)
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // implement → ai_review
        { index: 1, method: 'phase1_tag' },  // ai_review → ai_fix (issues found)
        { index: 0, method: 'phase1_tag' },  // ai_fix → ai_review (fixed)
        { index: 1, method: 'phase1_tag' },  // ai_review → ai_fix (issues found again)
        { index: 0, method: 'phase1_tag' },  // ai_fix → ai_review (fixed) — but cycle detected!
        // Judge rule match: Unproductive (index 1) → reviewers
        { index: 1, method: 'ai_judge_fallback' },
        // reviewers → COMPLETE
        { index: 0, method: 'phase1_tag' },
      ]);

      const cycleDetectedFn = vi.fn();
      engine.on('movement:cycle_detected', cycleDetectedFn);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      expect(cycleDetectedFn).toHaveBeenCalledOnce();
      expect(cycleDetectedFn.mock.calls[0][1]).toBe(2); // cycleCount
      // 7 iterations: implement + ai_review + ai_fix + ai_review + ai_fix + judge + reviewers
      expect(state.iteration).toBe(7);
    });

    it('should run judge and continue loop when cycle is healthy', async () => {
      const config = buildConfigWithLoopMonitor(2);
      engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        // implement
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        // Cycle 1: ai_review → ai_fix
        makeResponse({ persona: 'ai_review', content: 'Issues found: A' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed A' }),
        // Cycle 2: ai_review → ai_fix (threshold reached)
        makeResponse({ persona: 'ai_review', content: 'Issues found: B' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed B' }),
        // Judge says healthy → continue to ai_review
        makeResponse({ persona: 'supervisor', content: 'Loop is healthy, making progress' }),
        // ai_review → no issues
        makeResponse({ persona: 'ai_review', content: 'No issues remaining' }),
        // reviewers → COMPLETE
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // implement → ai_review
        { index: 1, method: 'phase1_tag' },  // ai_review → ai_fix
        { index: 0, method: 'phase1_tag' },  // ai_fix → ai_review
        { index: 1, method: 'phase1_tag' },  // ai_review → ai_fix
        { index: 0, method: 'phase1_tag' },  // ai_fix → ai_review — cycle detected!
        // Judge: Healthy (index 0) → ai_review
        { index: 0, method: 'ai_judge_fallback' },
        // ai_review → reviewers (no issues)
        { index: 0, method: 'phase1_tag' },
        // reviewers → COMPLETE
        { index: 0, method: 'phase1_tag' },
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      // 8 iterations: impl + ai_review*3 + ai_fix*2 + judge + reviewers
      expect(state.iteration).toBe(8);
    });
  });

  // =====================================================
  // 2. No trigger when threshold not reached
  // =====================================================
  describe('No trigger before threshold', () => {
    it('should not trigger judge when fewer cycles than threshold', async () => {
      const config = buildConfigWithLoopMonitor(3); // threshold = 3, only do 1 cycle
      engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'Issues found' }),
        makeResponse({ persona: 'ai_fix', content: 'Fixed' }),
        makeResponse({ persona: 'ai_review', content: 'No issues' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // implement → ai_review
        { index: 1, method: 'phase1_tag' },  // ai_review → ai_fix
        { index: 0, method: 'phase1_tag' },  // ai_fix → ai_review
        { index: 0, method: 'phase1_tag' },  // ai_review → reviewers (no issues)
        { index: 0, method: 'phase1_tag' },  // reviewers → COMPLETE
      ]);

      const cycleDetectedFn = vi.fn();
      engine.on('movement:cycle_detected', cycleDetectedFn);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      expect(cycleDetectedFn).not.toHaveBeenCalled();
      // No judge was called, so only 5 iterations
      expect(state.iteration).toBe(5);
      expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(5);
    });
  });

  // =====================================================
  // 3. Validation errors
  // =====================================================
  describe('Config validation', () => {
    it('should throw when loop_monitor cycle references nonexistent movement', () => {
      const config = buildConfigWithLoopMonitor(3);
      config.loopMonitors = [
        {
          cycle: ['ai_review', 'nonexistent'],
          threshold: 3,
          judge: {
            rules: [{ condition: 'test', next: 'ai_review' }],
          },
        },
      ];

      expect(() => {
        new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });
      }).toThrow('nonexistent');
    });

    it('should throw when loop_monitor judge rule references nonexistent movement', () => {
      const config = buildConfigWithLoopMonitor(3);
      config.loopMonitors = [
        {
          cycle: ['ai_review', 'ai_fix'],
          threshold: 3,
          judge: {
            rules: [{ condition: 'test', next: 'nonexistent_target' }],
          },
        },
      ];

      expect(() => {
        new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });
      }).toThrow('nonexistent_target');
    });
  });

  // =====================================================
  // 4. No loop monitors configured
  // =====================================================
  describe('No loop monitors', () => {
    it('should work normally without loop_monitors configured', async () => {
      const config = buildConfigWithLoopMonitor(3);
      config.loopMonitors = undefined;
      engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ persona: 'implement', content: 'Done' }),
        makeResponse({ persona: 'ai_review', content: 'No issues' }),
        makeResponse({ persona: 'reviewers', content: 'All approved' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
      ]);

      const state = await engine.run();
      expect(state.status).toBe('completed');
      expect(state.iteration).toBe(3);
    });
  });
});
