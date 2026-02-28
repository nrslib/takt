/**
 * Provider layer structured output tests.
 *
 * Verifies that each provider (Claude, Codex, OpenCode) correctly passes
 * `outputSchema` through to its underlying client function and returns
 * `structuredOutput` in the AgentResponse.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  callClaudeAgent: vi.fn(),
  callClaudeSkill: vi.fn(),
}));

// ===== Codex =====
const {
  mockCallCodex,
  mockCallCodexCustom,
} = vi.hoisted(() => ({
  mockCallCodex: vi.fn(),
  mockCallCodexCustom: vi.fn(),
}));

vi.mock('../infra/codex/index.js', () => ({
  callCodex: mockCallCodex,
  callCodexCustom: mockCallCodexCustom,
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

// ===== Config (API key resolvers + CLI path resolvers) =====
vi.mock('../infra/config/index.js', () => ({
  resolveAnthropicApiKey: vi.fn(() => undefined),
  resolveOpenaiApiKey: vi.fn(() => undefined),
  resolveCodexCliPath: vi.fn(() => '/opt/codex/bin/codex'),
  resolveClaudeCliPath: vi.fn(() => undefined),
  resolveOpencodeApiKey: vi.fn(() => undefined),
  loadProjectConfig: vi.fn(() => ({})),
}));

// Codex の isInsideGitRepo をバイパス
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => 'true'),
}));

import { ClaudeProvider } from '../infra/providers/claude.js';
import { CodexProvider } from '../infra/providers/codex.js';
import { OpenCodeProvider } from '../infra/providers/opencode.js';

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

  it('outputSchema を callClaude に渡し structuredOutput を返す', async () => {
    mockCallClaude.mockResolvedValue(doneResponse('coder', { step: 2 }));

    const agent = new ClaudeProvider().setup({ name: 'coder' });
    const result = await agent.call('prompt', { cwd: '/tmp', outputSchema: SCHEMA });

    const opts = mockCallClaude.mock.calls[0]?.[2];
    expect(opts).toHaveProperty('outputSchema', SCHEMA);
    expect(result.structuredOutput).toEqual({ step: 2 });
  });

  it('systemPrompt 指定時も outputSchema が callClaudeCustom に渡される', async () => {
    mockCallClaudeCustom.mockResolvedValue(doneResponse('judge', { step: 1 }));

    const agent = new ClaudeProvider().setup({ name: 'judge', systemPrompt: 'You are a judge.' });
    const result = await agent.call('prompt', { cwd: '/tmp', outputSchema: SCHEMA });

    const opts = mockCallClaudeCustom.mock.calls[0]?.[3];
    expect(opts).toHaveProperty('outputSchema', SCHEMA);
    expect(result.structuredOutput).toEqual({ step: 1 });
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
});

// ---------- Codex ----------

describe('CodexProvider — structured output', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('outputSchema を callOpenCode に渡し structuredOutput を返す', async () => {
    mockCallOpenCode.mockResolvedValue(doneResponse('coder', { step: 2 }));

    const agent = new OpenCodeProvider().setup({ name: 'coder' });
    const result = await agent.call('prompt', {
      cwd: '/tmp',
      model: 'openai/gpt-4',
      outputSchema: SCHEMA,
    });

    const opts = mockCallOpenCode.mock.calls[0]?.[2];
    expect(opts).toHaveProperty('outputSchema', SCHEMA);
    expect(result.structuredOutput).toEqual({ step: 2 });
  });

  it('systemPrompt 指定時も outputSchema が callOpenCodeCustom に渡される', async () => {
    mockCallOpenCodeCustom.mockResolvedValue(doneResponse('judge', { step: 1 }));

    const agent = new OpenCodeProvider().setup({ name: 'judge', systemPrompt: 'sys' });
    const result = await agent.call('prompt', {
      cwd: '/tmp',
      model: 'openai/gpt-4',
      outputSchema: SCHEMA,
    });

    const opts = mockCallOpenCodeCustom.mock.calls[0]?.[3];
    expect(opts).toHaveProperty('outputSchema', SCHEMA);
    expect(result.structuredOutput).toEqual({ step: 1 });
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
});
