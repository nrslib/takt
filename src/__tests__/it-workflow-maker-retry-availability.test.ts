import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentResponse } from '../core/models/index.js';
import { getLabel } from '../shared/i18n/index.js';
import type { AgentSetup, Provider, ProviderAgent, ProviderCallOptions } from '../infra/providers/types.js';
import { runWorkflowMakerTui } from '../features/workflowMaker/tui.js';
import type { ConversationViewProps } from '../features/tui/ConversationView.js';
import { expectUndeliveredPrompt } from './helpers/undelivered.js';

const {
  mockGetProvider,
  mockMountInk,
  mockPromptInput,
  mockResolveUserMessageColors,
  mockSelectOption,
} = vi.hoisted(() => ({
  mockGetProvider: vi.fn(),
  mockMountInk: vi.fn(),
  mockPromptInput: vi.fn(),
  mockResolveUserMessageColors: vi.fn(),
  mockSelectOption: vi.fn(),
}));

vi.mock('../shared/prompt/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  promptInput: (...args: unknown[]) => mockPromptInput(...args),
  selectOption: (...args: unknown[]) => mockSelectOption(...args),
}));

vi.mock('../infra/providers/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getProvider: (...args: unknown[]) => mockGetProvider(...args),
}));

vi.mock('../features/tui/inkMount.js', () => ({
  mountInk: (...args: unknown[]) => mockMountInk(...args),
}));

vi.mock('../features/tui/terminalColors.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveUserMessageColors: (...args: unknown[]) => mockResolveUserMessageColors(...args),
}));

const ENTER = '\r';
const ESC = '\x1b';
const CTRL_C = '\x03';

interface MountHandlers {
  settle(value: unknown): void;
  fail(error: unknown): void;
}

type MountTreeBuilder = (handlers: MountHandlers) => ReactElement;

