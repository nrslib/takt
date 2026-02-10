/**
 * PieceEngine integration tests: happy path and normal flow scenarios.
 *
 * Covers:
 * - Full happy path (plan → implement → ai_review → reviewers → supervise → COMPLETE)
 * - Review reject and fix loop
 * - AI review reject and fix
 * - ABORT transition
 * - Event emissions
 * - Movement output tracking
 * - Config validation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import type { PieceConfig, PieceMovement } from '../core/models/index.js';

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
  buildDefaultPieceConfig,
  mockRunAgentSequence,
  mockDetectMatchedRuleSequence,
  createTestTmpDir,
  applyDefaultMocks,
  cleanupPieceEngine,
} from './engine-test-helpers.js';

describe('PieceEngine Integration: Happy Path', () => {
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
  // 1. Happy Path
  // =====================================================
  describe('Happy path', () => {
    it('should complete: plan → implement → ai_review → reviewers(all approved) → supervise → COMPLETE', async () => {
      const config = buildDefaultPieceConfig();
      engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Plan complete' }),
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'No issues' }),
        makeResponse({ persona: 'arch-review', content: 'Architecture OK' }),
        makeResponse({ persona: 'security-review', content: 'Security OK' }),
        makeResponse({ persona: 'supervise', content: 'All passed' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // plan → implement
        { index: 0, method: 'phase1_tag' },  // implement → ai_review
        { index: 0, method: 'phase1_tag' },  // ai_review → reviewers
        { index: 0, method: 'phase1_tag' },  // arch-review → approved
        { index: 0, method: 'phase1_tag' },  // security-review → approved
        { index: 0, method: 'aggregate' },   // reviewers(all approved) → supervise
        { index: 0, method: 'phase1_tag' },  // supervise → COMPLETE
      ]);

      const completeFn = vi.fn();
      engine.on('piece:complete', completeFn);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      expect(state.iteration).toBe(5); // plan, implement, ai_review, reviewers, supervise
      expect(completeFn).toHaveBeenCalledOnce();
      expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(6); // 4 normal + 2 parallel sub-movements
    });
  });

  // =====================================================
  // 2. Review reject and fix loop
  // =====================================================
  describe('Review reject and fix loop', () => {
    it('should handle: reviewers(needs_fix) → fix → reviewers(all approved) → supervise → COMPLETE', async () => {
      const config = buildDefaultPieceConfig();
      engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Plan done' }),
        makeResponse({ persona: 'implement', content: 'Impl done' }),
        makeResponse({ persona: 'ai_review', content: 'No issues' }),
        // Round 1 reviewers: arch approved, security needs fix
        makeResponse({ persona: 'arch-review', content: 'OK' }),
        makeResponse({ persona: 'security-review', content: 'Vulnerability found' }),
        // fix step
        makeResponse({ persona: 'fix', content: 'Fixed security issue' }),
        // Round 2 reviewers: both approved
        makeResponse({ persona: 'arch-review', content: 'OK' }),
        makeResponse({ persona: 'security-review', content: 'Security OK now' }),
        // supervise
        makeResponse({ persona: 'supervise', content: 'All passed' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // plan → implement
        { index: 0, method: 'phase1_tag' },  // implement → ai_review
        { index: 0, method: 'phase1_tag' },  // ai_review → reviewers
        { index: 0, method: 'phase1_tag' },  // arch-review → approved
        { index: 1, method: 'phase1_tag' },  // security-review → needs_fix
        { index: 1, method: 'aggregate' },   // reviewers: any(needs_fix) → fix
        { index: 0, method: 'phase1_tag' },  // fix → reviewers
        { index: 0, method: 'phase1_tag' },  // arch-review → approved
        { index: 0, method: 'phase1_tag' },  // security-review → approved
        { index: 0, method: 'aggregate' },   // reviewers: all(approved) → supervise
        { index: 0, method: 'phase1_tag' },  // supervise → COMPLETE
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      // plan, implement, ai_review, reviewers(1st), fix, reviewers(2nd), supervise = 7
      expect(state.iteration).toBe(7);
    });

    it('should inject latest reviewers output as Previous Response for repeated fix steps', async () => {
      const config = buildDefaultPieceConfig();
      engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Plan done' }),
        makeResponse({ persona: 'implement', content: 'Impl done' }),
        makeResponse({ persona: 'ai_review', content: 'No issues' }),
        // Round 1 reviewers
        makeResponse({ persona: 'arch-review', content: 'Arch R1 OK' }),
        makeResponse({ persona: 'security-review', content: 'Sec R1 needs fix' }),
        // fix round 1
        makeResponse({ persona: 'fix', content: 'Fix R1' }),
        // Round 2 reviewers
        makeResponse({ persona: 'arch-review', content: 'Arch R2 OK' }),
        makeResponse({ persona: 'security-review', content: 'Sec R2 still failing' }),
        // fix round 2
        makeResponse({ persona: 'fix', content: 'Fix R2' }),
        // Round 3 reviewers (approved)
        makeResponse({ persona: 'arch-review', content: 'Arch R3 OK' }),
        makeResponse({ persona: 'security-review', content: 'Sec R3 OK' }),
        // supervise
        makeResponse({ persona: 'supervise', content: 'All passed' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // plan → implement
        { index: 0, method: 'phase1_tag' },  // implement → ai_review
        { index: 0, method: 'phase1_tag' },  // ai_review → reviewers
        { index: 0, method: 'phase1_tag' },  // arch-review → approved
        { index: 1, method: 'phase1_tag' },  // security-review → needs_fix
        { index: 1, method: 'aggregate' },   // reviewers: any(needs_fix) → fix
        { index: 0, method: 'phase1_tag' },  // fix → reviewers
        { index: 0, method: 'phase1_tag' },  // arch-review → approved
        { index: 1, method: 'phase1_tag' },  // security-review → needs_fix
        { index: 1, method: 'aggregate' },   // reviewers: any(needs_fix) → fix
        { index: 0, method: 'phase1_tag' },  // fix → reviewers
        { index: 0, method: 'phase1_tag' },  // arch-review → approved
        { index: 0, method: 'phase1_tag' },  // security-review → approved
        { index: 0, method: 'aggregate' },   // reviewers: all(approved) → supervise
        { index: 0, method: 'phase1_tag' },  // supervise → COMPLETE
      ]);

      const fixInstructions: string[] = [];
      engine.on('movement:start', (step, _iteration, instruction) => {
        if (step.name === 'fix') {
          fixInstructions.push(instruction);
        }
      });

      await engine.run();

      expect(fixInstructions).toHaveLength(2);

      const fix1 = fixInstructions[0]!;
      expect(fix1).toContain('## Previous Response');
      expect(fix1).toContain('Arch R1 OK');
      expect(fix1).toContain('Sec R1 needs fix');
      expect(fix1).not.toContain('Arch R2 OK');
      expect(fix1).not.toContain('Sec R2 still failing');

      const fix2 = fixInstructions[1]!;
      expect(fix2).toContain('## Previous Response');
      expect(fix2).toContain('Arch R2 OK');
      expect(fix2).toContain('Sec R2 still failing');
      expect(fix2).not.toContain('Arch R1 OK');
      expect(fix2).not.toContain('Sec R1 needs fix');
    });

    it('should use the latest movement output across different steps for Previous Response', async () => {
      const config = buildDefaultPieceConfig();
      engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Plan done' }),
        makeResponse({ persona: 'implement', content: 'Impl done' }),
        makeResponse({ persona: 'ai_review', content: 'AI issues found' }),
        // ai_fix (should see ai_review output)
        makeResponse({ persona: 'ai_fix', content: 'AI issues fixed' }),
        // reviewers (approved)
        makeResponse({ persona: 'arch-review', content: 'Arch OK' }),
        makeResponse({ persona: 'security-review', content: 'Sec OK' }),
        // supervise (should see reviewers aggregate output)
        makeResponse({ persona: 'supervise', content: 'All passed' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // plan → implement
        { index: 0, method: 'phase1_tag' },  // implement → ai_review
        { index: 1, method: 'phase1_tag' },  // ai_review → ai_fix
        { index: 0, method: 'phase1_tag' },  // ai_fix → reviewers
        { index: 0, method: 'phase1_tag' },  // arch-review → approved
        { index: 0, method: 'phase1_tag' },  // security-review → approved
        { index: 0, method: 'aggregate' },   // reviewers → supervise
        { index: 0, method: 'phase1_tag' },  // supervise → COMPLETE
      ]);

      const aiFixInstructions: string[] = [];
      const superviseInstructions: string[] = [];
      engine.on('movement:start', (step, _iteration, instruction) => {
        if (step.name === 'ai_fix') {
          aiFixInstructions.push(instruction);
        } else if (step.name === 'supervise') {
          superviseInstructions.push(instruction);
        }
      });

      await engine.run();

      expect(aiFixInstructions).toHaveLength(1);
      const aiFix = aiFixInstructions[0]!;
      expect(aiFix).toContain('## Previous Response');
      expect(aiFix).toContain('AI issues found');
      expect(aiFix).not.toContain('AI issues fixed');

      expect(superviseInstructions).toHaveLength(1);
      const supervise = superviseInstructions[0]!;
      expect(supervise).toContain('## Previous Response');
      expect(supervise).toContain('Arch OK');
      expect(supervise).toContain('Sec OK');
    });
  });

  // =====================================================
  // 3. AI review reject and fix
  // =====================================================
  describe('AI review reject and fix', () => {
    it('should handle: ai_review(issues) → ai_fix → reviewers → supervise → COMPLETE', async () => {
      const config = buildDefaultPieceConfig();
      engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Plan done' }),
        makeResponse({ persona: 'implement', content: 'Impl done' }),
        makeResponse({ persona: 'ai_review', content: 'AI issues found' }),
        makeResponse({ persona: 'ai_fix', content: 'Issues fixed' }),
        makeResponse({ persona: 'arch-review', content: 'OK' }),
        makeResponse({ persona: 'security-review', content: 'OK' }),
        makeResponse({ persona: 'supervise', content: 'All passed' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // plan → implement
        { index: 0, method: 'phase1_tag' },  // implement → ai_review
        { index: 1, method: 'phase1_tag' },  // ai_review → ai_fix (issues found)
        { index: 0, method: 'phase1_tag' },  // ai_fix → reviewers
        { index: 0, method: 'phase1_tag' },  // arch-review → approved
        { index: 0, method: 'phase1_tag' },  // security-review → approved
        { index: 0, method: 'aggregate' },   // reviewers → supervise
        { index: 0, method: 'phase1_tag' },  // supervise → COMPLETE
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      // plan, implement, ai_review, ai_fix, reviewers, supervise = 6
      expect(state.iteration).toBe(6);
    });
  });

  // =====================================================
  // 4. ABORT transition
  // =====================================================
  describe('ABORT transition', () => {
    it('should abort when movement transitions to ABORT', async () => {
      const config = buildDefaultPieceConfig();
      engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Requirements unclear' }),
      ]);

      // plan rule index 1 → ABORT
      mockDetectMatchedRuleSequence([
        { index: 1, method: 'phase1_tag' },
      ]);

      const abortFn = vi.fn();
      engine.on('piece:abort', abortFn);

      const state = await engine.run();

      expect(state.status).toBe('aborted');
      expect(abortFn).toHaveBeenCalledOnce();
    });
  });

  // =====================================================
  // 5. Event emissions
  // =====================================================
  describe('Event emissions', () => {
    it('should emit movement:start and movement:complete for each movement', async () => {
      const config = buildDefaultPieceConfig();
      engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

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

      const startFn = vi.fn();
      const completeFn = vi.fn();
      engine.on('movement:start', startFn);
      engine.on('movement:complete', completeFn);

      await engine.run();

      // 5 movements: plan, implement, ai_review, reviewers, supervise
      expect(startFn).toHaveBeenCalledTimes(5);
      expect(completeFn).toHaveBeenCalledTimes(5);

      const startedMovements = startFn.mock.calls.map(call => (call[0] as PieceMovement).name);
      expect(startedMovements).toEqual(['plan', 'implement', 'ai_review', 'reviewers', 'supervise']);
    });

    it('should pass instruction to movement:start for normal movements', async () => {
      const simpleConfig: PieceConfig = {
        name: 'test',
        maxMovements: 10,
        initialMovement: 'plan',
        movements: [
          makeMovement('plan', {
            rules: [makeRule('done', 'COMPLETE')],
          }),
        ],
      };
      engine = new PieceEngine(simpleConfig, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Plan done' }),
      ]);
      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },
      ]);

      const startFn = vi.fn();
      engine.on('movement:start', startFn);

      await engine.run();

      expect(startFn).toHaveBeenCalledTimes(1);
      // movement:start should receive (movement, iteration, instruction)
      const [_movement, _iteration, instruction] = startFn.mock.calls[0];
      expect(typeof instruction).toBe('string');
      expect(instruction.length).toBeGreaterThan(0);
    });

    it('should pass empty instruction to movement:start for parallel movements', async () => {
      const config = buildDefaultPieceConfig();
      engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

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

      const startFn = vi.fn();
      engine.on('movement:start', startFn);

      await engine.run();

      // Find the "reviewers" movement:start call (parallel movement)
      const reviewersCall = startFn.mock.calls.find(
        (call) => (call[0] as PieceMovement).name === 'reviewers'
      );
      expect(reviewersCall).toBeDefined();
      // Parallel movements emit empty string for instruction
      const [, , instruction] = reviewersCall!;
      expect(instruction).toBe('');
    });

    it('should emit iteration:limit when max iterations reached', async () => {
      const config = buildDefaultPieceConfig({ maxMovements: 1 });
      engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Plan' }),
      ]);
      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },
      ]);

      const limitFn = vi.fn();
      engine.on('iteration:limit', limitFn);

      await engine.run();

      expect(limitFn).toHaveBeenCalledWith(1, 1);
    });
  });

  // =====================================================
  // 6. Movement output tracking
  // =====================================================
  describe('Movement output tracking', () => {
    it('should store outputs for all executed movements', async () => {
      const config = buildDefaultPieceConfig();
      engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Plan output' }),
        makeResponse({ persona: 'implement', content: 'Implement output' }),
        makeResponse({ persona: 'ai_review', content: 'AI review output' }),
        makeResponse({ persona: 'arch-review', content: 'Arch output' }),
        makeResponse({ persona: 'security-review', content: 'Sec output' }),
        makeResponse({ persona: 'supervise', content: 'Supervise output' }),
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

      expect(state.movementOutputs.get('plan')!.content).toBe('Plan output');
      expect(state.movementOutputs.get('implement')!.content).toBe('Implement output');
      expect(state.movementOutputs.get('ai_review')!.content).toBe('AI review output');
      expect(state.movementOutputs.get('supervise')!.content).toBe('Supervise output');
    });
  });

  // =====================================================
  // 7. Phase events
  // =====================================================
  describe('Phase events', () => {
    it('should emit phase:start and phase:complete events for Phase 1', async () => {
      const simpleConfig: PieceConfig = {
        name: 'test',
        maxMovements: 10,
        initialMovement: 'plan',
        movements: [
          makeMovement('plan', {
            rules: [makeRule('done', 'COMPLETE')],
          }),
        ],
      };
      engine = new PieceEngine(simpleConfig, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Plan done' }),
      ]);
      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },
      ]);

      const phaseStartFn = vi.fn();
      const phaseCompleteFn = vi.fn();
      engine.on('phase:start', phaseStartFn);
      engine.on('phase:complete', phaseCompleteFn);

      await engine.run();

      expect(phaseStartFn).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'plan' }),
        1, 'execute', expect.any(String)
      );
      expect(phaseCompleteFn).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'plan' }),
        1, 'execute', expect.any(String), 'done', undefined
      );
    });

    it('should emit phase events for all movements in happy path', async () => {
      const config = buildDefaultPieceConfig();
      engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

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

      const phaseStartFn = vi.fn();
      const phaseCompleteFn = vi.fn();
      engine.on('phase:start', phaseStartFn);
      engine.on('phase:complete', phaseCompleteFn);

      await engine.run();

      // 4 normal movements + 2 parallel sub-movements = 6 Phase 1 invocations
      expect(phaseStartFn).toHaveBeenCalledTimes(6);
      expect(phaseCompleteFn).toHaveBeenCalledTimes(6);

      // All calls should be Phase 1 (execute) since report/judgment are mocked off
      for (const call of phaseStartFn.mock.calls) {
        expect(call[1]).toBe(1);
        expect(call[2]).toBe('execute');
      }
    });
  });

  // =====================================================
  // 8. Config validation
  // =====================================================
  describe('Config validation', () => {
    it('should throw when initial movement does not exist', () => {
      const config = buildDefaultPieceConfig({ initialMovement: 'nonexistent' });

      expect(() => {
        new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });
      }).toThrow('Unknown movement: nonexistent');
    });

    it('should throw when rule references nonexistent movement', () => {
      const config: PieceConfig = {
        name: 'test',
        maxMovements: 10,
        initialMovement: 'step1',
        movements: [
          makeMovement('step1', {
            rules: [makeRule('done', 'nonexistent_step')],
          }),
        ],
      };

      expect(() => {
        new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });
      }).toThrow('nonexistent_step');
    });

    it('should throw when startMovement option references nonexistent movement', () => {
      const config = buildDefaultPieceConfig();

      expect(() => {
        new PieceEngine(config, tmpDir, 'test task', {
          projectCwd: tmpDir,
          startMovement: 'nonexistent',
        });
      }).toThrow('Unknown movement: nonexistent');
    });
  });

  // =====================================================
  // 9. startMovement option
  // =====================================================
  describe('startMovement option', () => {
    it('should start from specified movement instead of initialMovement', async () => {
      const config = buildDefaultPieceConfig();
      // Start from ai_review, skipping plan and implement
      engine = new PieceEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        startMovement: 'ai_review',
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'ai_review', content: 'No issues' }),
        makeResponse({ persona: 'arch-review', content: 'Architecture OK' }),
        makeResponse({ persona: 'security-review', content: 'Security OK' }),
        makeResponse({ persona: 'supervise', content: 'All passed' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // ai_review → reviewers
        { index: 0, method: 'phase1_tag' },  // arch-review → approved
        { index: 0, method: 'phase1_tag' },  // security-review → approved
        { index: 0, method: 'aggregate' },   // reviewers(all approved) → supervise
        { index: 0, method: 'phase1_tag' },  // supervise → COMPLETE
      ]);

      const startFn = vi.fn();
      engine.on('movement:start', startFn);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      // Should only run 3 movements: ai_review, reviewers, supervise
      expect(state.iteration).toBe(3);

      // First movement should be ai_review, not plan
      const startedMovements = startFn.mock.calls.map(call => (call[0] as PieceMovement).name);
      expect(startedMovements[0]).toBe('ai_review');
      expect(startedMovements).not.toContain('plan');
      expect(startedMovements).not.toContain('implement');
    });

    it('should use initialMovement when startMovement is not specified', async () => {
      const config = buildDefaultPieceConfig();
      engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Plan complete' }),
        makeResponse({ persona: 'implement', content: 'Implementation done' }),
        makeResponse({ persona: 'ai_review', content: 'No issues' }),
        makeResponse({ persona: 'arch-review', content: 'Architecture OK' }),
        makeResponse({ persona: 'security-review', content: 'Security OK' }),
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

      const startFn = vi.fn();
      engine.on('movement:start', startFn);

      await engine.run();

      // First movement should be plan (the initialMovement)
      const startedMovements = startFn.mock.calls.map(call => (call[0] as PieceMovement).name);
      expect(startedMovements[0]).toBe('plan');
    });
  });
});
