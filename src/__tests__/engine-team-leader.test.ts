import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { runAgent } from '../agents/runner.js';
import { detectMatchedRule } from '../core/workflow/evaluation/index.js';
import { WorkflowEngine } from '../core/workflow/engine/WorkflowEngine.js';
import { makeStep, makeRule, makeResponse, createTestTmpDir, applyDefaultMocks } from './engine-test-helpers.js';
import type { WorkflowConfig } from '../core/models/index.js';

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

function buildTeamLeaderConfig(): WorkflowConfig {
  return {
    name: 'team-leader-workflow',
    initialStep: 'implement',
    maxSteps: 5,
    steps: [
      makeStep('implement', {
        instruction: 'Task: {task}',
        teamLeader: {
          persona: '../personas/team-leader.md',
          maxParts: 3,
          refillThreshold: 0,
          timeoutMs: 10000,
          partPersona: '../personas/coder.md',
          partAllowedTools: ['Read', 'Edit', 'Write'],
          partEdit: true,
          partPermissionMode: 'edit',
        },
        rules: [makeRule('done', 'COMPLETE')],
      }),
    ],
  };
}

function mockRunAgentWithPrompt(...responses: ReturnType<typeof makeResponse>[]): void {
  const mock = vi.mocked(runAgent);
  for (const response of responses) {
    mock.mockImplementationOnce(async (persona, instruction, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: instruction,
      });
      return response;
    });
  }
}

