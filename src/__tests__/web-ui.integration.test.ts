import { appendFile, lstat, mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRunCollection, readRunDetail } from '../features/web-ui/run-store.js';
import { readRunLogArtifactsForDiagnostics } from '../features/web-ui/run-log-cache.js';
import { startWebUi, stopWebUi } from '../features/web-ui/index.js';
import { createWebUiServer, listenWebUiServer } from '../features/web-ui/server.js';
import {
  acquireWebUiInstanceLock,
  readWebUiInstance,
  stopWebUiInstance,
} from '../features/web-ui/instance-lock.js';
import type { WebChatService } from '../features/web-ui/chat.js';
import { resolveStatePaths, type StatePaths } from '../core/execution/locations.js';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import { CentralTaskRepository } from '../infra/task/centralStateRepository.js';
import { buildExecutionTrace } from '../../web-ui/public/execution-model.js';

const servers: Server[] = [];
const temporaryDirectories = new Set<string>();

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      resolvePromise();
    });
  });
}

function requestStatus(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = httpRequest(url, { headers }, (response) => {
      response.resume();
      response.once('end', () => resolvePromise(response.statusCode ?? 0));
    });
    request.once('error', rejectPromise);
    request.end();
  });
}

async function readFirstSnapshot(response: Response): Promise<unknown> {
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  if (response.body === null) throw new Error('SSE response body is missing');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    while (!pending.includes('\n\n')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('SSE stream ended before its first event');
      pending += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel();
  }
  const data = pending
    .slice(0, pending.indexOf('\n\n'))
    .split('\n')
    .find((line) => line.startsWith('data: '));
  if (data === undefined) throw new Error('SSE snapshot data is missing');
  return JSON.parse(data.slice('data: '.length)) as unknown;
}

afterEach(async () => {
  const activeServers = servers.splice(0);
  const directories = [...temporaryDirectories];
  temporaryDirectories.clear();
  try {
    await Promise.all(activeServers.map((server) => closeServer(server)));
  } finally {
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  }
});

async function createProject(): Promise<string> {
  return createTemporaryDirectory('takt-web-ui-');
}

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  temporaryDirectories.add(directory);
  return directory;
}

async function createArtifactState(): Promise<StatePaths> {
  const globalConfigDirectory = await createTemporaryDirectory('takt-web-ui-global-');
  const projectDirectory = await createProject();
  const project = await registerProject({ globalConfigDirectory, projectDirectory, command: 'run' });
  return resolveStatePaths(globalConfigDirectory, project.stateId);
}

