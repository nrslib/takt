import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentResponse } from '../core/models/index.js';
import type { AgentSetup, Provider, ProviderCallOptions } from '../infra/providers/types.js';

const {
  mockGetProvider,
  mockGetWorkflowDescription,
  mockResolveAssistantProviderModel,
  mockResolveConfigValues,
  mockResolveNonWorkflowProviderModel,
  mockResolveNonWorkflowProviderOptions,
} = vi.hoisted(() => ({
  mockGetProvider: vi.fn(),
  mockGetWorkflowDescription: vi.fn(),
  mockResolveAssistantProviderModel: vi.fn(),
  mockResolveConfigValues: vi.fn(),
  mockResolveNonWorkflowProviderModel: vi.fn(),
  mockResolveNonWorkflowProviderOptions: vi.fn(),
}));

vi.mock('../infra/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/config/index.js')>()),
  getWorkflowDescription: (...args: unknown[]) => mockGetWorkflowDescription(...args),
  resolveConfigValues: (...args: unknown[]) => mockResolveConfigValues(...args),
  resolveNonWorkflowProviderModel: (...args: unknown[]) => mockResolveNonWorkflowProviderModel(...args),
  resolveNonWorkflowProviderOptions: (...args: unknown[]) => mockResolveNonWorkflowProviderOptions(...args),
}));

vi.mock('../features/interactive/assistantConfig.js', () => ({
  resolveAssistantProviderModel: (...args: unknown[]) => mockResolveAssistantProviderModel(...args),
}));

vi.mock('../infra/providers/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/providers/index.js')>()),
  getProvider: (...args: unknown[]) => mockGetProvider(...args),
}));

vi.mock('../features/interactive/assistantInitFiles.js', () => ({
  loadAssistantInitContext: vi.fn(() => undefined),
}));

vi.mock('../features/interactive/taskInstructionFormat.js', () => ({
  resolveFormalSpecConfigurationWithoutPrompt: vi.fn(() => ({ mode: false, comments: true })),
}));

import { createWebChatService } from '../features/web-ui/chat.js';

const projectDirectory = '/web-chat-test';

function createProvider(call: ProviderAgentCall): { provider: Provider; setup: ReturnType<typeof vi.fn> } {
  const setup = vi.fn((_config: AgentSetup) => ({ call }));
  return {
    provider: {
      supportsStructuredOutput: true,
      supportsNativeImageInput: false,
      supportedMcpTransports: new Set(),
      getRuntimeInstructions: vi.fn(() => null),
      keepsAllowedToolWithoutEdit: vi.fn(() => false),
      setup,
    },
    setup,
  };
}

type ProviderAgentCall = (prompt: string, options: ProviderCallOptions) => Promise<AgentResponse>;

function workflowDescription(includeFirstStep: boolean) {
  const description = {
    name: 'default',
    description: 'A test workflow',
    workflowStructure: '1. plan',
    stepPreviews: [],
  };
  return includeFirstStep
    ? {
        ...description,
        firstStep: {
          personaContent: 'Review the task.',
          personaDisplayName: 'Reviewer',
          allowedTools: ['Read'],
        },
      }
    : description;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetWorkflowDescription.mockImplementation(() => workflowDescription(true));
  mockResolveAssistantProviderModel.mockReturnValue({
    runtimeManaged: false,
    provider: 'mock',
    model: 'web-test-model',
  });
  mockResolveConfigValues.mockReturnValue({ language: 'en' });
  mockResolveNonWorkflowProviderModel.mockReturnValue({
    runtimeManaged: false,
    provider: 'mock',
    model: 'web-test-model',
  });
  mockResolveNonWorkflowProviderOptions.mockReturnValue(undefined);
});

