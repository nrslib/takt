import { describe, expect, it } from 'vitest';
import { Phase1ExecutionLog } from '../core/workflow/phase1-execution-log.js';

describe('Phase1ExecutionLog', () => {
  it('keeps one complete tool result when streamed output repeats it', () => {
    const log = new Phase1ExecutionLog();
    log.recordEvent({ type: 'tool_use', data: { id: 'read-1', tool: 'Read', input: {} } });
    log.recordEvent({ type: 'tool_output', data: { id: 'read-1', tool: 'Read', output: 'first ' } });
    log.recordEvent({ type: 'tool_output', data: { id: 'read-1', tool: 'Read', output: 'second' } });
    log.recordEvent({ type: 'tool_result', data: { id: 'read-1', content: 'first second', isError: false } });

    expect(JSON.parse(log.toReportInput())).toEqual([
      { kind: 'provider_event', event: { type: 'tool_use', data: { id: 'read-1', tool: 'Read', input: {} } } },
      { kind: 'provider_event', event: { type: 'tool_result', data: { id: 'read-1', content: 'first second', isError: false } } },
    ]);
  });

  it('preserves partial, different, idless, and unmatched tool output', () => {
    const log = new Phase1ExecutionLog();
    log.recordEvent({ type: 'tool_output', data: { id: 'partial', tool: 'Read', output: 'part' } });
    log.recordEvent({ type: 'tool_result', data: { id: 'partial', content: 'part and more', isError: false } });
    log.recordEvent({ type: 'tool_output', data: { id: 'different', tool: 'Read', output: 'old' } });
    log.recordEvent({ type: 'tool_result', data: { id: 'different', content: 'new', isError: false } });
    log.recordEvent({ type: 'tool_output', data: { tool: 'Read', output: 'no id' } });
    log.recordEvent({ type: 'tool_result', data: { content: 'no id', isError: false } });
    log.recordEvent({ type: 'tool_output', data: { id: 'pending', tool: 'Read', output: 'unmatched' } });

    expect(JSON.parse(log.toReportInput()).filter((entry: { event: { type: string } }) => entry.event.type === 'tool_output')).toHaveLength(4);
  });

  it('does not combine reused tool ids across attempts or sources', () => {
    const log = new Phase1ExecutionLog();
    const prompt = { systemPrompt: 'system', userInstruction: 'instruction' };
    log.recordInstruction('initial', prompt, 'leader');
    log.markDispatched('leader');
    log.recordEvent({ type: 'tool_output', data: { id: 'reused', tool: 'Read', output: 'first' } }, 'leader');
    log.recordEvent({ type: 'tool_output', data: { id: 'reused', tool: 'Read', output: 'other' } }, 'part');
    log.recordResult({ status: 'error', content: '' }, 'leader');
    log.recordInstruction('retry', prompt, 'leader');
    log.markDispatched('leader');
    log.recordEvent({ type: 'tool_result', data: { id: 'reused', content: 'first', isError: false } }, 'leader');
    log.recordEvent({ type: 'tool_result', data: { id: 'reused', content: 'other', isError: false } }, 'part');

    const outputs = JSON.parse(log.toReportInput()).filter((entry: { event?: { type: string } }) => entry.event?.type === 'tool_output');
    expect(outputs).toEqual([
      { kind: 'provider_event', source: 'leader', event: { type: 'tool_output', data: { id: 'reused', tool: 'Read', output: 'first' } } },
    ]);
  });

  it('keeps native structured decisions when text is empty and masks nested secrets', () => {
    const log = new Phase1ExecutionLog();
    log.recordResult({
      status: 'done',
      content: '',
      structuredOutput: {
        done: false,
        reasoning: 'Schedule another check',
        cancelPartIds: ['obsolete-part'],
        parts: [{ id: 'new-part', title: 'Inspect source', instruction: 'Read the current source' }],
        metadata: { token: 'synthetic-secret-123' },
      },
    });

    const entries = JSON.parse(log.toReportInput());
    expect(entries).toEqual([{
      kind: 'attempt_result', status: 'done', content: '',
      structuredOutput: {
        done: false,
        reasoning: 'Schedule another check',
        cancelPartIds: ['obsolete-part'],
        parts: [{ id: 'new-part', title: 'Inspect source', instruction: 'Read the current source' }],
        metadata: { token: '[REDACTED]' },
      },
    }]);
    expect(log.toReportInput()).not.toContain('synthetic-secret-123');
  });
});
