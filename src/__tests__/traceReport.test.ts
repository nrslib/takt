import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderTraceReportMarkdown, renderTraceReportFromLogs } from '../features/tasks/execute/traceReport.js';

describe('traceReport', () => {
  it('should render judge stage details and tolerate aborted incomplete movement', () => {
    const markdown = renderTraceReportMarkdown(
      {
        tracePath: '/tmp/trace.md',
        pieceName: 'test-piece',
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
    );

    expect(markdown).toContain('- Status: ❌ aborted');
    expect(markdown).toContain('- Movement Status: in_progress');
    expect(markdown).toContain('## Iteration 1: ai_fix (persona: coder)');
    expect(markdown).toContain('<details><summary>System Prompt</summary>');
    expect(markdown).toContain('<details><summary>User Instruction</summary>');
    expect(markdown).toContain('- Stage 1 (structured_output)');
    expect(markdown).toContain('<details><summary>Stage Instruction</summary>');
    expect(markdown).toContain('<details><summary>Stage Response</summary>');
  });

  it('should render movements in timestamp order from NDJSON logs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-report-'));
    const sessionPath = join(dir, 'session.jsonl');
    const promptPath = join(dir, 'prompts.jsonl');
    writeFileSync(sessionPath, [
      JSON.stringify({ type: 'piece_start', task: 'task', pieceName: 'piece', startTime: '2026-03-04T11:59:00.000Z' }),
      JSON.stringify({ type: 'step_start', step: 'reviewers', persona: 'reviewer', iteration: 2, timestamp: '2026-03-04T11:59:05.000Z' }),
      JSON.stringify({ type: 'step_start', step: 'plan', persona: 'planner', iteration: 1, timestamp: '2026-03-04T11:59:01.000Z' }),
      JSON.stringify({ type: 'phase_start', step: 'reviewers', iteration: 2, phase: 1, phaseName: 'execute', phaseExecutionId: 'reviewers:2:1:1', instruction: 'r', timestamp: '2026-03-04T11:59:06.000Z' }),
      JSON.stringify({ type: 'phase_complete', step: 'reviewers', iteration: 2, phase: 1, phaseName: 'execute', phaseExecutionId: 'reviewers:2:1:1', status: 'done', content: 'r-ok', timestamp: '2026-03-04T11:59:07.000Z' }),
      JSON.stringify({ type: 'step_complete', step: 'reviewers', persona: 'reviewer', status: 'done', content: 'r-ok', instruction: 'inst', timestamp: '2026-03-04T11:59:08.000Z' }),
      JSON.stringify({ type: 'phase_start', step: 'plan', iteration: 1, phase: 1, phaseName: 'execute', phaseExecutionId: 'plan:1:1:1', instruction: 'p', timestamp: '2026-03-04T11:59:02.000Z' }),
      JSON.stringify({ type: 'phase_complete', step: 'plan', iteration: 1, phase: 1, phaseName: 'execute', phaseExecutionId: 'plan:1:1:1', status: 'done', content: 'p-ok', timestamp: '2026-03-04T11:59:03.000Z' }),
      JSON.stringify({ type: 'step_complete', step: 'plan', persona: 'planner', status: 'done', content: 'p-ok', instruction: 'inst', timestamp: '2026-03-04T11:59:04.000Z' }),
      JSON.stringify({ type: 'piece_complete', iterations: 2, endTime: '2026-03-04T12:00:00.000Z' }),
      '',
    ].join('\n'));
    writeFileSync(promptPath, [
      JSON.stringify({ movement: 'plan', phase: 1, iteration: 1, phaseExecutionId: 'plan:1:1:1', prompt: 'p', systemPrompt: 'ps', userInstruction: 'pu', response: 'p-ok', timestamp: '2026-03-04T11:59:03.000Z' }),
      JSON.stringify({ movement: 'reviewers', phase: 1, iteration: 2, phaseExecutionId: 'reviewers:2:1:1', prompt: 'r', systemPrompt: 'rs', userInstruction: 'ru', response: 'r-ok', timestamp: '2026-03-04T11:59:07.000Z' }),
      '',
    ].join('\n'));

    const markdown = renderTraceReportFromLogs(
      {
        tracePath: join(dir, 'trace.md'),
        pieceName: 'piece',
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

  it('should fail fast when completed trace has missing phase status', () => {
    expect(() => renderTraceReportMarkdown(
      {
        tracePath: '/tmp/trace.md',
        pieceName: 'test-piece',
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
      JSON.stringify({ type: 'piece_start', task: 'token=topsecret', pieceName: 'piece', startTime: '2026-03-04T11:59:00.000Z' }),
      JSON.stringify({ type: 'step_start', step: 'plan', persona: 'planner', iteration: 1, timestamp: '2026-03-04T11:59:01.000Z' }),
      JSON.stringify({ type: 'phase_start', step: 'plan', iteration: 1, phase: 1, phaseName: 'execute', phaseExecutionId: 'plan:1:1:1', instruction: 'api_key=abc123', systemPrompt: 'Authorization: Bearer abc123', userInstruction: 'user token=abc123', timestamp: '2026-03-04T11:59:02.000Z' }),
      JSON.stringify({ type: 'phase_complete', step: 'plan', iteration: 1, phase: 1, phaseName: 'execute', phaseExecutionId: 'plan:1:1:1', status: 'done', content: 'password=hunter2', timestamp: '2026-03-04T11:59:03.000Z' }),
      JSON.stringify({ type: 'step_complete', step: 'plan', persona: 'planner', status: 'done', content: 'secret=my-secret', instruction: 'inst', timestamp: '2026-03-04T11:59:04.000Z' }),
      '',
    ].join('\n'));

    const markdown = renderTraceReportFromLogs(
      {
        tracePath: join(dir, 'trace.md'),
        pieceName: 'piece',
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
      JSON.stringify({ type: 'piece_start', task: '{"api_key":"abc123"}', pieceName: 'piece', startTime: '2026-03-04T11:59:00.000Z' }),
      JSON.stringify({ type: 'step_start', step: 'plan', persona: 'planner', iteration: 1, timestamp: '2026-03-04T11:59:01.000Z' }),
      JSON.stringify({ type: 'phase_start', step: 'plan', iteration: 1, phase: 1, phaseName: 'execute', phaseExecutionId: 'plan:1:1:1', instruction: '{"token":"xyz987"}', systemPrompt: 'Authorization: Bearer sk-abcdef12345678', userInstruction: 'ghp_abcdef1234567890', timestamp: '2026-03-04T11:59:02.000Z' }),
      JSON.stringify({ type: 'phase_complete', step: 'plan', iteration: 1, phase: 1, phaseName: 'execute', phaseExecutionId: 'plan:1:1:1', status: 'done', content: 'xoxb-1234abcd-5678efgh', timestamp: '2026-03-04T11:59:03.000Z' }),
      JSON.stringify({ type: 'step_complete', step: 'plan', persona: 'planner', status: 'done', content: '{"password":"plain"}', instruction: 'inst', timestamp: '2026-03-04T11:59:04.000Z' }),
      '',
    ].join('\n'));

    const markdown = renderTraceReportFromLogs(
      {
        tracePath: join(dir, 'trace.md'),
        pieceName: 'piece',
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
        pieceName: 'test-piece',
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
    );

    expect(markdown).toContain('reviewers ↔ fix loop');
    expect(markdown).toContain('<details><summary>Loop details');
  });
});
