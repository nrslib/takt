import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAgent } from '../agents/runner.js';
import { mockRuleEvaluation } from './rule-evaluator-test-double.js';
import { WorkflowEngine } from '../core/workflow/engine/WorkflowEngine.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
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
});
