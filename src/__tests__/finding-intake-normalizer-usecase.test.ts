import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';

const { runAgent } = vi.hoisted(() => ({
  runAgent: vi.fn(),
}));

vi.mock('../agents/runner.js', () => ({ runAgent }));

import { normalizeFindingIntake } from '../agents/finding-intake-normalizer-usecase.js';

describe('normalizeFindingIntake', () => {
  beforeEach(() => {
    runAgent.mockReset();
    runAgent.mockResolvedValue({
      persona: 'default',
      status: 'done',
      content: '{}',
      sessionId: 'discard-me',
      structuredOutput: { rawFindings: [] },
    });
  });

  it('uses one fresh read-only configured call with no tools, session, or MCP inheritance', async () => {
    await normalizeFindingIntake('normal Markdown report', {
      provider: 'codex',
      model: 'gpt-5.6-terra',
      providerOptions: {
        codex: { reasoningEffort: 'high' },
      },
    });

    expect(runAgent).toHaveBeenCalledOnce();
    const [persona, prompt, options] = runAgent.mock.calls[0]!;
    expect(persona).toBeUndefined();
    expect(prompt).toContain('normal Markdown report');
    expect(options).toMatchObject({
      executionProfile: 'isolated-structured',
      resolvedProvider: 'codex',
      resolvedModel: 'gpt-5.6-terra',
      resolvedProviderOptions: {
        codex: { reasoningEffort: 'high' },
      },
      permissionMode: 'readonly',
      allowedTools: [],
    });
    expect(options).not.toHaveProperty('childProcessEnv');
    expect(options.cwd).not.toBe('/repo');
    expect(options.cwd).toContain('takt-finding-intake-');
    expect(existsSync(options.cwd)).toBe(false);
    expect(options.sessionId).toBeUndefined();
    expect(options.mcpServers).toBeUndefined();
    expect(options.provider).toBeUndefined();
    expect(options.model).toBeUndefined();
    expect(options.outputSchema).toBeDefined();
  });

  it('explicitly suppresses project/global provider option fallback when none are configured', async () => {
    await normalizeFindingIntake('report', {
      provider: 'codex',
      model: 'gpt-5.6-terra',
    });

    expect(runAgent.mock.calls[0]?.[2]).toMatchObject({
      resolvedProviderOptions: null,
    });
  });

  it('uses the correction extractor with the same report and no prior output, ledger, or repository context', async () => {
    await normalizeFindingIntake('authoritative report', {
      provider: 'codex',
      model: 'gpt-5.6-terra',
      mode: 'correction',
    });

    const prompt = runAgent.mock.calls[0]?.[1];
    expect(prompt).toContain('previous extraction violated');
    expect(prompt).toContain('## Candidate report\n\nauthoritative report');
    expect(prompt.match(/authoritative report/g)).toHaveLength(1);
    expect(runAgent.mock.calls[0]?.[2]).toMatchObject({
      executionProfile: 'isolated-structured',
      permissionMode: 'readonly',
      allowedTools: [],
    });
  });

  it('removes the isolated working directory when the provider call throws', async () => {
    let isolatedCwd: string | undefined;
    runAgent.mockImplementationOnce(async (_persona, _prompt, options) => {
      isolatedCwd = options.cwd;
      throw new Error('provider failed');
    });

    await expect(normalizeFindingIntake('report', {
      provider: 'codex',
      model: 'gpt-5.6-terra',
    })).rejects.toThrow('provider failed');

    expect(isolatedCwd).toBeDefined();
    expect(existsSync(isolatedCwd!)).toBe(false);
  });
});
