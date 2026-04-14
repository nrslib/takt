import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/workflow/evaluation/index.js', () => ({
  detectMatchedRule: vi.fn(),
}));

vi.mock('../core/workflow/phase-runner.js', () => ({
  needsStatusJudgmentPhase: vi.fn(),
  runReportPhase: vi.fn(),
  runStatusJudgmentPhase: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

import { WorkflowEngine } from '../core/workflow/index.js';
import { runAgent } from '../agents/runner.js';
import {
  invalidateAllResolvedConfigCache,
  invalidateGlobalConfigCache,
  loadWorkflowByIdentifier,
  resolveWorkflowCallTarget,
} from '../infra/config/index.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import { getWorkflowSourcePath } from '../infra/config/loaders/workflowSourceMetadata.js';
import { getWorkflowTrustInfo } from '../infra/config/loaders/workflowTrustSource.js';
import { WorkflowCallRunner } from '../core/workflow/engine/WorkflowCallRunner.js';
import { getWorkflowReference } from '../core/workflow/workflow-reference.js';
import {
  applyDefaultMocks,
  cleanupWorkflowEngine,
  createTestTmpDir,
  makeResponse,
  mockDetectMatchedRuleSequence,
} from './engine-test-helpers.js';

function writeWorkflow(projectDir: string, relativePath: string, content: string): void {
  const filePath = join(projectDir, '.takt', 'workflows', relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
}

function createParentWorkflow(projectDir: string, raw: Record<string, unknown>) {
  return normalizeWorkflowConfig(raw, projectDir);
}

function loadWorkflowOrThrow(identifier: string, projectDir: string, basePath?: string) {
  const workflow = loadWorkflowByIdentifier(identifier, projectDir, basePath ? { basePath } : undefined);
  expect(workflow).not.toBeNull();
  return workflow!;
}

function createWorkflowCallOptions(
  projectDir: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    projectCwd: projectDir,
    provider: 'mock',
    model: 'parent-model',
    workflowCallResolver: ({
      parentWorkflow,
      identifier,
      stepName,
      projectCwd: resolverProjectCwd,
      lookupCwd,
    }: {
      parentWorkflow: Parameters<typeof resolveWorkflowCallTarget>[0];
      identifier: Parameters<typeof resolveWorkflowCallTarget>[1];
      stepName: Parameters<typeof resolveWorkflowCallTarget>[2];
      projectCwd: Parameters<typeof resolveWorkflowCallTarget>[3];
      lookupCwd: string;
    }) => resolveWorkflowCallTarget(parentWorkflow, identifier, stepName, resolverProjectCwd, lookupCwd),
    ...overrides,
  };
}

function mockPersonaResponses(responses: Record<string, string>, fallback = 'Parent delegate placeholder'): void {
  vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
    options?.onPromptResolved?.({
      systemPrompt: typeof persona === 'string' ? persona : '',
      userInstruction: prompt,
    });

    const personaName = typeof persona === 'string' ? persona : '';
    const matchedPersona = Object.keys(responses).find((key) => personaName.includes(key));

    return makeResponse({
      persona: personaName || 'delegate',
      content: matchedPersona ? responses[matchedPersona]! : fallback,
    });
  });
}

describe('WorkflowEngine workflow_call integration', () => {
  let tmpDir: string;
  let cleanupDirs: string[];
  let engine: WorkflowEngine | null = null;
  const originalTaktConfigDir = process.env.TAKT_CONFIG_DIR;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    tmpDir = createTestTmpDir();
    cleanupDirs = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalTaktConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = originalTaktConfigDir;
    }
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    if (engine) {
      cleanupWorkflowEngine(engine);
      engine = null;
    }
    for (const dir of cleanupDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('子 workflow の最終出力を親 step の previous_response に引き継ぐ', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 4,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'final_review',
            },
            {
              condition: 'ABORT',
              next: 'ABORT',
            },
          ],
        },
        {
          name: 'final_review',
          persona: 'supervisor',
          instruction: 'Review child output:\n{previous_response}',
          rules: [
            {
              condition: 'approved',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    mockPersonaResponses({
      reviewer: 'Child review complete',
      supervisor: 'approved',
    });
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
    ]);

    engine = new WorkflowEngine(config, tmpDir, 'Implement workflow composition', createWorkflowCallOptions(tmpDir));

    const state = await engine.run();
    const finalPrompt = vi.mocked(runAgent).mock.calls[1]?.[1];

    expect(state.status).toBe('completed');
    expect(finalPrompt).toContain('Child review complete');
  });

  it('親 task を child workflow の agent prompt へデフォルト伝搬する', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: reviewer
    instruction: "Child task context:\\n{task}"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 4,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
            {
              condition: 'ABORT',
              next: 'ABORT',
            },
          ],
        },
      ],
    });

    vi.mocked(runAgent).mockResolvedValueOnce(makeResponse({
      persona: 'reviewer',
      content: 'done',
    }));
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
    ]);

    const parentTask = 'Propagate parent task into child workflow';
    engine = new WorkflowEngine(config, tmpDir, parentTask, createWorkflowCallOptions(tmpDir));

    await engine.run();

    const childPrompt = vi.mocked(runAgent).mock.calls[0]?.[1];

    expect(childPrompt).toContain(parentTask);
  });

  it('workflow_call overrides を子 workflow の agent 実行へ伝搬する', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 10,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          overrides: {
            provider: 'codex',
            model: 'gpt-5-codex',
            provider_options: {
              codex: {
                network_access: true,
              },
            },
          },
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
            {
              condition: 'ABORT',
              next: 'ABORT',
            },
          ],
        },
      ],
    });

    vi.mocked(runAgent).mockResolvedValueOnce(makeResponse({
      persona: 'reviewer',
      content: 'done',
    }));
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
    ]);

    engine = new WorkflowEngine(config, tmpDir, 'Override child provider', createWorkflowCallOptions(tmpDir, {
      provider: 'claude',
    }));

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];

    expect(options?.resolvedProvider).toBe('codex');
    expect(options?.resolvedModel).toBe('gpt-5-codex');
    expect(options?.providerOptions).toMatchObject({
      codex: {
        networkAccess: true,
      },
    });
  });

  it('workflow_call が provider だけ override した場合は親 model を引き継がない', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 10,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          overrides: {
            provider: 'codex',
          },
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    vi.mocked(runAgent).mockResolvedValueOnce(makeResponse({
      persona: 'reviewer',
      content: 'done',
    }));
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
    ]);

    engine = new WorkflowEngine(config, tmpDir, 'Override child provider only', createWorkflowCallOptions(tmpDir, {
      provider: 'claude',
      model: 'parent-model',
    }));

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];

    expect(options?.resolvedProvider).toBe('codex');
    expect(options?.resolvedModel).toBeUndefined();
  });

  it('workflow_call が provider だけ override した場合は child personaProviders の stale model を引き継がない', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 10,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          overrides: {
            provider: 'codex',
          },
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    vi.mocked(runAgent).mockResolvedValueOnce(makeResponse({
      persona: 'reviewer',
      content: 'done',
    }));
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'Override child provider without stale persona model', createWorkflowCallOptions(tmpDir, {
      provider: 'claude',
      model: 'parent-model',
      personaProviders: {
        reviewer: {
          provider: 'opencode',
          model: 'reviewer-model',
        },
      },
    }));

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];

    expect(options?.resolvedProvider).toBe('codex');
    expect(options?.resolvedModel).toBeUndefined();
  });

  it('workflow_call が model だけ override しても child personaProviders の provider 解決を維持する', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 10,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          overrides: {
            model: 'override-model',
          },
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    vi.mocked(runAgent).mockResolvedValueOnce(makeResponse({
      persona: 'reviewer',
      content: 'done',
    }));
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'Override child model with persona provider fallback', createWorkflowCallOptions(tmpDir, {
      provider: 'claude',
      model: 'parent-model',
      personaProviders: {
        reviewer: {
          provider: 'opencode',
          model: 'reviewer-model',
        },
      },
    }));

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];

    expect(options?.resolvedProvider).toBe('opencode');
    expect(options?.resolvedModel).toBe('override-model');
  });

  it('workflow_call が provider_options だけ override した場合は親 provider/model を維持する', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 10,
      workflow_config: {
        provider: 'claude',
        model: 'parent-model',
        provider_options: {
          claude: {
            allowed_tools: ['Read'],
          },
        },
      },
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          overrides: {
            provider_options: {
              codex: {
                network_access: true,
              },
            },
          },
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    vi.mocked(runAgent).mockResolvedValueOnce(makeResponse({
      persona: 'reviewer',
      content: 'done',
    }));
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'Override child provider options only', createWorkflowCallOptions(tmpDir, {
      provider: 'mock',
      model: 'cli-model',
    }));

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];

    expect(options?.resolvedProvider).toBe('claude');
    expect(options?.resolvedModel).toBe('parent-model');
    expect(options?.providerOptions).toMatchObject({
      claude: {
        allowedTools: ['Read'],
      },
      codex: {
        networkAccess: true,
      },
    });
  });

  it('workflow_call は親 step に継承済みの provider 設定を子 workflow に引き継ぐ', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 3,
      workflow_config: {
        provider: 'codex',
        model: 'gpt-5-codex',
        provider_options: {
          codex: {
            network_access: true,
          },
        },
      },
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
            {
              condition: 'ABORT',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    vi.mocked(runAgent).mockResolvedValueOnce(makeResponse({
      persona: 'reviewer',
      content: 'done',
    }));
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'Inherited child provider', createWorkflowCallOptions(tmpDir, {
      provider: 'claude',
    }));

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];

    expect(options?.resolvedProvider).toBe('codex');
    expect(options?.resolvedModel).toBe('gpt-5-codex');
    expect(options?.providerOptions).toMatchObject({
      codex: {
        networkAccess: true,
      },
    });
  });

  it('workflow_call は step 名と personaProviders の衝突で child 入口 provider を変えない', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 3,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    vi.mocked(runAgent).mockResolvedValueOnce(makeResponse({
      persona: 'reviewer',
      content: 'done',
    }));
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'Avoid personaProviders collision on workflow_call', createWorkflowCallOptions(tmpDir, {
      provider: 'claude',
      model: 'parent-model',
      personaProviders: {
        delegate: {
          provider: 'opencode',
          model: 'opencode/delegate-model',
        },
      },
    }));

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];

    expect(options?.resolvedProvider).toBe('claude');
    expect(options?.resolvedModel).toBe('parent-model');
  });

  it('workflow_call の step:start と loop monitor judge は child 実行と同じ provider context を使う', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 4,
      loop_monitors: [
        {
          cycle: ['delegate', 'delegate'],
          threshold: 1,
          judge: {
            persona: 'supervisor',
            rules: [
              { condition: 'Healthy', next: 'delegate' },
              { condition: 'Unproductive', next: 'COMPLETE' },
            ],
          },
        },
      ],
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'delegate',
            },
          ],
        },
      ],
    });

    mockPersonaResponses({
      reviewer: 'done',
      supervisor: 'Unproductive',
    });
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 1, method: 'ai_judge_fallback' },
    ]);

    const startedProviderInfo: Array<{ provider: string | undefined; model: string | undefined }> = [];
    engine = new WorkflowEngine(config, tmpDir, 'Align workflow_call runtime context', createWorkflowCallOptions(tmpDir, {
      provider: 'claude',
      model: 'parent-model',
      personaProviders: {
        delegate: {
          provider: 'opencode',
          model: 'opencode/delegate-model',
        },
      },
    }));
    engine.on('step:start', (step, _iteration, _instruction, providerInfo) => {
      if (step.name === 'delegate') {
        startedProviderInfo.push(providerInfo);
      }
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(startedProviderInfo).toEqual([
      { provider: 'claude', model: 'parent-model' },
      { provider: 'claude', model: 'parent-model' },
    ]);
    const childCall = vi.mocked(runAgent).mock.calls.find(([persona]) => String(persona).includes('reviewer'));
    const judgeCall = vi.mocked(runAgent).mock.calls.find(([persona]) => String(persona).includes('supervisor'));
    expect(childCall?.[2]).toEqual(expect.objectContaining({
      resolvedProvider: 'claude',
      resolvedModel: 'parent-model',
    }));
    expect(judgeCall?.[2]).toEqual(expect.objectContaining({
      resolvedProvider: 'claude',
      resolvedModel: 'parent-model',
    }));
  });

  it('callable ではない child workflow を拒否する', async () => {
    writeWorkflow(tmpDir, 'child.yaml', `name: child
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 10,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'child',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
            {
              condition: 'ABORT',
              next: 'ABORT',
            },
          ],
        },
      ],
    });

    engine = new WorkflowEngine(config, tmpDir, 'Reject non-callable child', createWorkflowCallOptions(tmpDir));

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });

  it('workflow_call cycle を検出して停止する', async () => {
    writeWorkflow(tmpDir, 'a.yaml', `name: a
subworkflow:
  callable: true
initial_step: delegate
max_steps: 5
steps:
  - name: delegate
    kind: workflow_call
    call: b
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);
    writeWorkflow(tmpDir, 'b.yaml', `name: b
subworkflow:
  callable: true
initial_step: delegate
max_steps: 5
steps:
  - name: delegate
    kind: workflow_call
    call: a
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);

    engine = new WorkflowEngine(loadWorkflowOrThrow('a', tmpDir), tmpDir, 'Detect workflow call cycle', createWorkflowCallOptions(tmpDir));

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });

  it('workflow_call depth 制限を超えたら停止する', async () => {
    for (let index = 1; index <= 6; index++) {
      const nextName = `w${index + 1}`;
      writeWorkflow(tmpDir, `w${index}.yaml`, index < 6
        ? `name: w${index}
subworkflow:
  callable: true
initial_step: delegate
max_steps: 5
steps:
  - name: delegate
    kind: workflow_call
    call: ${nextName}
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`
        : `name: w${index}
subworkflow:
  callable: true
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: reviewer
    instruction: "Deep child"
    rules:
      - condition: done
        next: COMPLETE
`);
    }

    engine = new WorkflowEngine(loadWorkflowOrThrow('w1', tmpDir), tmpDir, 'Detect workflow depth limit', createWorkflowCallOptions(tmpDir));

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'when rule',
      rule: 'when: "true"\n        next: COMPLETE',
    },
    {
      label: 'ai() condition',
      rule: 'condition: ai("route to plan")\n        next: COMPLETE',
    },
  ])('loadWorkflowOrThrow は workflow_call の不正な $label を実行前に reject する', ({ rule }) => {
    writeWorkflow(tmpDir, 'invalid-parent.yaml', `name: invalid-parent
initial_step: delegate
max_steps: 5
steps:
  - name: delegate
    kind: workflow_call
    call: child
    rules:
      - ${rule}
`);

    expect(() => loadWorkflowOrThrow('invalid-parent', tmpDir)).toThrow();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('project workflow から project 外の privileged subworkflow 呼び出しを拒否する', async () => {
    const externalDir = createTestTmpDir();
    cleanupDirs.push(externalDir);
    const externalWorkflowPath = join(externalDir, 'privileged-child.yaml');
    writeFileSync(externalWorkflowPath, `name: privileged-child
subworkflow:
  callable: true
initial_step: route_context
max_steps: 5
steps:
  - name: route_context
    kind: system
    effects:
      - type: merge_pr
        pr: 42
    rules:
      - when: "true"
        next: COMPLETE
`, 'utf-8');
    writeWorkflow(tmpDir, 'parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: ${externalWorkflowPath}
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);

    engine = new WorkflowEngine(loadWorkflowOrThrow('parent', tmpDir), tmpDir, 'Block privileged child', createWorkflowCallOptions(tmpDir));

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });

  it('relative child path は呼び出し元 workflow のディレクトリ基準で解決する', async () => {
    const externalDir = createTestTmpDir();
    cleanupDirs.push(externalDir);
    const externalParentPath = join(externalDir, 'parent.yaml');
    writeFileSync(externalParentPath, `name: external-parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: ./child.yaml
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`, 'utf-8');
    writeFileSync(join(externalDir, 'child.yaml'), `name: external-child
subworkflow:
  callable: true
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: external-reviewer
    instruction: "External child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');
    writeFileSync(join(tmpDir, 'child.yaml'), `name: project-child
subworkflow:
  callable: true
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: project-reviewer
    instruction: "Project child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');

    vi.mocked(runAgent).mockResolvedValueOnce(makeResponse({
      persona: 'external-reviewer',
      content: 'done',
    }));
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    engine = new WorkflowEngine(loadWorkflowOrThrow(externalParentPath, tmpDir), tmpDir, 'Resolve relative child from parent dir', createWorkflowCallOptions(tmpDir));

    const state = await engine.run();
    const calledPersona = vi.mocked(runAgent).mock.calls[0]?.[0];

    expect(state.status).toBeDefined();
    expect(calledPersona).toContain('external-reviewer');
  });

  it('external parent の plain identifier も project -> user -> builtin の順で解決する', () => {
    const configDir = createTestTmpDir();
    cleanupDirs.push(configDir);
    process.env.TAKT_CONFIG_DIR = configDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const externalDir = createTestTmpDir();
    cleanupDirs.push(externalDir);
    const externalParentPath = join(externalDir, 'parent.yaml');
    writeFileSync(externalParentPath, `name: external-parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: takt/coding
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`, 'utf-8');
    mkdirSync(dirname(join(externalDir, 'takt', 'coding.yaml')), { recursive: true });
    writeFileSync(join(externalDir, 'takt', 'coding.yaml'), `name: takt/coding
subworkflow:
  callable: true
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: external-reviewer
    instruction: "External child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: project-reviewer
    instruction: "Project child"
    rules:
      - condition: done
        next: COMPLETE
`);
    const userWorkflowDir = join(configDir, 'workflows', 'takt');
    mkdirSync(userWorkflowDir, { recursive: true });
    writeFileSync(join(userWorkflowDir, 'coding.yaml'), `name: takt/coding
subworkflow:
  callable: true
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: user-reviewer
    instruction: "User child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');

    const parentWorkflow = loadWorkflowOrThrow(externalParentPath, tmpDir);
    const childWorkflow = resolveWorkflowCallTarget(parentWorkflow, 'takt/coding', 'delegate', tmpDir);

    expect(childWorkflow?.name).toBe('takt/coding');
    expect(childWorkflow?.steps[0]).toMatchObject({
      kind: 'agent',
      persona: 'project-reviewer',
    });
  });

  it('external parent の named child は project 不在時に user workflow を優先する', () => {
    const configDir = createTestTmpDir();
    cleanupDirs.push(configDir);
    process.env.TAKT_CONFIG_DIR = configDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const externalDir = createTestTmpDir();
    cleanupDirs.push(externalDir);
    const externalParentPath = join(externalDir, 'parent.yaml');
    writeFileSync(externalParentPath, `name: external-parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: takt/coding
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`, 'utf-8');
    mkdirSync(dirname(join(externalDir, 'takt', 'coding.yaml')), { recursive: true });
    writeFileSync(join(externalDir, 'takt', 'coding.yaml'), `name: takt/coding
subworkflow:
  callable: true
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: external-reviewer
    instruction: "External child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');

    const userWorkflowDir = join(configDir, 'workflows', 'takt');
    mkdirSync(userWorkflowDir, { recursive: true });
    writeFileSync(join(userWorkflowDir, 'coding.yaml'), `name: takt/coding
subworkflow:
  callable: true
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: user-reviewer
    instruction: "User child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');

    const parentWorkflow = loadWorkflowOrThrow(externalParentPath, tmpDir);
    const childWorkflow = resolveWorkflowCallTarget(parentWorkflow, 'takt/coding', 'delegate', tmpDir);

    expect(childWorkflow?.name).toBe('takt/coding');
    expect(childWorkflow?.steps[0]).toMatchObject({
      kind: 'agent',
      persona: 'user-reviewer',
    });
  });

  it('project parent の named child は user workflow へ fallback できる', () => {
    const configDir = createTestTmpDir();
    cleanupDirs.push(configDir);
    process.env.TAKT_CONFIG_DIR = configDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const userWorkflowDir = join(configDir, 'workflows', 'takt');
    mkdirSync(userWorkflowDir, { recursive: true });
    writeFileSync(join(userWorkflowDir, 'coding.yaml'), `name: takt/coding
subworkflow:
  callable: true
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: user-reviewer
    instruction: "User child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');
    writeWorkflow(tmpDir, 'parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: takt/coding
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);

    const parentWorkflow = loadWorkflowOrThrow('parent', tmpDir);

    const childWorkflow = resolveWorkflowCallTarget(parentWorkflow, 'takt/coding', 'delegate', tmpDir);

    expect(childWorkflow?.name).toBe('takt/coding');
    expect(childWorkflow?.steps[0]).toMatchObject({
      kind: 'agent',
      persona: 'user-reviewer',
    });
  });

  it('source metadata を持たない project parent も user workflow fallback を解決できる', () => {
    const configDir = createTestTmpDir();
    cleanupDirs.push(configDir);
    process.env.TAKT_CONFIG_DIR = configDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const userWorkflowDir = join(configDir, 'workflows', 'takt');
    mkdirSync(userWorkflowDir, { recursive: true });
    writeFileSync(join(userWorkflowDir, 'coding.yaml'), `name: takt/coding
subworkflow:
  callable: true
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: user-reviewer
    instruction: "User child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');

    const parentWorkflow = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 3,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
            {
              condition: 'ABORT',
              next: 'ABORT',
            },
          ],
        },
      ],
    });

    const childWorkflow = resolveWorkflowCallTarget(parentWorkflow, 'takt/coding', 'delegate', tmpDir);

    expect(childWorkflow?.name).toBe('takt/coding');
    expect(childWorkflow?.steps[0]).toMatchObject({
      kind: 'agent',
      persona: 'user-reviewer',
    });
  });

  it('project parent の named child は builtin fallback を trust boundary で拒否する', () => {
    writeWorkflow(tmpDir, 'parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: default
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);

    const parentWorkflow = loadWorkflowOrThrow('parent', tmpDir);

    const childWorkflow = resolveWorkflowCallTarget(parentWorkflow, 'default', 'delegate', tmpDir);

    expect(childWorkflow?.name).toBe('default');
  });

  it('project parent は project workflow root 内 child の explicit path を呼べる', () => {
    writeWorkflow(tmpDir, 'child.yaml', `name: project-child
subworkflow:
  callable: true
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: project-reviewer
    instruction: "Project child"
    rules:
      - condition: done
        next: COMPLETE
`);
    writeWorkflow(tmpDir, 'parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: ./child.yaml
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);

    const parentWorkflow = loadWorkflowOrThrow('parent', tmpDir);
    const childWorkflow = resolveWorkflowCallTarget(parentWorkflow, './child.yaml', 'delegate', tmpDir);

    expect(childWorkflow?.name).toBe('project-child');
    expect(childWorkflow?.steps[0]).toMatchObject({
      kind: 'agent',
      persona: 'project-reviewer',
    });
  });

  it('project parent は absolute child path を既存どおり解決できる', () => {
    const externalDir = createTestTmpDir();
    cleanupDirs.push(externalDir);
    const externalWorkflowPath = join(externalDir, 'child.yaml');
    writeFileSync(externalWorkflowPath, `name: external-child
subworkflow:
  callable: true
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: external-reviewer
    instruction: "External child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');
    writeWorkflow(tmpDir, 'parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: ${externalWorkflowPath}
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);

    const parentWorkflow = loadWorkflowOrThrow('parent', tmpDir);

    const childWorkflow = resolveWorkflowCallTarget(parentWorkflow, externalWorkflowPath, 'delegate', tmpDir);

    expect(childWorkflow?.name).toBe('external-child');
  });

  it('project parent は tilde child path を既存どおり解決できる', async () => {
    const fakeHomeDir = createTestTmpDir();
    cleanupDirs.push(fakeHomeDir);
    const testWorkflowDir = join(fakeHomeDir, '.takt', 'workflows', 'workflow-call-tilde-test');
    const userWorkflowPath = join(testWorkflowDir, 'external.yaml');
    mkdirSync(testWorkflowDir, { recursive: true });
    writeFileSync(userWorkflowPath, `name: tilde-child
subworkflow:
  callable: true
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: tilde-reviewer
    instruction: "Tilde child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');
    const parentWorkflow = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 3,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: '~/.takt/workflows/workflow-call-tilde-test/external.yaml',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
            {
              condition: 'ABORT',
              next: 'ABORT',
            },
          ],
        },
      ],
    });

    vi.resetModules();
    vi.doMock('node:os', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:os')>()),
      homedir: () => fakeHomeDir,
    }));

    const { resolveWorkflowCallTarget: resolveWorkflowCallTargetWithMockedHomedir } = await import('../infra/config/loaders/workflowCallResolver.js');

    const childWorkflow = resolveWorkflowCallTargetWithMockedHomedir(
      parentWorkflow,
      '~/.takt/workflows/workflow-call-tilde-test/external.yaml',
      'delegate',
      tmpDir,
    );

    expect(childWorkflow?.name).toBe('tilde-child');
    vi.doUnmock('node:os');
    vi.resetModules();
  });

  it('project parent は dot-segment を含む named child identifier を reject する', () => {
    mkdirSync(join(tmpDir, '.takt'), { recursive: true });
    writeFileSync(join(tmpDir, '.takt', 'outside.yaml'), `name: escaped-child
subworkflow:
  callable: true
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: escaped-reviewer
    instruction: "Escaped child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');
    writeWorkflow(tmpDir, 'parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: takt/../../outside
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);

    const parentWorkflow = loadWorkflowOrThrow('parent', tmpDir);

    expect(() => resolveWorkflowCallTarget(parentWorkflow, 'takt/../../outside', 'delegate', tmpDir)).toThrow(
      'Workflow step "delegate" cannot call invalid workflow identifier "takt/../../outside"',
    );
  });

  it('project parent は @scope ref を既存どおり解決できる', () => {
    const configDir = createTestTmpDir();
    cleanupDirs.push(configDir);
    process.env.TAKT_CONFIG_DIR = configDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const workflowsDir = join(configDir, 'repertoire', '@nrslib', 'takt-ensemble', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'expert.yaml'), `name: external-child
subworkflow:
  callable: true
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: external-reviewer
    instruction: "External child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');
    writeWorkflow(tmpDir, 'parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: "@nrslib/takt-ensemble/expert"
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);

    const parentWorkflow = loadWorkflowOrThrow('parent', tmpDir);

    const childWorkflow = resolveWorkflowCallTarget(parentWorkflow, '@nrslib/takt-ensemble/expert', 'delegate', tmpDir);

    expect(childWorkflow?.name).toBe('external-child');
  });

  it('project parent は project に存在しない named child の user fallback を許可する', () => {
    const configDir = createTestTmpDir();
    cleanupDirs.push(configDir);
    process.env.TAKT_CONFIG_DIR = configDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const userWorkflowDir = join(configDir, 'workflows', 'takt');
    mkdirSync(userWorkflowDir, { recursive: true });
    writeFileSync(join(userWorkflowDir, 'coding.yaml'), `name: takt/coding
subworkflow:
  callable: true
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: external-reviewer
    instruction: "User child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');
    writeWorkflow(tmpDir, 'parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: takt/coding
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);

    const parentWorkflow = loadWorkflowOrThrow('parent', tmpDir);

    const childWorkflow = resolveWorkflowCallTarget(parentWorkflow, 'takt/coding', 'delegate', tmpDir);

    expect(childWorkflow?.name).toBe('takt/coding');
    expect(childWorkflow?.steps[0]).toMatchObject({
      kind: 'agent',
      persona: 'external-reviewer',
    });
  });

  it('default worktree root 上の parent path は worktree workflow を non-project trust として解決する', () => {
    const worktreeDir = join(tmpDir, '..', 'takt-worktrees', 'feature-branch');
    cleanupDirs.push(worktreeDir);
    const worktreeWorkflowPath = join(worktreeDir, '.takt', 'workflows', 'parent.yaml');
    mkdirSync(dirname(worktreeWorkflowPath), { recursive: true });
    writeFileSync(worktreeWorkflowPath, `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: ./takt/coding.yaml
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`, 'utf-8');
    mkdirSync(join(worktreeDir, '.takt', 'workflows', 'takt'), { recursive: true });
    writeFileSync(join(worktreeDir, '.takt', 'workflows', 'takt', 'coding.yaml'), `name: takt/coding
subworkflow:
  callable: true
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: worktree-reviewer
    instruction: "Worktree child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');

    const parentWorkflow = loadWorkflowByIdentifier('./.takt/workflows/parent.yaml', tmpDir, { lookupCwd: worktreeDir });
    expect(parentWorkflow).not.toBeNull();
    expect(getWorkflowTrustInfo(parentWorkflow!, tmpDir)).toMatchObject({
      source: 'worktree',
      isProjectTrustRoot: false,
      isProjectWorkflowRoot: false,
    });

    const childWorkflow = resolveWorkflowCallTarget(parentWorkflow!, './takt/coding.yaml', 'delegate', tmpDir, worktreeDir);

    expect(childWorkflow?.name).toBe('takt/coding');
    expect(childWorkflow?.steps[0]).toMatchObject({
      kind: 'agent',
      persona: 'worktree-reviewer',
    });
    expect(getWorkflowTrustInfo(childWorkflow!, tmpDir)).toMatchObject({
      source: 'worktree',
      isProjectTrustRoot: false,
      isProjectWorkflowRoot: false,
    });
  });

  it('default worktree root 上の parent path は user fallback child を許可する', () => {
    const configDir = createTestTmpDir();
    cleanupDirs.push(configDir);
    process.env.TAKT_CONFIG_DIR = configDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const userWorkflowDir = join(configDir, 'workflows', 'takt');
    mkdirSync(userWorkflowDir, { recursive: true });
    writeFileSync(join(userWorkflowDir, 'coding.yaml'), `name: takt/coding
subworkflow:
  callable: true
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: user-reviewer
    instruction: "User child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');

    const worktreeDir = join(tmpDir, '..', 'takt-worktrees', 'feature-branch');
    cleanupDirs.push(worktreeDir);
    const worktreeWorkflowPath = join(worktreeDir, '.takt', 'workflows', 'parent.yaml');
    mkdirSync(dirname(worktreeWorkflowPath), { recursive: true });
    writeFileSync(worktreeWorkflowPath, `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: takt/coding
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`, 'utf-8');

    const parentWorkflow = loadWorkflowByIdentifier('./.takt/workflows/parent.yaml', tmpDir, { lookupCwd: worktreeDir });
    expect(parentWorkflow).not.toBeNull();

    const childWorkflow = resolveWorkflowCallTarget(parentWorkflow!, 'takt/coding', 'delegate', tmpDir, worktreeDir);

    expect(childWorkflow?.name).toBe('takt/coding');
    expect(childWorkflow?.steps[0]).toMatchObject({
      kind: 'agent',
      persona: 'user-reviewer',
    });
  });

  it('project parent は privileged な external child path を拒否する', () => {
    const externalDir = createTestTmpDir();
    cleanupDirs.push(externalDir);
    const externalWorkflowPath = join(externalDir, 'child.yaml');
    writeFileSync(externalWorkflowPath, `name: external-child
subworkflow:
  callable: true
initial_step: route_context
max_steps: 5
steps:
  - name: route_context
    kind: system
    effects:
      - type: merge_pr
        pr: 42
    rules:
      - when: "true"
        next: COMPLETE
`, 'utf-8');
    writeWorkflow(tmpDir, 'parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: ${externalWorkflowPath}
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);

    const parentWorkflow = loadWorkflowOrThrow('parent', tmpDir);

    expect(() => resolveWorkflowCallTarget(parentWorkflow, externalWorkflowPath, 'delegate', tmpDir)).toThrow(
      'Workflow step "delegate" cannot call privileged workflow "external-child" across trust boundary',
    );
  });

  it('non-project parent から project child path を呼ぶ場合も path 解決できる', () => {
    const externalDir = createTestTmpDir();
    cleanupDirs.push(externalDir);
    const externalParentPath = join(externalDir, 'parent.yaml');
    writeFileSync(externalParentPath, `name: external-parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: takt/coding
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`, 'utf-8');
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: project-reviewer
    instruction: "Project child"
    rules:
      - condition: done
        next: COMPLETE
`);
    const projectWorkflowPath = join(tmpDir, '.takt', 'workflows', 'takt', 'coding.yaml');

    const parentWorkflow = loadWorkflowOrThrow(externalParentPath, tmpDir);
    const childWorkflow = resolveWorkflowCallTarget(parentWorkflow, projectWorkflowPath, 'delegate', tmpDir);

    expect(childWorkflow?.name).toBe('takt/coding');
    expect(childWorkflow?.steps[0]).toMatchObject({
      kind: 'agent',
      persona: 'project-reviewer',
    });
  });

  it('non-project parent から privileged な project child を named lookup で呼ぶと拒否する', () => {
    const externalDir = createTestTmpDir();
    cleanupDirs.push(externalDir);
    const externalParentPath = join(externalDir, 'parent.yaml');
    writeFileSync(externalParentPath, `name: external-parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: takt/coding
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`, 'utf-8');
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: route_context
max_steps: 5
steps:
  - name: route_context
    kind: system
    effects:
      - type: merge_pr
        pr: 42
    rules:
      - when: "true"
        next: COMPLETE
`);

    const parentWorkflow = loadWorkflowOrThrow(externalParentPath, tmpDir);

    expect(() => resolveWorkflowCallTarget(parentWorkflow, 'takt/coding', 'delegate', tmpDir)).toThrow(
      'Workflow step "delegate" cannot call privileged workflow "takt/coding" across trust boundary',
    );
  });

  it('子 workflow が ABORT したら親 workflow_call は ABORT rule で通常分岐し previous_response を引き継ぐ', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: abort
        next: ABORT
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 5,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
            {
              condition: 'ABORT',
              next: 'plan',
            },
          ],
        },
        {
          name: 'plan',
          persona: 'planner',
          instruction: 'Replan after child abort:\n{previous_response}',
          rules: [
            {
              condition: 'done',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    mockPersonaResponses({
      reviewer: 'child abort output',
      planner: 'done',
    });
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
    ]);

    engine = new WorkflowEngine(config, tmpDir, 'Abort branch test', createWorkflowCallOptions(tmpDir));

    const state = await engine.run();
    const calledPersonas = vi.mocked(runAgent).mock.calls
      .map(([persona]) => typeof persona === 'string' ? persona : '');
    const plannerPrompt = vi.mocked(runAgent).mock.calls[1]?.[1];

    expect(state.status).toBe('completed');
    expect(calledPersonas.some((persona) => persona.includes('planner'))).toBe(true);
    expect(plannerPrompt).toContain('child abort output');
  });

  it('子 workflow が例外 abort したら親 previous_response に stale な成功出力を渡さない', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: fix
  - name: fix
    persona: fixer
    instruction: "Fix child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 6,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
            {
              condition: 'ABORT',
              next: 'plan',
            },
          ],
        },
        {
          name: 'plan',
          persona: 'planner',
          instruction: 'Replan after child abort:\n{previous_response}',
          rules: [
            {
              condition: 'done',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    vi.mocked(runAgent)
      .mockImplementationOnce(async (persona, prompt, options) => {
        options?.onPromptResolved?.({
          systemPrompt: typeof persona === 'string' ? persona : '',
          userInstruction: prompt,
        });
        return makeResponse({
          persona: 'reviewer',
          content: 'Review done',
        });
      })
      .mockImplementationOnce(async (persona, prompt, options) => {
        options?.onPromptResolved?.({
          systemPrompt: typeof persona === 'string' ? persona : '',
          userInstruction: prompt,
        });
        throw new Error('child exploded');
      })
      .mockImplementationOnce(async (persona, prompt, options) => {
        options?.onPromptResolved?.({
          systemPrompt: typeof persona === 'string' ? persona : '',
          userInstruction: prompt,
        });
        return makeResponse({
          persona: 'planner',
          content: 'done',
        });
      });
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
    ]);

    engine = new WorkflowEngine(config, tmpDir, 'Abort branch with exception', createWorkflowCallOptions(tmpDir));

    const state = await engine.run();
    const plannerPrompt = vi.mocked(runAgent).mock.calls[2]?.[1];

    expect(state.status).toBe('completed');
    expect(plannerPrompt).toContain('Step execution failed: child exploded');
    expect(plannerPrompt).not.toContain('Review done');
  });

  it('子 workflow の step も親 run の max_steps 予算を消費する', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: fix
  - name: fix
    persona: fixer
    instruction: "Fix child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 2,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'final_review',
            },
            {
              condition: 'ABORT',
              next: 'ABORT',
            },
          ],
        },
        {
          name: 'final_review',
          persona: 'supervisor',
          instruction: 'Review child output:\n{previous_response}',
          rules: [
            {
              condition: 'approved',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    mockPersonaResponses({
      reviewer: 'Review done',
      fixer: 'Fix done',
      supervisor: 'approved',
    });
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
    ]);

    const startedIterations: Array<{ step: string; iteration: number }> = [];
    engine = new WorkflowEngine(config, tmpDir, 'Budget test', createWorkflowCallOptions(tmpDir));
    engine.on('step:start', (step, iteration) => {
      startedIterations.push({ step: step.name, iteration });
    });

    const state = await engine.run();
    const calledPersonas = vi.mocked(runAgent).mock.calls
      .map(([persona]) => typeof persona === 'string' ? persona : '');

    expect(state.status).toBe('aborted');
    expect(state.iteration).toBe(2);
    expect(startedIterations).toEqual([
      { step: 'delegate', iteration: 1 },
      { step: 'review', iteration: 2 },
    ]);
    expect(calledPersonas.some((persona) => persona.includes('fixer'))).toBe(false);
    expect(calledPersonas.some((persona) => persona.includes('supervisor'))).toBe(false);
  });

  it('子 workflow で max_steps を延長した場合も親 run へ共有予算を引き継いで継続する', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: fix
  - name: fix
    persona: fixer
    instruction: "Fix child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 2,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'final_review',
            },
            {
              condition: 'ABORT',
              next: 'ABORT',
            },
          ],
        },
        {
          name: 'final_review',
          persona: 'supervisor',
          instruction: 'Review child output:\n{previous_response}',
          rules: [
            {
              condition: 'approved',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    mockPersonaResponses({
      reviewer: 'Review done',
      fixer: 'Fix done',
      supervisor: 'approved',
    });
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
    ]);

    const onIterationLimit = vi.fn().mockResolvedValueOnce(2);
    const startedIterations: Array<{ step: string; iteration: number }> = [];

    engine = new WorkflowEngine(config, tmpDir, 'Extend budget from child workflow', createWorkflowCallOptions(tmpDir, {
      onIterationLimit,
    }));
    engine.on('step:start', (step, iteration) => {
      startedIterations.push({ step: step.name, iteration });
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(4);
    expect(onIterationLimit).toHaveBeenCalledOnce();
    expect(startedIterations).toEqual([
      { step: 'delegate', iteration: 1 },
      { step: 'review', iteration: 2 },
      { step: 'fix', iteration: 3 },
      { step: 'final_review', iteration: 4 },
    ]);
  });

  it('子 workflow で次 step 決定直後に max_steps へ達しても resume_point は最新 child step を指す', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: fix
  - name: fix
    persona: fixer
    instruction: "Fix child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 2,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
            {
              condition: 'ABORT',
              next: 'ABORT',
            },
          ],
        },
      ],
    });

    vi.mocked(runAgent).mockImplementationOnce(async (persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: prompt,
      });
      return makeResponse({
        persona: 'reviewer',
        content: 'Review done',
      });
    });
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    let capturedResumePoint: ReturnType<WorkflowEngine['getResumePoint']>;
    engine = new WorkflowEngine(config, tmpDir, 'Capture latest child resume point', createWorkflowCallOptions(tmpDir, {
      onIterationLimit: vi.fn().mockImplementation(async () => {
        capturedResumePoint = engine?.getResumePoint();
        return null;
      }),
    }));

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(capturedResumePoint?.stack).toHaveLength(2);
    expect(capturedResumePoint?.stack[0]).toEqual({
      workflow: 'parent',
      step: 'delegate',
      kind: 'workflow_call',
    });
    expect(capturedResumePoint?.stack[1]).toEqual(expect.objectContaining({
      workflow: 'takt/coding',
      step: 'fix',
      kind: 'agent',
    }));
    expect(capturedResumePoint?.iteration).toBe(2);
  });

  it('resolveWorkflowCallTarget は child workflow の max_steps を書き換えない', () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 2,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    const childWorkflow = resolveWorkflowCallTarget(config, 'takt/coding', 'delegate', tmpDir);

    expect(childWorkflow?.maxSteps).toBe(5);
  });

  it('retry 時は resume_point.elapsed_ms を引き継いで resume_point を再構築する', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-13T00:00:10.000Z'));

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 10,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    engine = new WorkflowEngine(config, tmpDir, 'Retry workflow composition', createWorkflowCallOptions(tmpDir, {
      initialIteration: 7,
      resumePoint: {
        version: 1,
        stack: [
          { workflow: 'parent', step: 'delegate', kind: 'workflow_call' },
          { workflow: 'takt/coding', step: 'review', kind: 'agent' },
        ],
        iteration: 7,
        elapsed_ms: 183245,
      },
    }));

    const resumePoint = engine.buildResumePointForStepName('delegate');

    expect(resumePoint?.iteration).toBe(7);
    expect(resumePoint?.elapsed_ms).toBe(183245);
  });

  it('同名だが別 source の child workflow path は cycle とみなさない', async () => {
    writeWorkflow(tmpDir, 'nested/child.yaml', `name: shared/workflow
subworkflow:
  callable: true
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: child-reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);
    writeWorkflow(tmpDir, 'parent.yaml', `name: shared/workflow
initial_step: delegate
max_steps: 10
steps:
  - name: delegate
    kind: workflow_call
    call: ./nested/child.yaml
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
    const parentConfig = loadWorkflowOrThrow('parent', tmpDir);
    const childConfig = loadWorkflowOrThrow(join(tmpDir, '.takt', 'workflows', 'nested', 'child.yaml'), tmpDir);
    const createEngine = vi.fn().mockReturnValue({
      on: vi.fn(),
      runWithResult: vi.fn().mockResolvedValue({
        state: {
          workflowName: childConfig.name,
          currentStep: 'review',
          iteration: 2,
          stepOutputs: new Map(),
          structuredOutputs: new Map(),
          systemContexts: new Map(),
          effectResults: new Map(),
          lastOutput: makeResponse({ persona: 'child-reviewer', content: 'done' }),
          userInputs: [],
          personaSessions: new Map(),
          stepIterations: new Map(),
          status: 'completed',
        },
      }),
    });
    const runner = new WorkflowCallRunner({
      getConfig: () => parentConfig,
      state: {
        workflowName: parentConfig.name,
        currentStep: 'delegate',
        iteration: 1,
        stepOutputs: new Map(),
        structuredOutputs: new Map(),
        systemContexts: new Map(),
        effectResults: new Map(),
        userInputs: [],
        personaSessions: new Map(),
        stepIterations: new Map(),
        status: 'running',
      },
      projectCwd: tmpDir,
      getMaxSteps: () => parentConfig.maxSteps,
      updateMaxSteps: vi.fn(),
      getCwd: () => tmpDir,
      task: 'Allow same-name subworkflow from another source',
      getOptions: () => createWorkflowCallOptions(tmpDir),
      sharedRuntime: { startedAtMs: Date.now() },
      resumeStackPrefix: [],
      runPaths: {
        slug: 'test-report-dir',
      } as never,
      setActiveResumePoint: vi.fn(),
      emit: vi.fn(),
      resolveWorkflowCall: () => childConfig,
      createEngine,
    });

    const result = await runner.run(parentConfig.steps[0] as never);

    expect(result.response.matchedRuleIndex).toBe(0);
    expect(createEngine).toHaveBeenCalledTimes(1);
  });

  it('WorkflowCallRunner は step_transition abort では abortReason 文字列より child の最終出力を優先する', async () => {
    const parentConfig = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 5,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'child',
          rules: [
            { condition: 'COMPLETE', next: 'COMPLETE' },
            { condition: 'ABORT', next: 'ABORT' },
          ],
        },
      ],
    });
    const childConfig = {
      name: 'child',
      initialStep: 'review',
      maxSteps: 5,
      subworkflow: {
        callable: true,
      },
      steps: [{ name: 'review' }],
    } as WorkflowConfig;
    const childState = {
      workflowName: childConfig.name,
      currentStep: 'review',
      iteration: 2,
      stepOutputs: new Map(),
      structuredOutputs: new Map(),
      systemContexts: new Map(),
      effectResults: new Map(),
      lastOutput: makeResponse({ persona: 'child-reviewer', content: 'child abort output' }),
      userInputs: [],
      personaSessions: new Map(),
      stepIterations: new Map(),
      status: 'aborted',
    } as WorkflowState;
    const createEngine = vi.fn().mockReturnValue({
      on: vi.fn(),
      runWithResult: vi.fn().mockResolvedValue({
        state: childState,
        abort: {
          kind: 'step_transition',
          reason: 'Abort due to child ABORT rule',
        },
      }),
    });
    const runner = new WorkflowCallRunner({
      getConfig: () => parentConfig,
      state: {
        workflowName: parentConfig.name,
        currentStep: 'delegate',
        iteration: 1,
        stepOutputs: new Map(),
        structuredOutputs: new Map(),
        systemContexts: new Map(),
        effectResults: new Map(),
        userInputs: [],
        personaSessions: new Map(),
        stepIterations: new Map(),
        status: 'running',
      },
      projectCwd: tmpDir,
      getMaxSteps: () => parentConfig.maxSteps,
      updateMaxSteps: vi.fn(),
      getCwd: () => tmpDir,
      task: 'Abort transition response',
      getOptions: () => createWorkflowCallOptions(tmpDir),
      sharedRuntime: { startedAtMs: Date.now() },
      resumeStackPrefix: [],
      runPaths: {
        slug: 'test-report-dir',
      } as never,
      setActiveResumePoint: vi.fn(),
      emit: vi.fn(),
      resolveWorkflowCall: () => childConfig,
      createEngine,
    });

    const result = await runner.run(parentConfig.steps[0] as never);

    expect(result.response.content).toBe('child abort output');
    expect(result.response.matchedRuleIndex).toBe(1);
  });

  it('WorkflowCallRunner は non-step_transition abort で reason と lastOutput がなくても ABORT を優先する', async () => {
    const parentConfig = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 5,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'child',
          rules: [
            { condition: 'COMPLETE', next: 'COMPLETE' },
            { condition: 'ABORT', next: 'ABORT' },
          ],
        },
      ],
    });
    const childConfig = {
      name: 'child',
      initialStep: 'review',
      maxSteps: 5,
      subworkflow: {
        callable: true,
      },
      steps: [{ name: 'review' }],
    } as WorkflowConfig;
    const parentState = {
      workflowName: parentConfig.name,
      currentStep: 'delegate',
      iteration: 1,
      stepOutputs: new Map(),
      structuredOutputs: new Map(),
      systemContexts: new Map(),
      effectResults: new Map(),
      userInputs: [],
      personaSessions: new Map(),
      stepIterations: new Map(),
      status: 'running',
    } as WorkflowState;
    const childState = {
      workflowName: childConfig.name,
      currentStep: 'review',
      iteration: 2,
      stepOutputs: new Map(),
      structuredOutputs: new Map(),
      systemContexts: new Map(),
      effectResults: new Map(),
      userInputs: [],
      personaSessions: new Map(),
      stepIterations: new Map(),
      status: 'aborted',
    } as WorkflowState;
    const createEngine = vi.fn().mockReturnValue({
      on: vi.fn(),
      runWithResult: vi.fn().mockResolvedValue({
        state: childState,
      }),
    });
    const runner = new WorkflowCallRunner({
      getConfig: () => parentConfig,
      state: parentState,
      projectCwd: tmpDir,
      getMaxSteps: () => parentConfig.maxSteps,
      updateMaxSteps: vi.fn(),
      getCwd: () => tmpDir,
      task: 'Abort fallback response',
      getOptions: () => createWorkflowCallOptions(tmpDir),
      sharedRuntime: { startedAtMs: Date.now() },
      resumeStackPrefix: [],
      runPaths: {
        slug: 'test-report-dir',
      } as never,
      setActiveResumePoint: vi.fn(),
      emit: vi.fn(),
      resolveWorkflowCall: () => childConfig,
      createEngine,
    });

    const result = await runner.run(parentConfig.steps[0] as never);

    expect(result.response.content).toBe('ABORT');
    expect(result.response.matchedRuleIndex).toBe(1);
    expect(parentState.lastOutput?.content).toBe('ABORT');
  });

  it('resume_point は workflow_ref が一致する child workflow にだけ適用する', async () => {
    writeWorkflow(tmpDir, 'child-a.yaml', `name: shared/workflow
subworkflow:
  callable: true
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: child-a-reviewer
    instruction: "Review child workflow A"
    rules:
      - condition: done
        next: COMPLETE
  - name: fix
    persona: child-a-fixer
    instruction: "Fix child workflow A"
    rules:
      - condition: done
        next: COMPLETE
`);
    writeWorkflow(tmpDir, 'child-b.yaml', `name: shared/workflow
subworkflow:
  callable: true
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: child-b-reviewer
    instruction: "Review child workflow B"
    rules:
      - condition: done
        next: COMPLETE
  - name: fix
    persona: child-b-fixer
    instruction: "Fix child workflow B"
    rules:
      - condition: done
        next: COMPLETE
`);
    writeWorkflow(tmpDir, 'parent.yaml', `name: parent
initial_step: delegate
max_steps: 10
steps:
  - name: delegate
    kind: workflow_call
    call: ./child-b.yaml
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
    const parentConfig = loadWorkflowOrThrow('parent', tmpDir);
    const childAConfig = loadWorkflowOrThrow(join(tmpDir, '.takt', 'workflows', 'child-a.yaml'), tmpDir);
    const childConfig = loadWorkflowOrThrow(join(tmpDir, '.takt', 'workflows', 'child-b.yaml'), tmpDir);
    const createEngine = vi.fn().mockReturnValue({
      on: vi.fn(),
      runWithResult: vi.fn().mockResolvedValue({
        state: {
          workflowName: childConfig.name,
          currentStep: 'review',
          iteration: 8,
          stepOutputs: new Map(),
          structuredOutputs: new Map(),
          systemContexts: new Map(),
          effectResults: new Map(),
          lastOutput: makeResponse({ persona: 'child-b-reviewer', content: 'done' }),
          userInputs: [],
          personaSessions: new Map(),
          stepIterations: new Map(),
          status: 'completed',
        },
      }),
    });
    const runner = new WorkflowCallRunner({
      getConfig: () => parentConfig,
      state: {
        workflowName: parentConfig.name,
        currentStep: 'delegate',
        iteration: 7,
        stepOutputs: new Map(),
        structuredOutputs: new Map(),
        systemContexts: new Map(),
        effectResults: new Map(),
        userInputs: [],
        personaSessions: new Map(),
        stepIterations: new Map(),
        status: 'running',
      },
      projectCwd: tmpDir,
      getMaxSteps: () => parentConfig.maxSteps,
      updateMaxSteps: vi.fn(),
      getCwd: () => tmpDir,
      task: 'Resume same-name workflow by workflow_ref',
      getOptions: () => createWorkflowCallOptions(tmpDir, {
        resumePoint: {
          version: 1,
          stack: [
            { workflow: 'parent', step: 'delegate', kind: 'workflow_call' },
            {
              workflow: 'shared/workflow',
              workflow_ref: getWorkflowReference(childAConfig),
              step: 'fix',
              kind: 'agent',
            },
          ],
          iteration: 7,
          elapsed_ms: 183245,
        },
      }),
      sharedRuntime: { startedAtMs: Date.now() },
      resumeStackPrefix: [],
      runPaths: {
        slug: 'test-report-dir',
      } as never,
      setActiveResumePoint: vi.fn(),
      emit: vi.fn(),
      resolveWorkflowCall: () => childConfig,
      createEngine,
    });

    await runner.run(parentConfig.steps[0] as never);

    expect(createEngine.mock.calls[0]?.[3]?.startStep).toBeUndefined();
  });

  it('resume_point の child step が消えていたら child initial_step から再開する', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: fix
max_steps: 5
steps:
  - name: fix
    persona: fixer
    instruction: "Fix child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 10,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    vi.mocked(runAgent).mockResolvedValueOnce(makeResponse({
      persona: 'fixer',
      content: 'done',
    }));
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'Resume workflow_call from child initial step', createWorkflowCallOptions(tmpDir, {
      initialIteration: 7,
      resumePoint: {
        version: 1,
        stack: [
          { workflow: 'parent', step: 'delegate', kind: 'workflow_call' },
          { workflow: 'takt/coding', step: 'review', kind: 'agent' },
        ],
        iteration: 7,
        elapsed_ms: 183245,
      },
    }));

    const state = await engine.run();
    const calledPersona = vi.mocked(runAgent).mock.calls[0]?.[0];

    expect(state.status).toBeDefined();
    expect(calledPersona).toContain('fixer');
  });

  it('resume_point の child step が残っていればその step から再開する', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
max_steps: 5
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: fix
  - name: fix
    persona: fixer
    instruction: "Fix child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 10,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    vi.mocked(runAgent).mockResolvedValueOnce(makeResponse({
      persona: 'fixer',
      content: 'done',
    }));
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'Resume workflow_call from child resume step', createWorkflowCallOptions(tmpDir, {
      initialIteration: 7,
      resumePoint: {
        version: 1,
        stack: [
          { workflow: 'parent', step: 'delegate', kind: 'workflow_call' },
          { workflow: 'takt/coding', step: 'fix', kind: 'agent' },
        ],
        iteration: 7,
        elapsed_ms: 183245,
      },
    }));

    const state = await engine.run();
    const calledPersona = vi.mocked(runAgent).mock.calls[0]?.[0];

    expect(state.status).toBeDefined();
    expect(calledPersona).toContain('fixer');
  });

  it('resume_point の深い child step が消えていたら直近の workflow_call から再開する', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: delegate_review
max_steps: 5
steps:
  - name: delegate_review
    kind: workflow_call
    call: takt/review-loop
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
    writeWorkflow(tmpDir, 'takt/review-loop.yaml', `name: takt/review-loop
subworkflow:
  callable: true
initial_step: fix
max_steps: 5
steps:
  - name: fix
    persona: fixer
    instruction: "Fix child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 10,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    vi.mocked(runAgent).mockResolvedValueOnce(makeResponse({
      persona: 'fixer',
      content: 'done',
    }));
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'Resume nested workflow_call from nearest valid parent', createWorkflowCallOptions(tmpDir, {
      initialIteration: 7,
      resumePoint: {
        version: 1,
        stack: [
          { workflow: 'parent', step: 'delegate', kind: 'workflow_call' },
          { workflow: 'takt/coding', step: 'delegate_review', kind: 'workflow_call' },
          { workflow: 'takt/review-loop', step: 'review', kind: 'agent' },
        ],
        iteration: 7,
        elapsed_ms: 183245,
      },
    }));

    const state = await engine.run();
    const calledPersona = vi.mocked(runAgent).mock.calls[0]?.[0];

    expect(state.status).toBeDefined();
    expect(calledPersona).toContain('fixer');
  });

  it('WorkflowCallRunner は child engine に subworkflow report namespace を渡す', async () => {
    const parentConfig = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 4,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
            {
              condition: 'ABORT',
              next: 'ABORT',
            },
          ],
        },
      ],
    });
    const childConfig = createParentWorkflow(tmpDir, {
      name: 'takt/coding',
      initial_step: 'review',
      max_steps: 4,
      subworkflow: {
        callable: true,
      },
      steps: [
        {
          name: 'review',
          persona: 'reviewer',
          instruction: 'Review child workflow',
          output_contracts: {
            report: [
              {
                name: '00-child-report.md',
                format: 'markdown',
              },
            ],
          },
          rules: [
            {
              condition: 'done',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    const createEngine = vi.fn().mockReturnValue({
      on: vi.fn(),
      runWithResult: vi.fn().mockResolvedValue({
        state: {
          workflowName: childConfig.name,
          currentStep: 'review',
          iteration: 2,
          stepOutputs: new Map(),
          structuredOutputs: new Map(),
          systemContexts: new Map(),
          effectResults: new Map(),
          lastOutput: makeResponse({ persona: 'reviewer', content: 'done' }),
          userInputs: [],
          personaSessions: new Map(),
          stepIterations: new Map(),
          status: 'completed',
        },
      }),
    });
    const runner = new WorkflowCallRunner({
      getConfig: () => parentConfig,
      state: {
        workflowName: parentConfig.name,
        currentStep: 'delegate',
        iteration: 1,
        stepOutputs: new Map(),
        structuredOutputs: new Map(),
        systemContexts: new Map(),
        effectResults: new Map(),
        userInputs: [],
        personaSessions: new Map(),
        stepIterations: new Map(),
        status: 'running',
      },
      projectCwd: tmpDir,
      getMaxSteps: () => parentConfig.maxSteps,
      updateMaxSteps: vi.fn(),
      getCwd: () => tmpDir,
      task: 'Workflow call report namespace',
      getOptions: () => ({
        ...createWorkflowCallOptions(tmpDir),
        reportDirName: 'test-report-dir',
      }),
      sharedRuntime: { startedAtMs: Date.now() },
      resumeStackPrefix: [],
      runPaths: {
        slug: 'test-report-dir',
      } as never,
      setActiveResumePoint: vi.fn(),
      emit: vi.fn(),
      resolveWorkflowCall: () => childConfig,
      createEngine,
    });

    await runner.run(parentConfig.steps[0] as never);

    expect(createEngine).toHaveBeenCalledWith(
      childConfig,
      tmpDir,
      'Workflow call report namespace',
      expect.objectContaining({
        reportDirName: 'test-report-dir',
        runPathNamespace: ['subworkflows', 'iteration-1--step-delegate--workflow-takt%2Fcoding'],
      }),
    );
  });

  it('WorkflowCallRunner は継承した resolver でも nested child の relative call を直近親基準で解決する', async () => {
    const externalDir = createTestTmpDir();
    cleanupDirs.push(externalDir);

    const rootWorkflowPath = join(externalDir, 'root.yaml');
    const childWorkflowPath = join(externalDir, 'child', 'child.yaml');
    const nestedWorkflowPath = join(externalDir, 'child', 'nested.yaml');
    const wrongNestedWorkflowPath = join(externalDir, 'nested.yaml');

    mkdirSync(dirname(childWorkflowPath), { recursive: true });
    writeFileSync(rootWorkflowPath, `name: external-root
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: ./child/child.yaml
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`, 'utf-8');
    writeFileSync(childWorkflowPath, `name: external-child
subworkflow:
  callable: true
initial_step: delegate_nested
max_steps: 3
steps:
  - name: delegate_nested
    kind: workflow_call
    call: ./nested.yaml
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`, 'utf-8');
    writeFileSync(nestedWorkflowPath, `name: nested-child
subworkflow:
  callable: true
initial_step: review
max_steps: 3
steps:
  - name: review
    persona: nested-reviewer
    instruction: "Nested child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');
    writeFileSync(wrongNestedWorkflowPath, `name: wrong-nested-child
subworkflow:
  callable: true
initial_step: review
max_steps: 3
steps:
  - name: review
    persona: wrong-reviewer
    instruction: "Wrong nested child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');

    const rootWorkflow = loadWorkflowOrThrow(rootWorkflowPath, tmpDir);
    const createEngine = vi.fn().mockReturnValue({
      on: vi.fn(),
      runWithResult: vi.fn().mockResolvedValue({
        state: {
          workflowName: 'external-child',
          currentStep: 'delegate_nested',
          iteration: 2,
          stepOutputs: new Map(),
          structuredOutputs: new Map(),
          systemContexts: new Map(),
          effectResults: new Map(),
          lastOutput: makeResponse({ persona: 'delegate_nested', content: 'done' }),
          userInputs: [],
          personaSessions: new Map(),
          stepIterations: new Map(),
          status: 'completed',
        },
      }),
    });
    const runner = new WorkflowCallRunner({
      getConfig: () => rootWorkflow,
      state: {
        workflowName: rootWorkflow.name,
        currentStep: 'delegate',
        iteration: 1,
        stepOutputs: new Map(),
        structuredOutputs: new Map(),
        systemContexts: new Map(),
        effectResults: new Map(),
        userInputs: [],
        personaSessions: new Map(),
        stepIterations: new Map(),
        status: 'running',
      },
      projectCwd: tmpDir,
      getMaxSteps: () => rootWorkflow.maxSteps,
      updateMaxSteps: vi.fn(),
      getCwd: () => tmpDir,
      task: 'Nested workflow call resolver context',
      getOptions: () => createWorkflowCallOptions(tmpDir),
      sharedRuntime: { startedAtMs: Date.now() },
      resumeStackPrefix: [],
      runPaths: {
        slug: 'test-report-dir',
      } as never,
      setActiveResumePoint: vi.fn(),
      emit: vi.fn(),
      resolveWorkflowCall: ({
        parentWorkflow,
        identifier,
        stepName,
        projectCwd,
        lookupCwd,
      }) => resolveWorkflowCallTarget(
        parentWorkflow,
        identifier,
        stepName,
        projectCwd,
        lookupCwd,
        {
          sourcePath: getWorkflowSourcePath(rootWorkflow),
          trustInfo: getWorkflowTrustInfo(rootWorkflow, projectCwd),
        },
      ),
      createEngine,
    });

    await runner.run(rootWorkflow.steps[0] as never);

    const childWorkflow = createEngine.mock.calls[0]?.[0];
    const childResolver = createEngine.mock.calls[0]?.[3]?.workflowCallResolver as (args: {
      parentWorkflow: Parameters<typeof resolveWorkflowCallTarget>[0];
      identifier: Parameters<typeof resolveWorkflowCallTarget>[1];
      stepName: Parameters<typeof resolveWorkflowCallTarget>[2];
      projectCwd: Parameters<typeof resolveWorkflowCallTarget>[3];
      lookupCwd: string;
    }) => ReturnType<typeof resolveWorkflowCallTarget>;

    const nestedWorkflow = childResolver({
      parentWorkflow: childWorkflow,
      identifier: './nested.yaml',
      stepName: 'delegate_nested',
      projectCwd: tmpDir,
      lookupCwd: tmpDir,
    });

    expect(nestedWorkflow).not.toBeNull();
    expect(nestedWorkflow?.name).toBe('nested-child');
  });

  it('WorkflowCallRunner は slug が同じ別名でも child namespace を衝突させない', async () => {
    const createChildState = () => ({
      workflowName: 'child',
      currentStep: 'review',
      iteration: 2,
      stepOutputs: new Map(),
      structuredOutputs: new Map(),
      systemContexts: new Map(),
      effectResults: new Map(),
      lastOutput: makeResponse({ persona: 'reviewer', content: 'done' }),
      userInputs: [],
      personaSessions: new Map(),
      stepIterations: new Map(),
      status: 'completed' as const,
    });
    const createState = (workflowName: string, stepName: string) => ({
      workflowName,
      currentStep: stepName,
      iteration: 1,
      stepOutputs: new Map(),
      structuredOutputs: new Map(),
      systemContexts: new Map(),
      effectResults: new Map(),
      userInputs: [],
      personaSessions: new Map(),
      stepIterations: new Map(),
      status: 'running' as const,
    });
    const createNamespaceRunner = (
      stepName: string,
      childWorkflowName: string,
      createEngine: ReturnType<typeof vi.fn>,
    ) => {
      const parentConfig = createParentWorkflow(tmpDir, {
        name: `parent-${stepName}`,
        initial_step: stepName,
        max_steps: 4,
        steps: [
          {
            name: stepName,
            kind: 'workflow_call',
            call: childWorkflowName,
            rules: [
              {
                condition: 'COMPLETE',
                next: 'COMPLETE',
              },
            ],
          },
        ],
      });
      const childConfig = createParentWorkflow(tmpDir, {
        name: childWorkflowName,
        initial_step: 'review',
        max_steps: 4,
        subworkflow: {
          callable: true,
        },
        steps: [
          {
            name: 'review',
            persona: 'reviewer',
            instruction: 'Review child workflow',
            rules: [
              {
                condition: 'done',
                next: 'COMPLETE',
              },
            ],
          },
        ],
      });

      return {
        runner: new WorkflowCallRunner({
          getConfig: () => parentConfig,
          state: createState(parentConfig.name, stepName),
          projectCwd: tmpDir,
          getMaxSteps: () => parentConfig.maxSteps,
          updateMaxSteps: vi.fn(),
          getCwd: () => tmpDir,
          task: 'Workflow call namespace collision',
          getOptions: () => ({
            ...createWorkflowCallOptions(tmpDir),
            reportDirName: 'test-report-dir',
          }),
          sharedRuntime: { startedAtMs: Date.now() },
          resumeStackPrefix: [],
          runPaths: {
            slug: 'test-report-dir',
          } as never,
          setActiveResumePoint: vi.fn(),
          emit: vi.fn(),
          resolveWorkflowCall: () => childConfig,
          createEngine,
        }),
        step: parentConfig.steps[0] as never,
      };
    };

    const createEngineA = vi.fn().mockReturnValue({
      on: vi.fn(),
      runWithResult: vi.fn().mockResolvedValue({ state: createChildState() }),
    });
    const createEngineB = vi.fn().mockReturnValue({
      on: vi.fn(),
      runWithResult: vi.fn().mockResolvedValue({ state: createChildState() }),
    });
    const runA = createNamespaceRunner('delegate/a', 'takt:review', createEngineA);
    const runB = createNamespaceRunner('delegate:a', 'takt/review', createEngineB);

    await runA.runner.run(runA.step);
    await runB.runner.run(runB.step);

    const namespaceA = createEngineA.mock.calls[0]?.[3]?.runPathNamespace;
    const namespaceB = createEngineB.mock.calls[0]?.[3]?.runPathNamespace;

    expect(namespaceA).toEqual(['subworkflows', 'iteration-1--step-delegate%2Fa--workflow-takt%3Areview']);
    expect(namespaceB).toEqual(['subworkflows', 'iteration-1--step-delegate%3Aa--workflow-takt%2Freview']);
    expect(namespaceA).not.toEqual(namespaceB);
  });

  it('WorkflowCallRunner は同じ workflow_call step を再実行しても child namespace を衝突させない', async () => {
    const childConfig = createParentWorkflow(tmpDir, {
      name: 'takt/coding',
      initial_step: 'review',
      max_steps: 4,
      subworkflow: {
        callable: true,
      },
      steps: [
        {
          name: 'review',
          persona: 'reviewer',
          instruction: 'Review child workflow',
          rules: [
            {
              condition: 'done',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });
    const parentConfig = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 4,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });
    const createEngine = vi.fn().mockReturnValue({
      on: vi.fn(),
      runWithResult: vi.fn().mockResolvedValue({
        state: {
          workflowName: childConfig.name,
          currentStep: 'review',
          iteration: 4,
          stepOutputs: new Map(),
          structuredOutputs: new Map(),
          systemContexts: new Map(),
          effectResults: new Map(),
          lastOutput: makeResponse({ persona: 'reviewer', content: 'done' }),
          userInputs: [],
          personaSessions: new Map(),
          stepIterations: new Map(),
          status: 'completed',
        },
      }),
    });
    const createRunner = (iteration: number) => new WorkflowCallRunner({
      getConfig: () => parentConfig,
      state: {
        workflowName: parentConfig.name,
        currentStep: 'delegate',
        iteration,
        stepOutputs: new Map(),
        structuredOutputs: new Map(),
        systemContexts: new Map(),
        effectResults: new Map(),
        userInputs: [],
        personaSessions: new Map(),
        stepIterations: new Map(),
        status: 'running',
      },
      projectCwd: tmpDir,
      getMaxSteps: () => parentConfig.maxSteps,
      updateMaxSteps: vi.fn(),
      getCwd: () => tmpDir,
      task: 'Workflow call namespace iteration isolation',
      getOptions: () => ({
        ...createWorkflowCallOptions(tmpDir),
        reportDirName: 'test-report-dir',
      }),
      sharedRuntime: { startedAtMs: Date.now() },
      resumeStackPrefix: [],
      runPaths: {
        slug: 'test-report-dir',
      } as never,
      setActiveResumePoint: vi.fn(),
      emit: vi.fn(),
      resolveWorkflowCall: () => childConfig,
      createEngine,
    });

    await createRunner(1).run(parentConfig.steps[0] as never);
    await createRunner(3).run(parentConfig.steps[0] as never);

    const firstNamespace = createEngine.mock.calls[0]?.[3]?.runPathNamespace;
    const secondNamespace = createEngine.mock.calls[1]?.[3]?.runPathNamespace;

    expect(firstNamespace).toEqual(['subworkflows', 'iteration-1--step-delegate--workflow-takt%2Fcoding']);
    expect(secondNamespace).toEqual(['subworkflows', 'iteration-3--step-delegate--workflow-takt%2Fcoding']);
    expect(firstNamespace).not.toEqual(secondNamespace);
  });
});
