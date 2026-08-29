import { appendFile, lstat, mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readRunCollection,
  readRunDetail,
  readRunOccurrenceArtifacts,
} from '../features/web-ui/run-store.js';
import {
  MAX_OCCURRENCE_PROMPT_BODY_BYTES,
  MAX_OCCURRENCE_PROMPT_COUNT,
  MAX_PROMPT_LINE_OWNERSHIP_ENTRIES,
  readRunLogArtifactsForDiagnostics,
} from '../features/web-ui/run-log-cache.js';
import { startWebUi, stopWebUi } from '../features/web-ui/index.js';
import { startCentralTaskActionConversation } from '../features/web-ui/launcher.js';
import { createWebUiServer, listenWebUiServer } from '../features/web-ui/server.js';
import {
  acquireWebUiInstanceLock,
  readWebUiInstance,
  stopWebUiInstance,
} from '../features/web-ui/instance-lock.js';
import {
  WebChatInputError,
  type WebChatService,
  type WebTaskActionClaim,
  type WebTaskActionContext,
} from '../features/web-ui/chat.js';
import {
  CentralTaskActionError,
  executeCentralTaskAction,
} from '../features/web-ui/task-actions.js';
import { resolveStatePaths, type StatePaths } from '../core/execution/locations.js';
import type {
  DynamicParallelFixedSubStep,
  DynamicParallelPoolSubStep,
  WorkflowConfig,
} from '../core/models/index.js';
import { buildWorkflowCallSiteIdentity } from '../core/workflow/workflow-call-site-identity.js';
import { buildWorkflowStepParticipationIdentity } from '../core/workflow/workflow-step-participation-index.js';
import { buildRunPathsFromRunsDirectory } from '../core/workflow/run/run-paths.js';
import { attachWorkflowOpaqueRef } from '../shared/workflowConfigMetadata.js';
import {
  prepareWorkflowExecutionBundle,
  publishWorkflowExecutionBundle,
} from '../features/tasks/execute/workflowExecutionBundle.js';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import { CentralTaskRepository } from '../infra/task/centralStateRepository.js';
import { createSharedClone } from '../infra/task/index.js';
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

function runFixtureGit(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_EDITOR: 'true',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
}

async function createGitProjectFixture() {
  const globalConfigDirectory = await createTemporaryDirectory('takt-web-ui-git-global-');
  const projectDirectory = await createProject();
  runFixtureGit(projectDirectory, ['init', '-b', 'main']);
  runFixtureGit(projectDirectory, ['config', 'user.name', 'TAKT Test']);
  runFixtureGit(projectDirectory, ['config', 'user.email', 'takt-test@example.invalid']);
  await writeFile(join(projectDirectory, 'README.md'), 'fixture\n');
  runFixtureGit(projectDirectory, ['add', 'README.md']);
  runFixtureGit(projectDirectory, ['commit', '-m', 'fixture']);
  const project = await registerProject({ globalConfigDirectory, projectDirectory, command: 'ui' });
  const repository = await CentralTaskRepository.open({
    globalConfigDirectory,
    stateId: project.stateId,
    locationId: project.locationId,
    canonicalDirectory: project.canonicalDirectory,
    displayName: project.displayName,
    fingerprint: project.fingerprint,
  });
  return { globalConfigDirectory, projectDirectory, project, repository };
}

