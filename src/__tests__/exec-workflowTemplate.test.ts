import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import type { AgentWorkflowStep } from '../core/models/index.js';
import { resolveLoopMonitorJudgeProviderModel, resolveStepProviderModel } from '../core/workflow/provider-resolution.js';
import type { ExecConfig } from '../features/exec/types.js';
import { buildExecWorkflowYaml } from '../features/exec/workflowTemplate.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';

type ExecConfigOverrides = Omit<Partial<ExecConfig>, 'session' | 'replan' | 'loop'> & {
  session?: Partial<ExecConfig['session']>;
  replan?: Partial<ExecConfig['replan']>;
  loop?: Partial<ExecConfig['loop']>;
};

type RawWorkflow = {
  loop_monitors?: Array<{
    cycle: string[];
    threshold: number;
    judge: Record<string, unknown>;
  }>;
  report_formats?: Record<string, string>;
  steps: Array<Record<string, unknown>>;
};

function createExecConfig(overrides: ExecConfigOverrides = {}): ExecConfig {
  const base: ExecConfig = {
    session: {
      provider: 'claude',
      model: 'opus',
      effort: 'high',
    },
    replan: {
      instruction: 'exec-replan',
      knowledge: ['architecture'],
      policy: [],
    },
    workers: [
      {
        name: 'worker-1',
        provider: 'claude',
        model: 'sonnet',
        effort: 'high',
        instruction: 'exec-worker',
        knowledge: ['architecture'],
        policy: ['coding', 'testing'],
      },
    ],
    reviews: [
      {
        name: 'review-1',
        provider: 'claude',
        model: 'opus',
        effort: 'high',
        instruction: 'exec-review',
        knowledge: ['architecture'],
        policy: ['review'],
      },
    ],
    loop: {
      smallThreshold: 3,
      largeThreshold: 2,
      maxSteps: 20,
    },
  };

  return {
    ...base,
    ...overrides,
    session: { ...base.session, ...overrides.session },
    replan: { ...base.replan, ...overrides.replan },
    workers: overrides.workers ?? base.workers,
    reviews: overrides.reviews ?? base.reviews,
    loop: { ...base.loop, ...overrides.loop },
  };
}

function withTaktConfigDir<T>(configDir: string, run: () => T): T {
  const originalConfigDir = process.env.TAKT_CONFIG_DIR;
  process.env.TAKT_CONFIG_DIR = configDir;
  try {
    return run();
  } finally {
    if (originalConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = originalConfigDir;
    }
  }
}

function writeFacet(projectDir: string, kind: string, name: string, content: string): void {
  const dir = join(projectDir, '.takt', 'facets', kind);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), content);
}

function writeExecFacetStubs(projectDir: string): void {
  writeFacet(projectDir, 'personas', 'exec-assistant', 'Exec assistant persona');
  writeFacet(projectDir, 'personas', 'exec-worker', 'Exec worker persona');
  for (const name of ['exec-worker', 'exec-review', 'exec-replan']) {
    writeFacet(projectDir, 'instructions', name, `${name} instruction`);
  }
  writeFacet(projectDir, 'instructions', 'exec-loop-monitor', 'exec-loop-monitor {cycle_count} instruction');
  for (const name of ['architecture', 'unit-testing']) {
    writeFacet(projectDir, 'knowledge', name, `${name} knowledge`);
  }
  for (const name of ['coding', 'testing', 'review']) {
    writeFacet(projectDir, 'policies', name, `${name} policy`);
  }
  writeFacet(projectDir, 'output-contracts', 'exec-review-result', 'Exec review result output contract');
}

function writeWorkflowAndLoad(yaml: string): { workflow: ReturnType<typeof loadWorkflowFromFile>; projectDir: string; globalConfigDir: string } {
  const projectDir = mkdtempSync(join(tmpdir(), 'takt-exec-workflow-project-'));
  const globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-exec-workflow-global-'));
  const workflowPath = join(projectDir, '.takt', 'exec', 'workflow.yaml');
  mkdirSync(join(projectDir, '.takt', 'exec'), { recursive: true });
  writeExecFacetStubs(projectDir);
  writeFileSync(workflowPath, yaml);

  const workflow = withTaktConfigDir(globalConfigDir, () => loadWorkflowFromFile(workflowPath, projectDir));
  return { workflow, projectDir, globalConfigDir };
}

