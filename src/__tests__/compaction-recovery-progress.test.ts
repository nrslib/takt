import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgent } from '../agents/runner.js';
import type { RunAgentOptions } from '../agents/types.js';
import type { AgentResponse } from '../core/models/index.js';
import type { ProgressNotesRequest } from '../core/workflow/progress-notes.js';
import type { Provider, ProviderAgent, ProviderCallOptions } from '../infra/providers/types.js';

const { getProviderMock, storeState } = vi.hoisted(() => ({
  getProviderMock: vi.fn(),
  storeState: { log: undefined as string | undefined, openFails: false, unavailable: false },
}));

vi.mock('../infra/providers/index.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../infra/providers/index.js')>(),
  getProvider: getProviderMock,
}));

// In-memory store with the real store's contract: append returns the saved log, read returns the
// current log, and failures to open or write it are reported as ProgressNotesUnavailableError.
vi.mock('../infra/progress-notes/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/progress-notes/store.js')>();
  const store = {
    path: '/run/reports/progress-notes/notes.log',
    target: { identity: 'step', revision: null },
    append: (note: string): string => {
      if (storeState.unavailable) throw new actual.ProgressNotesUnavailableError('Progress notes write failed');
      storeState.log = `${storeState.log ?? ''}${note}`;
      return storeState.log;
    },
    read: (): string | undefined => storeState.log,
  };
  return {
    ...actual,
    ProgressNotesStore: {
      create: async () => {
        if (storeState.openFails) throw new actual.ProgressNotesUnavailableError('Progress notes store unavailable');
        return { store, log: storeState.log };
      },
    },
  };
});

type Turn = (options: ProviderCallOptions) => AgentResponse;

const request: ProgressNotesRequest = {
  reportDir: '/run/reports',
  task: 'review the change',
  stepName: 'reviewers',
  definition: 'readonly reviewer',
  bindsSourceRevision: false,
};

function done(content: string): AgentResponse {
  return { persona: 'default', status: 'done', content, sessionId: 'thread', timestamp: new Date('2026-11-17T00:00:00.000Z') };
}

function compact(options: ProviderCallOptions): void {
  options.onStream?.({ type: 'context_compacted', data: { sessionId: 'thread' } });
}

function finalAnswer(options: ProviderCallOptions, content: string): AgentResponse {
  options.onStream?.({ type: 'text', data: { text: content } });
  options.onStream?.({ type: 'result', data: { result: content, sessionId: 'thread', success: true } });
  return done(content);
}

function runTool(options: ProviderCallOptions, id: string): void {
  options.onStream?.({ type: 'tool_use', data: { tool: 'Read', input: { file_path: 'src/retry.ts' }, id } });
  options.onStream?.({ type: 'tool_result', data: { id, content: 'export const retry = 1;', isError: false } });
}

function writeNote(options: ProviderCallOptions, index: number): void {
  options.onStream?.({ type: 'text', data: { text: `Checked retry.ts part ${index}; next part ${index + 1}.` } });
}

/** Runs a tool without writing any visible text and is compacted before it finishes. */
const toolOnlyTurn = (index: number): Turn => (options) => {
  runTool(options, `tool-${index}`);
  compact(options);
  return done('');
};

/** Writes a note, runs a tool right after it, and is compacted before it finishes. */
const workingTurn = (index: number): Turn => (options) => {
  writeNote(options, index);
  runTool(options, `tool-${index}`);
  compact(options);
  return finalAnswer(options, 'What should I review?');
};

const stalledTurn: Turn = (options) => {
  compact(options);
  return finalAnswer(options, 'What should I review?');
};

const completedTurn: Turn = (options) => finalAnswer(options, 'Review complete: no findings.');

function provideTurns(turns: readonly Turn[]): {
  readonly call: ReturnType<typeof vi.fn<ProviderAgent['call']>>;
  readonly recoverFromCompaction: ReturnType<typeof vi.fn<NonNullable<ProviderAgent['recoverFromCompaction']>>>;
} {
  let next = 0;
  const runNext = async (_prompt: string, options: ProviderCallOptions): Promise<AgentResponse> => {
    const turn = turns[next++];
    if (turn === undefined) throw new Error(`Unexpected provider turn ${next}`);
    return turn(options);
  };
  const call = vi.fn<ProviderAgent['call']>(runNext);
  const recoverFromCompaction = vi.fn<NonNullable<ProviderAgent['recoverFromCompaction']>>(runNext);
  const provider: Provider = {
    supportsStructuredOutput: false,
    supportsNativeImageInput: false,
    getRuntimeInstructions: () => null,
    keepsAllowedToolWithoutEdit: () => true,
    setup: () => ({ call, recoverFromCompaction }),
  };
  getProviderMock.mockReturnValue(provider);
  return { call, recoverFromCompaction };
}

