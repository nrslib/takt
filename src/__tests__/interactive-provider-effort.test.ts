import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const {
  mockCallCodex,
  mockCallClaude,
  mockCallClaudeHeadless,
  mockCallClaudeTerminal,
  mockCallCopilot,
} = vi.hoisted(() => ({
  mockCallCodex: vi.fn(),
  mockCallClaude: vi.fn(),
  mockCallClaudeHeadless: vi.fn(),
  mockCallClaudeTerminal: vi.fn(),
  mockCallCopilot: vi.fn(),
}));

vi.mock('../infra/codex/index.js', () => ({
  callCodex: mockCallCodex,
  callCodexCustom: vi.fn(),
}));

vi.mock('../infra/claude/client.js', () => ({
  callClaude: mockCallClaude,
  callClaudeCustom: vi.fn(),
}));

vi.mock('../infra/claude-headless/client.js', () => ({
  callClaudeHeadless: mockCallClaudeHeadless,
}));

vi.mock('../infra/claude-terminal/client.js', () => ({
  callClaudeTerminal: mockCallClaudeTerminal,
}));

vi.mock('../infra/copilot/index.js', () => ({
  callCopilot: mockCallCopilot,
  callCopilotCustom: vi.fn(),
}));

vi.mock('../infra/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/config/index.js')>()),
  resolveAnthropicApiKey: vi.fn(() => undefined),
  resolveClaudeCliPath: vi.fn(() => undefined),
  resolveCodexCliPath: vi.fn(() => undefined),
  resolveCopilotCliPath: vi.fn(() => undefined),
  resolveCopilotGithubToken: vi.fn(() => undefined),
  resolveOpenaiApiKey: vi.fn(() => undefined),
}));

import { CodexProvider } from '../infra/providers/codex.js';
import { ClaudeProvider } from '../infra/providers/claude.js';
import { ClaudeHeadlessProvider } from '../infra/providers/claude-headless.js';
import { ClaudeTerminalProvider } from '../infra/providers/claude-terminal.js';
import { CopilotProvider } from '../infra/providers/copilot.js';
import type { Provider, ProviderCallOptions } from '../infra/providers/types.js';

interface EffortAdapterCase {
  readonly name: string;
  readonly provider: () => Provider;
  readonly client: Mock;
  readonly optionName: 'effort' | 'reasoningEffort';
  readonly configuredOptions: ProviderCallOptions['providerOptions'];
}

const cases: readonly EffortAdapterCase[] = [
  {
    name: 'Codex',
    provider: () => new CodexProvider(),
    client: mockCallCodex,
    optionName: 'reasoningEffort',
    configuredOptions: { codex: { reasoningEffort: 'low' } },
  },
  {
    name: 'Claude SDK',
    provider: () => new ClaudeProvider(),
    client: mockCallClaude,
    optionName: 'effort',
    configuredOptions: { claude: { effort: 'low' } },
  },
  {
    name: 'Claude headless',
    provider: () => new ClaudeHeadlessProvider(),
    client: mockCallClaudeHeadless,
    optionName: 'effort',
    configuredOptions: { claude: { effort: 'low' } },
  },
  {
    name: 'Claude terminal',
    provider: () => new ClaudeTerminalProvider(),
    client: mockCallClaudeTerminal,
    optionName: 'effort',
    configuredOptions: { claude: { effort: 'low' } },
  },
  {
    name: 'Copilot',
    provider: () => new CopilotProvider(),
    client: mockCallCopilot,
    optionName: 'effort',
    configuredOptions: { copilot: { effort: 'low' } },
  },
];

describe('interactive effort adapter mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const testCase of cases) {
      testCase.client.mockResolvedValue({
        persona: 'interactive',
        status: 'done',
        content: 'ok',
        timestamp: new Date(),
      });
    }
  });

  it.each(cases)(
    'should map a free-form effort through the $name adapter and override configured effort',
    async ({ provider, client, optionName, configuredOptions }) => {
      const agent = provider().setup({ name: 'interactive' });

      await agent.call('prompt', {
        cwd: '/repo',
        effort: 'custom-effort',
        providerOptions: configuredOptions,
      });

      expect(client).toHaveBeenCalledTimes(1);
      expect(client.mock.calls[0]?.at(-1)).toEqual(expect.objectContaining({
        [optionName]: 'custom-effort',
      }));
    },
  );

  it.each(cases)(
    'should retain configured effort through the $name adapter without an interactive override',
    async ({ provider, client, optionName, configuredOptions }) => {
      const agent = provider().setup({ name: 'interactive' });

      await agent.call('prompt', {
        cwd: '/repo',
        providerOptions: configuredOptions,
      });

      expect(client).toHaveBeenCalledTimes(1);
      expect(client.mock.calls[0]?.at(-1)).toEqual(expect.objectContaining({
        [optionName]: 'low',
      }));
    },
  );
});
