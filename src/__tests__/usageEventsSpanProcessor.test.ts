import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

  it('rejects duplicate runId registrations', () => {
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
    })).toThrow('Phase usage event exporter is already registered for runId: run-1');
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

  it('unregister function removes the run from registrations', () => {
    const logPath = createTempLogPath('unregister-usage-events.phase.jsonl');
    const processor = new UsageEventsSpanProcessor();

    const unregister = processor.register({
      runId: 'run-unregister',
      sessionId: 'session-1',
      phaseUsageLogPath: logPath,
    });

    // Span is written while registered
    processor.onEnd(makePhaseSpan('run-unregister') as unknown as ReadableSpan);
    expect(readRecords(logPath)).toHaveLength(1);

    unregister();

    // Span is ignored after unregister — no new records appended
    processor.onEnd(makePhaseSpan('run-unregister') as unknown as ReadableSpan);
    expect(readRecords(logPath)).toHaveLength(1);
  });

  it('allows re-registration of a run after it has been unregistered', () => {
    const firstLogPath = createTempLogPath('reregister-first.phase.jsonl');
    const secondLogPath = createTempLogPath('reregister-second.phase.jsonl');
    const processor = new UsageEventsSpanProcessor();

    const unregister = processor.register({
      runId: 'run-reregister',
      sessionId: 'session-1',
      phaseUsageLogPath: firstLogPath,
    });
    unregister();

    // Should not throw after unregistering
    expect(() => processor.register({
      runId: 'run-reregister',
      sessionId: 'session-2',
      phaseUsageLogPath: secondLogPath,
    })).not.toThrow();
  });

  it('ignores spans that belong to an unregistered run', () => {
    const logPath = createTempLogPath('unregistered-run.phase.jsonl');
    const processor = new UsageEventsSpanProcessor({
      runId: 'run-registered',
      sessionId: 'session-1',
      phaseUsageLogPath: logPath,
    });

    // Span for a different run ID — should be silently ignored
    processor.onEnd(makePhaseSpan('run-unknown') as unknown as ReadableSpan);
    expect(existsSync(logPath)).toBe(false);
  });

  it('ignores spans without a takt.run.id attribute', () => {
    const logPath = createTempLogPath('no-run-id.phase.jsonl');
    const processor = new UsageEventsSpanProcessor({
      runId: 'run-1',
      sessionId: 'session-1',
      phaseUsageLogPath: logPath,
    });

    const spanWithoutRunId = {
      name: 'phase.implement.execute',
      endTime: [1_778_777_205, 0],
      attributes: {
        // takt.run.id deliberately omitted
        'takt.provider.name': 'mock',
        'takt.step.name': 'implement',
        'takt.step.type': 'normal',
        'takt.phase.number': 1,
        'takt.phase.name': 'execute',
        'takt.phase.status': 'done',
        'gen_ai.usage.input_tokens': 3,
        'gen_ai.usage.output_tokens': 2,
        'gen_ai.usage.total_tokens': 5,
      },
    };

    processor.onEnd(spanWithoutRunId as unknown as ReadableSpan);
    expect(existsSync(logPath)).toBe(false);
  });

  it('ignores non-phase, non-judge spans even when run is registered', () => {
    const logPath = createTempLogPath('non-phase-span.phase.jsonl');
    const processor = new UsageEventsSpanProcessor({
      runId: 'run-1',
      sessionId: 'session-1',
      phaseUsageLogPath: logPath,
    });

    const stepSpan = {
      name: 'step.implement',
      endTime: [1_778_777_205, 0],
      attributes: {
        'takt.run.id': 'run-1',
        'takt.step.name': 'implement',
        'takt.step.type': 'normal',
      },
    };

    processor.onEnd(stepSpan as unknown as ReadableSpan);
    expect(existsSync(logPath)).toBe(false);
  });

  it('forceFlush resolves without error', async () => {
    const processor = new UsageEventsSpanProcessor();
    await expect(processor.forceFlush()).resolves.toBeUndefined();
  });

  it('shutdown clears all registrations and resolves without error', async () => {
    const logPath = createTempLogPath('shutdown-usage-events.phase.jsonl');
    const processor = new UsageEventsSpanProcessor({
      runId: 'run-shutdown',
      sessionId: 'session-1',
      phaseUsageLogPath: logPath,
    });

    await expect(processor.shutdown()).resolves.toBeUndefined();

    // After shutdown, the run registration is cleared — spans are ignored
    processor.onEnd(makePhaseSpan('run-shutdown') as unknown as ReadableSpan);
    expect(existsSync(logPath)).toBe(false);
  });

  it('accepts initial options via constructor as a convenience shorthand', () => {
    const logPath = createTempLogPath('constructor-usage-events.phase.jsonl');
    const processor = new UsageEventsSpanProcessor({
      runId: 'run-constructor',
      sessionId: 'session-1',
      phaseUsageLogPath: logPath,
    });

    processor.onEnd(makePhaseSpan('run-constructor') as unknown as ReadableSpan);
    expect(readRecords(logPath)).toHaveLength(1);
  });
});

function makePhaseSpan(runId: string): Record<string, unknown> {

    name: 'phase.implement.execute',
    endTime: [1_778_777_205, 0],
    attributes: {
      'takt.run.id': runId,
      'takt.provider.name': 'mock',
      'takt.model.name': 'mock-model',
      'takt.step.name': 'implement',
      'takt.step.type': 'normal',
      'takt.phase.number': 1,
      'takt.phase.name': 'execute',
      'takt.phase.status': 'done',
      'gen_ai.usage.input_tokens': 3,
      'gen_ai.usage.output_tokens': 2,
      'gen_ai.usage.total_tokens': 5,
    },
  };
}
