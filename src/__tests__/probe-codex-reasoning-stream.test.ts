import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => {
  const startThread = vi.fn();
  const Codex = vi.fn(() => ({ startThread }));
  return { Codex, startThread };
});

vi.mock('@openai/codex-sdk', () => ({ Codex: sdk.Codex }));

import { parseArguments, runProbe } from '../../scripts/probe-codex-reasoning-stream.mjs';

async function* eventsOf(events: readonly Record<string, unknown>[]): AsyncGenerator<Record<string, unknown>> {
  yield* events;
}

describe('probe-codex-reasoning-stream', () => {
  let root: string;
  let output: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'takt-probe-test-'));
    process.exitCode = undefined;
    output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.clearAllMocks();
  });

  afterEach(() => {
    output.mockRestore();
    process.exitCode = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it('should validate required arguments and JSON object config', () => {
    expect(() => parseArguments([])).toThrow('--model, --prompt, and --output are required');
    expect(() => parseArguments([
      '--model', 'model',
      '--prompt', 'prompt',
      '--output', join(root, 'events.jsonl'),
      '--config', '[]',
    ])).toThrow('--config must be a JSON object');
  });

  it('should write JSONL events and a successful summary with the SDK contract', async () => {
    const outputPath = join(root, 'nested', 'events.jsonl');
    const runStreamed = vi.fn().mockResolvedValue({
      events: eventsOf([
        { type: 'turn.started' },
        { type: 'turn.completed', usage: { input_tokens: 10 } },
      ]),
    });
    sdk.startThread.mockReturnValue({ runStreamed });

    await runProbe(parseArguments([
      '--model', 'model',
      '--prompt', 'prompt',
      '--output', outputPath,
      '--effort', 'xhigh',
      '--config', '{"custom":"value"}',
    ]));

    expect(sdk.Codex).toHaveBeenCalledWith({
      config: {
        custom: 'value',
        model_reasoning_effort: 'xhigh',
      },
    });
    expect(sdk.startThread).toHaveBeenCalledWith({
      model: 'model',
      workingDirectory: process.cwd(),
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
    });
    expect(runStreamed).toHaveBeenCalledWith('prompt');

    const lines = readFileSync(outputPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line).event.type)).toEqual([
      'turn.started',
      'turn.completed',
    ]);
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({
      status: 'completed',
      eventCount: 2,
      turnCompleted: true,
    });
    expect(process.exitCode).toBeUndefined();
  });

  it.each([
    ['turn.failed', { type: 'turn.failed', error: { message: 'turn failed' } }, 'failed', 'turn failed'],
    ['error', { type: 'error', message: 'stream failed' }, 'error', 'stream failed'],
  ])('should report a %s event as a failed probe', async (_name, event, status, message) => {
    const outputPath = join(root, 'events.jsonl');
    sdk.startThread.mockReturnValue({
      runStreamed: vi.fn().mockResolvedValue({ events: eventsOf([event]) }),
    });

    await runProbe(parseArguments([
      '--model', 'model',
      '--prompt', 'prompt',
      '--output', outputPath,
    ]));

    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({
      status,
      error: message,
      eventCount: 1,
      turnCompleted: false,
    });
    expect(process.exitCode).toBe(1);
  });

  it('should report an async stream failure in the summary and exit non-zero', async () => {
    const outputPath = join(root, 'events.jsonl');
    async function* failingEvents() {
      yield { type: 'turn.started' };
      throw new Error('stream exploded');
    }
    sdk.startThread.mockReturnValue({
      runStreamed: vi.fn().mockResolvedValue({ events: failingEvents() }),
    });

    await runProbe(parseArguments([
      '--model', 'model',
      '--prompt', 'prompt',
      '--output', outputPath,
    ]));

    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({
      status: 'error',
      error: 'stream exploded',
      eventCount: 1,
    });
    expect(process.exitCode).toBe(1);
  });
  it('should record a failed summary and non-zero exit when runStreamed rejects at start', async () => {
    const outputPath = join(root, 'start-failure.jsonl');
    const runStreamed = vi.fn().mockRejectedValue(new Error('startup refused'));
    sdk.startThread.mockReturnValue({ runStreamed });

    await runProbe(parseArguments([
      '--model', 'model',
      '--prompt', 'prompt',
      '--output', outputPath,
    ]));

    const summary = JSON.parse(String(output.mock.calls.at(-1)?.[0]));
    expect(summary).toMatchObject({
      error: 'startup refused',
    });
    expect(summary.status).not.toBe('completed');
    expect(process.exitCode).toBe(1);
  });

});
