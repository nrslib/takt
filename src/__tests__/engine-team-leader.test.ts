import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runAgent } from '../agents/runner.js';
import { detectMatchedRule } from '../core/workflow/evaluation/index.js';
import { WorkflowEngine } from '../core/workflow/engine/WorkflowEngine.js';
import { makeStep, makeRule, makeResponse, createTestTmpDir, applyDefaultMocks } from './engine-test-helpers.js';
import type { WorkflowConfig } from '../core/models/index.js';
import { initNdjsonLog } from '../infra/fs/session.js';
import { SessionLogger } from '../features/tasks/execute/sessionLogger.js';
import { renderTraceReportFromLogs } from '../features/tasks/execute/traceReport.js';

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
    expect(state.stepOutputs.get('implement')).toMatchObject({
      persona: 'implement',
      status: 'error',
      error: 'All team leader parts failed: part-1: api failed; part-2: test failed',
    });
    expect(state.lastOutput).toMatchObject({
      persona: 'implement',
      status: 'error',
      error: 'All team leader parts failed: part-1: api failed; part-2: test failed',
    });
  });

  it('全パート失敗時でも team leader step_complete と trace に分類付き失敗理由を残す', async () => {
    const config = buildTeamLeaderConfig();
    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', { projectCwd: tmpDir, provider: 'claude' });
    const logsDir = join(tmpDir, '.takt', 'runs', 'test-report-dir', 'logs');
    const ndjsonPath = initNdjsonLog('session-team-leader-abort', 'implement feature', config.name, { logsDir });
    const sessionLogger = new SessionLogger(ndjsonPath, true);

    engine.on('step:start', (step, iteration, instruction, providerInfo) => {
      sessionLogger.onStepStart(step, iteration, instruction, undefined, providerInfo);
    });
    engine.on('step:complete', (step, response, instruction) => {
      sessionLogger.onStepComplete(step, response, instruction, undefined);
    });
    engine.on('workflow:abort', (workflowState, reason) => {
      sessionLogger.onWorkflowAbort(workflowState, reason);
    });

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
      makeResponse({
        persona: 'coder',
        status: 'error',
        content: '',
        error: 'external abort: Workflow interrupted by user (SIGINT)',
        failureCategory: 'external_abort',
      }),
      makeResponse({
        persona: 'coder',
        status: 'error',
        content: '',
        error: 'part timeout: Part timeout after 10000ms',
        failureCategory: 'part_timeout',
      }),
      makeResponse({
        persona: 'team-leader',
        structuredOutput: { done: true, reasoning: 'stop', parts: [] },
      }),
    );

    const state = await engine.run();

    expect(state.status).toBe('aborted');

    const records = readFileSync(ndjsonPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const stepComplete = records.find((record) => record.type === 'step_complete' && record.step === 'implement');
    const workflowAbort = records.find((record) => record.type === 'workflow_abort');

    expect(stepComplete).toMatchObject({
      type: 'step_complete',
      step: 'implement',
      status: 'error',
      error: 'All team leader parts failed: part-1: external abort: Workflow interrupted by user (SIGINT); part-2: part timeout: Part timeout after 10000ms',
    });
    expect(workflowAbort).toMatchObject({
      type: 'workflow_abort',
      reason: expect.stringContaining('All team leader parts failed: part-1: external abort: Workflow interrupted by user (SIGINT); part-2: part timeout: Part timeout after 10000ms'),
    });

    const trace = renderTraceReportFromLogs(
      {
        tracePath: join(tmpDir, '.takt', 'runs', 'test-report-dir', 'trace.md'),
        workflowName: config.name,
        task: 'implement feature',
        runSlug: 'test-report-dir',
        status: 'aborted',
        iterations: 1,
        endTime: '2026-04-25T00:00:00.000Z',
        reason: String(workflowAbort?.reason ?? ''),
      },
      ndjsonPath,
      undefined,
      'full',
    );

    expect(trace).toContain('- Step Status: error');
    expect(trace).toContain('All team leader parts failed: part-1: external abort: Workflow interrupted by user (SIGINT); part-2: part timeout: Part timeout after 10000ms');
  });

  it('全パート失敗時は stream idle timeout の分類を集約メッセージと trace に残す', async () => {
    const config = buildTeamLeaderConfig();
    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', { projectCwd: tmpDir, provider: 'claude' });
    const logsDir = join(tmpDir, '.takt', 'runs', 'test-report-dir', 'logs');
    const ndjsonPath = initNdjsonLog('session-team-leader-stream-idle-timeout', 'implement feature', config.name, { logsDir });
    const sessionLogger = new SessionLogger(ndjsonPath, true);

    engine.on('step:start', (step, iteration, instruction, providerInfo) => {
      sessionLogger.onStepStart(step, iteration, instruction, undefined, providerInfo);
    });
    engine.on('step:complete', (step, response, instruction) => {
      sessionLogger.onStepComplete(step, response, instruction, undefined);
    });
    engine.on('workflow:abort', (workflowState, reason) => {
      sessionLogger.onWorkflowAbort(workflowState, reason);
    });

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
      makeResponse({
        persona: 'coder',
        status: 'error',
        content: '',
        error: 'Codex stream timed out after 10 minutes of inactivity',
        failureCategory: 'stream_idle_timeout',
      }),
      makeResponse({
        persona: 'coder',
        status: 'error',
        content: '',
        error: 'stream idle timeout: Secondary stream timed out after 2 minutes of inactivity',
        failureCategory: 'stream_idle_timeout',
      }),
      makeResponse({
        persona: 'team-leader',
        structuredOutput: { done: true, reasoning: 'stop', parts: [] },
      }),
    );

    const state = await engine.run();

    expect(state.status).toBe('aborted');

    const expectedError =
      'All team leader parts failed: part-1: stream idle timeout: Codex stream timed out after 10 minutes of inactivity; part-2: stream idle timeout: Secondary stream timed out after 2 minutes of inactivity';

    expect(state.stepOutputs.get('implement')).toMatchObject({
      status: 'error',
      error: expectedError,
    });
    expect(state.lastOutput).toMatchObject({
      status: 'error',
      error: expectedError,
    });

    const records = readFileSync(ndjsonPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const stepComplete = records.find((record) => record.type === 'step_complete' && record.step === 'implement');
    const workflowAbort = records.find((record) => record.type === 'workflow_abort');

    expect(stepComplete).toMatchObject({
      type: 'step_complete',
      step: 'implement',
      status: 'error',
      error: expectedError,
    });
    expect(workflowAbort).toMatchObject({
      type: 'workflow_abort',
      reason: expect.stringContaining(expectedError),
    });

    const trace = renderTraceReportFromLogs(
      {
        tracePath: join(tmpDir, '.takt', 'runs', 'test-report-dir', 'trace.md'),
        workflowName: config.name,
        task: 'implement feature',
        runSlug: 'test-report-dir',
        status: 'aborted',
        iterations: 1,
        endTime: '2026-04-25T00:00:00.000Z',
        reason: String(workflowAbort?.reason ?? ''),
      },
      ndjsonPath,
      undefined,
      'full',
    );

    expect(trace).toContain('- Step Status: error');
    expect(trace).toContain(expectedError);
  });

  it('reason なしの親 abort でも external abort 分類を集約メッセージに残す', async () => {
    const config = buildTeamLeaderConfig();
    const abortController = new AbortController();
    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', {
      projectCwd: tmpDir,
      provider: 'claude',
      abortSignal: abortController.signal,
    });
    const mock = vi.mocked(runAgent);

    mockRunAgentWithPrompt(
      makeResponse({
        persona: 'team-leader',
        structuredOutput: {
          parts: [
            { id: 'part-1', title: 'API', instruction: 'Implement API' },
          ],
        },
      }),
    );
    mock.mockImplementationOnce(async (persona, instruction, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: instruction,
      });

      return new Promise((_, reject) => {
        const abortSignal = options?.abortSignal;
        if (!abortSignal) {
          reject(new Error('abortSignal is required'));
          return;
        }

        const rejectWithAbortReason = (): void => {
          reject(abortSignal.reason);
        };

        if (abortSignal.aborted) {
          rejectWithAbortReason();
          return;
        }

        abortSignal.addEventListener('abort', rejectWithAbortReason, { once: true });
        queueMicrotask(() => abortController.abort());
      });
    });
    mockRunAgentWithPrompt(
      makeResponse({
        persona: 'team-leader',
        structuredOutput: { done: true, reasoning: 'stop', parts: [] },
      }),
    );

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(state.stepOutputs.get('implement')).toMatchObject({
      status: 'error',
      error: 'All team leader parts failed: part-1: external abort: This operation was aborted',
    });
    expect(state.lastOutput).toMatchObject({
      status: 'error',
      error: 'All team leader parts failed: part-1: external abort: This operation was aborted',
    });
  });

  it('全パート失敗時は provider error の分類も集約メッセージに残す', async () => {
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
      makeResponse({
        persona: 'coder',
        status: 'error',
        content: '',
        error: 'Upstream model returned 500',
        failureCategory: 'provider_error',
      }),
      makeResponse({
        persona: 'coder',
        status: 'error',
        content: '',
        error: 'Gateway unavailable',
        failureCategory: 'provider_error',
      }),
      makeResponse({
        persona: 'team-leader',
        structuredOutput: { done: true, reasoning: 'stop', parts: [] },
      }),
    );

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(state.stepOutputs.get('implement')).toMatchObject({
      status: 'error',
      error: 'All team leader parts failed: part-1: provider error: Upstream model returned 500; part-2: provider error: Gateway unavailable',
    });
    expect(state.lastOutput).toMatchObject({
      status: 'error',
      error: 'All team leader parts failed: part-1: provider error: Upstream model returned 500; part-2: provider error: Gateway unavailable',
    });
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

  it('persona_providers の provider_options は team leader part に反映されつつ claude.allowed_tools は strip される', async () => {
    const config = buildTeamLeaderConfig();
    const step = config.steps[0];
    if (!step?.teamLeader) {
      throw new Error('teamLeader configuration is required');
    }
    step.teamLeader.partPersona = 'coder';

    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', {
      projectCwd: tmpDir,
      provider: 'claude',
      personaProviders: {
        coder: {
          provider: 'opencode',
          model: 'opencode/zai-coding-plan/glm-5.1',
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
