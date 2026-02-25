/**
 * PieceEngine tests: movement-level vars functionality.
 *
 * Covers:
 * - vars placeholders are replaced in instruction_template
 * - vars work with nested {report:{var}} expansion
 * - vars with regex special characters are handled correctly
 * - vars flow through InstructionBuilder → PieceEngine
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
import { runAgent } from '../agents/runner.js';
import {
  makeResponse,
  makeMovement,
  makeRule,
  mockRunAgentSequence,
  mockDetectMatchedRuleSequence,
  createTestTmpDir,
  applyDefaultMocks,
} from './engine-test-helpers.js';

describe('PieceEngine: Movement vars', () => {
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

  it('should replace vars placeholders in instruction_template', async () => {
    const piece: PieceConfig = {
      name: 'test-vars',
      initialMovement: 'step1',
      maxMovements: 5,
      movements: [
        makeMovement('step1', {
          instructionTemplate: 'Check file: {config_file}',
          vars: {
            config_file: 'app-config.yaml',
          },
          rules: [makeRule('done', 'COMPLETE')],
        }),
      ],
    };

    mockRunAgentSequence([makeResponse('step1 done')]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    const engine = new PieceEngine(piece, tmpDir, 'Test task', { projectCwd: tmpDir });
    await engine.run();

    // Verify that vars were replaced in the instruction
    expect(runAgent).toHaveBeenCalledWith(
      expect.any(String), // persona
      expect.stringContaining('Check file: app-config.yaml'), // prompt
      expect.any(Object), // options
    );
  });

  it('should support nested {report:{var}} expansion', async () => {
    const piece: PieceConfig = {
      name: 'test-vars-nested',
      initialMovement: 'review',
      maxMovements: 5,
      movements: [
        makeMovement('review', {
          instructionTemplate: 'Read report: {report:{test_report}}',
          vars: {
            test_report: 'test-scope.md',
          },
          rules: [makeRule('done', 'COMPLETE')],
        }),
      ],
    };

    mockRunAgentSequence([makeResponse('review done')]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    const engine = new PieceEngine(piece, tmpDir, 'Test task', { projectCwd: tmpDir });
    await engine.run();

    // Verify nested expansion: {test_report} → test-scope.md, then {report:test-scope.md} → test-report-dir/test-scope.md
    expect(runAgent).toHaveBeenCalledWith(
      expect.any(String), // persona
      expect.stringContaining('test-report-dir/reports/test-scope.md'), // prompt (note: full path includes /reports/)
      expect.any(Object), // options
    );
  });

  it('should handle vars keys with regex special characters (dots)', async () => {
    const piece: PieceConfig = {
      name: 'test-vars-regex',
      initialMovement: 'process',
      maxMovements: 5,
      movements: [
        makeMovement('process', {
          instructionTemplate: 'File: {test.md}, Not matched: {testXmd}',
          vars: {
            'test.md': 'correct-value',
          },
          rules: [makeRule('done', 'COMPLETE')],
        }),
      ],
    };

    mockRunAgentSequence([makeResponse('process done')]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    const engine = new PieceEngine(piece, tmpDir, 'Test task', { projectCwd: tmpDir });
    await engine.run();

    // Verify that only exact match is replaced, not regex-like patterns
    expect(runAgent).toHaveBeenCalledWith(
      expect.any(String), // persona
      expect.stringContaining('File: correct-value, Not matched: {testXmd}'), // prompt
      expect.any(Object), // options
    );
  });

  it('should handle vars keys with multiple regex special characters', async () => {
    const piece: PieceConfig = {
      name: 'test-vars-complex',
      initialMovement: 'validate',
      maxMovements: 5,
      movements: [
        makeMovement('validate', {
          instructionTemplate: '{config[prod].yaml} and {pattern.*}',
          vars: {
            'config[prod].yaml': 'prod-config',
            'pattern.*': 'wildcard-pattern',
          },
          rules: [makeRule('done', 'COMPLETE')],
        }),
      ],
    };

    mockRunAgentSequence([makeResponse('validate done')]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    const engine = new PieceEngine(piece, tmpDir, 'Test task', { projectCwd: tmpDir });
    await engine.run();

    // Verify all special characters are escaped correctly
    expect(runAgent).toHaveBeenCalledWith(
      expect.any(String), // persona
      expect.stringContaining('prod-config and wildcard-pattern'), // prompt
      expect.any(Object), // options
    );
  });

  it('should not match similar patterns when key contains dots', async () => {
    const piece: PieceConfig = {
      name: 'test-vars-no-fuzzy',
      initialMovement: 'check',
      maxMovements: 5,
      movements: [
        makeMovement('check', {
          instructionTemplate: 'Value: {a.b}, Should not match: {aXb} or {a_b}',
          vars: {
            'a.b': 'exact-match-only',
          },
          rules: [makeRule('done', 'COMPLETE')],
        }),
      ],
    };

    mockRunAgentSequence([makeResponse('check done')]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    const engine = new PieceEngine(piece, tmpDir, 'Test task', { projectCwd: tmpDir });
    await engine.run();

    // Verify only exact placeholder is replaced
    expect(runAgent).toHaveBeenCalledWith(
      expect.any(String), // persona
      expect.stringContaining('Value: exact-match-only, Should not match: {aXb} or {a_b}'), // prompt
      expect.any(Object), // options
    );
  });

  it('should handle vars with backslashes and pipes', async () => {
    const piece: PieceConfig = {
      name: 'test-vars-backslash',
      initialMovement: 'parse',
      maxMovements: 5,
      movements: [
        makeMovement('parse', {
          instructionTemplate: '{path\\file} and {option|default}',
          vars: {
            'path\\file': 'windows-path',
            'option|default': 'or-pattern',
          },
          rules: [makeRule('done', 'COMPLETE')],
        }),
      ],
    };

    mockRunAgentSequence([makeResponse('parse done')]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    const engine = new PieceEngine(piece, tmpDir, 'Test task', { projectCwd: tmpDir });
    await engine.run();

    // Verify backslashes and pipes are escaped correctly
    expect(runAgent).toHaveBeenCalledWith(
      expect.any(String), // persona
      expect.stringContaining('windows-path and or-pattern'), // prompt
      expect.any(Object), // options
    );
  });
});
