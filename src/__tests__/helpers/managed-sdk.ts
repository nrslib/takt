import * as claude from '@anthropic-ai/claude-agent-sdk';
import * as codex from '@openai/codex-sdk';
import * as opencodeV1 from '@opencode-ai/sdk/v2';
import * as opencodeV2 from '@opencode/client';
import * as piAgent from '@earendil-works/pi-coding-agent';
import * as piAi from '@earendil-works/pi-ai';

// Resolve test doubles before fake timers start; SDK loading is outside the retry clock.
export async function loadManagedSdk(provider: string) {
  const modules = provider === 'claude-sdk' ? [claude]
    : provider === 'codex' ? [codex]
      : provider === 'opencode' ? [opencodeV1, opencodeV2]
        : provider === 'pi' ? [piAgent, piAi]
          : [];
  if (modules.length === 0) throw new Error(`Unexpected managed SDK: ${provider}`);
  return { directory: `/test/managed/${provider}`, modules, stale: false };
}