async function flushFrames(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function createTestProvider() {
  const calls: { prompt: string; options: ProviderCallOptions }[] = [];
  const systemPrompts: string[] = [];
  const providerCall = vi.fn(async (prompt: string, options: ProviderCallOptions): Promise<AgentResponse> => {
    calls.push({ prompt, options });
    return {
      persona: 'interactive',
      status: 'done',
      content: `Provider response ${calls.length}`,
      timestamp: new Date(),
    };
  });
  const providerAgent: ProviderAgent = { call: providerCall };
  const provider: Provider = {
    supportsStructuredOutput: false,
    supportsNativeImageInput: false,
    supportedMcpTransports: new Set<'stdio' | 'sse' | 'http'>(['stdio']),
    getRuntimeInstructions: () => null,
    keepsAllowedToolWithoutEdit: () => true,
    setup: (config: AgentSetup) => {
      systemPrompts.push(config.systemPrompt ?? '');
      return providerAgent;
    },
  };

  return { calls, provider, providerCall, systemPrompts };
}

describe('Workflow Maker assistant retry command availability integration', () => {
  let projectDir: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMountInk.mockReset();
    mockResolveUserMessageColors.mockResolvedValue({
      colors: { background: '#42454b', foreground: '#ffffff' },
    });
    mockSelectOption.mockReset().mockResolvedValue('new');
    mockPromptInput.mockReset().mockResolvedValue('workflow-base');
  });

  afterEach(() => {
    if (projectDir !== undefined) {
      rmSync(projectDir, { recursive: true, force: true });
      projectDir = undefined;
    }
  });

  it.each(['interrupted', 'completed'] as const)(
    'retains original history and resends only an %s message after /workflow',
    async (outcome) => {
      projectDir = mkdtempSync(join(tmpdir(), 'takt-workflow-maker-resend-'));
      mkdirSync(join(projectDir, '.takt'), { recursive: true });
      writeFileSync(join(projectDir, '.takt', 'config.yaml'), 'language: en\nprovider: mock\n');
      mockPromptInput.mockResolvedValueOnce('first-base').mockResolvedValueOnce('next-base');
      const providerState = createTestProvider();
      mockGetProvider.mockReturnValue(providerState.provider);
      if (outcome === 'interrupted') {
        providerState.providerCall.mockImplementationOnce((prompt, options) => {
          providerState.calls.push({ prompt, options });
          return new Promise((_resolve, reject) => {
            options.abortSignal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        });
      }
      let mountCount = 0;
      mockMountInk.mockImplementation(async (buildTree: MountTreeBuilder) => {
        let settle!: (value: unknown) => void;
        let fail!: (error: unknown) => void;
        const settled = new Promise<unknown>((resolve, reject) => {
          settle = resolve;
          fail = reject;
        });
        void settled.catch(() => undefined);
        const tree = buildTree({ settle, fail }) as ReactElement<ConversationViewProps>;
        const app = render(tree);
        try {
          await flushFrames();
          if (mountCount++ === 0) {
            app.stdin.write('A');
            await flushFrames();
            app.stdin.write(ENTER);
            await vi.waitFor(() => expect(providerState.providerCall).toHaveBeenCalledTimes(1));
            if (outcome === 'interrupted') {
              app.stdin.write(ESC);
              await vi.waitFor(() => expect(app.lastFrame() ?? '')
                .toContain(getLabel('tui.ui.responseInterrupted', 'en')));
            } else {
              await vi.waitFor(() => expect(app.lastFrame() ?? '').toContain('Provider response 1'));
            }
            app.stdin.write('/workflow');
            await flushFrames();
            app.stdin.write(ENTER);
          } else {
            app.stdin.write('C');
            await flushFrames();
            app.stdin.write(ENTER);
            await vi.waitFor(() => expect(app.lastFrame() ?? '').toContain('Provider response 2'));
            const prompt = providerState.calls[1]!.prompt;
            if (outcome === 'interrupted') {
              expectUndeliveredPrompt(prompt, ['A'], 'C');
            } else {
              expect(prompt.split('\n\n').at(-1)?.trim()).toBe('C');
              expect(prompt).toContain('reference context only');
              expect(prompt.match(/User: A/gu)).toHaveLength(1);
            }
            expect(tree.props.conversation.snapshotHistory?.()
              .filter((message) => message.role === 'user').map((message) => message.content))
              .toEqual(['A', 'C']);
            app.stdin.write(CTRL_C);
          }
          return await settled;
        } finally {
          app.unmount();
        }
      });
      const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        await runWorkflowMakerTui({ projectDir });
        expect(mockPromptInput).toHaveBeenCalledTimes(2);
        expect(providerState.providerCall).toHaveBeenCalledTimes(2);
      } finally {
        stdoutWrite.mockRestore();
      }
    },
  );

  it.each(['en', 'ja'] as const)(
    'treats retry commands as regular conversation and retains /workflow for %s',
    async (lang) => {
      projectDir = mkdtempSync(join(tmpdir(), 'takt-workflow-maker-retry-'));
      mkdirSync(join(projectDir, '.takt'), { recursive: true });
      writeFileSync(join(projectDir, '.takt', 'config.yaml'), `language: ${lang}\nprovider: mock\n`);

      const providerState = createTestProvider();
      mockGetProvider.mockReturnValue(providerState.provider);

      let mountCount = 0;
      mockMountInk.mockImplementation(async (...args: unknown[]) => {
        const buildTree = args[0] as MountTreeBuilder;
        let settle!: (value: unknown) => void;
        let fail!: (error: unknown) => void;
        const settled = new Promise<unknown>((resolve, reject) => {
          settle = resolve;
          fail = reject;
        });
        void settled.catch(() => undefined);
        const app = render(buildTree({ settle, fail }));
        const script: { text: string; response?: number }[] = mountCount++ === 0
          ? [
            { text: '/retry revise from the beginning', response: 1 },
            { text: '/requeue return it to the queue', response: 2 },
            { text: '/workflow' },
          ]
          : [
            { text: '/retry revise after switching the base', response: 3 },
            { text: '/requeue queue after switching the base', response: 4 },
            { text: CTRL_C },
          ];

        try {
          await flushFrames();
          for (const step of script) {
            app.stdin.write(step.text);
            await flushFrames();
            if (step.text === CTRL_C) {
              continue;
            }
            app.stdin.write(ENTER);
            const response = step.response;
            if (response !== undefined) {
              await vi.waitFor(() => {
                expect(providerState.providerCall).toHaveBeenCalledTimes(response);
                expect(app.lastFrame() ?? '').toContain(`Provider response ${response}`);
              });
            }
          }
          return await settled;
        } finally {
          app.unmount();
        }
      });

      const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        await runWorkflowMakerTui({ projectDir });
      } finally {
        stdoutWrite.mockRestore();
      }

      expect(mockGetProvider).toHaveBeenCalledWith('mock');
      expect(mockSelectOption).toHaveBeenCalledTimes(2);
      expect(mockPromptInput).toHaveBeenCalledTimes(2);
      expect(providerState.providerCall).toHaveBeenCalledTimes(4);
      expect(providerState.systemPrompts).toHaveLength(4);
      const expectedMessages = [
        '/retry revise from the beginning',
        '/requeue return it to the queue',
        '/retry revise after switching the base',
        '/requeue queue after switching the base',
      ];
      for (const [index, prompt] of providerState.calls.map(({ prompt }) => prompt).entries()) {
        expect(prompt).toContain(expectedMessages[index]);
      }
      for (const { options } of providerState.calls) {
        expect(options.permissionMode).toBe('readonly');
        expect(options.allowedTools).toEqual(expect.arrayContaining([
          'Read',
          'Glob',
          'Grep',
          'WebSearch',
          'WebFetch',
        ]));
        expect(options.allowedTools).not.toEqual(expect.arrayContaining(['Write', 'Edit']));
        expect(options.mcpServers?.takt).toMatchObject({
          args: expect.arrayContaining(['--tool-set', 'read-only']),
        });
      }
      for (const prompt of providerState.systemPrompts) {
        expect(prompt).toContain(getLabel('interactive.ui.assistantRetryUnavailableGuidance', lang));
        expect(prompt).not.toContain('{{');
        expect(prompt).not.toContain(lang === 'en'
          ? 'Web UI cannot change task state'
          : 'Web UI からタスク状態を変更できない');
      }
    },
  );
});
