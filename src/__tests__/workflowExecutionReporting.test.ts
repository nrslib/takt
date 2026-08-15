import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionLog } from '../shared/utils/index.js';
import { MAX_AGENT_FAILURE_MESSAGE_BYTES } from '../shared/types/agent-failure.js';

const { mockNotifyError } = vi.hoisted(() => ({
  mockNotifyError: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  notifyError: (...args: unknown[]) => mockNotifyError(...args),
}));

import {
  reportWorkflowFailure,
  reportWorkflowCompletion,
} from '../features/tasks/execute/workflowExecutionReporting.js';

function createSessionLog(): SessionLog {
  return {
    task: 'Implement subworkflow call',
    projectDir: '/project',
    workflowName: 'takt-default',
    iterations: 3,
    startTime: '2026-04-14T00:00:00.000Z',
    status: 'running',
    history: [],
  };
}

function createOut() {
  return {
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  };
}

describe('workflowExecutionReporting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Given trace discovery metadata, When reporting workflow completion, Then it prints TraceQL query hints', () => {
    const out = createOut();

    reportWorkflowCompletion(
      out as never,
      {
        ...createSessionLog(),
        endTime: '2026-04-14T00:00:01.000Z',
      },
      3,
      '/tmp/project/.takt/runs/run-843/logs/session.jsonl',
      true,
      {
        queries: [
          '{ resource.service.name = "takt" && span."takt.run.id" = "run-843" }',
          '{ resource.service.name = "takt" && span."takt.task.pr_number" = 826 }',
        ],
      },
    );

    expect(out.success).toHaveBeenCalledWith(expect.stringContaining('Workflow completed (3 iterations'));
    expect(out.info).toHaveBeenCalledWith('Session log: /tmp/project/.takt/runs/run-843/logs/session.jsonl');
    expect(out.info).toHaveBeenCalledWith('TraceQL discovery:');
    expect(out.info).toHaveBeenCalledWith('  { resource.service.name = "takt" && span."takt.run.id" = "run-843" }');
    expect(out.info).toHaveBeenCalledWith('  { resource.service.name = "takt" && span."takt.task.pr_number" = 826 }');
  });

  it('Given unsafe trace discovery metadata, When reporting workflow completion, Then it sanitizes TraceQL query hints', () => {
    const out = createOut();

    reportWorkflowCompletion(
      out as never,
      {
        ...createSessionLog(),
        endTime: '2026-04-14T00:00:01.000Z',
      },
      3,
      '/tmp/project/.takt/runs/run-843/logs/session.jsonl',
      false,
      {
        queries: [
          '{ span."takt.run.id" = "run-843" }\x1b[31m\n\tbad\x1f',
        ],
      },
    );

    expect(out.info).toHaveBeenCalledWith('TraceQL discovery:');
    expect(out.info).toHaveBeenCalledWith('  { span."takt.run.id" = "run-843" }\\n\\tbad\\x1f');
  });

  it('Given trace discovery metadata, When reporting workflow abort, Then it prints the same TraceQL query hints', () => {
    const out = createOut();

    reportWorkflowFailure(
      out as never,
      {
        ...createSessionLog(),
        endTime: '2026-04-14T00:00:01.000Z',
      },
      2,
      'Step "write_tests" failed',
      'aborted',
      '/tmp/project/.takt/runs/run-843/logs/session.jsonl',
      false,
      {
        queries: [
          '{ resource.service.name = "takt" && span."takt.run.id" = "run-843" }',
        ],
      },
    );

    expect(out.error).toHaveBeenCalledWith(expect.stringContaining('Workflow aborted after 2 iterations'));
    expect(out.info).toHaveBeenCalledWith('Session log: /tmp/project/.takt/runs/run-843/logs/session.jsonl');
    expect(out.info).toHaveBeenCalledWith('TraceQL discovery:');
    expect(out.info).toHaveBeenCalledWith('  { resource.service.name = "takt" && span."takt.run.id" = "run-843" }');
  });

  it('reports failed status without calling it aborted', () => {
    const out = createOut();

    reportWorkflowFailure(
      out as never,
      {
        ...createSessionLog(),
        endTime: '2026-04-14T00:00:01.000Z',
      },
      1,
      'Runtime setup failed',
      'failed',
      '/tmp/project/.takt/runs/run-843/logs/session.jsonl',
      true,
    );

    expect(out.error).toHaveBeenCalledWith(
      expect.stringContaining('Workflow failed after 1 iterations'),
    );
    expect(out.error).not.toHaveBeenCalledWith(
      expect.stringContaining('Workflow aborted'),
    );
    expect(mockNotifyError).toHaveBeenCalledWith(
      'TAKT',
      expect.stringContaining('Failed: Runtime setup failed'),
    );
  });

  it('sanitizes only the terminal workflow failure while preserving the notification reason', () => {
    const out = createOut();
    const unsafeReason = 'provider failed\x1b]52;c;secret\x07\r\x00';

    reportWorkflowFailure(
      out as never,
      createSessionLog(),
      1,
      unsafeReason,
      'failed',
      '/tmp/project/.takt/runs/run-843/logs/session.jsonl',
      true,
    );

    const terminalMessage = out.error.mock.calls[0]?.[0] as string;
    expect(terminalMessage).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(terminalMessage).toContain('provider failed');
    expect(terminalMessage).toContain('\\r\\x00');
    expect(mockNotifyError).toHaveBeenCalledWith(
      'TAKT',
      expect.stringContaining(unsafeReason),
    );
  });

  it('keeps a multibyte workflow failure within the byte limit while preserving its marker', () => {
    const out = createOut();
    const marker = '[TRUNCATED: 12000 bytes, full text: /tmp/failure.txt]';
    const contentBytes = MAX_AGENT_FAILURE_MESSAGE_BYTES - Buffer.byteLength(marker, 'utf8');
    const reason = `${'界'.repeat(Math.floor(contentBytes / 3))}${'x'.repeat(contentBytes % 3)}${marker}`;

    reportWorkflowFailure(
      out as never,
      createSessionLog(),
      1,
      reason,
      'failed',
      '/tmp/project/.takt/runs/run-843/logs/session.jsonl',
      false,
    );

    const terminalMessage = out.error.mock.calls[0]?.[0] as string;
    expect(Buffer.byteLength(terminalMessage, 'utf8')).toBeLessThanOrEqual(MAX_AGENT_FAILURE_MESSAGE_BYTES);
    expect(terminalMessage).not.toContain('\uFFFD');
    expect(terminalMessage).toContain(marker);
  });
});
