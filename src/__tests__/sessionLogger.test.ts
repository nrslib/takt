import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { initNdjsonLog } from '../infra/fs/session.js';
import { SessionLogger } from '../features/tasks/execute/sessionLogger.js';
import { buildTraceFromRecords } from '../features/tasks/execute/traceReportParser.js';
import { buildWorkflowStepScopeKey } from '../features/tasks/execute/workflowStepScope.js';
import { AGENT_FAILURE_CATEGORIES } from '../shared/types/agent-failure.js';
import { buildPhaseExecutionId } from '../shared/utils/phaseExecutionId.js';

const tempDirs = new Set<string>();

function createTempLogsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-session-logger-'));
  tempDirs.add(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe('SessionLogger', () => {
  it('subworkflow stack を step/phase records にそのまま書き出す', () => {
    const logsDir = createTempLogsDir();
    const ndjsonPath = initNdjsonLog('session-1', 'task', 'parent', { logsDir });
    const logger = new SessionLogger(ndjsonPath, true);
    const stack = [
      { workflow: 'parent', workflow_ref: 'project:sha256:parent', step: 'delegate', kind: 'workflow_call' as const },
      { workflow: 'takt/coding', workflow_ref: 'project:sha256:child', step: 'review', kind: 'agent' as const },
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
      { workflow: 'shared/workflow', workflow_ref: 'project:sha256:parent', step: 'review', kind: 'workflow_call' as const },
    ];
    const childStack = [
      { workflow: 'shared/workflow', workflow_ref: 'project:sha256:child', step: 'delegate', kind: 'workflow_call' as const },
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

  it('workflow step scope key は : と > を含む名前でも可逆かつ一意である', () => {
    const firstStack = [
      { workflow: 'parent:alpha', step: 'review', kind: 'agent' as const },
    ];
    const secondStack = [
      { workflow: 'parent', step: 'alpha:review', kind: 'agent' as const },
    ];
    const key = buildWorkflowStepScopeKey('review>done', [
      { workflow: 'parent:workflow', step: 'delegate>step', kind: 'workflow_call' as const },
      { workflow: 'child>workflow', step: 'review:step', kind: 'agent' as const },
    ]);

    expect(buildWorkflowStepScopeKey('result', firstStack)).not.toBe(buildWorkflowStepScopeKey('result', secondStack));
    expect(JSON.parse(key)).toEqual({
      step: 'review>done',
      stack: [
        { workflow: 'parent:workflow', step: 'delegate>step', kind: 'workflow_call' },
        { workflow: 'child>workflow', step: 'review:step', kind: 'agent' },
      ],
    });
  });

  it('workflow_ref が異なる同名 workflow でも step scope key は衝突しない', () => {
    const firstStack = [
      { workflow: 'shared/workflow', workflow_ref: 'project:sha256:a', step: 'delegate', kind: 'workflow_call' as const },
    ];
    const secondStack = [
      { workflow: 'shared/workflow', workflow_ref: 'project:sha256:b', step: 'delegate', kind: 'workflow_call' as const },
    ];

    expect(buildWorkflowStepScopeKey('review', firstStack)).not.toBe(buildWorkflowStepScopeKey('review', secondStack));
  });

  it('step_start record includes providerOptions and providerOptionsSources when providerInfo carries them', () => {
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
      providerOptions: { claude: { effort: 'xhigh' } },
      providerOptionsSources: { 'claude.effort': 'step' },
    });

    const records = readFileSync(ndjsonPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const stepStart = records.find((record) => record.type === 'step_start');
    expect(stepStart?.providerOptions).toEqual({ claude: { effort: 'xhigh' } });
    expect(stepStart?.providerOptionsSources).toEqual({ 'claude.effort': 'step' });
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
});
