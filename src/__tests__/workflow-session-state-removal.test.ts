import { basename, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import type { SessionLog } from '../infra/fs/index.js';

const io = vi.hoisted(() => ({
  read: vi.fn((path: string) => ({ state: { path, exists: false } })),
  write: vi.fn<(path: string, content: string | Buffer, mode: number, expected: unknown) => void>(),
  atomicWrite: vi.fn<(path: string, content: string) => void>(),
  append: vi.fn(),
  projectLog: vi.fn(),
  finalizeMeta: vi.fn(),
  renderTrace: vi.fn(() => '# Trace'),
}));

vi.mock('../shared/utils/private-file.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/utils/private-file.js')>()),
  readPrivateFileState: io.read,
  writePrivateFileWithModeExpected: io.write,
}));
vi.mock('../infra/config/paths.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/config/paths.js')>()),
  ensureDir: vi.fn(),
}));
vi.mock('../infra/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/config/index.js')>()),
  writeFileAtomic: io.atomicWrite,
}));
vi.mock('../infra/fs/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/fs/index.js')>()),
  appendNdjsonLine: io.append,
}));
vi.mock('../features/tasks/execute/runMeta.js', () => ({ finalizeFileRunMeta: io.finalizeMeta }));
vi.mock('../features/tasks/execute/sessionLogger.js', () => ({ projectTerminalSessionRecord: io.projectLog }));
vi.mock('../features/tasks/execute/traceReport.js', () => ({
  assertTraceParams: vi.fn(),
  renderTraceReportFromLogs: io.renderTrace,
}));

import { createFileWorkflowRunTerminalPublisher } from '../features/tasks/execute/fileWorkflowRunTerminalPublisher.js';
import { createWorkflowTerminalPayloadFactory } from '../features/tasks/execute/workflowTerminalPayload.js';
import { projectWorkflowTerminalStage } from '../features/tasks/execute/workflowTerminalProjection.js';

const cwd = '/test-project';
const runPaths = buildRunPaths(cwd, 'terminal-run');
const endTime = '2026-10-09T00:01:00.000Z';
const endings = [
  { status: 'completed', reason: undefined },
  { status: 'failed', reason: 'provider unavailable' },
  { status: 'aborted', reason: 'Workflow aborted by step transition' },
  { status: 'aborted', reason: 'user_interrupted' },
] as const;

function createPayload(ending: typeof endings[number]) {
  const sessionLog: SessionLog = {
    task: 'current task',
    projectDir: cwd,
    iterations: 2,
    workflowName: 'test-workflow',
    startTime: '2026-10-09T00:00:00.000Z',
    status: 'running',
    history: [],
  };
  return createWorkflowTerminalPayloadFactory({
    runSlug: runPaths.slug,
    projectCwd: cwd,
    task: sessionLog.task,
    workflowName: sessionLog.workflowName,
    sessionLog,
    sessionId: 'test-session',
    ndjsonLogPath: join(runPaths.logsAbs, 'test-session.jsonl'),
    traceReportMode: 'redacted',
  }).create({
    ...ending,
    iterations: 2,
    endTime,
  });
}

beforeEach(() => { vi.clearAllMocks(); });

describe('workflow terminal publication without previous-run notices', () => {
  it.each(endings)('should finish $status ($reason) without creating a notice file', async (ending) => {
    const payload = createPayload(ending);
    const publisher = createFileWorkflowRunTerminalPublisher({ runPaths });

    await publisher.finish({ status: ending.status === 'aborted' ? 'cancelled' : ending.status, iteration: 2, reason: ending.reason }, payload);

    expect(io.finalizeMeta).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      runPaths, status: ending.status, iterations: 2, endTime,
    }));
    expect(io.append).toHaveBeenCalledExactlyOnceWith(join(runPaths.logsAbs, 'test-session.jsonl'), payload.sessionRecord);
    expect(io.atomicWrite).toHaveBeenCalledExactlyOnceWith(join(runPaths.runRootAbs, 'trace.md'), '# Trace');
    const writePaths = [...io.write.mock.calls, ...io.atomicWrite.mock.calls].map(([path]) => basename(String(path)));
    expect(writePaths).not.toContain('session-state.json');
  });

  it.each(endings)('should project the $status ($reason) terminal log without creating a notice file', (ending) => {
    const payload = createPayload(ending);

    projectWorkflowTerminalStage('session', payload, {
      runPaths,
      publicationId: 'test-publication',
      metaProjection: { project: vi.fn() },
    });

    expect(io.projectLog).toHaveBeenCalledExactlyOnceWith(
      join(runPaths.logsAbs, 'test-session.jsonl'),
      { task: payload.task, workflowName: payload.workflowName, startTime: payload.sessionLog.startTime },
      { ...payload.sessionRecord, publicationId: 'test-publication' },
    );
    expect(io.write.mock.calls.map(([path]) => basename(String(path)))).not.toContain('session-state.json');
  });

  it.each(endings)('should produce a $status ($reason) terminal payload containing only run records', (ending) => {
    const payload = createPayload(ending);

    expect(payload.sessionLog).toMatchObject({
      task: 'current task', workflowName: 'test-workflow',
      status: ending.status === 'completed' ? 'completed' : 'aborted', endTime,
    });
    expect(payload.sessionRecord).toMatchObject({
      type: ending.status === 'completed' ? 'workflow_complete' : 'workflow_abort',
      iterations: 2, endTime,
    });
    expect(payload).not.toHaveProperty('sessionState');
    expect(payload).not.toHaveProperty('sessionStorageDirectory');
  });
});
