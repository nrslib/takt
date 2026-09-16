import { basename, dirname, join } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/workflow/evaluation/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/evaluation/index.js')>();
  const { MockRuleEvaluator } = await import('./rule-evaluator-test-double.js');
  return {
    ...actual,
    RuleEvaluator: MockRuleEvaluator,
  };
});

vi.mock('../core/workflow/phase-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/workflow/phase-runner.js')>()),
  runReportPhase: vi.fn(),
  runStatusJudgmentPhase: vi.fn(),
}));

vi.mock('../shared/prompt/index.js', () => ({
  selectOption: vi.fn(),
}));

import { runAgent } from '../agents/runner.js';
import { runReportPhase, runStatusJudgmentPhase } from '../core/workflow/phase-runner.js';
import { readRunMetaBySlug } from '../core/workflow/run/run-meta.js';
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache } from '../infra/config/index.js';
import { selectOption } from '../shared/prompt/index.js';
import { resumeDirectRun } from '../features/tasks/resume/index.js';
import { executeTaskWithResult } from '../features/tasks/execute/taskExecution.js';
import { makeResponse } from './engine-test-helpers.js';
import { mockRuleEvaluation } from './rule-evaluator-test-double.js';

const temporaryProjects = new Set<string>();

function writeWorkflow(projectDir: string, relativePath: string, content: string): void {
  const filePath = join(projectDir, '.takt', 'workflows', relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
}

function createProject(): string {
  const projectDir = mkdtempSync(join(tmpdir(), 'takt-direct-nested-resume-'));
  temporaryProjects.add(projectDir);
  mkdirSync(join(projectDir, '.takt'), { recursive: true });
  writeFileSync(join(projectDir, '.takt', 'config.yaml'), 'provider: mock\nlanguage: en\n', 'utf-8');
  writeWorkflow(projectDir, 'root-revisit.yaml', `name: root-revisit
initial_step: parent-call
max_steps: 20
steps:
  - name: parent-call
    kind: workflow_call
    call: nested/revisit
    rules:
      - condition: COMPLETE
        next: parent-review
      - condition: DONE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
  - name: parent-review
    persona: parent-review
    instruction: Review the child result
    rules:
      - condition: needs_fix
        next: parent-repair
  - name: parent-repair
    persona: parent-repair
    instruction: Repair the parent result
    rules:
      - condition: done
        next: parent-call
`);
  writeWorkflow(projectDir, 'nested/revisit.yaml', `name: nested/revisit
subworkflow:
  callable: true
  returns: [DONE]
initial_step: child-review
max_steps: 20
steps:
  - name: child-review
    persona: child-review
    instruction: Review the child work
    rules:
      - condition: needs_fix
        next: child-fix
      - condition: done
        return: DONE
  - name: child-fix
    persona: child-fix
    instruction: Fix the child work
    rules:
      - condition: done
        next: COMPLETE
`);
  return projectDir;
}

function setAgentResponses(
  responses: Array<ReturnType<typeof makeResponse> | Error>,
): void {
  const mock = vi.mocked(runAgent);
  for (const response of responses) {
    mock.mockImplementationOnce(async (persona, task, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: task,
      });
      if (response instanceof Error) {
        throw response;
      }
      return response;
    });
  }
}

function setRuleMatches(indices: number[]): void {
  for (const index of indices) {
    mockRuleEvaluation.mockReturnValueOnce({ index, method: 'phase3_tag' });
  }
}

function runSlugs(projectDir: string): string[] {
  const runsDir = join(projectDir, '.takt', 'runs');
  if (!existsSync(runsDir)) {
    return [];
  }
  return readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function readLatestRunMeta(
  projectDir: string,
  previousSlugs: readonly string[],
): NonNullable<ReturnType<typeof readRunMetaBySlug>> {
  const previous = new Set(previousSlugs);
  const created = runSlugs(projectDir).filter((slug) => !previous.has(slug));
  const slug = created.at(-1);
  if (slug === undefined) {
    throw new Error('Expected a new direct-run directory');
  }
  const meta = readRunMetaBySlug(projectDir, slug);
  if (meta === null) {
    throw new Error(`Expected metadata for ${slug}`);
  }
  return meta;
}

describe('direct run nested checkpoint persistence', () => {
  let projectDir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(runReportPhase).mockResolvedValue(undefined);
    vi.mocked(runStatusJudgmentPhase).mockResolvedValue({ label: '', method: 'auto_select' });
    projectDir = createProject();
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  afterEach(() => {
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    for (const directory of temporaryProjects) {
      rmSync(directory, { recursive: true, force: true });
    }
    temporaryProjects.clear();
  });

  it('保存した nested checkpoint を direct run で二度再開し、二度目の保存位置から継続する', async () => {
    setAgentResponses([
      makeResponse({ persona: 'child-review', content: 'needs fix' }),
      new Error('child fix exploded'),
    ]);
    setRuleMatches([0]);
    const firstSlugs = runSlugs(projectDir);
    const first = await executeTaskWithResult({
      task: 'Resume nested work',
      cwd: projectDir,
      projectCwd: projectDir,
      workflowIdentifier: 'root-revisit',
      agentOverrides: { provider: 'mock', model: 'test-model' },
      outputMode: 'silent',
    });
    const sourceMeta = readLatestRunMeta(projectDir, firstSlugs);
    const sourceSlug = basename(sourceMeta.runRoot);

    expect(first.success).toBe(false);
    expect(sourceMeta.status).toBe('failed');
    expect(sourceMeta.resumePoint?.stack).toEqual([
      expect.objectContaining({ workflow: 'root-revisit', step: 'parent-call', kind: 'workflow_call' }),
      expect.objectContaining({ workflow: 'nested/revisit', step: 'child-fix', kind: 'agent' }),
    ]);

    vi.mocked(runAgent).mockReset();
    setAgentResponses([
      makeResponse({ persona: 'child-fix', content: 'fixed' }),
      new Error('parent review exploded'),
    ]);
    mockRuleEvaluation.mockReset();
    setRuleMatches([0]);
    vi.mocked(selectOption).mockResolvedValueOnce('requeue');
    const secondBefore = runSlugs(projectDir);
    await resumeDirectRun(projectDir, { provider: 'mock', model: 'test-model' });
    const secondMeta = readLatestRunMeta(projectDir, secondBefore);

    expect(secondMeta.status).toBe('failed');
    expect(secondMeta.sourceRunSlug).toBe(sourceSlug);
    expect(secondMeta.resumePoint?.stack).toEqual([
      expect.objectContaining({ workflow: 'root-revisit', step: 'parent-review', kind: 'agent' }),
    ]);

    vi.mocked(runAgent).mockReset();
    setAgentResponses([
      makeResponse({ persona: 'parent-review', content: 'needs fix' }),
      makeResponse({ persona: 'parent-repair', content: 'done' }),
      makeResponse({ persona: 'child-review', content: 'done' }),
    ]);
    mockRuleEvaluation.mockReset();
    setRuleMatches([0, 0, 1]);
    vi.mocked(selectOption).mockResolvedValueOnce('requeue');
    const thirdBefore = runSlugs(projectDir);
    await resumeDirectRun(projectDir, { provider: 'mock', model: 'test-model' });
    const thirdMeta = readLatestRunMeta(projectDir, thirdBefore);

    expect(thirdMeta.status).toBe('completed');
    expect(vi.mocked(runAgent).mock.calls.map(([persona]) => String(persona))).toEqual([
      'parent-review',
      'parent-repair',
      'child-review',
    ]);
  });
});
