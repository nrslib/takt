import { describe, expect, it } from 'vitest';
import { Phase1ExecutionLog } from '../core/workflow/phase1-execution-log.js';

describe('Phase1ExecutionLog', () => {
  it('masks a secret split across tool output chunks before deduplicating the full result', () => {
    const log = new Phase1ExecutionLog();
    log.recordEvent({ type: 'tool_output', data: { id: 'x', tool: 'Bash', output: 'password=' } });
    log.recordEvent({ type: 'tool_output', data: { id: 'x', tool: 'Bash', output: 'synthetic-secret-1929' } });
    log.recordEvent({ type: 'tool_result', data: { id: 'x', content: 'password=synthetic-secret-1929', isError: false } });

    const reportInput = log.toReportInput();
    expect(reportInput).not.toContain('synthetic-secret-1929');
    expect(JSON.parse(reportInput)).toEqual([
      { kind: 'provider_event', event: { type: 'tool_result', data: { id: 'x', content: 'password=[REDACTED]', isError: false } } },
    ]);
  });

  it('masks split secrets in unmatched and unfinished tool output', () => {
    const log = new Phase1ExecutionLog();
    log.recordEvent({ type: 'tool_output', data: { id: 'different', tool: 'Bash', output: 'password=' } });
    log.recordEvent({ type: 'tool_output', data: { id: 'different', tool: 'Bash', output: 'synthetic-secret-1929' } });
    log.recordEvent({ type: 'tool_result', data: { id: 'different', content: 'another result', isError: false } });
    log.recordEvent({ type: 'tool_output', data: { id: 'unfinished', tool: 'Bash', output: 'password=' } });
    log.recordEvent({ type: 'tool_output', data: { id: 'unfinished', tool: 'Bash', output: 'another-synthetic-secret' } });

    const reportInput = log.toReportInput();
    expect(reportInput).not.toContain('synthetic-secret-1929');
    expect(reportInput).not.toContain('another-synthetic-secret');
    expect(JSON.parse(reportInput).filter((entry: { event: { type: string } }) => entry.event.type === 'tool_output'))
      .toEqual([
        { kind: 'provider_event', event: { type: 'tool_output', data: { id: 'different', tool: 'Bash', output: 'password=[REDACTED]' } } },
        { kind: 'provider_event', event: { type: 'tool_output', data: { id: 'unfinished', tool: 'Bash', output: 'password=[REDACTED]' } } },
      ]);
  });

  it('masks text deltas across other sources without combining distinct tool ids', () => {
    const log = new Phase1ExecutionLog();
    log.recordEvent({ type: 'text', data: { text: 'password=' } }, 'leader');
    log.recordEvent({ type: 'tool_output', data: { id: 'other', tool: 'Bash', output: 'other output' } }, 'part');
    log.recordEvent({ type: 'text', data: { text: 'synthetic-secret-1929' } }, 'leader');
    log.recordEvent({ type: 'tool_output', data: { id: 'a', tool: 'Bash', output: 'password=' } }, 'leader');
    log.recordEvent({ type: 'tool_output', data: { id: 'b', tool: 'Bash', output: 'ordinary' } }, 'leader');
    log.recordEvent({ type: 'tool_output', data: { id: 'a', tool: 'Bash', output: 'another-synthetic-secret' } }, 'leader');

    const reportInput = log.toReportInput();
    expect(reportInput).not.toContain('synthetic-secret-1929');
    expect(reportInput).not.toContain('another-synthetic-secret');
    expect(JSON.parse(reportInput).filter((entry: { event?: { type: string } }) => entry.event?.type === 'text'))
      .toEqual([
        { kind: 'provider_event', source: 'leader', event: { type: 'text', data: { text: 'password=' } } },
        { kind: 'provider_event', source: 'leader', event: { type: 'text', data: { text: '[REDACTED]' } } },
      ]);
    expect(JSON.parse(reportInput).filter((entry: { event?: { type: string; data: { id?: string } } }) => entry.event?.data.id === 'b'))
      .toEqual([{ kind: 'provider_event', source: 'leader', event: { type: 'tool_output', data: { id: 'b', tool: 'Bash', output: 'ordinary' } } }]);
  });

  it('masks text fragments around tool events without moving the events', () => {
    const log = new Phase1ExecutionLog();
    log.recordEvent({ type: 'text', data: { text: 'Checked files. password=' } }, 'leader');
    log.recordEvent({ type: 'tool_use', data: { id: 'read-1', tool: 'Read', input: {} } }, 'leader');
    log.recordEvent({ type: 'tool_result', data: { id: 'read-1', content: 'read complete', isError: false } }, 'leader');
    log.recordEvent({ type: 'text', data: { text: 'synthetic-secret-across-tool and finished.' } }, 'leader');

    const reportInput = log.toReportInput();
    expect(reportInput).not.toContain('synthetic-secret-across-tool');
    expect(JSON.parse(reportInput)).toEqual([
      { kind: 'provider_event', source: 'leader', event: { type: 'text', data: { text: 'Checked files. password=' } } },
      { kind: 'provider_event', source: 'leader', event: { type: 'tool_use', data: { id: 'read-1', tool: 'Read', input: {} } } },
      { kind: 'provider_event', source: 'leader', event: { type: 'tool_result', data: { id: 'read-1', content: 'read complete', isError: false } } },
      { kind: 'provider_event', source: 'leader', event: { type: 'text', data: { text: '[REDACTED] and finished.' } } },
    ]);
  });

  it('masks a secret value split across text events around a tool call', () => {
    const log = new Phase1ExecutionLog();
    log.recordEvent({ type: 'text', data: { text: 'password=synthetic-' } });
    log.recordEvent({ type: 'tool_use', data: { id: 'read-1', tool: 'Read', input: {} } });
    log.recordEvent({ type: 'text', data: { text: 'secret-across-tool' } });

    const reportInput = log.toReportInput();
    expect(reportInput).not.toContain('synthetic-');
    expect(reportInput).not.toContain('secret-across-tool');
    expect(JSON.parse(reportInput).map((entry: { event: { type: string; data: { text?: string } } }) =>
      entry.event.type === 'text' ? entry.event.data.text : entry.event.type))
      .toEqual(['password=[REDACTED]', 'tool_use', '[REDACTED]']);
  });

  it('masks repeated and overlapping sensitive values wherever they occur', () => {
    const log = new Phase1ExecutionLog();
    log.recordEvent({ type: 'text', data: { text: 'password=abcde\napi_key=bcdef\nrepeat abcdef\n' } });

    const entries = JSON.parse(log.toReportInput());
    expect(entries[0].event.data.text).toBe('password=[REDACTED]\napi_key=[REDACTED]\nrepeat [REDACTED]\n');
  });

  it('preserves Unicode word boundaries around short sensitive values', () => {
    const log = new Phase1ExecutionLog();
    log.recordEvent({ type: 'text', data: { text: 'password=短\n独短\n短\n' } });

    const entries = JSON.parse(log.toReportInput());
    expect(entries[0].event.data.text).toBe('password=[REDACTED]\n独短\n[REDACTED]\n');
  });

  it('does not combine text fragments from different sources or attempts', () => {
    const log = new Phase1ExecutionLog();
    const prompt = { systemPrompt: 'system', userInstruction: 'instruction' };
    log.recordInstruction('initial', prompt, 'leader');
    log.markDispatched('leader');
    log.recordEvent({ type: 'text', data: { text: 'password=' } }, 'leader');
    log.recordEvent({ type: 'text', data: { text: 'ordinary' } }, 'part');
    log.recordResult({ status: 'done', content: '' }, 'leader');
    log.recordInstruction('retry', prompt, 'leader');
    log.markDispatched('leader');
    log.recordEvent({ type: 'text', data: { text: 'later response' } }, 'leader');

    expect(JSON.parse(log.toReportInput()).filter((entry: { event?: { type: string } }) => entry.event?.type === 'text'))
      .toEqual([
        { kind: 'provider_event', source: 'leader', event: { type: 'text', data: { text: 'password=' } } },
        { kind: 'provider_event', source: 'part', event: { type: 'text', data: { text: 'ordinary' } } },
        { kind: 'provider_event', source: 'leader', event: { type: 'text', data: { text: 'later response' } } },
      ]);
  });

  it('masks contiguous idless tool output without joining separate attempts', () => {
    const log = new Phase1ExecutionLog();
    const prompt = { systemPrompt: 'system', userInstruction: 'instruction' };
    log.recordInstruction('initial', prompt);
    log.markDispatched();
    log.recordEvent({ type: 'tool_output', data: { tool: 'Bash', output: 'password=' } });
    log.recordEvent({ type: 'tool_output', data: { tool: 'Bash', output: 'synthetic-secret-1929' } });
    log.recordResult({ status: 'done', content: '' });
    log.recordInstruction('retry', prompt);
    log.markDispatched();
    log.recordEvent({ type: 'tool_output', data: { tool: 'Bash', output: 'ordinary output' } });

    const reportInput = log.toReportInput();
    expect(reportInput).not.toContain('synthetic-secret-1929');
    expect(JSON.parse(reportInput).filter((entry: { event?: { type: string } }) => entry.event?.type === 'tool_output'))
      .toEqual([
        { kind: 'provider_event', event: { type: 'tool_output', data: { tool: 'Bash', output: 'password=[REDACTED]' } } },
        { kind: 'provider_event', event: { type: 'tool_output', data: { tool: 'Bash', output: 'ordinary output' } } },
      ]);
  });

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
