import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { UsageEventsSpanProcessor } from '../infra/observability/usageEventsSpanProcessor.js';

const tempDirs = new Set<string>();

function createTempLogPath(name = 'session-usage-events.phase.jsonl'): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-phase-usage-events-'));
  tempDirs.add(dir);
  return join(dir, name);
}

function readRecords(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
  vi.doUnmock('../infra/fs/index.js');
  vi.doUnmock('../shared/utils/debug.js');
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('UsageEventsSpanProcessor', () => {
  it('routes phase usage records to the matching registered run', () => {
    const firstLogPath = createTempLogPath('first-usage-events.phase.jsonl');
    const secondLogPath = createTempLogPath('second-usage-events.phase.jsonl');
    const processor = new UsageEventsSpanProcessor();

    processor.register({
      runId: 'run-1',
      sessionId: 'session-1',
      phaseUsageLogPath: firstLogPath,
    });
    processor.register({
      runId: 'run-2',
      sessionId: 'session-2',
      phaseUsageLogPath: secondLogPath,
    });

    processor.onEnd(makePhaseSpan('run-2') as unknown as ReadableSpan);
    processor.onEnd(makePhaseSpan('run-1') as unknown as ReadableSpan);

    expect(readRecords(firstLogPath)).toEqual([
      expect.objectContaining({
        run_id: 'run-1',
        session_id: 'session-1',
        phase: 'phase1_execute',
        persona: 'coder',
        tags: ['coding', 'review'],
      }),
    ]);
    expect(readRecords(secondLogPath)).toEqual([
      expect.objectContaining({
        run_id: 'run-2',
        session_id: 'session-2',
        phase: 'phase1_execute',
      }),
    ]);
  });

  it('ignores duplicate runId registrations without redirecting existing output', () => {
    const firstLogPath = createTempLogPath('first-usage-events.phase.jsonl');
    const secondLogPath = createTempLogPath('second-usage-events.phase.jsonl');
    const processor = new UsageEventsSpanProcessor();

    processor.register({
      runId: 'run-1',
      sessionId: 'session-1',
      phaseUsageLogPath: firstLogPath,
    });
    expect(() => processor.register({
      runId: 'run-1',
      sessionId: 'session-duplicate',
      phaseUsageLogPath: secondLogPath,
    })).not.toThrow();

    processor.onEnd(makePhaseSpan('run-1') as unknown as ReadableSpan);

    expect(readRecords(firstLogPath)).toEqual([
      expect.objectContaining({
        run_id: 'run-1',
        session_id: 'session-1',
        phase: 'phase1_execute',
      }),
    ]);
    expect(existsSync(secondLogPath)).toBe(false);
  });

  it('does not throw when appends fail', () => {
    const phaseUsageLogPath = join(createTempLogPath(), 'missing', 'usage-events.phase.jsonl');
    const processor = new UsageEventsSpanProcessor({
      runId: 'run-1',
      sessionId: 'session-1',
      phaseUsageLogPath,
    });

    expect(() => {
      processor.onEnd(makePhaseSpan('run-1') as unknown as ReadableSpan);
    }).not.toThrow();
  });

  it('reports append failures once per run and clears the flag when unregistered', async () => {
    const appendJsonLine = vi.fn(() => {
      throw new Error('write failed');
    });
    const errorLog = vi.fn();

    vi.doMock('../infra/fs/index.js', () => ({ appendJsonLine }));
    vi.doMock('../shared/utils/debug.js', () => ({
      createLogger: () => ({
        error: errorLog,
        warn: vi.fn(),
      }),
    }));

    const { UsageEventsSpanProcessor: MockedUsageEventsSpanProcessor } = await import(
      '../infra/observability/usageEventsSpanProcessor.js'
    );
    const processor = new MockedUsageEventsSpanProcessor();
    const unregisterRun1 = processor.register({
      runId: 'run-1',
      sessionId: 'session-1',
      phaseUsageLogPath: '/missing/run-1-usage-events.phase.jsonl',
    });
    processor.register({
      runId: 'run-2',
      sessionId: 'session-2',
      phaseUsageLogPath: '/missing/run-2-usage-events.phase.jsonl',
    });

    processor.onEnd(makePhaseSpan('run-1') as unknown as ReadableSpan);
    processor.onEnd(makePhaseSpan('run-1') as unknown as ReadableSpan);
    processor.onEnd(makePhaseSpan('run-2') as unknown as ReadableSpan);
    unregisterRun1();
    processor.register({
      runId: 'run-1',
      sessionId: 'session-1',
      phaseUsageLogPath: '/missing/run-1-usage-events.phase.jsonl',
    });
    processor.onEnd(makePhaseSpan('run-1') as unknown as ReadableSpan);
    await processor.shutdown();

    expect(appendJsonLine).toHaveBeenCalledTimes(4);
    expect(errorLog).toHaveBeenCalledTimes(3);
    expect(errorLog).toHaveBeenNthCalledWith(1, 'Failed to append phase usage event log record', expect.objectContaining({
      runId: 'run-1',
    }));
    expect(errorLog).toHaveBeenNthCalledWith(2, 'Failed to append phase usage event log record', expect.objectContaining({
      runId: 'run-2',
    }));
    expect(errorLog).toHaveBeenNthCalledWith(3, 'Failed to append phase usage event log record', expect.objectContaining({
      runId: 'run-1',
    }));
  });
});

function makePhaseSpan(runId: string): Record<string, unknown> {
  return {
    name: 'phase.implement.execute',
    endTime: [1_778_777_205, 0],
    attributes: {
      'takt.run.id': runId,
      'takt.provider.name': 'mock',
      'takt.model.name': 'mock-model',
      'takt.step.name': 'implement',
      'takt.step.type': 'agent',
      'takt.step.persona': 'coder',
      'takt.step.tags': ['coding', 'review'],
      'takt.phase.number': 1,
      'takt.phase.name': 'execute',
      'takt.phase.status': 'done',
      'gen_ai.usage.input_tokens': 3,
      'gen_ai.usage.output_tokens': 2,
      'gen_ai.usage.total_tokens': 5,
    },
  };
}
