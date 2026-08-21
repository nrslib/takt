import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { initNdjsonLog, parseNdjsonRecord } from '../infra/fs/session.js';
import { SessionLogger } from '../features/tasks/execute/sessionLogger.js';
import { buildTraceFromRecords } from '../features/tasks/execute/traceReportParser.js';
import { buildWorkflowStepScopeKey } from '../features/tasks/execute/workflowStepScope.js';
import { AGENT_FAILURE_CATEGORIES } from '../shared/types/agent-failure.js';
import { buildPhaseExecutionId } from '../shared/utils/phaseExecutionId.js';
import {
  writePromptLog,
  type PromptLogRecord,
} from '../features/tasks/execute/promptLog.js';

const tempDirs = new Set<string>();

function createTempLogsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-session-logger-'));
  tempDirs.add(dir);
  return dir;
}

function createPromptLogRecord(): PromptLogRecord {
  return {
    step: 'plan',
    phase: 1,
    iteration: 2,
    scope: '{"step":"plan","stack":[]}',
    phaseExecutionId: 'plan:2:1:1',
    systemPrompt: 'system prompt',
    userInstruction: 'prompt text',
    prompt: 'prompt text',
    response: 'response text',
    timestamp: '2026-02-07T00:00:00.000Z',
  };
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe('SessionLogger', () => {
  it('explicit run path へ private prompt record を追記する', () => {
    const logsDir = createTempLogsDir();
    const promptLogPath = join(logsDir, 'run-one', 'logs', 'session-one-prompts.jsonl');
    mkdirSync(join(logsDir, 'run-one', 'logs'), { recursive: true });

    writePromptLog(promptLogPath, createPromptLogRecord());

    expect(JSON.parse(readFileSync(promptLogPath, 'utf-8').trim()))
      .toEqual(createPromptLogRecord());
    if (process.platform !== 'win32') {
      expect(statSync(promptLogPath).mode & 0o777).toBe(0o600);
    }
  });

  it('prompt record の永続化失敗で workflow を中断しない', () => {
    const logsDir = createTempLogsDir();
    const blockingPath = join(logsDir, 'not-a-directory');
    const promptLogPath = join(blockingPath, 'session-one-prompts.jsonl');
    writeFileSync(blockingPath, 'blocking file');

    expect(() => writePromptLog(promptLogPath, createPromptLogRecord()))
      .not.toThrow();
    expect(existsSync(promptLogPath)).toBe(false);
  });

  it('companion review round と queue coalescing を run NDJSON に永続化する', () => {
    const logsDir = createTempLogsDir();
    const ndjsonPath = initNdjsonLog('session-companion', 'task', 'workflow', { logsDir });
    const logger = new SessionLogger(ndjsonPath, false);

    logger.onCompanionReviewRound({
      step: 'implement',
      companion: 'security-reviewer',
      trigger: 'quiet',
      digest: 'digest-2',
      changedLines: 12,
      findingCount: 0,
      reviewerFindings: [],
      acceptedFindings: [],
    });
    logger.onCompanionQueueCoalesced({
      step: 'implement',
      companion: 'security-reviewer',
      replaced: {
        trigger: 'quiet',
        digest: 'digest-1',
        changedLines: 10,
        observedGeneration: 1,
      },
      replacement: {
        trigger: 'quiet',
        digest: 'digest-2',
        changedLines: 12,
        observedGeneration: 2,
      },
    });

    const records = readFileSync(ndjsonPath, 'utf-8')
      .trim()
      .split('\n')
      .map(parseNdjsonRecord);

    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'companion_review_round',
        step: 'implement',
        companion: 'security-reviewer',
        trigger: 'quiet',
        digest: 'digest-2',
        changedLines: 12,
        findingCount: 0,
      }),
      expect.objectContaining({
        type: 'companion_queue_coalesced',
        replaced: expect.objectContaining({ digest: 'digest-1' }),
        replacement: expect.objectContaining({ digest: 'digest-2' }),
      }),
    ]));
  });

  it('Companion の実呼び出し、採否結果、skip理由を run NDJSON に永続化する', () => {
    const logsDir = createTempLogsDir();
    const ndjsonPath = initNdjsonLog('session-companion-audit', 'task', 'workflow', { logsDir });
    const logger = new SessionLogger(ndjsonPath, false);

    logger.onCompanionCall({
      step: 'implement',
      agent: 'security-reviewer',
      purpose: 'reviewer',
      attempt: 1,
      status: 'completed',
      provider: 'mock',
      model: 'mock-model',
      systemPrompt: 'system token=super-secret',
      prompt: 'prompt password=super-secret',
      promptResolved: true,
      response: {
        persona: 'security-reviewer',
        status: 'done',
        content: 'review response',
        structuredOutput: {
          findings: [{ severity: 'must_fix', file: 'src/a.ts', line: 1, finding: 'candidate' }],
          apiKey: 'sk-companion-actual-secret',
          nested: { accessToken: 'nested-access-token-value' },
        },
        sessionId: 'provider-session-1',
        providerUsage: { inputTokens: 10, outputTokens: 2, usageMissing: false },
        timestamp: new Date('2026-08-13T00:00:00.000Z'),
      },
    });
    logger.onCompanionReviewRound({
      step: 'implement',
      companion: 'security-reviewer',
      trigger: 'completion',
      digest: 'digest-1',
      changedLines: 4,
      reviewerFindings: [{
        severity: 'must_fix',
        file: 'src/a.ts',
        line: 1,
        finding: 'candidate',
      }],
      moderator: {
        name: 'moderator',
        invoked: true,
        decisions: [{ action: 'accept', sourceIndex: 0 }],
      },
      acceptedFindings: [{
        severity: 'must_fix',
        file: 'src/a.ts',
        line: 1,
        finding: 'candidate',
      }],
      findingCount: 1,
    });
    logger.onCompanionReviewSkipped({
      step: 'implement',
      companion: 'security-reviewer',
      phase: 'live',
      reason: 'unchanged_digest',
      observedGeneration: 3,
    });

    const records = readFileSync(ndjsonPath, 'utf-8')
      .trim()
      .split('\n')
      .map(parseNdjsonRecord);
    const call = records.find((record) => record.type === 'companion_call');
    const round = records.find((record) => (
      record.type === 'companion_review_round' && record.digest === 'digest-1'
    ));
    const skipped = records.find((record) => record.type === 'companion_review_skipped');

    expect(call).toMatchObject({
      purpose: 'reviewer',
      attempt: 1,
      status: 'completed',
      provider: 'mock',
      sessionIdAvailable: true,
      sessionId: 'provider-session-1',
      response: 'review response',
      structuredOutput: expect.stringContaining('candidate'),
      promptResolved: true,
      usage: expect.objectContaining({ inputTokens: 10, outputTokens: 2, usageMissing: false }),
      systemPrompt: expect.stringContaining('[REDACTED]'),
      prompt: expect.stringContaining('[REDACTED]'),
    });
    expect(call?.type).toBe('companion_call');
    expect(call?.systemPrompt).not.toContain('sk-companion-actual-secret');
    expect(call?.prompt).not.toContain('nested-access-token-value');
    expect(call?.structuredOutput).not.toContain('sk-companion-actual-secret');
    expect(call?.structuredOutput).not.toContain('nested-access-token-value');
    expect(round).toMatchObject({
      reviewerFindings: [expect.objectContaining({ finding: 'candidate' })],
      moderator: expect.objectContaining({ invoked: true }),
      acceptedFindings: [expect.objectContaining({ finding: 'candidate' })],
      findingCount: 1,
    });
    expect(skipped).toMatchObject({
      phase: 'live',
      reason: 'unchanged_digest',
      observedGeneration: 3,
    });
  });

  it.each([
    {
      name: 'completed',
      result: { status: 'completed' as const, returnValue: 'approved' },
      expected: { status: 'completed', returnValue: 'approved' },
    },
    {
      name: 'aborted',
      result: {
        status: 'aborted' as const,
        abortKind: 'iteration_limit' as const,
        abortReason: 'Maximum steps reached',
      },
      expected: {
        status: 'aborted',
        abortKind: 'iteration_limit',
        abortReason: 'Maximum steps reached',
      },
    },
    {
      name: 'failed',
      result: { status: 'failed' as const, reason: 'token=super-secret' },
      expected: { status: 'failed', reason: 'token=[REDACTED]' },
    },
  ])('workflow_call $name lifecycle を NDJSON に永続化する', ({ result, expected }) => {
    const logsDir = createTempLogsDir();
    const ndjsonPath = initNdjsonLog('session-workflow-call', 'task', 'parent', { logsDir });
    const logger = new SessionLogger(ndjsonPath, false);
    const lifecycle = {
      parentWorkflow: 'project:sha256:parent',
      step: 'delegate',
      childWorkflow: 'project:sha256:child',
      callInstance: 2,
      stack: [{
        workflow: 'parent',
        workflow_ref: 'project:sha256:parent',
        step: 'delegate',
        kind: 'workflow_call' as const,
        occurrence: 2,
      }],
    };

    logger.onWorkflowCallStart(lifecycle);
    logger.onWorkflowCallComplete({ ...lifecycle, result });

    const records = readFileSync(ndjsonPath, 'utf-8')
      .trim()
      .split('\n')
      .map(parseNdjsonRecord);
    const start = records.find((record) => record.type === 'workflow_call_start');
    const complete = records.find((record) => record.type === 'workflow_call_complete');

    expect(start).toMatchObject({
      type: 'workflow_call_start',
      workflow: lifecycle.parentWorkflow,
      step: lifecycle.step,
      childWorkflow: lifecycle.childWorkflow,
      callInstance: lifecycle.callInstance,
      stack: lifecycle.stack,
    });
    expect(complete).toMatchObject({
      type: 'workflow_call_complete',
      workflow: lifecycle.parentWorkflow,
      step: lifecycle.step,
      childWorkflow: lifecycle.childWorkflow,
      callInstance: lifecycle.callInstance,
      stack: lifecycle.stack,
      ...expected,
    });
    for (const record of [start, complete]) {
      expect(record).not.toHaveProperty('iteration');
      expect(record).not.toHaveProperty('provider');
      expect(record).not.toHaveProperty('model');
      expect(record).not.toHaveProperty('persona');
    }
  });

  it('subworkflow stack を step/phase records にそのまま書き出す', () => {
    const logsDir = createTempLogsDir();
    const ndjsonPath = initNdjsonLog('session-1', 'task', 'parent', { logsDir });
    const logger = new SessionLogger(ndjsonPath, true);
    const stack = [
      { workflow: 'parent', workflow_ref: 'project:sha256:parent', step: 'reviewers', kind: 'parallel' as const, occurrence: 1 },
      { workflow: 'parent', workflow_ref: 'project:sha256:parent', step: 'delegate', kind: 'workflow_call' as const, occurrence: 1 },
      { workflow: 'takt/coding', workflow_ref: 'project:sha256:child', step: 'review', kind: 'agent' as const, occurrence: 1 },
    ];
    const step = {
      name: 'review',
      kind: 'agent' as const,
      persona: 'reviewer',
      personaDisplayName: 'reviewer',
      instruction: 'Review the task',
      passPreviousResponse: true,
    };
    const phaseExecutionId = buildPhaseExecutionId({
      step: 'review',
      iteration: 2,
      phase: 1,
      sequence: 1,
    });

    logger.onStepStart(step, 2, 'Review the task', stack);
    logger.onPhaseStart(
      step,
      1,
      'execute',
      'Review the task',
      { systemPrompt: 'system', userInstruction: 'Review the task' },
      stack,
      phaseExecutionId,
      2,
    );
    logger.onPhaseComplete(
      step,
      1,
      'execute',
      'done',
      'done',
      undefined,
      stack,
      phaseExecutionId,
      2,
    );
    logger.onStepComplete(
      step,
      {
        persona: 'reviewer',
        status: 'done',
        content: 'done',
        timestamp: new Date('2026-04-13T00:00:00.000Z'),
      },
      'Review the task',
      stack,
    );

    const records = readFileSync(ndjsonPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const stepStart = records.find((record) => record.type === 'step_start');
    const phaseStart = records.find((record) => record.type === 'phase_start');
    const phaseComplete = records.find((record) => record.type === 'phase_complete');
    const stepComplete = records.find((record) => record.type === 'step_complete');

    for (const record of [stepStart, phaseStart, phaseComplete, stepComplete]) {
      expect(record?.workflow).toBe('takt/coding');
      expect(record?.stack).toEqual(stack);
    }
  });

  it('session logger の step scope key を trace parser と往復しても stack 別 step を混同しない', () => {
    const logsDir = createTempLogsDir();
    const ndjsonPath = initNdjsonLog('session-2', 'task', 'parent', { logsDir });
    const logger = new SessionLogger(ndjsonPath, true);
    const parentStack = [
      { workflow: 'shared/workflow', workflow_ref: 'project:sha256:parent', step: 'review', kind: 'workflow_call' as const, occurrence: 1 },
    ];
    const childStack = [
      { workflow: 'shared/workflow', workflow_ref: 'project:sha256:child', step: 'delegate', kind: 'workflow_call' as const, occurrence: 1 },
    ];
    const step = {
      name: 'review',
      kind: 'agent' as const,
      persona: 'reviewer',
      personaDisplayName: 'reviewer',
      instruction: 'Review the task',
      passPreviousResponse: true,
    };

    logger.onStepStart(step, 3, 'Parent review', parentStack);
    logger.onStepComplete(
      step,
      {
        persona: 'planner',
        status: 'done',
        content: 'parent-ok',
        timestamp: new Date('2026-04-13T00:00:01.000Z'),
      },
      'Parent review',
      parentStack,
    );

    logger.onStepStart(step, 4, 'Child review', childStack);
    logger.onStepComplete(
      step,
      {
        persona: 'reviewer',
        status: 'done',
        content: 'child-ok',
        timestamp: new Date('2026-04-13T00:00:02.000Z'),
      },
      'Child review',
      childStack,
    );

    const trace = buildTraceFromRecords(
      logger.getNdjsonRecords(),
      [],
      '2026-04-13T00:00:03.000Z',
    );

    expect(trace.steps).toHaveLength(2);
    expect(trace.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        step: 'review',
        iteration: 3,
        stack: parentStack,
        result: expect.objectContaining({ content: 'parent-ok' }),
      }),
      expect.objectContaining({
        step: 'review',
        iteration: 4,
        stack: childStack,
        result: expect.objectContaining({ content: 'child-ok' }),
      }),
    ]));
  });

  it('debug prompt と trace parser は同名 parallel child を scope で相関する', () => {
    const logsDir = createTempLogsDir();
    const ndjsonPath = initNdjsonLog(
      'session-parallel-prompts',
      'task',
      'parent',
      { logsDir },
    );
    const promptLogPath = join(logsDir, 'session-parallel-prompts-prompts.jsonl');
    const logger = new SessionLogger(ndjsonPath, true, promptLogPath);
    const step = {
      name: 'review',
      kind: 'agent' as const,
      persona: 'reviewer',
      personaDisplayName: 'reviewer',
      instruction: 'Review',
      passPreviousResponse: true,
    };
    const slowStack = [
      {
        workflow: 'parent',
        workflow_ref: 'project:sha256:parent',
        step: 'slow-delegate',
        kind: 'workflow_call' as const,
        occurrence: 1,
      },
      {
        workflow: 'shared-child',
        workflow_ref: 'project:sha256:shared-child',
        step: 'review',
        kind: 'agent' as const,
        occurrence: 1,
      },
    ];
    const fastStack = [
      {
        workflow: 'parent',
        workflow_ref: 'project:sha256:parent',
        step: 'fast-delegate',
        kind: 'workflow_call' as const,
        occurrence: 1,
      },
      {
        workflow: 'shared-child',
        workflow_ref: 'project:sha256:shared-child',
        step: 'review',
        kind: 'agent' as const,
        occurrence: 1,
      },
    ];
    const phaseExecutionId = buildPhaseExecutionId({
      step: 'review',
      iteration: 1,
      phase: 1,
      sequence: 1,
    });

    logger.onStepStart(step, 1, 'slow', slowStack);
    logger.onPhaseStart(
      step,
      1,
      'execute',
      'slow',
      { systemPrompt: 'slow-system', userInstruction: 'slow-user' },
      slowStack,
      phaseExecutionId,
      1,
    );
    logger.onStepStart(step, 1, 'fast', fastStack);
    logger.onPhaseStart(
      step,
      1,
      'execute',
      'fast',
      { systemPrompt: 'fast-system', userInstruction: 'fast-user' },
      fastStack,
      phaseExecutionId,
      1,
    );
    logger.onPhaseComplete(
      step,
      1,
      'execute',
      'fast-response',
      'done',
      undefined,
      fastStack,
      phaseExecutionId,
      1,
    );
    logger.onStepComplete(step, {
      persona: 'reviewer',
      status: 'done',
      content: 'fast-response',
      timestamp: new Date('2026-04-13T00:00:01.000Z'),
    }, 'fast', fastStack);
    logger.onPhaseComplete(
      step,
      1,
      'execute',
      'slow-response',
      'done',
      undefined,
      slowStack,
      phaseExecutionId,
      1,
    );
    logger.onStepComplete(step, {
      persona: 'reviewer',
      status: 'done',
      content: 'slow-response',
      timestamp: new Date('2026-04-13T00:00:02.000Z'),
    }, 'slow', slowStack);

    const promptRecords = readFileSync(promptLogPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)) as ReturnType<SessionLogger['getPromptRecords']>;
    expect(promptRecords).toEqual(logger.getPromptRecords());
    expect(promptRecords.map((record) => ({
      scope: record.scope,
      systemPrompt: record.systemPrompt,
      response: record.response,
    }))).toEqual([
      {
        scope: buildWorkflowStepScopeKey('review', fastStack),
        systemPrompt: 'fast-system',
        response: 'fast-response',
      },
      {
        scope: buildWorkflowStepScopeKey('review', slowStack),
        systemPrompt: 'slow-system',
        response: 'slow-response',
      },
    ]);

    const trace = buildTraceFromRecords(
      logger.getNdjsonRecords(),
      promptRecords,
      '2026-04-13T00:00:03.000Z',
    );
    expect(trace.steps.map((traceStep) => ({
      stack: traceStep.stack,
      systemPrompt: traceStep.phases[0]?.systemPrompt,
      response: traceStep.phases[0]?.response,
    }))).toEqual(expect.arrayContaining([
      {
        stack: slowStack,
        systemPrompt: 'slow-system',
        response: 'slow-response',
      },
      {
        stack: fastStack,
        systemPrompt: 'fast-system',
        response: 'fast-response',
      },
    ]));
  });

  it('workflow step scope key は : と > を含む名前でも可逆かつ一意である', () => {
    const firstStack = [
      { workflow: 'parent:alpha', workflow_ref: 'project:sha256:parent-alpha', step: 'review', kind: 'agent' as const, occurrence: 1 },
    ];
    const secondStack = [
      { workflow: 'parent', workflow_ref: 'project:sha256:parent', step: 'alpha:review', kind: 'agent' as const, occurrence: 1 },
    ];
    const key = buildWorkflowStepScopeKey('review>done', [
      { workflow: 'parent:workflow', workflow_ref: 'project:sha256:parent-workflow', step: 'delegate>step', kind: 'workflow_call' as const, occurrence: 1 },
      { workflow: 'child>workflow', workflow_ref: 'project:sha256:child-workflow', step: 'review:step', kind: 'agent' as const, occurrence: 1 },
    ]);

    expect(buildWorkflowStepScopeKey('result', firstStack)).not.toBe(buildWorkflowStepScopeKey('result', secondStack));
    expect(JSON.parse(key)).toEqual({
      step: 'review>done',
      stack: [
        { workflow: 'parent:workflow', workflow_ref: 'project:sha256:parent-workflow', step: 'delegate>step', kind: 'workflow_call', occurrence: 1 },
        { workflow: 'child>workflow', workflow_ref: 'project:sha256:child-workflow', step: 'review:step', kind: 'agent', occurrence: 1 },
      ],
    });
  });

  it('workflow_ref が異なる同名 workflow でも step scope key は衝突しない', () => {
    const firstStack = [
      { workflow: 'shared/workflow', workflow_ref: 'project:sha256:a', step: 'delegate', kind: 'workflow_call' as const, occurrence: 1 },
    ];
    const secondStack = [
      { workflow: 'shared/workflow', workflow_ref: 'project:sha256:b', step: 'delegate', kind: 'workflow_call' as const, occurrence: 1 },
    ];

    expect(buildWorkflowStepScopeKey('review', firstStack)).not.toBe(buildWorkflowStepScopeKey('review', secondStack));
  });

  it('同一workflow_callの別occurrenceはstep scope keyが衝突しない', () => {
    const firstStack = [{
      workflow: 'shared/workflow',
      workflow_ref: 'project:sha256:shared',
      step: 'delegate',
      kind: 'workflow_call' as const,
      occurrence: 1,
    }];
    const secondStack = [{ ...firstStack[0]!, occurrence: 2 }];

    expect(buildWorkflowStepScopeKey('review', firstStack))
      .not.toBe(buildWorkflowStepScopeKey('review', secondStack));
  });

  it('step_start record includes redacted providerOptions and providerOptionsSources when providerInfo carries them', () => {
    const logsDir = createTempLogsDir();
    const ndjsonPath = initNdjsonLog('session-opts', 'task', 'wf', { logsDir });
    const logger = new SessionLogger(ndjsonPath, true);
    const step = {
      name: 'plan',
      kind: 'agent' as const,
      persona: 'planner',
      personaDisplayName: 'planner',
      instruction: 'Plan it',
      passPreviousResponse: true,
    };

    logger.onStepStart(step, 1, 'Plan it', undefined, {
      provider: 'claude',
      providerSource: 'global',
      model: 'claude-opus-4-7',
      modelSource: 'global',
      providerOptions: {
        claude: {
          baseUrl: 'http://user:token@127.0.0.1:8787?api_key=secret',
          effort: 'xhigh',
        },
      },
      providerOptionsSources: { 'claude.baseUrl': 'project', 'claude.effort': 'step' },
    });

    const records = readFileSync(ndjsonPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const stepStart = records.find((record) => record.type === 'step_start');
    expect(stepStart?.providerOptions).toEqual({
      claude: {
        baseUrl: '[configured]',
        effort: 'xhigh',
      },
    });
    expect(stepStart?.providerOptionsSources).toEqual({ 'claude.baseUrl': 'project', 'claude.effort': 'step' });
  });

  it('step_start record includes provider/model/source when providerInfo is given (#370)', () => {
    const logsDir = createTempLogsDir();
    const ndjsonPath = initNdjsonLog('session-source', 'task', 'wf', { logsDir });
    const logger = new SessionLogger(ndjsonPath, true);
    const step = {
      name: 'plan',
      kind: 'agent' as const,
      persona: 'planner',
      personaDisplayName: 'planner',
      instruction: 'Plan it',
      passPreviousResponse: true,
    };

    logger.onStepStart(step, 1, 'Plan it', undefined, {
      provider: 'claude',
      providerSource: 'cli',
      model: 'claude-opus-4-7',
      modelSource: 'step',
    });

    const records = readFileSync(ndjsonPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const stepStart = records.find((record) => record.type === 'step_start');
    expect(stepStart?.provider).toBe('claude');
    expect(stepStart?.providerSource).toBe('cli');
    expect(stepStart?.model).toBe('claude-opus-4-7');
    expect(stepStart?.modelSource).toBe('step');
  });

  it('step_start record omits provider/model fields when providerInfo is absent', () => {
    const logsDir = createTempLogsDir();
    const ndjsonPath = initNdjsonLog('session-no-source', 'task', 'wf', { logsDir });
    const logger = new SessionLogger(ndjsonPath, true);
    const step = {
      name: 'plan',
      kind: 'agent' as const,
      persona: 'planner',
      personaDisplayName: 'planner',
      instruction: 'Plan it',
      passPreviousResponse: true,
    };

    logger.onStepStart(step, 1, 'Plan it', undefined);

    const records = readFileSync(ndjsonPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const stepStart = records.find((record) => record.type === 'step_start');
    expect(stepStart).not.toHaveProperty('provider');
    expect(stepStart).not.toHaveProperty('providerSource');
    expect(stepStart).not.toHaveProperty('model');
    expect(stepStart).not.toHaveProperty('modelSource');
  });

  it('step_complete の failureCategory を NDJSON と trace parser へ保持する', () => {
    const logsDir = createTempLogsDir();
    const ndjsonPath = initNdjsonLog('session-failure-category', 'task', 'workflow', { logsDir });
    const logger = new SessionLogger(ndjsonPath, true);
    const step = {
      name: 'implement',
      kind: 'agent' as const,
      persona: 'coder',
      personaDisplayName: 'coder',
      instruction: 'Implement it',
      passPreviousResponse: true,
    };

    logger.onStepStart(step, 1, 'Implement it');
    logger.onStepComplete(
      step,
      {
        persona: 'coder',
        status: 'error',
        content: 'Gateway unavailable',
        error: 'Gateway unavailable',
        failureCategory: AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR,
        timestamp: new Date('2026-04-13T00:00:00.000Z'),
      },
      'Implement it',
      undefined,
    );

    const records = readFileSync(ndjsonPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const stepComplete = records.find((record) => record.type === 'step_complete');
    const trace = buildTraceFromRecords(
      logger.getNdjsonRecords(),
      [],
      '2026-04-13T00:00:01.000Z',
    );

    expect(stepComplete?.failureCategory).toBe(AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR);
    expect(trace.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        step: 'implement',
        result: expect.objectContaining({
          failureCategory: AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR,
        }),
      }),
    ]));
  });

  it('workflow_abort の failureCategory を NDJSON に保持する', () => {
    const logsDir = createTempLogsDir();
    const ndjsonPath = initNdjsonLog('session-abort-category', 'task', 'workflow', { logsDir });
    const logger = new SessionLogger(ndjsonPath, true);
    const state = {
      workflowName: 'workflow',
      currentStep: 'implement',
      iteration: 1,
      stepOutputs: new Map(),
      structuredOutputs: new Map(),
      systemContexts: new Map(),
      effectResults: new Map(),
      userInputs: [],
      personaSessions: new Map(),
      stepIterations: new Map(),
      status: 'aborted' as const,
    };

    logger.onWorkflowAbort(
      state,
      'provider stream parse error: invalid line',
      AGENT_FAILURE_CATEGORIES.PROVIDER_STREAM_PARSE_ERROR,
    );

    const persistedLines = readFileSync(ndjsonPath, 'utf-8').trim().split('\n');
    const workflowAbort = JSON.parse(
      persistedLines.at(-1) ?? '{}',
    ) as Record<string, unknown>;
    expect(workflowAbort).toMatchObject({
      type: 'workflow_abort',
      failureCategory: AGENT_FAILURE_CATEGORIES.PROVIDER_STREAM_PARSE_ERROR,
    });
  });
});
