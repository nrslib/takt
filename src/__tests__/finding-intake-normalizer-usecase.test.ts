import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';

const { setupIsolatedStructured, getProvider } = vi.hoisted(() => ({
  setupIsolatedStructured: vi.fn(),
  getProvider: vi.fn(),
}));

vi.mock('../infra/providers/index.js', () => ({ getProvider }));

import { normalizeFindingIntake } from '../agents/finding-intake-normalizer-usecase.js';

describe('normalizeFindingIntake', () => {
  beforeEach(() => {
    setupIsolatedStructured.mockReset();
    getProvider.mockReset();
    setupIsolatedStructured.mockReturnValue({
      call: vi.fn().mockResolvedValue({
        persona: 'default',
        status: 'done',
        content: '{}',
        sessionId: 'discard-me',
        structuredOutput: { rawFindings: [] },
      }),
    });
    getProvider.mockReturnValue({ setupIsolatedStructured });
  });

  it('uses one fresh read-only configured call with no tools, session, or MCP inheritance', async () => {
    await normalizeFindingIntake('normal Markdown report', {
      provider: 'codex',
      model: 'gpt-5.6-terra',
      failureDir: '/tmp/failures',
      providerOptions: {
        codex: { reasoningEffort: 'high' },
      },
    });

    expect(getProvider).toHaveBeenCalledWith('codex');
    expect(setupIsolatedStructured).toHaveBeenCalledOnce();
    const [setupConfig] = setupIsolatedStructured.mock.calls[0]!;
    expect(setupConfig).toMatchObject({
      name: 'finding-intake-normalizer',
      systemPrompt: '',
    });
  });

  it('passes provider options through to the isolated call', async () => {
    await normalizeFindingIntake('report', {
      provider: 'codex',
      model: 'gpt-5.6-terra',
      failureDir: '/tmp/failures',
      providerOptions: {
        codex: { reasoningEffort: 'high' },
      },
    });

    const callFn = setupIsolatedStructured.mock.results[0]!.value.call;
    const [prompt, options] = callFn.mock.calls[0]!;
    expect(prompt).toContain('report');
    expect(options).toMatchObject({
      model: 'gpt-5.6-terra',
      permissionMode: 'readonly',
      allowedTools: [],
      providerOptions: {
        codex: { reasoningEffort: 'high' },
      },
      failureDir: '/tmp/failures',
    });
    expect(options).not.toHaveProperty('childProcessEnv');
    expect(options.cwd).toContain('takt-finding-intake-');
    expect(existsSync(options.cwd)).toBe(false);
    expect(options.sessionId).toBeUndefined();
    expect(options.mcpServers).toBeUndefined();
    expect(options.outputSchema).toBeDefined();
  });

  it('uses the correction extractor with the same report and no prior output, ledger, or repository context', async () => {
    await normalizeFindingIntake('authoritative report', {
      provider: 'codex',
      model: 'gpt-5.6-terra',
      failureDir: '/tmp/failures',
      mode: 'correction',
    });

    const callFn = setupIsolatedStructured.mock.results[0]!.value.call;
    const [prompt] = callFn.mock.calls[0]!;
    expect(prompt).toContain('previous extraction failed');
    expect(prompt).toContain('## Review report\n\nauthoritative report');
    expect(prompt.match(/authoritative report/g)).toHaveLength(1);
    const [, options] = callFn.mock.calls[0]!;
    expect(options).toMatchObject({
      permissionMode: 'readonly',
      allowedTools: [],
    });

    await normalizeFindingIntake('extraction-fidelity report', {
      provider: 'codex',
      model: 'gpt-5.6-terra',
      failureDir: '/tmp/failures',
      mode: 'correction',
      extractionFidelityCorrection: true,
    });
    // setupIsolatedStructured は beforeEach で同じ agent を返すため、2回目の呼び出しは
    // 同じ call モックの calls[1] に入る。
    const secondCallFn = setupIsolatedStructured.mock.results[1]!.value.call;
    const [secondPrompt] = secondCallFn.mock.calls[1]!;
    expect(secondPrompt).toContain(
      'this exception overrides rule 3 for the candidate itself',
    );
    expect(secondPrompt).toContain('`candidate: null` and a candidate missing any required field are both');
    // 入れ子 {{#if}} は未対応なので、条件分岐は兄弟条件として展開される。
    expect(secondPrompt).not.toContain('{{#if');
    expect(prompt).not.toContain('extraction-fidelity case only');
  });

  it('removes the isolated working directory when the provider call throws', async () => {
    let isolatedCwd: string | undefined;
    setupIsolatedStructured.mockReturnValueOnce({
      call: vi.fn(async (_prompt: string, options: { cwd: string }) => {
        isolatedCwd = options.cwd;
        throw new Error('provider failed');
      }),
    });

    await expect(normalizeFindingIntake('report', {
      provider: 'codex',
      model: 'gpt-5.6-terra',
      failureDir: '/tmp/failures',
    })).rejects.toThrow('provider failed');

    expect(isolatedCwd).toBeDefined();
    expect(existsSync(isolatedCwd!)).toBe(false);
  });
});
