import { describe, expect, it } from 'vitest';

import {
  aggregateContentFromStdout,
  aggregateResultFromStdout,
  tryExtractTextFromStreamJsonLine,
  tryExtractThinkingFromStreamJsonLine,
} from '../infra/claude-headless/stream-json-lines.js';

describe('claude-headless stream-json line parsing', () => {
  it('extracts text from a stream-json text line', () => {
    const line = JSON.stringify({ type: 'text', text: 'hello' });
    expect(tryExtractTextFromStreamJsonLine(line)).toBe('hello');
  });

  it('returns undefined for invalid JSON (noise lines)', () => {
    expect(tryExtractTextFromStreamJsonLine('not json')).toBeUndefined();
  });

  it('uses streaming text as a compatibility fallback when no result event exists', () => {
    const stdout = [
      JSON.stringify({ type: 'text', text: 'a' }),
      'garbage',
      JSON.stringify({ type: 'text', text: 'b' }),
    ].join('\n');

    expect(aggregateResultFromStdout(stdout)).toEqual({
      content: 'ab',
      displayText: 'ab',
      hasResult: false,
      success: true,
      error: undefined,
      structuredOutput: undefined,
    });
    expect(aggregateContentFromStdout(stdout)).toBe('ab');
  });

  it('uses result.result once when assistant content and final result contain the same text', () => {
    const stdout = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'final answer' }],
        },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'final answer',
      }),
    ].join('\n');

    expect(aggregateContentFromStdout(stdout)).toBe('final answer');
  });

  it('prefers result.result over assistant message content for the final aggregate', () => {
    const stdout = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'draft answer' }],
        },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'final answer',
      }),
    ].join('\n');

    expect(aggregateContentFromStdout(stdout)).toBe('final answer');
  });

  it('does not emit final result lines as streaming text', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'final answer',
    });

    expect(tryExtractTextFromStreamJsonLine(line)).toBeUndefined();
  });

  it('marks the final result as failure when is_error is true even if result text exists', () => {
    const stdout = [
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'partial answer',
      }),
    ].join('\n');

    expect(aggregateResultFromStdout(stdout)).toEqual({
      content: 'partial answer',
      displayText: '',
      hasResult: true,
      success: false,
      error: 'partial answer',
      structuredOutput: undefined,
    });
  });

  it('uses the last result event when an earlier success is followed by a final error', () => {
    const stdout = [
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'first answer',
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'final failure',
      }),
    ].join('\n');

    expect(aggregateResultFromStdout(stdout)).toEqual({
      content: 'final failure',
      displayText: '',
      hasResult: true,
      success: false,
      error: 'final failure',
      structuredOutput: undefined,
    });
  });

  it('uses the last result event when an earlier error is followed by a final success', () => {
    const stdout = [
      JSON.stringify({
        type: 'result',
        subtype: 'error',
        message: 'first failure',
        result: 'first failure',
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'final answer',
      }),
    ].join('\n');

    expect(aggregateResultFromStdout(stdout)).toEqual({
      content: 'final answer',
      displayText: '',
      hasResult: true,
      success: true,
      error: undefined,
      structuredOutput: undefined,
    });
  });

  it('marks the final result as failure when isError is true even if subtype is success', () => {
    const stdout = [
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        isError: true,
        message: 'explicit failure',
        result: 'partial answer',
      }),
    ].join('\n');

    expect(aggregateResultFromStdout(stdout)).toEqual({
      content: 'partial answer',
      displayText: '',
      hasResult: true,
      success: false,
      error: 'explicit failure',
      structuredOutput: undefined,
    });
  });

  it('treats an empty successful final result as done', () => {
    const stdout = [
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: '',
      }),
    ].join('\n');

    expect(aggregateResultFromStdout(stdout)).toEqual({
      content: '',
      displayText: '',
      hasResult: true,
      success: true,
      error: undefined,
      structuredOutput: undefined,
    });
  });

  it('keeps the final aggregate empty when assistant content exists but the final result body is empty', () => {
    const stdout = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'partial answer' }],
        },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: '',
      }),
    ].join('\n');

    expect(aggregateResultFromStdout(stdout)).toEqual({
      content: '',
      displayText: 'partial answer',
      hasResult: true,
      success: true,
      error: undefined,
      structuredOutput: undefined,
    });
  });

  it('keeps the final aggregate empty when assistant content exists but result.result is missing', () => {
    const stdout = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'partial answer' }],
        },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
      }),
    ].join('\n');

    expect(aggregateResultFromStdout(stdout)).toEqual({
      content: '',
      displayText: 'partial answer',
      hasResult: true,
      success: true,
      error: undefined,
      structuredOutput: undefined,
    });
  });

  it('marks the final result as failure when subtype is error without is_error flags', () => {
    const stdout = [
      JSON.stringify({
        type: 'result',
        subtype: 'error',
        message: 'explicit failure',
        result: 'partial answer',
      }),
    ].join('\n');

    expect(aggregateResultFromStdout(stdout)).toEqual({
      content: 'partial answer',
      displayText: '',
      hasResult: true,
      success: false,
      error: 'explicit failure',
      structuredOutput: undefined,
    });
  });

  it('captures structured_output from the final result event', () => {
    const stdout = [
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'plain text',
        structured_output: { decision: 'approved' },
      }),
    ].join('\n');

    expect(aggregateResultFromStdout(stdout)).toEqual({
      content: 'plain text',
      displayText: '',
      hasResult: true,
      success: true,
      error: undefined,
      structuredOutput: { decision: 'approved' },
    });
  });

  it('captures structuredOutput from the final result event', () => {
    const stdout = [
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'plain text',
        structuredOutput: { decision: 'approved' },
      }),
    ].join('\n');

    expect(aggregateResultFromStdout(stdout)).toEqual({
      content: 'plain text',
      displayText: '',
      hasResult: true,
      success: true,
      error: undefined,
      structuredOutput: { decision: 'approved' },
    });
  });

  it('falls back to assistant message content when the final result event is missing', () => {
    const stdout = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'partial answer' }],
        },
      }),
    ].join('\n');

    expect(aggregateResultFromStdout(stdout)).toEqual({
      content: 'partial answer',
      displayText: 'partial answer',
      hasResult: false,
      success: true,
      error: undefined,
      structuredOutput: undefined,
    });
  });

  describe('thinking extraction', () => {
    it('extracts thinking from stream_event with thinking_delta', () => {
      const line = JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'thinking_delta', thinking: 'Let me consider...' },
        },
      });
      expect(tryExtractThinkingFromStreamJsonLine(line)).toBe('Let me consider...');
    });

    it('extracts thinking from unwrapped content_block_delta (backward compat)', () => {
      const line = JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'Let me consider...' },
      });
      expect(tryExtractThinkingFromStreamJsonLine(line)).toBe('Let me consider...');
    });

    it('returns undefined for a text_delta', () => {
      const line = JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'hello' },
        },
      });
      expect(tryExtractThinkingFromStreamJsonLine(line)).toBeUndefined();
    });

    it('returns undefined for non-delta event types', () => {
      const line = JSON.stringify({ type: 'text', text: 'hello' });
      expect(tryExtractThinkingFromStreamJsonLine(line)).toBeUndefined();
    });

    it('returns undefined for empty thinking', () => {
      const line = JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'thinking_delta', thinking: '' },
        },
      });
      expect(tryExtractThinkingFromStreamJsonLine(line)).toBeUndefined();
    });

    it('does not extract thinking as text', () => {
      const line = JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'thinking_delta', thinking: 'internal reasoning' },
        },
      });
      expect(tryExtractTextFromStreamJsonLine(line)).toBeUndefined();
    });
  });
});
