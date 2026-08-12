import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalAgentWorkflowStep } from '../core/models/types.js';
import type { CompanionDiffReader } from '../core/workflow/companion/diff-reader.js';
import { buildCompanionMailboxPath } from '../core/workflow/companion/mailbox.js';
import { CompanionStepRuntime } from '../core/workflow/companion/step-runtime.js';
import { runCompanionFixLoop } from '../core/workflow/companion/fix-loop.js';
import { CompanionReviewStateStore } from '../core/workflow/companion/review-state-store.js';
import { CompanionStructuredCaller } from '../core/workflow/companion/structured-call.js';
import { assertStrictStructuredOutputSchema } from '../core/workflow/engine/structured-output-schema-validator.js';
import type { SelectorProviderInfo } from '../core/workflow/types.js';
import type { WorkflowState } from '../core/models/types.js';
import { COMPANION_CUMULATIVE_LIMITS } from '../core/workflow/companion/limits.js';
import { MAX_COMPANION_INTERVAL_MS } from '../core/models/companion-types.js';

const snapshot = {
  digest: 'one-line-change',
  changedLines: 1,
  content: '+changed\n',
  changedFiles: ['src/a.ts'],
  fileFingerprints: { 'src/a.ts': 'one-line-change' },
  hunkFingerprints: { 'src/a.ts:1-1': 'one-line-change' },
  omittedBytes: 0,
  truncated: false,
};

const emptySnapshot = {
  digest: 'empty',
  changedLines: 0,
  content: '',
  changedFiles: [],
  fileFingerprints: {},
  hunkFingerprints: {},
  omittedBytes: 0,
  truncated: false,
};

function step(
  allowGitCommit?: boolean,
  fixedCompanions: string[] = ['security-reviewer'],
): NormalAgentWorkflowStep {
  return {
    name: 'implement',
    persona: 'coder',
    personaDisplayName: 'coder',
    instruction: 'implement',
    edit: true,
    passPreviousResponse: true,
    companion: { fixed: fixedCompanions, pool: [] },
    rules: [],
    ...(allowGitCommit === undefined ? {} : { allowGitCommit }),
  };
}

function dependencies(input: {
  workflowStep?: NormalAgentWorkflowStep;
  diffReader: CompanionDiffReader;
  abortSignal?: AbortSignal;
  providers?: Record<string, { provider: 'mock' }>;
  selectorProvider?: SelectorProviderInfo;
  intervalMs?: number;
}) {
  return {
    cwd: '/project',
    projectCwd: '/project',
    failureDir: '/project/.takt/runs/run/failures',
    runSlug: 'run',
    runPathNamespace: [],
    language: 'en' as const,
    task: 'task',
    step: input.workflowStep ?? step(),
    definitions: {
      'security-reviewer': {
        name: 'security-reviewer',
        description: 'security review',
        instruction: 'review',
        intervalMs: input.intervalMs ?? 60_000,
      },
    },
    providers: input.providers ?? { 'security-reviewer': { provider: 'mock' as const } },
    selectorProvider: input.selectorProvider,
    diffReader: input.diffReader,
    abortSignal: input.abortSignal,
    stateStore: new CompanionReviewStateStore(),
    emitEvent: vi.fn(),
    recordUsage: vi.fn(),
  };
}

