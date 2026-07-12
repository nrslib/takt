import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowConfig } from '../core/models/index.js';

vi.mock('../agents/runner.js', () => ({ runAgent: vi.fn() }));
vi.mock('../core/workflow/evaluation/index.js', () => ({ detectMatchedRule: vi.fn() }));
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
import { detectMatchedRule } from '../core/workflow/evaluation/index.js';
import { WorkflowEngine } from '../core/workflow/index.js';
import { createDefaultSystemStepServices } from '../infra/workflow/system/DefaultSystemStepServices.js';
import {
  applyDefaultMocks,
  cleanupWorkflowEngine,
  createTestTmpDir,
  makeResponse,
  makeStep,
} from './engine-test-helpers.js';

describe('rule-bound artifact effects integration', () => {
  let cwd: string;
  let engine: WorkflowEngine | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    cwd = createTestTmpDir();
    execFileSync('git', ['init', '-q'], { cwd });
    execFileSync('git', ['config', 'user.name', 'Takt Test'], { cwd });
    execFileSync('git', ['config', 'user.email', 'takt@example.test'], { cwd });
    writeFileSync(`${cwd}/README.md`, 'base\n');
    execFileSync('git', ['add', 'README.md'], { cwd });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd });
  });

  afterEach(() => {
    if (engine) cleanupWorkflowEngine(engine);
    rmSync(cwd, { recursive: true, force: true });
  });

  it('captures before review, injects exact paths, and commits only after Go', async () => {
    const phaseDir = `${cwd}/specs/phase-42-proof`;
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(`${phaseDir}/plan.md`, 'plan\n');
    writeFileSync(`${phaseDir}/task.md`, 'task\n');
    writeFileSync(`${phaseDir}/test-plan.md`, 'tests\n');

    const captureEffect = {
      type: 'capture_artifacts' as const,
      allowedPatterns: [
        'specs/phase-*/plan.md',
        'specs/phase-*/task.md',
        'specs/phase-*/test-plan.md',
      ],
      requiredBasenames: ['plan.md', 'task.md', 'test-plan.md'],
      sameParent: true as const,
    };
    const config: WorkflowConfig = {
      name: 'artifact-flow',
      maxSteps: 3,
      initialStep: 'plan',
      steps: [
        makeStep('plan', {
          instruction: 'plan',
          rules: [{ condition: 'ready', next: 'plan-review', effects: [captureEffect] }],
        }),
        makeStep('plan-review', {
          instruction: [
            '{effect:plan.capture_artifacts.manifest.artifacts[0].path}',
            '{effect:plan.capture_artifacts.manifest.artifacts[1].path}',
            '{effect:plan.capture_artifacts.manifest.artifacts[2].path}',
          ].join('\n'),
          rules: [{
            condition: 'Go',
            next: 'COMPLETE',
            effects: [{
              type: 'commit_artifacts',
              manifest: '{effect:plan.capture_artifacts.manifest}',
              message: 'approve plan',
            }],
          }],
        }),
      ],
    };

    const prompts: string[] = [];
    vi.mocked(runAgent)
      .mockImplementationOnce(async (persona, task, options) => {
        prompts.push(task);
        options?.onPromptResolved?.({
          systemPrompt: typeof persona === 'string' ? persona : '',
          userInstruction: task,
        });
        return makeResponse({ persona: 'plan', content: 'ready' });
      })
      .mockImplementationOnce(async (persona, task, options) => {
        prompts.push(task);
        options?.onPromptResolved?.({
          systemPrompt: typeof persona === 'string' ? persona : '',
          userInstruction: task,
        });
        return makeResponse({ persona: 'plan-review', content: 'Go' });
      });
    vi.mocked(detectMatchedRule)
      .mockResolvedValueOnce({ index: 0, method: 'phase1_tag' })
      .mockResolvedValueOnce({ index: 0, method: 'phase1_tag' });

    engine = new WorkflowEngine(config, cwd, 'test task', {
      projectCwd: cwd,
      provider: 'mock',
      systemStepServicesFactory: createDefaultSystemStepServices,
    });
    let abortReason = '';
    engine.on('workflow:abort', (_state, reason) => {
      abortReason = String(reason);
    });
    const state = await engine.run();

    expect(state.status, abortReason).toBe('completed');
    expect(prompts[1]).toContain('specs/phase-42-proof/plan.md');
    expect(prompts[1]).toContain('specs/phase-42-proof/task.md');
    expect(prompts[1]).toContain('specs/phase-42-proof/test-plan.md');
    expect(execFileSync('git', ['show', '--pretty=', '--name-only', 'HEAD'], { cwd, encoding: 'utf8' })
      .trim().split('\n').sort()).toEqual([
      'specs/phase-42-proof/plan.md',
      'specs/phase-42-proof/task.md',
      'specs/phase-42-proof/test-plan.md',
    ]);
  });
});
