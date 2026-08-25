import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAgent } from '../agents/runner.js';
import { mockRuleEvaluation } from './rule-evaluator-test-double.js';
import { WorkflowEngine } from '../core/workflow/engine/WorkflowEngine.js';
import { makeStep, makeRule, makeResponse, createTestTmpDir, applyDefaultMocks } from './engine-test-helpers.js';
import { runReportPhase, runStatusJudgmentPhase } from '../core/workflow/phase-runner.js';
import type { StructuredCaller } from '../agents/structured-caller.js';
import type {
  AgentResponse,
  CompanionFinding,
  TeamLeaderWorkflowStep,
  WorkflowConfig,
} from '../core/models/index.js';
import type { CompanionDiff } from '../core/workflow/companion/diff-reader.js';
import type { AutoRoutingConfig } from '../core/models/config-types.js';
import { initNdjsonLog } from '../infra/fs/session.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import { SessionLogger } from '../features/tasks/execute/sessionLogger.js';
import { renderTraceReportFromLogs } from '../features/tasks/execute/traceReport.js';
import { createProviderEventLogger } from '../core/logging/providerEventLogger.js';
import { createUsageEventLogger, type UsageEventLoggerConfig } from '../core/logging/usageEventLogger.js';
import { USAGE_MISSING_REASONS } from '../core/logging/contracts.js';
import type { ProviderEventLogRecord } from '../core/logging/providerEvent.js';
import type { UsageEventLogRecord } from '../core/logging/usageEvent.js';
import { DebugLogger } from '../shared/utils/debug.js';
import { MAX_AGENT_FAILURE_MESSAGE_BYTES } from '../shared/types/agent-failure.js';
import { COMPANION_CHANGE_DEBOUNCE_MS } from '../core/workflow/companion/change-detector.js';
import { buildCompanionMailboxPath } from '../core/workflow/companion/mailbox.js';

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

function updateTeamLeaderStep(
  config: WorkflowConfig,
  update: (step: TeamLeaderWorkflowStep) => TeamLeaderWorkflowStep,
): void {
  const step = config.steps[0];
  if (step === undefined || step.teamLeader === undefined) {
    throw new Error('teamLeader configuration is required');
  }
  config.steps[0] = update(step);
}

function buildDynamicFacetTeamLeaderConfig(): WorkflowConfig {
  const config = buildTeamLeaderConfig();
  updateTeamLeaderStep(config, (step) => ({
    ...step,
    policyContents: [{ content: 'BASE TEAM POLICY' }],
    knowledgeContents: [{ content: 'BASE TEAM KNOWLEDGE' }],
    dynamicFacets: { pool: 'team-facets', maxSelected: 1 },
  }));
  config.facetPools = {
    'team-facets': {
      name: 'team-facets',
      source: 'inline',
      candidates: [{
        id: 'selected',
        description: 'Selected Team Leader facet',
        policyRefs: ['selected-policy'],
        knowledgeRefs: ['selected-knowledge'],
        resolvedPolicyContents: [{ content: 'SELECTED TEAM POLICY' }],
        resolvedKnowledgeContents: [{ content: 'SELECTED TEAM KNOWLEDGE' }],
      }],
    },
  };
  return config;
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
        routingTier: 'medium',
      },
    ],
    defaultPool: 'general',
    candidatePools: {
      general: { candidates: ['coding'], fallback: 'coding' },
    },
    poolRules: {
      tags: { implementation: 'general' },
      personas: { 'team-leader': 'general' },
      steps: { implement: 'general' },
    },
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