describe('WorkflowEngine Integration: TeamLeaderRunner', () => {
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

  it('team leaderが分解したパートを並列実行し集約する', async () => {
    const config = buildTeamLeaderConfig();
    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', { projectCwd: tmpDir, provider: 'claude' });

    mockRunAgentWithPrompt(
      makeResponse({
        persona: 'team-leader',
        structuredOutput: {
          parts: [
            { id: 'part-1', title: 'API', instruction: 'Implement API' },
            { id: 'part-2', title: 'Test', instruction: 'Add tests' },
          ],
        },
      }),
      makeResponse({ persona: 'coder', content: 'API done' }),
      makeResponse({ persona: 'coder', content: 'Tests done' }),
      makeResponse({
        persona: 'team-leader',
        structuredOutput: { done: true, reasoning: 'enough', parts: [] },
      }),
    );

    vi.mocked(detectMatchedRule).mockResolvedValueOnce({ index: 0, method: 'phase1_tag' });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(4);
    const output = state.stepOutputs.get('implement');
    expect(output).toBeDefined();
    expect(output!.content).toContain('## decomposition');
    expect(output!.content).toContain('## part-1: API');
    expect(output!.content).toContain('API done');
    expect(output!.content).toContain('## part-2: Test');
    expect(output!.content).toContain('Tests done');
  });

  it('全パートが失敗した場合はstep失敗として中断する', async () => {
    const config = buildTeamLeaderConfig();
    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', { projectCwd: tmpDir, provider: 'claude' });

    mockRunAgentWithPrompt(
      makeResponse({
        persona: 'team-leader',
        structuredOutput: {
          parts: [
            { id: 'part-1', title: 'API', instruction: 'Implement API' },
            { id: 'part-2', title: 'Test', instruction: 'Add tests' },
          ],
        },
      }),
      makeResponse({ persona: 'coder', status: 'error', error: 'api failed' }),
      makeResponse({ persona: 'coder', status: 'error', error: 'test failed' }),
      makeResponse({
        persona: 'team-leader',
        structuredOutput: { done: true, reasoning: 'stop', parts: [] },
      }),
    );

    const state = await engine.run();

    expect(state.status).toBe('aborted');
  });

  it('一部パートが失敗しても成功パートがあれば集約結果は完了する', async () => {
    const config = buildTeamLeaderConfig();
    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', { projectCwd: tmpDir, provider: 'claude' });

    mockRunAgentWithPrompt(
      makeResponse({
        persona: 'team-leader',
        structuredOutput: {
          parts: [
            { id: 'part-1', title: 'API', instruction: 'Implement API' },
            { id: 'part-2', title: 'Test', instruction: 'Add tests' },
          ],
        },
      }),
      makeResponse({ persona: 'coder', content: 'API done' }),
      makeResponse({ persona: 'coder', status: 'error', error: 'test failed' }),
      makeResponse({
        persona: 'team-leader',
        structuredOutput: { done: true, reasoning: 'stop', parts: [] },
      }),
    );

    vi.mocked(detectMatchedRule).mockResolvedValueOnce({ index: 0, method: 'phase1_tag' });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    const output = state.stepOutputs.get('implement');
    expect(output).toBeDefined();
    expect(output!.content).toContain('## part-1: API');
    expect(output!.content).toContain('API done');
    expect(output!.content).toContain('## part-2: Test');
    expect(output!.content).toContain('[ERROR] test failed');
  });

  it('パート失敗時にerrorがなくてもcontentの詳細をエラー表示に使う', async () => {
    const config = buildTeamLeaderConfig();
    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', { projectCwd: tmpDir, provider: 'claude' });

    mockRunAgentWithPrompt(
      makeResponse({
        persona: 'team-leader',
        structuredOutput: {
          parts: [
            { id: 'part-1', title: 'API', instruction: 'Implement API' },
            { id: 'part-2', title: 'Test', instruction: 'Add tests' },
          ],
        },
      }),
      makeResponse({ persona: 'coder', status: 'error', content: 'api failed from content' }),
      makeResponse({ persona: 'coder', content: 'Tests done' }),
      makeResponse({
        persona: 'team-leader',
        structuredOutput: { done: true, reasoning: 'stop', parts: [] },
      }),
    );

    vi.mocked(detectMatchedRule).mockResolvedValueOnce({ index: 0, method: 'phase1_tag' });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    const output = state.stepOutputs.get('implement');
    expect(output).toBeDefined();
    expect(output!.content).toContain('[ERROR] api failed from content');
  });

  it('結果に応じて追加パートを生成して実行する', async () => {
    const config = buildTeamLeaderConfig();
    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', { projectCwd: tmpDir, provider: 'claude' });

    mockRunAgentWithPrompt(
      makeResponse({
        persona: 'team-leader',
        structuredOutput: {
          parts: [
            { id: 'part-1', title: 'API', instruction: 'Implement API' },
            { id: 'part-2', title: 'Test', instruction: 'Add tests' },
          ],
        },
      }),
      makeResponse({ persona: 'coder', content: 'API done' }),
      makeResponse({ persona: 'coder', content: 'Tests done' }),
      makeResponse({
        persona: 'team-leader',
        structuredOutput: {
          done: false,
          reasoning: 'Need docs',
          parts: [
            { id: 'part-3', title: 'Docs', instruction: 'Write docs' },
          ],
        },
      }),
      makeResponse({ persona: 'coder', content: 'Docs done' }),
      makeResponse({
        persona: 'team-leader',
        structuredOutput: {
          done: true,
          reasoning: 'Enough',
          parts: [],
        },
      }),
    );

    vi.mocked(detectMatchedRule).mockResolvedValueOnce({ index: 0, method: 'phase1_tag' });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(6);
    const output = state.stepOutputs.get('implement');
    expect(output).toBeDefined();
    expect(output!.content).toContain('## part-3: Docs');
    expect(output!.content).toContain('Docs done');
  });

  it('persona_providers で opencode に解決される part でも part_allowed_tools を runtime allowedTools として渡す', async () => {
    const config = buildTeamLeaderConfig();
    const step = config.steps[0];
    if (!step?.teamLeader) {
      throw new Error('teamLeader configuration is required');
    }
    step.teamLeader.partPersona = 'coder';
    step.providerOptions = {
      opencode: {
        networkAccess: true,
      },
      claude: {
        allowedTools: ['Read', 'Edit', 'Bash', 'WebSearch'],
        sandbox: {
          allowUnsandboxedCommands: true,
        },
      },
    };

    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', {
      projectCwd: tmpDir,
      provider: 'claude',
      personaProviders: {
        coder: {
          provider: 'opencode',
          model: 'opencode/zai-coding-plan/glm-5.1',
        },
      },
    });

    mockRunAgentWithPrompt(
      makeResponse({
        persona: 'team-leader',
        structuredOutput: {
          parts: [
            { id: 'part-1', title: 'API', instruction: 'Implement API' },
          ],
        },
      }),
      makeResponse({ persona: 'coder', content: 'API done' }),
      makeResponse({
        persona: 'team-leader',
        structuredOutput: { done: true, reasoning: 'enough', parts: [] },
      }),
    );

    vi.mocked(detectMatchedRule).mockResolvedValueOnce({ index: 0, method: 'phase1_tag' });

    const state = await engine.run();

    expect(state.status).toBe('completed');

    const partCall = vi.mocked(runAgent).mock.calls.find(([, , options]) => options?.resolvedProvider === 'opencode');
    expect(partCall).toBeDefined();
    expect(partCall?.[2]).toEqual(expect.objectContaining({
      allowedTools: ['Read', 'Edit', 'Write'],
      resolvedProvider: 'opencode',
      resolvedModel: 'opencode/zai-coding-plan/glm-5.1',
      providerOptions: {
        opencode: {
          networkAccess: true,
        },
        claude: {
          sandbox: {
            allowUnsandboxedCommands: true,
          },
        },
      },
    }));
    expect(partCall?.[2]?.providerOptions?.claude?.allowedTools).toBeUndefined();
  });

  it('config 層の claude.allowed_tools は opencode part 実行時に再注入されない', async () => {
    const config = buildTeamLeaderConfig();
    const step = config.steps[0];
    if (!step?.teamLeader) {
      throw new Error('teamLeader configuration is required');
    }
    step.teamLeader.partPersona = 'coder';

    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', {
      projectCwd: tmpDir,
      provider: 'claude',
      providerOptions: {
        opencode: {
          networkAccess: true,
        },
        claude: {
          allowedTools: ['Read', 'Edit', 'Bash', 'WebSearch'],
          sandbox: {
            allowUnsandboxedCommands: true,
          },
        },
      },
      personaProviders: {
        coder: {
          provider: 'opencode',
          model: 'opencode/zai-coding-plan/glm-5.1',
        },
      },
    });

    mockRunAgentWithPrompt(
      makeResponse({
        persona: 'team-leader',
        structuredOutput: {
          parts: [
            { id: 'part-1', title: 'API', instruction: 'Implement API' },
          ],
        },
      }),
      makeResponse({ persona: 'coder', content: 'API done' }),
      makeResponse({
        persona: 'team-leader',
        structuredOutput: { done: true, reasoning: 'enough', parts: [] },
      }),
    );

    vi.mocked(detectMatchedRule).mockResolvedValueOnce({ index: 0, method: 'phase1_tag' });

    const state = await engine.run();

    expect(state.status).toBe('completed');

    const partCall = vi.mocked(runAgent).mock.calls.find(([, , options]) => options?.resolvedProvider === 'opencode');
    expect(partCall).toBeDefined();
    expect(partCall?.[2]).toEqual(expect.objectContaining({
      allowedTools: ['Read', 'Edit', 'Write'],
      resolvedProvider: 'opencode',
      resolvedModel: 'opencode/zai-coding-plan/glm-5.1',
      providerOptions: {
        opencode: {
          networkAccess: true,
        },
        claude: {
          sandbox: {
            allowUnsandboxedCommands: true,
          },
        },
      },
    }));
    expect(partCall?.[2]?.providerOptions?.claude?.allowedTools).toBeUndefined();
  });

  it('Claude part で part_allowed_tools 未指定なら provider_options.claude.allowed_tools を継承する', async () => {
    const config = buildTeamLeaderConfig();
    const step = config.steps[0];
    if (!step?.teamLeader) {
      throw new Error('teamLeader configuration is required');
    }
    step.teamLeader.partPersona = 'coder';
    step.teamLeader.partAllowedTools = undefined;

    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', {
      projectCwd: tmpDir,
      provider: 'claude',
      providerOptions: {
        claude: {
          allowedTools: ['Read', 'Edit', 'Bash'],
          sandbox: {
            allowUnsandboxedCommands: true,
          },
        },
      },
    });

    mockRunAgentWithPrompt(
      makeResponse({
        persona: 'team-leader',
        structuredOutput: {
          parts: [
            { id: 'part-1', title: 'API', instruction: 'Implement API' },
          ],
        },
      }),
      makeResponse({ persona: 'coder', content: 'API done' }),
      makeResponse({
        persona: 'team-leader',
        structuredOutput: { done: true, reasoning: 'enough', parts: [] },
      }),
    );

    vi.mocked(detectMatchedRule).mockResolvedValueOnce({ index: 0, method: 'phase1_tag' });

    const state = await engine.run();

    expect(state.status).toBe('completed');

    const partCall = vi.mocked(runAgent).mock.calls.find(([persona, , options]) => (
      persona === 'coder' && options?.resolvedProvider === 'claude'
    ));
    expect(partCall).toBeDefined();
    expect(partCall?.[2]).toEqual(expect.objectContaining({
      allowedTools: ['Read', 'Edit', 'Bash'],
      providerOptions: {
        claude: {
          allowedTools: ['Read', 'Edit', 'Bash'],
          sandbox: {
            allowUnsandboxedCommands: true,
          },
        },
      },
      resolvedProvider: 'claude',
    }));
  });

  it('team leader の phase:start には分解実行時の実 instruction を記録する', async () => {
    const config = buildTeamLeaderConfig();
    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', { projectCwd: tmpDir, provider: 'claude' });
    const phaseStarts: string[] = [];
    engine.on('phase:start', (step, phase, phaseName, instruction) => {
      if (step.name !== 'implement' || phase !== 1 || phaseName !== 'execute') return;
      phaseStarts.push(instruction);
    });

    mockRunAgentWithPrompt(
      makeResponse({
        persona: 'team-leader',
        structuredOutput: {
          parts: [{ id: 'part-1', title: 'API', instruction: 'Implement API' }],
        },
      }),
      makeResponse({ persona: 'coder', content: 'API done' }),
      makeResponse({
        persona: 'team-leader',
        structuredOutput: { done: true, reasoning: 'enough', parts: [] },
      }),
    );
    vi.mocked(detectMatchedRule).mockResolvedValueOnce({ index: 0, method: 'phase1_tag' });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(phaseStarts.length).toBeGreaterThan(0);
    expect(phaseStarts[0]).toContain('This is decomposition-only planning. Do not execute the task.');
  });

});
