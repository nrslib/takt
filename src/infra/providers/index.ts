/**
 * Provider abstraction layer
 *
 * Provides a unified interface for different agent providers (Claude, Codex, OpenCode, Mock).
 * This enables adding new providers without modifying the runner logic.
 */

import { ClaudeProvider } from './claude.js';
import { CodexProvider } from './codex.js';
import { OpenCodeProvider } from './opencode.js';
import { MockProvider } from './mock.js';
import type { Provider, ProviderType } from './types.js';

export type { AgentSetup, ProviderCallOptions, ProviderAgent, Provider, ProviderType } from './types.js';

/**
 * Registry for agent providers.
 * Singleton — use ProviderRegistry.getInstance().
 */
export class ProviderRegistry {
  private static instance: ProviderRegistry | null = null;
  private readonly providers: Record<string, Provider>;

  private constructor() {
    this.providers = {
      claude: new ClaudeProvider(),
      codex: new CodexProvider(),
      opencode: new OpenCodeProvider(),
      mock: new MockProvider(),
    };
  }

  static getInstance(): ProviderRegistry {
    if (!ProviderRegistry.instance) {
      ProviderRegistry.instance = new ProviderRegistry();
    }
    return ProviderRegistry.instance;
  }

  /** Reset singleton for testing */
  static resetInstance(): void {
    ProviderRegistry.instance = null;
  }

  /** Get a provider instance by type */
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

