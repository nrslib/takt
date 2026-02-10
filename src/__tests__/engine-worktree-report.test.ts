/**
 * Tests for worktree environment: reportDir should use cwd (clone dir), not projectCwd.
 *
 * Issue #113: In worktree mode, reportDir must be resolved relative to cwd (clone) to
 * prevent agents from discovering and editing the main repository via instruction paths.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

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
  makeRule,
  mockRunAgentSequence,
  mockDetectMatchedRuleSequence,
  applyDefaultMocks,
} from './engine-test-helpers.js';
import type { PieceConfig } from '../core/models/index.js';

function createWorktreeDirs(): { projectCwd: string; cloneCwd: string } {
  const base = join(tmpdir(), `takt-worktree-test-${randomUUID()}`);
  const projectCwd = join(base, 'project');
  const cloneCwd = join(base, 'clone');

  // Project side: real .takt/runs directory (for non-worktree tests)
  mkdirSync(join(projectCwd, '.takt', 'runs', 'test-report-dir', 'reports'), { recursive: true });

  // Clone side: .takt/runs directory (reports now written directly to clone)
  mkdirSync(join(cloneCwd, '.takt', 'runs', 'test-report-dir', 'reports'), { recursive: true });

  return { projectCwd, cloneCwd };
}

function buildSimpleConfig(): PieceConfig {
  return {
    name: 'worktree-test',
    description: 'Test piece for worktree',
    maxMovements: 10,
    initialMovement: 'review',
    movements: [
      makeMovement('review', {
        outputContracts: [{ label: 'review', path: '00-review.md' }],
        rules: [
          makeRule('approved', 'COMPLETE'),
        ],
      }),
    ],
  };
}

describe('PieceEngine: worktree reportDir resolution', () => {
  let projectCwd: string;
  let cloneCwd: string;
  let baseDir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    const dirs = createWorktreeDirs();
    projectCwd = dirs.projectCwd;
    cloneCwd = dirs.cloneCwd;
    baseDir = join(cloneCwd, '..');
  });

  afterEach(() => {
    if (existsSync(baseDir)) {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('should pass cloneCwd-based reportDir to phase runner context in worktree mode', async () => {
    // Given: worktree environment where cwd !== projectCwd
    const config = buildSimpleConfig();
    const engine = new PieceEngine(config, cloneCwd, 'test task', {
      projectCwd,
    });

    mockRunAgentSequence([
      makeResponse({ persona: 'review', content: 'Review done' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'tag' as const },
    ]);

    // When: run the piece
    await engine.run();

    // Then: runReportPhase was called with context containing cloneCwd-based reportDir
    const reportPhaseMock = vi.mocked(runReportPhase);
    expect(reportPhaseMock).toHaveBeenCalled();
    const phaseCtx = reportPhaseMock.mock.calls[0][2] as { reportDir: string };

    // reportDir should be resolved from cloneCwd (cwd), not projectCwd
    // This prevents agents from discovering the main repository path via instruction
    const expectedPath = join(cloneCwd, '.takt/runs/test-report-dir/reports');
    const unexpectedPath = join(projectCwd, '.takt/runs/test-report-dir/reports');

    expect(phaseCtx.reportDir).toBe(expectedPath);
    expect(phaseCtx.reportDir).not.toBe(unexpectedPath);
  });

  it('should pass cloneCwd-based reportDir to buildInstruction (used by {report_dir} placeholder)', async () => {
    // Given: worktree environment with a movement that uses {report_dir} in template
    const config: PieceConfig = {
      name: 'worktree-test',
      description: 'Test',
      maxMovements: 10,
      initialMovement: 'review',
      movements: [
        makeMovement('review', {
          instructionTemplate: 'Write report to {report_dir}',
          outputContracts: [{ label: 'review', path: '00-review.md' }],
          rules: [
            makeRule('approved', 'COMPLETE'),
          ],
        }),
      ],
    };
    const engine = new PieceEngine(config, cloneCwd, 'test task', {
      projectCwd,
    });

    const { runAgent } = await import('../agents/runner.js');
    mockRunAgentSequence([
      makeResponse({ persona: 'review', content: 'Review done' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'tag' as const },
    ]);

    // When: run the piece
    await engine.run();

    // Then: the instruction should contain cloneCwd-based reportDir
    // This prevents agents from discovering the main repository path
    const runAgentMock = vi.mocked(runAgent);
    expect(runAgentMock).toHaveBeenCalled();
    const instruction = runAgentMock.mock.calls[0][1] as string;

    const expectedPath = join(cloneCwd, '.takt/runs/test-report-dir/reports');
    expect(instruction).toContain(expectedPath);
    // In worktree mode, projectCwd path should NOT appear in instruction
    expect(instruction).not.toContain(join(projectCwd, '.takt/runs/test-report-dir/reports'));
  });

  it('should use same path in non-worktree mode (cwd === projectCwd)', async () => {
    // Given: normal environment where cwd === projectCwd
    const normalDir = projectCwd;
    const config = buildSimpleConfig();
    const engine = new PieceEngine(config, normalDir, 'test task', {
      projectCwd: normalDir,
    });

    mockRunAgentSequence([
      makeResponse({ persona: 'review', content: 'Review done' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'tag' as const },
    ]);

    // When: run the piece
    await engine.run();

    // Then: reportDir should be the same (cwd === projectCwd)
    const reportPhaseMock = vi.mocked(runReportPhase);
    expect(reportPhaseMock).toHaveBeenCalled();
    const phaseCtx = reportPhaseMock.mock.calls[0][2] as { reportDir: string };

    const expectedPath = join(normalDir, '.takt/runs/test-report-dir/reports');
    expect(phaseCtx.reportDir).toBe(expectedPath);
  });

  it('should use explicit reportDirName when provided', async () => {
    const normalDir = projectCwd;
    const config = buildSimpleConfig();
    const engine = new PieceEngine(config, normalDir, 'test task', {
      projectCwd: normalDir,
      reportDirName: '20260201-015714-foptng',
    });

    mockRunAgentSequence([
      makeResponse({ persona: 'review', content: 'Review done' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'tag' as const },
    ]);

    await engine.run();

    const reportPhaseMock = vi.mocked(runReportPhase);
    expect(reportPhaseMock).toHaveBeenCalled();
    const phaseCtx = reportPhaseMock.mock.calls[0][2] as { reportDir: string };
    expect(phaseCtx.reportDir).toBe(join(normalDir, '.takt/runs/20260201-015714-foptng/reports'));
  });

  it('should reject invalid explicit reportDirName', () => {
    const normalDir = projectCwd;
    const config = buildSimpleConfig();

    expect(() => new PieceEngine(config, normalDir, 'test task', {
      projectCwd: normalDir,
      reportDirName: '..',
    })).toThrow('Invalid reportDirName: ..');

    expect(() => new PieceEngine(config, normalDir, 'test task', {
      projectCwd: normalDir,
      reportDirName: '.',
    })).toThrow('Invalid reportDirName: .');

    expect(() => new PieceEngine(config, normalDir, 'test task', {
      projectCwd: normalDir,
      reportDirName: '',
    })).toThrow('Invalid reportDirName: ');
  });

  it('should persist context snapshots and update latest previous response', async () => {
    const normalDir = projectCwd;
    const config: PieceConfig = {
      name: 'snapshot-test',
      description: 'Test',
      maxMovements: 10,
      initialMovement: 'implement',
      movements: [
        makeMovement('implement', {
          policyContents: ['Policy content'],
          knowledgeContents: ['Knowledge content'],
          rules: [makeRule('go-review', 'review')],
        }),
        makeMovement('review', {
          rules: [makeRule('approved', 'COMPLETE')],
        }),
      ],
    };
    const engine = new PieceEngine(config, normalDir, 'test task', {
      projectCwd: normalDir,
      reportDirName: 'test-report-dir',
    });

    mockRunAgentSequence([
      makeResponse({ persona: 'implement', content: 'implement output' }),
      makeResponse({ persona: 'review', content: 'review output' }),
    ]);
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'tag' as const },
      { index: 0, method: 'tag' as const },
    ]);

    await engine.run();

    const base = join(normalDir, '.takt', 'runs', 'test-report-dir', 'context');
    const knowledgeDir = join(base, 'knowledge');
    const policyDir = join(base, 'policy');
    const previousResponsesDir = join(base, 'previous_responses');

    const knowledgeFiles = readdirSync(knowledgeDir);
    const policyFiles = readdirSync(policyDir);
    const previousResponseFiles = readdirSync(previousResponsesDir);

    expect(knowledgeFiles.some((name) => name.endsWith('.md'))).toBe(true);
    expect(policyFiles.some((name) => name.endsWith('.md'))).toBe(true);
    expect(previousResponseFiles).toContain('latest.md');
    expect(previousResponseFiles.filter((name) => name.endsWith('.md')).length).toBe(3);
    expect(readFileSync(join(previousResponsesDir, 'latest.md'), 'utf-8')).toBe('review output');
  });
});
