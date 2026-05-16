import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getClaudeProjectSessionsDir } from '../infra/config/project/sessionStore.js';
import {
  parseClaudeTerminalTranscript,
  ProjectClaudeTranscriptReader,
} from '../infra/claude-terminal/transcript-reader.js';

describe('Claude terminal transcript reader', () => {
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
      byteOffset: Buffer.byteLength(`${existingTranscript}\n`, 'utf-8'),
      lineNumberOffset: 2,
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
});
