import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runAgent } from '../agents/runner.js';
import { detectMatchedRule } from '../core/workflow/evaluation/index.js';
import { WorkflowEngine } from '../core/workflow/engine/WorkflowEngine.js';
import { makeStep, makeRule, makeResponse, createTestTmpDir, applyDefaultMocks } from './engine-test-helpers.js';
import type { WorkflowConfig } from '../core/models/index.js';
import type { AutoRoutingConfig } from '../core/models/config-types.js';
import { initNdjsonLog } from '../infra/fs/session.js';
import { SessionLogger } from '../features/tasks/execute/sessionLogger.js';
import { renderTraceReportFromLogs } from '../features/tasks/execute/traceReport.js';
import { createProviderEventLogger } from '../core/logging/providerEventLogger.js';
import { createUsageEventLogger, type UsageEventLoggerConfig } from '../core/logging/usageEventLogger.js';
import { USAGE_MISSING_REASONS } from '../core/logging/contracts.js';
import type { ProviderEventLogRecord } from '../core/logging/providerEvent.js';
import type { UsageEventLogRecord } from '../core/logging/usageEvent.js';
import { DebugLogger } from '../shared/utils/debug.js';

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
          maxConcurrency: 3,
          maxTotalParts: 20,
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

function createAutoRoutingConfig(): AutoRoutingConfig {
  return {
    strategy: 'balanced',
    router: {
      provider: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
    },
    candidates: [
      {
        name: 'coding',
        description: 'Implementation and tests',
        provider: 'codex',
        model: 'gpt-5',
        costTier: 'medium',
      },
    ],
    rules: {
      tags: {
        implementation: 'coding',
      },
    },
  };
}