describe('Web UI chat tell capability', () => {
  it.each(['assistant', 'grill-me', 'persona'] as const)(
    'treats /tell as a regular message without changing /go in %s mode',
    async (mode) => {
      let callCount = 0;
      const providerCall = vi.fn<ProviderAgentCall>(async (_prompt) => ({
        persona: 'web-chat-test',
        status: 'done',
        content: ++callCount === 1 ? 'assistant response' : 'generated instruction',
        timestamp: new Date(),
      }));
      const { provider, setup } = createProvider(providerCall);
      mockGetProvider.mockReturnValue(provider);

      const service = createWebChatService();
      const created = service.create(projectDirectory, { workflow: 'default', mode });

      expect(created.intro).not.toContain('/tell');
      await expect(service.send(created.id, '/tell keep this task in scope')).resolves.toEqual({
        kind: 'assistant_response',
        content: 'assistant response',
      });
      expect(providerCall).toHaveBeenCalledOnce();
      expect(providerCall.mock.calls[0]?.[0]).toContain('/tell keep this task in scope');
      expect(setup.mock.calls[0]?.[0].systemPrompt).not.toContain('/tell');

      await expect(service.send(created.id, '/go create a new task')).resolves.toEqual({
        kind: 'task_instruction',
        task: 'generated instruction',
      });
      expect(providerCall).toHaveBeenCalledTimes(2);
    },
  );

  it('uses the assistant plan when persona has no first step', async () => {
    mockGetWorkflowDescription.mockImplementation(() => workflowDescription(false));
    const providerCall = vi.fn<ProviderAgentCall>(async (_prompt) => ({
      persona: 'web-chat-test',
      status: 'done',
      content: 'assistant response',
      timestamp: new Date(),
    }));
    const { provider, setup } = createProvider(providerCall);
    mockGetProvider.mockReturnValue(provider);

    const service = createWebChatService();
    const created = service.create(projectDirectory, { workflow: 'default', mode: 'persona' });

    expect(created.intro).not.toContain('/tell');
    await expect(service.send(created.id, '/tell keep this task in scope')).resolves.toEqual({
      kind: 'assistant_response',
      content: 'assistant response',
    });
    await expect(service.send(created.id, '/go create a new task')).resolves.toEqual({
      kind: 'task_instruction',
      task: 'assistant response',
    });
    expect(providerCall).toHaveBeenCalledTimes(2);
    expect(providerCall.mock.calls[0]?.[0]).toContain('/tell keep this task in scope');
    expect(setup.mock.calls[0]?.[0].systemPrompt).not.toContain('/tell');
  });

  it.each([
    ['assistant', true],
    ['grill-me', true],
    ['persona', true],
    ['persona', false],
  ] as const)(
    'keeps tell disabled through %s create, reconfigure, and restart (%s first step)',
    async (mode, includeFirstStep) => {
      mockGetWorkflowDescription.mockImplementation(() => workflowDescription(includeFirstStep));
      const providerCall = vi.fn<ProviderAgentCall>(async () => ({
        persona: 'web-chat-test',
        status: 'done',
        content: 'assistant response',
        timestamp: new Date(),
      }));
      const { provider, setup } = createProvider(providerCall);
      mockGetProvider.mockReturnValue(provider);

      const service = createWebChatService();
      const created = service.create(projectDirectory, { workflow: 'default', mode });
      await expect(service.send(created.id, '/tell during create')).resolves.toEqual({
        kind: 'assistant_response',
        content: 'assistant response',
      });

      const reconfigured = service.reconfigure(created.id, { workflow: 'changed', mode });
      await expect(service.send(reconfigured.id, '/tell during reconfigure')).resolves.toEqual({
        kind: 'assistant_response',
        content: 'assistant response',
      });

      const restarted = service.restart(created.id);
      await expect(service.send(restarted.id, '/tell during restart')).resolves.toEqual({
        kind: 'assistant_response',
        content: 'assistant response',
      });

      expect(created.intro).not.toContain('/tell');
      expect(reconfigured.intro).not.toContain('/tell');
      expect(restarted.intro).not.toContain('/tell');
      expect(providerCall).toHaveBeenCalledTimes(3);
      expect(providerCall.mock.calls.map(([prompt]) => prompt)).toEqual([
        expect.stringContaining('/tell during create'),
        expect.stringContaining('/tell during reconfigure'),
        expect.stringContaining('/tell during restart'),
      ]);
      expect(setup).toHaveBeenCalledTimes(3);
      for (const [config] of setup.mock.calls) expect(config.systemPrompt).not.toContain('/tell');
    },
  );
});
