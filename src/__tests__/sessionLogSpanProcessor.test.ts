import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
      runId: 'run-1',
      shadowLogPath,
      sanitizedTask: 'task',
      workflowName: 'default',
    });
    const stepSpan = {
      name: 'step.implement',
      startTime: [1_778_777_200, 0],
      endTime: [1_778_777_205, 0],
      attributes: {
        'takt.run.id': 'run-1',
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
        'takt.run.id': 'run-1',
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
        runId: 'run-1',
        shadowLogPath,
        sanitizedTask: 'task',
        workflowName: 'default',
      });
      processor.onStart({
        name: 'step.implement',
        attributes: {
          'takt.run.id': 'run-1',
          'takt.step.name': 'implement',
          'takt.step.persona': 'coder',
          'takt.step.iteration': 1,
        },
      } as unknown as Span, {} as Context);
      processor.onEnd({
        name: 'workflow.default',
        attributes: {
          'takt.run.id': 'run-1',
          'takt.workflow.status': 'completed',
          'takt.workflow.iterations': 1,
        },
      } as unknown as ReadableSpan);
    }).not.toThrow();
  });

  it('ignores a duplicate runId registration instead of emitting a second workflow_start', () => {
    const firstLogPath = createTempLogPath();
    const secondLogPath = createTempLogPath();
    const processor = new SessionLogSpanProcessor();

    processor.register({
      runId: 'run-1',
      shadowLogPath: firstLogPath,
      sanitizedTask: 'first task',
      workflowName: 'default',
    });
    // Collision: same runId, different path. Must not clobber the live run.
    processor.register({
      runId: 'run-1',
      shadowLogPath: secondLogPath,
      sanitizedTask: 'second task',
      workflowName: 'default',
    });

    processor.onEnd({
      name: 'workflow.default',
      attributes: {
        'takt.run.id': 'run-1',
        'takt.workflow.status': 'completed',
        'takt.workflow.iterations': 1,
      },
    } as unknown as ReadableSpan);

    // Only the first registration is active: one workflow_start, records routed to it.
    expect(readRecords(firstLogPath).map((record) => record.type)).toEqual([
      'workflow_start',
      'workflow_complete',
    ]);
    expect(existsSync(secondLogPath)).toBe(false);
  });

  it('routes span records to the matching registered run', () => {
    const firstLogPath = createTempLogPath();
    const secondLogPath = createTempLogPath();
    const processor = new SessionLogSpanProcessor();

    processor.register({
      runId: 'run-1',
      shadowLogPath: firstLogPath,
      sanitizedTask: 'first task',
      workflowName: 'default',
    });
    processor.register({
      runId: 'run-2',
      shadowLogPath: secondLogPath,
      sanitizedTask: 'second task',
      workflowName: 'default',
    });

    processor.onEnd({
      name: 'workflow.default',
      attributes: {
        'takt.run.id': 'run-2',
        'takt.workflow.status': 'completed',
        'takt.workflow.iterations': 1,
      },
    } as unknown as ReadableSpan);
    processor.onEnd({
      name: 'workflow.default',
      attributes: {
        'takt.run.id': 'run-1',
        'takt.workflow.status': 'aborted',
        'takt.workflow.iterations': 2,
      },
    } as unknown as ReadableSpan);

    expect(readRecords(firstLogPath)).toEqual([
      expect.objectContaining({
        type: 'workflow_start',
        task: 'first task',
      }),
      expect.objectContaining({
        type: 'workflow_abort',
        iterations: 2,
      }),
    ]);
    expect(readRecords(secondLogPath)).toEqual([
      expect.objectContaining({
        type: 'workflow_start',
        task: 'second task',
      }),
      expect.objectContaining({
        type: 'workflow_complete',
        iterations: 1,
      }),
    ]);
  });

  it('orders judge stage records after phase_start even though their spans end first', () => {
    const shadowLogPath = createTempLogPath();
    const processor = new SessionLogSpanProcessor({
      runId: 'run-1',
      shadowLogPath,
      sanitizedTask: 'task',
      workflowName: 'default',
    });
    const judgePhaseSpan = {
      name: 'phase.implement.judge',
      startTime: [1_778_777_200, 0],
      endTime: [1_778_777_205, 0],
      attributes: {
        'takt.run.id': 'run-1',
        'takt.step.name': 'implement',
        'takt.step.iteration': 1,
        'takt.phase.number': 3,
        'takt.phase.name': 'judge',
        'takt.phase.execution_id': 'implement:3:1:1',
        'takt.phase.system_prompt': 'Judge system',
        'takt.phase.user_instruction': 'Judge user',
        'takt.phase.status': 'done',
      },
    };
    const judgeStageSpan = {
      name: 'judge_stage.implement.1.structured_output',
      endTime: [1_778_777_203, 0],
      attributes: {
        'takt.run.id': 'run-1',
        'takt.step.name': 'implement',
        'takt.step.iteration': 1,
        'takt.phase.execution_id': 'implement:3:1:1',
        'takt.judge.stage': 1,
        'takt.judge.method': 'structured_output',
        'takt.judge.status': 'done',
        'takt.judge.instruction': 'Judge it',
        'takt.judge.response': 'ok',
      },
    };

    // Real lifecycle: the phase span starts, the judge-stage child span ends
    // while the phase span is still open, then the phase span ends.
    processor.onStart(judgePhaseSpan as unknown as Span, {} as Context);
    processor.onEnd(judgeStageSpan as unknown as ReadableSpan);
    processor.onEnd(judgePhaseSpan as unknown as ReadableSpan);

    expect(readRecords(shadowLogPath).map((record) => record.type)).toEqual([
      'workflow_start',
      'phase_start',
      'phase_judge_stage',
      'phase_complete',
    ]);
  });

  it('writes phase start and complete records from the completed phase span snapshot', () => {
    const shadowLogPath = createTempLogPath();
    const processor = new SessionLogSpanProcessor({
      runId: 'run-1',
      shadowLogPath,
      sanitizedTask: 'task',
      workflowName: 'default',
    });
    const phaseSpan = {
      name: 'phase.implement.execute',
      startTime: [1_778_777_200, 0],
      endTime: [1_778_777_205, 0],
      attributes: {
        'takt.run.id': 'run-1',
        'takt.step.name': 'implement',
        'takt.step.iteration': 1,
        'takt.phase.number': 1,
        'takt.phase.name': 'execute',
        'takt.phase.execution_id': 'implement:1:1:1',
        'takt.phase.instruction': 'Implement it',
        'takt.phase.system_prompt': 'System prompt',
        'takt.phase.user_instruction': 'User instruction',
        'takt.phase.status': 'done',
        'takt.phase.result.content': 'implemented',
      },
    };

    processor.onStart(phaseSpan as unknown as Span, {} as Context);
    processor.onEnd(phaseSpan as unknown as ReadableSpan);

    expect(readRecords(shadowLogPath)).toEqual([
      expect.objectContaining({
        type: 'workflow_start',
      }),
      expect.objectContaining({
        type: 'phase_start',
        phaseExecutionId: 'implement:1:1:1',
        systemPrompt: 'System prompt',
        userInstruction: 'User instruction',
      }),
      expect.objectContaining({
        type: 'phase_complete',
        phaseExecutionId: 'implement:1:1:1',
        status: 'done',
        content: 'implemented',
      }),
    ]);
  });
});
