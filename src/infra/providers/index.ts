import { ClaudeProvider } from './claude.js';
import { ClaudeHeadlessProvider } from './claude-headless.js';
import { CodexProvider } from './codex.js';
import { OpenCodeProvider } from './opencode.js';
import { CursorProvider } from './cursor.js';
import { CopilotProvider } from './copilot.js';
import { MockProvider } from './mock.js';
import type { Provider, ProviderType } from './types.js';

export type { AgentSetup, ProviderCallOptions, ProviderAgent, Provider, ProviderType } from './types.js';

export class ProviderRegistry {
  private static instance: ProviderRegistry | null = null;
  private readonly providers: Record<string, Provider>;

  private constructor() {
    this.providers = {
      'claude-sdk': new ClaudeProvider(),
      claude: new ClaudeHeadlessProvider(),
      codex: new CodexProvider(),
      opencode: new OpenCodeProvider(),
      cursor: new CursorProvider(),
      copilot: new CopilotProvider(),
      mock: new MockProvider(),
    };
  }

  static getInstance(): ProviderRegistry {
    if (!ProviderRegistry.instance) {
      ProviderRegistry.instance = new ProviderRegistry();
    }
    return ProviderRegistry.instance;
  }

  static resetInstance(): void {
    ProviderRegistry.instance = null;
  }

  get(type: ProviderType): Provider {
    const provider = this.providers[type];
    if (!provider) {
      throw new Error(`Unknown provider type: ${type}`);
    }
    return provider;
  }

}

export function getProvider(type: ProviderType): Provider {
  return ProviderRegistry.getInstance().get(type);
}
