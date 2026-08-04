/**
 * Provider layer structured output tests.
 *
 * Verifies native structured output providers pass `outputSchema` through
 * and providers without native support do not.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ===== Claude =====
const {
  mockCallClaude,
  mockCallClaudeCustom,
} = vi.hoisted(() => ({
  mockCallClaude: vi.fn(),
  mockCallClaudeCustom: vi.fn(),
}));

vi.mock('../infra/claude/client.js', () => ({
  callClaude: mockCallClaude,
  callClaudeCustom: mockCallClaudeCustom,
}));

// ===== Codex =====
const {
  mockCallCodex,
  mockCallCodexCustom,
  mockCallCodexIsolatedStructured,
} = vi.hoisted(() => ({
  mockCallCodex: vi.fn(),
  mockCallCodexCustom: vi.fn(),
  mockCallCodexIsolatedStructured: vi.fn(),
}));

vi.mock('../infra/codex/index.js', () => ({
  callCodex: mockCallCodex,
  callCodexCustom: mockCallCodexCustom,
  callCodexIsolatedStructured: mockCallCodexIsolatedStructured,
}));

// ===== OpenCode =====
const {
  mockCallOpenCode,
  mockCallOpenCodeCustom,
} = vi.hoisted(() => ({
  mockCallOpenCode: vi.fn(),
  mockCallOpenCodeCustom: vi.fn(),
}));

vi.mock('../infra/opencode/index.js', () => ({
  callOpenCode: mockCallOpenCode,
  callOpenCodeCustom: mockCallOpenCodeCustom,
}));

// ===== Mock =====
const {
  mockCallMock,
  mockCallMockCustom,
} = vi.hoisted(() => ({
  mockCallMock: vi.fn(),
  mockCallMockCustom: vi.fn(),
}));

vi.mock('../infra/mock/index.js', () => ({
  callMock: mockCallMock,
  callMockCustom: mockCallMockCustom,
}));

// ===== Config (API key resolvers + CLI path resolvers) =====
vi.mock('../infra/config/index.js', () => ({
  resolveAnthropicApiKey: vi.fn(() => undefined),
  resolveOpenaiApiKey: vi.fn(() => undefined),
  resolveCodexCliPath: vi.fn(() => '/opt/codex/bin/codex'),
  resolveClaudeCliPath: vi.fn(() => undefined),
  resolveOpencodeApiKey: vi.fn(() => undefined),
  loadProjectConfig: vi.fn(() => ({})),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/utils/index.js')>();
  return {
    ...actual,
    createLogger: vi.fn(() => mockLogger),
  };
});

// Codex の isInsideGitRepo をバイパス
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => 'true'),
}));

import { ClaudeProvider } from '../infra/providers/claude.js';
import { CodexProvider } from '../infra/providers/codex.js';
import { OpenCodeProvider } from '../infra/providers/opencode.js';
import { MockProvider } from '../infra/providers/mock.js';
import type { StepProviderOptions } from '../core/models/workflow-types.js';

const SCHEMA = {
  type: 'object',
  properties: { step: { type: 'integer' } },
  required: ['step'],
};

function doneResponse(persona: string, structuredOutput?: Record<string, unknown>) {
  return {
    persona,
    status: 'done' as const,
    content: 'ok',
    timestamp: new Date(),
    structuredOutput,
  };
}

// ---------- Claude ----------

describe('ClaudeProvider — structured output', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('supportsStructuredOutput is true', () => {
    const provider = new ClaudeProvider() as { supportsStructuredOutput?: boolean };
    expect(provider.supportsStructuredOutput).toBe(true);
  });

  it('outputSchema を callClaude に渡し structuredOutput を返す', async () => {
    mockCallClaude.mockResolvedValue(doneResponse('coder', { step: 2 }));

    const agent = new ClaudeProvider().setup({ name: 'coder' });
    const result = await agent.call('prompt', { cwd: '/tmp', outputSchema: SCHEMA });

    const opts = mockCallClaude.mock.calls[0]?.[2];
    expect(opts).toHaveProperty('outputSchema', SCHEMA);
    expect(result.structuredOutput).toEqual({ step: 2 });
  });

  it('provider_options.claude.effort を callClaude に渡す', async () => {
    mockCallClaude.mockResolvedValue(doneResponse('coder'));

    const agent = new ClaudeProvider().setup({ name: 'coder' });
    await agent.call('prompt', {
      cwd: '/tmp',
      providerOptions: { claude: { effort: 'medium' } },
    });

    const opts = mockCallClaude.mock.calls[0]?.[2];
    expect(opts).toHaveProperty('effort', 'medium');
  });

  it('provider_options.claude.baseUrl を callClaude に渡す', async () => {
    mockCallClaude.mockResolvedValue(doneResponse('coder'));
    const providerOptions = {
      claude: { baseUrl: 'http://127.0.0.1:8787' },
    } as unknown as StepProviderOptions;

    const agent = new ClaudeProvider().setup({ name: 'coder' });
    await agent.call('prompt', {
      cwd: '/tmp',
      providerOptions,
    });

    const opts = mockCallClaude.mock.calls[0]?.[2];
    expect(opts).toHaveProperty('baseUrl', 'http://127.0.0.1:8787');
  });

  it('provider_options.claude.skills.enabled を callClaude に渡す', async () => {
    mockCallClaude.mockResolvedValue(doneResponse('coder'));
    const providerOptions = {
      claude: { skills: { enabled: false } },
    } as unknown as StepProviderOptions;

    const agent = new ClaudeProvider().setup({ name: 'coder' });
    await agent.call('prompt', { cwd: '/tmp', providerOptions });

    const opts = mockCallClaude.mock.calls[0]?.[2];
    expect(opts).toHaveProperty('skillsEnabled', false);
  });

  it('systemPrompt 指定時も outputSchema が callClaudeCustom に渡される', async () => {
    mockCallClaudeCustom.mockResolvedValue(doneResponse('judge', { step: 1 }));

    const agent = new ClaudeProvider().setup({ name: 'judge', systemPrompt: 'You are a judge.' });
    const result = await agent.call('prompt', { cwd: '/tmp', outputSchema: SCHEMA });

    const opts = mockCallClaudeCustom.mock.calls[0]?.[3];
    expect(opts).toHaveProperty('outputSchema', SCHEMA);
    expect(result.structuredOutput).toEqual({ step: 1 });
  });

  it('strict read-only internal agent isolation を Claude SDK client に渡す', async () => {
    mockCallClaudeCustom.mockResolvedValue(doneResponse('selector', {}));

    const agent = new ClaudeProvider().setup({ name: 'selector', systemPrompt: 'Select reviewers.' });
    await agent.call('prompt', {
      cwd: '/tmp',
      internalAgentIsolation: 'strict-readonly',
      permissionMode: 'readonly',
      allowedTools: [],
      mcpServers: {},
    });

    expect(mockCallClaudeCustom.mock.calls[0]?.[3]).toMatchObject({
      internalAgentIsolation: 'strict-readonly',
      permissionMode: 'readonly',
      allowedTools: [],
      mcpServers: {},
    });
  });

  it('structuredOutput がない場合は undefined', async () => {
    mockCallClaude.mockResolvedValue(doneResponse('coder'));

    const agent = new ClaudeProvider().setup({ name: 'coder' });
    const result = await agent.call('prompt', { cwd: '/tmp', outputSchema: SCHEMA });

    expect(result.structuredOutput).toBeUndefined();
  });

  it('outputSchema 未指定時は undefined が渡される', async () => {
    mockCallClaude.mockResolvedValue(doneResponse('coder'));

    const agent = new ClaudeProvider().setup({ name: 'coder' });
    await agent.call('prompt', { cwd: '/tmp' });

    const opts = mockCallClaude.mock.calls[0]?.[2];
    expect(opts.outputSchema).toBeUndefined();
  });

  it('imageAttachments を callClaude に渡す', async () => {
    mockCallClaude.mockResolvedValue(doneResponse('coder'));
    const imageAttachments = [{ placeholder: '[Image #1]', path: '/tmp/image-1.png' }];

    const agent = new ClaudeProvider().setup({ name: 'coder' });
    await agent.call('prompt', { cwd: '/tmp', imageAttachments });

    const opts = mockCallClaude.mock.calls[0]?.[2];
    expect(opts).toHaveProperty('imageAttachments', imageAttachments);
  });

  it('childProcessEnv を callClaude に渡す', async () => {
    mockCallClaude.mockResolvedValue(doneResponse('coder'));
    const childProcessEnv = { TAKT_OBSERVABILITY: '{"enabled":true}' };

    const agent = new ClaudeProvider().setup({ name: 'coder' });
    await agent.call('prompt', { cwd: '/tmp', childProcessEnv });

    const opts = mockCallClaude.mock.calls[0]?.[2];
    expect(opts).toHaveProperty('childProcessEnv', childProcessEnv);
  });

  it('systemPrompt 指定時も childProcessEnv が callClaudeCustom に渡される', async () => {
    mockCallClaudeCustom.mockResolvedValue(doneResponse('judge'));
    const childProcessEnv = { TAKT_OBSERVABILITY: '{"enabled":true}' };

    const agent = new ClaudeProvider().setup({ name: 'judge', systemPrompt: 'sys' });
    await agent.call('prompt', { cwd: '/tmp', childProcessEnv });

    const opts = mockCallClaudeCustom.mock.calls[0]?.[3];
    expect(opts).toHaveProperty('childProcessEnv', childProcessEnv);
  });
});

// ---------- Codex ----------

describe('CodexProvider — structured output', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('supportsStructuredOutput is true', () => {
    const provider = new CodexProvider() as { supportsStructuredOutput?: boolean };
    expect(provider.supportsStructuredOutput).toBe(true);
  });

  it('outputSchema を callCodex に渡し structuredOutput を返す', async () => {
    mockCallCodex.mockResolvedValue(doneResponse('coder', { step: 2 }));

    const agent = new CodexProvider().setup({ name: 'coder' });
    const result = await agent.call('prompt', { cwd: '/tmp', outputSchema: SCHEMA });

    const opts = mockCallCodex.mock.calls[0]?.[2];
    expect(opts).toHaveProperty('outputSchema', SCHEMA);
    expect(opts).toHaveProperty('codexPathOverride', '/opt/codex/bin/codex');
    expect(result.structuredOutput).toEqual({ step: 2 });
  });

  it('profile未指定時は既存のCodex SDK経路を維持する', async () => {
    mockCallCodex.mockResolvedValue(doneResponse('coder', { step: 2 }));

    const agent = new CodexProvider().setup({ name: 'coder' });
    await agent.call('prompt', {
      cwd: '/tmp',
      outputSchema: SCHEMA,
    });

    expect(mockCallCodex).toHaveBeenCalledOnce();
    expect(mockCallCodexIsolatedStructured).not.toHaveBeenCalled();
  });

  it('isolated-structured profileだけをhardened direct CLI経路へ渡す', async () => {
    mockCallCodexIsolatedStructured.mockResolvedValue(
      doneResponse('normalizer', { rawFindings: [] }),
    );

    const agent = new CodexProvider().setup({
      name: 'normalizer',
      systemPrompt: 'system',
    });
    await agent.call('report', {
      cwd: '/tmp/isolated',
      executionProfile: 'isolated-structured',
      outputSchema: SCHEMA,
    });

    expect(mockCallCodexIsolatedStructured).toHaveBeenCalledWith(
      'normalizer',
      'system\n\nreport',
      expect.objectContaining({
        cwd: '/tmp/isolated',
        outputSchema: SCHEMA,
        codexPathOverride: '/opt/codex/bin/codex',
      }),
    );
    expect(mockCallCodex).not.toHaveBeenCalled();
    expect(mockCallCodexCustom).not.toHaveBeenCalled();
  });

  it('provider_options.codex.reasoningEffort を callCodex に渡す', async () => {
    mockCallCodex.mockResolvedValue(doneResponse('coder'));

    const agent = new CodexProvider().setup({ name: 'coder' });
    await agent.call('prompt', {
      cwd: '/tmp',
      providerOptions: { codex: { reasoningEffort: 'high' } },
    });

    const opts = mockCallCodex.mock.calls[0]?.[2];
    expect(opts).toHaveProperty('reasoningEffort', 'high');
  });

  it('provider_options.codex.baseUrl を callCodex に渡す', async () => {
    mockCallCodex.mockResolvedValue(doneResponse('coder'));
    const providerOptions = {
      codex: { baseUrl: 'http://127.0.0.1:8787/v1' },
    } as unknown as StepProviderOptions;

    const agent = new CodexProvider().setup({ name: 'coder' });
    await agent.call('prompt', {
      cwd: '/tmp',
      providerOptions,
    });

    const opts = mockCallCodex.mock.calls[0]?.[2];
    expect(opts).toHaveProperty('baseUrl', 'http://127.0.0.1:8787/v1');
  });

  it('provider_options.codex.skills を callCodex に渡す', async () => {
    mockCallCodex.mockResolvedValue(doneResponse('coder'));

    const agent = new CodexProvider().setup({ name: 'coder' });
    await agent.call('prompt', {
      cwd: '/tmp',
      providerOptions: {
        codex: { skills: { repo: true, user: false } },
      },
    });

    const opts = mockCallCodex.mock.calls[0]?.[2];
    expect(opts).toHaveProperty('skills', { repo: true, user: false });
  });

  it('provider_options.codex.skills の未指定値を false として callCodex に渡す', async () => {
    mockCallCodex.mockResolvedValue(doneResponse('coder'));

    const agent = new CodexProvider().setup({ name: 'coder' });
    await agent.call('prompt', { cwd: '/tmp' });

    const opts = mockCallCodex.mock.calls[0]?.[2];
    expect(opts).toHaveProperty('skills', { repo: false, user: false });
  });

  it('strict read-only internal agent isolation を Codex client に渡す', async () => {
    mockCallCodexCustom.mockResolvedValue(doneResponse('selector', {}));

    const agent = new CodexProvider().setup({ name: 'selector', systemPrompt: 'Select reviewers.' });
    await agent.call('prompt', {
      cwd: '/tmp',
      internalAgentIsolation: 'strict-readonly',
      permissionMode: 'readonly',
      allowedTools: [],
      mcpServers: {},
      outputSchema: SCHEMA,
      providerOptions: {
        codex: {
          networkAccess: false,
          skills: { repo: true, user: false },
        },
      },
    });

    expect(mockCallCodexCustom.mock.calls[0]?.[3]).toMatchObject({
      internalAgentIsolation: 'strict-readonly',
      permissionMode: 'readonly',
      outputSchema: SCHEMA,
      networkAccess: false,
      skills: { repo: true, user: false },
    });
  });

  it('childProcessEnv を callCodex に渡す', async () => {
    mockCallCodex.mockResolvedValue(doneResponse('coder'));
    const childProcessEnv = { TAKT_OBSERVABILITY: '{"enabled":true}' };

    const agent = new CodexProvider().setup({ name: 'coder' });
    await agent.call('prompt', {
      cwd: '/tmp',
      childProcessEnv,
    });

    const opts = mockCallCodex.mock.calls[0]?.[2];
    expect(opts).toHaveProperty('childProcessEnv', childProcessEnv);
  });

  it('systemPrompt 指定時も outputSchema が callCodexCustom に渡される', async () => {
    mockCallCodexCustom.mockResolvedValue(doneResponse('judge', { step: 1 }));

    const agent = new CodexProvider().setup({ name: 'judge', systemPrompt: 'sys' });
    const result = await agent.call('prompt', { cwd: '/tmp', outputSchema: SCHEMA });

    const opts = mockCallCodexCustom.mock.calls[0]?.[3];
    expect(opts).toHaveProperty('outputSchema', SCHEMA);
    expect(result.structuredOutput).toEqual({ step: 1 });
  });

  it('structuredOutput がない場合は undefined', async () => {
    mockCallCodex.mockResolvedValue(doneResponse('coder'));

    const agent = new CodexProvider().setup({ name: 'coder' });
    const result = await agent.call('prompt', { cwd: '/tmp', outputSchema: SCHEMA });

    expect(result.structuredOutput).toBeUndefined();
  });

  it('outputSchema 未指定時は undefined が渡される', async () => {
    mockCallCodex.mockResolvedValue(doneResponse('coder'));

    const agent = new CodexProvider().setup({ name: 'coder' });
    await agent.call('prompt', { cwd: '/tmp' });

    const opts = mockCallCodex.mock.calls[0]?.[2];
    expect(opts.outputSchema).toBeUndefined();
  });
});

// ---------- OpenCode ----------

describe('OpenCodeProvider — structured output', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('supportsStructuredOutput is true', () => {
    const provider = new OpenCodeProvider() as { supportsStructuredOutput?: boolean };
    expect(provider.supportsStructuredOutput).toBe(true);
  });

  it('outputSchema を callOpenCode に渡す', async () => {
    mockCallOpenCode.mockResolvedValue(doneResponse('coder'));

    const agent = new OpenCodeProvider().setup({ name: 'coder' });
    await agent.call('prompt', {
      cwd: '/tmp',
      model: 'openai/gpt-4',
      outputSchema: SCHEMA,
    });

    const opts = mockCallOpenCode.mock.calls[0]?.[2];
    expect(opts).toHaveProperty('outputSchema', SCHEMA);
  });

  it('provider_options.opencode.variant を callOpenCode に渡す', async () => {
    mockCallOpenCode.mockResolvedValue(doneResponse('coder'));

    const agent = new OpenCodeProvider().setup({ name: 'coder' });
    await agent.call('prompt', {
      cwd: '/tmp',
      model: 'openai/gpt-5',
      providerOptions: {
        opencode: {
          networkAccess: true,
          variant: 'high',
        },
      },
    });

    const opts = mockCallOpenCode.mock.calls[0]?.[2];
    expect(opts).toMatchObject({
      networkAccess: true,
      variant: 'high',
    });
  });

  it('systemPrompt 指定時も outputSchema を callOpenCodeCustom に渡す', async () => {
    mockCallOpenCodeCustom.mockResolvedValue(doneResponse('judge'));

    const agent = new OpenCodeProvider().setup({ name: 'judge', systemPrompt: 'sys' });
    await agent.call('prompt', {
      cwd: '/tmp',
      model: 'openai/gpt-4',
      outputSchema: SCHEMA,
    });

    const opts = mockCallOpenCodeCustom.mock.calls[0]?.[3];
    expect(opts).toHaveProperty('outputSchema', SCHEMA);
  });

  it('structuredOutput がない場合は undefined', async () => {
    mockCallOpenCode.mockResolvedValue(doneResponse('coder'));

    const agent = new OpenCodeProvider().setup({ name: 'coder' });
    const result = await agent.call('prompt', {
      cwd: '/tmp',
      model: 'openai/gpt-4',
      outputSchema: SCHEMA,
    });

    expect(result.structuredOutput).toBeUndefined();
  });

  it('outputSchema 未指定時は undefined が渡される', async () => {
    mockCallOpenCode.mockResolvedValue(doneResponse('coder'));

    const agent = new OpenCodeProvider().setup({ name: 'coder' });
    await agent.call('prompt', { cwd: '/tmp', model: 'openai/gpt-4' });

    const opts = mockCallOpenCode.mock.calls[0]?.[2];
    expect(opts.outputSchema).toBeUndefined();
  });

  it('childProcessEnv を callOpenCodeCustom に渡す', async () => {
    mockCallOpenCodeCustom.mockResolvedValue(doneResponse('coder'));
    const childProcessEnv = { TAKT_OBSERVABILITY: '{"enabled":true}' };

    const agent = new OpenCodeProvider().setup({ name: 'coder', systemPrompt: 'system' });
    await agent.call('prompt', {
      cwd: '/tmp',
      model: 'openai/gpt-4',
      childProcessEnv,
    });

    const opts = mockCallOpenCodeCustom.mock.calls[0]?.[3];
    expect(opts).toHaveProperty('childProcessEnv', childProcessEnv);
  });

  it('imageAttachments を callOpenCode に渡さず非空時だけログする', async () => {
    mockCallOpenCode.mockResolvedValue(doneResponse('coder'));

    const agent = new OpenCodeProvider().setup({ name: 'coder' });
    await agent.call('prompt', {
      cwd: '/tmp',
      model: 'openai/gpt-4',
      imageAttachments: [{ placeholder: '[Image #1]', path: '/tmp/image-1.png' }],
    });

    const opts = mockCallOpenCode.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(opts.imageAttachments).toBeUndefined();
    expect(mockLogger.info).toHaveBeenCalledWith('OpenCode provider does not support imageAttachments; ignoring');

    mockLogger.info.mockClear();
    await agent.call('prompt', { cwd: '/tmp', model: 'openai/gpt-4', imageAttachments: [] });
    await agent.call('prompt', { cwd: '/tmp', model: 'openai/gpt-4' });

    expect(mockLogger.info).not.toHaveBeenCalledWith('OpenCode provider does not support imageAttachments; ignoring');
  });
});

// ---------- Mock ----------

describe('MockProvider — structured output', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('supportsStructuredOutput is true', () => {
    const provider = new MockProvider() as { supportsStructuredOutput?: boolean };
    expect(provider.supportsStructuredOutput).toBe(true);
  });

  it('passes allowedTools through to the mock client', async () => {
    mockCallMock.mockResolvedValue(doneResponse('coder'));

    const agent = new MockProvider().setup({ name: 'coder' });
    await agent.call('prompt', {
      cwd: '/tmp',
      allowedTools: ['Read', 'Edit'],
      outputSchema: SCHEMA,
    });

    const opts = mockCallMock.mock.calls[0]?.[2];
    expect(opts).toMatchObject({
      allowedTools: ['Read', 'Edit'],
    });
  });

  it('imageAttachments を callMock に渡さず非空時だけログする', async () => {
    mockCallMock.mockResolvedValue(doneResponse('coder'));

    const agent = new MockProvider().setup({ name: 'coder' });
    await agent.call('prompt', {
      cwd: '/tmp',
      imageAttachments: [{ placeholder: '[Image #1]', path: '/tmp/image-1.png' }],
    });

    const opts = mockCallMock.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(opts.imageAttachments).toBeUndefined();
    expect(mockLogger.info).toHaveBeenCalledWith('Mock provider does not support imageAttachments; ignoring');

    mockLogger.info.mockClear();
    await agent.call('prompt', { cwd: '/tmp', imageAttachments: [] });
    await agent.call('prompt', { cwd: '/tmp' });

    expect(mockLogger.info).not.toHaveBeenCalledWith('Mock provider does not support imageAttachments; ignoring');
  });
});

describe('ClaudeProvider abortSignal wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCallClaude.mockResolvedValue(doneResponse('coder'));
  });

  it('ProviderCallOptions.abortSignal を Claude call options に渡す', async () => {
    const provider = new ClaudeProvider();
    const agent = provider.setup({ name: 'coder' });
    const controller = new AbortController();

    await agent.call('test prompt', {
      cwd: '/tmp/project',
      abortSignal: controller.signal,
    });

    expect(mockCallClaude).toHaveBeenCalledTimes(1);
    const callOptions = mockCallClaude.mock.calls[0]?.[2];
    expect(callOptions).toHaveProperty('abortSignal', controller.signal);
  });
});
