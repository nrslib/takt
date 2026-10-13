import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { toManagerOutputSchema } from '../features/manager/outputSchema.js';
import { makeProvider } from './test-helpers.js';
import type { ProviderAgent } from '../infra/providers/types.js';

vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: vi.fn(async () => {}) }));
afterEach(() => { vi.restoreAllMocks(); vi.doUnmock('zod'); });

describe('manager provider output schema', () => {
  it('omits the schema declaration while retaining response constraints', () => {
    const schema = toManagerOutputSchema(z.object({ message: z.string().min(1), summary: z.null() }).strict());
    expect(schema).not.toHaveProperty('$schema');
    expect(schema).toMatchObject({
      type: 'object', additionalProperties: false, required: ['message', 'summary'],
      properties: { message: { type: 'string', minLength: 1 }, summary: { type: 'null' } },
    });
  });

  it('emits draft-07 tuple items instead of draft 2020-12 prefixItems', () => {
    const schema = toManagerOutputSchema(z.tuple([z.string(), z.number()]));
    expect(schema).toMatchObject({ type: 'array', items: [{ type: 'string' }, { type: 'number' }] });
    expect(schema).not.toHaveProperty('prefixItems');
    expect(schema).not.toHaveProperty('$schema');
  });

  it.each([
    { type: 'object', properties: { message: { type: 'string' }, summary: { type: 'null' } }, required: ['message'], additionalProperties: false },
    { type: 'object', properties: { message: { type: 'string', minLength: 1 }, summary: { type: 'null' } }, required: ['message', 'summary'], additionalProperties: false },
  ])('rejects a non-strict generated Codex schema before calling the provider: %j', async (invalidSchema) => {
    vi.resetModules();
    const { StructuredOutputSchemaError } = await import('../core/workflow/engine/structured-output-schema-validator.js');
    // 変換ライブラリの出力が退行しても、本番の送信前検証で止まることを確認する。
    const conversion = vi.fn(() => invalidSchema);
    vi.doMock('zod', async () => {
      const actual = await vi.importActual<typeof import('zod')>('zod');
      return { ...actual, z: { ...actual.z, toJSONSchema: conversion } };
    });
    const call = vi.fn<ProviderAgent['call']>().mockResolvedValue({
      persona: 'manager', status: 'done', timestamp: new Date(),
      content: JSON.stringify({ message: '相談', summary: null }), structuredOutput: { message: '相談', summary: null },
    });
    let result: { kind: string; message: string } | undefined;
    let failure: unknown;
    try {
      const { createManagerConversationSession } = await import('../features/manager/conversationSession.js');
      const { createGoalConfirmation } = await import('../features/manager/goalConfirmation.js');
      const session = createManagerConversationSession({
        cwd: '/test/manager-repository',
        plan: { ctx: { providerType: 'codex', lang: 'ja', model: undefined,
          provider: makeProvider({ supportsStructuredOutput: true, setup: () => ({ call }) }) },
        strategy: { systemPrompt: 'manager fixture', allowedTools: ['Read'] } },
        confirmation: createGoalConfirmation('/test/manager-repository'), mcpClient: { callTool: vi.fn() },
      });
      try { result = await session.handleUserMessage({ text: '相談' }); }
      finally { await session.close(); }
    } catch (error) { failure = error; }
    expect(conversion).toHaveBeenCalled();
    if (failure !== undefined) expect(failure).toBeInstanceOf(StructuredOutputSchemaError);
    else expect(result).toMatchObject({ kind: 'error' });
    expect(call).not.toHaveBeenCalled();
  });
});
