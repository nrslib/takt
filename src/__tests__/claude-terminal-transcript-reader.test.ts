import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getClaudeProjectSessionsDir } from '../infra/config/project/sessionStore.js';
import {
  parseClaudeTerminalTranscript,
  ProjectClaudeTranscriptReader,
} from '../infra/claude-terminal/transcript-reader.js';

const fsMockState = vi.hoisted(() => ({
  readFileCount: 0,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn(async (...args: Parameters<typeof actual.readFile>) => {
      fsMockState.readFileCount += 1;
      return await actual.readFile(...args);
    }),
  };
});

async function withTemporaryClaudeHome<T>(run: (projectDir: string) => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  const homeDir = await mkdtemp(join(tmpdir(), 'takt-claude-terminal-home-'));
  const projectDir = await mkdtemp(join(tmpdir(), 'takt-claude-terminal-project-'));
  process.env.HOME = homeDir;

  try {
    return await run(projectDir);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(homeDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function wait(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

type PromiseSettlement =
  | { status: 'resolved' }
  | { status: 'rejected'; error: unknown }
  | { status: 'timeout' };

const LONG_POLL_INTERVAL_MS = 60_000;
const ABORT_SETTLE_TIMEOUT_MS = 50;

function observeSettlement(promise: Promise<unknown>): Promise<PromiseSettlement> {
  return promise.then(
    () => ({ status: 'resolved' as const }),
    (error: unknown) => ({ status: 'rejected' as const, error }),
  );
}

async function expectRejectedBeforePollingInterval(settlementPromise: Promise<PromiseSettlement>): Promise<unknown> {
  const settlement = await Promise.race<PromiseSettlement>([
    settlementPromise,
    wait(ABORT_SETTLE_TIMEOUT_MS).then(() => ({ status: 'timeout' as const })),
  ]);

  expect(settlement.status).toBe('rejected');
  if (settlement.status !== 'rejected') {
    throw new Error(`Expected polling to reject before the ${LONG_POLL_INTERVAL_MS}ms interval elapsed.`);
  }
  return settlement.error;
}

describe('Claude terminal transcript reader', () => {
  beforeEach(() => {
    fsMockState.readFileCount = 0;
  });

  it('Given Claude transcript JSONL, When parsing, Then session id, assistant text, and tool events are extracted', () => {
    const transcript = [
      JSON.stringify({
        type: 'user',
        session_id: 'claude-session-1',
        message: { role: 'user', content: [{ type: 'text', text: 'implement task' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        session_id: 'claude-session-1',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will inspect the file.' },
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'src/index.ts' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        session_id: 'claude-session-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Done.' }],
        },
      }),
    ].join('\n');

    const parsed = parseClaudeTerminalTranscript(transcript);

    expect(parsed).toEqual({
      sessionId: 'claude-session-1',
      assistantText: 'I will inspect the file.\nDone.',
      events: [
        {
          type: 'tool_use',
          id: 'toolu_1',
          tool: 'Read',
          input: { file_path: 'src/index.ts' },
        },
      ],
    });
  });

  it('Given resume transcript baseline, When parsing, Then existing assistant responses are ignored', () => {
    const existingTranscript = [
      JSON.stringify({
        type: 'user',
        session_id: 'claude-session-1',
        message: { role: 'user', content: [{ type: 'text', text: 'previous prompt' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        session_id: 'claude-session-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'old response' }],
        },
      }),
    ].join('\n');
    const currentTranscript = [
      JSON.stringify({
        type: 'user',
        session_id: 'claude-session-1',
        message: { role: 'user', content: [{ type: 'text', text: 'current prompt' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        session_id: 'claude-session-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'current response' }],
        },
      }),
    ].join('\n');
    const transcript = `${existingTranscript}\n${currentTranscript}`;

    const parsed = parseClaudeTerminalTranscript(transcript, {
      baseline: {
        byteOffset: Buffer.byteLength(`${existingTranscript}\n`, 'utf-8'),
        lineNumberOffset: 2,
      },
    });

    expect(parsed).toEqual({
      sessionId: 'claude-session-1',
      assistantText: 'current response',
      events: [],
    });
  });

  it('Given permission and ask-user transcript events, When parsing, Then unsupported interactive events are surfaced explicitly', () => {
    const transcript = [
      JSON.stringify({
        type: 'permission_request',
        session_id: 'claude-session-1',
        tool: 'Bash',
        input: { command: 'npm test' },
      }),
      JSON.stringify({
        type: 'ask_user_question',
        session_id: 'claude-session-1',
        question: 'Which option should I choose?',
      }),
    ].join('\n');

    const parsed = parseClaudeTerminalTranscript(transcript);

    expect(parsed).toEqual({
      sessionId: 'claude-session-1',
      assistantText: '',
      events: [
        {
          type: 'permission_request',
          tool: 'Bash',
          input: { command: 'npm test' },
        },
        {
          type: 'ask_user_question',
          questions: [{ question: 'Which option should I choose?' }],
        },
      ],
    });
  });

  it('Given AskUserQuestion tool use content, When parsing, Then it is surfaced as a blocking ask-user event', () => {
    const transcript = JSON.stringify({
      type: 'assistant',
      session_id: 'claude-session-1',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_ask',
            name: 'AskUserQuestion',
            input: {
              questions: [
                {
                  question: 'Which option should I use?',
                  header: 'Choice',
                  options: [
                    { label: 'A', description: 'Use option A' },
                    { label: 'B' },
                  ],
                },
              ],
            },
          },
        ],
      },
    });

    const parsed = parseClaudeTerminalTranscript(transcript);

    expect(parsed).toEqual({
      sessionId: 'claude-session-1',
      assistantText: '',
      events: [
        {
          type: 'ask_user_question',
          questions: [
            {
              question: 'Which option should I use?',
              header: 'Choice',
              options: [
                { label: 'A', description: 'Use option A' },
                { label: 'B' },
              ],
            },
          ],
        },
      ],
    });
  });

  it('Given malformed JSONL, When parsing, Then transcript corruption is reported instead of skipped', () => {
    const transcript = [
      JSON.stringify({ type: 'user', session_id: 'claude-session-1' }),
      '{not-json',
    ].join('\n');

    expect(() => parseClaudeTerminalTranscript(transcript)).toThrow(/malformed claude terminal transcript json/i);
  });

  it('Given incomplete final JSONL, When polling parse is enabled, Then the final line is ignored temporarily', () => {
    const completeLine = JSON.stringify({
      type: 'assistant',
      session_id: 'claude-session-1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'parsed response' }],
      },
    });
    const transcript = `${completeLine}\n{"type":"assistant"`;

    const parsed = parseClaudeTerminalTranscript(transcript, {
      allowIncompleteFinalLine: true,
    });

    expect(parsed).toEqual({
      sessionId: 'claude-session-1',
      assistantText: 'parsed response',
      events: [],
    });
  });

  it('Given incomplete final JSONL, When strict parsing is used, Then transcript corruption is reported', () => {
    const transcript = [
      JSON.stringify({ type: 'user', session_id: 'claude-session-1' }),
      '{"type":"assistant"',
    ].join('\n');

    expect(() => parseClaudeTerminalTranscript(transcript)).toThrow(/malformed claude terminal transcript json/i);
  });

  it('Given malformed middle JSONL, When polling parse is enabled, Then transcript corruption is still reported', () => {
    const transcript = [
      JSON.stringify({ type: 'user', session_id: 'claude-session-1' }),
      '{not-json',
      JSON.stringify({
        type: 'assistant',
        session_id: 'claude-session-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'parsed response' }],
        },
      }),
    ].join('\n');

    expect(() => parseClaudeTerminalTranscript(transcript, {
      allowIncompleteFinalLine: true,
    })).toThrow(/malformed claude terminal transcript json/i);
  });

  it('Given an incomplete final JSONL becomes complete, When parsing again, Then the same line is parsed', () => {
    const firstLine = JSON.stringify({ type: 'user', session_id: 'claude-session-1' });
    const completeAssistantLine = JSON.stringify({
      type: 'assistant',
      session_id: 'claude-session-1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'completed response' }],
      },
    });

    const partial = parseClaudeTerminalTranscript(`${firstLine}\n{"type":"assistant"`, {
      allowIncompleteFinalLine: true,
    });
    const completed = parseClaudeTerminalTranscript(`${firstLine}\n${completeAssistantLine}`, {
      allowIncompleteFinalLine: true,
    });

    expect(partial.assistantText).toBe('');
    expect(completed.assistantText).toBe('completed response');
  });

  it('Given permission event without tool, When parsing, Then missing required fields are reported', () => {
    const transcript = JSON.stringify({
      type: 'permission_request',
      session_id: 'claude-session-1',
      input: { command: 'npm test' },
    });

    expect(() => parseClaudeTerminalTranscript(transcript)).toThrow(/permission_request\.tool/i);
  });

  it.each([
    '',
    '.',
    '..',
    '../other-project/session',
    'nested/session',
    'nested\\session',
  ])('Given unsafe session id %j, When reading a transcript, Then the project session directory is not escaped', async (sessionId) => {
    const reader = new ProjectClaudeTranscriptReader();

    await expect(reader.readBaseline({
      cwd: '/tmp/takt-project',
      sessionId,
    })).rejects.toThrow(/invalid claude terminal session id/i);
  });

  it('Given transcript receives a later assistant line and completion, When waiting, Then response is returned after completion', async () => {
    const originalHome = process.env.HOME;
    const homeDir = await mkdtemp(join(tmpdir(), 'takt-claude-terminal-home-'));
    const projectDir = await mkdtemp(join(tmpdir(), 'takt-claude-terminal-project-'));
    process.env.HOME = homeDir;

    try {
      const sessionId = 'claude-session-1';
      const sessionsDir = getClaudeProjectSessionsDir(projectDir);
      const transcriptPath = join(sessionsDir, `${sessionId}.jsonl`);
      const firstAssistantLine = JSON.stringify({
        type: 'assistant',
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'partial response' }],
        },
      });
      const finalAssistantLine = JSON.stringify({
        type: 'assistant',
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'final response' }],
        },
      });
      const completionLine = JSON.stringify({
        type: 'result',
        subtype: 'success',
        session_id: sessionId,
        result: 'final response',
      });
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(transcriptPath, firstAssistantLine, 'utf-8');

      const reader = new ProjectClaudeTranscriptReader();
      const responsePromise = reader.waitForAssistantResponse({
        cwd: projectDir,
        session: { sessionId },
        baseline: { byteOffset: 0, lineNumberOffset: 0 },
        timeoutMs: 200,
        pollIntervalMs: 5,
      });
      setTimeout(() => {
        void writeFile(transcriptPath, `${firstAssistantLine}\n${finalAssistantLine}\n${completionLine}`, 'utf-8');
      }, 20);

      await expect(responsePromise).resolves.toMatchObject({
        sessionId,
        assistantText: 'partial response\nfinal response',
      });
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      await rm(homeDir, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('Given interactive transcript has assistant text followed by turn duration, When waiting, Then response is returned', async () => {
    await withTemporaryClaudeHome(async (projectDir) => {
      const sessionId = 'claude-session-1';
      const sessionsDir = getClaudeProjectSessionsDir(projectDir);
      const transcriptPath = join(sessionsDir, `${sessionId}.jsonl`);
      const assistantLine = JSON.stringify({
        type: 'assistant',
        sessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'add-review-thread-state' }],
        },
      });
      const turnDurationLine = JSON.stringify({
        type: 'system',
        subtype: 'turn_duration',
        sessionId,
        durationMs: 2521,
        messageCount: 8,
      });
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(transcriptPath, `${assistantLine}\n${turnDurationLine}`, 'utf-8');

      const reader = new ProjectClaudeTranscriptReader();

      await expect(reader.waitForAssistantResponse({
        cwd: projectDir,
        session: { sessionId },
        baseline: { byteOffset: 0, lineNumberOffset: 0 },
        timeoutMs: 30,
        pollIntervalMs: 5,
      })).resolves.toMatchObject({
        sessionId,
        assistantText: 'add-review-thread-state',
      });
    });
  });

  it('Given transcript has assistant text without completion, When waiting, Then partial response is not returned', async () => {
    const originalHome = process.env.HOME;
    const homeDir = await mkdtemp(join(tmpdir(), 'takt-claude-terminal-home-'));
    const projectDir = await mkdtemp(join(tmpdir(), 'takt-claude-terminal-project-'));
    process.env.HOME = homeDir;

    try {
      const sessionId = 'claude-session-1';
      const sessionsDir = getClaudeProjectSessionsDir(projectDir);
      const transcriptPath = join(sessionsDir, `${sessionId}.jsonl`);
      const assistantLine = JSON.stringify({
        type: 'assistant',
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'partial response' }],
        },
      });
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(transcriptPath, assistantLine, 'utf-8');

      const reader = new ProjectClaudeTranscriptReader();

      await expect(reader.waitForAssistantResponse({
        cwd: projectDir,
        session: { sessionId },
        baseline: { byteOffset: 0, lineNumberOffset: 0 },
        timeoutMs: 30,
        pollIntervalMs: 5,
      })).rejects.toThrow(/timed out waiting for claude terminal assistant response/i);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      await rm(homeDir, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('Given findSession sees an incomplete final JSONL line, When polling, Then it returns the parsed session state', async () => {
    await withTemporaryClaudeHome(async (projectDir) => {
      const sessionId = 'claude-session-1';
      const sessionsDir = getClaudeProjectSessionsDir(projectDir);
      const transcriptPath = join(sessionsDir, `${sessionId}.jsonl`);
      const userLine = JSON.stringify({
        type: 'user',
        session_id: sessionId,
        message: { role: 'user', content: [{ type: 'text', text: 'implement task' }] },
      });
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(transcriptPath, `${userLine}\n{"type":"assistant"`, 'utf-8');

      const reader = new ProjectClaudeTranscriptReader();

      await expect(reader.findSession({
        cwd: projectDir,
        sessionId,
        timeoutMs: 30,
        pollIntervalMs: 5,
      })).resolves.toEqual({ sessionId });
    });
  });

  it('Given waitForAssistantResponse sees an incomplete final completion line, When polling, Then it retries until the line is complete', async () => {
    await withTemporaryClaudeHome(async (projectDir) => {
      const sessionId = 'claude-session-1';
      const sessionsDir = getClaudeProjectSessionsDir(projectDir);
      const transcriptPath = join(sessionsDir, `${sessionId}.jsonl`);
      const assistantLine = JSON.stringify({
        type: 'assistant',
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'final response' }],
        },
      });
      const completionLine = JSON.stringify({
        type: 'result',
        subtype: 'success',
        session_id: sessionId,
        result: 'final response',
      });
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(transcriptPath, `${assistantLine}\n{"type":"result"`, 'utf-8');

      const reader = new ProjectClaudeTranscriptReader();
      const responsePromise = reader.waitForAssistantResponse({
        cwd: projectDir,
        session: { sessionId },
        baseline: { byteOffset: 0, lineNumberOffset: 0 },
        timeoutMs: 200,
        pollIntervalMs: 5,
      });
      setTimeout(() => {
        void writeFile(transcriptPath, `${assistantLine}\n${completionLine}`, 'utf-8');
      }, 20);

      await expect(responsePromise).resolves.toMatchObject({
        sessionId,
        assistantText: 'final response',
      });
    });
  });

  it('Given findSession is polling, When abortSignal fires, Then polling stops before the next session read', async () => {
    await withTemporaryClaudeHome(async (projectDir) => {
      const reader = new ProjectClaudeTranscriptReader();
      const controller = new AbortController();
      const sessionId = 'claude-session-1';

      const sessionPromise = reader.findSession({
        cwd: projectDir,
        sessionId,
        timeoutMs: LONG_POLL_INTERVAL_MS * 2,
        pollIntervalMs: LONG_POLL_INTERVAL_MS,
        abortSignal: controller.signal,
      });
      const sessionSettlement = observeSettlement(sessionPromise);

      try {
        await wait(20);
        expect(fsMockState.readFileCount).toBeGreaterThan(0);

        controller.abort(new Error('manual findSession abort'));
        const readCountAtAbort = fsMockState.readFileCount;

        const sessionsDir = getClaudeProjectSessionsDir(projectDir);
        await mkdir(sessionsDir, { recursive: true });
        await writeFile(join(sessionsDir, `${sessionId}.jsonl`), JSON.stringify({
          type: 'user',
          session_id: sessionId,
          message: { role: 'user', content: [{ type: 'text', text: 'late prompt' }] },
        }), 'utf-8');

        const error = await expectRejectedBeforePollingInterval(sessionSettlement);
        expect(String(error)).not.toMatch(/timed out waiting/i);
        expect(fsMockState.readFileCount).toBe(readCountAtAbort);
      } finally {
        await sessionPromise.catch(() => undefined);
      }
    });
  });

  it('Given findSession starts with an aborted signal, When polling would begin, Then no transcript is read', async () => {
    await withTemporaryClaudeHome(async (projectDir) => {
      const reader = new ProjectClaudeTranscriptReader();
      const controller = new AbortController();
      controller.abort(new Error('manual findSession abort before polling'));

      await expect(reader.findSession({
        cwd: projectDir,
        sessionId: 'claude-session-1',
        timeoutMs: 200,
        pollIntervalMs: 10,
        abortSignal: controller.signal,
      })).rejects.toThrow(/manual findSession abort before polling/i);
      expect(fsMockState.readFileCount).toBe(0);
    });
  });

  it('Given waitForAssistantResponse is polling, When abortSignal fires, Then polling stops before completion appears', async () => {
    await withTemporaryClaudeHome(async (projectDir) => {
      const reader = new ProjectClaudeTranscriptReader();
      const controller = new AbortController();
      const sessionId = 'claude-session-1';
      const sessionsDir = getClaudeProjectSessionsDir(projectDir);
      const transcriptPath = join(sessionsDir, `${sessionId}.jsonl`);
      const assistantLine = JSON.stringify({
        type: 'assistant',
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'partial response' }],
        },
      });
      const completionLine = JSON.stringify({
        type: 'result',
        subtype: 'success',
        session_id: sessionId,
        result: 'final response',
      });
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(transcriptPath, assistantLine, 'utf-8');

      const responsePromise = reader.waitForAssistantResponse({
        cwd: projectDir,
        session: { sessionId },
        baseline: { byteOffset: 0, lineNumberOffset: 0 },
        timeoutMs: LONG_POLL_INTERVAL_MS * 2,
        pollIntervalMs: LONG_POLL_INTERVAL_MS,
        abortSignal: controller.signal,
      });
      const responseSettlement = observeSettlement(responsePromise);

      try {
        await wait(20);
        expect(fsMockState.readFileCount).toBeGreaterThan(0);

        controller.abort(new Error('manual response abort'));
        const readCountAtAbort = fsMockState.readFileCount;

        await writeFile(transcriptPath, `${assistantLine}\n${completionLine}`, 'utf-8');

        const error = await expectRejectedBeforePollingInterval(responseSettlement);
        expect(String(error)).not.toMatch(/timed out waiting/i);
        expect(fsMockState.readFileCount).toBe(readCountAtAbort);
      } finally {
        await responsePromise.catch(() => undefined);
      }
    });
  });

  it('Given waitForAssistantResponse starts with an aborted signal, When polling would begin, Then no transcript is read', async () => {
    await withTemporaryClaudeHome(async (projectDir) => {
      const reader = new ProjectClaudeTranscriptReader();
      const controller = new AbortController();
      controller.abort(new Error('manual response abort before polling'));

      await expect(reader.waitForAssistantResponse({
        cwd: projectDir,
        session: { sessionId: 'claude-session-1' },
        baseline: { byteOffset: 0, lineNumberOffset: 0 },
        timeoutMs: 200,
        pollIntervalMs: 10,
        abortSignal: controller.signal,
      })).rejects.toThrow(/manual response abort before polling/i);
      expect(fsMockState.readFileCount).toBe(0);
    });
  });
});