async function writeRun(
  statePaths: StatePaths,
  slug: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<string> {
  const runRoot = join(statePaths.runsDirectory, slug);
  await mkdir(join(runRoot, 'reports'), { recursive: true });
  await mkdir(join(runRoot, 'logs'), { recursive: true });
  const meta = {
    task: `Task for ${slug}`,
    workflow: 'default',
    runSlug: slug,
    runRoot: `runs/${slug}`,
    reportDirectory: `runs/${slug}/reports`,
    contextDirectory: `runs/${slug}/context`,
    logsDirectory: `runs/${slug}/logs`,
    status: 'running',
    startTime: '2026-08-24T00:00:00.000Z',
    ...overrides,
  };
  await writeFile(join(runRoot, 'meta.json'), JSON.stringify(meta));
  return runRoot;
}

describe('Web UI run artifacts', () => {
  it('lists runs newest first and ignores directories without meta', async () => {
    const statePaths = await createArtifactState();
    await writeRun(statePaths, 'older', { startTime: '2026-08-23T00:00:00.000Z' });
    await writeRun(statePaths, 'newer', { startTime: '2026-08-24T00:00:00.000Z' });
    await mkdir(join(statePaths.runsDirectory, 'debug-output'));

    const result = await readRunCollection(statePaths);

    expect(result.runs.map((run) => run.slug)).toEqual(['newer', 'older']);
    expect(result.warnings).toEqual([]);
  });

  it('returns reports and concise live session events without sidecars', async () => {
    const statePaths = await createArtifactState();
    const runRoot = await writeRun(statePaths, 'detail', {
      currentStep: 'implement',
      currentIteration: 3,
    });
    await writeFile(join(runRoot, 'reports', 'implementation.md'), '# Result\nDone');
    await writeFile(join(runRoot, 'logs', 'session.jsonl'), [
      JSON.stringify({
        type: 'phase_start',
        step: 'implement',
        phaseName: 'execute',
        timestamp: '2026-08-24T00:00:01.000Z',
        systemPrompt: 'must not be exposed',
      }),
      JSON.stringify({
        type: 'phase_complete',
        step: 'implement',
        phaseName: 'execute',
        status: 'done',
        content: 'Implemented',
        timestamp: '2026-08-24T00:00:02.000Z',
      }),
      '',
    ].join('\n'));
    await writeFile(
      join(runRoot, 'logs', 'session-provider-events.jsonl'),
      JSON.stringify({ type: 'provider_secret', content: 'ignored' }),
    );

    const detail = await readRunDetail(statePaths, 'detail');

    expect(detail.reports).toEqual([{
      filename: 'implementation.md',
      content: '# Result\nDone',
      omitted: false,
    }]);
    expect(detail.events).toEqual([
      {
        type: 'phase_complete',
        step: 'implement',
        phaseName: 'execute',
        status: 'done',
        content: 'Implemented',
        timestamp: '2026-08-24T00:00:02.000Z',
      },
      {
        type: 'phase_start',
        step: 'implement',
        phaseName: 'execute',
        timestamp: '2026-08-24T00:00:01.000Z',
      },
    ]);
  });

  it('preserves numeric workflow call instances for the execution map', async () => {
    const statePaths = await createArtifactState();
    const runRoot = await writeRun(statePaths, 'workflow-call');
    await writeFile(join(runRoot, 'logs', 'session.jsonl'), [
      JSON.stringify({
        type: 'workflow_call_start',
        workflow: 'default',
        step: 'review',
        childWorkflow: 'review-fix',
        callInstance: 3,
        timestamp: '2026-08-24T00:00:01.000Z',
      }),
      JSON.stringify({
        type: 'workflow_call_complete',
        workflow: 'default',
        step: 'review',
        childWorkflow: 'review-fix',
        callInstance: 3,
        status: 'completed',
        timestamp: '2026-08-24T00:00:02.000Z',
      }),
      '',
    ].join('\n'));

    const detail = await readRunDetail(statePaths, 'workflow-call');

    expect(detail.events.map((event) => event.callInstance)).toEqual(['3', '3']);
  });

  it('passes validated call paths through lifecycle history without collapsing child passes', async () => {
    const statePaths = await createArtifactState();
    const runRoot = await writeRun(statePaths, 'workflow-call-paths');
    const callStack = (occurrence: number) => [{
      workflow: 'default',
      workflow_ref: 'default',
      step: 'delegate',
      kind: 'workflow_call',
      occurrence,
    }];
    const childStack = (occurrence: number) => [
      ...callStack(occurrence),
      {
        workflow: 'child',
        workflow_ref: 'child',
        step: 'work',
        kind: 'agent',
        occurrence: 1,
      },
    ];
    const records = [1, 2].flatMap((occurrence) => [
      {
        type: 'workflow_call_start',
        workflow: 'default',
        step: 'delegate',
        childWorkflow: 'child',
        callInstance: occurrence,
        stack: callStack(occurrence),
        timestamp: `2026-08-24T00:00:0${occurrence}.000Z`,
      },
      {
        type: 'step_start',
        workflow: 'child',
        step: 'work',
        iteration: 1,
        stack: childStack(occurrence),
        timestamp: `2026-08-24T00:00:1${occurrence}.000Z`,
      },
      {
        type: 'step_complete',
        workflow: 'child',
        step: 'work',
        iteration: 1,
        status: 'done',
        content: `child-${occurrence}`,
        stack: childStack(occurrence),
        timestamp: `2026-08-24T00:00:2${occurrence}.000Z`,
      },
      {
        type: 'workflow_call_complete',
        workflow: 'default',
        step: 'delegate',
        childWorkflow: 'child',
        callInstance: occurrence,
        status: 'completed',
        stack: callStack(occurrence),
        timestamp: `2026-08-24T00:00:3${occurrence}.000Z`,
      },
    ]);
    await writeFile(join(runRoot, 'logs', 'session.jsonl'), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);

    const detail = await readRunDetail(statePaths, 'workflow-call-paths');
    const trace = buildExecutionTrace(detail.meta, detail.events, detail.history, detail.graphSummary);
    const child = trace.nodes.find((node) => node.workflow === 'child');

    expect(detail.history.find((event) => (
      event.type === 'step_complete'
      && event.stack?.[0]?.occurrence === 1
    ))?.stack).toEqual(childStack(1));
    expect(child?.occurrences).toHaveLength(2);
    expect(new Set(child?.occurrences.map((occurrence) => occurrence.id)).size).toBe(2);
  });

  it('keeps lifecycle history beyond the bounded live-log tail and omits content', async () => {
    const statePaths = await createArtifactState();
    const runRoot = await writeRun(statePaths, 'long-history');
    const records = Array.from({ length: 101 }, (_value, index) => [
      {
        type: 'step_start',
        step: `step-${index + 1}`,
        iteration: 1,
        timestamp: `2026-08-24T00:00:${String(index).padStart(2, '0')}.000Z`,
      },
      {
        type: 'step_complete',
        step: `step-${index + 1}`,
        iteration: 1,
        status: 'done',
        content: 'large result that belongs only in the live log',
        timestamp: `2026-08-24T00:01:${String(index).padStart(2, '0')}.000Z`,
      },
    ]).flat();
    await writeFile(join(runRoot, 'logs', 'session.jsonl'), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);

    const detail = await readRunDetail(statePaths, 'long-history');

    expect(detail.events).toHaveLength(100);
    expect(detail.history).toHaveLength(202);
    expect(detail.history.some((event) => event.step === 'step-1')).toBe(true);
    expect(detail.history.every((event) => event.content === undefined)).toBe(true);
    expect(detail.graphSummary).toMatchObject({
      totalOccurrences: 101,
      truncated: false,
    });
    expect(detail.graphSummary.occurrences).toHaveLength(101);
    const trace = buildExecutionTrace(detail.meta, detail.events, detail.history, detail.graphSummary);
    expect(trace.nodes.find((node) => node.label === 'step-1')?.occurrences[0]).toMatchObject({
      preview: 'large result that belongs only in the live log',
      eventIndexes: [],
    });
  });

  it('keeps graph summary newest-first while rebuilding chronological transitions', async () => {
    const statePaths = await createArtifactState();
    const runRoot = await writeRun(statePaths, 'graph-order');
    await writeFile(join(runRoot, 'logs', 'session.jsonl'), [
      { type: 'step_start', step: 'plan', iteration: 1 },
      { type: 'step_complete', step: 'plan', iteration: 1, status: 'done' },
      { type: 'step_start', step: 'review', iteration: 1 },
      { type: 'step_complete', step: 'review', iteration: 1, status: 'done' },
      '',
    ].map((record) => JSON.stringify(record)).join('\n'));

    const detail = await readRunDetail(statePaths, 'graph-order');
    const trace = buildExecutionTrace(detail.meta, detail.events, detail.history, detail.graphSummary);
    const plan = trace.nodes.find((node) => node.label === 'plan');
    const review = trace.nodes.find((node) => node.label === 'review');

    expect(detail.graphSummary.occurrences.map((event) => event.step)).toEqual(['review', 'plan']);
    expect(trace.nodes.map((node) => node.label)).toEqual(['plan', 'review']);
    expect(trace.transitions).toEqual([
      expect.objectContaining({
        source: plan?.occurrences[0]?.id,
        target: review?.occurrences[0]?.id,
        sourceLogicalId: plan?.id,
        targetLogicalId: review?.id,
        kind: 'transition',
      }),
    ]);
  });

  it('evicts old graph occurrences but retains the latest current occurrence and counts starts once', async () => {
    const statePaths = await createArtifactState();
    const runRoot = await writeRun(statePaths, 'graph-cap');
    const records: Array<Readonly<Record<string, unknown>>> = Array.from({ length: 10_001 }, (_value, index) => ({
      type: 'step_start',
      step: `step-${index + 1}`,
      iteration: 1,
    }));
    records.splice(10_000, 1, {
      type: 'workflow_call_start',
      workflow: 'default',
      step: 'delegate',
      childWorkflow: 'child',
      callInstance: '1',
      stack: [{
        workflow: 'default',
        workflow_ref: 'default',
        step: 'delegate',
        kind: 'workflow_call',
        occurrence: 1,
      }],
    }, {
      type: 'step_start',
      workflow: 'child',
      step: 'work',
      iteration: 1,
      stack: [
        {
          workflow: 'default',
          workflow_ref: 'default',
          step: 'delegate',
          kind: 'workflow_call',
          occurrence: 1,
        },
        {
          workflow: 'child',
          workflow_ref: 'child',
          step: 'work',
          kind: 'agent',
          occurrence: 1,
        },
      ],
    }, {
      type: 'step_complete',
      workflow: 'child',
      step: 'work',
      iteration: 1,
      status: 'blocked',
      stack: [
        {
          workflow: 'default',
          workflow_ref: 'default',
          step: 'delegate',
          kind: 'workflow_call',
          occurrence: 1,
        },
        {
          workflow: 'child',
          workflow_ref: 'child',
          step: 'work',
          kind: 'agent',
          occurrence: 1,
        },
      ],
    });
    await writeFile(join(runRoot, 'logs', 'session.jsonl'), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);

    const detail = await readRunDetail(statePaths, 'graph-cap');
    const trace = buildExecutionTrace(detail.meta, detail.events, detail.history, detail.graphSummary);

    expect(detail.graphSummary.totalOccurrences).toBe(10_002);
    expect(detail.graphSummary.occurrences).toHaveLength(10_000);
    expect(detail.graphSummary.occurrences[0]?.step).toBe('work');
    expect(trace.nodes.find((node) => node.label === 'work')?.occurrences[0]?.status).toBe('failed');
    expect(trace.graphTruncated).toBe(true);
    expect(trace.graphOccurrenceCount).toBe(10_002);
  });

  it('scans only appended session-log bytes and rebuilds after truncation', async () => {
    const statePaths = await createArtifactState();
    const runRoot = await writeRun(statePaths, 'incremental');
    const path = join(runRoot, 'logs', 'session.jsonl');
    const readDiagnostics = () => readRunLogArtifactsForDiagnostics(
      `${runRoot}:diagnostics`,
      [path],
      async () => undefined,
    );
    const firstRecord = `${JSON.stringify({ type: 'step_start', step: 'first', iteration: 1 })}\n`;
    await writeFile(path, firstRecord);

    const first = await readDiagnostics();
    expect(first.scan.bytesRead).toBe(Buffer.byteLength(firstRecord));
    expect(first.scan.totalBytesRead).toBe(first.scan.bytesRead);

    const appendedRecord = `${JSON.stringify({ type: 'step_complete', step: 'second', iteration: 1, status: 'done' })}\n`;
    await appendFile(path, appendedRecord);
    const second = await readDiagnostics();
    expect(second.scan.bytesRead).toBe(Buffer.byteLength(appendedRecord));
    expect(second.scan.totalBytesRead).toBe(Buffer.byteLength(firstRecord + appendedRecord));
    expect(second.events.map((event) => event.step)).toEqual(['second', 'first']);

    const unchanged = await readDiagnostics();
    expect(unchanged.scan.bytesRead).toBe(0);
    expect(unchanged.scan.reusedBytes).toBeGreaterThanOrEqual(Buffer.byteLength(firstRecord + appendedRecord));

    const replacement = `${JSON.stringify({ type: 'step_start', step: 'replacement', iteration: 1 })}\n`;
    await writeFile(path, replacement);
    const rebuilt = await readDiagnostics();
    expect(rebuilt.scan.bytesRead).toBe(Buffer.byteLength(replacement));
    expect(rebuilt.events.map((event) => event.step)).toEqual(['replacement']);
  });

  it('shares one incremental scan between concurrent run readers', async () => {
    const statePaths = await createArtifactState();
    const runRoot = await writeRun(statePaths, 'shared-cache');
    const record = `${JSON.stringify({ type: 'step_start', step: 'shared', iteration: 1 })}\n`;
    const path = join(runRoot, 'logs', 'session.jsonl');
    await writeFile(path, record);
    const readDiagnostics = () => readRunLogArtifactsForDiagnostics(
      `${runRoot}:diagnostics`,
      [path],
      async () => undefined,
    );

    const [first, second] = await Promise.all([
      readDiagnostics(),
      readDiagnostics(),
    ]);
    expect([first.scan.bytesRead, second.scan.bytesRead].sort((left, right) => left - right))
      .toEqual([0, Buffer.byteLength(record)]);
    expect(first.events).toEqual(second.events);
  });

  it('rebuilds a normal cache after a same-inode larger rewrite', async () => {
    const statePaths = await createArtifactState();
    const runRoot = await writeRun(statePaths, 'same-inode-rewrite');
    const path = join(runRoot, 'logs', 'session.jsonl');
    const readDiagnostics = () => readRunLogArtifactsForDiagnostics(
      `${runRoot}:diagnostics`,
      [path],
      async () => undefined,
    );
    const oldRecord = `${JSON.stringify({ type: 'step_start', step: 'old', iteration: 1 })}\n`;
    await writeFile(path, oldRecord);
    const before = await lstat(path);
    const first = await readDiagnostics();
    expect(first.events.map((event) => event.step)).toEqual(['old']);

    const replacement = `${JSON.stringify({
      type: 'step_start',
      step: `replacement-${'x'.repeat(128)}`,
      iteration: 1,
    })}\n`;
    expect(Buffer.byteLength(replacement)).toBeGreaterThan(Buffer.byteLength(oldRecord));
    await writeFile(path, replacement);
    const after = await lstat(path);
    expect(after.ino).toBe(before.ino);

    const rebuilt = await readDiagnostics();
    expect(rebuilt.scan.bytesRead).toBe(Buffer.byteLength(replacement));
    expect(rebuilt.events.map((event) => event.step)).toEqual([`replacement-${'x'.repeat(128)}`]);
  });

  it('keeps run detail available for completed and partial oversize records', async () => {
    const statePaths = await createArtifactState();
    const completedRoot = await writeRun(statePaths, 'oversize-complete');
    await writeFile(join(completedRoot, 'logs', 'session.jsonl'), [
      JSON.stringify({ type: 'step_start', step: 'before', iteration: 1 }),
      JSON.stringify({ type: 'step_complete', step: 'oversize', content: 'x'.repeat(1_100_000) }),
      JSON.stringify({ type: 'step_complete', step: 'after', iteration: 1, status: 'done' }),
      '',
    ].join('\n'));
    const completed = await readRunDetail(statePaths, 'oversize-complete');
    expect(completed.events.map((event) => event.step)).toEqual(['after', 'before']);
    expect(completed.warnings.some((warning) => warning.includes('exceeds 1 MiB'))).toBe(true);

    const partialRoot = await writeRun(statePaths, 'oversize-partial');
    await writeFile(join(partialRoot, 'logs', 'session.jsonl'), [
      JSON.stringify({ type: 'step_start', step: 'before', iteration: 1 }),
      `{"type":"step_complete","step":"partial","content":"${'x'.repeat(1_100_000)}`,
    ].join('\n'));
    const partial = await readRunDetail(statePaths, 'oversize-partial');
    expect(partial.events.map((event) => event.step)).toEqual(['before']);
    expect(partial.warnings.some((warning) => warning.includes('exceeds 1 MiB'))).toBe(true);
  });

  it('rejects malformed workflow stacks at the session-log boundary', async () => {
    const statePaths = await createArtifactState();
    const runRoot = await writeRun(statePaths, 'invalid-stack');
    await writeFile(join(runRoot, 'logs', 'session.jsonl'), `${JSON.stringify({
      type: 'step_start',
      workflow: 'child',
      step: 'work',
      iteration: 1,
      stack: [{ workflow: 'child' }],
    })}\n`);

    await expect(readRunDetail(statePaths, 'invalid-stack')).rejects.toThrow(
      'Session log workflow stack[0].workflow_ref',
    );
    await expect(readRunDetail(statePaths, 'invalid-stack')).rejects.toThrow(
      'Session log workflow stack[0].workflow_ref',
    );
    await appendFile(
      join(runRoot, 'logs', 'session.jsonl'),
      `${JSON.stringify({ type: 'step_start', step: 'after-invalid' })}\n`,
    );
    await expect(readRunDetail(statePaths, 'invalid-stack')).rejects.toThrow(
      'Session log workflow stack[0].workflow_ref',
    );
    await writeFile(
      join(runRoot, 'logs', 'session.jsonl'),
      `${JSON.stringify({ type: 'step_start', step: `replacement-${'x'.repeat(128)}` })}\n`,
    );
    await expect(readRunDetail(statePaths, 'invalid-stack')).resolves.toMatchObject({
      events: [{ step: `replacement-${'x'.repeat(128)}` }],
    });
  });

  it('rejects artifact directories outside the selected run', async () => {
    const statePaths = await createArtifactState();
    await writeRun(statePaths, 'unsafe', { logsDirectory: 'runs' });

    await expect(readRunDetail(statePaths, 'unsafe')).rejects.toThrow(
      'Logs directory is outside the run directory',
    );
  });

  it('warns and ignores a symlinked run root', async () => {
    const statePaths = await createArtifactState();
    const target = await writeRun(statePaths, 'target');
    await symlink(target, join(statePaths.runsDirectory, 'linked'));

    const result = await readRunCollection(statePaths);

    expect(result.runs.map((run) => run.slug)).toEqual(['target']);
    expect(result.warnings).toContain('linked: run root must not be a symbolic link');
  });

  it('rejects a symlinked runs collection root before enumeration', async () => {
    const statePaths = await createArtifactState();
    await mkdir(statePaths.stateDirectory, { recursive: true });
    const outside = await createTemporaryDirectory('takt-web-ui-runs-outside-');
    await symlink(outside, statePaths.runsDirectory);

    await expect(readRunCollection(statePaths)).rejects.toThrow(/symbolic link|runs directory/i);
  });

  it('rejects an ordinary runs-root replacement with the expected inode', async () => {
    const statePaths = await createArtifactState();
    await mkdir(statePaths.runsDirectory, { recursive: true });
    const original = await lstat(statePaths.runsDirectory);
    const pinned = {
      ...statePaths,
      runsRootFingerprint: { dev: original.dev, ino: original.ino },
    };
    // Create the replacement while the original is still present. This makes
    // the differing inode deterministic on filesystems that eagerly reuse
    // deleted directory inodes.
    const replacementPath = join(statePaths.stateDirectory, 'runs-replacement');
    await mkdir(replacementPath);
    await rm(statePaths.runsDirectory, { recursive: true, force: true });
    await rename(replacementPath, statePaths.runsDirectory);
    const replacement = await lstat(statePaths.runsDirectory);
    expect(replacement.ino).not.toBe(original.ino);

    await expect(readRunCollection(pinned)).rejects.toThrow(/fingerprint|identity/i);
  });

  it('rejects a symlinked report root before reading outside the run', async () => {
    const statePaths = await createArtifactState();
    const runRoot = await writeRun(statePaths, 'symlink-report');
    const outside = await createTemporaryDirectory('takt-web-ui-outside-');
    await rm(join(runRoot, 'reports'), { recursive: true, force: true });
    await symlink(outside, join(runRoot, 'reports'));

    await expect(readRunDetail(statePaths, 'symlink-report')).rejects.toThrow(/symbolic link/i);
  });
});

describe('Web UI HTTP boundary', () => {
  it('stops while an EventSource connection is active', async () => {
    const globalConfigDirectory = await createTemporaryDirectory('takt-web-ui-global-');
    const previousConfigDirectory = process.env.TAKT_CONFIG_DIR;
    process.env.TAKT_CONFIG_DIR = globalConfigDirectory;
    let server: Server | undefined;
    try {
      const started = await startWebUi({ port: 0 });
      server = started.server;
      servers.push(server);
      const response = await fetch(`${started.origin}/api/tasks/events`);
      expect(response.status).toBe(200);
      if (response.body === null) throw new Error('SSE response body is missing');
      const reader = response.body.getReader();
      await reader.read();

      await expect(stopWebUi()).resolves.toMatchObject({ disposition: 'stopped' });
      expect(server.listening).toBe(false);
      await reader.cancel().catch(() => undefined);
    } finally {
      if (server?.listening) {
        server.closeAllConnections();
        await closeServer(server);
      }
      if (server !== undefined) {
        const serverIndex = servers.indexOf(server);
        if (serverIndex >= 0) servers.splice(serverIndex, 1);
      }
      if (previousConfigDirectory === undefined) delete process.env.TAKT_CONFIG_DIR;
      else process.env.TAKT_CONFIG_DIR = previousConfigDirectory;
    }
  });

  it('gracefully stops the owned Web UI through its private control endpoint', async () => {
    const globalConfigDirectory = await createTemporaryDirectory('takt-web-ui-global-');
    const projectDirectory = await createProject();
    const project = await registerProject({ globalConfigDirectory, projectDirectory, command: 'ui' });
    const repository = await CentralTaskRepository.open({
      globalConfigDirectory,
      stateId: project.stateId,
      locationId: project.locationId,
      canonicalDirectory: project.canonicalDirectory,
      displayName: project.displayName,
      fingerprint: project.fingerprint,
    });
    const execution = await repository.enqueueAndClaim({
      task: 'keep running across UI restart',
      workflow: 'default',
      worktree: false,
    });
    await repository.setStartingPid({
      taskId: execution.task.taskId,
      generation: execution.task.generation,
      executionId: execution.executionId,
      ownerToken: execution.ownerToken,
      pid: process.pid,
      runId: execution.runId,
    });
    const lock = await acquireWebUiInstanceLock(globalConfigDirectory, 0);
    let server: Server | undefined;
    server = await createWebUiServer({
      globalConfigDirectory,
      launch: async () => ({ pid: 9001, disposition: 'started' as const, mode: 'run' as const }),
      control: {
        token: lock.controlToken,
        onStopRequested: () => server?.close(),
      },
    });
    servers.push(server);
    server.once('close', () => {
      void lock.release();
    });
    const origin = await listenWebUiServer(server, 0);
    await lock.publishOrigin(origin);

    await expect(fetch(`${origin}/api/control/stop`, { method: 'POST' }))
      .resolves.toMatchObject({ status: 403 });
    await expect(stopWebUiInstance(globalConfigDirectory)).resolves.toMatchObject({
      disposition: 'stopped',
      instance: { origin, pid: process.pid },
    });

    expect(server.listening).toBe(false);
    await expect(readWebUiInstance(globalConfigDirectory)).resolves.toBeUndefined();
    await expect(repository.readTask(execution.task.taskId)).resolves.toMatchObject({
      status: 'starting',
      activeExecution: { pid: process.pid, runId: execution.runId },
    });
    servers.splice(servers.indexOf(server), 1);
  });

  it('rejects non-loopback Host and Origin before exposing the session token', async () => {
    const globalConfigDirectory = await createTemporaryDirectory('takt-web-ui-global-');
    const server = await createWebUiServer({
      globalConfigDirectory,
      launch: async () => ({ pid: 9001, disposition: 'started' as const, mode: 'run' as const }),
    });
    servers.push(server);
    const origin = await listenWebUiServer(server, 0);

    await expect(requestStatus(`${origin}/api/session`, { Host: 'attacker.example' }))
      .resolves.toBe(403);
    await expect(fetch(`${origin}/api/session`, { headers: { Origin: 'http://attacker.example' } }))
      .resolves.toMatchObject({ status: 403 });
  });

  it('serves a viewer-first shell with a separate task surface', async () => {
    const globalConfigDirectory = await createTemporaryDirectory('takt-web-ui-global-');
    const server = await createWebUiServer({
      globalConfigDirectory,
      launch: async () => ({ pid: 9001, disposition: 'started' as const, mode: 'run' as const }),
    });
    servers.push(server);
    const origin = await listenWebUiServer(server, 0);

    const response = await fetch(origin);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<details id="execution-context" class="execution-context" open>');
    expect(html.indexOf('id="execution-context"')).toBeLessThan(html.indexOf('<main'));
    expect(html).toContain('id="viewer-screen"');
    expect(html).toContain('id="new-task-button"');
    expect(html).toContain('id="language-toggle"');
    expect(html).toContain('id="chat-surface"');
    expect(html).toContain('id="run-inspector"');
    expect(html).not.toContain('id="ai-consult-button"');
    expect(html).not.toContain('class="workspace"');
    expect(html).toContain('<section id="chat-panel" class="chat-panel">');
    expect(html).toContain('rows="1"');
    expect(html).toContain('aria-keyshortcuts="Meta+Enter Control+Enter"');
    expect(html).toContain('id="chat-go-button"');
    expect(html).toContain('id="chat-setup-button"');
    expect(html).toContain('id="watch-button"');
    expect(html).toContain('id="refresh-button"');
    expect(html).toContain('id="chat-new-button"');
    expect(html).toContain('>新しい会話</button>');
    expect(html).toContain('id="chat-thinking"');
    expect(html).toContain('id="chat-thinking-content"');
    expect(html).toContain('id="chat-collapse-button"');
    expect(html).not.toContain('id="chat-resizer"');
    expect(html).not.toContain('data-composer-mode');
    expect(html).not.toContain('id="run-form"');

    const uiStateResponse = await fetch(`${origin}/ui-state.js`);
    expect(uiStateResponse.status).toBe(200);
    const i18nResponse = await fetch(`${origin}/i18n.js`);
    expect(i18nResponse.status).toBe(200);
    expect(await i18nResponse.text()).toContain("DEFAULT_LOCALE = 'ja'");
    const executionMapResponse = await fetch(`${origin}/execution-map.js`);
    expect(executionMapResponse.status).toBe(200);
    expect(await executionMapResponse.text()).toContain('renderExecutionMap');
    const executionViewResponse = await fetch(`${origin}/execution-view.js`);
    expect(executionViewResponse.status).toBe(200);
    expect(await executionViewResponse.text()).toContain("from './execution-model.js'");
  });

  it('browses and registers an unregistered execution directory', async () => {
    const globalConfigDirectory = await createTemporaryDirectory('takt-web-ui-global-');
    const parentDirectory = await createTemporaryDirectory('takt-directory-browser-');
    const projectDirectory = join(parentDirectory, 'new-project');
    await mkdir(projectDirectory);
    const server = await createWebUiServer({
      globalConfigDirectory,
      launch: async () => ({ pid: 9001, disposition: 'started' as const, mode: 'run' as const }),
      pickNativeDirectory: async () => ({ cancelled: false, path: projectDirectory }),
    });
    servers.push(server);
    const origin = await listenWebUiServer(server, 0);

    const logoResponse = await fetch(`${origin}/takt-logo.svg`);
    expect(logoResponse.status).toBe(200);
    expect(logoResponse.headers.get('content-type')).toBe('image/svg+xml');
    expect(await logoResponse.text()).toContain('#5bbb91');

    const unauthorized = await fetch(`${origin}/api/directories/browse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: parentDirectory }),
    });
    expect(unauthorized.status).toBe(403);

    const token = (await (await fetch(`${origin}/api/session`)).json() as { token: string }).token;
    const nativePickerResponse = await fetch(`${origin}/api/directories/native-picker`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TAKT-Web-Token': token,
      },
      body: '{}',
    });
    expect(nativePickerResponse.status).toBe(200);
    await expect(nativePickerResponse.json()).resolves.toMatchObject({
      cancelled: false,
      directory: { path: projectDirectory },
    });

    const browseResponse = await fetch(`${origin}/api/directories/browse`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TAKT-Web-Token': token,
      },
      body: JSON.stringify({ path: parentDirectory }),
    });
    expect(browseResponse.status).toBe(200);
    await expect(browseResponse.json()).resolves.toMatchObject({
      path: parentDirectory,
      directories: [{ name: 'new-project', path: projectDirectory }],
    });

    const registerResponse = await fetch(`${origin}/api/projects`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TAKT-Web-Token': token,
      },
      body: JSON.stringify({ projectDirectory }),
    });
    expect(registerResponse.status).toBe(201);
    const registered = await registerResponse.json() as { id: string };

    await expect((await fetch(`${origin}/api/projects`)).json()).resolves.toMatchObject({
      projects: [{ id: registered.id, projectDirectory, lastCommand: 'ui', available: true }],
    });

    const relativePath = await fetch(`${origin}/api/projects`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TAKT-Web-Token': token,
      },
      body: JSON.stringify({ projectDirectory: 'relative/project' }),
    });
    expect(relativePath.status).toBe(400);
  });

  it('serves runs and accepts token-authenticated launches', async () => {
    const globalConfigDirectory = await createTemporaryDirectory('takt-web-ui-global-');
    const projectDirectory = await createProject();
    const project = await registerProject({
      globalConfigDirectory,
      projectDirectory,
      command: 'run',
    });
    const central = await CentralTaskRepository.open({
      globalConfigDirectory,
      stateId: project.stateId,
      locationId: project.locationId,
      canonicalDirectory: project.canonicalDirectory,
      displayName: project.displayName,
      fingerprint: project.fingerprint,
    });
    const centralTask = await central.enqueueAndClaim({
      task: 'Task for 20260824-example',
      workflow: 'default',
      worktree: false,
    });
    await writeRun(central.paths, centralTask.runId);
    const launches: unknown[] = [];
    const requeues: unknown[] = [];
    const server = await createWebUiServer({
      globalConfigDirectory,
      launch: async (directory, request) => {
        launches.push({ directory, request });
        return { pid: 9001, disposition: 'started' as const, mode: 'run' as const };
      },
      requeue: async (directory, taskId) => {
        requeues.push({ directory, taskId });
        return { pid: 9002, disposition: 'started' as const, mode: 'run' as const };
      },
    });
    servers.push(server);
    const origin = await listenWebUiServer(server, 0);

    const listResponse = await fetch(`${origin}/api/tasks`);
    expect(listResponse.status).toBe(200);
    const tasks = (await listResponse.json() as { tasks: Array<Record<string, unknown>> }).tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      taskId: centralTask.task.taskId,
      projectId: project.id,
      projectDirectory,
      runs: [{ slug: centralTask.runId, attempt: 1 }],
    });

    await expect(readFirstSnapshot(await fetch(`${origin}/api/tasks/events`))).resolves.toMatchObject({
      tasks: [{ taskId: centralTask.task.taskId, projectId: project.id }],
    });
    await expect(readFirstSnapshot(await fetch(
      `${origin}/api/runs/${centralTask.runId}/events?project=${project.id}`,
    ))).resolves.toMatchObject({
      project: { id: project.id },
      meta: { runSlug: centralTask.runId, status: 'running' },
    });
    const runUrl = `${origin}/api/runs/${centralTask.runId}?project=${project.id}`;
    const firstRunResponse = await fetch(runUrl);
    expect(firstRunResponse.status).toBe(200);
    const firstRunPayload = await firstRunResponse.json() as Record<string, unknown>;
    expect(firstRunPayload).not.toHaveProperty('scan');
    const secondRunResponse = await fetch(runUrl);
    expect(secondRunResponse.status).toBe(200);
    expect(await secondRunResponse.text()).toBe(JSON.stringify(firstRunPayload));

    const projectsResponse = await fetch(`${origin}/api/projects`);
    expect(projectsResponse.status).toBe(200);
    await expect(projectsResponse.json()).resolves.toMatchObject({
      projects: [{ id: project.id, projectDirectory, available: true }],
    });

    const rejected = await fetch(`${origin}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, prompt: 'Build it', workflow: 'default' }),
    });
    expect(rejected.status).toBe(403);

    const token = (await (await fetch(`${origin}/api/session`)).json() as { token: string }).token;
    const invalidProject = await fetch(`${origin}/api/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TAKT-Web-Token': token,
      },
      body: JSON.stringify({
        projectId: 'f'.repeat(64),
        prompt: 'Build it',
        workflow: 'default',
      }),
    });
    expect(invalidProject.status).toBe(400);

    const accepted = await fetch(`${origin}/api/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TAKT-Web-Token': token,
      },
      body: JSON.stringify({ projectId: project.id, prompt: 'Build it', workflow: 'default' }),
    });
    expect(accepted.status).toBe(202);
    await expect(accepted.json()).resolves.toEqual({
      pid: 9001,
      disposition: 'started',
      mode: 'run',
    });
    expect(launches).toEqual([{
      directory: projectDirectory,
      request: {
        prompt: 'Build it',
        workflow: 'default',
        worktree: true,
        autoPr: false,
        draftPr: false,
      },
    }]);

    const requeueResponse = await fetch(`${origin}/api/tasks/${centralTask.task.taskId}/requeue`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TAKT-Web-Token': token,
      },
      body: JSON.stringify({ projectId: project.id }),
    });
    expect(requeueResponse.status).toBe(202);
    await expect(requeueResponse.json()).resolves.toEqual({
      pid: 9002,
      disposition: 'started',
      mode: 'run',
    });
    expect(requeues).toEqual([{ directory: projectDirectory, taskId: centralTask.task.taskId }]);
  });

  it('joins project discovery with central consumer status without stale cleanup', async () => {
    const globalConfigDirectory = await createTemporaryDirectory('takt-web-ui-global-');
    const projectDirectory = await createProject();
    const project = await registerProject({
      globalConfigDirectory,
      projectDirectory,
      command: 'run',
    });
    const central = await CentralTaskRepository.open({
      globalConfigDirectory,
      stateId: project.stateId,
      locationId: project.locationId,
      canonicalDirectory: project.canonicalDirectory,
      displayName: project.displayName,
      fingerprint: project.fingerprint,
    });
    const acquired = await central.enqueueAndClaim({ task: 'watch', workflow: 'default', worktree: false });
    await central.setStartingPid({
      taskId: acquired.task.taskId,
      generation: acquired.task.generation,
      executionId: acquired.executionId,
      ownerToken: acquired.ownerToken,
      pid: process.pid,
    });

    const server = await createWebUiServer({
      globalConfigDirectory,
      launch: async () => ({ pid: 9001, disposition: 'reused' as const, mode: 'watch' as const }),
    });
    servers.push(server);
    const origin = await listenWebUiServer(server, 0);

    await expect((await fetch(`${origin}/api/projects`)).json()).resolves.toMatchObject({
      projects: [{
        id: project.id,
        state: { stateId: project.stateId, status: 'starting' },
      }],
    });
  });

  it('serves categorized workflows and token-authenticated chat messages', async () => {
    const globalConfigDirectory = await createTemporaryDirectory('takt-web-ui-global-');
    const projectDirectory = await createProject();
    const project = await registerProject({
      globalConfigDirectory,
      projectDirectory,
      command: 'run',
    });
    const messages: Array<{ sessionId: string; text: string }> = [];
    const settings: Array<{ sessionId: string; workflow: string; mode: string }> = [];
    const restarts: string[] = [];
    const chat: WebChatService = {
      create: (_directory, request) => ({
        id: 'chat-session-1',
        ...request,
        intro: '相談内容を教えてください。',
        provider: 'codex',
        model: 'gpt-5',
      }),
      reconfigure: (sessionId, request) => {
        settings.push({ sessionId, ...request });
        return {
          id: sessionId,
          ...request,
          intro: '切り替えました。',
          provider: 'codex',
          model: 'gpt-5',
        };
      },
      restart: (sessionId) => {
        restarts.push(sessionId);
        return {
          id: sessionId,
          workflow: 'review',
          mode: 'grill-me',
          intro: '新しい会話です。',
          provider: 'codex',
          model: 'gpt-5',
        };
      },
      send: async (sessionId, text, onThinking) => {
        messages.push({ sessionId, text });
        onThinking?.('確認しています。');
        if (text === '失敗する') throw new Error('provider failed');
        return { kind: 'assistant_response', content: '回答です。' };
      },
    };
    const server = await createWebUiServer({
      globalConfigDirectory,
      launch: async () => ({ pid: 9001, disposition: 'started' as const, mode: 'run' as const }),
      getWorkflowCatalog: () => ({
        categories: [{
          id: 'development',
          label: '開発',
          workflows: [{ id: 'default', description: '標準', source: 'builtin' }],
        }],
        warnings: [],
      }),
      chat,
    });
    servers.push(server);
    const origin = await listenWebUiServer(server, 0);

    await expect((await fetch(`${origin}/api/workflows?project=${project.id}`)).json()).resolves.toEqual({
      categories: [{
        id: 'development',
        label: '開発',
        workflows: [{ id: 'default', description: '標準', source: 'builtin' }],
      }],
      warnings: [],
    });

    const unauthorized = await fetch(`${origin}/api/chat/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, workflow: 'default', mode: 'assistant' }),
    });
    expect(unauthorized.status).toBe(403);

    const token = (await (await fetch(`${origin}/api/session`)).json() as { token: string }).token;
    const created = await fetch(`${origin}/api/chat/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TAKT-Web-Token': token,
      },
      body: JSON.stringify({ projectId: project.id, workflow: 'default', mode: 'assistant' }),
    });
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      id: 'chat-session-1',
      workflow: 'default',
      mode: 'assistant',
    });

    const reconfigured = await fetch(`${origin}/api/chat/sessions/chat-session-1/settings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TAKT-Web-Token': token,
      },
      body: JSON.stringify({ workflow: 'review', mode: 'grill-me' }),
    });
    expect(reconfigured.status).toBe(200);
    await expect(reconfigured.json()).resolves.toMatchObject({
      id: 'chat-session-1',
      workflow: 'review',
      mode: 'grill-me',
    });
    expect(settings).toEqual([{
      sessionId: 'chat-session-1',
      workflow: 'review',
      mode: 'grill-me',
    }]);

    const restarted = await fetch(`${origin}/api/chat/sessions/chat-session-1/restart`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TAKT-Web-Token': token,
      },
      body: '{}',
    });
    expect(restarted.status).toBe(200);
    await expect(restarted.json()).resolves.toMatchObject({
      id: 'chat-session-1',
      workflow: 'review',
      mode: 'grill-me',
    });
    expect(restarts).toEqual(['chat-session-1']);

    const response = await fetch(`${origin}/api/chat/sessions/chat-session-1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TAKT-Web-Token': token,
      },
      body: JSON.stringify({ text: '相談したい' }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/x-ndjson; charset=utf-8');
    const records = (await response.text()).trim().split('\n').map((line) => JSON.parse(line) as unknown);
    expect(records).toEqual([
      { type: 'thinking', content: '確認しています。' },
      { type: 'reply', reply: { kind: 'assistant_response', content: '回答です。' } },
    ]);
    expect(messages).toEqual([{ sessionId: 'chat-session-1', text: '相談したい' }]);

    const failedResponse = await fetch(`${origin}/api/chat/sessions/chat-session-1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TAKT-Web-Token': token,
      },
      body: JSON.stringify({ text: '失敗する' }),
    });
    const failedRecords = (await failedResponse.text()).trim().split('\n')
      .map((line) => JSON.parse(line) as unknown);
    expect(failedRecords).toEqual([
      { type: 'thinking', content: '確認しています。' },
      { type: 'error', message: 'provider failed' },
    ]);
  });
});
