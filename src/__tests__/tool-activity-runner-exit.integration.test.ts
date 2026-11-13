import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { WorkflowEngine } from '../core/workflow/engine/WorkflowEngine.js';
import { runAgent } from '../agents/runner.js';
import { LiveInterventionFileStore } from '../infra/workflow/live-intervention-store.js';
import { ProviderStreamParseError } from '../shared/types/agent-failure.js';
import { createTestTmpDir, makeResponse, makeRule, makeStep } from './engine-test-helpers.js';
import type { WorkflowConfig } from '../core/models/index.js';

vi.mock('../agents/runner.js', () => ({ runAgent: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe('runner exit tool output', () => {
  let project: string;
  let output: string[];
  let engine: WorkflowEngine | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
    project = createTestTmpDir();
    output = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { output.push(String(chunk)); return true; });
  });

  afterEach(() => {
    engine?.removeAllListeners();
    vi.restoreAllMocks();
    rmSync(project, { recursive: true, force: true });
  });

  function config(owner: 'parallel' | 'team leader'): WorkflowConfig {
    return {
      name: 'runner-output', initialStep: 'run', maxSteps: 4,
      steps: [makeStep('run', {
        ...(owner === 'parallel' ? {
          parallel: [makeStep('worker', { rules: [makeRule('when(true)', 'COMPLETE')] })],
        } : {
          teamLeader: {
            persona: '../personas/team-leader.md', partPersona: '../personas/worker.md',
            maxConcurrency: 1, timeoutMs: 10000,
          },
        }),
        rules: [makeRule('when(true)', 'COMPLETE')],
      })],
    };
  }

  for (const owner of ['parallel', 'team leader'] as const) {
    const endings = owner === 'parallel'
      ? ['done', 'error', 'blocked', 'rate_limited', 'exception', 'parse failure', 'abort', 'restart'] as const
      : ['done', 'error', 'rate_limited', 'exception', 'parse failure', 'abort'] as const;
    describe(owner, () => {
      it.each(endings.flatMap((ending) => [false, true].map((completed) => ({ ending, completed }))))(
        'should preserve tool output on $ending with completed=$completed',
        async ({ ending, completed }) => {
          const controller = new AbortController();
          const received = deferred<void>();
          const release = deferred<void>();
          const live = ending === 'restart' ? new LiveInterventionFileStore(project, 'test-report-dir') : undefined;
          let leaderCalls = 0;
          let workerCalls = 0;
          vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
            options.onPromptResolved?.({ systemPrompt: persona ?? '', userInstruction: instruction });
            options.onDispatch?.(options.permissionMode);
            if (persona?.includes('team-leader')) {
              leaderCalls += 1;
              return makeResponse({ structuredOutput: leaderCalls === 1
                ? { parts: [{ id: 'worker', title: 'Work', instruction: 'Run a command' }] }
                : { done: true, reasoning: 'finished', cancelPartIds: [], parts: [] } });
            }
            workerCalls += 1;
            if (workerCalls > 1) {
              if (ending === 'restart') {
                expect(output.join('')).toContain('observed-output');
                return makeResponse({ content: 'rerun result' });
              }
              expect(ending).toBe('error');
              return makeResponse({ status: 'error', content: 'worker result', error: 'provider exit failure' });
            }
            options.onStream?.({ type: 'tool_use', data: { id: 'shell', tool: 'Bash', input: { command: 'printf output', api_key: 'private123' } } });
            options.onStream?.({ type: 'tool_output', data: { id: 'shell', tool: 'Bash', output: 'observed-output private123' } });
            if (completed) options.onStream?.({ type: 'tool_result', data: { id: 'shell', content: 'observed-output private123', isError: false } });
            received.resolve();
            if (ending === 'abort' || ending === 'restart') await release.promise;
            if (ending === 'abort') options.abortSignal?.throwIfAborted();
            if (ending === 'exception') throw new Error('provider exit failure');
            if (ending === 'parse failure') throw new ProviderStreamParseError('invalid provider item');
            return makeResponse({
              status: ending === 'abort' || ending === 'restart' ? 'done' : ending,
              content: 'worker result', ...(ending === 'done' || ending === 'restart' ? {} : { error: 'provider exit failure' }),
            });
          });
          engine = new WorkflowEngine(config(owner), project, 'Observe output', {
            projectCwd: project, reportDirName: 'test-report-dir', provider: 'mock',
            onStream: () => {}, toolDisplayMode: 'expanded', taskPrefix: 'task', taskColorIndex: 0,
            abortSignal: controller.signal,
            ...(live === undefined ? {} : { liveIntervention: live }),
          });
          const aborted = vi.fn();
          engine.on('workflow:abort', aborted);
          const running = engine.run();
          if (ending === 'abort' || ending === 'restart') {
            await received.promise;
            if (ending === 'abort') controller.abort(new Error('requested stop'));
            else await live!.issue('rerun with updated instruction');
            release.resolve();
          }
          const state = await running;
          const rendered = output.join('').replace(/\x1b\[[0-9;]*m/gu, '');
          expect(rendered).toContain('observed-output');
          expect(rendered).toContain('[task]');
          expect(rendered).toContain('worker');
          expect(rendered).not.toContain('private123');
          expect(rendered.match(/observed-output/gu)).toHaveLength(1);
          if (!completed) {
            expect(rendered).toContain('Bash output: [running]');
            expect(rendered).not.toMatch(/✓ Bash|\[success\]/u);
          }
          if (ending === 'done' || ending === 'restart') {
            expect(state.status).toBe('completed');
          } else {
            expect(state.status).toBe('aborted');
            expect(aborted).toHaveBeenCalled();
            if (ending === 'abort') {
              expect(String(aborted.mock.calls[0]?.[1])).toContain('external AbortSignal');
              expect(controller.signal.reason).toMatchObject({ message: 'requested stop' });
            } else if (ending === 'parse failure') {
              expect(aborted.mock.calls[0]?.[3]).toMatchObject({ failureCategory: 'provider_stream_parse_error', error: 'provider stream parse error: invalid provider item' });
              if (owner === 'parallel') expect(state.stepOutputs.get('run')).toMatchObject({ status: 'error', failureCategory: 'provider_stream_parse_error' });
            } else if (owner === 'team leader' && ending === 'rate_limited') {
              expect(state.stepOutputs.has('run')).toBe(false);
              expect(String(aborted.mock.calls[0]?.[1])).toMatch(/rate.limit/iu);
            } else expect(state.stepOutputs.get('run')).toMatchObject({ status: ending === 'exception' ? 'error' : ending });
          }
          if (ending === 'restart') {
            expect(workerCalls).toBe(2);
            expect(vi.mocked(runAgent).mock.calls.at(-1)?.[1]).toContain('rerun with updated instruction');
          }
        },
      );
    });
  }
});
