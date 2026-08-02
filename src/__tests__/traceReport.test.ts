import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderTraceReportMarkdown, renderTraceReportFromLogs } from '../features/tasks/execute/traceReport.js';
import { buildTraceFromRecords } from '../features/tasks/execute/traceReportParser.js';
import { buildPhaseExecutionId } from '../shared/utils/phaseExecutionId.js';
import type { NdjsonRecord } from '../shared/utils/types.js';

describe('traceReport', () => {
  it('should keep parallel workflow-call phase traces independent for identical child step names', () => {
    const firstStack = [{
      workflow: 'parent',
      step: 'delegate',
      kind: 'workflow_call' as const,
      call_instance: 1,
    }];
    const secondStack = [{
      workflow: 'parent',
      step: 'delegate',
      kind: 'workflow_call' as const,
      call_instance: 2,
    }];
    const firstId = buildPhaseExecutionId({
      step: 'review', iteration: 2, phase: 1, sequence: 1, workflowStack: firstStack,
    });
    const secondId = buildPhaseExecutionId({
      step: 'review', iteration: 2, phase: 1, sequence: 1, workflowStack: secondStack,
    });
    const records = [
      { type: 'step_start', step: 'review', persona: 'reviewer', iteration: 2, stack: firstStack, timestamp: '2026-03-04T11:59:01.000Z' },
      { type: 'step_start', step: 'review', persona: 'reviewer', iteration: 2, stack: secondStack, timestamp: '2026-03-04T11:59:02.000Z' },
      { type: 'phase_start', step: 'review', iteration: 2, phase: 1, phaseName: 'execute', phaseExecutionId: firstId, stack: firstStack, instruction: 'first', timestamp: '2026-03-04T11:59:03.000Z' },
      { type: 'phase_start', step: 'review', iteration: 2, phase: 1, phaseName: 'execute', phaseExecutionId: secondId, stack: secondStack, instruction: 'second', timestamp: '2026-03-04T11:59:04.000Z' },
      { type: 'phase_complete', step: 'review', iteration: 2, phase: 1, phaseName: 'execute', phaseExecutionId: secondId, stack: secondStack, status: 'done', content: 'second response', timestamp: '2026-03-04T11:59:05.000Z' },
      { type: 'phase_complete', step: 'review', iteration: 2, phase: 1, phaseName: 'execute', phaseExecutionId: firstId, stack: firstStack, status: 'done', content: 'first response', timestamp: '2026-03-04T11:59:06.000Z' },
    ] as NdjsonRecord[];

    const trace = buildTraceFromRecords(records, [], '2026-03-04T12:00:00.000Z');

    expect(firstId).not.toBe(secondId);
    expect(trace.steps).toHaveLength(2);
    expect(trace.steps.map((step) => step.phases[0]?.response)).toEqual([
      'first response',
      'second response',
    ]);
  });

  it('should recover an omitted phase completion iteration from an encoded special-character step id', () => {
    const phaseExecutionId = buildPhaseExecutionId({
      step: 'child:review',
      iteration: 4,
      phase: 1,
      sequence: 1,
    });
    const records = [
      {
        type: 'phase_start',
        step: 'child:review',
        iteration: 4,
        phase: 1,
        phaseName: 'execute',
        phaseExecutionId,
        instruction: 'review',
        timestamp: '2026-03-04T11:59:03.000Z',
      },
      {
        type: 'phase_complete',
        step: 'child:review',
        phase: 1,
        phaseName: 'execute',
        phaseExecutionId,
        status: 'done',
        content: 'reviewed',
        timestamp: '2026-03-04T11:59:04.000Z',
      },
    ] as NdjsonRecord[];

    const trace = buildTraceFromRecords(records, [], '2026-03-04T12:00:00.000Z');

    expect(trace.steps[0]).toMatchObject({
      step: 'child:review',
      iteration: 4,
      phases: [{ phaseExecutionId, response: 'reviewed' }],
    });
  });

  it('should render judge stage details and tolerate aborted incomplete step', () => {
    const markdown = renderTraceReportMarkdown(
      {
        tracePath: '/tmp/trace.md',
        workflowName: 'test-workflow',
        task: 'test task',
        runSlug: 'run-1',
        status: 'aborted',
        iterations: 1,
        endTime: '2026-03-04T12:00:00.000Z',
        reason: 'user_interrupted',
      },
      '2026-03-04T11:59:00.000Z',
      [
        {
          step: 'ai_fix',
          persona: 'coder',
          iteration: 1,
          startedAt: '2026-03-04T11:59:01.000Z',
          phases: [
            {
              phaseExecutionId: 'ai_fix:3:1',
              phase: 3,
              phaseName: 'judge',
              instruction: 'judge prompt',
              systemPrompt: 'conductor',
              userInstruction: 'judge prompt',
              startedAt: '2026-03-04T11:59:02.000Z',
              judgeStages: [
                {
                  stage: 1,
                  method: 'structured_output',
                  status: 'error',
                  instruction: 'stage1 prompt',
                  response: '',
                },
              ],
            },
          ],
        },
      ],
      [],
    );

    expect(markdown).toContain('- Status: ❌ aborted');
    expect(markdown).toContain('- Step Status: in_progress');
    expect(markdown).toContain('## Iteration 1: ai_fix (persona: coder)');
    expect(markdown).toContain('<details><summary>System Prompt</summary>');
    expect(markdown).toContain('<details><summary>User Instruction</summary>');
    expect(markdown).toContain('- Stage 1 (structured_output)');
    expect(markdown).toContain('<details><summary>Stage Instruction</summary>');
    expect(markdown).toContain('<details><summary>Stage Response</summary>');
  });

  it('should render steps in timestamp order from NDJSON logs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-report-'));
    const sessionPath = join(dir, 'session.jsonl');
    const promptPath = join(dir, 'prompts.jsonl');
    writeFileSync(sessionPath, [
      JSON.stringify({ type: 'workflow_start', task: 'task', workflowName: 'workflow', startTime: '2026-03-04T11:59:00.000Z' }),
      JSON.stringify({ type: 'step_start', step: 'reviewers', persona: 'reviewer', iteration: 2, timestamp: '2026-03-04T11:59:05.000Z' }),
      JSON.stringify({ type: 'step_start', step: 'plan', persona: 'planner', iteration: 1, timestamp: '2026-03-04T11:59:01.000Z' }),
      JSON.stringify({ type: 'phase_start', step: 'reviewers', iteration: 2, phase: 1, phaseName: 'execute', phaseExecutionId: 'reviewers:2:1:1', instruction: 'r', timestamp: '2026-03-04T11:59:06.000Z' }),
      JSON.stringify({ type: 'phase_complete', step: 'reviewers', iteration: 2, phase: 1, phaseName: 'execute', phaseExecutionId: 'reviewers:2:1:1', status: 'done', content: 'r-ok', timestamp: '2026-03-04T11:59:07.000Z' }),
      JSON.stringify({ type: 'step_complete', step: 'reviewers', persona: 'reviewer', iteration: 2, status: 'done', content: 'r-ok', instruction: 'inst', timestamp: '2026-03-04T11:59:08.000Z' }),
      JSON.stringify({ type: 'phase_start', step: 'plan', iteration: 1, phase: 1, phaseName: 'execute', phaseExecutionId: 'plan:1:1:1', instruction: 'p', timestamp: '2026-03-04T11:59:02.000Z' }),
      JSON.stringify({ type: 'phase_complete', step: 'plan', iteration: 1, phase: 1, phaseName: 'execute', phaseExecutionId: 'plan:1:1:1', status: 'done', content: 'p-ok', timestamp: '2026-03-04T11:59:03.000Z' }),
      JSON.stringify({ type: 'step_complete', step: 'plan', persona: 'planner', iteration: 1, status: 'done', content: 'p-ok', instruction: 'inst', timestamp: '2026-03-04T11:59:04.000Z' }),
      JSON.stringify({ type: 'workflow_complete', iterations: 2, endTime: '2026-03-04T12:00:00.000Z' }),
      '',
    ].join('\n'));
    writeFileSync(promptPath, [
      JSON.stringify({ step: 'plan', phase: 1, iteration: 1, phaseExecutionId: 'plan:1:1:1', prompt: 'p', systemPrompt: 'ps', userInstruction: 'pu', response: 'p-ok', timestamp: '2026-03-04T11:59:03.000Z' }),
      JSON.stringify({ step: 'reviewers', phase: 1, iteration: 2, phaseExecutionId: 'reviewers:2:1:1', prompt: 'r', systemPrompt: 'rs', userInstruction: 'ru', response: 'r-ok', timestamp: '2026-03-04T11:59:07.000Z' }),
      '',
    ].join('\n'));

    const markdown = renderTraceReportFromLogs(
      {
        tracePath: join(dir, 'trace.md'),
        workflowName: 'workflow',
        task: 'task',
        runSlug: 'run-1',
        status: 'completed',
        iterations: 2,
        endTime: '2026-03-04T12:00:00.000Z',
      },
      sessionPath,
      promptPath,
      'full',
    );

    expect(markdown).toBeDefined();
    const planIndex = markdown!.indexOf('## Iteration 1: plan');
    const reviewersIndex = markdown!.indexOf('## Iteration 2: reviewers');
    expect(planIndex).toBeGreaterThan(-1);
    expect(reviewersIndex).toBeGreaterThan(planIndex);
  });

  it('should render failure category from NDJSON step_complete records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-report-failure-category-'));
    const sessionPath = join(dir, 'session.jsonl');
    writeFileSync(sessionPath, [
      JSON.stringify({ type: 'workflow_start', task: 'task', workflowName: 'workflow', startTime: '2026-03-04T11:59:00.000Z' }),
      JSON.stringify({ type: 'step_start', step: 'implement', persona: 'coder', iteration: 1, timestamp: '2026-03-04T11:59:01.000Z' }),
      JSON.stringify({
        type: 'step_complete',
        step: 'implement',
        persona: 'coder',
        iteration: 1,
        status: 'error',
        content: 'Gateway unavailable',
        error: 'Gateway unavailable',
        failureCategory: 'provider_error',
        instruction: 'inst',
        timestamp: '2026-03-04T11:59:02.000Z',
      }),
      JSON.stringify({ type: 'workflow_complete', iterations: 1, endTime: '2026-03-04T12:00:00.000Z' }),
      '',
    ].join('\n'));

    const markdown = renderTraceReportFromLogs(
      {
        tracePath: join(dir, 'trace.md'),
        workflowName: 'workflow',
        task: 'task',
        runSlug: 'run-1',
        status: 'completed',
        iterations: 1,
        endTime: '2026-03-04T12:00:00.000Z',
      },
      sessionPath,
      undefined,
      'full',
    );

    expect(markdown).toContain('- Failure Category: provider_error');
  });

  it('should render a child agent step with its workflow_call stack without a wrapper agent step', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-report-stack-'));
    const sessionPath = join(dir, 'session.jsonl');
    writeFileSync(sessionPath, [
      JSON.stringify({ type: 'workflow_start', task: 'task', workflowName: 'parent', startTime: '2026-03-04T11:59:00.000Z' }),
      JSON.stringify({
        type: 'step_start',
        step: 'review',
        workflow: 'child',
        stack: [
          { workflow: 'parent', step: 'delegate', kind: 'workflow_call', call_instance: 1 },
          { workflow: 'child', step: 'review', kind: 'agent' },
        ],
        persona: 'reviewer',
        iteration: 1,
        timestamp: '2026-03-04T11:59:03.000Z',
      }),
      JSON.stringify({
        type: 'step_complete',
        step: 'review',
        workflow: 'child',
        stack: [
          { workflow: 'parent', step: 'delegate', kind: 'workflow_call', call_instance: 1 },
          { workflow: 'child', step: 'review', kind: 'agent' },
        ],
        persona: 'reviewer',
        iteration: 1,
        status: 'done',
        content: 'child-ok',
        instruction: 'inst',
        timestamp: '2026-03-04T11:59:04.000Z',
      }),
      JSON.stringify({ type: 'workflow_complete', iterations: 1, endTime: '2026-03-04T12:00:00.000Z' }),
      '',
    ].join('\n'));

    const markdown = renderTraceReportFromLogs(
      {
        tracePath: join(dir, 'trace.md'),
        workflowName: 'parent',
        task: 'task',
        runSlug: 'run-1',
        status: 'completed',
        iterations: 1,
        endTime: '2026-03-04T12:00:00.000Z',
      },
      sessionPath,
      undefined,
      'full',
    );

    expect(markdown).toContain('child-ok');
    expect(markdown).toContain('## Iteration 1: review');
  });

  it('should render workflow_call lifecycle without creating a synthetic iteration section', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-report-workflow-call-lifecycle-'));
    const sessionPath = join(dir, 'session.jsonl');
    const stack = [
      { workflow: 'parent', step: 'delegate', kind: 'workflow_call', call_instance: 1 },
    ];
    const records = [
      { type: 'workflow_start', task: 'task', workflowName: 'parent', startTime: '2026-03-04T11:59:00.000Z' },
      {
        type: 'workflow_call_start',
        workflow: 'parent',
        step: 'delegate',
        childWorkflow: 'shared/review',
        callInstance: 1,
        stack,
        timestamp: '2026-03-04T11:59:01.000Z',
      },
      {
        type: 'step_start',
        step: 'review',
        workflow: 'shared/review',
        stack: [...stack, { workflow: 'shared/review', step: 'review', kind: 'agent' }],
        persona: 'reviewer',
        iteration: 1,
        timestamp: '2026-03-04T11:59:02.000Z',
      },
      {
        type: 'step_complete',
        step: 'review',
        workflow: 'shared/review',
        stack: [...stack, { workflow: 'shared/review', step: 'review', kind: 'agent' }],
        persona: 'reviewer',
        iteration: 1,
        status: 'done',
        content: 'reviewed',
        instruction: 'Review',
        timestamp: '2026-03-04T11:59:03.000Z',
      },
      {
        type: 'workflow_call_complete',
        workflow: 'parent',
        step: 'delegate',
        childWorkflow: 'shared/review',
        callInstance: 1,
        stack,
        status: 'completed',
        returnValue: 'child-return-ok',
        timestamp: '2026-03-04T11:59:04.000Z',
      },
      { type: 'workflow_complete', iterations: 1, endTime: '2026-03-04T12:00:00.000Z' },
    ] as NdjsonRecord[];
    writeFileSync(sessionPath, [...records.map((record) => JSON.stringify(record)), ''].join('\n'));

    const trace = buildTraceFromRecords(records, [], '2026-03-04T12:00:00.000Z');

    const markdown = renderTraceReportFromLogs(
      {
        tracePath: join(dir, 'trace.md'),
        workflowName: 'parent',
        task: 'task',
        runSlug: 'run-1',
        status: 'completed',
        iterations: 1,
        endTime: '2026-03-04T12:00:00.000Z',
      },
      sessionPath,
      undefined,
      'full',
    );

    expect(markdown).toContain('delegate#1');
    expect(markdown).toContain('shared/review');
    expect(markdown).toContain('Call Stack: parent/delegate#1');
    expect(markdown).toContain('child-return-ok');
    expect(markdown).toContain('## Iteration 1: review');
    expect(trace.steps.map((step) => ({ step: step.step, iteration: step.iteration }))).toEqual([
      { step: 'review', iteration: 1 },
    ]);
    expect(trace.workflowCalls).toEqual([
      expect.objectContaining({
        parentWorkflow: 'parent',
        step: 'delegate',
        childWorkflow: 'shared/review',
        callInstance: 1,
      }),
    ]);
  });

  it('should fail fast when completed trace has missing phase status', () => {
    expect(() => renderTraceReportMarkdown(
      {
        tracePath: '/tmp/trace.md',
        workflowName: 'test-workflow',
        task: 'test task',
        runSlug: 'run-1',
        status: 'completed',
        iterations: 1,
        endTime: '2026-03-04T12:00:00.000Z',
      },
      '2026-03-04T11:59:00.000Z',
      [
        {
          step: 'plan',
          persona: 'planner',
          iteration: 1,
          startedAt: '2026-03-04T11:59:01.000Z',
          phases: [
            {
              phaseExecutionId: 'plan:1:1',
              phase: 1,
              phaseName: 'execute',
              instruction: 'instr',
              systemPrompt: 'system',
              userInstruction: 'user',
              startedAt: '2026-03-04T11:59:02.000Z',
              completedAt: '2026-03-04T11:59:03.000Z',
            },
          ],
        },
      ],
      [],
    )).toThrow('missing status');
  });

  it('should mask sensitive task and reason in redacted mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-report-redact-'));
    const sessionPath = join(dir, 'session.jsonl');
    writeFileSync(sessionPath, [
      JSON.stringify({ type: 'workflow_start', task: 'token=topsecret', workflowName: 'workflow', startTime: '2026-03-04T11:59:00.000Z' }),
      JSON.stringify({ type: 'step_start', step: 'plan', persona: 'planner', iteration: 1, timestamp: '2026-03-04T11:59:01.000Z' }),
      JSON.stringify({ type: 'phase_start', step: 'plan', iteration: 1, phase: 1, phaseName: 'execute', phaseExecutionId: 'plan:1:1:1', instruction: 'api_key=abc123', systemPrompt: 'Authorization: Bearer abc123', userInstruction: 'user token=abc123', timestamp: '2026-03-04T11:59:02.000Z' }),
      JSON.stringify({ type: 'phase_complete', step: 'plan', iteration: 1, phase: 1, phaseName: 'execute', phaseExecutionId: 'plan:1:1:1', status: 'done', content: 'password=hunter2', timestamp: '2026-03-04T11:59:03.000Z' }),
      JSON.stringify({ type: 'step_complete', step: 'plan', persona: 'planner', iteration: 1, status: 'done', content: 'secret=my-secret', instruction: 'inst', timestamp: '2026-03-04T11:59:04.000Z' }),
      '',
    ].join('\n'));

    const markdown = renderTraceReportFromLogs(
      {
        tracePath: join(dir, 'trace.md'),
        workflowName: 'workflow',
        task: 'token=topsecret',
        runSlug: 'run-1',
        status: 'aborted',
        iterations: 1,
        endTime: '2026-03-04T12:00:00.000Z',
        reason: 'api_key=super-secret',
      },
      sessionPath,
      undefined,
      'redacted',
    );

    expect(markdown).toContain('token=[REDACTED]');
    expect(markdown).toContain('api_key=[REDACTED]');
    expect(markdown).not.toContain('topsecret');
    expect(markdown).not.toContain('super-secret');
    expect(markdown).not.toContain('hunter2');
  });

  it('should mask quoted JSON secrets and common token formats in redacted mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-report-redact-json-'));
    const sessionPath = join(dir, 'session.jsonl');
    writeFileSync(sessionPath, [
      JSON.stringify({ type: 'workflow_start', task: '{"api_key":"abc123"}', workflowName: 'workflow', startTime: '2026-03-04T11:59:00.000Z' }),
      JSON.stringify({ type: 'step_start', step: 'plan', persona: 'planner', iteration: 1, timestamp: '2026-03-04T11:59:01.000Z' }),
      JSON.stringify({ type: 'phase_start', step: 'plan', iteration: 1, phase: 1, phaseName: 'execute', phaseExecutionId: 'plan:1:1:1', instruction: '{"token":"xyz987"}', systemPrompt: 'Authorization: Bearer sk-abcdef12345678', userInstruction: 'ghp_abcdef1234567890', timestamp: '2026-03-04T11:59:02.000Z' }),
      JSON.stringify({ type: 'phase_complete', step: 'plan', iteration: 1, phase: 1, phaseName: 'execute', phaseExecutionId: 'plan:1:1:1', status: 'done', content: 'xoxb-1234abcd-5678efgh', timestamp: '2026-03-04T11:59:03.000Z' }),
      JSON.stringify({ type: 'step_complete', step: 'plan', persona: 'planner', iteration: 1, status: 'done', content: '{"password":"plain"}', instruction: 'inst', timestamp: '2026-03-04T11:59:04.000Z' }),
      '',
    ].join('\n'));

    const markdown = renderTraceReportFromLogs(
      {
        tracePath: join(dir, 'trace.md'),
        workflowName: 'workflow',
        task: '{"api_key":"abc123"}',
        runSlug: 'run-1',
        status: 'aborted',
        iterations: 1,
        endTime: '2026-03-04T12:00:00.000Z',
        reason: '{"secret":"plain"}',
      },
      sessionPath,
      undefined,
      'redacted',
    );

    expect(markdown).toContain('"api_key":"[REDACTED]"');
    expect(markdown).toContain('"secret":"[REDACTED]"');
    expect(markdown).toContain('Authorization: Bearer [REDACTED]');
    expect(markdown).not.toContain('abc123');
    expect(markdown).not.toContain('xyz987');
    expect(markdown).not.toContain('ghp_abcdef1234567890');
    expect(markdown).not.toContain('xoxb-1234abcd-5678efgh');
  });

  it('should fold alternating loop iterations into a details block', () => {
    const markdown = renderTraceReportMarkdown(
      {
        tracePath: '/tmp/trace.md',
        workflowName: 'test-workflow',
        task: 'test task',
        runSlug: 'run-1',
        status: 'completed',
        iterations: 4,
        endTime: '2026-03-04T12:00:00.000Z',
      },
      '2026-03-04T11:59:00.000Z',
      [
        { step: 'reviewers', persona: 'reviewer', iteration: 1, startedAt: '2026-03-04T11:59:01.000Z', phases: [], result: { status: 'done', content: 'ok' } },
        { step: 'fix', persona: 'coder', iteration: 2, startedAt: '2026-03-04T11:59:02.000Z', phases: [], result: { status: 'done', content: 'ok' } },
        { step: 'reviewers', persona: 'reviewer', iteration: 3, startedAt: '2026-03-04T11:59:03.000Z', phases: [], result: { status: 'done', content: 'ok' } },
        { step: 'fix', persona: 'coder', iteration: 4, startedAt: '2026-03-04T11:59:04.000Z', phases: [], result: { status: 'done', content: 'ok' } },
      ],
      [],
    );

    expect(markdown).toContain('reviewers ↔ fix loop');
    expect(markdown).toContain('<details><summary>Loop details');
  });
});