function createBoundedParseFailure(fullTextPath: string): string {
  const prefix = 'provider stream parse error: Failed to parse item: ';
  const truncationMarker = `[TRUNCATED: 428000 bytes, full text: ${fullTextPath}]`;
  return [
    prefix,
    'x'.repeat(
      MAX_AGENT_FAILURE_MESSAGE_BYTES
      - Buffer.byteLength(prefix)
      - Buffer.byteLength(truncationMarker),
    ),
    truncationMarker,
  ].join('');
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

    vi.mocked(mockRuleEvaluation).mockReturnValueOnce({ index: 0, method: 'phase3_tag' });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(4);
    const output = state.stepOutputs.get('implement');
    expect(output).toBeDefined();
    expect(output!.content).toContain('API done');
    expect(output!.content).toContain('Tests done');
  });

  it('Team Leader は dynamic facet を一度だけ選択し、親と全 worker part に同じ内容を渡す', async () => {
    const config = buildDynamicFacetTeamLeaderConfig();
    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', {
      projectCwd: tmpDir,
      provider: 'mock',
      selectorProvider: { provider: 'mock', model: 'mock-model' },
      selectorGitCommandRunner: { isInsideWorkTree: async () => false, run: async () => ({ output: Buffer.from(''), bytes: 0 }) },
    });

    mockRunAgentWithPrompt(
      makeResponse({
        persona: 'selector',
        structuredOutput: { selected_ids: ['selected'], rationale: 'The selected facet applies.' },
      }),
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
    vi.mocked(mockRuleEvaluation).mockReturnValueOnce({ index: 0, method: 'phase3_tag' });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(5);
    const executionInstructions = vi.mocked(runAgent).mock.calls
      .slice(1)
      .map(([, instruction]) => instruction);
    expect(executionInstructions).toHaveLength(4);
    for (const instruction of executionInstructions) {
      expect(instruction).toContain('SELECTED TEAM POLICY');
      expect(instruction).toContain('SELECTED TEAM KNOWLEDGE');
    }
    expect([...state.dynamicFacetSelections.values()]).toEqual([
      expect.objectContaining({
        selected_ids: ['selected'],
        round: 1,
      }),
    ]);
  });

  it('同じ Team Leader step への再入では previous snapshot を使って dynamic facet の round を進める', async () => {
    const config = buildDynamicFacetTeamLeaderConfig();
    config.maxSteps = 2;
    config.steps[0]!.rules = [
      makeRule('repeat', 'implement'),
      makeRule('done', 'COMPLETE'),
    ];
    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', {
      projectCwd: tmpDir,
      provider: 'mock',
      selectorProvider: { provider: 'mock', model: 'mock-model' },
      selectorGitCommandRunner: { isInsideWorkTree: async () => false, run: async () => ({ output: Buffer.from(''), bytes: 0 }) },
    });

    mockRunAgentWithPrompt(
      makeResponse({ persona: 'selector', structuredOutput: { selected_ids: ['selected'], rationale: 'first' } }),
      makeResponse({ persona: 'team-leader', structuredOutput: { parts: [{ id: 'part-1', title: 'API', instruction: 'Implement API' }] } }),
      makeResponse({ persona: 'coder', content: 'first part done' }),
      makeResponse({ persona: 'team-leader', structuredOutput: { done: true, reasoning: 'repeat', parts: [] } }),
      makeResponse({ persona: 'selector', structuredOutput: { selected_ids: ['selected'], rationale: 'second' } }),
      makeResponse({ persona: 'team-leader', structuredOutput: { parts: [{ id: 'part-2', title: 'Test', instruction: 'Add tests' }] } }),
      makeResponse({ persona: 'coder', content: 'second part done' }),
      makeResponse({ persona: 'team-leader', structuredOutput: { done: true, reasoning: 'complete', parts: [] } }),
    );
    vi.mocked(mockRuleEvaluation)
      .mockReturnValueOnce({ index: 0, method: 'phase3_tag' })
      .mockReturnValueOnce({ index: 1, method: 'phase3_tag' });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    const calls = vi.mocked(runAgent).mock.calls;
    expect(calls).toHaveLength(8);
    expect(calls[0]?.[1]).toContain('Entry type:\ninitial entry');
    expect(calls[0]?.[1]).not.toContain('Previous selection snapshot:');
    expect(calls[4]?.[1]).toContain('Entry type:\nre-entry');
    expect(calls[4]?.[1]).toContain('Previous selection snapshot:');
    expect(calls[4]?.[1]).toContain('round: 1');
    expect(calls[4]?.[1]).toContain('selected_ids:\n- selected');
    expect(calls[4]?.[1]).toContain('selected_policy_refs:\n- selected-policy');
    expect(calls[4]?.[1]).toContain('selected_knowledge_refs:\n- selected-knowledge');
    expect(calls[4]?.[1]).toContain('rationale:\nfirst');
    expect([...state.dynamicFacetSelections.values()]).toEqual([
      expect.objectContaining({
        selected_ids: ['selected'],
        round: 2,
      }),
    ]);
  });

  it('Team Leader は part ごとの完了レビューと Team 終端レビューを分離する', async () => {
    const config = buildTeamLeaderConfig();
    updateTeamLeaderStep(config, (step) => ({
      ...step,
      teamLeader: { ...step.teamLeader, maxConcurrency: 1 },
      companion: { fixed: ['reviewer'], pool: [] },
    }));
    config.companions = {
      reviewer: {
        name: 'reviewer',
        description: 'Review the complete Team Leader change',
        instruction: 'Review the complete change.',
        instructionRef: 'reviewer',
        intervalMs: 60_000,
      },
    };
    const expectedReviewRounds = [
      { step: 'implement.part-1', digest: 'part-1-initial-digest' },
      { step: 'implement.part-1', digest: 'part-1-fixed-digest' },
      { step: 'implement.part-2', digest: 'part-2-cumulative-digest' },
      { step: 'implement', digest: 'part-2-cumulative-digest' },
      { step: 'implement.part-3', digest: 'part-3-cumulative-digest' },
      { step: 'implement', digest: 'part-3-cumulative-digest' },
      { step: 'implement.part-4', digest: 'part-4-cumulative-digest' },
      { step: 'implement', digest: 'part-4-cumulative-digest' },
    ];
    const worktreeFile = join(tmpDir, 'src', 'a.ts');
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
    const digestByWorktreeContent = new Map([
      ['part-1-initial\n', 'part-1-initial-digest'],
      ['part-1-fixed\n', 'part-1-fixed-digest'],
      ['part-2-cumulative\n', 'part-2-cumulative-digest'],
      ['part-3-cumulative\n', 'part-3-cumulative-digest'],
      ['part-4-cumulative\n', 'part-4-cumulative-digest'],
    ]);
    const companionDiffReader = {
      readBaselineSha: vi.fn()
        .mockResolvedValueOnce('team-baseline')
        .mockResolvedValue('later-head'),
      readDiff: vi.fn().mockImplementation(async (cwd: string, baseline: string) => {
        expect(cwd).toBe(tmpDir);
        expect(baseline).toBe('team-baseline');
        const worktreeContent = readFileSync(join(cwd, 'src', 'a.ts'), 'utf-8');
        const digest = digestByWorktreeContent.get(worktreeContent);
        if (digest === undefined) {
          throw new Error(`Unexpected worktree content: ${worktreeContent}`);
        }
        return {
          status: 'ok' as const,
          snapshot: {
            digest,
            changedLines: 1,
            content: `+${worktreeContent}`,
            changedFiles: ['src/a.ts'],
            fileFingerprints: { 'src/a.ts': digest },
            hunkFingerprints: { 'src/a.ts:1-1': digest },
            omittedBytes: 0,
            truncated: false,
          },
        };
      }),
    };
    const logsDir = join(tmpDir, '.takt', 'runs', 'test-report-dir', 'logs');
    const usageLogger = createUsageEventLogger({
      logsDir,
      sessionId: 'team-companion',
      runId: 'team-companion-run',
      enabled: true,
    } satisfies UsageEventLoggerConfig);
    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', {
      projectCwd: tmpDir,
      provider: 'mock',
      companionEnabled: true,
      companionProviders: { reviewer: { provider: 'mock' } },
      companionDiffReader,
      onDelegatedAgentUsage: (context, result) => usageLogger.logUsageFor(context, {
        success: result.success,
        usage: result.usage ?? {
          usageMissing: true,
          reason: USAGE_MISSING_REASONS.NOT_AVAILABLE,
        },
      }),
    });
    const companionStarts = vi.fn();
    const companionRounds = vi.fn();
    const companionFindings = vi.fn();
    const companionFixRounds = vi.fn();
    const companionCompletes = vi.fn();
    engine.on('companion:start', companionStarts);
    engine.on('companion:review_round', companionRounds);
    engine.on('companion:finding', companionFindings);
    engine.on('companion:fix_round', companionFixRounds);
    engine.on('companion:complete', companionCompletes);

    const partOneFinding = {
      severity: 'must_fix' as const,
      file: 'src/a.ts',
      line: 1,
      finding: 'Remove the unsafe part assignment.',
    };
    const teamFinding = {
      severity: 'must_fix' as const,
      file: 'src/a.ts',
      line: 2,
      finding: 'Remove the unsafe Team assignment.',
    };
    const secondTeamFinding = {
      severity: 'must_fix' as const,
      file: 'src/a.ts',
      line: 3,
      finding: 'Remove the second unsafe Team assignment.',
    };
    let partOneFindingReturned = false;
    let teamFindingIndex = 0;
    let teamCorrectionCount = 0;
    const partOneSessionIds: Array<string | undefined> = [];
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      const personaName = typeof persona === 'string' ? persona : '';
      options?.onPromptResolved?.({ systemPrompt: personaName, userInstruction: instruction });
      if (personaName === 'reviewer') {
        const reviewsPartOne = instruction.includes(
          '"label":"step_name","value":"implement.part-1"',
        );
        const reviewsTeam = instruction.includes('"label":"step_name","value":"implement"');
        const finding = reviewsPartOne && !partOneFindingReturned
          ? partOneFinding
          : reviewsTeam && teamFindingIndex < 2
            ? [teamFinding, secondTeamFinding][teamFindingIndex]
            : undefined;
        if (finding === partOneFinding) partOneFindingReturned = true;
        if (reviewsTeam && finding !== undefined) teamFindingIndex += 1;
        return makeResponse({
          persona: 'reviewer',
          structuredOutput: {
            findings: finding === undefined ? [] : [finding],
            notes: null,
          },
        });
      }
      if (personaName.includes('team-leader')) {
        const required = options?.outputSchema?.required;
        if (!Array.isArray(required) || !required.includes('done')) {
          return makeResponse({
              persona: 'team-leader',
              structuredOutput: {
                parts: [
                  { id: 'part-1', title: 'API', instruction: 'Implement API' },
                  { id: 'part-2', title: 'Test', instruction: 'Add tests' },
                ],
              },
            });
        }
        if (instruction.includes('"label":"team_companion_findings"')) {
          teamCorrectionCount += 1;
          return makeResponse({
            persona: 'team-leader',
            structuredOutput: {
              done: false,
              reasoning: teamCorrectionCount === 1
                ? 'apply the Team finding'
                : 'apply the second Team finding',
              cancelPartIds: [],
              parts: [teamCorrectionCount === 1
                ? { id: 'part-3', title: 'Correction', instruction: 'Fix Team finding' }
                : { id: 'part-4', title: 'Second correction', instruction: 'Fix second Team finding' }],
            },
          });
        }
        return makeResponse({
          persona: 'team-leader',
          structuredOutput: { done: true, reasoning: 'enough', cancelPartIds: [], parts: [] },
        });
      }
      if (personaName.includes('coder')) {
        const worktreeContent = instruction.includes('New companion findings')
          ? 'part-1-fixed\n'
          : instruction.includes('Implement API')
            ? 'part-1-initial\n'
            : instruction.includes('Add tests')
              ? 'part-2-cumulative\n'
              : instruction.includes('Fix second Team finding')
                ? 'part-4-cumulative\n'
                : instruction.includes('Fix Team finding')
                  ? 'part-3-cumulative\n'
                  : undefined;
        if (worktreeContent === undefined) {
          throw new Error(`Unexpected coder instruction: ${instruction}`);
        }
        if (worktreeContent.startsWith('part-1-')) {
          partOneSessionIds.push(options?.sessionId);
        }
        writeFileSync(worktreeFile, worktreeContent);
        return makeResponse({
          persona: 'coder',
          content: instruction.includes('New companion findings')
            ? 'Companion finding fixed'
            : `${personaName} done`,
          sessionId: personaName,
          providerUsage: {
            inputTokens: 5,
            outputTokens: 3,
            totalTokens: 8,
            usageMissing: false,
          },
        });
      }
      throw new Error(`Unexpected mock persona: ${personaName}`);
    });
    vi.mocked(mockRuleEvaluation).mockReturnValueOnce({ index: 0, method: 'phase3_tag' });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(companionStarts).toHaveBeenCalledTimes(5);
    expect(companionStarts.mock.calls.map(([payload]) => payload.step)).toEqual(expect.arrayContaining([
      'implement.part-1',
      'implement.part-2',
      'implement.part-3',
      'implement.part-4',
      'implement',
    ]));
    expect(companionStarts.mock.calls.every(([payload]) => payload.companion === 'reviewer')).toBe(true);
    expect(companionRounds.mock.calls.map(([payload]) => ({
      step: payload.step,
      digest: payload.digest,
    }))).toEqual(expectedReviewRounds);
    expect(companionFindings.mock.calls.map(([payload]) => payload.step)).toEqual([
      'implement.part-1',
      'implement',
      'implement',
    ]);
    expect(companionFixRounds.mock.calls.map(([payload]) => payload.step)).toEqual([
      'implement.part-1',
      'implement',
      'implement',
    ]);
    expect(companionFixRounds.mock.calls.map(([payload]) => ({
      step: payload.step,
      sequence: payload.sequence,
    }))).toEqual([
      { step: 'implement.part-1', sequence: 2 },
      { step: 'implement', sequence: 2 },
      { step: 'implement', sequence: 3 },
    ]);
    expect(companionCompletes.mock.calls).toEqual(expect.arrayContaining([
      [expect.objectContaining({
        step: 'implement.part-1',
        completionSettled: true,
        completionFailure: false,
        followUpRounds: 1,
      })],
      [expect.objectContaining({
        step: 'implement.part-2',
        completionSettled: true,
        completionFailure: false,
        followUpRounds: 0,
      })],
      [expect.objectContaining({
        step: 'implement.part-3',
        completionSettled: true,
        completionFailure: false,
        followUpRounds: 0,
      })],
      [expect.objectContaining({
        step: 'implement.part-4',
        completionSettled: true,
        completionFailure: false,
        followUpRounds: 0,
      })],
      [expect.objectContaining({
        step: 'implement',
        completionSettled: true,
        completionFailure: false,
        followUpRounds: 2,
      })],
    ]));
    expect(vi.mocked(runAgent).mock.calls.filter(([persona]) => persona === 'reviewer')).toHaveLength(8);
    const teamLeaderInstructions = vi.mocked(runAgent).mock.calls
      .filter(([persona]) => persona?.includes('team-leader'))
      .map(([, instruction]) => instruction);
    expect(teamLeaderInstructions).toHaveLength(6);
    for (const instruction of teamLeaderInstructions) {
      expect(instruction).toContain('Inbox:');
      expect(instruction).toContain('/companion/implement');
    }
    expect(vi.mocked(runAgent).mock.calls.filter(([persona]) => persona?.includes('coder'))).toHaveLength(5);
    const partOneOutput = state.stepOutputs.get('implement.part-1');
    expect(partOneSessionIds).toEqual([undefined, partOneOutput?.sessionId]);
    expect(state.stepOutputs.get('implement.part-1')).toMatchObject({
      content: 'Companion finding fixed',
    });
    expect(state.stepOutputs.has('implement.part-3')).toBe(true);
    expect(state.stepOutputs.has('implement.part-4')).toBe(true);

    expect(companionDiffReader.readBaselineSha).toHaveBeenCalledOnce();
    expect(companionDiffReader.readDiff).toHaveBeenCalledTimes(expectedReviewRounds.length);
    expect(companionDiffReader.readDiff.mock.calls.every(([, baseline]) => (
      baseline === 'team-baseline'
    ))).toBe(true);

    const partMailboxPath = buildCompanionMailboxPath({
      cwd: tmpDir,
      runSlug: 'test-report-dir',
      runPathNamespace: [],
      stepName: 'implement.part-1',
      companionName: 'reviewer',
    });
    const teamMailboxPath = buildCompanionMailboxPath({
      cwd: tmpDir,
      runSlug: 'test-report-dir',
      runPathNamespace: [],
      stepName: 'implement',
      companionName: 'reviewer',
    });
    const partMailboxFindings = readFileSync(partMailboxPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as CompanionFinding);
    const teamMailboxFindings = readFileSync(teamMailboxPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as CompanionFinding);
    expect(partMailboxFindings).toEqual([{
      companion: 'reviewer',
      reviewedAt: expect.any(String),
      reviewedDigest: 'part-1-initial-digest',
      ...partOneFinding,
    }]);
    expect(teamMailboxFindings).toEqual([{
      companion: 'reviewer',
      reviewedAt: expect.any(String),
      reviewedDigest: 'part-2-cumulative-digest',
      ...teamFinding,
    }, {
      companion: 'reviewer',
      reviewedAt: expect.any(String),
      reviewedDigest: 'part-3-cumulative-digest',
      ...secondTeamFinding,
    }]);

    const usageRecords = readFileSync(usageLogger.filepath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as UsageEventLogRecord);
    const partUsageRecords = usageRecords.filter((record) => record.step.startsWith('implement.part-'));
    expect(partUsageRecords).toHaveLength(5);
    expect(partUsageRecords.map((record) => record.step)).toEqual([
      'implement.part-1',
      'implement.part-1',
      'implement.part-2',
      'implement.part-3',
      'implement.part-4',
    ]);
    expect(partUsageRecords.every((record) => record.step_type === 'team_leader')).toBe(true);
    expect(usageRecords.filter((record) => record.step === 'companion:reviewer')).toHaveLength(8);
  });

  it('Team selector が空でも part selector のレビューは Team 開始時の baseline を共有する', async () => {
    const config = buildTeamLeaderConfig();
    updateTeamLeaderStep(config, (step) => ({
      ...step,
      teamLeader: { ...step.teamLeader, maxConcurrency: 1 },
      companion: { fixed: [], pool: ['reviewer'] },
    }));
    config.companions = {
      reviewer: {
        name: 'reviewer',
        description: 'Review the complete Team Leader change',
        instruction: 'Review the complete change.',
        instructionRef: 'reviewer',
        intervalMs: 60_000,
      },
    };
    const callOrder: string[] = [];
    const worktreeFile = join(tmpDir, 'src', 'a.ts');
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
    const digestByWorktreeContent = new Map([
      ['part-1\n', 'part-1-digest'],
      ['part-2-cumulative\n', 'part-2-digest'],
    ]);
    const companionDiffReader = {
      readBaselineSha: vi.fn(async () => {
        callOrder.push('baseline');
        return 'team-start-baseline';
      }),
      readDiff: vi.fn(async (cwd: string, baseline: string) => {
        expect(cwd).toBe(tmpDir);
        expect(baseline).toBe('team-start-baseline');
        const worktreeContent = readFileSync(join(cwd, 'src', 'a.ts'), 'utf-8');
        const digest = digestByWorktreeContent.get(worktreeContent);
        if (digest === undefined) {
          throw new Error(`Unexpected worktree content: ${worktreeContent}`);
        }
        return {
          status: 'ok' as const,
          snapshot: {
            digest,
            changedLines: 1,
            content: `+${worktreeContent}`,
            changedFiles: ['src/a.ts'],
            fileFingerprints: { 'src/a.ts': digest },
            hunkFingerprints: { 'src/a.ts:1-1': digest },
            omittedBytes: 0,
            truncated: false,
          },
        };
      }),
    };
    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', {
      projectCwd: tmpDir,
      provider: 'mock',
      selectorProvider: { provider: 'mock', model: 'selector-model' },
      companionEnabled: true,
      companionProviders: { reviewer: { provider: 'mock', model: 'reviewer-model' } },
      companionDiffReader,
    });
    const selectedReviewSteps: string[] = [];
    let selectorCallCount = 0;
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      const personaName = typeof persona === 'string' ? persona : '';
      options?.onPromptResolved?.({ systemPrompt: personaName, userInstruction: instruction });
      if (personaName === 'companion-selector') {
        selectorCallCount += 1;
        callOrder.push(`selector:${selectorCallCount}`);
        return makeResponse({
          persona: 'companion-selector',
          structuredOutput: {
            selected_ids: selectorCallCount === 1 ? [] : ['reviewer'],
            rationale: selectorCallCount === 1 ? 'No Team reviewer applies.' : 'Review the part.',
          },
        });
      }
      if (personaName === 'reviewer') {
        const reviewedStep = instruction.includes('"label":"step_name","value":"implement.part-1"')
          ? 'implement.part-1'
          : instruction.includes('"label":"step_name","value":"implement.part-2"')
            ? 'implement.part-2'
            : 'unexpected';
        selectedReviewSteps.push(reviewedStep);
        return makeResponse({
          persona: 'reviewer',
          structuredOutput: { findings: [], notes: null },
        });
      }
      if (personaName.includes('team-leader')) {
        const required = options?.outputSchema?.required;
        return Array.isArray(required) && required.includes('done')
          ? makeResponse({
              persona: 'team-leader',
              structuredOutput: { done: true, reasoning: 'complete', cancelPartIds: [], parts: [] },
            })
          : makeResponse({
              persona: 'team-leader',
              structuredOutput: {
                parts: [
                  { id: 'part-1', title: 'First', instruction: 'Implement first part' },
                  { id: 'part-2', title: 'Second', instruction: 'Implement second part' },
                ],
              },
            });
      }
      if (personaName.includes('coder')) {
        writeFileSync(
          worktreeFile,
          instruction.includes('Implement first part') ? 'part-1\n' : 'part-2-cumulative\n',
        );
        return makeResponse({ persona: 'coder', content: `${personaName} complete` });
      }
      throw new Error(`Unexpected mock persona: ${personaName}`);
    });
    vi.mocked(mockRuleEvaluation).mockReturnValueOnce({ index: 0, method: 'phase3_tag' });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(callOrder[0]).toBe('baseline');
    expect(callOrder.indexOf('baseline')).toBeLessThan(callOrder.indexOf('selector:1'));
    expect(selectorCallCount).toBe(3);
    expect(selectedReviewSteps).toEqual(['implement.part-1', 'implement.part-2']);
    expect(companionDiffReader.readBaselineSha).toHaveBeenCalledOnce();
    expect(companionDiffReader.readDiff).toHaveBeenCalledTimes(2);
    expect(companionDiffReader.readDiff.mock.calls.every(([, baseline]) => (
      baseline === 'team-start-baseline'
    ))).toBe(true);
  });

  it('Team part の Companion follow-up 失敗を fail-soft で確定し初回応答を公開する', async () => {
    const config = buildTeamLeaderConfig();
    updateTeamLeaderStep(config, (step) => ({
      ...step,
      teamLeader: { ...step.teamLeader, maxConcurrency: 1 },
      companion: { fixed: ['reviewer'], pool: [] },
    }));
    config.companions = {
      reviewer: {
        name: 'reviewer',
        description: 'Review the complete Team Leader change',
        instruction: 'Review the complete change.',
        instructionRef: 'reviewer',
        intervalMs: 60_000,
      },
    };
    const companionDiffReader = {
      readBaselineSha: vi.fn().mockResolvedValue('baseline'),
      readDiff: vi.fn().mockResolvedValue({
        status: 'ok',
        snapshot: {
          digest: 'follow-up-failure-digest',
          changedLines: 1,
          content: '+change\n',
          changedFiles: ['src/a.ts'],
          fileFingerprints: { 'src/a.ts': 'file-1' },
          hunkFingerprints: { 'src/a.ts:1-1': 'hunk-1' },
          omittedBytes: 0,
          truncated: false,
        },
      }),
    };
    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', {
      projectCwd: tmpDir,
      provider: 'mock',
      companionEnabled: true,
      companionProviders: { reviewer: { provider: 'mock' } },
      companionDiffReader,
    });
    const companionCompletes = vi.fn();
    const companionRounds = vi.fn();
    const stepCompletes = vi.fn();
    const lifecycle: string[] = [];
    engine.on('companion:complete', (event) => {
      companionCompletes(event);
      if (event.step === 'implement.part-1' && event.completionFailure) {
        lifecycle.push('part-fail-soft');
      }
      if (event.step === 'implement') {
        lifecycle.push('team-complete');
      }
    });
    engine.on('companion:review_round', (event) => {
      companionRounds(event);
      if (event.step === 'implement') {
        lifecycle.push('team-review');
      }
    });
    engine.on('step:complete', (step, response, instruction, resumeStepName, workflowStack) => {
      stepCompletes(step, response, instruction, resumeStepName, workflowStack);
      if (step.name === 'implement') {
        lifecycle.push('parent-step-complete');
      }
    });

    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      const personaName = typeof persona === 'string' ? persona : '';
      options?.onPromptResolved?.({ systemPrompt: personaName, userInstruction: instruction });
      if (personaName === 'reviewer') {
        const reviewsPartOne = instruction.includes(
          '"label":"step_name","value":"implement.part-1"',
        );
        return makeResponse({
          persona: 'reviewer',
          structuredOutput: reviewsPartOne
            ? {
                findings: [{
                  severity: 'must_fix',
                  file: 'src/a.ts',
                  line: 1,
                  finding: 'Fix the value.',
                }],
                notes: null,
              }
            : { findings: [], notes: null },
        });
      }
      if (personaName.includes('team-leader')) {
        const required = options?.outputSchema?.required;
        return Array.isArray(required) && required.includes('done')
          ? makeResponse({
              persona: 'team-leader',
              structuredOutput: { done: true, reasoning: 'enough', cancelPartIds: [], parts: [] },
            })
          : makeResponse({
              persona: 'team-leader',
              structuredOutput: {
                parts: [{ id: 'part-1', title: 'API', instruction: 'Implement API' }],
              },
            });
      }
      if (personaName.includes('coder')) {
        if (instruction.includes('New companion findings')) {
          expect(options?.sessionId).toBe('part-session');
          throw new Error('follow-up provider failed');
        }
        return makeResponse({
          persona: 'coder',
          content: 'initial part response',
          sessionId: 'part-session',
        });
      }
      throw new Error(`Unexpected mock persona: ${personaName}`);
    });
    vi.mocked(mockRuleEvaluation).mockReturnValueOnce({ index: 0, method: 'phase3_tag' });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(state.stepOutputs.get('implement.part-1')).toMatchObject({
      content: 'initial part response',
      sessionId: 'part-session',
    });
    expect(state.stepOutputs.get('implement')?.content).toContain('initial part response');
    expect(companionCompletes).toHaveBeenCalledWith(expect.objectContaining({
      step: 'implement.part-1',
      completionSettled: false,
      completionFailure: true,
      followUpRounds: 1,
      reason: 'follow-up provider failed',
    }));
    expect(companionRounds).toHaveBeenCalledWith(expect.objectContaining({
      step: 'implement',
      trigger: 'completion',
      findingCount: 0,
    }));
    expect(companionCompletes).toHaveBeenCalledWith(expect.objectContaining({
      step: 'implement',
      completionSettled: true,
      completionFailure: false,
      followUpRounds: 0,
    }));
    expect(stepCompletes).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'implement' }),
      expect.objectContaining({
        status: 'done',
        content: expect.stringContaining('initial part response'),
      }),
      expect.any(String),
      expect.any(String),
      expect.any(Array),
    );
    expect(lifecycle).toEqual([
      'part-fail-soft',
      'team-review',
      'team-complete',
      'parent-step-complete',
    ]);
  });

  it('Team 終端の Companion provider 失敗を fail-soft で確定する', async () => {
    const config = buildTeamLeaderConfig();
    updateTeamLeaderStep(config, (step) => ({
      ...step,
      teamLeader: { ...step.teamLeader, maxConcurrency: 1 },
      companion: { fixed: ['reviewer'], pool: [] },
    }));
    config.companions = {
      reviewer: {
        name: 'reviewer',
        description: 'Review the complete Team Leader change',
        instruction: 'Review the complete change.',
        instructionRef: 'reviewer',
        intervalMs: 60_000,
      },
    };
    const companionDiffReader = {
      readBaselineSha: vi.fn().mockResolvedValue('baseline'),
      readDiff: vi.fn().mockResolvedValue({
        status: 'ok',
        snapshot: {
          digest: 'provider-failure-digest',
          changedLines: 1,
          content: '+change\n',
          changedFiles: ['src/a.ts'],
          fileFingerprints: { 'src/a.ts': 'file-1' },
          hunkFingerprints: { 'src/a.ts:1-1': 'hunk-1' },
          omittedBytes: 0,
          truncated: false,
        },
      }),
    };
    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', {
      projectCwd: tmpDir,
      provider: 'mock',
      companionEnabled: true,
      companionProviders: { reviewer: { provider: 'mock' } },
      companionDiffReader,
    });
    const companionCompletes = vi.fn();
    engine.on('companion:complete', companionCompletes);

    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      const personaName = typeof persona === 'string' ? persona : '';
      options?.onPromptResolved?.({ systemPrompt: personaName, userInstruction: instruction });
      if (personaName === 'reviewer') {
        if (instruction.includes('"label":"step_name","value":"implement"')) {
          throw new Error('Team reviewer failed');
        }
        return makeResponse({
          persona: 'reviewer',
          structuredOutput: { findings: [], notes: null },
        });
      }
      if (personaName.includes('team-leader')) {
        const required = options?.outputSchema?.required;
        return Array.isArray(required) && required.includes('done')
          ? makeResponse({
              persona: 'team-leader',
              structuredOutput: { done: true, reasoning: 'enough', cancelPartIds: [], parts: [] },
            })
          : makeResponse({
              persona: 'team-leader',
              structuredOutput: {
                parts: [{ id: 'part-1', title: 'API', instruction: 'Implement API' }],
              },
            });
      }
      if (personaName.includes('coder')) {
        return makeResponse({ persona: 'coder', content: 'part response' });
      }
      throw new Error(`Unexpected mock persona: ${personaName}`);
    });
    vi.mocked(mockRuleEvaluation).mockReturnValueOnce({ index: 0, method: 'phase3_tag' });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(state.stepOutputs.get('implement.part-1')).toMatchObject({ content: 'part response' });
    expect(companionCompletes).toHaveBeenCalledWith(expect.objectContaining({
      step: 'implement',
      completionSettled: false,
      completionFailure: true,
      followUpRounds: 0,
      reason: 'Team reviewer failed',
    }));
  });

  it('Team 終端の Companion review 中に親 AbortSignal が伝播し、補正 part と集約を停止する', async () => {
    const config = buildTeamLeaderConfig();
    updateTeamLeaderStep(config, (step) => ({
      ...step,
      teamLeader: { ...step.teamLeader, maxConcurrency: 1 },
      companion: { fixed: ['reviewer'], pool: [] },
    }));
    config.companions = {
      reviewer: {
        name: 'reviewer',
        description: 'Review the complete Team Leader change',
        instruction: 'Review the complete change.',
        instructionRef: 'reviewer',
        intervalMs: 60_000,
      },
    };
    const companionDiffReader = {
      readBaselineSha: vi.fn().mockResolvedValue('baseline'),
      readDiff: vi.fn().mockResolvedValue({
        status: 'ok',
        snapshot: {
          digest: 'team-abort-digest',
          changedLines: 1,
          content: '+change\n',
          changedFiles: ['src/a.ts'],
          fileFingerprints: { 'src/a.ts': 'file-1' },
          hunkFingerprints: { 'src/a.ts:1-1': 'hunk-1' },
          omittedBytes: 0,
          truncated: false,
        },
      }),
    };
    const abortController = new AbortController();
    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', {
      projectCwd: tmpDir,
      provider: 'mock',
      companionEnabled: true,
      companionProviders: { reviewer: { provider: 'mock' } },
      companionDiffReader,
      abortSignal: abortController.signal,
    });
    const reviewerSteps: string[] = [];
    let teamLeaderCalls = 0;
    let coderCalls = 0;
    const abortReason = new Error('Team completion review aborted');

    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      const personaName = typeof persona === 'string' ? persona : '';
      options?.onPromptResolved?.({ systemPrompt: personaName, userInstruction: instruction });
      if (personaName === 'reviewer') {
        if (instruction.includes('"label":"step_name","value":"implement"')) {
          reviewerSteps.push('implement');
          const signal = options?.abortSignal;
          if (signal === undefined) {
            throw new Error('Team completion review abortSignal is required');
          }
          abortController.abort(abortReason);
          expect(signal.aborted).toBe(true);
          throw abortReason;
        }
        reviewerSteps.push('implement.part-1');
        return makeResponse({
          persona: 'reviewer',
          structuredOutput: { findings: [], notes: null },
        });
      }
      if (personaName.includes('team-leader')) {
        teamLeaderCalls += 1;
        const required = options?.outputSchema?.required;
        return Array.isArray(required) && required.includes('done')
          ? makeResponse({
              persona: 'team-leader',
              structuredOutput: { done: true, reasoning: 'enough', cancelPartIds: [], parts: [] },
            })
          : makeResponse({
              persona: 'team-leader',
              structuredOutput: {
                parts: [{ id: 'part-1', title: 'API', instruction: 'Implement API' }],
              },
            });
      }
      if (personaName.includes('coder')) {
        coderCalls += 1;
        return makeResponse({ persona: 'coder', content: 'part response' });
      }
      throw new Error(`Unexpected mock persona: ${personaName}`);
    });
    vi.mocked(mockRuleEvaluation).mockReturnValueOnce({ index: 0, method: 'phase3_tag' });

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(reviewerSteps).toEqual(['implement.part-1', 'implement']);
    expect(teamLeaderCalls).toBe(2);
    expect(coderCalls).toBe(1);
    expect(state.stepOutputs.has('implement.part-1')).toBe(true);
    expect(state.stepOutputs.get('implement')).toBeUndefined();
    expect(state.stepOutputs.has('implement.part-2')).toBe(false);
  });

  it('Team part の Companion follow-up 中断時は初回応答を公開しない', async () => {
    const config = buildTeamLeaderConfig();
    updateTeamLeaderStep(config, (step) => ({
      ...step,
      teamLeader: { ...step.teamLeader, maxConcurrency: 2 },
      companion: { fixed: ['reviewer'], pool: [] },
    }));
    config.companions = {
      reviewer: {
        name: 'reviewer',
        description: 'Review the complete Team Leader change',
        instruction: 'Review the complete change.',
        instructionRef: 'reviewer',
        intervalMs: 60_000,
      },
    };
    const companionDiffReader = {
      readBaselineSha: vi.fn().mockResolvedValue('baseline'),
      readDiff: vi.fn().mockResolvedValue({
        status: 'ok',
        snapshot: {
          digest: 'abort-digest',
          changedLines: 1,
          content: '+change\n',
          changedFiles: ['src/a.ts'],
          fileFingerprints: { 'src/a.ts': 'file-1' },
          hunkFingerprints: { 'src/a.ts:1-1': 'hunk-1' },
          omittedBytes: 0,
          truncated: false,
        },
      }),
    };
    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', {
      projectCwd: tmpDir,
      provider: 'mock',
      companionEnabled: true,
      companionProviders: { reviewer: { provider: 'mock' } },
      companionDiffReader,
    });
    const companionCompletes = vi.fn();
    engine.on('companion:complete', companionCompletes);

    let markFollowUpStarted: (() => void) | undefined;
    const followUpStarted = new Promise<void>((resolve) => {
      markFollowUpStarted = resolve;
    });
    let followUpSessionId: string | undefined;
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      const personaName = typeof persona === 'string' ? persona : '';
      options?.onPromptResolved?.({ systemPrompt: personaName, userInstruction: instruction });
      if (personaName === 'reviewer') {
        const reviewsPartOne = instruction.includes(
          '"label":"step_name","value":"implement.part-1"',
        );
        return makeResponse({
          persona: 'reviewer',
          structuredOutput: reviewsPartOne
            ? {
                findings: [{
                  severity: 'must_fix',
                  file: 'src/a.ts',
                  line: 1,
                  finding: 'Fix the value.',
                }],
                notes: null,
              }
            : { findings: [], notes: null },
        });
      }
      if (personaName.includes('team-leader')) {
        const required = options?.outputSchema?.required;
        return Array.isArray(required) && required.includes('done')
          ? makeResponse({
              persona: 'team-leader',
              structuredOutput: {
                done: true,
                reasoning: 'part-2 is sufficient',
                cancelPartIds: ['part-1'],
                parts: [],
              },
            })
          : makeResponse({
              persona: 'team-leader',
              structuredOutput: {
                parts: [
                  { id: 'part-1', title: 'API', instruction: 'Implement API' },
                  { id: 'part-2', title: 'Test', instruction: 'Add tests' },
                ],
              },
            });
      }
      if (personaName.includes('coder')) {
        if (instruction.includes('New companion findings')) {
          followUpSessionId = options?.sessionId;
          markFollowUpStarted?.();
          const signal = options?.abortSignal;
          if (signal === undefined) throw new Error('part abortSignal is required');
          return new Promise<AgentResponse>((_resolve, reject) => {
            const rejectWithReason = (): void => reject(signal.reason);
            if (signal.aborted) {
              rejectWithReason();
              return;
            }
            signal.addEventListener('abort', rejectWithReason, { once: true });
          });
        }
        if (instruction.includes('Add tests')) {
          await followUpStarted;
          return makeResponse({ persona: 'coder', content: 'part-2 response' });
        }
        return makeResponse({
          persona: 'coder',
          content: 'part-1 initial response',
          sessionId: 'part-1-session',
        });
      }
      throw new Error(`Unexpected mock persona: ${personaName}`);
    });
    vi.mocked(mockRuleEvaluation).mockReturnValueOnce({ index: 0, method: 'phase3_tag' });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(followUpSessionId).toBe('part-1-session');
    expect(state.stepOutputs.has('implement.part-1')).toBe(false);
    expect(state.stepOutputs.get('implement.part-2')).toMatchObject({ content: 'part-2 response' });
    expect(companionCompletes.mock.calls.some(([payload]) => payload.step === 'implement.part-1')).toBe(false);
  });

  it.each([
    ['明示的な無効化', false],
    ['既定の無効化', undefined],
  ] as const)('%sでは Team Leader の通常実行と親 skip event を維持する', async (
    _caseName,
    companionEnabled,
  ) => {
    const config = buildTeamLeaderConfig();
    updateTeamLeaderStep(config, (step) => ({
      ...step,
      companion: { fixed: ['reviewer'], pool: [] },
    }));
    config.companions = {
      reviewer: {
        name: 'reviewer',
        description: 'Review the complete Team Leader change',
        instruction: 'Review the complete change.',
        instructionRef: 'reviewer',
        intervalMs: 60_000,
      },
    };
    const companionDiffReader = {
      readBaselineSha: vi.fn().mockResolvedValue('baseline'),
      readDiff: vi.fn(),
    };
    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', {
      projectCwd: tmpDir,
      provider: 'mock',
      companionEnabled,
      companionProviders: { reviewer: { provider: 'mock' } },
      companionDiffReader,
    });
    const companionStarts = vi.fn();
    const companionReviewSkips: Array<{ step: string; reason: string }> = [];
    engine.on('companion:start', companionStarts);
    engine.on('companion:review_skipped', (payload) => {
      companionReviewSkips.push({ step: payload.step, reason: payload.reason });
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
    vi.mocked(mockRuleEvaluation).mockReturnValueOnce({ index: 0, method: 'phase3_tag' });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(companionStarts).not.toHaveBeenCalled();
    expect(companionDiffReader.readBaselineSha).not.toHaveBeenCalled();
    expect(companionDiffReader.readDiff).not.toHaveBeenCalled();
    expect(vi.mocked(runAgent).mock.calls.some(([persona]) => persona === 'reviewer')).toBe(false);
    expect(companionReviewSkips).toEqual([
      { step: 'implement', reason: 'companion_disabled' },
    ]);
  });

  it('Companion未宣言のTeam LeaderはCompanion infrastructureを使用せず通常実行する', async () => {
    const config = buildTeamLeaderConfig();
    config.companions = {
      reviewer: {
        name: 'reviewer',
        description: 'Review the complete Team Leader change',
        instruction: 'Review the complete change.',
        instructionRef: 'reviewer',
        intervalMs: 60_000,
      },
    };
    const companionDiffReader = {
      readBaselineSha: vi.fn().mockResolvedValue('baseline'),
      readDiff: vi.fn(),
    };
    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', {
      projectCwd: tmpDir,
      provider: 'mock',
      companionEnabled: true,
      companionProviders: { reviewer: { provider: 'mock' } },
      companionDiffReader,
    });
    const companionStarts = vi.fn();
    const companionRounds = vi.fn();
    const companionFindings = vi.fn();
    const companionFixRounds = vi.fn();
    const companionCompletes = vi.fn();
    engine.on('companion:start', companionStarts);
    engine.on('companion:review_round', companionRounds);
    engine.on('companion:finding', companionFindings);
    engine.on('companion:fix_round', companionFixRounds);
    engine.on('companion:complete', companionCompletes);

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
    vi.mocked(mockRuleEvaluation).mockReturnValueOnce({ index: 0, method: 'phase3_tag' });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(state.stepOutputs.get('implement')?.content).toContain('API done');
    expect(companionDiffReader.readBaselineSha).not.toHaveBeenCalled();
    expect(companionDiffReader.readDiff).not.toHaveBeenCalled();
    expect(companionStarts).not.toHaveBeenCalled();
    expect(companionRounds).not.toHaveBeenCalled();
    expect(companionFindings).not.toHaveBeenCalled();
    expect(companionFixRounds).not.toHaveBeenCalled();
    expect(companionCompletes).not.toHaveBeenCalled();
    expect(vi.mocked(runAgent).mock.calls.some(([persona]) => persona === 'reviewer')).toBe(false);
  });

  it('WorkflowEngineのTeam Leaderはcompletion modeでworker応答中のlive triggerを保留する', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let releaseWorker: (() => void) | undefined;
    const workerGate = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    let workerStreamed = false;
    let leaderCallCount = 0;
    const reviewedRounds: Array<{ step: string; trigger: string }> = [];
    const initialSnapshot: CompanionDiff = {
      digest: 'baseline-digest',
      changedLines: 0,
      content: '',
      changedFiles: [],
      fileFingerprints: {},
      hunkFingerprints: {},
      omittedBytes: 0,
      truncated: false,
    };
    let currentSnapshot = initialSnapshot;
    const companionDiffReader = {
      readBaselineSha: vi.fn().mockResolvedValue('baseline'),
      readDiff: vi.fn().mockImplementation(async () => ({
        status: 'ok' as const,
        snapshot: currentSnapshot,
      })),
    };
    const config = buildTeamLeaderConfig();
    updateTeamLeaderStep(config, (step) => ({
      ...step,
      allowGitCommit: true,
      teamLeader: { ...step.teamLeader, maxConcurrency: 1 },
      companion: { fixed: ['reviewer'], pool: [] },
    }));
    config.companions = {
      reviewer: {
        name: 'reviewer',
        description: 'Review the complete Team Leader change',
        instruction: 'Review the complete change.',
        instructionRef: 'reviewer',
        intervalMs: 250,
      },
    };
    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', {
      projectCwd: tmpDir,
      provider: 'mock',
      companionEnabled: true,
      companionReviewMode: 'completion',
      companionProviders: { reviewer: { provider: 'mock' } },
      companionDiffReader,
    });
    engine.on('companion:review_round', (event) => reviewedRounds.push({
      step: event.step,
      trigger: event.trigger,
    }));
    let runPromise: ReturnType<WorkflowEngine['run']> | undefined;

    try {
      vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
        const personaName = typeof persona === 'string' ? persona : '';
        options?.onPromptResolved?.({ systemPrompt: personaName, userInstruction: instruction });

        if (personaName.includes('team-leader')) {
          leaderCallCount += 1;
          return leaderCallCount === 1
            ? makeResponse({
              persona: 'team-leader',
              structuredOutput: {
                parts: [{ id: 'part-1', title: 'API', instruction: 'Implement API' }],
              },
            })
            : makeResponse({
              persona: 'team-leader',
              structuredOutput: {
                done: true,
                reasoning: 'enough',
                cancelPartIds: [],
                parts: [],
              },
            });
        }

        if (personaName.includes('coder')) {
          currentSnapshot = {
            ...initialSnapshot,
            digest: 'completion-digest',
            changedLines: 12,
            content: '+completion change\n',
            changedFiles: ['src/completion.ts'],
            fileFingerprints: { 'src/completion.ts': 'completion-file' },
            hunkFingerprints: { 'src/completion.ts:1-12': 'completion-hunk' },
          };
          if (options?.onStream === undefined) {
            throw new Error('Team Leader worker did not receive onStream');
          }
          options.onStream({
            type: 'tool_use',
            data: { tool: 'Edit', id: 'edit-1', input: { file_path: 'src/completion.ts' } },
          });
          options.onStream({
            type: 'tool_use',
            data: { tool: 'Bash', id: 'commit-1', input: { command: 'git commit -am "change"' } },
          });
          workerStreamed = true;
          await workerGate;
          return makeResponse({ persona: 'coder', content: 'worker complete' });
        }

        if (personaName === 'reviewer') {
          return makeResponse({
            persona: 'reviewer',
            structuredOutput: { findings: [], notes: null },
          });
        }

        throw new Error(`Unexpected agent persona: ${personaName}`);
      });
      vi.mocked(mockRuleEvaluation).mockReturnValueOnce({ index: 0, method: 'phase3_tag' });

      const workflowPromise = engine.run();
      runPromise = workflowPromise;
      await vi.waitFor(() => expect(workerStreamed).toBe(true), { timeout: 1_000 });
      await vi.advanceTimersByTimeAsync(1_000);

      expect(vi.mocked(runAgent).mock.calls.filter(([persona]) => persona === 'reviewer')).toHaveLength(0);
      expect(reviewedRounds).toEqual([]);

      releaseWorker?.();
      const state = await workflowPromise;

      expect(state.status).toBe('completed');
      expect(reviewedRounds).toEqual([
        { step: 'implement.part-1', trigger: 'completion' },
        { step: 'implement', trigger: 'completion' },
      ]);
      expect(vi.mocked(runAgent).mock.calls.filter(([persona]) => persona === 'reviewer')).toHaveLength(2);
    } finally {
      releaseWorker?.();
      await runPromise?.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it('WorkflowEngineのTeam Leader worker streamでcompletion前にlive reviewを開始する', async () => {
    vi.useFakeTimers();
    let releaseWorker: (() => void) | undefined;
    const workerGate = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    let workerStreamed = false;
    let liveLeaderCallCount = 0;
    const reviewOrder: string[] = [];
    const reviewedRounds: Array<{
      step: string;
      trigger: 'quiet' | 'forced' | 'completion' | 'commit';
      digest: string;
    }> = [];
    const companionStarts: Array<{ step: string; reviewMode: 'completion' | 'live' }> = [];
    const initialSnapshot: CompanionDiff = {
      digest: 'baseline-digest',
      changedLines: 0,
      content: '',
      changedFiles: [],
      fileFingerprints: {},
      hunkFingerprints: {},
      omittedBytes: 0,
      truncated: false,
    };
    let currentSnapshot = initialSnapshot;
    const companionDiffReader = {
      readBaselineSha: vi.fn().mockResolvedValue('baseline'),
      readDiff: vi.fn().mockImplementation(async () => ({
        status: 'ok' as const,
        snapshot: currentSnapshot,
      })),
    };
    const config = buildTeamLeaderConfig();
    updateTeamLeaderStep(config, (step) => ({
      ...step,
      teamLeader: {
        ...step.teamLeader,
        maxConcurrency: 1,
      },
      companion: { fixed: ['reviewer'], pool: [] },
    }));
    config.companions = {
      reviewer: {
        name: 'reviewer',
        description: 'Review the complete Team Leader change',
        instruction: 'Review the complete change.',
        instructionRef: 'reviewer',
        intervalMs: 60_000,
      },
    };
    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', {
      projectCwd: tmpDir,
      provider: 'mock',
      companionEnabled: true,
      companionReviewMode: 'live',
      companionProviders: { reviewer: { provider: 'mock' } },
      companionDiffReader,
    });
    engine.on('companion:start', (event) => companionStarts.push({
      step: event.step,
      reviewMode: event.reviewMode,
    }));
    engine.on('companion:review_round', (event) => reviewedRounds.push({
      step: event.step,
      trigger: event.trigger,
      digest: event.digest,
    }));
    let runPromise: ReturnType<WorkflowEngine['run']> | undefined;

    try {
      vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
        const personaName = typeof persona === 'string' ? persona : '';
        options?.onPromptResolved?.({
          systemPrompt: personaName,
          userInstruction: instruction,
        });

        if (personaName.includes('team-leader')) {
          liveLeaderCallCount += 1;
          if (liveLeaderCallCount === 1) {
            currentSnapshot = {
              ...initialSnapshot,
              digest: 'live-digest',
              changedLines: 12,
              content: '+live change\n',
              changedFiles: ['src/live.ts'],
              fileFingerprints: { 'src/live.ts': 'live-file' },
              hunkFingerprints: { 'src/live.ts:1-12': 'live-hunk' },
            };
            if (options?.onStream === undefined) {
              throw new Error('Team Leader did not receive onStream');
            }
            options.onStream({
              type: 'tool_use',
              data: { tool: 'Edit', id: 'leader-edit-1', input: { file_path: 'src/live.ts' } },
            });
          }
          return liveLeaderCallCount === 1
            ? makeResponse({
              persona: 'team-leader',
              structuredOutput: {
                parts: [{ id: 'part-1', title: 'API', instruction: 'Implement API' }],
              },
            })
            : makeResponse({
              persona: 'team-leader',
              structuredOutput: {
                done: true,
                reasoning: 'enough',
                cancelPartIds: [],
                parts: [],
              },
            });
        }

        if (personaName.includes('coder')) {
          currentSnapshot = {
            ...initialSnapshot,
            digest: 'live-digest',
            changedLines: 12,
            content: '+live change\n',
            changedFiles: ['src/live.ts'],
            fileFingerprints: { 'src/live.ts': 'live-file' },
            hunkFingerprints: { 'src/live.ts:1-12': 'live-hunk' },
          };
          if (options?.onStream === undefined) {
            throw new Error('Team Leader worker did not receive onStream');
          }
          options.onStream({
            type: 'tool_use',
            data: { tool: 'Edit', id: 'edit-1', input: { file_path: 'src/live.ts' } },
          });
          workerStreamed = true;
          await workerGate;
          reviewOrder.push('worker-complete');
          return makeResponse({ persona: 'coder', content: 'worker complete' });
        }

        if (personaName === 'reviewer') {
          reviewOrder.push('review-start');
          return makeResponse({
            persona: 'reviewer',
            structuredOutput: { findings: [], notes: null },
          });
        }

        throw new Error(`Unexpected agent persona: ${personaName}`);
      });
      vi.mocked(mockRuleEvaluation).mockReturnValueOnce({ index: 0, method: 'phase3_tag' });

      const workflowPromise = engine.run();
      runPromise = workflowPromise;
      await vi.waitFor(() => expect(workerStreamed).toBe(true), { timeout: 1_000 });
      await vi.advanceTimersByTimeAsync(COMPANION_CHANGE_DEBOUNCE_MS);
      await vi.waitFor(() => expect(reviewOrder).toContain('review-start'), { timeout: 1_000 });
      await vi.waitFor(() => expect(reviewedRounds).toContainEqual({
        step: 'implement.part-1',
        trigger: 'quiet',
        digest: 'live-digest',
      }), { timeout: 1_000 });
      await vi.waitFor(() => expect(reviewedRounds).toContainEqual({
        step: 'implement',
        trigger: 'quiet',
        digest: 'live-digest',
      }), { timeout: 1_000 });
      expect(reviewedRounds.filter(({ step }) => step === 'implement')).toHaveLength(1);
      expect(companionStarts).toContainEqual({ step: 'implement', reviewMode: 'live' });
      currentSnapshot = {
        ...initialSnapshot,
        digest: 'completion-digest',
        changedLines: 18,
        content: '+live change\n+completion change\n',
        changedFiles: ['src/live.ts'],
        fileFingerprints: { 'src/live.ts': 'completion-file' },
        hunkFingerprints: { 'src/live.ts:1-18': 'completion-hunk' },
      };
      releaseWorker?.();

      const state = await workflowPromise;
      expect(reviewOrder.indexOf('worker-complete'))
        .toBeGreaterThan(reviewOrder.indexOf('review-start'));
      expect(reviewedRounds).toEqual(expect.arrayContaining([
        { step: 'implement.part-1', trigger: 'quiet', digest: 'live-digest' },
        { step: 'implement.part-1', trigger: 'completion', digest: 'completion-digest' },
        { step: 'implement', trigger: 'quiet', digest: 'live-digest' },
        { step: 'implement', trigger: 'completion', digest: 'completion-digest' },
      ]));
      expect(reviewedRounds.filter(({ step }) => step === 'implement')).toHaveLength(2);
      expect(state.status).toBe('completed');
    } finally {
      releaseWorker?.();
      await runPromise?.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it('WorkflowEngineのTeam Leader parentは同一digestのcompletion reviewを抑止する', async () => {
    vi.useFakeTimers();
    let releaseWorker: (() => void) | undefined;
    const workerGate = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    let workerStreamed = false;
    let leaderCallCount = 0;
    const reviewedRounds: Array<{
      step: string;
      trigger: 'quiet' | 'forced' | 'completion' | 'commit';
      digest: string;
    }> = [];
    const companionStarts: Array<{ step: string; reviewMode: 'completion' | 'live' }> = [];
    const companionReviewSkips: Array<{ step: string; phase: string; reason: string }> = [];
    const companionCompletions: Array<{ step: string; completionSettled: boolean }> = [];
    const initialSnapshot: CompanionDiff = {
      digest: 'baseline-digest',
      changedLines: 0,
      content: '',
      changedFiles: [],
      fileFingerprints: {},
      hunkFingerprints: {},
      omittedBytes: 0,
      truncated: false,
    };
    let currentSnapshot = initialSnapshot;
    const companionDiffReader = {
      readBaselineSha: vi.fn().mockResolvedValue('baseline'),
      readDiff: vi.fn().mockImplementation(async () => ({
        status: 'ok' as const,
        snapshot: currentSnapshot,
      })),
    };
    const config = buildTeamLeaderConfig();
    updateTeamLeaderStep(config, (step) => ({
      ...step,
      teamLeader: {
        ...step.teamLeader,
        maxConcurrency: 1,
      },
      companion: { fixed: ['reviewer'], pool: [] },
    }));
    config.companions = {
      reviewer: {
        name: 'reviewer',
        description: 'Review the complete Team Leader change',
        instruction: 'Review the complete change.',
        instructionRef: 'reviewer',
        intervalMs: 60_000,
      },
    };
    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', {
      projectCwd: tmpDir,
      provider: 'mock',
      companionEnabled: true,
      companionReviewMode: 'live',
      companionProviders: { reviewer: { provider: 'mock' } },
      companionDiffReader,
    });
    engine.on('companion:start', (event) => companionStarts.push({
      step: event.step,
      reviewMode: event.reviewMode,
    }));
    engine.on('companion:review_round', (event) => reviewedRounds.push({
      step: event.step,
      trigger: event.trigger,
      digest: event.digest,
    }));
    engine.on('companion:review_skipped', (event) => {
      if (event.step === 'implement') {
        companionReviewSkips.push({
          step: event.step,
          phase: event.phase,
          reason: event.reason,
        });
      }
    });
    engine.on('companion:complete', (event) => {
      if (event.step === 'implement') {
        companionCompletions.push({
          step: event.step,
          completionSettled: event.completionSettled,
        });
      }
    });
    let runPromise: ReturnType<WorkflowEngine['run']> | undefined;

    try {
      vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
        const personaName = typeof persona === 'string' ? persona : '';
        options?.onPromptResolved?.({
          systemPrompt: personaName,
          userInstruction: instruction,
        });

        if (personaName.includes('team-leader')) {
          leaderCallCount += 1;
          if (leaderCallCount === 1) {
            currentSnapshot = {
              ...initialSnapshot,
              digest: 'live-digest',
              changedLines: 12,
              content: '+live change\n',
              changedFiles: ['src/live.ts'],
              fileFingerprints: { 'src/live.ts': 'live-file' },
              hunkFingerprints: { 'src/live.ts:1-12': 'live-hunk' },
            };
            if (options?.onStream === undefined) {
              throw new Error('Team Leader did not receive onStream');
            }
            options.onStream({
              type: 'tool_use',
              data: { tool: 'Edit', id: 'leader-edit-1', input: { file_path: 'src/live.ts' } },
            });
          }
          return leaderCallCount === 1
            ? makeResponse({
              persona: 'team-leader',
              structuredOutput: {
                parts: [{ id: 'part-1', title: 'API', instruction: 'Implement API' }],
              },
            })
            : makeResponse({
              persona: 'team-leader',
              structuredOutput: {
                done: true,
                reasoning: 'enough',
                cancelPartIds: [],
                parts: [],
              },
            });
        }

        if (personaName.includes('coder')) {
          if (options?.onStream === undefined) {
            throw new Error('Team Leader worker did not receive onStream');
          }
          options.onStream({
            type: 'tool_use',
            data: { tool: 'Edit', id: 'edit-1', input: { file_path: 'src/live.ts' } },
          });
          workerStreamed = true;
          await workerGate;
          return makeResponse({ persona: 'coder', content: 'worker complete' });
        }

        if (personaName === 'reviewer') {
          return makeResponse({
            persona: 'reviewer',
            structuredOutput: { findings: [], notes: null },
          });
        }

        throw new Error(`Unexpected agent persona: ${personaName}`);
      });
      vi.mocked(mockRuleEvaluation).mockReturnValueOnce({ index: 0, method: 'phase3_tag' });

      const workflowPromise = engine.run();
      runPromise = workflowPromise;
      await vi.waitFor(() => expect(workerStreamed).toBe(true), { timeout: 1_000 });
      await vi.advanceTimersByTimeAsync(COMPANION_CHANGE_DEBOUNCE_MS);
      await vi.waitFor(() => expect(reviewedRounds).toContainEqual({
        step: 'implement',
        trigger: 'quiet',
        digest: 'live-digest',
      }), { timeout: 1_000 });

      expect(reviewedRounds.filter(({ step }) => step === 'implement')).toHaveLength(1);
      expect(companionStarts).toContainEqual({ step: 'implement', reviewMode: 'live' });
      const reviewerCallsBeforeCompletion = vi.mocked(runAgent).mock.calls
        .filter(([persona]) => persona === 'reviewer').length;

      releaseWorker?.();
      const state = await workflowPromise;

      expect(state.status).toBe('completed');
      expect(reviewedRounds.filter(({ step }) => step === 'implement')).toHaveLength(1);
      expect(vi.mocked(runAgent).mock.calls
        .filter(([persona]) => persona === 'reviewer'))
        .toHaveLength(reviewerCallsBeforeCompletion);
      expect(companionReviewSkips).toContainEqual({
        step: 'implement',
        phase: 'completion',
        reason: 'unchanged_digest',
      });
      expect(companionCompletions).toEqual([{
        step: 'implement',
        completionSettled: true,
      }]);
    } finally {
      releaseWorker?.();
      await runPromise?.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it('WorkflowEngineのTeam Leader再入でcompanion poolを実行ごとに再選択する', async () => {
    const config = buildTeamLeaderConfig();
    config.maxSteps = 2;
    updateTeamLeaderStep(config, (step) => ({
      ...step,
      companion: { fixed: [], pool: ['reviewer'] },
      rules: [makeRule('repeat', 'implement'), makeRule('done', 'COMPLETE')],
    }));
    config.companions = {
      reviewer: {
        name: 'reviewer',
        description: 'Review the complete Team Leader change',
        instruction: 'Review the complete change.',
        instructionRef: 'reviewer',
        intervalMs: 60_000,
      },
    };
    const companionDiffReader = {
      readBaselineSha: vi.fn().mockResolvedValue('baseline'),
      readDiff: vi.fn().mockResolvedValue({
        status: 'ok' as const,
        snapshot: {
          digest: 'team-leader-reentry-digest',
          changedLines: 1,
          content: '+team leader change\n',
          changedFiles: ['src/a.ts'],
          fileFingerprints: { 'src/a.ts': 'file-1' },
          hunkFingerprints: { 'src/a.ts:1-1': 'hunk-1' },
          omittedBytes: 0,
          truncated: false,
        },
      }),
    };
    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', {
      projectCwd: tmpDir,
      provider: 'mock',
      selectorProvider: { provider: 'mock', model: 'selector-model' },
      companionEnabled: true,
      companionProviders: { reviewer: { provider: 'mock', model: 'reviewer-model' } },
      companionDiffReader,
    });
    const abortReasons: string[] = [];
    engine.on('workflow:abort', (_state, reason) => abortReasons.push(reason));
    const poolSelections: Array<{ step: string; selected: string[] }> = [];
    engine.on('companion:pool_selected', (event) => poolSelections.push({
      step: event.step,
      selected: event.selected,
    }));
    const selectorCalls: Array<{ provider?: string; model?: string }> = [];
    const reviewerCalls: Array<{ provider?: string; model?: string }> = [];
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      const personaName = typeof persona === 'string' ? persona : '';
      const execution = options?.resolvedExecution;
      options?.onPromptResolved?.({
        systemPrompt: personaName,
        userInstruction: instruction,
      });
      if (personaName === 'companion-selector') {
        selectorCalls.push({ provider: execution?.provider, model: execution?.model });
        return makeResponse({
          persona: 'companion-selector',
          structuredOutput: { selected_ids: ['reviewer'], rationale: 'reviewer applies' },
        });
      }
      if (personaName === 'reviewer') {
        reviewerCalls.push({ provider: execution?.provider, model: execution?.model });
        return makeResponse({
          persona: 'reviewer',
          structuredOutput: { findings: [], notes: null },
        });
      }
      if (personaName.includes('team-leader')) {
        const required = options?.outputSchema?.required;
        if (Array.isArray(required) && required.includes('done')) {
          return makeResponse({
            persona: 'team-leader',
            structuredOutput: { done: true, reasoning: 'complete', cancelPartIds: [], parts: [] },
          });
        }
        return makeResponse({
          persona: 'team-leader',
          structuredOutput: { parts: [{ id: 'part', title: 'Implementation', instruction: 'Implement the change' }] },
        });
      }
      if (personaName.includes('coder')) {
        return makeResponse({ persona: 'coder', content: 'part complete' });
      }
      throw new Error(`Unexpected mock persona: ${personaName}`);
    });
    vi.mocked(mockRuleEvaluation)
      .mockReturnValueOnce({ index: 0, method: 'phase3_tag' })
      .mockReturnValueOnce({ index: 1, method: 'phase3_tag' });

    const state = await engine.run();

    expect(state.status, [...abortReasons, state.lastOutput?.content, state.companion?.reason]
      .filter((value): value is string => value !== undefined).join('\n')).toBe('completed');
    expect(poolSelections).toEqual([
      { step: 'implement', selected: ['reviewer'] },
      { step: 'implement.part', selected: ['reviewer'] },
      { step: 'implement', selected: ['reviewer'] },
      { step: 'implement.part', selected: ['reviewer'] },
    ]);
    expect(selectorCalls).toEqual(Array.from({ length: 4 }, () => ({
      provider: 'mock',
      model: 'selector-model',
    })));
    expect(reviewerCalls).toHaveLength(4);
    expect(reviewerCalls.every((call) => call.provider === 'mock' && call.model === 'reviewer-model')).toBe(true);
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
    expect(vi.mocked(runAgent).mock.calls[0]?.[2]?.abortSignal?.aborted).toBe(true);
  });

  it('timeout part 後の feedback call 中に親中断された場合は継続 part を routing しない', async () => {
    const config = buildTeamLeaderConfig();
    const abortController = new AbortController();
    const autoRouting: AutoRoutingConfig = {
      ...createAutoRoutingConfig(),
      rules: undefined,
    };
    const estimate = vi.fn().mockResolvedValue({ requiredTier: 'medium', reasonCodes: ['focused-change'] });
    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', {
      projectCwd: tmpDir,
      provider: 'mock',
      abortSignal: abortController.signal,
      autoRouting,
      autoRoutingEstimator: { estimate },
    });
    mockRunAgentWithPrompt(
      makeResponse({
        persona: 'team-leader',
        structuredOutput: {
          parts: [{ id: 'part-1', title: 'API', instruction: 'Implement API' }],
        },
      }),
      makeResponse({
        persona: 'coder',
        status: 'error',
        content: '',
        error: 'Part timeout after 1000ms',
        failureCategory: 'part_timeout',
      }),
    );
    vi.mocked(runAgent).mockImplementationOnce(async () => {
      abortController.abort(new Error('feedback aborted'));
      throw abortController.signal.reason;
    });

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(3);
    const feedbackAbortSignal = vi.mocked(runAgent).mock.calls[2]?.[2]?.abortSignal;
    expect(feedbackAbortSignal).not.toBe(abortController.signal);
    expect(feedbackAbortSignal?.aborted).toBe(true);
    expect(feedbackAbortSignal?.reason).toBe(abortController.signal.reason);
    expect(estimate).toHaveBeenCalled();
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
    vi.mocked(mockRuleEvaluation).mockReturnValueOnce({ index: 0, method: 'phase3_tag' });

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
          routingTier: 'medium',
        },
        {
          name: 'coding',
          description: 'Implementation and tests',
          provider: 'codex',
          model: 'gpt-5',
          routingTier: 'medium',
        },
      ],
      defaultPool: 'general',
      candidatePools: {
        general: { candidates: ['leader', 'coding'], fallback: 'leader' },
      },
      poolRules: {
        tags: { implementation: 'general' },
        personas: { 'team-leader': 'general' },
        steps: { implement: 'general' },
      },
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
          model: options.resolvedExecution?.model ?? options.resolvedModel ?? '(default)',
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
    vi.mocked(mockRuleEvaluation).mockReturnValueOnce({ index: 0, method: 'phase3_tag' });

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
      resolvedExecution: {
        provider: 'mock',
        model: 'mock-1',
        providerOptions: undefined,
        permissionMode: undefined,
      },
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
    step.teamLeader.partTags = ['implementation'];
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
          routingTier: 'medium',
        },
        {
          name: 'coding',
          description: 'Implementation and tests',
          provider: 'codex',
          model: 'gpt-5',
          routingTier: 'medium',
        },
      ],
      defaultPool: 'general',
      candidatePools: {
        general: { candidates: ['leader', 'coding'], fallback: 'leader' },
      },
      poolRules: {
        tags: { implementation: 'general' },
        personas: { 'team-leader': 'general' },
        steps: { implement: 'general' },
      },
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
      const provider = options?.resolvedExecution?.provider ?? options?.resolvedProvider;
      if (provider === 'claude-sdk') {
        options.onStream?.({ type: 'text', data: { text: 'routing' } });
        const selections = [
          { id: longPartId, required_tier: 'medium' },
          { id: shortPartId, required_tier: 'medium' },
        ];
        return makeResponse({
          persona: 'auto-router',
          content: JSON.stringify({ required_tier: 'medium', reason_codes: ['focused-change'], confidence: null }),
          structuredOutput: { required_tier: 'medium', reason_codes: ['focused-change'], confidence: null },
        });
      }
      if (provider === 'mock') {
        return nextLeaderResponse();
      }
      if (provider === 'codex') {
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
      throw new Error(`Unexpected provider: ${provider ?? '(missing)'}`);
    });
    vi.mocked(mockRuleEvaluation).mockReturnValueOnce({ index: 0, method: 'phase3_tag' });

    const state = await engine.run();
    const routingEvents = routingDecision.mock.calls;

    expect(state.status).toBe('completed');
    expect(nextLeaderResponse).toHaveBeenCalledTimes(4);
    const partRoutingEvents = routingEvents.filter((event) => {
      const name = (event[0] as { name?: string }).name;
      return name === `implement.${longPartId}` || name === `implement.${shortPartId}`;
    });
    expect(partRoutingEvents).toHaveLength(2);
    expect(partRoutingEvents.every((event) => (
      (event[3] as { providerSource?: string }).providerSource === 'auto.dynamic'
    ))).toBe(true);
    expect(routingEvents.some((event) => (
      (event[3] as { providerSource?: string }).providerSource === 'auto.fallback'
    ))).toBe(false);

    const usageLog = readFileSync(usageLogger.filepath, 'utf-8').trim();
    const usageRecords = usageLog
      .split('\n')
      .map((line) => JSON.parse(line) as UsageEventLogRecord);
    const longPartUsage = usageRecords.find((record) => record.step.includes('[REDACTED]'));
    expect(longPartUsage).toMatchObject({
      step_type: 'team_leader',
      provider: 'mock',
      provider_model: 'mock-1',
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
    const step = config.steps[0];
    if (!step?.teamLeader) {
      throw new Error('teamLeader configuration is required');
    }
    step.tags = ['implementation'];
    step.teamLeader.partTags = ['implementation'];
    const autoRouting: AutoRoutingConfig = {
      ...createAutoRoutingConfig(),
      rules: undefined,
    };
    const estimate = vi.fn().mockResolvedValue({ requiredTier: 'medium', reasonCodes: ['focused-change'] });
    const engine = new WorkflowEngine(config, tmpDir, 'SECRET_TASK_SHOULD_NOT_REACH_ROUTER', {
      projectCwd: tmpDir,
      provider: 'mock',
      autoRouting,
      autoRoutingEstimator: { estimate },
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
    vi.mocked(mockRuleEvaluation).mockReturnValueOnce({ index: 0, method: 'phase3_tag' });

    const state = await engine.run();
    expect(state.status).toBe('completed');
    expect(estimate).toHaveBeenCalled();
    expect(estimate.mock.calls.map(([snapshot]) => snapshot.step.instruction)).toEqual(expect.arrayContaining([
      'Task: {task}',
      'Implement [SECRET] API',
    ]));
    expect(JSON.stringify(estimate.mock.calls)).not.toContain('SECRET_TASK_SHOULD_NOT_REACH_ROUTER');
  });

  it('leader routing estimator の中断を fallback に変換せず親 AbortSignal を伝播する', async () => {
    const config = buildTeamLeaderConfig();
    const abortController = new AbortController();
    const abortReason = new Error('leader routing aborted');
    let estimatorAbortSignal: AbortSignal | undefined;
    const estimate = vi.fn().mockImplementation(async (_input, options) => {
      estimatorAbortSignal = options?.abortSignal;
      abortController.abort(abortReason);
      throw abortReason;
    });
    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', {
      projectCwd: tmpDir,
      provider: 'mock',
      abortSignal: abortController.signal,
      autoRouting: {
        ...createAutoRoutingConfig(),
        rules: undefined,
      },
      autoRoutingEstimator: { estimate },
    });

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(estimate).toHaveBeenCalledOnce();
    expect(estimatorAbortSignal).not.toBe(abortController.signal);
    expect(estimatorAbortSignal?.aborted).toBe(true);
    expect(estimatorAbortSignal?.reason).toBe(abortReason);
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
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
          routingTier: 'medium',
        },
        {
          name: 'coding',
          description: 'Implementation and tests',
          provider: 'codex',
          model: 'sonnet',
          routingTier: 'medium',
        },
      ],
      defaultPool: 'general',
      candidatePools: {
        general: { candidates: ['leader', 'coding'], fallback: 'leader' },
      },
      poolRules: {
        tags: { implementation: 'general' },
        steps: { implement: 'general' },
      },
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
      "Step execution failed: Configuration error: auto_routing resolved model 'sonnet' is a Claude model alias but provider is 'codex'.",
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
          cancelPartIds: [],
          parts: [
            { id: 'part-2', title: 'Tests', instruction: 'Add tests' },
          ],
        },
      }),
      makeResponse({ persona: 'coder', content: 'Tests done' }),
      makeResponse({
        persona: 'team-leader',
        structuredOutput: { done: true, reasoning: 'enough', cancelPartIds: [], parts: [] },
      }),
    );
    vi.mocked(mockRuleEvaluation).mockReturnValueOnce({ index: 0, method: 'phase3_tag' });

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

    vi.mocked(mockRuleEvaluation).mockReturnValueOnce({ index: 0, method: 'phase3_tag' });

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
    const primaryError = 'api failed';
    const aggregateContent = 'All team leader parts failed: part-1: api failed; part-2: test failed';

    expect(state.status).toBe('aborted');
    expect(state.stepOutputs.get('implement')).toMatchObject({
      persona: 'implement',
      status: 'error',
      error: primaryError,
      content: aggregateContent,
    });
    expect(state.lastOutput).toMatchObject({
      persona: 'implement',
      status: 'error',
      error: primaryError,
      content: aggregateContent,
    });
  });

  it('member の provider stream parse failure は成功パートと混在しても即時 abort する', async () => {
    const config = buildTeamLeaderConfig();
    const step = config.steps[0];
    if (!step?.teamLeader) {
      throw new Error('teamLeader configuration is required');
    }
    step.teamLeader.maxConcurrency = 2;
    const engine = new WorkflowEngine(config, tmpDir, 'implement feature', {
      projectCwd: tmpDir,
      provider: 'claude',
    });
    const workflowAborted = vi.fn();
    engine.on('workflow:abort', workflowAborted);
    const boundedParseFailure = createBoundedParseFailure(
      '/tmp/project/.takt/runs/sample/failures/team-leader-provider-failure-1.txt',
    );

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
        error: boundedParseFailure,
        failureCategory: 'provider_stream_parse_error',
      }),
      makeResponse({ persona: 'coder', content: 'Tests done' }),
    );

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(3);
    expect(mockRuleEvaluation).not.toHaveBeenCalled();
    expect(workflowAborted).toHaveBeenCalledOnce();
    const abortReason = workflowAborted.mock.calls[0]?.[1];
    const abortKind = workflowAborted.mock.calls[0]?.[2];
    const abortFailure = workflowAborted.mock.calls[0]?.[3];
    expect(abortKind).toBe('step_error');
    expect(abortReason).toBe(boundedParseFailure);
    expect(abortFailure).toMatchObject({
      kind: 'step_error',
      reason: boundedParseFailure,
      error: boundedParseFailure,
      failureCategory: 'provider_stream_parse_error',
    });
    expect(Buffer.byteLength(String(abortReason))).toBe(MAX_AGENT_FAILURE_MESSAGE_BYTES);
    expect(Buffer.byteLength(String(abortFailure?.error))).toBe(
      MAX_AGENT_FAILURE_MESSAGE_BYTES,
    );
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

  it('prompt-based team leader の意味的再生成と feedback 契約失敗を全attempt分記録する', async () => {
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
          return makeResponse({ persona: 'team-leader', content: 'no json' });
        })
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
        }));
      vi.mocked(mockRuleEvaluation).mockReturnValueOnce({ index: 0, method: 'phase3_tag' });

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
        true,
        true,
        false,
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
    mockRunAgentWithPrompt(makeResponse({
      persona: 'team-leader',
      structuredOutput: {
        done: true,
        reasoning: 'No recovery requested',
        cancelPartIds: [],
        parts: [],
      },
    }));

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    const primaryError = 'part timeout: Part timeout after 5ms';
    const aggregateContent =
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
      error: primaryError,
      content: aggregateContent,
    });
    expect(workflowAbort).toMatchObject({
      type: 'workflow_abort',
      reason: primaryError,
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
        reason: primaryError,
      },
      ndjsonPath,
      undefined,
      'full',
    );

    expect(trace).toContain(aggregateContent);
    expect(trace).toContain(primaryError);

    const usageRecords = readFileSync(usageLogger.filepath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as UsageEventLogRecord);
    const leaderRecords = usageRecords.filter((record) => record.step === 'implement');
    const partRecords = usageRecords.filter((record) => record.step.startsWith('implement.part-'));
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(4);
    expect(usageRecords).toHaveLength(vi.mocked(runAgent).mock.calls.length);
    expect(leaderRecords).toHaveLength(2);
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

    const primaryError =
      'stream idle timeout: Codex stream timed out after 10 minutes of inactivity';
    const aggregateContent =
      'All team leader parts failed: part-1: stream idle timeout: Codex stream timed out after 10 minutes of inactivity; part-2: stream idle timeout: Secondary stream timed out after 2 minutes of inactivity';

    expect(state.stepOutputs.get('implement')).toMatchObject({
      status: 'error',
      error: primaryError,
      content: aggregateContent,
    });
    expect(state.lastOutput).toMatchObject({
      status: 'error',
      error: primaryError,
      content: aggregateContent,
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
      error: primaryError,
      content: aggregateContent,
    });
    expect(workflowAbort).toMatchObject({
      type: 'workflow_abort',
      reason: primaryError,
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
        reason: primaryError,
      },
      ndjsonPath,
      undefined,
      'full',
    );

    expect(trace).toContain(aggregateContent);
    expect(trace).toContain(primaryError);
  });

  it('実際の親 AbortSignal でも part の失敗 usage を1件だけ記録する', async () => {
    const config = buildTeamLeaderConfig();
    const step = config.steps[0];
    if (!step?.teamLeader) {
      throw new Error('teamLeader configuration is required');
    }
    step.teamLeader.providerRoutingPersonaKey = 'team-leader';
    step.teamLeader.partTags = ['implementation'];
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
    const abortFn = vi.fn();
    engine.on('workflow:abort', abortFn);

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
    expect(state.stepOutputs.get('implement')).toBeUndefined();
    expect(state.lastOutput).toBeUndefined();
    expect(abortFn).toHaveBeenCalledWith(
      state,
      'Workflow interrupted by external AbortSignal',
      'interrupt',
      {
        kind: 'interrupt',
        step: 'implement',
        reason: 'Workflow interrupted by external AbortSignal',
        error: 'Workflow interrupted by external AbortSignal',
      },
    );

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

  it('全パート失敗時は診断をcontentに残し、errorは最初のprovider failureに分離する', async () => {
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
      error: 'Upstream model returned 500',
      failureCategory: 'provider_error',
    });
    expect(state.stepOutputs.get('implement')?.content).toBe(
      'All team leader parts failed: part-1: Upstream model returned 500; part-2: Gateway unavailable',
    );
    expect(state.lastOutput).toMatchObject({
      status: 'error',
      error: 'Upstream model returned 500',
      failureCategory: 'provider_error',
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

    vi.mocked(mockRuleEvaluation).mockReturnValueOnce({ index: 0, method: 'phase3_tag' });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    const output = state.stepOutputs.get('implement');
    expect(output).toBeDefined();
    expect(output!.content).toContain('API done');
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

    vi.mocked(mockRuleEvaluation).mockReturnValueOnce({ index: 0, method: 'phase3_tag' });

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
          cancelPartIds: [],
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
          cancelPartIds: [],
          parts: [],
        },
      }),
    );

    vi.mocked(mockRuleEvaluation).mockReturnValueOnce({ index: 0, method: 'phase3_tag' });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(6);
    const output = state.stepOutputs.get('implement');
    expect(output).toBeDefined();
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

    vi.mocked(mockRuleEvaluation).mockReturnValueOnce({ index: 0, method: 'phase3_tag' });

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

    vi.mocked(mockRuleEvaluation).mockReturnValueOnce({ index: 0, method: 'phase3_tag' });

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

    vi.mocked(mockRuleEvaluation).mockReturnValueOnce({ index: 0, method: 'phase3_tag' });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    const partCall = vi.mocked(runAgent).mock.calls.find(([, , options]) => options?.resolvedProvider === 'opencode');
    expect(partCall).toBeDefined();
    expect(partCall?.[2]?.allowedTools).toEqual(['read', 'bash', 'grep']);
  });

  it('Pi part では part_edit false かつ part_allowed_tools 未指定でも読み取り専用上限を適用する', async () => {
    const config = buildTeamLeaderConfig();
    const step = config.steps[0];
    if (!step?.teamLeader) {
      throw new Error('teamLeader configuration is required');
    }
    step.teamLeader.partPersona = 'coder';
    step.teamLeader.partAllowedTools = undefined;
    step.teamLeader.partEdit = false;
    step.teamLeader.partPermissionMode = 'edit';

    const engine = new WorkflowEngine(config, tmpDir, 'review feature', {
      projectCwd: tmpDir,
      provider: 'claude',
      personaProviders: {
        coder: {
          provider: 'pi',
          model: 'test/model',
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

    vi.mocked(mockRuleEvaluation).mockReturnValueOnce({ index: 0, method: 'phase3_tag' });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    const partCall = vi.mocked(runAgent).mock.calls.find(([persona, , options]) => (
      persona === 'coder' && options?.resolvedProvider === 'pi'
    ));
    expect(partCall).toBeDefined();
    expect(partCall?.[2]?.allowedTools).toEqual(['read', 'grep', 'find', 'ls']);
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

    vi.mocked(mockRuleEvaluation).mockReturnValueOnce({ index: 0, method: 'phase3_tag' });

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

    vi.mocked(mockRuleEvaluation).mockReturnValueOnce({ index: 0, method: 'phase3_tag' });

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

    vi.mocked(mockRuleEvaluation).mockReturnValueOnce({ index: 0, method: 'phase3_tag' });

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

});

describe('WorkflowEngine Integration: team_leader report phase fallback', () => {
  let tmpDir: string;
  let engine: WorkflowEngine | undefined;

  function createReportPhaseStructuredCaller(): StructuredCaller {
    return {
      judgeStatus: async () => {
        throw new Error('judgeStatus should not be called in this test');
      },
      evaluateCondition: async (content, conditions) => {
        for (const condition of conditions) {
          if (content.includes(condition.text)) {
            return condition.index;
          }
        }
        return -1;
      },
      decomposeTask: async (instruction, _maxInitialParts, options) => {
        options.onPromptResolved?.({
          systemPrompt: options.persona ?? 'testing-reviewer',
          userInstruction: instruction,
        });
        return { parts: [
          {
            id: 'part-1',
            title: 'Audit flow',
            instruction: 'Inspect the workflow end-to-end',
          },
        ] };
      },
      requestMoreParts: async () => ({
        done: true,
        reasoning: 'enough coverage',
        cancelPartIds: [],
        parts: [],
      }),
    };
  }

  function createReportPhaseConfig(): WorkflowConfig {
    return {
      name: 'team-leader-report-fallback',
      description: 'Tests team leader report fallback',
      maxSteps: 5,
      initialStep: 'audit',
      steps: [
        {
          name: 'audit',
          persona: 'testing-reviewer',
          personaDisplayName: 'Testing Reviewer',
          instruction: 'Audit task: {task}',
          passPreviousResponse: false,
          teamLeader: {
            maxConcurrency: 1,
            timeoutMs: 1_000,
            partPersona: 'testing-reviewer',
            partEdit: false,
            partPermissionMode: 'readonly',
          },
          outputContracts: [
            {
              name: '02-e2e-audit.md',
              format: '# E2E Audit Report',
            },
          ],
          rules: [
            makeRule('when(true)', 'COMPLETE'),
          ],
        },
      ],
    };
  }

  beforeEach(async () => {
    vi.resetAllMocks();
    applyDefaultMocks();
    // These tests exercise the real report phase, status judgment, and rule
    // evaluation (file-wide mocks are delegated back to the actual modules).
    const actualPhaseRunner = await vi.importActual<typeof import('../core/workflow/phase-runner.js')>(
      '../core/workflow/phase-runner.js',
    );
    vi.mocked(runReportPhase).mockImplementation(actualPhaseRunner.runReportPhase);
    vi.mocked(runStatusJudgmentPhase).mockImplementation(actualPhaseRunner.runStatusJudgmentPhase);
    const actualEvaluation = await vi.importActual<typeof import('../core/workflow/evaluation/index.js')>(
      '../core/workflow/evaluation/index.js',
    );
    vi.mocked(mockRuleEvaluation).mockImplementation((step, selection, context) =>
      new actualEvaluation.RuleEvaluator(step, context).evaluate(selection));
    tmpDir = createTestTmpDir();
  });

  afterEach(() => {
    engine?.removeAllListeners();
    engine = undefined;
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should generate the report in a new session when the team_leader root session is missing', async () => {
    // Given
    const reportDirName = 'test-report-dir';
    const reportPath = join(tmpDir, '.takt', 'runs', reportDirName, 'reports', '02-e2e-audit.md');
    mockRunAgentWithPrompt(
      {
        persona: 'testing-reviewer',
        status: 'done',
        content: 'Part audit finished',
        timestamp: new Date('2026-04-22T01:45:00Z'),
        sessionId: 'part-session-1',
      },
      {
        persona: 'testing-reviewer',
        status: 'done',
        content: '# Audit Report\nEverything passed',
        timestamp: new Date('2026-04-22T01:45:01Z'),
        sessionId: 'report-session-1',
      },
    );
    engine = new WorkflowEngine(createReportPhaseConfig(), tmpDir, 'run audit', {
      projectCwd: tmpDir,
      provider: 'mock',
      reportDirName,
      structuredCaller: createReportPhaseStructuredCaller(),
    });

    // When
    const state = await engine.run();

    // Then
    expect(state.status).toBe('completed');
    expect(readFileSync(reportPath, 'utf-8')).toContain('Everything passed');

    const runAgentMock = vi.mocked(runAgent);
    expect(runAgentMock).toHaveBeenCalledTimes(2);

    const reportInstruction = runAgentMock.mock.calls[1]?.[1] as string;
    const reportOptions = runAgentMock.mock.calls[1]?.[2] as { sessionId?: string };
    expect(reportOptions.sessionId).toBeUndefined();
    expect(reportInstruction).toContain('Part audit finished');
    expect(state.personaSessions.get('["audit.part-1","mock"]')).toBe('part-session-1');
    expect(state.personaSessions.get('["testing-reviewer","mock"]')).toBe('report-session-1');
  });

  it('should record team_leader part and report attempts across retry and fallback providers', async () => {
    // Given
    const reportDirName = 'test-report-dir';
    const reportPath = join(tmpDir, '.takt', 'runs', reportDirName, 'reports', '02-e2e-audit.md');
    const partUsage = {
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
      usageMissing: false as const,
    };
    const firstReportUsage = {
      inputTokens: 13,
      outputTokens: 1,
      totalTokens: 14,
      usageMissing: false as const,
    };
    const retryReportUsage = {
      inputTokens: 17,
      outputTokens: 1,
      totalTokens: 18,
      usageMissing: false as const,
    };
    const fallbackReportUsage = {
      inputTokens: 19,
      outputTokens: 5,
      totalTokens: 24,
      usageMissing: false as const,
    };
    mockRunAgentWithPrompt(
      {
        persona: 'testing-reviewer',
        status: 'done',
        content: 'Part audit finished',
        timestamp: new Date('2026-04-22T01:55:00Z'),
        sessionId: 'part-session-1',
        providerUsage: partUsage,
      },
      {
        persona: 'testing-reviewer',
        status: 'done',
        content: '   ',
        timestamp: new Date('2026-04-22T01:55:01Z'),
        sessionId: 'leader-session',
        providerUsage: firstReportUsage,
      },
      {
        persona: 'testing-reviewer',
        status: 'done',
        content: '   ',
        timestamp: new Date('2026-04-22T01:55:02Z'),
        sessionId: 'report-retry-session',
        providerUsage: retryReportUsage,
      },
      {
        persona: 'testing-reviewer',
        status: 'done',
        content: '# E2E Audit Report\nRecovered with fallback',
        timestamp: new Date('2026-04-22T01:55:03Z'),
        sessionId: 'report-fallback-session',
        providerUsage: fallbackReportUsage,
      },
    );
    const delegatedUsage = vi.fn<(
      context: {
        step: string;
        stepType: 'parallel' | 'team_leader' | 'normal';
        provider: string;
        providerModel: string;
      },
      result: {
        success: boolean;
        usage?: AgentResponse['providerUsage'];
      },
    ) => void>();
    engine = new WorkflowEngine(createReportPhaseConfig(), tmpDir, 'run audit', {
      projectCwd: tmpDir,
      provider: 'opencode',
      model: 'opencode/qwen3-coder-next',
      reportFallbackProvider: {
        provider: 'mock',
        model: 'mock/fallback',
      },
      reportDirName,
      structuredCaller: createReportPhaseStructuredCaller(),
      initialSessions: {
        '["testing-reviewer","opencode","opencode/qwen3-coder-next"]': 'leader-session',
      },
      onDelegatedAgentUsage: delegatedUsage,
    });

    // When
    const state = await engine.run();

    // Then
    expect(state.status).toBe('completed');
    expect(readFileSync(reportPath, 'utf-8')).toContain('Recovered with fallback');
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(4);
    expect(delegatedUsage.mock.calls
      .filter(([, result]) => result.usage !== undefined)
      .map(([context, result]) => ({ context, result }))).toEqual([
      {
        context: {
          step: 'audit.part-1',
          stepType: 'team_leader',
          provider: 'opencode',
          providerModel: 'opencode/qwen3-coder-next',
        },
        result: { success: true, usage: partUsage },
      },
      {
        context: {
          step: 'audit',
          stepType: 'team_leader',
          provider: 'opencode',
          providerModel: 'opencode/qwen3-coder-next',
        },
        result: { success: false, usage: firstReportUsage },
      },
      {
        context: {
          step: 'audit',
          stepType: 'team_leader',
          provider: 'opencode',
          providerModel: 'opencode/qwen3-coder-next',
        },
        result: { success: false, usage: retryReportUsage },
      },
      {
        context: {
          step: 'audit',
          stepType: 'team_leader',
          provider: 'mock',
          providerModel: 'mock/fallback',
        },
        result: { success: true, usage: fallbackReportUsage },
      },
    ]);
  });

});
