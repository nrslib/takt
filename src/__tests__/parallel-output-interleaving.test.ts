/**
 * Reproduction tests for stdout/stderr interleaving around streamed text output.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ParallelLogger } from '../core/workflow/index.js';
import type { StreamEvent } from '../core/workflow/index.js';

describe('stream output interleaving', () => {
  let output: string[];

  beforeEach(() => {
    vi.useRealTimers();
    output = [];
  });

  it('reproduces sentence fragments when timed flush + worker-pool log interleave', async () => {
    vi.useFakeTimers();

    const logger = new ParallelLogger({
      subStepNames: ['testing-review'],
      writeFn: (text) => output.push(`STDOUT:${text}`),
      flushIntervalMs: 10,
      minTimedFlushChars: 24,
      maxTimedBufferMs: 200,
    });

    const handler = logger.createStreamHandler('testing-review', 0);

    handler({
      type: 'text',
      data: { text: '[#429][reviewers][testing-review](2/30)(1) should include' },
    } as StreamEvent);

    await vi.advanceTimersByTimeAsync(20);

    output.push('STDERR:[04:47:20.401] [DEBUG] [worker-pool] poll_tick\n');

    handler({
      type: 'text',
      data: { text: ' ag' },
    } as StreamEvent);

    await vi.advanceTimersByTimeAsync(20);

    output.push('STDERR:[04:47:20.401] [DEBUG] [worker-pool] no_new_tasks\n');

    handler({
      type: 'text',
      data: { text: 'ent Error in throw message when provided' },
    } as StreamEvent);

    logger.flush();

    expect(output.length).toBeGreaterThanOrEqual(2);

    const rendered = output.join('');
    expect(rendered).toContain('should');
    expect(rendered).toContain('include');
    expect(rendered).toContain('ent Error in throw message when provided');
    expect(rendered).toContain('[worker-pool] poll_tick');
    expect(rendered).toContain('no_new_tasks');

    const stdoutText = output.filter((line) => line.startsWith('STDOUT:')).join('');
    const stdoutChunks = output
      .filter((line) => line.startsWith('STDOUT:'))
      .map((line) => line.replace(/^STDOUT:/, '').replace(/^\u001b\[[0-9;]*m\[[^\]]+\]\u001b\[0m /, ''));

    // この再現では、単独断片 " ag" がSTDOUTチャンクとして流れないことを確認する
    expect(stdoutText).toContain('ent Error in throw message when provided');
    expect(stdoutChunks).not.toContain(' ag');
    expect(stdoutChunks.join('')).toContain('include agent Error in throw message when provided');

    vi.useRealTimers();
  });
});
