import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowConfig } from '../core/models/index.js';

const injectedLstatError = vi.hoisted(() => ({
  path: '',
  error: undefined as NodeJS.ErrnoException | undefined,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    lstatSync: ((path: Parameters<typeof actual.lstatSync>[0], options?: Parameters<typeof actual.lstatSync>[1]) => {
      if (String(path) === injectedLstatError.path && injectedLstatError.error !== undefined) {
        throw injectedLstatError.error;
      }
      return actual.lstatSync(path, options as never);
    }) as typeof actual.lstatSync,
  };
});

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/workflow/evaluation/index.js', () => ({
  detectMatchedRule: vi.fn(),
}));

vi.mock('../core/workflow/phase-runner.js', () => ({
  needsStatusJudgmentPhase: vi.fn().mockReturnValue(false),
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ tag: '', ruleIndex: 0, method: 'auto_select' }),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

import { runAgent } from '../agents/runner.js';
import { WorkflowEngine } from '../core/workflow/index.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import {
  applyDefaultMocks,
  createTestTmpDir,
  makeResponse,
  makeRule,
  makeStep,
  mockDetectMatchedRuleSequence,
  mockRunAgentSequence,
} from './engine-test-helpers.js';

const CHILD_NAMESPACE = ['subworkflows', 'child'] as const;
const REPORT_NAME = 'review.md';

function workflowConfig(): WorkflowConfig {
  return {
    name: 'report-reference-integration',
    maxSteps: 10,
    initialStep: 'consumer',
    steps: [makeStep('consumer', {
      instruction: `Use {report:${REPORT_NAME}}`,
      passPreviousResponse: false,
      rules: [makeRule('done', 'COMPLETE')],
    })],
  };
}

describe('report reference integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    injectedLstatError.path = '';
    injectedLstatError.error = undefined;
    tmpDir = createTestTmpDir();
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.each(['ENOENT', 'ENOTDIR'])('子 report の %s だけを欠落として親 report へ解決する', async (code) => {
    const parentPaths = buildRunPaths(tmpDir, 'test-report-dir');
    const childPaths = buildRunPaths(tmpDir, 'test-report-dir', [...CHILD_NAMESPACE]);
    mkdirSync(childPaths.reportsAbs, { recursive: true });
    writeFileSync(join(parentPaths.reportsRootAbs, REPORT_NAME), 'parent report');
    injectedLstatError.path = join(childPaths.reportsAbs, REPORT_NAME);
    injectedLstatError.error = Object.assign(new Error(`injected ${code}`), { code });
    mockRunAgentSequence([makeResponse({ persona: 'consumer', content: 'done' })]);
    mockDetectMatchedRuleSequence([{ index: 0, matched: true } as never]);

    const engine = new WorkflowEngine(workflowConfig(), tmpDir, 'consume report', {
      projectCwd: tmpDir,
      reportDirName: 'test-report-dir',
      runPathNamespace: [...CHILD_NAMESPACE],
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAgent).mock.calls[0]?.[1]).toContain('Use parent report');
  });

  it.each(['EACCES', 'EPERM', 'EIO'])(
    '子 report の %s は親 report が存在しても元エラーを伝播する',
    async (code) => {
      const parentPaths = buildRunPaths(tmpDir, 'test-report-dir');
      const childPaths = buildRunPaths(tmpDir, 'test-report-dir', [...CHILD_NAMESPACE]);
      mkdirSync(childPaths.reportsAbs, { recursive: true });
      writeFileSync(join(parentPaths.reportsRootAbs, REPORT_NAME), 'parent report');
      const error = Object.assign(new Error(`injected ${code}`), { code });
      injectedLstatError.path = join(childPaths.reportsAbs, REPORT_NAME);
      injectedLstatError.error = error;

      const engine = new WorkflowEngine(workflowConfig(), tmpDir, 'consume report', {
        projectCwd: tmpDir,
        reportDirName: 'test-report-dir',
        runPathNamespace: [...CHILD_NAMESPACE],
      });

      await expect(engine.run()).rejects.toBe(error);
      expect((error as NodeJS.ErrnoException).code).toBe(code);
      expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
    },
  );
});
