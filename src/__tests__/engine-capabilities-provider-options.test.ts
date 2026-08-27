import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { runAgent } from '../agents/runner.js';
import { mockRuleEvaluation } from './rule-evaluator-test-double.js';
import { WorkflowEngine } from '../core/workflow/engine/WorkflowEngine.js';
import { GitSelectorCommandRunner } from '../infra/task/selector-git-command-runner.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import { loadWorkflowByIdentifier } from '../infra/config/loaders/workflowResolver.js';
import { applyDefaultMocks, createTestTmpDir, makeResponse, mockRuleEvaluationSequence, mockRunAgentSequence } from './engine-test-helpers.js';

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

vi.mock('../core/workflow/phase-runner.js', () => ({
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ label: '', method: 'auto_select' }),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

/**
 * `capabilities:` は workflow YAML から最終的な runAgent 呼び出しの providerOptions まで
 * 届いて初めて意味を持つ。ロード時の畳み込みだけを検証すると、エンジンが読まない
 * フィールドに乗ったまま実行時 no-op になる後退（実際に起きた）を見逃す。
 */

const MOCK_SELECTOR_PROVIDER = {
  provider: 'mock' as const,
  model: undefined,
  providerOptions: {},
};

let tmpDir: string;

beforeEach(() => {
  vi.resetAllMocks();
  applyDefaultMocks();
  tmpDir = createTestTmpDir();
  mkdirSync(join(tmpDir, 'provider-options'), { recursive: true });
  writeFileSync(
    join(tmpDir, 'provider-options', 'inspect.yaml'),
    'claude:\n  allowed_tools:\n    - Read\n    - Grep\nopencode:\n  network_access: true\n',
  );
  writeFileSync(
    join(tmpDir, 'provider-options', 'writer.yaml'),
    'claude:\n  allowed_tools:\n    - Read\n    - Edit\n    - Write\n',
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function agentOptionsOfCall(index: number) {
  return vi.mocked(runAgent).mock.calls[index]![2];
}

describe('capabilities reach the final provider call', () => {
  it.each([
    { stepName: 'plan' },
    { stepName: 'write_tests' },
  ])(
    'builtin simple の $stepName capability と Codex runtime profile を最終 provider options へ渡す',
    async ({ stepName }) => {
      mkdirSync(join(tmpDir, '.takt'), { recursive: true });
      writeFileSync(join(tmpDir, '.takt', 'config.yaml'), 'language: ja\n', 'utf-8');
      const config = loadWorkflowByIdentifier('simple', tmpDir);
      if (!config) {
        throw new Error('Expected builtin workflow "simple"');
      }
      mockRunAgentSequence([makeResponse({ persona: 'agent', content: 'done' })]);
      mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

      const engine = new WorkflowEngine(config, tmpDir, 'task', {
        projectCwd: tmpDir,
        provider: 'codex',
        providerSource: 'runtime-v1',
        providerOptionsProviderSource: 'runtime-v1',
        providerOptions: {
          codex: {
            permissionControl: 'codex',
            reasoningEffort: 'high',
            fastMode: true,
          },
        },
        startStep: stepName,
        maxStepsOverride: 1,
        workflowCallResolver: () => null,
      });
      const abortReasons: string[] = [];
      engine.on('workflow:abort', (_state, reason) => abortReasons.push(reason));

      const state = await engine.run();

      if (vi.mocked(runAgent).mock.calls.length === 0) {
        throw new Error(`Expected runAgent call; workflow ended with ${JSON.stringify({
          status: state.status,
          currentStep: state.currentStep,
          iteration: state.iteration,
          lastOutput: state.lastOutput,
          abortReasons,
        })}`);
      }
      expect(agentOptionsOfCall(0).providerOptions?.codex).toEqual({
        permissionControl: 'codex',
        networkAccess: true,
        reasoningEffort: 'high',
        fastMode: true,
        skills: { repo: true, user: true },
      });
    },
  );

  it('should pass the resolved capability options to runAgent when a step declares capabilities', async () => {
    const config = normalizeWorkflowConfig(
      {
        name: 'wf',
        max_steps: 2,
        initial_step: 'plan',
        steps: [
          {
            name: 'plan',
            instruction: '{task}',
            capabilities: 'provider-options/inspect.yaml',
            rules: [{ condition: 'done', next: 'COMPLETE' }],
          },
        ],
      },
      tmpDir,
    );
    mockRunAgentSequence([makeResponse({ persona: 'agent', content: 'done' })]);
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    const state = await new WorkflowEngine(config, tmpDir, 'task', {
      projectCwd: tmpDir,
      provider: 'claude',
    }).run();

    expect(state.status).toBe('completed');
    expect(agentOptionsOfCall(0).providerOptions).toEqual({
      claude: { allowedTools: ['Read', 'Grep'] },
      opencode: { networkAccess: true },
    });
  });

  it('should pass the parent capability options to runAgent when a parallel sub-step declares none', async () => {
    const config = normalizeWorkflowConfig(
      {
        name: 'wf',
        max_steps: 2,
        initial_step: 'review',
        capabilities: 'provider-options/writer.yaml',
        steps: [
          {
            name: 'review',
            capabilities: 'provider-options/inspect.yaml',
            parallel: [
              { name: 'inherits-parent', instruction: 'review' },
              {
                name: 'declares-own',
                instruction: 'review',
                capabilities: 'provider-options/writer.yaml',
              },
            ],
            rules: [{ condition: 'all(done)', next: 'COMPLETE' }],
          },
        ],
      },
      tmpDir,
    );
    mockRunAgentSequence([
      makeResponse({ persona: 'agent', content: 'done' }),
      makeResponse({ persona: 'agent', content: 'done' }),
    ]);
    vi.mocked(mockRuleEvaluation).mockReturnValue({ index: 0, method: 'phase3_tag' });

    const state = await new WorkflowEngine(config, tmpDir, 'task', {
      projectCwd: tmpDir,
      provider: 'claude',
    }).run();

    expect(state.status).toBe('completed');
    const byName = new Map(
      vi.mocked(runAgent).mock.calls.map((call) => [
        call[2].permissionResolution?.stepName,
        call[2].providerOptions,
      ]),
    );
    expect(byName.get('inherits-parent')).toEqual({
      claude: { allowedTools: ['Read', 'Grep'] },
      opencode: { networkAccess: true },
    });
    expect(byName.get('declares-own')).toEqual({
      claude: { allowedTools: ['Read', 'Edit', 'Write'] },
    });
  });

  it('should pass the step capability options to part runAgent calls when a team_leader step declares capabilities', async () => {
    const config = normalizeWorkflowConfig(
      {
        name: 'wf',
        max_steps: 2,
        initial_step: 'implement',
        steps: [
          {
            name: 'implement',
            instruction: '{task}',
            capabilities: 'provider-options/inspect.yaml',
            team_leader: {
              max_concurrency: 2,
              timeout_ms: 10000,
            },
            rules: [{ condition: 'done', next: 'COMPLETE' }],
          },
        ],
      },
      tmpDir,
    );
    const responses = [
      makeResponse({
        persona: 'leader',
        structuredOutput: { parts: [{ id: 'part-1', title: 'API', instruction: 'implement api' }] },
      }),
      makeResponse({ persona: 'coder', content: 'API done' }),
      makeResponse({
        persona: 'leader',
        structuredOutput: { done: true, reasoning: 'enough', parts: [] },
      }),
    ];
    vi.mocked(runAgent).mockImplementation(async (persona, task, options) => {
      options?.onPromptResolved?.({ systemPrompt: '', userInstruction: task });
      return responses.shift()!;
    });
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    const state = await new WorkflowEngine(config, tmpDir, 'task', {
      projectCwd: tmpDir,
      provider: 'claude',
    }).run();

    expect(state.status).toBe('completed');
    const partCall = vi.mocked(runAgent).mock.calls.find(
      (call) => call[2].permissionResolution?.stepName === 'implement.part-1',
    );
    expect(partCall).toBeDefined();
    expect(partCall![2].providerOptions).toEqual({
      claude: { allowedTools: ['Read', 'Grep'] },
      opencode: { networkAccess: true },
    });
  });

  it('should pass inherited and own capability options to runAgent when dynamic parallel runs fixed and pool sub-steps', async () => {
    const config = normalizeWorkflowConfig(
      {
        name: 'wf',
        max_steps: 2,
        initial_step: 'reviewers',
        steps: [
          {
            name: 'reviewers',
            capabilities: 'provider-options/inspect.yaml',
            parallel: {
              fixed: [
                {
                  name: 'fixed-inherits',
                  persona: 'architecture',
                  instruction: 'review architecture',
                  rules: [{ condition: 'approved', next: 'COMPLETE' }],
                },
              ],
              pool: [
                {
                  name: 'pool-declares-own',
                  persona: 'frontend',
                  description: 'frontend review',
                  instruction: 'review frontend',
                  capabilities: 'provider-options/writer.yaml',
                  rules: [{ condition: 'approved', next: 'COMPLETE' }],
                },
                {
                  name: 'pool-unselected',
                  persona: 'backend',
                  description: 'backend review',
                  instruction: 'review backend',
                  rules: [{ condition: 'approved', next: 'COMPLETE' }],
                },
              ],
              selection: { mode: 'replace' },
            },
            rules: [{ condition: 'all("approved")', next: 'COMPLETE' }],
          },
        ],
      },
      tmpDir,
    );
    vi.mocked(runAgent).mockImplementation(async (persona, task, options) => {
      if (options?.outputSchema) {
        return makeResponse({
          persona: persona ?? 'selector',
          structuredOutput: { selected_ids: ['pool-declares-own'], rationale: 'frontend changed' },
        });
      }
      options?.onPromptResolved?.({ systemPrompt: '', userInstruction: task });
      return makeResponse({ persona: persona ?? 'reviewer', content: 'approved' });
    });
    vi.mocked(mockRuleEvaluation).mockReturnValue({ index: 0, method: 'phase3_tag' });

    // dynamic parallel の selection snapshot は git 管理下の作業ツリーを前提とする
    execFileSync('git', ['init', '--quiet'], { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'tracked.ts'), 'const x = 1;\n', 'utf-8');
    execFileSync('git', ['add', 'tracked.ts'], { cwd: tmpDir });
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '--quiet', '-m', 'init'], { cwd: tmpDir });

    const engine = new WorkflowEngine(config, tmpDir, 'task', {
      projectCwd: tmpDir,
      provider: 'claude',
      selectorProvider: MOCK_SELECTOR_PROVIDER,
      selectorGitCommandRunner: new GitSelectorCommandRunner(),
    });
    const ran = await engine.run();

    expect(ran.status).toBe('completed');
    const byName = new Map(
      vi.mocked(runAgent).mock.calls.map((call) => [
        call[2].permissionResolution?.stepName,
        call[2].providerOptions,
      ]),
    );
    expect(byName.get('fixed-inherits')).toEqual({
      claude: { allowedTools: ['Read', 'Grep'] },
      opencode: { networkAccess: true },
    });
    expect(byName.get('pool-declares-own')).toEqual({
      claude: { allowedTools: ['Read', 'Edit', 'Write'] },
    });
    expect(byName.has('pool-unselected')).toBe(false);
  });

  it('should pass the merged list options including skills to runAgent when a step declares a capabilities list', async () => {
    writeFileSync(
      join(tmpDir, 'provider-options', 'skills-grant.yaml'),
      'codex:\n  skills:\n    repo: true\n    user: true\n',
    );
    const config = normalizeWorkflowConfig(
      {
        name: 'wf',
        max_steps: 2,
        initial_step: 'implement',
        steps: [
          {
            name: 'implement',
            instruction: '{task}',
            capabilities: ['provider-options/writer.yaml', 'provider-options/skills-grant.yaml'],
            rules: [{ condition: 'done', next: 'COMPLETE' }],
          },
        ],
      },
      tmpDir,
    );
    mockRunAgentSequence([makeResponse({ persona: 'agent', content: 'done' })]);
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    const state = await new WorkflowEngine(config, tmpDir, 'task', {
      projectCwd: tmpDir,
      provider: 'claude',
    }).run();

    expect(state.status).toBe('completed');
    expect(agentOptionsOfCall(0).providerOptions).toEqual({
      claude: { allowedTools: ['Read', 'Edit', 'Write'] },
      codex: { skills: { repo: true, user: true } },
    });
  });
});
