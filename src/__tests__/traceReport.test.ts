import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  renderTraceReportFromLogs,
  renderTraceReportFromRecords,
  renderTraceReportMarkdown,
} from '../features/tasks/execute/traceReport.js';

describe('traceReport', () => {
  it('returns no optional trace report when session records are absent', () => {
    expect(renderTraceReportFromRecords({
      tracePath: '/tmp/trace.md',
      workflowName: 'workflow',
      task: 'task',
      runSlug: 'run-empty',
      status: 'completed',
      iterations: 0,
      endTime: '2026-03-04T12:00:00.000Z',
    }, [], [], 'full')).toBeUndefined();
  });

  it('preserves an incomplete step as in progress when a run is aborted', () => {
    const markdown = renderTraceReportMarkdown(
      {
        tracePath: '/tmp/trace.md',
        workflowName: 'workflow-under-test',
        task: 'task-under-test',
        runSlug: 'run-aborted',
        status: 'aborted',
        iterations: 1,
        endTime: '2026-03-04T12:00:00.000Z',
      },
      '2026-03-04T11:59:00.000Z',
      [{
        step: 'incomplete-step',
        persona: 'coder',
        iteration: 1,
        startedAt: '2026-03-04T11:59:01.000Z',
        phases: [{
          phaseExecutionId: 'incomplete-step:1:3:1',
          phase: 3,
          phaseName: 'judge',
          instruction: 'judge input',
          systemPrompt: 'system input',
          userInstruction: 'user input',
          startedAt: '2026-03-04T11:59:02.000Z',
          judgeStages: [{
            stage: 1,
            method: 'structured_output',
            status: 'error',
            instruction: 'stage input',
            response: '',
          }],
        }],
      }],
    );

    expect(markdown).toContain('in_progress');
    expect(markdown).toContain('stage input');
  });

  it('keeps a failed terminal step distinct from an aborted run', () => {
    const markdown = renderTraceReportMarkdown(
      {
        tracePath: '/tmp/trace.md',
        workflowName: 'failed-workflow',
        task: 'task-under-test',
        runSlug: 'run-failed',
        status: 'failed',
        iterations: 1,
        endTime: '2026-03-04T12:00:00.000Z',
      },
      '2026-03-04T11:59:00.000Z',
      [{
        step: 'terminal-step',
        persona: 'reviewer',
        iteration: 1,
        startedAt: '2026-03-04T11:59:01.000Z',
        completedAt: '2026-03-04T11:59:02.000Z',
        phases: [],
      }],
    );

    expect(markdown).toContain('failed');
    expect(markdown).not.toContain('aborted');
  });

  it('renders steps in timestamp order from NDJSON logs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-report-order-'));
    const sessionPath = join(dir, 'session.jsonl');
    writeFileSync(sessionPath, [
      JSON.stringify({ type: 'workflow_start', task: 'task', workflowName: 'workflow', startTime: '2026-03-04T11:59:00.000Z' }),
      JSON.stringify({ type: 'step_start', step: 'later-step', persona: 'reviewer', iteration: 2, timestamp: '2026-03-04T11:59:05.000Z' }),
      JSON.stringify({ type: 'step_start', step: 'earlier-step', persona: 'planner', iteration: 1, timestamp: '2026-03-04T11:59:01.000Z' }),
      JSON.stringify({ type: 'step_complete', step: 'later-step', persona: 'reviewer', iteration: 2, status: 'done', content: 'later-result', instruction: 'later-instruction', timestamp: '2026-03-04T11:59:06.000Z' }),
      JSON.stringify({ type: 'step_complete', step: 'earlier-step', persona: 'planner', iteration: 1, status: 'done', content: 'earlier-result', instruction: 'earlier-instruction', timestamp: '2026-03-04T11:59:02.000Z' }),
      JSON.stringify({ type: 'workflow_complete', iterations: 2, endTime: '2026-03-04T12:00:00.000Z' }),
      '',
    ].join('\n'));

    const markdown = renderTraceReportFromLogs(
      {
        tracePath: join(dir, 'trace.md'),
        workflowName: 'workflow',
        task: 'task',
        runSlug: 'run-ordered',
        status: 'completed',
        iterations: 2,
        endTime: '2026-03-04T12:00:00.000Z',
      },
      sessionPath,
      undefined,
      'full',
    );

    expect(markdown).toBeDefined();
    expect(markdown!.indexOf('earlier-result')).toBeLessThan(markdown!.indexOf('later-result'));
  });

  it('preserves the failure category from an NDJSON step record', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-report-category-'));
    const sessionPath = join(dir, 'session.jsonl');
    writeFileSync(sessionPath, [
      JSON.stringify({ type: 'workflow_start', task: 'task', workflowName: 'workflow', startTime: '2026-03-04T11:59:00.000Z' }),
      JSON.stringify({ type: 'step_start', step: 'failed-step', persona: 'coder', iteration: 1, timestamp: '2026-03-04T11:59:01.000Z' }),
      JSON.stringify({
        type: 'step_complete',
        step: 'failed-step',
        persona: 'coder',
        iteration: 1,
        status: 'error',
        content: 'provider result',
        error: 'provider error',
        failureCategory: 'provider_error',
        instruction: 'instruction',
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
        runSlug: 'run-category',
        status: 'failed',
        iterations: 1,
        endTime: '2026-03-04T12:00:00.000Z',
      },
      sessionPath,
      undefined,
      'full',
    );

    expect(markdown).toContain('provider_error');
  });

  it('should preserve workflow_call and child steps with the same name across different iterations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-report-stack-'));
    const sessionPath = join(dir, 'session.jsonl');
    writeFileSync(sessionPath, [
      JSON.stringify({ type: 'workflow_start', task: 'task', workflowName: 'parent', startTime: '2026-03-04T11:59:00.000Z' }),
      JSON.stringify({
        type: 'step_start',
        step: 'review',
        workflow: 'parent',
        stack: [{
          workflow: 'parent',
          workflow_ref: 'project:sha256:parent',
          step: 'review',
          kind: 'workflow_call',
          occurrence: 1,
        }],
        persona: 'planner',
        iteration: 3,
        timestamp: '2026-03-04T11:59:01.000Z',
      }),
      JSON.stringify({
        type: 'step_start',
        step: 'review',
        workflow: 'child',
        stack: [
          {
            workflow: 'parent',
            workflow_ref: 'project:sha256:parent',
            step: 'delegate',
            kind: 'workflow_call',
            occurrence: 1,
          },
          {
            workflow: 'child',
            workflow_ref: 'project:sha256:child',
            step: 'review',
            kind: 'agent',
            occurrence: 1,
          },
        ],
        persona: 'reviewer',
        iteration: 4,
        timestamp: '2026-03-04T11:59:03.000Z',
      }),
      JSON.stringify({
        type: 'step_complete',
        step: 'review',
        workflow: 'child',
        stack: [
          {
            workflow: 'parent',
            workflow_ref: 'project:sha256:parent',
            step: 'delegate',
            kind: 'workflow_call',
            occurrence: 1,
          },
          {
            workflow: 'child',
            workflow_ref: 'project:sha256:child',
            step: 'review',
            kind: 'agent',
            occurrence: 1,
          },
        ],
        persona: 'reviewer',
        iteration: 4,
        status: 'done',
        content: 'child-ok',
        instruction: 'inst',
        timestamp: '2026-03-04T11:59:04.000Z',
      }),
      JSON.stringify({
        type: 'step_complete',
        step: 'review',
        workflow: 'parent',
        stack: [{
          workflow: 'parent',
          workflow_ref: 'project:sha256:parent',
          step: 'review',
          kind: 'workflow_call',
          occurrence: 1,
        }],
        persona: 'planner',
        iteration: 3,
        status: 'done',
        content: 'parent-ok',
        instruction: 'inst',
        timestamp: '2026-03-04T11:59:05.000Z',
      }),
      JSON.stringify({ type: 'workflow_complete', iterations: 2, endTime: '2026-03-04T12:00:00.000Z' }),
      '',
    ].join('\n'));

    const markdown = renderTraceReportFromLogs(
      {
        tracePath: join(dir, 'trace.md'),
        workflowName: 'parent',
        task: 'task',
        runSlug: 'run-1',
        status: 'completed',
        iterations: 2,
        endTime: '2026-03-04T12:00:00.000Z',
      },
      sessionPath,
      undefined,
      'full',
    );

    expect(markdown).toContain('parent-ok');
    expect(markdown).toContain('child-ok');
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

  it('should reject duplicate prompt executions within one run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-report-duplicate-prompt-'));
    const sessionPath = join(dir, 'session.jsonl');
    const promptPath = join(dir, 'session-prompts.jsonl');
    const scope = '{"step":"plan","stack":[]}';
    const promptRecord = {
      step: 'plan',
      phase: 1,
      iteration: 1,
      scope,
      phaseExecutionId: 'plan:1:1:1',
      systemPrompt: 'system prompt',
      userInstruction: 'user prompt',
      prompt: 'user prompt',
      response: 'response',
      timestamp: '2026-03-04T11:59:03.000Z',
    };

    try {
      writeFileSync(sessionPath, [
        JSON.stringify({ type: 'workflow_start', task: 'task', workflowName: 'workflow', startTime: '2026-03-04T11:59:00.000Z' }),
        JSON.stringify({ type: 'step_start', step: 'plan', persona: 'planner', iteration: 1, timestamp: '2026-03-04T11:59:01.000Z' }),
        JSON.stringify({ type: 'phase_start', step: 'plan', iteration: 1, phase: 1, phaseName: 'execute', phaseExecutionId: 'plan:1:1:1', instruction: 'user prompt', systemPrompt: 'system prompt', userInstruction: 'user prompt', timestamp: '2026-03-04T11:59:02.000Z' }),
        JSON.stringify({ type: 'phase_complete', step: 'plan', iteration: 1, phase: 1, phaseName: 'execute', phaseExecutionId: 'plan:1:1:1', status: 'done', content: 'response', timestamp: '2026-03-04T11:59:03.000Z' }),
        '',
      ].join('\n'));
      writeFileSync(promptPath, [
        JSON.stringify(promptRecord),
        JSON.stringify(promptRecord),
        '',
      ].join('\n'));

      expect(() => renderTraceReportFromLogs(
        {
          tracePath: join(dir, 'trace.md'),
          workflowName: 'workflow',
          task: 'task',
          runSlug: 'run-duplicate',
          status: 'completed',
          iterations: 1,
          endTime: '2026-03-04T12:00:00.000Z',
        },
        sessionPath,
        promptPath,
        'full',
      )).toThrow('Duplicate prompt execution');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should not require session or prompt logs when trace mode is off', () => {
    expect(renderTraceReportFromLogs(
      {
        tracePath: '/missing/trace.md',
        workflowName: 'workflow',
        task: 'task',
        runSlug: 'run-off',
        status: 'completed',
        iterations: 1,
        endTime: '2026-03-04T12:00:00.000Z',
      },
      '/missing/session.jsonl',
      '/missing/session-prompts.jsonl',
      'off',
    )).toBeUndefined();
  });

});