async function createCompletedGitTask(
  options: { readonly branch?: string; readonly worktree?: string } = {},
) {
  const fixture = await createGitProjectFixture();
  const branch = options.branch ?? 'feature/action';
  const worktreePath = options.worktree ?? join(
    await createTemporaryDirectory('takt-web-ui-worktrees-'),
    'clone',
  );
  const reserved = await fixture.repository.enqueueAndClaim({
    task: 'completed action task',
    workflow: 'default',
    worktree: worktreePath,
    branch,
    baseBranch: 'main',
  });
  const adopted = await fixture.repository.adopt({
    taskId: reserved.task.taskId,
    generation: reserved.task.generation,
    executionId: reserved.executionId,
    ownerToken: reserved.ownerToken,
  });
  const clone = createSharedClone(fixture.projectDirectory, {
    worktree: worktreePath,
    worktreeBaseDirectory: join(worktreePath, '..'),
    branch,
    baseBranch: 'main',
    cloneMetadataDirectory: fixture.repository.paths.worktreeMetadataDirectory,
    skipProjectLocalTaktSync: true,
    taskSlug: 'action-fixture',
  });
  await fixture.repository.updateExecutionContext({
    taskId: reserved.task.taskId,
    generation: adopted.generation,
    executionId: reserved.executionId,
    ownerToken: reserved.ownerToken,
    worktreePath: clone.path,
    branch: clone.branch,
  });
  await writeFile(join(clone.path, 'change.txt'), 'change\n');
  runFixtureGit(clone.path, ['add', 'change.txt']);
  runFixtureGit(clone.path, ['commit', '-m', 'change']);
  await fixture.repository.terminal({
    taskId: reserved.task.taskId,
    generation: adopted.generation,
    executionId: reserved.executionId,
    ownerToken: reserved.ownerToken,
    status: 'completed',
  });
  const task = await fixture.repository.readTask(reserved.task.taskId);
  if (task === undefined) throw new Error('fixture task was not persisted');
  return { ...fixture, task, clonePath: clone.path, branch };
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
    expect(detail.events).toMatchObject([
      {
        type: 'phase_complete',
        step: 'implement',
        phaseName: 'execute',
        status: 'done',
        content: 'Implemented',
        timestamp: '2026-08-24T00:00:02.000Z',
        occurrenceId: expect.any(String),
      },
      {
        type: 'phase_start',
        step: 'implement',
        phaseName: 'execute',
        timestamp: '2026-08-24T00:00:01.000Z',
        occurrenceId: expect.any(String),
      },
    ]);
    expect(detail.events[0]?.occurrenceId).toBe(detail.events[1]?.occurrenceId);
  });

  it('reads canonical workflow-call site namespaces from persisted run metadata', async () => {
    const statePaths = await createArtifactState();
    const namespace = 'iteration-1--step-delegate--workflow-child--site-' + 'a'.repeat(64);
    const runRoot = await writeRun(statePaths, 'canonical-resume-metadata', {
      resume_point: {
        version: 2,
        stack: [{
          workflow: 'root',
          workflow_ref: 'root-ref',
          step: 'delegate',
          kind: 'workflow_call',
          occurrence: 1,
          call_instance: 1,
        }],
        iteration: 1,
        elapsed_ms: 0,
        workflow_call_invocations: {
          '{"workflow":"root-ref","step":"delegate","calls":[]}': {
            call_instance: 1,
            report_namespace_segment: namespace,
          },
        },
        workflow_step_participations: {},
      },
    });
    await writeFile(join(runRoot, 'logs', 'session.jsonl'), '');

    const detail = await readRunDetail(statePaths, 'canonical-resume-metadata');

    expect(detail.meta.resumePoint?.workflow_call_invocations).toMatchObject({
      '{"workflow":"root-ref","step":"delegate","calls":[]}': {
        report_namespace_segment: namespace,
      },
    });
  });

  it('accepts equal resume aliases and rejects conflicting aliases', async () => {
    const statePaths = await createArtifactState();
    const resumePoint = {
      version: 2,
      stack: [{
        workflow: 'root',
        workflow_ref: 'root-ref',
        step: 'review',
        kind: 'agent' as const,
        occurrence: 1,
      }],
      iteration: 1,
      elapsed_ms: 0,
      workflow_call_invocations: {},
      workflow_step_participations: {},
    };
    await writeRun(statePaths, 'equal-resume-aliases', {
      resumePoint,
      resume_point: { ...resumePoint },
    });
    await expect(readRunDetail(statePaths, 'equal-resume-aliases')).resolves.toMatchObject({
      meta: { resumePoint },
    });

    await writeRun(statePaths, 'conflicting-resume-aliases', {
      resumePoint,
      resume_point: { ...resumePoint, iteration: 2 },
    });
    await expect(readRunDetail(statePaths, 'conflicting-resume-aliases')).rejects.toThrow(
      'resumePoint and resume_point must contain the same value',
    );
  });

  it('scopes occurrence reports and prompts to the selected canonical stack', async () => {
    const statePaths = await createArtifactState();
    const firstStack = [
      {
        workflow: 'root',
        workflow_ref: 'root-ref',
        step: 'delegate',
        kind: 'workflow_call',
        occurrence: 1,
      },
      {
        workflow: 'child',
        workflow_ref: 'child-ref',
        step: 'review',
        kind: 'agent',
        occurrence: 1,
      },
    ];
    const secondStack = firstStack.map((frame) => ({ ...frame, occurrence: 2 }));
    const childWorkflow = {
      name: 'child',
      [Symbol.for('takt.workflowOpaqueRef')]: 'child-ref',
    } as unknown as WorkflowConfig;
    const namespaceFor = (occurrence: number) => buildWorkflowCallSiteIdentity({
      stack: [{ ...firstStack[0]!, kind: 'workflow_call' as const, occurrence }],
      childWorkflow,
    }).runPathSegment;
    const firstNamespace = namespaceFor(1);
    const secondNamespace = namespaceFor(2);
    const wrongSiteNamespace = 'iteration-1--step-delegate--workflow-child--site-0000000000000000000000000000000000000000000000000000000000000000';
    const participationIdentity = (instance: number) => JSON.stringify({
      workflow: 'child-ref',
      step: 'review',
      calls: [{ workflow: 'root-ref', step: 'delegate', kind: 'workflow_call', instance }],
    });
    const runRoot = await writeRun(statePaths, 'occurrence-artifacts', {
      resume_point: {
        version: 2,
        stack: [{ ...secondStack[0]!, call_instance: 2 }, secondStack[1]!],
        iteration: 2,
        elapsed_ms: 0,
        workflow_call_invocations: {
          '{"workflow":"root-ref","step":"delegate","calls":[]}': {
            call_instance: 2,
            report_namespace_segment: secondNamespace,
          },
        },
        workflow_step_participations: {
          [participationIdentity(1)]: { report_names: ['first.md'] },
          [participationIdentity(2)]: { report_names: ['second.md'] },
        },
      },
    });
    await mkdir(join(runRoot, 'reports', 'subworkflows', firstNamespace), { recursive: true });
    await mkdir(join(runRoot, 'reports', 'subworkflows', secondNamespace), { recursive: true });
    await mkdir(join(runRoot, 'reports', 'subworkflows', wrongSiteNamespace), { recursive: true });
    await mkdir(join(runRoot, 'reports', 'subworkflows', 'iteration-9--step-other--workflow-other'), { recursive: true });
    await writeFile(join(runRoot, 'reports', 'subworkflows', firstNamespace, 'first.md'), 'first report');
    await writeFile(join(runRoot, 'reports', 'subworkflows', firstNamespace, 'stale.md'), 'stale report');
    await writeFile(join(runRoot, 'reports', 'subworkflows', secondNamespace, 'second.md'), 'second report');
    await writeFile(join(runRoot, 'reports', 'subworkflows', wrongSiteNamespace, 'wrong-site.md'), 'wrong site report');
    await writeFile(
      join(runRoot, 'reports', 'subworkflows', 'iteration-9--step-other--workflow-other', 'outside.md'),
      'outside report',
    );
    await writeFile(join(runRoot, 'logs', 'session.jsonl'), [
      {
        type: 'step_start',
        step: 'review',
        workflow: 'child',
        iteration: 1,
        stack: firstStack,
      },
      {
        type: 'phase_start',
        step: 'review',
        workflow: 'child',
        phase: 1,
        phaseName: 'execute',
        phaseExecutionId: 'review:1:1:1',
        iteration: 1,
        stack: firstStack,
        systemPrompt: 'system prompt 1',
        userInstruction: 'user instruction 1',
        instruction: 'phase instruction 1',
      },
      {
        type: 'step_complete',
        step: 'review',
        workflow: 'child',
        iteration: 1,
        status: 'done',
        stack: firstStack,
      },
      {
        type: 'step_start',
        step: 'review',
        workflow: 'child',
        iteration: 2,
        stack: secondStack,
      },
      {
        type: 'phase_start',
        step: 'review',
        workflow: 'child',
        phase: 1,
        phaseName: 'execute',
        phaseExecutionId: 'review:2:1:1',
        iteration: 2,
        stack: secondStack,
        systemPrompt: 'system prompt 2',
        userInstruction: 'user instruction 2',
      },
      {
        type: 'phase_start',
        step: 'review',
        workflow: 'child',
        phase: 2,
        phaseName: 'judge',
        phaseExecutionId: 'review:ambiguous:2:1',
        stack: secondStack,
        systemPrompt: 'ambiguous prompt without ITER identity',
        userInstruction: 'ambiguous instruction without ITER identity',
      },
      {
        type: 'step_complete',
        step: 'review',
        workflow: 'child',
        iteration: 2,
        status: 'done',
        stack: secondStack,
      },
    ].map((record) => JSON.stringify(record)).join('\n') + '\n');

    const detail = await readRunDetail(statePaths, 'occurrence-artifacts');
    const firstOccurrence = detail.graphSummary.occurrences.find((event) => event.iteration === 1);
    const secondOccurrence = detail.graphSummary.occurrences.find((event) => event.iteration === 2);
    expect(firstOccurrence?.occurrenceId).toBeDefined();
    expect(secondOccurrence?.occurrenceId).toBeDefined();
    if (firstOccurrence?.occurrenceId === undefined || secondOccurrence?.occurrenceId === undefined) {
      throw new Error('Occurrence fixture was not indexed');
    }

    const first = await readRunOccurrenceArtifacts(statePaths, 'occurrence-artifacts', firstOccurrence.occurrenceId);
    const second = await readRunOccurrenceArtifacts(statePaths, 'occurrence-artifacts', secondOccurrence.occurrenceId);

    expect(first.reports.map((report) => report.filename)).toEqual([
      `subworkflows/${firstNamespace}/first.md`,
    ]);
    expect(first.prompts).toHaveLength(1);
    expect(first.promptsTruncated).toBe(false);
    expect(first.omittedPromptCount).toBe(0);
    expect(first.prompts).toMatchObject([{
      phase: 1,
      systemPrompt: 'system prompt 1',
      userInstruction: 'user instruction 1',
      instruction: 'phase instruction 1',
    }]);
    expect(second.reports.map((report) => report.filename)).toEqual([
      `subworkflows/${secondNamespace}/second.md`,
    ]);
    expect(second.prompts).toHaveLength(2);
    expect(second.promptsTruncated).toBe(false);
    expect(second.omittedPromptCount).toBe(0);
    expect(second.prompts).toMatchObject([
      {
        phase: 1,
        systemPrompt: 'system prompt 2',
        userInstruction: 'user instruction 2',
      },
      {
        phase: 2,
        systemPrompt: 'ambiguous prompt without ITER identity',
        userInstruction: 'ambiguous instruction without ITER identity',
      },
    ]);
  });

  it('restores parallel child report ownership from the canonical stack', async () => {
    const statePaths = await createArtifactState();
    const childWorkflow = {
      name: 'child',
      [Symbol.for('takt.workflowOpaqueRef')]: 'child-ref',
    } as unknown as WorkflowConfig;
    const callFrame = (occurrence: number) => ({
      workflow: 'root',
      workflow_ref: 'root-ref',
      step: 'delegate',
      kind: 'workflow_call' as const,
      occurrence,
      call_instance: occurrence,
    });
    const parallelFrame = {
      workflow: 'child',
      workflow_ref: 'child-ref',
      step: 'reviewers',
      kind: 'parallel' as const,
      occurrence: 1,
    };
    const childStack = (callOccurrence: number, step: string) => [
      {
        ...callFrame(callOccurrence),
      },
      parallelFrame,
      {
        workflow: 'child',
        workflow_ref: 'child-ref',
        step,
        kind: 'agent' as const,
        occurrence: 1,
      },
    ];
    const parentOnlyStack = (callOccurrence: number) => [
      {
        ...callFrame(callOccurrence),
      },
      parallelFrame,
    ];
    const namespaceFor = (occurrence: number) => buildWorkflowCallSiteIdentity({
      stack: [callFrame(occurrence)],
      childWorkflow,
    }).runPathSegment;
    const firstNamespace = namespaceFor(1);
    const secondNamespace = namespaceFor(2);
    const participationIdentity = (callOccurrence: number, step: string) => (
      buildWorkflowStepParticipationIdentity(
        'child-ref',
        step,
        [callFrame(callOccurrence)],
        'reviewers',
      )
    );
    const runRoot = await writeRun(statePaths, 'parallel-child-artifacts', {
      resume_point: {
        version: 2,
        stack: [callFrame(2), parallelFrame, {
          workflow: 'child',
          workflow_ref: 'child-ref',
          step: 'architecture',
          kind: 'agent',
          occurrence: 1,
        }],
        iteration: 2,
        elapsed_ms: 0,
        workflow_call_invocations: {
          '{"workflow":"root-ref","step":"delegate","calls":[]}': {
            call_instance: 2,
            report_namespace_segment: secondNamespace,
          },
        },
        workflow_step_participations: {
          [participationIdentity(1, 'architecture')]: { report_names: ['architecture-1.md'] },
          [participationIdentity(1, 'security')]: { report_names: ['security-1.md'] },
          [participationIdentity(1, 'testing')]: { report_names: ['testing-1.md'] },
          [participationIdentity(2, 'architecture')]: { report_names: ['architecture-2.md'] },
        },
      },
    });
    await mkdir(join(runRoot, 'reports', 'subworkflows', firstNamespace), { recursive: true });
    await mkdir(join(runRoot, 'reports', 'subworkflows', secondNamespace), { recursive: true });
    await writeFile(join(runRoot, 'reports', 'subworkflows', firstNamespace, 'architecture-1.md'), 'architecture 1');
    await writeFile(join(runRoot, 'reports', 'subworkflows', firstNamespace, 'security-1.md'), 'security 1');
    await writeFile(join(runRoot, 'reports', 'subworkflows', firstNamespace, 'testing-1.md'), 'testing 1');
    await writeFile(join(runRoot, 'reports', 'subworkflows', secondNamespace, 'architecture-2.md'), 'architecture 2');
    const records = [
      [1, 'architecture', 'architecture 1'],
      [1, 'security', 'security 1'],
      [2, 'architecture', 'architecture 2'],
    ].flatMap(([callOccurrence, step]) => {
      const numericCallOccurrence = callOccurrence as number;
      const stepName = step as string;
      const stack = childStack(numericCallOccurrence, stepName);
      return [
        {
          type: 'step_start',
          workflow: 'child',
          step: stepName,
          iteration: numericCallOccurrence,
          stack,
        },
        {
          type: 'step_complete',
          workflow: 'child',
          step: stepName,
          iteration: numericCallOccurrence,
          status: 'done',
          stack,
        },
      ];
    });
    records.push(
      {
        type: 'step_start',
        workflow: 'child',
        step: 'testing',
        iteration: 1,
        stack: parentOnlyStack(1),
      },
      {
        type: 'step_complete',
        workflow: 'child',
        step: 'testing',
        iteration: 1,
        status: 'done',
        stack: parentOnlyStack(1),
      },
    );
    await writeFile(
      join(runRoot, 'logs', 'session.jsonl'),
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    );

    const detail = await readRunDetail(statePaths, 'parallel-child-artifacts');
    const architectureOccurrences = detail.graphSummary.occurrences.filter(
      (event) => event.step === 'architecture',
    );
    expect(architectureOccurrences).toHaveLength(2);
    const firstOccurrence = architectureOccurrences.find((event) => event.stack?.[0]?.occurrence === 1);
    const secondOccurrence = architectureOccurrences.find((event) => event.stack?.[0]?.occurrence === 2);
    expect(firstOccurrence?.occurrenceId).toBeDefined();
    expect(secondOccurrence?.occurrenceId).toBeDefined();
    if (firstOccurrence?.occurrenceId === undefined || secondOccurrence?.occurrenceId === undefined) {
      throw new Error('Parallel child occurrences were not indexed');
    }

    const first = await readRunOccurrenceArtifacts(
      statePaths,
      'parallel-child-artifacts',
      firstOccurrence.occurrenceId,
    );
    const second = await readRunOccurrenceArtifacts(
      statePaths,
      'parallel-child-artifacts',
      secondOccurrence.occurrenceId,
    );
    expect(first.reports.map((report) => report.filename)).toEqual([
      `subworkflows/${firstNamespace}/architecture-1.md`,
    ]);
    expect(second.reports.map((report) => report.filename)).toEqual([
      `subworkflows/${secondNamespace}/architecture-2.md`,
    ]);
    const testingOccurrence = detail.graphSummary.occurrences.find(
      (event) => event.step === 'testing' && event.stack?.at(-1)?.kind === 'parallel',
    );
    expect(testingOccurrence?.occurrenceId).toBeDefined();
    if (testingOccurrence?.occurrenceId === undefined) throw new Error('Parent-only parallel occurrence was not indexed');
    const testing = await readRunOccurrenceArtifacts(
      statePaths,
      'parallel-child-artifacts',
      testingOccurrence.occurrenceId,
    );
    expect(testing.reports.map((report) => report.filename)).toEqual([
      `subworkflows/${firstNamespace}/testing-1.md`,
    ]);
  });

  it('returns the recorded ITER result and the frozen condition with judge stages', async () => {
    const statePaths = await createArtifactState();
    const runRoot = await writeRun(statePaths, 'iteration-outcome');
    const stack = [{
      workflow: 'root',
      workflow_ref: 'root-ref',
      step: 'review',
      kind: 'agent' as const,
      occurrence: 1,
    }];
    const frozenWorkflow = attachWorkflowOpaqueRef<WorkflowConfig>({
      name: 'root',
      initialStep: 'review',
      maxSteps: 5,
      steps: [{
        name: 'review',
        kind: 'agent',
        persona: 'review prompt',
        personaDisplayName: 'review',
        instruction: '{task}',
        rules: [
          { condition: { kind: 'semantic', label: 'APPROVE' }, next: 'ship' },
          { condition: { kind: 'semantic', label: 'REVISE' }, next: 'review' },
        ],
      }],
    }, 'root-ref');
    publishWorkflowExecutionBundle(
      buildRunPathsFromRunsDirectory(statePaths.runsDirectory, 'iteration-outcome'),
      prepareWorkflowExecutionBundle({
        rootWorkflow: frozenWorkflow,
        workflowCallResolver: () => null,
        projectCwd: runRoot,
        lookupCwd: runRoot,
        centralExecution: true,
      }),
    );
    await writeFile(join(runRoot, 'logs', 'session.jsonl'), [
      {
        type: 'step_start',
        workflow: 'root',
        step: 'review',
        iteration: 1,
        provider: 'codex',
        providerSource: 'step',
        model: 'gpt-test',
        modelSource: 'step',
        stack,
      },
      {
        type: 'phase_judge_stage',
        workflow: 'root',
        step: 'review',
        phase: 3,
        phaseName: 'judge',
        stage: 1,
        method: 'structured_output',
        status: 'done',
        response: '{"step":2}',
        stack,
      },
      {
        type: 'phase_judge_stage',
        workflow: 'root',
        step: 'review',
        phase: 3,
        phaseName: 'judge',
        stage: 2,
        method: 'text_fallback',
        status: 'done',
        response: 'REVISE',
        stack,
      },
      {
        type: 'step_complete',
        workflow: 'root',
        step: 'review',
        iteration: 1,
        status: 'done',
        matchedRuleIndex: 1,
        matchedRuleMethod: 'structured_output',
        matchMethod: 'structured_output',
        content: 'The review requires another pass.',
        stack,
      },
    ].map((record) => JSON.stringify(record)).join('\n') + '\n');

    const detail = await readRunDetail(statePaths, 'iteration-outcome');
    const occurrence = detail.graphSummary.occurrences.find((event) => event.step === 'review');
    expect(occurrence).toMatchObject({
      matchedRuleIndex: 1,
      matchedRuleMethod: 'structured_output',
      matchMethod: 'structured_output',
      provider: 'codex',
      model: 'gpt-test',
      judgeStages: [
        { stage: 1, method: 'structured_output', status: 'done', response: '{"step":2}' },
        { stage: 2, method: 'text_fallback', status: 'done', response: 'REVISE' },
      ],
    });
    expect(occurrence?.occurrenceId).toBeDefined();
    if (occurrence?.occurrenceId === undefined) throw new Error('Outcome fixture was not indexed');

    await expect(
      readRunOccurrenceArtifacts(statePaths, 'iteration-outcome', occurrence.occurrenceId),
    ).resolves.toMatchObject({
      outcome: {
        matchedRuleIndex: 1,
        condition: 'REVISE',
        nextStep: 'review',
        matchedRuleMethod: 'structured_output',
        matchMethod: 'structured_output',
        provider: 'codex',
        providerSource: 'step',
        model: 'gpt-test',
        modelSource: 'step',
        outputPreview: 'The review requires another pass.',
        judgeStages: [
          { stage: 1, method: 'structured_output', status: 'done', response: '{"step":2}' },
          { stage: 2, method: 'text_fallback', status: 'done', response: 'REVISE' },
        ],
      },
    });
  });

  it('restores frozen conditions from array, fixed, and pool parallel children', async () => {
    const statePaths = await createArtifactState();
    const runRoot = await writeRun(statePaths, 'parallel-frozen-rules', { workflow: 'root' });
    const child = (name: string, label: string, description?: string) => ({
      name,
      ...(description === undefined ? {} : { description }),
      kind: 'agent' as const,
      persona: `${name} prompt`,
      personaDisplayName: name,
      instruction: '{task}',
      rules: [{ condition: { kind: 'semantic' as const, label }, next: 'done' }],
    });
    const workflow = attachWorkflowOpaqueRef<WorkflowConfig>({
      name: 'root',
      initialStep: 'array-parent',
      maxSteps: 10,
      steps: [
        {
          name: 'array-parent',
          kind: 'agent',
          persona: 'parent prompt',
          personaDisplayName: 'array-parent',
          instruction: '{task}',
          parallel: [child('array-child', 'ARRAY'), child('array-other', 'OTHER')],
        },
        {
          name: 'dynamic-parent',
          kind: 'agent',
          persona: 'parent prompt',
          personaDisplayName: 'dynamic-parent',
          instruction: '{task}',
          parallel: {
            kind: 'dynamic',
            fixed: [child('fixed-child', 'FIXED') as DynamicParallelFixedSubStep],
            pool: [child('pool-child', 'POOL', 'Pool child') as DynamicParallelPoolSubStep],
            selection: { mode: 'replace' },
          },
        },
      ],
    }, 'root-ref');
    publishWorkflowExecutionBundle(
      buildRunPathsFromRunsDirectory(statePaths.runsDirectory, 'parallel-frozen-rules'),
      prepareWorkflowExecutionBundle({
        rootWorkflow: workflow,
        workflowCallResolver: () => null,
        projectCwd: runRoot,
        lookupCwd: runRoot,
        centralExecution: true,
      }),
    );
    const parentFrame = (step: string, occurrence: number) => ({
      workflow: 'root',
      workflow_ref: 'root-ref',
      step,
      kind: 'parallel' as const,
      occurrence,
    });
    const records = [
      ['array-child', 'array-parent', 'ARRAY'],
      ['fixed-child', 'dynamic-parent', 'FIXED'],
      ['pool-child', 'dynamic-parent', 'POOL'],
    ].flatMap(([step, parent, _label], index) => {
      const stepName = step as string;
      const parentName = parent as string;
      const iteration = index + 1;
      const stack = [parentFrame(parentName, 1), {
        workflow: 'root',
        workflow_ref: 'root-ref',
        step: stepName,
        kind: 'agent' as const,
        occurrence: 1,
      }];
      return [
        { type: 'step_start', workflow: 'root', step: stepName, iteration, stack },
        {
          type: 'step_complete',
          workflow: 'root',
          step: stepName,
          iteration,
          status: 'done',
          matchedRuleIndex: 0,
          stack,
        },
      ];
    });
    await writeFile(
      join(runRoot, 'logs', 'session.jsonl'),
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    );
    const detail = await readRunDetail(statePaths, 'parallel-frozen-rules');
    for (const [step, label] of [['array-child', 'ARRAY'], ['fixed-child', 'FIXED'], ['pool-child', 'POOL']]) {
      const occurrence = detail.graphSummary.occurrences.find((event) => event.step === step);
      expect(occurrence?.occurrenceId).toBeDefined();
      if (occurrence?.occurrenceId === undefined) throw new Error(`${step} was not indexed`);
      await expect(
        readRunOccurrenceArtifacts(statePaths, 'parallel-frozen-rules', occurrence.occurrenceId),
      ).resolves.toMatchObject({ outcome: { condition: label, nextStep: 'done' } });
    }
  });

  it('scopes prompts to the source log and lifecycle boundary, including incomplete phase identity', async () => {
    const statePaths = await createArtifactState();
    const stack = [
      {
        workflow: 'root',
        workflow_ref: 'root-ref',
        step: 'review',
        kind: 'agent' as const,
        occurrence: 1,
      },
    ];
    const lifecycle = (prompt: string, includeInvalidLine = false) => [
      JSON.stringify({
        type: 'step_start',
        step: 'review',
        workflow: 'root',
        iteration: 1,
        stack,
      }),
      ...(includeInvalidLine ? ['{"type":"phase_start"'] : []),
      JSON.stringify({
        type: 'phase_start',
        step: 'review',
        workflow: 'root',
        phase: 1,
        phaseName: 'execute',
        stack,
        systemPrompt: prompt,
        userInstruction: `instruction-${prompt}`,
      }),
      JSON.stringify({
        type: 'step_complete',
        step: 'review',
        workflow: 'root',
        iteration: 1,
        status: 'done',
        stack,
      }),
    ];
    const runRoot = await writeRun(statePaths, 'prompt-lifecycle-scope');
    await writeFile(join(runRoot, 'logs', 'a.jsonl'), `${[
      ...lifecycle('a-first', true),
      ...lifecycle('a-second'),
    ].join('\n')}\n`);
    await writeFile(join(runRoot, 'logs', 'b.jsonl'), `${lifecycle('b-only').join('\n')}\n`);

    const detail = await readRunDetail(statePaths, 'prompt-lifecycle-scope');
    expect(detail.warnings.some((warning) => warning.includes('not valid JSON'))).toBe(true);
    expect(detail.graphSummary.occurrences).toHaveLength(3);
    const newest = detail.graphSummary.occurrences[0];
    const middle = detail.graphSummary.occurrences[1];
    const oldest = detail.graphSummary.occurrences[2];
    expect(newest?.occurrenceId).toBeDefined();
    expect(middle?.occurrenceId).toBeDefined();
    expect(oldest?.occurrenceId).toBeDefined();
    if (newest?.occurrenceId === undefined || middle?.occurrenceId === undefined || oldest?.occurrenceId === undefined) {
      throw new Error('Prompt lifecycle fixture was not indexed');
    }

    await expect(
      readRunOccurrenceArtifacts(statePaths, 'prompt-lifecycle-scope', newest.occurrenceId),
    ).resolves.toMatchObject({ prompts: [{ systemPrompt: 'b-only' }] });
    await expect(
      readRunOccurrenceArtifacts(statePaths, 'prompt-lifecycle-scope', middle.occurrenceId),
    ).resolves.toMatchObject({ prompts: [{ systemPrompt: 'a-second' }] });
    await expect(
      readRunOccurrenceArtifacts(statePaths, 'prompt-lifecycle-scope', oldest.occurrenceId),
    ).resolves.toMatchObject({ prompts: [{ systemPrompt: 'a-first' }] });
  });

  it('accepts a legacy report namespace when the selected call site is unambiguous', async () => {
    const statePaths = await createArtifactState();
    const runRoot = await writeRun(statePaths, 'legacy-occurrence-artifacts');
    const namespace = 'iteration-1--step-delegate--workflow-child';
    const stack = [
      {
        workflow: 'root',
        workflow_ref: 'root-ref',
        step: 'delegate',
        kind: 'workflow_call',
        occurrence: 1,
      },
      {
        workflow: 'child',
        workflow_ref: 'child-ref',
        step: 'review',
        kind: 'agent',
        occurrence: 1,
      },
    ];
    await mkdir(join(runRoot, 'reports', 'subworkflows', namespace), { recursive: true });
    await writeFile(join(runRoot, 'reports', 'subworkflows', namespace, 'legacy.md'), 'legacy report');
    await writeFile(join(runRoot, 'logs', 'session.jsonl'), [
      {
        type: 'step_start',
        step: 'review',
        workflow: 'child',
        iteration: 1,
        stack,
      },
      {
        type: 'step_complete',
        step: 'review',
        workflow: 'child',
        iteration: 1,
        status: 'done',
        stack,
      },
    ].map((record) => JSON.stringify(record)).join('\n') + '\n');

    const detail = await readRunDetail(statePaths, 'legacy-occurrence-artifacts');
    const occurrenceId = detail.graphSummary.occurrences[0]?.occurrenceId;
    expect(occurrenceId).toBeDefined();
    if (occurrenceId === undefined) throw new Error('Occurrence fixture was not indexed');

    await expect(
      readRunOccurrenceArtifacts(statePaths, 'legacy-occurrence-artifacts', occurrenceId),
    ).resolves.toMatchObject({
      reports: [{ filename: `subworkflows/${namespace}/legacy.md`, content: 'legacy report' }],
    });
  });

  it('does not guess a legacy report namespace when two call sites collide', async () => {
    const statePaths = await createArtifactState();
    const runRoot = await writeRun(statePaths, 'ambiguous-legacy-occurrence-artifacts');
    const namespace = 'iteration-1--step-delegate--workflow-child';
    const stack = (workflowRef: string) => [
      {
        workflow: 'root',
        workflow_ref: workflowRef,
        step: 'delegate',
        kind: 'workflow_call' as const,
        occurrence: 1,
      },
      {
        workflow: 'child',
        workflow_ref: 'child-ref',
        step: 'review',
        kind: 'agent' as const,
        occurrence: 1,
      },
    ];
    const firstStack = stack('root-ref-a');
    const secondStack = stack('root-ref-b');
    await mkdir(join(runRoot, 'reports', 'subworkflows', namespace), { recursive: true });
    await writeFile(join(runRoot, 'reports', 'subworkflows', namespace, 'legacy.md'), 'ambiguous report');
    await writeFile(join(runRoot, 'logs', 'session.jsonl'), [
      1,
      2,
    ].flatMap((iteration) => {
      const currentStack = iteration === 1 ? firstStack : secondStack;
      return [
        {
          type: 'step_start',
          step: 'review',
          workflow: 'child',
          iteration: 1,
          stack: currentStack,
        },
        {
          type: 'step_complete',
          step: 'review',
          workflow: 'child',
          iteration: 1,
          status: 'done',
          stack: currentStack,
        },
      ];
    }).map((record) => JSON.stringify(record)).join('\n') + '\n');

    const detail = await readRunDetail(statePaths, 'ambiguous-legacy-occurrence-artifacts');
    const occurrenceId = detail.graphSummary.occurrences.at(-1)?.occurrenceId;
    expect(occurrenceId).toBeDefined();
    if (occurrenceId === undefined) throw new Error('Occurrence fixture was not indexed');

    await expect(
      readRunOccurrenceArtifacts(statePaths, 'ambiguous-legacy-occurrence-artifacts', occurrenceId),
    ).resolves.toMatchObject({ reports: [] });
  });

  it('assigns lifecycle occurrence IDs without closing on phase completion or merging orphan completions', async () => {
    const statePaths = await createArtifactState();
    const runRoot = await writeRun(statePaths, 'occurrence-boundaries');
    await writeFile(join(runRoot, 'logs', 'session.jsonl'), [
      { type: 'step_start', step: 'review', iteration: 1 },
      { type: 'phase_start', step: 'review', phaseName: 'plan' },
      { type: 'phase_complete', step: 'review', phaseName: 'plan', status: 'done' },
      { type: 'step_complete', step: 'review', iteration: 1, status: 'done' },
      { type: 'step_start', step: 'review', iteration: 2 },
      { type: 'step_complete', step: 'review', iteration: 2, status: 'done' },
      { type: 'step_complete', step: 'orphan', status: 'done' },
    ].map((record) => JSON.stringify(record)).join('\n') + '\n');

    const detail = await readRunDetail(statePaths, 'occurrence-boundaries');
    const chronologicalHistory = detail.history.slice().reverse();
    const reviewStarts = chronologicalHistory.filter((event) => (
      event.type === 'step_start' && event.step === 'review'
    ));
    const firstReviewId = reviewStarts[0]?.occurrenceId;
    const secondReviewId = reviewStarts[1]?.occurrenceId;
    const phaseEvents = chronologicalHistory.filter((event) => event.step === 'review' && event.type.startsWith('phase_'));
    const reviewCompletions = chronologicalHistory.filter((event) => (
      event.type === 'step_complete' && event.step === 'review'
    ));
    const orphanCompletion = chronologicalHistory.find((event) => event.step === 'orphan');
    const lifecycleIds = chronologicalHistory
      .filter((event) => event.step !== undefined)
      .map((event) => event.occurrenceId);

    expect(firstReviewId).toBeDefined();
    expect(secondReviewId).toBeDefined();
    expect(firstReviewId).not.toBe(secondReviewId);
    expect(phaseEvents.every((event) => event.occurrenceId === firstReviewId)).toBe(true);
    expect(reviewCompletions.map((event) => event.occurrenceId)).toEqual([
      firstReviewId,
      secondReviewId,
    ]);
    expect(orphanCompletion?.occurrenceId).toBeDefined();
    expect(orphanCompletion?.occurrenceId).not.toBe(firstReviewId);
    expect(orphanCompletion?.occurrenceId).not.toBe(secondReviewId);
    expect(detail.events.filter((event) => event.step !== undefined)
      .every((event) => lifecycleIds.includes(event.occurrenceId))).toBe(true);
    expect(detail.graphSummary.occurrences.every((event) => lifecycleIds.includes(event.occurrenceId))).toBe(true);
    expect(detail.graphSummary.totalOccurrences).toBe(3);
  });

  it('fails closed for prompts when a lifecycle identity is reopened before it terminates', async () => {
    const statePaths = await createArtifactState();
    const runRoot = await writeRun(statePaths, 'reopened-prompt-lifecycle');
    await writeFile(join(runRoot, 'logs', 'session.jsonl'), [
      {
        type: 'step_start',
        step: 'review',
        workflow: 'default',
        iteration: 1,
      },
      {
        type: 'phase_start',
        step: 'review',
        workflow: 'default',
        phase: 2,
        phaseName: 'old-phase',
        iteration: 1,
        systemPrompt: 'must not be attributed to the old lifecycle',
      },
      {
        type: 'step_start',
        step: 'review',
        workflow: 'default',
        iteration: 2,
      },
      {
        type: 'phase_start',
        step: 'review',
        workflow: 'default',
        phase: 4,
        phaseName: 'new-phase',
        iteration: 2,
        systemPrompt: 'new lifecycle prompt',
      },
      {
        type: 'step_complete',
        step: 'review',
        workflow: 'default',
        iteration: 2,
        status: 'done',
      },
    ].map((record) => JSON.stringify(record)).join('\n') + '\n');

    const detail = await readRunDetail(statePaths, 'reopened-prompt-lifecycle');
    const oldOccurrence = detail.graphSummary.occurrences.find((event) => event.phase === 2);
    const newOccurrence = detail.graphSummary.occurrences.find((event) => event.phase === 4);
    expect(oldOccurrence?.occurrenceId).toBeDefined();
    expect(newOccurrence?.occurrenceId).toBeDefined();
    if (oldOccurrence?.occurrenceId === undefined || newOccurrence?.occurrenceId === undefined) {
      throw new Error('Reopened lifecycle fixture was not indexed');
    }

    await expect(
      readRunOccurrenceArtifacts(statePaths, 'reopened-prompt-lifecycle', oldOccurrence.occurrenceId),
    ).resolves.toMatchObject({ prompts: [] });
    await expect(
      readRunOccurrenceArtifacts(statePaths, 'reopened-prompt-lifecycle', newOccurrence.occurrenceId),
    ).resolves.toMatchObject({ prompts: [{ phase: 4, systemPrompt: 'new lifecycle prompt' }] });
  });

  it('attaches canonical prompts with missing optional scope to a unique active lifecycle', async () => {
    const statePaths = await createArtifactState();
    const stack = [{
      workflow: 'default',
      workflow_ref: 'default-ref',
      step: 'review',
      kind: 'agent' as const,
      occurrence: 1,
    }];
    const runRoot = await writeRun(statePaths, 'optional-prompt-scope');
    await writeFile(join(runRoot, 'logs', 'session.jsonl'), [
      {
        type: 'step_start',
        step: 'review',
        workflow: 'default',
        childWorkflow: 'child',
        callInstance: 7,
        iteration: 3,
        stack,
      },
      {
        type: 'phase_start',
        step: 'review',
        workflow: 'default',
        phase: 1,
        phaseName: 'execute',
        systemPrompt: 'canonical prompt with omitted optional scope',
      },
      {
        type: 'step_complete',
        step: 'review',
        workflow: 'default',
        childWorkflow: 'child',
        callInstance: 7,
        iteration: 3,
        stack,
        status: 'done',
      },
      {
        type: 'step_start',
        step: 'review',
        workflow: 'default',
        childWorkflow: 'child',
        callInstance: 7,
        iteration: 4,
        stack,
      },
      {
        type: 'phase_start',
        step: 'review',
        workflow: 'default',
        phase: 1,
        phaseName: 'execute',
        systemPrompt: 'next occurrence prompt',
      },
      {
        type: 'step_complete',
        step: 'review',
        workflow: 'default',
        childWorkflow: 'child',
        callInstance: 7,
        iteration: 4,
        stack,
        status: 'done',
      },
    ].map((record) => JSON.stringify(record)).join('\n') + '\n');

    const detail = await readRunDetail(statePaths, 'optional-prompt-scope');
    expect(detail.graphSummary.occurrences).toHaveLength(2);
    const occurrenceId = detail.graphSummary.occurrences
      .find((occurrence) => occurrence.iteration === 3)?.occurrenceId;
    const nextOccurrenceId = detail.graphSummary.occurrences
      .find((occurrence) => occurrence.iteration === 4)?.occurrenceId;
    expect(occurrenceId).toBeDefined();
    expect(nextOccurrenceId).toBeDefined();
    if (occurrenceId === undefined || nextOccurrenceId === undefined) {
      throw new Error('Optional scope fixture was not indexed');
    }

    await expect(
      readRunOccurrenceArtifacts(statePaths, 'optional-prompt-scope', occurrenceId),
    ).resolves.toMatchObject({
      prompts: [{
        phase: 1,
        systemPrompt: 'canonical prompt with omitted optional scope',
      }],
    });
    await expect(
      readRunOccurrenceArtifacts(statePaths, 'optional-prompt-scope', nextOccurrenceId),
    ).resolves.toMatchObject({
      prompts: [{
        phase: 1,
        systemPrompt: 'next occurrence prompt',
      }],
    });
  });

  it('does not create a phantom occurrence when an optional scope is ambiguous', async () => {
    const statePaths = await createArtifactState();
    const runRoot = await writeRun(statePaths, 'ambiguous-optional-prompt-scope');
    await writeFile(join(runRoot, 'logs', 'session.jsonl'), [
      {
        type: 'step_start',
        step: 'review',
        workflow: 'default',
        callInstance: 1,
      },
      {
        type: 'step_start',
        step: 'review',
        workflow: 'default',
        callInstance: 2,
      },
      {
        type: 'phase_start',
        step: 'review',
        workflow: 'default',
        phase: 1,
        systemPrompt: 'ambiguous and must be omitted',
      },
      {
        type: 'phase_start',
        step: 'review',
        workflow: 'default',
        callInstance: 1,
        phase: 2,
        systemPrompt: 'unique call instance one',
      },
      {
        type: 'step_complete',
        step: 'review',
        workflow: 'default',
        callInstance: 1,
        status: 'done',
      },
      {
        type: 'step_complete',
        step: 'review',
        workflow: 'default',
        callInstance: 2,
        status: 'done',
      },
    ].map((record) => JSON.stringify(record)).join('\n') + '\n');

    const detail = await readRunDetail(statePaths, 'ambiguous-optional-prompt-scope');
    expect(detail.graphSummary.occurrences).toHaveLength(2);
    expect(detail.graphSummary.occurrences.some((event) => event.phase === 1)).toBe(false);
    expect(detail.history.filter((event) => event.phase === 1)).toHaveLength(1);
    expect(detail.history.find((event) => event.phase === 1)?.occurrenceId).toBeUndefined();
    const firstOccurrence = detail.graphSummary.occurrences.find((event) => event.callInstance === '1');
    const secondOccurrence = detail.graphSummary.occurrences.find((event) => event.callInstance === '2');
    expect(firstOccurrence?.occurrenceId).toBeDefined();
    expect(secondOccurrence?.occurrenceId).toBeDefined();
    if (firstOccurrence?.occurrenceId === undefined || secondOccurrence?.occurrenceId === undefined) {
      throw new Error('Ambiguous optional scope fixture was not indexed');
    }
    await expect(
      readRunOccurrenceArtifacts(statePaths, 'ambiguous-optional-prompt-scope', firstOccurrence.occurrenceId),
    ).resolves.toMatchObject({
      prompts: [{ phase: 2, systemPrompt: 'unique call instance one' }],
    });
    await expect(
      readRunOccurrenceArtifacts(statePaths, 'ambiguous-optional-prompt-scope', secondOccurrence.occurrenceId),
    ).resolves.toMatchObject({ prompts: [] });
  });

  it('fails closed for evicted prompt ownership while retaining recent lines', async () => {
    const statePaths = await createArtifactState();
    const runRoot = await writeRun(statePaths, 'bounded-prompt-ownership');
    const stack = [{
      workflow: 'default',
      workflow_ref: 'default-ref',
      step: 'review',
      kind: 'agent' as const,
      occurrence: 1,
    }];
    const filler = Array.from({ length: MAX_PROMPT_LINE_OWNERSHIP_ENTRIES }, (_, index) => ({
      type: 'phase_start',
      step: 'review',
      workflow: 'default',
      phase: index + 2,
      stack,
    }));
    await writeFile(join(runRoot, 'logs', 'session.jsonl'), [
      {
        type: 'step_start',
        step: 'review',
        workflow: 'default',
        iteration: 1,
        stack,
      },
      {
        type: 'phase_start',
        step: 'review',
        workflow: 'default',
        phase: 1,
        stack,
        systemPrompt: 'old prompt must be evicted',
      },
      ...filler,
      {
        type: 'phase_start',
        step: 'review',
        workflow: 'default',
        phase: filler.length + 2,
        stack,
        systemPrompt: 'new prompt remains indexed',
      },
      {
        type: 'step_complete',
        step: 'review',
        workflow: 'default',
        iteration: 1,
        status: 'done',
        stack,
      },
    ].map((record) => JSON.stringify(record)).join('\n') + '\n');

    const detail = await readRunDetail(statePaths, 'bounded-prompt-ownership');
    const occurrence = detail.graphSummary.occurrences.find((event) => event.step === 'review');
    expect(occurrence?.occurrenceId).toBeDefined();
    if (occurrence?.occurrenceId === undefined) throw new Error('Bounded prompt fixture was not indexed');

    const artifacts = await readRunOccurrenceArtifacts(
      statePaths,
      'bounded-prompt-ownership',
      occurrence.occurrenceId,
    );
    expect(artifacts.prompts.some((prompt) => prompt.systemPrompt === 'old prompt must be evicted')).toBe(false);
    expect(artifacts.prompts.some((prompt) => prompt.systemPrompt === 'new prompt remains indexed')).toBe(true);
  });

  it('bounds occurrence prompt responses by count and reports omitted entries', async () => {
    const statePaths = await createArtifactState();
    const runRoot = await writeRun(statePaths, 'prompt-count-limit');
    const stack = [{
      workflow: 'default',
      workflow_ref: 'default-ref',
      step: 'review',
      kind: 'agent' as const,
      occurrence: 1,
    }];
    const prompts = Array.from({ length: MAX_OCCURRENCE_PROMPT_COUNT + 2 }, (_, index) => ({
      type: 'phase_start',
      step: 'review',
      workflow: 'default',
      phase: index + 1,
      stack,
      systemPrompt: `count-limited prompt ${index + 1}`,
    }));
    await writeFile(join(runRoot, 'logs', 'session.jsonl'), [
      { type: 'step_start', step: 'review', workflow: 'default', iteration: 1, stack },
      ...prompts,
      { type: 'step_complete', step: 'review', workflow: 'default', iteration: 1, status: 'done', stack },
    ].map((record) => JSON.stringify(record)).join('\n') + '\n');

    const detail = await readRunDetail(statePaths, 'prompt-count-limit');
    const occurrence = detail.graphSummary.occurrences.find((event) => event.step === 'review');
    expect(occurrence?.occurrenceId).toBeDefined();
    if (occurrence?.occurrenceId === undefined) throw new Error('Prompt count fixture was not indexed');
    const artifacts = await readRunOccurrenceArtifacts(statePaths, 'prompt-count-limit', occurrence.occurrenceId);
    expect(artifacts.prompts).toHaveLength(MAX_OCCURRENCE_PROMPT_COUNT);
    expect(artifacts.promptsTruncated).toBe(true);
    expect(artifacts.omittedPromptCount).toBe(2);
    expect(artifacts.prompts.at(-1)?.systemPrompt).toBe(
      `count-limited prompt ${MAX_OCCURRENCE_PROMPT_COUNT}`,
    );
  });

  it('bounds the UTF-8 prompt body total and omits a whole over-limit entry', async () => {
    const statePaths = await createArtifactState();
    const runRoot = await writeRun(statePaths, 'prompt-byte-limit');
    const stack = [{
      workflow: 'default',
      workflow_ref: 'default-ref',
      step: 'review',
      kind: 'agent' as const,
      occurrence: 1,
    }];
    const bodyLength = Math.floor(MAX_OCCURRENCE_PROMPT_BODY_BYTES / 3) + 1;
    const prompts = Array.from({ length: 3 }, (_, index) => ({
      type: 'phase_start',
      step: 'review',
      workflow: 'default',
      phase: index + 1,
      stack,
      systemPrompt: 'x'.repeat(bodyLength),
    }));
    await writeFile(join(runRoot, 'logs', 'session.jsonl'), [
      { type: 'step_start', step: 'review', workflow: 'default', iteration: 1, stack },
      ...prompts,
      { type: 'step_complete', step: 'review', workflow: 'default', iteration: 1, status: 'done', stack },
    ].map((record) => JSON.stringify(record)).join('\n') + '\n');

    const detail = await readRunDetail(statePaths, 'prompt-byte-limit');
    const occurrence = detail.graphSummary.occurrences.find((event) => event.step === 'review');
    expect(occurrence?.occurrenceId).toBeDefined();
    if (occurrence?.occurrenceId === undefined) throw new Error('Prompt byte fixture was not indexed');
    const artifacts = await readRunOccurrenceArtifacts(statePaths, 'prompt-byte-limit', occurrence.occurrenceId);
    expect(artifacts.prompts).toHaveLength(2);
    expect(artifacts.prompts.every((prompt) => prompt.systemPrompt?.length === bodyLength)).toBe(true);
    expect(artifacts.promptsTruncated).toBe(true);
    expect(artifacts.omittedPromptCount).toBe(1);
  });

  it('accepts prompt bodies whose UTF-8 total is exactly at the limit', async () => {
    const statePaths = await createArtifactState();
    const runRoot = await writeRun(statePaths, 'prompt-byte-boundary');
    const stack = [{
      workflow: 'default',
      workflow_ref: 'default-ref',
      step: 'review',
      kind: 'agent' as const,
      occurrence: 1,
    }];
    const firstLength = Math.floor(MAX_OCCURRENCE_PROMPT_BODY_BYTES / 3);
    const secondLength = firstLength;
    const thirdLength = MAX_OCCURRENCE_PROMPT_BODY_BYTES - firstLength - secondLength;
    const prompts = [firstLength, secondLength, thirdLength].map((length, index) => ({
      type: 'phase_start',
      step: 'review',
      workflow: 'default',
      phase: index + 1,
      stack,
      systemPrompt: 'x'.repeat(length),
    }));
    await writeFile(join(runRoot, 'logs', 'session.jsonl'), [
      { type: 'step_start', step: 'review', workflow: 'default', iteration: 1, stack },
      ...prompts,
      { type: 'step_complete', step: 'review', workflow: 'default', iteration: 1, status: 'done', stack },
    ].map((record) => JSON.stringify(record)).join('\n') + '\n');

    const detail = await readRunDetail(statePaths, 'prompt-byte-boundary');
    const occurrence = detail.graphSummary.occurrences.find((event) => event.step === 'review');
    expect(occurrence?.occurrenceId).toBeDefined();
    if (occurrence?.occurrenceId === undefined) throw new Error('Prompt boundary fixture was not indexed');
    const artifacts = await readRunOccurrenceArtifacts(statePaths, 'prompt-byte-boundary', occurrence.occurrenceId);
    expect(artifacts.prompts).toHaveLength(3);
    expect(artifacts.promptsTruncated).toBe(false);
    expect(artifacts.omittedPromptCount).toBe(0);
  });

  it('keeps occurrence IDs unique across session logs and shared across workflow call boundaries', async () => {
    const statePaths = await createArtifactState();
    const runRoot = await writeRun(statePaths, 'occurrence-log-files');
    await writeFile(join(runRoot, 'logs', 'session-a.jsonl'), [
      {
        type: 'workflow_call_start',
        workflow: 'default',
        step: 'delegate',
        childWorkflow: 'child',
        callInstance: '1',
      },
      {
        type: 'workflow_call_complete',
        workflow: 'default',
        step: 'delegate',
        childWorkflow: 'child',
        callInstance: '1',
        status: 'done',
      },
    ].map((record) => JSON.stringify(record)).join('\n') + '\n');
    await writeFile(join(runRoot, 'logs', 'session-b.jsonl'), [
      { type: 'step_start', step: 'shared' },
    ].map((record) => JSON.stringify(record)).join('\n') + '\n');
    await writeFile(join(runRoot, 'logs', 'session-c.jsonl'), [
      { type: 'step_start', step: 'shared' },
    ].map((record) => JSON.stringify(record)).join('\n') + '\n');

    const detail = await readRunDetail(statePaths, 'occurrence-log-files');
    const callEvents = detail.history.filter((event) => event.type.startsWith('workflow_call_'));
    const sharedIds = detail.history
      .filter((event) => event.type === 'step_start' && event.step === 'shared')
      .map((event) => event.occurrenceId);
    const summaryIds = detail.graphSummary.occurrences.map((event) => event.occurrenceId);

    expect(callEvents).toHaveLength(2);
    expect(callEvents[0]?.occurrenceId).toBe(callEvents[1]?.occurrenceId);
    expect(new Set(sharedIds).size).toBe(2);
    expect(new Set(summaryIds).size).toBe(summaryIds.length);
    expect(summaryIds.every((id) => detail.history.some((event) => event.occurrenceId === id))).toBe(true);
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
    expect(trace.calls).toHaveLength(2);
    expect(trace.calls.every((call) => call.startObserved && call.targetObserved)).toBe(true);
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
  it('serves occurrence-scoped prompts while six SSE connections are active', async () => {
    const globalConfigDirectory = await createTemporaryDirectory('takt-web-ui-occurrence-api-global-');
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
    const slug = 'occurrence-api';
    const runRoot = await writeRun(repository.paths, slug);
    await writeFile(join(runRoot, 'logs', 'session.jsonl'), [
      {
        type: 'step_start',
        step: 'review',
        workflow: 'default',
        iteration: 1,
      },
      {
        type: 'phase_start',
        step: 'review',
        workflow: 'default',
        phase: 1,
        phaseName: 'execute',
        phaseExecutionId: 'review:1:1:1',
        iteration: 1,
        systemPrompt: 'system prompt from API',
        userInstruction: 'user instruction from API',
      },
      {
        type: 'step_complete',
        step: 'review',
        workflow: 'default',
        iteration: 1,
        status: 'done',
      },
    ].map((record) => JSON.stringify(record)).join('\n') + '\n');
    const detail = await readRunDetail(repository.paths, slug);
    const occurrenceId = detail.graphSummary.occurrences[0]?.occurrenceId;
    expect(occurrenceId).toBeDefined();
    if (occurrenceId === undefined) throw new Error('Occurrence fixture was not indexed');

    const server = await createWebUiServer({
      globalConfigDirectory,
      launch: async () => ({ pid: 9001, disposition: 'started' as const, mode: 'run' as const }),
    });
    servers.push(server);
    const origin = await listenWebUiServer(server, 0);

    const streamPaths = [
      ...Array.from({ length: 3 }, () => `/api/tasks/events`),
      ...Array.from({ length: 3 }, () => (
        `/api/runs/${slug}/events?project=${encodeURIComponent(project.id)}`
      )),
    ];
    const streamResponses = await Promise.all(streamPaths.map((path) => fetch(`${origin}${path}`)));
    const streamReaders: ReadableStreamDefaultReader<Uint8Array>[] = [];
    try {
      for (const response of streamResponses) {
        expect(response.status).toBe(200);
        if (response.body === null) throw new Error('SSE response body is missing');
        streamReaders.push(response.body.getReader());
      }
      await Promise.all(streamReaders.map((reader) => reader.read()));

      const response = await fetch(
        `${origin}/api/runs/${slug}/occurrence-artifacts?project=${project.id}&occurrence=${encodeURIComponent(occurrenceId)}`,
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        reports: [],
        promptsTruncated: false,
        omittedPromptCount: 0,
        prompts: [{
          systemPrompt: 'system prompt from API',
          userInstruction: 'user instruction from API',
        }],
      });
    } finally {
      await Promise.all(streamReaders.map((reader) => reader.cancel().catch(() => undefined)));
    }
    await expect(fetch(`${origin}/api/runs/${slug}/occurrence-artifacts?project=${project.id}`))
      .resolves.toMatchObject({ status: 400 });
    await expect(fetch(
      `${origin}/api/runs/${slug}/occurrence-artifacts?project=${project.id}&occurrence=missing`,
    )).resolves.toMatchObject({ status: 404 });
  });

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
    expect(html.indexOf('id="execution-context"')).toBeGreaterThan(html.indexOf('<main'));
    expect(html.indexOf('id="execution-context"')).toBeGreaterThan(html.indexOf('id="chat-surface"'));
    expect(html.indexOf('id="execution-context"')).toBeLessThan(html.indexOf('id="chat-thinking"'));
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
    expect(html).toContain('id="task-sidebar-toggle"');
    expect(html).toContain('aria-controls="task-sidebar-content"');
    expect(html).toContain('id="inspector-resizer"');
    expect(html).toContain('role="separator"');
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
    const taskActionUiResponse = await fetch(`${origin}/task-action-ui.js`);
    expect(taskActionUiResponse.status).toBe(200);
    expect(taskActionUiResponse.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    const markdownViewResponse = await fetch(`${origin}/markdown-view.js`);
    expect(markdownViewResponse.status).toBe(200);
    expect(await markdownViewResponse.text()).toContain('renderMarkdown');
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

  it('authorizes task actions, revalidates availability, and releases the task lock', async () => {
    const globalConfigDirectory = await createTemporaryDirectory('takt-web-ui-action-global-');
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
    const reserved = await repository.enqueueAndClaim({
      task: 'action task',
      workflow: 'default',
      worktree: false,
    });
    await repository.failStarting({
      taskId: reserved.task.taskId,
      generation: reserved.task.generation,
      executionId: reserved.executionId,
      ownerToken: reserved.ownerToken,
      message: 'startup failed',
    });

    const calls: Array<{ directory: string; taskId: string; action: string; input: string | undefined }> = [];
    let invocation = 0;
    let releaseFirst!: () => void;
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let handlerStarted!: () => void;
    const firstHandlerStarted = new Promise<void>((resolve) => { handlerStarted = resolve; });
    const server = await createWebUiServer({
      globalConfigDirectory,
      launch: async () => ({ pid: 9001, disposition: 'started' as const, mode: 'run' as const }),
      taskAction: async (directory, taskId, action, input) => {
        calls.push({ directory, taskId, action, input });
        invocation += 1;
        if (invocation === 1) {
          handlerStarted();
          await firstRelease;
        } else if (invocation === 2) {
          throw new CentralTaskActionError('simulated action failure');
        }
        return { action, taskId, status: 'completed' as const };
      },
    });
    servers.push(server);
    const origin = await listenWebUiServer(server, 0);
    const token = (await (await fetch(`${origin}/api/session`)).json() as { token: string }).token;
    const actionUrl = (action: string) => `${origin}/api/tasks/${reserved.task.taskId}/actions/${action}`;
    const actionInit = (body: Record<string, unknown>, includeToken = true): RequestInit => ({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(includeToken ? { 'X-TAKT-Web-Token': token } : {}),
      },
      body: JSON.stringify({ projectId: project.id, ...body }),
    });

    await expect(fetch(actionUrl('requeue'), actionInit({ input: 'payload' }, false)))
      .resolves.toMatchObject({ status: 403 });
    await expect(fetch(`${origin}/api/tasks/${reserved.task.taskId}/actions/unknown`, actionInit({})))
      .resolves.toMatchObject({ status: 400 });
    await expect(fetch(actionUrl('diff'), actionInit({})))
      .resolves.toMatchObject({ status: 409 });

    const first = fetch(actionUrl('requeue'), actionInit({ input: 'payload' }));
    await firstHandlerStarted;
    const concurrent = await fetch(actionUrl('delete'), actionInit({}));
    expect(concurrent.status).toBe(409);
    releaseFirst();
    expect((await first).status).toBe(200);
    expect(calls).toEqual([{
      directory: projectDirectory,
      taskId: reserved.task.taskId,
      action: 'requeue',
      input: 'payload',
    }]);

    const failed = await fetch(actionUrl('delete'), actionInit({}));
    expect(failed.status).toBe(409);
    const recovered = await fetch(actionUrl('requeue'), actionInit({}));
    expect(recovered.status).toBe(200);
    expect(calls.map((call) => call.action)).toEqual(['requeue', 'delete', 'requeue']);
  });

  it('guards try/merge against dirty or non-base roots and protects task deletion boundaries', async () => {
    const fixture = await createCompletedGitTask();
    const execute = (action: 'try' | 'merge' | 'delete') => executeCentralTaskAction({
      globalConfigDirectory: fixture.globalConfigDirectory,
      projectDirectory: fixture.projectDirectory,
      repository: fixture.repository,
      task: fixture.task,
      action,
      spawnDecision: async () => ({ pid: 0, disposition: 'reused' as const, mode: 'run' as const }),
    });

    await writeFile(join(fixture.projectDirectory, 'dirty.txt'), 'uncommitted\n');
    await expect(execute('try')).rejects.toThrow(/uncommitted/i);
    await expect(execute('merge')).rejects.toThrow(/uncommitted/i);
    await rm(join(fixture.projectDirectory, 'dirty.txt'));

    runFixtureGit(fixture.projectDirectory, ['checkout', '-b', 'wrong-root']);
    await expect(execute('try')).rejects.toThrow(/base branch/i);
    await expect(execute('merge')).rejects.toThrow(/base branch/i);
    runFixtureGit(fixture.projectDirectory, ['checkout', 'main']);

    runFixtureGit(fixture.projectDirectory, ['branch', fixture.branch]);
    runFixtureGit(fixture.projectDirectory, ['checkout', fixture.branch]);
    await expect(execute('delete')).rejects.toThrow(/current branch/i);
    runFixtureGit(fixture.projectDirectory, ['checkout', 'main']);

    const baseFixture = await createCompletedGitTask({
      branch: 'main',
      worktree: join(await createTemporaryDirectory('takt-web-ui-base-worktree-'), 'clone'),
    });
    await expect(executeCentralTaskAction({
      globalConfigDirectory: baseFixture.globalConfigDirectory,
      projectDirectory: baseFixture.projectDirectory,
      repository: baseFixture.repository,
      task: baseFixture.task,
      action: 'delete',
      spawnDecision: async () => ({ pid: 0, disposition: 'reused' as const, mode: 'run' as const }),
    })).rejects.toThrow(/(?:base|current) branch/i);
    await expect(baseFixture.repository.readTask(baseFixture.task.taskId)).resolves.toBeDefined();
  });

  it('deletes only owned central resources and preserves the project for worktree=false tasks', async () => {
    const fixture = await createCompletedGitTask();
    runFixtureGit(fixture.projectDirectory, ['branch', fixture.branch]);
    await mkdir(join(fixture.repository.paths.runsDirectory, fixture.task.runId!), { recursive: true });
    const metadataPath = join(fixture.repository.paths.worktreeMetadataDirectory, 'feature--action.json');
    const executeDelete = () => executeCentralTaskAction({
      globalConfigDirectory: fixture.globalConfigDirectory,
      projectDirectory: fixture.projectDirectory,
      repository: fixture.repository,
      task: fixture.task,
      action: 'delete',
      spawnDecision: async () => ({ pid: 0, disposition: 'reused' as const, mode: 'run' as const }),
    });

    await expect(executeDelete()).resolves.toMatchObject({ status: 'completed', action: 'delete' });
    await expect(lstat(fixture.clonePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(metadataPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(fixture.repository.paths.runsDirectory, fixture.task.runId!)))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(fixture.projectDirectory)).resolves.toBeDefined();
    expect(() => runFixtureGit(fixture.projectDirectory, [
      'show-ref', '--verify', '--quiet', `refs/heads/${fixture.branch}`,
    ])).toThrow();

    const failedCleanup = await createCompletedGitTask({
      worktree: join(await createTemporaryDirectory('takt-web-ui-failed-cleanup-'), 'clone'),
    });
    await rm(join(
      failedCleanup.repository.paths.worktreeMetadataDirectory,
      'feature--action.json',
    ));
    await expect(executeCentralTaskAction({
      globalConfigDirectory: failedCleanup.globalConfigDirectory,
      projectDirectory: failedCleanup.projectDirectory,
      repository: failedCleanup.repository,
      task: failedCleanup.task,
      action: 'delete',
      spawnDecision: async () => ({ pid: 0, disposition: 'reused' as const, mode: 'run' as const }),
    })).rejects.toThrow(/ownership metadata/i);
    await expect(failedCleanup.repository.readTask(failedCleanup.task.taskId)).resolves.toBeDefined();

    const noWorktree = await createGitProjectFixture();
    const reserved = await noWorktree.repository.enqueueAndClaim({
      task: 'no worktree task',
      workflow: 'default',
      worktree: false,
    });
    const adopted = await noWorktree.repository.adopt({
      taskId: reserved.task.taskId,
      generation: reserved.task.generation,
      executionId: reserved.executionId,
      ownerToken: reserved.ownerToken,
    });
    await noWorktree.repository.terminal({
      taskId: adopted.taskId,
      generation: adopted.generation,
      executionId: reserved.executionId,
      ownerToken: reserved.ownerToken,
      status: 'completed',
    });
    const noWorktreeTask = await noWorktree.repository.readTask(reserved.task.taskId);
    if (noWorktreeTask === undefined || noWorktreeTask.runId === undefined) throw new Error('missing no-worktree fixture task');
    await mkdir(join(noWorktree.repository.paths.runsDirectory, noWorktreeTask.runId), { recursive: true });
    await expect(executeCentralTaskAction({
      globalConfigDirectory: noWorktree.globalConfigDirectory,
      projectDirectory: noWorktree.projectDirectory,
      repository: noWorktree.repository,
      task: noWorktreeTask,
      action: 'delete',
      spawnDecision: async () => ({ pid: 0, disposition: 'reused' as const, mode: 'run' as const }),
    })).resolves.toMatchObject({ status: 'completed', action: 'delete' });
    await expect(lstat(noWorktree.projectDirectory)).resolves.toBeDefined();
    await expect(lstat(join(noWorktree.repository.paths.runsDirectory, noWorktreeTask.runId)))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(noWorktree.repository.readTask(noWorktreeTask.taskId)).resolves.toBeUndefined();
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
      commitTaskAction: () => {},
      releaseTaskAction: () => {},
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

  it('finalizes a task-action conversation only once against its central snapshot', async () => {
    const fixture = await createCompletedGitTask();
    const context: WebTaskActionContext = {
      taskId: fixture.task.taskId,
      action: 'instruct',
      projectId: fixture.project.id,
      stateId: fixture.project.stateId,
      projectDirectory: fixture.project.canonicalDirectory,
      task: fixture.task.task,
      workflow: fixture.task.workflow,
      status: 'completed',
      attempt: fixture.task.attempt,
      runIds: fixture.task.runIds,
      generation: fixture.task.generation,
      runId: fixture.task.runId,
      sourceRunId: fixture.task.runId,
      worktreePath: fixture.task.worktreePath,
    };
    const claimedIds = new Set<string>();
    const committedReservations: Array<{ sessionId: string; token: string }> = [];
    const releasedReservations: Array<{ sessionId: string; token: string }> = [];
    const claims = new Map<string, WebTaskActionClaim>([
      ['conversation-1', { reservationToken: 'reservation-conversation-1', context }],
      ['wrong-task', { reservationToken: 'reservation-wrong-task', context: { ...context, taskId: '00000000-0000-4000-8000-000000000000' } }],
      ['wrong-project', { reservationToken: 'reservation-wrong-project', context: { ...context, projectId: 'other-project' } }],
      ['wrong-action', { reservationToken: 'reservation-wrong-action', context: { ...context, action: 'retry' } }],
      ['wrong-generation', { reservationToken: 'reservation-wrong-generation', context: { ...context, generation: context.generation! + 1 } }],
      ['wrong-runs', { reservationToken: 'reservation-wrong-runs', context: { ...context, runIds: ['other-run'] } }],
      ['wrong-source', { reservationToken: 'reservation-wrong-source', context: { ...context, sourceRunId: 'other-run' } }],
      ['wrong-worktree', { reservationToken: 'reservation-wrong-worktree', context: { ...context, worktreePath: '/other/worktree' } }],
      ['wrong-status', { reservationToken: 'reservation-wrong-status', context: { ...context, status: 'failed' } }],
    ]);
    const chat: WebChatService = {
      create: () => ({
        id: 'ordinary', workflow: 'default', mode: 'assistant', intro: '', provider: 'mock',
      }),
      reconfigure: (id, request) => ({ id, ...request, intro: '', provider: 'mock' }),
      restart: (id) => ({ id, workflow: 'default', mode: 'assistant', intro: '', provider: 'mock' }),
      send: async () => ({ kind: 'assistant_response', content: 'ok' }),
      createTaskAction: (_directory, actionContext) => ({
        id: 'conversation-1',
        workflow: actionContext.workflow,
        mode: 'assistant',
        intro: 'existing task',
        provider: 'mock',
      }),
      getTaskActionContext: (id) => claims.get(id)?.context,
      claimTaskAction: (id) => {
        if (claimedIds.has(id)) throw new WebChatInputError(409, 'Task action conversation has already been finalized');
        const claim = claims.get(id);
        if (claim === undefined) throw new WebChatInputError(404, 'Chat session not found');
        claimedIds.add(id);
        return claim;
      },
      commitTaskAction: (sessionId, token) => {
        committedReservations.push({ sessionId, token });
      },
      releaseTaskAction: (sessionId, token) => {
        releasedReservations.push({ sessionId, token });
      },
    };
    const calls: Array<{ taskId: string; action: string; input: string | undefined; claim?: WebTaskActionClaim }> = [];
    const server = await createWebUiServer({
      globalConfigDirectory: fixture.globalConfigDirectory,
      launch: async () => ({ pid: 1, disposition: 'started' as const, mode: 'run' as const }),
      taskActionConversation: async (_directory, taskId, action) => ({
        action,
        taskId,
        status: 'conversation' as const,
        taskStatus: 'completed' as const,
        chatSession: {
          id: 'conversation-1',
          workflow: 'default',
          mode: 'assistant' as const,
          intro: 'existing task',
          provider: 'mock',
        },
      }),
      taskAction: async (_directory, taskId, action, input, _conversationId, _project, claim) => {
        calls.push({ taskId, action, input, ...(claim === undefined ? {} : { claim }) });
        return { action, taskId, status: 'accepted' as const, taskStatus: 'running' as const };
      },
      chat,
    });
    servers.push(server);
    const origin = await listenWebUiServer(server, 0);
    const token = (await (await fetch(`${origin}/api/session`)).json() as { token: string }).token;
    const actionUrl = `${origin}/api/tasks/${fixture.task.taskId}/actions/instruct`;
    const headers = { 'Content-Type': 'application/json', 'X-TAKT-Web-Token': token };

    const start = await fetch(actionUrl, {
      method: 'POST', headers,
      body: JSON.stringify({ projectId: fixture.project.id }),
    });
    expect(start.status).toBe(200);
    expect(await start.json()).toMatchObject({ status: 'conversation', taskId: fixture.task.taskId });
    await expect(fixture.repository.readTask(fixture.task.taskId)).resolves.toMatchObject({
      generation: fixture.task.generation,
      runIds: fixture.task.runIds,
    });

    for (const conversationId of [
      'wrong-task',
      'wrong-project',
      'wrong-action',
      'wrong-generation',
      'wrong-runs',
      'wrong-source',
      'wrong-worktree',
      'wrong-status',
    ]) {
      const mismatch = await fetch(actionUrl, {
        method: 'POST', headers,
        body: JSON.stringify({
          projectId: fixture.project.id,
          input: 'stale action',
          conversationId,
        }),
      });
      expect(mismatch.status).toBe(409);
    }

    const finalized = await fetch(actionUrl, {
      method: 'POST', headers,
      body: JSON.stringify({
        projectId: fixture.project.id,
        input: 'add docs',
        conversationId: 'conversation-1',
      }),
    });
    expect(finalized.status).toBe(202);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ taskId: fixture.task.taskId, action: 'instruct', input: 'add docs' });
    expect(calls[0]?.claim?.context.runIds).toEqual(fixture.task.runIds);
    expect(committedReservations).toEqual([{
      sessionId: 'conversation-1',
      token: 'reservation-conversation-1',
    }]);
    expect(releasedReservations.map((entry) => entry.sessionId)).toEqual([
      'wrong-task',
      'wrong-project',
      'wrong-action',
      'wrong-generation',
      'wrong-runs',
      'wrong-source',
      'wrong-worktree',
      'wrong-status',
    ]);

    const duplicate = await fetch(actionUrl, {
      method: 'POST', headers,
      body: JSON.stringify({
        projectId: fixture.project.id,
        input: 'duplicate',
        conversationId: 'conversation-1',
      }),
    });
    expect(duplicate.status).toBe(409);
    expect(calls).toHaveLength(1);
  });

  it('keeps the task action error when reservation release also fails', async () => {
    const fixture = await createCompletedGitTask();
    const context: WebTaskActionContext = {
      taskId: fixture.task.taskId,
      action: 'instruct',
      projectId: fixture.project.id,
      stateId: fixture.project.stateId,
      projectDirectory: fixture.project.canonicalDirectory,
      task: fixture.task.task,
      workflow: fixture.task.workflow,
      status: 'completed',
      attempt: fixture.task.attempt,
      runIds: fixture.task.runIds,
      generation: fixture.task.generation,
      runId: fixture.task.runId,
      sourceRunId: fixture.task.runId,
      worktreePath: fixture.task.worktreePath,
    };
    let releaseCount = 0;
    const chat: WebChatService = {
      create: () => ({ id: 'ordinary', workflow: 'default', mode: 'assistant', intro: '', provider: 'mock' }),
      reconfigure: (id, request) => ({ id, ...request, intro: '', provider: 'mock' }),
      restart: (id) => ({ id, workflow: 'default', mode: 'assistant', intro: '', provider: 'mock' }),
      send: async () => ({ kind: 'assistant_response', content: 'ok' }),
      claimTaskAction: () => ({
        reservationToken: 'reservation-error',
        context,
      }),
      commitTaskAction: () => {
        throw new Error('commit must not run after action failure');
      },
      releaseTaskAction: () => {
        releaseCount += 1;
        throw new Error('reservation release failed');
      },
    };
    const server = await createWebUiServer({
      globalConfigDirectory: fixture.globalConfigDirectory,
      launch: async () => ({ pid: 1, disposition: 'started' as const, mode: 'run' as const }),
      taskAction: async () => {
        throw new CentralTaskActionError('primary action failure', 409);
      },
      chat,
    });
    servers.push(server);
    const origin = await listenWebUiServer(server, 0);
    const token = (await (await fetch(`${origin}/api/session`)).json() as { token: string }).token;
    const response = await fetch(`${origin}/api/tasks/${fixture.task.taskId}/actions/instruct`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-TAKT-Web-Token': token },
      body: JSON.stringify({
        projectId: fixture.project.id,
        input: 'add docs',
        conversationId: 'conversation-error',
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'primary action failure' });
    expect(releaseCount).toBe(1);
  });

  it('starts task-action chat in the owned worktree and fails closed on ownership drift', async () => {
    const fixture = await createCompletedGitTask();
    let receivedDirectory = '';
    let receivedContext: WebTaskActionContext | undefined;
    const chat: WebChatService = {
      create: () => ({ id: 'ordinary', workflow: 'default', mode: 'assistant', intro: '', provider: 'mock' }),
      reconfigure: (id, request) => ({ id, ...request, intro: '', provider: 'mock' }),
      restart: (id) => ({ id, workflow: 'default', mode: 'assistant', intro: '', provider: 'mock' }),
      send: async () => ({ kind: 'assistant_response', content: 'ok' }),
      commitTaskAction: () => {},
      releaseTaskAction: () => {},
      createTaskAction: (directory, context) => {
        receivedDirectory = directory;
        receivedContext = context;
        return {
          id: 'task-action-chat',
          workflow: context.workflow,
          mode: 'assistant',
          intro: 'existing task',
          provider: 'mock',
        };
      },
    };

    await expect(startCentralTaskActionConversation({
      projectDirectory: fixture.projectDirectory,
      globalConfigDirectory: fixture.globalConfigDirectory,
      registeredProject: fixture.project,
      taskId: fixture.task.taskId,
      action: 'instruct',
      chat,
    })).resolves.toMatchObject({ status: 'conversation', taskId: fixture.task.taskId });
    expect(receivedDirectory).toBe(fixture.clonePath);
    expect(receivedContext).toMatchObject({
      projectId: fixture.project.id,
      stateId: fixture.project.stateId,
      projectDirectory: fixture.project.canonicalDirectory,
      taskId: fixture.task.taskId,
      runIds: fixture.task.runIds,
    });

    await rm(join(fixture.repository.paths.worktreeMetadataDirectory, 'feature--action.json'));
    await expect(startCentralTaskActionConversation({
      projectDirectory: fixture.projectDirectory,
      globalConfigDirectory: fixture.globalConfigDirectory,
      registeredProject: fixture.project,
      taskId: fixture.task.taskId,
      action: 'instruct',
      chat,
    })).rejects.toThrow(/ownership metadata/i);
  });
});