function createTeamLeaderAutoRoutingConfig(): AutoRoutingConfig {
  const autoRouting = createAutoRoutingConfig();
  return {
    ...autoRouting,
    rules: {
      ...autoRouting.rules,
      personas: {
        'team-leader': 'coding',
      },
    },
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

function mockRunAgentRejectingOnAbort(onWaitingForAbort?: () => void): void {
  vi.mocked(runAgent).mockImplementationOnce(async (persona, instruction, options) => {
    options?.onPromptResolved?.({
      systemPrompt: typeof persona === 'string' ? persona : '',
      userInstruction: instruction,
    });
    const abortSignal = options?.abortSignal;
    if (!abortSignal) {
      throw new Error('abortSignal is required');
    }

    return new Promise<never>((_resolve, reject) => {
      const rejectWithAbortReason = (): void => {
        reject(abortSignal.reason);
      };
      if (abortSignal.aborted) {
        rejectWithAbortReason();
        return;
      }
      abortSignal.addEventListener('abort', rejectWithAbortReason, { once: true });
      onWaitingForAbort?.();
    });
  });
}

describe('WorkflowEngine Integration: TeamLeaderRunner', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    DebugLogger.getInstance().reset();
    tmpDir = createTestTmpDir();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    DebugLogger.getInstance().reset();
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

  it('親 AbortSignal を decomposition call に渡し、cancel 後に再試行しない', async () => {
    const config = buildTeamLeaderConfig();
    const abortController = new AbortController();
    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', {
      projectCwd: tmpDir,
      provider: 'claude',
      abortSignal: abortController.signal,
    });
    mockRunAgentRejectingOnAbort(() => abortController.abort());

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(vi.mocked(runAgent)).toHaveBeenCalledOnce();
    expect(vi.mocked(runAgent).mock.calls[0]?.[2]?.abortSignal).toBe(abortController.signal);
  });

  it('feedback call 中の親中断を workflow aborted として伝播し後続callを停止する', async () => {
    const config = buildTeamLeaderConfig();
    const abortController = new AbortController();
    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', {
      projectCwd: tmpDir,
      provider: 'claude',
      abortSignal: abortController.signal,
    });
    mockRunAgentWithPrompt(
      makeResponse({
        persona: 'team-leader',
        structuredOutput: {
          parts: [{ id: 'part-1', title: 'API', instruction: 'Implement API' }],
        },
      }),
      makeResponse({ persona: 'coder', content: 'API done' }),
    );
    vi.mocked(runAgent).mockImplementationOnce(async () => {
      abortController.abort(new Error('feedback aborted'));
      throw abortController.signal.reason;
    });

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(runAgent).mock.calls[2]?.[2]?.abortSignal).toBe(abortController.signal);
  });

  // buildGitRules は team-leader-part-runner の buildTeamLeaderPartInstruction 経由でも
  // 注入される（#1012）。git_rules.md の parts/ 移行でこの経路が壊れていないことを確認する。
  it('team leader が分解したパートの instruction にも git ルールが注入される', async () => {
    const config = buildTeamLeaderConfig();
    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', { projectCwd: tmpDir, provider: 'claude' });

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
    // 2回目の runAgent 呼び出しがパート（coder）実行。第2引数が組み立てられた instruction。
    // commit 禁止文は phase2 にもあるため、それだけでは phase2 への退行を検出できない。
    // phase1 固有の index 状態ルールまで直接 assert する。
    const partCall = vi.mocked(runAgent).mock.calls[1];
    expect(partCall?.[1]).toContain('Do NOT run git commit');
    expect(partCall?.[1]).toContain('Do NOT run git add');
    expect(partCall?.[1]).toContain('index state (staged / unstaged / untracked)');
    expect(partCall?.[1]).toContain('git check-ignore -v');
  });

  it('team leader と worker の auto routing decision を routing event として発行する', async () => {
    const config = buildTeamLeaderConfig();
    const step = config.steps[0];
    if (!step?.teamLeader) {
      throw new Error('teamLeader configuration is required');
    }
    step.tags = ['implementation'];
    step.teamLeader.partTags = ['implementation'];
    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', {
      projectCwd: tmpDir,
      provider: 'mock',
      autoRouting: createAutoRoutingConfig(),
    });
    const routingDecision = vi.fn();
    engine.on('routing:decision', routingDecision);

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
    const routingEvents = routingDecision.mock.calls;

    expect(state.status).toBe('completed');
    expect(routingEvents).toHaveLength(2);
    expect(routingEvents[0]?.[0]).toMatchObject({
      name: 'implement',
      tags: ['implementation'],
    });
    expect(routingEvents[0]?.[3]).toMatchObject({
      provider: 'codex',
      model: 'gpt-5',
      providerSource: 'auto.rules',
      autoRoutingDecision: {
        candidateName: 'coding',
      },
    });
    expect(routingEvents[0]?.[4]).toBe('agent');
    expect(typeof routingEvents[0]?.[5]).toBe('number');
    expect(routingEvents[1]?.[0]).toMatchObject({
      name: 'implement.part-1',
      tags: ['implementation'],
    });
    expect(routingEvents[1]?.[3]).toMatchObject({
      provider: 'codex',
      model: 'gpt-5',
      providerSource: 'auto.rules',
      autoRoutingDecision: {
        candidateName: 'coding',
      },
    });
    expect(routingEvents[1]?.[4]).toBe('agent');
    expect(typeof routingEvents[1]?.[5]).toBe('number');
  });

  it('team leader と worker の実 provider を候補ごとに JSONL へ記録する', async () => {
    const config = buildTeamLeaderConfig();
    const step = config.steps[0];
    if (!step?.teamLeader) {
      throw new Error('teamLeader configuration is required');
    }
    step.teamLeader.providerRoutingPersonaKey = 'team-leader';
    step.teamLeader.partTags = ['implementation'];
    const autoRouting: AutoRoutingConfig = {
      strategy: 'balanced',
      router: {
        provider: 'claude-sdk',
        model: 'claude-haiku-4-5-20251001',
      },
      candidates: [
        {
          name: 'leader',
          description: 'Team leader planning',
          provider: 'mock',
          model: 'mock-1',
          costTier: 'medium',
        },
        {
          name: 'coding',
          description: 'Implementation and tests',
          provider: 'codex',
          model: 'gpt-5',
          costTier: 'medium',
        },
      ],
      rules: {
        tags: {
          implementation: 'coding',
        },
        personas: {
          'team-leader': 'leader',
        },
      },
    };
    const logsDir = join(tmpDir, '.takt', 'runs', 'test-report-dir', 'logs');
    const providerLogger = createProviderEventLogger({
      logsDir,
      sessionId: 'team-routing',
      runId: 'team-routing-run',
      enabled: true,
    });
    const usageLogger = createUsageEventLogger({
      logsDir,
      sessionId: 'team-routing',
      runId: 'team-routing-run',
      enabled: true,
    } satisfies UsageEventLoggerConfig);
    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', {
      projectCwd: tmpDir,
      provider: 'claude-sdk',
      model: 'top-level-model',
      autoRouting,
      onProviderStream: (context, event) => providerLogger.logEvent(context, event),
      onDelegatedAgentUsage: (context, result) => usageLogger.logUsageFor(context, {
        success: result.success,
        usage: result.usage ?? {
          usageMissing: true,
          reason: USAGE_MISSING_REASONS.NOT_AVAILABLE,
        },
      }),
    });
    const routingDecision = vi.fn();
    engine.on('routing:decision', routingDecision);

    const responses = [
      makeResponse({
        persona: 'team-leader',
        structuredOutput: {
          parts: [
            { id: 'part-1', title: 'API', instruction: 'Implement API' },
          ],
        },
      }),
      makeResponse({
        persona: 'coder',
        content: 'API done',
        providerUsage: {
          inputTokens: 13,
          outputTokens: 8,
          totalTokens: 21,
          usageMissing: false,
        },
      }),
      makeResponse({
        persona: 'team-leader',
        structuredOutput: { done: true, reasoning: 'enough', parts: [] },
      }),
    ];
    let responseIndex = 0;
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: instruction,
      });
      options?.onStream?.({
        type: 'init',
        data: {
          model: options.resolvedModel ?? '(default)',
          sessionId: `team-session-${responseIndex}`,
        },
      });
      const response = responses[responseIndex];
      responseIndex += 1;
      if (!response) {
        throw new Error('Unexpected team leader agent call');
      }
      return response;
    });
    vi.mocked(detectMatchedRule).mockResolvedValueOnce({ index: 0, method: 'phase1_tag' });

    const state = await engine.run();
    const routingEvents = routingDecision.mock.calls;

    expect(state.status).toBe('completed');
    expect(routingEvents.map((event) => (event[0] as { name: string }).name)).toEqual([
      'implement',
      'implement.part-1',
    ]);
    expect(routingEvents[0]?.[3]).toMatchObject({
      provider: 'mock',
      model: 'mock-1',
      providerSource: 'auto.rules',
      autoRoutingDecision: {
        candidateName: 'leader',
      },
    });
    expect(routingEvents[1]?.[3]).toMatchObject({
      provider: 'codex',
      model: 'gpt-5',
      providerSource: 'auto.rules',
      autoRoutingDecision: {
        candidateName: 'coding',
      },
    });
    expect(vi.mocked(runAgent).mock.calls[0]?.[2]).toMatchObject({
      resolvedProvider: 'mock',
      resolvedModel: 'mock-1',
    });

    const providerRecords = readFileSync(providerLogger.filepath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as ProviderEventLogRecord);
    expect(providerRecords.filter((record) => record.step === 'implement')).toHaveLength(2);
    expect(providerRecords.filter((record) => record.step === 'implement')).toEqual([
      expect.objectContaining({ provider: 'mock' }),
      expect.objectContaining({ provider: 'mock' }),
    ]);
    expect(providerRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({ step: 'implement.part-1', provider: 'codex' }),
    ]));
    expect(providerRecords).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'claude-sdk' }),
    ]));

    const usageRecords = readFileSync(usageLogger.filepath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as UsageEventLogRecord);
    expect(usageRecords.filter((record) => record.step === 'implement')).toEqual([
      expect.objectContaining({ provider: 'mock', provider_model: 'mock-1', usage_missing: true }),
      expect.objectContaining({ provider: 'mock', provider_model: 'mock-1', usage_missing: true }),
    ]);
    expect(usageRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({
        step: 'implement.part-1',
        step_type: 'team_leader',
        provider: 'codex',
        provider_model: 'gpt-5',
        usage: expect.objectContaining({ total_tokens: 21 }),
      }),
    ]));
  });

  it('長大な動的part IDを実AI batch routerでroutingし安全なJSONLを記録する', async () => {
    const debugLogSpy = vi.spyOn(DebugLogger.getInstance(), 'writeLog');
    const config = buildTeamLeaderConfig();
    const step = config.steps[0];
    if (!step?.teamLeader) {
      throw new Error('teamLeader configuration is required');
    }
    step.teamLeader.providerRoutingPersonaKey = 'team-leader';
    const secret = 'Authorization: Bearer TOP_SECRET_VALUE';
    const metadataSecret = 'UNIQUE_TEAM_LEADER_METADATA_SECRET';
    const credentialUrl = `https://${'a'.repeat(980)}:${metadataSecret}@example.com`;
    const longPartId = `part-${secret}-${'x'.repeat(520)}`;
    const shortPartId = 'part-short';
    const autoRouting: AutoRoutingConfig = {
      strategy: 'balanced',
      router: {
        provider: 'claude-sdk',
        model: 'claude-haiku-4-5-20251001',
      },
      candidates: [
        {
          name: 'leader',
          description: 'Team leader planning',
          provider: 'mock',
          model: 'mock-1',
          costTier: 'medium',
        },
        {
          name: 'coding',
          description: 'Implementation and tests',
          provider: 'codex',
          model: 'gpt-5',
          costTier: 'medium',
        },
      ],
      rules: {
        personas: {
          'team-leader': 'leader',
        },
      },
    };
    const logsDir = join(tmpDir, '.takt', 'runs', 'test-report-dir', 'logs');
    const debugLogPath = join(logsDir, 'team-leader-debug.log');
    DebugLogger.getInstance().init({ enabled: true, logFile: debugLogPath }, tmpDir);
    const providerLogger = createProviderEventLogger({
      logsDir,
      sessionId: 'team-long-id-routing',
      runId: 'team-long-id-routing-run',
      enabled: true,
    });
    const usageLogger = createUsageEventLogger({
      logsDir,
      sessionId: 'team-long-id-routing',
      runId: 'team-long-id-routing-run',
      enabled: true,
    } satisfies UsageEventLoggerConfig);
    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', {
      projectCwd: tmpDir,
      provider: 'claude-sdk',
      model: 'top-level-model',
      autoRouting,
      onProviderStream: (context, event) => providerLogger.logEvent(context, event),
      onDelegatedAgentUsage: (context, result) => usageLogger.logUsageFor(context, {
        success: result.success,
        usage: result.usage ?? {
          usageMissing: true,
          reason: USAGE_MISSING_REASONS.NOT_AVAILABLE,
        },
      }),
    });
    const routingDecision = vi.fn();
    engine.on('routing:decision', routingDecision);
    const nextLeaderResponse = vi.fn()
      .mockReturnValueOnce(makeResponse({
        persona: 'team-leader',
        structuredOutput: {
          parts: [
            { id: longPartId, title: credentialUrl, instruction: 'Implement API' },
            { id: shortPartId, title: 'Short ID part', instruction: 'Add tests' },
          ],
        },
      }))
      .mockReturnValueOnce(makeResponse({
        persona: 'team-leader',
        structuredOutput: { done: true, reasoning: credentialUrl, parts: [] },
      }));

    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: instruction,
      });
      if (options?.resolvedProvider === 'claude-sdk') {
        options.onStream?.({ type: 'text', data: { text: 'routing' } });
        const selections = [
          { id: longPartId, selected_candidate: 'coding' },
          { id: shortPartId, selected_candidate: 'coding' },
        ];
        return makeResponse({
          persona: 'auto-router',
          content: JSON.stringify({ selections }),
          structuredOutput: { selections },
        });
      }
      if (options?.resolvedProvider === 'mock') {
        return nextLeaderResponse();
      }
      if (options?.resolvedProvider === 'codex') {
        options.onStream?.({ type: 'text', data: { text: 'part execution' } });
        return makeResponse({
          persona: 'coder',
          content: 'part done',
          providerUsage: {
            inputTokens: 13,
            outputTokens: 8,
            totalTokens: 21,
            usageMissing: false,
          },
        });
      }
      throw new Error(`Unexpected provider: ${options?.resolvedProvider ?? '(missing)'}`);
    });
    vi.mocked(detectMatchedRule).mockResolvedValueOnce({ index: 0, method: 'phase1_tag' });

    const state = await engine.run();
    const routingEvents = routingDecision.mock.calls;

    expect(state.status).toBe('completed');
    expect(nextLeaderResponse).toHaveBeenCalledTimes(2);
    const partRoutingEvents = routingEvents.filter((event) => {
      const name = (event[0] as { name?: string }).name;
      return name === `implement.${longPartId}` || name === `implement.${shortPartId}`;
    });
    expect(partRoutingEvents).toHaveLength(2);
    expect(partRoutingEvents.every((event) => (
      (event[3] as { providerSource?: string }).providerSource === 'auto.ai'
    ))).toBe(true);
    expect(routingEvents.some((event) => (
      (event[3] as { providerSource?: string }).providerSource === 'auto.default'
    ))).toBe(false);
    expect(debugLogSpy.mock.calls.some(([level, component, message]) => (
      level === 'WARN'
      && component === 'team-leader-runner'
      && message === 'Auto routing AI router failed; falling back to strategy default'
    ))).toBe(false);

    const providerLog = readFileSync(providerLogger.filepath, 'utf-8').trim();
    const providerRecords = providerLog
      .split('\n')
      .map((line) => JSON.parse(line) as ProviderEventLogRecord);
    expect(providerRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({
        step: 'auto-router',
      }),
      expect.objectContaining({
        provider: 'codex',
        provider_model: 'gpt-5',
      }),
    ]));
    const longPartProvider = providerRecords.find((record) => record.step.includes('[REDACTED]'));
    expect(longPartProvider?.step.length).toBeLessThanOrEqual(1_000);
    expect(longPartProvider?.step).toContain('[REDACTED]');
    expect(providerRecords.every((record) => !('step_digest' in record))).toBe(true);
    expect(providerLog).not.toContain(secret);
    expect(providerLog).not.toContain(longPartId);

    const usageLog = readFileSync(usageLogger.filepath, 'utf-8').trim();
    const usageRecords = usageLog
      .split('\n')
      .map((line) => JSON.parse(line) as UsageEventLogRecord);
    const longPartUsage = usageRecords.find((record) => record.step.includes('[REDACTED]'));
    expect(longPartUsage).toMatchObject({
      step_type: 'team_leader',
      provider: 'codex',
      provider_model: 'gpt-5',
    });
    expect(usageRecords.every((record) => !('step_digest' in record))).toBe(true);
    expect(longPartUsage?.step.length).toBeLessThanOrEqual(1_000);
    expect(usageLog).not.toContain(secret);
    expect(usageLog).not.toContain(longPartId);

    const debugLog = readFileSync(debugLogPath, 'utf-8');
    expect(debugLog).toContain('[REDACTED]');
    expect(debugLog).not.toContain('TOP_SECRET_VALUE');
    expect(debugLog).not.toContain(metadataSecret);
    expect(debugLog).not.toContain(longPartId);
    expect(debugLog.length).toBeLessThan(50_000);
  });

  it('team leader の AI routing には raw instruction だけを渡し worker part instruction は渡さない', async () => {
    const config = buildTeamLeaderConfig();
    const autoRouting: AutoRoutingConfig = {
      ...createAutoRoutingConfig(),
      rules: undefined,
    };
    const routeStep = vi.fn().mockResolvedValue(autoRouting.candidates[0]);
    const routeBatch = vi.fn(async (_autoRouting: AutoRoutingConfig, steps: Array<{ id: string; instruction?: string }>) =>
      new Map(steps.map((step) => [step.id, autoRouting.candidates[0]])));
    const engine = new WorkflowEngine(config, tmpDir, 'SECRET_TASK_SHOULD_NOT_REACH_ROUTER', {
      projectCwd: tmpDir,
      provider: 'mock',
      autoRouting,
      autoRoutingAiRouter: {
        routeStep,
        routeBatch,
      },
    });

    mockRunAgentWithPrompt(
      makeResponse({
        persona: 'team-leader',
        structuredOutput: {
          parts: [
            { id: 'part-1', title: 'API', instruction: 'Implement SECRET_TASK_SHOULD_NOT_REACH_ROUTER API' },
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
    const routedStep = routeStep.mock.calls[0]?.[1];
    const routedParts = routeBatch.mock.calls[0]?.[1];

    expect(state.status).toBe('completed');
    expect(routedStep).toMatchObject({
      name: 'implement',
      instruction: 'Task: {task}',
    });
    expect(routedStep?.instruction).not.toContain('SECRET_TASK_SHOULD_NOT_REACH_ROUTER');
    expect(routedStep?.instruction).not.toContain('Previous Response');
    expect(routedStep?.instruction).not.toContain('Report Directory');
    expect(routedParts).toEqual([
      expect.objectContaining({
        id: 'part-1',
        name: 'implement.part-1',
      }),
    ]);
    expect(routedParts?.[0]?.instruction).toBeUndefined();
    expect(JSON.stringify(routedParts)).not.toContain('SECRET_TASK_SHOULD_NOT_REACH_ROUTER');
  });

  it('team leader worker の auto routing provider が part model と非互換なら worker 実行前に失敗する', async () => {
    const config = buildTeamLeaderConfig();
    const step = config.steps[0];
    if (!step?.teamLeader) {
      throw new Error('teamLeader configuration is required');
    }
    step.teamLeader.partPersona = 'coder';
    step.teamLeader.partTags = ['implementation'];
    const autoRouting: AutoRoutingConfig = {
      strategy: 'balanced',
      router: {
        provider: 'claude-sdk',
        model: 'claude-haiku-4-5-20251001',
      },
      candidates: [
        {
          name: 'leader',
          description: 'Team leader planning',
          provider: 'mock',
          model: 'leader-model',
          costTier: 'medium',
        },
        {
          name: 'coding',
          description: 'Implementation and tests',
          provider: 'codex',
          model: 'sonnet',
          costTier: 'medium',
        },
      ],
      rules: {
        tags: {
          implementation: 'coding',
        },
        steps: {
          implement: 'leader',
        },
      },
    };
    const workflowAborted = vi.fn();
    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', {
      projectCwd: tmpDir,
      provider: 'mock',
      autoRouting,
    });
    engine.on('workflow:abort', workflowAborted);

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

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(workflowAborted.mock.calls[0]?.[1]).toBe(
      "Step execution failed: Configuration error: auto_routing resolved model 'sonnet' is a Claude model alias but provider is 'codex'. " +
      'Either choose a Claude provider or specify a codex-compatible model.',
    );
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(1);
  });

  it('team leader が feedback で追加した part に auto routing を適用する', async () => {
    const config = buildTeamLeaderConfig();
    const step = config.steps[0];
    if (!step?.teamLeader) {
      throw new Error('teamLeader configuration is required');
    }
    step.tags = ['implementation'];
    step.teamLeader.maxConcurrency = 1;
    step.teamLeader.partTags = ['implementation'];
    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', {
      projectCwd: tmpDir,
      provider: 'mock',
      autoRouting: createAutoRoutingConfig(),
    });
    const routingDecision = vi.fn();
    engine.on('routing:decision', routingDecision);

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
        structuredOutput: {
          done: false,
          reasoning: 'add test part',
          parts: [
            { id: 'part-2', title: 'Tests', instruction: 'Add tests' },
          ],
        },
      }),
      makeResponse({ persona: 'coder', content: 'Tests done' }),
      makeResponse({
        persona: 'team-leader',
        structuredOutput: { done: true, reasoning: 'enough', parts: [] },
      }),
    );
    vi.mocked(detectMatchedRule).mockResolvedValueOnce({ index: 0, method: 'phase1_tag' });

    const state = await engine.run();
    const routingEvents = routingDecision.mock.calls;

    expect(state.status).toBe('completed');
    expect(routingEvents).toHaveLength(3);
    expect(routingEvents.map((event) => (event[0] as { name: string }).name)).toEqual([
      'implement',
      'implement.part-1',
      'implement.part-2',
    ]);
    expect(vi.mocked(runAgent).mock.calls[3]?.[2]).toMatchObject({
      resolvedProvider: 'codex',
      resolvedModel: 'gpt-5',
    });
  });

  it('passes childProcessEnv to team leader decomposition and feedback calls', async () => {
    const config = buildTeamLeaderConfig();
    const childProcessEnv = { TAKT_OBSERVABILITY: '{"enabled":true}' };
    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', {
      projectCwd: tmpDir,
      provider: 'claude',
      childProcessEnv,
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

    await engine.run();

    expect(vi.mocked(runAgent).mock.calls[0]?.[2]).toEqual(expect.objectContaining({ childProcessEnv }));
    expect(vi.mocked(runAgent).mock.calls[2]?.[2]).toEqual(expect.objectContaining({ childProcessEnv }));
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

  it('team leader call が reject した場合も失敗 usage を1件だけ記録する', async () => {
    const config = buildTeamLeaderConfig();
    const step = config.steps[0];
    if (!step?.teamLeader) {
      throw new Error('teamLeader configuration is required');
    }
    step.teamLeader.providerRoutingPersonaKey = 'team-leader';
    step.teamLeader.partTags = ['implementation'];
    const autoRouting = createTeamLeaderAutoRoutingConfig();
    const logsDir = join(tmpDir, '.takt', 'runs', 'test-report-dir', 'logs');
    const usageLogger = createUsageEventLogger({
      logsDir,
      sessionId: 'team-leader-rejection',
      runId: 'team-leader-rejection-run',
      enabled: true,
    } satisfies UsageEventLoggerConfig);
    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', {
      projectCwd: tmpDir,
      provider: 'claude-sdk',
      model: 'top-level-model',
      autoRouting,
      onDelegatedAgentUsage: (context, result) => usageLogger.logUsageFor(context, {
        success: result.success,
        usage: result.usage ?? {
          usageMissing: true,
          reason: USAGE_MISSING_REASONS.NOT_AVAILABLE,
        },
      }),
    });
    vi.mocked(runAgent).mockRejectedValueOnce(new Error('leader provider rejected'));

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    const usageRecords = readFileSync(usageLogger.filepath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as UsageEventLogRecord);
    expect(vi.mocked(runAgent)).toHaveBeenCalledOnce();
    expect(usageRecords).toEqual([
      expect.objectContaining({
        step: 'implement',
        step_type: 'team_leader',
        provider: 'codex',
        provider_model: 'gpt-5',
        success: false,
      }),
    ]);
  });

  it('prompt-based team leader の retry response と reject を全attempt分記録する', async () => {
    vi.useFakeTimers();
    try {
      const config = buildTeamLeaderConfig();
      const step = config.steps[0];
      if (!step?.teamLeader) {
        throw new Error('teamLeader configuration is required');
      }
      step.teamLeader.maxConcurrency = 1;
      const logsDir = join(tmpDir, '.takt', 'runs', 'test-report-dir', 'logs');
      const usageLogger = createUsageEventLogger({
        logsDir,
        sessionId: 'team-leader-retries',
        runId: 'team-leader-retries-run',
        enabled: true,
      } satisfies UsageEventLoggerConfig);
      const engine = new WorkflowEngine(config, tmpDir, 'implement feature', {
        projectCwd: tmpDir,
        provider: 'cursor',
        onDelegatedAgentUsage: (context, result) => usageLogger.logUsageFor(context, {
          success: result.success,
          usage: result.usage ?? {
            usageMissing: true,
            reason: USAGE_MISSING_REASONS.NOT_AVAILABLE,
          },
        }),
      });
      vi.mocked(runAgent)
        .mockImplementationOnce(async (persona, instruction, options) => {
          options?.onPromptResolved?.({
            systemPrompt: typeof persona === 'string' ? persona : '',
            userInstruction: instruction,
          });
          return makeResponse({ persona: 'team-leader', status: 'error', error: 'first failed' });
        })
        .mockRejectedValueOnce(new Error('second rejected'))
        .mockImplementationOnce(async (persona, instruction, options) => {
          options?.onPromptResolved?.({
            systemPrompt: typeof persona === 'string' ? persona : '',
            userInstruction: instruction,
          });
          return makeResponse({
            persona: 'team-leader',
            content: [
              '```json',
              JSON.stringify([{ id: 'part-1', title: 'API', instruction: 'Implement API' }]),
              '```',
            ].join('\n'),
          });
        })
        .mockResolvedValueOnce(makeResponse({ persona: 'coder', content: 'API done' }))
        .mockResolvedValueOnce(makeResponse({
          persona: 'team-leader',
          status: 'error',
          error: 'feedback first failed',
        }))
        .mockRejectedValueOnce(new Error('feedback second rejected'))
        .mockResolvedValueOnce(makeResponse({
          persona: 'team-leader',
          content: [
            '```json',
            JSON.stringify({ done: true, reasoning: 'enough', parts: [] }),
            '```',
          ].join('\n'),
        }));
      vi.mocked(detectMatchedRule).mockResolvedValueOnce({ index: 0, method: 'phase1_tag' });

      const runPromise = engine.run();
      await vi.advanceTimersByTimeAsync(4_000);
      const state = await runPromise;
      const usageRecords = readFileSync(usageLogger.filepath, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as UsageEventLogRecord);
      const leaderRecords = usageRecords.filter((record) => record.step === 'implement');

      expect(state.status).toBe('completed');
      expect(usageRecords).toHaveLength(vi.mocked(runAgent).mock.calls.length);
      expect(leaderRecords.map((record) => record.success)).toEqual([
        false,
        false,
        true,
        false,
        false,
        true,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('実際の part timeout でも失敗 usage を呼び出しごとに1件記録し親aggregateを記録しない', async () => {
    const config = buildTeamLeaderConfig();
    const step = config.steps[0];
    if (!step?.teamLeader) {
      throw new Error('teamLeader configuration is required');
    }
    step.teamLeader.providerRoutingPersonaKey = 'team-leader';
    step.teamLeader.partTags = ['implementation'];
    step.teamLeader.timeoutMs = 5;
    step.teamLeader.maxTotalParts = 2;
    const autoRouting = createTeamLeaderAutoRoutingConfig();
    const logsDir = join(tmpDir, '.takt', 'runs', 'test-report-dir', 'logs');
    const usageLogger = createUsageEventLogger({
      logsDir,
      sessionId: 'team-leader-abort',
      runId: 'team-leader-abort-run',
      enabled: true,
    } satisfies UsageEventLoggerConfig);
    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', {
      projectCwd: tmpDir,
      provider: 'claude-sdk',
      model: 'top-level-model',
      autoRouting,
      onDelegatedAgentUsage: (context, result) => usageLogger.logUsageFor(context, {
        success: result.success,
        usage: result.usage ?? {
          usageMissing: true,
          reason: USAGE_MISSING_REASONS.NOT_AVAILABLE,
        },
      }),
    });
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
    );
    mockRunAgentRejectingOnAbort();
    mockRunAgentRejectingOnAbort();

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    const expectedError =
      'All team leader parts failed: part-1: part timeout: Part timeout after 5ms; part-2: part timeout: Part timeout after 5ms';

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

    const usageRecords = readFileSync(usageLogger.filepath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as UsageEventLogRecord);
    const leaderRecords = usageRecords.filter((record) => record.step === 'implement');
    const partRecords = usageRecords.filter((record) => record.step.startsWith('implement.part-'));
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(3);
    expect(usageRecords).toHaveLength(vi.mocked(runAgent).mock.calls.length);
    expect(leaderRecords).toHaveLength(1);
    expect(leaderRecords.every((record) => (
      record.provider === 'codex'
      && record.provider_model === 'gpt-5'
      && record.success
    ))).toBe(true);
    expect(partRecords).toHaveLength(2);
    expect(partRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({
        step: 'implement.part-1',
        step_type: 'team_leader',
        provider: 'codex',
        provider_model: 'gpt-5',
        success: false,
      }),
      expect.objectContaining({
        step: 'implement.part-2',
        step_type: 'team_leader',
        provider: 'codex',
        provider_model: 'gpt-5',
        success: false,
      }),
    ]));
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

  it('実際の親 AbortSignal でも part の失敗 usage を1件だけ記録する', async () => {
    const config = buildTeamLeaderConfig();
    const step = config.steps[0];
    if (!step?.teamLeader) {
      throw new Error('teamLeader configuration is required');
    }
    step.teamLeader.providerRoutingPersonaKey = 'team-leader';
    step.teamLeader.partTags = ['implementation'];
    step.teamLeader.maxTotalParts = 1;
    const abortController = new AbortController();
    const autoRouting = createTeamLeaderAutoRoutingConfig();
    const logsDir = join(tmpDir, '.takt', 'runs', 'test-report-dir', 'logs');
    const usageLogger = createUsageEventLogger({
      logsDir,
      sessionId: 'team-leader-external-abort',
      runId: 'team-leader-external-abort-run',
      enabled: true,
    } satisfies UsageEventLoggerConfig);
    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', {
      projectCwd: tmpDir,
      provider: 'claude-sdk',
      model: 'top-level-model',
      autoRouting,
      abortSignal: abortController.signal,
      onDelegatedAgentUsage: (context, result) => usageLogger.logUsageFor(context, {
        success: result.success,
        usage: result.usage ?? {
          usageMissing: true,
          reason: USAGE_MISSING_REASONS.NOT_AVAILABLE,
        },
      }),
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
    );
    mockRunAgentRejectingOnAbort(() => abortController.abort());

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

    const usageRecords = readFileSync(usageLogger.filepath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as UsageEventLogRecord);
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(2);
    expect(usageRecords).toHaveLength(2);
    expect(usageRecords.filter((record) => record.step === 'implement')).toEqual([
      expect.objectContaining({
        provider: 'codex',
        provider_model: 'gpt-5',
        success: true,
      }),
    ]);
    expect(usageRecords.filter((record) => record.step === 'implement.part-1')).toEqual([
      expect.objectContaining({
        step_type: 'team_leader',
        provider: 'codex',
        provider_model: 'gpt-5',
        success: false,
      }),
    ]);
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

  it('Claude part では part_edit false の part_allowed_tools から編集系ツールを除去する', async () => {
    const config = buildTeamLeaderConfig();
    const step = config.steps[0];
    if (!step?.teamLeader) {
      throw new Error('teamLeader configuration is required');
    }
    step.teamLeader.partAllowedTools = ['Read', 'Bash', 'Edit', 'Write', 'Grep'];
    step.teamLeader.partEdit = false;
    step.teamLeader.partPermissionMode = 'readonly';

    const engine = new WorkflowEngine(config, tmpDir, 'review feature', {
      projectCwd: tmpDir,
      provider: 'claude',
    });

    mockRunAgentWithPrompt(
      makeResponse({
        persona: 'team-leader',
        structuredOutput: {
          parts: [
            { id: 'part-1', title: 'Review', instruction: 'Review implementation' },
          ],
        },
      }),
      makeResponse({ persona: 'coder', content: 'Review done' }),
      makeResponse({
        persona: 'team-leader',
        structuredOutput: { done: true, reasoning: 'enough', parts: [] },
      }),
    );

    vi.mocked(detectMatchedRule).mockResolvedValueOnce({ index: 0, method: 'phase1_tag' });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    const partCall = vi.mocked(runAgent).mock.calls.find(([persona, , options]) => (
      persona === '../personas/coder.md' && options?.resolvedProvider === 'claude'
    ));
    expect(partCall).toBeDefined();
    expect(partCall?.[2]?.allowedTools).toEqual(['Read', 'Grep']);
  });

  it('OpenCode part では part_edit false の part_allowed_tools から編集系ツールを除去するが bash は残す', async () => {
    const config = buildTeamLeaderConfig();
    const step = config.steps[0];
    if (!step?.teamLeader) {
      throw new Error('teamLeader configuration is required');
    }
    step.teamLeader.partPersona = 'coder';
    step.teamLeader.partAllowedTools = ['read', 'bash', 'edit', 'write', 'grep'];
    step.teamLeader.partEdit = false;
    step.teamLeader.partPermissionMode = 'readonly';

    const engine = new WorkflowEngine(config, tmpDir, 'review feature', {
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
            { id: 'part-1', title: 'Review', instruction: 'Review implementation' },
          ],
        },
      }),
      makeResponse({ persona: 'coder', content: 'Review done' }),
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
    expect(partCall?.[2]?.allowedTools).toEqual(['read', 'bash', 'grep']);
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
    const phaseStarted = vi.fn();
    engine.on('phase:start', phaseStarted);

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
    const phaseStarts = phaseStarted.mock.calls
      .filter(([step, phase, phaseName]) => (
        step.name === 'implement' && phase === 1 && phaseName === 'execute'
      ))
      .map(([, , , instruction]) => instruction);

    expect(state.status).toBe('completed');
    expect(phaseStarts.length).toBeGreaterThan(0);
    expect(phaseStarts[0]).toContain('This is decomposition-only planning. Do not execute the task.');
  });

});
