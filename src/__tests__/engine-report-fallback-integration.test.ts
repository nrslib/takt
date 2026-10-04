import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { StructuredCaller } from '../agents/structured-caller.js';
import type { RunAgentOptions } from '../agents/runner.js';
import type { AgentResponse, WorkflowConfig } from '../core/models/index.js';
import { WorkflowEngine } from '../core/workflow/index.js';
import type { StreamEvent } from '../shared/types/provider.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';
import { LiveInterventionFileStore } from '../infra/workflow/live-intervention-store.js';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

import { runAgent } from '../agents/runner.js';

function response(overrides: Partial<AgentResponse>): AgentResponse {
  return {
    persona: 'coder',
    status: 'done',
    content: 'done',
    timestamp: new Date('2026-06-28T00:00:00Z'),
    ...overrides,
  };
}

function workflowConfig(): WorkflowConfig {
  return {
    name: 'report-fallback-it',
    maxSteps: 3,
    initialStep: 'implement',
    steps: [{
      name: 'implement',
      persona: 'coder',
      personaDisplayName: 'Coder',
      instruction: 'Implement the task',
      passPreviousResponse: false,
      outputContracts: [{ name: 'review.md', format: '' }],
      rules: [
        normalizeRule({ condition: 'approved', next: 'COMPLETE' }),
        normalizeRule({ condition: 'needs_fix', next: 'ABORT' }),
      ],
    }],
  };
}

function queueAttempt(result: AgentResponse, streamEvents: StreamEvent[] = []): void {
  vi.mocked(runAgent).mockImplementationOnce(async (persona, task, options) => {
    options?.onPromptResolved?.({
      systemPrompt: typeof persona === 'string' ? persona : '',
      userInstruction: task,
    });

    for (const event of streamEvents) {
      options?.onStream?.(event);
    }

    return result;
  });
}

