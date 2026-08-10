import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalAgentWorkflowStep } from '../core/models/types.js';
import type { CompanionDiffReader } from '../core/workflow/companion/diff-reader.js';
import { CompanionStepRuntime } from '../core/workflow/companion/step-runtime.js';
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

function step(allowGitCommit?: boolean): NormalAgentWorkflowStep {
  return {
    name: 'implement',
    persona: 'coder',
    personaDisplayName: 'coder',
    instruction: 'implement',
    edit: true,
    passPreviousResponse: true,
    companion: { fixed: ['security-reviewer'], pool: [] },
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
      await runtime.complete({ companion: undefined } as unknown as WorkflowState, 'complete');
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
    const callSpy = vi.spyOn(CompanionStructuredCaller.prototype, 'call').mockResolvedValue({
      status: 'done',
      content: '',
      structuredOutput: { selected_ids: ['security-reviewer'], rationale: 'relevant' },
    });
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
      await runtime.complete({ companion: undefined } as unknown as WorkflowState, 'first');
      runtime.beginFixRound(3, 1);
      runtime.observe({
        type: 'tool_use',
        data: { tool: 'Edit', input: { path: 'src/a.ts' }, id: 'second-edit' },
      });
      await runtime.complete({ companion: undefined } as unknown as WorkflowState, 'second');

      expect(schemas.filter(({ purpose }) => purpose === 'reviewer')).toHaveLength(1);
      expect(schemas.filter(({ purpose }) => purpose === 'judge')).toHaveLength(1);
      for (const { outputSchema } of schemas) {
        expect(() => assertStrictStructuredOutputSchema(outputSchema)).not.toThrow();
      }
    } finally {
      runtime?.stop();
      callSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
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

      const result = await runtime.complete(state, 'complete');

      expect(result).toMatchObject({
        escalated: true,
        reason: expect.stringContaining('cumulative capacity'),
      });
      expect(state.companion).toMatchObject({ escalated: true });
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

      const result = await runtime.complete(state, 'complete');

      expect(result).toMatchObject({
        escalated: true,
        openMustFix: [{
          id: 'security-reviewer-1', severity: 'must_fix', file: 'src/a.ts', line: 1,
          finding: 'confirmed-1',
        }],
        reason: expect.stringContaining('cumulative capacity'),
      });
      expect(state.companion).toMatchObject({
        escalated: true,
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
