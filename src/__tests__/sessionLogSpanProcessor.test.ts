import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Context } from '@opentelemetry/api';
import type { ReadableSpan, Span } from '@opentelemetry/sdk-trace-base';
import { SessionLogSpanProcessor } from '../infra/observability/sessionLogSpanProcessor.js';

const tempDirs = new Set<string>();

function createTempLogPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-session-log-exporter-'));
  tempDirs.add(dir);
  return join(dir, 'session-otel-session-shadow.jsonl');
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

describe('SessionLogSpanProcessor', () => {
  it('writes a shadow session log from workflow and step spans', () => {
    const shadowLogPath = createTempLogPath();
    const processor = new SessionLogSpanProcessor({
      shadowLogPath,
      sanitizedTask: 'task',
      workflowName: 'default',
    });
    const stepSpan = {
      name: 'step.implement',
      startTime: [1_778_777_200, 0],
      endTime: [1_778_777_205, 0],
      attributes: {
        'takt.step.name': 'implement',
        'takt.step.persona': 'coder',
        'takt.step.iteration': 1,
        'takt.step.instruction': 'Implement it',
        'takt.step.status': 'done',
        'takt.step.result.persona': 'coder',
        'takt.step.result.content': 'done',
        'takt.step.result.timestamp': '2026-05-18T00:00:00.000Z',
      },
    };

    processor.onStart(stepSpan as unknown as Span, {} as Context);
    processor.onEnd(stepSpan as unknown as ReadableSpan);
    processor.onEnd({
      name: 'workflow.default',
      endTime: [1_778_777_210, 0],
      attributes: {
        'takt.workflow.status': 'completed',
        'takt.workflow.iterations': 1,
      },
    } as unknown as ReadableSpan);

    expect(readRecords(shadowLogPath).map((record) => record.type)).toEqual([
      'workflow_start',
      'step_start',
      'step_complete',
      'workflow_complete',
    ]);
  });

  it('does not throw when shadow log appends fail', () => {
    const shadowLogPath = join(createTempLogPath(), 'missing', 'shadow.jsonl');

    expect(() => {
      const processor = new SessionLogSpanProcessor({
        shadowLogPath,
        sanitizedTask: 'task',
        workflowName: 'default',
      });
      processor.onStart({
        name: 'step.implement',
        attributes: {
          'takt.step.name': 'implement',
          'takt.step.persona': 'coder',
          'takt.step.iteration': 1,
        },
      } as unknown as Span, {} as Context);
      processor.onEnd({
        name: 'workflow.default',
        attributes: {
          'takt.workflow.status': 'completed',
          'takt.workflow.iterations': 1,
        },
      } as unknown as ReadableSpan);
    }).not.toThrow();
  });
});