describe('WorkflowEngine report fallback integration', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'takt-report-fallback-it-'));
    vi.mocked(runAgent).mockReset();
  });

  afterEach(() => {
    if (existsSync(tmpRoot)) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it.each([
    { mode: 'next_step', resume: false },
    { mode: 'next_step', resume: true },
    { mode: 'same_session', resume: true },
  ])('preserves dispatched $mode revisions through report creation (resume=$resume)', async ({ mode, resume }) => {
    const store = new LiveInterventionFileStore(tmpRoot, 'live-report-inputs');
    const revision = 'Withdraw the original obligation; replace it with the current requirement.';
    const pending = 'PENDING: this instruction has not been delivered to Phase 1.';
    if (mode === 'next_step') await store.issue(revision);
    let workCalls = 0;
    let reportCalls = 0;
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({ systemPrompt: String(persona), userInstruction: prompt });
      options?.onDispatch?.(options.permissionMode);
      if (options?.allowedTools?.length === 0) {
        reportCalls += 1;
        if (reportCalls === 1) await store.issue(pending);
        return response({ content: resume && reportCalls < 3 ? '' : '# Report\nCurrent requirement recorded.' });
      }
      // Repeated dispatch notifications must not duplicate the same delivery in the report.
      options?.onDispatch?.(options.permissionMode);
      workCalls += 1;
      if (mode === 'same_session' && workCalls === 1) await store.issue(revision);
      return response({ content: 'Implementation and checks completed.', sessionId: resume ? 'work-session' : undefined });
    });
    const structuredCaller: StructuredCaller = {
      judgeStatus: vi.fn().mockImplementation(async (_structured, _tag, _candidates, options) => {
        options.onStructuredPromptResolved?.({ systemPrompt: 'conductor', userInstruction: 'judge' });
        return { candidateIndex: 0, method: 'structured_output' };
      }),
      evaluateCondition: vi.fn(), decomposeTask: vi.fn(), requestMoreParts: vi.fn(),
    };
    const engine = new WorkflowEngine(workflowConfig(), tmpRoot, 'Original obligation', {
      projectCwd: tmpRoot, provider: 'opencode', model: 'opencode/primary-model', reportDirName: 'live-report-inputs',
      reportFallbackProvider: { provider: 'codex', model: 'report-model' }, structuredCaller, liveIntervention: store,
    });
    engine.addUserInput('An earlier ordinary user requirement.');

    expect((await engine.run()).status).toBe('completed');
    const calls = vi.mocked(runAgent).mock.calls;
    const work = calls.filter(([, , options]) => options?.allowedTools?.length !== 0);
    expect(work).toHaveLength(mode === 'same_session' ? 2 : 1);
    const deliveryPrompt = work.at(-1)![1];
    expect(deliveryPrompt).toContain(revision);
    const reports = calls.filter(([, , options]) => options?.allowedTools?.length === 0);
    expect(reports).toHaveLength(resume ? 3 : 1);
    for (const [, prompt, options] of reports) {
      expect(prompt).toContain(revision);
      expect(prompt.split(revision)).toHaveLength(2);
      expect(prompt).toContain('An earlier ordinary user requirement.');
      expect(prompt).toContain('Implementation and checks completed.');
      expect(prompt).not.toContain(pending);
      expect(options?.allowedTools).toEqual([]);
    }
    if (resume) {
      expect(reports[1]![2]?.sessionId).toBeUndefined();
      expect(reports[2]![2]).toMatchObject({ sessionId: undefined, resolvedProvider: 'codex' });
    } else {
      expect(reports[0]![2]?.sessionId).toBeUndefined();
    }
    expect(store.read().instructions.map(({ state }) => state)).toEqual([
      mode === 'same_session' ? 'deliveredSameSession' : 'deliveredNextStep', 'unconsumedWarned',
    ]);
    expect(readFileSync(join(tmpRoot, '.takt', 'runs', 'live-report-inputs', 'reports', 'review.md'), 'utf-8'))
      .toContain('Current requirement recorded.');
  });

  it.each([
    { language: 'ja' as const, resume: false },
    { language: 'en' as const, resume: false },
    { language: 'ja' as const, resume: true },
    { language: 'en' as const, resume: true },
  ])('preserves revisions and conversation contracts with generic work results ($language, resume=$resume)', async ({ language, resume }) => {
    const upstream = 'CONVERSATION-CTR-01: preserve identity; CONVERSATION-CTR-02: send notifications.';
    const revisions = ['Withdraw CONVERSATION-CTR-02: do not send notifications.', 'Replace the initial target with the current target.'];
    const config = workflowConfig();
    config.initialStep = 'plan';
    config.steps.unshift({
      name: 'plan', persona: 'planner', personaDisplayName: 'Planner', instruction: 'Plan the task', passPreviousResponse: false,
      rules: [normalizeRule({ condition: 'planned', next: 'implement' })],
    });
    config.steps[1]!.passPreviousResponse = true;
    queueAttempt(response({ persona: 'planner', content: upstream, sessionId: 'planner-session' }));
    queueAttempt(response({ content: 'Implementation and checks completed.', sessionId: resume ? 'coder-session' : undefined }));
    if (resume) {
      queueAttempt(response({ content: '' }));
      queueAttempt(response({ content: '' }));
    }
    queueAttempt(response({ content: '# Report\nCurrent requirements recorded.', sessionId: 'report-session' }));
    const structuredCaller: StructuredCaller = {
      judgeStatus: vi.fn().mockImplementation(async (_structured, _tag, _candidates, options) => {
        options.onStructuredPromptResolved?.({ systemPrompt: 'conductor-system', userInstruction: 'judge' });
        return { candidateIndex: 0, method: 'structured_output' };
      }),
      evaluateCondition: vi.fn(), decomposeTask: vi.fn(), requestMoreParts: vi.fn(),
    };
    const engine = new WorkflowEngine(config, tmpRoot, 'Initial target: obsolete target', {
      projectCwd: tmpRoot, provider: 'opencode', model: 'opencode/primary-model', language,
      reportFallbackProvider: { provider: 'codex', model: 'report-model' },
      reportDirName: 'conversation-contracts', structuredCaller,
    });
    engine.on('step:complete', (step) => {
      if (step.name === 'plan') for (const revision of revisions) engine.addUserInput(revision);
    });

    expect((await engine.run()).status).toBe('completed');
    const calls = vi.mocked(runAgent).mock.calls;
    const phase1Instruction = calls[1]![1];
    expect(phase1Instruction).toContain(upstream);
    for (const revision of revisions) expect(phase1Instruction).toContain(revision);
    const reportCalls = calls.slice(2);
    expect(reportCalls).toHaveLength(resume ? 3 : 1);
    for (const [, prompt, options] of reportCalls) {
      expect(prompt).toContain('Initial target: obsolete target');
      expect(prompt).toContain(JSON.stringify(revisions));
      expect(prompt).toContain(JSON.stringify(upstream));
      expect(prompt).toContain('Implementation and checks completed.');
      expect(options).toMatchObject({ allowedTools: [] });
    }
    expect(reportCalls[0]![2]?.sessionId).toBe(resume ? 'coder-session' : undefined);
    if (resume) {
      expect(reportCalls[1]![2]?.sessionId).toBeUndefined();
      expect(reportCalls[2]![2]).toMatchObject({ resolvedProvider: 'codex', sessionId: undefined });
    }
    expect(readFileSync(join(tmpRoot, '.takt', 'runs', 'conversation-contracts', 'reports', 'review.md'), 'utf-8'))
      .toContain('Current requirements recorded.');
  });

  it('passes conversation contracts and dispatched revisions to fresh parallel reports and fallback', async () => {
    const upstream = 'PARALLEL-CONTRACT: preserve the current record identity.';
    const revision = 'Withdraw the obsolete parallel obligation.';
    const store = new LiveInterventionFileStore(tmpRoot, 'parallel-report-inputs');
    const liveRevision = 'LIVE PARALLEL: replace the old requirement for both parts.';
    const reportAttempts = new Map<string, number>();
    const config: WorkflowConfig = {
      name: 'parallel-report-inputs', maxSteps: 3, initialStep: 'plan',
      steps: [{
        name: 'plan', persona: 'planner', personaDisplayName: 'Planner', instruction: 'Plan', passPreviousResponse: false,
        rules: [
          normalizeRule({ condition: 'planned', next: 'implement' }),
          normalizeRule({ condition: 'cannot_plan', next: 'ABORT' }),
        ],
      }, {
        name: 'implement', personaDisplayName: 'Implement', instruction: '',
        parallel: ['left', 'right'].map((name) => ({
          name, persona: name, personaDisplayName: name, instruction: 'Implement your part', passPreviousResponse: true,
          outputContracts: [{ name: `${name}.md`, format: '# Part Result' }],
          rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
        })),
        rules: [normalizeRule({ condition: 'all("done")', next: 'COMPLETE' })],
      }],
    };
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({ systemPrompt: String(persona), userInstruction: prompt });
      options?.onDispatch?.(options.permissionMode);
      const isReport = options?.allowedTools?.length === 0;
      const attempt = isReport ? (reportAttempts.get(String(persona)) ?? 0) + 1 : 0;
      if (isReport) reportAttempts.set(String(persona), attempt);
      return response({
        persona: String(persona),
        content: persona === 'planner' ? upstream : isReport ? attempt < 2 ? '' : '# Part report' : 'Part completed.',
      });
    });
    const structuredCaller: StructuredCaller = {
      judgeStatus: vi.fn().mockImplementation(async (_structured, _tag, _candidates, options) => {
        options.onStructuredPromptResolved?.({ systemPrompt: 'conductor', userInstruction: 'judge' });
        if (store.read().issuedTotal === 0) await store.issue(liveRevision);
        return { candidateIndex: 0, method: 'structured_output' };
      }),
      evaluateCondition: vi.fn(), decomposeTask: vi.fn(), requestMoreParts: vi.fn(),
    };
    const engine = new WorkflowEngine(config, tmpRoot, 'Implement current requirements', {
      projectCwd: tmpRoot, provider: 'opencode', model: 'opencode/primary-model', reportDirName: 'parallel-report-inputs', structuredCaller, liveIntervention: store,
      reportFallbackProvider: { provider: 'codex', model: 'report-model' },
    });
    engine.addUserInput(revision);
    expect((await engine.run()).status).toBe('completed');
    const reportCalls = vi.mocked(runAgent).mock.calls.filter(([, , options]) => options?.allowedTools?.length === 0);
    expect(reportCalls).toHaveLength(4);
    for (const [persona, prompt, options] of reportCalls) {
      expect(prompt).toContain(JSON.stringify(upstream));
      expect(prompt).toContain(revision);
      expect(prompt).toContain(liveRevision);
      expect(prompt).toContain('Part completed.');
      expect(options?.sessionId).toBeUndefined();
      expect(readFileSync(join(tmpRoot, '.takt', 'runs', 'parallel-report-inputs', 'reports', `${persona}.md`), 'utf-8'))
        .toBe('# Part report');
    }
  });

  it.each([true, false])('keeps only dispatched team leader revisions in reports (dispatch=%s)', async (dispatch) => {
    const store = new LiveInterventionFileStore(tmpRoot, 'team-live-report-inputs');
    const revisions = ['TEAM INITIAL: withdraw the obsolete obligation.', 'TEAM FEEDBACK: replace the old target.', 'TEAM FOLLOW-UP: retain the current identity.'];
    await store.issue(revisions[0]!);
    let feedbackCalls = 0;
    let reportAttempts = 0;
    const structuredCaller: StructuredCaller = {
      judgeStatus: vi.fn().mockImplementation(async (_structured, _tag, _candidates, options) => {
        options.onStructuredPromptResolved?.({ systemPrompt: 'conductor', userInstruction: 'judge' });
        return { candidateIndex: 0, method: 'structured_output' };
      }),
      evaluateCondition: vi.fn(),
      decomposeTask: vi.fn().mockImplementation(async (instruction, _maxParts, options) => {
        options.onPromptResolved?.({ systemPrompt: 'leader', userInstruction: instruction });
        if (dispatch) options.onDispatch?.(undefined);
        await store.issue(revisions[1]!);
        return { parts: [{ id: 'part-1', title: 'Implementation', instruction: 'Implement the current requirement.' }], sessionId: 'leader-session' };
      }),
      requestMoreParts: vi.fn().mockImplementation(async (instruction, _results, _ids, options) => {
        feedbackCalls += 1;
        if (feedbackCalls > 4) throw new Error('Unexpected unbounded feedback');
        options.onPromptResolved?.({ systemPrompt: 'leader', userInstruction: instruction });
        if (dispatch) options.onDispatch?.(undefined);
        if (feedbackCalls === 1) await store.issue(revisions[2]!);
        return { done: true, reasoning: 'Work completed.', cancelPartIds: [], parts: [], sessionId: 'leader-session' };
      }),
    };
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({ systemPrompt: String(persona), userInstruction: prompt });
      options?.onDispatch?.(options.permissionMode);
      if (options?.allowedTools?.length === 0) {
        reportAttempts += 1;
        return response({ content: reportAttempts < 2 ? '' : '# Team report\nCurrent requirement recorded.' });
      }
      return response({ content: 'Implementation and checks completed.' });
    });
    const config = workflowConfig();
    const step = config.steps[0]!;
    if (step.kind === 'workflow_call') throw new Error('Expected an agent step');
    step.teamLeader = {
      persona: '../personas/team-leader.md', maxConcurrency: 1, timeoutMs: 10000,
      partPersona: '../personas/coder.md', partAllowedTools: ['Read', 'Edit', 'Write'], partEdit: true, partPermissionMode: 'edit',
    };
    const engine = new WorkflowEngine(config, tmpRoot, 'Original team obligation', {
      projectCwd: tmpRoot, provider: 'opencode', model: 'opencode/primary-model', reportDirName: 'team-live-report-inputs', liveIntervention: store,
      structuredCaller, reportFallbackProvider: { provider: 'codex', model: 'report-model' },
    });

    expect((await engine.run()).status).toBe('completed');
    expect(feedbackCalls).toBeGreaterThanOrEqual(2);
    const reports = vi.mocked(runAgent).mock.calls.filter(([, , options]) => options?.allowedTools?.length === 0);
    expect(reports).toHaveLength(2);
    for (const [, prompt, options] of reports) {
      for (const revision of revisions) {
        if (dispatch) expect(prompt).toContain(revision);
        else expect(prompt).not.toContain(revision);
      }
      expect(prompt).toContain('Implementation and checks completed.');
      expect(options?.allowedTools).toEqual([]);
      expect(options?.sessionId).toBeUndefined();
    }
    expect(reports[1]![2]?.resolvedProvider).toBe('codex');
    expect(store.read().instructions.map(({ state }) => state)).toEqual(dispatch
      ? ['deliveredNextStep', 'deliveredSameSession', 'deliveredSameSession']
      : ['unconsumedWarned', 'unconsumedWarned', 'unconsumedWarned']);
    if (dispatch) {
      const deliveredPrompts = [
        vi.mocked(structuredCaller.decomposeTask).mock.calls[0]![0],
        ...vi.mocked(structuredCaller.requestMoreParts).mock.calls.map(([prompt]) => prompt),
      ];
      expect(deliveredPrompts[0]).toContain(revisions[0]);
      expect(deliveredPrompts[1]).toContain(revisions[1]);
      expect(deliveredPrompts[2]).toContain(revisions[2]);
      expect(reports[0]![1].indexOf(revisions[0]!)).toBeLessThan(reports[0]![1].indexOf(revisions[1]!));
    }
  });
  it.each(['credential_binding_changed', 'session_continuation_unsupported'] as const)(
    'aborts on terminal report failure %s without status judgment or fallback', async (failureCategory) => {
      queueAttempt(response({ content: 'Implementation complete', sessionId: 'saved-session' }));
      queueAttempt(response({ status: 'error', content: 'terminal report failure', error: 'terminal report failure', failureCategory }));
      const structuredCaller: StructuredCaller = {
        judgeStatus: vi.fn(), evaluateCondition: vi.fn(), decomposeTask: vi.fn(), requestMoreParts: vi.fn(),
      };
      const engine = new WorkflowEngine(workflowConfig(), tmpRoot, 'Task', {
        projectCwd: tmpRoot, provider: 'deepseek-harness', structuredCaller,
        reportFallbackProvider: { provider: 'codex', model: 'fallback' },
      });
      const state = await engine.run();
      expect(state.status).toBe('aborted');
      expect(runAgent).toHaveBeenCalledTimes(2);
      expect(structuredCaller.judgeStatus).not.toHaveBeenCalled();
    },
  );

  it('should pass configured fallback provider to the final report runAgent call and write the report', async () => {
    queueAttempt(response({
      content: '[IMPLEMENT:1]\nPhase 1 output',
      sessionId: 'opencode-session-1',
    }));
    queueAttempt(response({ content: '# Report\nfirst attempt' }), [{
      type: 'tool_use',
      data: { id: 'tool-1', tool: 'read', input: {} },
    }]);
    queueAttempt(response({ content: '# Report\nretry attempt' }), [{
      type: 'tool_use',
      data: { id: 'tool-2', tool: 'bash', input: {} },
    }]);
    queueAttempt(response({
      content: '# Report\nGenerated by fallback provider',
      sessionId: 'codex-fallback-session',
    }));
    const structuredCaller: StructuredCaller = {
      judgeStatus: vi.fn().mockImplementation(async (_structured, _tag, _candidates, options) => {
        options.onStructuredPromptResolved?.({
          systemPrompt: 'conductor-system',
          userInstruction: 'structured prompt',
        });
        return { candidateIndex: 0, method: 'structured_output' };
      }),
      evaluateCondition: vi.fn(),
      decomposeTask: vi.fn(),
      requestMoreParts: vi.fn(),
    };

    const attemptTelemetry: Array<{
      readonly provider: string;
      readonly providerModel: string;
    }> = [];
    const reportProvenance: Array<{
      readonly provider: string;
      readonly model: string;
    }> = [];
    const engine = new WorkflowEngine(workflowConfig(), tmpRoot, 'Task: implement fallback', {
      projectCwd: tmpRoot,
      provider: 'opencode',
      model: 'opencode/qwen3-coder-next',
      reportFallbackProvider: {
        provider: 'codex',
        model: 'gpt-5-report',
      },
      reportDirName: 'report-fallback-it',
      structuredCaller,
      onDelegatedAgentUsage: (context) => {
        attemptTelemetry.push({
          provider: context.provider,
          providerModel: context.providerModel,
        });
      },
    });
    engine.on('step:report', (_step, _path, _name, context) => {
      reportProvenance.push({
        provider: context.provider,
        model: context.model,
      });
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(readFileSync(join(tmpRoot, '.takt', 'runs', 'report-fallback-it', 'reports', 'review.md'), 'utf-8'))
      .toContain('Generated by fallback provider');
    expect(runAgent).toHaveBeenCalledTimes(4);
    expect(structuredCaller.judgeStatus).toHaveBeenCalledTimes(1);
    expect(structuredCaller.judgeStatus).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      [{ label: 'approved' }, { label: 'needs_fix' }],
      expect.objectContaining({
        stepName: 'implement',
        resolvedProvider: 'opencode',
        resolvedModel: 'opencode/qwen3-coder-next',
      }),
    );

    const fallbackOptions = vi.mocked(runAgent).mock.calls[3]?.[2] as RunAgentOptions;
    expect(fallbackOptions).toEqual(expect.objectContaining({
      resolvedProvider: 'codex',
      resolvedModel: 'gpt-5-report',
      permissionMode: 'readonly',
      allowedTools: [],
      sessionId: undefined,
    }));
    expect(reportProvenance).toEqual([{
      provider: 'opencode',
      model: 'opencode/qwen3-coder-next',
    }]);
    expect(attemptTelemetry).toEqual(expect.arrayContaining([{
      provider: 'codex',
      providerModel: 'gpt-5-report',
    }]));
  });
});