function runPhase1(): Promise<AgentResponse> {
  const options: RunAgentOptions = {
    cwd: '/worktree',
    executionPhase: 1,
    sessionId: 'thread',
    edit: false,
    language: 'en',
    progressNotes: request,
    resolvedExecution: { provider: 'codex', model: 'gpt-test', providerOptions: undefined, permissionMode: 'readonly' },
  };
  return runAgent(undefined, 'Review the retry boundary.', options);
}

describe('compaction recovery limit based on tool activity', () => {
  beforeEach(() => {
    getProviderMock.mockReset();
    storeState.log = undefined;
    storeState.openFails = false;
    storeState.unavailable = false;
  });

  it('fails after three consecutive recoveries that compact again without running a tool', async () => {
    const { call, recoverFromCompaction } = provideTurns([stalledTurn, stalledTurn, stalledTurn, stalledTurn]);

    const response = await runPhase1();

    expect(response).toMatchObject({ status: 'error', error: expect.any(String), sessionId: 'thread' });
    expect(call).toHaveBeenCalledOnce();
    expect(recoverFromCompaction).toHaveBeenCalledTimes(3);
  });

  it.each<[string, (index: number) => Turn]>([
    ['runs a tool without writing a note', toolOnlyTurn],
    ['writes a note and runs a tool', workingTurn],
  ])('keeps recovering past three compactions while each recovery %s, then returns the final answer', async (_kind, working) => {
    const { recoverFromCompaction } = provideTurns([
      working(1), working(2), working(3), working(4), working(5), completedTurn,
    ]);

    const response = await runPhase1();

    expect(response).toMatchObject({ status: 'done', content: 'Review complete: no findings.', sessionId: 'thread' });
    expect(recoverFromCompaction).toHaveBeenCalledTimes(5);
  });

  it.each<[string, 'openFails' | 'unavailable']>([
    ['the progress notes store cannot be opened', 'openFails'],
    ['saving progress notes fails', 'unavailable'],
  ])('keeps recovering past three compactions while each recovery runs a tool when %s', async (_kind, failure) => {
    storeState[failure] = true;
    const { recoverFromCompaction } = provideTurns([
      workingTurn(1), workingTurn(2), workingTurn(3), workingTurn(4), workingTurn(5), completedTurn,
    ]);

    const response = await runPhase1();

    expect(storeState.log).toBeUndefined();
    expect(response).toMatchObject({ status: 'done', content: 'Review complete: no findings.', sessionId: 'thread' });
    expect(recoverFromCompaction).toHaveBeenCalledTimes(5);
  });

  it('counts recoveries without a tool call again from zero after a recovery that runs a tool', async () => {
    const { recoverFromCompaction } = provideTurns([
      stalledTurn, stalledTurn, stalledTurn, toolOnlyTurn(1), stalledTurn, stalledTurn, stalledTurn,
    ]);

    const response = await runPhase1();

    expect(response).toMatchObject({ status: 'error', error: expect.any(String) });
    expect(recoverFromCompaction).toHaveBeenCalledTimes(6);
  });

  it.each<[string, Turn]>([
    ['a final answer text and result', stalledTurn],
    ['a result event without text', (options) => {
      compact(options);
      options.onStream?.({ type: 'result', data: { result: 'Still reviewing.', sessionId: 'thread', success: true } });
      return done('Still reviewing.');
    }],
    ['a response without stream events', (options) => {
      compact(options);
      return done('Still reviewing.');
    }],
    ['a saved note without a tool call', (options) => {
      writeNote(options, 1);
      compact(options);
      return finalAnswer(options, 'What should I review?');
    }],
    ['private reasoning without a tool call', (options) => {
      options.onStream?.({ type: 'thinking', data: { thinking: 'I should read retry.ts again.' } });
      compact(options);
      return done('');
    }],
  ])('does not reset the count for %s', async (_kind, turn) => {
    const { recoverFromCompaction } = provideTurns([turn, turn, turn, turn]);

    const response = await runPhase1();

    expect(response).toMatchObject({ status: 'error', error: expect.any(String) });
    expect(recoverFromCompaction).toHaveBeenCalledTimes(3);
  });
});