describe('companion runtime lifecycle', () => {
  it('should preserve the diff failure code and sanitized message in its error', async () => {
    await expect(CompanionStepRuntime.create(dependencies({
      diffReader: {
        readBaselineSha: vi.fn().mockResolvedValue('baseline'),
        readDiff: vi.fn().mockResolvedValue({
          status: 'error',
          failure: {
            code: 'git_failure',
            message: 'git diff failed in /private/secret/repository',
          },
        }),
      },
    }))).rejects.toThrow(
      'Companion diff unavailable (git_failure): git diff failed in [path]',
    );
  });

  it('should pass the maximum platform-safe interval to the scheduler unchanged', async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    let runtime: CompanionStepRuntime | undefined;
    try {
      runtime = await CompanionStepRuntime.create(dependencies({
        diffReader: {
          readBaselineSha: vi.fn().mockResolvedValue('baseline'),
          readDiff: vi.fn().mockResolvedValue({ status: 'ok', snapshot: emptySnapshot }),
        },
        intervalMs: MAX_COMPANION_INTERVAL_MS,
      }));

      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), MAX_COMPANION_INTERVAL_MS);
    } finally {
      runtime?.stop();
      setIntervalSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each([undefined, false])(
    'should treat a commit as a normal Bash candidate when allow_git_commit is %s',
    async (allowGitCommit) => {
      const readDiff = vi.fn().mockResolvedValue({ status: 'ok', snapshot });
      const runtime = await CompanionStepRuntime.create(dependencies({
        workflowStep: step(allowGitCommit),
        diffReader: { readBaselineSha: vi.fn().mockResolvedValue('baseline'), readDiff },
      }));

      runtime.observe({
        type: 'tool_use',
        data: { tool: 'Bash', input: { command: 'git commit -m change' }, id: 'commit' },
      });
      await Promise.resolve();
      runtime.stop();

      expect(readDiff).toHaveBeenCalledOnce();
    },
  );

  it('should immediately review a one-line commit only when allow_git_commit is true', async () => {
    const readDiff = vi.fn().mockResolvedValue({ status: 'ok', snapshot });
    const runtime = await CompanionStepRuntime.create(dependencies({
      workflowStep: step(true),
      diffReader: { readBaselineSha: vi.fn().mockResolvedValue('baseline'), readDiff },
    }));

    runtime.observe({
      type: 'tool_use',
      data: { tool: 'Bash', input: { command: 'git commit -m change' }, id: 'commit' },
    });
    await vi.waitFor(() => expect(readDiff).toHaveBeenCalledTimes(2));
    runtime.stop();
  });

  it('should synchronize the completion snapshot before an unchanged Bash in a fix round', async () => {
    vi.useFakeTimers();
    const readDiff = vi.fn()
      .mockResolvedValueOnce({ status: 'ok', snapshot: emptySnapshot })
      .mockResolvedValue({ status: 'ok', snapshot });
    const callSpy = vi.spyOn(CompanionStructuredCaller.prototype, 'call').mockImplementation(
      async (request) => request.purpose === 'judge'
        ? {
            status: 'done',
            content: '',
            structuredOutput: { decision: 'continue', reason: 'continue' },
          }
        : {
            status: 'done',
            content: '',
            structuredOutput: { findings: [], updates: [], notes: null },
          },
    );
    let runtime: CompanionStepRuntime | undefined;
    try {
      runtime = await CompanionStepRuntime.create(dependencies({
        diffReader: { readBaselineSha: vi.fn().mockResolvedValue('baseline'), readDiff },
      }));
      await runtime.complete(
        { companion: undefined } as unknown as WorkflowState,
        'complete',
        { afterFix: false },
      );
      runtime.beginFixRound(2, 0);

      runtime.observe({
        type: 'tool_use',
        data: { tool: 'Bash', input: { command: 'npm test' }, id: 'bash-read' },
      });
      runtime.observe({
        type: 'tool_result',
        data: { id: 'bash-read', content: '', isError: false },
      });
      await vi.waitFor(() => expect(readDiff).toHaveBeenCalledTimes(3));
      await vi.advanceTimersByTimeAsync(250);

      expect(callSpy.mock.calls.filter(([request]) => request.purpose === 'reviewer')).toHaveLength(1);
    } finally {
      runtime?.stop();
      callSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('should leave no listener or timer when baseline initialization fails', async () => {
    const error = new Error('baseline failed');
    const signal = new AbortController().signal;
    const addListener = vi.spyOn(signal, 'addEventListener');
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    await expect(CompanionStepRuntime.create(dependencies({
      diffReader: { readBaselineSha: vi.fn().mockRejectedValue(error), readDiff: vi.fn() },
      abortSignal: signal,
    }))).rejects.toBe(error);

    expect(addListener).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  it('should leave no listener or timer when selector initialization fails', async () => {
    const signal = new AbortController().signal;
    const addListener = vi.spyOn(signal, 'addEventListener');
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const workflowStep = {
      ...step(),
      companion: { fixed: [], pool: ['security-reviewer'] },
    };

    await expect(CompanionStepRuntime.create(dependencies({
      workflowStep,
      diffReader: { readBaselineSha: vi.fn().mockResolvedValue('baseline'), readDiff: vi.fn() },
      abortSignal: signal,
    }))).rejects.toThrow(/selector.*provider|provider.*selector/i);

    expect(addListener).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  it('should send a provider-compatible schema when selecting companion reviewers', async () => {
    const workflowStep = {
      ...step(),
      companion: { fixed: [], pool: ['security-reviewer'] },
    };
    const callSpy = vi.spyOn(CompanionStructuredCaller.prototype, 'call').mockImplementation(
      async (request) => {
        const response = {
          status: 'done' as const,
          content: '',
          structuredOutput: { selected_ids: ['security-reviewer'], rationale: 'relevant' },
        };
        expect(request.validateResponse).toBeDefined();
        request.validateResponse!(response);
        return response;
      },
    );
    let runtime: CompanionStepRuntime | undefined;

    try {
      runtime = await CompanionStepRuntime.create(dependencies({
        workflowStep,
        diffReader: {
          readBaselineSha: vi.fn().mockResolvedValue('baseline'),
          readDiff: vi.fn().mockResolvedValue({ status: 'ok', snapshot: emptySnapshot }),
        },
        selectorProvider: {
          provider: 'mock',
          model: undefined,
          providerOptions: {},
          nativeTools: [],
        },
      }));

      const outputSchema = callSpy.mock.calls[0]?.[0].outputSchema;
      expect(() => assertStrictStructuredOutputSchema(outputSchema)).not.toThrow();
      expect(outputSchema).not.toHaveProperty('properties.selected_ids.uniqueItems');
      expect(outputSchema).toHaveProperty('properties.selected_ids.maxItems', 3);
    } finally {
      runtime?.stop();
      callSpy.mockRestore();
    }
  });

  it('should leave no listener or timer when companion provider initialization fails', async () => {
    const signal = new AbortController().signal;
    const addListener = vi.spyOn(signal, 'addEventListener');
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    await expect(CompanionStepRuntime.create(dependencies({
      diffReader: { readBaselineSha: vi.fn().mockResolvedValue('baseline'), readDiff: vi.fn() },
      abortSignal: signal,
      providers: {},
    }))).rejects.toThrow(/no resolved provider/);

    expect(addListener).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  it('should resolve the moderator without registering it as an active watcher', async () => {
    const emitEvent = vi.fn();
    const workflowStep = {
      ...step(),
      companion: {
        fixed: ['security-reviewer'],
        pool: [],
        moderator: 'adjudicator',
      },
    };
    const base = dependencies({
      workflowStep,
      diffReader: {
        readBaselineSha: vi.fn().mockResolvedValue('baseline'),
        readDiff: vi.fn().mockResolvedValue({ status: 'ok', snapshot: emptySnapshot }),
      },
      providers: {
        'security-reviewer': { provider: 'mock' },
        adjudicator: { provider: 'mock' },
      },
    });
    const runtime = await CompanionStepRuntime.create({
      ...base,
      definitions: {
        ...base.definitions,
        adjudicator: {
          name: 'adjudicator',
          description: 'moderate findings',
          instruction: 'moderate',
          intervalMs: 1,
        },
      },
      emitEvent,
    });

    runtime.stop();

    expect(emitEvent).toHaveBeenCalledWith('companion:start', {
      step: 'implement',
      companion: 'security-reviewer',
    });
    expect(emitEvent).not.toHaveBeenCalledWith('companion:start', expect.objectContaining({
      companion: 'adjudicator',
    }));
  });

  it('should fix a moderator-accepted must_fix and re-review it in the same session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-companion-runtime-moderated-fix-'));
    const workflowStep = {
      ...step(),
      companion: {
        fixed: ['security-reviewer'],
        pool: [],
        moderator: 'adjudicator',
      },
    };
    let reviewerCalls = 0;
    let moderatorCalls = 0;
    const callSpy = vi.spyOn(CompanionStructuredCaller.prototype, 'call').mockImplementation(
      async (request) => {
        if (request.purpose === 'judge') {
          return {
            status: 'done',
            content: '',
            structuredOutput: { decision: 'continue', reason: 'progress continues' },
          };
        }
        if (request.purpose === 'moderator') {
          moderatorCalls += 1;
          return {
            status: 'done',
            content: '',
            structuredOutput: moderatorCalls === 1
              ? {
                  findings: [{
                    action: 'accept',
                    sourceIndex: 0,
                    severity: null,
                    finding: null,
                    targetId: null,
                  }],
                  updates: [],
                }
              : {
                  findings: [],
                  updates: [{ id: 'security-reviewer-1', status: 'resolved' }],
                },
          };
        }
        reviewerCalls += 1;
        return {
          status: 'done',
          content: '',
          structuredOutput: reviewerCalls === 1
            ? {
                findings: [{
                  severity: 'must_fix',
                  file: 'src/a.ts',
                  line: 1,
                  finding: 'candidate',
                }],
                updates: [],
                notes: null,
              }
            : {
                findings: [],
                updates: [{ id: 'security-reviewer-1', status: 'resolved' }],
                notes: null,
              },
        };
      },
    );
    const state = { companion: undefined } as unknown as WorkflowState;
    let runtime: CompanionStepRuntime | undefined;

    try {
      const base = dependencies({
        workflowStep,
        diffReader: {
          readBaselineSha: vi.fn().mockResolvedValue('baseline'),
          readDiff: vi.fn().mockResolvedValue({ status: 'ok', snapshot }),
        },
        providers: {
          'security-reviewer': { provider: 'mock' },
          adjudicator: { provider: 'mock' },
        },
      });
      runtime = await CompanionStepRuntime.create({
        ...base,
        cwd: root,
        projectCwd: root,
        definitions: {
          ...base.definitions,
          adjudicator: {
            name: 'adjudicator',
            description: 'moderate findings',
            instruction: 'moderate',
            intervalMs: 60_000,
          },
        },
      });
      const executeFix = vi.fn(async (attempt: { sequence: number; openMustFixCount: number }) => {
        runtime!.beginFixRound(attempt.sequence, attempt.openMustFixCount);
        return {
          persona: 'coder',
          status: 'done' as const,
          content: 'fixed candidate',
          sessionId: 'session-2',
          timestamp: new Date('2026-08-08T00:00:00.000Z'),
        };
      });

      const result = await runCompanionFixLoop({
        initialResponse: {
          persona: 'coder',
          status: 'done',
          content: 'initial implementation',
          sessionId: 'session-1',
          timestamp: new Date('2026-08-08T00:00:00.000Z'),
        },
        phase1Options: {},
        completeReview: ({ implementerResponse, afterFix, fixRound }) => runtime!.complete(
          state,
          implementerResponse,
          { afterFix, fixRound },
        ),
        executeFix,
      });

      expect(executeFix).toHaveBeenCalledOnce();
      expect(executeFix).toHaveBeenCalledWith(expect.objectContaining({
        sequence: 2,
        sessionId: 'session-1',
        openMustFixCount: 1,
      }));
      expect(reviewerCalls).toBe(2);
      expect(moderatorCalls).toBe(2);
      expect(result.phaseResponse).toMatchObject({ content: 'fixed candidate', sessionId: 'session-2' });
      expect(state.companion).toMatchObject({ openMustFixCount: 0, openMustFix: [] });
    } finally {
      runtime?.stop();
      callSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('should fail initialization when the adjudication-only moderator has no provider', async () => {
    const workflowStep = {
      ...step(),
      companion: {
        fixed: ['security-reviewer'],
        pool: [],
        moderator: 'adjudicator',
      },
    };
    const base = dependencies({
      workflowStep,
      diffReader: { readBaselineSha: vi.fn().mockResolvedValue('baseline'), readDiff: vi.fn() },
    });

    await expect(CompanionStepRuntime.create({
      ...base,
      definitions: {
        ...base.definitions,
        adjudicator: {
          name: 'adjudicator',
          description: 'moderate findings',
          instruction: 'moderate',
          intervalMs: 1,
        },
      },
    })).rejects.toThrow(/adjudicator.*provider/);
  });

  it('should pass projected reviewer and judge schemas through their structured calls', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-companion-runtime-schema-'));
    const schemas: Array<{ purpose: string; outputSchema: Record<string, unknown> }> = [];
    let reviewerCalls = 0;
    const callSpy = vi.spyOn(CompanionStructuredCaller.prototype, 'call').mockImplementation(
      async (request) => {
        schemas.push({ purpose: request.purpose, outputSchema: request.outputSchema });
        if (request.purpose === 'judge') {
          const response = {
            status: 'done',
            content: '',
            structuredOutput: { decision: 'continue', reason: 'continue' },
          } as const;
          expect(request.validateResponse).toBeDefined();
          request.validateResponse!(response);
          return response;
        }
        reviewerCalls += 1;
        const response = {
          status: 'done',
          content: '',
          structuredOutput: {
            findings: reviewerCalls === 1
              ? [{ severity: 'must_fix', file: 'src/a.ts', line: 1, finding: 'candidate' }]
              : [],
            updates: [],
            notes: null,
          },
        } as const;
        expect(request.validateResponse).toBeDefined();
        request.validateResponse!(response);
        return response;
      },
    );
    const readDiff = vi.fn().mockResolvedValue({ status: 'ok', snapshot });
    let runtime: CompanionStepRuntime | undefined;

    try {
      const base = dependencies({
        diffReader: { readBaselineSha: vi.fn().mockResolvedValue('baseline'), readDiff },
      });
      runtime = await CompanionStepRuntime.create({
        ...base,
        cwd: root,
        projectCwd: root,
      });
      runtime.beginFixRound(2, 0);
      runtime.observe({
        type: 'tool_use',
        data: { tool: 'Edit', input: { path: 'src/a.ts' }, id: 'first-edit' },
      });
      await runtime.complete(
        { companion: undefined } as unknown as WorkflowState,
        'first',
        { afterFix: false },
      );
      runtime.beginFixRound(3, 1);
      runtime.observe({
        type: 'tool_use',
        data: { tool: 'Edit', input: { path: 'src/a.ts' }, id: 'second-edit' },
      });
      await runtime.complete(
        { companion: undefined } as unknown as WorkflowState,
        'second',
        { afterFix: true, fixRound: 2 },
      );

      expect(schemas.filter(({ purpose }) => purpose === 'reviewer')).toHaveLength(2);
      expect(schemas.filter(({ purpose }) => purpose === 'judge')).toHaveLength(2);
      for (const { outputSchema } of schemas) {
        expect(() => assertStrictStructuredOutputSchema(outputSchema)).not.toThrow();
      }
    } finally {
      runtime?.stop();
      callSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('should re-review an unchanged diff after a fix explanation and resolve the prior finding', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-companion-runtime-unchanged-fix-'));
    const prompts: Array<{ purpose: string; prompt: string }> = [];
    let reviewerCalls = 0;
    const callSpy = vi.spyOn(CompanionStructuredCaller.prototype, 'call').mockImplementation(
      async (request) => {
        prompts.push({ purpose: request.purpose, prompt: request.prompt });
        if (request.purpose === 'judge') {
          return {
            status: 'done',
            content: '',
            structuredOutput: { decision: 'continue', reason: 'continue' },
          };
        }
        reviewerCalls += 1;
        return {
          status: 'done',
          content: '',
          structuredOutput: {
            findings: reviewerCalls === 1
              ? [{ severity: 'must_fix', file: 'src/a.ts', line: 1, finding: 'false positive' }]
              : [],
            updates: reviewerCalls === 2
              ? [{ id: 'security-reviewer-1', status: 'resolved' }]
              : [],
            notes: null,
          },
        };
      },
    );
    const readDiff = vi.fn().mockResolvedValue({ status: 'ok', snapshot });
    const state = { companion: undefined } as unknown as WorkflowState;
    const emitEvent = vi.fn();
    let runtime: CompanionStepRuntime | undefined;

    try {
      const base = dependencies({
        diffReader: { readBaselineSha: vi.fn().mockResolvedValue('baseline'), readDiff },
      });
      runtime = await CompanionStepRuntime.create({
        ...base,
        cwd: root,
        projectCwd: root,
        emitEvent,
      });
      const result = await runCompanionFixLoop({
        initialResponse: {
          persona: 'coder',
          status: 'done',
          content: 'initial implementation',
          sessionId: 'session-1',
          timestamp: new Date('2026-08-08T00:00:00.000Z'),
        },
        phase1Options: {},
        completeReview: ({ implementerResponse, afterFix, fixRound }) => runtime!.complete(
          state,
          implementerResponse,
          { afterFix, fixRound },
        ),
        executeFix: async (attempt) => {
          runtime!.beginFixRound(attempt.sequence, attempt.openMustFixCount);
          return {
            persona: 'coder',
            status: 'done' as const,
            content: 'The finding is a false positive; no code change was needed.',
            sessionId: 'session-2',
            timestamp: new Date('2026-08-08T00:00:00.000Z'),
          };
        },
      });

      const reviewerPrompts = prompts
        .filter(({ purpose }) => purpose === 'reviewer')
        .map(({ prompt }) => prompt);
      expect(result.fixRounds).toBe(1);
      expect(reviewerPrompts).toHaveLength(2);
      expect(reviewerPrompts[1]).toContain('false positive; no code change was needed.');
      expect(reviewerPrompts[1]).toContain('security-reviewer-1');
      expect(emitEvent.mock.calls.filter(([event]) => event === 'companion:finding')).toHaveLength(1);
      expect(state.companion).toMatchObject({
        openMustFixCount: 0,
        openMustFix: [],
        completionVerified: true,
      });
      expect(base.stateStore.get(
        buildCompanionMailboxPath({
          cwd: root,
          runSlug: 'run',
          runPathNamespace: [],
          stepName: 'implement',
          companionName: 'security-reviewer',
        }),
        'security-reviewer',
      ).mailbox.findings).toEqual([
        expect.objectContaining({ id: 'security-reviewer-1', status: 'resolved' }),
      ]);
    } finally {
      runtime?.stop();
      callSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('should authorize unchanged post-fix review only for the companion that owns an open finding', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-companion-runtime-unchanged-scope-'));
    const prompts: Array<{ purpose: string; agentName: string; prompt: string }> = [];
    const reviewerCalls: string[] = [];
    const callSpy = vi.spyOn(CompanionStructuredCaller.prototype, 'call').mockImplementation(
      async (request) => {
        prompts.push({ purpose: request.purpose, agentName: request.agentName, prompt: request.prompt });
        if (request.purpose === 'judge') {
          return {
            status: 'done',
            content: '',
            structuredOutput: { decision: 'continue', reason: 'continue' },
          };
        }
        reviewerCalls.push(request.agentName);
        const companionCalls = reviewerCalls.filter((name) => name === request.agentName).length;
        return {
          status: 'done',
          content: '',
          structuredOutput: {
            findings: request.agentName === 'security-reviewer' && companionCalls === 1
              ? [{ severity: 'must_fix', file: 'src/a.ts', line: 1, finding: 'false positive' }]
              : [],
            updates: request.agentName === 'security-reviewer' && companionCalls === 2
              ? [{ id: 'security-reviewer-1', status: 'resolved' }]
              : [],
            notes: null,
          },
        };
      },
    );
    const state = { companion: undefined } as unknown as WorkflowState;
    let runtime: CompanionStepRuntime | undefined;

    try {
      const workflowStep = step(undefined, ['security-reviewer', 'architecture-reviewer']);
      const base = dependencies({
        workflowStep,
        providers: {
          'security-reviewer': { provider: 'mock' },
          'architecture-reviewer': { provider: 'mock' },
        },
        diffReader: {
          readBaselineSha: vi.fn().mockResolvedValue('baseline'),
          readDiff: vi.fn().mockResolvedValue({ status: 'ok', snapshot }),
        },
      });
      runtime = await CompanionStepRuntime.create({
        ...base,
        cwd: root,
        projectCwd: root,
        definitions: {
          ...base.definitions,
          'architecture-reviewer': {
            name: 'architecture-reviewer',
            description: 'architecture review',
            instruction: 'review architecture',
            intervalMs: 60_000,
          },
        },
      });

      const result = await runCompanionFixLoop({
        initialResponse: {
          persona: 'coder',
          status: 'done',
          content: 'initial implementation',
          sessionId: 'session-1',
          timestamp: new Date('2026-08-08T00:00:00.000Z'),
        },
        phase1Options: {},
        completeReview: ({ implementerResponse, afterFix, fixRound }) => runtime!.complete(
          state,
          implementerResponse,
          { afterFix, fixRound },
        ),
        executeFix: async (attempt) => {
          runtime!.beginFixRound(attempt.sequence, attempt.openMustFixCount);
          return {
            persona: 'coder',
            status: 'done' as const,
            content: 'The finding is a false positive; no code change was needed.',
            sessionId: 'session-2',
            timestamp: new Date('2026-08-08T00:00:00.000Z'),
          };
        },
      });

      expect(result.fixRounds).toBe(1);
      expect(reviewerCalls.filter((name) => name === 'security-reviewer')).toHaveLength(2);
      expect(reviewerCalls.filter((name) => name === 'architecture-reviewer')).toHaveLength(1);
      const securityPrompts = prompts
        .filter(({ purpose, agentName }) => purpose === 'reviewer' && agentName === 'security-reviewer')
        .map(({ prompt }) => prompt);
      expect(securityPrompts[1]).toContain('false positive; no code change was needed.');
      expect(securityPrompts[1]).toContain('security-reviewer-1');
      expect(state.companion).toMatchObject({ openMustFixCount: 0, openMustFix: [] });
    } finally {
      runtime?.stop();
      callSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('should not bypass unchanged-digest dedupe when the Fix explanation is empty', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-companion-runtime-empty-explanation-'));
    let reviewerCalls = 0;
    const callSpy = vi.spyOn(CompanionStructuredCaller.prototype, 'call').mockImplementation(
      async (request) => {
        if (request.purpose === 'judge') {
          return {
            status: 'done',
            content: '',
            structuredOutput: { decision: 'continue', reason: 'continue' },
          };
        }
        reviewerCalls += 1;
        return {
          status: 'done',
          content: '',
          structuredOutput: {
            findings: reviewerCalls === 1
              ? [{ severity: 'must_fix', file: 'src/a.ts', line: 1, finding: 'candidate' }]
              : [],
            updates: [],
            notes: null,
          },
        };
      },
    );
    const state = { companion: undefined } as unknown as WorkflowState;
    let runtime: CompanionStepRuntime | undefined;

    try {
      const base = dependencies({
        diffReader: {
          readBaselineSha: vi.fn().mockResolvedValue('baseline'),
          readDiff: vi.fn().mockResolvedValue({ status: 'ok', snapshot }),
        },
      });
      runtime = await CompanionStepRuntime.create({ ...base, cwd: root, projectCwd: root });

      const first = await runtime.complete(state, 'initial', { afterFix: false });
      runtime.beginFixRound(2, first.openMustFix.length);
      const afterEmpty = await runtime.complete(state, '  \n\t', {
        afterFix: true,
        fixRound: 1,
      });

      expect(reviewerCalls).toBe(1);
      expect(afterEmpty.openMustFix).toHaveLength(1);
    } finally {
      runtime?.stop();
      callSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('should re-review with the latest explanation even after a live review during the Fix round', async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), 'takt-companion-runtime-live-before-completion-'));
    const liveSnapshot = {
      ...snapshot,
      digest: 'live-diff',
      changedLines: 10,
      content: '+live change\n',
      fileFingerprints: { 'src/a.ts': 'live-diff' },
      hunkFingerprints: { 'src/a.ts:1-1': 'live-diff' },
    };
    const readDiff = vi.fn()
      .mockResolvedValueOnce({ status: 'ok', snapshot: emptySnapshot })
      .mockResolvedValueOnce({ status: 'ok', snapshot })
      .mockResolvedValue({ status: 'ok', snapshot: liveSnapshot });
    const prompts: string[] = [];
    let reviewerCalls = 0;
    const callSpy = vi.spyOn(CompanionStructuredCaller.prototype, 'call').mockImplementation(
      async (request) => {
        if (request.purpose === 'judge') {
          return {
            status: 'done',
            content: '',
            structuredOutput: { decision: 'continue', reason: 'continue' },
          };
        }
        prompts.push(request.prompt);
        reviewerCalls += 1;
        return {
          status: 'done',
          content: '',
          structuredOutput: {
            findings: reviewerCalls === 1
              ? [{ severity: 'must_fix', file: 'src/a.ts', line: 1, finding: 'candidate' }]
              : [],
            updates: reviewerCalls === 3
              ? [{ id: 'security-reviewer-1', status: 'resolved' }]
              : [],
            notes: null,
          },
        };
      },
    );
    const state = { companion: undefined } as unknown as WorkflowState;
    let runtime: CompanionStepRuntime | undefined;

    try {
      const base = dependencies({
        diffReader: { readBaselineSha: vi.fn().mockResolvedValue('baseline'), readDiff },
      });
      runtime = await CompanionStepRuntime.create({ ...base, cwd: root, projectCwd: root });
      const first = await runtime.complete(state, 'initial', { afterFix: false });
      runtime.beginFixRound(2, first.openMustFix.length);
      runtime.observe({
        type: 'tool_use',
        data: { tool: 'Edit', input: { path: 'src/a.ts' }, id: 'fix-edit' },
      });
      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() => expect(reviewerCalls).toBe(2));

      const result = await runtime.complete(
        state,
        'The finding is a false positive; no code change was needed.',
        { afterFix: true, fixRound: 1 },
      );

      expect(reviewerCalls).toBe(3);
      expect(prompts[2]).toContain('false positive; no code change was needed.');
      expect(prompts[2]).toContain('security-reviewer-1');
      expect(result.openMustFix).toEqual([]);
    } finally {
      runtime?.stop();
      callSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it('should convert an oversized restored mailbox into sticky escalation without a provider call', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-companion-runtime-capacity-'));
    const mailboxDirectory = join(root, '.takt', 'runs', 'run', 'companion', 'implement');
    const mailboxPath = join(mailboxDirectory, 'security-reviewer.jsonl');
    const records = [{
      id: 'security-reviewer-1',
      severity: 'must_fix',
      file: 'src/a.ts',
      line: 1,
      finding: 'candidate',
      status: 'open',
    }, ...Array.from(
      { length: COMPANION_CUMULATIVE_LIMITS.maxRecordsPerMailbox },
      (_, index) => ({
        id: 'security-reviewer-1',
        status: index % 2 === 0 ? 'resolved' : 'unresolved',
      }),
    )];
    mkdirSync(mailboxDirectory, { recursive: true });
    writeFileSync(mailboxPath, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    const callSpy = vi.spyOn(CompanionStructuredCaller.prototype, 'call');
    let runtime: CompanionStepRuntime | undefined;

    try {
      const base = dependencies({
        diffReader: {
          readBaselineSha: vi.fn().mockResolvedValue('baseline'),
          readDiff: vi.fn().mockResolvedValue({ status: 'ok', snapshot }),
        },
      });
      runtime = await CompanionStepRuntime.create({
        ...base,
        cwd: root,
        projectCwd: root,
      });
      const state = { companion: undefined } as unknown as WorkflowState;

      const result = await runtime.complete(state, 'complete', { afterFix: false });

      expect(result).toMatchObject({
        escalated: true,
        completionVerified: true,
        reason: expect.stringContaining('cumulative capacity'),
      });
      expect(state.companion).toMatchObject({ escalated: true, completionVerified: true });
      expect(callSpy).not.toHaveBeenCalled();
    } finally {
      runtime?.stop();
      callSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('should retain confirmed open must_fix findings after mailbox capacity is reached', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-companion-runtime-retained-capacity-'));
    const mailboxDirectory = join(root, '.takt', 'runs', 'run', 'companion', 'implement');
    const mailboxPath = join(mailboxDirectory, 'security-reviewer.jsonl');
    const records = Array.from(
      { length: COMPANION_CUMULATIVE_LIMITS.maxFindingsPerMailbox },
      (_, index) => ({
        id: `security-reviewer-${index + 1}`,
        severity: index === 0 ? 'must_fix' : 'nit',
        file: 'src/a.ts',
        line: index + 1,
        finding: `confirmed-${index + 1}`,
        status: 'open',
      }),
    );
    mkdirSync(mailboxDirectory, { recursive: true });
    writeFileSync(mailboxPath, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    const callSpy = vi.spyOn(CompanionStructuredCaller.prototype, 'call').mockResolvedValue({
      status: 'done',
      content: '',
      structuredOutput: {
        findings: [{ severity: 'nit', file: 'src/b.ts', line: 1, finding: 'overflow' }],
        updates: [],
        notes: null,
      },
    });
    let runtime: CompanionStepRuntime | undefined;

    try {
      const base = dependencies({
        diffReader: {
          readBaselineSha: vi.fn().mockResolvedValue('baseline'),
          readDiff: vi.fn().mockResolvedValue({ status: 'ok', snapshot }),
        },
      });
      runtime = await CompanionStepRuntime.create({
        ...base,
        cwd: root,
        projectCwd: root,
      });
      const state = { companion: undefined } as unknown as WorkflowState;

      const result = await runtime.complete(state, 'complete', { afterFix: false });

      expect(result).toMatchObject({
        escalated: true,
        completionVerified: true,
        openMustFix: [{
          id: 'security-reviewer-1', severity: 'must_fix', file: 'src/a.ts', line: 1,
          finding: 'confirmed-1',
        }],
        reason: expect.stringContaining('cumulative capacity'),
      });
      expect(state.companion).toMatchObject({
        escalated: true,
        completionVerified: true,
        openMustFixCount: 1,
        openMustFix: [{
          id: 'security-reviewer-1', severity: 'must_fix', file: 'src/a.ts', line: 1,
          finding: 'confirmed-1',
        }],
      });
      expect(callSpy).toHaveBeenCalledOnce();
    } finally {
      runtime?.stop();
      callSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