function parseRawWorkflow(yaml: string): RawWorkflow {
  const raw = parseYaml(yaml);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Generated exec workflow YAML must be an object');
  }
  return raw as RawWorkflow;
}

describe('exec workflow template', () => {
  it('should generate a loadable workflow with parallel execute and review steps', () => {
    const yaml = buildExecWorkflowYaml(createExecConfig(), {
      workflowName: 'exec-test',
      taskDescription: 'Implement the requested task',
    });
    const raw = parseRawWorkflow(yaml);
    const { workflow, projectDir, globalConfigDir } = writeWorkflowAndLoad(yaml);
    try {
      const execute = workflow.steps.find((step) => step.name === 'execute') as AgentWorkflowStep | undefined;
      const judge = workflow.steps.find((step) => step.name === 'review') as AgentWorkflowStep | undefined;
      const replan = workflow.steps.find((step) => step.name === 'replan') as AgentWorkflowStep | undefined;
      const worker = execute?.parallel?.[0];
      const judgeActor = judge?.parallel?.[0];
      const rawJudge = raw.steps.find((step) => step.name === 'review');
      const rawReplan = raw.steps.find((step) => step.name === 'replan');
      expect(workflow.name).toBe('exec-test');
      expect(workflow.description).toBe('Implement the requested task');
      expect(workflow.initialStep).toBe('execute');
      expect(workflow.maxSteps).toBe(20);
      expect(execute?.parallel).toHaveLength(1);
      expect(judge?.parallel).toHaveLength(1);
      expect(worker?.sessionKey).toBe('worker-1');
      expect(worker?.persona).toBe('exec-worker');
      expect(worker?.personaPath).toContain('exec-worker.md');
      expect(judgeActor?.sessionKey).toBe('review-1');
      expect(rawJudge).toMatchObject({
        pass_previous_response: false,
        parallel: [
          {
            pass_previous_response: false,
            provider_options: {
              claude: {
                allowed_tools: ['Read', 'Glob', 'Grep'],
              },
            },
          },
        ],
      });
      expect(rawReplan).toMatchObject({
        provider_options: {
          claude: {
            allowed_tools: ['Read', 'Glob', 'Grep'],
          },
        },
      });
      expect(judge?.passPreviousResponse).toBe(false);
      expect(judgeActor?.passPreviousResponse).toBe(false);
      expect(replan?.sessionKey).toBe('exec-replan');
      expect(execute?.rules).toEqual([
        expect.objectContaining({ condition: 'all("done")', next: 'review', aggregateType: 'all' }),
        expect.objectContaining({ condition: 'any("blocked")', next: 'review', aggregateType: 'any' }),
      ]);
      expect(judge?.rules).toEqual([
        expect.objectContaining({ condition: 'all("approved")', next: 'COMPLETE', aggregateType: 'all' }),
        expect.objectContaining({ condition: 'any("needs_replan")', next: 'replan', aggregateType: 'any' }),
        expect.objectContaining({ condition: 'any("needs_fix")', next: 'execute', aggregateType: 'any' }),
      ]);
      expect(replan?.persona).toBe('exec-assistant');
      expect(rawReplan).toHaveProperty('requires_user_input', true);
      expect(replan?.requiresUserInput).toBe(true);
      expect(replan?.rules).toEqual([
        expect.objectContaining({
          condition: 'User input needed for clarification',
          next: 'replan',
          requiresUserInput: true,
          interactiveOnly: true,
        }),
        expect.objectContaining({ condition: 'New plan ready', next: 'execute' }),
        expect.objectContaining({ condition: 'Cannot proceed', next: 'ABORT' }),
      ]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(globalConfigDir, { recursive: true, force: true });
    }
  });

  it('should load generated parallel sub-steps with explicit model omission', () => {
    const yaml = buildExecWorkflowYaml(createExecConfig({
      session: {
        provider: 'cursor',
        model: undefined,
        effort: undefined,
      },
      workers: [
        {
          name: 'cursor-worker',
          provider: 'cursor',
          model: undefined,
          effort: undefined,
          instruction: 'exec-worker',
          knowledge: ['architecture'],
          policy: ['coding', 'testing'],
        },
      ],
      reviews: [
        {
          name: 'cursor-review',
          provider: 'cursor',
          model: undefined,
          effort: undefined,
          instruction: 'exec-review',
          knowledge: ['architecture'],
          policy: ['review'],
        },
      ],
    }), {
      workflowName: 'exec-omitted-model-test',
      taskDescription: 'Implement optional model workflow',
    });
    const raw = parseRawWorkflow(yaml);
    const { workflow, projectDir, globalConfigDir } = writeWorkflowAndLoad(yaml);
    try {
      const execute = workflow.steps.find((step) => step.name === 'execute') as AgentWorkflowStep | undefined;
      const judge = workflow.steps.find((step) => step.name === 'review') as AgentWorkflowStep | undefined;
      const replan = workflow.steps.find((step) => step.name === 'replan') as AgentWorkflowStep | undefined;
      const cursorWorker = execute?.parallel?.[0];
      const cursorJudge = judge?.parallel?.[0];
      if (!cursorWorker || !cursorJudge || !replan || !judge) {
        throw new Error('Generated exec workflow must include cursor worker, review, and replan steps');
      }

      expect(raw.steps.find((step) => step.name === 'execute')).toMatchObject({
        parallel: [{ provider: 'cursor', model: null }],
      });
      expect(raw.steps.find((step) => step.name === 'review')).toMatchObject({
        parallel: [{ provider: 'cursor', model: null }],
      });
      expect(raw.steps.find((step) => step.name === 'replan')).toMatchObject({
        provider: 'cursor',
        model: null,
      });
      expect(raw.loop_monitors?.map((monitor) => monitor.judge)).toEqual([
        expect.objectContaining({ provider: 'cursor', model: null }),
        expect.objectContaining({ provider: 'cursor', model: null }),
      ]);
      expect(cursorWorker).toMatchObject({
        provider: 'cursor',
        model: undefined,
        modelSpecified: true,
      });
      expect(cursorJudge).toMatchObject({
        provider: 'cursor',
        model: undefined,
        modelSpecified: true,
      });
      expect(replan).toMatchObject({
        provider: 'cursor',
        model: undefined,
        modelSpecified: true,
      });
      for (const monitor of workflow.loopMonitors ?? []) {
        expect(monitor.judge.provider).toBe('cursor');
        expect(monitor.judge.model).toBeUndefined();
        expect(monitor.judge.modelSpecified).toBe(true);
        expect(resolveLoopMonitorJudgeProviderModel({
          judge: monitor.judge,
          triggeringProviderInfo: {
            provider: 'cursor',
            providerSource: 'step',
            model: 'global-model',
            modelSource: 'step',
          },
        })).toEqual({
          provider: 'cursor',
          providerSource: 'step',
          model: undefined,
          modelSource: 'step',
        });
      }
      expect(resolveStepProviderModel({
        step: cursorWorker,
        provider: 'cursor',
        model: 'global-model',
      })).toEqual(expect.objectContaining({
        provider: 'cursor',
        model: undefined,
        modelSource: 'step',
      }));
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(globalConfigDir, { recursive: true, force: true });
    }
  });

  it('should generate loop monitors and unique review report output contracts', () => {
    const yaml = buildExecWorkflowYaml(createExecConfig({
      reviews: [
        {
          name: 'review-1',
          provider: 'claude',
          model: 'opus',
          effort: 'high',
          instruction: 'exec-review',
          knowledge: ['architecture'],
          policy: ['review'],
        },
        {
          name: 'security-review',
          provider: 'claude',
          model: 'opus',
          effort: 'high',
          instruction: 'exec-review',
          knowledge: ['architecture'],
          policy: ['review'],
        },
      ],
      loop: {
        smallThreshold: 4,
        largeThreshold: 2,
        maxSteps: 30,
      },
    }), {
      workflowName: 'exec-loop-test',
      taskDescription: 'Implement loop-aware task',
      });
      const raw = parseRawWorkflow(yaml);
      const { workflow, projectDir, globalConfigDir } = writeWorkflowAndLoad(yaml);
    try {
      const judge = workflow.steps.find((step) => step.name === 'review') as AgentWorkflowStep | undefined;
      const loopMonitorJudges = raw.loop_monitors?.map((monitor) => monitor.judge);
      if (!judge) {
        throw new Error('Generated exec workflow must include review step');
      }
      expect(workflow.maxSteps).toBe(30);
      expect(loopMonitorJudges).toEqual([
        expect.objectContaining({
          provider: 'claude',
          model: 'opus',
          provider_options: {
            claude: {
              effort: 'high',
              allowed_tools: ['Read', 'Glob', 'Grep'],
            },
          },
        }),
        expect.objectContaining({
          provider: 'claude',
          model: 'opus',
          provider_options: {
            claude: {
              effort: 'high',
              allowed_tools: ['Read', 'Glob', 'Grep'],
            },
          },
        }),
      ]);
      expect(workflow.loopMonitors).toEqual([
        expect.objectContaining({
          cycle: ['execute', 'review'],
          threshold: 4,
          judge: expect.objectContaining({
            sessionKey: 'exec-loop-monitor-small',
            persona: 'exec-assistant',
            instruction: 'exec-loop-monitor {cycle_count} instruction',
            rules: [
              { condition: 'Healthy (progress being made)', next: 'execute' },
              { condition: 'Unproductive (same rework repeating)', next: 'replan' },
            ],
          }),
        }),
        expect.objectContaining({
          cycle: ['replan', 'execute', 'review'],
          threshold: 2,
          judge: expect.objectContaining({
            sessionKey: 'exec-loop-monitor-large',
            persona: 'exec-assistant',
            instruction: 'exec-loop-monitor {cycle_count} instruction',
            rules: [
              { condition: 'Healthy (progress being made)', next: 'replan' },
              { condition: 'Unproductive (no convergence)', next: 'COMPLETE' },
            ],
          }),
        }),
      ]);
      expect(raw.report_formats).toBeUndefined();
      expect(judge?.parallel?.map((step) => step.outputContracts?.[0]?.name)).toEqual([
        'review-1-review-result.md',
        'security-review-review-result.md',
      ]);
      expect(judge?.parallel?.[0]?.outputContracts).toEqual([
        expect.objectContaining({
          name: 'review-1-review-result.md',
          format: 'Exec review result output contract',
        }),
      ]);
      for (const monitor of workflow.loopMonitors ?? []) {
        expect(monitor.judge.providerOptions).toEqual({
          claude: {
            effort: 'high',
            allowedTools: ['Read', 'Glob', 'Grep'],
          },
        });
        expect(resolveLoopMonitorJudgeProviderModel({
          judge: monitor.judge,
          triggeringProviderInfo: {
            provider: 'mock',
            model: 'global-model',
          },
        })).toEqual({
          provider: 'claude',
          providerSource: 'step',
          model: 'opus',
          modelSource: 'step',
        });
      }
      expect(judge?.outputContracts).toBeUndefined();
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(globalConfigDir, { recursive: true, force: true });
    }
  });

  it('should emit provider-specific effort options without leaking unsupported provider effort', () => {
    const yaml = buildExecWorkflowYaml(createExecConfig({
      workers: [
        {
          name: 'claude-worker',
          provider: 'claude-sdk',
          model: 'sonnet',
          effort: 'high',
          instruction: 'exec-worker',
          knowledge: ['architecture'],
          policy: ['coding', 'testing'],
        },
        {
          name: 'codex-worker',
          provider: 'codex',
          model: 'gpt-5',
          effort: 'medium',
          instruction: 'exec-worker',
          knowledge: ['unit-testing'],
          policy: ['testing'],
        },
        {
          name: 'opencode-worker',
          provider: 'opencode',
          model: 'opencode/example',
          instruction: 'exec-worker',
          knowledge: ['architecture'],
          policy: ['coding'],
        },
      ],
      reviews: [
        {
          name: 'terminal-review',
          provider: 'claude-terminal',
          model: 'sonnet',
          effort: 'medium',
          instruction: 'exec-review',
          knowledge: ['architecture'],
          policy: ['review'],
        },
        {
          name: 'copilot-review',
          provider: 'copilot',
          model: 'gpt-5',
          effort: 'low',
          instruction: 'exec-review',
          knowledge: ['architecture'],
          policy: ['review'],
        },
      ],
    }), {
      workflowName: 'exec-provider-test',
      taskDescription: 'Implement provider-specific task',
    });
    const { workflow, projectDir, globalConfigDir } = writeWorkflowAndLoad(yaml);
    try {
      const execute = workflow.steps.find((step) => step.name === 'execute') as AgentWorkflowStep | undefined;
      const judge = workflow.steps.find((step) => step.name === 'review') as AgentWorkflowStep | undefined;
      const claudeWorker = execute?.parallel?.find((step) => step.name === 'claude-worker');
      const codexWorker = execute?.parallel?.find((step) => step.name === 'codex-worker');
      const opencodeWorker = execute?.parallel?.find((step) => step.name === 'opencode-worker');
      const terminalJudge = judge?.parallel?.find((step) => step.name === 'terminal-review');
      const copilotJudge = judge?.parallel?.find((step) => step.name === 'copilot-review');
      expect(claudeWorker?.providerOptions).toEqual({
        claude: {
          effort: 'high',
          allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
        },
      });
      expect(codexWorker?.providerOptions).toEqual({
        codex: {
          reasoningEffort: 'medium',
        },
      });
      expect(opencodeWorker?.providerOptions).toBeUndefined();
      expect(terminalJudge?.providerOptions).toEqual({
        claude: {
          effort: 'medium',
          allowedTools: ['Read', 'Glob', 'Grep'],
        },
      });
      expect(copilotJudge?.providerOptions).toEqual({
        copilot: {
          effort: 'low',
        },
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(globalConfigDir, { recursive: true, force: true });
    }
  });

  it('should reject effort values that the selected provider cannot use', () => {
    expect(() => buildExecWorkflowYaml(createExecConfig({
      workers: [
        {
          name: 'codex-worker',
          provider: 'codex',
          model: 'gpt-5',
          effort: 'max',
          instruction: 'exec-worker',
          knowledge: ['architecture'],
          policy: ['coding'],
        },
      ],
    }), {
      workflowName: 'exec-invalid-effort-test',
      taskDescription: 'Reject invalid effort',
    })).toThrow(/does not support effort "max"/);
  });

  it('should reject effort for providers without effort support', () => {
    expect(() => buildExecWorkflowYaml(createExecConfig({
      workers: [
        {
          name: 'opencode-worker',
          provider: 'opencode',
          model: 'opencode/example',
          effort: 'high',
          instruction: 'exec-worker',
          knowledge: ['architecture'],
          policy: ['coding'],
        },
      ],
    }), {
      workflowName: 'exec-unsupported-provider-effort-test',
      taskDescription: 'Reject unsupported provider effort',
    })).toThrow(/provider "opencode" does not support effort "high"/);
  });

  it('should allow missing effort for providers with exec effort support', () => {
    const raw = parseRawWorkflow(buildExecWorkflowYaml(createExecConfig({
      session: {
        provider: 'codex',
        model: 'gpt-5',
        effort: undefined,
      },
    }), {
      workflowName: 'exec-missing-effort-test',
      taskDescription: 'Allow missing effort',
    }));

    expect(raw.steps.find((step) => step.name === 'replan')).not.toHaveProperty('provider_options');
  });

  it('should reject actor names that cannot be used as session keys or report file names', () => {
    expect(() => buildExecWorkflowYaml(createExecConfig({
      reviews: [
        {
          name: '../review',
          provider: 'claude',
          model: 'opus',
          effort: 'high',
          instruction: 'exec-review',
          knowledge: ['architecture'],
          policy: ['review'],
        },
      ],
    }), {
      workflowName: 'exec-invalid-actor-name-test',
      taskDescription: 'Reject invalid actor name',
    })).toThrow(/actor name must match/);
  });

  it('should reject actor names that collide with generated exec workflow steps', () => {
    const reservedNames = [
      'execute',
      'review',
      'replan',
      '_loop_judge_execute_review',
      '_loop_judge_replan_execute_review',
    ];

    for (const name of reservedNames) {
      expect(() => buildExecWorkflowYaml(createExecConfig({
        workers: [
          {
            name,
            provider: 'claude',
            model: 'sonnet',
            effort: 'high',
            instruction: 'exec-worker',
            knowledge: ['architecture'],
            policy: ['coding'],
          },
        ],
      }), {
        workflowName: 'exec-reserved-actor-name-test',
        taskDescription: 'Reject reserved actor name',
      })).toThrow(new RegExp(`actor name "${name}" is reserved`));
    }
  });
});
