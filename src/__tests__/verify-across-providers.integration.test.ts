import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderAgent } from '../infra/providers/types.js';
import type { FormalSpecVerificationResult } from '../features/interactive/formalSpecVerifier.js';
import { createConversationSession } from '../features/interactive/conversationSession.js';
import { makeProvider, makeSessionContext } from './test-helpers.js';

const { verify, cleanup } = vi.hoisted(() => ({
  verify: vi.fn<typeof import('../features/interactive/formalSpecVerification.js').runFormalSpecVerification>(),
  cleanup: vi.fn(),
}));

vi.mock('../features/interactive/formalSpecVerification.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../features/interactive/formalSpecVerification.js')>(),
  runFormalSpecVerification: verify,
  cleanupFormalSpecVerificationArtifacts: cleanup,
}));

const generated = '```quint\nmodule current {}\n```\n~~~alloy\nrun {} for 3\n~~~';
const interpreted = 'Both specifications passed verification.';

function verificationResult(): FormalSpecVerificationResult {
  return {
    verdict: 'passed',
    verificationStarted: true,
    quint: { status: 'passed' },
    alloy: { status: 'passed' },
    artifacts: {
      runDirectory: '/repo/.takt/runs/verify-current',
      specifications: {
        quint: '/repo/.takt/runs/verify-current/specs/spec.qnt',
        alloy: '/repo/.takt/runs/verify-current/specs/spec.als',
      },
      logs: {},
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  verify.mockResolvedValue(verificationResult());
});

describe('/verify through the conversation session and AI caller', () => {
  it.each([
    'codex', 'claude', 'claude-headless',
    'claude-terminal', 'cursor', 'copilot', 'kiro',
  ] as const)('returns generated specifications followed by interpretation for %s', async (providerType) => {
    const call = vi.fn<ProviderAgent['call']>()
      .mockResolvedValueOnce({
        persona: 'interactive', status: 'done', content: generated,
        sessionId: 'generation-session', timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'interactive', status: 'done', content: interpreted,
        sessionId: 'interpretation-session', timestamp: new Date(),
      });
    const setup = vi.fn(() => ({ call }));
    const session = createConversationSession({
      cwd: '/repo',
      outputMode: 'silent',
      persistSession: false,
      formalSpec: true,
      modelCheckTimeoutSeconds: 300,
      ctx: makeSessionContext({
        provider: makeProvider({ setup }), providerType, sessionId: 'conversation-session',
        permissionMode: 'full',
        mcpServers: { untrusted: { type: 'stdio', command: 'must-not-start' } },
      }),
      strategy: {
        systemPrompt: 'formal conversation', allowedTools: ['Read'],
        modelCheckTimeoutSeconds: 300, transformPrompt: (message) => message,
      },
    });

    const result = await session.handleUserMessage({ text: '/verify' });

    expect(result).toEqual({
      kind: 'assistant_response', content: `${generated}\n\n${interpreted}`,
      sessionId: 'interpretation-session',
    });
    expect(setup).toHaveBeenCalledTimes(2);
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[0]![1]).toMatchObject({
      sessionId: 'conversation-session',
      permissionMode: 'readonly', internalAgentIsolation: 'strict-readonly',
    });
    expect(verify).toHaveBeenCalledExactlyOnceWith(generated, '/repo', {
      abortSignal: undefined, modelCheckTimeoutSeconds: 300,
    });
    const [interpretationPrompt, options] = call.mock.calls[1]!;
    expect(interpretationPrompt).toContain(generated);
    const resultJson = interpretationPrompt.split('<verification-result>\n')[1]!.split('\n</verification-result>')[0]!;
    expect(JSON.parse(resultJson)).toEqual(verificationResult());
    expect(options).toMatchObject({
      sessionId: 'generation-session',
      permissionMode: 'readonly', internalAgentIsolation: 'strict-readonly',
      allowReadonlyFileRead: true,
      readonlyFileReadPaths: [
        '/repo/.takt/runs/verify-current/specs/spec.qnt',
        '/repo/.takt/runs/verify-current/specs/spec.als',
      ],
    });
    for (const [, callOptions] of call.mock.calls) {
      expect(callOptions.mcpServers).toBeUndefined();
      expect(callOptions.preparedMcp).toBeUndefined();
    }
    const supportsAllowedTools = ['claude', 'claude-headless', 'claude-terminal'].includes(providerType);
    expect(call.mock.calls[0]![1].allowedTools).toEqual(supportsAllowedTools ? [] : undefined);
    expect(options.allowedTools).toEqual(supportsAllowedTools ? ['Read'] : undefined);
    expect(cleanup).toHaveBeenCalledExactlyOnceWith(verificationResult());
  });

  it.each(['opencode', 'pi'] as const)(
    'rejects verification artifact reads for %s before generation',
    async (providerType) => {
      const call = vi.fn<ProviderAgent['call']>().mockResolvedValue({
        persona: 'interactive', status: 'done', content: generated,
        sessionId: 'generation-session', timestamp: new Date(),
      });
      const setup = vi.fn(() => ({ call }));
      const session = createConversationSession({
        cwd: '/repo',
        outputMode: 'silent',
        persistSession: false,
        formalSpec: true,
        modelCheckTimeoutSeconds: 300,
        ctx: makeSessionContext({
          provider: makeProvider({ setup }), providerType, sessionId: 'conversation-session',
          permissionMode: 'full',
          mcpServers: { untrusted: { type: 'stdio', command: 'must-not-start' } },
        }),
        strategy: {
          systemPrompt: 'formal conversation', allowedTools: ['Read'],
          modelCheckTimeoutSeconds: 300, transformPrompt: (message) => message,
        },
      });

      const result = await session.handleUserMessage({ text: '/verify' });

      expect(result).toMatchObject({
        kind: 'error',
        code: 'provider_error',
        message: `Provider "${providerType}" does not support read-only access limited to verification artifacts`,
      });
      expect(setup).not.toHaveBeenCalled();
      expect(call).not.toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();
      expect(cleanup).not.toHaveBeenCalled();
    },
  );
});
vi.mock('../infra/managed-providers/loader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/managed-providers/loader.js')>()),
  inspectProviderInstallation: vi.fn(async () => ({ state: 'ready', directory: '/test/managed' })),
}));
